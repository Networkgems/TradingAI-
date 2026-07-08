import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type {
  AccumulationBacktestGateMetrics,
  BacktestGateMetrics,
  BacktestGateVerdict,
  PaperGateMetrics,
  PromotionDecision,
  PromotionThresholds,
  PromotionTradeSample,
} from '@trading-app/shared';
import { DEFAULT_PROMOTION_THRESHOLDS, computePaperGateMetrics, promotionStrategyClass } from '@trading-app/shared';
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
  /**
   * Close-based Stage-1 metrics picked from a computed backtest report. `null`
   * for an `accumulate`-class registration (TRA-1465), which has no per-trade
   * timing metrics and carries `accumulationBacktest` instead.
   */
  metrics: BacktestGateMetrics | null;
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
  /**
   * TRA-1465 — the accumulate-class Stage-1 verdict: accumulation-robustness
   * metrics computed by the TRA-695 harness on an OOS window. Present ONLY for an
   * `accumulate`-class registration (mutually exclusive with the close-based
   * `metrics`/`verdict` above); it is the authoritative Stage-1 source for a DCA
   * strategy. A six-guard timing verdict can never be stored here and vice-versa
   * (enforced by {@link registerAccumulationBacktestVerdict} /
   * {@link registerOptimizationVerdict} class guards).
   */
  accumulationBacktest?: AccumulationBacktestGateMetrics;
}

/**
 * TRA-913 (TRA-908 Phase C) — one monitored PAPER accrual for the advisory ->
 * capital bridge. The Phase-C bridge opens vetted, gate-passed ideas in the
 * PAPER options book and records the accrual here so the shadow -> paper -> live
 * promotion pipeline has a Stage-2 source for OPTIONS strategies (the
 * crypto/stocks Stage-2 path recomputes from the trade ledger; options had no
 * ledger source until now). Anti-gaming holds: the accrual is the real paper
 * trade (its capital-at-risk + realized P&L), not a hand-entered headline
 * metric, and `pnl` is filled only when the paper position actually closes via
 * {@link settlePaperAccrual}. Open accruals (no realized `pnl`) contribute to
 * neither the gate trade count nor the metrics.
 */
export interface PaperAccrualEntry {
  /** Stable id (the opened paper position id, so a close can settle it). */
  id: string;
  /** Epoch ms the paper position was opened. */
  openedAtMs: number;
  /** Defined-risk capital-at-risk for the structure, USD (the R denominator). */
  entryRiskUsd: number;
  /** Realized net P&L once the paper position closes; undefined while open. */
  pnl?: number;
  /** Epoch ms the paper position closed; undefined while open. */
  closedAtMs?: number;
  /** Per-trade realized slippage cost (USD), if instrumented. */
  realizedSlippage?: number;
  /** Per-trade modeled slippage cost (USD), if instrumented. */
  modeledSlippage?: number;
  /** Free-form ASCII note (e.g. the structure kind / bridge rationale). */
  note?: string;
}

export interface StrategyPromotionRecord {
  strategyId: string;
  backtest: RegisteredBacktest | null;
  /** Append-only audit trail; the latest entry is the active sign-off. */
  decisions: PromotionDecision[];
  /** Per-strategy loosen-only threshold overrides (recorded with a rationale). */
  thresholdOverrides?: Partial<PromotionThresholds>;
  /** TRA-913 — append-only monitored PAPER accruals (Phase C options bridge). */
  paperAccruals?: PaperAccrualEntry[];
}

/** Map a stored accrual to the gate's per-trade sample. R = pnl / entryRiskUsd. */
function accrualToSample(a: PaperAccrualEntry): PromotionTradeSample {
  return {
    pnl: a.pnl,
    // entryPrice - stopLoss = entryRiskUsd, quantity = 1 → risk amount = entryRiskUsd,
    // so R = pnl / entryRiskUsd (the same R-multiple basis the Phase-A harness uses).
    entryPrice: a.entryRiskUsd,
    stopLoss: 0,
    quantity: 1,
    openedAt: a.openedAtMs,
    closedAt: a.closedAtMs,
    realizedSlippage: a.realizedSlippage,
    modeledSlippage: a.modeledSlippage,
  };
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

/**
 * TRA-801 — ensure a strategy has a (possibly empty) promotion record so it
 * surfaces on the `GET /api/promotion/status` overview list, which only iterates
 * `listStrategyRecords()`. Creating a blank record registers NOTHING that could
 * advance the gate: `backtest` stays null (Stage 1 `missing`) and `decisions`
 * stays empty (sign-off `absent`), so `evaluatePromotion` still returns
 * `canGoLive=false`. This is how the SupertrendConfluence Stage-2 paper accrual
 * becomes visible on the overview while its real-chain backtest (TRA-382) and
 * Stage-3 sign-off are still outstanding. Idempotent — never clobbers an
 * existing record's backtest / decisions / overrides.
 */
export async function ensureStrategyRegistered(strategyId: string): Promise<StrategyPromotionRecord> {
  if (!strategyId) throw new PromotionValidationError('strategyId is required');
  const store = await ensureLoaded();
  const existing = store.strategies[strategyId];
  if (existing) return existing;
  const rec = blankRecord(strategyId);
  store.strategies[strategyId] = rec;
  await persist();
  log.info('ensured blank promotion record', { strategyId });
  return rec;
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
  // TRA-1465 — a close-based backtest report can never clear an accumulate
  // Stage 1 (the six-guard timing battery is meaningless on hold-mode DCA).
  if (promotionStrategyClass(args.strategyId) === 'accumulate') {
    throw new PromotionValidationError(
      `strategy "${args.strategyId}" is accumulate-class — register its Stage-1 leg via `
        + `POST /api/promotion/accumulation-backtest, not a close-based backtest report`,
    );
  }
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
  // TRA-1465 — the TRA-540 six-guard timing verdict can never clear an
  // accumulate Stage 1 (DCA has no per-trade timing edge to certify).
  if (promotionStrategyClass(args.strategyId) === 'accumulate') {
    throw new PromotionValidationError(
      `strategy "${args.strategyId}" is accumulate-class — its Stage-1 leg is an accumulation-backtest `
        + `verdict (POST /api/promotion/accumulation-backtest), not a six-guard timing verdict`,
    );
  }
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

/** The nine numeric fields of an accumulation-backtest verdict, ingested 1:1. */
const ACCUMULATION_BACKTEST_FIELDS: ReadonlyArray<keyof AccumulationBacktestGateMetrics> = [
  'oosDays',
  'deploymentRatio',
  'valueInvestedMaxDrawdown',
  'lumpSumMaxDrawdown',
  'oosReturn',
  'lumpSumReturn',
  'cadenceVariantsTested',
  'cadenceVariantsConsistent',
  'feeAdjustedValueRatio',
];

/**
 * TRA-1465 — register the accumulate-class Stage-1 leg from a TRA-695
 * accumulation-backtest verdict. The `metrics` are the OOS accumulation-
 * robustness figures the harness computed (deployment ratio, value/invested and
 * lump-sum drawdowns/returns, cadence consistency, fee-adjusted value ratio);
 * they are ingested 1:1 and then GATE the leg via
 * `evaluateAccumulationBacktestGate` (the gate re-derives pass from the metrics
 * vs the thresholds — a hand-entered `pass` with degenerate metrics still fails,
 * the same anti-gaming stance as the close-based leg). Stored on
 * `RegisteredBacktest.accumulationBacktest` with the close-based `metrics` left
 * null. Rejects a `close`-class strategy so a timing strategy can never be
 * cleared on the accumulation leg (the mirror of the accumulate guards on the
 * close-based registration paths).
 */
export async function registerAccumulationBacktestVerdict(args: {
  strategyId: string;
  metrics: AccumulationBacktestGateMetrics;
  reportId: string;
  registeredBy: string;
}): Promise<StrategyPromotionRecord> {
  if (!args.strategyId) throw new PromotionValidationError('strategyId is required');
  if (promotionStrategyClass(args.strategyId) !== 'accumulate') {
    throw new PromotionValidationError(
      `strategy "${args.strategyId}" is close-based — its Stage-1 leg is a six-guard timing verdict `
        + `(POST /api/promotion/optimization), not an accumulation-backtest verdict`,
    );
  }
  const m = args.metrics;
  if (!m || typeof m !== 'object') {
    throw new PromotionValidationError('accumulation-backtest verdict missing `metrics`');
  }
  for (const f of ACCUMULATION_BACKTEST_FIELDS) {
    const val = (m as unknown as Record<string, unknown>)[f];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new PromotionValidationError(`accumulation-backtest metrics missing numeric field: ${String(f)}`);
    }
  }
  // Ingest exactly the certified fields — never trust extra keys off the wire.
  const metrics: AccumulationBacktestGateMetrics = {
    oosDays: m.oosDays,
    deploymentRatio: m.deploymentRatio,
    valueInvestedMaxDrawdown: m.valueInvestedMaxDrawdown,
    lumpSumMaxDrawdown: m.lumpSumMaxDrawdown,
    oosReturn: m.oosReturn,
    lumpSumReturn: m.lumpSumReturn,
    cadenceVariantsTested: m.cadenceVariantsTested,
    cadenceVariantsConsistent: m.cadenceVariantsConsistent,
    feeAdjustedValueRatio: m.feeAdjustedValueRatio,
  };
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId] ?? blankRecord(args.strategyId);
  rec.backtest = {
    metrics: null, // accumulate class has no close-based timing metrics
    reportId: args.reportId || 'unspecified',
    registeredAt: new Date().toISOString(),
    registeredBy: args.registeredBy,
    accumulationBacktest: metrics,
  };
  store.strategies[args.strategyId] = rec;
  await persist();
  log.info('registered accumulation-backtest verdict', { strategyId: args.strategyId, reportId: args.reportId });
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
    // TRA-1461 — merge the accumulate-class Stage-2 thresholds too.
    accumulation: { ...base.accumulation, ...(override.accumulation ?? {}) },
    // TRA-1465 — …and the accumulate-class Stage-1 thresholds.
    accumulationBacktest: { ...base.accumulationBacktest, ...(override.accumulationBacktest ?? {}) },
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

/**
 * TRA-913 — record a monitored PAPER accrual for a strategy (Phase C bridge).
 * Called when a vetted, gate-passed idea is OPENED in the paper book; `pnl` is
 * left undefined until the position closes (see {@link settlePaperAccrual}).
 * Idempotent on `id`: re-recording the same opened position updates the open
 * accrual in place rather than duplicating it, so a retry can't inflate the
 * Stage-2 trade count. Creates a blank promotion record if the strategy has
 * none yet (so the accrual surfaces on the promotion overview).
 */
export async function recordPaperAccrual(args: {
  strategyId: string;
  id: string;
  openedAtMs: number;
  entryRiskUsd: number;
  note?: string;
}): Promise<PaperAccrualEntry> {
  if (!args.strategyId) throw new PromotionValidationError('strategyId is required');
  if (!args.id) throw new PromotionValidationError('accrual id is required');
  if (!Number.isFinite(args.entryRiskUsd) || args.entryRiskUsd <= 0) {
    throw new PromotionValidationError('entryRiskUsd must be a positive number');
  }
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId] ?? blankRecord(args.strategyId);
  rec.paperAccruals = rec.paperAccruals ?? [];
  const entry: PaperAccrualEntry = {
    id: args.id,
    openedAtMs: args.openedAtMs,
    entryRiskUsd: args.entryRiskUsd,
    ...(args.note ? { note: args.note } : {}),
  };
  const idx = rec.paperAccruals.findIndex((a) => a.id === args.id);
  if (idx >= 0) {
    // Preserve any already-settled realized fields on a re-open record.
    rec.paperAccruals[idx] = { ...entry, ...pickSettled(rec.paperAccruals[idx]!) };
  } else {
    rec.paperAccruals.push(entry);
  }
  store.strategies[args.strategyId] = rec;
  await persist();
  log.info('recorded paper accrual', { strategyId: args.strategyId, id: args.id });
  return rec.paperAccruals[idx >= 0 ? idx : rec.paperAccruals.length - 1]!;
}

function pickSettled(a: PaperAccrualEntry): Partial<PaperAccrualEntry> {
  const out: Partial<PaperAccrualEntry> = {};
  if (a.pnl !== undefined) out.pnl = a.pnl;
  if (a.closedAtMs !== undefined) out.closedAtMs = a.closedAtMs;
  if (a.realizedSlippage !== undefined) out.realizedSlippage = a.realizedSlippage;
  if (a.modeledSlippage !== undefined) out.modeledSlippage = a.modeledSlippage;
  return out;
}

/**
 * TRA-913 — settle a previously-recorded paper accrual with its realized P&L
 * when the paper position closes. Fills `pnl`/`closedAtMs` (and optional
 * slippage) so the accrual now contributes to the Stage-2 paper metrics.
 * Returns the updated entry, or null if no open accrual with that id exists.
 */
export async function settlePaperAccrual(args: {
  strategyId: string;
  id: string;
  pnl: number;
  closedAtMs: number;
  realizedSlippage?: number;
  modeledSlippage?: number;
}): Promise<PaperAccrualEntry | null> {
  if (!Number.isFinite(args.pnl)) throw new PromotionValidationError('pnl must be a finite number');
  const store = await ensureLoaded();
  const rec = store.strategies[args.strategyId];
  const entry = rec?.paperAccruals?.find((a) => a.id === args.id);
  if (!rec || !entry) return null;
  entry.pnl = args.pnl;
  entry.closedAtMs = args.closedAtMs;
  if (args.realizedSlippage !== undefined) entry.realizedSlippage = args.realizedSlippage;
  if (args.modeledSlippage !== undefined) entry.modeledSlippage = args.modeledSlippage;
  await persist();
  log.info('settled paper accrual', { strategyId: args.strategyId, id: args.id, pnl: args.pnl });
  return entry;
}

/**
 * TRA-913 — Stage-2 paper metrics for an OPTIONS strategy, computed from the
 * recorded paper accruals (Phase C). Returns null when no accrual has realized
 * P&L yet (mirrors the crypto/stocks "no monitored paper trades" → `missing`
 * Stage-2). Open (unsettled) accruals are carried by `computePaperGateMetrics`
 * but excluded from the count/metrics until they close.
 */
export async function getStrategyPaperMetrics(strategyId: string): Promise<PaperGateMetrics | null> {
  const rec = await getStrategyRecord(strategyId);
  const accruals = rec?.paperAccruals ?? [];
  const realized = accruals.filter((a) => typeof a.pnl === 'number' && Number.isFinite(a.pnl));
  if (realized.length === 0) return null;
  return computePaperGateMetrics(accruals.map(accrualToSample));
}

/** TRA-913 — read a strategy's recorded paper accruals (introspection / tests). */
export async function getPaperAccruals(strategyId: string): Promise<PaperAccrualEntry[]> {
  const rec = await getStrategyRecord(strategyId);
  return rec?.paperAccruals ? [...rec.paperAccruals] : [];
}

/** Test-only helper: reset in-memory cache and (optionally) override the on-disk path. */
export function __resetPromotionStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
