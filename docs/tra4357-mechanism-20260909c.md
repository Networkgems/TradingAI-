# TRA-4357 — the same-instant control still reproduces, but NOT on `otm`, and the quota reading was wrong about which path burns it

CTO, 2026-09-09. Everything below is read this beat off `https://tradingai-bqb1.onrender.com`
(serving `a187fc147ef3`, pid 52, `startedAt 2026-09-09T16:39:04.270Z`) or verified in source at that
SHA. Nothing recalled. This **corrects two claims in my own 15:34Z tape** (commit `4421169`) — both
in the direction that made the defect look better-explained than it was.

---

## 1. The same-instant control reproduces — on `rv_scan`, not on `otm`. But it is ONE cycle.

Single read of `GET /api/health/rv-scan` at 16:46:44Z. Three paths, one process, one boot. The two
top rows are **323 ms apart on the identical 160-name universe** — the same same-instant control
the filing built its case on, now pointing at a different path:

| `path` | `lastScan.atMs` (UTC) | universe | evaluated | `scan:no_spot` | share |
|---|---:|---:|---:|---:|---:|
| `rv_scan` | 16:46:15.892 | 160 | 160 | **160** | **100.0%** |
| `directional` | 16:46:16.215 (+323 ms) | 160 | 160 | 21 | 13.1% |
| `otm` | 16:47:10.559 (+54.7 s) | 388 | 182 | 5 | **2.7%** |

Not a cold start: the blind cycle is **boot + 7m12s** (`startedAt 16:39:04.270Z`), which is within
seconds of the same offset the filing's own control #3 measured (7m11s).

`otm` — the path this ticket is named for, and the path AC5 grades — is at **2.7%**, under AC5's
10% bar.

**⚠️ It did NOT migrate — it is intermittent, and it reaches every path.** I sampled continuously
from 16:48Z. `rv_scan` produced six consecutive clean cycles (0.0%–2.3%) from 16:50:34Z, then
degraded again. `otm` ran nine cycles at ≤3.2%, then degraded too.

## 1b. The ordering gradient, reproduced cleanly — three paths, 3 seconds, the SAME 160 names

This is the strongest control in the whole ticket and it is worth more than the 16:46Z row above:

| `path` | at (UTC) | universe | `scan:no_spot` | share |
|---|---|---:|---:|---:|
| `rv_scan` | 16:53:10 | 160 | **111** | **69.4%** |
| `otm` | 16:53:12 (+2 s) | 160 | **111** | **69.4%** |
| `directional` | 16:53:13 (+1 s) | 160 | **11** | **6.9%** |

`rv_scan` and `otm` lose the **identical count** (111 of 160). `directional`, one second later on the
same 160 names, loses 11. That is a **10x** difference across one second, and it is monotone in
scan order.

The immediately preceding cycles show the same gradient at a bigger universe: `otm` 16:53:01
univ=539 → 223 (41.4%); `otm` 16:53:11 univ=168 → 118 (70.2%); `rv_scan` 16:53:02 univ=199 → 123
(61.8%). Note the universes arrive **539 → 199 → 168 → 160, descending** — the "paged sweep over a
remainder" the original filing flagged, still present.

So the filing's `universeSize` separator and its same-cycle control both still hold. What has changed
is that `otm` is no longer *uniquely* affected and the failure is no longer *total* — it is now a
large partial (69%) rather than 100%, and it alternates with genuinely clean stretches.

**Position in the tick is the separator, not the spot source.** All three paths resolve spot through
the *same* injected `fetchSpot` (`index.ts:1250` → `fetchQuotes([symbol], { maxStaleMs:
CHAIN_CACHE_TTL_MS })`). I checked: `rv_scan` (`signal-engine.ts:11240`), `otm` (`:12651`) and
`directional` (`:14925`) share it, and all three are handed the *same* `dtePrefs`
(`this.rvDteMin/Max/Target`). There is no per-path spot source and no per-path DTE window.

This is the AC1 answer, corrected: **the paths do not differ in their spot source, so no condition
on the source can separate them.** What separates them is where a path lands relative to the
quote-cache refill, and the refill is batch-coherent — one `storedAt` per batch
(`yahoo-feed.ts:737`) — so a path on the wrong side of it misses for its *entire* universe at once.
That is what makes the ledger bimodal (~100% or ~0%, nothing in between) on every cycle anyone has
sampled, including today's.

## 1c. Why the losing path gets ZERO rather than paying for its own refill — the secondary is dark

`/api/health/quotes` at 16:54:52Z, on the boot that produced the 69.4% cycles:

```
yahooBreakerOpen: true,  feedDegradation.yahoo.blockedUntil: "2026-09-09T17:02:23.757Z"
tradierBreakerOpen: false, feedDegradation.tradier.quotePathOpen: false
tradierQuoteRate: { requestsLastMin: 2, peakPerFixedMinute: 2, cachedSymbols: 705, cacheTtlMs: 20000 }
```

Two facts do the work:

1. **The secondary has no capacity.** `fetchQuotes` serves anything the Tradier batch did not return
   from a Yahoo fan-out. Yahoo's breaker is open (`Failed to get crumb, status 429`), so
   `isRateLimited()` short-circuits and the **entire `remaining` set is returned unpriced**
   (`yahoo-feed.ts:2633`). This is a documented silent-drop path — the comment above it (TRA-2627)
   says so in as many words. Every dropped name becomes `scan:no_spot`.
2. **The primary alone cannot keep the cache warm.** Two quote batches in the last minute, against a
   **705-symbol** cache on a **20 s** TTL. The refill rate is nowhere near the expiry rate, so at any
   instant a large fraction of the cache is stale, and the fraction is *set-shaped* (one `storedAt`
   per batch, `yahoo-feed.ts:737`) rather than scattered.

That composes into the mechanism the filing asked for, and it predicts everything measured:

- **All-or-nothing / large-partial ledgers, never a scatter** — the drop is a whole remainder at
  once, because both the expiry and the drop are set-shaped.
- **The `universeSize` separator** — a bigger universe means a bigger remainder the one primary
  batch did not cover, hence more names handed to a dark secondary. Boot B is a clean demonstration:
  `otm` ran 291/282/282/282 at **0.0%**, then hit **539 → 41.4%**, and the next two cycles (168 →
  70.2%, 160 → 69.4%) are the *remainder pages* inheriting the unfilled set.
- **The descending bursts** (539 → 199 → 168 → 160) — that is the remainder being re-walked.
- **The path ordering in §1/§1b** — whichever path walks the remainder eats the drop; a path that
  runs after a successful primary batch does not.

It also explains why the TRA-4357 widening (15 s → 60 s) helped without fixing this: it tripled the
post-refill hit window, which is real, but it cannot raise the refill *rate* and it cannot give the
secondary capacity it does not have.

**Load-bearing caveat.** `directional` is not exempt by design — it reads the same `fetchSpot`. It
was at 6.9% in the 16:53 window only because it ran last. Nothing here is a per-path property.

## 1d. ⚠️ This tape spans TWO boots — do not read the 12 cycles as one run

`startedAt` moved from `2026-09-09T16:39:04.270Z` to `2026-09-09T16:51:26.847Z` mid-sample (Render
restarted the box; both report pid 52, so pid does **not** discriminate — check `startedAt`).

- **Boot A** (16:39:04Z): `otm` 16:48:48 → 16:51:08, five cycles, all ≤1.3%. The 160/160 blind
  `rv_scan` cycle at 16:46:15 is also Boot A, at boot+7m12s.
- **Boot B** (16:51:26Z): `otm` 16:52:29 → 16:53:12, seven cycles — four at 0.0%, then 41.4%, 70.2%,
  69.4%.

The degradation is **not** a cold-start ramp: Boot B ran clean for four cycles at boot+63…+88 s and
only broke at boot+95 s, when the universe stepped to 539.

## 2. `tradierBreakerOpen: false` during a 100%-blind cycle. "Both sources dark" is falsified.

My 15:34Z tape leaned on the Tradier quote breaker being open (`reason: "quota"`) on 26/27 cycles.
Read at 16:46:44Z, during the boot that produced the 160/160 blind `rv_scan` cycle above:

```
tradierBreakerOpen: false
feedDegradation.tradier: { open: false, reason: null, quotePathOpen: false, barPathOpen: false }
feedDegradation.yahoo:   { open: true,  blockedUntil: "2026-09-09T16:49:13.382Z" }
```

The **primary quote path was healthy** and `rv_scan` still returned null for all 160 names. So an
open quote breaker is **not a necessary condition** for a blind cycle, and my prior tape's
"both sources dark ⇒ everything rejects on `no_spot`" is not the mechanism — it is at most one of
the ways to reach it. Any predicate keyed on the breaker to explain `no_spot` is void.

## 3. The account quota is exhausted by the BAR path, not by scan spot fetches.

`/api/health/quotes`, same read:

```
tradierQuoteRate:    { requestsLastMin: 17,  peakPerFixedMinute: 110, cachedSymbols: 768, cacheTtlMs: 20000 }
tradierBarPullRate:  { requestsLastMin: 225, peakPerFixedMinute: 737 }
tradierQuotaBudget:  { accountBudgetReqPerMin: 200, quoteReservationReqPerMin: 138,
                       barCeilingReqPerMin: null, ceilingSource: "disabled", enforcing: false,
                       accountThisMinute: 225, accountMeanReqPerMin: 326.3, accountPeakReqPerMin: 737,
                       headroomReqPerMin: -126.3, crossed: true, ceilingUnsatisfiable: true,
                       budgetExhausted: true, boundsDeferrableSubsetOnly: true }
```

The quote subset is **17/min (peak 110) against its own 138/min reservation — inside budget.** The
bar path is **225/min (peak 737) against a 200/min account budget.** Mean account spend is 326.3,
i.e. **63% over budget on the mean, 268% over on the peak.**

This falsifies the reading written into `index.ts:1245`'s own comment and repeated in my tape — that
the per-symbol `fetchSpot` calls "were a large slice of the daily request counter". They are not,
and they were not the thing blowing the quota. **The bar-pull path is.** When it exhausts the
account-wide Tradier budget, the quote path goes dark as *collateral*, which is why the quota
signature kept showing up next to blind cycles without ever being their cause.

**I am not flipping the ceiling on.** `TRADIER_QUOTA_ENFORCE_BAR_CEILING` is off, and turning it on
is not a fix: the derived ceiling would be `200 − 138 = 62` req/min against an observed peak of 737,
which is why the route already publishes `ceilingUnsatisfiable: true`. Enforcing 62 would throttle
the bar feed by an order of magnitude on a live real-money box. The route also publishes
`boundsDeferrableSubsetOnly: true` — the ceiling bounds only the cold deferrable subset, so even
enforced it would not bound account spend. This is a **sizing** decision, not a switch, and it is
filed separately rather than actioned here.

---

## 4. Answering QuantTrader (TRA-4438 / comment `d899b9b0`): `no_expirations` is a SEPARATE defect. Please file it.

The question was whether `no_expirations` and `no_spot` share a root — "one chain fetch feeding
both". They do not, and the code settles it three ways.

**(a) They are mutually exclusive by control flow.** In both scanners the spot check returns
*before* any expiration call is made — `relative-value-scanner.ts:522` and `options-scanner.ts:217`
both `return … reason: 'no_spot'` above the `pickExpiration` / `resolveWindowedExpirations` call. So
**every name counted `no_expirations` provably resolved its spot.** The 60.12% and the 28.31% in
your table are disjoint populations, and no single fetch can be feeding both.

**(b) Different cache, different horizon, different fetch policy.**

| | `no_spot` | `no_expirations` |
|---|---|---|
| store | shared `quoteCache` | `expirationsCache` |
| TTL | 20 s (bound 60 s by the caller) | **6 hours** (`EXPIRATIONS_CACHE_TTL_MS`) |
| on miss | batched refetch, may return nothing | `await client.getExpirations(symbol)`, per-symbol |
| on throw | null ⇒ `no_spot` | trips breaker ⇒ **`fetch_error`, not `no_expirations`** |

So `no_spot` is an oscillating, batch-coherent, all-or-nothing condition, and `no_expirations` is a
**6-hour-sticky, per-symbol, deterministic** verdict that only fires when the broker *answered* and
nothing listed in the DTE window. Opposite signatures. That also explains your `blindScans`
discriminator: a 6h-sticky per-name refusal produces *mixed* ledgers, which is exactly the minority
`blindScans` you measured on `rv_scan` (3/37, 15/108) versus the majority on `otm`/desk-live.

**(c) I checked the obvious alternative and it is wrong — flagging it so nobody re-derives it.** My
first hypothesis was that `rv_scan` uses a stricter threshold: `relative-value-scanner.ts:625`
refuses at `inWindow.length < 2` (a term fit needs a term axis) while `pickExpiration:941` refuses
only at `length === 0`, which would explain your inverted weights exactly. **It does not apply
here.** The `< 2` threshold lives in `scanTermStructure`, the TRA-4413 shadow capture, which is
flag-gated default-off and observe-only and does not write `rejectionsByGate`. The `rv_scan` engine
loop calls `rvScanner.scan()`, which goes through `pickExpiration` — the *same* `length === 0`
threshold `otm` uses, on the *same* DTE window. So the 60.12% vs 46.6% inversion is **not** a
threshold difference. On the evidence above it is the same tick-position/warm-cache effect as §1,
plus the fact that `otm` runs under `runBudgetedSweep` and evaluates a *slice* (388 universe → 182
evaluated in the live read) while `rv_scan` walks its universe whole.

**Verdict for your filing: `no_expirations` is a separate defect from the `no_spot` starve.** Please
file it as its own issue. It is worth filing for a reason beyond bookkeeping: `scan:no_expirations`
currently pools "the broker listed nothing in the DTE window" with "the DTE window is mis-sized for
this name", and at 60% of your funnel that pooling is load-bearing.

---

---

## 5. The AC5 tape (QuantTrader's to grade — no verdict is written into the status)

12 distinct `otm` cycles, deduplicated on `lastScan.atMs`, 16:48:48Z → 16:53:12Z, in RTH, serving
`a187fc147ef3`. **Spans two boots — see §1d.** `scan:no_spot` as a share of `universeSize` (AC5's
literal denominator; the share of `candidatesEvaluated` is identical on every cycle where the sweep
was not truncated, and is shown where it differs).

```
boot A  16:48:48  univ=388  eval=158  no_spot=5     1.3% of univ  (3.2% of eval)
boot A  16:49:48  univ=388  eval=149  no_spot=3     0.8%          (2.0%)
boot A  16:50:41  univ=282  eval=118  no_spot=1     0.4%          (0.8%)
boot A  16:50:57  univ=282  eval=282  no_spot=2     0.7%
boot A  16:51:08  univ=282  eval=282  no_spot=2     0.7%
── box restarted 16:51:26.847Z ──
boot B  16:52:29  univ=291  eval=291  no_spot=0     0.0%
boot B  16:52:37  univ=282  eval=282  no_spot=0     0.0%
boot B  16:52:45  univ=282  eval=282  no_spot=0     0.0%
boot B  16:52:54  univ=282  eval=282  no_spot=0     0.0%
boot B  16:53:01  univ=539  eval=539  no_spot=223  41.4%
boot B  16:53:11  univ=168  eval=168  no_spot=118  70.2%
boot B  16:53:12  univ=160  eval=160  no_spot=111  69.4%
```

- Overall: **9 of 12** cycles under 10%.
- Windows of 10 consecutive: **3 available, counts [9, 8, 7]**. Two clear AC5's "≥8 of 10", one does
  not.
- Sampling stopped here because the host went unreachable; RTH runs to 20:00Z, so a longer tape is
  available to whoever wants one.

**My read: still short of a clean pass, and materially better than the 15:34Z tape** (which found a
best window of 6/10). But two of three windows passing and the third at 7 is a *borderline* result
that turns on which 10 cycles you start at, and it straddles a restart. I would not call that a
pass, and per the ticket the call is not mine.

## 6. What this does NOT claim

- It does not grade AC5. See §5 — the ticket says "I will grade this; do not close on my behalf".
- It does not claim the bar-pull overspend causes the blind cycles. §2 shows blind cycles with the
  Tradier quote breaker **closed**, so the two are separable. Filed separately as **TRA-4441**.
- It does not retract the 15 s → 60 s widening. It should not be reverted; §1c says why it helped
  and why it could not be sufficient.
- §1c is a mechanism supported by four independent predictions it gets right (set-shaped drops, the
  universeSize separator, the descending remainder pages, the path ordering) plus a source-verified
  silent-drop path. It is **not** a line-level proof: I did not instrument `fetchQuotes` to record
  which names it dropped on a given cycle. That instrumentation is the obvious next step and is what
  would turn this from well-supported to closed.
- It is ~25 minutes on one box across two boots. Internally controlled and consistent with the
  original filing's separator, but narrow.

---

## 7. The fix this points at (not implemented this beat)

Stated so the next beat does not have to re-derive it. **I did not ship it** — it changes spot
resolution on a live real-money book and it should land with the `fetchQuotes` drop instrumentation
above, so the before/after is measurable rather than asserted.

1. **Make the silent drop loud.** `fetchQuotes` returning short with the secondary dark is currently
   only a coalesced `console.warn`. It should be a counter on the scan-cycle record, which is also
   exactly the AC4 hole my 15:34Z tape named: `blindScans` says a cycle was blind but not *why*, so
   `censusByEtDay` still cannot separate "the feed was dark" from "the strategy declined".
2. **Prewarm the universe once per cycle** instead of `fetchQuotes([symbol])` per name. The scan
   loop knows its whole universe up front; one batched call per cycle both fits the primary's batch
   shape and removes the remainder-page behaviour in §1c.
3. **Do not raise the staleness bound again.** It is already at 60 s and the constraint is refill
   rate, not window width.
