// ── Automated pre/post-market analyst agent (TRA-1006, spec TRA-1005) ─────────
//
// Replaces the manual QuantTrader pre/post-market loop with an in-app agent that
// runs unattended on the demo/paper book. Two entry points:
//
//   • buildPremarketPlan(...)  — per watchlist symbol compute S/R + reversal
//     checklist, rank by 0.5·proximity + 0.3·reversal + 0.2·trendAlign (red-regime
//     inverted), publish a ReviewBlock so the demo loop consumes the plan.
//   • buildPostmarketReview(...) — fold the day's demo option-trade journal into a
//     per-regime / per-setup reflection and emit ≥1 hypothesis (R1/R2/R3) into the
//     TRA-994 pipeline.
//
// INVARIANTS (TRA-990): demo/paper only, no autonomous live-capital path. Nothing
// the agent emits changes demo sizing before it clears the G0 gate AND board
// ratification — `runHypothesis` only ever enqueues as `pending_ratification`, and
// the demo-override flag stays OFF by default. Self-adjustment is tighten-biased;
// loosening (R2 nudge) only ever ENTERS the queue, never lands without ratification.
// Zero cost/IO while `ENABLE_ANALYST_AGENT` is unset (the scheduler checks the flag
// BEFORE any deps are built — see analyst-scheduler.ts).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { Candle, MarketReviewGates, ReviewBlock, ReviewRegimeLabel } from '@trading-app/shared';
import { supportResistance, reversalChecklist, atr } from '@trading-app/engine';

import { logger } from './observability/index.js';
import { simpleMa } from './ma-utils.js';
import {
  makeHypothesis,
  runHypothesis,
  type ConfigSnapshot,
  type Hypothesis,
  type HypothesisTargetKind,
  type ParamDelta,
  type PipelineDeps,
} from './hypothesis-pipeline.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'analyst-agent' });

export const ANALYST_AGENT_FLAG = 'ENABLE_ANALYST_AGENT';

/** True when the analyst agent is enabled. Default OFF (same shape as the other flags). */
export function isAnalystAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ANALYST_AGENT_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Watchlist cap — mirrors `MAX_REVIEW_LEADERS` so the plan never blows past the watchlist. */
export const MAX_PLAN_SYMBOLS = 15;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnalystSymbolPlan {
  symbol: string;
  /** Composite rank in [0,1]; higher = more actionable today. */
  rank: number;
  proximityScore: number;
  reversalScore: number;
  trendAlignScore: number;
  support: number | null;
  resistance: number | null;
  /** Nearest key S/R level (the thesis-invalidation reference). */
  nearestKeyLevel: number | null;
  reversal: {
    score: number;
    confirmed: boolean;
    side: 'long' | 'short' | null;
    entry: number | null;
    stop: number | null;
    target: number | null;
    rr: number | null;
  };
}

export interface AnalystPlan {
  date: string;
  generatedAt: number;
  regime: ReviewRegimeLabel;
  regimeRationale: string;
  gapRisk: boolean;
  gates: MarketReviewGates;
  watchlist: AnalystSymbolPlan[];
}

/** Aggregated outcome for a bucket (a setup-type or a regime) over the day's closed trades. */
export interface SetupOutcome {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  /** wins / trades (0 when no closed trades). */
  winRate: number;
  /** Mean realized R over the closed trades (0 when none). */
  expectancy: number;
}

export interface AnalystReflection {
  date: string;
  regime: ReviewRegimeLabel;
  totalClosed: number;
  /** Per-regime rollup (keyed by the regime that was active that day). */
  byRegime: SetupOutcome[];
  /** Per-setup-type rollup (keyed by journal `structure`). */
  bySetup: SetupOutcome[];
  /**
   * Of the day's closed trades whose symbol had a pre-market plan entry, the
   * fraction that resolved a WIN (the level-based thesis held). `null` when no
   * planned-symbol trade closed.
   */
  planAdherence: number | null;
  narrative: string;
}

export interface AnalystReview {
  date: string;
  generatedAt: number;
  reflection: AnalystReflection;
  /** The hypotheses emitted this run (ids + targets, for the audit trail). */
  hypotheses: Array<{ id: string; path: string; op: ParamDelta['op']; value: number; rule: 'R1' | 'R2' | 'R3' }>;
}

/**
 * A tunable the agent may propose to adjust. Bridges a journal aggregation key
 * (a setup-type / sleeve) to a numeric leaf in the backtest base config, with the
 * tighten (R1) and nudge-up (R2) deltas pre-declared so direction is auditable and
 * QuantTrader owns the mapping. `path` MUST resolve to a finite number in the base
 * config or the agent skips it (so the pipeline never rejects a malformed target).
 */
export interface AnalystTunable {
  /** Matches a journal `structure` (setup-type) — drives which rule a tunable serves. */
  key: string;
  kind: HypothesisTargetKind;
  /** Dotted numeric path into the backtest base config. */
  path: string;
  /** R1 delta — must REDUCE risk / restrict (tighten-biased invariant). */
  tighten: ParamDelta;
  /** R2 delta — a small upward nudge of a strong signal (enters as pending_ratification only). */
  nudge: ParamDelta;
}

export interface AnalystHealth {
  enabled: boolean;
  lastPlanDate: string | null;
  watchlistCount: number;
  lastReviewDate: string | null;
  hypothesesQueuedToday: number;
}

// ── Pre-market ranking ───────────────────────────────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Symbol daily trend from a 20-period SMA with a ±0.2% neutral band. */
function symbolTrend(candles: Candle[]): 'up' | 'down' | 'neutral' {
  const ma = simpleMa(candles, 20);
  if (ma == null || candles.length === 0) return 'neutral';
  const close = candles[candles.length - 1].close;
  const band = ma * 0.002;
  if (close > ma + band) return 'up';
  if (close < ma - band) return 'down';
  return 'neutral';
}

export interface SymbolScore {
  rank: number;
  proximityScore: number;
  reversalScore: number;
  trendAlignScore: number;
  support: number | null;
  resistance: number | null;
  nearestKeyLevel: number | null;
  reversal: AnalystSymbolPlan['reversal'];
}

/**
 * Score one symbol's daily candles per the spec formula:
 * `rank = 0.5·proximity + 0.3·reversal + 0.2·trendAlign`.
 * In a RED regime the trend-align leg inverts to favour short-side setups
 * (defensive / mean-reversion tilt).
 */
export function scoreSymbol(
  candles: Candle[],
  regime: ReviewRegimeLabel,
  gatesTrendState: MarketReviewGates['trendState'],
): SymbolScore {
  const sr = supportResistance(candles);
  const rev = reversalChecklist(candles);
  const a = atr(candles, 14);
  const close = candles.length ? candles[candles.length - 1].close : null;

  const support = sr.support?.level ?? null;
  const resistance = sr.resistance?.level ?? null;

  // Distance to the nearest key level, and which level it is.
  let nearestKeyLevel: number | null = null;
  let dist = Infinity;
  if (close != null) {
    if (support != null) {
      const d = Math.abs(close - support);
      if (d < dist) { dist = d; nearestKeyLevel = support; }
    }
    if (resistance != null) {
      const d = Math.abs(close - resistance);
      if (d < dist) { dist = d; nearestKeyLevel = resistance; }
    }
  }

  const proximityScore =
    a != null && a > 0 && Number.isFinite(dist) ? 1 - clamp01(dist / (1.5 * a)) : 0;

  const reversalScore = clamp01(rev.score / 4 + (rev.confirmed ? 0.1 : 0));

  const trend = symbolTrend(candles);
  let trendAlignScore: number;
  if (regime === 'red') {
    // Inverted: short-side / downtrend setups rank higher in a red tape.
    trendAlignScore = trend === 'down' ? 1 : trend === 'neutral' ? 0.5 : 0;
  } else if (trend === 'neutral' || gatesTrendState == null || gatesTrendState === 'unknown') {
    trendAlignScore = 0.5;
  } else {
    trendAlignScore = trend === gatesTrendState ? 1 : 0;
  }

  const rank = 0.5 * proximityScore + 0.3 * reversalScore + 0.2 * trendAlignScore;

  return {
    rank,
    proximityScore,
    reversalScore,
    trendAlignScore,
    support,
    resistance,
    nearestKeyLevel,
    reversal: {
      score: rev.score,
      confirmed: rev.confirmed,
      side: rev.side,
      entry: rev.entry,
      stop: rev.stop,
      target: rev.target,
      rr: rev.riskReward,
    },
  };
}

export interface PremarketSymbolInput {
  symbol: string;
  /** Daily candles (chronological). */
  candles: Candle[];
}

export interface BuildPremarketPlanInput {
  date: string;
  now: number;
  regime: ReviewRegimeLabel;
  regimeRationale: string;
  gates: MarketReviewGates;
  gapRisk: boolean;
  symbols: PremarketSymbolInput[];
}

/**
 * Build the day's plan from the watchlist symbols (pure — no IO). Symbols are
 * scored, ranked descending, and capped at {@link MAX_PLAN_SYMBOLS}. The published
 * {@link ReviewBlock} carries the ranked leaders + per-symbol invalidation levels
 * (nearest support for longs / resistance for shorts) so the demo loop consumes it.
 */
export function buildPremarketPlan(input: BuildPremarketPlanInput): {
  plan: AnalystPlan;
  block: ReviewBlock;
} {
  const scored: AnalystSymbolPlan[] = input.symbols.map(({ symbol, candles }) => {
    const s = scoreSymbol(candles, input.regime, input.gates.trendState);
    return {
      symbol: symbol.trim().toUpperCase(),
      rank: s.rank,
      proximityScore: s.proximityScore,
      reversalScore: s.reversalScore,
      trendAlignScore: s.trendAlignScore,
      support: s.support,
      resistance: s.resistance,
      nearestKeyLevel: s.nearestKeyLevel,
      reversal: s.reversal,
    };
  });

  // Rank descending; stable tie-break by symbol so the order is deterministic.
  scored.sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol));
  const watchlist = scored.slice(0, MAX_PLAN_SYMBOLS);

  const invalidationLevels: Record<string, number> = {};
  for (const w of watchlist) {
    // Invalidation = the level the thesis leans on: support for longs, resistance
    // for shorts, else whichever key level is nearest.
    const level =
      w.reversal.side === 'long'
        ? w.support
        : w.reversal.side === 'short'
          ? w.resistance
          : w.nearestKeyLevel;
    if (level != null && Number.isFinite(level)) invalidationLevels[w.symbol] = level;
  }

  const plan: AnalystPlan = {
    date: input.date,
    generatedAt: input.now,
    regime: input.regime,
    regimeRationale: input.regimeRationale,
    gapRisk: input.gapRisk,
    gates: input.gates,
    watchlist,
  };

  const block: ReviewBlock = {
    leaders: watchlist.map((w) => w.symbol),
    invalidationLevels,
    gapRisk: input.gapRisk,
    regimeLabel: input.regime,
  };

  return { plan, block };
}

// ── Post-market reflection ───────────────────────────────────────────────────

/** Aggregate a set of CLOSED journal rows into one outcome bucket. */
function aggregate(key: string, rows: OptionTradeJournalRecord[]): SetupOutcome {
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let rSum = 0;
  for (const r of rows) {
    if (r.outcome === 'WIN') wins++;
    else if (r.outcome === 'LOSS') losses++;
    else if (r.outcome === 'SCRATCH') scratches++;
    if (typeof r.realizedR === 'number' && Number.isFinite(r.realizedR)) rSum += r.realizedR;
  }
  const trades = wins + losses + scratches;
  return {
    key,
    trades,
    wins,
    losses,
    scratches,
    winRate: trades > 0 ? wins / trades : 0,
    expectancy: trades > 0 ? rSum / trades : 0,
  };
}

function groupBy<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

const CLOSED = new Set(['WIN', 'LOSS', 'SCRATCH']);

/**
 * Fold the day's demo journal into the structured reflection. Only CLOSED demo
 * rows count toward win-rate / expectancy; open positions are ignored. `plan` (if
 * present) drives the plan-adherence metric.
 */
export function buildReflection(
  date: string,
  regime: ReviewRegimeLabel,
  rows: OptionTradeJournalRecord[],
  plan: AnalystPlan | null,
): AnalystReflection {
  const closed = rows.filter((r) => r.mode === 'demo' && CLOSED.has(r.outcome));

  const bySetup = [...groupBy(closed, (r) => r.structure).entries()]
    .map(([k, rs]) => aggregate(k, rs))
    .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));

  // Per-regime: the day ran under one regime, so all of it buckets there.
  const byRegime = closed.length ? [aggregate(regime, closed)] : [];

  // Plan adherence: among trades whose symbol the plan flagged, fraction that won.
  let planAdherence: number | null = null;
  if (plan) {
    const planned = new Set(plan.watchlist.map((w) => w.symbol));
    const matched = closed.filter((r) => planned.has(r.symbol.trim().toUpperCase()));
    if (matched.length) {
      planAdherence = matched.filter((r) => r.outcome === 'WIN').length / matched.length;
    }
  }

  const overall = aggregate('all', closed);
  const adherenceStr =
    planAdherence == null ? 'no planned-symbol trades closed' : `${(planAdherence * 100).toFixed(0)}% plan adherence`;
  const narrative =
    closed.length === 0
      ? `${date}: no demo option trades closed under a ${regime} regime — sparse day, re-validating current config.`
      : `${date}: ${closed.length} demo trades closed under a ${regime} regime — ${(overall.winRate * 100).toFixed(0)}% win-rate, ${overall.expectancy.toFixed(2)}R expectancy, ${adherenceStr}.`;

  return { date, regime, totalClosed: closed.length, byRegime, bySetup, planAdherence, narrative };
}

// ── Hypothesis rules (R1 / R2 / R3) ──────────────────────────────────────────

function getNumberAtPath(cfg: ConfigSnapshot, path: string): number | null {
  let node: unknown = cfg;
  for (const seg of path.split('.')) {
    if (node == null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

/** First numeric leaf path in a config (depth-first) — the last-resort R3 target. */
function firstNumericLeaf(cfg: ConfigSnapshot, prefix = ''): string | null {
  for (const [k, v] of Object.entries(cfg)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) return path;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = firstNumericLeaf(v as ConfigSnapshot, path);
      if (found) return found;
    }
  }
  return null;
}

/** A tunable usable against this base config — its path must resolve to a finite number. */
function tunableFor(
  key: string,
  tunables: AnalystTunable[],
  base: ConfigSnapshot,
): AnalystTunable | undefined {
  return tunables.find((t) => t.key === key && getNumberAtPath(base, t.path) != null);
}

/** Any tunable whose path resolves — for the R3 fallback when no setup matched. */
function anyResolvable(tunables: AnalystTunable[], base: ConfigSnapshot): AnalystTunable | null {
  return tunables.find((t) => getNumberAtPath(base, t.path) != null) ?? null;
}

export interface EmittedHypothesis {
  hypothesis: Hypothesis;
  rule: 'R1' | 'R2' | 'R3';
}

/**
 * Derive the hypotheses to emit from a reflection, in rule order. Tighten-biased:
 *   • R1 disables/restricts a weak gate (win-rate < 40%, N ≥ 5).
 *   • R2 nudges a strong signal up (win-rate > 60% AND expectancy > 0, N ≥ 5).
 *   • R3 (fallback) re-validates the worst gate of the day with a no-op `set`,
 *     guaranteeing ≥ 1 hypothesis every run (Acceptance #2).
 * Every returned hypothesis targets a path that resolves to a finite number in
 * `base`, so the pipeline can always apply it.
 */
export function deriveHypotheses(
  reflection: AnalystReflection,
  tunables: AnalystTunable[],
  base: ConfigSnapshot,
  now: number,
): EmittedHypothesis[] {
  const out: EmittedHypothesis[] = [];
  const { bySetup, regime } = reflection;

  // R1 — weakest qualifying gate.
  const weak = bySetup
    .filter((s) => s.trades >= 5 && s.winRate < 0.4)
    .sort((a, b) => a.winRate - b.winRate)[0];
  if (weak) {
    const t = tunableFor(weak.key, tunables, base);
    if (t) {
      out.push({
        rule: 'R1',
        hypothesis: makeHypothesis({
          target: { kind: t.kind, path: t.path },
          proposedDelta: t.tighten,
          rationale: `${reflection.narrative} R1: setup '${weak.key}' win-rate ${(weak.winRate * 100).toFixed(0)}% over ${weak.trades} demo trades (<40%, N≥5) in ${regime} — tighten ${t.path}.`,
          source: 'reflection',
          createdAt: now,
        }),
      });
    }
  }

  // R2 — strongest qualifying signal.
  const strong = bySetup
    .filter((s) => s.trades >= 5 && s.winRate > 0.6 && s.expectancy > 0)
    .sort((a, b) => b.winRate - a.winRate)[0];
  if (strong) {
    const t = tunableFor(strong.key, tunables, base);
    if (t) {
      out.push({
        rule: 'R2',
        hypothesis: makeHypothesis({
          // Per spec a strong-signal nudge is always a signal_weight target.
          target: { kind: 'signal_weight', path: t.path },
          proposedDelta: t.nudge,
          rationale: `${reflection.narrative} R2: setup '${strong.key}' win-rate ${(strong.winRate * 100).toFixed(0)}% / ${strong.expectancy.toFixed(2)}R over ${strong.trades} demo trades (>60%, exp>0, N≥5) — nudge ${t.path} up (pending_ratification only).`,
          source: 'reflection',
          createdAt: now,
        }),
      });
    }
  }

  // R3 — fallback re-validation (guarantees ≥1).
  if (out.length === 0) {
    const worst = bySetup.slice().sort((a, b) => a.winRate - b.winRate)[0];
    const t = (worst && tunableFor(worst.key, tunables, base)) || anyResolvable(tunables, base);
    let path: string;
    let kind: HypothesisTargetKind;
    let label: string;
    if (t) {
      path = t.path;
      kind = t.kind;
      label = `gate '${t.key}'`;
    } else {
      const leaf = firstNumericLeaf(base);
      if (!leaf) {
        log.warn('analyst R3 fallback found no numeric config leaf — no hypothesis emitted', {
          date: reflection.date,
        });
        return out;
      }
      path = leaf;
      kind = 'gate';
      label = `config leaf '${leaf}'`;
    }
    const baseline = getNumberAtPath(base, path);
    if (baseline == null) return out;
    out.push({
      rule: 'R3',
      hypothesis: makeHypothesis({
        target: { kind, path },
        proposedDelta: { op: 'set', value: baseline },
        rationale: `${reflection.narrative} R3 fallback: re-validate ${label} (${path}) at current ${baseline} — a no-op delta that exercises the G0 backtest on today's config.`,
        source: 'reflection',
        createdAt: now,
      }),
    });
  }

  return out;
}

export interface BuildPostmarketReviewInput {
  date: string;
  now: number;
  regime: ReviewRegimeLabel;
  rows: OptionTradeJournalRecord[];
  plan: AnalystPlan | null;
  baseConfig: ConfigSnapshot;
  tunables: AnalystTunable[];
}

/**
 * Build the post-market review (pure — no pipeline IO): fold the reflection and
 * derive the hypotheses to emit. The caller (runPostmarketReview) persists the
 * review and runs each hypothesis through the pipeline.
 */
export function buildPostmarketReview(input: BuildPostmarketReviewInput): {
  review: AnalystReview;
  emitted: EmittedHypothesis[];
} {
  const reflection = buildReflection(input.date, input.regime, input.rows, input.plan);
  const emitted = deriveHypotheses(reflection, input.tunables, input.baseConfig, input.now);

  const review: AnalystReview = {
    date: input.date,
    generatedAt: input.now,
    reflection,
    hypotheses: emitted.map((e) => ({
      id: e.hypothesis.id,
      path: e.hypothesis.target.path,
      op: e.hypothesis.proposedDelta.op,
      value: e.hypothesis.proposedDelta.value,
      rule: e.rule,
    })),
  };

  return { review, emitted };
}

// ── Persistence + state ──────────────────────────────────────────────────────

let dataDirOverride: string | null = null;
/** Test seam — point persisted artifacts at a temp dir. Pass `null` to restore default. */
export function setAnalystDataDirForTests(dir: string | null): void {
  dataDirOverride = dir;
}
// TRA-2604 — this copy did not merely mis-handle a blank DATA_DIR, it could not run
// its own fallback at all. `__dirname` was never declared in this module, and this
// package is ESM (`"type": "module"`), so `join(__dirname, ...)` throws
// `ReferenceError: __dirname is not defined`. It typechecked because @types/node
// declares `__dirname` globally for CJS consumers. The branch is only reached when
// BOTH the test override is null AND DATA_DIR is nullish, which is why no suite and
// no deploy ever hit it — bqb1 always has DATA_DIR set. `resolveDataDir()` supplies a
// real anchor, so the fallback now works instead of throwing.
function dataDir(): string {
  return dataDirOverride ?? resolveDataDir();
}
function planPath(date: string): string {
  return join(dataDir(), `analyst-plan-${date}.json`);
}
function reviewPath(date: string): string {
  return join(dataDir(), `analyst-review-${date}.json`);
}
function statePath(): string {
  return join(dataDir(), 'analyst-state.json');
}

async function ensureDir(): Promise<void> {
  const dir = dataDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

interface AnalystState {
  lastPlanDate: string | null;
  watchlistCount: number;
  lastReviewDate: string | null;
  /** Hypotheses queued on `date` — reset when a new day's review runs. */
  hypotheses: { date: string; count: number } | null;
}

async function readState(): Promise<AnalystState> {
  const path = statePath();
  if (!existsSync(path)) {
    return { lastPlanDate: null, watchlistCount: 0, lastReviewDate: null, hypotheses: null };
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<AnalystState>;
    return {
      lastPlanDate: parsed.lastPlanDate ?? null,
      watchlistCount: parsed.watchlistCount ?? 0,
      lastReviewDate: parsed.lastReviewDate ?? null,
      hypotheses: parsed.hypotheses ?? null,
    };
  } catch {
    return { lastPlanDate: null, watchlistCount: 0, lastReviewDate: null, hypotheses: null };
  }
}

async function writeState(state: AnalystState): Promise<void> {
  await ensureDir();
  await writeFile(statePath(), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Persist the day's plan, idempotent per date: the FIRST write for a date wins so
 * a same-day re-run never clobbers the published plan. Returns whether it wrote.
 */
export async function persistAnalystPlan(plan: AnalystPlan): Promise<boolean> {
  await ensureDir();
  const path = planPath(plan.date);
  if (existsSync(path)) return false;
  await writeFile(path, JSON.stringify(plan, null, 2), 'utf-8');
  const state = await readState();
  state.lastPlanDate = plan.date;
  state.watchlistCount = plan.watchlist.length;
  await writeState(state);
  return true;
}

/** Persist the day's review (overwrites in place — the latest reflection wins). */
export async function persistAnalystReview(review: AnalystReview, queued: number): Promise<void> {
  await ensureDir();
  await writeFile(reviewPath(review.date), JSON.stringify(review, null, 2), 'utf-8');
  const state = await readState();
  state.lastReviewDate = review.date;
  state.hypotheses = { date: review.date, count: queued };
  await writeState(state);
}

export async function readAnalystPlan(date: string): Promise<AnalystPlan | null> {
  const path = planPath(date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as AnalystPlan;
  } catch {
    return null;
  }
}

export async function readAnalystReview(date: string): Promise<AnalystReview | null> {
  const path = reviewPath(date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as AnalystReview;
  } catch {
    return null;
  }
}

/** ET calendar date (`YYYY-MM-DD`) for an epoch-ms instant. */
export function analystEtDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Build the `/api/health/analyst` readout from persisted state. No secrets/PII. */
export async function buildAnalystHealth(nowMs: number, enabled: boolean): Promise<AnalystHealth> {
  const state = await readState();
  const today = analystEtDate(nowMs);
  const hypothesesQueuedToday =
    state.hypotheses && state.hypotheses.date === today ? state.hypotheses.count : 0;
  return {
    enabled,
    lastPlanDate: state.lastPlanDate,
    watchlistCount: state.watchlistCount,
    lastReviewDate: state.lastReviewDate,
    hypothesesQueuedToday,
  };
}

// ── Orchestration (persist + publish + enqueue) ──────────────────────────────

export interface RunPremarketDeps extends BuildPremarketPlanInput {
  /** Publish the plan to the demo loop / agent graph (default: seedReviewLeaders). */
  publish: (block: ReviewBlock) => Promise<void>;
}

/** Build → persist (idempotent) → publish the pre-market plan. */
export async function runPremarketPlan(deps: RunPremarketDeps): Promise<AnalystPlan> {
  const { plan, block } = buildPremarketPlan(deps);
  await persistAnalystPlan(plan);
  await deps.publish(block);
  log.info('analyst pre-market plan ready', {
    date: plan.date,
    symbols: plan.watchlist.length,
    regime: plan.regime,
    gapRisk: plan.gapRisk,
  });
  return plan;
}

export interface RunPostmarketDeps extends BuildPostmarketReviewInput {
  pipeline: PipelineDeps;
  /** Test seam — defaults to the real pipeline `runHypothesis`. */
  runOne?: (h: Hypothesis, deps: PipelineDeps, now: number) => Promise<unknown>;
}

/** Build → persist → enqueue every emitted hypothesis through the TRA-994 pipeline. */
export async function runPostmarketReview(
  deps: RunPostmarketDeps,
): Promise<{ review: AnalystReview; queued: number }> {
  const { review, emitted } = buildPostmarketReview(deps);
  const run = deps.runOne ?? runHypothesis;

  let queued = 0;
  for (const e of emitted) {
    try {
      await run(e.hypothesis, deps.pipeline, deps.now);
      queued++;
    } catch (err) {
      log.warn('analyst hypothesis failed to enqueue', {
        id: e.hypothesis.id,
        path: e.hypothesis.target.path,
        rule: e.rule,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await persistAnalystReview(review, queued);
  log.info('analyst post-market review ready', {
    date: review.date,
    closed: review.reflection.totalClosed,
    queued,
  });
  return { review, queued };
}
