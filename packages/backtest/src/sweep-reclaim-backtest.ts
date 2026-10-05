/**
 * Sweep-and-reclaim swing study — PURE harness (no I/O, no capital path).
 *
 * Question: does the price-action "liquidity sweep and reclaim" trigger
 * (`detectSweepReclaimSeries` in @trading-app/engine) produce a positive,
 * cost-net expectancy on DAILY equity bars that the same bracket geometry
 * placed on RANDOM days does not?
 *
 * The placebo is the point. A long-biased bracket on a 2024–2026 large-cap
 * universe makes money on drift alone; "the backtest is green" says nothing
 * about the trigger unless it beats the identical stop/target/hold placed on
 * days the trigger did NOT pick.
 *
 * Execution model (conservative on every ambiguity):
 *  - Signal on bar t's CLOSE; fill at bar t+1's OPEN. Never at the signal close.
 *  - Opening gap through the stop on the entry bar ⇒ trade skipped
 *    (`gap_through_stop`); gap through the target ⇒ skipped (`gap_through_target`).
 *  - Later bars: an open beyond the stop exits AT THE OPEN (gap risk is real);
 *    stop and target touched in the same bar ⇒ STOP is assumed.
 *  - Time stop after `maxHoldBars` (exit at that bar's close); end of data ⇒
 *    exit at the last close, flagged `end_of_data`.
 *  - One open position per symbol; signals while a position is open are skipped.
 *  - Costs: `costBpsPerSide` on entry AND exit notional, charged in R.
 */

import type { Candle } from '@trading-app/shared';
import { atr, detectSweepReclaimSeries } from '@trading-app/engine';
import type { SweepReclaimOptions, SweepReclaimSignal } from '@trading-app/engine';

export interface BracketConfig {
  maxHoldBars: number;
  costBpsPerSide: number;
}

export const BRACKET_DEFAULTS: BracketConfig = Object.freeze({ maxHoldBars: 20, costBpsPerSide: 5 });

export type ExitReason = 'stop' | 'stop_gap' | 'target' | 'target_gap' | 'time' | 'end_of_data';

export interface Trade {
  symbol: string;
  side: 'long' | 'short';
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  entryTs: number;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  exitReason: ExitReason;
  grossR: number;
  netR: number;
  barsHeld: number;
}

export interface SkipCounts {
  position_open: number;
  gap_through_stop: number;
  gap_through_target: number;
  no_next_bar: number;
}

/** A bracket request: what the simulator needs, from a signal or a placebo. */
export interface BracketIntent {
  index: number;
  side: 'long' | 'short';
  stop: number;
  target: number;
}

/** Simulate one bracket from `intent` on `candles`. Null ⇒ skipped (reason returned). */
export function simulateBracket(
  symbol: string,
  candles: Candle[],
  intent: BracketIntent,
  cfg: BracketConfig = BRACKET_DEFAULTS,
): { trade: Trade | null; skip: keyof SkipCounts | null } {
  const ei = intent.index + 1;
  if (ei >= candles.length) return { trade: null, skip: 'no_next_bar' };
  const dir = intent.side === 'long' ? 1 : -1;
  const entry = candles[ei].open;
  const { stop, target } = intent;
  if ((entry - stop) * dir <= 0) return { trade: null, skip: 'gap_through_stop' };
  if ((target - entry) * dir <= 0) return { trade: null, skip: 'gap_through_target' };
  const risk = (entry - stop) * dir;

  let exit = candles[candles.length - 1].close;
  let exitIndex = candles.length - 1;
  let reason: ExitReason = 'end_of_data';
  for (let j = ei; j < candles.length; j++) {
    const b = candles[j];
    const adverse = dir === 1 ? b.low : b.high;
    const favour = dir === 1 ? b.high : b.low;
    if (j > ei && (b.open - stop) * dir <= 0) { exit = b.open; exitIndex = j; reason = 'stop_gap'; break; }
    if ((adverse - stop) * dir <= 0) { exit = stop; exitIndex = j; reason = 'stop'; break; }
    if (j > ei && (b.open - target) * dir >= 0) { exit = b.open; exitIndex = j; reason = 'target_gap'; break; }
    if ((favour - target) * dir >= 0) { exit = target; exitIndex = j; reason = 'target'; break; }
    if (j - ei + 1 >= cfg.maxHoldBars) { exit = b.close; exitIndex = j; reason = 'time'; break; }
  }
  const grossR = ((exit - entry) * dir) / risk;
  const costR = ((cfg.costBpsPerSide / 1e4) * (entry + exit)) / risk;
  return {
    trade: {
      symbol,
      side: intent.side,
      signalIndex: intent.index,
      entryIndex: ei,
      exitIndex,
      entryTs: candles[ei].timestamp,
      entry,
      stop,
      target,
      exit,
      exitReason: reason,
      grossR,
      netR: grossR - costR,
      barsHeld: exitIndex - ei + 1,
    },
    skip: null,
  };
}

/** Walk intents in order with one-position-per-symbol. */
export function simulateIntents(
  symbol: string,
  candles: Candle[],
  intents: BracketIntent[],
  cfg: BracketConfig = BRACKET_DEFAULTS,
): { trades: Trade[]; skips: SkipCounts } {
  const skips: SkipCounts = { position_open: 0, gap_through_stop: 0, gap_through_target: 0, no_next_bar: 0 };
  const trades: Trade[] = [];
  let busyUntil = -1;
  for (const it of [...intents].sort((a, b) => a.index - b.index)) {
    if (it.index < busyUntil) { skips.position_open += 1; continue; }
    const r = simulateBracket(symbol, candles, it, cfg);
    if (r.skip) { skips[r.skip] += 1; continue; }
    trades.push(r.trade!);
    busyUntil = r.trade!.exitIndex; // a new signal on the exit bar's close may enter next open
  }
  return { trades, skips };
}

export function intentFromSignal(s: SweepReclaimSignal): BracketIntent {
  return { index: s.index, side: s.side, stop: s.stop, target: s.target };
}

// ── statistics ───────────────────────────────────────────────────────────────

export interface RStats {
  n: number;
  meanR: number | null;
  medianR: number | null;
  sdR: number | null;
  winRate: number | null;
  profitFactor: number | null;
  totalR: number;
}

export function rStats(rs: readonly number[]): RStats {
  const n = rs.length;
  if (n === 0) return { n, meanR: null, medianR: null, sdR: null, winRate: null, profitFactor: null, totalR: 0 };
  const total = rs.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : null;
  const sorted = [...rs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = rs.filter((r) => r > 0);
  const gains = wins.reduce((a, b) => a + b, 0);
  const losses = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  return {
    n,
    meanR: mean,
    medianR: median,
    sdR: sd,
    winRate: wins.length / n,
    profitFactor: losses > 0 ? gains / losses : null,
    totalR: total,
  };
}

/** Deterministic PRNG (mulberry32) so every run is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * DATE-CLUSTERED bootstrap CI of mean net R. Trades entered on the same day
 * across 26 correlated large-caps are not independent draws — one market-wide
 * gap moves all of them — so resampling individual trades overstates
 * precision. Resample whole entry DAYS instead.
 */
export function clusteredBootstrapMeanCI(
  trades: readonly Pick<Trade, 'entryTs' | 'netR'>[],
  opts: { iterations?: number; alpha?: number; seed?: number } = {},
): { lower: number | null; upper: number | null; clusters: number } {
  const byDay = new Map<number, number[]>();
  for (const t of trades) {
    const d = Math.floor(t.entryTs / 86_400_000);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t.netR);
  }
  const groups = [...byDay.values()];
  if (groups.length < 2) return { lower: null, upper: null, clusters: groups.length };
  const iters = opts.iterations ?? 5000;
  const alpha = opts.alpha ?? 0.05;
  const rand = rng(opts.seed ?? 1);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    let n = 0;
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[Math.floor(rand() * groups.length)];
      for (const r of grp) { s += r; n += 1; }
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return { lower: q(alpha / 2), upper: q(1 - alpha / 2), clusters: groups.length };
}

// ── placebo ──────────────────────────────────────────────────────────────────

/**
 * For each REAL trade, place the same bracket on a random bar of the same
 * symbol: same side, same stop distance in ATR units (measured at the random
 * bar), same planned reward multiple. Returns the mean net R of each of
 * `draws` placebo books. The real book's mean is compared against this
 * distribution.
 */
export function placeboMeanRs(
  universe: ReadonlyMap<string, Candle[]>,
  realBySymbol: ReadonlyMap<string, { signals: SweepReclaimSignal[]; trades: Trade[] }>,
  opts: { draws?: number; seed?: number; warmup?: number; atrPeriod?: number; cfg?: BracketConfig } = {},
): number[] {
  const draws = opts.draws ?? 500;
  const warmup = opts.warmup ?? 200;
  const atrPeriod = opts.atrPeriod ?? 14;
  const cfg = opts.cfg ?? BRACKET_DEFAULTS;
  const rand = rng(opts.seed ?? 42);
  const atrCache = new Map<string, (number | null)[]>();
  const atrAt = (sym: string, cs: Candle[], i: number): number | null => {
    let arr = atrCache.get(sym);
    if (!arr) { arr = new Array(cs.length).fill(undefined); atrCache.set(sym, arr); }
    if (arr[i] === undefined) arr[i] = atr(cs.slice(Math.max(0, i - atrPeriod - 1), i + 1), atrPeriod);
    return arr[i] as number | null;
  };

  const out: number[] = [];
  for (let d = 0; d < draws; d++) {
    const rs: number[] = [];
    for (const [sym, { signals, trades }] of realBySymbol) {
      const cs = universe.get(sym)!;
      const sigByIndex = new Map(signals.map((s) => [s.index, s]));
      const intents: BracketIntent[] = [];
      for (const tr of trades) {
        const s = sigByIndex.get(tr.signalIndex)!;
        const stopAtr = Math.abs(s.entryRef - s.stop) / s.atr;
        const rewardMult = s.riskReward;
        const lo = Math.max(warmup, atrPeriod + 1);
        const hi = cs.length - 2;
        if (hi <= lo) continue;
        const r = lo + Math.floor(rand() * (hi - lo + 1));
        const a = atrAt(sym, cs, r);
        if (a === null || !(a > 0)) continue;
        const dir = s.side === 'long' ? 1 : -1;
        const ref = cs[r].close;
        const stop = ref - dir * stopAtr * a;
        const target = ref + dir * rewardMult * stopAtr * a;
        intents.push({ index: r, side: s.side, stop, target });
      }
      for (const t of simulateIntents(sym, cs, intents, cfg).trades) rs.push(t.netR);
    }
    if (rs.length > 0) out.push(rs.reduce((a, b) => a + b, 0) / rs.length);
  }
  return out;
}

// ── forward-return secondary statistic (TRA-4386 convention) ────────────────

/**
 * Signed `horizon`-session log return from the next OPEN, over NON-OVERLAPPING
 * events per symbol, with a one-sample t vs 0. Comparable to the TRA-4386
 * Phase 1 feeder table.
 */
export function forwardReturnT(
  universe: ReadonlyMap<string, Candle[]>,
  signalsBySymbol: ReadonlyMap<string, SweepReclaimSignal[]>,
  horizon = 5,
): { n: number; meanBp: number | null; t: number | null } {
  const xs: number[] = [];
  for (const [sym, sigs] of signalsBySymbol) {
    const cs = universe.get(sym)!;
    let nextFree = -1;
    for (const s of sigs) {
      if (s.index < nextFree) continue;
      const e = s.index + 1;
      const x = s.index + horizon;
      if (x >= cs.length) continue;
      const dir = s.side === 'long' ? 1 : -1;
      xs.push(dir * Math.log(cs[x].close / cs[e].open));
      nextFree = x + 1;
    }
  }
  const n = xs.length;
  if (n < 2) return { n, meanBp: null, t: null };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
  return { n, meanBp: m * 1e4, t: sd > 0 ? m / (sd / Math.sqrt(n)) : null };
}

// ── the study ───────────────────────────────────────────────────────────────

export interface VariantReport {
  name: string;
  options: SweepReclaimOptions;
  signals: number;
  bySide: { long: RStats; short: RStats };
  all: RStats;
  grossMeanR: number | null;
  ci: { lower: number | null; upper: number | null; clusters: number };
  halves: { first: RStats; second: RStats; splitTs: number | null };
  placebo: { draws: number; mean: number | null; p95: number | null; percentileOfReal: number | null };
  forward5: { n: number; meanBp: number | null; t: number | null };
  skips: SkipCounts;
  exitReasons: Record<string, number>;
  verdict: 'PASS' | 'FAIL' | 'UNDERPOWERED';
  failedCriteria: string[];
}

export interface PreRegistration {
  minTrades: number;
  /** Two-sided alpha for the CI after Bonferroni across variants. */
  ciAlpha: number;
  placeboPercentile: number;
}

export function runVariant(
  name: string,
  universe: ReadonlyMap<string, Candle[]>,
  options: SweepReclaimOptions,
  prereg: PreRegistration,
  cfg: BracketConfig = BRACKET_DEFAULTS,
  placebo: { draws: number; seed: number } = { draws: 500, seed: 42 },
): VariantReport {
  const real = new Map<string, { signals: SweepReclaimSignal[]; trades: Trade[] }>();
  const signalsBySymbol = new Map<string, SweepReclaimSignal[]>();
  const skips: SkipCounts = { position_open: 0, gap_through_stop: 0, gap_through_target: 0, no_next_bar: 0 };
  const trades: Trade[] = [];
  let signals = 0;
  for (const [sym, cs] of universe) {
    const sigs = detectSweepReclaimSeries(cs, options);
    signals += sigs.length;
    signalsBySymbol.set(sym, sigs);
    const r = simulateIntents(sym, cs, sigs.map(intentFromSignal), cfg);
    for (const k of Object.keys(skips) as (keyof SkipCounts)[]) skips[k] += r.skips[k];
    trades.push(...r.trades);
    real.set(sym, { signals: sigs, trades: r.trades });
  }

  const all = rStats(trades.map((t) => t.netR));
  const ci = clusteredBootstrapMeanCI(trades, { alpha: prereg.ciAlpha, seed: 7 });
  const sortedTs = trades.map((t) => t.entryTs).sort((a, b) => a - b);
  const splitTs = sortedTs.length ? sortedTs[Math.floor(sortedTs.length / 2)] : null;
  const halves = {
    first: rStats(trades.filter((t) => splitTs !== null && t.entryTs < splitTs).map((t) => t.netR)),
    second: rStats(trades.filter((t) => splitTs !== null && t.entryTs >= splitTs).map((t) => t.netR)),
    splitTs,
  };
  // Placebo bars come from the same eligible range the detector can fire in.
  const warmup = options.trendFilter === 'sma200' ? 200 : 2 * (options.pivotLookback ?? 5) + 16;
  const pl = placeboMeanRs(universe, real, { draws: placebo.draws, seed: placebo.seed, cfg, warmup });
  const plSorted = [...pl].sort((a, b) => a - b);
  const percentileOfReal =
    all.meanR === null || pl.length === 0 ? null : pl.filter((m) => m < (all.meanR as number)).length / pl.length;
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;

  const failed: string[] = [];
  if (all.n < prereg.minTrades) failed.push(`n ${all.n} < ${prereg.minTrades}`);
  if (!(ci.lower !== null && ci.lower > 0)) failed.push(`CI lower ${ci.lower?.toFixed(3)} <= 0`);
  if (!(percentileOfReal !== null && percentileOfReal >= prereg.placeboPercentile)) {
    failed.push(`placebo percentile ${percentileOfReal?.toFixed(3)} < ${prereg.placeboPercentile}`);
  }
  if (!((halves.first.meanR ?? -1) > 0 && (halves.second.meanR ?? -1) > 0)) failed.push('not positive in both halves');
  const verdict = all.n < prereg.minTrades ? 'UNDERPOWERED' : failed.length === 0 ? 'PASS' : 'FAIL';

  return {
    name,
    options,
    signals,
    bySide: {
      long: rStats(trades.filter((t) => t.side === 'long').map((t) => t.netR)),
      short: rStats(trades.filter((t) => t.side === 'short').map((t) => t.netR)),
    },
    all,
    grossMeanR: trades.length ? trades.reduce((a, t) => a + t.grossR, 0) / trades.length : null,
    ci,
    halves,
    placebo: {
      draws: pl.length,
      mean: pl.length ? pl.reduce((a, b) => a + b, 0) / pl.length : null,
      p95: plSorted.length ? plSorted[Math.floor(0.95 * (plSorted.length - 1))] : null,
      percentileOfReal,
    },
    forward5: forwardReturnT(universe, signalsBySymbol, 5),
    skips,
    exitReasons,
    verdict,
    failedCriteria: failed,
  };
}
