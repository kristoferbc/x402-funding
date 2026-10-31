/**
 * Capteur : divergence des taux de financement entre Hyperliquid et une
 * venue de reference, choisie automatiquement.
 *
 * Hyperliquid publie un taux HORAIRE et, pour chaque actif, l'open interest
 * ainsi que le volume notionnel du jour. Ces deux champs servent de filtre :
 * un ecart de 400 bps sur une paire a 50 000 $ d'open interest n'est pas
 * un signal, c'est du bruit. On ne publie que les paires ou le portage est
 * reellement executable.
 *
 * POURQUOI UNE CHAINE DE REPLI
 * ----------------------------
 * Binance renvoie HTTP 451 depuis les adresses americaines ("Service
 * unavailable from a restricted location"). Un serveur heberge aux Etats-Unis,
 * ou un client qui execute ce paquet depuis chez lui a Miami, obtenait donc une
 * erreur systematique. Bybit ne resout rien : son CDN renvoie 403 "block access
 * from your country". OKX, lui, repond normalement depuis ces memes adresses.
 *
 * On essaie donc les venues dans l'ordre, on garde la premiere qui repond, et
 * la reponse publique dit laquelle a servi. L'appelant n'a jamais a savoir
 * dans quel pays il tourne.
 *
 * Un detour par Kraken a ete ecarte : sa periode de financement n'est pas
 * documentee sans ambiguite, et comparer deux taux annualises sur des periodes
 * differentes produirait des chiffres plausibles mais faux.
 *
 * Aucune cle API. Des endpoints publics.
 */

const HL_URL = "https://api.hyperliquid.xyz/info";

// Les URL sont surchargeables : un auto-hebergeur peut deplacer une venue ou
// forcer un ordre different sans toucher au code.
const VENUE_URLS = {
  binance:
    process.env.X402_BINANCE_URL ||
    "https://fapi.binance.com/fapi/v1/premiumIndex",
  okx:
    process.env.X402_OKX_URL ||
    "https://www.okx.com/api/v5/public/funding-rate",
};

const DEFAULT_ORDER = ["binance", "okx"];

const ORDER = (process.env.X402_BENCHMARK_ORDER || DEFAULT_ORDER.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s in VENUE_URLS);

const HOURS_PER_YEAR = 24 * 365; // 8760
const INTERVALS_8H_PER_YEAR = 3 * 365; // 1095
const MS_PER_YEAR = 365 * 24 * 3600 * 1000;

// Seuils de liquidite, ajustables par variables d'environnement.
const MIN_OI_USD = Number(process.env.MIN_OI_USD || 1_000_000);
const MIN_VOL_USD = Number(process.env.MIN_VOL_USD || 2_000_000);

// OKX publie un taux par instrument : on plafonne le nombre d'appels pour
// garder la latence sous quelques secondes. Les paires retenues sont les plus
// liquides, donc la couverture perdue est marginale.
const OKX_MAX_COINS = Number(process.env.OKX_MAX_COINS || 50);
const OKX_CONCURRENCY = Number(process.env.OKX_CONCURRENCY || 6);

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function withParam(base, key, value) {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}`;
}

async function fetchJson(url, opts = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function hyperliquidStats(payload) {
  const [meta, ctxs] = payload;
  const out = new Map();
  if (!meta?.universe || !Array.isArray(ctxs)) return out;

  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || asset.isDelisted) return;

    const hourly = Number(ctx.funding);
    if (!Number.isFinite(hourly)) return;

    const markPx = Number(ctx.markPx);
    const openInterest = Number(ctx.openInterest);
    const oiUsd =
      Number.isFinite(markPx) && Number.isFinite(openInterest)
        ? markPx * openInterest
        : 0;
    const volUsd = Number(ctx.dayNtlVlm) || 0;

    out.set(asset.name, {
      apr: hourly * HOURS_PER_YEAR,
      oiUsd,
      volUsd,
    });
  });

  return out;
}

/* ------------------------------------------------------------------ venues */

/**
 * Binance : un seul appel rend tous les contrats. Taux quote sur 8 heures.
 */
async function binanceRates() {
  const rows = await fetchJson(VENUE_URLS.binance);
  if (!Array.isArray(rows)) throw new Error("unexpected payload");

  const out = new Map();
  for (const row of rows) {
    const symbol = row?.symbol;
    if (!symbol || !symbol.endsWith("USDT")) continue;
    const rate = Number(row.lastFundingRate);
    if (!Number.isFinite(rate)) continue;
    out.set(symbol.slice(0, -4), rate * INTERVALS_8H_PER_YEAR);
  }

  if (out.size === 0) throw new Error("no usable rates in payload");
  return out;
}

/**
 * OKX : un appel par instrument. On lit la periode reelle dans la reponse
 * (nextFundingTime - fundingTime) au lieu de la supposer, et on annualise
 * avec cette valeur. Si OKX changeait la cadence d'un contrat, le calcul
 * suivrait tout seul.
 */
async function okxRates(coins) {
  const out = new Map();
  const queue = [...coins];
  let lastError = null;

  const worker = async () => {
    while (queue.length) {
      const coin = queue.shift();
      try {
        const payload = await fetchJson(
          withParam(VENUE_URLS.okx, "instId", `${coin}-USDT-SWAP`),
          {},
          8000,
        );
        const row = payload?.data?.[0];
        if (!row) continue;

        const rate = Number(row.fundingRate);
        if (!Number.isFinite(rate)) continue;

        const span = Number(row.nextFundingTime) - Number(row.fundingTime);
        const intervalsPerYear =
          span > 0 ? MS_PER_YEAR / span : INTERVALS_8H_PER_YEAR;

        out.set(coin, rate * intervalsPerYear);
      } catch (err) {
        lastError = err;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(OKX_CONCURRENCY, coins.length) },
      () => worker(),
    ),
  );

  if (out.size === 0) {
    throw new Error(
      lastError ? lastError.message : "no usable rates in payload",
    );
  }
  return out;
}

const VENUES = {
  binance: {
    label: "binance",
    fetch: (coins) => binanceRates(),
    interval: "8h x 1095",
  },
  okx: {
    label: "okx",
    fetch: (coins) => okxRates(coins),
    interval: "venue funding interval",
  },
};

/* ------------------------------------------------------------------ public */

export async function fundingDivergence({ topN = 5 } = {}) {
  const hlRaw = await fetchJson(HL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });

  const hl = hyperliquidStats(hlRaw);

  // On filtre avant d'interroger la venue : cela evite des appels inutiles,
  // et pour OKX cela borne le nombre de requetes au seul univers qui compte.
  const candidates = [];
  let rejectedIlliquid = 0;
  for (const [coin, stats] of hl) {
    if (stats.oiUsd < MIN_OI_USD || stats.volUsd < MIN_VOL_USD) {
      rejectedIlliquid += 1;
      continue;
    }
    candidates.push({ coin, stats });
  }
  candidates.sort((a, b) => b.stats.oiUsd - a.stats.oiUsd);

  const attempts = [];
  let benchmark = null;

  for (const name of ORDER) {
    const venue = VENUES[name];
    if (!venue) continue;
    try {
      const rates = await venue.fetch(candidates.slice(0, OKX_MAX_COINS).map((c) => c.coin));
      benchmark = { name, venue, rates };
      break;
    } catch (err) {
      attempts.push({ venue: name, error: err.message });
    }
  }

  if (!benchmark) {
    const detail = attempts
      .map((a) => `${a.venue}: ${a.error}`)
      .join("; ");
    throw new Error(`no benchmark venue responded (${detail})`);
  }

  const rows = [];
  let compared = 0;

  for (const { coin, stats } of candidates) {
    const cexApr = benchmark.rates.get(coin);
    if (cexApr === undefined) continue;
    compared += 1;

    const divergence = stats.apr - cexApr;
    if (!Number.isFinite(divergence)) continue;

    rows.push({
      coin,
      hl_apr_pct: round(stats.apr * 100, 2),
      cex_apr_pct: round(cexApr * 100, 2),
      divergence_bps: round(divergence * 10000, 1),
      oi_usd: Math.round(stats.oiUsd),
      vol_24h_usd: Math.round(stats.volUsd),
      trade:
        divergence > 0
          ? `short_hyperliquid_long_${benchmark.name}`
          : `long_hyperliquid_short_${benchmark.name}`,
    });
  }

  rows.sort((a, b) => Math.abs(b.divergence_bps) - Math.abs(a.divergence_bps));

  return {
    updated_at: new Date().toISOString(),
    benchmark: {
      venue: benchmark.name,
      interval: benchmark.venue.interval,
      fallbacks: attempts,
    },
    methodology:
      `Annualised funding: Hyperliquid hourly x 8760; ${benchmark.name} per its own funding interval. ` +
      `Divergence = HL - ${benchmark.name} in bps. Only pairs with open interest and 24h volume ` +
      `above the liquidity floor are reported.`,
    liquidity_floor: { min_oi_usd: MIN_OI_USD, min_vol_usd: MIN_VOL_USD },
    pairs_considered: candidates.length,
    pairs_compared: compared,
    pairs_rejected_illiquid: rejectedIlliquid,
    pairs_tradable: rows.length,
    top: rows.slice(0, topN),
    all: rows,
  };
}

export default fundingDivergence;
