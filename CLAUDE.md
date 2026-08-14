# TradingAI — repo conventions

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
pnpm typecheck   # tsc --noEmit, honours tsconfig
pnpm build       # tsc -b, emits to dist/
```

Both read `tsconfig.json` and emit to `dist/`, never into `src/`.

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

…while the *blocking* one — `pnpm build`, i.e. `tsc -b --force` — ran only at deploy time. CI does
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

`core.hooksPath` is **local** config and is not committed, so the hook file is inert until something
arms it. That is `prepare` → `pnpm hooks:install`, run by `pnpm install`. Whether it is actually
armed is **measured**, never assumed:

```bash
pnpm check:deploy-build --verify-hook
```

This is a gate in front of `main`, not in front of the host. It is **not** a deploy executor: the
`autoDeploy=no` pin (TRA-1653/TRA-1665) below stands.

## Merging does not deploy. Deploying is a command you run.

`tradingai-bqb1` has `autoDeploy=no` / `autoDeployTrigger=off` — **on purpose** (the launch-window
pin, TRA-1653/TRA-1665; see `docs/runbook.md` §2). The last deploy Render fired from a commit hook
was **2026-07-12** (`c495294`). Every deploy since has been an explicit REST trigger.

So the manual trigger is **the deploy path, not a fallback**:

```bash
RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<sha>
```

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

⚠️ It gates **deploys**. It cannot see an **env/settings write**, nor the memory watchdog's own pm2
self-restart, which writes no deploy record at all (TRA-2203/TRA-2261). **A green run of the script
is not evidence the host is safe to touch.**

⚠️ **An env-var write on bqb1 does NOT auto-deploy and `--commit` IS honoured (TRA-3724).** The old
claim here said the opposite and cost us a five-commit train into the real-money host (TRA-3708). To
apply an env change with a zero-byte code delta: write the single key, then
`node scripts/render-redeploy.mjs --commit=<sha already serving>`. `POST /restart` is **not** an
env-apply path — it replays the last deploy's env snapshot. A **settings** write (`PATCH /services`)
is a different verb and is still assumed to ship the branch tip. Full per-verb measurement:
`ENV_WRITE_TRUTH` in `scripts/render-redeploy.mjs`; operator steps in `docs/runbook.md`.

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
