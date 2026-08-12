// TRA-3394 item 1 (authorization: TRA-3392 §3) — the LIVE arm of the entry
// |delta| CEILING. The half of the band the cost bar cannot reach.
//
// `costAwareGateReject` is a FLOOR by construction, so the live admitted set is
// `[0.495, ∞)` while the ratified authorization is `[0.495, 0.55)`. The sleeve
// therefore exceeds its mandate at the top end today, in the direction of the
// second-most-negative cell on the tape (n=20, E=−1.072 R_gate). No retune of a
// bar, a `k` or a multiplier can cut a top end — only a ceiling can.
//
// The mechanism already existed and was DEMO-ONLY: `entryDeltaCeilingVerdict`
// (`exit-risk-rules-flag.ts`) is consulted behind `mode === 'demo'` and is
// structurally incapable of touching a live open. This module is the live
// containment, following the TRA-2048 / TRA-2763 pattern exactly:
//
//   • SECRET-ADJACENT — it changes what real orders do, so it is read from the
//     PROCESS env ONLY, never the demo-flags file, and is NOT on the demo-flag
//     allowlist.
//   • TIGHTENING-ONLY — it can only REMOVE a live open, never add one
//     (TRA-1897-HOLD-safe).
//   • OFF by default — merging this changes nothing. TRA-3394 explicitly forbids
//     arming it in the same beat it ships.
//   • Its OWN ledger gate + reasonCode, so a block is VISIBLE rather than
//     inferred (the treatment TRA-3216 gave the universe axis). n=20 above 0.55
//     means it will bite RARELY: `evaluated > 0, blocked = 0` is the expected
//     healthy read, and that is exactly why it needs a counter of its own — an
//     armed-but-inert gate and an armed-and-passing gate are indistinguishable
//     without one (TRA-1407 / TRA-1486 were both "shipped, believed armed,
//     silently inert").
//
// ── The number is NOT an operator's to choose ────────────────────────────────
//
// The ceiling comes from {@link mandateCeilingFor} — the ratified table — not
// from a default constant here. `OPTION_ENTRY_DELTA_CEILING_LIVE` may only
// TIGHTEN it: a value ABOVE the mandate ceiling would admit a band the CTO did
// not authorize, so it is REFUSED (with the raw value echoed on the health read)
// and the mandate number stands. That asymmetry is the point — a typo that
// tightens costs trades, a typo that loosens costs the mandate.
//
// ── Why a separate module and not `exit-risk-rules-flag.ts` ──────────────────
//
// The demo ceiling reads the demo-flags env and takes its number and its
// structure list from operator config. This one reads the process env and takes
// its number from a ratified document. Sharing a resolver would put one env
// parse between the mandate and real money, and the whole reason this ticket
// exists is that a bar-side retune could silently reach an authorization.
//
// PURE w.r.t. the env passed in — no I/O, no clock.

import {
  mandateBandFor,
  mandateCeilingFor,
  OTM_SLEEVE_MANDATE_ISSUE,
} from './otm-sleeve-mandate.js';

/** Local, matching every other flag module in the tree (accepts 1/true/yes/on). */
function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** ENFORCE: a breach BLOCKS the live open. Off by default. */
export const OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG = 'ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE';
/**
 * SHADOW: record the verdict on its own ledger gate and ADMIT anyway. This is the
 * pre-arm read TRA-3394 asks for ("land it dark, show me the recorded verdicts on
 * a demo/shadow read, and I will authorize the live arm"). Ignored when the
 * enforce flag is on — you cannot shadow a gate that is already biting.
 */
export const OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG =
  'ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE';
/** Optional TIGHTENING-ONLY override of the mandate ceiling. */
export const OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR = 'OPTION_ENTRY_DELTA_CEILING_LIVE';

/** The ledger gate an ENFORCING verdict is recorded under. */
export const ENTRY_DELTA_CEILING_GATE = 'entry_delta_ceiling';
/** The ledger gate a SHADOW verdict is recorded under. Never blocked an order. */
export const ENTRY_DELTA_CEILING_SHADOW_GATE = 'entry_delta_ceiling_shadow';
/** The single, bounded block classification this gate emits. */
export const ENTRY_DELTA_CEILING_REASON_CODE = 'above_mandate_ceiling';

/** True iff a breach of the live entry-delta ceiling BLOCKS a real option open. */
export function isEntryDeltaCeilingLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG]);
}

/** True iff breaches are RECORDED but admitted (shadow). Enforce wins if both are set. */
export function isEntryDeltaCeilingLiveObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG]);
}

/** What the ceiling is doing for a structure right now. */
export type EntryDeltaCeilingLiveMode = 'off' | 'observe' | 'enforce';

/**
 * How the env resolved the live ceiling for one structure. `mandateCeiling ===
 * null` ⇒ the structure has no ratified authorization and is UNCAPPED; the mode
 * is then `off` regardless of the flags, because there is no authorized upper
 * edge to enforce. An unmandated sleeve stays uncapped rather than inheriting an
 * extrapolated number — the TRA-1689 rule.
 */
export interface EntryDeltaCeilingLiveResolution {
  mode: EntryDeltaCeilingLiveMode;
  /** The ceiling actually in force (mandate, or a tighter operator value). */
  ceiling: number | null;
  /** The ratified number, before any operator tightening. */
  mandateCeiling: number | null;
  /** The raw env value, echoed so a REFUSED typo is visible on the health read. */
  rawOverride: string | null;
  /** Set when `rawOverride` was refused, with why. */
  overrideRejectedReason: string | null;
}

/**
 * Resolve the live ceiling for one structure.
 *
 * An override is accepted only if it is a finite (0,1) magnitude AND is at or
 * below the mandate ceiling. Anything else is refused with a stated reason and
 * the mandate number stands — an armed ceiling never silently widens.
 */
export function resolveEntryDeltaCeilingLive(
  structure: string,
  env: NodeJS.ProcessEnv = process.env,
): EntryDeltaCeilingLiveResolution {
  const mandateCeiling = mandateCeilingFor(structure);
  const raw = env[OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR];
  const rawOverride = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

  if (mandateCeiling === null) {
    return { mode: 'off', ceiling: null, mandateCeiling: null, rawOverride, overrideRejectedReason: null };
  }

  const armed = isEntryDeltaCeilingLiveEnforceEnabled(env);
  const mode: EntryDeltaCeilingLiveMode = armed
    ? 'enforce'
    : isEntryDeltaCeilingLiveObserveEnabled(env)
      ? 'observe'
      : 'off';

  let ceiling = mandateCeiling;
  let overrideRejectedReason: string | null = null;
  if (rawOverride !== null) {
    const parsed = Number(rawOverride);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      overrideRejectedReason =
        `malformed |delta| magnitude "${rawOverride}" (must be finite and in (0,1)) `
        + `— mandate ceiling ${mandateCeiling} stands`;
    } else if (parsed > mandateCeiling) {
      overrideRejectedReason =
        `${parsed} is ABOVE the ${OTM_SLEEVE_MANDATE_ISSUE} ceiling ${mandateCeiling} for ${structure}; `
        + 'this override is tightening-only and may not widen a ratified authorization '
        + '— mandate ceiling stands';
    } else {
      ceiling = parsed;
    }
  }

  return { mode, ceiling, mandateCeiling, rawOverride, overrideRejectedReason };
}

/** The live ceiling's verdict on one candidate. */
export interface EntryDeltaCeilingLiveVerdict extends EntryDeltaCeilingLiveResolution {
  /** True iff |delta| reached or exceeded the ceiling in force. */
  breached: boolean;
  /** True iff the breach actually STOPPED the open (`mode === 'enforce'`). */
  blocked: boolean;
  /** The |delta| measured, or null when the candidate carried none. */
  absDelta: number | null;
  /**
   * The mandate band the candidate sits in — stamped on the ledger's `cell` axis
   * (admits included) so the pre-arm read is a per-band evaluated/blocked table
   * rather than a single scalar. `unknown_delta` when the candidate carried none.
   */
  bandLabel: string | null;
  /** Human-readable reason — present on ANY breach, enforced or merely shadowed. */
  reason: string | null;
}

/**
 * The live ceiling verdict for one candidate.
 *
 * The comparison is `|delta| >= ceiling` ⇒ BREACH, because the authorized band is
 * `[0.495, 0.55)` — half-open, upper edge EXCLUSIVE. A candidate at exactly 0.55
 * is outside the authorization and is cut. (The demo ceiling of TRA-1670 uses
 * `>` against a ceiling it treats as inclusive; that one is an operator-tuned
 * number, this one is a band edge, and the band edge is what the doc ratified.)
 *
 * FAIL-OPEN on an absent delta, matching the demo ceiling: a ceiling's job is to
 * cut a MEASURED tail, and rejecting on a missing greek would starve the sleeve on
 * a data outage rather than cut a loser. The FLOOR (`otm_delta_floor`, TRA-2763)
 * is the gate that fails CLOSED on an unknown delta, and it runs on the same
 * candidate — so the pair still admits nothing that cannot prove its delta.
 */
export function entryDeltaCeilingLiveVerdict(
  structure: string,
  delta: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EntryDeltaCeilingLiveVerdict {
  const resolution = resolveEntryDeltaCeilingLive(structure, env);
  const absDelta = typeof delta === 'number' && Number.isFinite(delta) ? Math.abs(delta) : null;
  const band = absDelta === null ? null : mandateBandFor(structure, absDelta);
  const base = {
    ...resolution,
    absDelta,
    bandLabel: absDelta === null ? 'unknown_delta' : band?.label ?? null,
  };

  if (resolution.mode === 'off' || resolution.ceiling === null || absDelta === null) {
    return { ...base, breached: false, blocked: false, reason: null };
  }
  if (absDelta < resolution.ceiling) {
    return { ...base, breached: false, blocked: false, reason: null };
  }

  const enforced = resolution.mode === 'enforce';
  const suffix = enforced ? '' : ' [SHADOW: recorded, NOT blocked — the open proceeded]';
  return {
    ...base,
    breached: true,
    blocked: enforced,
    reason:
      `entry delta ceiling (live, TRA-3394): |delta| ${absDelta.toFixed(4)} >= ${resolution.ceiling} `
      + `— above the ${OTM_SLEEVE_MANDATE_ISSUE} authorized band for ${structure} `
      + `(band ${band?.label ?? 'unmandated'}: ${band?.authorization ?? 'unknown'})${suffix}`,
  };
}
