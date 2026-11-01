/**
 * Capteur Ultra : la divergence de financement, plus la capacite d'execution.
 *
 * POURQUOI CE FICHIER EXISTE SEPAREMENT
 * -------------------------------------
 * `/funding` est en production et encaisse depuis un acheteur reel. Sa logique
 * ne doit pas bouger parce qu'on ajoute une offre : `sensor.mjs` reste donc
 * exactement le fichier publie, et cette couche se contente de l'appeler.
 *
 * Consequence pratique : une panne ou une lenteur de la lecture des carnets ne
 * peut pas atteindre `/funding`, qui n'importe jamais ce module. Les deux routes
 * ne partagent aucun etat, aucun cache, aucun compteur.
 *
 * CE QUE LA COUCHE AJOUTE
 * -----------------------
 * Pour chaque paire retenue, deux appels de carnet (Hyperliquid + la venue de
 * reference), puis le calcul de capacite de capacity.mjs. Une ligne dont le
 * carnet est indisponible reste publiee avec `available: false` et sa raison :
 * un appel paye ne doit pas etre perdu parce qu'une venue a rate une reponse.
 *
 * Si AUCUNE ligne ne peut etre mesuree, on leve une erreur : la route repond
 * alors 502, et le facilitateur annule le reglement. L'acheteur n'est pas
 * facture pour une reponse vide.
 */

import { fundingDivergence } from "./sensor.mjs";
import { orderBookCapacity } from "./capacity.mjs";

const HL_URL = process.env.X402_HL_INFO_URL || "https://api.hyperliquid.xyz/info";

// Lu a chaque appel et non a l'import : une adresse de carnet doit pouvoir etre
// redirigee pour prouver le comportement de panne sans redemarrer le serveur.
function bookUrls() {
  return {
    binance:
      process.env.X402_BINANCE_DEPTH_URL ||
      "https://fapi.binance.com/fapi/v1/depth",
    okx:
      process.env.X402_OKX_BOOKS_URL || "https://www.okx.com/api/v5/market/books",
    okxInstruments:
      process.env.X402_OKX_INSTRUMENTS_URL ||
      "https://www.okx.com/api/v5/public/instruments",
  };
}

// Budget d'impact : « au-dela de tant de points de base, je ne mesure plus ».
// Ce n'est pas une taille conseillee.
const IMPACT_BPS = Number(process.env.CAPACITY_IMPACT_BPS || 10);
const MAX_ROWS = Number(process.env.CAPACITY_MAX_ROWS || 10);
const CONCURRENCY = Number(process.env.CAPACITY_CONCURRENCY || 4);
const MAX_USD = Number(process.env.CAPACITY_MAX_USD || 50_000_000);
const FEES_BPS = Number(process.env.CAPACITY_FEES_BPS || 9.5);
// Chaque appel de carnet est borne. Sans cette borne, une venue qui ne repond
// jamais ferait attendre l'acheteur jusqu'au timeout du proxy.
const CALL_TIMEOUT_MS = Number(process.env.CAPACITY_CALL_TIMEOUT_MS || 7000);

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function withParam(base, key, value) {
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${key}=${encodeURIComponent(value)}`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Applique fn a chaque element avec au plus `limit` requetes en vol. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/* ------------------------------------------------------------------ carnets */

async function hyperliquidBook(coin) {
  const payload = await postJson(HL_URL, { type: "l2Book", coin });
  const levels = payload?.levels;
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new Error("no l2Book levels");
  }
  const pick = (rows) =>
    (Array.isArray(rows) ? rows : []).map((level) => ({
      px: level?.px,
      sz: level?.sz,
    }));
  return { bids: pick(levels[0]), asks: pick(levels[1]) };
}

/**
 * Valeur d'un contrat OKX en monnaie de base.
 *
 * OKX publie les tailles de carnet en contrats, pas en jetons. Sans ce facteur,
 * la profondeur serait fausse d'un ordre de grandeur sur tout instrument a
 * petit ctVal — une erreur silencieuse et massive.
 */
async function okxContractValues() {
  const payload = await fetchJson(`${bookUrls().okxInstruments}?instType=SWAP`);
  const rows = payload?.data;
  if (!Array.isArray(rows)) throw new Error("unexpected instruments payload");

  const values = new Map();
  for (const row of rows) {
    const ctVal = Number(row?.ctVal);
    const ctMult = Number(row?.ctMult);
    if (!row?.instId || !Number.isFinite(ctVal) || ctVal <= 0) continue;
    values.set(
      row.instId,
      ctVal * (Number.isFinite(ctMult) && ctMult > 0 ? ctMult : 1),
    );
  }
  return values;
}

async function benchmarkBook(venue, coin, okxValues) {
  if (venue === "binance") {
    const payload = await fetchJson(
      withParam(
        withParam(bookUrls().binance, "symbol", `${coin}USDT`),
        "limit",
        "100",
      ),
    );
    const pick = (rows) =>
      (Array.isArray(rows) ? rows : []).map(([px, sz]) => ({ px, sz }));
    return { bids: pick(payload?.bids), asks: pick(payload?.asks) };
  }

  if (venue === "okx") {
    const instId = `${coin}-USDT-SWAP`;
    const factor = okxValues?.get(instId);
    if (!factor) throw new Error(`no contract value for ${instId}`);

    const payload = await fetchJson(
      withParam(withParam(bookUrls().okx, "instId", instId), "sz", "50"),
    );
    const row = payload?.data?.[0];
    const pick = (rows) =>
      (Array.isArray(rows) ? rows : []).map(([px, sz]) => ({
        px,
        sz: Number(sz) * factor,
      }));
    return { bids: pick(row?.bids), asks: pick(row?.asks) };
  }

  throw new Error(`no order book source for ${venue}`);
}

/* ----------------------------------------------------------------- capacite */

async function rowCapacity(row, venue, okxValues, feesBps) {
  const shortHyperliquid = String(row.trade).startsWith("short_hyperliquid");
  const hlSide = shortHyperliquid ? "bid" : "ask";
  const cexSide = shortHyperliquid ? "ask" : "bid";

  let measured;
  try {
    const [hl, cex] = await Promise.all([
      hyperliquidBook(row.coin),
      benchmarkBook(venue, row.coin, okxValues),
    ]);
    measured = orderBookCapacity({
      hlLevels: hl[hlSide === "bid" ? "bids" : "asks"],
      cexLevels: cex[cexSide === "bid" ? "bids" : "asks"],
      hlSide,
      cexSide,
      maxImpactBps: IMPACT_BPS,
      maxUsd: MAX_USD,
    });
  } catch (err) {
    return { available: false, error: err.message };
  }

  // Conversion d'unite : la divergence annualisee ramenee au jour. Pas une
  // prevision, pas une recommandation.
  const carryPerDayBps = Math.abs(row.divergence_bps) / 365;
  const entryCostBps =
    feesBps + (measured.hlImpactBps ?? 0) + (measured.cexImpactBps ?? 0);

  return {
    available: measured.usd > 0,
    usd: Math.round(measured.usd),
    usd_lower_bound: measured.reason === "capped_by_request",
    impact_budget_bps: IMPACT_BPS,
    hl_impact_bps:
      measured.hlImpactBps === null ? null : round(measured.hlImpactBps, 2),
    cex_impact_bps:
      measured.cexImpactBps === null ? null : round(measured.cexImpactBps, 2),
    hl_book_usd: Math.round(measured.hlDepthUsd),
    cex_book_usd: Math.round(measured.cexDepthUsd),
    side_hyperliquid: hlSide,
    side_benchmark: cexSide,
    fees_assumed_bps: feesBps,
    entry_cost_bps: round(entryCostBps, 2),
    carry_bps_per_day: round(carryPerDayBps, 3),
    breakeven_days:
      carryPerDayBps > 0 && measured.usd > 0
        ? round(entryCostBps / carryPerDayBps, 2)
        : null,
    reason: measured.reason,
  };
}

/* ------------------------------------------------------------------- public */

export async function fundingDivergenceUltra({
  topN = 5,
  capacity = 5,
  feesBps = FEES_BPS,
} = {}) {
  // La mesure de base est celle de /funding, appelee telle quelle.
  const base = await fundingDivergence({ topN });

  const rows = base.top.slice(0, Math.max(0, Math.min(capacity, MAX_ROWS, base.top.length)));

  if (rows.length > 0) {
    let okxValues = null;
    if (base.benchmark?.venue === "okx") {
      try {
        okxValues = await okxContractValues();
      } catch {
        okxValues = null;
      }
    }

    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      row.capacity = await rowCapacity(row, base.benchmark.venue, okxValues, feesBps);
      return null;
    });
  }

  const measured = rows.filter((row) => row.capacity?.available).length;
  if (rows.length > 0 && measured === 0) {
    // Aucune mesure : mieux vaut refuser la vente que facturer du vide.
    const reasons = rows
      .map((row) => `${row.coin}: ${row.capacity?.error || row.capacity?.reason}`)
      .join("; ");
    throw new Error(`capacity unavailable for every pair (${reasons})`);
  }

  return {
    ...base,
    notice:
      "Measurements computed from public venue data. No recommendation, no position sizing, no investment advice.",
    capacity_method: {
      definition: `Largest notional executable on both legs at once before their combined market impact exceeds ${IMPACT_BPS} bps.`,
      impact_budget_bps: IMPACT_BPS,
      fees_assumed_bps: feesBps,
      entry_cost_bps: "taker fees plus market impact at that size, in basis points",
      breakeven_days:
        "entry_cost_bps divided by the funding carry per day. Unit conversion of the published divergence; not a forecast and not a recommendation.",
      rows_requested: rows.length,
      rows_measured: measured,
      book_limits:
        "Hyperliquid publishes about 20 book levels per side, Binance 100, OKX 50: depth beyond that is invisible to this measurement and is never extrapolated.",
    },
    top: rows,
  };
}

export default fundingDivergenceUltra;
