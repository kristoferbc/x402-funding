/**
 * Coeur du serveur MCP : la definition de l'outil, une seule fois.
 *
 * Ce module ne transporte rien. Il construit un serveur pret a etre branche,
 * soit sur stdio (src/mcp-server.mjs, usage local via npx), soit sur HTTP
 * (src/server.mjs, route /mcp, usage distant sans installation).
 *
 * Deux transports, un seul outil : si la description ou le calcul divergeaient
 * entre les deux, un agent obtiendrait deux reponses differentes pour la meme
 * question selon son mode de connexion.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fundingDivergence } from "./sensor.mjs";

// La version annoncee doit etre celle du paquet, pas une constante figee qui
// derive a chaque publication. package.json est toujours livre a cote de src/.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/**
 * @param {object} [options]
 * @param {(args: {limit: number}) => Promise<object>} [options.fetchFunding]
 *   Producteur des donnees. Permet a la route HTTP d'injecter un cache et une
 *   limite de debit sans que ce module ait a connaitre le reseau. Par defaut,
 *   appel direct du capteur.
 */
export function createFundingServer({ fetchFunding } = {}) {
  const readFunding =
    fetchFunding ?? (({ limit }) => fundingDivergence({ topN: limit }));

  const server = new McpServer({
    name: "x402-funding",
    version,
  });

  server.tool(
    "get_funding_divergence",
    "Returns the perpetual funding-rate divergence between Hyperliquid and a liquid CEX benchmark (Binance, or OKX where Binance restricts the region), annualised with each venue's real funding interval, for pairs liquid on both legs, with the direction of the basis trade to open.",
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
        const data = await readFunding({ limit: limit ?? 5 });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  updated_at: data.updated_at,
                  benchmark: data.benchmark,
                  liquidity_floor: data.liquidity_floor,
                  anomaly_threshold_bps: data.anomaly_threshold_bps,
                  pairs_tradable: data.pairs_tradable,
                  pairs_flagged_anomaly: data.pairs_flagged_anomaly,
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

  return server;
}
