import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type {
  BacktestGateMetrics,
  BacktestGateVerdict,
  PaperGateMetrics,
  PromotionDecision,
  PromotionThresholds,
} from '@trading-app/shared';
import { DEFAULT_PROMOTION_THRESHOLDS } from '@trading-app/shared';
import type { BacktestResult, OptimizationVerdict } from '@trading-app/backtest';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'promotion-store' });

// TRA-532 — file-backed store for the Live-Trading Promotion Gate. Holds, per
// strategy, the registered Stage-1 backtest metrics, any per-strategy
// (loosen-only) threshold overrides, and the append-only Stage-3
// `promotion_decision` audit trail. Global (not per-user): a strategy's
// promotion is a property of the strategy, the same way `STRATEGY_PRESETS` are
// global. Paper (Stage-2) metrics are NOT stored here — they are recomputed
// from the live paper ledger on every read so the gate can't be gamed by
// persisting stale numbers.

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'promotion-gate.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Stage-1 registration: the metrics picked from a computed backtest report. */
export interface RegisteredBacktest {
  metrics: BacktestGateMetrics;
  /** Free-form id of the source report/run (e.g. a TRA ticket or report filename). */
  reportId: string;
  registeredAt: string;
  registeredBy: string;
  /**
   * TRA-541 — the TRA-540 optimization six-guard verdict, present only when the
   * Stage-1 metrics were ingested from an optimization report. When present it
   * is authoritative for the Stage-1 leg (passes iff `verdict.pass`), so strong
   * headline `metrics` cannot clear the gate with a failed guard battery.
   */
  verdict?: BacktestGateVerdict;
  /**
   * TRA-541 — the parameter set the verdict certified (`verdict.blessedParams`),
   * recorded so the promoted config is auditable. Free-form (strategy + label +
   * the strategy-opts overlay).
   */
  blessedParams?: Record<string, unknown>;
}

export interface StrategyPromotionRecord {
  strategyId: string;
  backtest: RegisteredBacktest | null;
  /** Append-only audit trail; the latest entry is the active sign-off. */
  decisions: PromotionDecision[];
  /** Per-strategy loosen-only threshold overrides (recorded with a rationale). */
  thresholdOverrides?: Partial<PromotionThresholds>;
}

interface StoreFile {
  version: 1;
  strategies: Record<string, StrategyPromotionRecord>;
}

let cache: StoreFile | null = null;

async function ensureLoaded(): Promise<StoreFile> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = { version: 1, strategies: {} };
    return cache;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    cache = { version: 1, strategies: parsed.strategies ?? {} };
  } catch (err) {
    log.error('failed to read promotion store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = { version: 1, strategies: {} };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  // Atomic write so a mid-write kill never leaves a truncated audit trail.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  await rename(tmp, path);
}

function blankRecord(strategyId: string): StrategyPromotionRecord {
  return { strategyId, backtest: null, decisions: [] };
}

export class PromotionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionValidationError';
  }
}

/**
 * Derive the Stage-1 gate metrics from a *computed* backtest report. Metrics
 * are picked straight off the report — never hand-entered — which is the
 * anti-gaming requirement from TRA-527 §3. `maxDrawdown` on `BacktestResult` is
 * already a fraction (peak-to-trough / peak), matching the gate's
 * `maxDrawdownPct` units.
 */
export function deriveBacktestGateMetrics(report: BacktestResult): BacktestGateMetrics {
  const required: Array<[keyof BacktestResult, unknown]> = [
    ['sharpeRatio', report.sharpeRatio],
    ['expectancy', report.expectancy],
    ['profitFactor', report.profitFactor],
    ['maxDrawdown', report.maxDrawdown],
    ['totalTrades', report.totalTrades],
  ];
  for (const [name, val] of required) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new PromotionValidationError(`backtest report missing numeric field: ${String(name)}`);
    }
  }
  return {
    sharpe: report.sharpeRatio,
    expectancy: report.expectancy,
    profitFactor: report.profitFactor,
    maxDrawdown: report.maxDrawdown,
    tradeCount: report.totalTrades,
  };
}

export async function getStrategyRecord(strategyId: string): Promise<StrategyPromotionRecord | undefined> {
  const store = await ensureLoaded();
  return store.strategies[strategyId];
}

export async function listStrategyRecords(): Promise<StrategyPromotionRecord[]> {
  const store = await ensureLoaded();
  return Object.values(store.strategies);
}

/**
 * Register (or replace) the Stage-1 backtest report for a strategy. The caller
 * passes the full computed `BacktestResult`; this picks the gate metrics off it
 * so the registered numbers always reflect a real run.
 */
export async function registerBacktestReport(args: {
  strategyId: string;
  report: BacktestResult;
  reportId: string;
  registeredBy: string;
}): Promise<StrategyPromotionRecord> {
  if (!args.strategyId) throw new PromotionValidationError('strategyId is required');
  const metrics = deriveBacktestGateMetrics(args.report);
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId] ?? blankRecord(args.strategyId);
  rec.backtest = {
    metrics,
    reportId: args.reportId || 'unspecified',
    registeredAt: new Date().toISOString(),
    registeredBy: args.registeredBy,
  };
  store.strategies[args.strategyId] = rec;
  await persist();
  log.info('registered backtest report', { strategyId: args.strategyId, reportId: args.reportId });
  return rec;
}

/**
 * TRA-541 — register the Stage-1 backtest leg from a TRA-540 optimization
 * `verdict` block (`optimization-report.json`). The verdict's `backtestMetrics`
 * are field-for-field identical to {@link BacktestGateMetrics} — `{ sharpe,
 * expectancy, profitFactor, maxDrawdown, tradeCount }` — so they are ingested
 * 1:1 with no renaming. The six-guard `pass` flag and per-guard results are
 * stored alongside; once registered, the verdict is authoritative for Stage 1
 * (a `pass === false` verdict fails the leg regardless of how strong the raw
 * metrics look — see `evaluateBacktestGate`). `blessedParams` is recorded so the
 * promoted configuration is auditable.
 */
export async function registerOptimizationVerdict(args: {
  strategyId: string;
  verdict: OptimizationVerdict;
  reportId: string;
  registeredBy: string;
}): Promise<StrategyPromotionRecord> {
  if (!args.strategyId) throw new PromotionValidationError('strategyId is required');
  const v = args.verdict;
  if (!v || typeof v.pass !== 'boolean') {
    throw new PromotionValidationError('optimization verdict missing boolean `pass` flag');
  }
  const bm = v.backtestMetrics;
  if (!bm || typeof bm !== 'object') {
    throw new PromotionValidationError('optimization verdict missing `backtestMetrics`');
  }
  // 1:1 ingest — verdict.backtestMetrics already matches BacktestGateMetrics.
  const metrics: BacktestGateMetrics = {
    sharpe: bm.sharpe,
    expectancy: bm.expectancy,
    profitFactor: bm.profitFactor,
    maxDrawdown: bm.maxDrawdown,
    tradeCount: bm.tradeCount,
  };
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId] ?? blankRecord(args.strategyId);
  rec.backtest = {
    metrics,
    reportId: args.reportId || 'unspecified',
    registeredAt: new Date().toISOString(),
    registeredBy: args.registeredBy,
    verdict: { pass: v.pass, guards: v.guards },
    blessedParams: v.blessedParams,
  };
  store.strategies[args.strategyId] = rec;
  await persist();
  log.info('registered optimization verdict', {
    strategyId: args.strategyId,
    reportId: args.reportId,
    pass: v.pass,
  });
  return rec;
}

/** Whether a strategy currently has at least one recorded sign-off. */
export async function hasSignoff(strategyId: string): Promise<boolean> {
  const rec = await getStrategyRecord(strategyId);
  return !!rec && rec.decisions.length > 0;
}

/** Effective thresholds for a strategy: v1 defaults merged with any recorded overrides. */
export async function getEffectiveThresholds(strategyId: string): Promise<PromotionThresholds> {
  const rec = await getStrategyRecord(strategyId);
  return mergeThresholds(DEFAULT_PROMOTION_THRESHOLDS, rec?.thresholdOverrides);
}

export function mergeThresholds(
  base: PromotionThresholds,
  override?: Partial<PromotionThresholds>,
): PromotionThresholds {
  if (!override) return base;
  return {
    backtest: { ...base.backtest, ...(override.backtest ?? {}) },
    paper: { ...base.paper, ...(override.paper ?? {}) },
  };
}

/**
 * Record a Stage-3 sign-off (`promotion_decision`). `paperMetrics` /
 * `backtestMetrics` are the snapshots the reviewer saw at decision time, passed
 * in by the service layer (which recomputed them from data). When
 * `thresholdOverrides` is present a `rationale` is mandatory (TRA-527: defaults
 * may only be loosened with a written rationale).
 */
export async function recordSignoff(args: {
  strategyId: string;
  reviewer: string;
  backtestMetrics: BacktestGateMetrics | null;
  paperMetrics: PaperGateMetrics | null;
  thresholdOverrides?: Partial<PromotionThresholds>;
  rationale?: string;
}): Promise<PromotionDecision> {
  if (!args.strategyId) throw new PromotionValidationError('strategyId is required');
  if (!args.reviewer) throw new PromotionValidationError('reviewer is required');
  if (args.thresholdOverrides && !args.rationale?.trim()) {
    throw new PromotionValidationError('rationale is required when threshold overrides are applied');
  }
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId] ?? blankRecord(args.strategyId);
  const decision: PromotionDecision = {
    id: randomUUID(),
    strategyId: args.strategyId,
    decidedAt: new Date().toISOString(),
    reviewer: args.reviewer,
    backtestMetrics: args.backtestMetrics,
    paperMetrics: args.paperMetrics,
    ...(args.thresholdOverrides ? { thresholdOverrides: args.thresholdOverrides } : {}),
    ...(args.rationale ? { rationale: args.rationale } : {}),
  };
  rec.decisions.push(decision);
  if (args.thresholdOverrides) rec.thresholdOverrides = mergeThresholds(
    rec.thresholdOverrides
      ? mergeThresholds(DEFAULT_PROMOTION_THRESHOLDS, rec.thresholdOverrides)
      : DEFAULT_PROMOTION_THRESHOLDS,
    args.thresholdOverrides,
  );
  store.strategies[args.strategyId] = rec;
  await persist();
  log.info('recorded promotion sign-off', {
    strategyId: args.strategyId,
    reviewer: args.reviewer,
    decisionId: decision.id,
    override: !!args.thresholdOverrides,
  });
  return decision;
}

/** Test-only helper: reset in-memory cache and (optionally) override the on-disk path. */
export function __resetPromotionStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
