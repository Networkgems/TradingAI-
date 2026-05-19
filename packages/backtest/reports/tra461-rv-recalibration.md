# TRA-461 — RV scanner selection + options risk recalibration

**Owner:** QuantTrader · **Status:** recommendation, pending CTO review + LeadDev implementation
**Source:** board ask on [TRA-450](/TRA/issues/TRA-450); CTO diagnostic on [TRA-461](/TRA/issues/TRA-461)
**Sweep:** `packages/backtest/reports/tra461-rv-recalibration-sweep.mjs` (`node packages/backtest/reports/tra461-rv-recalibration-sweep.mjs`)

## 1. Confirmed root cause

Every one of the 7 closed-today losers and the 14 still-open positions is a **penny option ($0.05–$0.10 premium)**. At that premium the strategy is mathematically unable to win:

- **Spread dominates the edge.** One $0.01 tick on a $0.05 mark is a 20% spread; round-trip you surrender ~40% of premium to the spread before any thesis plays out. The RV "cheap vs fair" edge at those prices ($0.05 mark vs $0.07 fair) is $0.02/share — smaller than the spread and smaller than the skew-fit error.
- **Percentage stops go sub-tick.** `slPct = 0.25` on a $0.05 option is a $0.0125 stop — less than one tick. A single tick of quote noise ($0.05→$0.04) is −20%, so positions are booked out by microstructure, not by an adverse move. That is exactly the −28% to −80% spread of outcomes in the issue table.
- **Selection floor admits the junk.** `relative-value.ts` `DEFAULTS` are `minMark 0.05 / maxSpreadPct 0.20 / minOpenInterest 50` — a $0.05 floor admits precisely these contracts.

## 2. Sweep design

`tra461-rv-recalibration-sweep.mjs` — 12,000 synthetic premium paths per (mark × risk) cell across 3 regimes (Trending up 30% / Choppy 45% / Crashy 25%). What it adds over the existing OTM sweep:

1. **Tick-quantized observed mark.** A continuous "fair" premium walks under GBM; the broker only ever prints whole-cent marks. This is the mechanism behind the −28%/−50%/−80% closes — quantization noise is a huge % move on a penny contract.
2. **Round-trip spread paid explicitly** — enter at the ask, exit at the bid.
3. **RV edge as a convergence drift** — a `cheap` entry is priced 30% under fair and converges with 55% probability. The edge in *dollars* is what the strategy keeps; at low premium it is smaller than spread + a one-tick stop.

## 3. Sweep results

### Per-entry-mark, current vs proposed risk schedule

| Entry mark | Spread% | WinRate (cur→prop) | Expectancy/ticket (cur→prop) | Stop% (cur→prop) |
|---|---|---|---|---|
| $0.05 | 20% | 24.1% → 25.0% | **−$1.0 → −$1.4** | 41.8% → 0.0% |
| $0.07 | 16% | 35.3% → 40.0% | **−$1.3 → −$1.4** | 46.2% → 0.0% |
| $0.10 | 12% | 36.9% → 40.1% | **−$0.5 → −$1.2** | 44.6% → 0.0% |
| $0.20 | 10% | 38.8% → 44.0% | +$0.3 → $0.0 | 46.0% → 24.1% |
| $0.30 | 10% | 38.9% → 41.6% | −$0.0 → −$0.3 | 44.9% → 35.1% |
| $0.40 | 9% | 41.4% → 43.7% | **+$1.0 → +$1.0** | 45.6% → 40.3% |
| $0.50 | 8% | 46.9% → 49.5% | **+$2.8 → +$2.7** | 45.0% → 39.0% |
| $0.80 | 7% | 48.8% → 51.1% | +$4.1 → +$4.0 | 45.2% → 40.5% |

**Reading:** every penny bucket ($0.05–$0.10) has *negative expectancy under any risk schedule* — the dollar floor zeroes out the microstructure stop-outs there but the trades still lose, because the spread + edge math is upside-down. **The fix is selection, not risk management** — the engine cannot rescue a contract it should never have entered. Expectancy crosses solidly positive only at **$0.40+**.

### Selection-floor sweep (proposed risk schedule)

| minMark | maxSpread% | Buckets kept | Mean expectancy/ticket | Mean win rate |
|---|---|---|---|---|
| $0.05 | 20% | $0.05+ | +$0.4 | 41.9% |
| $0.10 | 15% | $0.10+ | +$1.0 | 45.0% |
| $0.20 | 12% | $0.20+ | +$1.5 | 46.0% |
| $0.30 | 10% | $0.30+ | +$1.9 | 46.5% |
| **$0.40** | **10%** | **$0.40+** | **+$2.6** | **48.1%** |
| $0.50 | 10% | $0.50+ | +$3.3 | 50.3% |

Expectancy/ticket rises monotonically with the floor. $0.40 captures the bulk of the improvement (+$2.6 vs +$0.4 at the current floor) while still admitting enough of the chain to keep the scanner productive; $0.50 squeezes a little more but starts to thin the candidate set materially.

`slPct` 0.25 vs 0.30 was tested at $0.40+ and is a **wash** (expectancy $1.0 vs $1.0 at $0.40; $2.8 vs $2.7 at $0.50) — so `slPct` stays 0.25 and the new robustness comes from the dollar floor, not a wider percentage stop.

## 4. Recommended values

### A. RV selection filters — `relative-value.ts` `DEFAULTS`

| Param | Current | **Recommended** | Rationale |
|---|---|---|---|
| `minMark` | 0.05 | **0.40** | Expectancy crosses positive at $0.40; one tick is only 2.5% of premium here, vs 20% at $0.05. |
| `maxSpreadPct` | 0.20 | **0.10** | At a $0.40 mark, 10% = $0.04 round-trip ≈ a small fraction of a real 25–40% RV edge. |
| `minOpenInterest` | 50 | **250** | A contract you may have to exit on a stop needs real depth; 50 OI admits names with no exit liquidity. |

### B. RV risk schedule — `RV_RISK_PARAMS` (`packages/shared/src/index.ts`)

| Param | Current | **Recommended** | Rationale |
|---|---|---|---|
| `slPct` | 0.25 | **0.25** (unchanged) | Sweep shows 0.25 vs 0.30 neutral once junk is filtered. |
| **`slDollarFloor`** (new) | — | **$0.10** | Stop *distance* = `max(premium·slPct, slDollarFloor)`. Guarantees a stop is never sub-tick. At `minMark 0.40` it is essentially non-binding (0.40·0.25 = 0.10) — pure insurance for imports / edge cases below the floor. |
| `tp1Pct` | 0.40 | 0.40 (unchanged) | RV winners are 30–80% gains; partial-take at +40% is appropriate. |
| `trailActivatePct` | 0.25 | 0.25 (unchanged) | Tested fine. |
| `trailOffsetPct` | 0.15 | 0.15 (unchanged) | Tested fine. |
| `budgetRatio` (`RV_OPTIONS_BUDGET_RATIO`) | 0.03 | **0.02** | Reconciled with the recommended 2% live risk-per-trade (see D) so demo and live size consistently. |

### C. Auto-management of imported positions — TRA-361

Imported Tradier positions with **`premiumPaid` (or current mark) below the RV `minMark` floor ($0.40)** must **not** be auto-managed — the engine cannot risk-manage a sub-floor contract (its stop would be sub-tick, which is the original failure mode). `applyImportedRiskThresholds` should gate on the floor: below it, take the existing no-auto-manage path (`tp1Premium = +∞`, `stopLossPremium = 0`, trailing off) and leave the contract for the user. At or above the floor, apply the RV schedule with the dollar stop floor.

### D. Risk-per-trade (4%)

`DEFAULT_ACCOUNT_SETTINGS.riskPerTrade` is already `0.01` (1%) in code — the **4% is the live account's saved AccountSetting**, not a code default, so cutting it is an operator settings change, not a code change. On a small live book, 4% over-sizes each ticket and compounds drawdown when win rate is poor.

- **Recommendation:** operator lowers the live **Risk Per Trade to 2%**.
- **Reconciliation:** with `RV_OPTIONS_BUDGET_RATIO` moved to `0.02` (item B), demo RV sizing (3%→2%) and the recommended 2% live sizing line up.
- **Optional, flagged for board:** a hard cap on `riskPerTrade` for options sizing (e.g. ≤2–3%) so a fat-finger settings save can't re-introduce 4%+ tickets. Not in this change set — board call.

## 5. Expected impact

With `minMark $0.40` the entire penny-option population in the TRA-461 table is **no longer eligible for entry**. Mean expectancy/ticket on the admitted set moves from +$0.4 (current floor) to **+$2.6** (sweep, §3). The dollar stop floor removes the sub-tick-stop failure mode for any contract that does slip through (and for legacy imports above the floor). Imports below the floor are left for the user rather than churned by an engine that cannot risk-manage them.

## 6. Handoff

Implementation (engine `DEFAULTS`, shared `RV_RISK_PARAMS` + new `slDollarFloor`, server `applyImportedRiskThresholds` gate + RV open-path stop, tests) is delegated to LeadDev under a child issue. CTO reviews the resulting PR before merge per the TRA-461 deliverable.
