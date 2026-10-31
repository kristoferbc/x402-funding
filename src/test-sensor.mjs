import { fundingDivergence } from "./sensor.mjs";

const t0 = Date.now();
const data = await fundingDivergence({ topN: 5 });

console.log(`latence            : ${Date.now() - t0} ms`);
console.log(`venue de reference : ${data.benchmark.venue}`);
if (data.benchmark.fallbacks.length > 0) {
  for (const f of data.benchmark.fallbacks) {
    console.log(`  repli            : ${f.venue} ecarte (${f.error})`);
  }
}
console.log(`paires retenues HL : ${data.pairs_considered}`);
console.log(`  rejetees (HL)    : ${data.pairs_rejected_illiquid}`);
console.log(`  rejetees (CEX)   : ${data.pairs_rejected_cex_illiquid}`);
console.log(`paires comparees   : ${data.pairs_compared}`);
console.log(`paires tradables   : ${data.pairs_tradable}`);
console.log(`dont anomalies     : ${data.pairs_flagged_anomaly} (seuil ${data.anomaly_threshold_bps} bps)`);
console.log(
  `seuils             : OI >= ${data.liquidity_floor.min_oi_usd.toLocaleString()} $, ` +
    `vol HL >= ${data.liquidity_floor.min_vol_usd.toLocaleString()} $, ` +
    `vol CEX >= ${data.liquidity_floor.min_cex_vol_usd.toLocaleString()} $`,
);
console.log("");
console.log("Top 5 divergences exploitables (annualise) :");
console.table(
  data.top.map((r) => ({
    coin: r.coin,
    hl_apr_pct: r.hl_apr_pct,
    cex_apr_pct: r.cex_apr_pct,
    divergence_bps: r.divergence_bps,
    cex_interval_h: r.cex_interval_hours,
    anomaly: r.anomaly,
    trade: r.trade,
  })),
);

if (data.pairs_tradable < 5) {
  console.error(
    "\nALERTE : moins de 5 paires tradables. Abaisser MIN_OI_USD, MIN_VOL_USD ou MIN_CEX_VOL_USD.",
  );
  process.exit(1);
}
