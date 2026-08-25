# Ops Runbook

Spun out of the TRA-402 review (§5 — "no documented backup-recovery / scaling
runbook"). This is the operational guide for running TradeAI in production.

For incident debugging (logs, trace ids, error telemetry) see
[`observability.md`](observability.md) — this runbook covers deploy, backups,
scaling and alert response.

## 1. Production topology

> **TRA-547 (CTO update, 2026-06-03) — READ FIRST, supersedes the TRA-444 note
> below on the public-backend question.** The public TradeAI site
> (<https://networkgems.github.io/TradingAI-/>, GitHub Pages) is now served by a
> **live Render backend at `https://tradingai-bqb1.onrender.com`**
> (`wss://tradingai-bqb1.onrender.com` for the WebSocket bus) — verified
> `GET /api/health → {ok:true}` on 2026-06-03. This is the **canonical public
> backend URL**; it is the single hardcoded fallback in
> [`apps/desktop/src/server-url.ts`](../apps/desktop/src/server-url.ts)
> (`PROD_BACKEND_URL`) and the CI `VITE_SERVER_URL` secret. The old name
> `tradingai-server.onrender.com` is **dead (404)** — do not reference it.
>
> ✅ **Live-broker ownership — RESOLVED (TRA-549, CTO decision, 2026-06-03).**
> The app is not multi-instance safe, so exactly one instance may hold live
> (production) Tradier credentials. **Render `tradingai-bqb1` is that single
> owner** — it is the only publicly-reachable backend (it serves the GitHub
> Pages site), whereas the PM2 self-host on `PG-DEVOPS14` (below) binds
> host-local with **no reverse proxy** and cannot be the public live-trading
> instance. The PM2 self-host is therefore **stood down to sandbox-only**:
> `TRADIER_ENV=sandbox` is hard-pinned in
> [`ecosystem.config.cjs`](../ecosystem.config.cjs) (TRA-549), so it can only
> ever route **paper** orders even if production `TRADIER_*` are set out-of-band
> on the host. Set the production `TRADIER_*` pair and `TRADIER_ENV=production`
> **only in the Render dashboard** — never on the PM2 host.
>
> **Gate:** this ownership must hold (or be explicitly re-decided — de-credential
> the loser *first*) before any change flips `LIVE_STRATEGY_PRESET` off
> `no_trade`. (TRA-609: this flip has happened — the board overrode the TRA-432
> NO-GO via TRA-577/944ad8cc and un-pinned `no_trade` to empty, releasing the
> live engine to the per-user preset. The ownership condition holds: Render is
> the sole production live instance, PM2 is sandbox-only. The live pilot is
> re-enabled but **gate-blocked** — the TRA-532 promotion gate still refuses to
> arm live crypto auto-trading until a crypto strategy is fully promoted, and no
> strategy currently is.)
>
> ⚠️ **A promotion is not a blank cheque on the UNIVERSE (TRA-2348).** Full
> promotion of a strategy is **necessary but not sufficient** for live crypto. All
> three live crypto presets enable the same single strategy (`dca`) and differ only
> in symbol universe, so swapping `crypto_core_live_canary_btc` → `crypto_core`
> (BTC-only → ≈395 pairs) is invisible to a strategy-keyed gate: the roster delta is
> empty. The gate therefore also refuses any save that **widens** the live symbol
> universe onto a preset outside `LIVE_RATIFIED_CRYPTO_PRESETS`
> (`packages/shared/src/index.ts` — today the TRA-1304 majors + canary presets).
> **Narrowing and holding are never blocked**, and turning live crypto off in the
> same save always succeeds. Adding an id to that list is a real-money
> authorization and needs a fresh live-money sign-off — QuantTrader's is NO-GO on
> the full `crypto_core` universe.
>
> **Before arming live crypto** (not before the equity `TRADIER_ENV=production`
> step — the two are scoped separately):
>
> ```bash
> RENDER_API_KEY=… node scripts/tra2342-interlock-live-check.mjs --crypto-arm
> ```
>
> Without `--crypto-arm` the TRA-2348 rows report as **NOTICE** and do not block the
> equity go-live; with it (or whenever `LIVE_CRYPTO_BOOT_ARM` is on/unreadable) they
> are hard FAILs. `--self-test` proves every predicate goes negative on the real
> pre-fix builds. A NOTICE is not a pass.
>
> To hand live ownership to the PM2 self-host instead, you must
> (1) clear `TRADIER_*` / set `TRADIER_ENV=sandbox` on Render bqb1, (2) drop the
> `TRADIER_ENV: 'sandbox'` pin in `ecosystem.config.cjs`, and (3) update this
> §1, the [`render.yaml`](../render.yaml) header, and the
> [`server-url.ts`](../apps/desktop/src/server-url.ts) note — in one change.
>
> ---
>
> **TRA-444 (CTO decision, 2026-05-17) — historical, see TRA-547 above:**
> production ran **self-hosted under PM2**, not on Render, and the Render service
> that earlier docs named (`https://tradingai-server.onrender.com`) was
> **unprovisioned**. [`render.yaml`](../render.yaml) is retained as a blueprint
> (see its file header). The PM2 operational detail below remains accurate for
> the self-hosted instance; the public backend is now Render bqb1 per TRA-547.

- **Host:** `PG-DEVOPS14` — a single company-operated Windows workstation. The
  server is a self-hosted Node process managed by **PM2**
  ([`ecosystem.config.cjs`](../ecosystem.config.cjs), app name `trading-server`).
  This is the operational instance TRA-438/TRA-441/TRA-442 were verified
  against.
- **Topology:** one instance, engine state and the WebSocket bus in-process.
  There is **no failover** and the app is **not multi-instance safe** — run
  exactly one `trading-server` process (see §4). Never run two instances against
  the **same live broker credentials**: per TRA-549 (note above) live Tradier
  ownership belongs to Render `tradingai-bqb1`, and this PM2 self-host is pinned
  to `TRADIER_ENV=sandbox` so the two never collide on the same live account.
- **Process:** `node packages/server/dist/index.js`, launched by PM2 with
  `NODE_ENV=production`, `autorestart: true`, `restart_delay: 3000`,
  `max_restarts: 10`.
- **Port:** the server listens on `$PORT` (default `4242`) and binds
  host-local on `PG-DEVOPS14`. **No public URL or reverse proxy is provisioned**
  — the operational instance is reachable only on the host itself at
  `http://localhost:4242` (`ws://localhost:4242` for the WebSocket bus). The
  desktop client falls back to `ws://localhost:4242` whenever it is not served
  from a remote origin (see
  [`apps/desktop/src/server-url.ts`](../apps/desktop/src/server-url.ts)). If a
  reverse proxy is added later, record its public URL here.
- **Data dir:** all user data, backups and logs live under `DATA_DIR`.
  [`ecosystem.config.cjs`](../ecosystem.config.cjs) now **sets `DATA_DIR`
  explicitly** to an absolute path anchored to the repo it launches from
  (`<repo>/packages/server/data/`), so a PM2 restart always resolves the **same**
  store regardless of the working directory it was launched from (TRA-522).
  Override `DATA_DIR` in the process environment to relocate onto a dedicated
  volume — recommended for production. **The override MUST be the same absolute
  path on every launch.**
  - ⚠️ **Single canonical launch path (TRA-522).** Start the server **only** via
    [`ops/bootstrap-trading-server.sh`](../ops/bootstrap-trading-server.sh) (or
    `npx pm2 start ecosystem.config.cjs` from the canonical repo). Do **not**
    launch from a second clone (e.g. a sibling `~/TradingAI`): each clone has its
    own `packages/server/data/`, and a restart from the wrong clone silently
    loads a **different account book**. See "Account-snapshot swap (TRA-522)"
    under §6.
- **Auth secret:** the server **refuses to start in production without
  `AUTH_SECRET`** and uses an ephemeral one otherwise (all sessions drop on
  restart). Set a stable `AUTH_SECRET` in the environment. (The Render blueprint
  injected this automatically via `generateValue: true`; self-hosting must
  provide it.)
- **Health check:** `GET /api/health` returns `{ ok: true }`. Poll it after
  every restart/deploy before considering the process healthy.
- **Autostart on reboot (TRA-605 / TRA-493 Part A).** PM2 does **not** auto-start
  on Windows by default — after a host reboot the daemon stays dead and nothing
  restores the saved process list, silently taking `trading-server` (and the
  News-tab POST path) down until a human re-runs the bootstrap (TRA-491). A
  scheduled task **`PM2 Resurrect`** — registered by
  [`ops/install-pm2-autostart.ps1`](../ops/install-pm2-autostart.ps1), running
  [`ops/pm2-resurrect-boot.ps1`](../ops/pm2-resurrect-boot.ps1) — runs
  **`pm2 resurrect` at machine start as `LOCAL_SYSTEM`**, so the daemon +
  `trading-server` come back up unattended. **Keep the resurrect file current:**
  run **`npx pm2 save` whenever you change the running process set** (after any
  `pm2 start`/`delete`), or a reboot restores a stale list.
  - ✅ **Verify it, don't assume it** — `ops/verify-pm2-autostart.ps1` (no admin
    needed, exit `0`=armed / `1`=not). **Shipping the scripts is not the same as
    installing the task**, and the failure is *silent*: on 2026-07-12 PG-DEVOPS14
    rebooted with the task never registered, and `trading-server` stayed down
    **~16.7h** until a human restarted it — TRA-491 all over again, while this
    runbook claimed autostart was in place. Run the verifier after any host
    rebuild, profile reset, or PM2 change.
  - ⚠️ **The installer must be run ELEVATED, on the host** (`Register-ScheduledTask`
    with a `SYSTEM` principal returns `Access is denied.` otherwise — agents are
    not elevated and *cannot* install this). It stages the boot wrapper to
    `C:\ProgramData\TradingAI\ops\` and points the task there **on purpose**: a task
    pointed into a repo/agent-workspace checkout decays into a dangling path when
    that tree is reset or wiped, and a dangling boot task fails silently.
  - ⚠️ **Daemon ownership after a reboot.** Because the task runs as
    `LOCAL_SYSTEM`, after a reboot the PM2 daemon is owned by `SYSTEM`, so a
    **non-elevated** `npx pm2 …` fails with `connect EPERM \\.\pipe\rpc.sock`
    (HTTP `/api/health` is unaffected). Manage PM2 from an **elevated** shell
    after a reboot — or `pm2 kill` the SYSTEM daemon and re-`resurrect` from a
    normal shell to return to user-context ownership. This is inherent to any
    no-password Windows autostart (incl. `pm2-installer`'s `LOCAL_SYSTEM` service).
  - **Why a scheduled task, not `pm2-installer`:** `pm2-installer` is not a
    published npm package (`npm view` → 404); its real form (jessety/pm2-installer)
    relocates the **machine-wide npm global prefix**, unsafe on `PG-DEVOPS14`
    which launches the Paperclip control plane via `npx`. The TRA-493 plan
    pre-approved a scripted scheduled task as the Part A fallback.
- **Admin login for the News-tab POST path (per-fire login).** The pre-/post-market
  routine publishes research to the Stocks → News tab via
  [`scripts/post-research-report.mjs`](../scripts/post-research-report.mjs), which
  **logs in fresh on every fire** with `ADMIN_USERNAME`/`ADMIN_PASSWORD` (TRA-493 /
  TRA-578). Static bearer tokens are *not* the documented path — they are
  HMAC-signed with `AUTH_SECRET` and expire after `AUTH_TOKEN_TTL_HOURS` (default
  24h, TRA-404/C1), so a baked token dies within a day.
  - ⚠️ **Rotating `ADMIN_PASSWORD`** requires updating **two** `.env` files
    together, or the next routine fire 401s: (1) the **trading-server** `.env` on
    `PG-DEVOPS14` (the credential the server authenticates against), and (2) the
    **Paperclip instance** `.env` (the `ADMIN_PASSWORD` the routine passes to the
    script). Change both in the same maintenance window (TRA-607).

## 2. Deploy procedure

### Launch-window deploy freeze (TRA-1653 / TRA-1665) — READ FIRST

While the go-live soak is running, `tradingai-bqb1` is **pinned**: `autoDeploy=no`,
`autoDeployTrigger=off`. Pushing to `main` deploys **nothing**. The build under
soak is the one the launch ships.

**The one rule: deploy by explicit commit id. Never "Deploy latest commit".**

`main` HEAD is **not** the pinned build and drifts further from it every time
anyone merges. "Deploy latest commit on `main`" therefore ships whatever else
happened to land — un-soaked, unreviewed for this window, and it **restarts the
process and resets the soak clock**. Deploying by SHA is immune to all of that.

Render UI: *Manual Deploy → **Deploy a specific commit*** → paste the SHA.
Never *Manual Deploy → Deploy latest commit*.

**Emergency hotfix during the window** — this is the realistic path to a manual
deploy, and it is exactly when someone clicks the wrong button. Do not branch from
`main`. A branch tracking the running build is pre-staged for you:

```bash
git fetch origin
git checkout -B hotfix-<TRA-xxxx> origin/launch-window-base  # == the RUNNING build
git cherry-pick <fix-sha>                                    # the fix, and nothing else
git push origin hotfix-<TRA-xxxx>
git rev-parse HEAD                                           # ← deploy THIS SHA, by id
```

That ships the fix on top of the soaked build and drags nothing else along. Land
the same fix on `main` afterwards, separately.

**Freeze on `main`:** no commits touching runtime surface (`packages/**`,
`render.yaml`, lockfiles) until the window closes. Docs/reports-only commits are
fine — they cannot reach the running process. This keeps the drift bounded.

> **Diagnostic trap — a pinned service is indistinguishable from a failed build.**
> Your push does not deploy, and `/api/health/version` just keeps reporting the old
> SHA, forever. It looks exactly like a broken build. **If your push does not
> deploy, check `autoDeploy` on the service before you go hunting for a build
> failure.** Note `autoDeploy` / `autoDeployTrigger` are **top-level** on the Render
> service object — *not* under `serviceDetails`, where you will look first and find
> nothing:
>
> ```bash
> curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
>   https://api.render.com/v1/services/$RENDER_SERVICE_ID \
>   | python -c "import sys,json;d=json.load(sys.stdin);print(d['autoDeploy'],d.get('autoDeployTrigger'))"
> ```

Lifting the freeze (after go-live sign-off, TRA-1648): set `autoDeploy=yes` /
`autoDeployTrigger=commit` on the service, then delete `launch-window-base`.

#### The drift alarm (TRA-2229) — run it before you grade anything

The pin's real cost is not the extra command, it is that **"merged" gets read as
"deployed"** and nothing contradicts it. Render emits no event for a deploy that did
not happen, and `/api/health/version` reports its SHA just as confidently eleven
commits behind as at the tip. TRA-2214 sat undeployed while it was the named blocker
on a regrade; the gap surfaced three merges later on TRA-2227, and only because that
issue happened to re-derive the live SHA by hand. Make it one number instead:

```bash
pnpm check:deploy-drift
#   DRIFT = 0  → CURRENT   live is exactly origin/main                  (exit 0)
#   DRIFT = N  → STALE     N merged commits are NOT running — each named (exit 1)
#              → DIVERGED  live is off origin/main entirely             (exit 1)
#              → BLIND     a leg could not be read — never a pass       (exit 3)
```

BLIND is deliberate and it fails closed: an unreachable health route, a live SHA this
checkout has never seen, or a failed `git fetch` all abort. A stale local `origin/main`
matching an equally stale live build would otherwise *manufacture* a CURRENT verdict.

**Before publishing any number measured against `tradingai-bqb1`, run this.** A DRIFT
of N means the window you just measured ran on the previous build, and the result will
look completely ordinary.

##### Drift on a SAFETY path is a decision, not a number (TRA-3991)

Drift answers *how far behind*. It does not say whether anything behind matters. On
2026-08-24 `a5a49717` — the exit-quantity oracle written that morning against
`BAC260925C00063000` — merged at 13:48Z, could not ship inside the RTH freeze, and the
engine sold the row it bounds to 0 at 19:31:08Z, 43 min before the 20:14Z deploy.
`--force-rth-override` existed for exactly this; nobody asked for it because nothing
said there was anything to decide. The freeze decided by default.

```bash
pnpm check:deploy-lag
#   → CURRENT     live is exactly origin/main                             (exit 0)
#   → LAG         behind, nothing behind touches the safety set          (exit 1)
#   → SAFETY_LAG  behind AND a safety-path commit is NOT running          (exit 2)
#                 an override decision is DUE — make it in writing, or write down
#                 why it can wait. The script authorizes nothing, deploys nothing.
#   → BLIND       a leg could not be read (incl. a SHALLOW checkout)      (exit 3)
pnpm check:deploy-lag:tape      # replay the last 30 d of Render deploys: how long each
                                # safety commit sat merged-but-undeployed, in RTH minutes
pnpm check:deploy-lag:controls  # the synthetic-repo control suite
```

The safety set is `SAFETY_SET` in `scripts/check-deploy-lag.mjs`: the oracles
(`option-exec-flag.ts`, `live-options-fee-slippage-ledger.ts`) and the order chokepoint
(`packages/engine/src/tradier/options-client.ts`) whole-file; `options-account.ts` and
`signal-engine.ts` by **method** (`stageableExitContracts`, `getExitQuantityBoundCensus`)
or by a changed line naming a bound symbol — those two files change in a quarter of all
commits, and a whole-file scope would fire on every deploy. The RTH refusal in
`render-redeploy.mjs` (exit 4) now prints the same partition, so the operator who *does*
ask is told what the freeze is holding. Measured on the 30 days to 2026-08-25: a safety
remedy sat undeployed during RTH on 11 of 21 weekdays.

#### The board alarm (TRA-2364) — `blocked` issues with an EMPTY `blockedBy`

An issue at `status: blocked` whose `blockedBy` is `[]` carries no edge anything can
resolve, so the board auto-flips it back to `in_progress`. The hold silently expires
and the work resumes unattended.

We cannot fix the cause: Paperclip's **terminal-run recovery** writes `status: blocked`
onto whatever is `in_progress` when a run dies on `acpx_turn_failed` ("You've hit your
session limit"), and **that write sets no blocker array**. It fired 2026-07-25T20:3xZ
and 2026-07-26T02:0xZ (TRA-2360 / TRA-2362) and it will fire again. So this is the
instrument, not the fix:

```bash
pnpm check:blocked-empty
#   CLEAN                 (exit 0)  nothing in the shape — scoped to this instant only
#   FINDINGS              (exit 1)  every hit has a roster assignee to route to
#   FINDINGS_UNREPAIRABLE (exit 2)  a hit no agent can repair — needs a human/board write
#   BLIND                 (exit 3)  the enumeration is untrustworthy — NOT a pass
pnpm check:blocked-empty:controls   # both directions + every cause/anchor arm reachable
```

The control run asserts **coverage, not a count** — it prints `N/N` but *fails* only on a red
case or an unreachable arm, so adding a control never breaks it. Do not quote the number.

Three things make it more than a one-liner, and each is a silent read it refuses:

- **`GET /api/companies/{c}/issues` caps at 1000 rows and `offset` DOES paginate.** The
  company has ~2370 issues, so one call reports 46 blocked where the full set is 82 — a
  one-page sweep misses ~44% of the population and reports health on the half it never
  read. ⛔ Do not probe paging by checking that page 2 is non-empty: an **ignored**
  `offset` returns a full page too. The script asserts the de-duped union *grew*.
- **The issue-LIST route carries no `blockedBy` key at all**, so a list-route sweep reads
  "0 blockers" on every issue in the company. Every hit is re-read through
  `GET /api/issues/{id}`, and the script asserts the key is *present* — `(x.blockedBy ||
  []).length === 0` cannot tell "no blockers" from "wrong route".
- **`blockerAttention` is never allowed to suppress a finding.** That rollup counts open
  *children*, which the anchor does not, so it reads `covered` over an empty
  `blockedBy` (measured on TRA-2331). Grade the shape, not the rollup.

**It emits no repair command, on purpose (TRA-2396).** The rollup's
`sampleBlockerIdentifier` is *structurally incapable* of naming a legal anchor — it samples
open **descendants**, and a descendant edge onto its own ancestor is a 2-cycle, which is
strictly worse than the empty array it would replace (empty auto-flips and stays visible; a
cycle is a permanent hold neither side can break). The first live routing this detector
produced (TRA-2383) shipped a copy-pasteable `PATCH` built on that field *plus* four lines of
prose saying not to run it. **Prose loses to copy-paste.** So instead the script resolves every
candidate against the parent chain — free, because the list route carries `parentId` — strikes
out descendants/self/ancestors/closed, and prints an **anchor verdict**: when nothing survives,
`NO VALID ANCHOR: every unresolved blocker in the rollup is a DESCENDANT`. The rollup *count*
still prints; work really is parked downstream. A control covers the descendant-only case, and
an invariant fails the whole run if any rendering contains a pasteable blocker write.

**The cause is a branch, not a sentence.** Two writers produce this shape and they need
opposite repairs:

| branch | marker | repair |
|---|---|---|
| `RECOVERY-BLOCKED` | `activeRecoveryAction`, or a **system-authored** comment carrying `acpx_turn_failed` / `Recovery action:` / `Recovery owner:` | **no anchor was ever intended** — re-derive what the issue waits on *today* |
| `DROPPED-EDGE` | no marker | an intended anchor exists — the dropped-blocker PATCH split (TRA-2365 / TRA-2304). Stated as an **inference**, hedged |
| `CAUSE UNKNOWN` | the comment thread could not be read | say so. Absence of a marker was never established |

TRA-2383 asserted DROPPED-EDGE in the indicative — in the title too — on an issue that was
RECOVERY-BLOCKED: a confident sentence bolted onto a correctly detected number. The `cause:`
line in the report is now generated per branch; **paste it, don't improvise it.** Two traps are
controlled: agents *quote* `acpx_turn_failed` in their own comments constantly, so the marker
requires `authorType === 'system'`; and an unread thread lands on UNKNOWN, never on the
inference — otherwise the guess would be strongest exactly where we read least.

It only ever **routes**. Board repair is assignee-scoped — the CFO holds the top role
and still got `403 "Issue is outside this actor's authorization boundary"` on a plain
`{"status":…}` PATCH of two issues that were not theirs, and the 403 covers the comment
route too. An issue whose assignee is off-roster or absent is unrepairable by *every*
agent and is reported as its own severity class.

⛔ When repairing a hit, do **not** anchor a child onto its own parent to satisfy
"blocked needs a blocker" — that is a 2-cycle neither side can break. `todo` is the
correct disposition for a parked-ready leaf; it still counts as an unresolved blocker
upstream, so parking costs the parent nothing.

### RTH deploy FREEZE (TRA-1996) — bqb1 deploys are REFUSED 13:25–20:00Z Mon–Fri

The "deploy by SHA" rule above bounds *what* ships; this rule bounds *when*. Even a
correct-SHA deploy to `tradingai-bqb1` **during Regular Trading Hours dumps the warm
quote cache and resets the soak clock** — every mid-RTH deploy disqualifies the
session as the clean, no-mid-RTH-deploy acceptance sample TRA-1648 requires. This bit
us repeatedly (07-20: 2 deploys, 07-21: 4) when the SANDBOX-options learning tree
(TRA-2125 / TRA-2134) — which ships its adapter to the **same** Render service —
deployed mid-session.

**The rule: no `tradingai-bqb1` deploy inside 13:25–20:00Z, Mon–Fri.** This applies to
**every** work stream, including sandbox-options — not just feed fixes.

**DIRECTION — stated so it cannot be read backwards (TRA-2313).** This is a **FREEZE**,
not a permission window. The gate **REFUSES *inside* 13:25–20:00Z Mon–Fri** and is
**OPEN pre-open (`<13:25Z`), post-close (`≥20:00Z`), and all weekend** — the market is
closed then, so there is no live soak session to fragment. Do not read "RTH-gated" as
"only deployable during RTH": two of us read that phrasing backwards and embargoed a
commit against a slot that was open the whole time (TRA-2308/TRA-2313). **Post-close is
the slot the script itself recommends**, not one it refuses.

The freeze opens **5 min before the 13:30Z bell** (`DEPLOY_LEAD_MIN`) because what
fragments the soak is the **boot, not the POST**: a deploy *created* at 13:29Z finishes
and restarts the process ~2–3 min later, i.e. inside RTH (TRA-2325). It does **not**
close late — a deploy created at 19:59Z boots after the bell. Post-close *reads* are
protected by dated embargoes instead (below), not by a standing close-side buffer.

**Route all bqb1 deploys through the wrapper**, which enforces this as a technical
gate rather than a convention:

```bash
# REFUSES (exit 4) if it is 13:25–20:00Z Mon–Fri on the soak host; else triggers the deploy
RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<sha>
node scripts/render-redeploy.mjs --dry-run            # print the gate decision only
# genuine emergency only — the reason is recorded and the session is disqualified:
node scripts/render-redeploy.mjs --commit=<sha> --force-rth-override="why this cannot wait"
```

**Four gates, four refusals, four separate overrides.** The first three are scoped to the
soak host only (every other Render service deploys with no time gate); the fourth is not,
because a host that will not boot is not a soak problem:

| exit | gate | what it means | override |
|---|---|---|---|
| `4` | RTH freeze | it is 13:25–20:00Z on a weekday | `--force-rth-override="…"` |
| `5` | dated embargo | a board-ratified hold in the `EMBARGOES` table covers this instant | `--force-embargo-override="…"` |
| `6` | commit hold | the deploy carries — or cannot be proven clear of — a commit in `COMMIT_HOLDS` | `--force-commit-hold-override="…"` |
| `7` | AUTH_SECRET value | the service's **live** `AUTH_SECRET` is empty/whitespace-only or absent — or **could not be read** | `--force-auth-secret-override="…"` |

The overrides are deliberately **not** interchangeable: 4 and 5 are about *when* you
deploy, 6 is about *what* you deploy, 7 is about *whether the thing you deploy will still
boot* — and authorisation to break the routine daily freeze is not authorisation to break a
named-day hold, to ship a held commit, or to boot a process that throws. Each requires a
non-empty reason, which is echoed so the breach is on the record. **A clear calendar says
nothing about the commit**, so check `--dry-run` before assuming an open window means "go".

Notes on gate 7 (TRA-2387, the residual of TRA-2315):

- It grades the value with `resolveAuthSecret()`'s own predicate, shared via
  `scripts/lib/auth-secret-predicate.mjs`. `auth.ts:34` accepts the value only if
  `fromEnv.trim().length > 0` and **throws** under `NODE_ENV=production` otherwise, so a
  blank secret does not degrade bqb1 — it takes it down.
- It **fails closed**: an unreadable env-var list, a truncated enumeration, or a row with no
  `value` field all exit `7` as BLIND, never `0`. A Render outage must not permit the deploy
  the gate exists to stop.
- **An absent key refuses only where the key is reachable** (bqb1, per `render.yaml` L76-77).
  On any other service an absent `AUTH_SECRET` prints `gate N/A` and does not block; a
  *present-but-blank* one refuses everywhere.
- It **cannot see its own most likely cause**: blanking the secret is an env write, and an env
  write redeploys the service unguarded (`service_updated`). What it does catch is the state
  that outlives that write — a boot that throws never goes live, Render keeps the previous
  process serving, and the box then runs healthy on an in-memory secret with a broken env
  until somebody deploys for an unrelated reason. That caveat prints in the **normal** output,
  not only in a refusal.
- Graded by `pnpm check:auth-secret-gate` (in `pretest`): 23 predicate cases, 10 end-to-end
  cases through the real `main()` against a stubbed Render API, plus a direction control that
  goes RED if the TRA-2315 predicate is reverted. Add `--live` to read bqb1's actual value
  (length only; the value is never printed).

The RTH bound is matched to `tra1648_soak_check.mjs`, so the wrapper and the acceptance
grader agree with no DST drift. This rule lifts together with the launch-window freeze
at go-live sign-off (TRA-1648).

⚠️ **A green run of the wrapper is not evidence the host is safe to touch.** It gates
**deploys**. It cannot see an **env/settings write**, nor the memory watchdog's own pm2
self-restart, which writes no deploy record at all (TRA-2203/TRA-2261). A raw
`POST /v1/services/…/deploys` curl also bypasses it, so the wrapper is the *documented,
enforced* path; do not hand-roll the curl during the soak.

#### Applying an env change on bqb1 — the pinned path (TRA-3724)

The claim that used to sit here — "an env write redeploys bqb1 anyway, and it does not
honour `--commit`" — was **measured wrong on 2026-08-14** and it is wrong in the dangerous
direction: it tells you pinning is futile at the moment pinning is the correct move. Acting
on it shipped five unrelated commits into the real-money host 9.5 hours before the go-live
week open (TRA-3708). The per-verb measurement is in `scripts/render-redeploy.mjs`,
`ENV_WRITE_TRUTH` — read that block before any env write on this host. In short:

| verb | does it deploy? | evidence |
|---|---|---|
| `PUT /env-vars/{KEY}` (single key) | **No** — not since 2026-07-23 | 22 `envUpdated:true` deploys ever, last `dep-d9h1j5nlk1mc738s57qg` 07-23T13:39Z; writes on 07-24 and 08-14 produced none |
| `PATCH /services/{id}` (settings) | **Assume YES, from the tip** | Render labels it `updatedProperty`; only 4 ever, all pre-pin — **untested** under the pin and not worth testing on this host |
| `PUT /env-vars` (full set) | **BANNED** regardless | TRA-2136 — replaces the whole set, wiped 19 secrets |
| `POST /deploys` + `commitId` | Yes, and **`--commit` IS honoured** | 280 api deploys, incl. the TRA-3671 bisect of 6 commits by SHA |

**To apply an env change with a zero-byte code delta:** write the one key, then

```bash
node scripts/render-redeploy.mjs --commit=<THE SHA ALREADY SERVING>
```

Render bakes env vars into the deploy at deploy time whatever commit it targets, so
re-deploying the *serving* commit applies the env and ships no code. Measured on this
service 2026-07-24: the `TRADIER_ENV` write at ~15:55Z was applied by deploys at 15:58Z
and 16:13Z, both of `8a7ecf50eee4` — already live since 12:50Z. Read the serving sha off
the host, never off git: `/api/health/options-live` → `build.commitShort`.

**`POST /restart` is not an env-apply path.** It replays the existing deploy's instance
spec, so a write made after that deploy is structurally invisible to it — which is why the
08-14T03:53:53Z restart still published `otmFlagOn: true`.

**Is a code freeze the same freeze as an env freeze here? No — provided you pin.** They
collapse into one freeze only when the apply is unpinned, because an unpinned deploy
resolves the branch tip. Pinning is what separates them. Both still owe the RTH freeze and
any embargo: `--commit` removes the code delta, not the boot.

#### After the board ratifies a live-arm value, WRITE THE STAMP (TRA-3694)

`/api/health/live-enforce-gates` → `arm.universe` used to publish the live value and its
source and **nothing about its authorization**, so a *ratified* widening and an
*unratified* one rendered **byte-identically**. That is not hypothetical: the same field
was flagged twice in 26 hours by two independent readers (CFO interaction `8e303cd7`, then
QT on TRA-3661), each of whom had to re-derive the answer from board interaction records
that sit nowhere near the health surface. It is a real-money sleeve, so the case that
matters is the reverse one — an **actually** unratified widening would have looked
identical to both of them.

The route now computes the comparison and publishes the verdict. **Read
`arm.universe.ratification.matchesLive`, not the two strings** — the failure being fixed is
precisely a comparison nobody performs.

| verdict | meaning |
|---|---|
| `true` | live universe == the ratified set (semantic set compare, so whitespace/order/case cannot false-alarm) |
| `false` | mismatch **or** a set-but-unparseable stamp. `onlyLive` names the symbols real money can open that the ratification does not cover — the unratified-widening direction |
| `'unstamped'` | the var is unset. **UNKNOWN, never a pass** — a stamp that defaulted to OK would reproduce the original defect one layer up |

Same shape on `/api/health/live-options-fee-slippage` → `capRatification` +
`ratificationMatchesLive` (fold is fail-loud: any `false` ⇒ `false`, else any
`'unstamped'` ⇒ `'unstamped'`).

**This is a READ-ONLY instrument.** A mismatch blocks no order — a missing env var halting
a real-money sleeve would be strictly worse than the defect it fixes. So a stale stamp is
loud but harmless, and there is no failure mode in which writing it costs you a session.

**⇒ THE PROCEDURE. When the board ratifies a change to any of these values, the same hand
that writes the enforcement var writes the stamp.** Skipping it leaves a `false` on a
correct box, which trains readers to ignore the field:

| enforcement var | stamp var |
|---|---|
| `OPTION_LIVE_OTM_UNIVERSE` | `OPTION_LIVE_OTM_UNIVERSE_RATIFIED` (+ `..._RATIFIED_BY`) |
| `LIVE_OPTION_TEST_NOTIONAL_CAP_USD` | `OPTION_LIVE_TEST_NOTIONAL_CAP_USD_RATIFIED` |
| `LIVE_OPTION_TEST_AGGREGATE_CAP_USD` | `OPTION_LIVE_TEST_AGGREGATE_CAP_USD_RATIFIED` |
| (both caps) | `OPTION_LIVE_TEST_CAPS_RATIFIED_BY` |

⛔ **Source the stamp from the interaction record, never from the live env.** Copying the
live value into the stamp manufactures a `true` and proves nothing — it is the same
circularity the ticket exists to break. Read it off
`GET /api/issues/{id}/interactions` → `result.answers` plus the resolved option's label.
The `_BY` vars are free text; carry the interaction id, the issue, the option id and the
resolve time so the next reader can re-derive it in one GET.

Values in force as of 2026-08-14 (each verified against its record that day):

```
OPTION_LIVE_OTM_UNIVERSE_RATIFIED    AAPL,SPY,QQQ,PLTR,TSLA,GIS,TFC,MO,VZ,UPS
                                     8e303cd7 · TRA-3417 · universe_0 · 2026-08-13T10:22:25Z
OPTION_LIVE_TEST_NOTIONAL_CAP_USD_RATIFIED   350
                                     1db5e5ca · TRA-3592 · cap_350 · 2026-08-13T15:40:17Z
OPTION_LIVE_TEST_AGGREGATE_CAP_USD_RATIFIED  750
                                     458710ce · TRA-3384 · expand_holdout_nke · 2026-08-12T23:32:44Z
```

⚠️ **Mind the unit.** `458710ce` authorised "max $750 **total**" and $750-total has already
once shipped as $750-per-book. `aggregateCapUsd` publishes the FLEET total, which is the
unit that record grants; the per-entry cap is a separate stamp on purpose, so one can never
silently grade the other. Note also that `LIVE_OPTION_TEST_AGGREGATE_CAP_USD` is **unset**
on bqb1 — the 750 in force is the compiled default, and the stamp grades the RESOLVED value,
which is what the order site actually uses.

Writes go through the single-key path above, then the pinned apply
(`--commit=<sha already serving>`) — the stamp is inert until a deploy bakes it.


### Standard deploy (self-hosted PM2)

1. On the production machine, sync the target commit — deploys track `main`:
   `git fetch origin && git checkout main && git pull`.
2. Build: `pnpm install --frozen-lockfile && pnpm run web:build`.
3. Restart the process: `npx pm2 restart trading-server`
   (first run on a fresh box: `npx pm2 start ecosystem.config.cjs`).
4. PM2 keeps the process up via `autorestart`; verify `/api/health` before
   declaring the deploy done. PM2 stops retrying after `max_restarts` (10) — the
   `restart-storm` alert (§5) is the in-process proxy for noticing that.

> **Render alternative (not currently provisioned).** If the company later
> deploys the [`render.yaml`](../render.yaml) blueprint, Render auto-deploys
> from `main`: it runs the build, starts `node packages/server/dist/index.js`,
> and polls `/api/health` until `{ ok: true }` before cutting traffic over.
> Provisioning Render is tracked in TRA-444 and needs dashboard access — do not
> run it alongside the self-hosted instance.

### Verify a deploy

```bash
curl -s http://<host>/api/health            # { "ok": true, "time": "..." }
curl -s http://<host>/api/health/storage    # confirm dataDir_exists + backupsDir_exists
```

**TRA-2599 — this route is now a liveness SUBSET.** It answers unauthenticated with
booleans only: `dataDir_exists`, `tra142Migrated`, `backupsDir_exists`, and
`disk.{readable,belowThreshold}` + `disk.monitor.{stalled,ageSec}`. The sizes, mtimes,
account counts, `backupsCount`, `dataDir` itself and the TRA-2420 `usage` block moved to
`GET /api/health/storage/detail`, which needs an **admin** token. `backupsCount > 0` is
therefore a *detail*-route check now; `backupsDir_exists` is the ungated stand-in.

⚠️ Read `disk.readable` before `disk.belowThreshold`. `belowThreshold` is `null` — not
`false` — when `statfs` could not be read, so `if (!belowThreshold)` treats an
unmeasurable disk as a healthy one.

Then log into the dashboard and confirm a `state` snapshot arrives over the
WebSocket (the UI populates).

If you are reading `GET /api/health/live-capital-gate` after a deploy, the rule that
decides what a per-sleeve `infeasible` does to `gate.passed` — and the difference between
a `FAIL` and an `INFEASIBLE` `positive_expectancy` — lives in
[`docs/live-capital-gate.md`](live-capital-gate.md) §"Rule R1" (TRA-2361). Grade the route
with `node scripts/tra2335-feasibility-check.mjs --live`; it grades the **instrument**, not
the book, so a live `infeasible` sleeve is a market observation, never a broken deploy.

### Render deploy status & failed-build logs (TRA-893)

The public backend (`tradingai-bqb1`, §1) auto-deploys on push to `main` **only
while `autoDeploy` is on** — it is currently **off** (pinned; see *Launch-window
deploy freeze* below, TRA-1653/TRA-1665). To check whether the latest deploy went
live and — when it **failed** — pull the build/deploy logs automatically (instead
of opening the dashboard):

```bash
RENDER_API_KEY=rnd_… pnpm run render:status
```

`scripts/render-deploy-status.mjs` resolves the service, reads the latest deploy,
prints its status/commit/timings, and on a failed deploy
(`build_failed` / `update_failed` / `pre_deploy_failed` / `canceled`) pulls the
log window for that deploy and prints it. Exit codes: `0` succeeded, `1` failed
(logs printed), `2` usage/auth error, `3` still in progress.

- The **`RENDER_API_KEY`** is the only requirement — get it from the Render
  dashboard → *Account Settings → API Keys*. Keep it in the environment; never
  commit it (same rule as the `sync:false` secrets in `render.yaml`).
- Override the target with `RENDER_SERVICE_ID=srv-…` (skips name lookup) or
  `RENDER_SERVICE_NAME=…` (default `TradingAI-`). **The service's Render `name` is
  `TradingAI-`; `tradingai-bqb1` is its `slug`**, which is what the onrender hostname
  tracks and what everything else in this runbook calls the host. `GET
  /v1/services?name=tradingai-bqb1` returns `[]` — the filter is exact and
  case-sensitive. Both helpers now accept **either** string (name is tried first, so one
  service's slug can never shadow another's name), and a name that resolves to nothing
  reports whether the key saw **zero** services (a key problem) or saw some and none
  matched (a name problem). The default used to be the slug and the refusal blamed the
  API key for it — TRA-3743, off TRA-3736/TRA-3719. `RENDER_SERVICE_ID` is still the only
  binding that cannot drift.
- Set `RENDER_WATCH_MS=10000` to poll until the deploy reaches a terminal state —
  handy right after a push.
- Because it exits non-zero on a failed deploy, it can back a recurring
  deploy-health gate (routine/CI step) that surfaces a broken `main` build
  without anyone watching the dashboard.

First triage when a Render build fails: the build command is
`pnpm install --frozen-lockfile && pnpm run web:build` (`render.yaml`). The most
common fresh-environment causes are (a) **pnpm version drift** — Render has no
`packageManager` pin, so its pnpm may differ from the one that wrote
`pnpm-lock.yaml` (lockfileVersion 9.0 → pnpm 9/10); and (b) a TS compile error in
`packages/*` that didn't surface locally. Pull the logs above to see which.

### What a redeploy does to running state

- A PM2 restart sends `SIGINT`/`SIGTERM`, which triggers `gracefulShutdown()` —
  the current engine tick finishes and the process exits cleanly inside the
  signal grace window.
- In-flight broker orders are **not** held across the restart; the next
  reconcile pass picks them up. Avoid redeploying during active trading hours
  if it can wait.
- Session tokens **survive** a restart **only if `AUTH_SECRET` is a stable env
  var** (see §1). With an ephemeral secret every restart logs all users out.

### Rollback

Roll back by checking out the last-good commit and redeploying: on the
production machine `git checkout <good-commit>`, rebuild (step 2 above) and
`npx pm2 restart trading-server`. Or revert the offending commit on `main` and
redeploy. The data dir is untouched by a rollback, so user data is unaffected.
If a rollback crosses a data-format migration, restore data from a backup taken
before the bad deploy (see §3). (On Render: use **"Rollback to this deploy"**.)

### Environment / secret changes

Broker credentials and all tuning knobs are env vars — the annotated list lives
in [`render.yaml`](../render.yaml) (the keys are the same whether self-hosted or
on Render; `sync: false` there just means "set out-of-band, never committed").
For the self-hosted process, set them in the environment PM2 launches with
(shell env, an `env` block in `ecosystem.config.cjs`, or a process-manager
`.env`). Changing one requires a `pm2 restart` to take effect.

## 3. Backup & recovery

### How backups work

- `rotateBackups()` snapshots every file under `DATA_DIR` into
  `$DATA_DIR/backups/<ISO-timestamp>/` **every 30 minutes** (and once on boot).
- The last **24** snapshots are kept (~12 hours); older folders are pruned.
- Backups mirror the live layout: global files at the snapshot root, per-user
  trees under `backups/<ts>/users/<username>/`.

### Automatic recovery

On startup, if a primary file (a user's trades, settings, equity, or
`users.json`) is **missing or corrupt**, `trade-store.ts` automatically restores
it from the most recent backup and logs a `Restored file from backup` warning.
For most single-file corruption, no operator action is needed — just restart.

### Manual recovery

If automatic restore is not enough (e.g. you need an older point in time):

1. Open a shell on the production machine (on Render: dashboard → **Shell**).
2. List snapshots — newest last:
   ```bash
   ls -1 $DATA_DIR/backups
   ```
3. Pick a timestamp from *before* the corruption. To restore everything:
   ```bash
   cp -r $DATA_DIR/backups/<timestamp>/* $DATA_DIR/
   ```
   To restore one user only:
   ```bash
   cp -r $DATA_DIR/backups/<timestamp>/users/<username> $DATA_DIR/users/
   ```
4. Restart the service (`npx pm2 restart trading-server`).
5. Verify with `GET /api/health/storage/detail` (admin token — it carries the file
   sizes/mtimes and `userCount` you need to confirm the restore) and a dashboard login.
   The ungated `GET /api/health/storage` only tells you the paths EXIST.

> **Backups are on the same disk.** The 30-min snapshots protect against file
> corruption and bad writes, **not** disk loss. For disaster recovery, copy
> `$DATA_DIR` (or the latest `backups/<ts>/`) off-box periodically — currently a
> manual step; an off-box backup is a known gap.

### Restoring a **deleted** user (TRA-2410)

A username is the primary key for every per-user store, so re-registering a name
is an *adoption* unless something stops it. Two things now do:

- `$DATA_DIR/deleted-accounts.json` — the tombstone file. It records, per
  username, the ms-epoch at which that identity ended. `tryRestoreFromBackup`
  refuses any generation stamped **before** that epoch, and the demo-calendar fold
  scopes the shared option journal to rows opened at or after it. **Keep this file
  with the data it describes**: restoring a `$DATA_DIR` *without* it brings back
  the user trees and silently re-arms the adoption bug. It is mirrored into every
  backup generation for exactly this reason.
- `$DATA_DIR/orphaned-books/<username>@<stamp>/` — where a book is parked when
  someone registers a name that still has data on disk. Nothing is deleted; the
  tree is moved off the live key.

So:

- **Restoring a user's data to the SAME account** (the ordinary corruption case,
  step 3 above) is unaffected — copying the primary files back works, because the
  tombstone guard only governs the *automatic* restore of a **missing** primary.
- **Re-creating a user that an admin deleted** (`DELETE /api/admin/users/:username`
  retains the files by design, TRA-142) must say so explicitly:

  ```bash
  curl -X POST .../api/admin/users -H 'Authorization: Bearer <admin>' \
    -d '{"username":"...","email":"...","password":"...","adoptExistingBook":true}'
  ```

  Without `adoptExistingBook`, the create succeeds with a **fresh** book and the
  response carries `retiredOrphanedBook.quarantinedTo` naming where the old one
  went. That is recoverable — move it back under `users/<username>/`, delete the
  name's row from `deleted-accounts.json`, and restart.
- `POST /api/auth/signup` never adopts. A `503 Could not prepare a clean account`
  from signup means the retirement failed (permissions on `$DATA_DIR`); the
  registration is refused rather than handing the caller someone else's positions.
  Check the `orphaned-books: retirement complete` log line for `errors`.

## 4. Scaling guide

### Current limits

The self-hosted single instance is **one process on one machine** — fine for a
small user base, paper trading, and a controlled live test. Constraints to
watch:

- **Disk.** Logs rotate at 10 MB per file; backups keep ~12h of snapshots;
  trade history and option-chain caches grow over time. The `disk-near-full`
  alert fires below `DISK_MIN_FREE_PCT` (10%).
- **CPU / memory.** Every active user runs their own equity + crypto engine in
  the single process. Engine count scales with user count.
- **No horizontal scale.** Engine state and the WebSocket bus are in-process;
  the app is **not** multi-instance safe today. Run exactly one instance.

### When to scale up

| Symptom | Action |
|---|---|
| `disk-near-full` alert; `health/storage` shows `disk.belowThreshold: true` (byte figures on `health/storage/detail`, admin) | Prune old option-chain caches; attach a larger volume / raise free space on the `DATA_DIR` disk. |
| Tick loop lagging / high memory under user growth | Move the process to a larger machine — vertical scale only. |
| Need true HA / horizontal scale | Larger effort: extract engine state to shared storage and add a message bus. Not supported today; scope as a project. |

### Scaling steps (vertical)

1. Provision a larger machine / bigger volume.
2. Deploy the process there per §2 and migrate `$DATA_DIR` (copy the data dir,
   then start the new instance — never run both at once).
3. Confirm via `GET /api/health/storage` (mount liveness) and
   `GET /api/health/storage/detail` (admin — sizes/counts survived the migration).

(On Render, vertical scale is a `plan` / `disk.sizeGB` bump in `render.yaml`.)

## 5. Alert response

Alerts are produced by the scheduler's 60s monitor hook and delivered to
`ALERT_EMAIL` and/or `ALERT_WEBHOOK_URL`. They always land in
`$DATA_DIR/logs/alerts.jsonl` and `GET /api/health/alerts` even with no sink
configured. Each alert key self-throttles (~30 min) so an outage produces one
alert per window.

| Alert | Meaning | First response |
|---|---|---|
| `health-check` | `GET /api/health` stopped returning `{ ok: true }`. | Check the PM2 process (`npx pm2 status`) and logs. If the process is down, `npx pm2 restart trading-server`. Confirm `/api/health` recovers. |
| `disk-near-full` | Free space on the `DATA_DIR` disk below `DISK_MIN_FREE_PCT` (default 10%). | **Read the alert's own log line, not the email** — it carries `freePct=` *and* the threshold it was compared against. TRA-2357's 2026-07-25 CRITICAL was `16.3% free — below 99%`: a healthy disk against a mis-set threshold, which from the inbox is indistinguishable from a real capacity event. Then `GET /api/health/storage/detail` (admin token — TRA-2599 moved the byte figures there; the ungated route gives you `disk.belowThreshold` but no sizes) for sizes and see "Option-chain archive" below; if structurally full, attach a larger volume (§4). |
| `restart-storm` | >5 process boots in 10 min — instance is crash-looping. | Read `errors.jsonl` / PM2 logs for the crash cause (bad deploy, corrupt data, OOM). Roll back the deploy (§2) or restore data (§3). Note PM2 gives up after `max_restarts` (10). |
| `trade-volume-zero` | No positions opened by 12:00 ET on a stock trading day. | Often benign (no qualifying signals). Confirm data feeds are fresh (`GET /api/health/quotes`) and auto-trading is enabled. Escalate only if feeds are stale. |
| `error-spike` | >25 errors captured in 15 min. | Grep `errors.jsonl` for the dominant error; correlate by `traceId`. See `observability.md`. |

### Option-chain archive — the biggest thing on `/data` (TRA-2417)

`/data` on bqb1 is a **1 GB** volume and the TRA-779 capture is the dominant
writer. Uncompacted it added **~8.4 MB per trading day and nothing reclaimed
it**: by 2026-07-26 that was 48 partitions ≈ 403 MB of the 850 MB used, on a
trajectory to cross the 10% floor ~2026-07-30 and fill ~2026-08-13.

Aged partitions are now stored **gzipped** — `<DATE>/<SYMBOL>.json.gz`, measured
at **11.3% of the plaintext bytes** on the real 2026-07-24 partition. Compaction
runs at boot (after the IVR enrichment backfill) and again after each 3:55 PM ET
capture. It is **non-destructive: no partition is ever deleted.** The plaintext is
unlinked only after the `.gz` has been read back from disk and byte-compared to
it. `_meta.json` is deliberately left plain.

```bash
curl -s https://tradingai-bqb1.onrender.com/api/health/chain-capture | jq '.storage'
#   storage.totalMb                     archive size
#   storage.compactedPartitions         aged partitions, all gz
#   storage.plainPartitions             expect exactly 1 — the newest, left plain
#                                       on purpose. 0 or >1 is the anomaly.
#   storage.lastCompaction.at/.failures last run + files that KEPT their plaintext
#   storage.retention.beyondWindowMb    what a 30-day prune WOULD reclaim
#   storage.retention.enforced          always false — nothing here deletes
```

⚠️ `retention` is **reporting only**. The capture is the only copy of that data
and a partition deleted is not recoverable; pruning is the capture owner's call
and, once compacted, is not needed for capacity. `CHAINS_RETENTION_REPORT_DAYS`
only moves the reported window.

⚠️ Every reader of a per-symbol snapshot must go through
`listChainSnapshotFiles` / `readChainSnapshotFile` (`@trading-app/backtest`). A
bare `endsWith('.json')` filter silently skips a compacted partition —
`AAPL.json.gz` does not end with `.json` — and an empty read is indistinguishable
from an empty partition. `/api/health/chain-capture/partition/:date` serves the
identical JSON either way, so `scripts/pull-recorded-chains.mjs` is unaffected.

### Triage workflow

1. **`GET /api/health/alerts`** (authenticated) — recent alerts + 15-min error
   count, without shelling into the box.
2. **Logs** — `$DATA_DIR/logs/` (and `npx pm2 logs trading-server`). `app.jsonl`,
   `errors.jsonl` are JSON-lines; pipe through `jq`. Query by `traceId`.
3. **Storage** — `GET /api/health/storage` (open) for mount/threshold liveness;
   `GET /api/health/storage/detail` (**admin**) for the byte-level disk figures, file
   sizes/mtimes, account counts and the TRA-2420 `usage` breakdown.
4. **Feeds** — `GET /api/health/quotes` for market-data freshness.

## 6. Routine operations

| Task | How |
|---|---|
| Tail logs | `npx pm2 logs trading-server`, or `$DATA_DIR/logs/*.jsonl` (on Render: dashboard → **Logs**) |
| Restart | `npx pm2 restart trading-server` (on Render: dashboard → **Manual Deploy / Restart**) |
| Check health | `curl http://<host>/api/health` |
| Inspect storage (liveness) | `curl http://<host>/api/health/storage` — no token; booleans only |
| Inspect storage (full) | `curl -H 'Authorization: Bearer <admin-token>' http://<host>/api/health/storage/detail` |
| Lock / unlock a user | `POST /api/admin/users/:username/lock` (admin token) |
| Reset a user's password | `POST /api/admin/users/:username/reset-password` (admin token) |
| Reseed reboot autostart | `npx pm2 save` after any change to the running process set (see §1 "Autostart on reboot"). The `PM2 Resurrect` scheduled task restores exactly what was last saved. |
| Manage PM2 after a reboot | The daemon is `SYSTEM`-owned post-reboot → use an **elevated** shell for `npx pm2 …` (non-elevated gets `EPERM` on the pipe). To return to user-context ownership: elevated `pm2 kill`, then `npx pm2 resurrect` from a normal shell. |

### Account-snapshot swap on restart (TRA-522)

**Symptom.** After a `trading-server` restart the demo/live book changes
wholesale — equity, open positions, options and closed history all flip to a
different, stale set (observed 2026-06-03: $1,000 → $26,397, QBTS/NVAX/GM →
IREN/ASTC, open options → none). This is **not** drift; it is a *different book*.

**Root cause.** Account state persists under `DATA_DIR`. When `DATA_DIR` is
unset, the server falls back to a path anchored to its own module —
`<repo>/packages/server/data/`. The host carries **two clones** of the repo
(`_default/tradingai_repo` and a sibling `~/TradingAI`, each with its own
`ecosystem.config.cjs` using `cwd: __dirname`). A restart launched from the
*other* clone / ecosystem file therefore reads that clone's
`packages/server/data/` — a different snapshot — and the live book becomes
invisible (it is not lost, just not loaded).

**Fix (shipped).** `ecosystem.config.cjs` now sets `DATA_DIR` explicitly, and
`trade-store.resolveDataDir()` guarantees the path is launch-cwd independent
(regression: `packages/server/src/data-dir-persistence.test.ts`). Start the
server only from the canonical path via
[`ops/bootstrap-trading-server.sh`](../ops/bootstrap-trading-server.sh).

**If it recurs — confirm a second instance / wrong clone:**

```bash
npx pm2 jlist | npx --yes json -a name pm_cwd                 # PM2 cwd per app
npx pm2 describe trading-server | grep -E 'cwd|exec cwd|script'
# Any second listener on :4242 (a parallel instance)?
ss -ltnp 'sport = :4242'      # Linux
netstat -ano | findstr :4242  # Windows
# Which data dir did the live process actually resolve?
grep -F 'DATA_DIR resolved' "$DATA_DIR/logs/"*.jsonl | tail -1
ls -1d ~/TradingAI/packages/server/data ~/_default/*/packages/server/data 2>/dev/null
```

Recovery: stop the stray/duplicate process, relaunch the single instance from
the canonical path, and confirm `/api/state` shows the expected book. If the
wrong clone overwrote nothing (it never does — it writes only its own dir), the
live book is intact under the canonical `DATA_DIR`; no data restore is needed.

## 7. Known operational gaps

Carried forward from the TRA-402 review — be aware when on call:

- **No off-box backup** — snapshots share the data disk; disk loss loses them.
- **Single instance, no failover** — an instance outage is a full outage.
- **No vendor APM** — error telemetry is a webhook seam (`ERROR_WEBHOOK_URL`),
  not a wired Sentry/Datadog SDK.
- **PM2 stops after 10 restarts** (`max_restarts`); the `restart-storm` alert is
  the in-process proxy for noticing that.
- **No external access path** — the instance binds host-local on `PG-DEVOPS14`
  with no reverse proxy, so it can only be reached from the host itself.
  Recorded in §1 (closes the TRA-444 / TRA-447 documentation follow-up).

## 8. GitHub credential for agent pushes (TRA-1675)

**Owner: human operator.** This is the one step no agent can perform — issuing a
credential for a private repo is secret issuance. Every agent on this host shares
the same empty credential store, so delegating sideways cannot fix it.

### Symptom

`git push origin main` **hangs** (observed >8 min, no output), rather than failing.
`git fetch` too. The network is fine — GitHub answers `401` because `origin`
(`https://github.com/Networkgems/TradingAI-`) is private and the host has no
credential. Git Credential Manager then blocks on a prompt that a headless agent
session can never answer.

A hang is worse than an error: an agent whose push is killed mid-hang can report
work as shipped while the commit is still only local. Run the preflight instead of
retrying the push:

```bash
pnpm check:push-auth     # answers "can I push?" in ~1s; lists stranded commits
```

### Diagnosis (2026-07-12) — it is a rotating OAuth token, and it will recur

The host authenticates with a **`gho_` GitHub OAuth access token** (GCM generic
credential `git:https://github.com`, user `Networkgems`). Those **expire on a clock**;
GCM silently mints a replacement from a companion refresh token.

That is the whole explanation for the outage: the credential worked at 18:27, was gone
by 18:44, and came back on its own. Nobody revoked it and nobody re-issued it — **it
rotated, as designed**. So expect this to happen again. It is self-healing: wait and
re-run. It only becomes a human ticket if it *stops* self-healing, which means the
refresh token expired too.

Two traps this cost us, both of the same shape — **presence is not validity**:

- **An expired token does not leave the store.** It fills from `git credential fill`
  perfectly happily. So any check that tests "is a password present?" prints OK and
  hands you straight to a 401 on push. The preflight therefore **actually
  authenticates** (`git ls-remote --heads`, ~1s, bounded and non-interactive).
- **`git` does not read `$GH_TOKEN`.** That is a `gh` CLI convention, and `gh` is not
  installed here (`credential.helper=manager`). Exporting the token and stopping there
  leaves git with *no credential at all* — verified: with the helper disabled and the
  token set, git reports `could not read Username`. The `credential.helper` line in
  Option 1 below is not optional garnish; it is the part that makes the token work.

### Fix — any one of these

Option 1 is the most durable for headless heartbeats.

1. **PAT in the environment** (preferred) — a PAT does not rotate, so it removes the
   recurrence entirely. Needs `repo` scope on `Networkgems/TradingAI-`. **Both steps are
   required** — the export alone does nothing (see above):

   ```powershell
   # PowerShell, persists for the user across sessions
   [Environment]::SetEnvironmentVariable('GH_TOKEN', '<paste-PAT>', 'User')
   ```

   Then configure git to use it non-interactively:

   ```bash
   git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f'
   ```

2. **Seed the credential store once, interactively** — from a real terminal on the
   host (not an agent session), so GCM caches a github.com credential:

   ```bash
   git push origin HEAD      # complete the GCM browser/device prompt
   ```

   Note this survives only as long as the token behind it does; when it lapses the
   symptom returns exactly as described above. Option 1 fails more visibly.

3. **Deploy key / token-embedded remote** for the agent workspace.

### Verify, then drain the backlog

```bash
pnpm check:push-auth              # must print OK
git push origin main              # drains any stranded commits
curl -s https://.../api/health/version   # confirm the running SHA (see §2)
```

⚠️ Pushing to `main` does **not** deploy bqb1. `autoDeploy` is **off** (the pin —
§2 "Launch-window deploy freeze"); the last commit-hook deploy was 2026-07-12.
Draining the backlog therefore ships nothing, and `/api/health/version` will keep
reporting the old SHA with no error anywhere. Confirm the gap explicitly:

```bash
pnpm check:deploy-drift    # DRIFT = commits between the running build and origin/main
```
