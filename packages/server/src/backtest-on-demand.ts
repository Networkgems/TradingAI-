// TRA-1046 (TRA-1041c L2) — synchronous, on-demand hypothesis backtest.
//
// Before this, a hypothesis could only be backtested by the analyst's EOD reflect
// routine (TRA-994/997) — overnight latency before a proposed param change had any
// graded evidence. This module exposes the SAME apply→backtest→G0-grade core as a
// blocking call so a param can be validated on demand (the `POST /api/backtest`
// handler), returning a graded result in one round-trip.
//
// It deliberately REUSES the audited pipeline primitives (`applyHypothesis`,
// `gradeG0`, the injected `BacktestExecutor`) rather than re-deriving them, so the
// on-demand grade is identical to what the queued path would produce. Critically
// it does NOT touch the promotion queue: an on-demand run is a read-only probe, so
// it can never enqueue a ratification item or influence even demo config. The only
// path that lands a change (still behind an OFF-by-default flag) remains the
// board-ratified queue (`ratifyHypothesis`); live promotion stays gated on TRA-382.

import type { BacktestGateMetrics, PromotionThresholds } from '@trading-app/shared';
import {
  applyHypothesis,
  gradeG0,
  makeHypothesis,
  DEFAULT_BACKTEST_WINDOW,
  type BacktestExecutor,
  type BacktestWindow,
  type ConfigSnapshot,
  type G0Grade,
  type Hypothesis,
  type HypothesisSource,
  type HypothesisTarget,
  type ParamDelta,
} from './hypothesis-pipeline.js';

/** What the caller asks to validate. Mirrors a `Hypothesis` minus the derived id. */
export interface OnDemandBacktestRequest {
  target: HypothesisTarget;
  proposedDelta: ParamDelta;
  /** Free-text justification; recorded on the returned hypothesis. */
  rationale?: string;
  /** Provenance; defaults to `human` (the on-demand caller). */
  source?: HypothesisSource;
  /** Author timestamp (caller-supplied; the core stays clockless). */
  createdAt?: number;
  /** Optional date-window override (ms-epoch). Symbols come from the sleeve. */
  window?: { startMs?: number; endMs?: number };
}

export interface OnDemandBacktestResult {
  hypothesis: Hypothesis;
  baseline: number;
  applied: number;
  metrics: BacktestGateMetrics;
  grade: G0Grade;
  window: BacktestWindow;
  /** Wall-clock the backtest took, ms — surfaced so the <10s budget is visible. */
  elapsedMs: number;
}

export interface OnDemandBacktestDeps {
  baseConfig: ConfigSnapshot;
  runBacktest: BacktestExecutor;
  window?: BacktestWindow;
  thresholds?: PromotionThresholds['backtest'];
  /** Clock for the elapsed-time measurement only. Injectable for tests. */
  now?: () => number;
}

/** A malformed request (bad target path, non-finite delta) — maps to HTTP 400. */
export class OnDemandBacktestBadRequest extends Error {}

/**
 * Validate the request shape WITHOUT running anything. Returns an error string for
 * the first problem, or null when the request is well-formed. The route uses this
 * to reject junk with a 400 before spending the backtest budget.
 */
export function validateBacktestRequest(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  const target = b['target'] as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object') return 'target is required';
  if (typeof target['path'] !== 'string' || target['path'] === '') return 'target.path must be a non-empty string';
  const validKinds = ['selector_param', 'signal_weight', 'gate', 'sleeve'];
  if (!validKinds.includes(target['kind'] as string)) return `target.kind must be one of ${validKinds.join(', ')}`;
  const delta = b['proposedDelta'] as Record<string, unknown> | undefined;
  if (!delta || typeof delta !== 'object') return 'proposedDelta is required';
  if (!['set', 'add', 'mul'].includes(delta['op'] as string)) return 'proposedDelta.op must be set, add, or mul';
  if (typeof delta['value'] !== 'number' || !Number.isFinite(delta['value']))
    return 'proposedDelta.value must be a finite number';
  return null;
}

/**
 * Run ONE hypothesis synchronously: apply → backtest → grade, returning the full
 * evidence (baseline/applied/metrics/grade) without persisting anything. Throws
 * `OnDemandBacktestBadRequest` when the target path doesn't resolve to a finite
 * number in the base config (a malformed proposal, not a server fault).
 */
export async function runOnDemandBacktest(
  req: OnDemandBacktestRequest,
  deps: OnDemandBacktestDeps,
): Promise<OnDemandBacktestResult> {
  const now = deps.now ?? Date.now;
  const base = deps.window ?? DEFAULT_BACKTEST_WINDOW;
  const window: BacktestWindow = {
    symbols: base.symbols,
    startMs: req.window?.startMs ?? base.startMs,
    endMs: req.window?.endMs ?? base.endMs,
  };

  const h = makeHypothesis({
    target: req.target,
    proposedDelta: req.proposedDelta,
    rationale: req.rationale ?? 'on-demand backtest',
    source: req.source ?? 'human',
    createdAt: req.createdAt ?? now(),
  });

  let applied;
  try {
    applied = applyHypothesis(deps.baseConfig, h);
  } catch (err) {
    throw new OnDemandBacktestBadRequest(err instanceof Error ? err.message : String(err));
  }

  const startedAt = now();
  const metrics = await deps.runBacktest(applied, window);
  const elapsedMs = now() - startedAt;
  const grade = gradeG0(metrics, deps.thresholds);

  return {
    hypothesis: h,
    baseline: applied.baseline,
    applied: applied.applied,
    metrics,
    grade,
    window,
    elapsedMs,
  };
}
