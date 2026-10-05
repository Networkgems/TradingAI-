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

## 2. Results

_Filled in after the run; see below._
