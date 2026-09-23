# TRA-4782 — the Tradier stream runs ~40s behind, and the instrument that was supposed to say so could not

Spun out of TRA-4656, whose **AC #1 (quote latency < 500ms from the exchange timestamp)** failed its
first live RTH grade by about 80x.

## What was measured

Mon 2026-09-22, 19:52–19:55Z, bqb1 `9472ced3fdc6`. Per symbol,
`latencyMs = receivedAt − max(biddate, askdate)`:

| | |
|---|---|
| p50 | **35.6 – 46.1 s** |
| p95 | 49 – 55 s |
| under the 500ms budget | **2 of 786** quoted symbols |
| throughput | ~1085 quotes/sec |

The data arrives. It arrives ~40 seconds late.

**Both benign explanations are already ruled out — do not re-derive them.**

* **Not trade sparsity.** SPY 35571ms, TSLA 35558ms, QQQ 35613ms, NVDA 35830ms, MSFT 34235ms at the
  same instant. Mega-caps quote continuously.
* **Not clock skew.** Server `generatedAt` vs the Render edge `Date` header over three probes:
  +918 / +458 / +580 ms. And the whole cohort drifts *together* (41.4 → 46.1 → 45.3 → 35.6 s over
  101 s), which a constant offset cannot do. It is a shared backlog.

## The experiment (the deliverable is a branch, not a fix)

`TRADIER_STREAM_SYMBOL_LIMIT` is a cap on the subscribe frame. **During the experiment** it was
opt-in — unset was the identity: the fleet union (822 symbols today), in exactly the order it
always had.

> **Superseded 2026-09-23 (TRA-4656).** The experiment closed with the branch named (our fan-out;
> see the result below), so the default flipped: **unset now means the default bound
> (`DEFAULT_STREAM_SYMBOL_LIMIT`, 25)**, a garbage value fails *closed* into that bound (plus
> `symbolLimitError`), and uncapped requires the explicit opt-out
> `TRADIER_STREAM_SYMBOL_LIMIT=none`. Dropping the env row can no longer resurrect the 40s regime.

```
TRADIER_STREAM_SYMBOL_LIMIT=25      # the most-liquid 25, ladder-first
```

Re-measure p50 at the next RTH open:

* **p50 collapses under 500ms** ⇒ the cause is **our 822-symbol fan-out / consumer backpressure**.
  The remedy is a bounded subscription, and TRA-4656 AC #1 is reachable on this path.
* **p50 stays ~40s on 25 liquid names** ⇒ the cause is **vendor-side on `/markets/events`**. AC #1 is
  not reachable on this path as configured, and the decision (a different Tradier product, a
  different vendor, or renegotiating the AC) goes to the board rather than being absorbed silently.

Either branch is a result. The close condition is a **re-run of the TRA-4656 grade with the branch
named** — never "tuned it and it looks better".

**Result (2026-09-23, in-RTH re-grade, TRA-4656 comment `1202db97` / TRA-4782 comment `bf09619c`):
the first branch.** At N=25 the per-symbol p50 read 276–708ms across 10 reads vs the uncapped
control's 35,600–46,100ms — a 51–100x collapse. The backlog was our 822-symbol fan-out. A ~0.3–0.7s
delivery-path floor remains on the session WebSocket itself (the feed already speaks
`wss://ws.tradier.com/v1/markets/events`, so "switch to the websocket" is not an available lever),
which is why AC #1 as written (<500ms p50) grades marginal-FAIL at N=25 while p50 <1s holds.

### How the 25 are chosen

`STREAM_LIQUIDITY_LADDER` in `packages/server/src/tradier-stream-status.ts` is a **curated static
ordering**, not a measured one — the server has no ADV table at boot. Its only contract is *these
names quote all session*, which is what kills the sparsity confound. SPY/QQQ/NVDA/TSLA/AAPL are
ranks 0–4, so the capped arm contains the exact rows whose 35.6s p50 is the thing being explained.
Nothing downstream may read the ladder as a claim about relative liquidity.

If the cap exceeds how many ladder names the books actually watch, the rest is back-filled from the
tail — and the payload says so, in `symbolsFromLadder` / `symbolsOffLadder`.

## Second, independent defect: the since-boot counters could not be the instrument

`maxLatencyMs` read **10859825298** — 125 days. It is one row: **FLYYQ**, a halted ticker whose
`eventTime` is `1779224400000` (2026-05-21), captured in the connect-time snapshot. ANY, ATAI and
APGE are the same shape.

Because `eventTime = max(biddate, askdate)`, **a halted book is byte-identical to extreme feed
latency**. `maxLatencyMs` and `quotesOverLatencyBudget` (79.2%) were silently mixing "we are late"
with "this ticker stopped trading in May".

The fix **segregates rather than clamps** (`packages/engine/src/feed/tradier-stream-feed.ts`):

| field | meaning |
|---|---|
| `latencySanityBoundMs` | 600000 (10 min). Far above any plausible transport backlog — the incident itself was 46s — and far below a halted book's staleness. |
| `quotesLatencyGraded` | rows that entered the statistics. **The denominator for `quotesOverLatencyBudget` — not `quotesReceived`.** |
| `quotesWithStaleEventTime` | segregated: stamp older than the bound. A halted/delisted book. |
| `quotesWithFutureEventTime` | segregated the other way: stamp ahead of receipt by more than the bound. |
| `latencyP50Ms` / `latencyP95Ms` | **the AC's instrument.** Over the trailing `latencySampleSize` graded rows (ring capacity 5000), so it is a moving window, *not* a since-boot fold. |
| `maxLatencyMs` | still a since-boot high-water mark. Correct, and **not** an instrument for a percentile question. |

Invariant, asserted in the suite:
`quotesReceived === quotesLatencyGraded + quotesWithStaleEventTime + quotesWithFutureEventTime`.
**A suppression ships a counter** — an excluded row is never silently dropped, and it keeps its true
per-row `latencyMs` alongside a `staleEventTime: true` label on `/api/market-data/stream` and in
`TradierStreamPanel.tsx`.

### Reading the wire without re-creating the bug

Every new field is **three-valued** and must be read that way:

* **absent** — the server predates the field (not deployed).
* **`null`** — published, nothing measured yet.
* **number** — a measurement. `0` is a legitimate latency.

⛔ `latencyP50Ms ?? 0` turns "never deployed" into "perfect latency". The desktop panel renders these
as `not published` / `no sample` / `<n>ms` for exactly this reason.

The same rule covers the cap. Since the TRA-4656 default flip: an unset `TRADIER_STREAM_SYMBOL_LIMIT`
and a *garbage* one both resolve to the default bound (25). Only `symbolLimitError` tells them
apart, and it is non-null exactly when a present value was refused. `symbolLimit: null` now appears
only under the explicit `none` opt-out.

### What the sanity bound is, and what it is not

600000ms is calibrated against the RTH p95 of 49–55s — roughly 10x headroom. It is a **broken /
extreme exchange stamp** discriminator, not a halted-ticker oracle. Measured on the live uncapped
payload at 21:47Z on 2026-09-22 (post-close), 118 of 790 quoted rows exceeded it: **4 by more than a
day** (FLYYQ 126.0d, APGE 19.6d, ATAI 11.6d, ANY 5.6d — the ticket's four), 31 between an hour and a
day, and 83 between 10 min and an hour. Post-close the boundary population is expected to swell:
quoting stops, and the newest frame a thin name got may be a snapshot stamped long before receipt.

So the counter is not decoration — it is the check on its own bound. **If `quotesWithStaleEventTime`
is large during RTH, the bound is doing more than segregating dead books and the verdict must be
re-read, not published.**

## Operating the experiment

⛔ **Grade inside RTH only.** `scripts/tra4782-grade-stream-latency.mjs` refuses outside
13:30–20:00Z Mon–Fri, and below 50 gradeable rows, because a post-close read produces a p50 off a
handful of frames that **reads identically to an RTH grade**. The script's own first live run, at
21:47Z, printed `p50=918ms` off `n=63` — a number that would have read as "the cap nearly fixed it".
Outside the window the verdict is `BLIND` (exit 3), never `PASS` and never `FAIL`; `--allow-outside-rth`
prints the numbers and leaves the verdict `BLIND`.

```bash
node scripts/tra4782-grade-stream-latency.mjs --samples=4 --gap=30
#   0 PASS · 1 FAIL (a RESULT) · 2 usage · 3 BLIND
```

It reports **two** p50s, and they answer different questions. `PER-SYMBOL` is the median over each
subscribed symbol's latest quote — the 2026-09-22 control's own method, and therefore the one the
before/after comparison must be made on. `FEED SAMPLE` is the server's `latencyP50Ms` over the
trailing quote *frames*, so it is frame-weighted: a hot mega-cap counts many times and a thin name
once. Quoting one where you mean the other is how a 786-symbol median and a 5000-frame median end up
in the same sentence.


```bash
# 1. the code must be live BEFORE 13:30Z on the grading day
node scripts/render-redeploy.mjs --commit=<sha>      # outside the 13:25-20:00Z Mon-Fri freeze
pnpm check:deploy-drift                              # 0 = CURRENT; anything else, stop

# 2. single-key env upsert. NEVER PUT /env-vars - that verb replaces the whole set (TRA-2136).
#    An env write does not auto-deploy; re-deploy the SHA already serving to apply it (TRA-3724).

# 3. verify by VALUE, not by presence (TRA-2163)
GET /api/market-data/stream
#   symbolLimit: 25 · symbolLimitError: null · subscribedSymbols: 25 · symbolsBeforeLimit: 822

# 4. grade in RTH, off latencyP50Ms - NOT maxLatencyMs
```

## Not a live-money hazard

The stream has no consumer. `index.ts` starts it and registers the read-only GET; nothing subscribes
to its quotes, and the module imports no order client. The options sleeve and TRA-4657 paper trading
run on their own quote paths. The flag stays **on** so the defect stays measurable, and the cap is
**opt-in** so an unset environment keeps today's behaviour exactly.
