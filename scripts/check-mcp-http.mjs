#!/usr/bin/env node
/**
 * Verifie la route /mcp avec un vrai client MCP et le vrai transport HTTP.
 *
 * Ce n'est pas un test unitaire : le client se connecte, negocie le protocole,
 * liste les outils et appelle l'outil. Si le transport ou le schema casse, ce
 * script echoue.
 *
 * Usage :
 *   MCP_URL=http://127.0.0.1:4099/mcp node scripts/check-mcp-http.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL || "http://127.0.0.1:4099/mcp";
const limit = Number(process.env.MCP_LIMIT || 2);

console.log(`cible       : ${url}`);

const client = new Client({ name: "check-mcp-http", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));

let failed = false;

try {
  await client.connect(transport);

  const info = client.getServerVersion?.();
  if (info) console.log(`serveur     : ${info.name} ${info.version}`);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  console.log(`outils      : ${names.join(", ")}`);
  if (!names.includes("get_funding_divergence")) {
    throw new Error("get_funding_divergence absent de la liste des outils");
  }

  const started = Date.now();
  const res = await client.callTool({
    name: "get_funding_divergence",
    arguments: { limit },
  });
  const ms = Date.now() - started;

  if (res.isError) throw new Error(res.content?.[0]?.text || "l'outil a renvoye une erreur");

  const payload = JSON.parse(res.content[0].text);
  const rows = Array.isArray(payload.top) ? payload.top.length : -1;

  console.log(`latence     : ${ms} ms`);
  console.log(`venue       : ${payload.benchmark?.venue}`);
  console.log(`tradables   : ${payload.pairs_tradable}`);
  console.log(`lignes      : ${rows}`);

  if (rows !== limit) throw new Error(`attendu ${limit} lignes, recu ${rows}`);
  if (!payload.updated_at) throw new Error("updated_at manquant");

  console.log("\nRoute /mcp operationnelle.");
} catch (err) {
  console.error(`ECHEC : ${err.message}`);
  failed = true;
} finally {
  await client.close().catch(() => {});
}

if (failed) process.exit(1);
