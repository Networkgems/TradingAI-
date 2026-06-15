// TRA-544 (TRA-529 P1) — inputs the multi-agent graph consumes. The wire
// contracts the graph *emits* (AnalystReport, TraderDecision, RiskVerdict,
// AgentRecommendation) live in @trading-app/shared; these are the engine-side
// inputs that never cross the WS boundary.
import type { Candle, SocialSentiment, TradeSignal } from '@trading-app/shared';

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
  /**
   * TRA-813 (P4 Piece 1) — per-symbol StockTwits social-sentiment aggregate
   * (TRA-602), read at the call site from `engine.getSocialSentiment(symbol)`.
   * Consumed by the social-sentiment analyst. Optional + additive: when absent
   * the analyst abstains (neutral, low confidence), exactly like the news feed.
   * The aggregate is computed as-of the live cache read; the analyst still pins
   * its horizon short because social buzz is a fast-decaying signal.
   */
  social?: SocialSentiment;
  /**
   * TRA-850 — the owning user's persistent advisory PREFERENCES, read into the
   * graph context so recommendations are personalized + consistent across
   * sessions instead of stateless per tick. Strictly preferences (risk
   * tolerance, preferred/avoided strategies, a sizing default, watchlist
   * rationale) — NOT a self-modifying strategy: the backtest/calibration gate
   * stays authoritative and the agent layer can still only DE-RISK. Optional +
   * additive: absent ⇒ the graph behaves exactly as before.
   */
  userMemory?: UserTradingMemory;
}

/** Risk appetite the user has expressed. Coarse on purpose — it tilts tone + sizing, never the gate. */
export type RiskTolerance = 'conservative' | 'moderate' | 'aggressive';

/**
 * TRA-850 — one user's persistent advisory preferences. Every field is OPTIONAL:
 * the store starts empty and fills as the user states preferences or as
 * approve/reject interactions accrue. PREFERENCES ONLY — nothing here changes a
 * strategy's parameters or bypasses the promotion gate; it personalizes the
 * advisory read (tone + a de-risk-only sizing tilt) so the desk feels consistent
 * across sessions.
 */
export interface UserTradingMemory {
  /** Stated risk appetite — tilts the advisory tone and the de-risk sizing default. */
  riskTolerance?: RiskTolerance;
  /**
   * Strategy ids/types the user leans toward (e.g. 'momentum', 'orb'). Surfaced
   * to the model as context; it never forces a trade the gate would not allow.
   */
  preferredStrategies?: string[];
  /** Strategy ids/types the user has repeatedly rejected — the model de-emphasizes them. */
  avoidedStrategies?: string[];
  /**
   * The user's default position-size tilt as a fraction in (0,1], applied as a
   * deterministic DE-RISK shrink on the final size (1 = no shrink, 0.5 = half).
   * Can only ever reduce size — it never enlarges past the risk panel's clamp.
   */
  sizingMultiplier?: number;
  /** Per-symbol watchlist rationale (UPPERCASE symbol → why the user is watching it). */
  watchlistRationale?: Record<string, string>;
  /** Free-form notes the user asked the desk to remember. */
  notes?: string;
  /** ISO-8601 timestamp this memory was last updated (audit/freshness). */
  updatedAt?: string;
}
