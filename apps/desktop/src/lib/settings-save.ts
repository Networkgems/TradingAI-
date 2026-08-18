import type { AccountSettings } from '@trading-app/shared';

/**
 * TRA-3833 — helpers behind SettingsPage's save path, extracted so the two
 * defects that ledger event 2026-08-17T13:53:42Z exposed can be locked by unit
 * tests without mounting the 2,600-line page.
 *
 * The event: a full 61-field `PUT /api/account/settings` from the Settings form
 * carried `liveTradeEquitiesTradier:false`, attempting to demote the pinned
 * operator off the board-ratified live-equities arm. The TRA-2649 write-path
 * enforcement re-converged it (that control held and is NOT touched here), but
 * the sender had two separable defects:
 *
 *   1. The form posted its ENTIRE state on every save — fields the user never
 *      touched included. Any staleness anywhere in the form (a long-open tab, a
 *      hydration bug, a future field the form doesn't know) rides along on
 *      every save and gets written over disk. The server PUT explicitly merges
 *      partial bodies against the persisted snapshot (TRA-485), so the fix is
 *      to send only the fields that actually changed since the last load/save.
 *
 *   2. When the server clamped a sent field, `handleSave` merged the clamped
 *      value back into the form (TRA-327) and reported a plain "Saved" — the
 *      TRA-3809 lie in another skin: uncheck "Tradier Live trades equities",
 *      click Save, see "Saved", while the account keeps placing live equity
 *      orders. The response body was in hand; the claim must come from it.
 */

/** The three fields the TRA-2649 arm forces (see server `applyLiveBrokerArm`). */
export const LIVE_ARM_FIELDS = [
  'mode',
  'liveTradierEnvOptions',
  'liveTradeEquitiesTradier',
] as const satisfies readonly (keyof AccountSettings)[];

export type LiveArmField = (typeof LIVE_ARM_FIELDS)[number];

/** User-facing labels for the arm fields, matching the controls on the page. */
export const LIVE_ARM_FIELD_LABELS: Record<LiveArmField, string> = {
  mode: 'Account Mode',
  liveTradierEnvOptions: 'Options environment (Sandbox/Production)',
  liveTradeEquitiesTradier: 'Tradier Live trades equities',
};

function sameValue(a: unknown, b: unknown): boolean {
  // AccountSettings values are scalars; JSON.stringify also normalizes
  // `undefined` (omitted either side) so absent-vs-absent compares equal.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The body to PUT: only the fields that differ from the last loaded/saved
 * snapshot. An untouched field is never sent, so form-state staleness in a
 * field the user did not edit can no longer reach disk — the exact vehicle of
 * the 2026-08-17 demotion attempt (61 fields sent, one edited at most).
 *
 * `baseline === null` means we never anchored a snapshot (the form refuses to
 * render in that state — see the TRA-397 load-error gate), so fall back to the
 * legacy full-body shape rather than guessing at a diff against nothing.
 */
export function diffSettingsForSave(
  current: AccountSettings,
  baseline: AccountSettings | null,
): Partial<AccountSettings> {
  if (baseline === null) return { ...current };
  const out: Partial<AccountSettings> = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]) as Set<keyof AccountSettings>;
  for (const key of keys) {
    if (!sameValue(current[key], baseline[key])) {
      // A key present in baseline but deleted from current still serializes as
      // `undefined` here, which JSON.stringify drops from the body — the server
      // then keeps its persisted value, which is the safe reading of "deleted".
      (out as Record<string, unknown>)[key] = current[key];
    }
  }
  return out;
}

/**
 * Which of the fields we SENT came back different in the 200 response —
 * i.e. the server accepted the write but clamped/repaired those fields
 * (TRA-2649 arm re-convergence, range clamps, preset-id fallback…).
 *
 * Returns `null` when the response carried no settings object: the outcome is
 * UNOBSERVED, which is deliberately distinct from "nothing was clamped".
 * Collapsing unknown into either verdict is the TRA-3809 bug class.
 */
export function resolveClampedFields(
  sent: Partial<AccountSettings>,
  returned: AccountSettings | null | undefined,
): (keyof AccountSettings)[] | null {
  if (returned === null || returned === undefined) return null;
  const clamped: (keyof AccountSettings)[] = [];
  for (const key of Object.keys(sent) as (keyof AccountSettings)[]) {
    // A sent `undefined` never reaches the wire (JSON.stringify drops it), so
    // it cannot have been clamped — skip rather than compare it.
    if (sent[key] === undefined) continue;
    if (!sameValue(sent[key], returned[key])) clamped.push(key);
  }
  return clamped;
}

/** Split a clamped-field list into live-arm fields vs everything else. */
export function partitionArmClamps(clamped: (keyof AccountSettings)[]): {
  armClamped: LiveArmField[];
  otherClamped: (keyof AccountSettings)[];
} {
  const armClamped = LIVE_ARM_FIELDS.filter(f => clamped.includes(f));
  const otherClamped = clamped.filter(f => !(LIVE_ARM_FIELDS as readonly string[]).includes(f));
  return { armClamped, otherClamped };
}

/** True when the outgoing body touches any of the three live-arm fields. */
export function touchesLiveArmField(sent: Partial<AccountSettings>): boolean {
  return LIVE_ARM_FIELDS.some(f => f in sent && sent[f] !== undefined);
}
