// TRA-546 (TRA-529 P3 §7) — scoring plumbing for replayed recommendations.
// Scores each recommendation's realized outcome against the FUTURE bars that
// were hidden from it at decision time, and reports through the existing
// `EodSignalAccuracy` shape (hit-rate + avg R) so live EOD and replay speak the
// same language. Produces the agent-vs-deterministic-baseline comparison the
// §7 OOS study needs: the agent's routable APPROVE trades vs the deterministic
// candidate signals that gated them.
import type { Candle, EodSignalAccuracy, TradeSignal } from '@trading-app/shared';
import type { AgentReplayRecord } from './agent-replay.js';

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Realized R-multiple of a signal over the bars that followed it. R is measured
 * in stop-distances: a target-first exit pays `(target−entry)/risk` R, a
 * stop-first exit pays −1R, and an unresolved trade is marked-to-market at the
 * horizon's last close. When target and stop are touched in the same bar we
 * assume the stop filled first (pessimistic, matching the live fill model's
 * intrabar ambiguity). Mirrors `runner.reachedOneR`'s touch test but returns a
 * continuous R rather than a boolean so avg-R is meaningful.
 */
export function realizedR(
  signal: TradeSignal,
  future: ReadonlyArray<Candle>,
): number {
  const risk = Math.abs(signal.entryPrice - signal.stopLoss);
  if (risk === 0 || future.length === 0) return 0;
  const rewardR = Math.abs(signal.takeProfit - signal.entryPrice) / risk;
  for (const c of future) {
    const hitTarget = signal.side === 'buy'
      ? c.high >= signal.takeProfit
      : c.low <= signal.takeProfit;
    const hitStop = signal.side === 'buy'
      ? c.low <= signal.stopLoss
      : c.high >= signal.stopLoss;
    if (hitStop) return -1; // pessimistic tie-break: stop wins a same-bar touch.
    if (hitTarget) return round(rewardR);
  }
  // Unresolved: mark to the last available close.
  const lastClose = future[future.length - 1]!.close;
  const mtm = signal.side === 'buy'
    ? (lastClose - signal.entryPrice) / risk
    : (signal.entryPrice - lastClose) / risk;
  return round(mtm);
}

/** A signal paired with the future bars it is scored against. */
export interface ScoredSignal {
  signal: TradeSignal;
  r: number;
  win: boolean;
}

/**
 * Aggregate a set of scored signals into the existing `EodSignalAccuracy`
 * shape. `winRate` is the hit-rate (R > 0); `avgRR` carries the avg realized
 * R-multiple — the EOD path's "avg R:R achieved" column, reused verbatim so the
 * replay study and the live report are directly comparable.
 */
export function summarizeAccuracy(scored: ScoredSignal[]): EodSignalAccuracy {
  const totalSignals = scored.length;
  const winningSignals = scored.filter((s) => s.win).length;
  const winRate = totalSignals > 0 ? round(winningSignals / totalSignals) : 0;
  const avgRR = totalSignals > 0
    ? round(scored.reduce((sum, s) => sum + s.r, 0) / totalSignals)
    : 0;
  return { totalSignals, winningSignals, winRate, avgRR };
}

/** Score one signal against the bars strictly after its decision bar. */
export function scoreSignal(
  signal: TradeSignal,
  candles: Candle[],
  barIndex: number,
  horizonBars: number,
): ScoredSignal {
  const future = candles.slice(barIndex + 1, barIndex + 1 + horizonBars);
  const r = realizedR(signal, future);
  return { signal, r, win: r > 0 };
}

export interface AgentScoreReport {
  /** Accuracy of the agent's ROUTABLE trades (APPROVE → non-null proposedSignal). */
  agent: EodSignalAccuracy;
  /** Accuracy of the deterministic candidate signals that gated the runs. */
  baseline: EodSignalAccuracy;
  /** Agent − baseline edge (positive ⇒ the agent layer added value). */
  edgeVsBaseline: {
    winRateDelta: number;
    avgRDelta: number;
  };
  /** Bars of look-forward each trade was scored over. */
  horizonBars: number;
  /** Recommendations that produced a routable (APPROVE) trade. */
  routableCount: number;
  /** Total recommendations replayed. */
  totalRecommendations: number;
}

/**
 * Score a replay run: the agent's routable proposals vs the deterministic
 * baseline, both over the same `horizonBars` look-forward window. This is the
 * §7 "agent-vs-deterministic-baseline" comparison. In P1 the stub anchors the
 * agent's trade to the candidate, so the deltas reflect only the agent's
 * action/veto filtering (it can shrink or veto a candidate, never enrich it) —
 * exactly the additive guarantee the study is built to measure once P2's real
 * agents make the two streams genuinely diverge.
 */
export function scoreReplay(
  records: AgentReplayRecord[],
  candles: Candle[],
  horizonBars = 20,
): AgentScoreReport {
  const agentScored: ScoredSignal[] = [];
  const baselineScored: ScoredSignal[] = [];

  for (const rec of records) {
    if (rec.candidateSignal) {
      baselineScored.push(
        scoreSignal(rec.candidateSignal, candles, rec.barIndex, horizonBars),
      );
    }
    const proposed = rec.recommendation.proposedSignal;
    if (proposed) {
      agentScored.push(scoreSignal(proposed, candles, rec.barIndex, horizonBars));
    }
  }

  const agent = summarizeAccuracy(agentScored);
  const baseline = summarizeAccuracy(baselineScored);
  return {
    agent,
    baseline,
    edgeVsBaseline: {
      winRateDelta: round(agent.winRate - baseline.winRate),
      avgRDelta: round(agent.avgRR - baseline.avgRR),
    },
    horizonBars,
    routableCount: agentScored.length,
    totalRecommendations: records.length,
  };
}
