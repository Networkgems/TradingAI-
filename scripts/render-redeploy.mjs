#!/usr/bin/env node
// render-redeploy.mjs — TRA-1996 / TRA-1648
//
// The MISSING shared Render deploy *trigger* (companion to render-deploy-status.mjs,
// which only READS). Until now, deploys to the live public backend `tradingai-bqb1`
// (srv-d7mb7rr7uimc73ev0chg) were raw `POST /v1/services/{id}/deploys` curl calls
// with NO gate — which is exactly why the go-live soak's "no mid-RTH deploy" rule
// was a *convention with no technical enforcement* (TRA-1653 gap, flagged on
// TRA-1996). Every mid-RTH api deploy dumps bqb1's warm quote cache and resets the
// soak clock, disqualifying the session as the required clean acceptance sample.
//
// This wrapper turns that convention into a TECHNICAL GATE: it REFUSES to deploy the
// soak host across Regular Trading Hours (freeze window 13:25–20:00 UTC, Mon–Fri;
// RTH proper is 13:30–20:00Z and the freeze opens DEPLOY_LEAD_MIN early — see below)
// unless the caller passes an explicit, reasoned override. Any agent that routes bqb1
// deploys through this script can no longer accidentally break the soak. Stage
// feed/host changes for the pre-open (<13:25Z) or post-close (>20:00Z) window instead.
//
// DIRECTION, stated once so it cannot be read backwards (TRA-2313): this is a FREEZE.
// It REFUSES *inside* the window and is OPEN pre-open, post-close, and all weekend.
//
// The 13:30–20:00Z bound is chosen to match the soak grader (tra1648_soak_check.mjs)
// exactly, so this gate and the acceptance check agree on the window with no DST drift.
// The freeze itself starts DEPLOY_LEAD_MIN earlier than that, because the thing that
// breaks the soak is the BOOT, not the API call — see below.
//
// ── What this gate does NOT cover (TRA-2325, NARROWED BY MEASUREMENT — TRA-3724) ──
// It intercepts DEPLOYS. It does not — and structurally cannot — intercept an
// ENV/SETTINGS write. Nor does it see the memory watchdog's own pm2 self-restart,
// which writes no deploy record at all (TRA-2203/TRA-2261).
// ⇒ A GREEN RUN OF THIS SCRIPT IS NOT EVIDENCE THAT THE HOST IS SAFE TO TOUCH.
//   It is evidence about one of the three paths that can boot the box.
//
// What an env/settings write actually DOES is verb-dependent and was measured wrong
// here for three weeks. The per-verb truth, the safe apply path, and the one sentence
// that used to steer operators off it all live in ENV_WRITE_TRUTH below — read that,
// not this paragraph, and do not restate its claims inline anywhere. The reason the
// correction needed a ticket is that the wrong version had been copy-pasted to seven
// sites in this file, so fixing one site left six lying.
//
// ── The AUTH_SECRET value gate (TRA-2387, residual of TRA-2315) ───────────────
// The three gates above answer "may I deploy NOW?" (freeze, embargo) and "may I deploy
// THIS?" (commit hold). None of them asks the fourth question: "will the thing I deploy
// still BOOT?" `resolveAuthSecret()` (packages/server/src/auth.ts:34) accepts AUTH_SECRET
// only if `fromEnv.trim().length > 0`, and THROWS under NODE_ENV=production otherwise. So
// a deploy onto a host whose AUTH_SECRET is empty or whitespace-only does not degrade the
// service, it takes it DOWN.
//
// TRA-2315 fixed the PREDICATE that answers this (0f9e89e — the old guard tested
// `.length === 0`, so `AUTH_SECRET=" "` was reported PASS on a host that would refuse to
// boot). What it did not do is CALL it: `scripts/tra2296-auth-secret-check.mjs` only runs
// when a human remembers to run it. This gate is the invocation.
//
// ⚠ WHY THIS IS NOT REDUNDANT WITH "an env write redeploys anyway". The obvious objection
// is that you cannot blank AUTH_SECRET without triggering `service_updated`, so a broken
// secret bricks the box before this script ever runs. That is wrong in the case that
// matters: a deploy whose boot THROWS does not go live, and Render keeps the PREVIOUS
// process serving. The result is a host that is up, healthy, and holding a good secret in
// memory — while its env is broken and every future deploy is a landmine. That state ends
// only when somebody deploys for an unrelated reason, and nothing else on the box reports
// it. Same shape for the TRA-2296 P1 itself: the process that booted before the value was
// cleared keeps working until the next restart.
// ⇒ AND THE CONVERSE, WHICH THIS GATE CANNOT FIX: the write that BREAKS the secret is an
//   env write, so it never passes through here. This gate cannot see its own most likely
//   cause. It is printed in the normal output, not only in a refusal, so that a green
//   `auth :` line is not read as "the secret is protected".
//
// ── Auth ──────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_xxx node scripts/render-redeploy.mjs      (never commit the key)
//
// ── Options ───────────────────────────────────────────────────────────────────
//   RENDER_SERVICE_ID   (optional) `srv-…`. Default the soak host bqb1.
//   RENDER_SERVICE_NAME (optional) resolve by name instead. Default `TradingAI-` — the
//                       live service's Render `name`. Its SLUG `tradingai-bqb1` (which is
//                       what the onrender hostname tracks) also resolves. That default
//                       read `tradingai-bqb1` and resolved to `[]`, and the refusal blamed
//                       the API key for it — TRA-3743, see scripts/lib/render-service-resolve.mjs.
//   --commit=<sha>      deploy a specific commit. THE STANDING RULE (TRA-1665).
//   --tip               deploy whatever origin/<branch> is at this instant. REQUIRED to be
//                       explicit since TRA-4420: this used to be the DEFAULT, so a typo'd
//                       --commit (or --help) shipped the tip and exited 0. Exactly one of
//                       --commit / --tip must be given.
//   --clear-cache       (optional) deploy with a cleared build cache.
//   --force-rth-override="reason"   deploy during the RTH freeze anyway. REQUIRES a
//                       non-empty reason; it is echoed so the breach is on the record.
//   --force-embargo-override="reason"  deploy during a DATED EMBARGO anyway. Separate
//                       from --force-rth-override on purpose: an embargo is a specific
//                       board-ratified hold on a named day, so authorisation to break
//                       the routine freeze is not authorisation to break that hold.
//   --force-commit-hold-override="reason"  deploy a HELD COMMIT anyway. Separate again:
//                       the other two gates are about WHEN you deploy, this one is about
//                       WHAT you deploy, and a clear calendar says nothing about it.
//   --force-auth-secret-override="reason"  deploy onto a host whose live AUTH_SECRET is
//                       unusable (or unreadable) anyway. Separate for the fourth time, and
//                       for the sharpest reason yet: the other three gates protect a
//                       MEASUREMENT, this one protects the SERVICE STAYING UP. "The soak is
//                       already broken, ship it" is a perfectly good reason to break the
//                       freeze and no reason at all to boot a process that throws.
//   --allow-rollback="reason"  deploy something OLDER than what is serving anyway. Fifth
//                       and last, and the only one whose hazard is created by the caller
//                       typing MORE, not less — see the gate note below.
//   --override-hold="<TRA-####> reason"  deploy past an open REPO-RESIDENT HOLD in
//                       ops/deploy-hold.json anyway. Sixth override, and the only one that
//                       demands the TICKET as well as a reason — the other five guard a
//                       condition this script can itself measure (a clock, a sha, a secret),
//                       so a bare reason is enough; this one guards a DECISION somebody else
//                       is holding, and naming it is the cheapest proof the hold was read.
//   --override-cadence="<TRA-####> reason"  deploy one more COMMIT ADVANCE into a window whose
//                       cadence ceiling is already spent, or whose history cannot be read.
//                       This is the seventh override. Like --override-hold it must name a
//                       ticket, because a second train needs an owner who will answer for it.
//                       TRA-4535.
//   --dry-run           print the gate decision and the intended call, POST nothing.
//   --help, -h          print usage and exit 0 WITHOUT deploying. Added by TRA-4420: on
//                       2026-09-09 this flag was unrecognised, therefore ignored, and the
//                       run deployed bqb1. See the ARGUMENT GUARD block below.
//
// ⛔ VALUES ATTACH WITH '='. There is no space form. `--commit <sha>` and `--commmit=<sha>`
//   are both REFUSED (exit 2) since TRA-4420; before it they were silently ignored and the
//   BRANCH TIP shipped under a green exit 0.
//
// ── Exit codes ────────────────────────────────────────────────────────────────
//   0  deploy triggered (or dry-run allowed, or --help printed)
//   2  usage / unknown-or-malformed argument / auth / API error
//   4  REFUSED — RTH freeze in effect on the soak host and no override given
//   5  REFUSED — a dated embargo covers this instant and no override given
//   6  REFUSED — the deploy would carry a HELD COMMIT, or it cannot be proven not to
//   7  REFUSED — the host's live AUTH_SECRET is unusable, or it cannot be READ (BLIND)
//   8  REFUSED — the deploy would ROLL THE HOST BACK, or it cannot be proven not to
//   9  REFUSED — an open hold in ops/deploy-hold.json covers this service, or that file
//      exists and cannot be trusted (BLIND). Runs FIRST, before RENDER_API_KEY is read and
//      before any byte reaches Render — TRA-4261. A hold missing either stamp is BLIND:
//      `enumeratedTip` (the list's HEAD, TRA-4262) and `enumeratedFromLivePin` (the list's
//      BASELINE — the sha THE BOX IS RUNNING, sha first then provenance, TRA-4268).
//  10  REFUSED — a CADENCE_CEILINGS row is active, this post-close window already holds its
//      quota of COMMIT ADVANCES (counted off Render's deploy history), and this deploy would
//      add one more. Also exit 10 when that history cannot be read (BLIND). A same-SHA
//      redeploy is never refused. Override: --override-cadence="<TRA-####> reason". TRA-4535.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyAuthSecret } from './lib/auth-secret-predicate.mjs';
// The shallow-graft ancestry grader (TRA-3699, moved to lib by TRA-3721). Imported for
// local use AND re-exported below — `export … from` alone would leave `isShallowCheckout`
// undefined at the gate-6 call site in this file.
import {
  gradedAncestry,
  isShallowCheckout,
  gradeCarries,
  carriesFromVerdict,
  BLIND_ANCESTRY_CAUSES,
} from './lib/shallow-ancestry.mjs';
// The shared service resolver (TRA-3743). Both Render helpers had their own copy and
// both carried the same dead default name.
import {
  BQB1,
  DEFAULT_SERVICE_NAME,
  resolveServiceByName,
  explainUnresolved,
} from './lib/render-service-resolve.mjs';
// TRA-3991: when the RTH freeze refuses, say what it is HOLDING. A refusal that names a
// safety-path remedy is a decision the operator must make; one that names none is a
// stage-for-post-close. Read-only, fails BLIND, never deploys.
import { lagState as deployLagState, readLiveCommit as readDeployLagLive, DEFAULT_HOST as DEPLOY_LAG_DEFAULT_HOST } from './check-deploy-lag.mjs';

const API = 'https://api.render.com/v1';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID_ENV = process.env.RENDER_SERVICE_ID;
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;

// The one service under go-live soak. The freeze applies ONLY to this host; every
// other Render service deploys with no time gate.
//
// ⚠️ THREE IDENTITY STRINGS, KEPT APART ON PURPOSE (TRA-3743). `SOAK_HOST_NAME` used to
// hold `tradingai-bqb1` and was doing double duty: correct as a HOSTNAME (the hostname
// tracks the SLUG) and DEAD as a service `name` (the live `name` is `TradingAI-`), so the
// `service.name === SOAK_HOST_NAME` arm below could never match. It was covered by the id
// arm beside it and so never fired — a dead disjunct in a safety predicate is still a
// disjunct that will not be there when the id arm needs company.
const SOAK_HOST_ID = 'srv-d7mb7rr7uimc73ev0chg';
const SOAK_HOST_NAME = BQB1.name; //  `TradingAI-`     — Render `service.name`
const SOAK_HOST_SLUG = BQB1.slug; //  `tradingai-bqb1` — Render `service.slug`, and the HOSTNAME

// ─────────────────────────────────────────────────────────────────────────────────
// ENV_WRITE_TRUTH (TRA-3724) — what an env/settings write does on bqb1, per VERB.
//
// This block replaces the sentence this file used to print at seven sites:
//
//     "An env/settings write redeploys this service from its BRANCH TIP immediately
//      and unguarded (trigger: service_updated, TRA-2186). It does NOT honour --commit"
//
// The first half was true when written and is no longer reproducible. The second half
// was never true, and it is the half that cost us: on 2026-08-14 it told the operator
// holding TRA-3708 that pinning was futile, so the recovery reached for an untargeted
// POST /deploys, resolved the branch tip, and shipped five unrelated commits — including
// `signal-engine.ts +110` on the real-money OTM entry path — into this host 9.5 hours
// before the go-live-week open. Nobody decided that; the omitted flag did.
//
// ── The measurement (Render events API, ALL 1161 deploy_started, 2026-04-25 → 08-14) ──
// Render stamps every deploy with the cause. The markers are disjoint, so the verbs are
// distinguishable from the record alone — nothing here is inferred:
//
//   marker                  cause                                n    LAST occurrence
//   ----------------------  -----------------------------------  ---  -------------------
//   newCommit:<sha>         git push auto-deploy                 854  2026-07-12T20:34Z
//   user:{...}              POST /deploys  (this script)         280  2026-08-14T05:48Z
//   envUpdated:true         an ENV-VAR write                      22  2026-07-23T13:39Z
//   updatedProperty:<name>  a SETTINGS write, PATCH /services/{id} 4  2026-04-28T04:11Z
//   firstBuild:true         service creation                       1  2026-04-25T12:30Z
//
// VERB 1 — ENV-VAR WRITE. TRA-2186 was RIGHT when it was written, and its artifact holds
//   up: dep-d9h1j5nlk1mc738s57qg, 2026-07-23T13:39:34Z, `trigger:"service_updated"`,
//   event trigger `envUpdated:true` with NO `user` (Render-initiated, not operator-
//   initiated). It shipped `1e5c4883` — the branch tip, pushed 13:25:32Z, fourteen
//   minutes earlier — and NOT `9493b4ec`, the commit the same operator had deliberately
//   deployed at 13:23Z. So "redeploys from BRANCH TIP, despite autoDeploy:no" is measured
//   true for that occurrence: git-push deploys had already stopped on 07-12, so the pin
//   was in force and did not suppress it.
//   BUT that occurrence is the LAST of the 22, and there have been ZERO since, across at
//   least two subsequent env writes on this service:
//     · 2026-07-24 ~15:55Z  TRADIER_ENV -> "production"  (TRA-2163 remediation)
//     · 2026-08-14T03:53Z   PUT /env-vars/ENABLE_OPTION_LIVE_OTM -> HTTP 200 (TRA-3708);
//       no deploy, no event of any kind — the stream goes deploy_ended 02:23:55.856Z
//       straight to server_restarted 03:53:53.783Z.
//   Service now reads `autoDeploy:"no"`, `autoDeployTrigger:"off"`. Do NOT trust this
//   paragraph over the live reading the script prints; see envWriteAutoDeployPosture().
//
// VERB 2 — SETTINGS WRITE, `PATCH /v1/services/{id}`. A DIFFERENT verb: Render labels it
//   `updatedProperty`, never `envUpdated`. Only 4 in this service's whole life (build
//   command, start command, Plan, Disk), all 2026-04-25/28, all long before the pin.
//   ⇒ UNMEASURED under the current pin, and deliberately left untested: the only way to
//   test it is to write a setting on the real-money host during go-live week, which is
//   the exact unguarded branch-tip deploy this block exists to prevent. THE WARNING IS
//   RETAINED FOR THIS VERB. Treat a settings write as capable of shipping the tip.
//
// VERB 3 — FULL-SET `PUT /v1/services/{id}/env-vars`. BANNED (TRA-2136: it REPLACES the
//   entire set and wiped 19 secrets). Its deploy behaviour is unmeasured and irrelevant —
//   it is banned for the wipe, not for the deploy. Never run it to find out.
//
// VERB 4 — `--commit` / `commitId`. The old claim was a CATEGORY ERROR. A `service_updated`
//   deploy is created by Render, not by this script, so there is no `--commit` in that path
//   to honour or ignore. The deploys this script creates DO honour it: 280 api deploys,
//   including the TRA-3671 bisect, which deployed six commits BY SHA to this same service
//   (f9f4bd7354be, 070a188a5f08, 606be9e5693b, 4ed46445daa3, 8713331519bc, 1ff4fa7be6f1),
//   most of them not the tip. `--commit` is honoured. Pinning is not futile. Pin.
//
// ── THE ENV-ONLY APPLY PATH (this is the instruction that was missing) ───────────────
//   To apply an env-level change on bqb1 with a ZERO-BYTE code delta:
//
//       node scripts/render-redeploy.mjs --commit=<THE SHA ALREADY SERVING>
//
//   i.e. POST /deploys with `commitId` = the currently-live commit. Render materialises
//   env vars into the deploy AT DEPLOY TIME regardless of which commit it targets, so
//   re-deploying the serving commit bakes the new env and ships no code.
//   MEASURED ON THIS SERVICE, the day after TRA-2186's incident: the 07-24 ~15:55Z
//   TRADIER_ENV write was applied by deploys at 15:58:03Z and 16:13:30Z, BOTH of
//   `8a7ecf50eee4` — the commit already live since 12:50:42Z. Same commit in, same commit
//   out, env applied.
//   Get the serving sha from the host itself, never from git:
//       curl -s https://tradingai-bqb1.onrender.com/api/health/options-live \
//         | python -c "import sys,json;b=json.load(sys.stdin)['build'];print(b['commitShort'],b['startedAt'])"
//
// ── `POST /restart` IS NOT AN ENV-APPLY MECHANISM ────────────────────────────────────
//   It re-launches the instance from the EXISTING deploy's spec, i.e. it replays the env
//   snapshot resolved when that deploy was created. A write made AFTER the last deploy is
//   structurally invisible to it. That is why the 2026-08-14T03:53:53Z restart still
//   published `otmFlagOn:true` off a spec built at 02:21:34Z, and why the operator
//   concluded the env write had not taken and escalated to an untargeted deploy.
//
// ── IS A CODE FREEZE THE SAME FREEZE AS AN ENV FREEZE ON THIS HOST? ─────────────────
//   NO — PROVIDED THE OPERATOR PINS. An env-only change can be applied by deploying the
//   serving sha, which is a zero-byte code delta, so an env freeze can be lifted while a
//   code freeze holds. They collapse into ONE freeze only when the apply is UNPINNED,
//   because an unpinned POST /deploys resolves the branch tip and ships whatever landed.
//   The freeze is separable; the separation is bought entirely by `--commit`.
//   (Both remain subject to the RTH freeze and any embargo below: pinning removes the
//   CODE delta, it does not remove the BOOT, and the boot is what resets the soak clock.)
// ─────────────────────────────────────────────────────────────────────────────────

// The one-paragraph version, printed wherever this file used to print the wrong claim.
// Single source of truth on purpose: the defect TRA-3724 fixed was seven copies drifting
// together. If you need to say this somewhere new, CALL this — do not paraphrase it.
// Exported for the same reason: tra2387-auth-secret-gate-check.mjs asserts that this text
// REACHES stdout, and it has to assert on the constant, not on a hand-copied excerpt of it.
// A copy is exactly the drift this comment forbids — and it bit us: that suite pinned the
// literal `service_updated`, TRA-3724 correctly removed the claim, and `pnpm pretest` went
// red on main for everyone until TRA-3744.
export const ENV_WRITE_CAVEAT_SHORT =
  'This gate sees DEPLOYS only. An env/settings write does not pass through it. A SETTINGS\n' +
  '  write (PATCH /services) can still redeploy from the BRANCH TIP unguarded — hold those by\n' +
  '  hand. An ENV-VAR write has produced no deploy on this host since 2026-07-23 (TRA-3724),\n' +
  '  so it applies NOTHING until you deploy: apply it with --commit=<sha already serving>,\n' +
  '  which bakes the env with a zero-byte code delta. --commit IS honoured. POST /restart is\n' +
  '  NOT an env-apply path — it replays the last deploy\'s env snapshot.';

// Report the LIVE setting rather than a compiled belief. The 2026-07-23 -> 08-14 change in
// env-write behaviour is not attributable to any code we own, so a hard-coded claim here
// ages silently; these two fields are the ones that actually govern it. They are TOP-LEVEL
// on the Render service object, not under serviceDetails (TRA-1665).
function envWriteAutoDeployPosture(service) {
  const ad = service?.autoDeploy ?? '(unread)';
  const adt = service?.autoDeployTrigger ?? '(absent)';
  const suppressed = ad === 'no' && adt === 'off';
  return {
    autoDeploy: ad,
    autoDeployTrigger: adt,
    suppressed,
    line:
      `autoDeploy=${ad} autoDeployTrigger=${adt} — ` +
      (suppressed
        ? 'env-var writes are NOT expected to self-deploy here (matches every reading since 2026-07-23)'
        : 'THIS HOST MAY SELF-DEPLOY FROM THE BRANCH TIP ON AN ENV/SETTINGS WRITE — re-read TRA-3724 before writing anything'),
  };
}

// RTH window, in UTC minutes-of-day, matching tra1648_soak_check.mjs.
const RTH_OPEN_MIN = 13 * 60 + 30; // 13:30Z
const RTH_CLOSE_MIN = 20 * 60; // 20:00Z

// What fragments the soak is the BOOT, not the POST. A deploy created at 13:29Z on this
// service finishes and restarts the process ~2–3 min later, i.e. INSIDE RTH — and the
// old gate returned exit 0 for it, so a green run read as "outside the freeze" while the
// box booted mid-session (TRA-2325). The freeze therefore opens a lead time EARLY.
// It does NOT close late: a deploy created at 19:59Z boots after the bell, which is fine
// for RTH itself. (Post-close READS are protected by dated embargoes instead — a general
// close-side buffer would refuse deploys on every day of the year to protect grades that
// only exist on specific days.)
export const DEPLOY_LEAD_MIN = 5;
export const FREEZE_OPEN_MIN = RTH_OPEN_MIN - DEPLOY_LEAD_MIN; // 13:25Z
export const FREEZE_CLOSE_MIN = RTH_CLOSE_MIN; // 20:00Z

// ── Dated embargoes ───────────────────────────────────────────────────────────
// Specific, board-ratified holds on named instants — for when a scarce measurement
// needs a wider or differently-shaped window than the routine daily freeze. Absolute
// UTC instants, so there is no weekday/timezone reasoning to get backwards.
// SELF-EXPIRING: an entry whose `to` is past is inert. Leave expired rows in place as
// a record; delete them only when the ticket is closed.
export const EMBARGOES = [
  {
    from: '2026-07-27T13:25:00Z',
    // EXTENDED 20:20Z -> 21:00Z on 2026-07-26 (CTO, TRA-2306). See the note below the table:
    // the old close opened the window at the exact instant three graded reads fire.
    to: '2026-07-27T21:00:00Z',
    ticket: 'TRA-2322 (CTO-ratified) / TRA-2325 / TRA-2306',
    why:
      'TRA-2213 leg 1 (exit-cadence p99), the TRA-1648 soak sign-off and TRA-2306 all need ONE ' +
      'zero-restart RTH on bqb1, AND an undisturbed post-close read window. A boot resets the ' +
      "doTick tape and the soak clock outright; for TRA-2306 the hazard is different and worse " +
      '(see the rationale note below). Runs to 21:00Z because the graded post-close reads land ' +
      'at 20:10Z / 20:20Z / 20:25Z / 20:30Z / 20:45Z and take minutes to execute.',
  },
  {
    from: '2026-08-06T13:25:00Z',
    // Closes at 20:35Z, NOT 20:00Z and NOT 20:05Z. Same shape defect the row above was
    // fixed for: the reads this protects start at 20:02Z and the last two land at 20:25Z,
    // so a close on the hour would open the window underneath them.
    to: '2026-08-06T20:35:00Z',
    ticket: 'TRA-3066 (QA ask, CTO-accepted) / TRA-3044 / TRA-2956',
    why:
      'TRA-3044 is a PRE-REGISTERED grade of the TRA-2956 stale-working-exit withdrawal on the ' +
      'live book: rubric frozen, nine scheduled session reads, subject row TSLA260911C00555000 ' +
      'entering the bell pre-armed. Its headline observable, staleWorkingExits.holdAttempts, is ' +
      'boot-scoped and is the one arm the code deliberately does not self-heal — a boot inside ' +
      'RTH refills the 8-withdrawal per-row budget, resets the monotonic counters and erases ' +
      'every hold verdict taken before it. The grader fails safe (NOT_CERTIFIABLE_BOOT_SPLIT) ' +
      'rather than green, so the cost of a mid-session boot is the whole session and another ' +
      'day of TRA-2956 blocked, not a wrong answer. The RTH freeze already covers 13:25–20:00Z; ' +
      'this row exists to (a) require a SECOND, separately-reasoned override to defeat the hold ' +
      'and (b) extend it across the post-close reads the freeze does not cover: 20:02Z TRA-3052 ' +
      'stale-working-exit tail, 20:05Z TRA-3044 close fire, 20:25Z TRA-1648 soak check, 20:25Z ' +
      'TRA-2305 tickExitRegionMs. Spent at 20:35Z; the TRA-3057 carrier deploys at 20:40Z.',
  },
  {
    from: '2026-08-13T20:00:00Z',
    // Contiguous with the RTH freeze close (20:00Z) on purpose — no gap. Closes 21:45Z so
    // the 21:50Z TRA-3619 carrier is the FIRST legal deploy after it, which is the one boot
    // this row exists to funnel everything into.
    to: '2026-08-13T21:45:00Z',
    ticket: 'TRA-3625 / TRA-1648 / TRA-3619',
    why:
      'Thu 2026-08-13 post-close carries NINETEEN graded reads between 20:10Z and 21:40Z, and three ' +
      'separate deploy carriers fired at bqb1 inside them (20:30Z TRA-3547, 21:00Z TRA-3387, 21:50Z ' +
      'TRA-3619). Deploying each one separately boots the soak host three times, and the 20:30Z boot ' +
      'lands underneath the 20:25Z TRA-1648 go-live soak gate (7d30dcfc) plus the 20:30/20:40/20:45Z ' +
      'reads. Enumerated from the live routine table at 19:2xZ: 20:10 TRA-3417 098ce476 + TRA-3299 ' +
      '9a576b6f, 20:15 TRA-3394 50d19ffb, 20:20 TRA-3510 384f8725, 20:25 TRA-3417 + TRA-1648 7d30dcfc, ' +
      '20:30 TRA-2536 7e7ab58e + TRA-3505 c839d767, 20:40 TRA-3417, 20:45 TRA-3516 22fbe2f5 + TRA-2879 ' +
      '41c0c68d + TRA-2331 7c3af47e + TRA-2945 ec0f4a75, 21:00 TRA-3419 10c10d02, 21:15 TRA-2242 ' +
      '20d3357e + TRA-2636 8d2c80a9 + TRA-3505 a1cc3e61, 21:30 TRA-1398 6213da0a, 21:40 TRA-2220 ' +
      '5293f29f. The RTH freeze stops at 20:00Z and does NOT cover post-close reads — that gap is what ' +
      'the TRA-2306 and TRA-3066 rows above were each written to patch, one day at a time. ' +
      'NOTHING IS LOST BY WAITING: 8713331 (TRA-3547) and 48a0883 (TRA-3387) are both strict ancestors ' +
      'of the 229af6d tip, and check:deploy-train-window grades a deploy order by ANCESTRY, so the ' +
      'single 21:50Z tip deploy satisfies all three orders at once. Three boots collapse into one.',
  },
  {
    from: '2026-08-14T20:00:00Z',
    // Same shape as the row above, one day later, and written for the same reason: the row
    // above is SPENT at 21:45Z on 08-13 and self-expiring rows do not renew themselves.
    // Contiguous with the RTH freeze close (20:00Z) — no gap. Closes 21:45Z so the 21:50Z
    // TRA-3702 carrier is the FIRST legal deploy after it.
    to: '2026-08-14T21:45:00Z',
    ticket: 'TRA-3702 / TRA-1648 / TRA-3547 / TRA-3701',
    why:
      'Fri 2026-08-14 post-close carries SIXTEEN graded reads between 20:25Z and 21:40Z, and the day ' +
      'opens with THREE separate things wanting to boot bqb1 inside them. Enumerated from the live ' +
      'routine table + the issue monitor column at 03:2xZ. Routines: 20:25 TRA-1648 7d30dcfc, 20:30 ' +
      'TRA-2536 7e7ab58e + TRA-971 81928e50 + TRA-1965 a986323e + TRA-3547 fc05a69f, 20:35 TRA-3619 ' +
      'leg 2 7aa04c72, 20:45 TRA-2331 7c3af47e + TRA-2945 ec0f4a75, 21:15 TRA-2879 41c0c68d + TRA-2636 ' +
      '8d2c80a9, 21:30 TRA-1398 6213da0a + TRA-820 f28ea628 + LeadDev unlinked-monitor census 1aa6b2c1, ' +
      '21:40 TRA-2220 5293f29f. Issue monitors: 20:30 TRA-3660, 20:45 TRA-3464, 21:00 TRA-3442. ' +
      'THE 20:25Z TRA-1648 READ IS NOT THE END OF THE HOLD, IT IS THE START OF IT — TRA-3702 was ' +
      'filed reasoning "not merely after 20:00Z, because a 20:05Z deploy boots the box before the ' +
      '20:25Z re-grade reads it", and then armed its own carrier at 20:35Z, which clears the one read ' +
      'it was watching and lands underneath TRA-3660 (20:30, boot-scoped watchdog lastTrip), TRA-3464 ' +
      '(20:45, RTH-partitioned exit cadence), TRA-3442 (21:00, per-session advisory census) and the ' +
      '21:40Z TRA-2220 liveness watch. That is the identical defect one layer further down, which is ' +
      'why this is a table row and not a note in a ticket: prose that reasons correctly about the ' +
      'read in front of it does not execute against the four behind it. ' +
      'NOTHING IS LOST BY WAITING: the 21:50Z tip deploy carries b4cb1664 (TRA-3702), fe603074 ' +
      '(TRA-3674, whose live-read acceptance is TRA-3701) and 0096adf3 (TRA-3678) in one boot, and ' +
      'check:deploy-train-window grades a deploy order by ANCESTRY. Three boots collapse into one. ' +
      'The fc05a69f 20:30Z fire should read its own STEP 0 the same way it did on 08-13: exit 5 is ' +
      'the correct outcome, do not override, do not archive — 8713331 is already SERVING (it is an ' +
      'ancestor of the live 1ff4fa7b), so that carrier has nothing left to deploy and only a grade ' +
      'to take.',
  },
  {
    from: '2026-09-10T20:00:00Z',
    // Opens at the 09-10 post-close boundary and closes at the 09-11 one, so the next legal
    // commit advance is the 09-11 post-close train. The RTH freeze already owns 13:25–20:00Z;
    // running through it means an RTH override alone cannot spend a second train today.
    // A STOPGAP, one night wide: the durable form is a cadence gate that counts commit
    // advances off Render's history (TRA-4384 child). Until it lands, one row per night.
    to: '2026-09-11T20:00:00Z',
    ticket: 'TRA-4384 (TRA-4383 board ruling A, card c4dd383c: ONE deploy train per day to 2026-09-18)',
    why:
      'The feature freeze caps bqb1 at ONE deploy train per day, and prose did not hold it: the ' +
      'closed 09-09T20:00Z -> 09-10T13:30Z window carried NINE commit-advancing deploys (8e51be03, ' +
      '21b15106, 3955593e, eacd1364, aa12bbcf, e4a1c67b, eb8a1738, 35feb9f7, c54f1e73) by at least ' +
      'three different operators, the CTO who enforces the freeze among them. TONIGHT\'S ONE TRAIN IS ' +
      'SPENT: dep-dahgtvmq advanced c54f1e73 -> b5c76cc1 at 20:11Z; the 20:16Z and 21:09Z deploys were ' +
      'same-SHA env-applies. NOTHING IS LOST BY WAITING: every commit past b5c76cc1 rides the 09-11 ' +
      'post-close train in one boot, and check:deploy-train-window grades a deploy order by ANCESTRY. ' +
      'A same-SHA env-apply (--commit=<sha already serving>) is not a train but still boots the box: ' +
      'run it with --force-embargo-override="<TRA-#### why>" and it is recorded.',
  },
];

// ── Why the 2026-07-27 row closes at 21:00Z, not 20:20Z (TRA-2306, CTO 2026-07-26) ──
//
// TWO defects in the previous row, one of shape and one of rationale. Both are fixed above;
// this note exists so neither gets "corrected" back by someone re-deriving the old reason.
//
// 1. SHAPE — the old 20:20Z close opened the deploy window at the exact instant the reads it
//    exists to protect begin. Derived from the live routine table on 2026-07-26, the graded
//    post-close reads on Mon 2026-07-27 are:
//      20:10Z  d017b173  TRA-2277 parity-reconcile dailySeries
//      20:20Z  0bb90f24  TRA-2306 spread-ceiling grade   <- the first session under the gate
//      20:20Z  dcedeb43  TRA-2171/2213 doTick tape grade
//      20:25Z  7d30dcfc  TRA-1648 soak check             <- named in this very embargo
//      20:30Z  f97baf3b  TRA-2339 decided-throttle run check
//      20:45Z  7c3af47e  TRA-2331 · e3e69d35 TRA-1585
//    A deploy CREATED at 20:20:00Z BOOTS the box ~2-3 min later — i.e. inside all of them. That
//    is the same created-vs-boots confusion DEPLOY_LEAD_MIN fixes on the open side (TRA-2325),
//    left unfixed on the close side. The old row's stated derivation ("reads land at 20:02Z and
//    20:15Z") matches no routine in the table.
//
// 2. RATIONALE — "TRA-2306 is graded off in-memory counters that reset on boot" is FALSE on this
//    host. Do not cite it, and do not let its falseness be read as "the TRA-2306 hold is
//    unfounded" (it is exactly the kind of dead premise that invites --force-embargo-override).
//    hydrateCostAwareGateFromDisk re-apply()s every /data record inside the 7-day retention back
//    into the same byDay map, with no exclude-today filter — so the CURRENT day's counters are
//    rebuilt by the boot. What actually threatens the read:
//      a. the hydrate COMPACTS — it rewrites the JSONL to only the lines it kept. A boot onto a
//         wiped or repointed DATA_DIR hydrates empty and then rewrites the file to empty,
//         destroying `retained` PERMANENTLY rather than zeroing a day view (TRA-2319, and the
//         TRA-2136 env-wipe class is the live way to get there). Every health field reads like an
//         ordinary deploy either way.
//      b. a build swap mid-read: 502 on every route while it is in flight, and the grader cannot
//         tell that from an outage.
//      c. TRA-2355 changes the cost-aware-gate counters themselves — the instrument TRA-2306 is
//         grading. Landing it on main is safe (autoDeploy: no); shipping it into the graded
//         session is not.
//
// This row is spent at 21:00Z on 2026-07-27. Grades are published from the reads above, so if you
// need a deploy that evening, take it after 21:00Z rather than overriding.

// ── The CADENCE CEILING (TRA-4535, off TRA-4384) — exit 10 ────────────────────
// Every other gate here answers a question about ONE deploy: is it the right hour, the right
// commit, will it boot, does it go backwards. None of them can COUNT. So a ceiling on how many
// deploys a night may carry could only be written as prose, and prose did not hold. Board
// ruling A (TRA-4383, card c4dd383c) caps bqb1 at ONE deploy train per day through Fri
// 2026-09-18. The closed window 2026-09-09T20:00Z → 09-10T13:30Z carried NINE commit advances,
// by at least three operators, the freeze's own enforcer among them, and every one passed every
// gate in this file, because no gate could see the ceiling. A freeze that reads "in force"
// identically whether it holds or not is the silent-green class.
//
// The stopgap was a dated EMBARGOES row per night. It works, but somebody has to write it by
// hand every night, which is the "one day at a time" defect the notes above already name. It
// also LOST A RACE on its first night: the 09-10 row was committed at 22:07:00Z, and that
// window's second advance (dep-dahik9m1, b5c76cc1 → 05be2d16) was created at 22:07:34Z from a
// checkout that did not hold it. A ceiling row covers the whole freeze, so every checkout from
// the day it lands carries it, and the count comes from Render, not from whoever last wrote a row.
//
// WHAT IS COUNTED. A COMMIT ADVANCE is a deploy whose commit differs from the commit of the
// counting deploy before it, in creation order. Failed and canceled deploys never changed what
// served, so they are skipped: they neither count nor move the baseline. A same-SHA redeploy (the
// env-apply path, --commit=<sha already serving>) is not a train. It is never counted, and it is
// never refused. A deploy still IN FLIGHT does count: an advance somebody else created two minutes
// ago is this window's train whether or not it has booted yet.
//
// THE WINDOW is [D 20:00Z, D+1 20:00Z): a 24h day anchored at the close. TRA-4535 first
// specified [D 20:00Z, D+1 13:25Z), the post-close deploy slot. On a weekday the two count the same
// deploys, because the RTH freeze already refuses everything in 13:25–20:00Z. They differ in two
// places, and in the spec's shape both are holes:
//   · a deploy made INSIDE RTH with --force-rth-override falls in no post-close window, so it
//     would be a second train for free. The CTO's own stopgap row ran 20:00Z → 20:00Z for this
//     reason: "an RTH override alone cannot spend a second train today";
//   · the RTH freeze does not run at weekends, so Sat/Sun 13:25–20:00Z would be counted by
//     nothing, and the ceiling row spans the 09-12/13 weekend.
// Half-open at 20:00Z: a deploy created at 19:59:59Z belongs to the previous window.
//
// FAILS CLOSED, like every other gate here. A deploy history that cannot be read, or that cannot
// be shown to reach back past the window's start (the first advance needs a baseline to be an
// advance FROM), is BLIND ⇒ REFUSE. A spent window with an unreadable live commit is also BLIND,
// because the same-SHA exemption cannot then be shown. An EMPTY window proceeds without either,
// since there is nothing to be exempted from.
//
// DATED, and inert outside a row. The ceiling is a board ruling with an end date, not a standing
// rule, and a gate that outlived the ruling would be a rule nobody ratified. A row is half-open
// [from, to) like EMBARGOES, and advances created before the row's `from` are not counted.
// Leave spent rows in place as a record.
export const CADENCE_WINDOW_OPEN_MIN = FREEZE_CLOSE_MIN; // 20:00Z — the window rolls at the close
const DAY_MS = 24 * 60 * 60 * 1000;

export const CADENCE_CEILINGS = [
  {
    from: '2026-09-08T18:50:00Z',
    to: '2026-09-19T04:00:00Z',
    ticket: 'TRA-4384 (TRA-4383 board ruling A, card c4dd383c: ONE deploy train per day to 2026-09-18)',
    max: 1,
    why:
      'The feature freeze caps bqb1 at ONE deploy train per day, and prose did not hold it: 5 commit ' +
      'advances in the 09-08 window, 9 in the 09-09 window, and 2 by 22:08Z in the 09-10 window ' +
      '(the second one 34s after that night\'s stopgap embargo was committed). NOTHING IS LOST BY ' +
      'WAITING: every commit on main rides the next window\'s train in one boot, and ' +
      'check:deploy-train-window grades a deploy order by ANCESTRY.',
  },
];

// Render deploy statuses that never changed what the host served. Everything else counts, and
// that includes a status this list has never seen: an unrecognised status is counted, never
// waved through, so a new Render verb over-counts rather than opening the gate.
export const CADENCE_NON_COUNTING_STATUSES = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']);

// The window `now` falls in: the most recent 20:00Z at or before `now`, for 24h.
export function cadenceWindow(now) {
  const t = now.getTime();
  let start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + CADENCE_WINDOW_OPEN_MIN * 60000;
  if (start > t) start -= DAY_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export function activeCadenceCeiling(now, table = CADENCE_CEILINGS) {
  const t = now.getTime();
  return table.find(c => t >= Date.parse(c.from) && t < Date.parse(c.to)) ?? null;
}

// Where counting starts: the window's start, or the row's `from` if the row began inside the
// window. An advance from before the ceiling existed is not a breach of it.
export function cadenceLowerBound(now, ceiling) {
  return Math.max(cadenceWindow(now).start.getTime(), Date.parse(ceiling.from));
}

// One deploy-list row, as Render returns it (`{deploy, cursor}`) or already unwrapped.
function cadenceRow(entry) {
  const d = entry?.deploy ?? entry;
  return {
    id: typeof d?.id === 'string' ? d.id : '(no id)',
    commit: typeof d?.commit?.id === 'string' ? d.commit.id : null,
    status: typeof d?.status === 'string' ? d.status : '(no status)',
    createdAt: d?.createdAt ?? null,
    t: Date.parse(d?.createdAt),
  };
}

export function cadenceRowCounts(row) {
  return !CADENCE_NON_COUNTING_STATUSES.has(row.status);
}

// Pure. `history` = { rows: [Render deploy entries], exhausted: boolean }, where `exhausted` says
// the rows are the service's WHOLE history, so that "no deploy before the window" is a fact about
// the service and not about pagination. Counts over [lower, upper).
//   → { advances, sameSha, skipped, baseline } | { blind: why }
export function countCommitAdvances(history, lower, upper) {
  const rows = (history?.rows ?? []).map(cadenceRow);
  const undated = rows.find(r => !Number.isFinite(r.t));
  if (undated) return { blind: `deploy ${undated.id} carries no readable createdAt, so it cannot be placed in or out of the window` };
  rows.sort((a, b) => a.t - b.t);

  const before = rows.filter(r => r.t < lower && cadenceRowCounts(r));
  let baseline;
  if (before.length) baseline = before[before.length - 1].commit;
  else if (history?.exhausted) baseline = null; // the service's first deploy ever is an advance
  else {
    return {
      blind:
        `the deploy history read does not reach back past ${new Date(lower).toISOString()}, so the window's ` +
        'first deploy has nothing to be an advance FROM',
    };
  }

  const advances = [];
  const sameSha = [];
  const skipped = [];
  let prev = baseline;
  for (const r of rows) {
    if (r.t < lower || r.t >= upper) continue;
    if (!cadenceRowCounts(r)) {
      skipped.push(r);
      continue;
    }
    // A row with no commit is COUNTED: "cannot tell whether it moved" is not "it did not move".
    if (r.commit && prev && sameCommitSha(r.commit, prev)) sameSha.push(r);
    else advances.push({ ...r, from: prev });
    prev = r.commit;
  }
  return { advances, sameSha, skipped, baseline };
}

// The predicate main() evaluates. Pure: `history` from fetchDeployHistory, `target` from
// resolveTarget, `live` from fetchLiveCommit, all injected.
//   INERT     no ceiling row covers `now`                           ⇒ proceed
//   CLEAR     the window holds fewer advances than the ceiling       ⇒ proceed
//   SAME_SHA  the window is spent, but the target IS the live build  ⇒ proceed (not a train)
//   SPENT     the window is spent and this deploy would advance      ⇒ REFUSE
//   BLIND     the count or the same-SHA exemption cannot be shown    ⇒ REFUSE
export function cadenceState(now, { history, target, live }, table = CADENCE_CEILINGS) {
  const ceiling = activeCadenceCeiling(now, table);
  const window = cadenceWindow(now);
  const base = { ceiling, window, target, live, advances: [], sameSha: [], skipped: [], why: null };
  if (!ceiling) return { ...base, verdict: 'INERT' };
  if (!history || history.error || !Array.isArray(history.rows)) {
    return { ...base, verdict: 'BLIND', why: history?.error ?? 'the deploy history was not read' };
  }
  const c = countCommitAdvances(history, cadenceLowerBound(now, ceiling), window.end.getTime());
  if (c.blind) return { ...base, verdict: 'BLIND', why: c.blind };
  const at = { ...base, advances: c.advances, sameSha: c.sameSha, skipped: c.skipped };
  if (c.advances.length < ceiling.max) return { ...at, verdict: 'CLEAR' };
  if (!target?.sha) return { ...at, verdict: 'BLIND', why: target?.error ?? 'the target commit could not be resolved' };
  if (!live?.sha) {
    return {
      ...at,
      verdict: 'BLIND',
      why: `${live?.error ?? 'the live commit could not be read'}, so whether this deploy is a same-SHA redeploy (not a train) cannot be shown`,
    };
  }
  // Prefix equality, not `===`: --commit is passed through verbatim, so a 7-char pin against the
  // 40-char live sha is the NORMAL case (the stalePinNote lesson, TRA-3625).
  if (sameCommitSha(target.sha, live.sha)) return { ...at, verdict: 'SAME_SHA' };
  return { ...at, verdict: 'SPENT' };
}

export function cadenceBlocks(verdict) {
  return verdict === 'SPENT' || verdict === 'BLIND';
}

// The override must name A ticket, not necessarily the ceiling's own. What it is proving is
// that the second train has an owner who will answer for it, and the owner's ticket is the one
// that says why it could not wait.
export function cadenceOverrideNamesTicket(reason) {
  return /\bTRA-\d+\b/i.test(String(reason ?? ''));
}

const cadenceAt = r => (Number.isFinite(r.t) ? new Date(r.t).toISOString() : '(undated)');
const cadenceWin = w => `[${w.start.toISOString().replace(':00.000Z', 'Z')}, ${w.end.toISOString().replace(':00.000Z', 'Z')})`;

function cadenceAdvanceLines(state) {
  const lines = state.advances.map(
    a => `    · ${cadenceAt(a)}  ${a.id}  ${a.from ? a.from.slice(0, 8) : '(none)'} → ${a.commit ? a.commit.slice(0, 8) : '(no commit)'}  [${a.status}]`,
  );
  lines.push(
    `    (+ ${state.sameSha.length} same-SHA redeploy(s) and ${state.skipped.length} failed/canceled deploy(s) in the window — not counted)`,
  );
  return lines;
}

export function renderCadenceRefusal(state) {
  const c = state.ceiling;
  const head =
    state.verdict === 'SPENT'
      ? `[render-redeploy] REFUSED: this deploy would be commit advance #${state.advances.length + 1} in a window whose ceiling is ${c.max} — TRA-4535.`
      : `[render-redeploy] REFUSED: the cadence ceiling cannot be checked, so this gate is BLIND and fails closed — TRA-4535.`;
  return [
    head,
    `  ceiling : at most ${c.max} commit advance(s) per window, ${c.from} → ${c.to} — ${c.ticket}`,
    `  window  : ${cadenceWin(state.window)}`,
    ...(state.why ? [`  blind   : ${state.why}`] : []),
    `  counted : ${state.advances.length} advance(s)${state.advances.length ? ':' : ''}`,
    ...(state.advances.length || state.sameSha.length || state.skipped.length ? cadenceAdvanceLines(state) : []),
    `  live    : ${state.live?.sha ? short(state.live.sha) : '(unreadable)'}`,
    `  target  : ${state.target?.sha ? short(state.target.sha) : '(unresolved)'}  [${state.target?.source ?? '?'}]`,
    `  ${c.why}`,
    `  The next window opens ${state.window.end.toISOString().replace(':00.000Z', 'Z')}. A same-SHA env-apply is not a train and is not`,
    `  refused: --commit=<the sha ALREADY SERVING>. If a second train genuinely cannot wait, re-run with`,
    `  --override-cadence="TRA-#### why this cannot wait" (it must name a ticket, and it is echoed on the record).`,
    `  NOTE: ${ENV_WRITE_CAVEAT_SHORT}`,
  ].join('\n');
}

// The one-line summary on a run that proceeds. Never silent: a green run must say how much of
// the night it spent, or "the gate passed" reads the same at 0 advances and at 1.
export function renderCadenceLine(state, { isSoakHost = true, overridden = false } = {}) {
  if (!isSoakHost) return '(not the soak host — cadence gate N/A)';
  if (state.verdict === 'INERT') return 'no CADENCE_CEILINGS row covers this instant — gate inert';
  const n = `${state.advances.length}/${state.ceiling.max} advance(s) in ${cadenceWin(state.window)} (${state.ceiling.ticket.split(' ')[0]})`;
  if (state.verdict === 'SAME_SHA') return `${n} — SPENT, but the target is the SAME build as live: not a train`;
  if (state.verdict === 'CLEAR') {
    const advance = state.live?.sha && state.target?.sha ? !sameCommitSha(state.target.sha, state.live.sha) : null;
    return `${n} — ${
      advance === null ? 'whether this deploy advances is unknown (live unread)' : advance ? 'THIS DEPLOY IS A TRAIN and spends the window' : 'this deploy is a same-SHA redeploy, not a train'
    }`;
  }
  return `${n} — ${state.verdict}${overridden ? ', OVERRIDDEN (--override-cadence)' : ''}`;
}

// ── Held commits ──────────────────────────────────────────────────────────────
// The two gates above answer "may I deploy NOW?". Neither can answer "may I deploy THIS?" —
// and some holds are on the CONTENT, not the calendar. A commit that changes an instrument
// while a measurement is pending must not ship, and the window in which it must not ship
// starts the moment it lands on main, not when the embargo opens.
//
// Before this table, such a hold was carried by a ⚠ line in the commit message and a
// paragraph of comment in this file. Neither executes. `git push` is not a deploy here
// (autoDeploy: no), so landing is safe — but the very next routine deploy takes the branch
// TIP, and `--commit` is OPTIONAL, so a caller who never typed a sha ships whatever landed
// last. The gate printed `commit : (service branch tip)` for that, which reads identically
// whether the tip is benign or is the held commit.
//
// SELF-EXPIRING, like EMBARGOES: a row whose `until` is past is inert. Leave expired rows
// in place as a record; delete them when the ticket closes.
export const COMMIT_HOLDS = [
  {
    commit: '204f2984896d62447d6a480c7f7c346b5071a5f6',
    until: '2026-07-27T21:00:00Z',
    ticket: 'TRA-2355 (held for TRA-2306)',
    why:
      'TRA-2355 gives the cost-aware-gate spread counters an ACCOUNT axis — it re-keys the ' +
      'very tally TRA-2306 grades at 20:20Z Mon 2026-07-27, the first session under the ' +
      'TRA-2295 ceiling. Its own commit message says DO NOT DEPLOY before that grade ' +
      'publishes. Shipping it early does not merely add a field: pre-TRA-2355 records ' +
      'hydrate as `unattributed`, never `desk`, so the desk cell reads n=0 for the whole ' +
      'retained history and the grade lands NOT GRADED YET / VOID on an instrument that ' +
      'changed under it. Deploy any commit that does NOT carry it, or wait until 21:00Z.',
  },
];

// Does a deploy of `target` carry a held commit? `target` is resolved by the caller (see
// resolveTarget) and injected so this predicate stays pure and testable:
//   { sha, source, error?, carries(heldSha) -> true | false | null }
// `carries` returns null for "cannot tell", which is NOT the same as false.
//
// FAILS CLOSED on purpose, in the same spirit as check:deploy-drift's BLIND: an
// unresolvable tip or an ungrepable object yields REFUSE, never PROCEED. A hold that
// silently degrades to "allowed" the moment the network hiccups is not a hold.
// The grader itself now lives in scripts/lib/shallow-ancestry.mjs and is re-exported from
// here unchanged (TRA-3721). It moved because the same predicate was needed by two more
// call sites — tra2342's --self-test and tra2306's build detector — and three independent
// copies of a fail-open fix is how one of them drifts back. The names, the verdict strings
// and the row order are identical to what shipped in 12305eba; tra2325-embargo-gate-check.mjs
// keeps driving `gradeCarries` through this module's exports.
export { BLIND_ANCESTRY_CAUSES, gradeCarries, carriesFromVerdict, isShallowCheckout };

export function commitHoldState(now, target, table = COMMIT_HOLDS) {
  const t = now.getTime();
  const active = table.filter(h => t < Date.parse(h.until));
  if (active.length === 0) return { verdict: 'CLEAR', hold: null, active, target, why: null };

  if (!target || !target.sha) {
    return {
      verdict: 'BLIND',
      hold: active[0],
      active,
      target,
      why: target?.error ?? 'the target commit could not be resolved',
    };
  }

  for (const hold of active) {
    const carries = target.carries(hold.commit);
    if (carries === null) {
      return {
        verdict: 'BLIND',
        hold,
        active,
        target,
        why: `cannot test whether ${target.sha.slice(0, 12)} carries ${hold.commit.slice(0, 12)} (${BLIND_ANCESTRY_CAUSES})`,
      };
    }
    if (carries) return { verdict: 'CARRIES', hold, active, target, why: null };
  }
  return { verdict: 'CLEAR', hold: null, active, target, why: null };
}

// ── Gate −1: the repo-resident DEPLOY HOLD (TRA-4261) ─────────────────────────
// Every gate above is a TABLE IN THIS FILE. That is right for the ones it is right for —
// the RTH window is a property of the market, and a commit hold is keyed on a sha nobody
// can write without a commit. It is wrong for the case this gate exists for: a hold that
// is opened and closed by a BOARD DECISION on a running week, by whoever is holding the
// ticket, possibly not the owner of this script.
//
// THE CONDITION THAT PRODUCED IT (TRA-4261, off TRA-4217, 2026-09-01). `e1dbf341`
// (TRA-4218) landed on main. It runs at SNAPSHOT IMPORT — at boot — and on the three open
// real-money rows in Tradier ***0154 it deletes `closeRejectCount`, drops the
// `close_reject` `exitBreakerTrip`, and re-arms the exit path through one backoff step.
// This script ships the TIP, not a pin. So any owner deploying bqb1 for an entirely
// unrelated reason performed that migration on live money — and NOTHING IN THE REPO SAID
// SO. The only signal was prose in a ticket thread, and prose in a ticket thread is not a
// gate: it does not execute, and it is not discoverable from the code you are shipping.
//
// WHY A FILE AND NOT ANOTHER TABLE HERE. Three properties a table cannot have:
//   1. `git log ops/deploy-hold.json` is the hold's whole history, in one command, with
//      no ticket access. A table row is buried in the diff of a 1400-line script.
//   2. It ships on the tip, so the artefact and the warning about the artefact travel
//      together. Editing it is a one-file diff a reviewer can read in ten seconds.
//   3. It has no `until`. EMBARGOES and COMMIT_HOLDS are self-expiring because they
//      protect a measurement that finishes. This protects a DECISION that has not been
//      taken, and a decision does not expire on a clock — inventing an expiry for it would
//      hand the answer to the calendar. It clears when somebody deletes the entry, which
//      is a recorded, attributable act.
//
// FAILS CLOSED, in the same spirit as gates 2 and 4. Unparseable JSON, a non-array
// `holds`, or a hold missing a required field is BLIND ⇒ REFUSE. A hold file that
// silently degrades to "allowed" the moment somebody fat-fingers a comma is not a hold.
// The one thing that reads CLEAR is an ABSENT file or an EMPTY `holds` array, and that is
// deliberate: it is the state this repo was in before this commit, and AC2 of TRA-4261 is
// that behaviour with no hold present is unchanged.
//
// ⚠ NAMED LIMITATION, so nobody reads more into this than it does: the hold is a
// convention, not a permission system. Anyone who can deploy can delete the file. That is
// accepted on purpose and is the same reason `--override-hold` exists at all — a hold that
// cannot be broken gets deleted instead of respected, and a deletion leaves a much worse
// record than an override does. What this gate buys is that the deploy is a DECISION
// somebody took and signed, instead of a side effect nobody saw.
export const DEPLOY_HOLD_FILE = 'ops/deploy-hold.json';
// `enumeratedTip` joined this list on TRA-4262. It is required for the same reason `emits`
// is: an `emits` array with no tip stamped beside it is an enumeration of A deploy, not of
// THIS one, and nothing in the file says which. Requiring it costs one `git rev-parse` at
// the moment the hold is written and makes staleness answerable in one command
// (`git log <enumeratedTip>..origin/main`) instead of undetectable by inspection.
//
// `enumeratedFromLivePin` joined it on TRA-4268, and AC1 of that ticket asks for the call
// to be DELIBERATE rather than a side effect, so here it is in full:
//
//   WHAT IT COSTS. Every hold missing the field reads BLIND ⇒ exit 9. That is fail-closed
//   in direction (both HELD and BLIND refuse; nothing is admitted that was not admitted
//   before) but it is NOT free: a BLIND read discards `holds`, so the operator is shown
//   "fix the file" instead of the hold's `reason` and `emits`. It also widens a malformed
//   hold's refusal to services the hold does not cover, because validation runs before
//   scoping. Both of those are already true of `enumeratedTip` and are accepted for the
//   same reason.
//   WHAT IT COSTS TODAY, MEASURED not assumed: `ops/deploy-hold.json` carries exactly ONE
//   hold (TRA-4217) and it already stamps the field (backfilled by `74a8c5aa`). So the
//   live behaviour change on this repo, right now, is NIL — and the suite's LIVE arm
//   drives the real reader against the committed file, so a regression is loud.
//   WHY REQUIRED AND NOT MERELY GRADED. The baseline is not decoration on the list, it is
//   the list's START POINT. A hold that stamps a head and no start describes the window
//   `<somebody's tip>..<head>` while a deploy ships `<live pin>..<tip>` — which on the
//   TRA-4217 hold differed by 22 commits, 13 of them shipping server bytes, under FOUR
//   consecutive re-takes that were each individually correct. Grading it without requiring
//   it leaves that hole re-acquirable by whoever writes the next hold, which is exactly
//   the failure mode this ticket exists to close. The stamp costs one `curl` the author is
//   already told to run.
const DEPLOY_HOLD_REQUIRED_FIELDS = [
  'ticket',
  'reason',
  'openedAt',
  'openedBy',
  'emits',
  'enumeratedTip',
  'enumeratedFromLivePin',
];

// The leading commit sha of a stamp field. `enumeratedFromLivePin` carries the sha AND the
// provenance that makes it checkable by a human — which boot (`startedAt`), off which
// route, at what time, and that it was RE-READ rather than recalled. That prose is load
// bearing (a pin recalled instead of re-read is the staleness this whole section exists to
// name), so the field is PARSED rather than required to be bare.
// FAILS CLOSED: prose with no leading hex token yields null, and null is UNSTAMPED —
// never "it says something, it is probably fine".
export function extractShaPrefix(v) {
  const m = /^\s*`?([0-9a-f]{7,40})\b/i.exec(String(v ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// Read + VALIDATE the hold file. Separated from the predicate below so the predicate stays
// pure and the control suite can drive it with injected rows (the TRA-3699 lesson: a
// commit-hold suite that injected every input never once reached the real predicate).
// Returns { verdict: 'CLEAR' | 'HOLDS' | 'BLIND', holds, why, path }.
export function readDeployHolds(root = REPO_ROOT, file = DEPLOY_HOLD_FILE) {
  const path = new URL(file, pathToFileURL(root.endsWith('/') ? root : `${root}/`));
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the ONLY clear read. Anything else (EACCES, EISDIR, an I/O error) is a
    // file we cannot rule out the contents of, and that is BLIND, not clear.
    if (err && err.code === 'ENOENT') return { verdict: 'CLEAR', holds: [], why: null, path: file };
    return { verdict: 'BLIND', holds: [], why: `${file} could not be read (${err?.code ?? err?.message ?? err})`, path: file };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { verdict: 'BLIND', holds: [], why: `${file} is not valid JSON (${err?.message ?? err})`, path: file };
  }
  const holds = doc?.holds;
  if (!Array.isArray(holds)) {
    return { verdict: 'BLIND', holds: [], why: `${file} has no \`holds\` array (found ${typeof holds})`, path: file };
  }
  for (const [i, h] of holds.entries()) {
    if (!h || typeof h !== 'object') {
      return { verdict: 'BLIND', holds: [], why: `${file} holds[${i}] is not an object`, path: file };
    }
    const missing = DEPLOY_HOLD_REQUIRED_FIELDS.filter(k => {
      const v = h[k];
      if (k === 'emits') return !Array.isArray(v) || v.length === 0;
      // TRA-4268: this one is required to carry a READABLE SHA, not merely to be non-empty.
      // A baseline nobody can parse is a baseline nobody can check, and the check is the
      // whole point of the field.
      if (k === 'enumeratedFromLivePin') return !extractShaPrefix(v);
      return typeof v !== 'string' || !v.trim();
    });
    if (missing.length) {
      // Present-but-unparseable is a different mistake from absent, and an operator told
      // "missing enumeratedFromLivePin" while staring at a populated field will go looking
      // for the wrong bug.
      const pin = h.enumeratedFromLivePin;
      const detail =
        missing.includes('enumeratedFromLivePin') && typeof pin === 'string' && pin.trim()
          ? ` (enumeratedFromLivePin is PRESENT but carries no leading commit sha — it must START with the` +
            ` sha the box is running, provenance after it: ${JSON.stringify(pin.trim().slice(0, 48))}…)`
          : '';
      return {
        verdict: 'BLIND',
        holds: [],
        // Name the ticket if we can read it — a refusal that says "holds[0]" makes the
        // operator open the file to find out who to talk to.
        why: `${file} holds[${i}]${typeof h.ticket === 'string' ? ` (${h.ticket})` : ''} is missing required field(s): ${missing.join(', ')}${detail}`,
        path: file,
      };
    }
  }
  return { verdict: holds.length ? 'HOLDS' : 'CLEAR', holds, why: null, path: file };
}

// Which Render service is this invocation ACTUALLY going to talk to, decided WITHOUT the
// network? Mirrors resolveService() exactly, including its precedence: RENDER_SERVICE_ID
// wins outright and the name is not consulted. Mirroring rather than re-deriving is the
// point — a scoping rule that disagrees with the resolver is a hold on the wrong host.
export function requestedServiceRef(idEnv = SERVICE_ID_ENV, nameEnv = SERVICE_NAME) {
  return idEnv ? { kind: 'id', value: idEnv } : { kind: 'name', value: nameEnv };
}

// Does `hold` cover the service this invocation is aimed at? A hold with no `service` key
// covers EVERY service — that is the fail-closed default, so an under-specified hold holds
// too much rather than too little.
export function deployHoldCoversService(hold, ref) {
  const scope = hold?.service;
  if (!scope || (!Array.isArray(scope.ids) && !Array.isArray(scope.names))) return true;
  const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const list = ref.kind === 'id' ? scope.ids : scope.names;
  return Array.isArray(list) && list.some(v => eq(v, ref.value));
}

// The predicate main() evaluates. Pure: no fs, no network, no clock (a hold has no expiry
// on purpose — see the block comment above).
//   BLIND     the file exists and could not be trusted  ⇒ REFUSE
//   HELD      at least one hold covers this service     ⇒ REFUSE
//   OUT_OF_SCOPE  holds exist, none covers this service ⇒ proceed, but SAY SO
//   CLEAR     no holds at all                           ⇒ proceed silently (AC2)
export function deployHoldState(read, ref) {
  if (read.verdict === 'BLIND') return { verdict: 'BLIND', applicable: [], skipped: [], why: read.why, ref };
  const applicable = read.holds.filter(h => deployHoldCoversService(h, ref));
  const skipped = read.holds.filter(h => !deployHoldCoversService(h, ref));
  if (applicable.length) return { verdict: 'HELD', applicable, skipped, why: null, ref };
  if (skipped.length) return { verdict: 'OUT_OF_SCOPE', applicable, skipped, why: null, ref };
  return { verdict: 'CLEAR', applicable, skipped, why: null, ref };
}

export function deployHoldBlocks(verdict) {
  return verdict === 'HELD' || verdict === 'BLIND';
}

// ── Gate −1b: is the hold's blast-radius enumeration STILL CURRENT? (TRA-4262) ─
// `emits` is the field that earns this whole mechanism — it is what lets the next owner
// decide without asking anyone. But it is a SNAPSHOT OF A MOVING TIP. This script ships
// the tip, never a pin (TRA-3888), so the set of bytes a hold is holding back GROWS with
// every push while the `emits` array stays exactly where it was typed.
//
// That is not hypothetical and it is not "someone forgot to update a file". On 2026-09-01
// TWO independent enumerations of the SAME deploy went stale inside thirty minutes: the
// TRA-4217 hold's `emits` (written at 14:32Z against `4e0f4438`) and card `438ed4c5`'s
// scope on TRA-4217. `77047ea0` (TRA-4255) was already in the box and named in neither;
// `8061bbf6` (TRA-4154) landed while this ticket was being written.
//
// THE STRUCTURAL POINT: an UNPINNED deploy authorization cannot be enumerated in advance.
// The enumeration is an act performed AT CLEAR TIME, by the clearer. `clearedBy` on the
// TRA-4217 entry now says so, and this gate makes the drift LOUD instead of invisible —
// which is the whole thesis of TRA-4261 applied to TRA-4261's own artefact.
//
// ⚠ THIS IS AN AUGMENTATION, NEVER A VERDICT. It cannot turn CLEAR into REFUSE and it
// cannot lift a hold. A hold that applies already refuses; this only tells the operator
// reading that refusal that the `emits` they are about to trust describes an older tip.
// Making staleness itself refuse would be a gate on a HOUSEKEEPING property, and the first
// person it inconvenienced would delete the stamp rather than re-enumerate.
//
// ⚠ OFFLINE BY DESIGN. Gate −1 needs nothing from the network — that property is load
// bearing (it is why the refusal lands before RENDER_API_KEY is read), so the comparison
// sha comes from the LOCAL remote-tracking ref, not from `git ls-remote`. The consequence
// is stated in the refusal rather than hidden: a local `origin/main` behind the real one
// makes the reported delta a LOWER BOUND. It can under-report drift, never invent it.
export const DEPLOY_HOLD_ENUM_REF = 'origin/main';

// Two shas name the same commit if either is a prefix of the other, ≥7 hex. Abbreviated
// shas are what people paste into JSON, and a stamp that only matched at 40 chars would
// read STALE against its own tip.
export function sameCommitSha(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(x) || !/^[0-9a-f]{7,40}$/.test(y)) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short);
}

// Is this path a SERVER BYTE — something the Render build compiles and the box then runs?
// Deliberately one-sided: `packages/**` minus tests is what this classifier can RECOGNISE,
// and everything else is `other`, NEVER "clean". `scripts/` and `ops/` do not ship in the
// server image today, but "the classifier did not recognise it" is a different sentence
// from "it is inert", and only the operator can say the second one.
export function isServerBytePath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  if (!s.startsWith('packages/')) return false;
  if (/(^|\/)__tests__\//.test(s)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(s)) return false;
  if (/\.(md|snap)$/.test(s)) return false;
  return true;
}

// Pure. `probe` is injected so the control suite can drive every status without a repo
// (and so the LIVE arm can drive the REAL one) — the TRA-3699 lesson again.
//   probe.head()            -> { sha, source, error? }
//   probe.delta(tip, head)  -> { ok, commits: [{sha, subject}], paths: [string], shallow, error? }
// Statuses:
//   UNSTAMPED  no `enumeratedTip` — nothing says which tip `emits` describes
//   CURRENT    the enumeration was taken against exactly what is about to ship
//   STALE      N commits have landed since the enumeration  ⇒ SAY SO, LOUDLY
//   DIVERGED   the shas differ and the target is not ahead — cannot claim CURRENT
//   BLIND      git could not answer. Never collapsed into CURRENT (see gradeCarries).
export function deployHoldStaleness(hold, probe) {
  const tip = typeof hold?.enumeratedTip === 'string' ? hold.enumeratedTip.trim() : '';
  const base = {
    tip: tip || null,
    enumeratedAt: typeof hold?.enumeratedAt === 'string' ? hold.enumeratedAt : null,
    head: null,
    source: null,
    commits: [],
    paths: [],
    serverPaths: [],
    why: null,
  };
  if (!tip) {
    return {
      ...base,
      status: 'UNSTAMPED',
      why: 'the hold carries no `enumeratedTip`, so nothing in the file says which tip its `emits` describes (TRA-4262)',
    };
  }
  const head = probe.head();
  if (!head?.sha) {
    return { ...base, status: 'BLIND', why: head?.error ?? 'could not resolve the sha this deploy would ship' };
  }
  const at = { ...base, head: head.sha, source: head.source ?? null };
  if (sameCommitSha(tip, head.sha)) return { ...at, status: 'CURRENT' };
  const delta = probe.delta(tip, head.sha);
  if (!delta?.ok) {
    return { ...at, status: 'BLIND', why: delta?.error ?? `could not list ${tip.slice(0, 12)}..${head.sha.slice(0, 12)}` };
  }
  const commits = Array.isArray(delta.commits) ? delta.commits : [];
  const paths = Array.isArray(delta.paths) ? delta.paths : [];
  if (commits.length === 0) {
    // The shas differ and nothing is in tip..head. Either the target is BEHIND the stamp,
    // or the two diverged — or the history between them was grafted away by a shallow
    // clone, which produces the identical empty list (TRA-3699). An empty answer out of a
    // shallow checkout is NOT evidence of currency, so it is graded BLIND, not DIVERGED.
    if (delta.shallow) {
      return {
        ...at,
        status: 'BLIND',
        why: `${tip.slice(0, 12)}..${head.sha.slice(0, 12)} is empty in a SHALLOW checkout — a graft hides history, so this is not evidence the enumeration is current (${BLIND_ANCESTRY_CAUSES})`,
      };
    }
    return {
      ...at,
      status: 'DIVERGED',
      why: `nothing is in ${tip.slice(0, 12)}..${head.sha.slice(0, 12)}, yet the shas differ — the stamped tip is not an ancestor of what would ship`,
    };
  }
  return { ...at, status: 'STALE', commits, paths, serverPaths: paths.filter(isServerBytePath) };
}

export function deployHoldStalenessIsLoud(status) {
  return status === 'STALE' || status === 'UNSTAMPED' || status === 'DIVERGED' || status === 'BLIND';
}

// The refusal lines for one hold's staleness. Pure, and returns [] for CURRENT — a hold
// whose enumeration is current has nothing to say, and a line that prints on every read is
// a line nobody reads.
export function renderDeployHoldStaleness(st, { maxCommits = 10, maxPaths = 8 } = {}) {
  if (!st || st.status === 'CURRENT') return [];
  const head = st.head ? st.head.slice(0, 12) : '(unresolved)';
  const tip = st.tip ? st.tip.slice(0, 12) : '(unstamped)';
  if (st.status === 'STALE') {
    const lines = [
      `  ⚠ THIS HOLD'S BLAST-RADIUS ENUMERATION IS STALE — TRA-4262.`,
      `    enumerated against : ${tip}${st.enumeratedAt ? ` (${st.enumeratedAt})` : ''}`,
      `    would ship         : ${head}${st.source ? ` — ${st.source}` : ''}`,
      `    ${st.commits.length} commit(s) have landed since, and the emits[] above does NOT describe them:`,
    ];
    for (const c of st.commits.slice(0, maxCommits)) lines.push(`      · ${c.sha} ${c.subject}`);
    if (st.commits.length > maxCommits) lines.push(`      · … ${st.commits.length - maxCommits} more`);
    if (st.serverPaths.length) {
      lines.push(`    ${st.serverPaths.length} of the ${st.paths.length} changed path(s) are SERVER BYTES this box will run:`);
      for (const p of st.serverPaths.slice(0, maxPaths)) lines.push(`      · ${p}`);
      if (st.serverPaths.length > maxPaths) lines.push(`      · … ${st.serverPaths.length - maxPaths} more`);
    } else {
      lines.push(
        `    No changed path was RECOGNISED as a server byte (packages/** minus tests). That is a\n` +
          `    statement about PATHS, not about behaviour — read the ${st.paths.length} changed file(s) yourself.`,
      );
    }
    lines.push(
      `    RE-ENUMERATE BEFORE YOU CLEAR: git log ${tip}..${DEPLOY_HOLD_ENUM_REF} — then either extend\n` +
        `    emits[] or say in the clearing commit that the delta is server-byte-free, and re-stamp\n` +
        `    enumeratedTip. The comparison is against your LOCAL ${DEPLOY_HOLD_ENUM_REF} (this gate takes no\n` +
        `    network), so an unfetched checkout makes this count a LOWER BOUND.`,
    );
    return lines;
  }
  if (st.status === 'UNSTAMPED') {
    return [
      `  ⚠ THIS HOLD'S emits[] CARRIES NO enumeratedTip — TRA-4262.`,
      `    Nothing in the file says which tip it describes, so its staleness is undetectable by`,
      `    inspection. Treat the list as a LOWER BOUND on what a deploy would emit.`,
    ];
  }
  if (st.status === 'DIVERGED') {
    return [
      `  ⚠ THIS HOLD'S enumeratedTip IS NOT AN ANCESTOR OF WHAT WOULD SHIP — TRA-4262.`,
      `    enumerated against : ${tip}`,
      `    would ship         : ${head}${st.source ? ` — ${st.source}` : ''}`,
      `    ${st.why}. The emits[] may describe a different line of history entirely.`,
    ];
  }
  return [
    `  ⚠ COULD NOT TELL WHETHER THIS HOLD'S emits[] IS CURRENT — TRA-4262.`,
    `    enumerated against : ${tip}`,
    `    blind              : ${st.why}`,
    `    "Cannot tell" is not "current". Re-enumerate by hand before trusting the list above.`,
  ];
}

// ── Gate −1c: WHICH WINDOW DOES emits[] CLAIM TO COVER? (TRA-4268) ────────────
// Gate −1b fixed staleness at the HEAD of the enumeration: `emits` is a snapshot of a
// moving tip, so stamp the tip and re-take at clear time. That is correct, it is
// instrumented, and it worked — four re-takes landed on the TRA-4217 hold on 2026-09-01
// alone. AND EVERY ONE OF THEM MEASURED FORWARD FROM A TIP.
//
// A DEPLOY DOES NOT MOVE THE BOX FROM `enumeratedTip` TO THE TIP. IT MOVES IT FROM THE
// LIVE DEPLOYED PIN TO THE TIP. Those two windows coincide only when the box is already
// caught up, which under a deploy hold is exactly the case that does not hold: the hold is
// WHY it is behind.
//
// MEASURED, on the hold this was written for. bqb1 was running `092d087775dc`; the
// TRA-4217 hold's first enumeration was taken against `4e0f4438` — TWENTY-TWO COMMITS
// LATER. `git log 092d087775dc..4e0f4438` is 22 commits, 14 of them changing `packages/**`
// outside tests (~4,300 added lines across 20 non-test server files). EXACTLY ONE of the
// 14 appears anywhere in `emits`, and only because the hold was opened for it. The other
// thirteen ship to the box and were described nowhere — among them a refusal added to the
// imported-row CLOSE route, a byte in the live OTM ENTRY path, and a rewrite of where
// `peakPremium` persists, which feeds the profit-lock exit.
//
// ⚠ THE INSTRUMENT WAS NOT LYING, AND THIS IS THE POINT. `deployHoldStaleness` compares
// `enumeratedTip..origin/main` and reported CURRENT/STALE TRUTHFULLY the whole time, while
// the list was structurally short by 22 commits. It answered a NARROWER question than its
// readers asked of it, and the unstated hole read as coverage. The defect class is not a
// wrong answer — it is a MISSING OPERAND, and the remedy is a second stamp, not a better
// comparison.
//
// OFFLINE, like the rest of gate −1: both operands are shas already in the file, so this
// asks git only for ancestry and never touches the network. The NETWORK half — "is the
// stamped baseline still what the box is RUNNING" — cannot live here and does not; see
// `deployHoldPinDrift`, which runs at Gate 4 where the live pin has already been resolved.
//
// Statuses:
//   UNSTAMPED     no usable `enumeratedFromLivePin` — emits[] states a HEAD and no START
//   WINDOW        the baseline is an ancestor of (or equal to) the stamped head ⇒ the
//                 window emits[] claims to cover EXISTS and is enumerable
//   NOT_ANCESTOR  the baseline is NOT an ancestor of the head ⇒ `git log <base>..<head>`
//                 is empty and the stamped window DOES NOT EXIST
//   BLIND         git could not answer. NEVER collapsed into WINDOW (the gradeCarries
//                 lesson: a grafted-away path and a genuine absence look identical)
export function deployHoldBaseline(hold, probe) {
  const baseline = extractShaPrefix(hold?.enumeratedFromLivePin);
  const head = extractShaPrefix(hold?.enumeratedTip);
  const base = { baseline, head, degenerate: false, why: null };
  if (!baseline) {
    return {
      ...base,
      status: 'UNSTAMPED',
      why:
        'the hold carries no usable `enumeratedFromLivePin`, so emits[] states a HEAD and no START — ' +
        'nothing in the file says which window it claims to cover (TRA-4268)',
    };
  }
  if (!head) {
    return {
      ...base,
      status: 'BLIND',
      why: 'the hold carries no usable `enumeratedTip`, so the baseline has no head to be tested against',
    };
  }
  // Ancestry is reflexive, and an equal pair is a legitimate (empty) window: the box is
  // already at the stamped head, so a deploy is a restart. Answer it without asking git,
  // which also keeps the abbreviated-vs-full sha case out of `merge-base`.
  if (sameCommitSha(baseline, head)) return { ...base, status: 'WINDOW', degenerate: true };
  const anc = probe.ancestor(baseline, head);
  if (anc === null) {
    return {
      ...base,
      status: 'BLIND',
      why: `cannot test whether ${baseline.slice(0, 12)} is an ancestor of ${head.slice(0, 12)} (${BLIND_ANCESTRY_CAUSES})`,
    };
  }
  if (anc === false) {
    return {
      ...base,
      status: 'NOT_ANCESTOR',
      why:
        `${baseline.slice(0, 12)} is NOT an ancestor of ${head.slice(0, 12)}, so ` +
        `\`git log ${baseline.slice(0, 12)}..${head.slice(0, 12)}\` is EMPTY — the window emits[] stamps does not exist`,
    };
  }
  return { ...base, status: 'WINDOW', degenerate: false };
}

export function deployHoldBaselineIsLoud(status) {
  return status === 'UNSTAMPED' || status === 'NOT_ANCESTOR' || status === 'BLIND';
}

// AC2 of TRA-4268: the refusal must PRINT THE WINDOW `emits[]` claims to cover, not only
// its head — a reader must be able to see the list's START POINT without opening the file.
// So unlike the staleness renderer, this one is NEVER silent: the good case still prints
// one line, because the window IS the header of the list underneath it. It is one line on
// a refusal that is already dozens, and it is the line the 22-commit hole hid behind.
export function renderDeployHoldBaseline(st) {
  if (!st) return [];
  const head = st.head ? st.head.slice(0, 12) : '(unstamped)';
  const baseline = st.baseline ? st.baseline.slice(0, 12) : '(no baseline)';
  if (st.status === 'WINDOW') {
    return [
      `  emits[] COVERS: ${baseline}..${head}${
        st.degenerate ? '  (EMPTY — the baseline IS the stamped head, so this describes a RESTART)' : ''
      }`,
      `    Baseline is the LIVE DEPLOYED PIN, not the enumerator's starting tip (TRA-4268). RE-READ it` +
        `\n    off GET /api/health/options-live before you clear — this box reboots on its own (TRA-4158),` +
        `\n    and \`pid\` is not a boot identity: key on \`startedAt\`.`,
    ];
  }
  if (st.status === 'UNSTAMPED') {
    return [
      `  emits[] COVERS: ???..${head}  ⚠ NO BASELINE — TRA-4268.`,
      `    This hold stamps the tip its list was taken AGAINST and not the sha the box is RUNNING, so`,
      `    the list describes <somebody's tip>..${head} while a deploy ships <live pin>..<tip>. On the`,
      `    TRA-4217 hold those two windows differed by 22 commits, 13 of which shipped server bytes and`,
      `    were described nowhere, under four consecutive re-enumerations that were each correct.`,
      `    Treat emits[] as a LOWER BOUND and re-enumerate FROM THE LIVE PIN before clearing.`,
    ];
  }
  if (st.status === 'NOT_ANCESTOR') {
    return [
      `  emits[] COVERS: ${baseline}..${head}  ⚠ THAT WINDOW DOES NOT EXIST — TRA-4268.`,
      `    ${st.why}.`,
      `    A baseline that is not an ancestor of the head is a sha off another history, or the two`,
      `    stamps were taken in the wrong order. Either way the list enumerates nothing checkable.`,
    ];
  }
  return [
    `  emits[] COVERS: ${baseline}..${head}  ⚠ COULD NOT VERIFY THE WINDOW — TRA-4268.`,
    `    blind : ${st.why}`,
    `    "Cannot tell" is not "the window exists". Check it by hand before trusting the list below.`,
  ];
}

// The impure half: resolves what this invocation would ship and what landed since, WITHOUT
// the network. `--commit` wins because that is what Render would build; otherwise the local
// remote-tracking ref, which is the honest offline stand-in for the tip this script ships.
export function gitEnumerationProbe(requestedCommit = COMMIT, ref = DEPLOY_HOLD_ENUM_REF) {
  return {
    head() {
      if (requestedCommit) return { sha: String(requestedCommit), source: '--commit' };
      const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10000);
      const sha = r.status === 0 ? (r.stdout ?? '').trim() : '';
      if (!sha) {
        return {
          sha: null,
          error: `could not resolve ${ref} in this checkout (git rev-parse status ${r.status}${r.error ? `, ${r.error.message}` : ''}) — run \`git fetch origin\``,
        };
      }
      return { sha, source: `local ${ref} (this gate takes no network — a lower bound on the real tip)` };
    },
    delta(tip, head) {
      const shallow = isShallowCheckout();
      const log = git(['log', '--no-color', '--format=%h%x09%s', `${tip}..${head}`], 20000);
      if (log.status !== 0) {
        return {
          ok: false,
          shallow,
          error: `git log ${String(tip).slice(0, 12)}..${String(head).slice(0, 12)} failed (status ${log.status}${
            shallow ? ', and this is a SHALLOW checkout' : ''
          }) — the stamped tip may not be in this checkout`,
        };
      }
      const commits = (log.stdout ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
          const [sha, ...rest] = l.split('\t');
          return { sha, subject: rest.join('\t') };
        });
      const diff = git(['diff', '--name-only', `${tip}..${head}`], 20000);
      const paths =
        diff.status === 0 ? (diff.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean) : [];
      return { ok: true, shallow, commits, paths };
    },
    // TRA-4268. Deliberately `gitCarries`, the same graded ancestry every other gate here
    // uses: it returns null rather than false for a grafted or unresolvable answer, so a
    // shallow checkout reads BLIND instead of manufacturing NOT_ANCESTOR against a window
    // that is perfectly real (TRA-3699).
    ancestor(a, b) {
      return gitCarries(a, b);
    },
  };
}

// The TRA-NNNN tokens an --override-hold reason must name at least one of. Requiring the
// ticket is not ceremony: it is the cheapest available proof that the operator read the
// hold they are breaking rather than pasting the flag out of the usage text. It costs
// seconds to satisfy, so it does not stand between anyone and a genuine emergency.
// A hold whose `ticket` carries no TRA token contributes no requirement — this gate does
// not invent a lock it cannot state.
export function deployHoldOverrideTokens(holds) {
  const out = new Set();
  for (const h of holds) for (const m of String(h.ticket).matchAll(/TRA-\d+/g)) out.add(m[0]);
  return [...out];
}

export function deployHoldOverrideNames(reason, tokens) {
  if (tokens.length === 0) return true;
  const r = String(reason).toUpperCase();
  return tokens.some(t => r.includes(t));
}

// `staleness` is a Map from hold object → deployHoldStaleness() result, or null. Passed in
// rather than computed here so this stays pure and the suite can drive both halves.
export function renderDeployHoldRefusal(state, { file = DEPLOY_HOLD_FILE, staleness = null, baselines = null } = {}) {
  if (state.verdict === 'BLIND') {
    return (
      `[render-redeploy] REFUSED: the deploy-hold file exists and CANNOT BE TRUSTED, so this gate\n` +
      `  is BLIND and fails closed — TRA-4261.\n` +
      `  file    : ${file}\n` +
      `  blind   : ${state.why}\n` +
      `  A hold file that degrades to "allowed" when it is malformed is not a hold. FIX THE FILE\n` +
      `  (every hold needs ticket, reason, openedAt, openedBy, a non-empty emits[], the\n` +
      `  enumeratedTip that emits[] was taken against — TRA-4262 — and the enumeratedFromLivePin\n` +
      `  emits[] was enumerated FROM, i.e. the sha the box is running, sha first — TRA-4268),\n` +
      `  or, if the deploy genuinely cannot wait, re-run with --override-hold="TRA-#### why"\n` +
      `  (recorded).`
    );
  }
  const lines = [
    `[render-redeploy] REFUSED: this host is under a REPO-RESIDENT DEPLOY HOLD — TRA-4261.`,
    `  file    : ${file}  (${state.applicable.length} hold(s) apply to ${state.ref.kind}=${state.ref.value})`,
  ];
  for (const h of state.applicable) {
    lines.push('');
    lines.push(`  ── ${h.ticket} — opened ${h.openedAt} by ${h.openedBy}`);
    // VERBATIM, unwrapped, unsummarised. The reason is the whole point of the gate; a
    // refusal that paraphrases it is a refusal the operator has to go and check.
    lines.push(`  ${h.reason}`);
    // TRA-4268: the WINDOW comes FIRST, above the list, because it is what the list is a
    // list OF. A reader who sees only the head cannot tell a complete enumeration from one
    // that is structurally short by 22 commits — which is precisely how this was missed.
    for (const l of renderDeployHoldBaseline(baselines?.get?.(h) ?? null)) lines.push(l);
    lines.push(`  WHAT A DEPLOY WOULD EMIT:`);
    for (const e of h.emits) lines.push(`    ⚠ ${e}`);
    // …and whether that list still describes the tip about to ship (TRA-4262). Printed
    // directly under emits[], because the two are one claim: the list is only as good as
    // the tip it was taken against.
    for (const l of renderDeployHoldStaleness(staleness?.get?.(h) ?? null)) lines.push(l);
    if (h.clearedBy) lines.push(`  CLEARED BY: ${h.clearedBy}`);
  }
  lines.push('');
  lines.push(
    `  This gate runs BEFORE the Render API is contacted and before RENDER_API_KEY is even read,\n` +
      `  so nothing has been asked of Render and no deploy exists. It is NOT the RTH freeze and NOT\n` +
      `  a dated embargo: waiting until 20:00Z does not clear it. It clears when somebody DELETES the\n` +
      `  entry from ${file} — a recorded, attributable act — or when it is broken with\n` +
      `  --override-hold="<TRA-####> why this cannot wait", which is echoed into this command's own\n` +
      `  output so the breach is on the record.`,
  );
  return lines.join('\n');
}

// ── The env-write escape hatch underneath Gate 0 (TRA-2306) ───────────────────
// Gate 0 (AUTH_SECRET, exit 7) runs BEFORE the commit-hold and embargo gates, and its
// remediation — "set a real AUTH_SECRET on the service" — is an ENV WRITE. It exits before
// the caller has been shown either of the gates that exist to refuse the tip, and Gate 2's
// refusal text is where that warning normally lives, so it is restated here.
//
// NARROWED 2026-08-14 (TRA-3724) — see ENV_WRITE_TRUTH. The dangerous half of what this
// block used to say is gone:
//   • An ENV-VAR write has produced no deploy on this host since 2026-07-23, so the
//     realistic failure is now the OPPOSITE one: the operator writes the secret, sees the
//     box still serving the old value, and escalates to an UNPINNED deploy that ships the
//     tip. The tip is still the thing that gets shipped; the write is no longer what ships
//     it. Evaluate the hold against the TIP anyway — that is what an unpinned recovery
//     resolves to.
//   • --commit IS honoured by POST /deploys. Apply the secret with
//     --commit=<sha already serving>: it bakes the env with a zero-byte code delta and is
//     the only apply path that respects a commit hold. The old text said the reverse and
//     that is what steered TRA-3708 into a five-commit train.
//   • A SETTINGS write (PATCH /services) is a different verb and remains untested under
//     the pin — assume it CAN still ship the tip.
//   • BLIND blocks too (authSecretBlocks), and BLIND means the secret could not be READ —
//     not that it is wrong. On BLIND the printed FIX asks for a write that was never
//     needed, which is exactly the case where this warning is load-bearing.
export function envWriteHoldWarning({ holdCheck, embargo, isSoakHost }) {
  if (!isSoakHost) return '';
  const lines = [];
  if (holdCheck && holdCheck.verdict !== 'CLEAR') {
    const h = holdCheck.hold;
    lines.push(
      `  tip     : ${holdCheck.target?.sha?.slice(0, 12) ?? '(unresolved)'} ${
        holdCheck.verdict === 'CARRIES' ? 'CARRIES' : 'CANNOT BE PROVEN CLEAR of'
      } ${h.commit.slice(0, 12)} — ${h.ticket}, held until ${h.until}.`,
    );
    if (holdCheck.why) lines.push(`  blind   : ${holdCheck.why}`);
    lines.push(`  ${h.why}`);
  }
  if (embargo) {
    lines.push(`  embargo : ACTIVE ${embargo.from} → ${embargo.to} — ${embargo.ticket}.`);
  }
  if (lines.length === 0) return '';
  return (
    `\n  ⛔ THERE IS AN OPEN HOLD ON THIS HOST. Neither of the gates below can see an env or\n` +
    `  settings write, and this refusal exits BEFORE both of them, so they are reported here:\n` +
    lines.join('\n') +
    `\n  HOW TO WRITE THE SECRET WITHOUT SHIPPING THE HELD COMMIT (TRA-3724):\n` +
    `    1. Write the ONE key: PUT /v1/services/{id}/env-vars/{KEY}. Never the full-set PUT\n` +
    `       (TRA-2136 — it replaces the whole set and wiped 19 secrets).\n` +
    `    2. That write applies NOTHING on its own: no env-var write has produced a deploy on\n` +
    `       this host since 2026-07-23. Do NOT read the unchanged box as a failed write, and\n` +
    `       do NOT reach for POST /restart — it replays the last deploy's env snapshot.\n` +
    `    3. Apply it with --commit=<THE SHA ALREADY SERVING>. --commit IS honoured; that is a\n` +
    `       zero-byte code delta, so it does not ship the held commit and Gate 2 stays clean.\n` +
    `       Serving sha: curl -s $HOST/api/health/options-live -> build.commitShort\n` +
    `  ⚠ A SETTINGS write (PATCH /services/{id}) is a DIFFERENT verb and is UNTESTED under the\n` +
    `    current pin — it can still redeploy from the branch tip and would ship the held\n` +
    `    commit. Do not change service settings while this hold is open.\n` +
    `  ⚠ What you must NOT do is what happened on TRA-3708: an UNPINNED deploy. That resolves\n` +
    `    the branch tip and ships every commit that has landed since, held or not.`
  );
}

function git(args, timeout = 20000) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout });
}

// ── The shallow-graft hole under every gate below (TRA-3699 / TRA-3678) ───────
// `git merge-base --is-ancestor A B` exits 1 for TWO different facts:
//   (a) B genuinely does not contain A — a real, usable negative;
//   (b) the path between A and B was GRAFTED AWAY by a shallow clone — no answer at all.
// The two are byte-identical: same exit code, no stderr, no warning. And
// `gitHasCommit` does NOT screen (b) out — in the grafted state BOTH shas resolve
// fine (`git fetch --depth=1 origin <sha>` puts the object in the store); it is the
// history BETWEEN them that is missing. So the house idiom "probe each sha, unknown
// ⇒ BLIND" passes straight through this.
//
// A shallow checkout is the DEFAULT shape of a fresh CI or agent workspace, and was
// the shape of this repo's shared workspace until 2026-08-13.
//
// ⚠ THE DIRECTION IS NOT UNIFORM ACROSS CALLERS, which is why this is graded here
// once instead of at each site. TRA-3678's `check-deploy-floor.mjs` turned a false
// negative into a false RED (it blocked — annoying, safe). Gate 2 below turns the
// SAME false negative into "the target does not carry the held commit" ⇒ the hold is
// silently LIFTED and the deploy PROCEEDS. Same git exit code, opposite blast radius,
// on the live-money path.
//
// Only the NEGATIVE is re-graded. rc 0 stays trustworthy while shallow: an affirmative
// answer is PROVEN by objects that are present, and a graft can only ever hide history,
// never invent it.
//
// `gradeCarries` / `carriesFromVerdict` / `isShallowCheckout` now live in
// scripts/lib/shallow-ancestry.mjs and are re-exported at the top of this section, so this
// file's public surface is unchanged (TRA-3721).

// true = target carries held · false = it does not · null = cannot tell.
// `merge-base --is-ancestor` exits 0/1 for the real answers and something else for an
// error, so anything but 0/1 must NOT be collapsed into "not an ancestor" — and neither
// may a 1 that came out of a grafted history (see gradeCarries in the lib).
function gitCarries(heldSha, targetSha) {
  return gradedAncestry(heldSha, targetSha).answer;
}

// What Render will actually build. With --commit that is the sha given; without it Render
// takes the tip of the service's branch, so the guard has to go and look — the whole point
// is that the caller who omitted --commit is precisely the one who does not know what ships.
export function resolveTarget(branch, requestedCommit) {
  if (requestedCommit) {
    return {
      sha: requestedCommit,
      source: '--commit',
      carries: held => gitCarries(held, requestedCommit),
    };
  }
  const ref = `refs/heads/${branch}`;
  const r = git(['ls-remote', 'origin', ref], 30000);
  const sha = r.status === 0 ? (r.stdout ?? '').trim().split(/\s+/)[0] : null;
  if (!sha) {
    return {
      sha: null,
      source: `origin/${branch} tip`,
      error:
        `git ls-remote origin ${ref} failed (status ${r.status}${r.error ? `, ${r.error.message}` : ''}) — ` +
        'cannot tell what the branch tip is, so cannot tell whether it carries a held commit',
      carries: () => null,
    };
  }
  // TRA-4420: this used to read "(no --commit given)", which was accurate and useless — it
  // described what the operator FAILED to type, at a point where the deploy was already
  // decided. Reaching here now requires an explicit `--tip`, so the echo names the flag that
  // authorised it.
  return { sha, source: `origin/${branch} tip (--tip)`, carries: held => gitCarries(held, sha) };
}

// ── The stale-pin ROLLBACK gate (TRA-3625) ────────────────────────────────────
// Every gate above answers a question about the commit IN ISOLATION: is it held, is the
// calendar clear, will it boot. None of them compares it to WHAT IS ALREADY SERVING. So a
// `--commit` that was the tip when somebody wrote it into a carrier, and is an ancestor of
// the tip by the time that carrier is actually executed, sails through all four and
// SILENTLY REVERTS the host to it.
//
// ⚠ THIS IS THE ONE HAZARD THE CALLER CREATES BY TYPING MORE, NOT LESS. The header above
// warns that omitting `--commit` ships an unknown tip; that is an UNDER-ship and it is
// loud (check:deploy-drift reads STALE, and the ordered commit is still an ancestor of
// live so check:deploy-train-window still reads SATISFIED). The opposite — naming a sha
// and having it be OLD — reads as the careful thing to do and removes serving code.
//
// ── Why the predicate is "older than LIVE", not "ancestor of origin/main" ────
// The obvious formulation is "refuse a --commit that is a strict ancestor of the tip".
// That is WRONG, and wrong in a way that would jam an existing remedy shut: Gate 2's own
// refusal text tells the operator to "deploy a commit that predates the held one
// (--commit=<sha>)", and check-deploy-drift.mjs prints `--commit=<tip>` — under the
// ancestor-of-tip rule the first is always refused and the second breaks the moment
// anybody lands a commit between the print and the run. Neither is a rollback.
//
// A rollback is defined against the bytes the host is EXECUTING, so that is what this
// compares. `origin/main` never enters it. The distance from tip is reported as a
// non-blocking STALE PIN note instead (see stalePinNote) — under-shipping is worth
// naming and is not worth refusing.
//
// FAILS CLOSED, like Gate 2 and Gate 0: an unreadable live sha, a sha unknown to this
// checkout, or a git error is BLIND → REFUSE. A guard that degrades to "allowed" the
// moment /api/health/version times out is not a guard, and the state it is protecting
// (serving code that is about to vanish) is not recoverable by re-running.
//
// `isAncestor(a, b)` is "a is an ancestor of, or equal to, b" → true | false | null,
// injected so this stays pure and the control suite can drive it without git.
const short = sha => (typeof sha === 'string' ? sha.slice(0, 12) : '(none)');

export function rollbackState(target, live, isAncestor = gitCarries) {
  if (!target || !target.sha) {
    return { verdict: 'BLIND', target, live, why: target?.error ?? 'the target commit could not be resolved' };
  }
  if (!live || !live.sha) {
    return {
      verdict: 'BLIND',
      target,
      live,
      why: live?.error ?? 'the live commit could not be read, so "older than live" is unanswerable',
    };
  }
  // Compare full shas when we have them, but a short --commit against a long live sha is
  // the normal case, so fall back to the ancestry answers rather than a string compare.
  const forward = isAncestor(live.sha, target.sha); // live ⊆ target → nothing is lost
  if (forward === null) {
    return {
      verdict: 'BLIND',
      target,
      live,
      why: `cannot test whether live ${short(live.sha)} is an ancestor of ${short(target.sha)} (${BLIND_ANCESTRY_CAUSES})`,
    };
  }
  const backward = isAncestor(target.sha, live.sha); // target ⊆ live → live has extra commits
  if (backward === null) {
    return {
      verdict: 'BLIND',
      target,
      live,
      why: `cannot test whether ${short(target.sha)} is an ancestor of live ${short(live.sha)} (${BLIND_ANCESTRY_CAUSES})`,
    };
  }
  // Ancestry is reflexive, so equal shas answer true BOTH ways. Check that first, or a
  // no-op redeploy (the ordinary "restart the box on the same build" call) reads FORWARD
  // and the operator is never told the deploy changes nothing.
  if (forward && backward) return { verdict: 'NOOP', target, live, why: null };
  if (forward) return { verdict: 'FORWARD', target, live, why: null };
  if (backward) return { verdict: 'ROLLBACK', target, live, why: null };
  return {
    verdict: 'DIVERGED',
    target,
    live,
    why:
      `live ${short(live.sha)} and ${short(target.sha)} are on different histories — neither contains ` +
      'the other, so this deploy drops live commits AND adds unrelated ones',
  };
}

// ROLLBACK and DIVERGED both remove serving code. BLIND means we could not prove it does
// not. All three refuse; only FORWARD and NOOP proceed.
export function rollbackBlocks(verdict) {
  return verdict === 'ROLLBACK' || verdict === 'DIVERGED' || verdict === 'BLIND';
}

// The non-blocking half: naming an old-but-still-forward sha is legal (it does not remove
// serving code) and is exactly what the three TRA-3625 carriers did. Say so, with the
// commits it leaves on the floor, so "the deploy went green" is not read as "we shipped
// what is on main". Returns '' when there is nothing to say.
export function stalePinNote(target, tipSha, isAncestor = gitCarries) {
  if (!target?.sha || !tipSha || target.source !== '--commit') return '';
  const behindTip = isAncestor(target.sha, tipSha);
  if (behindTip !== true) return ''; // not behind the tip, or unanswerable — not this note's subject
  // ⚠ NOT `target.sha === tipSha`. resolveTarget passes --commit through VERBATIM, so the
  // ordinary "pin the tip" call compares a 7-char sha against a 40-char one, the string
  // test misses, and ancestry is reflexive — so pinning the tip printed STALE PIN and told
  // the operator to drop the flag they were right to use. Ask ancestry BOTH ways instead;
  // that is equality in the only representation both sides agree on.
  if (isAncestor(tipSha, target.sha) !== false) return ''; // equal, or unanswerable
  return (
    `          ⚠ STALE PIN: --commit=${short(target.sha)} is an ANCESTOR of origin/main ${short(tipSha)}.\n` +
    `            This is an UNDER-ship, not a rollback (nothing serving is removed), so it is\n` +
    `            allowed — but check:deploy-drift will read STALE against this host afterwards.\n` +
    `            If you meant "ship what is on main", drop --commit and let Render take the tip.`
  );
}

// ── The NETWORK half of the emits[] baseline (TRA-4268) ───────────────────────
// `deployHoldBaseline` (gate −1c) answers "does the stamped window EXIST", offline. It
// cannot answer the other half — "is `enumeratedFromLivePin` STILL what the box is
// running" — because that needs the live pin, and gate −1 takes no network BY DESIGN. That
// property is load bearing: it is why the hold refusal lands before RENDER_API_KEY is read
// and before any byte is on the wire, and AC4 of TRA-4268 says in as many words that it is
// not to be traded away for this. So the network half runs HERE, at the gate that has
// already resolved the live sha for the rollback test, and pays nothing extra for it.
//
// ⚠ REACHABILITY, stated rather than left to be discovered. A hold that APPLIES exits at
// gate −1 with code 9, so control only reaches this point with applicable holds when the
// operator BROKE them with --override-hold. That is not a consolation prize: the override
// path is the last read of emits[] before bytes move, and an override is exactly the
// moment somebody is trusting a list whose baseline may have rebooted out from under it.
//
// ⚠ IT WARNS, IT DOES NOT REFUSE. A refusal here would be a second lock that
// --override-hold cannot clear, needing a second flag; the first person it inconvenienced
// would delete the stamp rather than re-read the pin. Same reasoning that keeps gate −1b
// an augmentation. What it buys is that the drift is in the same scrollback as the deploy.
//
// ⚠ TWO ROUTES, ONE PIN — MEASURED, NOT ASSUMED. The hold's `enumeratedFromLivePin` is
// stamped off `GET /api/health/options-live` (`build.commit`), and `fetchLiveCommit()`
// above reads `GET /api/health/version` (`commit`). A comparison across two routes is only
// meaningful if they agree, so it was checked against the live box on 2026-09-01T23:0xZ:
// BOTH returned `092d087775dc3e4cbb1724427c4bae8df303740f`, `commitSource: git`, and the
// SAME `startedAt` 2026-09-01T18:04:59.811Z. They are two projections of one boot's own
// answer, so they cannot diverge without the process serving two shas — and if they ever
// did, this reads REBOOTED, which is the conservative direction.
//
//   UNSTAMPED  no baseline to compare (gate −1c has already said so, loudly)
//   MATCHES    the box is running the sha emits[] was enumerated from
//   REBOOTED   the box is on a DIFFERENT sha ⇒ emits[] describes a window that is not the
//              one this deploy ships
//   BLIND      the live pin could not be read — never collapsed into MATCHES
export function deployHoldPinDrift(hold, live) {
  const baseline = extractShaPrefix(hold?.enumeratedFromLivePin);
  const at = {
    baseline,
    live: live?.sha ?? null,
    reported: live?.reported ?? null,
    startedAt: live?.startedAt ?? null,
    why: null,
  };
  if (!baseline) {
    return { ...at, status: 'UNSTAMPED', why: 'the hold carries no usable `enumeratedFromLivePin` to compare against the box' };
  }
  if (!live?.sha) {
    return {
      ...at,
      status: 'BLIND',
      why: live?.error ?? 'the live commit could not be read, so "is the baseline still what is running" is unanswerable',
    };
  }
  if (sameCommitSha(baseline, live.sha)) return { ...at, status: 'MATCHES' };
  return { ...at, status: 'REBOOTED', why: `the box is running ${short(live.sha)}, not the stamped ${baseline.slice(0, 12)}` };
}

export function deployHoldPinDriftIsLoud(status) {
  return status === 'REBOOTED' || status === 'UNSTAMPED' || status === 'BLIND';
}

export function renderDeployHoldPinDrift(hold, st) {
  const ticket = hold?.ticket ?? '(untitled hold)';
  const baseline = st.baseline ? st.baseline.slice(0, 12) : '(no baseline)';
  const boot = st.startedAt ? `, booted ${st.startedAt}` : '';
  if (st.status === 'MATCHES') {
    return (
      `[render-redeploy] ${ticket}: emits[] BASELINE CONFIRMED LIVE — ${baseline} is what the host is ` +
      `running${boot}. The window emits[] describes is the window this deploy ships. TRA-4268.`
    );
  }
  if (st.status === 'REBOOTED') {
    return (
      `[render-redeploy] ⚠ ${ticket}: THE emits[] BASELINE IS NO LONGER WHAT THE BOX IS RUNNING — TRA-4268.\n` +
      `  enumerated from : ${baseline}\n` +
      `  box is running  : ${short(st.live)}${st.reported ? `  [reported ${st.reported}]` : ''}${boot}\n` +
      `  emits[] describes ${baseline}..<its stamped head>; this deploy ships ${short(st.live)}..<the tip>.\n` +
      `  Those are DIFFERENT WINDOWS, so that list is not an enumeration of what you are about to do.\n` +
      `  RE-ENUMERATE FROM THE PIN ABOVE: git log ${short(st.live)}..${DEPLOY_HOLD_ENUM_REF}\n` +
      `  ⚠ \`pid\` is NOT a boot identity — key on \`startedAt\`. This host restarts itself (TRA-4158),\n` +
      `  so a baseline recalled from the file rather than re-read is stale by construction.`
    );
  }
  if (st.status === 'UNSTAMPED') {
    return (
      `[render-redeploy] ⚠ ${ticket}: emits[] HAS NO LIVE-PIN BASELINE, so nothing can be said about\n` +
      `  whether it covers what this deploy ships — TRA-4268. The host is running ` +
      `${short(st.live)}${boot}.\n` +
      `  Run \`git log ${short(st.live)}..${DEPLOY_HOLD_ENUM_REF}\` yourself: THAT is the window.`
    );
  }
  return (
    `[render-redeploy] ⚠ ${ticket}: COULD NOT CHECK THE emits[] BASELINE AGAINST THE BOX — TRA-4268.\n` +
    `  enumerated from : ${baseline}\n` +
    `  blind           : ${st.why}\n` +
    `  "Cannot tell" is not "still current". The list may describe a window that closed.`
  );
}

// ── AUTH_SECRET value gate (TRA-2387) ─────────────────────────────────────────
// Services whose BOOT reads AUTH_SECRET. render.yaml declares the key on exactly one
// service (L76-77, `generateValue: true`, tradingai-bqb1), and that declaration is the
// only mechanical statement anywhere of where the secret is load-bearing.
//
// This set exists to SCOPE THE SEVERITY, not to scope the check. The check runs on every
// service; what the set decides is what an ABSENT key means:
//   • in the set   → ABSENT is a REFUSAL. We know the server reads it here, so a missing
//                    key is a host that will not boot.
//   • not in the set → ABSENT is NOT_APPLICABLE. A worker or static site that never had an
//                    AUTH_SECRET must not be false-blocked by a guard written for bqb1;
//                    a new check whose severity is not scoped to reachability jams
//                    somebody else's critical path (TRA-2348).
// A key that is PRESENT-but-unusable REFUSES on ANY service, in the set or not: somebody
// set that key on purpose and then blanked it, which is positive evidence it matters there.
// All three of the host's identity strings, because the call site tests membership of
// whichever field it happens to hold. Before TRA-3743 this set held the SLUG under the
// name of the NAME, so the `service.name` membership test at the call site was dead.
export const AUTH_SECRET_REQUIRED_ON = new Set([SOAK_HOST_ID, SOAK_HOST_NAME, SOAK_HOST_SLUG]);

// The gate's decision, as a pure function of an injected probe so it is testable without
// the network (same idiom as commitHoldState's injected `carries`).
//
// `probe` is what fetchEnvVarProbe returns:
//   { rows: [{key, value}] | null, truncated: boolean, error?: string }
//
// FAILS CLOSED, and the reason is worth stating because it is the one behaviour the other
// three gates got right and a fourth gate is most likely to get wrong: a guard that cannot
// READ the value must refuse, never proceed. If an unreadable Render API returned CLEAR,
// then the deploy this gate exists to stop would be permitted by the same outage that
// hides the problem — i.e. the gate would be strictly worse than no gate, because it also
// prints a green line while doing it. BLIND and UNUSABLE therefore share exit 7.
export function authSecretGateState(probe, { keyRequired = false } = {}) {
  const blind = why => ({ verdict: 'BLIND', shape: null, detail: null, why });

  if (!probe) return blind('the env-var probe did not run');
  if (probe.error) return blind(probe.error);
  if (!Array.isArray(probe.rows)) return blind('the env-var list could not be read as an array');

  const row = probe.rows.find(v => v && v.key === 'AUTH_SECRET') ?? null;

  if (!row) {
    // ⛔ A TRUNCATED ENUMERATION CANNOT PROVE AN ABSENCE. The env-vars route is a capped
    // list, and a capped list is a fail-open read wearing a full-looking payload (TRA-2360,
    // measured on the issues route: 1000 rows looked complete and hid 46% of the
    // population). "AUTH_SECRET is not in the rows I managed to read" is a fact about the
    // pagination, not about the service — so it is BLIND, never ABSENT.
    if (probe.truncated) {
      return blind(
        `the env-var list could not be enumerated to the end (${probe.rows.length} rows read, more remain), ` +
          "so AUTH_SECRET's absence from them is a fact about the pagination, not about the service",
      );
    }
    if (!keyRequired) {
      return {
        verdict: 'NOT_APPLICABLE',
        shape: 'ABSENT',
        detail: 'absent, and this service is not one that reads it',
        why: null,
      };
    }
    const c = classifyAuthSecret(null);
    return { verdict: 'UNUSABLE', shape: c.shape, detail: c.detail, why: null };
  }

  // ⛔ `'value' in row` — NOT `row.value ?? ''`. An absent field is a fact about the payload
  // you asked for, never about the world: collapsing "the API did not return the value" into
  // "the value is the empty string" manufactures a confident UNUSABLE out of a read failure.
  // Both refuse, so the safety is identical — but only one of them is TRUE, and the operator
  // acts on the message. (Residual noted on TRA-2387: tra2296-auth-secret-check.mjs still
  // does the `?? ''` collapse at its check 1.)
  if (!('value' in row)) {
    return blind('the AUTH_SECRET row carries no `value` key at all, so its value was not read');
  }
  if (typeof row.value !== 'string') {
    return blind(
      `the AUTH_SECRET row's value is ${row.value === null ? 'null' : typeof row.value}, not a string — ` +
        'the server predicate is defined over strings, so this cannot be graded',
    );
  }

  const c = classifyAuthSecret(row.value);
  return { verdict: c.usable ? 'CLEAR' : 'UNUSABLE', shape: c.shape, detail: c.detail, why: null };
}

// Which verdicts stop a deploy. Exported and used by main() rather than re-typed there, so
// the control suite grades THE EXPRESSION MAIN ACTUALLY EVALUATES and not a second opinion
// that can drift away from it. BLIND is in here on purpose: see the fail-closed note above.
export function authSecretBlocks(verdict) {
  return verdict === 'UNUSABLE' || verdict === 'BLIND';
}

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const COMMIT = valOf('--commit');
const CLEAR_CACHE = has('--clear-cache');
const DRY_RUN = has('--dry-run');
const OVERRIDE_REASON = valOf('--force-rth-override');
const HAS_OVERRIDE = argv.some(a => a === '--force-rth-override' || a.startsWith('--force-rth-override='));
const EMBARGO_OVERRIDE_REASON = valOf('--force-embargo-override');
const HAS_EMBARGO_OVERRIDE = argv.some(
  a => a === '--force-embargo-override' || a.startsWith('--force-embargo-override='),
);
const COMMIT_HOLD_OVERRIDE_REASON = valOf('--force-commit-hold-override');
const HAS_COMMIT_HOLD_OVERRIDE = argv.some(
  a => a === '--force-commit-hold-override' || a.startsWith('--force-commit-hold-override='),
);
const AUTH_SECRET_OVERRIDE_REASON = valOf('--force-auth-secret-override');
const HAS_AUTH_SECRET_OVERRIDE = argv.some(
  a => a === '--force-auth-secret-override' || a.startsWith('--force-auth-secret-override='),
);
const ROLLBACK_OVERRIDE_REASON = valOf('--allow-rollback');
const HAS_ROLLBACK_OVERRIDE = argv.some(a => a === '--allow-rollback' || a.startsWith('--allow-rollback='));
const HOLD_OVERRIDE_REASON = valOf('--override-hold');
const HAS_HOLD_OVERRIDE = argv.some(a => a === '--override-hold' || a.startsWith('--override-hold='));
const CADENCE_OVERRIDE_REASON = valOf('--override-cadence');
const HAS_CADENCE_OVERRIDE = argv.some(a => a === '--override-cadence' || a.startsWith('--override-cadence='));
const WANTS_TIP = has('--tip');

function fail(code, msg) {
  console.error(`[render-redeploy] ERROR: ${msg}`);
  process.exit(code);
}

// ── The ARGUMENT GUARD (TRA-4420) ─────────────────────────────────────────────
//
// Every flag above is looked up POSITIVELY — `argv.includes('--dry-run')`,
// `argv.find(a => a.startsWith('--commit='))`. Nothing enumerated argv, so anything this
// script did not recognise was SILENTLY IGNORED and the run proceeded as a real deploy.
// Measured 2026-09-09 on the live money host: `node scripts/render-redeploy.mjs --help`
// printed no usage, ran all four gates and triggered `dep-dagcbqp5efls73ac5d40` on bqb1.
// Nothing was harmed because the tip happened to be the commit TRA-4419 had ordered — luck,
// not design.
//
// ⛔ AND `--help` IS THE HARMLESS INSTANCE. The one that costs us bytes on the host is the
// near-miss on the flag that names WHICH BYTES:
//
//     node scripts/render-redeploy.mjs --commmit=<pinned sha>   # typo, two m's
//     node scripts/render-redeploy.mjs --commit <pinned sha>    # space instead of '='
//
// Both used to read as "no --commit given" and deploy the branch TIP instead of the sha the
// operator named — exit 0, cheerful output, wrong bytes on bqb1. That inverts TRA-1665's
// deploy-by-commit-id rule, and it degrades in the direction this repo keeps paying for: an
// operator pins a sha precisely BECAUSE the tip is not safe to ship.
//
// So the load-bearing half of this guard is not `--help`. It is the REJECTION: enumerate
// argv, match against the table below, and refuse (exit 2) naming the offender. A flag this
// script does not understand is an instruction it did not carry out, and a deploy trigger
// must not carry out an instruction it did not understand.
//
// Three further silent-wrong-bytes shapes in the same family, all refused here:
//   · `--commit=` (empty)      — valOf returns '', which is falsy, which was the tip again.
//   · `--commit=a --commit=b`  — argv.find takes the FIRST; the second was discarded without
//                                a word. Two conflicting statements about what to ship is
//                                not a thing to resolve by array order.
//   · `--dry-run=true`         — a no-value flag written with a value. `has()` compares for
//                                EQUALITY, so this did not enable --dry-run: it armed a REAL
//                                deploy while the operator believed they had asked for a
//                                rehearsal. The worst shape on this list.
//
// ⚠️ The override flags are `value: 'reason'`, NOT 'required', on purpose. Written bare they
// are already accepted here and refused one layer down by the gate itself, with the specific
// message that names what a reason has to contain (and, for --override-hold, the ticket).
// Promoting them to a generic usage error here would REPLACE those messages with a worse one.
//
// The table is the single source of truth for both the refusal and `--help`, so a flag can
// never be documented in usage and rejected by the parser, or vice versa.
export const KNOWN_ARGS = [
  { flag: '--help', alias: '-h', value: 'none', help: 'print this usage and exit 0 WITHOUT deploying.' },
  {
    flag: '--commit',
    value: 'required',
    arg: '<sha>',
    help: 'deploy this exact commit. THE STANDING RULE (TRA-1665) — deploy by commit id.',
  },
  {
    flag: '--tip',
    value: 'none',
    help: "deploy whatever origin/<branch> is right now. The explicit opt-in for the old default; you must say it.",
  },
  { flag: '--clear-cache', value: 'none', help: 'deploy with a cleared build cache.' },
  { flag: '--dry-run', value: 'none', help: 'print the gate decision and the intended call, POST nothing.' },
  {
    flag: '--force-rth-override',
    value: 'reason',
    arg: '"reason"',
    help: 'deploy during the RTH freeze anyway (exit 4). Reason required, and echoed.',
  },
  {
    flag: '--force-embargo-override',
    value: 'reason',
    arg: '"reason"',
    help: 'deploy during a dated embargo anyway (exit 5). Reason required, and echoed.',
  },
  {
    flag: '--force-commit-hold-override',
    value: 'reason',
    arg: '"reason"',
    help: 'deploy a held commit anyway (exit 6). Reason required, and echoed.',
  },
  {
    flag: '--force-auth-secret-override',
    value: 'reason',
    arg: '"reason"',
    help: "deploy onto a host whose live AUTH_SECRET is unusable/unreadable anyway (exit 7).",
  },
  {
    flag: '--allow-rollback',
    value: 'reason',
    arg: '"reason"',
    help: 'deploy something OLDER than what is serving anyway (exit 8). Reason required.',
  },
  {
    flag: '--override-hold',
    value: 'reason',
    arg: '"<TRA-####> reason"',
    help: 'deploy past an open hold in ops/deploy-hold.json anyway (exit 9). Must NAME the hold.',
  },
  {
    flag: '--override-cadence',
    value: 'reason',
    arg: '"<TRA-####> reason"',
    help: 'deploy one more commit advance into a window whose CADENCE CEILING is spent or unreadable (exit 10). Must name a ticket.',
  },
];

// Levenshtein, bounded — only used to say "did you mean". A suggestion is a courtesy; the
// REFUSAL is the fix, so this never decides anything.
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function nearestFlag(name, known) {
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(name, k.flag);
    if (d < bestD) {
      bestD = d;
      best = k.flag;
    }
  }
  // 3 covers a doubled letter, a dropped dash and a transposition; beyond that a "did you
  // mean" is noise attached to a refusal that already stands on its own.
  return bestD <= 3 ? best : null;
}

/**
 * Enumerate argv and grade every token against KNOWN_ARGS.
 *
 * PURE, and exported, so scripts/tra4420-arg-guard-check.mjs can grade the predicate — but
 * the suite's load-bearing arms are REAL INVOCATIONS of this file, because the defect being
 * fixed was never a wrong predicate. It was the absence of a call site. (Same reasoning as
 * check:deploy-gates:shallow-repro: a table cannot reach the thing a table stands in for.)
 *
 * Returns { help, problems: [{arg, kind, why, suggestion}] }. `help` wins over `problems`:
 * asking for usage is a read, and refusing to explain yourself to somebody who mistyped a
 * flag is the exact unhelpfulness that made `--help` get typed at a deploy trigger.
 */
export function classifyArgs(argv, known = KNOWN_ARGS) {
  const byName = new Map();
  for (const k of known) {
    byName.set(k.flag, k);
    if (k.alias) byName.set(k.alias, k);
  }
  const problems = [];
  const seen = new Set();
  let help = false;
  let target = null; // '--commit' | '--tip'

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? undefined : a.slice(eq + 1);

    if (!name.startsWith('-')) {
      // A bare word. Overwhelmingly this is the space-form of the flag before it, which is
      // THE case that used to ship the tip, so say that rather than a generic complaint.
      const prevSpec = i > 0 ? byName.get(argv[i - 1]) : undefined;
      problems.push({
        arg: a,
        kind: 'positional',
        why:
          prevSpec && prevSpec.value !== 'none'
            ? `bare value after ${prevSpec.flag}. This script does not take space-separated values — ` +
              `write \`${prevSpec.flag}=${a}\`, with an '='. Without the '=' the flag was ignored and the BRANCH TIP shipped.`
            : 'a bare positional argument. This script takes flags only.',
      });
      continue;
    }

    const spec = byName.get(name);
    if (!spec) {
      const near = nearestFlag(name, known);
      problems.push({
        arg: a,
        kind: 'unknown',
        why: 'not a flag this script understands, so it would have been SILENTLY IGNORED (TRA-4420).',
        suggestion: near,
      });
      continue;
    }

    if (spec.flag === '--help') {
      help = true;
      continue;
    }

    if (seen.has(spec.flag)) {
      problems.push({
        arg: a,
        kind: 'duplicate',
        why: `${spec.flag} was given more than once. The parser takes the FIRST and discards the rest; ` +
          'two different answers to "what do I ship" is a decision for you, not for array order.',
      });
      continue;
    }
    seen.add(spec.flag);

    if (spec.value === 'none' && eq !== -1) {
      problems.push({
        arg: a,
        kind: 'unexpected-value',
        why: `${spec.flag} takes no value. Written with one it does NOT match, so the flag had no effect at all — ` +
          `write it bare as \`${spec.flag}\`.`,
      });
      continue;
    }

    if (spec.value === 'required' && eq === -1) {
      problems.push({
        arg: a,
        kind: 'missing-value',
        why: `${spec.flag} takes a value and must be written \`${spec.flag}=${spec.arg}\`, with an '='. ` +
          'Written bare it was ignored and the BRANCH TIP shipped.',
      });
      continue;
    }

    if (spec.value === 'required' && (value ?? '').trim() === '') {
      problems.push({
        arg: a,
        kind: 'empty-value',
        why: `${spec.flag} was given an empty value, which is indistinguishable from not giving it at all — ` +
          'i.e. the BRANCH TIP. Say what you mean to ship.',
      });
      continue;
    }

    if (spec.flag === '--commit' || spec.flag === '--tip') {
      if (target && target !== spec.flag) {
        problems.push({
          arg: a,
          kind: 'conflicting-target',
          why: '--commit and --tip both name WHAT to ship, and they disagree. Pass exactly one.',
        });
        continue;
      }
      target = spec.flag;
    }
  }

  // TRA-4420 item 3: the bare `origin/main` tip default is retired. It was a hole in the
  // deploy-by-commit-id rule that could be fallen into by SAYING NOTHING — including by
  // every typo above, before they were refused. `--tip` keeps the capability and costs one
  // token; what it removes is the ability to ship the tip by accident.
  //
  // Not applied under --help: usage is a read, and demanding a deploy target before agreeing
  // to explain the flags is the loop this ticket exists to close.
  if (!help && !target) {
    problems.push({
      arg: '(none)',
      kind: 'no-target',
      why:
        'no deploy target. Pass `--commit=<sha>` (the standing rule — TRA-1665) or, if you really do mean ' +
        'whatever origin/<branch> is at this instant, say `--tip` explicitly. Until TRA-4420 saying nothing ' +
        'meant the tip, which is how a mistyped --commit shipped it.',
    });
  }

  return { help, problems };
}

export function renderUsage() {
  const rows = KNOWN_ARGS.map(k => ({
    left: `${k.flag}${k.value === 'none' ? '' : `=${k.arg}`}${k.alias ? `, ${k.alias}` : ''}`,
    help: k.help,
  }));
  const w = Math.max(...rows.map(r => r.left.length));
  return [
    'render-redeploy.mjs — the gated deploy trigger for Render (TRA-1996/TRA-1648).',
    '',
    'USAGE',
    '  RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<sha> [options]',
    '  RENDER_API_KEY=… node scripts/render-redeploy.mjs --tip [options]',
    '',
    'A deploy target is REQUIRED: exactly one of --commit=<sha> or --tip (TRA-4420).',
    'Values are attached with `=`. There is no space form: `--commit <sha>` is refused.',
    '',
    'OPTIONS',
    ...rows.map(r => `  ${r.left.padEnd(w)}  ${r.help}`),
    '',
    'ENVIRONMENT',
    '  RENDER_API_KEY       required for anything that touches Render (never commit it).',
    '  RENDER_SERVICE_ID    optional `srv-…`. Default: the soak host bqb1.',
    '  RENDER_SERVICE_NAME  optional. Default `TradingAI-` (slug `tradingai-bqb1` also resolves).',
    '',
    'EXIT CODES',
    '  0  deploy triggered (or --dry-run allowed, or --help printed)',
    '  2  usage / unknown argument / auth / API error',
    '  4  REFUSED — RTH freeze on the soak host, no override',
    '  5  REFUSED — a dated embargo covers this instant, no override',
    '  6  REFUSED — the deploy would carry a HELD COMMIT, or cannot be proven not to',
    '  7  REFUSED — the live AUTH_SECRET is unusable, or cannot be READ (BLIND)',
    '  8  REFUSED — the deploy would ROLL THE HOST BACK, or cannot be proven not to',
    '  9  REFUSED — an open hold in ops/deploy-hold.json covers this service (or it is BLIND)',
    ' 10  REFUSED — this window\'s CADENCE CEILING is spent by earlier commit advances (or is BLIND)',
    '',
    'THIS PRINTS AND EXITS. It deploys nothing. Before TRA-4420 it deployed the branch tip.',
  ].join('\n');
}

export function renderArgRefusal(problems) {
  return (
    `[render-redeploy] REFUSED (usage): ${problems.length} argument problem(s). NOTHING WAS DEPLOYED.\n` +
    problems
      .map(p => `  ✗ ${p.arg}\n      ${p.why}${p.suggestion ? `\n      Did you mean \`${p.suggestion}\`?` : ''}`)
      .join('\n') +
    '\n  Run `node scripts/render-redeploy.mjs --help` for usage (it prints and exits, it does not deploy).\n' +
    '  TRA-4420: an argument this script does not understand used to be ignored, and the run\n' +
    '  proceeded as a real deploy of the BRANCH TIP.'
  );
}

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    fail(2, `${init?.method ?? 'GET'} ${path} → ${r.status} ${r.statusText} ${body}`.trim());
  }
  return r.json();
}

// Read the service's live env vars for the AUTH_SECRET gate.
//
// ⛔ DELIBERATELY NOT `api()`. That helper calls fail(2) on a non-2xx, which would report a
// Render outage as a USAGE error — the operator's remedy for exit 2 is "check your key and
// re-run", i.e. exactly the wrong reflex. An unreadable env-var list is not a usage problem,
// it is the gate going BLIND, and it must say so under its own exit code.
//
// PAGES TO THE END. `?limit=100` on its own would let a service with >100 env vars return a
// full-looking page that happens not to contain AUTH_SECRET, and the honest-looking
// conclusion from that page is "the key is absent" — a refusal for the wrong reason on bqb1,
// and a false NOT_APPLICABLE anywhere else. Anything short of a proven-complete enumeration
// reports `truncated`, which the predicate turns into BLIND.
const ENV_VAR_PAGE = 100;
const ENV_VAR_MAX_PAGES = 20;

async function fetchEnvVarProbe(serviceId) {
  const rows = [];
  let cursor;
  for (let page = 0; page < ENV_VAR_MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ limit: String(ENV_VAR_PAGE) });
    if (cursor) q.set('cursor', cursor);
    const path = `/services/${serviceId}/env-vars?${q}`;
    let r;
    try {
      r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    } catch (e) {
      return { rows: null, truncated: false, error: `GET ${path} threw: ${e?.message ?? String(e)}` };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { rows: null, truncated: false, error: `GET ${path} → ${r.status} ${r.statusText} ${body}`.trim() };
    }
    let json;
    try {
      json = await r.json();
    } catch (e) {
      return { rows: null, truncated: false, error: `GET ${path} returned unparseable JSON: ${e?.message ?? String(e)}` };
    }
    if (!Array.isArray(json)) {
      return { rows: null, truncated: false, error: `GET ${path} returned ${typeof json}, expected an array` };
    }
    for (const entry of json) rows.push(entry?.envVar ?? entry);
    if (json.length < ENV_VAR_PAGE) return { rows, truncated: false };
    // A full page with no cursor to follow: we cannot prove we reached the end.
    cursor = json[json.length - 1]?.cursor;
    if (!cursor) return { rows, truncated: true };
  }
  return { rows, truncated: true };
}

// What the host is EXECUTING right now — the operand of the rollback gate (TRA-3625).
//
// ⛔ DELIBERATELY the process's own answer (/api/health/version), not the Render deploy
// list, and deliberately NOT `api()`. Same reasoning as fetchEnvVarProbe: an unreachable
// health route is the gate going BLIND, not a usage error, and it must say so under its
// own exit code. The deploy list is also the wrong source — it can say `live` for a build
// the pm2 watchdog has since restarted off of (TRA-2203/TRA-2261).
// SLUG, not name: the onrender hostname is derived from the slug and does not track a
// service rename (TRA-3736/TRA-3743). This URL was always right; it is now labelled.
const LIVE_HEALTH_URL = process.env.ROLLBACK_LIVE_URL ?? `https://${SOAK_HOST_SLUG}.onrender.com/api/health/version`;
const LIVE_PROBE_TIMEOUT_MS = 25_000;

async function fetchLiveCommit() {
  let res;
  try {
    res = await fetch(LIVE_HEALTH_URL, { signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS) });
  } catch (e) {
    return { sha: null, error: `GET ${LIVE_HEALTH_URL} failed: ${e?.message ?? String(e)}` };
  }
  if (!res.ok) return { sha: null, error: `GET ${LIVE_HEALTH_URL} returned HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { sha: null, error: `GET ${LIVE_HEALTH_URL} did not return JSON: ${e?.message ?? String(e)}` };
  }
  const commit = body?.commit;
  // A build that could not read its own SHA still reports SOMETHING. Do not grade a
  // placeholder as a commit — that would silently turn the gate into a rubber stamp.
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    return {
      sha: null,
      error:
        `${LIVE_HEALTH_URL} carried no usable commit (commit=${JSON.stringify(commit)}, ` +
        `commitSource=${JSON.stringify(body?.commitSource)})`,
    };
  }
  // Resolve against this checkout so the ancestry tests below have a real object. A live
  // sha we have never fetched is BLIND, not "far away" — same call as check:deploy-drift.
  const rev = git(['rev-parse', `${commit}^{commit}`]);
  if (rev.status !== 0) {
    return {
      sha: null,
      error:
        `the LIVE commit ${commit} is unknown to this checkout — it may predate a fetch, or the ` +
        'host may be running a build that was never pushed here. Run `git fetch origin` and re-run',
    };
  }
  return { sha: (rev.stdout ?? '').trim(), reported: commit, startedAt: body?.startedAt ?? null };
}

// The cadence gate's history (TRA-4535). Deliberately NOT `api()`, for the reason given at
// fetchEnvVarProbe: an unreadable deploy list is this gate going BLIND under exit 10, not a
// usage error under exit 2. Pages newest-first until it holds a COUNTING deploy created before
// `lowerMs` (the baseline the window's first advance is measured from), or the history ends.
// It stops there, so a normal night costs one request. Anything short of that returns
// `exhausted: false`, and countCommitAdvances turns a missing baseline into BLIND.
const DEPLOY_HISTORY_PAGE = 100;
const DEPLOY_HISTORY_MAX_PAGES = 10;

async function fetchDeployHistory(serviceId, lowerMs) {
  const rows = [];
  let cursor;
  for (let page = 0; page < DEPLOY_HISTORY_MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ limit: String(DEPLOY_HISTORY_PAGE) });
    if (cursor) q.set('cursor', cursor);
    const path = `/services/${serviceId}/deploys?${q}`;
    let r;
    try {
      r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    } catch (e) {
      return { rows: null, error: `GET ${path} threw: ${e?.message ?? String(e)}` };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { rows: null, error: `GET ${path} → ${r.status} ${r.statusText} ${body}`.trim() };
    }
    let json;
    try {
      json = await r.json();
    } catch (e) {
      return { rows: null, error: `GET ${path} returned unparseable JSON: ${e?.message ?? String(e)}` };
    }
    if (!Array.isArray(json)) return { rows: null, error: `GET ${path} returned ${typeof json}, expected an array` };
    rows.push(...json);
    if (json.length < DEPLOY_HISTORY_PAGE) return { rows, exhausted: true };
    const baselineInHand = json.some(e => {
      const d = e?.deploy ?? e;
      return Date.parse(d?.createdAt) < lowerMs && !CADENCE_NON_COUNTING_STATUSES.has(d?.status);
    });
    if (baselineInHand) return { rows, exhausted: false };
    cursor = json[json.length - 1]?.cursor;
    if (!cursor) return { rows, exhausted: false };
  }
  return { rows, exhausted: false };
}

async function resolveService() {
  if (SERVICE_ID_ENV) return api(`/services/${SERVICE_ID_ENV}`);
  const r = await resolveServiceByName(SERVICE_NAME, api);
  if (!r.service) fail(2, explainUnresolved(SERVICE_NAME, r));
  // Say WHICH string matched. Resolving the money host by its slug is correct and
  // supported, and it is also the exact moment an operator is one identity field away
  // from talking to a service they did not mean.
  if (r.matchedOn === 'slug') {
    console.log(
      `[render-redeploy] resolved "${SERVICE_NAME}" by SLUG -> ${r.service.id} ` +
        `(Render name="${r.service.name}")`,
    );
  }
  return r.service;
}

// TRA-3991 — what is the freeze HOLDING? The exit-4 refusal above used to answer only
// "may I deploy now" (no). On 2026-08-24 the answer to the question nobody asked — "is a
// safety remedy waiting behind this refusal" — was yes (`a5a49717`), and the engine sold
// the row it bounds 43 min before the post-close deploy. So the refusal now names the
// partition of `live..target` by the safety set. It is READ-ONLY: it never authorizes an
// override and never deploys. Every unreadable leg is reported BLIND, not "none".
export async function describeHeldSafetyLag(service, target) {
  const host = (service?.serviceDetails?.url ?? DEPLOY_LAG_DEFAULT_HOST).replace(/\/+$/, '');
  try {
    const live = await readDeployLagLive(host);
    const lag = deployLagState({ liveSha: live.commit, baseRef: target?.sha });
    if (lag.verdict === 'CURRENT') {
      return `  holding : nothing — live ${lag.live.slice(0, 8)} is already the target. This deploy is a RESTART.`;
    }
    const safety = lag.safetyBehind;
    if (safety.length === 0) {
      return (
        `  holding : ${lag.behind.length} commit(s) behind live ${lag.live.slice(0, 8)}, NONE on the safety set\n` +
        `            (scripts/check-deploy-lag.mjs). Staging for post-close costs a measurement, not a hazard.`
      );
    }
    const lines = safety.map(
      c => `            ⛔ ${c.short} ${c.committedAt}  ${c.subject.slice(0, 80)}\n` +
        c.hits.map(h => `               ${h.path} — ${h.why}`).join('\n'),
    );
    return (
      `  holding : ${lag.behind.length} commit(s) behind live ${lag.live.slice(0, 8)}, of which ${safety.length} touch the SAFETY set:\n` +
      `${lines.join('\n')}\n` +
      `            ⛔ SAFETY_LAG (TRA-3991). This refusal is holding a safety-path remedy while the hazard it\n` +
      `            closes is reachable in RTH. That is a DECISION, not a default: either re-run with\n` +
      `            --force-rth-override="<why it cannot wait>", or write on the remedy's ticket why it CAN wait.\n` +
      `            Nothing here authorizes the override.`
    );
  } catch (e) {
    return (
      `  holding : BLIND — could not partition live..target by the safety set (${e?.message ?? e}).\n` +
      `            Unreadable is NOT "nothing waiting". Run scripts/check-deploy-lag.mjs by hand before staging.`
    );
  }
}

// Is `now` inside the RTH freeze window? Weekend deploys are always allowed (market
// closed → no live soak session to fragment).
export function freezeState(now) {
  const dow = now.getUTCDay(); // 0 Sun … 6 Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow = min >= FREEZE_OPEN_MIN && min < FREEZE_CLOSE_MIN;
  return { frozen: isWeekday && inWindow, isWeekday, min };
}

// Is `now` inside a dated embargo? Half-open [from, to): an embargo that ends at 20:20Z
// is OPEN at 20:20:00Z exactly, which is the instant the ticket names as clear.
export function embargoState(now, table = EMBARGOES) {
  const t = now.getTime();
  const active = table.find(e => t >= Date.parse(e.from) && t < Date.parse(e.to)) ?? null;
  const upcoming = table
    .filter(e => Date.parse(e.from) > t)
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))[0] ?? null;
  const minsToUpcoming = upcoming ? Math.round((Date.parse(upcoming.from) - t) / 60000) : null;
  return { active, upcoming, minsToUpcoming };
}

async function main() {
  // ── Gate −2: the ARGUMENT GUARD (TRA-4420) ──────────────────────────────────
  // FIRST — ahead of even the deploy hold, which was previously the first thing to run.
  // Nothing here reads a file, a git ref, an env var or the network, so a run refused at
  // this point cannot have had any effect anywhere. That property is the whole fix: on
  // 2026-09-09 `--help` reached the bottom of this function and POSTed a deploy to bqb1.
  //
  // It lives INSIDE main() rather than at module scope on purpose: this file is imported
  // for its gate predicates by tra2325-embargo-gate-check.mjs and tra3699-shallow-hold-repro
  // .mjs, and a module-scope process.exit() would fire on THEIR argv.
  {
    const args = classifyArgs(argv);
    if (args.help) {
      console.log(renderUsage());
      process.exit(0);
    }
    if (args.problems.length) {
      console.error(renderArgRefusal(args.problems));
      process.exit(2);
    }
  }

  // ── Gate −1: the repo-resident deploy hold (TRA-4261) ───────────────────────
  // FIRST, ahead of the API key check and therefore ahead of every byte on the wire. Two
  // reasons, and the second is the one that matters:
  //   1. It is the only gate that needs nothing from the network, so making the operator
  //      supply a key before being told they may not deploy is pure friction.
  //   2. AC1 of TRA-4261 is that the refusal lands BEFORE Render is contacted. Running it
  //      here makes that structural rather than a claim: at this point in main() no fetch
  //      has been issued and no deploy object exists anywhere.
  // It is NOT scoped to isSoakHost, because isSoakHost is only knowable after a Render
  // round-trip. Scope lives in the hold's own `service` block and is evaluated against the
  // service ref this invocation is aimed at (see requestedServiceRef, which mirrors
  // resolveService's precedence exactly).
  const holdRead = readDeployHolds();
  const holdRef = requestedServiceRef();
  const deployHold = deployHoldState(holdRead, holdRef);

  // Gate −1b (TRA-4262): does each applicable hold's `emits` still describe the tip this
  // invocation would ship? Read-only — it can make a refusal louder, never lift one, and
  // never turns a proceed into a refusal. Still no network: the comparison sha comes from
  // the local remote-tracking ref (or --commit), so the reported drift is a lower bound.
  // Gate −1c (TRA-4268): and WHICH WINDOW does that `emits` claim to cover? −1b grades the
  // list's HEAD; this grades its START. Also offline — both operands are shas in the file,
  // so it costs one `merge-base --is-ancestor` and no network.
  const holdStaleness = new Map();
  const holdBaseline = new Map();
  if (deployHold.applicable.length) {
    const enumProbe = gitEnumerationProbe();
    for (const h of deployHold.applicable) {
      holdStaleness.set(h, deployHoldStaleness(h, enumProbe));
      holdBaseline.set(h, deployHoldBaseline(h, enumProbe));
    }
  }

  if (deployHoldBlocks(deployHold.verdict) && !HAS_HOLD_OVERRIDE) {
    console.error(renderDeployHoldRefusal(deployHold, { staleness: holdStaleness, baselines: holdBaseline }));
    process.exit(9);
  }

  if (deployHoldBlocks(deployHold.verdict) && HAS_HOLD_OVERRIDE) {
    if (!HOLD_OVERRIDE_REASON || !HOLD_OVERRIDE_REASON.trim()) {
      fail(2, '--override-hold requires a non-empty reason, e.g. --override-hold="TRA-4217 board cleared it on card 438ed4c5".');
    }
    const tokens = deployHoldOverrideTokens(deployHold.applicable);
    if (!deployHoldOverrideNames(HOLD_OVERRIDE_REASON, tokens)) {
      fail(
        2,
        `--override-hold must NAME the hold it breaks. Active hold(s): ${tokens.join(', ')}. ` +
          `Re-run with the ticket in the reason, e.g. --override-hold="${tokens[0]} why this cannot wait". ` +
          `Got: "${HOLD_OVERRIDE_REASON}".`,
      );
    }
    // Echoed on the way IN, before anything is deployed, so the breach is in the same
    // scrollback as the deploy it authorised and not appended after the fact.
    console.error(
      `[render-redeploy] ⚠ OVERRIDING ${
        deployHold.verdict === 'BLIND' ? 'an UNREADABLE deploy-hold file' : `${deployHold.applicable.length} REPO-RESIDENT DEPLOY HOLD(S)`
      } at ${new Date().toISOString()} — TRA-4261.\n` +
        `  override: --override-hold="${HOLD_OVERRIDE_REASON}"\n` +
        (deployHold.verdict === 'BLIND'
          ? `  blind   : ${deployHold.why}\n`
          : deployHold.applicable
              .map(h => {
                // TRA-4262: the override echo is the LAST place the emits list is read
                // before bytes move, so it is the last place its staleness can be said.
                const st = holdStaleness.get(h);
                const stale =
                  st && st.status !== 'CURRENT'
                    ? `  ⚠ stale   : ${st.status} — emits[] was enumerated against ${st.tip ? st.tip.slice(0, 12) : '(unstamped)'}${
                        st.status === 'STALE' ? `, ${st.commits.length} commit(s) and ${st.serverPaths.length} server-byte path(s) since` : ''
                      }. You are overriding a list that does NOT describe what you are shipping (TRA-4262).\n`
                    : '';
                // TRA-4268: and say what window the list covers, in the same breath. The
                // override echo is the last place emits[] is read before bytes move, so it
                // is the last place its START POINT can be said.
                const bl = holdBaseline.get(h);
                const window = bl
                  ? `  window  : ${bl.baseline ? bl.baseline.slice(0, 12) : '???'}..${bl.head ? bl.head.slice(0, 12) : '???'}${
                      deployHoldBaselineIsLoud(bl.status)
                        ? `  ⚠ ${bl.status} — ${bl.why}. The baseline for emits[] is the LIVE DEPLOYED PIN, never the enumerator's starting tip (TRA-4268).`
                        : '  (from the live deployed pin — re-read it, do not recall it)'
                    }\n`
                  : '';
                return `  broken  : ${h.ticket} (opened ${h.openedAt} by ${h.openedBy})\n${window}  emits   : ${h.emits.join('\n            ')}\n${stale}`;
              })
              .join('')) +
        `  Tell the hold's owner BEFORE the box boots, not after. If the hold is genuinely dead,\n` +
        `  delete the entry from ${DEPLOY_HOLD_FILE} in a commit — an override is a breach on the\n` +
        `  record, not a way to leave a stale hold standing.`,
    );
  }

  // Holds exist but none covers this service. Not a refusal, and deliberately not silent:
  // "I read the hold file and it does not apply to you" is a different fact from "there is
  // no hold file", and an operator who is one identity field from the money host should be
  // told which one they got.
  if (deployHold.verdict === 'OUT_OF_SCOPE') {
    console.log(
      `[render-redeploy] NOTE: ${deployHold.skipped.length} deploy hold(s) in ${DEPLOY_HOLD_FILE} ` +
        `(${deployHold.skipped.map(h => h.ticket).join(', ')}) do NOT cover ${holdRef.kind}=${holdRef.value}. TRA-4261.`,
    );
  }

  if (!API_KEY) fail(2, 'RENDER_API_KEY is required (never commit it).');

  const service = await resolveService();
  const isSoakHost =
    service.id === SOAK_HOST_ID || service.name === SOAK_HOST_NAME || service.slug === SOAK_HOST_SLUG;

  const now = new Date();
  const { frozen } = freezeState(now);
  const { active: embargo, upcoming, minsToUpcoming } = embargoState(now);
  const nowZ = now.toISOString().slice(11, 16) + 'Z';

  // Say it ONCE, up front, before any gate speaks — because on a shallow checkout the two
  // ancestry gates below can only ever answer YES or BLIND, and a reader who meets the BLIND
  // first will go looking for a missing object that is not missing (TRA-3699).
  if (isSoakHost && isShallowCheckout()) {
    console.log(
      '[render-redeploy] NOTE: this checkout is SHALLOW. A NEGATIVE ancestry answer is unreadable\n' +
        '  here — a grafted-away path and a genuine absence produce the SAME git exit code — so the\n' +
        '  commit-hold and rollback gates report BLIND (refuse) rather than guessing PROCEED.\n' +
        '  Run `git fetch origin --unshallow` and re-run to get a real answer. TRA-3699.',
    );
  }

  // ── Gate 0: the host's live AUTH_SECRET (TRA-2387) ──────────────────────────
  // FIRST of the four, on severity. The other three protect a measurement: breaking them
  // costs a soak session, a graded read, or an instrument's continuity. This one protects
  // the service being reachable at all — an unusable AUTH_SECRET under NODE_ENV=production
  // makes resolveAuthSecret() THROW at boot, so the deploy does not degrade bqb1, it takes
  // it down. Report the outage risk before the calendar.
  const authProbe = await fetchEnvVarProbe(service.id);
  const authGate = authSecretGateState(authProbe, {
    keyRequired: AUTH_SECRET_REQUIRED_ON.has(service.id) || AUTH_SECRET_REQUIRED_ON.has(service.name),
  });
  const authBlocking = authSecretBlocks(authGate.verdict);

  // The caveat this gate must repeat wherever it speaks, refusal or not
  // (TRA-2186/TRA-2325, narrowed by TRA-3724 — see ENV_WRITE_TRUTH).
  const AUTH_ENV_WRITE_CAVEAT =
    'NOTE: this gate reads the value; it cannot guard the WRITE. Blanking AUTH_SECRET in the\n' +
    '  dashboard is itself an env write, so the gate cannot see its own most likely cause.\n' +
    '  ' +
    ENV_WRITE_CAVEAT_SHORT +
    '\n  What it DOES catch is the state that outlives that write: a boot that throws never goes\n' +
    '  live, Render keeps the previous process serving, and the box then runs healthy on an\n' +
    '  in-memory secret with a broken env until somebody deploys.';

  if (authBlocking && !HAS_AUTH_SECRET_OVERRIDE) {
    // TRA-2306: resolve the hold/embargo picture HERE. This refusal exits before Gate 2 and
    // Gate 3 ever run, and the FIX it prints is an env write — see envWriteHoldWarning().
    // Deliberately resolves the TIP (no COMMIT): an env write ships the tip regardless.
    const tipHold = commitHoldState(now, resolveTarget(service.branch ?? 'main', undefined));
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) — its live AUTH_SECRET ${
        authGate.verdict === 'UNUSABLE'
          ? `is ${authGate.detail} [${authGate.shape}]`
          : 'COULD NOT BE READ, so this gate is BLIND and fails closed'
      }.\n` +
        (authGate.why ? `  blind   : ${authGate.why}\n` : '') +
        `  resolveAuthSecret() (packages/server/src/auth.ts:34) accepts the value only if\n` +
        `  fromEnv.trim().length > 0 and THROWS under NODE_ENV=production otherwise. Deploying now\n` +
        `  would boot a process that refuses to start; if it did start, it would re-roll the HMAC\n` +
        `  signing key on every boot and sign out every logged-in user (the TRA-2296 P1).\n` +
        `  FIX: set a real AUTH_SECRET on the service, then re-run. Verify with\n` +
        `  RENDER_API_KEY=… node scripts/tra2296-auth-secret-check.mjs (TRA-2315 predicate).\n` +
        `  If you must ship anyway, re-run with --force-auth-secret-override="why" (recorded).\n` +
        `  ${AUTH_ENV_WRITE_CAVEAT}` +
        envWriteHoldWarning({ holdCheck: tipHold, embargo, isSoakHost }),
    );
    process.exit(7);
  }

  if (authBlocking && HAS_AUTH_SECRET_OVERRIDE) {
    if (!AUTH_SECRET_OVERRIDE_REASON || !AUTH_SECRET_OVERRIDE_REASON.trim()) {
      fail(
        2,
        '--force-auth-secret-override requires a non-empty reason, e.g. --force-auth-secret-override="NODE_ENV is not production on this host".',
      );
    }
    console.error(
      `[render-redeploy] WARNING: deploying ${service.name} with AUTH_SECRET ${
        authGate.verdict === 'UNUSABLE' ? authGate.detail : 'UNREADABLE'
      } at ${nowZ}. Reason: ${AUTH_SECRET_OVERRIDE_REASON}. If NODE_ENV=production on this host the ` +
        `new process will THROW at boot and Render will keep the old one serving; if it does boot, ` +
        `every existing session is invalidated. Have scripts/render-deploy-status.mjs open.`,
    );
  }

  // Content gate BEFORE the two time gates: it is the one that can fire while the calendar
  // is wide open, and its remedy is different — deploy a different COMMIT, not at a
  // different HOUR. Reporting "outside freeze, no embargo" first would answer a question
  // the caller did not ask.
  const target = resolveTarget(service.branch ?? 'main', COMMIT);
  const holdCheck = commitHoldState(now, target);

  if (isSoakHost && holdCheck.verdict !== 'CLEAR' && !HAS_COMMIT_HOLD_OVERRIDE) {
    const h = holdCheck.hold;
    console.error(
      `[render-redeploy] REFUSED: this deploy ${
        holdCheck.verdict === 'CARRIES' ? 'CARRIES A HELD COMMIT' : 'CANNOT BE PROVEN CLEAR of a held commit'
      } — ${h.ticket}.\n` +
        `  held    : ${h.commit}\n` +
        `  target  : ${target.sha ?? '(unresolved)'}  [${target.source}]\n` +
        (holdCheck.why ? `  blind   : ${holdCheck.why}\n` : '') +
        `  ${h.why}\n` +
        `  The hold expires ${h.until}. Deploy a commit that predates the held one\n` +
        `  (--commit=<sha>), or wait. If it is truly urgent, re-run with\n` +
        `  --force-commit-hold-override="why this cannot wait" (the reason is recorded).\n` +
        `  NOTE: a commit hold, like the embargo, covers DEPLOYS ONLY. ${ENV_WRITE_CAVEAT_SHORT}`,
    );
    process.exit(6);
  }

  if (isSoakHost && holdCheck.verdict !== 'CLEAR' && HAS_COMMIT_HOLD_OVERRIDE) {
    if (!COMMIT_HOLD_OVERRIDE_REASON || !COMMIT_HOLD_OVERRIDE_REASON.trim()) {
      fail(2, '--force-commit-hold-override requires a non-empty reason, e.g. --force-commit-hold-override="P0 hotfix".');
    }
    console.error(
      `[render-redeploy] WARNING: shipping past the ${holdCheck.hold.ticket} commit hold at ${nowZ}. ` +
        `Reason: ${COMMIT_HOLD_OVERRIDE_REASON}. The measurement that hold protects is now suspect — ` +
        `tell the ticket owner BEFORE its grade publishes, not after.`,
    );
  }

  // ── Gate 4: would this deploy ROLL THE HOST BACK? (TRA-3625) ────────────────
  // Sits next to the commit hold because it is the other "may I deploy THIS?" question,
  // and ahead of the two calendar gates for the same reason they are: its remedy is a
  // different COMMIT, not a different HOUR, so answering "outside freeze" first would
  // answer a question the caller did not ask.
  const live = isSoakHost ? await fetchLiveCommit() : null;
  const rollback = isSoakHost ? rollbackState(target, live) : { verdict: 'NOT_GATED', why: null };

  // ── The NETWORK half of the emits[] baseline (TRA-4268, AC4) ───────────────
  // Here, and NOT at gate −1, because gate −1 is offline by design and that is why its
  // refusal precedes any byte on the wire. This point already holds the live pin, so the
  // check is free. Read-only: it never refuses and never lifts anything. It is printed
  // BEFORE the rollback refusal below, so it is on the record even when Gate 4 then exits.
  // Reachable only when applicable holds were overridden — which is the moment it matters.
  if (isSoakHost && deployHold.applicable.length) {
    for (const h of deployHold.applicable) {
      const drift = deployHoldPinDrift(h, live);
      const text = renderDeployHoldPinDrift(h, drift);
      if (deployHoldPinDriftIsLoud(drift.status)) console.error(text);
      else console.log(text);
    }
  }

  if (isSoakHost && rollbackBlocks(rollback.verdict) && !HAS_ROLLBACK_OVERRIDE) {
    const dropped =
      rollback.verdict === 'ROLLBACK' && live?.sha && target.sha
        ? git(['log', '--format=%h %s', `${target.sha}..${live.sha}`])
        : null;
    console.error(
      `[render-redeploy] REFUSED: this deploy would ${
        rollback.verdict === 'ROLLBACK'
          ? 'ROLL THE HOST BACK'
          : rollback.verdict === 'DIVERGED'
            ? 'REPLACE THE SERVING HISTORY'
            : 'CANNOT BE PROVEN not to roll the host back'
      } — TRA-3625.\n` +
        `  live    : ${live?.sha ?? '(unreadable)'}${live?.reported ? `  [reported ${live.reported}]` : ''}\n` +
        `  target  : ${target.sha ?? '(unresolved)'}  [${target.source}]\n` +
        (rollback.why ? `  blind   : ${rollback.why}\n` : '') +
        (dropped?.status === 0 && dropped.stdout?.trim()
          ? `  These commits are SERVING NOW and this deploy REMOVES them:\n` +
            dropped.stdout
              .trim()
              .split('\n')
              .map(l => `    ✗ ${l}`)
              .join('\n') +
            '\n'
          : '') +
        `  A pinned --commit ages: it was the tip when somebody wrote it into a carrier, and a\n` +
        `  deploy carrier is EXECUTED whenever its assignee's queue reaches it, not when it fires.\n` +
        `  Nothing between those two instants re-derives the pin.\n` +
        `  FIX: drop --commit and let Render take the branch tip. check:deploy-train-window grades\n` +
        `  a deploy order by ANCESTRY ("is the ordered commit an ancestor of live?"), not equality,\n` +
        `  so deploying the TIP still satisfies an order that names an older sha.\n` +
        `  If the rollback is the POINT (reverting a bad build, or clearing a commit hold per the\n` +
        `  Gate 2 refusal above), re-run with --allow-rollback="why" — the reason is recorded.`,
    );
    process.exit(8);
  }

  if (isSoakHost && rollbackBlocks(rollback.verdict) && HAS_ROLLBACK_OVERRIDE) {
    if (!ROLLBACK_OVERRIDE_REASON || !ROLLBACK_OVERRIDE_REASON.trim()) {
      fail(2, '--allow-rollback requires a non-empty reason, e.g. --allow-rollback="reverting the bad c0ffee build".');
    }
    console.error(
      `[render-redeploy] WARNING: deploying ${rollback.verdict} onto ${service.name} at ${nowZ}. ` +
        `Reason: ${ROLLBACK_OVERRIDE_REASON}. Anything graded green against the code you are removing ` +
        `is no longer evidence about this host — re-read it after the boot, and tell whoever published it.`,
    );
  }

  // ── The CADENCE CEILING (TRA-4535) — exit 10 ────────────────────────────────
  // After Gate 4, because it needs the live commit Gate 4 already read: the same-SHA exemption
  // IS "target equals live". AHEAD of the embargo and the RTH freeze on purpose. On a night when
  // a stopgap embargo row and a spent ceiling cover the same deploy, the count names the trains
  // that spent the window, where the embargo refusal only names a row. And a deploy made under
  // --force-rth-override must still meet it: that was the free second train in the spec's shape
  // of the window (see the block at CADENCE_CEILINGS).
  // Only the soak host, and only inside a ceiling row. Outside one it costs no request at all.
  const cadenceCeiling = isSoakHost ? activeCadenceCeiling(now) : null;
  const cadenceHistory = cadenceCeiling ? await fetchDeployHistory(service.id, cadenceLowerBound(now, cadenceCeiling)) : null;
  const cadence = cadenceState(now, { history: cadenceHistory, target, live }, isSoakHost ? CADENCE_CEILINGS : []);

  if (cadenceBlocks(cadence.verdict) && !HAS_CADENCE_OVERRIDE) {
    console.error(renderCadenceRefusal(cadence));
    process.exit(10);
  }

  if (cadenceBlocks(cadence.verdict) && HAS_CADENCE_OVERRIDE) {
    if (!CADENCE_OVERRIDE_REASON || !CADENCE_OVERRIDE_REASON.trim()) {
      fail(2, '--override-cadence requires a non-empty reason, e.g. --override-cadence="TRA-4512 P0: the exit path is down".');
    }
    if (!cadenceOverrideNamesTicket(CADENCE_OVERRIDE_REASON)) {
      fail(
        2,
        `--override-cadence must NAME the ticket this extra train is for (a TRA-#### token). ` +
          `Got: "${CADENCE_OVERRIDE_REASON}".`,
      );
    }
    console.error(
      `[render-redeploy] ⚠ OVERRIDING the ${cadence.ceiling.ticket.split(' ')[0]} CADENCE CEILING at ${new Date().toISOString()} — TRA-4535.\n` +
        `  override: --override-cadence="${CADENCE_OVERRIDE_REASON}"\n` +
        `  verdict : ${cadence.verdict}${cadence.why ? ` — ${cadence.why}` : ''}\n` +
        `  window  : ${renderCadenceLine(cadence, { overridden: true })}\n` +
        (cadence.advances.length ? `${cadenceAdvanceLines(cadence).join('\n')}\n` : '') +
        `  This is commit advance #${cadence.advances.length + 1} in the window. Tell the freeze owner on ` +
        `${cadence.ceiling.ticket.split(' ')[0]} BEFORE the box boots, not after.`,
    );
  }

  if (isSoakHost && embargo && !HAS_EMBARGO_OVERRIDE) {
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) is under a DATED EMBARGO ` +
        `(${embargo.from} → ${embargo.to}, ${embargo.ticket}).\n` +
        `  ${embargo.why}\n` +
        `  Deploy before ${embargo.from} or after ${embargo.to}, or, if it is truly urgent, re-run with\n` +
        `  --force-embargo-override="why this cannot wait" (the reason is recorded).\n` +
        `  NOTE: this refusal covers DEPLOYS ONLY. ${ENV_WRITE_CAVEAT_SHORT}`,
    );
    process.exit(5);
  }

  if (isSoakHost && embargo && HAS_EMBARGO_OVERRIDE) {
    if (!EMBARGO_OVERRIDE_REASON || !EMBARGO_OVERRIDE_REASON.trim()) {
      fail(2, '--force-embargo-override requires a non-empty reason, e.g. --force-embargo-override="P0 hotfix".');
    }
    console.error(
      `[render-redeploy] WARNING: breaking the ${embargo.ticket} embargo on ${service.name} at ${nowZ}. ` +
        `Reason: ${EMBARGO_OVERRIDE_REASON}. This restart destroys — not degrades — every in-memory ` +
        `counter the embargoed reads depend on. Tell the ticket owner.`,
    );
  }

  if (isSoakHost && frozen && !HAS_OVERRIDE) {
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) is the go-live soak host and it is ` +
        `${nowZ}, inside the RTH freeze window 13:25–20:00Z (RTH is 13:30–20:00Z; the freeze opens ` +
        `${DEPLOY_LEAD_MIN} min early because a deploy created now BOOTS the box inside RTH).\n` +
        `  A mid-RTH deploy dumps the warm quote cache and resets the TRA-1648 soak clock (see TRA-1996).\n` +
        `  Stage this deploy for pre-open (<13:25Z) or post-close (>20:00Z), or, if it is truly urgent,\n` +
        `  re-run with --force-rth-override="why this cannot wait" (the reason is recorded).`,
    );
    console.error(await describeHeldSafetyLag(service, target));
    process.exit(4);
  }

  if (isSoakHost && frozen && HAS_OVERRIDE) {
    if (!OVERRIDE_REASON || !OVERRIDE_REASON.trim()) {
      fail(2, '--force-rth-override requires a non-empty reason, e.g. --force-rth-override="hotfix for X".');
    }
    console.error(
      `[render-redeploy] WARNING: overriding the RTH freeze on ${service.name} at ${nowZ}. ` +
        `Reason: ${OVERRIDE_REASON}. This resets the TRA-1648 soak clock — expect the session to be disqualified.`,
    );
  }

  // TRA-4420, second line of defence, AT THE EDGE. Gate −2 already refused an argv with no
  // target, so this is unreachable — which is the point: an omitted `commitId` means "ship
  // the tip", and that must never again be something this script can arrive at by falling
  // through. If a future refactor loses the guard, the failure lands HERE, one statement
  // before the POST, instead of on the host. (TRA-2262: verify the EDGE, not the node.)
  if (!COMMIT && !WANTS_TIP) {
    fail(2, 'internal: reached the deploy with no --commit and no --tip. Refusing to ship the branch tip by default (TRA-4420).');
  }
  const body = {};
  if (COMMIT) body.commitId = COMMIT;
  if (CLEAR_CACHE) body.clearCache = 'clear';

  console.log(`service : ${service.name} (${service.id})`);
  console.log(`window  : ${nowZ} — ${isSoakHost ? (frozen ? 'RTH FREEZE (soak host)' : 'outside freeze') : 'not the soak host'}`);
  // ⚠ RIDER (TRA-2387): "OVERRIDDEN" was printed for a non-soak host too, where the embargo
  // and hold gates never ran at all (both are `isSoakHost && …`). Nothing was overridden
  // there and nobody forced anything — but the word says an operator broke a board-ratified
  // hold, which is the single most alarming thing this output can claim. Distinguish
  // "gated and forced past" from "not gated on this host".
  console.log(
    `embargo : ${
      embargo
        ? `ACTIVE ${embargo.from}→${embargo.to} (${embargo.ticket}) — ${isSoakHost ? 'OVERRIDDEN' : 'not gated on this host'}`
        : upcoming
          ? `none now; next ${upcoming.from}→${upcoming.to} (${upcoming.ticket}), in ${minsToUpcoming} min`
          : 'none scheduled'
    }`,
  );
  if (isSoakHost && !embargo && upcoming && minsToUpcoming <= 60) {
    console.log(
      `          ⚠ that embargo starts in ${minsToUpcoming} min and a deploy created now boots the box ` +
        `~${DEPLOY_LEAD_MIN} min from now. If this can wait, wait for ${upcoming.to}.`,
    );
  }
  // Name the RESOLVED sha, never just "(service branch tip)" — that string reads identically
  // whether the tip is the commit you meant or the one somebody landed ten minutes ago.
  console.log(
    `commit  : ${target.sha ?? '(unresolved)'} [${target.source}]${CLEAR_CACHE ? ' + clear-cache' : ''}`,
  );
  // Print the live sha and the direction on EVERY run, not only on a refusal. "commit :"
  // one line up names what ships; without this line nothing on a green run says what it
  // REPLACES, and a no-op redeploy and a two-commit advance read identically (TRA-3625).
  console.log(
    `live    : ${
      !isSoakHost
        ? '(not the soak host — rollback gate N/A)'
        : rollback.verdict === 'NOOP'
          ? `${short(live.sha)} — target is the SAME build; this deploy changes no code, it only reboots`
          : rollback.verdict === 'FORWARD'
            ? `${short(live.sha)} → ${short(target.sha)} FORWARD, nothing serving is removed`
            : `${live?.sha ? short(live.sha) : 'UNREADABLE'} — ${rollback.verdict}, OVERRIDDEN`
    }`,
  );
  {
    const note = stalePinNote(target, resolveTarget(service.branch ?? 'main', undefined).sha);
    if (note) console.log(note);
  }
  // TRA-4535: printed on every run, so a green run still says how much of tonight it spends.
  console.log(
    `cadence : ${renderCadenceLine(cadence, { isSoakHost, overridden: HAS_CADENCE_OVERRIDE && cadenceBlocks(cadence.verdict) })}`,
  );
  console.log(
    `holds   : ${
      holdCheck.active.length === 0
        ? 'none active'
        : holdCheck.verdict === 'CLEAR'
          ? `${holdCheck.active.length} active (${holdCheck.active.map(h => h.ticket).join(', ')}) — target carries none of them`
          : `${holdCheck.verdict} ${holdCheck.hold.ticket} — ${isSoakHost ? 'OVERRIDDEN' : 'not gated on this host'}`
    }`,
  );
  console.log(
    `auth    : AUTH_SECRET ${
      authGate.verdict === 'CLEAR'
        ? `${authGate.detail} — usable, the host will boot`
        : authGate.verdict === 'NOT_APPLICABLE'
          ? `${authGate.detail} (gate N/A on this service)`
          : authGate.verdict === 'UNUSABLE'
            ? `${authGate.detail} [${authGate.shape}] — OVERRIDDEN`
            : `UNREADABLE — BLIND, OVERRIDDEN (${authGate.why})`
    }`,
  );
  // Say what the gate does NOT see in the NORMAL output, not only in a refusal. A green
  // `auth :` line one line above is exactly the thing a reader turns into "the secret is
  // protected", and the write that breaks it never comes through this script.
  console.log(
    `          ⚠ this gate reads the VALUE, it does not guard the WRITE: blanking AUTH_SECRET is\n` +
      `            itself an env write and never passes through here. A green line means the value\n` +
      `            is usable RIGHT NOW, nothing more.`,
  );
  console.log(`note    : ${ENV_WRITE_CAVEAT_SHORT}`);
  // Print the LIVE governing setting, not a compiled belief about it (TRA-3724). The
  // 2026-07-23 change in env-write behaviour came from the platform, not from us, so the
  // only honest statement is the one re-read on this run.
  {
    const posture = envWriteAutoDeployPosture(service);
    console.log(`envdep  : ${posture.line}`);
  }

  if (DRY_RUN) {
    console.log('[render-redeploy] --dry-run: would POST /services/%s/deploys %j', service.id, body);
    process.exit(0);
  }

  const deploy = await api(`/services/${service.id}/deploys`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const d = deploy.deploy ?? deploy;
  console.log(`deploy  : ${d.id ?? '(unknown id)'} — ${d.status ?? 'triggered'}`);
  console.log('[render-redeploy] deploy triggered. Poll with scripts/render-deploy-status.mjs (RENDER_WATCH_MS=…).');
  process.exit(0);
}

// Run only when invoked directly, so the gate predicates above can be imported and
// exercised by scripts/tra2325-embargo-gate-check.mjs. `process.argv[1]` is absent when
// this module is imported.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(e => fail(2, e?.stack ?? String(e)));
}
