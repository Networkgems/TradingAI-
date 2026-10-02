# TRA-4899 — `/data` tape reservations, ranked by worst-case bytes

**Measured live on bqb1 2026-09-25T03:21–03:28Z, build `a158c516`, pid 75 (booted 03:02:42Z).**
Every figure below is reproducible with `node scripts/tra4899-tape-census.mjs`, which asserts its
own manifest against the source lines it cites and exits BLIND rather than printing a stale table.

Disk: **973.4 MiB total, 364.7 MiB free (37.46%)**. Inodes: **39,147 free of 65,536 (59.73%)**.

---

## The headline: 192 MiB was not the largest reservation on the box

The TRA-4156 Phase 2 filing ranked five files by *size on disk* and concluded that
`otm-admission-tape`'s 192 MiB was the outlier. Ranked by **worst-case bytes** — the question a
reservation actually asks — the picture inverts:

| rank | worst case | kind | tape |
|---|---|---|---|
| 1–27 | **973.4 MiB each** | UNBOUNDED | 27 append-only files with **no cap of any kind** |
| 28 | 144.0 MiB | HARD | `otm-admission-tape.jsonl` (was 192.0) |
| 29 | 119.1 MiB | DERIVED | `cost-aware-gate.jsonl` |
| 30 | 72.3 MiB | DERIVED | `live-enforce-gate.jsonl` |
| 31 | 58.8 MiB | DERIVED | `reversal-shadow-signals.jsonl` |
| 32 | 48.0 MiB | HARD | `users/**/reports/closes/` — **all 68 books** |
| 33 | 44.4 MiB | DERIVED | `churn-brake-guard.jsonl` |
| 34 | 16.0 MiB | HARD | `users/**/reports/tape/` — **all 69 buckets** |

**`otm-admission-tape` was the largest *finite* reservation, not the largest one.** 27 files —
including `shadow-signals.jsonl` (7.6 MiB today) and `paper-trading.jsonl` (6.2 MiB today) — are
strictly append-only with no retention, no byte cap and no row cap, so each is bounded by the
volume and nothing else. Two of those were read end-to-end and are **confirmed** uncapped; the
other 25 are flagged `?` in the census output, meaning the cap absence was grepped but the write
path has not been walked. That is the same epistemic gap the filing itself flagged on
`reversal-shadow` ("I read the writer, not every call site"), and it is the residual this ticket
hands on.

### How the four units were put on one axis

| unit | worst case |
|---|---|
| bytes | the cap itself (plus the boot overshoot below) |
| days | `observed × (retainDays + bootGapDays) / retainDays` — observed is read live and is a post-compaction steady state |
| rows / inodes | **not** convertible without a measured bytes/row; the cap is named and observed bytes are reported as a *floor*, never as a worst case |
| none | **the volume** |

`bootGapDays = 4.93` is measured, not assumed: the longest interval between two `finishedAt`
timestamps across the 100 Render deploys spanning 2026-08-26 → 09-25. It is an **upper** bound —
the TRA-4158 watchdog also restarts the process and every restart compacts — so the real figure
can only be smaller. `--boot-gap=` overrides it.

---

## AC2 — `otm-admission-tape` re-scoped to **144 MiB**

`packages/server/src/otm-admission-tape.ts`: `MAX_FILE_BYTES` **192 MiB → 144 MiB**.

Measured off `/api/health/otm-admission-tape` (`durability` + `byClass[].days[]`), same instant:

- `29,956,613 B / 98,575 hydrated rows` = **303.9 B/row** blended. Decomposed: candidate rows
  ≈ 357 B, `ranked`/`ordered` link rows ≈ 150 B. (Arithmetic closes: the 4 policy-v2 sessions plus
  the one v1 session sum to exactly 98,575 rows.)
- Policy-v2 sessions 09-21 / 09-22 / 09-23 / 09-24 = 20,809 / 21,091 / 18,796 / 23,977 rows
  ⇒ **mean 6.43 MB/session, max 7.29 MB/session** (09-24).

**The evidence horizon this buys.** TRA-3927/AC4 — via the TRA-4623 re-run — needs **≥20 desk
sessions of raw rows on disk simultaneously**, and `sessionsWithAdmissions` is itself rebuilt from
hydrated days, so any cap below the bar makes the bar unreachable. `20 × 7.29 MB = 145.8 MB` is
therefore a hard floor. **144 MiB = 151.0 MB clears it by 3.5% ⇒ 20.7 worst-case sessions, 23.5
mean-case.** The tape stands at 4/20 today, so the cap is not yet exercised in either version.

The **48 MiB returned is, exactly, the entire 68-book `closes/` budget.**

### Two things the previous comment got wrong, and one it could not have known

1. **"the 60-day time retention binds first" is false by its own arithmetic.** 60 calendar days
   ≈ 42 trading sessions ≈ 270 MB at the volume that same comment measures — above the old 192 MiB
   and far above the new 144. The byte cap is the only leg that has ever bound this file. Comment
   corrected in place; `RETAIN_MS` left at 60 d and re-annotated as deliberate slack (it is the
   floor under a future, thinner sample, where 60 days of thin rows beats 20 sessions of fat ones).
2. **144 MiB is not a hard ceiling.** The byte prune runs inside
   `hydrateOtmAdmissionTapeFromDisk` — **boot only**. The true reservation is
   `cap + rate × maxBootInterval` = `151.0 + ~22` = **~173 MB**. (The old value's true reservation
   was ~224 MB.) Do not quote 144 MiB without the overshoot.
3. **The desk sample is policy-set, not demand-driven.** `MAX_ROWS_PER_SLOT.desk = 1000` saturates
   almost every RTH slot — `rowsBySlotEt` reads 995–1000 in 13 of 13 slots on three of four
   sessions, and `13 × 1000` brackets the 12,168–12,990 rows/session measured. So the file's size
   is set by the slot budget, and **the slot budget is the only lever that gets this reservation
   below the close ledger's 64 MiB** (÷4 would put 20 sessions in ~40 MB). That is TRA-4628's call,
   not this ticket's: changing it mid-collection reweights the four sessions already banked, and
   the sampler is pre-registered. Filed as a follow-up.

A fourth, for that ticket's owner: the `ranked`/`ordered` link rows are documented **"Never
throttled"** and carry no slot budget. They were 27.6% of all v2 rows and **38% on 09-24** (9,216
of 23,977, up 77% on 09-21). They are the one leg of this file with no policy bound at all.

> **Resolved by TRA-4906 (2026-09-25), and it was not growth — it was duplication.** TRA-4905
> measured 4.33x–11.56x duplication on `ranked` (`XLF261030C00056000` written 87 times on 09-24)
> while the count of *distinct* nominated contracts was **falling**: 872 → 1,023 → 800 over the
> three complete sessions as raw rows went 5,221 → 5,480 → 3,460. So `ranked` is now deduped per
> `(etDay, slot, accountClass, occSymbol)` — **information-preserving, not a throttle**: the
> survivorship join reads the SET of nominees, and its candidate leg is itself `(etDay, slot)`-
> granular, so a link finer than slot granularity has nothing finer to join to. Projected saving
> 1.60x–2.80x on the link leg, taking max per-session bytes 6.65 MB → **6.06 MB** (144 MiB: 22.7 →
> **24.9** worst-case sessions against the 20-session AC4 bar). `ordered` is deliberately left
> **unbounded** — it reads 0 on every day and both classes, so it costs nothing, and an `ordered`
> row is execution provenance. The bound this paragraph asked for is a *set* invariant, not a cap.
>
> TRA-4906 also made the slot-budget drop itself durable (`kind: 'budgetdrop'`, ~95 B/row,
> < 150 KB/session), published as `days[].dropsBySlotEt`. That is what the point above needs to be
> settled at all: `counters.slotBudgetPassesDropped` was one module-level integer zeroed by every
> boot and rebuilt from nothing on hydrate, so "how often does the budget bite, per slot" was
> unmeasurable at ~3.3 deploys/day. `MAX_ROWS_PER_SLOT` and `MAX_FILE_BYTES` are **unchanged** by
> that ticket: TRA-4905 ruled NO-CUT (the budget already size-filters each slot's tail — 31/40
> slots, p = 0.0007 — so cutting it amplifies a measured bias), and the cap is re-derived by
> TRA-4905 §5 off a *post-dedup* session, not before one exists.

---

## AC3 — `reversal-shadow-signals.jsonl` is already bounded

**Resolved before this ticket opened, by TRA-4883.** Commit `b690d64a`
(`fix(TRA-4883): bound reversal-shadow-signals.jsonl — 30d retention + boot compaction`,
2026-09-24T21:50Z) is an ancestor of the live build `a158c516`, so the bound is **in force on the
money host**, not merely merged.

Confirmed by outcome rather than by reading the constant —
`GET /api/health/reversal-shadow-signals` on this boot:

```
compaction: { ranAt: 2026-09-25T03:02:44.875Z, cutoff: 2026-08-26T03:02:44.875Z,
              linesBefore: 238880, linesAfter: 238880, recordsDropped: 0,
              bytesBefore: 52938297, bytesAfter: 52938297, rewrote: false }
```

`recordsDropped: 0` on **this** boot is not evidence of an inert cap: the file's oldest surviving
row is `ts 1787724900000` = 2026-08-26T06:15Z, **3h 12m after the cutoff**, which is the signature
of a compaction that already bound on an earlier boot and left the window flush. 50.5 MiB is
therefore the 30-day steady state, which lands inside the 45–50 MiB band the TRA-4883 comment
predicted. Worst case with the boot-gap premium: **58.8 MiB**.

The CFO's "no cap found" was correct **as of the 01:56Z measurement** — the fix had landed in git
4h earlier but had not deployed. Nothing to do here beyond recording it.

---

## AC4 — boot-only compaction: **only `cost-aware-gate` needs a periodic one**

All four of the large time-capped tapes compact on boot only, so each carries up to one boot
interval of rows that have aged past retention and not been dropped. The premium is
`bootGap / retain`, and it is **not** ranked by file size — which is why the filing's five-file
list does not sort it:

| tape | retention | rate | boot-only premium | worst case |
|---|---|---|---|---|
| `cost-aware-gate.jsonl` | **7 d** | **9.98 MiB/d** | **+70.4%** | **119.1 MiB** |
| `live-enforce-gate.jsonl` | 30 d | 2.07 MiB/d | +16.4% | 72.3 MiB |
| `reversal-shadow-signals.jsonl` | 30 d | 1.68 MiB/d | +16.4% | 58.8 MiB |
| `churn-brake-guard.jsonl` | 30 d | 1.27 MiB/d | +16.4% | 44.4 MiB |

**`cost-aware-gate` is the only one that needs periodic compaction, and it is uniquely exposed
because it pairs the highest write rate on the box with the *shortest* retention.** Its worst case
is 45.9 MiB above its steady state — on its own, most of one close-ledger budget. The other three
sit on 30-day horizons that bqb1's boot cadence is nowhere near: over the last 30 days the longest
gap between process boots was 4.93 days, across 100 deploys, and watchdog restarts make the true
figure smaller still.

**The aggregate, which is the number that decides whether this is urgent.** During a long uptime
`/data` grows at the sum of the append rates of everything that compacts on boot — **15.35 MiB/day**
across the 16 time-capped tapes, plus **4.38 MiB/day** for `otm-admission-tape` (whose *byte* cap
is boot-only too, so it also overshoots), = **19.73 MiB/day**. Headroom to the 10% `minFreePct`
threshold is `364.7 − 97.3` = **267.4 MiB** ⇒ **~13.5 days of continuous uptime before the disk
threshold trips**, against a 4.93-day observed maximum. That is a **2.7× margin**, so this is a
hardening item and not an incident — which matches the filing's own framing. The 27 uncapped files
grow through a reboot as well and are *not* in that 19.73; they are small today, and nothing
measures when they stop being.

⚠️ The margin is a function of the *boot cadence*, and the boot cadence is short because the box is
unstable (TRA-4158 watchdog restarts, TRA-4820 unattributed env-write deploys). **Fixing the
instability shortens this margin.** A stable box that stays up three weeks trips the disk threshold
on exactly this path, with no code change anywhere. The periodic compaction on `cost-aware-gate` is
the cheap way to stop that coupling.

### AC4 resolution — TRA-4904, shipped 2026-09-25

`cost-aware-gate-ledger.ts` now re-applies its 7-day cutoff **every 6 hours** as well as at boot
(`COST_AWARE_GATE_COMPACTION_INTERVAL_MS`, armed in `index.ts` beside the other unref'd timers). The
premium is `interval / retain`, so 6 h caps it at **+3.6%** against the AC1 bar of 16.4%, and the
census row falls accordingly:

```
node scripts/tra4899-tape-census.mjs        # 2026-09-25T04:4xZ, host build 66a8a1ab40cc
  72.3  DERIVED  7 d +6h timer   69.9  cost-aware-gate.jsonl     ← was 119.1 boot-only
```

⚠️ **That 72.3 MiB is a projection, not yet a measurement.** The observed 69.9 MiB was read off a
host still running the pre-fix build; what changed in this run is the census's own multiplier
(`(7 + 0.25)/7` instead of `(7 + 4.93)/7`), which is only true of the box once the build is live. The
manifest row carries `bootOnly: false` + `compactEveryDays: 0.25` and its needle now asserts **both**
constants, so the row cannot claim a cadence the source does not hold.

The compaction **outcome** is published at `/api/health/cost-aware-gate` → `compaction`
(`trigger`, `ranAt`, `cutoff`, `linesBefore/After`, `linesDropped`, `bytesBefore/After`, `rewrote`,
`bufferedAppendsFlushed`) — `reversalShadowCompaction`'s shape plus the field that answers the
question that shape cannot: **`hookState`**. A build where the interval was never armed publishes a
perfectly ordinary `trigger: 'boot'` outcome forever, and nothing else on the payload separates it
from a working hook.

⚠️ **Read `hookState`, not `timerCompactions`.** A fire count cannot carry this on bqb1, because the
box is usually up for *less* than one 6h interval (1416 s at the 04:36Z read), so **zero fires is the
ordinary healthy reading** — and in that case the overshoot is bounded by the boot gap instead, which
is tighter than the timer. The enum is derived off the arm instant
(`noteCostAwareGateCompactionTimerArmed`, called in `index.ts` right after the `setInterval`):

| `hookState` | meaning |
|---|---|
| `timer_not_armed` | **the alarm** — nothing scheduled a fire. The pre-TRA-4904 state. |
| `armed_not_yet_due` | armed, 0 fires, inside the first interval. Not a reading either way. |
| `firing` | ≥1 fire, next not overdue. The working state. |
| `overdue` | armed and past due with no fire — the interval died, or the loop is wedged. |

**Do the other three need the same timer? Still no — and here is the arithmetic that would change
the answer.** The trio's pooled append rate is `2.07 + 1.68 + 1.27` = **5.02 MiB/day**, so at the
observed 4.93-day maximum boot gap their *combined* overshoot is **24.7 MiB — 9.3% of the 267.4 MiB
headroom**, against the 45.9 MiB `cost-aware-gate` cost on its own.

What this fix actually buys, and what it leaves:

- `cost-aware-gate` is already **at** its 7-day steady state (69.9 MiB ÷ 9.98 = 7.00 d), so the timer
  holds it flat rather than merely slowing it. Residual `/data` growth during a long uptime is
  `19.73 − 9.98` = **9.75 MiB/day** ⇒ **~27.4 days** of continuous uptime before `minFreePct`, up
  from ~13.5. That is **5.6× the observed maximum boot gap**, against 2.7× before.
- The residual is now almost entirely four files: `otm-admission-tape` **4.38 MiB/day** (45% of it —
  its *byte* cap is boot-only too) plus the trio's 5.02. The other twelve time-capped tapes together
  are ~0.35 MiB/day.
- The trio's pooled overshoot reaches the 45.9 MiB that justified this ticket at an uptime of
  `45.9 / 5.02` = **9.1 days**.

So the trigger is an uptime, not a size: **put the trio and `otm-admission-tape` on the same hook
when a sustained uptime above ~9 days becomes plausible** — i.e. when the measured max boot gap
crosses 9 d, or when TRA-4158/TRA-4820 are closed and a multi-week soak is actually being asked for,
or if headroom ever falls below ~150 MiB. Two notes for whoever picks that up: it should be **one
shared periodic-compaction hook**, not four bespoke timers, and `otm-admission-tape` is the single
largest lever in the residual despite being the tape this parent ticket already re-scoped.

#### Verified live 2026-10-02T03:1xZ — and the AC4 "no, not today" has since expired

The build is live: bqb1 serves `6690770689b5` (boot 02:13:38Z), which carries `969f1beb` as an
ancestor. `/api/health/cost-aware-gate` → `compaction` reads:

```
hookState        armed_not_yet_due     timerArmedAt  2026-10-02T02:13:56.829Z
intervalMs       21600000              nextFireDueAt 2026-10-02T08:13:56.829Z
last.trigger     boot                  last.ranAt    2026-10-02T02:13:45.526Z
last.cutoff      2026-09-25T02:13:45Z  linesDropped  0   rewrote false
last.linesBefore 376622                bytesBefore   84332698
```

**The arm is the live reading, not the fire count.** `timer_not_armed` — the pre-fix state — is
excluded by `timerArmedAt` being stamped, which is the whole reason `hookState` exists: at a 2,923 s
uptime a healthy hook has 0 fires and `timerCompactions` cannot tell that from a dead one. The boot
outcome publishes, so AC2's "a `RETAIN_MS` with no working hook reads identically" hole is closed on
the real host. `linesDropped: 0` is itself the AC1 result: nothing on disk had aged past the cutoff.

**AC3, re-run against the live build — the premium claim verifies exactly; the *level* did not.**

```
node scripts/tra4899-tape-census.mjs        # 2026-10-02T03:1xZ, host build 6690770689b5
  144.0  HARD     144.0 MiB            56.1   otm-admission-tape.jsonl
  110.2  DERIVED  30 d (boot-only)     94.7   live-enforce-gate.jsonl     ← was 72.3 / 62.1
   83.3  DERIVED  7 d +6h timer        80.4   cost-aware-gate.jsonl       ← was 119.1 boot-only
   78.8  DERIVED  30 d (boot-only)     67.7   churn-brake-guard.jsonl     ← was 44.4 / 38.1
   51.6  DERIVED  30 d (boot-only)     44.3   reversal-shadow-signals.jsonl
volume: 973.4 MiB total, 239.0 MiB free (24.554%)
```

119.1 → **83.3 MiB**, not the 72.3 MiB projected, and the gap is **not** a shortfall in the fix.
Separate the two factors or a rate regression hides behind a cap fix:

- **The premium is exactly as specified.** `83.3 / 80.4` = +3.6%, the `interval/retain` figure. Had
  the tape stayed boot-only it would today read `80.4 × 1.704` = **137.0 MiB**, so the fix removes
  **53.7 MiB** of overshoot at today's size — *more* than the 45.9 MiB that justified the ticket.
- **The level rose because the write rate did.** The tape is at steady state (`retained.etDays`
  spans 09-25→10-01; `linesDropped: 0`), so its rate is `80.4 / 7` = **11.49 MiB/day**, 15% above
  the 9.98 measured on 09-25. The cadence bounds the overshoot; it cannot bound the rate.

⚠️ **The trio measurement that produced "still no" is stale, and two of the three named triggers
have tripped.** Over the 6.94 days since, `live-enforce-gate` grew **+32.6 MiB** (62.1 → 94.7) and
`churn-brake-guard` **+29.6 MiB** (38.1 → 67.7); `reversal-shadow-signals` *fell* 6.2 MiB, which is
what a tape at its 30-day steady state looks like. Both readings of the trio's pooled rate are above
the 5.02 MiB/day the "no" rested on, and the discriminator between them is unmeasured — neither tape
has a health route publishing a retained day span, so whether they are still filling toward 30 days
cannot be settled from here:

| keying | live-enf | churn | reversal | pooled | overshoot @4.93 d gap | uptime to 45.9 MiB |
|---|---|---|---|---|---|---|
| at steady state (`size/30`) | 3.16 | 2.26 | 1.48 | **6.90** | 34.0 MiB | **6.7 d** |
| still filling (6.94 d growth) | 4.70 | 4.27 | 1.48 | **10.45** | **51.5 MiB** | **4.4 d** |

Under the upper keying the trio *already* costs the 45.9 MiB that justified this ticket at the
observed boot gap, and the 9.1-day threshold has moved **inside** it. And headroom to the 10%
`minFreePct` is now `239.0 − 97.3` = **141.7 MiB**, below the **~150 MiB** trigger written above.
**So the answer to AC4 flips from "no, at ~9 days of uptime" to "yes, now"** — on a measured size
trigger rather than the hypothesised uptime one, which is the opposite of how this section expected
to be falsified. It does not change what gets built: still **one shared periodic hook** over
`live-enforce-gate`, `churn-brake-guard`, `reversal-shadow-signals` and `otm-admission-tape`, whose
first job is to measure which keying above is true. Successor: **TRA-5038**.

#### TRA-5038 — the shared hook, built 2026-10-02 (code landed; live readings pending deploy)

`packages/server/src/shared-tape-compaction.ts` is **one** registry and **one** `setInterval`, armed
once in `index.ts`, covering all four tapes. Each owner contributes only its path and its
**predicate**, and the predicates genuinely differ — which is why the hook takes one per tape rather
than assuming a cutoff:

| tape | predicate | bound | cadence premium |
|---|---|---|---|
| `live-enforce-gate.jsonl` | `age` | 30 d | 6 h / 30 d = **+0.83%** |
| `churn-brake-guard.jsonl` | `age` | 30 d | **+0.83%** |
| `reversal-shadow-signals.jsonl` | `age` | 30 d | **+0.83%** |
| `otm-admission-tape.jsonl` | `bytes_whole_day` | 144 MiB | n/a — a byte cap has no retention to overshoot |

All four are well inside AC2's ceiling (`cost-aware-gate`'s +3.6%), and one cadence nobody has to
re-check beats four tuned ones.

**`otm-admission-tape` needed a third predicate kind, not the obvious `bytes` one.** Its prune must
land on an **ET-day boundary**: its consumers divide by *sessions*, so a partial day biases its own
within-day sample toward the afternoon, and a biased day is worse than an absent one — the reason
`hydrateOtmAdmissionTapeFromDisk` has always pruned whole days. A plain byte-prefix cut would have
silently changed that. The periodic pass deliberately does **not** reuse the hydrate's prune, which
`JSON.parse`s every line and rebuilds the fold: affordable once at boot, and exactly what AC4 forbids
four times a day at ~189k rows.

**Two properties carried over from TRA-4904, per tape:**

- **Does not parse what it keeps** — applies to all four. The walk reads `ts` (and `etDay` for
  `otm-admission-tape`) off the first 96 bytes of each line with a regex, and only over the prefix it
  is about to **delete**; the retained bytes are echoed verbatim and never deserialized, so no field
  can be erased by the rewrite (TRA-1703) and the pass stays clear of the TRA-2111 tripwire.
- **Buffered-and-flushed live appends** — applies to all four, and the flush happens **even on a
  failed rewrite** (an erased row reads identically to a row never written, TRA-1681). Each owner's
  append path checks the interlock *synchronously* and routes its flush back through its own raw
  append, so `durability.appendErrors` stays the authority on what reached disk.
  `reversal-shadow-ledger.ts` is the one whose append is `async`; the check is still sync and runs
  before any `await`, so it cannot observe a stale `false` and then land inside the window.

**One deliberate departure from the prototype: the rewrite is streamed, not a whole-file string.**
`compactCostAwareGateLedgerNow` does `readFile(path, 'utf8')` and holds the tape as one string, which
was affordable for one 80 MiB file. These four are 263 MiB on disk, and a JS string is UTF-16 — a
94 MiB ASCII tape is ~188 MiB of heap. Four of those per pass, four times a day, on the box TRA-4158
just cut 330 MB of RSS out of, would be a **memory** incident shipped to fix a **disk** problem. The
scan is chunked and the rewrite is `createReadStream(start) → tmp → rename`, so memory is O(chunk).

⚠️ **Consequence, deliberate:** the shared payload publishes no `linesBefore` / `linesAfter`. Neither
can be computed without reading every retained byte, which is the cost just removed. `linesDropped`
and `bytesDropped` are exact (the dropped prefix is walked) and `bytesBefore/After` come off `stat`.
**Do not "complete" the payload by adding a full-file line count back.**

**AC3 surface.** Each of the four publishes `sharedCompaction` carrying the same four-state
arm-derived enum as `/api/health/cost-aware-gate`. The key is `sharedCompaction`, not `compaction`,
on all four deliberately: `reversal-shadow-signals` already publishes `compaction` for its **boot**
outcome, and one consistent name across the four beats a collision on one of them. The exact paths —
the depth differs because one route nests its whole durable fold:

| route | JSON path |
|---|---|
| `/api/health/live-enforce-gates` | `sharedCompaction` |
| `/api/health/churn-brake` | `retained.sharedCompaction` |
| `/api/health/reversal-shadow-signals` | `sharedCompaction` |
| `/api/health/otm-admission-tape` | `sharedCompaction` |

⚠️ **Being armed and being ON THE WIRE are two different things**, and this bit nearly shipped
wrong. `/api/health/live-enforce-gates` **hand-picks** fields off its summary rather than spreading
it, so the field added to `LiveEnforceSummary` typechecked, tested green, and would not have reached
a single reader. The census now asserts the publication literal in the file that actually serves it
(`publish` on each manifest row) as a third seam beside the predicate and the arm — verified by
control: blanking that literal exits **BLIND (3)** naming the route.

**AC1 is answered by `sharedCompaction.span`, and it is measured at boot, not only on a fire.** A
span published only inside a timer outcome would be unreadable on bqb1, whose uptime is routinely
under one interval — so `index.ts` runs a measure-only pass (no rewrite) right after arming, once
each owner's own boot compaction has already run. `span.fill` reads `at_steady_state` when the pass
dropped rows or the oldest row sits within one day of the cutoff (one day, because these tapes only
write on sessions, so a weekend leaves a legitimate hole at the head), `still_filling` when the
content begins well inside the cutoff, and `unknown` when it cannot be read — never guessed. When it
reads `still_filling`, `size / retentionDays` **understates** the rate and `span.observedBytesPerDay`
(`size / spanDays`) is the honest figure.

**The census row cannot claim a timer that is not wired.** Each of the four manifest rows carries
`bootOnly: false` + `compactEveryDays: 0.25`, and the needle check now asserts three further seams:
the owner's own `predicate:` literal, `SHARED_TAPE_COMPACTION_INTERVAL_MS = 6 * …` in the shared
module, and that `index.ts` still references that tape's spec factory, `registerSharedTape(` and
`noteSharedTapeCompactionArmed()`, plus the per-tape **publication** literal above. A reverted
registration leaves every other field on the health route reading healthy, so it exits
**BLIND (3)** at desk time instead of at `minFreePct`. All three directions were run as controls: a
row claiming a 12 h cadence, a spec factory `index.ts` never references, and a blanked publication
literal each exit 3 naming the row.

⛔ **Still open at the time of writing — these are measurements, not code:**

1. **AC1's live answer.** The keying (steady state vs still filling) for `live-enforce-gate` and
   `churn-brake-guard` is settled by reading `sharedCompaction.span` off the deployed build. Until
   then the ranking in this document is provisional, exactly as the ticket says. What is already
   visible from the *existing* routes is suggestive but not conclusive: `live-enforce-gate`'s
   `retained.etDays` starts **2026-09-02** against a 09-02T12:51Z cutoff (consistent with steady
   state) while `churn-brake-guard`'s starts **2026-09-04**, two days inside its cutoff (consistent
   with still filling) — but an ET-day bucket cannot settle it, because a 09-02 row written before
   08:51 ET would have been dropped by that same cutoff. That is precisely why AC1 asks for the
   oldest retained `ts` and not a day list.
2. **AC3b — the prototype's timer has still never been observed firing.** Read at
   2026-10-02T14:50Z: build `104bc8ed322c`, uptime **7133 s (1.98 h)**, `hookState`
   `armed_not_yet_due`, `nextFireDueAt` **18:52:07Z**. Under 6 h, so the read AC3b asks for is not
   yet available on this host. It must be taken **before** the next deploy, because a deploy resets
   uptime and the window closes for another 6 h.
3. **AC5's live re-run** of the census (`/data` growth rate and days-to-`minFreePct`) is only
   meaningful against the deployed build; the offline run is CLEAN and the four rows now read
   `30 d +6h timer` / `144 MiB +6h timer`.

---

## AC5 — the inode budget: the file-count leg does **not** become binding

65,536 inodes on 973.4 MiB is one inode per 15.57 KB *on average*. The number that actually decides
which resource runs out first is the **marginal** one, off current headroom:

```
267.4 MiB usable before the 10% threshold / 39,147 free inodes = 7,162 B
```

**Any subsystem whose mean file is under ~7.16 KB exhausts inodes before bytes.** (The filing's
15.6 KB is the whole-volume average; the marginal figure is the binding one, and it is less than
half as forgiving.)

| population | files | mean file | verdict |
|---|---|---|---|
| `backups/` | 6,756 | **6.40 KiB** | **inode-bound** |
| `users/**/reports/<date>.json` | 9,929 | 7.89 KiB | byte-bound, but only just |
| `users/**/reports/closes/` | 666 | 33.0 KiB | firmly byte-bound |
| `users/**/reports/tape/` | 234 | 69.6 KiB | firmly byte-bound |

**The one inode-bound subsystem is the one that already has an inode-denominated cap.** `backups/`
is bounded by `BACKUP_MAX_FILES = 8,000` inodes *and* ≤24 generations (TRA-2817), and it is the
**only cap on the entire box denominated in inodes** — every other one is bytes, days or rows. It
sits at 6,756 of its 8,000, i.e. 20.4% of the inode table at cap.

**The specific question — does the per-bucket 250-file leg become binding?** No, by a wide margin
and in both directions:

| dir | byte cap | mean file | files the byte cap allows | files the 250-leg allows | binding leg |
|---|---|---|---|---|---|
| `closes/` | 48 MiB | 33,842 B | **1,487** | 68 buckets × 250 = 17,000 | **bytes, by 11.4×** |
| `tape/` | 16 MiB | 71,290 B | **235** | 69 buckets × 250 = 17,250 | **bytes, by 73×** |

Observed max files in any single bucket: **10** (`closes/`) and **4** (`tape/`) — 4% and 1.6% of the
250 leg. The whole ledger pool at its byte cap is ~1,722 inodes, **4.4% of free inodes**. And
`tape/` is already at **99.43% of its 16 MiB** (16,681,746 / 16,777,216) with 234 files, which is
the direct measurement that the byte leg is the one doing the work.

**The AC2 change is inode-neutral**: `otm-admission-tape.jsonl` is one file, at any cap.

The residual inode story is *outside* this census: `users/**/reports/<date>.json` holds **9,929
inodes — 25.4% of free inodes and the single largest population on the box** — and is governed by
neither of the two caps TRA-4156 set. It is byte-bound today at 7.89 KiB mean, but by only **10%**
(8,079 B against the 7,162 B break-even), and that margin falls as the book count grows. That
belongs with TRA-4898's book-reap work, not here.

---

## Reproducing this

```bash
TRADING_ADMIN_PASSWORD=… node scripts/tra4899-tape-census.mjs
#   0 CLEAN · 1 UNCATALOGUED · 2 usage · 3 BLIND · 4 UNBOUNDED
node scripts/tra4899-tape-census.mjs --offline   # policy table, no host
node scripts/tra4899-tape-census.mjs --json
```

> **TRA-4903 (2026-09-25) — the 27 uncapped tapes this document ranked are now bounded.**
> They print as `SEALED` with a byte ceiling enforced on the write path, **248 MiB across all 27**,
> and the census exits **UNBOUNDED (4)** if a new one ever appears. The bound is bytes rather than
> time on all 27, because a central time prune corrupts these specific tapes four measured ways —
> most sharply, it splits a supersede pair in a way that **biases the survivors toward fast
> resolutions**. A seal also carries **no boot-overshoot premium**, unlike every cap in the AC4 table
> below. See `docs/tra4903-tape-bounds.md`.

Two guards, both of which have fired during development and are the reason the table can be
trusted:

- **manifest-vs-source** — every capped row names the source literal its cap lives on; if that
  literal is gone, the run exits **BLIND (3)** naming the row rather than printing a stale number.
  (It caught `rv-scan-census-ledger.ts` using `CENSUS_RETAIN_MS`, not `RETAIN_MS`, on first run.)
- **host-vs-manifest** — any root entry on the live host that nobody catalogued exits
  **UNCATALOGUED (1)**. This is the direction that produced the defect this ticket exists to fix:
  a table of five files read as a complete ranking.
