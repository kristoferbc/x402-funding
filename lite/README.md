# Hyperliquid × Binance Funding Divergence

[![npm version](https://img.shields.io/npm/v/hyperliquid-binance-funding.svg)](https://www.npmjs.com/package/hyperliquid-binance-funding)
[![license](https://img.shields.io/npm/l/hyperliquid-binance-funding.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/hyperliquid-binance-funding.svg)](https://nodejs.org)

**Perpetual funding rates, compared across venues.** Hyperliquid against a liquid CEX benchmark, annualized with each venue's real funding interval, filtered for pairs that are liquid on both legs, with the direction of the basis trade already resolved.

**Zero dependencies.** Native `fetch` only. Nothing to audit, nothing to keep up to date.

```js
import { fundingDivergence } from "hyperliquid-binance-funding";

const { top } = await fundingDivergence({ topN: 5 });
```

```json
[
  {
    "coin": "AAVE",
    "hl_apr_pct": 10.95,
    "cex_apr_pct": -7.29,
    "divergence_bps": 1823.8,
    "cex_interval_hours": 8,
    "oi_usd": 58969834,
    "vol_24h_usd": 8784527,
    "cex_vol_24h_usd": 103668389,
    "anomaly": false,
    "trade": "short_hyperliquid_long_binance"
  }
]
```

The `trade` field tells you which leg to short and which to long, and it names the venue those numbers actually came from.

> **Binance is the default benchmark, not the only one.** Binance answers `HTTP 451` from US addresses and Bybit refuses them too, so the sensor falls back to OKX and reports which venue served the data in `benchmark.venue`. Nothing to configure.

## Install

```bash
npm install hyperliquid-binance-funding
```

Requires Node.js 20 or newer. No other package is installed.

## What it actually measures

A funding rate on one venue tells you what that venue thinks. The gap between two venues tells you how far apart their carry expectations sit — which is the raw input for a basis decision, not a return forecast.

Doing it by hand means reconciling funding intervals that differ per venue and per instrument, two unit conventions, and a filter for pairs where both order books are deep enough to trade. This package does that in one call.

- **Intervals are read, not assumed.** Hyperliquid funds hourly. Binance defaults to 8-hour funding, but 4-hour is common — of the 820 contracts it lists, 465 settle every 4 hours — so the interval comes from `/fapi/v1/fundingInfo` per symbol. OKX varies by instrument. Each leg is annualized with its own interval, read from the venue. Assuming 8 hours divides the result by two on every 4-hour contract, silently.
- **Both legs must be liquid.** Open interest ≥ $1M and 24h volume ≥ $2M on Hyperliquid, plus 24h quote volume ≥ $2M on the benchmark venue. A pair that is deep on one side and empty on the other is not tradable.
- **Dislocations are flagged, not promoted.** Beyond 2,000 bps the row is marked `anomaly: true` and ranked after the ordinary rows (upstream caps: `ANOMALY_BPS`).
- **Direction included.** The sign of the divergence determines the trade.

## Usage

```js
import { fundingDivergence } from "hyperliquid-binance-funding";

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
| `cex_interval_hours` | number | Benchmark venue funding interval, per instrument |
| `oi_usd` | number | Hyperliquid open interest, USD |
| `vol_24h_usd` | number | Hyperliquid 24h notional volume, USD |
| `cex_vol_24h_usd` | number | Benchmark venue 24h quote volume, USD |
| `anomaly` | boolean | Divergence beyond `anomaly_threshold_bps` |
| `trade` | string | `short_hyperliquid_long_<venue>` or `long_hyperliquid_short_<venue>` |
| `stability` | object \| null | Recent mean and standard deviation of both legs; computed for the first `STABILITY_MAX_ROWS` rows only, `null` elsewhere |

## Methodology

- Hyperliquid publishes funding **hourly**: `rate × 8760`.
- Binance defaults to 8-hour funding, but 465 of the 820 contracts it lists settle every 4 hours and 2 every hour. The interval comes from `/fapi/v1/fundingInfo` per symbol, then `rate × (8760 / interval)`.
- OKX publishes one rate per instrument. The interval is derived from `nextFundingTime − fundingTime` in the response, then the same formula.
- Divergence is `HL − benchmark`, in basis points.
- A positive divergence means Hyperliquid funding is richer, so the carry shorts Hyperliquid and longs the venue named in `benchmark.venue`.
- Rows are sorted by absolute divergence, with anomalies placed after ordinary rows.

## What this is not

The divergence is an **instantaneous** annualization, not a forecast. A funding rate that reads −200% annualized today can read +50% tomorrow: the annualization multiplies whatever the last settlement was by 1,095 or 2,190. The `stability` block exists precisely so you can see how much a given pair's rate moves before treating the gap as a return.

Both venues are public and unauthenticated.

## Related

- **[x402-funding-divergence](https://www.npmjs.com/package/x402-funding-divergence)** — the same sensor plus an MCP server and a self-hostable x402 payment server. Heavier: it ships the payment stack.
- **Hosted endpoint** — if you would rather not run anything, `GET https://x402-funding.onrender.com/funding?limit=5` is billed $0.02 per call in USDC on Base over the [x402](https://www.x402.org) protocol. No API key, no account.

## License

MIT
