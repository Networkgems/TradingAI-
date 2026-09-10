# TRA-820 — StockTwits + Options-Flow Signal Study (Step 1)

**Author:** QuantTrader · **Date:** 2026-06-13 · **Graded:** 2026-09-04 (TRA-4360)
**Status:** Step 1 GRADED — **VERDICT: INCONCLUSIVE** (sample bar met; S2 edge absent). See **§7**.
**Parent:** [TRA-814](/TRA/issues/TRA-814) turnaround · **Gates Step 2 on:** [TRA-815](/TRA/issues/TRA-815) (fee-aware harness) + [TRA-817](/TRA/issues/TRA-817) (OOS keeper gate)

> Owner ask (TRA-814): *"find the best options trade strategies using live data and StockTwits data."*
> This issue runs that through the **measure-then-gate** discipline so we do not put real money on an unvalidated signal — the exact pattern that caused the losses.

---

## TL;DR (read this first)

1. **We cannot run the retrospective IC study on our own data today, because we never stored the data.** StockTwits sentiment is held in an **in-memory cache only** (`SignalEngine.socialCache` / `curatedSocialCache`, refreshed every 5 min, reduced on read in `getSocialSentiment`). There is **zero persisted sentiment time series** anywhere in the repo or DB. The literal Step-1 ask ("using our existing StockTwits feed + price history") presumes a history that does not exist.
2. **The live StockTwits API only returns the most recent ~30 messages per symbol** (`fetchStockTwitsStream`, `MAX_MESSAGES = 30`). Even with backward pagination (`?max=<id>`) the unauthenticated stream is rate-limited hard (200/window, breaker on 429) and retains only recent messages — a best-effort retrospective pull buys **weeks, not months**, of tagged-message history for liquid names, with survivorship bias (deleted/aged-out messages are gone).
3. **Options-flow history is reconstructable only forward** from the TRA-376 daily chain recorder's accumulated `<date>/<SYMBOL>.json` partitions (`OptionChainRow` carries `volume`/`openInterest`/`strike`/`optionType`). Tradier serves **no historical chains**. So the *flow-confirmation* half of the signal — the half the literature says actually carries the edge — **cannot be measured retrospectively at all**.
4. **Verdict on Step 1 as written: BLOCKED on data, not on analysis.** The honest path is (a) stand up a tiny daily sentiment-snapshot logger mirroring the chain recorder, (b) let it co-accumulate with the chain snapshots, (c) run the measurement harness specified below once we have ≥ ~20 trading days × the 25-name universe. A best-effort retrospective pull can give a **preliminary sentiment-alone** read now, but it **cannot** test flow-confirmation and must be labelled preliminary.
5. **No live options entry gets wired off StockTwits.** Per the acceptance criterion and the turnaround discipline, nothing trades until Step 2 clears the TRA-817 gate — and Step 2 is gated on a *positive* Step 1, which we do not have and cannot fabricate.

---

## 1. Hypothesis (from the literature anchor)

Sentiment **alone** is mostly noise. The documented, replicated edge appears when **StockTwits bullishness is confirmed by options order flow** (net OTM options volume) — the combination predicts forward returns out to ~20 days. So the study tests **two nested signals**, not one:

- **S1 — sentiment alone:** does daily per-symbol StockTwits `netScore` predict forward returns?
- **S2 — sentiment + flow confirmation:** does sentiment predict returns *conditional on* options flow agreeing (net OTM call vs put volume pointing the same direction)?

The pre-registered expectation: **S1 ≈ 0 (noise), S2 > S1 (edge concentrated in the confirmed subset).** If S2 does not materially beat S1, the idea is dead.

---

## 2. Universe, signal, and forward returns

**Universe.** `EQUITIES_WATCHLIST` (25 names): AAPL MSFT NVDA GOOGL AMZN META TSLA AMD NFLX ORCL INTC QCOM AVGO CRM ADBE PYPL XYZ SHOP COIN MSTR SPY QQQ IWM DIA XLF. Index/ETF names (SPY QQQ IWM DIA XLF) are kept for a sanity baseline but reported separately — single-name flow signals are not expected to work on broad ETFs.

**Sentiment signal (as of each trading day, stamped 15:55 ET to match the chain recorder):**
- Primary continuous signal: `netScore` ∈ [−1, +1] from `aggregateStockTwitsSentiment`.
- Quality filters (drop the symbol-day if not met): `taggedCount ≥ 5` and `freshnessMinutes ≤ 720` — i.e. only days where `tilt` was allowed to be non-neutral. Untagged-but-high `messageCount` days are recorded as a separate "buzz-only" cohort, not folded into the IC.
- Also retain `tilt` (bull/neutral/bear) for the bucketed-return cut and `curatedCount` for a curated-lane robustness split.

**Forward returns (no look-ahead).** Signal is known at 15:55 ET on day *t*; entry is **day *t+1* open** to avoid using the close that partly forms after the signal. Horizons: **1d, 5d, 20d**, measured open(t+1)→close(t+1), open(t+1)→close(t+5), open(t+1)→close(t+20). Close-to-close variants reported as a robustness check only. Returns are excess over the equal-weight universe mean that day (de-market) so we measure cross-sectional skill, not beta.

**Options-flow confirmation signal (S2 only).** From the TRA-376 chain snapshot for the same symbol-day:
- Define OTM: calls with `strike > spot`, puts with `strike < spot`, within the recorder's 14–35 DTE window.
- `netOTMflow = (Σ OTM call volume − Σ OTM put volume) / (Σ OTM call volume + Σ OTM put volume)` ∈ [−1, +1]. Spot from the stamped `spot` or `estimateSpotFromChain`.
- **Confirmed** symbol-day = `sign(netScore) === sign(netOTMflow)` and both magnitudes above a floor (`|netScore| ≥ 0.25`, `|netOTMflow| ≥ 0.10`). S2 IC is computed on the confirmed subset; the disagree/neutral subsets are reported as controls.

---

## 3. Metrics

1. **Information Coefficient (IC).** Per trading day, Spearman rank correlation between the signal and each forward return across the cross-section of symbols. Report **mean IC**, **IC std**, and **ICIR = mean IC / IC std** per horizon, for S1 and for S2's confirmed subset. Pooled (all symbol-days) Spearman reported alongside as a second view.
2. **Bucketed forward returns.** Group symbol-days by `tilt` (bear/neutral/bull) and by `netScore` quintile; report mean and median forward return per bucket per horizon, with bootstrap CIs. The signal is only interesting if returns are **monotone** across buckets in the expected direction.
3. **Confirmed-vs-alone delta.** The headline number: `IC(S2 confirmed) − IC(S1 all)` per horizon. This is what tells us whether flow-confirmation is the carrier of the edge.
4. **Sample bookkeeping.** N symbol-days, N trading days, N confirmed days, per-symbol counts. Any silently dropped cohort is logged, not hidden.

---

## 4. Pre-registered verdict gate (decide BEFORE seeing results)

This is the whole point of the measure-then-gate discipline — the threshold is fixed now so the result can't be rationalised later.

**PASS (edge real enough to scope a gated Step-2 candidate):** ALL of —
- Sample ≥ **20 trading days** and ≥ **300 usable symbol-days** (else → INCONCLUSIVE, keep collecting; not a pass).
- **S2 confirmed** subset: `|mean IC| ≥ 0.03` **and** `ICIR ≥ 0.3` on **≥ 2 of the 3 horizons**, with **consistent sign** across those horizons.
- S2 bucketed returns **monotone** in the expected direction on the 5d or 20d horizon.
- **S2 materially beats S1:** `IC(S2 confirmed) − IC(S1 all) ≥ 0.02` on the horizon(s) that pass — i.e. the edge lives in the flow-confirmed subset, consistent with the literature.

**FAIL (kill the idea, record the negative result honestly):** S1 and S2 are both indistinguishable from zero by the bar above, or S2 does not beat S1. → close the direction on TRA-820, no Step 2.

**INCONCLUSIVE (sample too small):** do not pass, do not kill — continue forward collection until the sample bar is met, then re-evaluate against this same gate.

**Only a PASS unlocks Step 2** (design a sentiment-+-flow OTM candidate on the fixed RV execution layer / TRA-461 and run it through the TRA-817 OOS keeper gate). A PASS is necessary, not sufficient — Step 2 still has to clear OOS after costs.

---

## 5. Data-readiness assessment (the binding constraint)

| Input | Available today? | Source | Note |
|---|---|---|---|
| Daily price candles (open/close) | ✅ yes | existing Yahoo/Tradier daily feeds | full history available |
| StockTwits sentiment **history** | ❌ **no** | in-memory cache only (`socialCache`) | never persisted; this blocks the study |
| StockTwits sentiment **live/forward** | ✅ yes | `getSocialSentiment(symbol)` per refresh | need a snapshot logger to retain it |
| StockTwits sentiment **retrospective** | ⚠️ partial | API `?max=` pagination | weeks only, rate-limited, survivorship-biased; preliminary S1 only |
| Options-flow **history** | ❌ **no** before recorder ran | TRA-376 chain snapshots | accumulates forward; Tradier has no historical chains |
| Options-flow **forward** | ✅ yes | TRA-376 recorder partitions | `volume`/`OI`/`strike`/`optionType` per row |

**Consequence:** the full S2 study (the one that matters) is a **forward-collection** study. The cheapest honest design:
1. **Add a daily sentiment-snapshot logger** — at the same 15:55 ET hook as the chain recorder, append `getSocialSentiment(sym)` for each watchlist symbol to a date-partitioned JSON (`<dir>/<YYYY-MM-DD>/sentiment.json`), mirroring `options-chain-recorder.ts`. Tiny, no new external infra, reuses the existing read path.
2. **Co-accumulate** with the chain snapshots already being recorded.
3. **Run the measurement harness** (§3 metrics, §4 gate) once the §4 sample bar is met (~20 trading days ≈ 4 calendar weeks).
4. **In parallel (optional, now):** a best-effort retrospective StockTwits pull for the most liquid names to produce a **preliminary, clearly-labelled sentiment-alone (S1)** read. This cannot test S2 and does not satisfy the gate; it only tells us early whether S1 is so dead that even forward collection isn't worth it.

This is the disciplined answer, not a stall: we don't have the data because we never kept it, so we start keeping it correctly rather than torturing a biased retrospective sample into a false "edge."

---

## 6. Disposition & delegation

The measurement requires **application code** (a snapshot logger + an offline IC/flow harness), which is Developer/LeadDev's lane, not the quant's. The quant deliverables — study design, signal definition, metrics, and the **pre-registered verdict gate** — are complete in §§1–5 above.

**Delegated to Developer/LeadDev (child issue):**
- **(a)** Daily StockTwits sentiment-snapshot logger mirroring `options-chain-recorder.ts` (date-partitioned `sentiment.json`, fields per §2, wired to the same scheduler hook).
- **(b)** Offline measurement harness in `packages/backtest` that joins sentiment snapshots + TRA-376 chain snapshots + daily candles and emits the §3 tables (IC/ICIR per horizon for S1 and S2-confirmed, bucketed returns, confirmed-vs-alone delta) plus the §4 sample bookkeeping, as a committed report.
- **(c)** Optional: a best-effort retrospective StockTwits backfill (paginated `?max=`) for the liquid subset to seed a preliminary S1 read, clearly labelled non-gating.

**TRA-820 status:** `blocked` on the child issue (data-collection + harness). Unblock owner: Developer/LeadDev. Once (a)+(b) land and ~20 trading days have accumulated, QuantTrader re-runs the harness against the §4 gate and writes the final PASS/FAIL/INCONCLUSIVE verdict here. No live options entry is wired off StockTwits in the interim (acceptance criterion).

---

## 7. VERDICT — first graded run against the §4 gate (TRA-4360, 2026-09-04)

**VERDICT: INCONCLUSIVE.** The accrual constraint is gone — the §4 *sample* bar is met — but the
S2 edge the study was built to detect is not there. This is a **materially different**
INCONCLUSIVE from every prior one: those were INCONCLUSIVE-for-no-data, this is
INCONCLUSIVE-with-the-sample-met.

**Provenance.** Graded on bqb1 commit `f6d72028`, pid 52, `startedAt` 2026-09-04T16:16:52Z. Data
mirrored this run via `scripts/pull-recorded-sentiment.mjs` + `scripts/pull-recorded-chains.mjs`.
Report: `packages/backtest/reports/tra822-sentiment-ic.{json,md}`.

### 7.1 The sample is smaller than the capture counters say

⚠️ **`tradingDaysCaptured: 55` is a partition count, not a data count.** Of the 1,350 recorded
rows, **475 are `outcome: "no_data"`** — 19 trading days (2026-06-15 → 2026-07-08, plus 07-27 →
07-29) wrote a partition where *every* symbol came back empty. Those days are indistinguishable
from healthy ones in `/api/health/sentiment-capture`, whose `latest` block only ever describes the
most recent day.

| Quantity | Health route says | Actually usable | §4 bar |
|---|---|---|---|
| Trading days | 55 | **35** | ≥ 20 ✅ |
| Symbol-days (single-name, `taggedCount ≥ 5` ∧ `freshness ≤ 720m`) | (implied ~1,375) | **685** | ≥ 300 ✅ |
| Chain days joined | 73 | **34** (overlap w/ signal days) | ≥ 1 ✅ |

The bar is still cleared — but by **1.75×** on days and **2.3×** on symbol-days, not the ~4.6× a
naive read of the counters gives. Signal span: **2026-07-09 → 2026-09-03**.

### 7.2 Measured IC (every cell carries its denominator — Amendment 1)

Bar coverage **25/25 symbols, 0 fetch failures**, so no cell below is an unmeasured zero.
`nDays`/`nPairs` are non-zero on every cell reported.

| Horizon | S1 meanIC | S1 ICIR | S1 nDays/nPairs | S2 meanIC | S2 ICIR | S2 nDays/nPairs | S2−S1 Δ |
|---|---|---|---|---|---|---|---|
| 1d | **−0.0622** | −0.31 | 35 / 685 | **−0.0775** | −0.29 | 33 / 381 | −0.0153 |
| 5d | **−0.0822** | −0.36 | 31 / 606 | **+0.0000176** | +0.00005 | 29 / 325 | +0.0822 |
| 20d | **−0.0750** | −0.34 | 16 / 314 | **−0.0725** | −0.24 | 16 / 186 | +0.0025 |

Confirmed (S2) symbol-days: **381**. Buzz-only cohort: 15.

### 7.3 Reading it

1. **S1 is not the noise we pre-registered — it leans *contrarian*.** Sentiment alone carries a
   consistently **negative** de-market IC on all three horizons (bullish StockTwits → subsequent
   underperformance vs the equal-weight universe). Directionally consistent with the retail
   sentiment-reversal literature. It is **not** the "S1 ≈ 0" §1 predicted.
2. **S2 does not beat S1 — flow confirmation *destroys* the signal.** At 5d, conditioning on
   options-flow agreement drives meanIC to **+0.0000176 on 325 pairs** — a measured zero, not an
   unmeasured one. At 1d, S2 is no better than S1. The study's central hypothesis (*the edge lives
   in the flow-confirmed subset*) is **not supported**.
3. **Nothing is statistically decisive, and the horizons are not independent confirmations.**
   Overlapping forward windows make the daily ICs autocorrelated, so raw ICIR overstates
   significance:

   | Cell | t (raw) | effective N | t (overlap-adjusted) |
   |---|---|---|---|
   | S1 1d | −1.81 | 35 | **−1.81** |
   | S1 5d | −1.99 | 6.2 | −0.89 |
   | S1 20d | −1.37 | 1.0 | −0.34 |
   | S2 1d | −1.64 | 33 | −1.64 |

   **No cell reaches \|t\| ≥ 2.** Only the 1d row has genuinely non-overlapping daily observations.
4. ⚠️ **The 20d row is a different subsample from the 1d row.** Forward bars end 2026-09-04, so 20d
   resolves only for signal days **2026-07-09 → 2026-08-07** (16 of 35). "Consistent sign across
   horizons" is therefore substantially the same July data resampled, not three independent looks.
5. **Bucketed returns are non-monotone** on 5d and 20d; 13 of 15 quintile CIs straddle zero.

### 7.4 Pre-registration defect found while grading — flagged, NOT applied

§4 reads `|mean IC| ≥ 0.03` (absolute) **and** `ICIR ≥ 0.3` (signed), and the harness implements
that literally (`sentiment-ic-harness.ts:673`). Since `sign(ICIR) = sign(meanIC)`, a strong,
consistent **negative** IC can never enter `passingHorizons` — so a contrarian edge can reach
neither the PASS branch nor the "shows IC but does not beat S1" FAIL branch, and lands in
INCONCLUSIVE **by construction**. That is exactly the regime S1 is now in.

**This has deliberately NOT been re-graded under an amended gate.** Amending a pre-registered
threshold after seeing the results is the rationalisation the pre-registration exists to prevent.
The verdict above is the gate as written. The asymmetry is raised for board ratification and must
be resolved **before** the next grading run, not after.

### 7.5 Disposition

- **No PASS ⇒ Step 2 stays locked.** No live options entry is wired off StockTwits. Unchanged.
- **Not a FAIL either** — under the gate as codified this is INCONCLUSIVE, and the contrarian S1
  reading is interesting enough that killing the direction now would discard a real observation.
- **Keep collecting**, and **fix the recorder's dead days** — 19 of 54 partitions returning
  all-`no_data` is a ~35% loss of accrual rate that the health route does not surface.
- Re-grade when the sample roughly doubles (~70 usable days), which also lets the 20d horizon
  cover a genuinely out-of-sample span rather than the July subsample.
