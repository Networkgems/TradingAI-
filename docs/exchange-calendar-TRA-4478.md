# The exchange calendar (TRA-4478)

Source: external audit H1 / Package 6; review in `docs/external-audit-review-TRA-4473.md` §6.

## What was wrong

`packages/server/src/scheduler.ts` owned `MARKET_HOLIDAYS`: a hand-typed `Set` holding **2025 and
2026 only**. There were **zero `2027-` dates anywhere in non-test server source**. `isMarketDayIso`
fell through to a bare weekday check, so from **2027-01-01** — a Friday, ~114 days out at filing —
every NYSE holiday would have read as an ordinary market day. Early closes were not modelled at all.

Trading on a closed day mostly gets refused by the broker. **The damage that matters is to
evidence.** The same calendar keys EOD, risk-day and every per-ET-day fold, so a wrong session
boundary silently mis-dates the rows the live-capital promotion gate reads — and a promotion
decision computed off a mis-dated fold looks completely ordinary. (cf. TRA-4154 on per-ET-day rolls;
TRA-3267, where the two halves of the session predicate disagreed about what day it was and dropped
every Friday EOD row fleet-wide.)

## The shape of the fix

| Layer | File | What it is |
| --- | --- | --- |
| Rules | `scripts/gen-nyse-calendar.mjs` | NYSE Rule 7.2 observance rules, encoded once. `--selftest` grades them; `--check` diffs the bundle. |
| Data | `packages/server/src/data/nyse-calendar.generated.ts` | Generated annual bundles, **2015–2035**. Never hand-edit. |
| Interface | `packages/server/src/market-calendar.ts` | The single consumer-facing API. |
| Consumers | `scheduler.ts` + the 12 non-test server modules keying off `isMarketDayIso` | `isMarketDayIso`, `previousMarketDayIso`, `isMarketOpen` now read the bundle. |
| Repo alarm | `pnpm check:calendar-coverage` | In `pretest` and CI. |
| Live alarm | `GET /api/health/exchange-calendar` | Unauthenticated; reports the RUNNING build's calendar. |

Extending coverage is a re-run, not a typing exercise:

```bash
# raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs, then
pnpm gen:calendar
pnpm check:calendar-coverage
```

## ⛔ The three-valued result is the point

`resolveSessionDate` returns `'session' | 'non_session' | 'uncovered'` — **never a boolean**. "The
calendar says this is a trading day" and "the calendar has no opinion and I guessed from the day of
week" must not share a value; that identity *is* the defect. Callers pick their failure direction
explicitly, and the two directions are opposite on purpose:

- **ENTRY fails CLOSED** — `calendarEntryGate(date, assetClass)`. An out-of-coverage or unreadable
  date refuses new entries. **An external calendar outage must never open trading.**
- **EXITS are never gated.** `allowExit` is hard-coded `true`. A stale calendar that trapped you in
  a position would be strictly worse than the mis-dating it guards against.
- **EVIDENCE keeps the weekday fallback** — `isSessionDateOptimistic`, which `isMarketDayIso`
  delegates to. Failing session-keyed folds and EOD writes closed would drop every row fleet-wide,
  which is the TRA-3267 incident shape, not a fix for it (12 non-test server modules key folds and
  EOD writes off it, measured 2026-09-09). The fallback is instead **counted**
  (`calendarFallbackCount`) and logged once per date, and both are published on the health route.
  A suppression must ship a counter.

## Asset classes

| Class | Calendar | Coverage gate |
| --- | --- | --- |
| `equities` | NYSE | yes |
| `options` | NYSE (OCC holidays track NYSE; an option does not trade when its underlying's exchange is shut) | yes |
| `crypto` | **none — 24/7/365** | **exempt** |

Crypto is exempt by construction: it has no exchange calendar, so it cannot have a stale one. This
is enforced structurally, not by convention — the governor's calendar gate sits in `isHalted()`
(the equity/options leg) and is deliberately **absent** from `isHaltedExcludingFeedStale()`, which
is the leg the crypto engine consults.

## Early closes

13:00 ET, modelled explicitly: the Friday after Thanksgiving (always), Christmas Eve when it falls
Mon–Thu, and July 3 when it falls Mon–Thu. A day that is already a **full closure** is never also an
early close — the observed-holiday cases (2026-07-03, 2027-12-24) are the ones a naive
"July 3 / Dec 24 are half days" rule marks wrongly, and a caller reading a 13:00 close for a shut
exchange is worse off than one reading nothing.

`isMarketOpen()` now reads its close boundary from `sessionCloseEtMinute` instead of a hard-coded
16:00, so a half day reports shut at 13:00 rather than claiming three hours of session that do not
exist. `session-coverage.ts` still measures against a 390-minute session on a half day, unchanged
and deliberately: that biases toward "less covered than you think", which is the safe direction for
a reader deciding whether to trust a zero.

## ⛔ The coverage FLOOR is as load-bearing as the cliff

A calendar starting at "now" refuses every historical date, so a replay/backtest run — or any
fixture pinned to a past instant — reads as uncovered and **halts**. This nearly shipped: the first
bundle started at 2025 and `sma200-capital-gate.test.ts`, whose clock is `2024-06-04`, went red.
Coverage therefore starts at **2015**, and `gen-nyse-calendar.mjs --selftest` asserts
`COVERAGE_START_YEAR <= 2024` so the floor cannot be quietly raised past the fixtures again.

Reaching back means reaching past two **rule changes**, both encoded in `EFFECTIVE_FROM`:

- **Juneteenth** — first observed by the NYSE in **2022** (2022-06-20; June 19 was a Sunday).
  Emitting it for 2019 mis-dates that fold in exactly the same way as missing 2027-01-01, and is
  quieter, because nobody re-reads a 2019 fixture.
- **MLK Day** — first observed **1998**.

The per-year closure count is asserted against what the rules imply for that specific year
(10, minus one for each rule not yet in effect, minus one in a New-Year's-on-Saturday season) —
not against a loose "9 or 10", which would not have seen Juneteenth leaking into 2019. 2022 and
2024 are additionally transcribed by hand as literal control years, alongside 2025 and 2026.

## The weekend observation rules, including the one that is easy to get wrong

- Saturday → observed the **preceding Friday**.
- Sunday → observed the **following Monday**.
- ⛔ **Except New Year's Day.** When Jan 1 falls on a Saturday the NYSE does **not** close the
  preceding Friday and does **not** roll forward either — there is simply no New Year's holiday that
  season (next: 2028). Rolling it back would also push the date into the *previous* year's bundle,
  which is how a per-year generator quietly loses a date at a seam. Both directions are asserted in
  the generator selftest and again in the vitest fixtures.

## Rollback

The bundle is **checked into the repo and ships inside the build**, so a rollback is an ordinary
deploy of an older commit and automatically carries that commit's last-validated bundle. The
requirement that a rollback is "only valid if its coverage includes the active date" is satisfied
**structurally rather than by procedure**: if the rolled-back bundle does not cover today,
`calendarEntryGate` refuses entries on the live host and
`GET /api/health/exchange-calendar` reports `freshness.status: "stale"` with the coverage window and
the remedy. There is no separate rollback validation step to forget, and no path by which an old
bundle silently resumes guessing.

## Exit codes

```
pnpm check:calendar-coverage
  0 FRESH     covered, >180d of runway
  1 STALE     ⛔ today is UNCOVERED — the incident
  2 usage
  3 BLIND     ⛔ could not check
  4 EXPIRING  covered, cliff inside 180d — extend it
  5 DRIFT     the checked-in bundle is not what the generator produces,
              or the generator's own rule selftest fails
Precedence: BLIND > STALE > DRIFT > EXPIRING > FRESH

pnpm check:calendar-coverage:controls   # every exit code driven for real
node scripts/gen-nyse-calendar.mjs --selftest
```

Both selftests and the live check run in `pretest`. Every arm of both was **mutation-verified** at
authoring time (drop the New Year's exception; let an early close collide with a closure; move Good
Friday by a day; remove the gate from `isHalted`; make the entry gate fail open; restore
`isMarketOpen`'s hard-coded 16:00) — each mutation turns the suite red, and the suite is green
without them. The coverage-floor case was not caught by design: it was caught by the full server
suite going red on a 2024 fixture, which is the reason the whole suite is worth running on a change
to a predicate this widely consumed.

## What this does NOT do

- It does not change **which** dates 2025–2026 were holidays. The generated bundle reproduces the
  retired hand-typed table byte-for-byte, asserted in both selftests, so no existing evidence is
  re-dated.
- It does not move the EOD/archive fire times. A 13:00 half day still archives at 21:00 ET; only the
  `isMarketOpen` boundary changed.
- It does not subtract half days from `session-coverage.ts`'s 390-minute denominator (see above).
- It carries no deploy order (`<!-- deploy-order: none -->`). The gate is inert on a covered date,
  and today is covered with 3400 days of runway.
