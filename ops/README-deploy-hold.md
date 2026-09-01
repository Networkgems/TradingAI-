# `ops/deploy-hold.json` — the repo-resident deploy hold (TRA-4261)

A **fail-closed hold on deploying, that lives in the repo instead of in a ticket thread.**
`scripts/render-redeploy.mjs` reads it **first**, before `RENDER_API_KEY` is read and before any
byte reaches Render, and exits **9** while a hold covering the target service is open.

## Why this exists

On 2026-09-01, `e1dbf341` (TRA-4218) was an ancestor of `origin/main`. It runs at **snapshot
import — i.e. at boot** — and on the three open real-money rows in production Tradier `***0154`
it deletes `closeRejectCount`, drops the `close_reject` `exitBreakerTrip`, and re-arms the exit
path through one backoff step. `render-redeploy.mjs` ships the **tip**, not a pin (TRA-3888: *a
pinned `--commit` ages — drop it, ship the tip*).

So **any owner deploying bqb1 for an entirely unrelated reason would have performed that
migration on live money**, without ever reading TRA-4217. The only signal was prose in a ticket
thread — and prose in a ticket thread is not a gate. It does not execute, and it is not
discoverable from the code you are shipping.

## Why a file and not another table in `render-redeploy.mjs`

`EMBARGOES` and `COMMIT_HOLDS` are right for what they hold. This is a different animal, and it
needs three properties a table in a 1400-line script cannot have:

1. **`git log ops/deploy-hold.json` is the hold's entire history**, in one command, with no
   ticket access and no board seat.
2. **It ships on the tip**, so the artefact and the warning about the artefact travel together.
   Opening or clearing a hold is a one-file diff a reviewer reads in ten seconds.
3. **It has no `until`.** The other two tables self-expire because they protect a *measurement*,
   and a measurement finishes. This protects a **decision that has not been taken**, and a
   decision does not expire on a clock — inventing an expiry would hand the answer to the
   calendar. It clears when somebody **deletes the entry**, which is a recorded, attributable act.

## Shape

```jsonc
{
  "holds": [
    {
      "ticket":   "TRA-4217",                 // required. The TRA-#### token is what --override-hold must name.
      "reason":   "…",                        // required. Printed VERBATIM in the refusal.
      "openedAt": "2026-09-01T14:32:00Z",      // required. ISO, Z.
      "openedBy": "LeadDev (d3355d6d) — …",    // required. Who to talk to.
      "emits":    ["…", "…"],                 // required, non-empty. What a deploy WOULD DO if performed.
      "enumeratedTip": "8061bbf62c76…",        // required. The origin/main sha `emits` was taken against.
      "enumeratedAt":  "2026-09-01T15:15:00Z", // expected. When. ISO, Z.
      "enumeratedBy":  "LeadDev (d3355d6d) …", // expected. Who took it, and off what.
      "service":  {                            // optional. ABSENT MEANS EVERY SERVICE.
        "ids":   ["srv-d7mb7rr7uimc73ev0chg"],
        "names": ["TradingAI-", "tradingai-bqb1"]
      },
      "clearedBy": "…"                        // optional but expected. What must happen for this to go away.
    }
  ]
}
```

`emits` is the field that earns the mechanism. A hold that only says *don't deploy* makes the
next owner go and ask why; a hold that says *this boot deletes `closeRejectCount` on three
real-money rows and re-arms the exit path* lets them decide without asking anyone.

## `emits` describes a TIP, and tips move (TRA-4262)

**Read this before you open a hold, and again before you clear one.**

`render-redeploy.mjs` ships the **tip**, never a pin (TRA-3888: *a pinned `--commit` ages —
drop it, ship the tip*). So the set of bytes a hold is holding back **grows every time anybody
pushes**, while the `emits` array stays exactly where it was typed. An `emits` list is therefore
a **snapshot of a moving target**, and it is a **lower bound** on what a deploy would carry from
the moment it is written.

This is not a discipline problem, and it was not caught by inspection. On 2026-09-01 **two
independent enumerations of the same deploy went stale inside thirty minutes** — the TRA-4217
hold's `emits`, written at 14:32Z against `4e0f4438`, and card `438ed4c5`'s scope on TRA-4217,
which named the same tip. `77047ea0` (TRA-4255, +223/+31 server bytes) was already in the box and
named in neither; `8061bbf6` (TRA-4154) landed while the ticket about it was being written. The
consequence was specific and on real money: whoever cleared the hold would have read an honest,
complete description of the TRA-4218 heal, deployed, and also shipped a published-telemetry change
to production Tradier `***0154` without ever being told it was in the box.

The structural point:

> **An unpinned deploy authorization cannot be enumerated in advance. The enumeration is an act
> performed AT CLEAR TIME, by the clearer.**

So, for **every** hold, not just this one:

1. **Stamp it.** `enumeratedTip` is a **required field** — a hold without it is BLIND and refuses,
   same as one missing `emits`. It is the `origin/main` sha the list was taken against, and it is
   what makes staleness answerable by inspection instead of undetectable:
   ```bash
   git log       <enumeratedTip>..origin/main   # what has landed since
   git diff --name-only <enumeratedTip>..origin/main
   ```
2. **Re-enumerate before you clear.** The clearing commit must either **extend `emits`** with what
   the delta emits, or **state that the delta touches no server byte** and why that is safe.
   `packages/**` outside tests is what the Render build compiles and the box then runs; `ops/`,
   `scripts/` and `docs/` do not ship in the server image. One reviewable diff, and it is the
   clearer's act — not a promise the hold's author could have made on their behalf.
3. **Re-stamp if you leave it standing.** A hold you decide to *keep* also gets a fresh
   `enumeratedTip`/`enumeratedAt` for whatever you just measured against. A hold left open on a
   stale enumeration is the defect this section exists for.
4. **The stamp cannot name its own commit.** Whatever you write, the commit that writes it lands
   *after* the sha it names, so the first entry in `git log <enumeratedTip>..origin/main` will
   normally be the hold edit itself. That is expected and reads as exactly what it is in the
   refusal text — a one-commit, zero-server-byte delta.

### The script says it out loud

`render-redeploy.mjs` computes the drift and prints it **directly under `emits`** in the refusal,
and again in the `--override-hold` echo:

```
  ⚠ THIS HOLD'S BLAST-RADIUS ENUMERATION IS STALE — TRA-4262.
    enumerated against : 8061bbf62c76 (2026-09-01T15:15:00Z)
    would ship         : 1f4c0a9be331 — local origin/main (…a lower bound on the real tip)
    2 commit(s) have landed since, and the emits[] above does NOT describe them:
      · 1f4c0a9 feat(TRA-4268): …
      · 9ab21ce fix(TRA-4270): …
    1 of the 3 changed path(s) are SERVER BYTES this box will run:
      · packages/server/src/options-account.ts
    RE-ENUMERATE BEFORE YOU CLEAR: git log 8061bbf62c76..origin/main — …
```

Five statuses, and only `CURRENT` is silent: `STALE` · `UNSTAMPED` · `DIVERGED` (the stamp is not
an ancestor of what would ship) · `BLIND` (git could not answer — **never** collapsed into
`CURRENT`; a shallow checkout returning an empty list is BLIND, TRA-3699) · `CURRENT`.

Three deliberate limits, because a check that overstates itself is worse than none:

- **It augments, it never decides.** Staleness cannot turn `CLEAR` into a refusal and cannot lift
  a hold. A hold that applies already refuses; this makes that refusal honest. Gating on a
  housekeeping property would just get the stamp deleted rather than re-taken.
- **It takes no network.** Gate −1 landing before `RENDER_API_KEY` is read is load-bearing, so the
  comparison sha is your **local** `origin/main` (or `--commit`, which is what Render would build).
  An unfetched checkout makes the reported delta a **lower bound** — it can under-report drift,
  never invent it. The refusal says so.
- **"No server byte" is a claim about PATHS, not about behaviour.** The classifier recognises
  `packages/**` minus tests. Everything else is *unclassified*, never *inert* — read the files.

## Scoping

The gate runs before the Render round-trip, so it cannot know which service the API will
resolve. It evaluates the hold against the **service ref this invocation is aimed at**, derived
from the environment by `requestedServiceRef()`, which **mirrors `resolveService()`'s precedence
exactly**: `RENDER_SERVICE_ID` wins outright and the name is not consulted; otherwise
`RENDER_SERVICE_NAME`, defaulted to the bqb1 service name. Mirroring rather than re-deriving is
the point — a scoping rule that disagrees with the resolver is a hold on the wrong host.

`names` should carry **both** the Render `name` (`TradingAI-`) and the **slug** (`tradingai-bqb1`,
which is what the onrender hostname tracks). TRA-3743: the money host answers to three identity
strings and a list with one of them in it is a hold with a dead disjunct.

Holds that exist but do not cover the target print a `NOTE` and proceed — deliberately not
silent. *"I read the hold file and it does not apply to you"* is a different fact from *"there is
no hold file"*.

## Fail-closed

| state | verdict | exit |
| --- | --- | --- |
| file absent (`ENOENT`) | `CLEAR` | falls through, **silent** |
| `{"holds": []}` | `CLEAR` | falls through, **silent** |
| a hold covers the target | `HELD` | **9** |
| unreadable / not JSON / no `holds` array / a hold missing a required field | `BLIND` | **9** |
| holds exist, none covers the target | `OUT_OF_SCOPE` | falls through, prints a NOTE |

A hold file that degrades to *allowed* the moment somebody fat-fingers a comma is not a hold.
The only clear read of a *present* file is one that parses and validates.

## Overriding

```
node scripts/render-redeploy.mjs --override-hold="TRA-4217 why this cannot wait"
```

The reason must be non-empty **and must name the ticket of an active hold** (case-insensitive).
This is the only one of the six overrides that demands the ticket: the other five guard a
condition the script can itself measure — a clock, a sha, a secret — so a bare reason is enough.
This one guards a **decision somebody else is holding**, and naming it is the cheapest available
proof the hold was read rather than the flag pasted out of the usage text. It costs seconds, so
it does not stand between anyone and a genuine emergency.

The override, the ticket, the opener and the full `emits` list are echoed **on the way in**, so
the breach is in the same scrollback as the deploy it authorised.

## Named limitation — read this before relying on it

**This is a convention, not a permission system.** Anyone who can deploy can delete the file.
That is accepted on purpose, and it is the same reason `--override-hold` exists at all: a hold
that cannot be broken gets **deleted instead of respected**, and a deletion leaves a far worse
record than an override does.

What the gate buys is that a deploy under a hold is a **decision somebody took and signed**,
instead of a side effect nobody saw.

It also covers **deploys only**. Like the RTH freeze and the embargo, it cannot see an env-var or
settings write — see `ENV_WRITE_TRUTH` in `scripts/render-redeploy.mjs`.

## Tests

`pnpm check:deploy-gates` (`scripts/tra2325-embargo-gate-check.mjs`, in `pretest`) carries the
discrimination arms: every REFUSE case paired with a PROCEED case differing by one variable, the
run fails if any verdict is unreachable, and — applying the TRA-3699 lesson, where a suite that
injected every input never once reached the real predicate — a **LIVE arm that drives the real
reader against the committed file**. That arm asserts a *property* (the file parses and
validates), never a specific hold, so the suite stays green after a hold is cleared. A test that
went red when you cleared a hold would be a reason not to clear it.
