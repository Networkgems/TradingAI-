// TRA-4474 — the INTENDED value of every production env lever, IN THE REPO.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `DURABILITY_POLICY=refuse` was armed on bqb1 on 2026-07-17 (TRA-2002, verified
// at three layers) and was ABSENT from the live env by 2026-09-10 — most likely
// wiped by the TRA-2136 `PUT /env-vars` full-set replace four days later, whose
// restore inventory was rebuilt from memory and never named the key. The box
// booted fail-open for ~50 days and NOTHING could notice, because
// `/api/health/durability` publishes only the EFFECTIVE policy: `"observe"` on a
// box we armed is byte-identical to `"observe"` on a box we never armed. There
// was no second term for any grader to disagree with.
//
// The intent therefore lives HERE, in a compiled source file, precisely because
// the env is the thing that can vanish. An intended value carried in another env
// var would be wiped by the same verb that wipes the lever, and the mismatch
// would read as a match.
//
// Every lever gets an EXPLICIT intent — including the ones intended OFF. A lever
// whose intent is `off` being found `on` is the TRA-4442 shape (absence/default
// silently meaning ARMED), and a deliberate posture change now requires a
// one-line edit to this manifest, which is the audit trail this file exists to
// force. `/api/health/durability` publishes this summary as `envIntent`;
// `pnpm check:env-intent` grades it fail-closed (an unreadable route or a box
// that cannot prove it is production is BLIND, never a pass).
//
// ⚠️ This manifest GRADES; it never ARMS. Changing an `intended` value here
// changes what the instrument reports, not what the process does.

import { resolveDurabilityPolicy } from './durability.js';
import { resolveOrderQuoteGuardConfig } from './order-quote-guard.js';
import {
  isOptionLiveDirectionalEnabled,
  isOptionLiveOtmEnabled,
  isOptionLiveRvLongEnabled,
} from './option-exec-flag.js';

export interface EnvLeverIntent {
  /** The env key the intent is about. */
  key: string;
  /** Intended EFFECTIVE value on the production money host. */
  intended: string;
  /** The ruling / record the intent derives from. */
  provenance: string;
  /** Resolve the effective value the SAME way the consumer does. */
  resolve: (env: NodeJS.ProcessEnv) => string;
}

/**
 * The production intent manifest. One row per lever; `intended` compares
 * against the lever's own resolver (so ` Refuse ` matches `refuse`, and an
 * absent key resolves to whatever the code default actually is — which is the
 * whole point: the DEFAULT is graded, not the string).
 */
export const PRODUCTION_ENV_INTENT: readonly EnvLeverIntent[] = [
  {
    key: 'DURABILITY_POLICY',
    intended: 'refuse',
    provenance:
      'TRA-2002 (armed+verified 2026-07-17); lost by the TRA-2136 env-set replace; re-arm ordered by TRA-4474',
    resolve: (env) => resolveDurabilityPolicy(env),
  },
  {
    key: 'ENABLE_ORDER_QUOTE_GUARD',
    intended: 'off',
    provenance:
      'code default; no board ruling arms it — recorded so a silent arm/disarm is graded (TRA-4474). Arming it is a one-line edit here plus the env write.',
    resolve: (env) => resolveOrderQuoteGuardConfig(env).mode,
  },
  {
    key: 'ENABLE_OPTION_LIVE_OTM',
    intended: 'off',
    provenance:
      'TRA-4750 item 3 (2026-09-20): `single_leg_otm` STAND DOWN — SUPERSEDES the TRA-2877 standing arm, which is what this row read until 2026-09-22. Executed on bqb1 by TRA-4785 (env -> false + pinned same-window deploy). RE-ARMING NEEDS BOARD SIGN-OFF (TRA-4750 item 5): standing down is the risk-reducing direction and needed none; resuming is not. Do NOT "resolve" a mismatch here by flipping this row back — an `on` reading IS the event to escalate.',
    resolve: (env) => (isOptionLiveOtmEnabled(env) ? 'on' : 'off'),
  },
  {
    key: 'ENABLE_OPTION_LIVE_RV_LONG',
    intended: 'off',
    provenance: 'RV live sleeve stays dark (TRA-1491/TRA-1929; RV remains OFF per the TRA-2877 record)',
    resolve: (env) => (isOptionLiveRvLongEnabled(env) ? 'on' : 'off'),
  },
  {
    key: 'ENABLE_OPTION_LIVE_DIRECTIONAL',
    intended: 'off',
    provenance:
      'TRA-1490: board authorized BUILDING the live path, explicitly did NOT arm it; arming is a separate gated approval',
    resolve: (env) => (isOptionLiveDirectionalEnabled(env) ? 'on' : 'off'),
  },
];

export interface EnvIntentLeverReading {
  key: string;
  intended: string;
  /** Raw env string, `null` when the key is absent. */
  raw: string | null;
  /** Whether the key exists in the env at all — `false` + a passing `effective` means the DEFAULT is doing the work. */
  present: boolean;
  /** The value the consumer actually resolves. */
  effective: string;
  /** `null` when the box is not (provably) production — nothing is graded. */
  matches: boolean | null;
  provenance: string;
}

export interface EnvIntentSummary {
  /** Where the intent comes from, so a reader knows what to edit. */
  source: 'packages/server/src/env-intent.ts';
  /**
   * TRUE ⇒ this box says NODE_ENV=production and the manifest is graded.
   * FALSE ⇒ dev/test box, `matches`/`ok` are null — NOT a pass. A checker that
   * knows it is pointed at the money host must treat `applies: false` as BLIND
   * (the box cannot prove it is the thing the intent is about), never as green.
   */
  applies: boolean;
  nodeEnv: string | null;
  levers: EnvIntentLeverReading[];
  /** Keys where the graded effective value disagrees with the manifest. */
  mismatches: string[];
  /** TRUE only when graded and clean; FALSE on any mismatch; `null` when not graded. */
  ok: boolean | null;
}

/** Pure — no IO, safe from an open health route. */
export function summarizeEnvIntent(env: NodeJS.ProcessEnv = process.env): EnvIntentSummary {
  const applies = (env['NODE_ENV'] ?? '').trim() === 'production';
  const levers = PRODUCTION_ENV_INTENT.map((lever): EnvIntentLeverReading => {
    const raw = env[lever.key];
    const effective = lever.resolve(env);
    return {
      key: lever.key,
      intended: lever.intended,
      raw: raw ?? null,
      present: raw !== undefined,
      effective,
      matches: applies ? effective === lever.intended : null,
      provenance: lever.provenance,
    };
  });
  const mismatches = levers.filter((l) => l.matches === false).map((l) => l.key);
  return {
    source: 'packages/server/src/env-intent.ts',
    applies,
    nodeEnv: env['NODE_ENV'] ?? null,
    levers,
    mismatches,
    ok: applies ? mismatches.length === 0 : null,
  };
}
