/**
 * Type definitions for x402-funding-divergence.
 *
 * Mirrors schema/funding-divergence.schema.json (JSON Schema Draft 2020-12).
 * Fields may be added in future minor versions; ignore what you do not read.
 */

/** Venue used as the funding benchmark. Binance is tried first, OKX where Binance restricts the region. */
export type BenchmarkVenue = "binance" | "okx";

/**
 * Which leg to short and which to long.
 * The leg with the higher annualised funding is shorted, because a short receives
 * funding when the rate is positive.
 */
export type TradeDirection =
  | "short_hyperliquid_long_binance"
  | "long_hyperliquid_short_binance"
  | "short_hyperliquid_long_okx"
  | "long_hyperliquid_short_okx";

/** Mean and dispersion of both legs over the recent window, each annualised with its own interval. */
export interface Stability {
  window_hours: number;
  /** Settlements found in the window. 72h at an 8h interval yields 9 samples, not 72. */
  cex_samples: number;
  /** Hyperliquid settles hourly, so this is normally the window length. */
  hl_samples: number;
  cex_mean_apr_pct: number | null;
  cex_std_apr_pct: number | null;
  hl_mean_apr_pct: number | null;
  hl_std_apr_pct: number | null;
}

/** One tradable pair: liquid on both legs, with the gap and the direction to take. */
export interface FundingRow {
  coin: string;
  /** Hyperliquid APR minus benchmark APR, in basis points. The sign carries the direction of the gap. */
  divergence_bps: number;
  hl_apr_pct: number;
  cex_apr_pct: number;
  /** Read from the venue, never assumed. Hyperliquid is 1. */
  hl_interval_hours: number;
  /** Read from the venue: 1, 4 or 8 hours depending on the instrument. */
  cex_interval_hours: number;
  oi_usd: number;
  vol_24h_usd: number;
  cex_vol_24h_usd: number;
  trade: TradeDirection;
  /** True above the anomaly threshold. Flagged rows are ranked after ordinary rows. */
  anomaly: boolean;
  /** null when the row is past the stability enrichment limit, or history was unavailable. */
  stability: Stability | null;
  /** Present only on GET /ultra. */
  capacity?: Capacity | null;
}

/** Capacity was measured against live order books. */
export interface CapacityMeasured {
  available: true;
  /** Notional executable on both legs before the combined impact exceeds the budget. */
  usd: number;
  /** True when the solver hit its ceiling: read `usd` as "at least this much". */
  usd_lower_bound: boolean;
  impact_budget_bps: number;
  hl_impact_bps: number;
  cex_impact_bps: number;
  hl_book_usd: number;
  cex_book_usd: number;
  side_hyperliquid: "bid" | "ask";
  side_benchmark: "bid" | "ask";
  fees_assumed_bps: number;
  /** Round-trip cost: assumed fees plus both impacts. */
  entry_cost_bps: number;
  carry_bps_per_day: number;
  /** entry_cost_bps / carry_bps_per_day. */
  breakeven_days: number;
  /** "impact_budget", "capped_by_visible_depth" or "capped_by_request". */
  reason: string;
}

/** Capacity could not be measured for this pair. */
export interface CapacityUnavailable {
  available: false;
  error?: string;
  reason?: string;
}

export type Capacity = CapacityMeasured | CapacityUnavailable;

export interface BenchmarkInfo {
  venue: BenchmarkVenue;
  funding_interval: string;
  /** Venues that failed before this one answered. Empty when the first choice worked. */
  fallbacks: { venue: string; error: string }[];
}

export interface LiquidityFloor {
  min_oi_usd: number;
  min_vol_usd: number;
  min_cex_vol_usd: number;
}

export interface CapacityMethod {
  rows_requested: number;
  rows_measured: number;
}

/** Response of fundingDivergence(), GET /funding and GET /ultra. */
export interface FundingResponse {
  updated_at: string;
  benchmark: BenchmarkInfo;
  /** Plain-language description of the annualisation, including the intervals actually used. */
  methodology: string;
  liquidity_floor: LiquidityFloor;
  anomaly_threshold_bps: number;
  pairs_considered: number;
  /** Pairs the benchmark venue does not list. */
  pairs_not_checked_on_venue: number;
  pairs_compared: number;
  pairs_rejected_illiquid: number;
  pairs_rejected_cex_illiquid: number;
  /** Rows in `all`. */
  pairs_tradable: number;
  pairs_flagged_anomaly: number;
  /** The first `topN` rows, ranked by absolute divergence with anomalies last. */
  top: FundingRow[];
  /** Every tradable row, same order. */
  all: FundingRow[];
  /** Added by the HTTP layer only. */
  notice?: string;
  /** Present only on GET /ultra. */
  capacity_method?: CapacityMethod;
}

/** The trimmed shape returned by the MCP tool. */
export interface McpFundingResponse {
  updated_at: string;
  benchmark: BenchmarkInfo;
  liquidity_floor: LiquidityFloor;
  anomaly_threshold_bps: number;
  pairs_tradable: number;
  pairs_flagged_anomaly: number;
  top: FundingRow[];
}

export interface FundingDivergenceOptions {
  /** Number of rows in `top`. Default 5. */
  topN?: number;
}

/**
 * Fetch the current divergence, computing locally against the public venue APIs.
 * No key, no account, no payment.
 */
export declare function fundingDivergence(
  options?: FundingDivergenceOptions,
): Promise<FundingResponse>;

export default fundingDivergence;
