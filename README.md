# x402-funding

Capteur de divergence de funding entre Hyperliquid et Binance, vendu à la requête via x402.

Réponse : les 5 paires où l'écart de taux annualisé est le plus grand, avec le sens du portage à ouvrir.

---

## 1. Ce qu'il faut avant de commencer

| Élément | Où | Coût |
|---|---|---|
| Node.js ≥ 20 | [nodejs.org](https://nodejs.org) | 0 |
| Une adresse EVM pour recevoir | MetaMask ou Coinbase Wallet | 0 |
| Un compte npm | [npmjs.com/signup](https://www.npmjs.com/signup) | 0 |
| Un compte Render | [render.com](https://render.com) | 0 |
| Des USDC sur Base (pour tester en payant) | [faucet.circle.com](https://faucet.circle.com) (Sepolia) | 0 |

**Aucune clé privée n'est nécessaire sur le serveur.** `PAY_TO` est une simple adresse publique ; le facilitateur s'occupe du règlement.

---

## 2. Test local (10 minutes)

```bash
cd x402-funding
npm install
copy .env.example .env
npm run sensor
```

Tu dois voir un tableau avec 5 lignes. Si `pairs_comparees` est inférieur à 20, le format d'une des deux APIs a changé — arrête-toi ici.

---

## 3. Le facilitateur : public (testnet) ou CDP (mainnet)

Le facilitateur vérifie et règle les paiements. Deux options, mesurées :

| Réseau | Usage | Facilitateur |
|---|---|---|
| `eip155:84532` | Base Sepolia, **gratuit** | `https://x402.org/facilitator` |
| `eip155:8453` | Base Mainnet, **argent réel** | **CDP obligatoire** |

**Vérifié le 30/10 :** `https://x402.org/facilitator/supported` ne liste **aucun réseau mainnet**. Il n'expose que `eip155:84532` et des testnets non-EVM. Le mainnet exige donc les clés CDP.

**Vérifié également :** le facilitateur CDP, interrogé avec de vraies clés, expose bien `eip155:8453 / exact`. C'est la paire utilisée ici.

Le code bascule automatiquement :

- `CDP_API_KEY_ID` et `CDP_API_KEY_SECRET` présents → `createCdpFacilitatorClient()` (JWT signé, URL `https://api.cdp.coinbase.com/platform/v2/x402`)
- absents → `HTTPFacilitatorClient` sur `FACILITATOR_URL`

Et il **refuse de démarrer** en `eip155:8453` sans clés CDP, plutôt que d'échouer au premier paiement.

---

## 4. Déployer sur Render (tier gratuit)

1. Pousse le dossier sur un dépôt GitHub.
2. Render → **New → Web Service** → connecte le dépôt.
3. Build command : `npm install`
4. Start command : `npm start`
5. Variables d'environnement :

```
PAY_TO=0xTonAdresse
NETWORK=eip155:84532
FACILITATOR_URL=https://x402.org/facilitator
PRICE=$0.02
SELF_URL=https://ton-service.onrender.com/funding
HEARTBEAT_MS=300000
```

6. Déploie, puis vérifie :

```bash
curl -i https://ton-service.onrender.com/funding
```

Tu dois recevoir **HTTP 402** avec un en-tête `PAYMENT-REQUIRED`. C'est la preuve que la route est payante et correctement annoncée.

> Le tier gratuit s'endort après ~15 min. Le heartbeat ne tourne pas tout seul sur Render : utilise un cron externe gratuit (cron-job.org) qui appelle `/health` toutes les 5 minutes. Sinon, le premier agent qui arrive réveille le service en 30 secondes et reçoit un timeout.

---

## 4 bis. Passer en Base Mainnet

1. **Renseigner les clés CDP.** Dans le fichier JSON téléchargé depuis le portail CDP, `id` va dans `CDP_API_KEY_ID` et `privateKey` dans `CDP_API_KEY_SECRET`. Ces valeurs ne se retéléchargent pas.
2. **`NETWORK=eip155:8453`**, `PAY_TO` = ton adresse réelle.
3. **Gaz : rien à prévoir.** Le facilitateur diffuse la transaction et paie le gaz. Tu n'as besoin ni d'ETH ni de USDC sur ton adresse pour recevoir — seulement d'une adresse valide.
4. **Vérifier avant de pousser** : le serveur doit afficher `MODE : MAINNET — argent réel` et `/funding` doit renvoyer 402 avec `asset = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (le vrai USDC de Base).

### Frais du facilitateur CDP (vérifié à la source)

« The first 1,000 facilitator transactions each month are free, and each one after that costs $0.001. »

- Seul un **règlement réussi** est facturé. La vérification est gratuite, et un `settle` en erreur (4xx/5xx) aussi.
- 1 000 règlements/mois sont offerts, donc le test de 7 jours ne coûte rien en frais.
- Au-delà, à 0,02 $ le call : **5 % de marge**. Sur 122 099 calls/mois (le volume du premier vendeur du catalogue), 121 099 × 0,001 $ = 121 $ de frais pour 2 442 $ de recettes.
- Le gaz est inclus dans ce prix : le facilitateur diffuse la transaction et le paie.

Sources : [FAQ x402](https://docs.cdp.coinbase.com/x402/support/faq) et [tarification du facilitateur CDP](https://docs.cdp.coinbase.com/x402/seller/facilitator#pricing).

---

## 5. Publier le paquet npm

```bash
npm login
npm publish --access public
```

Le paquet expose `fundingDivergence()` :

```js
import { fundingDivergence } from "x402-funding-divergence";
const data = await fundingDivergence();
```

C'est le levier de dépendance : chaque agent qui installe le paquet connaît l'endpoint sans avoir à le chercher.

Utilise un nom de paquet disponible — `npm view <nom>` renvoie 404 s'il est libre.

---

## 6. Le serveur MCP (levier de découverte)

Le paquet expose aussi un serveur MCP. Test local :

```bash
npm run mcp
```

Configuration Claude Desktop — fichier `%APPDATA%\Claude\claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "x402-funding": {
      "command": "npx",
      "args": ["-y", "x402-funding-divergence"]
    }
  }
}
```

L'outil exposé s'appelle `get_funding_divergence`. Un agent qui l'installe appelle le capteur sans qu'aucun humain n'ait été démarché — c'est le levier de dépendance.

Publie-le ensuite dans les registres que les agents parcourent (Smithery, mcp.so, Glama). Ce sont des annuaires **avec moteur de recherche**, contrairement à Bazaar.

> La version MCP est gratuite : elle calcule en local. L'endpoint HTTP payant reste le produit pour les agents qui appellent en boucle.

---

## 7. Le protocole des 7 jours

| Jour | Action |
|---|---|
| J0 | Publier l'endpoint, vérifier le 402, publier le paquet npm |
| J0 | Mettre en place le cron `/health` toutes les 5 min |
| **J0** | **Payer ton propre endpoint une fois** (0,02 $) — sans ça, Bazaar ne t'indexe pas |
| J0+15 min | Vérifier que l'endpoint apparaît dans le catalogue |
| J1-J6 | Ne rien toucher |
| J7 | `npm run measure` |

> **L'indexation Bazaar exige un paiement réglé.** Référence : « A successful payment is what triggers indexing, so the paid call in the checklist is required rather than recommended. Indexing completes within 10 to 15 minutes of that payment. » Sans ce paiement d'amorçage, l'endpoint reste invisible et un « 0 appel » à J7 ne prouverait rien.

### Critères fixés à l'avance

| Résultat à J7 | Lecture | Décision |
|---|---|---|
| ≥ 1 payeur unique | La découverte fonctionne | Industrialiser |
| Appels > 0, payeurs 0 | Visible mais pas convaincant | Baisser le prix à 0,005 $ |
| 0 appel, endpoint trouvé | Indexé mais invisible | Le problème est la demande, pas la visibilité |
| Endpoint non trouvé | Pas indexé | Vérifier `declareDiscoveryExtension` |

---

## 8. Ce que ce projet ne fait pas

- Il ne garantit aucun revenu. Le vendeur médian du catalogue encaisse ~2,50 $/mois.
- Il ne crée pas la demande. Il rend l'endpoint visible et payant ; il ne force personne à l'appeler.
- Il n'automatise pas l'adoption. Le paquet npm doit être installé par quelqu'un.

Le test mesure une seule chose : **est-ce qu'un agent inconnu paie sans qu'on lui parle ?** Si la réponse est non en 7 jours avec un endpoint indexé, elle ne changera pas en 70.
