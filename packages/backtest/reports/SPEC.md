# Backtest §8 Spec — amendments registry

Canonical record of `§8` walk-forward acceptance-bar amendments ratified for
this codebase. Lightweight rolling log — each entry cites the issue thread
where the amendment was ratified; that issue is the source of record. New
amendments append below.

## §8.1 — Universe-aware rolling-90d DD bar (ratified TRA-294)

Source: TRA-294 comment
[`fd10201c-1354-41ab-8206-5c657064accf`](/TRA/issues/TRA-294#comment-fd10201c-1354-41ab-8206-5c657064accf).

> §8 amendment — universe-aware rolling-90d DD bar.
>
> The §8 rolling-90d DD bar SHALL be calibrated per-universe rather
> than as a single global value. For each universe + strategy-params
> combination, the bar SHALL be derived as:
>
>     bar_universe = ceil_to_5pct(p99(synthetic_MC_DD) + 1.5%)
>
> where synthetic_MC_DD is the distribution of max in-window equity-
> drawdowns across n=1000 Monte-Carlo paths of a hardcoded-outcome
> strategy with the universe's spec params: per-trade-risk fraction,
> hit rate, reward:risk ratio, and trade density (trades / window).
> Trade outcomes are i.i.d. Bernoulli(hit_rate) → +reward_R or -risk_R,
> applied as multiplicative steps on current equity. The 1.5% additive
> buffer covers residual intra-trade DD that ATR-stop sizing does not
> absorb.
>
> Rationale: when position sizing is risk-normalised via ATR-stops at
> a fixed per-trade-risk fraction, equity-DD does NOT scale linearly
> with underlying σ — the σ effect is largely absorbed by ATR sizing.
> A simple linear vol scaling (bar = 8% × σ_uni / σ_SPY) over-scales
> and lands at the passive buy-and-hold floor on high-σ universes,
> failing to discriminate active alpha from passive exposure.
>
> For the SOL+DOGE 4H r9 universe (30% hit / 1:2 R:R / 1.0% risk /
> ~38 trades per 90-day window) the resulting bar is 25%. The
> original 8% bar SHALL remain in force on the Phase-1 stock universe
> at its native strategy params.

### First downstream consumer

TRA-296 (`run-tra296-meanrev-long-regime-sweep.ts`) — first §8 sweep where
the 25% DD bar is binding (no longer reported-only). Phase-1 stock-universe
sweeps continue to bind the original 8% bar per the amendment.
