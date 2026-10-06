# TRA-5135 — Impact analysis: retract-money vs retract-inert vs read-time exclusion (TRA-3849 non-session ledger rows)

Board-ruled impact-first (TRA-3849 leg 3, 2026-10-04, recorded under the TRA-5122 delegation).
Measured 2026-10-06T03:15Z against live bqb1 `/api/health/pnl-reconciliation` (4 engines / 313 day
rows / server axis 23 non-session rows, agreeing with `scripts/data/tra3849-nonsession-row-manifest.json`).
Author: LeadDev.

## The structural finding that reframes the dollar question

**No published total sums `eodCombined`.** The reconciliation view's `eodCombined` is read from the
per-date EOD *report file* (`users/<u>/reports/<mode>/<date>.json`), not from the snapshot row
(`pnl-reconciliation.ts:3841-3855`). Every published aggregate sums the snapshot legs
`dailyPnl + optionsDailyPnl`:

| Published surface | Source | Window | Market-day filter |
|---|---|---|---|
| Account state `weeklyPnl/monthlyPnl/yearlyPnl/allTimePnl` (`pnl-tracker.ts:1018-1105` → `signal-engine.ts:17108-17118`) | `dailyPnl + optionsDailyPnl` | rolling week/month/year/all-time | none |
| `peakEquity` (`pnl-tracker.ts:1027-1033`) | max `closingEquity` | all rows | none |
| Scheduled + on-demand period reports (`scheduled-report.ts:161-241`, driven at the 21:00 ET archive and `index.ts:~16640`) | `dailyPnl + optionsDailyPnl`, `trades`, equity cells, row counts | daily / Mon–Sun weekly / monthly / yearly | none |
| `GET /api/snapshots` (`index.ts:15939`) | raw rows | — | none |
| `/api/health/pnl-reconciliation` window sums | legs | diagnostic | none (calendar only *flags* rows) |

Of the 9 money-bearing in-census rows, **8 carry their money exclusively on `eodCombined` with both
snapshot legs flat** — i.e. the money sits in the non-session EOD report files, which no published
total reads. The single row with snapshot-leg money is `enock|demo 2026-05-03` (`dailyPnl = +19.49`).

## Deliverable 1 — which published totals change, by book and window, in dollars

Row-level pricing (live, all 23 in-census rows; tolerance $0.01):

| Book | Date | eodCombined (report cell) | stockDaily | optionsDaily | Class |
|---|---|---:|---:|---:|---|
| admin\|live | 2026-05-10 | +15.67 | 0 | 0 | money |
| admin\|live | 2026-05-31 | −23.12 | 0 | 0 | money |
| admin\|live | 2026-06-14 | −200.91 | 0 | 0 | money |
| admin\|live | 2026-08-09 | −63.54 | 0 | 0 | money |
| enock\|demo | 2026-05-03 | +8.95 | **+19.49** | 0 | money |
| enock\|demo | 2026-05-10 | +161.01 | 0 | 0 | money |
| enock\|demo | 2026-05-17 | +787.69 | 0 | 0 | money |
| enock\|demo | 2026-05-24 | +839.93 | 0 | 0 | money |
| enock\|demo | 2026-05-31 | +697.22 | 0 | 0 | money |
| (14 further rows: admin×6, Richard\|sandbox×4, enock×3, v0nni\|live×1) | various | 0.00 | 0 | 0 | inert |

### Retract-money (delete the 9 money-bearing snapshot rows)

Published P&L sums that change:

- `enock|demo`: **−$19.49** on all-time, 2026-yearly, May-2026 monthly (`totalPnl` and `stockPnl`),
  and ISO-week 2026-W18. The W18 weekly window contains *only* this row, so the W18 weekly report
  ceases to exist rather than re-totalling. `winDays` −1 in each containing window; May/2026
  `bestDay` re-derives if +19.49 held it.
- `admin|live`, `Richard|sandbox`, `v0nni|live`: **$0.00** on every published P&L sum, every window.
- Rolling account-state `weeklyPnl`/`monthlyPnl` today: $0.00 everywhere (all rows are May–Aug).

Non-sum cells that change: `tradingDays` −1 per money row per window; weekly `endEquity` where a
money Sunday is the window's last row — admin 2026-05-10 ($12,000 → $1,000), admin 2026-05-17
($1,000 → $12,686.44), enock 05-03/05-10/05-17/05-24/05-31 (deltas −$46.91 to +$2,019.49, the
05-03 one being series-first and so also a `startEquity` cell). These are equity-basis echoes of the
book's own erratic opening bases, not P&L. `peakEquity`: unchanged — **no book's peak closingEquity
sits on a non-session row** (admin peak 05-22, Richard 06-22, enock 07-27, v0nni 08-05).

Reconciliation/diagnostic view only (never a published sum): the `eodCombined` cells leave the
census — admin|live −$271.90 in total (May −$7.45, Jun −$200.91, Aug −$63.54), enock|demo
−$2,494.80 (all May). ⚠️ Note these dollars live in the EOD *report files*: deleting the snapshot
rows alone would drop them from the census while leaving the money sitting in
`reports/<mode>/<date>.json` invisible to `check:nonsession-rows` — a strictly worse state unless
the paired report files are dispositioned in the same breath.

### Retract-inert (delete the 14 inert snapshot rows)

**$0.00 on every published dollar total, every book, every window** (all 14 rows are $0.00 on every
axis within the $0.01 tolerance). Effects are counts and equity cells only: `tradingDays` −14 across
windows, weekly `endEquity` where an inert Sunday ends a window (admin 2026-05-24 −$293.27, enock
2026-06-07 −$93.56, Richard 2026-06-14 and admin 2026-05-03 series-first `startEquity` cells).
Retract-inert buys no dollar correction at all; it is pure deletion risk.

### The 60 departed rows (BOOK-ABSENT cohort)

They **survived on disk** — this is board-recorded fact, not inference: TRA-4902 (card `e9754ca6`,
executed 2026-10-01) deregistered the 64 QA books **delete-nothing**; the TRA-5132 census
(2026-10-04T23:46Z, admin-gated storage surfaces) measured 251 book dirs on disk vs 4 registered
accounts, orphan-tree writes frozen since 2026-10-01T01:00Z. TRA-5132 then ruled all ~247 orphan
trees **retired move-only** to `orphaned-books/<name>@<stamp>/` (TRA-5134, CTO, dry-run first,
deletion unauthorized).

Their current published-total impact is **$0.00 by construction**: `getAllUserContexts()` is
registry-driven (`user-context.ts:1080-1101`), the accounts are deregistered, so no account state,
no scheduled report and no snapshot endpoint can read those rows today. An orphan directory alone
never re-enters the census; the only re-entry path is the ruled TRA-4902 reversal (move back +
`adoptExistingBook: true`, an explicit admin action — normal name-recreation retires the old tree
first, `index.ts:9622,10044`). Exact dollar pricing of the 17 departed money-bearing rows requires
admin disk access and is **deferred to adoption time**: the sign-off below binds any adoption to a
per-book re-run of this analysis before the adopted book's totals are served.

## Deliverable 2 — does read-time exclusion produce the same corrected totals without a write?

**Yes — plainly.** Filtering `!isMarketDayIso(s.date)` at the reporting layer (`getCumulativeStats`,
`mergeByDate`/`aggregatePeriod`, `peakEquity`) produces, with **zero ledger writes**:

- dollar totals **identical** to retract-money on every published P&L sum (the inert rows contribute
  $0.00 to every dollar sum, so retract-money, retract-all, and read-time exclusion are
  dollar-indistinguishable);
- count/equity cells identical to retract-money **and** retract-inert combined — and arguably more
  correct than either alone (a Sunday is not a trading day, so excluding it from `tradingDays` is
  the right answer, not a side effect).

It also covers the departed cohort for free: if a book is ever adopted back, the same read-time
filter corrects its windows the moment it re-enumerates, with no per-book retraction ruling needed.
Per the ruling's own words ("a reporting defect must not be fixed by rewriting the ledger if the
reporting layer can be fixed instead" — TRA-3703 logic), this **moots the override question**:
TRA-2886/2888 stand untouched, `ENABLE_EOD_ROW_BACKFILL` stays false, no banked row is restated.

Limits, stated plainly: read-time exclusion cannot alter already-dispatched artifacts (a weekly
report email sent in May 2026 keeps its numbers) — but neither can a retraction; and it leaves the
rows in the census, so `check:nonsession-rows` keeps its 23-row steady state and the movement watch
(routine 1ab33141) keeps its tripwire semantics unchanged.

## Deliverable 3 — money-bearing rows referenced by already-published artifacts

- **`admin|live 2026-08-09 (−$63.54)` is a cited row.** The TRA-3849 board-record comment of
  2026-08-19T01:00Z — the analysis that framed board interaction `e9b50548` — quotes it by name and
  value ("admin/live 2026-08-09 eodCombined −63.54, both legs 0.00"). Its value is also echoed as a
  fixture constant in committed code (`scripts/check-nonsession-rows.mjs:235`,
  `packages/server/src/eod-nonsession-row.test.ts:84,111`) — synthetic echoes, not references to the
  stored row, but they would read strangely beside a retracted original. Retracting this row would
  leave a board-record citation pointing at a row that no longer exists.
- **All 9 money rows have a paired stored artifact**: the non-session EOD report file
  (`users/<u>/reports/<mode>/<date>.json`) that actually carries the `eodCombined` dollars (written
  before the TRA-3848 market-day gate). Stored, not cited — but any retraction plan that touches the
  snapshot row without the paired report file hides the money from the census (see Deliverable 1).
- No sealed session day cites a non-session row (non-session dates have no sealed session). Whether
  any May/June weekly or monthly scheduled report was actually dispatched to a recipient in-window
  could not be verified from here; if one was, its already-sent totals included at most the +$19.49
  leg (enock, W18/May) — and no option on the table can alter a sent artifact.
- The 17 departed money-bearing rows sit in retired orphan trees no published surface reads.

## Recommendation

**Read-time exclusion (Option C).** Retract-inert moves $0.00 and is pure deletion risk.
Retract-money moves exactly $19.49 of actually-published sums, requires a CFO override of
TRA-2886/2888, strands a board-cited row, and — done naively on snapshots alone — hides $2,766.70
of report-cell money from the census. Read-time exclusion delivers every dollar correction either
retraction would, plus the correct day-count semantics, with no write, no override, and automatic
coverage of any future adoption of a departed book. Implementation is a small, testable reporting
change (filter in `getCumulativeStats`, `mergeByDate`, `peakEquity`) to be filed as its own ticket
on sign-off; the detector and manifest machinery stay exactly as they are.

## Deliverable 4 — CFO sign-off (left unsigned)

> **SIGN-OFF (CFO):** I approve **Option C — read-time exclusion**: non-session rows are excluded at
> the reporting layer (`getCumulativeStats`, `mergeByDate`/`aggregatePeriod`, `peakEquity`) with no
> ledger write; TRA-2886/2888 remain in force; `ENABLE_EOD_ROW_BACKFILL` remains false; no snapshot
> row and no EOD report file is deleted or restated; the 60 departed rows remain retired under the
> TRA-5132 machinery, and any future `adoptExistingBook` reversal must re-run this pricing over the
> adopted book before its totals are served.
>
> SIGNED: ____________________  DATE: ____________
