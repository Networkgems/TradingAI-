// TRA-546 (TRA-529 P3 §7) — point-in-time replay of the advisory multi-agent
// graph. Walks a historical candle series with an AS-OF CLOCK: at each decision
// bar the analysts only ever see candles/news/fundamentals timestamped at or
// before `asOf` (no look-ahead, TRA-529 §3.1). Every run's AgentRecommendation
// is persisted (it already carries costUsd + latencyMs) so the §7/§8 scoring,
// calibration and net-of-cost-edge plumbing can score it later.
//
// This is INFRASTRUCTURE ONLY and incurs NO LLM spend — it drives the P1 stub
// graph (deterministic fakes). P2's real, LlmClient-backed agents drop in via
// `AgentReplayConfig.graphDeps.llm` with zero changes to this loop, and the
// real OOS verdict is run once those land.
import type { AgentRecommendation, Candle, TradeSignal } from '@trading-app/shared';
import {
  runAgentGraph,
  type AgentGraphDeps,
  type AgentGraphInput,
  type FundamentalSnapshot,
  type NewsHeadline,
} from '@trading-app/agents';

/**
 * A deterministic candidate-signal generator. The agent layer is *additive*
 * (TRA-529 §6.1): it only runs on a deterministic precondition and anchors its
 * trade to the candidate that gated the run. For the validation harness this
 * stands in for the live strategy stack — it sees ONLY the point-in-time window
 * (all candles ≤ asOf) so it can never look ahead. Return `null` to skip the
 * bar (no event gated a run).
 */
export type CandidateGenerator = (
  asOf: number,
  window: ReadonlyArray<Candle>,
) => TradeSignal | null;

/** A single persisted replay step: the recommendation plus its scoring keys. */
export interface AgentReplayRecord {
  /** The persisted graph output — carries costUsd + latencyMs (TRA-529 §4/§6). */
  recommendation: AgentRecommendation;
  /** The deterministic baseline signal that gated this run (null if none). */
  candidateSignal: TradeSignal | null;
  /** Index of the `asOf` bar in the full series — used to slice future bars. */
  barIndex: number;
  /** The decision-bar timestamp (epoch ms). Mirrors recommendation.asOf. */
  asOf: number;
}

export interface AgentReplayConfig {
  symbol: string;
  /**
   * Candidate-signal generator. Defaults to {@link momentumCandidate} so the
   * harness runs end-to-end out of the box, but P2 can inject the real
   * strategy-derived candidate stream.
   */
  candidateAt?: CandidateGenerator;
  /**
   * Bars of warm-up before the first decision bar so analysts have context.
   * Default 30 (the technical analyst's data-confidence saturates at 30 bars).
   */
  warmup?: number;
  /** Stride between decision bars (event-gate cadence). Default 1 (every bar). */
  step?: number;
  /**
   * Point-in-time news pool. Each headline is filtered to `timestamp ≤ asOf`
   * before it reaches an analyst — the harness's primary no-look-ahead guard
   * for non-price evidence. Optional (P1 stub ignores sentiment content).
   */
  news?: NewsHeadline[];
  /**
   * Fundamentals snapshot. P1 treats this as static; P2 will make it
   * as-of-aware. Passed through unchanged.
   */
  fundamentals?: FundamentalSnapshot;
  /** Graph deps (clock, debate rounds, P2's llm seam). */
  graphDeps?: AgentGraphDeps;
}

export interface AgentReplayResult {
  symbol: string;
  /** Every recommendation produced during replay, oldest→newest. */
  records: AgentReplayRecord[];
  /** Σ costUsd across all records (0 for the P1 stub; real $ in P2). */
  totalCostUsd: number;
  /** Σ latencyMs across all records. */
  totalLatencyMs: number;
  /** Bars in the series. */
  bars: number;
  /** Decision bars that actually fired a candidate (= records.length). */
  decisions: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * A simple, transparent deterministic candidate generator: fire a momentum
 * trade when the trailing `lookback`-bar return exceeds `threshold`, anchoring
 * a `stopPct` stop and an `rr`× target. Pure function of the point-in-time
 * window — it cannot see future bars. This is harness scaffolding, NOT a
 * tradeable strategy; P2 injects the real candidate stream.
 */
export function momentumCandidate(opts: {
  lookback?: number;
  threshold?: number;
  stopPct?: number;
  rr?: number;
} = {}): CandidateGenerator {
  const lookback = opts.lookback ?? 10;
  const threshold = opts.threshold ?? 0.01;
  const stopPct = opts.stopPct ?? 0.02;
  const rr = opts.rr ?? 2;
  return (asOf, window) => {
    if (window.length < lookback + 1) return null;
    const last = window[window.length - 1]!;
    const first = window[window.length - 1 - lookback]!;
    if (first.close <= 0) return null;
    const ret = (last.close - first.close) / first.close;
    if (Math.abs(ret) < threshold) return null;
    const side: TradeSignal['side'] = ret > 0 ? 'buy' : 'sell';
    const entry = last.close;
    const stop = side === 'buy' ? entry * (1 - stopPct) : entry * (1 + stopPct);
    const target = side === 'buy' ? entry * (1 + stopPct * rr) : entry * (1 - stopPct * rr);
    return {
      id: `cand-${last.symbol}-${asOf}`,
      symbol: last.symbol,
      type: 'momentum',
      side,
      entryPrice: round(entry),
      stopLoss: round(stop),
      takeProfit: round(target),
      riskRewardRatio: round(rr),
      timestamp: asOf,
    };
  };
}

/**
 * Replay the advisory graph over a candle series under an as-of clock.
 *
 * Invariant (TRA-529 §3.1, the whole point of P3): at decision bar `i`, the
 * graph input contains ONLY `candles[0..i]` and news with `timestamp ≤
 * candles[i].timestamp`. Nothing the analysts read post-dates the decision bar,
 * so a replay score is a faithful out-of-sample proxy with no leakage.
 */
export async function replayAgents(
  candles: Candle[],
  config: AgentReplayConfig,
): Promise<AgentReplayResult> {
  const warmup = Math.max(1, config.warmup ?? 30);
  const step = Math.max(1, config.step ?? 1);
  const candidateAt = config.candidateAt ?? momentumCandidate();
  const news = config.news ?? [];

  const records: AgentReplayRecord[] = [];
  let totalCostUsd = 0;
  let totalLatencyMs = 0;

  for (let i = warmup; i < candles.length; i += step) {
    const asOf = candles[i]!.timestamp;
    // As-of window: every candle at/before the decision bar, oldest→newest.
    const window = candles.slice(0, i + 1);
    const candidateSignal = candidateAt(asOf, window);
    if (!candidateSignal) continue; // no event gated a run this bar.

    // No-look-ahead filter for non-price evidence (§3.1). News is the field
    // most prone to leakage, so it is filtered explicitly here rather than
    // trusting upstream callers.
    const visibleNews = news.filter((n) => n.timestamp <= asOf);

    const input: AgentGraphInput = {
      symbol: config.symbol,
      asOf,
      candles: window,
      candidateSignal,
      ...(config.fundamentals ? { fundamentals: config.fundamentals } : {}),
      ...(visibleNews.length ? { news: visibleNews } : {}),
    };

    const recommendation = await runAgentGraph(input, config.graphDeps);
    totalCostUsd = round(totalCostUsd + recommendation.costUsd, 6);
    totalLatencyMs += recommendation.latencyMs;
    records.push({ recommendation, candidateSignal, barIndex: i, asOf });
  }

  return {
    symbol: config.symbol,
    records,
    totalCostUsd,
    totalLatencyMs,
    bars: candles.length,
    decisions: records.length,
  };
}

/** Cap a conviction into the contract's [0,1] band (defensive helper for tests). */
export const clampConviction = (v: number): number => clamp(v, 0, 1);
