// TRA-4752 (parent TRA-4750) — a sleeve the board has STOOD DOWN must be unable
// to reach live capital BY CONSTRUCTION, not by the absence of a caller.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-4750 ruled both option sleeves down: `single_leg_otm` stood down, and
// `directional` "stood down as routed — may not carry live capital". TRA-4752
// then asked whether that ruling is a rule the CODE enforces or only one we
// wrote down, and measured the answer off live `5d5cb869`:
//
//   • `/api/health/live-enforce-gates`, full 30-day retained window: every gate
//     with a populated `byScope` reports `single_leg_otm` (and, on two days,
//     `single_leg_rv`). `cost_bar.byEtDay` carries an explicit `directional`
//     sub-row reading `evaluated: 0` on all 21 retained days.
//   • `/api/health/rv-scan` `armByEtDay`: the `live`/`desk` cell reads
//     `disposition: live_arm_off`, `reachable: false` on **21 of 21** retained
//     days. The directional pass never entered live mode, so the live gates
//     correctly never saw it — the BENIGN reading of that zero, confirmed.
//   • `/api/health/options-live`: `liveDirectionalArmed: false` but
//     `liveTestWindowOpen: true` (`liveTestUntilIso` 2026-12-31T21:00:00Z).
//
// That last line is the defect. `isOptionLiveDirectionalArmed` is
// `ENABLE_OPTION_LIVE_DIRECTIONAL && <window open>`, and the window conjunct is
// open for the rest of the year — so the entire stand-down of the sleeve with
// live content rests on ONE unset environment variable, which an env write
// flips with no code change, no review and no alarm. Nothing anywhere keys on
// "this sleeve was ruled down": not the arm flags, not the TRA-4655 hard
// controls (`HardControlIntent` carries no sleeve at all), not the canary
// ceiling, not any of the fourteen live-enforcement gates.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// The TRA-4655 fail-closed choke-point posture applied to a SLEEVE rather than
// to an operation. The roster below is COMPILED IN and deliberately carries NO
// env override: re-opening a stood-down sleeve is a board decision (TRA-4750
// §5), so it costs a code change, a review and a deploy — which is what "by
// construction" means here. An env-lifted stand-down would re-create the exact
// one-variable hazard this module exists to close.
//
// TIGHTENING-ONLY. It can only ADD a refusal to a live `buy_to_open`; it can
// never admit, upsize or route anything the current path would not already
// admit. It is bound at the single audited live-options open seam
// (`mirrorLiveOptionOpen`) and is therefore blind to CLOSES by construction —
// standing a sleeve down must never strand an open position, and the close path
// does not pass through that seam.

/**
 * The stood-down roster: sleeve label → the ticket that ruled it down.
 *
 * Keyed on the `LiveFillSleeve` labels the open seam actually passes, and
 * `directional` is listed beside `single_leg_directional` because both spellings
 * are live members of that union (`live-options-fee-slippage-ledger.ts`) and a
 * roster that matched only the long one would be silently bypassed by a caller
 * using the short one — the TRA-3839 shape (a hand-written key list ships the
 * next value ABSENT).
 *
 * ⚠️ `single_leg_otm` is DELIBERATELY NOT HERE, and that is a scoping decision,
 * not an oversight. TRA-4750 ruled it down too, but:
 *
 *   • its live arm is currently ON (`/api/health/options-live` reads
 *     `liveOtmArmed: true`, `liveOtmRouting: true` on `5d5cb869`), so listing it
 *     changes the behaviour of an ARMED live sleeve — an operational act that
 *     belongs with whoever owns that arm, not with this ticket;
 *   • nine live-enforcement gates (`entry_window`, `contract_floor`,
 *     `setup_confirmation`, `universe`, `underlying_asset_class`,
 *     `otm_delta_floor`, `aggregate_cap`, `fleet_reachable_bound`,
 *     `exit_actionability`) sit UPSTREAM of this seam on the OTM path. A blanket
 *     refusal here would leave all nine evaluating into a decision that can no
 *     longer matter — the vacuous-instrument shape this whole file exists to
 *     close, re-committed one layer down.
 *
 * Operationalising the OTM half of TRA-4750 is a separate change; disarming
 * `ENABLE_OPTION_LIVE_OTM` is the direct remedy and does not need this roster.
 *
 * `single_leg_rv` is not here either — TRA-4750 said nothing about the
 * (compile-time-OFF since TRA-1207) RV engine. Both omissions are load-bearing
 * for a second reason: a gate that refuses everything has no discriminating
 * power, and the ADMITS are what supply the denominator separating "the roster
 * is enforcing" from "the roster is inert".
 */
export const STOOD_DOWN_SLEEVES: Readonly<Record<string, string>> = Object.freeze({
  single_leg_directional: 'TRA-4750',
  directional: 'TRA-4750',
});

/** Low-cardinality classification of a refusal — the `reasonCode` ledger axis. */
export type SleeveStandDownReasonCode = 'sleeve_stood_down' | 'sleeve_unattributable';

export interface SleeveStandDownVerdict {
  /** FALSE ⇒ the live open must be refused and rolled back. */
  allowed: boolean;
  /** The sleeve label this verdict was decided under; `unattributed` when absent. */
  scope: string;
  /** Present only on a refusal. */
  reasonCode?: SleeveStandDownReasonCode;
  /** Present only on a refusal. */
  reason?: string;
  /** The ticket that stood this sleeve down; present only on `sleeve_stood_down`. */
  ruling?: string;
}

/** A sleeve label that names no sleeve — cannot be proven to be off the roster. */
function isUnattributable(sleeve: string | null | undefined): boolean {
  return typeof sleeve !== 'string' || sleeve.trim() === '' || sleeve.trim() === 'unattributed';
}

/**
 * Grade one live option OPEN against the stood-down roster.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   • on the roster                → REFUSE (`sleeve_stood_down`);
 *   • a named sleeve, not on it    → ALLOW (this is the denominator);
 *   • absent / empty / `unattributed` → REFUSE (`sleeve_unattributable`).
 *
 * The third is fail-closed rather than permissive because an order whose sleeve
 * cannot be read cannot be proven to be off the roster, and "could not tell" must
 * never share an outcome with "checked and it is fine". All three PRODUCTION
 * callers of the open seam pass an explicit sleeve (RV `:12682`, OTM `:14764`,
 * directional `:16258`), so it costs nothing today — which is precisely why it
 * must be written before a fourth caller arrives without one. It is not
 * hypothetical: `hard-controls-wiring.test.ts` was calling the seam with no
 * sleeve at all, and this branch caught it.
 */
export function gradeSleeveStandDown(sleeve: string | null | undefined): SleeveStandDownVerdict {
  if (isUnattributable(sleeve)) {
    return {
      allowed: false,
      scope: 'unattributed',
      reasonCode: 'sleeve_unattributable',
      reason:
        'sleeve stand-down REFUSED (TRA-4752) — this live open carries no readable sleeve, so it '
        + 'cannot be proven to be off the stood-down roster (fail-closed)',
    };
  }
  const scope = sleeve!.trim();
  const ruling = STOOD_DOWN_SLEEVES[scope];
  if (ruling !== undefined) {
    return {
      allowed: false,
      scope,
      reasonCode: 'sleeve_stood_down',
      ruling,
      reason:
        `sleeve stand-down REFUSED (TRA-4752) — the \`${scope}\` sleeve was stood down by ${ruling} `
        + 'and may not carry live capital; re-opening it is a board decision and a code change, '
        + 'not an environment variable',
    };
  }
  return { allowed: true, scope };
}
