# TradingAI — repo conventions

## A health field reports the outcome of the last REAL attempt, never the configuration

Two separate multi-week outages were invisible because a health route reported our **intent** and
everyone read it as the **feed's state**:

- `feeds.anthropicConfigured: true` — a pure env-presence check — held through the entire
  2026-08 Anthropic credit outage (~4.8 weeks, TRA-3122/TRA-4434). Presence cannot go false when
  the vendor refuses to bill you, so the flag read identically in the pass state and the fail state.
- `queriesSucceeded: 0` on the news-catalyst route counted our **own breaker suppressing the
  request** in the same bucket as the vendor answering nothing (TRA-4805). Three triages read a
  self-inflicted block as a vendor outage; a 5-session feed outage read as ordinary quiet days.

The rule, when writing or reviewing any `/api/health/*` field:

1. **Report what the dependency actually DID last time it was exercised** — an outcome enum off the
   last real attempt (`ok` / `auth_rejected` / `credit_exhausted` / `rate_limited` / …), with the
   attempt's timestamp beside it. A config/presence fact may also be published, but name it as one
   (`*KeyPresent`, `*Configured`) and never let it stand in for liveness.
2. **Attribute the failure to the right side of the wire.** "We suppressed the call" (breaker open,
   spend cap, gate off) and "they refused/failed" (401, 429, 5xx) are different pages to different
   people — separate codes, never one rolled-up counter.
3. **Absent evidence reads as its own named state** (`never_attempted_this_boot` / `unknown` /
   `NOT MEASURED`), which is an alarm, not a pass. Fabricating an attribution from silence is how
   both incidents got misfiled.

Reference implementation: `deriveFeedsUsable` in `packages/server/src/options-ideas-feed.ts` and
`lastRunFeedFailures` on the news-catalyst route.

## Never type-check a single file with `tsc <file>`

```bash
npx tsc packages/server/src/demo-flags.ts   # ← NEVER. Poisons the tree.
```

When `tsc` is given explicit file arguments it **does not read `tsconfig.json`**. `outDir` and
`noEmit` are silently dropped and it emits the compiled `.js` **next to the input** — leaving
`src/demo-flags.js` sitting beside `src/demo-flags.ts`.

That stale sibling then wins module resolution, and vitest exercises the **compiled copy instead
of the source**:

- **server** — sources import with explicit ESM extensions (`./demo-flags.js`). Vite normally maps
  that back to `./demo-flags.ts`, but only while no real `.js` exists. When one does, it wins.
- **desktop** — imports are extensionless, and Vite's default `resolve.extensions` lists `.js`
  *before* `.ts`. Same outcome.

The failure mode that matters is the silent one. If the stale `.js` holds an **older, passing**
build while the current `.ts` is broken, the suite goes **GREEN against code you are not
shipping** — and sails straight through a verification gate. (TRA-1660; first hit on TRA-1515,
where it surfaced as six bogus `renderInfraDefaults is not a function` failures against a source
file that plainly exported it.)

Use instead:

```bash
pnpm typecheck   # builds the packages, then tsc --noEmit across the workspace
pnpm build       # tsc -b over the five @trading-app/* packages, emits to dist/
```

Both read `tsconfig.json` and emit to `dist/`, never into `src/`.

Until TRA-3720 (2026-08-19) this block was **aspirational**: root `build` read
`pnpm --filter desktop tauri build`, and `desktop` has no `tauri` script — `pnpm --filter <pkg> <name>`
runs a *script* called `<name>`, while `dev`/`build` there invoke the tauri *binary*. So the prescribed
safe command died in pnpm with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`, exit 1, without starting a compiler.
It now runs `tsc -b` for real (negative control: a planted `TS2322` exits 1 and names the file). The
tauri desktop build is not vestigial — `apps/desktop/src-tauri/` is real — and moved to
**`pnpm desktop:build`** / **`pnpm desktop:dev`**, with the same script-vs-binary bug fixed.

⚠️ **Never single-quote a `--filter` inside a `package.json` script.** pnpm runs scripts through
`cmd.exe` on Windows, where `'` is not a quote character, so pnpm receives the quotes as part of the
pattern, matches nothing, and **exits 0**. `web:build` carried `'./packages/**'` and therefore compiled
**zero packages while reporting success** on every Windows checkout — the silent-green direction this
whole file is about. Double quotes are honoured by `sh` and `cmd.exe` alike.

### The guard

```bash
pnpm check:stale-js          # fails if any emit shadows a TS source
pnpm check:stale-js -- --fix # delete the offending artifacts
```

It runs automatically in `pretest` and in CI ahead of build/test, so a poisoned tree fails loudly
instead of passing quietly. `.gitignore` also covers `packages/*/src` and `apps/desktop/src`, but
that only stops a stray `git add -A` from committing the emit — **it does not stop the shadowing**.
The guard is the part that does.

## A push to `main` runs the deploy's build first. It takes ~70s and it will refuse you.

`070a188a` reached `origin/main` carrying `error TS18047`, **eight further commits landed on top
of it**, and the thing that noticed was a live deploy to the money host — which then had to be
bisected forward commit-by-commit, briefly serving two off-tip mid-train builds. ~35 minutes off a
critical go-live path at 02:00Z. (TRA-3695, off TRA-3671.)

The defect was an **asymmetry, not a missing checker**. The *advisory* check ran pre-deploy and is
explicitly non-blocking:

```
[render-build] lint reported issues (non-blocking for deploy; fix via CI/pre-commit)
```

…while the *blocking* one — the packages' own `tsc -b` / `tsc -b --force`, as invoked by the deploy's
`render-build` — ran only at deploy time. (This sentence used to name `pnpm build` as that compile. It
never was: root `build` was the dead tauri verb, and even now it is a *local* verb, not on any deploy
chain. TRA-3720.) CI does
compile the packages, but CI runs **on push to main**, which is after the commit is on the branch
the deploy pulls from. A detector behind the branch is what we already had.

```bash
pnpm check:deploy-build              # grade HEAD in isolation
pnpm check:deploy-build --rev=<sha>  # grade any commit
pnpm check:deploy-build --worktree   # grade the dirty tree in place (fast local loop)
pnpm check:deploy-build:controls
#   0 CLEAN · 1 BROKEN (the incident) · 2 usage · 3 BLIND;  BLIND > BROKEN > CLEAN
```

It runs automatically from `.githooks/pre-push` and **refuses the push** on BROKEN *and* on BLIND —
"could not check" and "checked and it is fine" must never share an exit code. `git push --no-verify`
bypasses it and hands you the deploy.

**`tsc -b --force` type-checks the `.test.ts` files.** A broken test file does not fail the suite —
it fails the BUILD, without ever running. So "tests pass" is not evidence here, and neither is
`pnpm typecheck`, whose project graph is not the graph `packages/server` compiles. The gate
therefore runs **no proxy**: it parses the deploy's build script out of `package.json` and executes
those segments verbatim, and reads BLIND rather than guessing if the shape changes.

Which command the deploy runs is **not knowable from this repo** — `render.yaml` pins `web:build`,
the live bqb1 log prints `[render-build]`, and they are not the same chain (`render-build`
hardcodes four packages; `web:build` globs five — `packages/agents` is in the glob and not in the
list). The gate grades the **union** and does not have to be right about which one the dashboard
holds. A `render.yaml` re-pointed at some third script reads BLIND, not green.

**The subject is the commit being pushed, never your working tree.** It is built in a throwaway
`git worktree` with `node_modules` junctioned in. Grading the tree in place is wrong in both
directions: an unstaged fix passes a broken commit, and an unrelated dirty file fails a clean one —
and a gate that is red for reasons you did not cause gets `--no-verify`'d on day one, which is the
same end state as no gate.

The junction alone is not isolation: pnpm's `@trading-app/*` workspace links are absolute
junctions back into the main checkout, so a wholesale-junctioned `node_modules` graded the LOCAL
tree's `packages/*/dist`, not the commit (TRA-3858 — a checkout 10 commits behind manufactured 10
false errors against a clean commit; the reverse direction would wave a broken one through).
Workspace deps are therefore re-rooted onto the worktree's own packages and the resolution is
verified: any `@trading-app/*` realpath escaping the worktree reads BLIND, never a grade.

`core.hooksPath` is **local** config and is not committed, so the hook file is inert until something
arms it. That is `prepare` → `pnpm hooks:install`, run by `pnpm install`. Whether it is actually
armed is **measured**, never assumed:

```bash
pnpm check:deploy-build --verify-hook
```

This is a gate in front of `main`, not in front of the host. It is **not** a deploy executor: the
`autoDeploy=no` pin (TRA-1653/TRA-1665) below stands.

## Concurrent runs share this checkout. The index is not yours.

Paperclip allocates **one checkout per project** (`PAPERCLIP_WORKSPACE_STRATEGY=project_primary` —
by design, not a misconfiguration; TRA-4398 AC1, measured 2026-09-24). So `git add`,
`git commit --amend` and `git rebase` all read shared mutable state — the index, the working tree —
that another live run can change **between two of your commands**, with no lock and no signal. On
2026-09-08 that pushed a non-building commit to `origin/main` (`f66ab888`, repaired by `c7b452c0`):
a concurrent run left 19 files staged at a pre-TRA-4241 base (+163/−1582 against `HEAD`), and an
index reset landed between a verified `git add` and the `--amend` that followed, so the amend
committed `HEAD`'s copies of 7 of the 9 files. Every individual command was correct.

**The safe commit verb in this checkout is path-limited:**

```bash
git commit -m "..." -- <your paths>   # reads the WORKING TREE for those paths — safe
```

- A **brand-new** file must be `git add <path>`-ed first or the pathspec errors out ("did not match
  any file(s) known to git"). That add is safe — it writes *your* worktree content for *your* named
  path; the path-limited commit still excludes everything anyone else staged.
- `git commit --amend` and bare `git commit` read the **index**, which another run can reset or
  restage under you — not safe. (During a path-limited commit git builds a private temporary index,
  which is why that verb is immune.)
- `git commit -a` stages **everything tracked**, so it can ship another run's staged revert of a
  landed commit — the shape that would have silently undone TRA-4241 on the money host.

**Verify by content, not by stat.** The broken `--amend` commit showed a completely healthy
`git show --stat` — right file list, right line counts. After every commit here, assert a marker
that exists only in your new content:

```bash
pnpm check:commit-content --rev=<sha> --expect=<marker>:<file> [--expect=...]
#   0 PRESENT · 1 ABSENT · 2 usage · 3 BLIND;  BLIND > ABSENT > PRESENT
```

**The staged-revert shape fails loud at commit time.** `.githooks/pre-commit` (armed by the same
`prepare` → `pnpm hooks:install` as pre-push) runs `pnpm check:staged-revert`: it refuses when a
staged MODIFIED path is byte-identical to a strictly older ancestor of `HEAD` for that path — a
revert of landed work you did not announce. Intentional revert: `GIT_ALLOW_STAGED_REVERT=1`.
Fails closed (BLIND=3, the `check:deploy-build` convention). It cannot see the index-reset shape
(that content matches `HEAD`, not an ancestor) — the path-limited verb above is the defence there.

Deliberately **not** the remedy: serialising runs onto the checkout with a lock, or an unattended
merge/push executor — both re-create what TRA-3529/TRA-3533 and the `autoDeploy` pin already ruled
out. Detection plus a safe verb, nothing more. (TRA-4398.)

## Merging does not deploy. Deploying is a command you run.

`tradingai-bqb1` has `autoDeploy=no` / `autoDeployTrigger=off` — **on purpose** (the launch-window
pin, TRA-1653/TRA-1665; see `docs/runbook.md` §2). The last deploy Render fired from a commit hook
was **2026-07-12** (`c495294`). Almost every deploy since has been an explicit REST trigger — but
**not all of them**, and the exceptions are the whole point of `pnpm check:deploy-origin` (TRA-4789):
three dashboard-button deploys on 2026-09-13 and one env-write self-deploy on 2026-09-21 ran **no
gate at all**. "Every deploy is a REST trigger" is a convention, not an enforcement.

So the manual trigger is **the deploy path, not a fallback**:

```bash
RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<sha>
```

⛔ **A deploy target is REQUIRED and values attach with `=`** (TRA-4420). Until 2026-09-09 that
script matched its flags *positively*, so anything it did not recognise was silently ignored and
the run proceeded as a **real deploy of the branch tip** — `--help` shipped
`dep-dagcbqp5efls73ac5d40` to the money host, and `--commmit=<sha>` / `--commit <sha>` shipped the
**tip instead of the sha the operator named**, exit 0. Those are now exit 2 naming the offender,
`--help` prints usage and exits 0, and the bare-tip default is gone: say `--commit=<sha>`, or
`--tip` if you mean whatever `origin/main` is at that instant. `pnpm check:arg-guard` (in
`pretest`) grades it; its ARM 0 re-runs `a187fc14`'s bytes and asserts they still reach the POST.

That script is a **freeze**: it **REFUSES** inside 13:25–20:00Z Mon–Fri (RTH is 13:30–20:00Z; the
freeze opens 5 min early because a deploy *created* at 13:29Z *boots* the box inside RTH), plus any
dated embargo in its `EMBARGOES` table. It is **OPEN** pre-open, post-close and all weekend. Do not
read "RTH-gated" as "only deployable during RTH" — two of us read the old annotation backwards and
embargoed a commit against a slot that was open the whole time (TRA-2313).

It carries **four** gates with four separate exit codes and four separate overrides — `4` RTH
freeze · `5` dated embargo · `6` held commit · `7` the host's **live `AUTH_SECRET`** is unusable or
unreadable (TRA-2387; `auth.ts:34` throws under `NODE_ENV=production` on a blank value, so that
deploy takes the box DOWN rather than degrading it). Gate 7 **fails closed** — an unreadable
env-var list exits `7`, never `0` — and unlike the first three it is not scoped to bqb1. See
`docs/runbook.md` §"Four gates". The overrides are not interchangeable: a reason that justifies
deploying inside RTH is not a reason to boot a process that throws.

**Exit `10`: the cadence ceiling (TRA-4535).** While a `CADENCE_CEILINGS` row is active (the first
one runs `2026-09-08T18:50Z → 2026-09-19T04:00Z`, TRA-4384, max 1), the script counts **commit
advances** on bqb1 from Render's own deploy history over `[D 20:00Z, D+1 20:00Z)`. Once the window
holds its quota it refuses any further deploy whose target is not the live build. A same-SHA
env-apply always proceeds, and failed/canceled deploys are not counted. If the history is
unreadable the gate reads BLIND and still exits `10`. Override with
`--override-cadence="TRA-#### why"`, which must name a ticket. The window runs a full 24h rather than
closing at 13:25Z so that an RTH-override deploy or a weekend afternoon deploy is still counted.

⚠️ It gates **deploys**. It cannot see an **env/settings write**, nor the memory watchdog's own pm2
self-restart, which writes no deploy record at all (TRA-2203/TRA-2261). **A green run of the script
is not evidence the host is safe to touch.**

⚠️ **A SINGLE-KEY API env write (`PUT /env-vars/{key}`) on bqb1 does NOT auto-deploy, and `--commit`
IS honoured (TRA-3724).** The old claim here said the opposite and cost us a five-commit train into
the real-money host (TRA-3708). To apply an env change with a zero-byte code delta: write the single
key **through the API**, then `node scripts/render-redeploy.mjs --commit=<sha already serving>`.
`POST /restart` is **not** an env-apply path — it replays the last deploy's env snapshot.

⛔ **THAT EXEMPTION IS PER-SURFACE, NOT PER-VERB, AND THE UNQUALIFIED VERSION OF IT WAS WRONG
(TRA-4820).** On **2026-09-21T02:08:37Z** an env write self-deployed this host gate-free
(`dep-dao939egekts73bbv9cg`, `trigger: service_updated`, `envUpdated:true`, **no actor recorded**).
It was an env write, not a settings write — Render's markers are disjoint and there is not one
`updatedProperty` row in the whole 2026-07-10→09-23 event corpus. It was **not** the API verb: no
agent run existed anywhere in the company at that instant, and 0 of 3 recent API env writes produced
any deploy. So the dashboard (or the banned full-set `PUT`) **still ships the tip, unguarded** —
treat every surface except `PUT /env-vars/{key}` the way you treat a **settings** write
(`PATCH /services`), which is a different verb and is likewise assumed to ship the branch tip.
⛔ Do **not** read that row as "env writes now pin the serving commit": `9472ced3` was *both* the
serving commit *and* the branch tip (tip from 09-20T21:57:16Z to 09-22T19:33:37Z, 45h36m with
nothing pushed), so it cannot discriminate the two. It cost nothing because `main` was quiet.
Which key was written is **unreadable** — `GET /env-vars` returns `{key, value}` only, no timestamp,
no actor. Full per-verb measurement: `ENV_WRITE_TRUTH` in `scripts/render-redeploy.mjs`; operator
steps in `docs/runbook.md`.
⚠ A **third** such row DID discriminate — the other way (`dep-daq028id0e5s73aka5i0`,
2026-09-23T16:41:06Z, adjudicated on TRA-4845): it carried `7f290414`, the **serving** commit,
while the tip was `2e6feeaa`, ≥11 commits ahead. Against 07-23 (shipped the TIP over a
14-minute-old pin) the surface's commit choice is now measured in **both directions** — treat it
as **unpredictable**, so the ships-the-tip assumption above stays in force as the conservative
bound. And a serving-pin row is not harmless: that deploy landed **inside the RTH freeze**, killed
pid 76 mid-session at 5.80h uptime, and the replacement crash-looped 3× inside RTH (the TRA-4158
boot-burst heap trips) — the mid-session restart is the cost the `autoDeploy` pin exists to
prevent, arriving through a surface the pin cannot see.

Do not "fix" the pin by turning `autoDeploy` back on. It is what stops a mid-session merge from
dumping bqb1's warm quote cache and resetting the go-live soak clock (TRA-1996), and lifting it is
gated on go-live sign-off (TRA-1648).

### What actually bites: a stale build reads identically to a current one

Render emits **no event for a deploy that did not happen**, and `/api/health/version` reports its
SHA with exactly as much confidence eleven commits behind as at the tip. Nothing anywhere says "you
are N commits behind `origin/main`". So "merged, CI green" gets read as "deployed", and every
verdict computed in that window quietly measures the **previous** code — producing numbers that
look completely ordinary. TRA-2214 sat undeployed while it was the named blocker on a regrade; it
surfaced three merges later on TRA-2227, and only because that issue re-derived the live SHA by hand.

**Before publishing any number measured against bqb1:**

```bash
pnpm check:deploy-drift
#   DRIFT = 0 → CURRENT · N → STALE (each missing commit named) · DIVERGED · BLIND
```

It fails closed: an unreachable health route, a live SHA unknown to this checkout, or a failed
`git fetch` all exit BLIND (3), never 0 — because a stale local `origin/main` matching an equally
stale live build would otherwise manufacture a CURRENT verdict. (TRA-2229)

### A deploy one-shot must state its order as DATA, not as prose

A deploy train is written because a deploy has to happen inside a window — after the close, before
the open, outside the freeze. But the carrier issue it creates is picked up whenever the assignee's
queue reaches it. On 2026-08-13 TRA-3493 sat **5.4h** and TRA-3511 **3.4h** with nobody woken on
them; both were dispositioned by hand, from an unrelated run, by a human reading the prose and
re-deriving the ancestry. Nothing stranded — because an unrelated deploy path happened to carry the
same commits. That was luck, and under `skip_missed` the slot is not replayed. (TRA-3529/TRA-3533)

**Do not "fix" this by giving the trains an unattended executor.** That re-creates `autoDeploy`
through the back door, which is the pin two sections up, and hands the live host a standing
automated write. The queue dependency IS the "a human decides each deploy" posture, one layer down.

So the remediation is detection, and it has to run **outside the carrier** — a lateness check
written into the carrier's own prose only runs if somebody runs the carrier, which is the exact
event whose absence is the defect. Every deploy-train carrier therefore carries exactly one block:

````
```deploy-order
commit: 65fdb95
host: tradingai-bqb1
deadline: 2026-08-13T13:25:00Z
```
````

`deadline` **must** end in `Z`. Crons are evaluated in **ET** and these windows are written in UTC;
a bare local time is rejected, never guessed. A carrier that mentions deploying but orders nothing
opts out with `<!-- deploy-order: none -->` — there is no way to leave the population by accident.

```bash
pnpm check:deploy-train-window       # 0 clean · 1 STRANDED · 3 BLIND · 4 UNGRADED · 5 LATE
pnpm check:deploy-train-window:controls
```

`STRANDED` (deadline passed, ordered commit not in the live build) is the incident and the only
code that should page. `UNGRADED` is the migration backlog — suspected trains carrying no block —
non-zero so it cannot read as green, separate so eighteen backlog rows cannot bury one incident.
TRA-3536 is the live fixture (its ordered commit is the SHA already live, so obeying it is a strict
no-op).

`SATISFIED` means the commit is live **now**. Whether it was live **by the deadline** is a separate
column, and it is the one this ticket is actually about — on 08-13 both orders were satisfied
*hours late by an unrelated path*, which an ancestry-only pass calls a healthy train. That column is
measured when `RENDER_API_KEY` + `RENDER_SERVICE_ID` are in the environment (`--render-key` /
`--render-service`), and whether the arm is ON or OFF is **printed with its reason** — `UNREAD` is
never OK. A missed window exits **5 LATE**: nothing is stranded, so it must not page as one, and the
window was missed, so it must not pass as clean. Precedence `BLIND > STRANDED > LATE > UNGRADED >
CLEAN`.

⛔ The arm binds Render's history to the box by **live-SHA identity**, not by name: a deploy-order
block names the onrender hostname `tradingai-bqb1` while the Render service's own `name` is
`TradingAI-`, so `GET /v1/services?name=tradingai-bqb1` returns `[]`. If the newest `live` deploy in
the fetched history is not the SHA the health route just served, the arm stays off rather than time
an order against some other service's deploys. It also fails to `UNREAD`, never to `LATE`, when the
history starts after the deadline, when a pre-deadline deploy carries a commit this checkout does
not know, or when nothing in the window carries the commit at all — the expensive direction of a
grader over other people's deploys is the false accusation.

## A timed wait rests in a monitor, never in `blocked` with an empty `blockedBy`

You finished the work but have to come back at a time — a close, a soak window, an external check.
The resting state for that is a **scheduled issue monitor**, and it is agent-reachable. It is not a
sub-route; it is a field on the ordinary issue PATCH. Every route an agent guesses (`/monitor`,
`/monitor/schedule`, `/monitors`) 404s, and the one monitor route that does exist
(`POST /api/issues/{id}/monitor/check-now`) presupposes a monitor you already armed. There is no path
from the `422` remedy text to the working call — which is why TRA-4060 was filed twice as a platform
bug and looped a watchdog subtree for days.

```
PATCH /api/issues/{id}
{"status":"in_review",
 "executionPolicy":{"monitor":{"nextCheckAt":"2026-08-26T20:30:00.000Z",
                               "scheduledBy":"assignee",
                               "notes":"<why you are coming back>",
                               "recoveryPolicy":"wake_owner"}}}
```

`nextCheckAt` is the only required key. `scheduledBy` ∈ `assignee|board`. `recoveryPolicy` ∈
`wake_owner|create_recovery_issue|escalate_to_board` (default `wake_owner`). Only the **assignee
agent** or a board user may arm or trigger one.

⚠️ **The monitor is ONE-SHOT and nothing re-arms it.** When it fires — from the scheduler *or* from
your own `check-now` — the platform nulls `monitorNextCheckAt` and **deletes** the `monitor` block
out of `executionPolicy` (`buildIssueMonitorTriggeredPatch`). It never reschedules. So when a monitor
wake lands, **finish the issue or arm the next monitor in the same heartbeat**; waking up, posting a
comment and leaving it `in_review` yields a stopped leaf that looks compliant to every status query
and is owned by nobody. The `invalid_issue_disposition` guard cannot catch it — that guard runs only
on the *transition into* `in_review`, not when the monitor later burns. 18 issues were sitting in
exactly that state company-wide on 2026-08-26.

⚠️ **`check-now` is a manual dispatch, not a status read** — it spends the monitor. To read monitor
state just `GET /api/issues/{id}`; there is no top-level `monitorRecoveryPolicy`/`monitorStatus`
field (looking for one is how this got misdiagnosed twice). It is nested:
`executionState.monitor.{status,recoveryPolicy,attemptCount,maxAttempts,clearReason}`, alongside
top-level `monitorNextCheckAt`. **Spent** = `monitorNextCheckAt == null` &&
`executionState.monitor.status == "triggered"`.

⛔ Do **not** rest a timed wait in `blocked` with an empty `blockedBy`. That is the strand condition
itself, and the TRA-3541 drain arms will "repair" it — they hit TRA-4060 twice in seven minutes.
A clock/threshold gate that another issue `blocks` rests `todo` (TRA-3058), and stays assigned.

Full field table, authorization rules and the source trace: `docs/agent-issue-monitor-TRA-4073.md`.
