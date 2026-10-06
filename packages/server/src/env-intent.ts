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
import { isExplorationAllowanceFlagOn } from './directional-exploration-allowance.js';
import { isWheelIvEntryFilterEnabled } from './option-exec-flag.js';
import { resolveExpectancyGateConfig } from '@trading-app/agents';

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
   * TRA-5014 — this lever's AUTHORITATIVE HOME is the `demo-flags.json` overlay
   * (`DATA_DIR/demo-flags.json`, allowlisted by `DEMO_FLAG_ALLOWLIST`), not the
   * service env var list.
   *
   * ⚠️ Without this marker such a lever is UNGRADEABLE HERE, and ungradeable in
   * the silent direction. `resolveDemoFlagEnv` layers the file OVER the base env
   * and never writes into `process.env`, so a flag armed only through the
   * overlay reads `raw: null, present: false` and resolves to its code default —
   * i.e. a lever that is ON in force publishes as `off`. That is the TRA-4474
   * failure this whole file exists to kill, reached by a second route: one term,
   * nothing for a grader to disagree with.
   *
   * It is not hypothetical. `ENABLE_DIRECTIONAL_EXPLORATION_ALLOWANCE` is the
   * paper directional sleeve's ONLY admission path, it has no `render.yaml`
   * seed, and it was absent from this manifest — so when an unattributed write
   * disarmed it on 2026-09-22/23 the sleeve went dark for SEVEN consecutive ET
   * sessions while `pnpm check:env-intent` graded MATCH / exit 0 every day
   * (TRA-5014).
   *
   * Marking a lever `overlayBacked` changes two things and only two:
   *   • `resolve`/`raw`/`present` read the OVERLAY env the caller supplied,
   *     because that is where the consumer reads (file wins over base env), and
   *   • a caller that supplies NO overlay env grades this lever `matches: null`
   *     and lists it in `blindLevers` — never a pass, and never a false
   *     mismatch either. A blind lever is reported as blind.
   *
   * Env-backed levers are untouched by the overlay by construction: they keep
   * resolving from the base env, so a demo override can never move one. That is
   * belt-and-braces over the allowlist, which already shares ZERO keys with this
   * manifest (asserted in `env-intent.test.ts`, which fails if a manifest lever
   * is ever added to `DEMO_FLAG_ALLOWLIST` — that would hand a non-admin
   * overlay write a real-money lever).
   */
  overlayBacked?: true;
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
    intended: 'off',
    provenance:
      'TRA-4885 default direction B, EXECUTED by TRA-4988 (2026-10-03): board card f8cd3843 ' +
      '(ask_user_questions, human_only, 5th in its chain) expired unanswered after 5.74d, firing ' +
      'the declared default — bands dark FIRST, then restore_both (caps 64/64 -> ratified 300/500, ' +
      'stamp 5fc18af7) as ratification hygiene, one-shot cost-bar grant NOT re-issued. Supersedes ' +
      'the TRA-4750-item-5 standing re-arm (card 6b82a9e7, 2026-09-24) this row carried ' +
      '09-24..10-03. Standing down was risk-reducing and needed no sign-off, per this row\'s own ' +
      'prior text; the manifest row moved in the same change, as required. The hazard direction ' +
      'has inverted again: an `on` reading here is now a silent RE-ARM of a stood-down sleeve on ' +
      'the money host — escalate. Re-arming is a board decision and there is no pending card; it ' +
      'needs a fresh answer on a live surface (TRA-4885 comment 88153428).',
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
    // TRA-5014 — ⚠️ DO NOT DELETE THIS ROW TO MAKE A CHECKER GO GREEN. It is the
    // only second term that can disagree with a silent disarm of this flag; the
    // seven dark sessions below happened precisely because the row was absent.
    key: 'ENABLE_DIRECTIONAL_EXPLORATION_ALLOWANCE',
    intended: 'on',
    provenance:
      'TRA-5014 / TRA-5033. The TRA-4378 bounded exploration carve-out is the paper directional ' +
      "sleeve's ONLY admission path — the flat cost bar has never admitted a `directional` " +
      'candidate (TRA-4053 premise; read 2026-10-02: admitted 0 / rejected 99,269 over 5 retained ' +
      'days), so every desk entry it ever made came through this bypass. An UNATTRIBUTED write ' +
      'disarmed it on 2026-09-22/23 and the desk book then produced ZERO entries for SEVEN ' +
      'consecutive ET sessions (2026-09-23..2026-10-01), terminating the TRA-4744 pre-registered ' +
      "chandelier read at NOT RUN. Nothing could notice: the flag has no `render.yaml` seed, it is " +
      'armed through the DATA_DIR demo-flags overlay rather than the service env list, and it was ' +
      'absent from this manifest — so `check:env-intent` graded MATCH / exit 0 on all seven dark ' +
      'days. The actor is unrecoverable past Render\'s 7-day log retention, so the record is the ' +
      'remedy (CTO ruling on TRA-5033, 2026-10-02T02:55Z: TRA-4750 binds CAPITAL-COMMITTING entry ' +
      'paths and this instrument is demo-only with `liveCapitalReachable: false`, so the ' +
      'stand-down never reached it; its board sign-off — TRA-4053 card `17e5f566`, 2026-09-08 — is ' +
      'live and was never revoked, and no terminal `disarm` event exists across 41 durable rows). ' +
      'RE-ARMED 2026-10-02T02:55Z via `POST /api/admin/demo-flags`, box RESUMED not reset ' +
      '(armedEtDay 2026-09-09, rowsUsed 20/25, expiresEtDay 2026-11-03) and verified to survive a ' +
      'deploy (`durability.ephemeral: false`, 41 hydrated events, re-read on pid 73 after the ' +
      '2026-10-02T04:25:48Z boot onto new bytes). An `off` reading here is now a SILENT DISARM of ' +
      'a board-signed-off carve-out and is the event to escalate; arming does not by itself ' +
      'produce trades (the quality gate and spread ceiling still run on every granted candidate), ' +
      'and because the home is the overlay the re-arm is HOT — no deploy, no env-var write.',
    resolve: (env) => (isExplorationAllowanceFlagOn(env) ? 'on' : 'off'),
    // The overlay IS this lever's home — see `overlayBacked` on EnvLeverIntent.
    // Without it this row would publish `off` on a box where the flag is armed.
    overlayBacked: true,
  },
  {
    // TRA-5172 — the IVR>=50 floor is a HARD FAIL ON UNKNOWN in this consumer
    // (`options-ideas-expectancy-gate.ts`: `ivRank == null || ivRank < minIvRank`
    // ⇒ drop, checks 4-6 never run), unlike the scanner where it is fail-open
    // (TRA-2045). Registering the precondition here makes it machine-readable on
    // the no-auth /api/health/durability surface instead of living in a comment
    // — the TRA-2206 warning was prose, and prose did not stop it.
    key: 'ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE',
    intended: 'off',
    provenance:
      'code default, off. TRA-5170 (QuantTrader ruling, 2026-10-05): MUST NOT be armed while ' +
      '/api/health/short-premium reports ivRankMeasured: 0. The IVR>=50 floor is a hard fail on ' +
      'unknown in this consumer, so arming it on the current store (depth 2 of 20 on 82/82 scans) ' +
      'suppresses 100% of credit structures and attributes it to a missing data field — a drop ' +
      'rate that reads exactly like "the gate is working" while measuring nothing. Precondition: ' +
      'ivRankMeasured >= 0.80 * scanCount sustained across a deploy (TRA-5173).',
    resolve: (env) => (resolveExpectancyGateConfig(env) != null ? 'on' : 'off'),
  },
  {
    // TRA-5172 — same ruling, second fail-closed consumer: `wheel-router.ts`
    // `passesRoutingGate` never routes a null/sub-floor rank. Overlay-backed:
    // this flag's home is the demo-flags.json allowlist (a daemon-free board
    // arm), not the service env list — see `overlayBacked` on EnvLeverIntent.
    key: 'ENABLE_WHEEL_IV_ENTRY_FILTER',
    intended: 'off',
    provenance:
      'code default, off (observe-only ledger accrues either way, TRA-2028). TRA-5170 ' +
      '(QuantTrader ruling, 2026-10-05): MUST NOT be armed while /api/health/short-premium ' +
      'reports ivRankMeasured: 0 — wheel-router passesRoutingGate is a hard fail on an unknown ' +
      'ivRank, so arming the filter on the current store (depth 2 of 20 on 82/82 scans) stands ' +
      'down 100% of wheel routing while /api/health/wheel-promotion-gate keeps reading like a ' +
      'working gate (ivEntries.total: 0). Precondition: ivRankMeasured >= 0.80 * scanCount ' +
      'sustained across a deploy (TRA-5173).',
    resolve: (env) => (isWheelIvEntryFilterEnabled(env) ? 'on' : 'off'),
    overlayBacked: true,
  },
  {
    key: 'ENABLE_OPTION_LIVE_RV_LONG',
    intended: 'off',
    provenance: 'RV live sleeve stays dark (TRA-1491/TRA-1929; RV remains OFF per the TRA-2877 record)',
    resolve: (env) => (isOptionLiveRvLongEnabled(env) ? 'on' : 'off'),
  },
  {
    key: 'ENABLE_OPTION_LIVE_DIRECTIONAL',
    intended: 'on',
    provenance:
      'TRA-1490 authorized BUILDING the live path, explicitly dark; arming was a separate gated ' +
      'approval — and board card ca66df94 on TRA-5207 (ask_user_questions, human_only, answered ' +
      '2026-10-06T03:03:52Z) IS that approval: option B armed the LIVE directional learning budget ' +
      'at $800 loss cap / $150 per-open / 40 opens / 40-session box, executed 2026-10-06 by five ' +
      'single-key PUT /env-vars writes + the same-SHA env-apply dep-db26gcui0phs73dg4hm0 ' +
      '(TRA-5213). THE AUTHORISATION IS SCOPED TO THAT BUDGET, not open-ended: it stands only ' +
      'while ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET is on (the row below — the two rows move ' +
      'together) AND the budget has not self-disarmed. The budget disarms itself at the loss cap, ' +
      'the open cap, or the session box (live-learning-budget.ts), writing a durable disarm event ' +
      'WITHOUT touching any env var — so this row alone cannot see expiry: once ' +
      '/api/health/durability reports liveLearningBudget.disarmed != null, an `on` reading here ' +
      'is ONCE AGAIN an unauthorised re-arm of the TRA-4750-stood-down directional sleeve ' +
      '(STOOD_DOWN_SLEEVES still names it) — stand it down and return BOTH rows to intended ' +
      "'off' in the same change, per the two-acts rule above. Kill switch: " +
      'ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET=0 + same-SHA redeploy.',
    resolve: (env) => (isOptionLiveDirectionalEnabled(env) ? 'on' : 'off'),
  },
  {
    // TRA-5213 — the expiry term for the row above, machine-readable. Without
    // this row the ca66df94 authorisation's env-level bound (the kill switch)
    // would live only in prose: a wipe or kill of the budget flag that left
    // ENABLE_OPTION_LIVE_DIRECTIONAL=1 standing would grade clean while the
    // directional arm ran unbudgeted on the money host.
    key: 'ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET',
    intended: 'on',
    provenance:
      'Armed by board card ca66df94 on TRA-5207 (2026-10-06): $800 loss cap / $150 per-open / ' +
      '40 opens / 40-session box. This flag is the env-level bound on the live directional arm: ' +
      'an `off`/absent reading here while ENABLE_OPTION_LIVE_DIRECTIONAL is still on means the ' +
      'kill switch was thrown (or the key wiped) without the paired manifest edit — the ' +
      'directional lever is then armed WITHOUT its budget: escalate; never edit this row alone ' +
      'to clear it. The runtime self-disarm (loss/open/session caps) is NOT visible in env: ' +
      'grade liveLearningBudget.disarmed on the same /api/health/durability payload. When the ' +
      "budget ends either way, BOTH rows return to intended 'off' in the same change.",
    // Resolve the way the consumer does — a faithful inline of
    // `isLiveLearningBudgetFlagOn` (live-learning-budget.ts:83; the same truthy
    // list as option-exec-flag's `flagOn`). Inlined rather than imported because
    // that module pulls the scheduler/logger graph in at module scope, and the
    // check-env-intent.mjs declared leg imports this file's compiled artifact —
    // an import failure there would read BLIND on every run of the instrument.
    resolve: (env) => {
      const raw = env['ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET'];
      return typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
        ? 'on'
        : 'off';
    },
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
      'TRA-4820/TRA-4821; this ratifies the POSTURE, not those writes. TRA-4863 has since ' +
      'key-named both of them as writes to THIS key, off the boot tape rather than off a bracket: ' +
      'dep-dao939egekts73bbv9cg set `sandbox` (last production boot 2026-09-20T22:07:07Z, first ' +
      'sandbox boot 2026-09-21T02:09:14Z) and dep-daq028id0e5s73aka5i0 set it back ' +
      '(2026-09-23T16:41:55Z) — 62h32m41s boot-to-boot with the real-money boot-arm disarmed, ' +
      'which is why TRA-4820\'s "it cost nothing" verdict is withdrawn and re-filed as TRA-4864.',
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
  /**
   * `null` when the box is not (provably) production — nothing is graded — OR
   * when this is an `overlayBacked` lever and the caller supplied no overlay env
   * (see `blindLevers`). Both are UNGRADED, never a pass.
   */
  matches: boolean | null;
  provenance: string;
  /**
   * TRA-5014 — `true` when this lever's home is the `demo-flags.json` overlay
   * rather than the service env var list. A consumer of this payload (notably
   * `scripts/check-env-intent.mjs`, whose leg 2 grades the Render STORED env
   * list) must not read an absent stored env var as a disarm for these: there is
   * no stored env var to read, by design, and `key ABSENT` is the healthy state.
   */
  overlayBacked: boolean;
  /**
   * TRA-5014 — `null` for an env-backed lever (not applicable). For an
   * `overlayBacked` lever: whether the caller supplied the overlay env at all.
   * `false` ⇒ this lever was NOT graded, because the only layer that can hold
   * its value was not read.
   */
  overlayVisible: boolean | null;
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
  /**
   * TRA-5014 — keys that could NOT be graded on a box that otherwise applies,
   * because an `overlayBacked` lever's overlay env was not supplied. Separate
   * from `mismatches` on purpose: a blind lever is not a disagreement, and
   * reporting it as one would train an operator to ignore this instrument. It
   * still blocks `ok`, per the fail-closed rule this file states up top.
   */
  blindLevers: string[];
  /**
   * TRUE only when graded and clean; FALSE on any mismatch OR any blind lever;
   * `null` when not graded at all.
   */
  ok: boolean | null;
}

/**
 * Pure — no IO, safe from an open health route.
 *
 * `overlayEnv` (TRA-5014) is the `demo-flags.json`-layered env, which the CALLER
 * resolves (`resolveDemoFlagEnvFromEnv()`) because resolving it reads the disk
 * and this function must stay IO-free. Only `overlayBacked` levers consult it;
 * every other lever resolves from `env`, so an overlay can never move one.
 * Omitting it does not silently degrade a reading to `off` — the affected levers
 * come back `matches: null` in `blindLevers`.
 */
export function summarizeEnvIntent(
  env: NodeJS.ProcessEnv = process.env,
  overlayEnv?: NodeJS.ProcessEnv,
): EnvIntentSummary {
  const applies = (env['NODE_ENV'] ?? '').trim() === 'production';
  const levers = PRODUCTION_ENV_INTENT.map((lever): EnvIntentLeverReading => {
    const overlayBacked = lever.overlayBacked === true;
    // An overlay-backed lever is read from the layered env, because that is the
    // layer its consumer reads (the file wins over the base env). Env-backed
    // levers never see the overlay: inertness by construction, not by argument.
    const overlayVisible = overlayBacked ? overlayEnv !== undefined : null;
    const source = overlayBacked && overlayEnv !== undefined ? overlayEnv : env;
    const raw = source[lever.key];
    const effective = lever.resolve(source);
    // Blind ⇒ UNGRADED. Resolving an overlay-backed lever against the base env
    // would publish its code default as if it were a measurement.
    const gradeable = applies && !(overlayBacked && overlayVisible === false);
    return {
      key: lever.key,
      intended: lever.intended,
      // TRA-4801 — redacted for publication when the lever declares a filter.
      // `present` below is deliberately derived from the UNREDACTED value, so a
      // key that exists but redacts to null still reads present:true.
      raw: lever.redact ? lever.redact(raw) : (raw ?? null),
      present: raw !== undefined,
      effective,
      matches: gradeable ? effective === lever.intended : null,
      provenance: lever.provenance,
      overlayBacked,
      overlayVisible,
    };
  });
  const mismatches = levers.filter((l) => l.matches === false).map((l) => l.key);
  const blindLevers = applies
    ? levers.filter((l) => l.overlayVisible === false).map((l) => l.key)
    : [];
  return {
    source: 'packages/server/src/env-intent.ts',
    applies,
    nodeEnv: env['NODE_ENV'] ?? null,
    levers,
    mismatches,
    blindLevers,
    ok: applies ? mismatches.length === 0 && blindLevers.length === 0 : null,
  };
}
