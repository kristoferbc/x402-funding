import "dotenv/config";
import { readFileSync } from "node:fs";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { fundingDivergence } from "./sensor.mjs";
import { fundingDivergenceUltra } from "./sensor-ultra.mjs";
import {
  renderHome,
  renderLlmsTxt,
  renderRobotsTxt,
  renderSitemapXml,
  renderOpenApi,
  renderWellKnownX402,
  FAVICON_SVG,
} from "./public-pages.mjs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFundingServer } from "./mcp-core.mjs";

// Version publiee du service, lue a la source. Recopiee a la main elle
// finirait par mentir ; le document OpenAPI doit annoncer ce qui tourne.
const PKG_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const PORT = Number(process.env.PORT || 4021);
const PAY_TO = process.env.PAY_TO;
const NETWORK = process.env.NETWORK || "eip155:8453";
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PRICE = process.env.PRICE || "$0.02";
// Palier haute valeur. Route separee, module separe : une lenteur ou une panne
// de la lecture des carnets ne peut pas atteindre /funding, qui n'importe
// jamais sensor-ultra.mjs.
const ULTRA_PRICE = process.env.ULTRA_PRICE || "$0.25";
const ULTRA_TIMEOUT_MS = Number(process.env.ULTRA_TIMEOUT_MS || 20_000);

const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
const USE_CDP = Boolean(CDP_KEY_ID && CDP_KEY_SECRET);
const IS_MAINNET = NETWORK === "eip155:8453";

if (!PAY_TO || /^0x0{40}$/i.test(PAY_TO)) {
  console.error("STOP: PAY_TO n'est pas configure dans .env");
  process.exit(1);
}

// Le facilitateur public x402.org ne sert que le testnet. Encaisser de vrais
// USDC sur Base exige le facilitateur heberge par Coinbase, qui demande des
// cles CDP. On refuse de demarrer plutot que d'echouer au premier paiement.
if (IS_MAINNET && !USE_CDP) {
  console.error(
    "STOP: le reseau eip155:8453 (Base Mainnet) exige CDP_API_KEY_ID et CDP_API_KEY_SECRET.",
  );
  console.error(
    "      Le facilitateur public ne supporte pas le mainnet. Repasse en eip155:84532 pour tester.",
  );
  process.exit(1);
}

const app = express();

// Derriere le proxy de Render. Sans ca, l'URL annoncee dans le 402 peut sortir
// en http:// au lieu de https:// et Bazaar indexerait une mauvaise adresse.
app.set("trust proxy", 1);

// Route gratuite : sert de sonde de sante et de cible au heartbeat.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    network: NETWORK,
    facilitator: USE_CDP ? "cdp" : "public",
  });
});

// Route gratuite : dit quelles venues de reference cet hebergeur arrive a
// joindre. Un serveur americain voit Binance en 451 ; cette route rend le fait
// observable au lieu de le laisser deviner a travers des 502.
//
// Elle interroge les trois endpoints dont depend le calcul, pas seulement
// celui des taux : si fundingInfo tombe, les intervalles sont faux et la venue
// doit basculer, donc une sonde partielle mentirait.
const PROBES = [
  { venue: "binance", part: "rates", url: "https://fapi.binance.com/fapi/v1/premiumIndex" },
  { venue: "binance", part: "fundingInfo", url: "https://fapi.binance.com/fapi/v1/fundingInfo" },
  { venue: "binance", part: "tickers", url: "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT" },
  { venue: "okx", part: "rates", url: "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP" },
  { venue: "okx", part: "tickers", url: "https://www.okx.com/api/v5/market/tickers?instType=SWAP" },
];

// Cache court : cette route est gratuite, on ne veut pas qu'une boucle
// transforme notre IP en relais vers les venues.
const SOURCES_TTL_MS = 30_000;
let sourcesCache = { at: 0, body: null };

async function probeSources() {
  return Promise.all(
    PROBES.map(async ({ venue, part, url }) => {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const upstream = await fetch(url, { signal: ctrl.signal });
        return { venue, part, ok: upstream.ok, status: upstream.status, ms: Date.now() - started };
      } catch (err) {
        return { venue, part, ok: false, status: null, ms: Date.now() - started, error: err.name };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

app.get("/sources", async (_req, res) => {
  if (sourcesCache.body && Date.now() - sourcesCache.at < SOURCES_TTL_MS) {
    res.json({ ...sourcesCache.body, cached: true });
    return;
  }

  const sources = await probeSources();

  const byVenue = {};
  for (const probe of sources) {
    if (!byVenue[probe.venue]) byVenue[probe.venue] = { ok: true, parts: {} };
    byVenue[probe.venue].parts[probe.part] = probe.ok ? probe.status : probe.status || probe.error;
    if (!probe.ok) byVenue[probe.venue].ok = false;
  }

  const body = {
    ts: Date.now(),
    benchmark_order: process.env.X402_BENCHMARK_ORDER || "binance,okx",
    usable: Object.keys(byVenue).filter((v) => byVenue[v].ok),
    venues: byVenue,
    sources,
  };

  sourcesCache = { at: Date.now(), body };
  res.json({ ...body, cached: false });
});

// ---------------------------------------------------------------------------
// Pages publiques. Enregistrees AVANT le middleware de paiement : une visite
// de la racine ne doit jamais traverser le controle x402, et une erreur de
// rendu ne peut pas facturer quelqu'un.
// ---------------------------------------------------------------------------

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

const PAGES_TTL_MS = 60_000;

// Le contenu ne depend que de la configuration, mais les URL absolues
// dependent de l'hote de la requete : on met en cache par hote pour rester
// correct derriere plusieurs domaines, sans recalculer a chaque visite.
const pagesByHost = new Map();

function pagesFor(req) {
  const b = baseUrl(req);
  const hit = pagesByHost.get(b);
  if (hit && Date.now() - hit.at < PAGES_TTL_MS) return hit;

  const values = {
    baseUrl: b,
    price: PRICE,
    ultraPrice: ULTRA_PRICE,
    network: NETWORK,
    payTo: PAY_TO,
  };

  const entry = {
    at: Date.now(),
    home: renderHome(values),
    llms: renderLlmsTxt(values),
    robots: renderRobotsTxt(values),
    sitemap: renderSitemapXml({
      baseUrl: b,
      lastmod: new Date().toISOString().slice(0, 10),
    }),
    openapi: renderOpenApi({ ...values, version: PKG_VERSION }),
    wellKnown: renderWellKnownX402(values),
  };

  // Borne memoire : une boucle de requetes avec des en-tetes Host varies ne
  // doit pas fabriquer des cles sans limite.
  if (pagesByHost.size > 20) pagesByHost.clear();
  pagesByHost.set(b, entry);
  return entry;
}

app.get("/", (req, res) => {
  res.type("html").send(pagesFor(req).home);
});

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").send(pagesFor(req).llms);
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(pagesFor(req).robots);
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send(pagesFor(req).sitemap);
});

// Decouverte machine : x402scan (et les crawlers qui suivent la meme spec)
// lisent OpenAPI en premier, puis /.well-known/x402 en compatibilite. Le 402
// runtime reste la source de verite ; ces deux fichiers ne font qu'annoncer
// ou chercher.
app.get("/openapi.json", (req, res) => {
  res.type("application/json").send(pagesFor(req).openapi);
});

app.get("/.well-known/x402", (req, res) => {
  res.type("application/json").send(pagesFor(req).wellKnown);
});

app.get("/favicon.svg", (_req, res) => {
  res.type("image/svg+xml").send(FAVICON_SVG);
});

app.get("/favicon.ico", (_req, res) => {
  res.redirect(301, "/favicon.svg");
});

// ---------------------------------------------------------------------------
// MCP sur HTTP (transport Streamable HTTP, sans session).
//
// Meme outil que le paquet npm, mais joignable depuis une URL : un client
// colle https://.../mcp et appelle l'outil sans rien installer. La definition
// vit dans mcp-core.mjs, partagee avec le mode stdio.
//
// Gratuit, donc expose : trois garde-fous. Un plafond par client, un cache
// court qui absorbe les rafales et mutualise les appels simultanes, et une
// taille de corps bornee. Sans eux, la route serait un relais ouvert vers les
// venues pour n'importe qui.
// ---------------------------------------------------------------------------

const MCP_RATE_WINDOW_MS = 60_000;
const MCP_RATE_MAX = Number(process.env.MCP_RATE_LIMIT || 30);
const MCP_CACHE_MS = Number(process.env.MCP_CACHE_MS || 15_000);

const mcpHits = new Map(); // ip -> { start, count }
const mcpCache = new Map(); // limit -> { at, promise }

function mcpRateLimited(req) {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = mcpHits.get(key);

  if (!entry || now - entry.start > MCP_RATE_WINDOW_MS) {
    // Borne memoire : une rafale d'IP forgees ne doit pas faire grossir la
    // table indefiniment.
    if (mcpHits.size > 5000) mcpHits.clear();
    mcpHits.set(key, { start: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > MCP_RATE_MAX;
}

// ---------------------------------------------------------------------------
// Cache a promesse partagee, commun aux trois routes qui lisent les venues.
//
// La promesse est partagee, pas seulement le resultat : dix appelants
// simultanes declenchent une seule lecture, y compris pendant que la premiere
// est encore en vol. C'est ce qui protege l'IP de l'hebergeur quand un client
// boucle, la ou un cache de resultat ne protegerait qu'apres coup.
//
// Un echec est purge immediatement : un 429 passager ne doit pas rester colle
// au cache et empoisonner les appels suivants.
// ---------------------------------------------------------------------------

const SINGLE_FLIGHT_MAX = 100;

function singleFlight(cache, key, ttlMs, producer) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.promise;

  const promise = Promise.resolve()
    .then(producer)
    .catch((err) => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
      throw err;
    });

  if (cache.size > SINGLE_FLIGHT_MAX) cache.clear();
  cache.set(key, { at: now, promise });
  return promise;
}

/**
 * Route MCP : gratuite, donc la plus exposee. Quinze secondes suffisent a
 * absorber une rafale sans jamais servir une donnee ancienne.
 */
function cachedFunding({ limit }) {
  return singleFlight(mcpCache, limit, MCP_CACHE_MS, () =>
    fundingDivergence({ topN: limit }),
  );
}

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

app.options("/mcp", (_req, res) => {
  res.set(MCP_CORS).status(204).end();
});

app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
  res.set(MCP_CORS);

  if (mcpRateLimited(req)) {
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Rate limit exceeded (${MCP_RATE_MAX} requests per minute). Retry shortly.`,
      },
      id: null,
    });
    return;
  }

  // Serveur et transport par requete : le protocole est sans etat ici, donc
  // rien ne persiste entre deux appels et une requete ne peut pas heriter du
  // contexte d'une autre.
  const server = createFundingServer({ fetchFunding: cachedFunding });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    try {
      transport.close();
    } catch {
      /* deja ferme */
    }
    try {
      server.close();
    } catch {
      /* deja ferme */
    }
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp http failure:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    } else {
      res.end();
    }
  }
});

// Sans session, il n'y a ni flux serveur a ouvrir ni session a fermer : le
// protocole autorise ce refus explicite.
app.get("/mcp", (_req, res) => {
  res.set(MCP_CORS).status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. POST JSON-RPC requests to /mcp.",
    },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.set(MCP_CORS).status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This endpoint is stateless.",
    },
    id: null,
  });
});

// createCdpFacilitatorClient lit CDP_API_KEY_ID / CDP_API_KEY_SECRET dans
// l'environnement et signe chaque appel en JWT. Il retourne un
// HTTPFacilitatorClient, donc il se substitue sans autre changement.
const facilitatorClient = USE_CDP
  ? createCdpFacilitatorClient({
      ...(FACILITATOR_URL ? { facilitatorUrl: FACILITATOR_URL } : {}),
    })
  : new HTTPFacilitatorClient({
      url: FACILITATOR_URL || "https://x402.org/facilitator",
    });

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

app.use(
  paymentMiddleware(
    {
      "GET /funding": {
        accepts: {
          scheme: "exact",
          price: PRICE,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          "Perpetual funding rate arbitrage: cross-venue funding rate divergence between Hyperliquid and a liquid CEX benchmark (Binance, or OKX where Binance blocks the region), annualised, ranked by basis spread, with the trade direction resolved. How much size the spread can absorb is on /ultra.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { limit: 5 },
            inputSchema: {
              properties: {
                limit: { type: "integer", minimum: 1, maximum: 50 },
              },
              required: [],
            },
            output: {
              example: {
                updated_at: "2026-10-30T17:00:00.000Z",
                benchmark: { venue: "binance" },
                pairs_compared: 46,
                top: [
                  {
                    coin: "AAVE",
                    hl_apr_pct: 10.95,
                    cex_apr_pct: -7.29,
                    divergence_bps: 1823.8,
                    hl_interval_hours: 1,
                    cex_interval_hours: 8,
                    anomaly: false,
                    trade: "short_hyperliquid_long_binance",
                  },
                ],
              },
            },
          }),
        },
      },
      "GET /ultra": {
        accepts: {
          scheme: "exact",
          price: ULTRA_PRICE,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          "Funding rate divergence with execution capacity: Hyperliquid vs Binance or OKX, plus the largest notional you can execute on both legs before market impact and slippage exceed a bps budget, order book depth, carry per day and breakeven days.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { limit: 5, capacity: 5 },
            inputSchema: {
              properties: {
                limit: { type: "integer", minimum: 1, maximum: 20 },
                capacity: { type: "integer", minimum: 1, maximum: 10 },
                fees_bps: { type: "number", minimum: 0, maximum: 200 },
              },
              required: [],
            },
            output: {
              example: {
                updated_at: "2026-10-30T17:00:00.000Z",
                benchmark: { venue: "binance" },
                notice:
                  "Measurements computed from public venue data. No recommendation, no position sizing, no investment advice.",
                top: [
                  {
                    coin: "AAVE",
                    hl_apr_pct: 10.95,
                    cex_apr_pct: -7.29,
                    divergence_bps: 1823.8,
                    hl_interval_hours: 1,
                    cex_interval_hours: 8,
                    anomaly: false,
                    trade: "short_hyperliquid_long_binance",
                    capacity: {
                      available: true,
                      usd: 41250,
                      impact_budget_bps: 10,
                      hl_impact_bps: 4.1,
                      cex_impact_bps: 5.9,
                      hl_book_usd: 128400,
                      cex_book_usd: 206900,
                      side_hyperliquid: "bid",
                      side_benchmark: "ask",
                      fees_assumed_bps: 9.5,
                      entry_cost_bps: 19.5,
                      carry_bps_per_day: 4.996,
                      breakeven_days: 3.9,
                      reason: "impact_budget",
                    },
                  },
                ],
              },
            },
          }),
        },
      },
    },
    resourceServer,
  ),
);

// Deux durees differentes, parce que les deux routes ne vendent pas la meme
// chose. /funding ne publie que des taux de financement, qui ne bougent qu'au
// rythme de la venue : une reponse vieille de trente secondes contient
// exactement les memes chiffres, et updated_at en dit l'age. /ultra publie une
// capacite mesuree sur des carnets vivants : au-dela de quelques secondes, ce
// serait un chiffre perime servi comme une mesure.
const FUNDING_CACHE_MS = Number(process.env.FUNDING_CACHE_MS || 30_000);
const ULTRA_CACHE_MS = Number(process.env.ULTRA_CACHE_MS || 5_000);
const fundingCache = new Map(); // limit -> promesse en cours ou resolue
const ultraCache = new Map(); // parametres -> promesse en cours ou resolue

app.get("/funding", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
    const data = await singleFlight(fundingCache, limit, FUNDING_CACHE_MS, () =>
      fundingDivergence({ topN: limit }),
    );
    res.json(data);
  } catch (err) {
    console.error("sensor failure:", err.message);
    res.status(502).json({
      error: "upstream_failure",
      message:
        "Hyperliquid or the benchmark venue did not respond. No charge should apply.",
    });
  }
});

/**
 * Borne dure sur la route Ultra. La lecture de deux carnets par ligne peut
 * trainer si une venue ralentit ; au-dela du budget on renonce, on repond 502,
 * et le facilitateur annule le reglement. L'acheteur n'est pas facture pour une
 * reponse qui n'arrive pas.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.get("/ultra", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);
    const capacity = Math.min(Math.max(Number(req.query.capacity) || 5, 1), 10);
    const feesBps = Number(req.query.fees_bps);
    const overrideFees =
      Number.isFinite(feesBps) && feesBps >= 0 && feesBps <= 200;

    const key = `${limit}|${capacity}|${overrideFees ? feesBps : "std"}`;
    const data = await singleFlight(ultraCache, key, ULTRA_CACHE_MS, () =>
      withTimeout(
        fundingDivergenceUltra({
          topN: limit,
          capacity,
          ...(overrideFees ? { feesBps } : {}),
        }),
        ULTRA_TIMEOUT_MS,
        "ultra sensor",
      ),
    );
    res.json(data);
  } catch (err) {
    console.error("ultra sensor failure:", err.message);
    res.status(502).json({
      error: "upstream_failure",
      message: "Order books could not be measured. No charge should apply.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`x402 funding sensor listening on :${PORT}`);
  console.log(`  network     : ${NETWORK}`);
  console.log(
    `  facilitator : ${USE_CDP ? "CDP (JWT signe)" : FACILITATOR_URL || "https://x402.org/facilitator"}`,
  );
  console.log(`  price       : ${PRICE}`);
  console.log(`  price ultra : ${ULTRA_PRICE} (/ultra, avec capacite d'execution)`);
  console.log(`  payTo       : ${PAY_TO}`);
  if (IS_MAINNET) console.log("  MODE        : MAINNET — argent reel");
});
