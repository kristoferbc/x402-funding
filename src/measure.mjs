#!/usr/bin/env node
/**
 * Lecture des compteurs du catalogue Bazaar.
 *
 * Le catalogue expose, pour chaque endpoint :
 *   quality.l30DaysTotalCalls
 *   quality.l30DaysUniquePayers
 *   quality.lastCalledAt
 *
 * C'est la seule mesure honnete de la decouverte : personne ne publie de
 * statistiques de recherche, seulement des statistiques d'usage.
 *
 * Methode : on interroge le catalogue par adresse `payTo`
 * (listX402DiscoveryMerchant). Le catalogue compte plus de 105 000 entrees
 * et n'offre aucune recherche serveur utilisable ; paginer serait vain.
 * Cette requete renvoie uniquement nos endpoints, en une seule page.
 *
 * Usage :
 *   npm run measure
 *
 * Variables : PAY_TO (obligatoire), SELF_URL (facultatif, pour filtrer).
 */

import "dotenv/config";
import { listX402DiscoveryMerchant } from "@coinbase/cdp-sdk";

const PAY_TO = process.env.PAY_TO;
const SELF_URL = process.env.SELF_URL || "";

if (!PAY_TO) {
  console.error("STOP: PAY_TO n'est pas configure.");
  process.exit(1);
}

async function allOurResources() {
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await listX402DiscoveryMerchant({
      payTo: PAY_TO,
      limit: 100,
      offset,
    });
    const items = page.resources ?? page.items ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

let items;
try {
  items = await allOurResources();
} catch (e) {
  console.error(`ECHEC de la requete catalogue : ${e.message}`);
  process.exit(3);
}

console.log(`adresse  : ${PAY_TO}`);
console.log(`trouves  : ${items.length} ressource(s)\n`);

if (items.length === 0) {
  console.log("VERDICT : NON INDEXE.");
  console.log("Un paiement regle est necessaire pour declencher l'indexation.");
  process.exit(2);
}

const target = SELF_URL
  ? items.filter((i) => i.resource === SELF_URL)
  : items;

if (SELF_URL && target.length === 0) {
  console.log(`Aucune ressource ne correspond exactement a ${SELF_URL}.`);
  console.log("Ressources de cette adresse :");
  for (const i of items) console.log(`  ${i.resource}`);
  process.exit(2);
}

let totalCalls = 0;
let totalPayers = 0;

for (const r of target) {
  const q = r.quality ?? {};
  const calls = q.l30DaysTotalCalls ?? 0;
  const payers = q.l30DaysUniquePayers ?? 0;
  totalCalls += calls;
  totalPayers += payers;

  console.log(`endpoint     : ${r.resource}`);
  console.log(`prix         : ${r.accepts?.[0]?.amount} unites atomiques`);
  console.log(`reseau       : ${r.accepts?.[0]?.network}`);
  console.log(`dernier appel: ${q.lastCalledAt ?? "jamais"}`);
  console.log(`appels 30j   : ${calls}`);
  console.log(`payeurs 30j  : ${payers}`);
  console.log("");
}

const revenue = (totalCalls * Number(target[0]?.accepts?.[0]?.amount ?? 0)) / 1e6;
console.log(`TOTAL appels 30j : ${totalCalls}`);
console.log(`TOTAL payeurs    : ${totalPayers}`);
console.log(`recettes brutes  : ${revenue.toFixed(4)} USDC`);
console.log("");

if (totalPayers >= 1) {
  console.log("VERDICT : au moins un payeur. La decouverte fonctionne. Industrialiser.");
} else if (totalCalls > 0) {
  console.log("VERDICT : des appels mais aucun payeur distinct.");
  console.log("Prochaine action : baisser le prix a 0,005 $ et remesurer.");
} else {
  console.log("VERDICT : indexe, zero appel sur 30 jours.");
  console.log("Le probleme est la demande, pas la visibilite. Arreter ou changer de produit.");
}
