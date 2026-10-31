/**
 * Test de bout en bout du serveur MCP, par le vrai protocole : on lance le
 * binaire tel qu'un client le ferait, on negocie, on liste les outils, on en
 * appelle un, et on verifie la forme de la reponse.
 *
 * Lance par `npm run check:mcp`. Sortie 0 = le serveur MCP fonctionne.
 * Necessite le reseau : le capteur interroge les venues.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "src", "mcp-server.mjs")],
  stderr: "pipe",
});

const client = new Client({ name: "verify", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`serveur      : ${info?.name} ${info?.version}`);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "get_funding_divergence");
  if (!tool) failures.push("l'outil get_funding_divergence est absent");
  console.log(`outil        : ${tool ? tool.name : "ABSENT"}`);

  const limitSchema = tool?.inputSchema?.properties?.limit;
  const boundsOk =
    limitSchema?.minimum === 1 && limitSchema?.maximum === 50;
  if (!boundsOk) failures.push("le schema de `limit` n'expose pas min 1 / max 50");

  const started = Date.now();
  const res = await client.callTool({
    name: "get_funding_divergence",
    arguments: { limit: 2 },
  });
  const elapsed = Date.now() - started;

  const text = res?.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    failures.push("l'appel n'a renvoye aucun contenu texte");
  } else {
    const payload = JSON.parse(text);
    console.log(`latence      : ${elapsed} ms`);
    console.log(`venue        : ${payload.benchmark?.venue}`);
    console.log(`tradables    : ${payload.pairs_tradable}`);
    console.log(`anomalies    : ${payload.pairs_flagged_anomaly}`);
    console.log(`lignes       : ${payload.top?.length}`);

    if (!payload.benchmark?.venue) failures.push("benchmark.venue absent de la reponse");
    if (!Array.isArray(payload.top) || payload.top.length !== 2) {
      failures.push("`limit: 2` ne renvoie pas exactement 2 lignes");
    }
    for (const key of [
      "coin",
      "hl_apr_pct",
      "cex_apr_pct",
      "divergence_bps",
      "cex_interval_hours",
      "anomaly",
      "trade",
    ]) {
      if (!(key in (payload.top?.[0] ?? {}))) failures.push(`champ manquant dans une ligne : ${key}`);
    }
  }
} catch (err) {
  failures.push(`exception : ${err.message}`);
} finally {
  await client.close().catch(() => {});
}

console.log("");
if (failures.length > 0) {
  for (const f of failures) console.error(`ECHEC ${f}`);
  process.exit(1);
}
console.log("Serveur MCP operationnel.");
