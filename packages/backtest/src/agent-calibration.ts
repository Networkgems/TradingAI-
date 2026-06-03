// TRA-546 (TRA-529 P3 §8) — conviction calibration + net-of-cost edge.
//
// (1) Reliability curve: bin the recommendations by stated `conviction` and
//     compare predicted probability (mean conviction in the bin) to the
//     observed hit-rate. A well-calibrated agent's points sit on the diagonal;
//     the expected-calibration-error (ECE) and Brier score quantify the gap.
//     This is what tells the §7 study whether a "0.8 conviction" call actually
//     wins 80% of the time — the single most important check before any
//     conviction-weighted sizing is allowed live.
//
// (2) Net-of-cost edge: gross avg-R turned into a $ edge per trade at a fixed
//     risk budget, minus the recommendation's own LLM cost. In P1 costUsd = 0
//     so net == gross, but the plumbing is wired so P2's real per-call spend is
//     subtracted automatically — the §6 "edge must survive its own cost" gate.
import type { Candle } from '@trading-app/shared';
import type { AgentReplayRecord } from './agent-replay.js';
import { realizedR } from './agent-scoring.js';

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

export interface CalibrationBin {
  /** Bin's conviction lower/upper edge (lo inclusive, hi exclusive; last hi=1 inclusive). */
  lo: number;
  hi: number;
  /** Trades that fell in this bin. */
  count: number;
  /** Mean stated conviction of the bin (the "predicted" probability). */
  meanConviction: number;
  /** Observed fraction of the bin's trades that won (R > 0). */
  hitRate: number;
}

export interface ReliabilityCurve {
  bins: CalibrationBin[];
  /**
   * Expected calibration error: Σ (binWeight · |meanConviction − hitRate|),
   * weighted by each bin's share of trades. 0 = perfectly calibrated.
   */
  expectedCalibrationError: number;
  /** Mean squared (conviction − outcome) across trades. Lower is better. */
  brierScore: number;
  /** Trades that carried a routable proposal and were scorable. */
  sampleSize: number;
}

/**
 * Build the reliability curve over routable recommendations. Each routable
 * recommendation contributes its `conviction` (predicted win probability) and a
 * realized win/loss (R > 0 over `horizonBars`). HOLD/VETO recommendations carry
 * no proposed trade and are excluded — there is nothing to be right or wrong
 * about. `bins` defaults to 10 even-width buckets across [0,1].
 */
export function reliabilityCurve(
  records: AgentReplayRecord[],
  candles: Candle[],
  horizonBars = 20,
  bins = 10,
): ReliabilityCurve {
  const binCount = Math.max(1, bins);
  const acc = Array.from({ length: binCount }, () => ({
    convictionSum: 0,
    wins: 0,
    count: 0,
  }));

  const points: Array<{ conviction: number; win: 0 | 1 }> = [];
  for (const rec of records) {
    const proposed = rec.recommendation.proposedSignal;
    if (!proposed) continue; // not a directional call — nothing to calibrate.
    const future = candles.slice(rec.barIndex + 1, rec.barIndex + 1 + horizonBars);
    const r = realizedR(proposed, future);
    const win: 0 | 1 = r > 0 ? 1 : 0;
    const conviction = Math.min(1, Math.max(0, rec.recommendation.conviction));
    points.push({ conviction, win });

    // Right-closed only for the top bin so conviction === 1 lands in bin K-1.
    let idx = Math.floor(conviction * binCount);
    if (idx >= binCount) idx = binCount - 1;
    acc[idx]!.convictionSum += conviction;
    acc[idx]!.wins += win;
    acc[idx]!.count += 1;
  }

  const sampleSize = points.length;
  const binsOut: CalibrationBin[] = acc.map((b, i) => {
    const lo = round(i / binCount);
    const hi = round((i + 1) / binCount);
    const meanConviction = b.count > 0 ? round(b.convictionSum / b.count) : 0;
    const hitRate = b.count > 0 ? round(b.wins / b.count) : 0;
    return { lo, hi, count: b.count, meanConviction, hitRate };
  });

  const ece = sampleSize > 0
    ? round(
        binsOut.reduce(
          (sum, b) => sum + (b.count / sampleSize) * Math.abs(b.meanConviction - b.hitRate),
          0,
        ),
      )
    : 0;
  const brier = sampleSize > 0
    ? round(
        points.reduce((sum, p) => sum + (p.conviction - p.win) ** 2, 0) / sampleSize,
      )
    : 0;

  return {
    bins: binsOut,
    expectedCalibrationError: ece,
    brierScore: brier,
    sampleSize,
  };
}

export interface NetEdgeReport {
  /** Routable trades the edge is measured over. */
  trades: number;
  /** Mean realized R across the routable trades (the gross edge in R units). */
  grossEdgeR: number;
  /** $ risked per trade — the conversion factor from R to dollars. */
  riskBudgetUsd: number;
  /** grossEdgeR × riskBudgetUsd × trades. */
  grossEdgeUsd: number;
  /** Σ costUsd across ALL replayed recommendations (HOLD/VETO calls cost too). */
  totalCostUsd: number;
  /** Mean cost per recommendation. */
  avgCostUsd: number;
  /** grossEdgeUsd − totalCostUsd — the edge that survives its own LLM spend. */
  netEdgeUsd: number;
  /** netEdgeUsd / trades. */
  netEdgePerTradeUsd: number;
}

/**
 * Net-of-cost edge: gross R turned into dollars at a fixed `riskBudgetUsd` per
 * trade, minus the LLM spend the recommendations billed. Cost is summed across
 * ALL recommendations (a HOLD/VETO still burns tokens in P2), while the gross
 * edge counts only the routable trades that actually took risk — so a chatty
 * agent that mostly stands aside is correctly penalised. In P1 costUsd = 0, so
 * netEdgeUsd === grossEdgeUsd; the subtraction is live for P2.
 */
export function netOfCostEdge(
  records: AgentReplayRecord[],
  candles: Candle[],
  horizonBars = 20,
  riskBudgetUsd = 100,
): NetEdgeReport {
  let rSum = 0;
  let trades = 0;
  let totalCostUsd = 0;
  for (const rec of records) {
    totalCostUsd += rec.recommendation.costUsd;
    const proposed = rec.recommendation.proposedSignal;
    if (!proposed) continue;
    const future = candles.slice(rec.barIndex + 1, rec.barIndex + 1 + horizonBars);
    rSum += realizedR(proposed, future);
    trades += 1;
  }
  const grossEdgeR = trades > 0 ? round(rSum / trades) : 0;
  const grossEdgeUsd = round(grossEdgeR * riskBudgetUsd * trades, 2);
  totalCostUsd = round(totalCostUsd, 6);
  const netEdgeUsd = round(grossEdgeUsd - totalCostUsd, 2);
  return {
    trades,
    grossEdgeR,
    riskBudgetUsd,
    grossEdgeUsd,
    totalCostUsd,
    avgCostUsd: records.length > 0 ? round(totalCostUsd / records.length, 6) : 0,
    netEdgeUsd,
    netEdgePerTradeUsd: trades > 0 ? round(netEdgeUsd / trades, 2) : 0,
  };
}
