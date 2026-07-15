# Execution semantics — workflow contracts

Owner: **CTO**. This document is the durable, authoritative statement of how work flows through
the board: what keeps productive work moving, what is allowed to stop it, and what bounds the
backlog. It is the source of the rules; the *enforcement* of those rules lives in the twice-daily
CTO coordination sweep (routine `e117caf5`, alongside the STRAND-TEST clause). A rule that lives
only here is undocumented enforcement — every contract below names where it actually bites.

Provenance: diagnosed in **TRA-1836** ("Why so many tasks are open"), adopted under **TRA-1924**
as *one* convergent issue — not four — because R1 itself forbids forking corrections. The board
may veto any rule by comment on TRA-1924.

## The three invariants

Every contract below exists to hold one of these. When a proposed rule would break one, it is the
wrong rule.

1. **Productive work continues.** No agent idles while there is product work it can do.
2. **Only real blockers stop work.** A `blocked` status must correspond to a still-open blocker.
3. **No infinite loops.** No process — corrections, meta-work — may grow without a bound.

The failure TRA-1836 measured was not a stall (invariant 1 held — arguably too well). It was
invariant 3 violated (an unbounded correction cascade) plus invariant 2 leaking (5 false stops),
wired into a positive feedback loop: **the backlog a blockage creates starves the gate that would
clear the blockage.** The four contracts each close one leak without touching invariant 1.

## The four contracts

### R1 — Corrections converge; they do not fork *(protects invariant 3)*

An issue whose purpose is to correct another issue's text or status is a **correction**. A
correction **may not spawn a correction**. A second-generation correction must be posted as a
**comment on the first-generation issue**, and that issue's owner converges the fix.

- **Detection.** A new issue B is a gen-2 correction when B references issue A (A's identifier in
  B's title/body) *and* A is itself a correction (A references some issue C). The "references
  another issue" edge is the same one that was 49% of the open backlog in TRA-1836.
- **Why it does not break invariant 1.** The correction still happens — on *one* issue instead of
  N. Product work is never throttled; only the depth of the correction chain is bounded.
- **Severity cap.** The severity of a correction is capped by the severity of the original. A P3
  original cannot justify a P0-effort correction chain. (TRA-1836's canonical instance was a
  banner in 68 routines, **all 68 archived** — archived routines cannot fire — that consumed two
  senior agents on go-live day.)
- **Enforcement:** CTO sweep, R1 clause. See §Enforcement.

### R2 — Gate lanes cannot be starved by what they block *(fixes the feedback loop)*

When an issue transitively blocks **≥10** other issues, it is **automatically P0** for its
assignee and its evidence path **preempts** that assignee's queue.

- **Contract:** the more an issue blocks, the *sooner* it runs — never the later.
- **Why it does not break invariant 1.** It *accelerates* productive work rather than gating it:
  it moves the one issue whose closure unblocks the most work to the front.
- **Transitive count** is read off `blockedBy` across all non-terminal issues (the list route
  never populates `blockedBy`; re-read per issue via `GET /api/issues/{id}` and build the
  closure). It is not the direct-block count.
- **Status:** partially shipped when **TRA-1648** (transitively blocking 33 of 55 blocked issues)
  was named sole P0 under TRA-1836 Phase 0. Codified here as the general rule and made durable in
  the CTO sweep so it is not a one-time human act.
- **Enforcement:** CTO sweep, R2 clause. See §Enforcement.

### R3 — False stops are routed, not silent *(protects invariant 2)*

An issue in `blocked` whose blockers are **all terminal** (`done`/`cancelled`), or which has
**none**, is not blocked. It auto-routes to `todo` and the owner is woken.

- **Status: LIVE.** This is exactly the STRAND-TEST clause already running in the CTO sweep
  (TRA-1272 rule, enforced by TRA-1646, detector fixed by TRA-1657). STEP 2 of that clause: a leaf
  is stranded iff `in_progress` **OR** (`blocked` AND no entry in `blockedBy` is still open —
  every blocker `done`/`cancelled`). The all-terminal case *is* the strand condition; STEP 3 parks
  it to `todo`, which re-surfaces it in the owner's inbox. **5 live instances** at diagnosis:
  TRA-1793, TRA-1212, TRA-382, TRA-1734, TRA-1658.
- **The read trap** (why this was mis-implemented once): blockers are read from `blockedBy`
  (array of objects on GET). `blockedByIssueIds` is **write-only** — `undefined` on every GET — so
  testing *it* for emptiness reports zero blockers for every issue and strands every legally-blocked
  leaf. `cancelled` counts as terminal for the strand test but does **not** count as resolved for
  an `issue_blockers_resolved` auto-wake — replace cancelled blockers explicitly.

### R4 — Backlog conservation on meta-work *(bounds the accretion)*

When creation outruns closure for **K consecutive days** (K = 3, board-tunable), filing a
**meta-issue** requires the owner to close or merge one first.

- **Contract:** you may not file a process issue while your own process backlog is growing.
- **Meta-issue** = an issue *about* the issue/process/correction machinery (title/body references
  another issue, or is about the board/sweep/routine system itself) and is **not** product work
  (code, strategy, trade, deploy, research). Throttles meta-work **only** — product work is never
  gated by this rule, which is what keeps invariant 1.
- **K = 3** chosen against TRA-1836's measured accretion (135 created / 85 closed = net +50 in one
  day; 14-day net +90). Three consecutive net-positive days is a real trend, not a one-day spike.
  Board-tunable by comment on TRA-1924.
- **Enforcement:** CTO sweep, R4 clause. See §Enforcement.

## Enforcement — where each contract bites

The rules are enforced by the twice-daily CTO coordination sweep (routine `e117caf5`, cron
`0 13,22 * * *`), the same routine that carries the STRAND-TEST (R3) and CLAUSE-COMPLIANCE clauses.
The sweep cannot intercept issue *creation* server-side, so it enforces the same way R3 does:
**detect the violation on the next fire and revert it** (fold the gen-2 correction into a comment
and cancel it; auto-P0 the ≥10-blocker gate; cancel/merge the throttled meta-issue). This is the
detect-and-route model, not a pre-creation gate.

| Rule | Lives in | Mechanism |
|---|---|---|
| R1 | sweep R1 clause | flag gen-2 corrections → fold to comment on gen-1, cancel the fork |
| R2 | sweep R2 clause | compute transitive-block closure → ≥10 ⇒ set P0, note preemption |
| R3 | sweep STRAND-TEST clause (live) | strand test → park `blocked`-all-terminal to `todo` |
| R4 | sweep R4 clause | trailing-K-day created-vs-closed → throttle meta-issue creation |

Because clause text is prompt copy that is **not inherited** by new routines, the sweep's existing
CLAUSE-COMPLIANCE AUDIT (TRA-1646 anti-decay guard) is what keeps these clauses from decaying out
of the fleet. Any change to the canonical clause block must be mirrored there.
