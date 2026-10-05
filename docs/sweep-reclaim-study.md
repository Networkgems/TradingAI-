# Sweep-and-reclaim swing study

## 1. Pre-registration (written and committed before the first run on real bars)

**Question.** On daily equity bars, does the price-action trigger "liquidity sweep and reclaim" produce positive expectancy net of costs? And does it beat the **same bracket placed on random days**?

**Trigger** (`packages/engine/src/indicators/sweep-reclaim.ts`, defaults frozen in `SWEEP_RECLAIM_DEFAULTS`):

- **Zones:** fractal swing pivots with a half-width of 5 bars. A pivot is only used once it is confirmed, strictly before the signal bar (no lookahead; a test pins this). Pivots from the last 180 bars are clustered within 1% of price. A zone needs at least 2 touches.
- **Long signal:**
  - The bar's low pierces a support zone's lower edge by 0.1 to 1.5 ATR(14).
  - The bar closes back above that edge.
  - The close sits in the upper half of the bar's range.
- **Short signal:** the mirror image at resistance.
- **Stop and target:** the stop is the sweep extreme ± 0.25 ATR. The target is the nearest opposing zone, or 2R if there is none.

**Execution** (`packages/backtest/src/sweep-reclaim-backtest.ts`):

- Fill at the next bar's open.
- If the entry bar gaps through the stop or the target, the trade is skipped.
- A later gap through the stop exits at that bar's open.
- If the stop and target are both hit in the same bar, the stop is assumed.
- Time stop after 20 bars.
- One position per symbol at a time.
- Costs are 5 bps per side.

**Data.** The frozen TRA-4386 cache: 26 symbols, about 501 sessions each, 2024-09-24 → 2026-09-23, Yahoo prices adjusted for dividends and splits. This cache has already been used by TRA-4386 for **different** feeders. This trigger has never been run on it.

**Variants (k = 2):**

- **V1:** no trend filter.
- **V2:** SMA(200) trend filter (longs only above it, shorts only below). V2 has about 300 usable sessions per symbol.

No other parameter values will be graded under this registration.

**PASS requires all four of:**

1. n ≥ 100 trades.
2. A date-clustered bootstrap CI of mean net R that excludes 0 at two-sided α = 0.05/k = 0.025. Trades are resampled by entry day, because same-day trades across correlated large-caps are not independent.
3. The real mean net R beats ≥ 95% of 500 placebo books. Each placebo book places the same side, the same stop distance in ATR and the same reward multiple on uniformly random bars of the same symbol.
4. Mean net R > 0 in both chronological halves.

n < 100 is **UNDERPOWERED** (neither passed nor failed). The secondary statistic is the signed forward return over 5 sessions from the next open, on non-overlapping events. It is reported only, for comparison with TRA-4386 Phase 1, and does not decide anything.

**Kill rule.** If neither variant passes, the trigger is not wired into any sleeve. Re-testing it needs a new registration with a new reason, not new parameters on the same data.

**Harness controls** (`sweep-reclaim-backtest.test.ts`):

- **ARM-PLACEBO:** on a pure random walk, the study does not pass.
- **ARM-DETECT:** with a positive drift planted after sweep-like bars, the real book separates from the placebo.
- **Execution model:** next-open fills, gap exits, stop-first, costs and one position per symbol are each pinned by a test.
- **Lookahead:** the series form must equal the prefix form on every bar. This test goes red if the pivot-confirmation guard is removed (mutation verified).

## 2. Results (run 2026-10-04 on the frozen cache; harness commit `6035842e`)

`node packages/backtest/dist/run-sweep-reclaim.js`. The run is deterministic: seeds are fixed and it takes about 0.5 s.

| | V1 no trend filter | V2 SMA(200) filter |
|---|---|---|
| Signals / trades | 293 / 227 | 87 / 69 |
| Net mean R (gross) | **−0.207** (−0.110) | **−0.232** (−0.170) |
| Median R · win rate · profit factor | −1.03 · 33% · 0.75 | −1.03 · 29% · 0.74 |
| Clustered 97.5% CI | [−0.481, +0.097] over 164 days | [−0.786, +0.454] over 52 days |
| Long / short mean R | −0.099 (n=127) / −0.344 (n=100) | −0.038 (n=48) / −0.675 (n=21) |
| First half / second half | −0.109 / −0.303 | −0.406 / −0.073 |
| Placebo mean · p95 · real beats | −0.093 · +0.179 · **21%** | −0.069 · +0.306 · **22%** |
| 5-session forward return (secondary) | n=210, −12.7 bp, t=−0.30 | n=66, +0.2 bp, t=0.00 |
| Exits | stop 116, gap-stop 34, target 51, gap-target 14, time 8 | stop 35, gap-stop 13, target 14, gap-target 4, time 2 |

Diagnostics: median planned reward:risk is 2.0, the median stop is 3.0% from entry, and the median cost is 0.036R (mean 0.097R). 257 of 293 targets came from a real opposing zone.

### Verdict: V1 FAIL, V2 UNDERPOWERED (and negative). The kill rule applies.

1. **The trigger is worse than random entry.** The same brackets placed on random days lose −0.07 to −0.09R. The sweep signal loses −0.21 to −0.23R and sits at the 21st–22nd percentile of the placebo distribution. Picking a day this way slightly hurts.
2. **Costs are not the reason.** Gross mean R is already negative (−0.11 / −0.17), and the median cost is only 0.036R.
3. **The short side is the worst** (−0.34R and −0.68R). That fits a 2024–2026 large-cap tape where fading resistance sweeps fought the drift. The long side is near zero after the trend filter (−0.04R, n=48), which is far too few trades to support any claim.
4. **Gap risk is large.** 15–19% of exits were gaps through the stop, filled at the open beyond it. A bracket that assumes the stop price would overstate results by roughly that much.
5. **It agrees with TRA-4386 Phase 1.** No daily-bar feeder tested on this universe predicts 5-session returns. This one reads t = −0.30 / 0.00.

**Limits of this result.** It covers one two-year, mostly bullish window on 26 mega-cap and high-beta names, using daily bars only. It does **not** show that sweep-and-reclaim never works. It shows that this rule-set has no edge here, and that re-tuning it on this same data would be overfitting.

**What is allowed next.** A *confirmatory* run with the **same frozen parameters** on data this study has not seen is legitimate: a longer history (`--tradier --bars 2500`) or a different universe. Register it as its own study before running it. Changing parameters on this cache until something passes is not allowed.
