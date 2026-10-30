#!/usr/bin/env node
/**
 * Paiement d'amorcage.
 *
 * Bazaar n'indexe un endpoint qu'apres un premier paiement regle. Sans ce
 * script, le serveur reste invisible et un "0 appel" a J+7 ne prouverait rien.
 *
 * Usage :
 *   $env:BUYER_PRIVATE_KEY = "0x..."   # portefeuille contenant >= 0,02 USDC sur Base
 *   $env:SEED_URL = "https://ton-service.onrender.com/funding"
 *   node src/seed.mjs
 *
 * Le portefeuille acheteur doit contenir des USDC sur Base. Aucun ETH n'est
 * necessaire : le facilitateur diffuse la transaction et paie le gaz.
 */

import "dotenv/config";
import {
  x402Client,
  wrapFetchWithPayment,
} from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const rawKey = process.env.BUYER_PRIVATE_KEY;
const url = process.env.SEED_URL || process.env.SELF_URL;

if (!rawKey) {
  console.error("STOP: BUYER_PRIVATE_KEY n'est pas definie.");
  process.exit(1);
}
if (/^0x[0-9a-fA-F]{40}$/.test(rawKey.trim())) {
  console.error(
    "STOP: BUYER_PRIVATE_KEY contient une ADRESSE (42 caracteres), pas une cle privee.",
  );
  console.error(
    "      Une cle privee fait 66 caracteres : 0x suivi de 64 caracteres hexadecimaux.",
  );
  console.error(
    "      Portefeuille : Account details > Show private key. Ne la partage avec personne.",
  );
  process.exit(1);
}
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey.trim())) {
  console.error(
    `STOP: BUYER_PRIVATE_KEY a ${rawKey.trim().length} caracteres, 66 attendus (0x + 64 hex).`,
  );
  process.exit(1);
}
if (!url) {
  console.error("STOP: SEED_URL (ou SELF_URL) n'est pas definie.");
  process.exit(1);
}

const pk = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(pk);
console.log(`acheteur : ${account.address}`);
console.log(`cible    : ${url}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
console.log("client x402 pret (scheme exact, EVM)");

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

try {
  const res = await fetchWithPayment(url, { method: "GET" });
  const body = await res.text();

  console.log(`statut HTTP : ${res.status}`);

  const header =
    res.headers.get("PAYMENT-RESPONSE") || res.headers.get("payment-response");
  if (header) {
    try {
      const decoded = JSON.parse(
        Buffer.from(header, "base64").toString("utf8"),
      );
      console.log(`reglement   : ${JSON.stringify(decoded)}`);
      console.log("");
      console.log("Indexation Bazaar dans 10 a 15 minutes.");
    } catch {
      console.log(`en-tete brut : ${header}`);
    }
  } else {
    console.log("aucun en-tete PAYMENT-RESPONSE (paiement non declenche)");
  }

  console.log(`corps (300 premiers caracteres) : ${body.slice(0, 300)}`);
} catch (err) {
  console.error(`ECHEC : ${err.message}`);
  process.exit(1);
}
