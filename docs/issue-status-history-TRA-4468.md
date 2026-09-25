# Recovering an issue's status history (TRA-4468)

**Question this answers:** *what status was issue X in at instant T?*

**Short answer:** it is recoverable, for every issue created from ~**2026-08-16** onward, with
**100%** accuracy on the 2026-09 cohort — but **not** from the two places TRA-4468 looked.
Use `scripts/tra4468-status-history.mjs`.

```
node scripts/tra4468-status-history.mjs --at 2026-09-09T21:30:00Z TRA-4445
```
```
=== TRA-4445
    status=done startedAt=2026-09-09T22:57:52.853Z
    blockedTransitionAt=2026-09-09T20:32:15.900Z  <- path-dependent, DO NOT key on it
    2026-09-09T20:32:16.020Z  in_progress  -> blocked      [system:recovery.reconcile_stranded_assigned_issue]
    2026-09-09T22:57:52.853Z  blocked      -> in_progress  [startedAt(inferred)]
    2026-09-09T22:59:51.040Z  in_progress  -> done         [patch]
    blocked intervals: 2026-09-09T20:32:16.020Z..2026-09-09T22:57:52.853Z
    status at 2026-09-09T21:30:00Z: blocked
```

Measured live `2026-09-10T00:2x–00:4xZ` over the 500 issues reachable via
`GET /api/companies/{companyId}/issues?view=compact` and all **7,039** of their audit events.
Re-verified live `2026-09-25T13:4xZ`: the TRA-4445 replay above reproduces byte-identically
15 days on, including the `blocked` verdict at `21:30Z` that TRA-4463's corrected cell rests on.

### `--at` must carry a timezone

`--at 2026-09-09T21:30:00Z` or an explicit offset (`…T17:30:00-04:00`). A zone-less instant is
**refused** (exit 2). It used to be accepted: `Date.parse` reads it in the *host's* zone, and on an
ET host `--at "2026-09-09 21:30"` answered `done` where the same wall-clock in UTC answers
`blocked` — the query silently landed on the far side of the window it was asked about. Every
timestamp the platform serves is UTC. An unparseable instant is likewise refused, rather than
making every comparison false and reporting `(before first recorded event)`.
Unknown flags are refused by name; they used to fall through and be looked up as issue keys.

### `--audit` self-checks the three event shapes

```
node scripts/tra4468-status-history.mjs --audit
```

Two halves, and only the first gates the exit code:

- **fixtures** — each of the three shapes in §2 must still parse to the right transition, and a
  non-status update must still parse to `null`. Deterministic; a failure here means the parser or
  the platform's event schema moved.
- **census** — counts each shape across the 500 most recent company audit rows (~15h of traffic)
  and prints the window it actually covered. **Informational only.** The route ignores
  `offset`/`cursor`/`from`, so the window cannot be widened, and `system` legitimately reads `0`
  whenever the recovery sweep has not fired — as it does on a healthy day. Folding that into the
  exit status would ship a check that is red on an ordinary day.

---

## 1. Never key a retrospective query on `blockedTransitionAt`

TRA-4468's claim is **confirmed, and understated**. The field is written by two paths that
disagree, so it is neither `lastBlockedAt` nor `blockedSince`:

| | measured |
|---|---|
| closed issues that were ever `blocked` | **118** |
| ...where `blockedTransitionAt` survived closure (sticky) | **17** (14.4%) |
| ...where it was cleared, losing the block from the row | **101** (85.6%) |
| explicit `blockedTransitionAt -> null` events in window | **38** (TRA-4468 filed 23) |

A query keyed on this field is therefore **not reproducible over time** — the same fixed
population re-measured later returns a smaller `n` as its members close. This is exactly why the
AGENTS.md WINDOW GUARD `blocked` cell had to be rebuilt from change *events*.

⚠️ `?view=compact` returns `blockedTransitionAt: null` for **all 500** rows regardless of the true
value. It is not a cheap substitute for `GET /api/issues/{id}` — reading stickiness off the compact
list produces a clean, entirely false "0 sticky".

## 2. `/activity` records far more than a `changes.status` query finds

The headline "181 of 238 leaves `done` with zero status events" does **not** reproduce. The
population's transitions are recorded — under **three different shapes**, only one of which a
`details.changes.status` query matches:

| transition class | recorded? | where |
|---|---|---|
| explicit agent `PATCH` | yes | `details.changes.status.{from,to}` |
| **system / recovery-driven** | **yes** | `details.previousStatus` + `details.status`, **no `changes` key at all** |
| creation | yes | `issue.created` / `issue.child_created`, `details.status` |
| **checkout pickup → `in_progress`** | **NO** | nowhere — see §3 |

Re-keying on all three lifts recoverability sharply:

| population | `changes.status` only | all three shapes |
|---|---|---|
| all 500 issues | 353/500 (70.6%) | **480/500 (96.0%)** |
| `done` issues (n=401) | 284 (70.8%) | **381 (95.0%)** |
| routine-execution leaves (n=110) | 105 (95.5%) | **109 (99.1%)** |

So TRA-4468's asks (2)(a) "record every status transition" and "there is no creation event" are
mostly already satisfied. The genuine residue is §3.

## 3. The one real hole: checkout writes no audit row

Of 476 issues carrying a `startedAt`, **472 (99.2%)** have **no** event recording a transition
into `in_progress`. Only 4 do. This is the single unlogged transition class, and it is worse than
TRA-4468 estimated.

It is fully repairable by the caller, because `startedAt` is never cleared and never re-stamped:
splice a `-> in_progress` transition in at `startedAt`, inheriting whatever the replay held just
before it. That is what the script does, and it is what recovers TRA-4445's `blocked` interval
above.

## 4. Paging: the per-issue route can't bound truncation; the company route can

`GET /api/issues/{id}/activity` takes **no** parameters but `id` — confirmed against the live
OpenAPI document — so a caller genuinely cannot distinguish a short feed from a capped one.

**`GET /api/companies/{companyId}/activity?entityId={issueId}&limit=500` serves the identical
rows, is agent-reachable, and honours `limit`.** Assert `rows.length < 500` and truncation is ruled
out. Largest feed observed: **197** events, so nothing is currently truncated.

⚠️ Silent fail-opens on that route — all measured, all return `200`:

| param | behaviour |
|---|---|
| `limit` | **honoured**, hard cap 500 (`limit=5000` → 500) |
| `entityId` | **honoured** |
| `offset` | **silently ignored** — `offset=5` returns the identical page. There is no paging. |
| `action`, `entityType`, `from`, `cursor` | **silently ignored** (an `action=` filter returned 9 distinct actions) |

`GET /api/companies/{companyId}/audit/agent-actions` *does* document `cursor`/`limit`/`action`/
`from`/`to`, but returns **`403 Board access required`** to an agent key. Agents use the company
`/activity` route.

## 5. The real limit: an audit retention horizon

Replaying the full history and comparing the reconstructed final state against the row's actual
`status`, by issue-creation cohort:

| cohort | replay agrees with the row |
|---|---|
| 2026-04 / 05 / 06 | 0/13, 0/14, 0/18 — **0%** |
| 2026-07 | 9/50 (18%) |
| 2026-08 | 220/262 (84%) — daily agreement reaches 100% from **2026-08-16** |
| **2026-09** | **143/143 (100%)** |

126 of the 128 replay failures are issues created **before 2026-08-24**. The audit table does not
reach back before ~mid-August, so status history for older issues is genuinely gone — that, not
the endpoint shape, is the true boundary. **Every population TRA-4463 measured (leaves created
since 2026-08-24) sits comfortably inside the recoverable window.**

## Recipe

1. Fetch `GET /api/companies/{companyId}/activity?entityId={issueId}&limit=500`; assert `< 500`.
2. Seed from the creation event's `details.status`.
3. Apply, in `createdAt` order, **both** `details.changes.status` and
   `details.previousStatus`→`details.status`.
4. Splice `-> in_progress` at the row's `startedAt` if no event covers it.
5. Derive blocked intervals from that timeline. **Never** from `blockedTransitionAt`.
6. Cross-check the replayed final state against the row's `status`. A mismatch means an unlogged
   hop remains — treat the reconstruction as unsound rather than trusting it.

## Still owed by the platform

Neither is agent-patchable; both are narrowed by the above.

- **Log the checkout transition.** 99.2% of pickups leave no audit row. `startedAt` patches the
  *first* pickup only; an issue picked up, released, and picked up again is not fully recoverable.
- **Pick one meaning for `blockedTransitionAt`** and make both write paths agree, or drop the field
  in favour of the event stream, which is already the more reliable source.

Lower priority, since §4 gives a working path: document `limit`/`entityId` on the company
`/activity` route and make the ignored params `400` instead of silently passing.
