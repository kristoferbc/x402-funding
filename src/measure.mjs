/**
 * Lecture des compteurs du catalogue Bazaar.
 *
 * Le catalogue expose, pour chaque endpoint :
 *   quality.l30DaysTotalCalls
 *   quality.l30DaysUniquePayers
 *   quality.lastCalledAt
 *
 * C'est la seule mesure honnete de la decouverte : personne ne publie
 * de statistiques de recherche, seulement des statistiques d'usage.
 *
 * ATTENTION : le catalogue compte >100 000 entrees et n'offre pas de
 * recherche serveur. On scanne donc les premieres pages (tri par recence),
 * la ou un endpoint fraichement publie doit apparaitre.
 */

const BASE =
  process.env.DISCOVERY_URL ||
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

const TARGET = process.env.SELF_URL || "";
const MAX_PAGES = Number(process.env.MAX_PAGES || 120);

if (!TARGET) {
  console.error("STOP: SELF_URL n'est pas configure (ex: https://xxx.onrender.com/funding)");
  process.exit(1);
}

const targetHost = (() => {
  try {
    return new URL(TARGET).host;
  } catch {
    return TARGET;
  }
})();

async function page(offset) {
  const url = `${BASE}?offset=${offset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function matches(item) {
  const r = item?.resource || "";
  return r.includes(targetHost) || r.includes(TARGET);
}

const first = await page(0);
const total = first?.pagination?.total ?? 0;
console.log(`catalogue total : ${total} entrees`);
console.log(`recherche de    : ${targetHost}`);

let found = null;
let scanned = 0;
let offset = 0;

while (offset < total && scanned < MAX_PAGES) {
  const data = scanned === 0 ? first : await page(offset);
  const items = data?.items ?? [];
  if (items.length === 0) break;

  for (const item of items) {
    if (matches(item)) {
      found = item;
      break;
    }
  }

  scanned += 1;
  offset += items.length;

  if (found) break;
  if (scanned % 10 === 0) {
    console.log(`  ... ${scanned} pages scannees (${offset} entrees)`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log("");
if (!found) {
  console.log(
    `RESULTAT : non trouve dans les ${scanned} premieres pages (${offset} entrees).`,
  );
  console.log(
    "  -> Soit l'endpoint n'est pas encore indexe, soit il est plus loin dans le tri.",
  );
  process.exit(2);
}

const q = found.quality ?? {};
console.log("RESULTAT : endpoint trouve");
console.log(`  resource            : ${found.resource}`);
console.log(`  serviceName         : ${found.serviceName ?? "(aucun)"}`);
console.log(`  appels 30j          : ${q.l30DaysTotalCalls ?? 0}`);
console.log(`  payeurs uniques 30j : ${q.l30DaysUniquePayers ?? 0}`);
console.log(`  dernier appel       : ${q.lastCalledAt ?? "jamais"}`);
console.log("");

const payers = q.l30DaysUniquePayers ?? 0;
const calls = q.l30DaysTotalCalls ?? 0;
const priceUsd = Number((process.env.PRICE || "$0.02").replace("$", "")) || 0.02;
const revenue = calls * priceUsd;

console.log(`  revenu estime 30j   : ${revenue.toFixed(2)} $ (${calls} x ${priceUsd})`);
console.log(`  revenu estime /jour : ${(revenue / 30).toFixed(2)} $`);

if (payers >= 1) {
  console.log("  VERDICT : la decouverte fonctionne -> industrialiser.");
} else if (calls > 0) {
  console.log("  VERDICT : des appels arrivent mais personne ne paie -> revoir le prix.");
} else {
  console.log("  VERDICT : aucun appel -> l'annuaire ne pousse pas de trafic. Arreter.");
}
