**TRA-2020 ML-classifier feasibility — evidence report (live, 2023-01-01→2026-01-01)**

> MECHANICAL bar only — the five §8 booleans are computed here so QuantTrader can grade in one pass. **This harness does not pronounce the official REAL/KILL verdict.**

**Config:** H=5, 16 features, train 252 / test 63 / warmup 250, slippage 5bps/side, holdout opt 0.7/embargo 10 (≥H). Trials: logreg_C0.1, logreg_C1.0, logreg_C10, gbm_n100, gbm_n200.

#### Locked holdout (the graded surface)

Holdout bars pooled: 392 · opt bars 5744 · gap 2080 · one-shot access OK: ✅

| Model | N | Hit-rate | Net exp (R) | Per-trade Sharpe |
| --- | ---: | ---: | ---: | ---: |
| B0 (always-range) | 0 | — | 0.000 | — |
| **B1 (incumbent rules)** | 245 | 37.5% | -0.075 | -0.067 |
| **logreg_C0.1** *(blessed)* | 232 | 44.0% | 0.062 | 0.048 |
| logreg_C1.0 | 114 | 37.7% | -0.088 | -0.067 |
| logreg_C10 | 170 | 45.9% | 0.217 | 0.145 |
| gbm_n100 | 220 | 39.1% | -0.046 | -0.036 |
| gbm_n200 | 214 | 36.9% | -0.046 | -0.034 |
| _B2 buy&hold (context)_ | — | — | -0.15% total | — |

**Blessed model:** `logreg_C0.1` · margin `E_ml − E_B1 = 0.137 R` · PSR(SR*) 0.435 (SR* 0.058) → ❌

#### Walk-forward (per trial, pooled OOS)

| Trial | Windows | Trades | Mean net R | Sharpe | % windows > 0 |
| --- | ---: | ---: | ---: | ---: | ---: |
| **logreg_C0.1** | 12 | 4021 | 0.101 | 0.070 | 75.0% |
| logreg_C1.0 | 12 | 3350 | -0.005 | -0.004 | 58.3% |
| logreg_C10 | 12 | 3836 | -0.080 | -0.064 | 50.0% |
| gbm_n100 | 12 | 4321 | -0.023 | -0.018 | 41.7% |
| gbm_n200 | 12 | 4482 | -0.029 | -0.022 | 33.3% |

Blessed per-window net expectancy: [0.065, 0.273, -0.161, 0.076, 0.552, -0.097, -0.088, 0.106, 0.015, 0.091, 0.080, 0.329]
PBO = 0.194 (924 CSCV combos, 12 blocks, 5 trials) → ✅

#### PRE-REGISTERED PASS/KILL BAR (§8) — mechanical read (LOCKED HOLDOUT)

1. Net-of-fee margin `E_ml − E_B1 ≥ +0.05R` **and** `E_ml > 0`: ✅ (margin 0.137R, E_ml 0.062R)
2. PBO < 0.25: ✅ (0.194)
3. Deflated/probabilistic Sharpe PSR > 0.95: ❌ (0.435)
4. N ≥ 30 acted holdout trades: ✅ (N=232)
5. Stability — net exp > 0 in ≥60% of walk-forward windows: ✅ (75.0%)

**Mechanical AND of §8 bars: AT LEAST ONE MISS** — any miss ⇒ KILL. QuantTrader confirms and writes the official verdict.

**Notes:**
- MECHANICAL bar only — this harness computes the five pre-registered §8 booleans but does NOT pronounce the official REAL/KILL verdict. QuantTrader grades the frozen bar and writes the verdict (issue hand-off).
- No-lookahead is STRUCTURAL: featureVectorAt(candles, T) computes bar T from candles.slice(0, T+1) only, and the unit test asserts mutating bars > T leaves T byte-identical. Labels read candles[T+1..T+H] and enter TRAINING TARGETS only.
- Label-horizon purge active on BOTH boundaries: the final H=5 bars of every train window are dropped before fitting, and the locked holdout uses embargoBars=10 (≥ H) so the forward label cannot leak across opt→holdout (pre-reg §2 — the highest-risk leak).
- B1 (incumbent rules) is a majority vote of reversal-RSI + MACD-histogram + Supertrend direction, translated on the IDENTICAL §6 R basis (1×ATR risk unit, H-bar horizon, 5bps/side) so E_ml − E_B1 is a same-unit margin rather than a cross-basis subtraction. Flagged for QuantTrader to confirm this operationalization of the frozen B1.
- Anchored (session-less) VWAP: daily bars have no intraday session, so feature 13 is the distance from a VWAP anchored at the start of each point-in-time prefix — slow-moving but strictly causal.
- Per-symbol OOS ledgers are POOLED into one evidence set (earnings-gate pooling pattern); the PBO matrix uses the min window count across symbols so the trial×window matrix is rectangular.