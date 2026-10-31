import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { fundingDivergence } from "./sensor.mjs";

const PORT = Number(process.env.PORT || 4021);
const PAY_TO = process.env.PAY_TO;
const NETWORK = process.env.NETWORK || "eip155:8453";
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PRICE = process.env.PRICE || "$0.02";

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
const PROBES = [
  {
    venue: "binance",
    url: "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
  },
  {
    venue: "okx",
    url: "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",
  },
];

app.get("/sources", async (_req, res) => {
  const sources = await Promise.all(
    PROBES.map(async ({ venue, url }) => {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const upstream = await fetch(url, { signal: ctrl.signal });
        return {
          venue,
          ok: upstream.ok,
          status: upstream.status,
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          venue,
          ok: false,
          status: null,
          ms: Date.now() - started,
          error: err.name,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  res.json({
    ts: Date.now(),
    benchmark_order: process.env.X402_BENCHMARK_ORDER || "binance,okx",
    reachable: sources.filter((s) => s.ok).map((s) => s.venue),
    sources,
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
          "Cross-venue perpetual funding divergence: Hyperliquid against a liquid CEX benchmark (Binance, falling back to OKX where Binance restricts the region), annualised, with the direction of the basis trade.",
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
                benchmark: { venue: "binance", interval: "8h x 1095" },
                pairs_compared: 180,
                top: [
                  {
                    coin: "BTC",
                    hl_apr_pct: 10.95,
                    cex_apr_pct: 8.42,
                    divergence_bps: 25.3,
                    trade: "short_hyperliquid_long_binance",
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

app.get("/funding", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
    const data = await fundingDivergence({ topN: limit });
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

app.listen(PORT, () => {
  console.log(`x402 funding sensor listening on :${PORT}`);
  console.log(`  network     : ${NETWORK}`);
  console.log(
    `  facilitator : ${USE_CDP ? "CDP (JWT signe)" : FACILITATOR_URL || "https://x402.org/facilitator"}`,
  );
  console.log(`  price       : ${PRICE}`);
  console.log(`  payTo       : ${PAY_TO}`);
  if (IS_MAINNET) console.log("  MODE        : MAINNET — argent reel");
});
