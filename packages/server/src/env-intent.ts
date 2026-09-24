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
//
// ── TRA-4862 — THE INTENT IS BINDING, AND IT BINDS THE OPERATOR ──────────────
// CTO ruling, 2026-09-24. A row here is not documentation. When this manifest
// declares a value for a production lever, the live service env var MUST be
// made to agree, in the same change. What the ruling does NOT do is make this
// file arm anything — see below for why — so the obligation lands on the human
// who edits it, and the checker's job is to refuse to go green until they have
// discharged it.
//
// Editing a row is therefore TWO acts, never one:
//   1. the edit here (the audit trail), and
//   2. the single-key `PUT /env-vars/{key}` upsert on the service, then
//      `render-redeploy --commit=<sha>` to ship the edit (TRA-3724).
// Do half and you have declared a posture the box is not in.
//
// That is not a style note. On 2026-09-23 `f183e601` declared `TRADIER_ENV:
// sandbox` for the duration of the TRA-4750 stand-down of the REAL-MONEY option
// book. Act 2 never happened. `shouldBootArmLiveEquity` reads the raw env var,
// which still said `production`, so the boot-arm stayed eligible and at 16:42Z
// converged the operator back to `mode=live` + `liveTradierEnvOptions=
// production` — reverting a board-ordered stand-down, with one `origin:boot`
// repair row as the entire record. The stand-down stood nothing down.
//
// WHY THE FIX IS NOT "MAKE THIS FILE ARM THE LEVER". Three reasons, and the
// third is the one that settles it:
//   • A repo file that writes the money host's live broker routing is a
//     standing automated write to production. That is the `autoDeploy=no` pin
//     (TRA-1653/TRA-1665) and the TRA-3529/TRA-3533 no-unattended-executor
//     ruling, both still in force; this would re-create both through the back
//     door.
//   • It would collapse the two terms into one. The whole point of TRA-4474 is
//     that `effective` alone cannot be disagreed with. An arming manifest makes
//     intent and effect the same fact again, and the instrument goes blind in
//     exactly the way it was built not to.
//   • It would not have prevented THIS event anyway. This file is COMPILED INTO
//     THE BUILD, so an arming row could only take effect at the deploy that
//     shipped it — and `f183e601` was never deployed. The failure was the gap
//     between declaring and applying, and an arming manifest has that same gap.
//
// So the remedy is detection, and it had to be able to see a declaration THE
// BOX HAS NEVER HEARD OF. `check:env-intent` used to take every `intended` off
// the wire from the manifest the RUNNING BUILD published — one source of truth,
// deliberately, but it meant a committed-but-undeployed edit was invisible to
// every leg it had. On a host pinned `autoDeploy=no` that blind window has no
// upper bound. Its third leg now reads THIS CHECKOUT's manifest (source and
// compiled build, which must agree or it reads BLIND) and grades it against
// both the build's intent and the stored env value, so "declared but not
// deployed" and "declared but never applied" are each named, loudly, as their
// own finding. Control ARM 0 in `check:env-intent:controls` is the 09-23 state
// byte-for-byte; it exits 0 on the pre-fix checker and 1 now.

import { resolveDurabilityPolicy } from './durability.js';
import { redactTradierEnvLabel } from './tradier-env-label.js';
import { resolveOrderQuoteGuardConfig } from './order-quote-guard.js';
import {
  isOptionLiveDirectionalEnabled,
  isOptionLiveOtmEnabled,
  isOptionLiveRvLongEnabled,
} from './option-exec-flag.js';
import { isOptionMakerTelemetryEnabled } from './option-maker-fill-ledger.js';

export interface EnvLeverIntent {
  /** The env key the intent is about. */
  key: string;
  /** Intended EFFECTIVE value on the production money host. */
  intended: string;
  /** The ruling / record the intent derives from. */
  provenance: string;
  /** Resolve the effective value the SAME way the consumer does. */
  resolve: (env: NodeJS.ProcessEnv) => string;
  /**
   * TRA-4801 — optional publication filter for the RAW value.
   *
   * ⚠️ `summarizeEnvIntent` is served by `/api/health/durability`, which is an
   * OPEN route (no auth, by design — see its handler). `raw` therefore echoes an
   * env var's literal contents to the public internet. That is harmless for a
   * policy word like `refuse`, and it is a **P0 credential leak** for any key
   * that can hold a secret.
   *
   * `TRADIER_ENV` is exactly such a key, not hypothetically but historically:
   * TRA-2163 was a P0 in which this very var held the 28-char production Tradier
   * API token and a no-auth health route published it. Adding that key to this
   * manifest without a filter would have re-opened that leak through a second
   * route.
   *
   * So: any lever whose key could ever hold a secret MUST set `redact`. Return
   * `null` for unset/empty and a fixed marker for anything unrecognized — never
   * the raw string. `present` is still computed from the unredacted value, so
   * redaction never costs the absent/present distinction.
   */
  redact?: (raw: string | undefined) => string | null;
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
    intended: 'on',
    provenance:
      'TRA-4750 item 5 board sign-off EXECUTED: card 6b82a9e7 on TRA-3401 (ask_user_questions, ' +
      'human_only, answered by the board 2026-09-24T01:57Z) ordered the STANDING RE-ARM, superseding ' +
      'the stand-down posture this row carried 2026-09-22..09-24 (TRA-4750 item 3, executed on bqb1 ' +
      'by TRA-4785). Re-armed together with the TRA-4814 rider row (ENABLE_OPTION_MAKER_TELEMETRY ' +
      'below) in the same change, as that ruling requires. The 0.385R cost bar still gates every ' +
      'entry — arming does not by itself produce trades. An `off` reading here is now a silent ' +
      'DISARM and is still the event to escalate, in the new direction; standing down again is ' +
      'risk-reducing and needs no sign-off, but the manifest row must move in the same change.',
    resolve: (env) => (isOptionLiveOtmEnabled(env) ? 'on' : 'off'),
  },
  {
    key: 'ENABLE_OPTION_MAKER_TELEMETRY',
    intended: 'on',
    provenance:
      'TRA-4814 rider (2026-09-23): any TRA-4750 re-open must arm the maker fill ledger AND this ' +
      'row in the same change, so the re-armed sleeve cannot run untelemetered — the sleeve was ' +
      'stood down partly because its 32 real closes were never recorded. Armed by the TRA-3401 ' +
      're-arm (card 6b82a9e7, 2026-09-24). An `off` reading while ENABLE_OPTION_LIVE_OTM is `on` ' +
      'means live chases are going unrecorded — escalate; never edit this row alone to clear it.',
    resolve: (env) => (isOptionMakerTelemetryEnabled(env) ? 'on' : 'off'),
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
  {
    key: 'TRADIER_ENV',
    intended: 'production',
    provenance:
      "TRA-2163 verified 'production' by value on 2026-07-23 (the go-live routing). TRA-4801 ruled " +
      "intent 'sandbox' on 2026-09-23 while the TRA-4750 option-book stand-down was in force. " +
      'Card 6b82a9e7 on TRA-3401 (human board answer, 2026-09-24T01:57Z) RATIFIED production in the ' +
      'same decision that ordered the TRA-4750 item 5 re-arm — which satisfies the TRA-1655 G2 ' +
      "condition (TRADIER_ENV == production) and inverts this row's hazard again: with a live sleeve " +
      "armed, a silent re-point to 'sandbox' routes real entries to the sandbox broker, so " +
      "'sandbox' or 'unrecognized' here is now the event to escalate — never edit this row alone to " +
      'clear it. The unattributed 09-21/09-23 env writes remain open incidents under ' +
      'TRA-4820/TRA-4821; this ratifies the POSTURE, not those writes.',
    // Resolve the way the CREDENTIAL ROUTER does (index.ts ~1243), because that
    // is the read with consequences:
    //   const tradierEnv = (process.env['TRADIER_ENV'] as ...) ?? 'sandbox';
    //   ... tradierEnv === 'production' ? PROD_CREDS : SANDBOX_CREDS
    // So it defaults to sandbox ONLY on absence (`??` does not catch ''), and it
    // routes production on an EXACT `=== 'production'` with no trim.
    //
    // `unrecognized` is its own value on purpose. `/api/health/live-equity`
    // grades this key as `(env['TRADIER_ENV'] ?? '').trim() === 'production'`
    // — WITH a trim — so ` production ` makes that route report
    // `tradierEnvProduction: true` while the credential router hands out SANDBOX
    // creds. Collapsing that case into 'sandbox' would hide a real disagreement
    // between two live readers of the same key; it mismatches either way, but an
    // operator needs to know it is a malformed value, not a deliberate flip.
    resolve: (env) => {
      const raw = env['TRADIER_ENV'];
      if (raw === undefined) return 'sandbox';
      if (raw === 'production') return 'production';
      if (raw === 'sandbox') return 'sandbox';
      return 'unrecognized';
    },
    // MANDATORY here — see the `redact` doc above. `/api/health/durability` is open.
    redact: (raw) => redactTradierEnvLabel(raw),
  },
];

export interface EnvIntentLeverReading {
  key: string;
  intended: string;
  /**
   * Raw env string, `null` when the key is absent — or when the lever declares a
   * `redact` filter that suppresses it. This field is PUBLISHED on the open
   * `/api/health/durability` route, so never assume it is the literal value:
   * for a secret-capable key it is a label or a fixed marker. Use `present` to
   * ask whether the key exists.
   */
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
      // TRA-4801 — redacted for publication when the lever declares a filter.
      // `present` below is deliberately derived from the UNREDACTED value, so a
      // key that exists but redacts to null still reads present:true.
      raw: lever.redact ? lever.redact(raw) : (raw ?? null),
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
