// ── Backtest executor for the TRA-994 pipeline (TRA-997 / TRA-4629) ─────────
//
// Parent: TRA-994. The keystone pipeline (hypothesis-pipeline.ts) takes an
// INJECTED `BacktestExecutor` so the queued→backtested→graded→ratified flow is
// deterministic + unit-testable.
//
// TRA-4629 — the pipeline's ONLY concrete sleeve was the RV / crypto-majors
// mean-reversion book (TRA-523's surviving candidate), graded off the on-disk
// crypto-majors 4H candle cache. Both were removed with the crypto engine, so
// there is currently NO backtestable surface. The injected-executor
// architecture stays; until an equity/options sleeve is registered, a
// hypothesis backtest REFUSES loudly (fail-closed) rather than grading against
// a sleeve that no longer exists. Nothing armed reaches this in production:
// ENABLE_ANALYST_AGENT and the external-intel flag are both unset on bqb1, so
// the two remaining callers (analyst-scheduler, external-intel-scheduler) are
// dark at the flag check before any executor is built.
import {
  type AppliedConfig,
  type BacktestExecutor,
  type BacktestWindow,
  type ConfigSnapshot,
} from './hypothesis-pipeline.js';

/**
 * Empty base snapshot — there is no registered sleeve, so there are no
 * tunable leaves. Kept exported so the callers' `PipelineDeps` wiring stays
 * type-correct without inventing a phantom sleeve.
 */
export const EMPTY_BASE_CONFIG: ConfigSnapshot = {};

/**
 * Fail-closed executor: every run refuses. A hypothesis can therefore never
 * clear G0 (invariant 2 of the pipeline — nothing ungraded can influence even
 * demo config) and the refusal names why in the audit trail.
 */
export function makeBacktestExecutor(): BacktestExecutor {
  return async (_applied: AppliedConfig, _window: BacktestWindow) => {
    throw new Error(
      'no backtest sleeve registered — the RV crypto-majors sleeve was removed with the crypto engine (TRA-4629); '
      + 'register an equity/options sleeve before grading hypotheses',
    );
  };
}
