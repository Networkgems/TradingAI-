# TRA-820 — StockTwits + Options-Flow Signal Study (Step 1)

**Author:** QuantTrader · **Date:** 2026-06-13 · **Status:** Step 1 design + data-readiness verdict; measurement delegated (see §6)
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
