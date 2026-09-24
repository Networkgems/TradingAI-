# TRA-4875 — the `inputStale` flag nothing consumed

`arm.costBar.edge.freshness.inputStale` (TRA-4783) has read `true` since roughly 2026-08-18. Nothing
read it. The gate went on enforcing live refusals off expectancy constants derived from a tape that
stopped advancing in early August, with `ok: true` on the same route and no annotation on any
decision. It was found by hand off a postmarket review five weeks later.

⛔ **This ticket RAISES; it does not ADMIT.** A stale estimator must keep refusing. AC3 is the guard:
zero candidates move from blocked to admitted.

## AC3 — the BEFORE read

`GET https://tradingai-bqb1.onrender.com/api/health/live-enforce-gates`
read **2026-09-24T20:42:40Z**, pin **`26ec52a483e8be00f5d09cd66ab25db3106d4e98`**, pid 77,
`startedAt` 2026-09-24T20:12:21.444Z, `durability: { dataDir: "/data", ephemeral: false }` —
so the retained fold is hydrated from disk and SURVIVES the redeploy. The before/after comparison
below is over the same recorded rows, not two different populations.

**The entry-site population is the two cells the armed strike selector can nominate**
(`arm.admissibleStrike.band = [0.25, 0.40)`, armed) — `retained.byGate[cost_bar].byCell[]`:

| cell | evaluated | blocked | rate | `grossRProvenance.tapeAgeMsMaxAtDecision` |
|---|---|---|---|---|
| `single_leg_otm::0.20-0.30` | 5002 | 5002 | 1.0 | 4 514 959 027 ms = **52.3 d** |
| `single_leg_otm::0.30-0.40` | 6853 | 6853 | 1.0 | 4 416 187 742 ms = **51.1 d** |
| **total** | **11855** | **11855** | **1.0** | — |

That 11855/11855 is exactly the number TRA-4875's description reports, recovered independently from
the retained per-cell fold.

Wider context from the same read, so the after-read can be checked against more than one number:

- whole gate, retained 30-day fold: `evaluated 14633 / blocked 14205` (`blockRate 0.9708`). The
  admits are all in `single_leg_otm::0.50-0.55` (2055/1627), a cell **outside** the armed band —
  its bound is above the bar and its tape is the one still growing.
- since-boot (`byGate[cost_bar]`): `evaluated 3039 / blocked 3039`.
- per ET day, 09-11 through 09-24: 1322 / 810 / 805 / 640 / 931 / 466 / 1645 / 1562 / 933 / 3039 —
  **blocked == evaluated on every one of the ten**.

## Why the global flag was not enough (AC4)

`arm.costBar.edge.freshness` at the same instant:

```
inputStale: true            inputStaleThresholdDays: 10
inputTapeAgeDaysMax: 78.1   inputTapeToIsoOldest: 2026-07-08T18:13:15.968Z
inputCellsMeasured: 8       inputCellsUnmeasured: 0
```

78.1 d is driven by `0.40-0.45`, a cell the armed band `[0.25, 0.40)` **cannot nominate**. The two
cells that actually refused the entry site sit at 52.3 d and 51.1 d. So the single global boolean was
true **for the wrong reason**: a reader who checked which cell drove it would have cleared the
decision-relevant ones, and a reader who did not would have been right by accident. Hence the
per-cell requirement.

## What shipped

1. **AC1** — `byGate[cost_bar].byCell[].inputFreshness`: `stale` / `tapeAgeDaysAtDecisionMax` /
   `tapeAgeDaysAtLastDecision` / `tapeToIsoNewest` / `rowsStamped` / `rowsUnstamped` / `statement`,
   for **that cell's own constant**, measured **at the decision** (`decidedAt − tapeToTs` off the
   TRA-4753 stamp — not a re-read of today's estimator, which is constant across every day by
   construction and so can confirm nothing). It is the hoisted
   `grossRProvenance.inputFreshness` — the same object, folded once, never a second computation.
2. **AC2 — the surface chosen is the ROUTE-LEVEL `ok`,** plus a top-level `degradations[]` array
   carrying the code, severity, the offending cells with their ages, the affected decision count and
   a `detail` line. `ok` was a hard-coded literal `true`; it is now `degradations.length === 0`.
   ⚠️ This is **not** the container probe — Render health-checks `/api/health`
   (`render.yaml: healthCheckPath`), so a `false` here pages a reader and restarts nothing.
3. **AC4** — per cell, and the degradation is **scoped to cells that decided something**: the keys
   are the ledger's own `byCell` rows, so a cell nobody nominates cannot drive `ok`.
   `degradations[].globalInputStale` echoes the old global flag beside the per-cell set so the case
   where the two DISAGREE stays visible instead of being collapsed.

Three-valued on the TRA-4783 contract: `true` / `false` (a clean pass — stamped rows, all inside the
bar, and `rowsUnstamped === 0`) / `null` (NOT COMPUTABLE). `?? false` on it re-creates the
coerce-unknown-to-healthy bug one layer up.

## AC3 — the AFTER read

Recorded in the ticket comment against the rolled pin. Strictly additive telemetry: nothing on the
admission path reads `ok`, `degradations` or `inputFreshness`, and no gate, arm, bar or reason code
branches on any of them.
