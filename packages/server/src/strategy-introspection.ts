// TRA-995 (epic-C, self-awareness) — the INTROSPECTION layer.
//
// "The firm knows its own state." A pure fold over closed-trade rows that
// produces, per strategy (and optionally per regime):
//   • P&L attribution      — realized $ and trade count
//   • rolling expectancy    — mean realized R per trade
//   • Sharpe                — per-trade information ratio (mean R / stdev R)
//   • win rate
// plus an EDGE-DECAY detector: it splits each strategy's closed trades into a
// BASELINE window (older) and a RECENT window (newer) and flags the strategy as
// degrading when a previously-profitable edge has materially eroded in the
// recent window. A flagged strategy is handed to the risk autopilot
// (`risk-autopilot.ts`) to be auto-throttled and queued for review via the
// epic-A hypothesis pipeline.
//
// Everything here is a PURE function of its input rows — no clock, no I/O — so
// the readout is deterministic and unit-testable. The adapter at the bottom maps
// the option-trade journal into the generic row shape; the same readout can fold
// the reversal shadow ledger or any future per-strategy ledger.

import type { OptionTradeJournalRecord } from './option-trade-journal.js';

/** Coarse regime label a trade was opened into (mirrors engine `Regime`). */
export type IntrospectionRegime =
  | 'trend_up'
  | 'trend_down'
  | 'range'
  | 'high_vol'
  | 'flat'
  | 'unknown';

/**
 * One closed trade, reduced to what attribution needs. Strategy-agnostic so the
 * same fold serves options, reversals, and anything future.
 */
export interface StrategyTradeRow {
  /** Attribution key — the strategy / structure that produced the trade. */
  strategy: string;
  /** ms-epoch the trade closed (used to order baseline vs recent windows). */
  closeTs: number;
  /** Signed realized P&L, USD. */
  realizedPnlUsd: number;
  /** Realized R-multiple (pnl / risk) — the comparable expectancy unit. */
  realizedR: number;
  /** Regime the trade was opened into, if known. */
  regime?: IntrospectionRegime;
}

/** Expectancy / Sharpe / win-rate over a set of closed trades. Pure stats. */
export interface PerformanceStats {
  trades: number;
  realizedPnlUsd: number;
  winRate: number | null;
  /** Mean realized R per trade (expectancy); null when no trades. */
  expectancy: number | null;
  /** Per-trade Sharpe = mean R / stdev R; null when <2 trades or zero variance. */
  sharpe: number | null;
}

/** Per-regime expectancy slice for one strategy. */
export interface RegimeStats extends PerformanceStats {
  regime: IntrospectionRegime;
}

/** Full attribution for one strategy. */
export interface StrategyAttribution extends PerformanceStats {
  strategy: string;
  /** Per-regime breakdown, descending by trade count. */
  byRegime: RegimeStats[];
}

/** The edge-decay verdict for one strategy. */
export interface EdgeDecayFlag {
  strategy: string;
  /** True ⇒ a previously-profitable edge is materially degrading. */
  degrading: boolean;
  /** Expectancy over the older (baseline) window; null if too few trades. */
  baselineExpectancy: number | null;
  /** Expectancy over the newer (recent) window; null if too few trades. */
  recentExpectancy: number | null;
  /** baselineTrades / recentTrades used for the comparison. */
  baselineTrades: number;
  recentTrades: number;
  /** Human-readable explanation surfaced in health + EOD. */
  reason: string;
}

export interface IntrospectionOptions {
  /**
   * Recent-window size (most-recent N closed trades per strategy) compared
   * against the trades before it as the baseline. Default 10.
   */
  recentWindow?: number;
  /** Minimum trades in EACH window before edge-decay can fire. Default 5. */
  minWindowTrades?: number;
  /**
   * Fraction of baseline expectancy the recent window must fall below to flag
   * decay (only when baseline was positive). Default 0.5 (recent < half of
   * baseline). Also flags when a positive baseline turns recent-negative.
   */
  decayDropFraction?: number;
}

const DEFAULT_INTROSPECTION_OPTS: Required<IntrospectionOptions> = {
  recentWindow: 10,
  minWindowTrades: 5,
  decayDropFraction: 0.5,
};

/** The whole self-awareness readout. */
export interface IntrospectionReadout {
  /** Per-strategy attribution, descending by trade count. */
  strategies: StrategyAttribution[];
  /** Edge-decay verdicts (one per strategy with enough trades to judge). */
  edgeDecay: EdgeDecayFlag[];
  /** Convenience: just the names flagged degrading (feeds the autopilot). */
  degradingStrategies: string[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population stdev — denominator n (we have the full sample, not an estimate). */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(variance);
}

/** PURE — expectancy / Sharpe / win-rate over a set of rows. */
export function computePerformanceStats(rows: StrategyTradeRow[]): PerformanceStats {
  const trades = rows.length;
  if (trades === 0) {
    return { trades: 0, realizedPnlUsd: 0, winRate: null, expectancy: null, sharpe: null };
  }
  const rs = rows.map((r) => r.realizedR);
  const realizedPnlUsd = rows.reduce((acc, r) => acc + r.realizedPnlUsd, 0);
  const wins = rows.filter((r) => r.realizedPnlUsd > 0).length;
  const sd = stdev(rs);
  return {
    trades,
    realizedPnlUsd,
    winRate: wins / trades,
    expectancy: mean(rs),
    sharpe: trades >= 2 && sd > 0 ? mean(rs) / sd : null,
  };
}

/**
 * PURE — the edge-decay verdict for one strategy's chronologically-sorted rows.
 * Splits off the most-recent `recentWindow` trades as the recent window and the
 * trades immediately before it (same size, capped by availability) as baseline.
 */
export function detectEdgeDecay(
  strategy: string,
  sortedRows: StrategyTradeRow[],
  opts: Required<IntrospectionOptions>,
): EdgeDecayFlag {
  const n = sortedRows.length;
  const recent = sortedRows.slice(Math.max(0, n - opts.recentWindow));
  const baseline = sortedRows.slice(0, Math.max(0, n - opts.recentWindow));

  const recentStats = computePerformanceStats(recent);
  const baselineStats = computePerformanceStats(baseline);

  const enough =
    recent.length >= opts.minWindowTrades && baseline.length >= opts.minWindowTrades;

  let degrading = false;
  let reason = 'Not enough trades in both windows to judge edge decay';

  if (enough && baselineStats.expectancy !== null && recentStats.expectancy !== null) {
    const base = baselineStats.expectancy;
    const rec = recentStats.expectancy;
    if (base > 0) {
      // A positive edge that has either gone negative or fallen below the
      // configured fraction of its former self is decaying.
      if (rec < 0) {
        degrading = true;
        reason = `Edge turned negative: baseline expectancy +${base.toFixed(2)}R → recent ${rec.toFixed(2)}R`;
      } else if (rec < base * opts.decayDropFraction) {
        degrading = true;
        reason = `Edge eroding: recent expectancy ${rec.toFixed(2)}R is below ${(opts.decayDropFraction * 100).toFixed(0)}% of baseline +${base.toFixed(2)}R`;
      } else {
        reason = `Edge intact: recent ${rec.toFixed(2)}R vs baseline +${base.toFixed(2)}R`;
      }
    } else {
      reason = `Baseline expectancy non-positive (${base.toFixed(2)}R) — nothing to decay from`;
    }
  }

  return {
    strategy,
    degrading,
    baselineExpectancy: baselineStats.expectancy,
    recentExpectancy: recentStats.expectancy,
    baselineTrades: baseline.length,
    recentTrades: recent.length,
    reason,
  };
}

/** PURE — the full self-awareness readout over all closed-trade rows. */
export function computeStrategyIntrospection(
  rows: StrategyTradeRow[],
  options: IntrospectionOptions = {},
): IntrospectionReadout {
  const opts = { ...DEFAULT_INTROSPECTION_OPTS, ...options };

  const byStrategy = new Map<string, StrategyTradeRow[]>();
  for (const r of rows) {
    const list = byStrategy.get(r.strategy) ?? [];
    list.push(r);
    byStrategy.set(r.strategy, list);
  }

  const strategies: StrategyAttribution[] = [];
  const edgeDecay: EdgeDecayFlag[] = [];

  for (const [strategy, list] of byStrategy.entries()) {
    const sorted = [...list].sort((a, b) => a.closeTs - b.closeTs);
    const overall = computePerformanceStats(sorted);

    const byRegimeMap = new Map<IntrospectionRegime, StrategyTradeRow[]>();
    for (const r of sorted) {
      const reg = r.regime ?? 'unknown';
      const l = byRegimeMap.get(reg) ?? [];
      l.push(r);
      byRegimeMap.set(reg, l);
    }
    const byRegime: RegimeStats[] = [...byRegimeMap.entries()]
      .map(([regime, l]) => ({ regime, ...computePerformanceStats(l) }))
      .sort((a, b) => b.trades - a.trades);

    strategies.push({ strategy, ...overall, byRegime });
    edgeDecay.push(detectEdgeDecay(strategy, sorted, opts));
  }

  strategies.sort((a, b) => b.trades - a.trades);

  return {
    strategies,
    edgeDecay,
    degradingStrategies: edgeDecay.filter((e) => e.degrading).map((e) => e.strategy),
  };
}

/**
 * Adapter — map closed option-trade journal records into generic strategy rows
 * keyed by structure (the option "strategy"), carrying the entry trend as the
 * regime proxy (the journal records trend, not the full regime label). Open rows
 * are dropped; only resolved (closed) trades attribute.
 */
export function optionJournalToStrategyRows(
  records: OptionTradeJournalRecord[],
): StrategyTradeRow[] {
  const trendToRegime = (t: OptionTradeJournalRecord['trend']): IntrospectionRegime => {
    switch (t) {
      case 'up':
        return 'trend_up';
      case 'down':
        return 'trend_down';
      case 'sideways':
        return 'range';
      default:
        return 'unknown';
    }
  };
  return records
    .filter((r) => r.outcome !== 'OPEN' && r.closeTs != null)
    .map((r) => ({
      strategy: r.structure,
      closeTs: r.closeTs as number,
      realizedPnlUsd: r.realizedPnlUsd ?? 0,
      realizedR: r.realizedR ?? 0,
      regime: trendToRegime(r.trend),
    }));
}
