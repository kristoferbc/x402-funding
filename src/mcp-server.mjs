#!/usr/bin/env node
/**
 * Serveur MCP sur stdio : le mode local, gratuit.
 *
 * Expose le capteur comme un outil que n'importe quel agent compatible MCP
 * (Claude Desktop, Cursor, etc.) peut appeler, sans rien installer d'autre que
 * le paquet npm.
 *
 * C'est le levier de decouverte : l'agent trouve l'outil dans un registre,
 * l'installe, et appelle le capteur sans qu'aucun humain n'ait ete demarche.
 *
 * La definition de l'outil vit dans mcp-core.mjs, partagee avec la route HTTP
 * /mcp du serveur heberge.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFundingServer } from "./mcp-core.mjs";

const server = createFundingServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// Les logs doivent aller sur stderr : stdout est reserve au protocole MCP.
console.error("x402-funding MCP server ready on stdio");
