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
