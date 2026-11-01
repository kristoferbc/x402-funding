#!/usr/bin/env node
/**
 * Metriques de classement Bazaar — une commande, aucune dependance.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * L'indexeur de Coinbase publie nos propres chiffres : appels regles sur 30
 * jours, payeurs distincts, date du dernier appel. Ces trois nombres sont le
 * classement. Les regarder a l'oeil dans une reponse JSON, c'est se priver de
 * la seule mesure qui compte et decider a l'aveugle.
 *
 * Il conserve un releve dans .bazaar-metrics.json pour afficher l'evolution
 * depuis la derniere lecture : quatre appels ne veulent rien dire seuls, mais
 * « +12 depuis mardi » veut dire quelque chose.
 *
 * Usage :
 *   npm run metrics                 lecture, avec comparatif
 *   npm run metrics -- --json       sortie machine
 *   npm run metrics -- --reset      oublie l'historique
 *
 * Code de sortie 1 si l'API ne repond pas : utilisable dans une tache planifiee.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = join(ROOT, ".bazaar-metrics.json");
const API = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";

// Adresse publique de paiement : elle identifie le marchand dans l'index. Ce
// n'est pas un secret, elle figure dans chaque en-tete 402.
const DEFAULT_PAY_TO = "0x07f69780f024d0ff507a42ba124b191a181d41ae";
const PAY_TO = process.env.PAY_TO || DEFAULT_PAY_TO;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
if (argv.includes("--reset") && existsSync(HISTORY)) rmSync(HISTORY);

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function relative(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "inconnu";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "a l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function pad(value, width) {
  return String(value).padStart(width, " ");
}

function signed(value) {
  if (value === null || value === undefined) return "  -";
  return value > 0 ? `+${value}` : String(value);
}

function loadHistory() {
  if (!existsSync(HISTORY)) return null;
  try {
    return JSON.parse(readFileSync(HISTORY, "utf8"));
  } catch {
    return null;
  }
}

function saveHistory(snapshot) {
  try {
    writeFileSync(HISTORY, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch {
    // Un disque en lecture seule ne doit pas faire echouer la lecture.
  }
}

const started = Date.now();

let merchant;
let indexTotal = null;
try {
  merchant = await getJson(`${API}/merchant?payTo=${encodeURIComponent(PAY_TO)}`);
} catch (err) {
  console.error(`Lecture impossible : ${err.message}`);
  console.error(`URL : ${API}/merchant?payTo=${PAY_TO}`);
  process.exit(1);
}

// Le total de l'index sert de contexte : 4 appels, sur combien de concurrents.
try {
  const page = await getJson(`${API}/resources?limit=1`);
  indexTotal = page?.pagination?.total ?? null;
} catch {
  indexTotal = null;
}

const resources = (Array.isArray(merchant?.resources) ? merchant.resources : []).map(
  (row) => ({
    resource: row.resource,
    calls: row?.quality?.l30DaysTotalCalls ?? null,
    payers: row?.quality?.l30DaysUniquePayers ?? null,
    lastCalledAt: row?.quality?.lastCalledAt ?? null,
  }),
);

const totals = resources.reduce(
  (acc, row) => ({
    calls: acc.calls + (row.calls || 0),
    payers: Math.max(acc.payers, row.payers || 0),
  }),
  { calls: 0, payers: 0 },
);

const previous = loadHistory();
const snapshot = {
  readAt: new Date().toISOString(),
  payTo: PAY_TO,
  indexTotal,
  resources,
  totals,
};

saveHistory(snapshot);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        readAt: snapshot.readAt,
        payTo: PAY_TO,
        indexTotal,
        totals,
        resources,
        previous: previous ? { readAt: previous.readAt, totals: previous.totals } : null,
        delta: previous
          ? {
              calls: totals.calls - (previous.totals?.calls ?? 0),
              payers: totals.payers - (previous.totals?.payers ?? 0),
            }
          : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log("");
console.log("BAZAAR — metriques de classement (30 derniers jours)");
console.log(`marchand  ${PAY_TO}`);
if (indexTotal !== null) console.log(`index     ${indexTotal} ressources listees`);
console.log("");

if (resources.length === 0) {
  console.log("  Aucune ressource indexee pour cette adresse.");
  console.log("  Verifie que l'endpoint a bien regle au moins un appel via CDP.");
} else {
  console.log("  appels  payeurs  dernier appel      ressource");
  console.log("  ------  -------  ------------------  ---------");
  for (const row of resources) {
    const name = row.resource.replace(/^https?:\/\/[^/]+/, "") || row.resource;
    console.log(
      `  ${pad(row.calls ?? "-", 6)}  ${pad(row.payers ?? "-", 7)}  ` +
        `${(row.lastCalledAt ? relative(row.lastCalledAt) : "jamais").padEnd(18)}  ${name}`,
    );
  }
  console.log("");
  console.log(
    `  total      appels ${totals.calls}   payeurs distincts ${totals.payers}`,
  );
}

if (previous?.totals) {
  const dc = totals.calls - (previous.totals.calls ?? 0);
  const dp = totals.payers - (previous.totals.payers ?? 0);
  console.log("");
  console.log(`Depuis le releve precedent (${relative(previous.readAt)}) :`);
  console.log(`  appels  ${signed(dc)}     payeurs  ${signed(dp)}`);
} else {
  console.log("");
  console.log("Premier releve enregistre : le comparatif apparaitra au prochain passage.");
}

console.log("");
console.log(`Releve conserve dans .bazaar-metrics.json  (${Date.now() - started} ms)`);
