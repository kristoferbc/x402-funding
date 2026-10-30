import { fundingDivergence } from "./sensor.mjs";

const t0 = Date.now();
const data = await fundingDivergence({ topN: 5 });

console.log(`latence          : ${Date.now() - t0} ms`);
console.log(`paires comparees : ${data.pairs_compared}`);
console.log(`rejetees (illiq) : ${data.pairs_rejected_illiquid}`);
console.log(`paires tradables : ${data.pairs_tradable}`);
console.log(
  `seuils           : OI >= ${data.liquidity_floor.min_oi_usd.toLocaleString()} $, vol 24h >= ${data.liquidity_floor.min_vol_usd.toLocaleString()} $`,
);
console.log("");
console.log("Top 5 divergences exploitables (annualise) :");
console.table(data.top);

if (data.pairs_tradable < 5) {
  console.error(
    "\nALERTE : moins de 5 paires tradables. Abaisser MIN_OI_USD ou MIN_VOL_USD.",
  );
  process.exit(1);
}
