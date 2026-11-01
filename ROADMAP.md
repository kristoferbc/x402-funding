# Roadmap

Deferred on purpose. Nothing here has a date, and listing something is not a promise.

## Dual benchmark venue

**What.** Query Binance *and* OKX on every call, then publish either the median of the two, the venue with the deepest book, or both side by side.

**Why it matters.** Today one benchmark is used at a time: Binance, or OKX where Binance restricts the region. A gap measured against a single venue can be that venue's own dislocation rather than a real carry — and the caller cannot tell which, because only one comparison was made. Two venues turn a single observation into a check on itself.

**What it would change.**

- `benchmark.venue` becomes a list, or a `comparisons: [{venue, cex_apr_pct, divergence_bps}]` array per row.
- The liquidity floor applies to two benchmark venues instead of one.
- Response time roughly doubles for `/funding` and more than doubles for `/ultra`, which already reads two order books per pair. The 20-second ceiling on `/ultra` would need revisiting.
- Any agent reading the current shape needs a migration path. Adding fields is safe; changing `trade` is not.

**Open questions.** Median of the two, or the deepest book? What if one venue does not list the pair — publish the single comparison, or drop the row? A composite hides the disagreement, which is itself information.

## Rejected for now

- **Historical series / backtesting.** Storage, retention and a query API for something no current buyer has asked for.
- **Execution or position management.** This is a data API. It publishes what the market can absorb and what entering costs; it does not trade and does not advise.
- **Uptime monitoring inside the project.** Handled externally.

## Done

- 1.4.0 — TypeScript declarations and a JSON Schema, so an integration is an import away.
- 1.3.0 — `/ultra` with measured execution capacity.
- 1.2.0 — per-instrument funding intervals and the OKX fallback.
