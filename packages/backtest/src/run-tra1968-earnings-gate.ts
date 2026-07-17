/**
 * TRA-1973 (D2 of TRA-1968) — Walk-forward OOS validation harness for the
 * earnings gate.
 *
 * The evidence gate for the TRA-1968 catalyst gate: a catalyst gate cannot be
 * promoted to a *default* until its out-of-sample effect is measured and graded
 * (parent DoD + `packages/shared/src/promotion-gate.ts` Stage-1). TRA-1972 (D1,
 * commit 7651388) shipped the live earnings-proximity gate SHADOW-first
 * (`packages/server/src/catalyst-gate.ts`) — it computes/logs/surfaces the gate
 * decision but never suppresses the open. This harness answers: *if it did
 * suppress, what would it do to OOS performance?*
 *
 * ── What it measures ─────────────────────────────────────────────────────────
 * Two books, each baseline vs gated side by side, run through the TRA-172
 * `walkForward(...)` harness on daily bars:
 *   • `swing` — the daily-swing proxy for the live `sma200_pullback` router
 *     (earnings gate default ≤ 10d).
 *   • `intraday_trend` — the `ichimoku` trend book, proxy for the intraday
 *     trend entries the gate ALSO touches (ORB / Ichimoku, default ≤ 1d). This
 *     is QuantTrader's "trend-entry check" (criterion 5): confirm the gate is
 *     not throwing away good trend entries near earnings.
 *
 * Emitted per book so QuantTrader can grade the D2/Stage-3 bar in one pass
 * (criteria pre-registered on TRA-1972):
 *   1. Do-no-harm: Sharpe, Sortino, expectancy, profit factor, max drawdown (R)
 *      AND the left tail — p10 R, worst-trade R, worst-decile mean R — baseline
 *      vs gated + delta.
 *   2. Suppressed-cohort justification: the removed entries summarized as their
 *      OWN arm (avg R, p10 R, worst-decile, stop-hit rate) so they can be read
 *      against the general population. The gate only earns its keep if the
 *      suppressed cohort is materially fatter-left-tailed than baseline.
 *   3. Sample sufficiency: removed-entry N per book vs a ~30 floor, with an
 *      explicit `sufficient` flag (silent small-N is a grade fail).
 *   4. Threshold sensitivity: a sweep (swing 5/7/10/14d, intraday 1/2d) so the
 *      default sits on a plateau, not a lucky point.
 *   5. Trend-entry check: the `intraday_trend` book's suppressed cohort gets the
 *      same tail treatment — if it is NOT tail-heavy the gate should exempt
 *      trend-intraday rather than blanket-gate.
 *
 * ── Modeling the gate ────────────────────────────────────────────────────────
 * The D1 earnings rule is a pure predicate: suppress a NEW entry when the
 * symbol's next earnings is within the book's threshold days. Since it only ever
 * *removes* entries and never alters an unrelated trade, the gated arm is exactly
 * the baseline trade ledger with the gated-out entries dropped — so we run each
 * book once, precompute each entry's days-to-earnings point-in-time at its
 * `openedAt`, and re-split the ledger at any threshold from that one number. This
 * mirrors `evaluateCatalystGate`'s earnings branch (inlined here — the backtest
 * package deliberately does not depend on `@trading-app/server`; same pattern as
 * run-tra797-agents-ab.ts).
 *
 * ── Point-in-time earnings (no lookahead) ────────────────────────────────────
 * Past earnings dates are static facts. We fetch the *historical* calendar for
 * the OOS span via `EarningsCalendarClient.fetchWindow` with a backdated
 * from/to, index it per symbol, and at each decision bar read only the nearest
 * NOT-YET-PAST earnings date as of that bar (`earningsInDaysAsOf`). Nothing the
 * evaluator sees at bar T depends on price/data after T.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPEND / NETWORK SAFETY — this script does NOTHING by default.
 *   • `… run-tra1968-earnings-gate.ts`            → PLAN mode: prints the config
 *     + earnings-token reachability, runs NOTHING. Safe.
 *   • `… run-tra1968-earnings-gate.ts --smoke`    → free DETERMINISTIC smoke: the
 *     full pipeline (synthetic daily bars + synthetic quarterly earnings +
 *     walkForward + gate split + OOS table) on seeded fakes. No network. Proves
 *     the wiring end-to-end. Reports are tagged `mode: "smoke-deterministic"`.
 *   • `… run-tra1968-earnings-gate.ts --execute`  → the REAL run: Yahoo daily
 *     bars (no key) + Finnhub historical earnings (needs `FINNHUB_API_TOKEN`).
 *     Free market data; blocked on the earnings token when it is absent.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1968-earnings-gate.ts [--smoke|--execute]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import { EarningsCalendarClient, daysUntil, type EarningsEvent } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import { walkForward } from './walk-forward.js';
import { summarizeTrades, type TradeMetrics } from './tra731-metrics.js';
import type { BacktestConfig } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DAY_MS = 24 * 60 * 60 * 1000;

// ── OOS config ───────────────────────────────────────────────────────────────
// Liquid single names with regular quarterly earnings — the universe the D1 gate
// targets in production (equity swing router). Kept small so the free Yahoo/
// Finnhub round-trips stay light.
const UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX'];

// Held-out OOS span. ~3y of daily bars gives walk-forward several rolling
// test windows past the 200-day EMA warmup the swing router needs.
const WINDOW_START_MS = Date.UTC(2023, 0, 1); // 2023-01-01
const WINDOW_END_MS = Date.UTC(2026, 0, 1); // 2026-01-01

// Walk-forward geometry, in *daily* bars (calendar-agnostic bar counts).
const TRAIN_BARS = 252; // ~1y in-sample (swing uses fixed params; train span kept for cadence)
const TEST_BARS = 63; // ~1 quarter out-of-sample per window
const WARMUP_BARS = 250; // clears the 200-day slow EMA the swing router keys on

// The D1 earnings rule thresholds (calendar days). Mirror `catalyst-gate.ts`
// DEFAULT_SWING_MAX_DAYS / DEFAULT_INTRADAY_MAX_DAYS — inlined to avoid a server
// dep. `SWING_MAX_DAYS` stays exported for the point-in-time helper tests.
const SWING_MAX_DAYS = 10;
const INTRADAY_MAX_DAYS = 1;

/**
 * The two books graded here. Each is run once; the gate is then applied as a
 * point-in-time split of that book's ledger, swept across `sweepDays`. `swing`
 * proxies the live `sma200_pullback` router; `intraday_trend` (ichimoku) proxies
 * the intraday trend entries (ORB / Ichimoku) the gate also touches. NOTE: true
 * intraday opening-range (ORB) entries need intraday bars this daily harness does
 * not fetch — see `verdict.notes`; ichimoku is the daily-cadence trend proxy.
 */
interface BookSpec {
  label: string;
  strategyType: BacktestConfig['strategyType'];
  defaultThresholdDays: number;
  sweepDays: number[];
}
const BOOKS: BookSpec[] = [
  { label: 'swing', strategyType: 'swing', defaultThresholdDays: SWING_MAX_DAYS, sweepDays: [5, 7, 10, 14] },
  { label: 'intraday_trend', strategyType: 'ichimoku', defaultThresholdDays: INTRADAY_MAX_DAYS, sweepDays: [1, 2] },
];

// Sample-sufficiency floor: below ~30 gated entries per book the OOS split is
// anecdote, not evidence (QuantTrader criterion 3). Logged, never silently hidden.
const SAMPLE_MIN = 30;

// Equity execution costs: commission-free, slippage is the real cost. Matches
// run-tra470-orb-gate.ts / backtest-equity.ts.
const SLIPPAGE_BPS = 5;
const INITIAL_EQUITY = 25_000;

// A trade whose realized R ≤ this is a "tail / large-gap" loss (full-risk stop
// or a gap straight through it) — the loss family an earnings gate exists to cut.
// Also the stop-hit proxy for the suppressed-cohort stop-hit rate.
const TAIL_LOSS_R = -1.0;

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

// ── deterministic PRNG (seeded, reproducible smoke) ──────────────────────────
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function symbolSeed(symbol: string): number {
  return symbol.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

// ── point-in-time earnings index (no lookahead) ──────────────────────────────
/** `symbol (UPPER) → sorted unique YYYY-MM-DD earnings dates`. */
type EarningsIndex = Map<string, string[]>;

function buildEarningsIndex(events: readonly EarningsEvent[]): EarningsIndex {
  const idx: EarningsIndex = new Map();
  for (const ev of events) {
    const sym = ev.symbol.trim().toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;
    const list = idx.get(sym);
    if (list) list.push(ev.date);
    else idx.set(sym, [ev.date]);
  }
  for (const [sym, list] of idx) {
    idx.set(sym, [...new Set(list)].sort());
  }
  return idx;
}

/**
 * Days to the nearest NOT-YET-PAST earnings date as of `asOf`, or `null` when
 * the symbol is uncovered / has no future event in the index. Point-in-time:
 * reads only scheduled dates ≥ the decision bar — identical semantics to the
 * live `earnings-store.earningsInDaysSync` + `nextEarningsDate`.
 */
function earningsInDaysAsOf(index: EarningsIndex, symbol: string, asOf: number): number | null {
  const list = index.get(symbol.trim().toUpperCase());
  if (!list) return null;
  let best: number | null = null;
  for (const date of list) {
    const d = daysUntil(date, asOf);
    if (d === null || d < 0) continue;
    if (best === null || d < best) best = d;
    // list is sorted ascending; the first non-past date is already the nearest.
    if (best !== null) break;
  }
  return best;
}

/** The D1 `earnings_swing` predicate: suppress a NEW entry near earnings. */
function gatedAtEntry(earningsInDays: number | null, thresholdDays: number): boolean {
  return earningsInDays !== null && earningsInDays <= thresholdDays;
}

// ── left-tail statistics (QuantTrader criteria 1/2/5) ────────────────────────
/**
 * Linear-interpolated percentile of `xs` (p in [0,1], ascending). p10 of an R
 * series is the left-tail read the gate's thesis lives or dies on. 0 on empty.
 */
function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Mean of the worst 10% of `xs` (bottom decile by value). 0 on empty. */
function worstDecileMean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(s.length * 0.1));
  const slice = s.slice(0, k);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Fraction of trades that hit a full-risk / gap-through stop (R ≤ TAIL_LOSS_R). */
function stopHitRate(rs: readonly number[]): number {
  if (rs.length === 0) return 0;
  return rs.filter((r) => r <= TAIL_LOSS_R).length / rs.length;
}

function tailLossCount(rs: readonly number[]): number {
  return rs.filter((r) => r <= TAIL_LOSS_R).length;
}

// ── gate split as point-in-time records ──────────────────────────────────────
/**
 * One OOS trade, tagged with its days-to-earnings at entry (point-in-time,
 * `null` = uncovered / no future event). Every threshold in the sweep re-reads
 * the gate off this single number — no per-threshold re-backtest.
 */
interface GatedRecord {
  eDays: number | null;
  r: number;
  pnl: number;
}

interface ArmRs {
  baseRs: number[];
  basePnls: number[];
  gatedRs: number[];
  gatedPnls: number[];
  /** Trades the gate removed (baseline − gated), at the DEFAULT threshold. */
  removedRs: number[];
  removedPnls: number[];
}

/** Days-to-earnings at each entry (point-in-time), aligned to `trades`/`tradeRs`. */
function toGatedRecords(
  symbol: string,
  trades: ReadonlyArray<{ openedAt: number; pnl?: number }>,
  tradeRs: readonly number[],
  index: EarningsIndex,
): GatedRecord[] {
  const out: GatedRecord[] = [];
  for (let i = 0; i < trades.length; i++) {
    out.push({
      eDays: earningsInDaysAsOf(index, symbol, trades[i].openedAt),
      r: tradeRs[i] ?? 0,
      pnl: trades[i].pnl ?? 0,
    });
  }
  return out;
}

/** Split a pooled record set into baseline / gated / removed arms at a threshold. */
function armAtThreshold(records: readonly GatedRecord[], thresholdDays: number): ArmRs {
  const arm: ArmRs = { baseRs: [], basePnls: [], gatedRs: [], gatedPnls: [], removedRs: [], removedPnls: [] };
  for (const rec of records) {
    arm.baseRs.push(rec.r);
    arm.basePnls.push(rec.pnl);
    if (gatedAtEntry(rec.eDays, thresholdDays)) {
      arm.removedRs.push(rec.r);
      arm.removedPnls.push(rec.pnl);
    } else {
      arm.gatedRs.push(rec.r);
      arm.gatedPnls.push(rec.pnl);
    }
  }
  return arm;
}

/**
 * Back-compat wrapper preserved for the point-in-time helper tests: split one
 * symbol's ledger at the default swing threshold. New code uses
 * `toGatedRecords` + `armAtThreshold` so the sweep is free.
 */
function splitByGate(
  symbol: string,
  trades: ReadonlyArray<{ openedAt: number; pnl?: number }>,
  tradeRs: readonly number[],
  index: EarningsIndex,
): ArmRs {
  return armAtThreshold(toGatedRecords(symbol, trades, tradeRs, index), SWING_MAX_DAYS);
}

// ── verdict shape ────────────────────────────────────────────────────────────
type RunMode = 'smoke-deterministic' | 'live';

interface ArmSummary extends TradeMetrics {
  tailLosses: number;
  /** 10th-percentile R — the left-tail read (criterion 1/2). */
  p10R: number;
  /** Worst single trade R (min). */
  worstR: number;
  /** Mean of the worst-decile R (bottom 10%). */
  worstDecileMeanR: number;
  /** Fraction of trades hitting a full-risk stop (R ≤ −1). */
  stopHitRate: number;
}

function summarizeArm(rs: number[], pnls: number[]): ArmSummary {
  return {
    ...summarizeTrades(rs, pnls),
    tailLosses: tailLossCount(rs),
    p10R: round(percentile(rs, 0.1)),
    worstR: rs.length ? round(Math.min(...rs)) : 0,
    worstDecileMeanR: round(worstDecileMean(rs)),
    stopHitRate: round(stopHitRate(rs)),
  };
}

interface SweepRow {
  thresholdDays: number;
  removedTrades: number;
  gated: ArmSummary;
  /** The suppressed cohort AT THIS THRESHOLD — its own arm. */
  suppressed: ArmSummary;
  delta: {
    sharpe: number;
    sortino: number;
    avgR: number;
    maxDrawdownR: number;
    tailLosses: number;
    p10R: number;
  };
}

interface BookVerdict {
  label: string;
  strategyType: string;
  defaultThresholdDays: number;
  perSymbol: Array<{
    symbol: string;
    bars: number;
    earningsEvents: number;
    baseline: ArmSummary;
    gated: ArmSummary;
    removedTrades: number;
    removedTailLosses: number;
  }>;
  aggregate: {
    baseline: ArmSummary;
    /** Gated arm at the DEFAULT threshold. */
    gated: ArmSummary;
    /** The removed / suppressed cohort at the DEFAULT threshold (criterion 2/5). */
    suppressed: ArmSummary;
    removedTrades: number;
    removedTailLosses: number;
    delta: {
      sharpe: number;
      sortino: number;
      avgR: number;
      profitFactor: number;
      maxDrawdownR: number;
      winRate: number;
      trades: number;
      tailLosses: number;
      p10R: number;
      worstDecileMeanR: number;
    };
  };
  /** Criterion 3: removed-entry N vs the ~30 floor. */
  sampleSufficiency: {
    removedEntries: number;
    minRequired: number;
    sufficient: boolean;
  };
  /** Criterion 4: gate effect across the threshold sweep. */
  thresholdSweep: SweepRow[];
  /** DoD: not degrade expectancy/Sharpe AND reduce MDD and/or tail losses. */
  dod: {
    expectancyNotDegraded: boolean;
    sharpeNotDegraded: boolean;
    reducesDrawdownOrTail: boolean;
    pass: boolean;
  };
}

interface OosVerdict {
  mode: RunMode;
  window: { start: string; end: string };
  config: {
    universe: string[];
    trainBars: number;
    testBars: number;
    warmupBars: number;
    swingMaxDays: number;
    intradayMaxDays: number;
    sampleMin: number;
    slippageBps: number;
    initialEquity: number;
  };
  books: BookVerdict[];
  /** Honest coverage caveats — silent gaps read as "covered everything". */
  notes: string[];
}

// ── per-symbol OOS run ───────────────────────────────────────────────────────
async function runSymbolBook(
  book: BookSpec,
  symbol: string,
  candles: Candle[],
  index: EarningsIndex,
): Promise<{ perSymbol: BookVerdict['perSymbol'][number]; records: GatedRecord[] }> {
  const config: BacktestConfig = {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType: book.strategyType,
    slippageBps: SLIPPAGE_BPS,
    portfolioOpts: { maxOpenPositions: 1, maxSectorExposure: 1 },
  };

  const report = await walkForward(config, candles, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    warmupBars: WARMUP_BARS,
  });
  const agg = report.aggregate;

  const records = toGatedRecords(symbol, agg.trades, agg.tradeRs, index);
  const arm = armAtThreshold(records, book.defaultThresholdDays);
  const baseline = summarizeArm(arm.baseRs, arm.basePnls);
  const gated = summarizeArm(arm.gatedRs, arm.gatedPnls);

  const perSymbol: BookVerdict['perSymbol'][number] = {
    symbol,
    bars: candles.length,
    earningsEvents: (index.get(symbol.toUpperCase()) ?? []).length,
    baseline,
    gated,
    removedTrades: arm.removedRs.length,
    removedTailLosses: tailLossCount(arm.removedRs),
  };

  console.log(
    `[tra1973] ${book.label} ${symbol}: ${baseline.trades} base → ${gated.trades} gated ` +
      `(−${arm.removedRs.length}, −${tailLossCount(arm.removedRs)} tail) · ` +
      `avgR ${baseline.avgR.toFixed(3)}→${gated.avgR.toFixed(3)} · ` +
      `Sharpe ${baseline.sharpe.toFixed(3)}→${gated.sharpe.toFixed(3)} · ` +
      `MDD(R) ${baseline.maxDrawdownR.toFixed(2)}→${gated.maxDrawdownR.toFixed(2)}`,
  );

  return { perSymbol, records };
}

function summarizeBook(book: BookSpec, perSymbol: BookVerdict['perSymbol'], pooled: GatedRecord[]): BookVerdict {
  const baseArm = armAtThreshold(pooled, book.defaultThresholdDays);
  const baseline = summarizeArm(baseArm.baseRs, baseArm.basePnls);
  const gated = summarizeArm(baseArm.gatedRs, baseArm.gatedPnls);
  const suppressed = summarizeArm(baseArm.removedRs, baseArm.removedPnls);

  const delta = {
    sharpe: round(gated.sharpe - baseline.sharpe),
    sortino: round(gated.sortino - baseline.sortino),
    avgR: round(gated.avgR - baseline.avgR),
    profitFactor: round(gated.profitFactor - baseline.profitFactor),
    maxDrawdownR: round(gated.maxDrawdownR - baseline.maxDrawdownR),
    winRate: round(gated.winRate - baseline.winRate),
    trades: gated.trades - baseline.trades,
    tailLosses: gated.tailLosses - baseline.tailLosses,
    p10R: round(gated.p10R - baseline.p10R),
    worstDecileMeanR: round(gated.worstDecileMeanR - baseline.worstDecileMeanR),
  };

  // DoD: gated must NOT degrade expectancy/Sharpe, and SHOULD reduce MDD and/or
  // tail losses. A tiny tolerance absorbs float noise on a no-op split.
  const EPS = 1e-9;
  const expectancyNotDegraded = gated.avgR >= baseline.avgR - EPS;
  const sharpeNotDegraded = gated.sharpe >= baseline.sharpe - EPS;
  const reducesDrawdownOrTail =
    gated.maxDrawdownR < baseline.maxDrawdownR - EPS || gated.tailLosses < baseline.tailLosses;

  const thresholdSweep: SweepRow[] = book.sweepDays.map((thresholdDays) => {
    const arm = armAtThreshold(pooled, thresholdDays);
    const g = summarizeArm(arm.gatedRs, arm.gatedPnls);
    const s = summarizeArm(arm.removedRs, arm.removedPnls);
    return {
      thresholdDays,
      removedTrades: arm.removedRs.length,
      gated: g,
      suppressed: s,
      delta: {
        sharpe: round(g.sharpe - baseline.sharpe),
        sortino: round(g.sortino - baseline.sortino),
        avgR: round(g.avgR - baseline.avgR),
        maxDrawdownR: round(g.maxDrawdownR - baseline.maxDrawdownR),
        tailLosses: g.tailLosses - baseline.tailLosses,
        p10R: round(g.p10R - baseline.p10R),
      },
    };
  });

  return {
    label: book.label,
    strategyType: book.strategyType,
    defaultThresholdDays: book.defaultThresholdDays,
    perSymbol,
    aggregate: {
      baseline,
      gated,
      suppressed,
      removedTrades: baseArm.removedRs.length,
      removedTailLosses: tailLossCount(baseArm.removedRs),
      delta,
    },
    sampleSufficiency: {
      removedEntries: baseArm.removedRs.length,
      minRequired: SAMPLE_MIN,
      sufficient: baseArm.removedRs.length >= SAMPLE_MIN,
    },
    thresholdSweep,
    dod: {
      expectancyNotDegraded,
      sharpeNotDegraded,
      reducesDrawdownOrTail,
      pass: expectancyNotDegraded && sharpeNotDegraded && reducesDrawdownOrTail,
    },
  };
}

// ── full run ─────────────────────────────────────────────────────────────────
async function runAll(mode: RunMode): Promise<OosVerdict> {
  // Fetch/generate bars + earnings once per symbol; reuse across both books.
  const barsBySymbol = new Map<string, Candle[]>();
  const indexBySymbol = new Map<string, EarningsIndex>();
  for (const symbol of UNIVERSE) {
    let candles: Candle[];
    let events: EarningsEvent[];
    if (mode === 'smoke-deterministic') {
      candles = syntheticDaily(symbol, WARMUP_BARS + 900);
      events = syntheticEarnings(symbol, candles);
    } else {
      console.log(`[tra1973] ${symbol} — fetching Yahoo daily …`);
      candles = await fetchYahooDaily(symbol);
      events = liveEarningsBySymbol.get(symbol.toUpperCase()) ?? [];
    }
    if (candles.length < WARMUP_BARS + TRAIN_BARS + TEST_BARS) {
      console.log(
        `[tra1973] ${symbol} — SKIP: only ${candles.length} bars (< ${WARMUP_BARS + TRAIN_BARS + TEST_BARS} needed).`,
      );
      continue;
    }
    barsBySymbol.set(symbol, candles);
    indexBySymbol.set(symbol, buildEarningsIndex(events));
  }

  const books: BookVerdict[] = [];
  for (const book of BOOKS) {
    const perSymbol: BookVerdict['perSymbol'] = [];
    const pooled: GatedRecord[] = [];
    for (const symbol of UNIVERSE) {
      const candles = barsBySymbol.get(symbol);
      const index = indexBySymbol.get(symbol);
      if (!candles || !index) continue;
      const { perSymbol: ps, records } = await runSymbolBook(book, symbol, candles, index);
      perSymbol.push(ps);
      pooled.push(...records);
    }
    books.push(summarizeBook(book, perSymbol, pooled));
  }

  const notes = [
    'The `intraday_trend` book uses the ichimoku trend strategy on DAILY bars as the ' +
      'proxy for the intraday trend entries the D1 gate also touches. True intraday ' +
      'opening-range (ORB) entries require intraday bars this daily harness does not ' +
      'fetch — grading the ORB cohort specifically is a follow-up if the daily-cadence ' +
      'trend read is inconclusive (QuantTrader criterion 5).',
    'The gate only ever removes entries, so the gated arm is exactly the baseline ledger ' +
      'minus the point-in-time gated-out entries; the sweep re-reads the gate off each ' +
      "entry's precomputed days-to-earnings with no re-backtest.",
  ];

  return {
    mode,
    window: {
      start: new Date(WINDOW_START_MS).toISOString().slice(0, 10),
      end: new Date(WINDOW_END_MS).toISOString().slice(0, 10),
    },
    config: {
      universe: [...UNIVERSE],
      trainBars: TRAIN_BARS,
      testBars: TEST_BARS,
      warmupBars: WARMUP_BARS,
      swingMaxDays: SWING_MAX_DAYS,
      intradayMaxDays: INTRADAY_MAX_DAYS,
      sampleMin: SAMPLE_MIN,
      slippageBps: SLIPPAGE_BPS,
      initialEquity: INITIAL_EQUITY,
    },
    books,
    notes,
  };
}

// ── data sources ─────────────────────────────────────────────────────────────
async function fetchYahooDaily(symbol: string): Promise<Candle[]> {
  const result = await yf.chart(symbol, {
    period1: new Date(WINDOW_START_MS - WARMUP_BARS * DAY_MS * 1.6),
    period2: new Date(WINDOW_END_MS),
    interval: '1d',
  });
  const quotes = result?.quotes ?? [];
  return quotes
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Deterministic synthetic daily bars: a gentle uptrend with recurring pullbacks
 * into the 50-EMA and RSI oscillation, so the swing router actually fires. Not a
 * market model — its only job is to exercise the full pipeline in the smoke.
 */
function syntheticDaily(symbol: string, bars: number): Candle[] {
  const rand = mulberry32(symbolSeed(symbol));
  const out: Candle[] = [];
  let price = 100 + (rand() * 60);
  for (let i = 0; i < bars; i++) {
    // Slow drift up + a ~28-bar pullback cycle + bounded noise.
    const drift = 0.0006;
    const cycle = Math.sin((i / 28) * Math.PI * 2) * 0.012;
    const noise = (rand() - 0.5) * 0.02;
    const ret = drift + cycle + noise;
    const prevClose = price;
    price = Math.max(1, price * (1 + ret));
    const high = Math.max(prevClose, price) * (1 + rand() * 0.006);
    const low = Math.min(prevClose, price) * (1 - rand() * 0.006);
    out.push({
      symbol,
      timestamp: WINDOW_START_MS - WARMUP_BARS * DAY_MS + i * DAY_MS,
      open: prevClose,
      high,
      low,
      close: price,
      volume: 1_000_000 + Math.floor(rand() * 500_000),
    });
  }
  return out;
}

/**
 * Deterministic synthetic earnings dates spanning the bar range, phase-offset
 * per symbol. Static "facts" for the point-in-time index, mirroring the real
 * Finnhub shape. The cadence is DENSIFIED to ~monthly for the smoke ONLY — real
 * earnings are quarterly, but on the synthetic tape a true 91-day spacing rarely
 * lands its ±`swingMaxDays` window on a sparse swing entry, so the gate-split
 * path would never exercise. Monthly spacing makes the split visibly fire so the
 * smoke proves the plumbing. The `--execute` path uses the true quarterly dates.
 */
function syntheticEarnings(symbol: string, candles: Candle[]): EarningsEvent[] {
  if (candles.length === 0) return [];
  const rand = mulberry32(symbolSeed(symbol) ^ 0x9e3779b9);
  const startMs = candles[0].timestamp;
  const endMs = candles[candles.length - 1].timestamp;
  const phase = Math.floor(rand() * 30);
  const out: EarningsEvent[] = [];
  for (let ms = startMs + phase * DAY_MS; ms <= endMs; ms += 30 * DAY_MS) {
    out.push({ symbol, date: new Date(ms).toISOString().slice(0, 10), epsEstimate: null, hour: 'amc' });
  }
  return out;
}

// ── markdown report (drop straight into the issue comment) ───────────────────
function renderBook(bk: BookVerdict): string {
  const a = bk.aggregate;
  const b = a.baseline;
  const g = a.gated;
  const s = a.suppressed;
  const d = a.delta;
  const n = (x: number, dp = 3) => x.toFixed(dp);
  const row = (label: string, base: number | string, gate: number | string, delta: number | string) =>
    `| ${label} | ${base} | ${gate} | ${delta} |`;

  const suf = bk.sampleSufficiency;
  const sufMark = suf.sufficient ? '✅' : '⚠️';

  const lines: string[] = [
    `#### Book: \`${bk.label}\` (${bk.strategyType}, earnings ≤ ${bk.defaultThresholdDays}d, ${bk.perSymbol.length} names)`,
    '',
    '| Metric | Baseline | Gated | Δ |',
    '| --- | ---: | ---: | ---: |',
    row('Trades', b.trades, g.trades, d.trades),
    row('Hit-rate', `${n(b.winRate * 100, 1)}%`, `${n(g.winRate * 100, 1)}%`, `${n(d.winRate * 100, 1)}pp`),
    row('Expectancy (avg R)', n(b.avgR), n(g.avgR), n(d.avgR)),
    row('Sharpe (per-trade)', n(b.sharpe), n(g.sharpe), n(d.sharpe)),
    row('Sortino (per-trade)', n(b.sortino), n(g.sortino), n(d.sortino)),
    row('Profit factor', n(b.profitFactor, 2), n(g.profitFactor, 2), n(d.profitFactor, 2)),
    row('Max drawdown (R)', n(b.maxDrawdownR, 2), n(g.maxDrawdownR, 2), n(d.maxDrawdownR, 2)),
    row('p10 R (left tail)', n(b.p10R), n(g.p10R), n(d.p10R)),
    row('Worst-decile mean R', n(b.worstDecileMeanR), n(g.worstDecileMeanR), n(d.worstDecileMeanR)),
    row('Worst trade R', n(b.worstR, 2), n(g.worstR, 2), '—'),
    row('Tail losses (R≤−1)', b.tailLosses, g.tailLosses, d.tailLosses),
    '',
    `**Suppressed cohort** (the ${a.removedTrades} entries the gate would drop) vs baseline population — ` +
      'justified only if materially fatter-left-tailed:',
    '',
    '| Metric | Suppressed | Baseline |',
    '| --- | ---: | ---: |',
    `| N | ${s.trades} | ${b.trades} |`,
    `| Avg R | ${n(s.avgR)} | ${n(b.avgR)} |`,
    `| p10 R | ${n(s.p10R)} | ${n(b.p10R)} |`,
    `| Worst-decile mean R | ${n(s.worstDecileMeanR)} | ${n(b.worstDecileMeanR)} |`,
    `| Stop-hit rate | ${n(s.stopHitRate * 100, 1)}% | ${n(b.stopHitRate * 100, 1)}% |`,
    '',
    `**Sample sufficiency** ${sufMark} — ${suf.removedEntries} gated entries ` +
      `(floor ${suf.minRequired}). ${suf.sufficient ? 'Sufficient.' : 'BELOW floor — extend the window before grading; treat as anecdote.'}`,
    '',
    `**Threshold sweep** (default ${bk.defaultThresholdDays}d — look for a plateau, not a lucky point):`,
    '',
    '| Threshold (d) | Removed | ΔSharpe | ΔSortino | ΔMaxDD(R) | ΔTail | Δp10 R |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...bk.thresholdSweep.map(
      (sw) =>
        `| ${sw.thresholdDays}${sw.thresholdDays === bk.defaultThresholdDays ? ' *(def)*' : ''} | ${sw.removedTrades} | ` +
        `${n(sw.delta.sharpe)} | ${n(sw.delta.sortino)} | ${n(sw.delta.maxDrawdownR, 2)} | ${sw.delta.tailLosses} | ${n(sw.delta.p10R)} |`,
    ),
    '',
    `**DoD** — expectancy not degraded: ${bk.dod.expectancyNotDegraded ? '✅' : '❌'} · ` +
      `Sharpe not degraded: ${bk.dod.sharpeNotDegraded ? '✅' : '❌'} · ` +
      `reduces MDD and/or tail: ${bk.dod.reducesDrawdownOrTail ? '✅' : '❌'} → ` +
      `**${bk.dod.pass ? 'PASS' : 'REVIEW'}**`,
  ];
  return lines.join('\n');
}

function renderReport(v: OosVerdict): string {
  const lines = [
    `**TRA-1968 earnings gate — OOS report (${v.mode}, ${v.window.start}→${v.window.end})**`,
    '',
    ...v.books.flatMap((bk) => [renderBook(bk), '']),
    '**Notes:**',
    ...v.notes.map((note) => `- ${note}`),
  ];
  return lines.join('\n');
}

// ── earnings reachability + live fetch ───────────────────────────────────────
const liveEarningsBySymbol = new Map<string, EarningsEvent[]>();

function describeFinnhub(): { reachable: boolean; summary: string } {
  const token = (process.env['FINNHUB_API_TOKEN'] ?? '').trim();
  if (!token) {
    return {
      reachable: false,
      summary:
        'FINNHUB_API_TOKEN NOT set — the historical earnings calendar is unreachable, so the ' +
        'point-in-time gate cannot be evaluated on real data. The real OOS run is BLOCKED on ' +
        'the token (same feeds-off reality as TRA-1965). Yahoo daily bars are free and reachable.',
    };
  }
  return { reachable: true, summary: `FINNHUB_API_TOKEN set (prefix ${token.slice(0, 4)}…) — earnings reachable.` };
}

/** Fetch the historical earnings calendar for the OOS span, once, all symbols. */
async function fetchHistoricalEarnings(): Promise<void> {
  const token = (process.env['FINNHUB_API_TOKEN'] ?? '').trim();
  if (!token) return;
  const client = new EarningsCalendarClient(token);
  // One backdated window covers the whole OOS span (+ threshold slack on both
  // ends so an event just outside the span still gates a boundary entry).
  const spanDays = Math.ceil((WINDOW_END_MS - WINDOW_START_MS) / DAY_MS) + SWING_MAX_DAYS * 2;
  const events = await client.fetchWindow({
    asOf: WINDOW_START_MS - SWING_MAX_DAYS * DAY_MS,
    fromDays: 0,
    toDays: spanDays,
  });
  const want = new Set(UNIVERSE.map((s) => s.toUpperCase()));
  for (const ev of events) {
    if (!want.has(ev.symbol)) continue;
    const list = liveEarningsBySymbol.get(ev.symbol);
    if (list) list.push(ev);
    else liveEarningsBySymbol.set(ev.symbol, [ev]);
  }
  const covered = [...liveEarningsBySymbol.entries()].map(([s, e]) => `${s}:${e.length}`).join(' ');
  console.log(`[tra1973] fetched historical earnings — ${covered || '(none for universe)'}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const smoke = argv.includes('--smoke');
  const execute = argv.includes('--execute');

  const fh = describeFinnhub();
  console.log(`[tra1973] ${fh.summary}`);
  console.log(
    `[tra1973] window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ` +
      `${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} · train=${TRAIN_BARS} test=${TEST_BARS} ` +
      `warmup=${WARMUP_BARS} bars · swing≤${SWING_MAX_DAYS}d intraday≤${INTRADAY_MAX_DAYS}d · universe ${UNIVERSE.join(',')}`,
  );

  if (!smoke && !execute) {
    console.log(
      '\n[tra1973] PLAN mode — nothing run (no spend, no network). Pass --smoke for the free ' +
        'deterministic wiring check, or --execute for the real Yahoo+Finnhub run.',
    );
    return;
  }

  let mode: RunMode;
  if (execute) {
    if (!fh.reachable) {
      console.error(
        '[tra1973] --execute requested but FINNHUB_API_TOKEN is unset. The gate cannot be ' +
          'evaluated point-in-time without the historical earnings calendar. Aborting — this is ' +
          'a real blocker (route to whoever provisions the Finnhub token, cf. TRA-1965).',
      );
      process.exit(2);
      return;
    }
    await fetchHistoricalEarnings();
    mode = 'live';
  } else {
    mode = 'smoke-deterministic';
    console.log('[tra1973] --smoke: synthetic bars + synthetic earnings, zero network.');
  }

  const verdict = await runAll(mode);

  mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = resolve(REPORT_DIR, `tra1968-earnings-gate-oos-${mode === 'live' ? 'live' : 'smoke'}.json`);
  writeFileSync(outPath, JSON.stringify(verdict, null, 2));
  console.log(`\n[tra1973] wrote ${outPath}\n`);
  console.log(renderReport(verdict));
}

const invoked =
  process.argv[1] && /[\\/]run-tra1968-earnings-gate\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  buildEarningsIndex,
  earningsInDaysAsOf,
  gatedAtEntry,
  splitByGate,
  toGatedRecords,
  armAtThreshold,
  percentile,
  worstDecileMean,
  stopHitRate,
  summarizeArm,
  renderBook,
  renderReport,
  SWING_MAX_DAYS,
  INTRADAY_MAX_DAYS,
  type GatedRecord,
  type OosVerdict,
  type BookVerdict,
};
