# TRA-4903 — bounding the 27 uncapped `/data` tapes

Residual of TRA-4899. Measured on bqb1 `2026-09-25T03:5xZ`, build `a158c516`, off
`/api/health/storage/detail`. Seam: `packages/server/src/data-tape-bounds.ts`.

---

## AC1 — every `?` row resolved: all 25 are confirmed UNCAPPED, none turned out capped

The filing flagged 2 confirmed and 25 `?` (cap absence grepped, write path not walked). All 25 are
now confirmed uncapped, so the AC1 clause about "the capped ones given a `needle`" is **vacuous —
there were none**. That is worth stating rather than leaving implied: the grep was not producing
false positives, it was producing an incomplete confirmation.

The confirmation is stronger than re-grepping the writer, which is the weakness the filing flagged
on itself ("I read the writer, not every call site"). Two passes:

1. **Per-module** — each writer profiled for `appendFile*` vs `writeFile*` / `truncate` / `unlink`.
   24 of 25 have **zero** rewrite calls of any kind; the one that has them
   (`live-options-fee-slippage-ledger.ts`) rewrites its own 30-day-capped file and never the two
   uncapped ones it also owns.
2. **Repo-wide, per filename** — every `'<tape>.jsonl'` literal grepped across `packages/`, `apps/`
   and `scripts/`, and each foreign referrer checked for a rewrite of that path. Four modules
   reference a tape they do not own (`eod-row-backfill`, `orphaned-books`, `pnl-reconciliation`,
   `maker-ladder-recommendation`, `live-lot-adoption`, `source-quality-scorer`); **none** writes to
   one. `orphaned-books.ts:45` says so in a comment — "shared, append-only and outside the per-user
   tree entirely, so no file move touches it".

So the census manifest's `confirmed: false` flags are gone, and with them the `unit: 'none'` rows.

---

## AC2 — the bound, and why it is bytes rather than time on all 27

AC2 prefers **time** where a consumer reasons in calendar time, citing
`reversal-shadow-ledger.ts:56-77` as the template. Walking the 27 write paths turned up **four ways
a time prune applied from a central manifest silently corrupts these specific tapes.** Each is
measured in this repo, and each is a *silent* defect — which is what rules the policy:

| # | hazard | where it is visible | who it hits |
|---|---|---|---|
| 1 | **Splits a supersede pair, with a direction** | `shadow-signal-ledger.ts:21,105` — folded by `id`; the superseding `ResolveLine` is `{kind:'resolve',id,res,resolvedAt}` and carries **no `ts`** | 9 tapes |
| 2 | **Makes a ratified bar unreachable** | `pcr-shadow-ledger.ts:49,309` — 20-session z-window + `PCR_PROMOTION_MIN_Z_SESSIONS=20`, and TRA-1664 ratifies N≥90 **sessions** ≈ 126 calendar days | `pcr`, `pcs`, `oi`, `option-shadow` |
| 3 | **Drops pending work** | `hypothesis-pipeline.ts:392-399` — a log-structured queue where "a decision with no enqueue is ignored"; an item may sit `queued` indefinitely | `hypothesis-queue` |
| 4 | **Rewrites a money total** | `paper-trading.ts:283` `foldRowIntoBook` — rows are increments of a cumulative balance, not independent observations | `paper-trading` |

Hazard 1 is the one that would have been hardest to notice: **slow resolutions are the ones whose
OPEN row is oldest, so a line-wise cutoff biases the survivors toward FAST resolutions** — it skews
the outcome distribution the learner exists to read, in the direction that flatters it. The AC2
template avoids it only because it was written to: `reversal-shadow-ledger.ts:211` keys the cutoff
on the signal time "never on `resolvedAt`", and `:239` keeps a resolve line "iff its open was".
That is per-tape knowledge of the id field and the line kinds, and **a central manifest does not
have it.**

Hazard 2 is not hypothetical either — it is the TRA-4607 defect recorded at
`live-options-fee-slippage-ledger.ts:62-77`, where every boot shrank the store, `fillsSeen` fell
41 → 31, and a close read `noMatchingOpen`: "an exclusion **MANUFACTURED BY RETENTION**".

A byte ceiling has none of these properties, because it needs to know nothing about record shape,
id folds, line kinds, or a consumer's lookback. So:

- **The 27-wide bound is byte-denominated.**
- **Per-tape time retention stays a per-tape exercise** against that tape's own consumer — the shape
  TRA-4883 used on `reversal-shadow-signals.jsonl`. Filed as the residual, one tape at a time.

### `seal`, not `truncate`

At the ceiling the append is **REFUSED** and a breach is logged loudly. No row is ever dropped.

Every other `/data` compactor on this box truncates the oldest rows, which is right for a
measurement tape and wrong for an evidence tape — and **nothing in the repo drew that line before,
which is plausibly how 27 files ended up with no bound at all rather than the wrong one.** On these
27 the past rows are largely non-re-derivable:

- `tra3939-order-provenance-capture.ts:151` — retention "none … evidence that expires at the source
  (the broker serves ONE trading day of orders)"
- `tra3932-open-leg-provenance.ts:113` — "none — verdicts are not re-derivable"
- `option-trade-journal` — the pre-onset history a money gate keys on
  (`pnl-reconciliation.ts:256`: "DURABLE history and does not age out")

Losing a **future** row to a loud refusal is recoverable. Losing a **past** verdict to a silent
prune is not.

One call site needed the refusal threaded through explicitly.
`live-options-fee-slippage-ledger.ts:2054` archives aged fills **before** compacting them out of the
main file, and skips the compaction if the archive append fails — its stated invariant is that the
worst case leaves a row "in both places, never in neither". A refusal returns `false` rather than
throwing, so without handling it the compaction would have proceeded and **deleted aged fills that
never reached the archive.** It now sets `archiveOk = false`, keeps the rows, and retries next boot.

### The ceilings

`DATA_TAPE_BOUNDS` in `data-tape-bounds.ts`. A seal's failure mode is "the tape stops recording", so
a ceiling a healthy tape already sits near is worse than no ceiling — every one is set well clear of
the measured size, and a test asserts **nothing exceeds 50% of its ceiling**.

| band | tapes | reserved |
|---|---|---|
| 32 MiB | `shadow-signals`, `paper-trading`, `option-trade-journal` | 96 MiB |
| 16 MiB | `pcr-shadow-signals` (sized 2× its band — the one tape where the *ceiling* could itself manufacture the TRA-4607 exclusion) | 16 MiB |
| 8 MiB | 11 tapes: `option-maker-shadow`, `news-catalyst-{runs,signals}`, `tra3939-engine-submitted-orders`, `tra4476-order-intents`, `option-shadow-signals`, `live-options-fill-archive`, `pcs-shadow-signals`, `oi-shadow-signals`, `pre-trade-{gate,liquidity}-decisions` | 88 MiB |
| 4 MiB | 12 tapes | 48 MiB |
| | **27** | **248 MiB** |

**248 MiB reserved against 17.87 MiB actual — 7.2% subscribed, 25.5% of the 973.4 MiB volume.**

Stated plainly because it is the honest objection: 248 MiB is *above* `otm-admission-tape`'s
144 MiB and *above* the 64 MiB the whole 68-book close ledger shares. A ceiling is not free. The
comparison that matters is against the class it leaves — 27 files each bounded by the volume and
nothing else.

### The reservation was never proportional to today's size

**10 of the 27 do not exist on the money host at all** (`option-maker-fills`, `oi-shadow-signals`,
`pcr-shadow-signals`, `pcs-shadow-signals`, `orb-options-shadow-signals`, `option-real-fill-shadow`,
`pre-trade-gate-decisions`, `pre-trade-liquidity-decisions`, `live-canary-state`,
`hypothesis-queue`) — their flag is off. Each still reserved the full 973 MiB the instant it flipped
on, which is why the census ranks by worst case and why those ten are sized off the record's **role**
rather than off "0 bytes today". `pre-trade-gate-decisions` writes one row per gate decision: the
highest potential rate of the 27, and invisible in every size-ranked table.

---

## AC3 — the census

```bash
TRADING_ADMIN_PASSWORD=… node scripts/tra4899-tape-census.mjs
#   0 CLEAN · 1 UNCATALOGUED · 2 usage · 3 BLIND · 4 UNBOUNDED
```

**Zero UNBOUNDED rows, exit 0, 0 uncatalogued**, run live against bqb1. The 27 now print as
`SEALED`. Three guards, each exercised as a positive control rather than merely present:

| guard | injection | result |
|---|---|---|
| **manifest-vs-source** | changed one ceiling `4 * MiB` → `5 * MiB` without touching the census | **BLIND (3)**, naming `hypothesis-queue.jsonl` |
| **writer-is-wired** (new) | reverted `hypothesis-pipeline.ts` to a raw `appendFile` | **BLIND (3)**, both arms: "does not call appendBoundedTapeLine" **and** "still has a RAW appendFile call" |
| **UNBOUNDED gate** (new) | — | exit **4**, ranked above UNCATALOGUED: an unbounded file is a live reservation, an uncatalogued one is a gap in the table |

The writer-is-wired guard exists because a ceiling whose call site was reverted reads **identically**
to one that works. The first attempt at that control used `sed` and silently failed to inject — the
run exited 0 and looked like a pass. A positive control that fails to inject is vacuous; it was
re-run with a real injection before being believed.

The same reasoning puts the enforcement **outcome** on `/api/health/storage/detail` as
`tapeBounds`, not just the constants: `bytes`, `fillPct`, `breached`, `refusedAppends` per tape.
`bytes: null` means "not touched this boot" and is **not** the same as `0` — conflating them is how
an unwired layer comes to read like a layer that ran and found nothing (TRA-3514). The block is
**admin-gated** and deliberately not projected onto the open liveness route: it names files with
their sizes, the material TRA-2414 found leaking.

---

## AC4 — boot overshoot: **there is none, and that is the one place this beats the pattern it copies**

AC4 asks for `rate × maxBootInterval` alongside each cap, because every existing implementation
compacts **on boot only** — `tra4899-data-tape-budget.md` AC4 measures the boot interval at
**4.93 d** and `otm-admission-tape`'s true reservation at `151.0 + ~22` MB against a 144 MiB cap.

**A seal has no such premium.** It is enforced at every append, not at boot, so:

```
reservation = ceiling                    (exact)
            ≠ ceiling + rate × 4.93 d    (what a boot-only cap reserves)
```

`SEALED` is the only `KIND` in the census that is exact. This is a direct consequence of refusing
rather than truncating: **a refusal is an O(1) check on the write path; truncate-oldest is not**, so
the boot-only compromise every other tape makes does not arise here.

The boot pass (`seedDataTapeBounds`) changes no file — a seal never rewrites. It seeds the size cache
so `/api/health/storage/detail` can answer "is this wired in at all?" on a quiet box before any tape
has been appended to.

Size is then maintained in-process (`seeded + written`) rather than `stat`ed per append. These stores
are module-global singletons — one writer per process — so that is exact for the owning process, and
the alternative is a syscall on every row of a tape that can take one row per gate decision. If
something outside the process ever appended, the in-process count would be a **floor**, so the
ceiling would be enforced *late* rather than not at all: the safe direction.

---

## Residual

Per-tape **time** retention, one ticket per tape, against that tape's own consumer and its own fold
— the four hazards above are exactly the per-tape questions each of those tickets has to answer, and
none of them can be answered from a manifest. The byte ceilings stand as the backstop underneath,
so a tape that never gets its retention ticket is still bounded.
