// TRA-819 (TRA-814 workstream D) — the stock-strategy LIVE-ENTRY capital-gate
// manifest.
//
// Codifies the discipline from `docs/strategy-turnaround-TRA-814.md` §4C: no
// stock strategy may open a real (live OR demo) position until it is registered
// here as having PASSED the fixed out-of-sample keeper gate — pooled OOS
// bootstrap p5 final-equity > 1.0 AND pooled OOS expectancy > 0 on the full
// universe with the *fixed* fee-aware harness (TRA-818), PLUS a walk-forward
// across >=2 regime cycles.
//
// This is a machine-checkable ALLOW-LIST, not a knob to flip a strategy on by
// hand. An entry belongs here ONLY when TRA-817's capital gate emits a passing
// run; the router (`signal-engine.ts`) consults `isLiveEntryGatePassed()`
// before any entry path opens a position. Until TRA-817 lands its gate and a
// strategy clears it, this list stays empty and every stock strategy is
// display-only.
//
// As of TRA-819, NO stock strategy has cleared a real OOS gate:
//   - `sma200_pullback`: TRA-455 verdict was a flat FAIL ("live trading stays
//     disabled", "do not wire an entry path"; PF 1.18 < 1.3 gate, MAR 0.09 vs
//     SPY 0.41). TRA-458 then re-swept ~11 param configs on a SINGLE
//     2022-01-01..2026-05-18 window and shipped the 1-2 that crossed the gate —
//     params tuned and graded on the same data, with NO out-of-sample /
//     walk-forward split. Neighboring configs flip pass/fail (cfg5 PF 1.94 pass,
//     cfg6 PF 1.56 fail), a classic overfitting signature. NOT gate-passed.
//   - `sma200_reclaim`: failed validation (n=2-17). Display-only.

export interface PassedLiveEntry {
  /** Strategy id, matching the signal `type` the router emits (e.g. `sma200_pullback`). */
  strategyId: string;
  /** The TRA-817 gate run id that produced the passing verdict — the audit trail. */
  passedGateRunId: string;
  /** ISO date (YYYY-MM-DD) the gate passed. */
  passedAt: string;
}

/**
 * The allow-list of stock strategies that have cleared the TRA-817 OOS capital
 * gate and may therefore open real positions.
 *
 * INTENTIONALLY EMPTY. A strategy is added here ONLY by TRA-817's gate emitting
 * a passing run — never by hand to "turn a strategy on". As long as it is empty,
 * every stock strategy stays display-only.
 */
export const PASSED_LIVE_ENTRIES: readonly PassedLiveEntry[] = [
  // (none — no stock strategy has passed the OOS / walk-forward gate yet)
];

/**
 * True iff `strategyId` is registered in the capital-gate manifest as having
 * passed the TRA-817 OOS gate — i.e. it is permitted to open real positions.
 *
 * Pure and side-effect-free so it is safe on the hot entry path and trivially
 * unit-testable. Returns `false` for every unknown or unregistered strategy:
 * the gate is closed by default, opened only by an explicit passing entry.
 */
export function isLiveEntryGatePassed(strategyId: string): boolean {
  return PASSED_LIVE_ENTRIES.some((e) => e.strategyId === strategyId);
}
