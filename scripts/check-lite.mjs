/**
 * Le paquet `hyperliquid-binance-funding` (dossier lite/) publie le meme
 * capteur que le paquet principal. Deux copies d'un meme calcul finissent
 * toujours par diverger : ce controle echoue si les deux fichiers ne sont plus
 * identiques octet pour octet.
 *
 * Lance par `npm run check:lite`. Sortie 0 = identiques.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  join(root, "src", "sensor.mjs"),
  join(root, "lite", "src", "sensor.mjs"),
];

const hashes = files.map((file) => {
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, digest };
});

const [a, b] = hashes;

if (a.digest !== b.digest) {
  console.error("Les deux copies du capteur ont diverge.");
  console.error(`  ${a.file}  ${a.digest}`);
  console.error(`  ${b.file}  ${b.digest}`);
  console.error("");
  console.error("Corrigez avec : Copy-Item src/sensor.mjs lite/src/sensor.mjs -Force");
  process.exit(1);
}

console.log(`Capteur identique dans les deux paquets (sha256 ${a.digest.slice(0, 12)}).`);
