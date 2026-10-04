// TRA-3962 (Q2, board ruling 2026-10-04, interaction `4036dfe9`) — PAGE, DO
// NOT UNWIND, on an over-cap live book.
//
// The ruling's finding: `headroomSignedUsd < 0` was never a report-only state —
// it already drives `admissibleEntryUsd` to 0 and both order gates refuse every
// positive entry (regression-pinned in the TRA-3911 suite). What an over-cap
// book did NOT do before this module is page anyone: `admin` sat at −$51.68 on
// 2026-08-21 and the only way to notice was to read the route by hand. "Cannot
// add" protects the cap; it does not summon the human the condition wants —
// and the board explicitly chose a page over an automatic unwind, because a
// forced liquidation converts a bookkeeping condition into a realized loss in
// exactly the tape where it fires hardest.
//
// WHO IT PAGES: the ops alert channel — `ALERT_EMAIL` recipients and
// `ALERT_WEBHOOK_URL`, via `dispatchAlert` (plus the `/api/health/alerts` ring
// and `alerts.jsonl` when no push channel is configured; posture readable at
// `/api/health/alerting`).
//
// This classifier is PURE and the page decision is graded as a full matrix,
// never as "any negative number pages":
//
//   • `openPremiumAtRiskUsd <= 0` — nothing live is on; a negative headroom
//     cannot arise from the shipped fold here (cap ≤ 0 reads `null`, not
//     negative), so this leg is a cheap early-out, not a verdict about caps.
//   • `headroomSignedUsd === null` — the basis is UNREADABLE, not over cap.
//     This is the TRA-3970 trap by construction: a broker all-zeros
//     maintenance envelope (or any unreadable balance) collapses
//     `availableCashUsd` to `null`, which fail-closes `capUsd` to 0, and
//     `liveOptionTestAggregateHeadroomSignedUsd` returns `null` for
//     `capUsd <= 0`. Before TRA-3970 that same artifact MANUFACTURED
//     `headroomSignedUsd: −140.38` on a book that was not over cap — an alert
//     keyed on "< 0" alone would have paged the desk on broker maintenance
//     every weekend. Unreadable must neither page nor read clean: it returns
//     its own reason so the caller can keep the suppression visible.
//   • `< 0` — page. `critical` on the production env (real money, risk on);
//     `warning` on sandbox, so a paper-env book cannot page the desk at
//     critical (the TRA-2984 severity split, for the same reason).
export type OverCapPageVerdict =
  | { action: 'page'; severity: 'critical' | 'warning'; reason: 'over_cap' }
  | { action: 'none'; reason: 'no_live_at_risk' | 'basis_unreadable' | 'within_cap' };

export function classifyOverCapPage(input: {
  /** `liveOptionTestAggregateHeadroomSignedUsd(atRisk, capUsd)` — `null` ⇒ unreadable basis, NEVER coerced to 0. */
  headroomSignedUsd: number | null;
  /** `openPremiumAtRiskForMode('live').usd` — the gating leg; must be read even when it is 0 (18★). */
  openPremiumAtRiskUsd: number;
  /** The engine's `liveTradierEnvOptions` selection — which env's money is at risk. */
  tradierEnv: 'production' | 'sandbox';
}): OverCapPageVerdict {
  if (!Number.isFinite(input.openPremiumAtRiskUsd) || input.openPremiumAtRiskUsd <= 0) {
    return { action: 'none', reason: 'no_live_at_risk' };
  }
  if (input.headroomSignedUsd === null || !Number.isFinite(input.headroomSignedUsd)) {
    return { action: 'none', reason: 'basis_unreadable' };
  }
  if (input.headroomSignedUsd >= 0) {
    return { action: 'none', reason: 'within_cap' };
  }
  return {
    action: 'page',
    severity: input.tradierEnv === 'production' ? 'critical' : 'warning',
    reason: 'over_cap',
  };
}
