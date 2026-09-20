# TRA-4739 — StockTwits / Unusual Whales / "is there better live market data?"

**Author:** CTO · **Date:** 2026-09-19 · **Owner ask:** *"Read through these sites and see if the free
version is worth it, is there something else out there that gives live market data better to make better
watchlist and signals. What about StockTwits?"*

All vendor prices below were read off the vendors' own pages on **2026-09-19** and must be re-verified
before any purchase. All measurements of our own system were taken this run against bqb1 live commit
`f511ede2` (`startedAt` 2026-09-19T23:35:55Z) and are reproducible from §7.

---

## 0a. Board decision — settled 2026-09-20

Card `35590c81` on TRA-4739, resolved by the board **2026-09-20T00:00:48Z**. All three answers took the
recommended option; none of them spends money.

| Question | Answer | Status |
|---|---|---|
| Paid market data | **A — keep the free feed, spend nothing** | Standing. The StockTwits accrual continues at $0; no vendor, no card, no approval. |
| The curated StockTwits lane | **A — drop it** | **Shipped 2026-09-20** — see §2.3. |
| A wider, dynamically screened universe | **A — yes, but after the cost work** | Queued behind the execution-cost work, not started. |

Two consequences worth stating plainly, because they are the parts that could be misread later:

- **"Keep the free feed" is not "revisit this in November."** The re-grade condition is a *sample-size*
  condition (~70 usable days, ≈ late November at the measured rate), and it is owned by TRA-820, not by this
  issue. Nothing here re-opens on a date.
- **"After the cost work" is a dependency, not a deferral.** The wider universe is queued behind the
  execution-cost work because widening a funnel whose candidates are already 195-of-200 starved by cost gates
  adds noise rather than trades. It is filed with that blocker attached so it cannot be picked up out of order.

---

## 0. Answer first

| Ask | Verdict |
|---|---|
| StockTwits **free** version | **Already running, already graded — keep it, it costs $0, but do not expect signal from it.** We have had it wired since TRA-602, we persisted 65 days of it, and we measured it against a pre-registered gate on 2026-09-04: **no edge** (TRA-820 §7). |
| StockTwits **paid / commercial** API (`api-docs.stocktwits.com`) | **Not buyable.** Stocktwits' own developer portal: *"we unfortunately won't be accepting new registrations until we have finished our review."* There is no public price. Nothing to evaluate. |
| **Unusual Whales** API | **No.** $150/mo (Basic) or $375/mo (Advanced) buys the *exact* thesis — sentiment/flow confirmation — that **our own measured data already rejected**: conditioning on options-flow agreement drove our 5-day IC to **+0.0000176 on 325 symbol-day pairs**. We would be paying $1,800–4,500/yr for a better version of a signal we measured at zero. |
| "Something better for live market data" | **We already have real-time.** Tradier's streaming NBBO has been armed on bqb1 since 2026-09-19T17:21Z (815 subscriptions) at $0 incremental. Live data is not our gap. |
| So what *is* the gap? | **(a)** execution cost — the spread is **52%** of the measured signal (TRA-4674) and the cost bar is **0.385**, not 0.10 (TRA-4438); **(b)** gate starvation — **195 of 200** candidates never reached scoring (TRA-4575); **(c)** **no historical options chains** to validate anything. No alt-data subscription fixes (a) or (b), and Unusual Whales barely touches (c). |

**Bottom line:** the free StockTwits feed is worth exactly what it costs, and nothing on this slate is
worth money right now. If we ever do spend on data, the thing to buy is **historical options chains**
(§5), not more signal feeds.

---

## 1. What we already run (measured, not recalled)

| Feed | Status today | Incremental cost |
|---|---|---|
| Tradier quotes + chains + **streaming** | live on bqb1 (stream armed 2026-09-19T17:21Z, 815 subs) | $0 — included with the brokerage account |
| Tradier **historical** option chains | **does not exist** — Tradier serves no historical chains | — |
| TRA-376 daily option-chain recorder | accumulating forward only | $0 |
| StockTwits keyless v2 stream | live, recording daily | $0 |
| Yahoo daily candles | live | $0 |

So the honest framing of the owner's question is not "should we buy live data" — we have live data. It is
"would buying *someone's alt-data* make the watchlist and the signals better." That is an empirical
question, and unusually for this kind of ask, **we have already run the experiment.**

---

## 2. StockTwits — the free version

### 2.1 It works, and it is the thing the docs site describes

The "free version" is the key-less v2 stream (`https://api.stocktwits.com/api/2/streams/symbol/{SYM}.json`),
which `packages/server/src/stocktwits-feed.ts` has called since TRA-602. Measured from a residential IP
this run: **HTTP 200, 125,464 bytes, `x-served-by: core-api-v2`**, no key, no account.

From bqb1's Render egress it is **flaky but currently delivering**. Two separate measurements, which say
different things and must not be collapsed:

- The one-shot probe at 2026-09-19T23:43Z read `ok:false, breakerOpen:true` (breaker latched until
  23:46:48Z, `proxyConfigured:false`, egress `74.220.48.175`). Cloudflare/429 pressure on datacenter
  egress is real and is the TRA-1330 story.
- The **recorder**, which is what actually matters, is healthy. Last nine trading days:

| Date | recorded | no_data | usable rows (`taggedCount ≥ 5` ∧ `freshness ≤ 720m`) |
|---|---|---|---|
| 09-04 | 25/25 | 0 | 23 |
| 09-08 | 25/25 | 0 | 23 |
| 09-09 | 25/25 | 0 | 22 |
| 09-10 | 25/25 | 0 | 23 |
| 09-11 | 25/25 | 0 | 20 |
| 09-15 | 25/25 | 0 | 23 |
| 09-16 | 25/25 | 0 | 24 |
| 09-17 | 25/25 | 0 | 25 |
| 09-18 | 25/25 | 0 | 25 |

≈ **23 usable symbol-days per trading day**, zero dead days in this window. The 35%-dead-partition problem
that TRA-820 §7.1 flagged (19 of 54 partitions all-`no_data`) is **not** present in the recent window.
Note the discriminator: I counted `meta.recorded`/`noData` **per partition**, because
`/api/health/sentiment-capture`'s `latest` block describes only the most recent day and cannot see a dead
one behind it.

### 2.2 …and we already graded what it is worth

TRA-820 / `docs/stocktwits-signal-study-TRA-820.md`, graded 2026-09-04 against a gate that was
**pre-registered before anyone saw a number**:

| Horizon | S1 (sentiment alone) meanIC | S2 (sentiment **+ options-flow confirmation**) meanIC | S2 − S1 |
|---|---|---|---|
| 1d | −0.0622 (685 pairs) | −0.0775 (381 pairs) | −0.0153 |
| 5d | −0.0822 (606 pairs) | **+0.0000176 (325 pairs)** | +0.0822 |
| 20d | −0.0750 (314 pairs) | −0.0725 (186 pairs) | +0.0025 |

**No cell reaches |t| ≥ 2** once overlapping forward windows are accounted for. Bucketed returns are
non-monotone; 13 of 15 quintile CIs straddle zero. Verdict: **INCONCLUSIVE** — sample bar met, edge absent.

The one genuinely interesting observation is that S1 leans **contrarian** (bullish StockTwits → subsequent
underperformance), consistent with the retail sentiment-reversal literature — and that the pre-registered
gate, as written, *cannot* pass a contrarian edge (§7.4 of that doc). That asymmetry is flagged for board
ratification and has deliberately **not** been re-graded under an amended gate.

**Consequence for this review:** the free feed's value is as a *continuing accrual* toward the ~70-usable-day
re-grade the study asks for. At 35 usable days on 09-04 plus ~11 trading days since, we are near ~46. At the
measured rate the re-grade condition lands around **late November 2026**. That accrual costs $0 and needs no
decision today.

### 2.3 One cheap defect found while measuring

> **Correction (2026-09-20).** The first version of this section said `curatedCount` is "0 in every
> snapshot." That is **wrong**, and it was wrong in the way this repo keeps getting caught by: I read the
> recent partitions, found 0, and generalised. Re-measured **per partition over the whole series**
> (2026-06-15 → 2026-09-03, 875 recorded symbol-days, 27,180 messages):
>
> - **55 curated messages, not 0** — but that is **0.202%** of the message population.
> - Present on **15 of 35** recorded days, never more than **2** on a single symbol-day.
> - **None at all since 2026-08-18**, which is what the recent-partition read mistook for "always 0".
>
> So the lane was not dead-by-construction; it worked intermittently and its yield was simply far too small
> to pay for nine fetches per sweep against a shared rate-limit breaker. **The recommendation below does not
> change** — it is now supported by a weaker-but-true premise instead of a stronger false one. The crowd lane
> saturates its own 30-messages-per-symbol cap (every dry day lands on exactly 25 × 30 = 750), so curated
> messages were strictly additive and dropping them displaces no crowd read.

`curatedCount` is **near-zero in every snapshot, and exactly 0 since 2026-08-18** (see the correction above).
It is not a broken fetch — all nine curated accounts return 200. Sampling each account's last 30 messages
from a clean IP this run:

| Account | messages | carrying a Bullish/Bearish tag |
|---|---|---|
| JFDI | 30 | 11 |
| JoeyRockets | 30 | 5 |
| howardlindzon, ivanhoff, Jonathan_Morgan, StocktwitsNews, StocktwitsEarnings, Stocktwits, Cryptotwits | 30 each | **0** |

**16 tagged messages out of 270 (5.9%), from 2 of 9 accounts.** The aggregator only scores *tagged*
messages, and a tagged message must also carry a symbol entity to be attributable — the intersection of
those two conditions is what holds the lane down to 0.202%. It is not adding a "smart money" overlay to
anything. Either drop it, or count untagged curated messages as a separate buzz term. That is a
study-design call for QuantTrader (one-line change either way), not a platform bug.

**RESOLVED 2026-09-20 — the lane is dropped** (board card `35590c81`, option A). Shipped in
`getCuratedStockTwitsAccounts()`, which now returns `[]` by default; `CURATED_STOCKTWITS_ACCOUNTS`
resurrects it and `DEFAULT_CURATED_STOCKTWITS_ACCOUNTS` is retained as the documented seed list. Nine
account fetches per sweep are gone from both call sites (the engine's paired social sweep and the daily
snapshot recorder).

One thing the drop had to not do: make itself invisible. `curatedCount: 0` on a recorded row now means two
different things either side of 2026-09-20 — "nine accounts were polled and contributed nothing
attributable" (the 20 dry days before) versus "nobody was polled" (every day after) — and those are
identical in the data. So `_meta.json` now carries `curatedLane: {status, accounts}` and the recorder logs
it, letting the eventual TRA-820 re-grade partition the series on the retirement rather than infer where the
composition changed. `describeCuratedLane()` is the single source of that value, and a test asserts the two
states cannot share one.

---

## 3. StockTwits — the commercial API (`api-docs.stocktwits.com`, the News Feeds tag)

Stocktwits' own developer portal states they are reviewing their APIs, documentation and terms and
**"won't be accepting new registrations until we have finished our review."** No public price, no self-serve
signup, no published rate limits. Third-party resellers (RapidAPI, scrapers, "whisperer" APIs) exist but
are re-wrappers of the same public stream with someone else's terms on top.

There is therefore nothing to buy, and — given §2.2 — nothing we would buy if there were. The **News Feeds**
endpoints the owner spotted are a headline product; our catalyst handling already runs off `earnings-store`
and `catalyst-gate`, and a headline feed does not address the cost or starvation constraints.

---

## 4. Unusual Whales

**What it is:** 100+ endpoints / 19 categories — options flow with Greeks and OI, dark-pool prints, GEX
and gamma/charm/vanna exposure, Market Tide / net premium, congressional and insider trades, screeners,
seasonality, news, WebSocket streaming, and an MCP server.

**Price (2026-09-19):**

| Tier | Price | Limits |
|---|---|---|
| API Basic | **$150/mo** | 120 req/min, 40,000 req/day, 2-year lookback |
| API Advanced | **$375/mo** | 120 req/min, unlimited daily REST, 2-year lookback |
| Enterprise | from **$750/mo** (Kafka $3,000/mo) | custom |

7-day free trial. **API access is a separate subscription from the regular UW membership** — a UW website
subscription does not include it. There is **no free tier**.

**Why it is a no, on the merits and not on the price:**

1. **We already tested its core thesis and it failed.** UW's headline value is options flow as confirmation
   of a directional idea. TRA-820's S2 arm is precisely that construction, built from our own recorded
   chains, on 381 confirmed symbol-days — and flow confirmation did not add edge; at 5d it drove the IC to
   a **measured zero**. UW's data is cleaner and per-trade rather than daily-aggregate, so it is not a
   byte-for-byte refutation — but it is the only direct evidence either of us has, and it points down.
   Buying the subscription is proposing to re-run a failed experiment at $1,800/yr.
2. **It does not touch the binding constraint.** Our measured problem is that **the spread eats 52% of the
   signal** (TRA-4674) against a **0.385** cost bar (TRA-4438), and that **195 of 200** candidates are
   starved before scoring (TRA-4575). A better idea generator makes the starvation worse, not better: we
   are not short of candidates, we are short of candidates that survive costs.
3. **The 2-year lookback is short for validation.** Two years of flow does not give us the historical option
   **chains** (§5) we actually lack, and two years spans one regime.
4. **It is an opinionated derived product.** Their gamma/flow classifications are computed by them, not
   reproducible by us, and we cannot re-derive a number we cannot see the inputs to — which is the one thing
   this program has repeatedly paid for learning.

If someone wants to test it anyway, the honest design is: take the **7-day trial**, record flow snapshots
for the 25-name watchlist, and *extend the existing TRA-820 harness* with UW flow as the S2 confirmer
instead of our recorded chain volume. Same pre-registered gate, same horizons. That is a week of accrual on
a free trial and a harness we already own — it would be the first evaluation of a data vendor this company
has done against a pre-registered threshold. **But seven days of accrual cannot clear the study's ≥20-day
sample bar**, so it would produce a directional read, not a verdict, and it would need a payment method on
file, which the board has declined (§6).

---

## 5. "Is there something better?" — what I would buy if we bought anything

Not a signal feed. A **historical options chain** archive. That is the one gap that blocks work we are
already trying to do: TRA-820's re-grade, TRA-4727's promotion evidence (n=6 priced of 22 journal rows), and
every "would this strategy have worked" question, all of which currently wait on forward accrual because
**Tradier serves no historical chains.**

| Vendor | Price (2026-09-19) | What it gives us | Fit |
|---|---|---|---|
| **ThetaData** | $40 / **$80** / $160 per mo | Standard: OPRA NBBO quotes + chain snapshots, historical | **Best fit.** Cheapest route to real historical chains. |
| **ORATS** | $99/mo delayed (20k req) · $199 live · $399 intraday | EOD historical chains **with Greeks**, 98 computed indicators | Good, pricier, more derived. |
| **Databento** | pay-as-you-go $/GB, **$125 free credits**, Standard $199/mo | OPRA historical + live, raw | **Already board-approved at a $750 one-time ceiling** (TRA-2041) — but unspendable, see §6. |
| Polygon.io (now Massive) | Stocks $29 delayed / $79 / $199 real-time; options priced separately | Broad coverage, WebSockets | Fine for **universe breadth**, not needed for live quotes. |
| Unusual Whales | $150–375/mo | derived flow/GEX, 2-yr | Does **not** solve this gap. |

On **watchlist breadth** specifically — our universe is a hard-coded 25 names (`EQUITIES_WATCHLIST`). Widening
it is an **engineering** job, not a purchase: Tradier quotes a symbol list, and Yahoo daily candles already
feed our screens. A paid daily-bar plan (~$29/mo) would make a broad daily screener tidier, but is not
required to build one. **Do the engineering before spending anything here.**

---

## 6. Governance — none of this is purchasable today

`docs/external-spend-register.md`, board card `09bee410` on TRA-3020 (2026-08-06):

> **No external spend is authorised while go-live sign-off (TRA-1648) is outstanding.**

The board ruled a **slate** of four and approved exactly one — the ~$5–7/mo StockTwits egress proxy. Norgate,
an external validator, and *putting a payment method on file for Databento* were all declined. The register
is explicit that re-opening a single row as "circumstances have changed" misreads the ruling: the board
declined a slate **on a precondition**, and the precondition is go-live sign-off, not elapsed time. **If the
posture is to be revisited, the posture is what gets revisited — not this line item.**

So: UW at $150/mo, ThetaData at $80/mo and a UW trial that needs a card on file are all **outside the
authorised envelope**, independent of whether they are good ideas. The $750 Databento ceiling remains
*committed-but-unavailable* — authorised, unspendable, not headroom.

---

## 7. What I recommend (ranked, cheapest first)

1. **Keep the free StockTwits feed running and change nothing about it.** $0, accruing ~23 usable
   symbol-days/day, re-grade condition (~70 usable days) lands ≈ late November 2026. **← default; needs no
   decision.**
2. ~~**Decide the curated lane** (QuantTrader, one line): drop it, or score untagged curated messages as
   buzz.~~ **DONE 2026-09-20 — dropped** (board card `35590c81`, option A). It contributed 0.202% of the
   message population and nothing at all after 2026-08-18; see §2.3.
3. **Resolve the TRA-820 §7.4 gate asymmetry before the re-grade, not after.** The gate as written cannot
   pass a contrarian signal, and S1 is contrarian on all three horizons. This is a board ratification, and
   it must land before the next grading run or the re-grade is pre-decided.
4. **Spend the next engineering hour on cost, not data.** The spread is 52% of the signal and 195/200
   candidates are starved. That is where the money is, and it is free to work on.
5. **If, and only if, the board reopens the spend posture:** the buy is **ThetaData Standard (~$80/mo)** for
   historical option chains — not Unusual Whales. UW's thesis is the one we measured at zero.

**Do not buy Unusual Whales. Do not chase a StockTwits paid tier (it is closed). We already have live market
data; what we lack is history and execution economics.**

---

## 8. Reproduce

```bash
# live host + StockTwits egress right now
curl -s https://tradingai-bqb1.onrender.com/api/health/version
curl -s "https://tradingai-bqb1.onrender.com/api/health/sentiment-probe?symbol=AAPL&egress=1"

# capture health (NB: `latest` describes ONE day — it cannot see a dead day behind it)
curl -s https://tradingai-bqb1.onrender.com/api/health/sentiment-capture

# per-day truth: meta.recorded / meta.noData, and sentiment.symbols[].sentiment.taggedCount
curl -s https://tradingai-bqb1.onrender.com/api/health/sentiment-capture/partition/2026-09-18

# curated-lane tagging rate (no key required)
curl -s -H 'User-Agent: Mozilla/5.0' -H 'Referer: https://stocktwits.com/' \
  https://api.stocktwits.com/api/2/streams/user/JFDI.json
```

**Sources (read 2026-09-19):** [Unusual Whales public API](https://unusualwhales.com/public-api) ·
[Unusual Whales API pricing](https://unusualwhales.com/api_lander) ·
[Stocktwits for Developers](https://api.stocktwits.com/developers) ·
[Stocktwits API docs](https://api-docs.stocktwits.com/) ·
[Theta Data pricing](https://www.thetadata.net/pricing) · [ORATS Data API](https://orats.com/data-api) ·
[Databento pricing](https://databento.com/pricing)

**Internal:** `docs/stocktwits-signal-study-TRA-820.md` §7 · `docs/external-spend-register.md` ·
TRA-4674 (spread = 52% of signal) · TRA-4438 (cost bar 0.385) · TRA-4575 (195/200 starved) ·
TRA-1330 / TRA-1969 (Cloudflare egress) · TRA-2041 / TRA-2052 (Databento ceiling).
