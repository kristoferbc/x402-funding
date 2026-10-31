#!/usr/bin/env node
/**
 * Serveur MCP : expose le capteur comme un outil que n'importe quel agent
 * compatible MCP (Claude Desktop, Cursor, etc.) peut appeler.
 *
 * C'est le levier de decouverte : l'agent trouve l'outil dans un registre,
 * l'installe, et appelle le capteur sans qu'aucun humain n'ait ete demarche.
 *
 * Version gratuite : elle calcule en local et ne passe pas par l'endpoint paye.
 * L'endpoint HTTP paye reste le produit pour les agents qui bouclent a haute
 * frequence.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fundingDivergence } from "./sensor.mjs";

// La version annoncee doit etre celle du paquet, pas une constante figee qui
// derive a chaque publication. package.json est toujours livre a cote de src/.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const server = new McpServer({
  name: "x402-funding",
  version,
});

server.tool(
  "get_funding_divergence",
  "Returns the perpetual funding-rate divergence between Hyperliquid and a liquid CEX benchmark (Binance, or OKX where Binance restricts the region), annualised, for liquid pairs only, with the direction of the basis trade to open.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Number of pairs to return (default 5)."),
  },
  async ({ limit }) => {
    try {
      const data = await fundingDivergence({ topN: limit ?? 5 });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                updated_at: data.updated_at,
                liquidity_floor: data.liquidity_floor,
                pairs_tradable: data.pairs_tradable,
                top: data.top,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Sensor failure: ${err.message}. Hyperliquid or the benchmark venue did not respond.`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Les logs doivent aller sur stderr : stdout est reserve au protocole MCP.
console.error("x402-funding MCP server ready on stdio");
