/**
 * Capteur : divergence des taux de financement entre Hyperliquid et une venue
 * de reference, choisie automatiquement.
 *
 * TROIS REGLES QUI GOUVERNENT CE FICHIER
 * --------------------------------------
 * 1. Chaque venue a sa propre cadence de financement. Hyperliquid finance
 *    toutes les heures. Binance liste 820 contrats dans /fundingInfo : 465 en
 *    4 h, 353 en 8 h, 2 en 1 h. OKX varie aussi d'un instrument a l'autre. On
 *    lit donc l'intervalle dans les metadonnees de la venue au lieu de
 *    supposer 8 heures : annualiser un taux 4h avec le facteur 8h divise le
 *    resultat par deux, sans aucune erreur visible.
 *
 * 2. Un portage n'est executable que si LES DEUX jambes sont liquides. Filtrer
 *    sur le seul open interest Hyperliquid laisse passer des paires mortes sur
 *    le CEX, donc intraitables.
 *
 * 3. Un ecart enorme est presque toujours une dislocation d'une venue, pas un
 *    rendement. Au-dela de ANOMALY_BPS on publie la ligne mais on la marque,
 *    et on la classe apres les lignes saines au lieu de la mettre en tete.
 *
 * POURQUOI UNE CHAINE DE REPLI
 * ----------------------------
 * Binance renvoie HTTP 451 depuis les adresses americaines. Bybit renvoie 403
 * depuis les memes adresses. OKX repond. On essaie les venues dans l'ordre, on
 * garde la premiere qui repond, et la reponse dit laquelle a servi.
 *
 * Aucune cle API. Endpoints publics.
 */

const HL_URL = "https://api.hyperliquid.xyz/info";

const VENUE_URLS = {
  binance: {
    rates:
      process.env.X402_BINANCE_URL ||
      "https://fapi.binance.com/fapi/v1/premiumIndex",
    fundingInfo:
      process.env.X402_BINANCE_INFO_URL ||
      "https://fapi.binance.com/fapi/v1/fundingInfo",
    tickers:
      process.env.X402_BINANCE_TICKERS_URL ||
      "https://fapi.binance.com/fapi/v1/ticker/24hr",
    history:
      process.env.X402_BINANCE_HISTORY_URL ||
      "https://fapi.binance.com/fapi/v1/fundingRate",
  },
  okx: {
    rates:
      process.env.X402_OKX_URL ||
      "https://www.okx.com/api/v5/public/funding-rate",
    tickers:
      process.env.X402_OKX_TICKERS_URL ||
      "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
    history:
      process.env.X402_OKX_HISTORY_URL ||
      "https://www.okx.com/api/v5/public/funding-rate-history",
  },
};

const DEFAULT_ORDER = ["binance", "okx"];

const ORDER = (process.env.X402_BENCHMARK_ORDER || DEFAULT_ORDER.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s in VENUE_URLS);

const HOURS_PER_YEAR = 24 * 365; // 8760
const MS_PER_YEAR = 365 * 24 * 3600 * 1000;
const DEFAULT_INTERVAL_HOURS = 8;

// Planchers de liquidite. Les deux premiers portent sur Hyperliquid, le
// troisieme sur la venue de reference : sans lui, on publierait des paires
// liquides d'un cote et vides de l'autre.
const MIN_OI_USD = Number(process.env.MIN_OI_USD || 1_000_000);
const MIN_VOL_USD = Number(process.env.MIN_VOL_USD || 2_000_000);
const MIN_CEX_VOL_USD = Number(
  process.env.MIN_CEX_VOL_USD || process.env.MIN_VOL_USD || 2_000_000,
);

// Au-dela de ce seuil, l'ecart est marque comme anomalie et recule dans le
// classement. 2 000 bps = 20 points de pourcentage annualises.
const ANOMALY_BPS = Number(process.env.ANOMALY_BPS || 2_000);

const OKX_MAX_COINS = Number(process.env.OKX_MAX_COINS || 50);
const OKX_CONCURRENCY = Number(process.env.OKX_CONCURRENCY || 6);
const STABILITY_CONCURRENCY = Number(process.env.STABILITY_CONCURRENCY || 5);
// Borne le cout : la stabilite coute deux appels par ligne, donc on la calcule
// pour les premieres lignes publiees seulement. Au-dela, `stability` vaut null.
const STABILITY_MAX_ROWS = Number(process.env.STABILITY_MAX_ROWS || 10);
// 72 h et non 24 h : Binance ne regle que toutes les 8 h, donc 24 h ne
// donneraient que trois points, insuffisants pour un ecart-type.
const STABILITY_WINDOW_HOURS = Number(process.env.STABILITY_WINDOW_HOURS || 72);

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function withParam(base, key, value) {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${key}=${encodeURIComponent(value)}`;
}

async function fetchJson(url, { timeoutMs = 9000, ...opts } = {}) {
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

async function postJson(url, body, timeoutMs = 9000) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

/** Applique fn a chaque element avec au plus `limit` requetes en vol. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
  return Math.sqrt(variance);
}

/* --------------------------------------------------------------- Hyperliquid */

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
      intervalHours: 1,
      oiUsd,
      volUsd,
    });
  });

  return out;
}

/* -------------------------------------------------------------------- Binance */

async function binanceBenchmark(coins) {
  // Les trois appels sont indispensables : sans fundingInfo les intervalles
  // sont faux, sans tickers la liquidite de la jambe CEX est inconnue.
  const [premium, info, tickers] = await Promise.all([
    fetchJson(VENUE_URLS.binance.rates),
    fetchJson(VENUE_URLS.binance.fundingInfo),
    fetchJson(VENUE_URLS.binance.tickers),
  ]);

  if (!Array.isArray(premium)) throw new Error("unexpected premiumIndex payload");
  if (!Array.isArray(info)) throw new Error("unexpected fundingInfo payload");
  if (!Array.isArray(tickers)) throw new Error("unexpected ticker payload");

  const intervals = new Map();
  for (const row of info) {
    const symbol = row?.symbol;
    const hours = Number(row?.fundingIntervalHours);
    if (symbol && Number.isFinite(hours) && hours > 0) {
      intervals.set(symbol, hours);
    }
  }

  const volumes = new Map();
  for (const row of tickers) {
    const symbol = row?.symbol;
    const quote = Number(row?.quoteVolume);
    if (symbol && Number.isFinite(quote)) volumes.set(symbol, quote);
  }

  const rates = new Map();
  const cexVolumes = new Map();

  for (const row of premium) {
    const symbol = row?.symbol;
    if (!symbol || !symbol.endsWith("USDT")) continue;

    const rate = Number(row.lastFundingRate);
    if (!Number.isFinite(rate)) continue;

    const coin = symbol.slice(0, -4);
    const hours = intervals.get(symbol) || DEFAULT_INTERVAL_HOURS;
    const apr = rate * (HOURS_PER_YEAR / hours);

    rates.set(coin, { apr, intervalHours: hours });

    const quote = volumes.get(symbol);
    if (Number.isFinite(quote)) cexVolumes.set(coin, quote);
  }

  if (rates.size === 0) throw new Error("no usable rates in payload");
  // Binance rend tous les contrats en un appel : aucune troncature.
  return { rates, volumes: cexVolumes, notChecked: 0 };
}

/* ------------------------------------------------------------------------ OKX */

function okxCoinFromInstId(instId) {
  const suffix = "-USDT-SWAP";
  if (typeof instId !== "string" || !instId.endsWith(suffix)) return null;
  return instId.slice(0, -suffix.length);
}

async function okxBenchmark(coins) {
  // Un appel par instrument : on plafonne pour tenir la latence. Le nombre de
  // paires ecartees pour cette raison est remonte a l'appelant, pour qu'une
  // couverture partielle ne passe pas pour une absence de paire.
  const subset = coins.slice(0, OKX_MAX_COINS);

  const tickers = await fetchJson(VENUE_URLS.okx.tickers);
  const rows = tickers?.data;
  if (!Array.isArray(rows)) throw new Error("unexpected ticker payload");

  // volCcy24h est exprime en monnaie de base ; on le convertit en dollars avec
  // le dernier prix pour rester comparable aux volumes Binance.
  const volumes = new Map();
  for (const row of rows) {
    const coin = okxCoinFromInstId(row?.instId);
    if (!coin) continue;
    const base = Number(row?.volCcy24h);
    const price = Number(row?.last);
    if (Number.isFinite(base) && Number.isFinite(price) && price > 0) {
      volumes.set(coin, base * price);
    }
  }

  const results = await mapWithConcurrency(
    subset,
    OKX_CONCURRENCY,
    async (coin) => {
      try {
        const payload = await fetchJson(
          withParam(VENUE_URLS.okx.rates, "instId", `${coin}-USDT-SWAP`),
          { timeoutMs: 8000 },
        );
        const row = payload?.data?.[0];
        if (!row) return null;

        const rate = Number(row.fundingRate);
        if (!Number.isFinite(rate)) return null;

        const span = Number(row.nextFundingTime) - Number(row.fundingTime);
        const hours = span > 0 ? span / 3_600_000 : DEFAULT_INTERVAL_HOURS;
        if (!(hours > 0)) return null;

        return [coin, { apr: rate * (HOURS_PER_YEAR / hours), intervalHours: hours }];
      } catch {
        return null;
      }
    },
  );

  const rates = new Map();
  for (const entry of results) if (entry) rates.set(entry[0], entry[1]);

  if (rates.size === 0) throw new Error("no usable rates in payload");
  return { rates, volumes, notChecked: coins.length - subset.length };
}

const VENUES = {
  binance: {
    label: "binance",
    fetch: (coins) => binanceBenchmark(coins),
  },
  okx: {
    label: "okx",
    fetch: (coins) => okxBenchmark(coins),
  },
};

/* --------------------------------------------------------------- Stabilite */

/**
 * Moyenne et dispersion des taux sur la fenetre recente, pour les deux jambes.
 * Cout : deux appels par ligne, donc on ne le fait que pour les lignes
 * effectivement publiees dans `top`.
 *
 * Toute erreur est avalee : une ligne sans historique reste publiable, elle
 * porte simplement `stability` a null plutot que de faire echouer l'appel.
 */
async function stability(coin, venueName, sinceMs, cexFactor, hlFactor) {
  const collect = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  const cexRates = await collect(async () => {
    if (venueName === "binance") {
      const payload = await fetchJson(
        withParam(
          withParam(
            withParam(VENUE_URLS.binance.history, "symbol", `${coin}USDT`),
            "startTime",
            String(sinceMs),
          ),
          "limit",
          "120",
        ),
        { timeoutMs: 7000 },
      );
      if (!Array.isArray(payload)) return null;
      return payload
        .filter((r) => Number(r.fundingTime) >= sinceMs)
        .map((r) => Number(r.fundingRate))
        .filter(Number.isFinite);
    }

    if (venueName === "okx") {
      // OKX n'accepte pas de startTime : on demande les derniers reglements
      // puis on filtre nous-memes sur la fenetre.
      const payload = await fetchJson(
        withParam(
          withParam(VENUE_URLS.okx.history, "instId", `${coin}-USDT-SWAP`),
          "limit",
          "100",
        ),
        { timeoutMs: 7000 },
      );
      const rows = payload?.data;
      if (!Array.isArray(rows)) return null;
      return rows
        .filter((r) => Number(r.fundingTime) >= sinceMs)
        .map((r) => Number(r.fundingRate))
        .filter(Number.isFinite);
    }

    return null;
  });

  const hlRates = await collect(async () => {
    const payload = await postJson(
      HL_URL,
      { type: "fundingHistory", coin, startTime: sinceMs },
      7000,
    );
    if (!Array.isArray(payload)) return null;
    return payload.map((r) => Number(r.fundingRate)).filter(Number.isFinite);
  });

  const cexSummary = summarise(cexRates, cexFactor);
  const hlSummary = summarise(hlRates, hlFactor);

  if (cexSummary.mean_pct === null && hlSummary.mean_pct === null) return null;

  return {
    window_hours: STABILITY_WINDOW_HOURS,
    cex_samples: cexRates ? cexRates.length : 0,
    hl_samples: hlRates ? hlRates.length : 0,
    cex_mean_apr_pct: cexSummary.mean_pct,
    cex_std_apr_pct: cexSummary.std_pct,
    hl_mean_apr_pct: hlSummary.mean_pct,
    hl_std_apr_pct: hlSummary.std_pct,
  };
}

function summarise(values, factor) {
  if (!values || values.length === 0) return { mean_pct: null, std_pct: null };
  const apr = values.map((v) => v * factor);
  return {
    mean_pct: round(mean(apr) * 100, 2),
    std_pct: round(stdDev(apr) * 100, 2),
  };
}

/* ------------------------------------------------------------------ public */

export async function fundingDivergence({ topN = 5 } = {}) {
  const hlRaw = await postJson(HL_URL, { type: "metaAndAssetCtxs" });

  const hl = hyperliquidStats(hlRaw);

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
      const { rates, volumes, notChecked } = await venue.fetch(
        candidates.map((c) => c.coin),
      );
      benchmark = { name, rates, volumes, notChecked };
      break;
    } catch (err) {
      attempts.push({ venue: name, error: err.message });
    }
  }

  if (!benchmark) {
    const detail = attempts.map((a) => `${a.venue}: ${a.error}`).join("; ");
    throw new Error(`no benchmark venue responded (${detail})`);
  }

  const rows = [];
  let compared = 0;
  let rejectedCexIlliquid = 0;

  for (const { coin, stats } of candidates) {
    const cex = benchmark.rates.get(coin);
    if (!cex) continue;
    compared += 1;

    const cexVol = benchmark.volumes.get(coin);
    if (!Number.isFinite(cexVol) || cexVol < MIN_CEX_VOL_USD) {
      rejectedCexIlliquid += 1;
      continue;
    }

    const divergence = stats.apr - cex.apr;
    if (!Number.isFinite(divergence)) continue;

    const divergenceBps = round(divergence * 10000, 1);

    rows.push({
      coin,
      hl_apr_pct: round(stats.apr * 100, 2),
      cex_apr_pct: round(cex.apr * 100, 2),
      divergence_bps: divergenceBps,
      hl_interval_hours: stats.intervalHours,
      cex_interval_hours: cex.intervalHours,
      oi_usd: Math.round(stats.oiUsd),
      vol_24h_usd: Math.round(stats.volUsd),
      cex_vol_24h_usd: Math.round(cexVol),
      anomaly: Math.abs(divergenceBps) > ANOMALY_BPS,
      trade:
        divergence > 0
          ? `short_hyperliquid_long_${benchmark.name}`
          : `long_hyperliquid_short_${benchmark.name}`,
      stability: null,
    });
  }

  // Les lignes ordinaires d'abord, les anomalies ensuite : un ecart enorme ne
  // doit pas occuper la premiere place sous pretexte qu'il est enorme.
  rows.sort((a, b) => {
    if (a.anomaly !== b.anomaly) return a.anomaly ? 1 : -1;
    return Math.abs(b.divergence_bps) - Math.abs(a.divergence_bps);
  });

  const top = rows.slice(0, topN);

  // Stabilite : deux appels par ligne publiee, donc seulement pour les
  // premieres lignes de `top`. Les autres restent publiees avec null.
  const sinceMs = Date.now() - STABILITY_WINDOW_HOURS * 3_600_000;
  const enriched = top.slice(0, Math.max(0, STABILITY_MAX_ROWS));
  await mapWithConcurrency(enriched, STABILITY_CONCURRENCY, async (row) => {
    const cexFactor =
      HOURS_PER_YEAR / (row.cex_interval_hours || DEFAULT_INTERVAL_HOURS);
    const hlFactor = HOURS_PER_YEAR / (row.hl_interval_hours || 1);

    row.stability = await stability(
      row.coin,
      benchmark.name,
      sinceMs,
      cexFactor,
      hlFactor,
    );
    return null;
  });

  return {
    updated_at: new Date().toISOString(),
    benchmark: {
      venue: benchmark.name,
      funding_interval: "read per instrument from the venue",
      fallbacks: attempts,
    },
    methodology:
      `Annualised funding, each leg with its own funding interval: Hyperliquid hourly x 8760; ` +
      `${benchmark.name} x (8760 / its interval in hours). Divergence = HL - ${benchmark.name} in bps. ` +
      `A pair is published only when both legs clear the liquidity floor. ` +
      `Rows beyond ${ANOMALY_BPS} bps are flagged as anomalies and ranked after normal rows.`,
    liquidity_floor: {
      min_oi_usd: MIN_OI_USD,
      min_vol_usd: MIN_VOL_USD,
      min_cex_vol_usd: MIN_CEX_VOL_USD,
    },
    anomaly_threshold_bps: ANOMALY_BPS,
    pairs_considered: candidates.length,
    pairs_not_checked_on_venue: benchmark.notChecked,
    pairs_compared: compared,
    pairs_rejected_illiquid: rejectedIlliquid,
    pairs_rejected_cex_illiquid: rejectedCexIlliquid,
    pairs_tradable: rows.length,
    pairs_flagged_anomaly: rows.filter((r) => r.anomaly).length,
    top,
    all: rows,
  };
}

export default fundingDivergence;
