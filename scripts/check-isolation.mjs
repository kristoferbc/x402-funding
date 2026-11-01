#!/usr/bin/env node
/**
 * Preuve d'isolation : la route Ultra ne peut pas degrader la route Funding.
 *
 * CE QUE CE SCRIPT DEMONTRE
 * -------------------------
 * Le risque, quand on ajoute une route lente a un service qui encaisse, est
 * qu'elle contamine la route existante : boucle d'evenements saturee, etat
 * partage, panne propagee. Trois experiences le mesurent au lieu de le
 * supposer.
 *
 *   1. Une mesure Ultra lente, lancee en premier, ne retarde pas le capteur de
 *      base. On chronometre la reponse de /funding pendant qu'Ultra travaille.
 *   2. Une panne totale des carnets fait echouer Ultra proprement, et le
 *      capteur de base repond toujours ensuite.
 *   3. La charge utile de /funding ne contient aucun champ ajoute par Ultra :
 *      les deux sorties sont independantes par construction.
 *
 * Reseau requis (Hyperliquid). A lancer a la main, pas dans `npm run check`.
 *
 *   node scripts/check-isolation.mjs
 */

// Doit etre pose AVANT l'import de sensor-ultra : les bornes sont lues au
// chargement du module.
process.env.CAPACITY_CALL_TIMEOUT_MS = "2500";
process.env.CAPACITY_CONCURRENCY = "4";

const { fundingDivergence } = await import("../src/sensor.mjs");
const { fundingDivergenceUltra } = await import("../src/sensor-ultra.mjs");

const checks = [];
function record(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "OK  " : "ECHEC"} ${label}${detail ? `  -> ${detail}` : ""}`);
}
function pad(value) {
  return String(value).padStart(5, " ");
}

const results = {};

/* --- 1. Ultra lent en parallele d'un appel de base ----------------------- */

// Adresse non routable : la connexion traine jusqu'au timeout, ce qui simule
// une venue qui ne repond plus.
process.env.X402_BINANCE_DEPTH_URL = "http://10.255.255.1:81/depth";
process.env.X402_HL_INFO_URL = process.env.X402_HL_INFO_URL || "https://api.hyperliquid.xyz/info";

const slowStart = Date.now();
const slowUltra = fundingDivergenceUltra({ topN: 5, capacity: 5 })
  .then(() => ({ outcome: "resolved" }))
  .catch((err) => ({ outcome: "threw", message: err.message }));

// Le capteur de base est appele PENDANT que l'Ultra attend ses carnets.
const baseStart = Date.now();
const base = await fundingDivergence({ topN: 3 });
const baseMs = Date.now() - baseStart;

const ultra = await slowUltra;
const ultraMs = Date.now() - slowStart;

record(
  "le capteur de base repond pendant qu'Ultra attend un carnet",
  Boolean(base?.top) && base.top.length > 0,
  `${base.top?.length ?? 0} lignes`,
);
record(
  "le capteur de base n'est pas ralenti",
  baseMs < 6000,
  `${pad(baseMs)} ms alors qu'Ultra a tourne ${pad(ultraMs)} ms`,
);
record(
  "Ultra echoue proprement quand les carnets sont injoignables",
  ultra.outcome === "threw",
  ultra.outcome === "threw" ? ultra.message.slice(0, 90) : "aucune erreur levee",
);
results.baseDuringSlowUltra = baseMs;
results.ultraWithDeadBooks = ultraMs;

/* --- 2. Apres la panne, la base repond toujours ------------------------- */

const afterStart = Date.now();
const after = await fundingDivergence({ topN: 2 });
const afterMs = Date.now() - afterStart;

record(
  "apres un echec complet d'Ultra, le capteur de base fonctionne encore",
  Boolean(after?.top) && after.top.length > 0,
  `${after.top?.length ?? 0} lignes en ${afterMs} ms`,
);
results.baseAfterFailure = afterMs;

/* --- 3. Les deux charges utiles sont independantes ---------------------- */

const baseKeys = Object.keys(base || {});
record(
  "/funding n'expose aucun champ ajoute par Ultra",
  !baseKeys.includes("capacity_method") &&
    !baseKeys.includes("notice") &&
    !(base.top || []).some((row) => "capacity" in row),
  `${baseKeys.length} champs, aucun propre a Ultra`,
);

/* --- 4. Ultra mesure correctement quand les carnets repondent ----------- */

delete process.env.X402_BINANCE_DEPTH_URL;
process.env.X402_BINANCE_DEPTH_URL = "https://fapi.binance.com/fapi/v1/depth";

const okStart = Date.now();
const ultraOk = await fundingDivergenceUltra({ topN: 3, capacity: 3 });
const ultraOkMs = Date.now() - okStart;
const measured = (ultraOk.top || []).filter((row) => row.capacity?.available);

record(
  "avec des carnets joignables, Ultra mesure au moins une paire",
  measured.length > 0,
  `${measured.length}/${ultraOk.top?.length ?? 0} paires en ${ultraOkMs} ms`,
);
for (const row of measured) {
  const c = row.capacity;
  const coherent =
    Number.isFinite(c.usd) &&
    c.usd >= 0 &&
    Number.isFinite(c.hl_impact_bps) &&
    Number.isFinite(c.cex_impact_bps) &&
    c.hl_impact_bps + c.cex_impact_bps <= c.impact_budget_bps + 0.05 &&
    c.usd <= Math.min(c.hl_book_usd, c.cex_book_usd) + 1;
  record(
    `  ${row.coin} : capacite coherente`,
    coherent,
    `${c.usd} $ | impact ${c.hl_impact_bps}+${c.cex_impact_bps} <= ${c.impact_budget_bps} bps | carnets ${c.hl_book_usd}/${c.cex_book_usd}`,
  );
}

/* --- Rapport ------------------------------------------------------------ */

const failures = checks.filter((c) => !c.ok);
console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} verification(s) en echec.`);
  process.exit(1);
}
console.log(`${checks.length} verifications d'isolation passees.`);
console.log(
  `base ${results.baseDuringSlowUltra} ms pendant Ultra lent, ` +
    `${results.baseAfterFailure} ms apres panne Ultra.`,
);
