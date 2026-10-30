/**
 * Capteur : divergence des taux de financement entre Hyperliquid et Binance.
 *
 * Hyperliquid publie un taux HORAIRE et, pour chaque actif, l'open interest
 * ainsi que le volume notionnel du jour. Ces deux champs servent de filtre :
 * un ecart de 400 bps sur une paire a 50 000 $ d'open interest n'est pas
 * un signal, c'est du bruit. On ne publie que les paires ou le portage est
 * reellement executable.
 *
 * Aucune cle API. Deux endpoints publics.
 */

const HL_URL = "https://api.hyperliquid.xyz/info";
const BN_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

const HOURS_PER_YEAR = 24 * 365; // 8760
const BN_INTERVALS_PER_YEAR = 3 * 365; // funding 8h -> 1095

// Seuils de liquidite, ajustables par variables d'environnement.
const MIN_OI_USD = Number(process.env.MIN_OI_USD || 1_000_000);
const MIN_VOL_USD = Number(process.env.MIN_VOL_USD || 2_000_000);

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
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

function binanceAnnualised(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;

  for (const row of rows) {
    const symbol = row?.symbol;
    if (!symbol || !symbol.endsWith("USDT")) continue;
    const rate = Number(row.lastFundingRate);
    if (!Number.isFinite(rate)) continue;
    out.set(symbol.slice(0, -4), rate * BN_INTERVALS_PER_YEAR);
  }

  return out;
}

export async function fundingDivergence({ topN = 5 } = {}) {
  const [hlRaw, bnRaw] = await Promise.all([
    fetchJson(HL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    }),
    fetchJson(BN_URL),
  ]);

  const hl = hyperliquidStats(hlRaw);
  const bn = binanceAnnualised(bnRaw);

  const rows = [];
  let compared = 0;
  let rejectedIlliquid = 0;

  for (const [coin, stats] of hl) {
    const bnApr = bn.get(coin);
    if (bnApr === undefined) continue;
    compared += 1;

    // Filtre : on ne garde que ce qui est executable.
    if (stats.oiUsd < MIN_OI_USD || stats.volUsd < MIN_VOL_USD) {
      rejectedIlliquid += 1;
      continue;
    }

    const divergence = stats.apr - bnApr;
    if (!Number.isFinite(divergence)) continue;

    rows.push({
      coin,
      hl_apr_pct: round(stats.apr * 100, 2),
      bn_apr_pct: round(bnApr * 100, 2),
      divergence_bps: round(divergence * 10000, 1),
      oi_usd: Math.round(stats.oiUsd),
      vol_24h_usd: Math.round(stats.volUsd),
      trade:
        divergence > 0
          ? "short_hyperliquid_long_binance"
          : "long_hyperliquid_short_binance",
    });
  }

  rows.sort((a, b) => Math.abs(b.divergence_bps) - Math.abs(a.divergence_bps));

  return {
    updated_at: new Date().toISOString(),
    methodology:
      "Annualised funding: Hyperliquid hourly x 8760; Binance 8h x 1095. Divergence = HL - BN in bps. Only pairs with open interest and 24h volume above the liquidity floor are reported.",
    liquidity_floor: { min_oi_usd: MIN_OI_USD, min_vol_usd: MIN_VOL_USD },
    pairs_compared: compared,
    pairs_rejected_illiquid: rejectedIlliquid,
    pairs_tradable: rows.length,
    top: rows.slice(0, topN),
    all: rows,
  };
}

export default fundingDivergence;
