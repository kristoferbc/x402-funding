# x402 Funding Divergence — Lite

[![npm version](https://img.shields.io/npm/v/x402-funding-lite.svg)](https://www.npmjs.com/package/x402-funding-lite)
[![license](https://img.shields.io/npm/l/x402-funding-lite.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/x402-funding-lite.svg)](https://nodejs.org)

**Perpetual funding rates, compared across venues.** Hyperliquid vs Binance, annualized, liquidity-filtered, with the direction of the basis trade already resolved.

**Zero dependencies.** Native `fetch` only. Nothing to audit, nothing to keep up to date.

```js
import { fundingDivergence } from "x402-funding-lite";

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

The `trade` field tells you which leg to short and which to long. No interpretation needed downstream.

## Install

```bash
npm install x402-funding-lite
```

Requires Node.js 20 or newer. No other package is installed.

## Why compare two venues

A funding rate on one venue tells you what that venue thinks. The gap between two venues tells you what you can actually collect.

Doing it by hand means two APIs, two funding intervals, two unit conventions, and a filter for pairs where the spread is real rather than an artifact of a dead order book. This package does that in one call, in about half a second.

- **Two venues, one shape.** Hyperliquid publishes hourly funding; Binance publishes every 8 hours. Both are normalized to annualized percentages so the numbers are directly comparable.
- **Liquidity filter on by default.** Open interest ≥ $1M and 24h volume ≥ $2M, configurable. Thin pairs produce spectacular but unexecutable numbers; they are dropped before they reach you.
- **Direction included.** The sign of the divergence determines the trade, and the trade string is computed for you.

## Usage

```js
import { fundingDivergence } from "x402-funding-lite";

const data = await fundingDivergence({ topN: 10 });

console.log(data.pairs_tradable);   // pairs that passed the liquidity floor
console.log(data.top);              // the 10 widest divergences
console.log(data.all);              // every tradable pair
```

Tune the floor when the defaults are too strict for your universe:

```bash
MIN_OI_USD=500000 MIN_VOL_USD=1000000 node your-script.mjs
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
- Divergence is `HL − BN`, in basis points.
- A positive divergence means Hyperliquid funding is richer, so the carry trade shorts Hyperliquid and longs Binance.
- Rows are sorted by absolute divergence, so the widest gaps appear first regardless of sign.

Both venues are public and unauthenticated. Two parallel requests, roughly 500 ms warm.

## Related

- **[x402-funding-divergence](https://www.npmjs.com/package/x402-funding-divergence)** — the same sensor plus an MCP server and a self-hostable x402 payment server. Heavier: it ships the payment stack.
- **Hosted endpoint** — if you would rather not run anything, `GET https://x402-funding.onrender.com/funding?limit=5` is billed $0.02 per call in USDC on Base over the [x402](https://www.x402.org) protocol. No API key, no account.

## License

MIT

---

Built on public venue APIs. Funding rates change continuously; the numbers returned are a snapshot, not a forecast.
