# x402 Funding Divergence

[![npm version](https://img.shields.io/npm/v/x402-funding-divergence.svg)](https://www.npmjs.com/package/x402-funding-divergence)
[![npm downloads](https://img.shields.io/npm/dm/x402-funding-divergence.svg)](https://www.npmjs.com/package/x402-funding-divergence)
[![license](https://img.shields.io/npm/l/x402-funding-divergence.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/x402-funding-divergence.svg)](https://nodejs.org)

**Perpetual funding rates, compared across venues.** Hyperliquid vs Binance, annualized, liquidity-filtered, with the direction of the basis trade already resolved.

One call returns every liquid pair where the two venues disagree, sorted by the size of the gap. No API keys, no signup, no rate-limit negotiation.

```js
import { fundingDivergence } from "x402-funding-divergence";

const { top } = await fundingDivergence({ topN: 5 });
```

```json
[
  {
    "coin": "WLD",
    "hl_apr_pct": -0.51,
    "bn_apr_pct": -229.01,
    "divergence_bps": 22850,
    "oi_usd": 57400000,
    "vol_24h_usd": 67900000,
    "trade": "short_hyperliquid_long_binance"
  }
]
```

That `trade` field is the whole point: it tells you which leg to short and which to long. No interpretation needed downstream.

> **In a hurry?** The same JSON is served at `https://x402-funding.onrender.com/funding` for $0.02 per call, with no setup. See [the hosted endpoint](#use-the-hosted-endpoint-pay-per-call).

## Why this exists

A funding rate on one venue tells you what that venue thinks. The gap between two venues tells you what you can actually collect.

Doing it by hand means two APIs, two funding intervals, two unit conventions, and a filter for pairs where the spread is real rather than an artifact of a dead order book. This package does that in one call, in about half a second.

- **Two venues, one shape.** Hyperliquid publishes hourly funding; Binance publishes every 8 hours. Both are normalized to annualized percentages so the numbers are directly comparable.
- **Liquidity filter on by default.** Open interest ≥ $1M and 24h volume ≥ $2M, configurable. Thin pairs produce spectacular but unexecutable numbers; they are dropped before they reach you.
- **Direction included.** The sign of the divergence determines the trade, and the trade string is computed for you.
- **Zero dependencies for the sensor.** Native `fetch`, nothing else. Runs in Node 20+, in a serverless function, or on an edge runtime.

Whether you use the free local package or the paid hosted endpoint, you never manage blockchain complexity: no RPC endpoint, no ETH, no KYC.

## Install

```bash
npm install x402-funding-divergence
```

Requires Node.js 20 or newer.

> **Only want the data?** This package ships the full payment server along with its dependencies. If you just need the sensor, install [`hyperliquid-binance-funding`](https://www.npmjs.com/package/hyperliquid-binance-funding) — same function, same output, **zero dependencies**.

## Use it as a library

```js
import { fundingDivergence } from "x402-funding-divergence";

const data = await fundingDivergence({ topN: 10 });

console.log(data.pairs_tradable);   // pairs that passed the liquidity floor
console.log(data.top);              // the 10 widest divergences
console.log(data.all);              // every tradable pair
```

Tune the floor with environment variables when the defaults are too strict for your universe:

```bash
MIN_OI_USD=500000 MIN_VOL_USD=1000000 node your-script.mjs
```

## Use it as an MCP tool

Any MCP-compatible client can call the sensor directly. Add this to your client configuration:

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

The tool is exposed as `get_funding_divergence` and accepts an optional `limit` (1–50, default 5). An agent that speaks MCP gets funding divergence with no integration work and no payment setup.

## Use the hosted endpoint (pay per call)

A hosted instance runs at `https://x402-funding.onrender.com` and is billed per request over [x402](https://www.x402.org), the HTTP-native payment protocol: the server answers `402 Payment Required`, your client attaches a signed USDC authorization, the request completes.

```
GET https://x402-funding.onrender.com/funding?limit=5
```

- **Price:** $0.02 per call, paid in USDC on Base.
- **Optional query parameter:** `limit`, 1–50.
- **No account, no key:** the paying address is the only identity involved.

> **Zero configuration.** Your agent needs no ETH and no exchange account.
>
> **Automatic payment.** The x402 SDK signs the USDC payment and handles authentication in the background.
>
> **100% gasless.** Coinbase, acting as facilitator, pays the network fee. You only pay the $0.02.

To your code this is an API call like any other: one request in, one JSON body out. No wallet UI, no signing prompt, no blockchain library to configure beyond the snippet below.

Client example, using the x402 SDK:

```bash
npm install @x402/fetch @x402/evm viem
```

```js
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("https://x402-funding.onrender.com/funding?limit=5");

console.log(await res.json());
```

## Response shape

```jsonc
{
  "updated_at": "2026-10-30T20:15:21.409Z",
  "methodology": "Annualised funding: Hyperliquid hourly x 8760; Binance 8h x 1095. ...",
  "liquidity_floor": { "min_oi_usd": 1000000, "min_vol_usd": 2000000 },
  "pairs_compared": 168,          // coins listed on both venues
  "pairs_rejected_illiquid": 96,  // dropped by the floor
  "pairs_tradable": 72,           // published
  "top": [ /* topN rows, widest divergence first */ ],
  "all": [ /* every tradable row */ ]
}
```

Each row:

| Field | Type | Meaning |
|---|---|---|
| `coin` | string | Base asset, e.g. `BTC` |
| `hl_apr_pct` | number | Hyperliquid funding, annualized, in percent |
| `bn_apr_pct` | number | Binance funding, annualized, in percent |
| `divergence_bps` | number | `hl_apr_pct − bn_apr_pct`, in basis points |
| `oi_usd` | number | Hyperliquid open interest, USD |
| `vol_24h_usd` | number | Hyperliquid 24h notional volume, USD |
| `trade` | string | `short_hyperliquid_long_binance` or `long_hyperliquid_short_binance` |

## Methodology

- Hyperliquid publishes funding **hourly**: annualized as `rate × 8760`.
- Binance publishes funding **every 8 hours**: annualized as `rate × 1095`.
- Divergence is `HL − BN`, expressed in basis points.
- A positive divergence means Hyperliquid funding is richer, so the carry trade shorts Hyperliquid and longs Binance.
- Rows are sorted by absolute divergence, so the widest gaps appear first regardless of sign.

Both venues are public and unauthenticated. The sensor issues two parallel requests and returns in roughly 500 ms on a warm connection.

## Self-host it

The package ships the full server. Clone the repository, install, and point it at a receiving address:

```bash
npm install
cp .env.example .env
npm start
```

| Variable | Required | Purpose |
|---|---|---|
| `PAY_TO` | yes | EVM address that receives payments. Public address only; no private key on the server. |
| `NETWORK` | no | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia) |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | mainnet | Coinbase CDP credentials; the hosted facilitator authenticates with them |
| `PRICE` | no | Per-call price, default `$0.02` |
| `MIN_OI_USD` / `MIN_VOL_USD` | no | Liquidity floor |
| `PORT` | no | Default `4021` |

`GET /health` is free and returns the active network. `GET /funding` is the paid route.

Mainnet requires CDP credentials because the public x402 facilitator serves testnets only. The server refuses to start on `eip155:8453` without them rather than failing at the first payment.

The first 1,000 settlements each month are free; beyond that the facilitator charges $0.001 per settlement. That figure sets your floor for a viable per-call price.

## Hosted vs. self-hosted: what you are actually paying for

Self-hosting costs nothing in money. It costs an afternoon of setup and a standing obligation to keep the service running. Both paths return the same JSON.

- **Zero maintenance.** No upstream API changes to track, no restarts, no CDP credentials to rotate.
- **Always warm.** The hosted instance runs continuously, so an agent loop never pays for a cold start. You configure no keep-alive job of your own.
- **One line of code.** No clone, no `.env`, no 281-package install. A `fetch` call is the whole integration.

| | Hosted | Self-hosted |
|---|---|---|
| Time to first call | one `fetch` | clone, install, credentials, deploy |
| Ongoing work | none | Node runtime, facilitator config, restarts |
| Marginal cost | $0.02 per call | your own infrastructure |
| Liquidity floor | fixed at OI ≥ $1M, volume ≥ $2M | you choose |
| Payments go to | the operator | you |
| Uptime | handled | yours to arrange |

Choose the hosted endpoint when this data is an input to something else you are building. Self-host when you need your own liquidity floor, your own receiving address, or a different network.

## License

MIT

---

Built on public venue APIs. Funding rates change continuously; the numbers this package returns are a snapshot, not a forecast.
