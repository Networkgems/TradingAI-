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
 * Baseline vs gated, side by side, on the daily swing book (`strategyType:
 * 'swing'`) run through the TRA-172 `walkForward(...)` harness:
 *   • Sharpe (per-trade), expectancy (avg R), profit factor, max drawdown (R),
 *     trade count, hit-rate — baseline vs gated + delta.
 *   • Tail (large-gap) losses removed — trades with R ≤ −1 the gate stood aside
 *     from. The DoD's "reduce max drawdown and/or tail losses" test keys on this.
 *
 * ── Modeling the gate ────────────────────────────────────────────────────────
 * The D1 earnings rule is a pure predicate: suppress a NEW swing entry when the
 * symbol's next earnings is within `swingMaxDays` (10, per the TRA-1968 plan).
 * Since it only ever *removes* entries and never alters an unrelated trade, the
 * gated arm is exactly the baseline trade ledger with the gated-out entries
 * dropped — so we run the swing book once and split the ledger point-in-time at
 * each entry's `openedAt`. This mirrors `evaluateCatalystGate`'s `earnings_swing`
 * branch (inlined here — the backtest package deliberately does not depend on
 * `@trading-app/server`; same pattern as run-tra797-agents-ab.ts). `strategyType:
 * 'swing'` is the daily-swing proxy for the live `sma200_pullback` router the D1
 * gate actually targets — both are daily-cadence long-pullback entries.
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

// The D1 earnings rule threshold (calendar days). Mirrors
// `catalyst-gate.ts` DEFAULT_SWING_MAX_DAYS — inlined to avoid a server dep.
const SWING_MAX_DAYS = 10;

// Equity execution costs: commission-free, slippage is the real cost. Matches
// run-tra470-orb-gate.ts / backtest-equity.ts.
const SLIPPAGE_BPS = 5;
const INITIAL_EQUITY = 25_000;

// A trade whose realized R ≤ this is a "tail / large-gap" loss (full-risk stop
// or a gap straight through it) — the loss family an earnings gate exists to cut.
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

// ── gate split + metrics ─────────────────────────────────────────────────────
interface ArmRs {
  baseRs: number[];
  basePnls: number[];
  gatedRs: number[];
  gatedPnls: number[];
  /** Trades the gate removed (baseline − gated). */
  removedRs: number[];
}

/**
 * Split one symbol's OOS trade ledger into baseline (all trades) and gated
 * (trades whose entry the earnings gate would NOT have blocked), point-in-time
 * at each `openedAt`. `tradeRs[i]` aligns with `trades[i]` (runner pushes them
 * together); `pnl` rides on the Position.
 */
function splitByGate(
  symbol: string,
  trades: ReadonlyArray<{ openedAt: number; pnl?: number }>,
  tradeRs: readonly number[],
  index: EarningsIndex,
): ArmRs {
  const arm: ArmRs = { baseRs: [], basePnls: [], gatedRs: [], gatedPnls: [], removedRs: [] };
  for (let i = 0; i < trades.length; i++) {
    const r = tradeRs[i] ?? 0;
    const pnl = trades[i].pnl ?? 0;
    arm.baseRs.push(r);
    arm.basePnls.push(pnl);
    const eDays = earningsInDaysAsOf(index, symbol, trades[i].openedAt);
    if (gatedAtEntry(eDays, SWING_MAX_DAYS)) {
      arm.removedRs.push(r);
    } else {
      arm.gatedRs.push(r);
      arm.gatedPnls.push(pnl);
    }
  }
  return arm;
}

function tailLossCount(rs: readonly number[]): number {
  return rs.filter((r) => r <= TAIL_LOSS_R).length;
}

// ── verdict shape ────────────────────────────────────────────────────────────
type RunMode = 'smoke-deterministic' | 'live';

interface ArmSummary extends TradeMetrics {
  tailLosses: number;
}

function summarizeArm(rs: number[], pnls: number[]): ArmSummary {
  return { ...summarizeTrades(rs, pnls), tailLosses: tailLossCount(rs) };
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
    slippageBps: number;
    initialEquity: number;
  };
  perSymbol: Array<{
    symbol: string;
    bars: number;
    earningsEvents: number;
    baseline: ArmSummary;
    gated: ArmSummary;
    removedTrades: number;
    removedTailLosses: number;
  }>;
  /** Pooled OOS aggregate across the universe — the headline table. */
  aggregate: {
    baseline: ArmSummary;
    gated: ArmSummary;
    removedTrades: number;
    removedTailLosses: number;
    delta: {
      sharpe: number;
      avgR: number;
      profitFactor: number;
      maxDrawdownR: number;
      winRate: number;
      trades: number;
      tailLosses: number;
    };
  };
  /** DoD checks: not degrade expectancy/Sharpe AND reduce MDD and/or tail losses. */
  dod: {
    expectancyNotDegraded: boolean;
    sharpeNotDegraded: boolean;
    reducesDrawdownOrTail: boolean;
    pass: boolean;
  };
}

// ── per-symbol OOS run ───────────────────────────────────────────────────────
async function runSymbol(
  symbol: string,
  candles: Candle[],
  index: EarningsIndex,
): Promise<{
  perSymbol: OosVerdict['perSymbol'][number];
  pooled: ArmRs;
}> {
  const config: BacktestConfig = {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'swing',
    slippageBps: SLIPPAGE_BPS,
    portfolioOpts: { maxOpenPositions: 1, maxSectorExposure: 1 },
  };

  const report = await walkForward(config, candles, {
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    warmupBars: WARMUP_BARS,
  });
  const agg = report.aggregate;

  const arm = splitByGate(symbol, agg.trades, agg.tradeRs, index);
  const baseline = summarizeArm(arm.baseRs, arm.basePnls);
  const gated = summarizeArm(arm.gatedRs, arm.gatedPnls);

  const perSymbol: OosVerdict['perSymbol'][number] = {
    symbol,
    bars: candles.length,
    earningsEvents: (index.get(symbol.toUpperCase()) ?? []).length,
    baseline,
    gated,
    removedTrades: arm.removedRs.length,
    removedTailLosses: tailLossCount(arm.removedRs),
  };

  console.log(
    `[tra1973] ${symbol}: ${baseline.trades} base → ${gated.trades} gated ` +
      `(−${arm.removedRs.length}, −${tailLossCount(arm.removedRs)} tail) · ` +
      `avgR ${baseline.avgR.toFixed(3)}→${gated.avgR.toFixed(3)} · ` +
      `Sharpe ${baseline.sharpe.toFixed(3)}→${gated.sharpe.toFixed(3)} · ` +
      `MDD(R) ${baseline.maxDrawdownR.toFixed(2)}→${gated.maxDrawdownR.toFixed(2)}`,
  );

  return { perSymbol, pooled: arm };
}

// ── full run ─────────────────────────────────────────────────────────────────
async function runAll(mode: RunMode): Promise<OosVerdict> {
  const perSymbol: OosVerdict['perSymbol'] = [];
  const poolBaseRs: number[] = [];
  const poolBasePnls: number[] = [];
  const poolGatedRs: number[] = [];
  const poolGatedPnls: number[] = [];
  const poolRemovedRs: number[] = [];

  for (const symbol of UNIVERSE) {
    let candles: Candle[];
    let events: EarningsEvent[];
    if (mode === 'smoke-deterministic') {
      candles = syntheticDaily(symbol, WARMUP_BARS + 900);
      events = syntheticEarnings(symbol, candles);
    } else {
      console.log(`[tra1973] ${symbol} — fetching Yahoo daily …`);
      candles = await fetchYahooDaily(symbol);
      // Historical earnings for the OOS span, backdated. Injected below.
      events = liveEarningsBySymbol.get(symbol.toUpperCase()) ?? [];
    }
    if (candles.length < WARMUP_BARS + TRAIN_BARS + TEST_BARS) {
      console.log(
        `[tra1973] ${symbol} — SKIP: only ${candles.length} bars (< ${WARMUP_BARS + TRAIN_BARS + TEST_BARS} needed).`,
      );
      continue;
    }
    const index = buildEarningsIndex(events);
    const { perSymbol: ps, pooled } = await runSymbol(symbol, candles, index);
    perSymbol.push(ps);
    poolBaseRs.push(...pooled.baseRs);
    poolBasePnls.push(...pooled.basePnls);
    poolGatedRs.push(...pooled.gatedRs);
    poolGatedPnls.push(...pooled.gatedPnls);
    poolRemovedRs.push(...pooled.removedRs);
  }

  const baseline = summarizeArm(poolBaseRs, poolBasePnls);
  const gated = summarizeArm(poolGatedRs, poolGatedPnls);
  const delta = {
    sharpe: round(gated.sharpe - baseline.sharpe),
    avgR: round(gated.avgR - baseline.avgR),
    profitFactor: round(gated.profitFactor - baseline.profitFactor),
    maxDrawdownR: round(gated.maxDrawdownR - baseline.maxDrawdownR),
    winRate: round(gated.winRate - baseline.winRate),
    trades: gated.trades - baseline.trades,
    tailLosses: gated.tailLosses - baseline.tailLosses,
  };

  // DoD: gated must NOT degrade expectancy/Sharpe, and SHOULD reduce MDD and/or
  // tail losses. A tiny tolerance absorbs float noise on a no-op split.
  const EPS = 1e-9;
  const expectancyNotDegraded = gated.avgR >= baseline.avgR - EPS;
  const sharpeNotDegraded = gated.sharpe >= baseline.sharpe - EPS;
  const reducesDrawdownOrTail =
    gated.maxDrawdownR < baseline.maxDrawdownR - EPS ||
    gated.tailLosses < baseline.tailLosses;

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
      slippageBps: SLIPPAGE_BPS,
      initialEquity: INITIAL_EQUITY,
    },
    perSymbol,
    aggregate: {
      baseline,
      gated,
      removedTrades: poolRemovedRs.length,
      removedTailLosses: tailLossCount(poolRemovedRs),
      delta,
    },
    dod: {
      expectancyNotDegraded,
      sharpeNotDegraded,
      reducesDrawdownOrTail,
      pass: expectancyNotDegraded && sharpeNotDegraded && reducesDrawdownOrTail,
    },
  };
}

// ── markdown table (drop straight into the issue comment) ────────────────────
function renderTable(v: OosVerdict): string {
  const a = v.aggregate;
  const b = a.baseline;
  const g = a.gated;
  const d = a.delta;
  const row = (label: string, base: number | string, gate: number | string, delta: number | string) =>
    `| ${label} | ${base} | ${gate} | ${delta} |`;
  const n = (x: number, dp = 3) => x.toFixed(dp);
  const lines = [
    `**TRA-1968 earnings gate — OOS aggregate (${v.mode}, ${v.window.start}→${v.window.end}, ${v.perSymbol.length} names)**`,
    '',
    '| Metric | Baseline | Gated | Δ |',
    '| --- | ---: | ---: | ---: |',
    row('Trades', b.trades, g.trades, d.trades),
    row('Hit-rate', `${n(b.winRate * 100, 1)}%`, `${n(g.winRate * 100, 1)}%`, `${n(d.winRate * 100, 1)}pp`),
    row('Expectancy (avg R)', n(b.avgR), n(g.avgR), n(d.avgR)),
    row('Sharpe (per-trade)', n(b.sharpe), n(g.sharpe), n(d.sharpe)),
    row('Profit factor', n(b.profitFactor, 2), n(g.profitFactor, 2), n(d.profitFactor, 2)),
    row('Max drawdown (R)', n(b.maxDrawdownR, 2), n(g.maxDrawdownR, 2), n(d.maxDrawdownR, 2)),
    row('Tail losses (R≤−1)', b.tailLosses, g.tailLosses, d.tailLosses),
    '',
    `Gated out **${a.removedTrades}** entries (**${a.removedTailLosses}** of them tail/large-gap losses).`,
    '',
    `**DoD** — expectancy not degraded: ${v.dod.expectancyNotDegraded ? '✅' : '❌'} · ` +
      `Sharpe not degraded: ${v.dod.sharpeNotDegraded ? '✅' : '❌'} · ` +
      `reduces MDD and/or tail: ${v.dod.reducesDrawdownOrTail ? '✅' : '❌'} → ` +
      `**${v.dod.pass ? 'PASS' : 'REVIEW'}**`,
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
      `warmup=${WARMUP_BARS} bars · swingMaxDays=${SWING_MAX_DAYS} · universe ${UNIVERSE.join(',')}`,
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
  console.log(renderTable(verdict));
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
  summarizeArm,
  renderTable,
  SWING_MAX_DAYS,
  type OosVerdict,
};
