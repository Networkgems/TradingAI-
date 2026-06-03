// TRA-544 (TRA-529 P1) — inputs the multi-agent graph consumes. The wire
// contracts the graph *emits* (AnalystReport, TraderDecision, RiskVerdict,
// AgentRecommendation) live in @trading-app/shared; these are the engine-side
// inputs that never cross the WS boundary.
import type { Candle, TradeSignal } from '@trading-app/shared';

/** Point-in-time fundamentals snapshot for the fundamental analyst (P2 fills). */
export interface FundamentalSnapshot {
  peRatio?: number;
  /** YoY revenue growth as a fraction (0.2 = +20%). */
  revenueGrowth?: number;
  /** Net margin as a fraction. */
  netMargin?: number;
  /** Days until the next scheduled earnings event. */
  nextEarningsInDays?: number;
}

/** A single point-in-time news headline for the news-sentiment analyst. */
export interface NewsHeadline {
  headline: string;
  /** Epoch ms; MUST be ≤ the run's asOf (no look-ahead, TRA-529 §3.1). */
  timestamp: number;
  source: string;
  /** Optional pre-scored sentiment, −1 … +1. */
  sentiment?: number;
}

/**
 * Everything one agent-graph run sees for a single symbol. The graph is
 * event-gated (TRA-529 §6.1): it only runs when a deterministic precondition
 * fires (a candidate signal, a regime flip, a fresh news event), never on
 * every candle. `asOf` pins the decision bar — every analyst may only read
 * data timestamped at/before it (no look-ahead).
 */
export interface AgentGraphInput {
  symbol: string;
  asOf: number;
  /** Recent candles, oldest→newest, all timestamped at/before `asOf`. */
  candles: Candle[];
  /**
   * The deterministic candidate signal that gated this run, if any. When
   * present the trader anchors its proposed entry/stop/target to it rather
   * than re-deriving them, so the agent layer stays additive (it can shrink
   * or veto the strategy's idea, never invent a richer one).
   */
  candidateSignal: TradeSignal | null;
  fundamentals?: FundamentalSnapshot;
  news?: NewsHeadline[];
}
