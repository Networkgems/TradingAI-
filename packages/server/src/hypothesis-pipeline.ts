// ── Hypothesis → backtest → gated-promotion pipeline (TRA-994) ───────────────
//
// Parent: TRA-990 (learning option desk). This is HOW the firm safely "updates
// its own strategies/signals/engines": ONE pipe that turns any proposed change
// into evidence-gated, board-ratified promotions. It is the consumer that makes
// the reflect routine (TRA-992) and external intel actionable WITHOUT ever
// auto-touching live capital.
//
// Invariants (board-ratified in the TRA-990 plan):
//   1. No autonomous path to live capital — a promotion reaches LIVE only via a
//      gate pass AND an explicit, separate board ratification. This module has
//      NO live path at all: ratification lands a change in DEMO config behind an
//      OFF-by-default flag, and that is the terminus here.
//   2. Ideas are hypotheses — nothing influences even demo sizing before it has
//      cleared the backtest G0 gate. A failing hypothesis never reaches the
//      ratification queue.
//
// Stages:
//   queued ──▶ backtested ──▶ G0-graded ──▶ (pass) ratification item ──▶
//   (board accept) demo config override behind a flag.
//
// The pure core (schema, delta application, grading, ranking) takes NO clock and
// NO I/O so it is fully deterministic and unit-testable. The file-backed queue
// mirrors option-trade-journal.ts (append-only JSONL + test seam). The backtest
// executor is INJECTED so the pipeline can be driven end-to-end deterministically
// in tests and wired to the real `@trading-app/backtest` runner in production.

import { existsSync } from 'fs';
import { readFile, appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  type BacktestGateMetrics,
  type PromotionThresholds,
} from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'hypothesis-pipeline' });
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 1. Hypothesis schema ─────────────────────────────────────────────────────

/** What a hypothesis proposes to change. One queue, many producers. */
export type HypothesisTargetKind = 'selector_param' | 'signal_weight' | 'gate' | 'sleeve';

/** Where a hypothesis came from. */
export type HypothesisSource = 'reflection' | 'external' | 'human';

/**
 * A normalized, parameterized change proposal: a single numeric param somewhere
 * in the strategy config, addressed by a dotted `path` (e.g.
 * `CONVICTION_DCA.optionMinAddDelta`). Keeping the target one tunable number
 * keeps the backtest apply step total and auditable.
 */
export interface HypothesisTarget {
  kind: HypothesisTargetKind;
  /** Dotted path into the config snapshot, e.g. `RV_GATE.minTrendConfluence`. */
  path: string;
}

/**
 * How to move the targeted param. `set` overwrites; `add` adds to the current
 * value; `mul` scales it. Resolved against the live value at apply time so the
 * same hypothesis stays meaningful even if the baseline drifts.
 */
export interface ParamDelta {
  op: 'set' | 'add' | 'mul';
  value: number;
}

export interface Hypothesis {
  /** Stable id — a content hash of (target, delta, source). Same proposal ⇒ same id. */
  id: string;
  target: HypothesisTarget;
  proposedDelta: ParamDelta;
  rationale: string;
  source: HypothesisSource;
  /** Epoch ms the hypothesis was authored (caller-supplied; no clock in core). */
  createdAt: number;
}

/** A nested config snapshot: numbers live at the leaves, addressed by dotted path. */
export type ConfigSnapshot = Record<string, unknown>;

// FNV-1a (32-bit) — a tiny, dependency-free, deterministic string hash. Used for
// the stable hypothesis id; NOT security-sensitive. Avoids Date.now()/random so
// the same proposal always hashes to the same id (idempotent producers).
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; hex, zero-padded to 8 chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derive the stable id for a hypothesis from its semantic content (target +
 * delta + source) — NOT its rationale or timestamp. Two producers proposing the
 * same change converge on the same id, so the queue dedupes naturally.
 */
export function hypothesisId(input: {
  target: HypothesisTarget;
  proposedDelta: ParamDelta;
  source: HypothesisSource;
}): string {
  const key = [
    input.target.kind,
    input.target.path,
    input.proposedDelta.op,
    input.proposedDelta.value,
    input.source,
  ].join('|');
  return `hyp-${fnv1a(key)}`;
}

/** Build a fully-formed hypothesis, stamping the content-derived stable id. */
export function makeHypothesis(input: {
  target: HypothesisTarget;
  proposedDelta: ParamDelta;
  rationale: string;
  source: HypothesisSource;
  createdAt: number;
}): Hypothesis {
  return {
    id: hypothesisId(input),
    target: input.target,
    proposedDelta: input.proposedDelta,
    rationale: input.rationale,
    source: input.source,
    createdAt: input.createdAt,
  };
}

// ── 2. Param-delta application (isolated config) ─────────────────────────────

function getAtPath(cfg: ConfigSnapshot, path: string): unknown {
  let node: unknown = cfg;
  for (const seg of path.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** Structured-clone-ish deep copy for JSON-shaped config (no Dates/functions). */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Resolve a delta against the current numeric value. */
export function resolveDelta(baseline: number, delta: ParamDelta): number {
  switch (delta.op) {
    case 'set':
      return delta.value;
    case 'add':
      return baseline + delta.value;
    case 'mul':
      return baseline * delta.value;
  }
}

export interface AppliedConfig {
  /** A deep clone of the base config with the single targeted leaf mutated. */
  config: ConfigSnapshot;
  /** The value before the delta (for the audit trail). */
  baseline: number;
  /** The value after the delta. */
  applied: number;
}

/**
 * Apply a hypothesis to an ISOLATED clone of the base config and return the new
 * config plus the before/after values. The base config is never mutated — every
 * hypothesis is backtested against a pristine baseline. Throws if the target
 * path does not resolve to a finite number (a malformed hypothesis must fail
 * loudly, never silently no-op into a "passing" backtest of the baseline).
 */
export function applyHypothesis(base: ConfigSnapshot, h: Hypothesis): AppliedConfig {
  const baseline = getAtPath(base, h.target.path);
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) {
    throw new Error(
      `hypothesis ${h.id}: target path "${h.target.path}" does not resolve to a finite number `
        + `(got ${JSON.stringify(baseline)})`,
    );
  }
  const applied = resolveDelta(baseline, h.proposedDelta);
  if (!Number.isFinite(applied)) {
    throw new Error(`hypothesis ${h.id}: delta produced a non-finite value (${applied})`);
  }

  const config = deepClone(base);
  const segs = h.target.path.split('.');
  let node = config as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    node = node[segs[i]] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]] = applied;

  return { config, baseline, applied };
}

// ── 3. Auto-backtest runner ──────────────────────────────────────────────────

/**
 * The standard backtest window + symbol universe a hypothesis is evaluated over.
 * Defaults mirror the crypto-majors 4H sweep (see `DEFAULT_4H_SYMBOLS` /
 * `DATA_START_MS` in @trading-app/backtest). Override per-run if a hypothesis
 * targets a different sleeve.
 */
export interface BacktestWindow {
  symbols: readonly string[];
  startMs: number;
  endMs: number;
}

export const DEFAULT_BACKTEST_WINDOW: BacktestWindow = {
  symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'],
  startMs: Date.UTC(2023, 4, 1), // 2023-05-01, on-disk Coinbase 4H cache start
  endMs: Date.UTC(2026, 0, 1), // exclusive upper bound; wiring caps to cache end
};

/**
 * Runs a backtest over an already-applied config + window and returns the
 * Stage-1 gate metrics. INJECTED: production wires this to the
 * `@trading-app/backtest` `BacktestRunner` (+ `computeBacktestGateMetrics`);
 * tests inject a deterministic stub so the whole pipeline is reproducible. The
 * executor MUST be pure w.r.t. its inputs — same (config, window) ⇒ same metrics.
 */
export type BacktestExecutor = (
  applied: AppliedConfig,
  window: BacktestWindow,
) => Promise<BacktestGateMetrics>;

// ── 4. G0 gate grader ────────────────────────────────────────────────────────

/**
 * The TRA-781 G0 gate thresholds. G0 is the lightweight ENTRY screen on raw
 * backtest edge — it reuses the Stage-1 `backtest` thresholds from the
 * board-ratified promotion gate (@trading-app/shared `DEFAULT_PROMOTION_THRESHOLDS`).
 *
 * G0 is deliberately NOT the full live-promotion gate: clearing G0 only earns a
 * hypothesis a place in the ratification queue (and, on accept, a DEMO flag). The
 * full TRA-540 six-guard overfitting verdict + paper Stage-2 + human sign-off
 * still stand between any change and LIVE capital — and that live path is out of
 * scope for this issue entirely.
 */
export const G0_THRESHOLDS = DEFAULT_PROMOTION_THRESHOLDS.backtest;

export interface G0Grade {
  pass: boolean;
  /** Empty when `pass`. Each entry names a threshold that was not met. */
  failedChecks: string[];
  /**
   * Rank score for ordering PASSERS: expectancy is primary (the per-trade edge),
   * Sharpe is the tiebreak. Higher is better. Meaningless for failers.
   */
  score: number;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Grade one backtest result against the G0 thresholds. Expectancy is a STRICT
 * `> minExpectancy` (a flat 0-expectancy strategy is not an edge); the rest are
 * inclusive bounds. Mirrors the comparison semantics of the Stage-1 gate.
 */
export function gradeG0(
  metrics: BacktestGateMetrics,
  thresholds: PromotionThresholds['backtest'] = G0_THRESHOLDS,
): G0Grade {
  const failedChecks: string[] = [];
  if (!(metrics.expectancy > thresholds.minExpectancy))
    failedChecks.push(`expectancy ${fmt(metrics.expectancy)}R ≤ ${fmt(thresholds.minExpectancy)}R`);
  if (metrics.sharpe < thresholds.minSharpe)
    failedChecks.push(`sharpe ${fmt(metrics.sharpe)} < ${fmt(thresholds.minSharpe)}`);
  if (metrics.profitFactor < thresholds.minProfitFactor)
    failedChecks.push(`profitFactor ${fmt(metrics.profitFactor)} < ${fmt(thresholds.minProfitFactor)}`);
  if (metrics.maxDrawdown > thresholds.maxDrawdownPct)
    failedChecks.push(
      `maxDrawdown ${fmt(metrics.maxDrawdown * 100)}% > ${fmt(thresholds.maxDrawdownPct * 100)}%`,
    );
  if (metrics.tradeCount < thresholds.minTradeCount)
    failedChecks.push(`tradeCount ${metrics.tradeCount} < ${thresholds.minTradeCount}`);

  // Score passers by expectancy primarily, Sharpe as a small tiebreak. Scaled so
  // expectancy dominates unless two candidates are expectancy-tied.
  const score = metrics.expectancy * 1000 + metrics.sharpe;
  return { pass: failedChecks.length === 0, failedChecks, score };
}

// ── 5. Promotion queue (file-backed, append-only) ────────────────────────────

export type PromotionItemStatus =
  | 'pending_ratification' // passed G0, awaiting board/CTO accept
  | 'gate_failed' // failed G0; recorded for the audit trail, not ratifiable
  | 'ratified' // board accepted → landed in demo config behind a flag
  | 'rejected'; // board declined

/**
 * A graded hypothesis sitting in the promotion queue. Carries the full evidence
 * chain — the applied baseline/value, the backtest metrics, and the G0 grade —
 * so a board reviewer can ratify from the record alone.
 */
export interface PromotionItem {
  hypothesis: Hypothesis;
  baseline: number;
  applied: number;
  metrics: BacktestGateMetrics;
  grade: G0Grade;
  status: PromotionItemStatus;
  /** Epoch ms the item was graded/queued. */
  queuedAt: number;
  /** Present once a board/CTO decision lands. */
  decidedAt?: number;
  decidedBy?: string;
  /** The demo flag that gates the change once ratified (OFF by default). */
  demoFlag?: string;
}

// Append-only JSONL line shapes (discriminated by `kind`). Mirrors the journal:
// the latest line for an id supersedes earlier ones on fold.
type QueueLine =
  | { kind: 'enqueue'; item: PromotionItem }
  | {
      kind: 'decision';
      id: string;
      status: Extract<PromotionItemStatus, 'ratified' | 'rejected'>;
      decidedAt: number;
      decidedBy: string;
      demoFlag?: string;
    };

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'hypothesis-queue.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the queue at a temp file. Pass `null` to restore default. */
export function setHypothesisQueueFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  // Read health travels with the cache — never let a prior file's verdict leak
  // onto the next load (TRA-2223).
  readHealth = CLEAN_READ;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: hypothesis id → latest item. */
let cache: Map<string, PromotionItem> | null = null;

/**
 * Why the last load ended with the queue it did (TRA-2223).
 *
 * An empty `listRatificationQueue()` is emitted by THREE different states: the
 * store was never written (nothing staged), the store read cleanly and holds no
 * pending items, or the read FAILED and we started empty. The third is a false
 * zero — `ensureLoaded` logs it and carries on — and the board-ratification
 * drain routine reads the HTTP health surface, not the logs, so without this it
 * closes a failed read as a "cheap no-op". Corrupt-line skips are the same
 * hazard in miniature: items silently vanish from an otherwise-successful read.
 */
export interface QueueReadHealth {
  /** The store was read end-to-end, or legitimately does not exist yet. */
  ok: boolean;
  /** Store file present on disk. `!storeExists && ok` ⇒ nothing ever staged. */
  storeExists: boolean;
  /** Corrupt JSONL lines skipped by the fold — items dropped from the queue. */
  skippedLines: number;
  /** Failure reason when `ok` is false. */
  error?: string;
}

const CLEAN_READ: QueueReadHealth = { ok: true, storeExists: false, skippedLines: 0 };
let readHealth: QueueReadHealth = CLEAN_READ;

/**
 * Read health of the currently-cached fold. Recomputed with the cache, so it
 * always describes the load that produced the items callers are seeing.
 */
export function hypothesisQueueReadHealth(): QueueReadHealth {
  return { ...readHealth };
}

function foldLine(map: Map<string, PromotionItem>, line: QueueLine): void {
  if (line.kind === 'enqueue') {
    // First enqueue wins; a re-enqueue of the same hypothesis is a no-op so a
    // decision already folded on top is never clobbered.
    if (!map.has(line.item.hypothesis.id)) map.set(line.item.hypothesis.id, line.item);
    return;
  }
  const existing = map.get(line.id);
  if (!existing) return; // a decision with no enqueue is ignored
  map.set(line.id, {
    ...existing,
    status: line.status,
    decidedAt: line.decidedAt,
    decidedBy: line.decidedBy,
    ...(line.demoFlag ? { demoFlag: line.demoFlag } : {}),
  });
}

async function ensureLoaded(): Promise<Map<string, PromotionItem>> {
  if (cache) return cache;
  const map = new Map<string, PromotionItem>();
  const path = storeFile();
  const storeExists = existsSync(path);
  let health: QueueReadHealth = { ok: true, storeExists, skippedLines: 0 };
  if (storeExists) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as QueueLine);
        } catch {
          // Skip a single corrupt line rather than losing the whole queue —
          // but COUNT it, so the drop is visible on the health surface instead
          // of reading as an item that was never staged (TRA-2223).
          health = { ...health, skippedLines: health.skippedLines + 1 };
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error('failed to read hypothesis queue, starting empty', { reason });
      // Starting empty is a FALSE ZERO, not an empty queue. Record it so the
      // readout can say so rather than presenting `[]` as a clean drain.
      health = { ...health, ok: false, error: reason };
    }
  }
  readHealth = health;
  cache = map;
  return cache;
}

async function appendLine(line: QueueLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf-8');
}

// ── 6. Pipeline orchestration ────────────────────────────────────────────────

export interface PipelineDeps {
  baseConfig: ConfigSnapshot;
  runBacktest: BacktestExecutor;
  window?: BacktestWindow;
  thresholds?: PromotionThresholds['backtest'];
}

/**
 * Run ONE hypothesis end-to-end: apply → backtest → grade → enqueue. The item is
 * persisted with `pending_ratification` when it clears G0, or `gate_failed`
 * (recorded for the audit trail, never ratifiable) when it does not. Idempotent
 * per hypothesis id: a re-run returns the already-queued item unchanged so the
 * same proposal can't be double-queued across ticks.
 *
 * Enforces invariant 2: a failing hypothesis is recorded but CANNOT become a
 * ratification item, so nothing that hasn't cleared the gate can influence even
 * demo config.
 */
export async function runHypothesis(
  h: Hypothesis,
  deps: PipelineDeps,
  queuedAt: number,
): Promise<PromotionItem> {
  const existing = (await ensureLoaded()).get(h.id);
  if (existing) return existing;

  const applied = applyHypothesis(deps.baseConfig, h);
  const window = deps.window ?? DEFAULT_BACKTEST_WINDOW;
  const metrics = await deps.runBacktest(applied, window);
  const grade = gradeG0(metrics, deps.thresholds);

  const item: PromotionItem = {
    hypothesis: h,
    baseline: applied.baseline,
    applied: applied.applied,
    metrics,
    grade,
    status: grade.pass ? 'pending_ratification' : 'gate_failed',
    queuedAt,
  };

  (await ensureLoaded()).set(h.id, item);
  await appendLine({ kind: 'enqueue', item });
  log.info('hypothesis graded', {
    id: h.id,
    path: h.target.path,
    pass: grade.pass,
    expectancy: metrics.expectancy,
    sharpe: metrics.sharpe,
    status: item.status,
  });
  return item;
}

/** List queue items, optionally filtered by status, ranked by G0 score desc. */
export async function listPromotionItems(filter?: {
  status?: PromotionItemStatus;
}): Promise<PromotionItem[]> {
  const all = [...(await ensureLoaded()).values()];
  const filtered = filter?.status ? all.filter(i => i.status === filter.status) : all;
  // Passers ranked by expectancy/Sharpe (G0 score); ties/non-passers fall back
  // to queue order via queuedAt.
  return filtered.sort((a, b) => b.grade.score - a.grade.score || a.queuedAt - b.queuedAt);
}

/** The ratification-ready items: passed G0, awaiting a board/CTO decision, ranked. */
export async function listRatificationQueue(): Promise<PromotionItem[]> {
  return listPromotionItems({ status: 'pending_ratification' });
}

/** Stable, namespaced demo flag for a ratified hypothesis (OFF by default). */
export function demoFlagFor(h: Hypothesis): string {
  return `ENABLE_HYP_${h.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
}

/**
 * A change that has been ratified into DEMO config behind a flag. This is the
 * terminus of the pipeline in this issue: `mode` is ALWAYS `'demo'`. Promotion to
 * LIVE is a separate, explicitly board-gated step that does not exist here
 * (invariant 1 — no autonomous path to live capital).
 */
export interface DemoConfigOverride {
  hypothesisId: string;
  target: HypothesisTarget;
  baseline: number;
  applied: number;
  mode: 'demo';
  /** Env flag that activates the override in demo; OFF by default. */
  flag: string;
  ratifiedAt: number;
  ratifiedBy: string;
}

export interface RatificationResult {
  item: PromotionItem;
  /** Present only when the decision was `accept` — the demo override that landed. */
  override?: DemoConfigOverride;
}

/**
 * Record a board/CTO ratification decision on a queued hypothesis. On `accept`
 * the change lands in DEMO config behind an OFF-by-default flag and the override
 * is returned for the demo-config layer to pick up. On `reject` the item is
 * closed out. Throws if the item is not currently `pending_ratification` (a
 * gate-failed or already-decided item cannot be ratified) — this is the code-side
 * enforcement of invariant 2.
 */
export async function ratifyHypothesis(input: {
  hypothesisId: string;
  decision: 'accept' | 'reject';
  decidedBy: string;
  decidedAt: number;
}): Promise<RatificationResult> {
  const map = await ensureLoaded();
  const item = map.get(input.hypothesisId);
  if (!item) throw new Error(`ratify: unknown hypothesis ${input.hypothesisId}`);
  if (item.status !== 'pending_ratification') {
    throw new Error(
      `ratify: hypothesis ${input.hypothesisId} is "${item.status}", not pending_ratification — `
        + `only gate-passing items awaiting a decision can be ratified`,
    );
  }

  if (input.decision === 'reject') {
    const line: QueueLine = {
      kind: 'decision',
      id: input.hypothesisId,
      status: 'rejected',
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
    };
    foldLine(map, line);
    await appendLine(line);
    return { item: map.get(input.hypothesisId)! };
  }

  const flag = demoFlagFor(item.hypothesis);
  const line: QueueLine = {
    kind: 'decision',
    id: input.hypothesisId,
    status: 'ratified',
    decidedAt: input.decidedAt,
    decidedBy: input.decidedBy,
    demoFlag: flag,
  };
  foldLine(map, line);
  await appendLine(line);
  const override: DemoConfigOverride = {
    hypothesisId: item.hypothesis.id,
    target: item.hypothesis.target,
    baseline: item.baseline,
    applied: item.applied,
    mode: 'demo',
    flag,
    ratifiedAt: input.decidedAt,
    ratifiedBy: input.decidedBy,
  };
  log.info('hypothesis ratified into demo config (behind flag, OFF by default)', {
    id: item.hypothesis.id,
    flag,
    path: item.hypothesis.target.path,
    baseline: item.baseline,
    applied: item.applied,
  });
  return { item: map.get(input.hypothesisId)!, override };
}

/**
 * The set of ratified demo overrides. The demo-config layer consults these and
 * applies an override ONLY when its flag is set in the environment — so a
 * ratified change is staged but inert until a human flips its flag in demo.
 */
export async function listDemoOverrides(env: NodeJS.ProcessEnv = process.env): Promise<{
  ratified: DemoConfigOverride[];
  active: DemoConfigOverride[];
}> {
  const ratified = [...(await ensureLoaded()).values()]
    .filter(i => i.status === 'ratified' && i.demoFlag)
    .map<DemoConfigOverride>(i => ({
      hypothesisId: i.hypothesis.id,
      target: i.hypothesis.target,
      baseline: i.baseline,
      applied: i.applied,
      mode: 'demo',
      flag: i.demoFlag!,
      ratifiedAt: i.decidedAt ?? i.queuedAt,
      ratifiedBy: i.decidedBy ?? 'unknown',
    }));
  const active = ratified.filter(o => {
    const v = env[o.flag];
    return v === '1' || v === 'true' || v === 'TRUE';
  });
  return { ratified, active };
}

/** Eagerly load the queue so reads have data right after boot. */
export async function initHypothesisQueue(): Promise<void> {
  await ensureLoaded();
}
