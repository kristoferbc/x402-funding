# x402 Funding Divergence

[![npm version](https://img.shields.io/npm/v/x402-funding-divergence.svg)](https://www.npmjs.com/package/x402-funding-divergence)
[![npm downloads](https://img.shields.io/npm/dm/x402-funding-divergence.svg)](https://www.npmjs.com/package/x402-funding-divergence)
[![license](https://img.shields.io/npm/l/x402-funding-divergence.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/x402-funding-divergence.svg)](https://nodejs.org)

**Perpetual funding rates, compared across venues.** Hyperliquid against a liquid CEX benchmark — Binance, or OKX where Binance restricts the region — annualized with each venue's real funding interval, filtered for pairs liquid on both legs, with the direction of the basis trade already resolved.

One call returns every pair where the two venues disagree, sorted by the size of the gap. No API keys, no signup, no rate-limit negotiation.

```js
import { fundingDivergence } from "x402-funding-divergence";

const { top } = await fundingDivergence({ topN: 5 });
```

```json
[
  {
    "coin": "AAVE",
    "hl_apr_pct": 10.95,
    "cex_apr_pct": -7.29,
    "divergence_bps": 1823.8,
    "hl_interval_hours": 1,
    "cex_interval_hours": 8,
    "oi_usd": 58969834,
    "vol_24h_usd": 8784527,
    "cex_vol_24h_usd": 103668389,
    "anomaly": false,
    "trade": "short_hyperliquid_long_binance",
    "stability": { "window_hours": 72, "cex_samples": 9, "hl_samples": 72, "cex_mean_apr_pct": -0.03, "cex_std_apr_pct": 7.47, "hl_mean_apr_pct": 6.2, "hl_std_apr_pct": 9.79 }
  }
]
```

That `trade` field is the whole point: it tells you which leg to short and which to long, and it names the venue those numbers came from. No interpretation needed downstream.

## Why this exists

A funding rate on one venue tells you what that venue thinks. The gap between two venues tells you how far apart their carry expectations sit — the raw input for a basis decision, not a return forecast.

Doing it by hand means reconciling funding intervals that differ per venue **and per instrument**, two unit conventions, and a filter for pairs where both order books are deep enough to trade. This package does that in one call.

- **Intervals are read, not assumed.** Hyperliquid funds hourly. Binance defaults to 8-hour funding, but 4-hour is common — of the 820 contracts it lists, 465 settle every 4 hours, 2 every hour — so the interval comes from `/fapi/v1/fundingInfo` per symbol. OKX varies per instrument, so it is derived from `nextFundingTime − fundingTime`. Assuming 8 hours everywhere halves the annualized figure on every 4-hour contract, with no visible error.
- **Both legs must be liquid.** Open interest ≥ $1M and 24h volume ≥ $2M on Hyperliquid, plus 24h quote volume ≥ $2M on the benchmark venue. A pair that is deep on one side and empty on the other cannot be traded, however wide the gap looks.
- **Dislocations are flagged, not promoted.** Beyond 2,000 bps the row is marked `anomaly: true` and ranked after the ordinary rows. A gap that wide is usually one venue dislocating, not a carry you can hold.
- **It works from a blocked region.** Binance answers HTTP 451 from US addresses, and Bybit's CDN refuses them too. The sensor tries Binance, falls back to OKX, and tells you which one it used in `benchmark.venue`. Nothing to configure — it takes whichever responds.
- **The sensor module has zero dependencies.** Native `fetch`, nothing else, so it runs in Node 20+, in a serverless function, or on an edge runtime. The full package adds the x402 payment server on top.

> **Two ways to consume it.** Locally, through the library or the MCP tool — free, and the only network calls are to the venue APIs. Or remotely, over HTTP at `https://x402-funding.onrender.com/funding`, billed at $0.02 per call over x402. Both return the same JSON. See [Use the hosted endpoint](#use-the-hosted-endpoint-pay-per-call).

Whether you use the free local package or the paid hosted endpoint, you never manage blockchain complexity: no RPC endpoint, no ETH, no KYC.

## Install

```bash
npm install x402-funding-divergence
```

Requires Node.js 20 or newer.

> **Only want the data?** This package ships the full payment server along with its dependencies. If you just need the sensor, install [`hyperliquid-binance-funding`](https://www.npmjs.com/package/hyperliquid-binance-funding) — same sensor file, same output, **zero dependencies**.

## Use it as a library

```js
import { fundingDivergence } from "x402-funding-divergence";

const data = await fundingDivergence({ topN: 10 });

console.log(data.benchmark.venue);   // "binance" or "okx"
console.log(data.pairs_tradable);    // pairs that cleared both liquidity floors
console.log(data.top);               // first topN rows, ordinary rows before anomalies
console.log(data.all);               // every tradable row
```

Tune the floors when the defaults are too strict for your universe:

```bash
MIN_OI_USD=500000 MIN_VOL_USD=1000000 MIN_CEX_VOL_USD=1000000 node your-script.mjs
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
- **Free diagnostics:** `GET /health` for liveness, `GET /sources` for which benchmark venues that host can actually reach.

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
  "benchmark": {
    "venue": "binance",              // or "okx" where Binance restricts the region
    "funding_interval": "read per instrument from the venue",
    "fallbacks": []                  // venues tried and failed before this one
  },
  "methodology": "Annualised funding, each leg with its own funding interval: ...",
  "liquidity_floor": { "min_oi_usd": 1000000, "min_vol_usd": 2000000, "min_cex_vol_usd": 2000000 },
  "anomaly_threshold_bps": 2000,
  "pairs_considered": 49,             // cleared the Hyperliquid floor
  "pairs_not_checked_on_venue": 0,    // skipped because of the per-venue call cap
  "pairs_compared": 46,               // of those, also listed on the benchmark venue
  "pairs_rejected_illiquid": 130,     // failed the Hyperliquid floor
  "pairs_rejected_cex_illiquid": 0,   // failed the benchmark-venue floor
  "pairs_tradable": 46,               // published
  "pairs_flagged_anomaly": 11,
  "top": [ /* first topN rows */ ],
  "all": [ /* every tradable row, ordinary rows first */ ]
}
```

Each row:

| Field | Type | Meaning |
|---|---|---|
| `coin` | string | Base asset, e.g. `BTC` |
| `hl_apr_pct` | number | Hyperliquid funding, annualized, in percent |
| `cex_apr_pct` | number | Benchmark venue funding, annualized, in percent |
| `divergence_bps` | number | `hl_apr_pct − cex_apr_pct`, in basis points |
| `hl_interval_hours` | number | Hyperliquid funding interval, always 1 |
| `cex_interval_hours` | number | Benchmark venue funding interval for this instrument |
| `oi_usd` | number | Hyperliquid open interest, USD |
| `vol_24h_usd` | number | Hyperliquid 24h notional volume, USD |
| `cex_vol_24h_usd` | number | Benchmark venue 24h quote volume, USD |
| `anomaly` | boolean | Divergence beyond `anomaly_threshold_bps` |
| `trade` | string | `short_hyperliquid_long_<venue>` or `long_hyperliquid_short_<venue>`, where `<venue>` is `benchmark.venue` |
| `stability` | object \| null | Recent mean and standard deviation of both legs. Costs two upstream calls per row, so it is computed for the first `STABILITY_MAX_ROWS` rows only; `null` elsewhere |

## Methodology

- Hyperliquid publishes funding **hourly**: `rate × 8760`.
- Binance defaults to 8-hour funding, but 465 of the 820 contracts it lists settle every 4 hours and 2 every hour. The interval is read per symbol, then `rate × (8760 / interval)`.
- OKX publishes one rate per instrument. The interval is derived from the response, then the same formula.
- Divergence is `HL − benchmark`, expressed in basis points.
- A positive divergence means Hyperliquid funding is richer, so the carry shorts Hyperliquid and longs the venue named in `benchmark.venue`.
- Rows are sorted by absolute divergence, with anomalies placed after ordinary rows.

Both venues are public and unauthenticated. On the Binance path the sensor issues three parallel requests and returns in about 1.5 s. The OKX fallback costs one request per pair, so roughly 3.5 s for the liquid universe.

## What this is not

The divergence is an **instantaneous** annualization, not a forecast. A funding rate that reads −200% annualized today can read +50% tomorrow, because the annualization multiplies whatever the last settlement was by 1,095 or 2,190. That is why every row carries `stability`: how much this pair's rate has actually moved over the recent window, and where it sat on average.

A gap of 3,000 bps does not mean a 30% annual return. It usually means one venue is briefly dislocated, which is exactly what `anomaly` is there to tell you.

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
| `MIN_OI_USD` / `MIN_VOL_USD` | no | Hyperliquid liquidity floor |
| `MIN_CEX_VOL_USD` | no | Benchmark-venue liquidity floor |
| `ANOMALY_BPS` | no | Anomaly threshold, default `2000` |
| `X402_BENCHMARK_ORDER` | no | Venue order, default `binance,okx` |
| `OKX_MAX_COINS` | no | Max pairs compared on the OKX path, default `50` (one request each) |
| `STABILITY_MAX_ROWS` | no | Rows enriched with `stability`, default `10` |
| `STABILITY_WINDOW_HOURS` | no | Lookback for `stability`, default `72` |
| `PORT` | no | Default `4021` |

`GET /health` and `GET /sources` are free. `GET /funding` is the paid route.

Mainnet requires CDP credentials because the public x402 facilitator serves testnets only. The server refuses to start on `eip155:8453` without them rather than failing at the first payment.

The first 1,000 settlements each month are free; beyond that the facilitator charges $0.001 per settlement. That figure sets your floor for a viable per-call price.

## Hosted vs. self-hosted: what you are actually paying for

Self-hosting costs nothing in money. It costs an afternoon of setup and a standing obligation to keep the service running. Both paths return the same JSON.

- **Zero maintenance.** No upstream API changes to track, no restarts, no CDP credentials to rotate.
- **Always warm.** The hosted instance runs continuously, so an agent loop never pays for a cold start. You configure no keep-alive job of your own.
- **One line of code.** No clone, no `.env`, no full dependency install. A `fetch` call is the whole integration.

| | Hosted | Self-hosted |
|---|---|---|
| Time to first call | one `fetch` | clone, install, credentials, deploy |
| Ongoing work | none | Node runtime, facilitator config, restarts |
| Marginal cost | $0.02 per call | your own infrastructure |
| Liquidity floors | fixed at OI ≥ $1M, HL volume ≥ $2M, CEX volume ≥ $2M | you choose |
| Payments go to | the operator | you |
| Uptime | handled | yours to arrange |

Choose the hosted endpoint when this data is an input to something else you are building. Self-host when you need your own liquidity floors, your own receiving address, or a different network.

## License

MIT

---

Built on public venue APIs. Funding rates change continuously; the numbers this package returns are a snapshot, not a forecast.
