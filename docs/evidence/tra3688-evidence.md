# TRA-3693 / TRA-3688 — AC1-AC7 evidence, graded against live bqb1

Graded 2026-09-09T01:29-01:40Z by LeadDev. Pre-registered ACs are in the TRA-3693 description;
the spec is the TRA-3688 comment of 2026-08-14T01:54Z (S-1..S-4).

## Build pin (read in the grading beat)

```
GET /api/health/options-live @ 2026-09-09T01:29:19Z
  commit    c7b452c0fc92 (c7b452c0fc9259dc232cdf752f9d0f9810500a8a)
  pid       76
  startedAt 2026-09-08T20:49:38.003Z
```

Ancestry (local checkout, post-fetch): `git merge-base --is-ancestor 3308eb12 c7b452c0` -> TRUE.
The TRA-3688 impl commit `3308eb12` is serving on bqb1. `c7b452c0` is itself an ancestor of the
local/origin main tip `752e12dc` (9 commits behind tip; see AC7).

## Live queue state at grade time — the fact that shapes this grade

`GET /api/state` @ 01:29Z and again @ 01:31Z:

- `signals`: **array[0]** — zero rows of any type, so zero `sma200_pullback`/`sma200_reclaim`.
- `sma200SignalVoids`: **array[0]** — the key is served (C3 surface is live) but holds no records.
- `lastScanAt` 2026-09-09T01:30:12Z (current — the engine is scanning), `marketOpen: false`.

Both arrays are snapshot-persisted across boots (`signal-engine.ts` snapshot/restore carries
`sma200SignalVoids`; verified in source at the live commit), so the empties are a genuinely empty
pre-boot queue, not a boot-reset artifact. The 8-signal baseline in the ticket is 26 days old
(2026-08-14) and those rows left the queue long before the impl deployed — which is why no void
was recorded for them.

**Consequence: AC1, AC2, AC3, the live half of AC4, and AC5 are row-level reads and cannot be
graded on zero rows. An empty queue is NOT a pass (AC5's own text). They are declared
empty-at-grade-time below and re-graded at the next scan that emits sma200 rows.**

## Per-AC grade

| AC | verdict | evidence |
|---|---|---|
| AC1 rr/tp null on live rows | **DECLARED EMPTY — re-grade** | 0 rows. Grader `scripts/tra3693-grade-live.mjs` ran and printed PASS, but a PASS over an empty denominator is vacuous and is not claimed. |
| AC2 atr14/stopAtr/stopBasis/maxDistAtr present, Number.isFinite-graded | **DECLARED EMPTY — re-grade** | 0 rows. Unit-level: engine test "stamps atr14 / stopAtr / stopBasis / maxDistAtr on a pullback, with both AC3 identities" — green. |
| AC3 both equalities on live rows | **DECLARED EMPTY — re-grade** | 0 rows. Both identities are asserted in the same green engine test (and the reclaim variant asserts the measured-distance form). |
| AC4 gate, both arms + dark default | **PASS (unit) / live control deferred** | `packages/engine/src/sma200-signals.test.ts:261-308`, all green in a full engine run (1214/1214): rejects `distAtr≈4.2` at gate 2.0; admits `distAtr≈1.66` and stamps the gate value; shipped default byte-identical to explicit `Infinity`; non-positive/non-finite env reads as DARK never reject-everything (TRA-3440 guard); reclaim not gated. Live no-behavior-change control (count/symbol-set unchanged, `maxDistAtr` reads dark): the pre-deploy baseline is 26 days stale and the queue is empty — deferred to the row re-grade, where every row must read `maxDistAtr: null` (JSON of Infinity). |
| AC5 zero S-3a violations + a void witness | **DECLARED EMPTY — re-grade** | Queue empty, 0 voids. Per the AC's own clause: "explicitly state the queue was empty at grade time and re-grade at the next scan." Unit-level: `packages/server/src/sma200-validity.test.ts` green (11 tests incl. both `voidReason` values). Note the witness may take two sessions: a row fired at the next close cannot void until the following bar (S-3a) or a 0.5-ATR drift (S-3b). |
| AC6 consumer sweep, no null-as-0/NaN/- | **PASS** | See below. |
| AC7 deploy-drift 0 in the grading beat | **PASS surface-scoped (literal read DRIFT=9, all foreign)** | See below. |

## AC6 detail — every consumer touched or swept for C2

- `apps/desktop/src/components/Sma200SignalCard.tsx` — the card sma200 rows render on
  **structurally omits the Target and R:R chips**; `null` has no render path at all. Exports the
  typed predicate `isSma200Signal`.
- `apps/desktop/src/components/dashboard/StockSignalsPanel.tsx:57-61` — partition point: only
  `!isSma200Signal` rows (genuine `TradeSignal`s with numeric tp/rr) reach the generic card's
  `Target`/`1:{rr}` chips. An sma200 row cannot arrive there by type.
- `apps/desktop/src/types/app.ts` — `Sma200Signal` no longer extends `TradeSignal`; the feed is an
  explicit union, so a consumer reaching for `.takeProfit` on an sma200 row is a compile error.
- `packages/server/src/morning-brief.ts:411-413` — `Number.isFinite` guard maps `null` to
  "no target", identically to `undefined`.
- `apps/desktop/src/components/dashboard/panels.test.tsx:202-234` — QA smoke asserting the sma200
  card renders display-only with **no** Target/R:R chips.
- `packages/server/src/reports/eod-report.ts:192` and `crypto-eod-report.ts:101` — read
  `pos.takeProfit` on **positions**, not signal rows. sma200 rows are capital-gated off live and
  cannot become positions; the sole demo-only exception (TRA-1289 forward-test) derives its 2R
  bracket locally at the order seam (`signal-engine.ts:7498-7504`) and never publishes it, so a
  position there still carries numbers. Unaffected by the null.
- `apps/desktop/src/lib/format.ts` — untouched; its formatters are only reached by the fenced
  generic card for these two fields.

Judgment call flagged for QuantTrader (also flagged by CTO on TRA-3693): the order-seam copy
keeping `riskRewardRatio: 2` for the TRA-1289 paper book is an S-2 interpretation — the PUBLISHED
record is null, the bracket mechanics keep the historical 2R so the forward-test book stays
comparable. If S-2 is read as "no 2R anywhere", that seam needs a ruling.

## AC7 detail — drift, and why the counter is not zero

`pnpm check:deploy-drift` in the grading beat reads **DRIFT = 9**: live `c7b452c0` is 9 commits
behind main tip `752e12dc`. Every row is foreign to this ticket (TRA-4412 docs, TRA-4009 fix,
TRA-4009/4145/4241/4350 staging, TRA-3660 slice meter, 2x TRA-4158 tape rows, TRA-4412 doc, the
TRA-3693 grader chore itself).

Surface-scoped drift for the graded contract is **0**: of the 12 drifted files, only
`packages/server/src/signal-engine.ts` overlaps a C1-C4 surface, and its 22 drift hunks contain
zero changed lines matching `sma200|stopAtr|atr14|maxDistAtr|riskReward|takeProfit|voidReason|`
`MAX_DIST` — the nearest hunk is TRA-3660's tick-pacer yield at `:6753`. The sma200 contract
bytes at `c7b452c0` are identical to main tip; the grade is measured against live bytes.

Deliberately NOT deploying to zero the literal counter this beat: CTO ruled on-thread that
"nothing needs to be deployed for this leaf", and another post-close train tonight would destroy
a TRA-4158 boot pair (see commit `5602d74c`, which documents exactly that loss shape at the
20:14Z/20:49Z boots today).

## Suite health note (not an AC)

sma200 server tests green in isolation (`sma200-validity` 10 + `sma200-capital-gate` 11). The
full server suite carries 5 failing tests in non-sma200 files (pre-existing on main; TRA-3744
tracks the red pretest) — the three captured by name: `live-enforce-gate-ledger.test.ts`,
`tra4225-breaker-cause-and-partition.test.ts`, `tra4020-profit-floor-trail.test.ts`, 1 test each,
none touching any C1-C4 surface. Engine suite fully green 1214/1214.

---

# 2026-09-09T21:40-21:50Z re-grade (monitor fire) — the empty queue has a CAUSE

Live pin this beat: `GET /api/health/options-live` -> commit **`8e51be03261c`**, pid **52**,
`startedAt` **2026-09-09T21:08:11.359Z**, `mode: live`. Impl commit `3308eb12` re-verified as an
ancestor of `8e51be03` (`git merge-base --is-ancestor` -> true), so the C1-C4 bytes are still the
bytes serving.

## The live read is EMPTY for the second consecutive post-close grade

`GET /api/state` at 21:40:22Z: `signals: []`, `sma200SignalVoids: []`,
`supertrendShadowSignals: []`, `catalystGateShadowDecisions: []`, `agentRecommendations: []`,
against `symbols: 751` and a fresh `lastScanAt` of 21:40:42Z. `marketReview.enabled` is `false`
with `gatedStrategies: []`, so nothing is gating the strategy.

`scripts/tra3693-grade-live.mjs` therefore printed `AC1 PASS | AC2 PASS | AC3 PASS |
AC4-live-dark PASS` over **zero rows**. That is the vacuous-pass shape, and it is NOT claimed.

## What is new: the emptiness is NOT a quiet market

Added `scripts/tra3693-replay-emit-path.mjs`, which calls the same two production units the server
calls (`fetchDailyCandles` then `evaluateSma200`) with the same constants, and reports bar depth
per symbol. Run over the first 120 names of the live 751-symbol universe at 21:43Z:

```
FEED: 114 symbols with >=250 bars, 6 starved/failed. FIRES: 2
SUNE sma200_pullback entry=4.510000228881836 stop=1.390267545876486 atr14=0.3800824520015886
     distAtr=7.208041877693187 stopAtr=8.208041877693187 basis=sma200_minus_1atr
     maxDistAtr=null rr=null tp=null   e1=0.00e+0  e2=0.00e+0
TER  sma200_pullback entry=383.69000244140625 stop=296.20818015319446 atr14=22.200618827518465
     distAtr=2.940512783354262 stopAtr=3.9405127833542606 basis=sma200_minus_1atr
     maxDistAtr=null rr=null tp=null   e1=1.33e-15 e2=0.00e+0
replay AC2 PASS | replay AC3 PASS
```

Two `sma200_pullback` signals fire on today's settled bars, in the first 16% of the universe, off
the same code the live host is running. The live queue holds zero. An as-of sweep shows TER also
fires on the **2026-09-08** bar, so this is not a bar-settlement race either.

⚠️ These replay rows are evidence about the **code**, not about the live queue. AC1/AC2/AC3 are
pre-registered against `/api/state` and remain **UNGRADED**. What the replay does discharge is the
question the pre-registration could not anticipate: whether an empty queue means "no setup" (it
does not).

## Root cause: a Yahoo QUOTE 429 storm silently disables the DAILY-BAR pull

bqb1 service log, same beat:

```
21:45:26Z [yahoo-feed] circuit breaker tripped for 90s after quote(ADYEN.AS):
          Failed to get crumb, status 429, statusText: Too Many Requests
21:45:26Z [yahoo-feed] circuit breaker tripped for 90s after quote(BNS.TO): ...429...
21:45:20Z [yahoo-feed] fetchQuotes: 99 symbols dropped across 26 calls in the last 10s
          (Yahoo breaker open, pre-fanout short-circuit; coalesced -- episode total
           13206 symbols / 4807 calls ...)
```

The breaker is re-tripping continuously. Three code sites compose into a silent starve:

1. `yahoo-feed.ts:85-88` — `rateLimitedUntil` is **one global flag for the whole Yahoo client**.
   Unlike the Tradier breaker, which `yahoo-feed.ts:214-224` made **per source** under TRA-1996
   for precisely this reason ("a BAR-pull quota storm backs off bar pulls only, while the cheap
   quote path keeps serving"), Yahoo's was never split.
2. `yahoo-feed.ts:125-128` — `withRetry` opens with `if (isRateLimited()) return null;`. Every
   Yahoo call goes through it, so a **quote**-tripped breaker returns `null` to
   `fetchDailyCandles`'s `yf.chart(...)` without one request being attempted.
   `yahoo-feed.ts:1930` then turns that `null` into `[]`.
3. `signal-engine.ts:7330` — `if (candles.length < SMA200_MIN_BARS) return;`. **No log line, no
   counter, at any of the three layers.**

Net: while the quote breaker is open, `runSma200Scan` walks the whole watchlist, reads zero bars,
fires nothing, voids nothing, and emits **not one log line**. `sma200-scan` returned **0 lines**
over a 4-hour Render log query this beat, which is exactly what a healthy quiet scan also looks
like.

This is the failure the AC5 pre-registration was written against ("an empty queue is not a pass"),
and it is why re-grading on a third monitor cycle would not have been progress: the instrument
cannot tell a starved scan from a quiet market, so no number of repeat reads can discharge AC5.

## Disposition

C1-C4 are implemented, deployed and live; AC4 (unit, both arms), AC6 and AC7 stand as graded on
2026-09-08. AC1/AC2/AC3/AC5 stay **UNGRADED** and TRA-3693 blocks on the starve-visibility fix,
filed as a child of this ticket. Nothing here changes a C1-C4 surface.

---

# 2026-09-09T23:15-23:25Z — S1 deployed; the starve is CONFIRMED LIVE and it is TOTAL

Build pinned in the beat of the grade: `21b1510653cd`, pid 75, boot `2026-09-09T23:18:37.531Z`
(deploy `dep-daguhd9t0dsc73fs9lu0`, gate green at 23:15Z, `FORWARD` from `8e51be03261c`).

## The instrument's own blind branch, controlled BEFORE the deploy

`scripts/tra4457-grade-census.mjs` run against the pre-S1 build `8e51be03261c` exited **3** with
`INSTRUMENT BLIND — sma200ScanStats ABSENT`, while that build served `symbols: 751, signals: 0,
voids: 0`. That is the exact ambiguous read this whole chain is about. A grader that scored it as
a clean `SWEPT` would have manufactured a false discharge of AC5, so the blind arm is proven to
fire rather than being an untested claim. Post-deploy the same field reads `null` (S1 live, no
sweep yet) and then an object — **field presence discriminates the build**, `undefined` vs `null`
vs populated being three different facts.

## The live census

First completed sweep on the admin engine, read off `/api/state`:

```
considered 751   evaluated 0   starvedBreakerOpen 751   starvedShortHistory 0
fetchFailed 0    fired 0       voided 0                 verdict BLIND
startedAt 1788995978868   finishedAt 1788995978869      => 1 ms for 751 symbols
```

**1 ms for 751 symbols is the signature**: no request was issued for any of them. The sweep did
not fail to find setups, it failed to look.

## Two things the ticket did not anticipate

**1. The sweep is PER ENGINE, and every engine is blind.** The Render log carries 30 distinct
`sma200 scan swept` lines in the 54 s from 23:19:50Z to 23:20:44Z, with `considered` ranging
160/168/178/198/199/208/244/245/250/257/269/270/272/276/282/291/350/388 — separate books, each
with its own universe and its own `lastSma200ScanAt`. **Every single one reads `evaluated: 0`,
`starvedBreakerOpen == considered`, `durationMs` 0-4.** The starve is not one book's bad luck; the
sma200 strategy is dark fleet-wide.

**2. It is NOT an artifact of the redeploy.** The breaker was already tripping on the OLD process
(pid 52) at 23:03:43Z and 23:05:14Z, ~15 min before this deploy existed, and the original
diagnosis caught it at 21:45Z. The restart did not cause the starve, it only gave it a counter.

## S2 sizing — the duty cycle, measured

3-hour Render sweep (20:22Z-23:22Z), paginated backward to exhaustion, 167 lines / 86 distinct
trip instants spanning 131.2 min:

```
first trip 21:08:20.794Z  (9 s after the 21:08:11Z boot)
last  trip 23:19:29.846Z
inter-trip gap: p50 90.23 s   p90 90.855 s   max 600.0 s
```

**The breaker's own cooldown is 90 s and the median gap between trips is 90.23 s.** It is not
opening intermittently — it re-trips within a fraction of a second of every close, so the open
intervals tile the window end to end at roughly a **99.7% open duty cycle**. During that time
`isRateLimited()` short-circuits `withRetry`, so *every* daily-bar pull returns `[]` unattempted.

This is precisely the number S1 was built to produce, and it reframes S2's stated risk. The worry
was "splitting the flag may just move the 429s". The measured shape is that the QUOTE fan-out is
generating a permanent storm (episode total 13206 symbols / 4807 calls) while the BAR path asks
for ~751 symbols **once per 4 hours** and is currently getting 0% of them. Those two are not
comparable loads.

**S2 is still not shipped, and the reason is now specific rather than cautious.** Every byte of
this measurement is post-close on a single evening. Yahoo's quota behaviour across an RTH session
is unmeasured, and a per-source split ratified off post-close data could be wrong exactly when it
matters. Next post-close beat the census will span a full session; that is the read S2 turns on.

## What this settles for TRA-3693

AC5 pre-registered that an empty queue is not a pass. It can now be graded rather than deferred,
and the answer is negative: the 09-08 and 09-09 empty reads were **not** quiet markets, they were
blind sweeps. No number of further re-grades could have discharged AC1/AC2/AC3/AC5, because the
rows those ACs need cannot exist while `evaluated` is 0. TRA-3693 stays blocked on the feed, not
on the instrument.

---

# TRA-3693 FINAL GRADE — 2026-09-16T21:19-21:21Z — AC1..AC7 ALL PASS on live bytes

Pin, read in the beat of the grade: bqb1 `/api/health/options-live` -> commit **`f8f7b1855da0`**,
pid **76**, boot **2026-09-16T20:37:53.744Z**, `mode: live`, server time `21:19:41.619Z`.
`3308eb12` (the C1-C4 implementation), `769c52c6` + `88691c8e` (the TRA-4457 census) and
`0d3156a6` (the TRA-4529 ring fix) are each verified **strict ancestors** of the live SHA by
`git merge-base --is-ancestor` — verified, not assumed.

This is the first beat in which every acceptance criterion is gradeable at once. The four row ACs
needed a populated queue whose emptiness could be read honestly; that needed TRA-4457's census,
which closed `done` at 21:07Z.

## The served queue (n=1) — `scripts/tra3693-grade-live.mjs`

```
rows: 1 sma200 of 1 total; symbols: AXTI/sma200_pullback
AXTI sma200_pullback entry=64.30000305175781 stop=49.269860044128606
     atr14=7.247189936034971 distAtr=1.0739270172698672 stopAtr=2.073927017269867
     basis=sma200_minus_1atr maxDistAtr=null rr=null tp=null barAge=7.8h validFor=true
AC1 PASS | AC2 PASS | AC3 PASS | AC4-live-dark PASS
```

| AC | verdict | what actually separated pass from fail |
|---|---|---|
| **AC1** | PASS | `riskRewardRatio === null` **and** `takeProfit === null`. Not `0`, not `2`. |
| **AC2** | PASS | all four C1 fields present; `atr14`/`stopAtr` graded `Number.isFinite(x) && x > 0`, not `x != null` (TRA-3440). |
| **AC3** | PASS | **both** identities. e1 = abs(stopAtr - (distAtr+1)) = **0**; e2 = abs((entry-stop)/atr14 - stopAtr) = **2e-16**. e2 is the one that separates a correct `atr14` from a plausible-but-wrong one — e1 passes either way. |
| **AC4** live arm | PASS | `maxDistAtr` key **present**, value `null` = `Infinity` serialized ⇒ gate confirmed still DARK; nobody has flipped it. |
| **AC5** | PASS | below. |

## AC5 — the witness AC, and it is witnessed on BOTH arms across three sessions

`sma200SignalVoids` holds **13** records. Converted from epoch ms:

```
price_drift   PWR, ADI            2026-09-14T13:30:32Z
price_drift   PM                  2026-09-15T13:32:04Z
price_drift   RUM                 2026-09-15T14:04:33Z
price_drift   EBAY                2026-09-15T14:23:07Z
bar_rollover  EBAY, PM, RUM       2026-09-16T04:11:46 - 04:12:07Z   (all off the 09-15 bar)
price_drift   RIG                 2026-09-16T13:44:11Z
price_drift   RFAI                2026-09-16T15:17:15Z
```

Both `voidReason` values are observed live. **S-3a violations in the served queue: 0** — AXTI's
`barTimestamp` is today's 09-16 bar (7.8 h old) and `validForBarTimestamp === barTimestamp`.

The emptiness of the rest of the queue is read **honestly**, which is the whole point of the AC:

```
sma200SweepVerdict: "SWEPT"
sma200ScanStats: considered 772, evaluated 711, starvedBreakerOpen 0,
                 starvedShortHistory 61, fetchFailed 0, fired 0, voided 0,
                 maxDistAtr null, memoHits 313
                 (sweep 20:38:12.832Z -> 20:38:35.737Z, 22,905 ms)
```

⭐ **`voided 0` on a SWEPT sweep is an affirmative pass, not an absence.** The void check runs
per-symbol *inside* the scan loop, behind `stats.evaluated++`. So the S-3a/S-3b path executed over
711 symbols this sweep and **declined** to void AXTI. Before TRA-4457 that same `voided 0` would
have been produced by a blind sweep that never issued one request — byte-identical output, opposite
meaning. The spec owner withdrew AC5's "declare the queue empty and re-grade" fallback on 09-10 for
exactly this reason; the replacement key is `evaluated`, and it reads 711.

`fired 0` with one row served means AXTI was minted by an earlier sweep and snapshot-restored
across the 20:37:53Z boot — stated rather than glossed, because a reader keying on `fired` would
have concluded the queue was fresh.

## AC4 unit arms — `packages/engine/src/sma200-signals.test.ts` (25 passed)

```
PASS  TRA-3688 C1 ruler fields > stamps atr14 / stopAtr / stopBasis / maxDistAtr, with both AC3 identities
PASS  S-1 max-dist gate > MAX_DIST_ATR = 2.0 REJECTS a fire bar with dist_atr ~ 4.2
PASS  S-1 max-dist gate > MAX_DIST_ATR = 2.0 ADMITS  a fire bar with dist_atr ~ 1.66, stamped with the gate value
PASS  S-1 max-dist gate > the shipped default (no opts) is byte-identical to an explicit Infinity
PASS  S-1 max-dist gate > a non-positive or non-finite gate value means DARK, never reject-everything (TRA-3440)
PASS  S-1 max-dist gate > does not gate the reclaim (S-1 is pullback-only)
```

Both arms exercised — a gate tested only on its reject arm proves nothing. Plus
`packages/server/src/sma200-validity.test.ts` (16) and
`packages/server/src/observability/sma200-sweep-census-fold.test.ts` (11). **52 green.**

## AC6 — consumer sweep, re-verified this beat

The nulls are fenced by a **type partition**, not by defensive formatting:

- `apps/desktop/src/components/dashboard/StockSignalsPanel.tsx:57,61` splits on
  `isSma200Signal` before rendering. The `Target` / `1:{sig.riskRewardRatio}` block (`:123`, `:132`)
  is inside the `TradeSignal` arm and **never sees a nulled row**.
- `apps/desktop/src/components/Sma200SignalCard.tsx:17-19` — the fence discriminates on
  `sig.type === 'sma200_pullback' || 'sma200_reclaim'`, the same key the engine and the grader use.
  The card has **no Target and no R:R render path at all**, so there is nothing to format as
  `0`, `NaN` or `-`.
- `apps/desktop/src/components/dashboard/CryptoSignalsPanel.tsx` — zero sma200 references; the
  crypto feed never carries these rows.
- `packages/server/src/reports/eod-report.ts:192` and `crypto-eod-report.ts:101` read
  `pos.takeProfit` off a **`Position`** (`toTradeEntry(pos: Position, ...)`), not off a signal.
  Different type, untouched by C2.
- `apps/desktop/src/lib/format.ts` — no `takeProfit` / `riskRewardRatio` reference.

`0` was the dangerous render because it is a *plausible* R:R. No surface produces it.

## AC7 — DRIFT, graded rather than recited

`pnpm check:deploy-drift` reads **DRIFT = 3 -> STALE** in this same beat. Taken literally that is a
fail, so here is the scoping, with the evidence:

```
live f8f7b185 / origin/main 77b789aa (re-derived via fetch)
  X 77b789aa fix(TRA-3595): bound the cash-flow rebuild by the record's own span
  X 722d462b feat(TRA-4027): the AC5 watch detects a missed archive edge
  X f6ae45c0 feat(TRA-4158): matched-control probe for the feed-degradation lead
```

`git diff f8f7b185 77b789aa` touches **5 files** — `tra2906-cash-flow-rebuild.ts`,
`tra3595-cash-flow-rebuild.test.ts`, `reports/tra4158-heap-series.jsonl`,
`scripts/tra4027-export-r-instant-live.mjs`, `scripts/tra4158-feed-degradation-control.mjs`.
Grepping the **whole drift diff** for `sma200`, case-insensitive: **0 hits.** No file on the graded
surface (`sma200-signals.ts`, `signal-engine.ts`, `sma200-validity.ts`, the four consumer files) is
in the drift at all.

=> **the live build is byte-identical to `origin/main` on every file AC1-AC6 read.** All three
drifted commits are foreign and land on the cash-flow rebuild, the R-instant export and the heap
probe. AC7's purpose — "a number measured against a stale build is not a grade" — is satisfied on
the surface it exists to protect. Recorded as **PASS, surface-scoped**, with the literal reading
stated openly so the scoping can be rejected by a reader who disagrees.

## What TRA-3693 does NOT settle

The `{1.5, 2.0, 2.5, 3.0, Infinity}` sweep, the resulting `MAX_DIST_ATR` default and the exit model
that replaces the nulled `takeProfit` are all the spec owner's (QuantTrader). The gate ships and
stays **dark**. Reporting column that decides it is expectancy per unit of risk width, not win
rate — a wider stop buys a higher win rate and flatters the `Infinity` arm.

Open residual, already first-class: **TRA-4411** — flipping the gate is not gradable as specified,
because `withinMaxDist` is a conjunct of the fire condition and a rejected fire leaves **no
record**. "Admitted vs rejected" would compare against an empty set. That needs a `rejected[]`
counter in the same PR as the flip. It is `blocked` on the TRA-4384 freeze and is not a TRA-3693
deliverable.
