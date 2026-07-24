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
  /**
   * TRA-2215 — the CALIBRATED decision boundary: the `nullQuantile` empirical
   * percentile of bootstrapped `recentTrades`-sized window means resampled from
   * this strategy's own baseline history. `recentExpectancy < decayThresholdR`
   * is the fire condition. Null when there was not enough history to calibrate.
   * Surfaced so the boundary is auditable in health/EOD rather than implicit.
   */
  decayThresholdR: number | null;
  /** Human-readable explanation surfaced in health + EOD. */
  reason: string;
}

export interface IntrospectionOptions {
  /**
   * Recent-window size (most-recent N closed trades per strategy), compared
   * against a threshold resampled from the trades before it. Default 30.
   *
   * TRA-2215 — was 10. At n=10 the mean of a realized-R window carries a
   * standard error of 0.085R–0.221R against a population mean of ~0.03R–0.04R,
   * so a 10-trade window says nothing about decay at any threshold.
   */
  recentWindow?: number;
  /** Minimum trades in EACH window before edge-decay can fire. Default 30. */
  minWindowTrades?: number;
  /**
   * TRA-2215 — bootstrap resamples used to build the null distribution of
   * window means. Default 2000 (SE of the 5th percentile ≈ 0.5% of the draw
   * count; cost is ~`nullDraws * recentWindow` adds per strategy, sub-ms).
   */
  nullDraws?: number;
  /**
   * Left-tail probability of the null distribution below which the recent
   * window is called decay. Default 0.05 — i.e. the detector is calibrated to
   * fire on ~5% of no-decay data, which is the property the regression test
   * asserts. This is the ONLY tuning knob, and it means what it says.
   */
  nullQuantile?: number;
}

const DEFAULT_INTROSPECTION_OPTS: Required<IntrospectionOptions> = {
  recentWindow: 30,
  minWindowTrades: 30,
  nullDraws: 2000,
  nullQuantile: 0.05,
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
 * Deterministic PRNG (mulberry32). The bootstrap below must be reproducible —
 * this module's contract is that the readout is a PURE function of its rows, and
 * a `Math.random` bootstrap would make the same journal yield a different risk
 * throttle on every tick. Seeded from the data, so identical rows ⇒ identical
 * verdict, and two strategies never share a draw sequence.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the strategy key — a stable seed that varies across strategies. */
function seedFor(strategy: string, poolSize: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < strategy.length; i++) {
    h ^= strategy.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ poolSize) >>> 0;
}

/**
 * TRA-2215 — the calibrated decision boundary.
 *
 * Draws `draws` bootstrap windows of `windowSize` trades (with replacement) from
 * `pool` and returns the `q` empirical quantile of their means. Under the null
 * "nothing has changed", a recent window IS such a draw, so the recent mean falls
 * below this boundary with probability exactly `q` — which is what makes the
 * false-positive rate a designed property rather than a hope.
 *
 * A parametric t-test was measured and REJECTED for this job: realized R is
 * fat-tailed and skewed enough that the normal approximation over-fires at
 * 10.5%–20.4% against a nominal 5%, and by a DIFFERENT amount per structure.
 * Being mis-calibrated by a varying amount is worse than being wrong by a
 * constant, because it cannot be corrected downstream. Only the resample is
 * calibrated across both structures.
 */
function bootstrapWindowMeanQuantile(
  pool: number[],
  windowSize: number,
  draws: number,
  q: number,
  seed: number,
): number {
  const rand = mulberry32(seed);
  const means = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) sum += pool[(rand() * pool.length) | 0]!;
    means[d] = sum / windowSize;
  }
  means.sort(); // TypedArray#sort is numeric-ascending, no comparator needed.
  const idx = Math.min(draws - 1, Math.max(0, Math.floor(q * draws)));
  return means[idx]!;
}

/**
 * PURE — the edge-decay verdict for one strategy's chronologically-sorted rows.
 *
 * The most-recent `recentWindow` trades are the RECENT window. Everything before
 * it is the BASELINE — note that this is ALL prior history, not a same-sized
 * window (the JSDoc claimed same-sized through TRA-2215; the code never did it).
 * All of it is the right population here: baseline is used only to estimate the
 * null distribution of window means, and more history means a tighter estimate.
 *
 * Decay fires iff the recent window's mean R falls below the `nullQuantile`
 * percentile of that resampled null. The previous rule — "recent < 0, or recent
 * < half of baseline" — was a hand-picked constant that sat 0.10–0.17 of ONE
 * standard error from the baseline it compared against, and measured a 50.3% /
 * 64.3% false-positive rate on shuffled live rows. See the shuffled-null
 * regression test, which fails on that rule and is the reason this one exists.
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
  let decayThresholdR: number | null = null;
  let reason =
    `Not enough trades to judge edge decay (recent ${recent.length}, baseline ${baseline.length}; `
    + `need ${opts.minWindowTrades} in each)`;

  if (enough && baselineStats.expectancy !== null && recentStats.expectancy !== null) {
    const base = baselineStats.expectancy;
    const rec = recentStats.expectancy;
    if (base > 0) {
      decayThresholdR = bootstrapWindowMeanQuantile(
        baseline.map((r) => r.realizedR),
        recent.length,
        opts.nullDraws,
        opts.nullQuantile,
        seedFor(strategy, baseline.length),
      );
      const pct = (opts.nullQuantile * 100).toFixed(0);
      if (rec < decayThresholdR) {
        degrading = true;
        reason =
          `Edge decaying: recent expectancy ${rec.toFixed(4)}R over ${recent.length} trades is below the `
          + `${pct}th-percentile of ${opts.nullDraws} resampled ${recent.length}-trade windows drawn from its own `
          + `${baseline.length}-trade history (threshold ${decayThresholdR.toFixed(4)}R, baseline +${base.toFixed(4)}R)`;
      } else {
        reason =
          `Edge intact: recent ${rec.toFixed(4)}R over ${recent.length} trades is at or above the calibrated `
          + `${pct}th-percentile floor ${decayThresholdR.toFixed(4)}R (baseline +${base.toFixed(4)}R over ${baseline.length})`;
      }
    } else {
      reason = `Baseline expectancy non-positive (${base.toFixed(4)}R) — nothing to decay from`;
    }
  }

  return {
    strategy,
    degrading,
    baselineExpectancy: baselineStats.expectancy,
    recentExpectancy: recentStats.expectancy,
    baselineTrades: baseline.length,
    recentTrades: recent.length,
    decayThresholdR,
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
 * Adapter — map closed option-trade journal records into generic strategy rows,
 * carrying the entry trend as the regime proxy (the journal records trend, not
 * the full regime label). Open rows are dropped; only resolved (closed) trades
 * attribute.
 *
 * TRA-2215 / TRA-2193b — rows are keyed `structure::entryArchetype`, NOT by the
 * bare structure. `structure` is a STRUCTURE LABEL, not a sleeve: four different
 * sleeves share `single_leg_rv`. Keyed on the bare label, one spurious decay flag
 * throttled all four sleeves at once, while a real decay in one sleeve was
 * diluted by the three healthy ones. This is the same cohort key the TRA-1691
 * delta rollup already uses, so the two folds now name cohorts identically.
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
      strategy: `${r.structure}::${r.entryArchetype ?? 'unspecified'}`,
      closeTs: r.closeTs as number,
      realizedPnlUsd: r.realizedPnlUsd ?? 0,
      realizedR: r.realizedR ?? 0,
      regime: trendToRegime(r.trend),
    }));
}
