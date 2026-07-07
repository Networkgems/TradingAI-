// TRA-1408 (parent TRA-1406 "less noise, more quality") — the per-name churn +
// same-day-loss brake. Two demo-book containment rules that stop the pathology
// GIS surfaced (95 closes for −$2,236 in one session while conviction-DCA kept
// ADDING to the loser):
//
//   1. Per-name same-session OPEN cap — reject a new open once a symbol hits N
//      new opens in the current ET session (start N=3, tunable). Stops the
//      re-entry churn on one name.
//   2. Same-day-loss DCA brake — halt conviction-DCA adds for any symbol that is
//      net-negative on the ET day (realized + unrealized). Stops averaging into a
//      same-day loser.
//
// A STANDALONE flag (deliberately NOT under the EXIT_RISK_RULES_ENABLED master):
// the signal-engine consults it ONLY on the DEMO branches (the equity/option
// open chokepoints and the demo conviction-DCA add loops — the live add-order
// path only shadow-logs), so the flag is structurally incapable of altering a
// live open or a live add. This mirrors the containment of OTM_DELTA_FLOOR /
// ENTRY_GREEKS_GATE / TAKE_PROFIT_EARLY. OFF by default (1/true/yes/on); the
// board flips it via demo-flags.json after QuantTrader forward-validates from the
// journal + /api/health/conviction-dca.

export const CHURN_LOSS_BRAKE_FLAG = 'ENABLE_CHURN_LOSS_BRAKE';
/** Numeric override of the per-name same-session open cap (default 3). */
export const CHURN_SAME_SESSION_OPEN_CAP_VALUE = 'CHURN_SAME_SESSION_OPEN_CAP';
export const CHURN_SAME_SESSION_OPEN_CAP_DEFAULT = 3;

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the churn + same-day-loss brake is enabled (standalone; 1/true/yes/on). */
export function isChurnLossBrakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CHURN_LOSS_BRAKE_FLAG]);
}

/**
 * Resolve the per-name same-session open cap (max NEW opens per symbol per ET
 * session). Reads the optional `CHURN_SAME_SESSION_OPEN_CAP` override, falling
 * back to {@link CHURN_SAME_SESSION_OPEN_CAP_DEFAULT}. A malformed / non-positive
 * value falls back to the default rather than silently disabling the cap; the
 * value is floored to an integer (a fractional cap is meaningless for a count).
 */
export function resolveSameSessionOpenCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHURN_SAME_SESSION_OPEN_CAP_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return CHURN_SAME_SESSION_OPEN_CAP_DEFAULT;
}
