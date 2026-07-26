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

⚠️ It gates **deploys**. It cannot see an **env/settings write**, and one of those redeploys bqb1
anyway (`trigger: service_updated`) *despite* `autoDeploy=no` (TRA-2186), nor the memory watchdog's
own pm2 self-restart, which writes no deploy record at all (TRA-2203/TRA-2261). **A green run of the
script is not evidence the host is safe to touch.**

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
