/**
 * Verification structurelle du paquet. Ne touche pas au reseau.
 *
 * Lance par `npm run verify`. Sortie 0 = tout est coherent.
 * Chaque controle correspond a une erreur deja commise une fois dans ce
 * projet : c'est la liste des pieges, pas une checklist generique.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const failures = [];
const checks = [];

function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail });
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
}

const pkg = read("package.json");
const server = read("server.json");
const lite = read("lite/package.json");

/* --- 1. Fichiers declares : ils doivent exister ------------------------- */

const declared = new Set();
for (const target of Object.values(pkg.bin || {})) declared.add(target);
if (pkg.main) declared.add(pkg.main);
if (typeof pkg.exports === "string") declared.add(pkg.exports);
else if (pkg.exports) {
  for (const value of Object.values(pkg.exports)) {
    if (typeof value === "string") declared.add(value);
  }
}

for (const file of declared) {
  check(`bin/main existe : ${file}`, existsSync(join(root, file)));
}

/* --- 2. `files` : rien de casse, rien de sensible ----------------------- */

for (const entry of pkg.files || []) {
  check(`files[] existe : ${entry}`, existsSync(join(root, entry)));
}
check(
  "files[] n'embarque pas le dossier lite/",
  !(pkg.files || []).some((f) => f.startsWith("lite")),
  "lite/ est un paquet npm separe, il ne doit pas partir dans celui-ci",
);
check(
  "files[] n'embarque pas scripts/",
  !(pkg.files || []).some((f) => f.startsWith("scripts")),
  "scripts/ est du developpement, pas du runtime",
);

/* --- 3. Versions alignees ---------------------------------------------- */

check(
  "package.json.version == server.json.version",
  pkg.version === server.version,
  `${pkg.version} vs ${server.version}`,
);
check(
  "server.json package version alignee",
  server.packages?.[0]?.version === pkg.version,
  `${server.packages?.[0]?.version} vs ${pkg.version}`,
);

/* --- 4. Registre MCP ---------------------------------------------------- */

check(
  "server.json.name == package.json.mcpName",
  server.name === pkg.mcpName,
  `${server.name} vs ${pkg.mcpName}`,
);
const descLength = (server.description || "").length;
check(
  "description du registre <= 100 caracteres",
  descLength <= 100,
  `${descLength} caracteres`,
);
check(
  "server.json pointe le bon identifiant npm",
  server.packages?.[0]?.identifier === pkg.name,
  `${server.packages?.[0]?.identifier} vs ${pkg.name}`,
);

/* --- 5. Le capteur publie est identique dans les deux paquets ---------- */

const hash = (p) =>
  createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
check(
  "src/sensor.mjs == lite/src/sensor.mjs",
  hash("src/sensor.mjs") === hash("lite/src/sensor.mjs"),
  "les deux paquets publient le meme calcul, ils ne doivent pas diverger",
);

/* --- 6. Le paquet lite n'a aucune dependance --------------------------- */

check(
  "lite : aucune dependance de runtime",
  Object.keys(lite.dependencies || {}).length === 0,
  JSON.stringify(lite.dependencies || {}),
);

/* --- 7. Node minimum ---------------------------------------------------- */

check(
  "package.json declare engines.node",
  Boolean(pkg.engines?.node),
);
check("lite declare engines.node", Boolean(lite.engines?.node));

/* --- 8. Aucun reste de version provisoire ------------------------------ */

for (const [label, value] of [
  ["package.json", pkg.version],
  ["server.json", server.version],
  ["lite/package.json", lite.version],
]) {
  check(
    `${label} : pas de version provisoire`,
    !/^0\.0\.0/.test(value),
    value,
  );
}

/* --- Rapport ------------------------------------------------------------ */

const width = Math.max(...checks.map((c) => c.label.length));
for (const c of checks) {
  console.log(`${c.ok ? "OK  " : "ECHEC"} ${c.label.padEnd(width)}${c.detail ? `  -> ${c.detail}` : ""}`);
}

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} controle(s) en echec.`);
  process.exit(1);
}
console.log(`${checks.length} controles passes.`);
