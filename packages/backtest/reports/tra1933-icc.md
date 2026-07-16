# TRA-1933 — ICC net-of-fee backtest

_Generated 2026-07-16T03:43:56.416Z. Parent: TRA-1932 (QuantTrader ICC spec)._

**Data window:** 2023-05-01 → 2026-06-02 · **Universe (18):** BTC-USD, ETH-USD, SOL-USD, ADA-USD, DOGE-USD, LINK-USD, AVAX-USD, LTC-USD, BCH-USD, DOT-USD, ETC-USD, ATOM-USD, NEAR-USD, ARB-USD, OP-USD, XRP-USD, UNI-USD, XLM-USD

> No 15m data on disk; top-down structure realised as daily(HTF,resampled from 4H)/4H(LTF). Coarser entry TF ⇒ LESS fee drag, so a net-of-taker KILL here is robust (15m would be worse). Costs: taker 60/80bps, maker 10/25bps, slippage 3bps/side.

## Pre-registered gate (net-of-taker, primary config: daily→4H, k=2, regime+R:R filters ON)

- ❌ net-of-taker expectancy > 0
- ✅ n >= 40
- ❌ >= 2 regimes positive
- ✅ realized R:R >= 1.3

### VERDICT: **KILL (documented; same discipline as TSMOM at n=18)**

Failed the pre-registered net-of-taker gate; the fee-vulnerable continuation profile does not clear the bar.

## Primary config — cost-arm sweep

| cost arm | n | expectancy (R) | win% | realized R:R | Sharpe | Sortino | maxDD (R) |
|---|--:|--:|--:|--:|--:|--:|--:|
| gross_0 | 390 | 0.0495 | 33.3 | 2.15 | 0.031 | 0.062 | -17.67 |
| maker_both_10 | 390 | 0.0084 | 33.3 | 2.02 | 0.005 | 0.010 | -21.87 |
| maker_entry | 390 | -0.1313 | 32.3 | 1.74 | -0.082 | -0.137 | -58.09 |
| taker_60 | 390 | -0.2094 | 32.3 | 1.57 | -0.131 | -0.203 | -86.65 |
| taker_80 | 390 | -0.2915 | 32.3 | 1.41 | -0.181 | -0.263 | -116.92 |

### Primary config — taker-60 expectancy by regime

| regime | n | expectancy (R) |
|---|--:|--:|
| trend_up | 253 | 0.0322 |
| chop_down | 137 | -0.6555 |

## Sensitivity — net-of-taker (taker_60) expectancy across all configs

| HTF/LTF | swingK | regimeFilter | rrFilter | n | taker60 expectancy (R) | gross expectancy (R) |
|---|--:|:--:|:--:|--:|--:|--:|
| daily/4H | 2 | on | on | 390 | -0.2094 | 0.0495 |
| daily/4H | 2 | on | off | 653 | -0.2049 | 0.0171 |
| daily/4H | 2 | off | on | 555 | -0.2188 | 0.0495 |
| daily/4H | 2 | off | off | 921 | -0.2065 | 0.0233 |
| daily/4H | 3 | on | on | 232 | -0.3043 | -0.0767 |
| daily/4H | 3 | on | off | 427 | -0.1931 | -0.0012 |
| daily/4H | 3 | off | on | 328 | -0.2357 | -0.0004 |
| daily/4H | 3 | off | off | 613 | -0.1482 | 0.0504 |
| 4H/4H | 2 | on | on | 519 | -0.5201 | -0.2306 |
| 4H/4H | 2 | on | off | 2656 | -0.3129 | -0.0594 |
| 4H/4H | 2 | off | on | 606 | -0.5489 | -0.2439 |
| 4H/4H | 2 | off | off | 3292 | -0.3060 | -0.0478 |
| 4H/4H | 3 | on | on | 297 | -0.6210 | -0.3738 |
| 4H/4H | 3 | on | off | 1750 | -0.3012 | -0.0832 |
| 4H/4H | 3 | off | on | 349 | -0.5970 | -0.3407 |
| 4H/4H | 3 | off | off | 2179 | -0.2880 | -0.0642 |

## Method notes
- **Indication:** HTF close breaks the most recent confirmed fractal swing (k={2,3}). Impulse leg L0→H1 over ≤12 HTF bars.
- **Correction:** valid when an LTF close lands in the [0.382, 0.786] Fib retrace of (H1−L0). Any close beyond L0 invalidates (no flip).
- **Continuation:** first LTF close beyond the correction's micro-swing (fractal k). Stop = correction extreme ∓ 0.1×ATR(14); target = H1; R:R filter ≥ 1.5.
- **Fills/exits:** entry at the trigger close; intrabar stop-first when both stop & target print on one bar (conservative). Time-stop after 90 LTF bars.
- **Fees in R:** round-trip (entryPx·fEntry + exitPx·fExit)/risk subtracted from gross R. Regimes tagged by BTC daily 200-SMA (trend_up / chop_down).
