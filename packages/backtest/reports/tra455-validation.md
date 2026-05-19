# TRA-455 — SMA-200 Pullback / Reclaim Backtest Acceptance Gate

**Verdict: ❌ FAIL — both signals. Live trading stays disabled.**

QuantTrader-owned validation of the SMA-200 signals built in TRA-451, against the
acceptance gate in the TRA-449 build spec. Harness:
`packages/backtest/src/run-tra455-validation.ts`; raw data:
`packages/backtest/reports/tra455-validation.json`.

## Method

- **Signal core:** the harness imports `evaluateSma200` directly from
  `packages/engine/src/sma200-signals.ts` — backtest math is byte-identical to
  the eventual live path. The spec's 5-bar per-symbol-per-type debounce is applied.
- **Universe:** 40 liquid S&P large caps across all 11 GICS sectors; SPY as the
  buy-and-hold benchmark.
- **Window:** data warmed from 2020-09-01; signals counted **2022-01-01 →
  2026-05-18** (4.38 years — clears the ≥ 3-year requirement).
- **Trade model (long-only, R-multiple):** entry = signal close; stop = signal's
  suggested stop; risk unit `R = entry − stop`. Exit on stop hit, on a 2.5R
  take-profit, or a 50-bar time stop; a bar tagging both stop and target is
  scored as a stop (conservative). 10 bps round-trip slippage charged per trade.
- **Risk-adjusted comparison:** trades sized at 1% account risk, compounded in
  exit-date order into an equity curve; **MAR = CAGR / |maxDD|**. A signal
  "beats buy-and-hold risk-adjusted" when its MAR > SPY's MAR over the same
  window. (Equity curve is a conservative single-slot approximation — parallel
  capital deployment is not credited.)

## Results — primary model (TP 2.5R)

| Metric | Signal 2 — pullback | Signal 3 — reclaim | SPY buy-and-hold |
|---|---|---|---|
| Trades | 56 | 17 | — |
| Win rate | 42.9% | 35.3% | — |
| Avg R / expectancy | +0.09 R | −0.04 R | — |
| **Profit factor** | **1.18** | **0.93** | — |
| CAGR (1% risk/trade) | +1.0% | −0.2% | +10.5% |
| Max drawdown | 11.5% | 4.0% | 25.4% |
| **MAR (CAGR / maxDD)** | **0.09** | **−0.05** | **0.41** |

Universe equal-weight buy-and-hold over the same window: +93.4% total / 16.3%
CAGR / 42.5% maxDD / MAR 0.38.

**Exit breakdown** — pullback: 24 stop / 23 time / 8 target / 1 EOD (only 8 of 56
reached 2.5R; the strategy mostly chops sideways into the time stop). Reclaim:
7 stop / 7 time / 3 target.

## TP sensitivity sweep

| Take-profit | Pullback PF | Pullback MAR | Reclaim PF | Reclaim MAR |
|---|---|---|---|---|
| 2.0R | 1.10 | 0.05 | 1.03 | 0.01 |
| 2.5R | 1.18 | 0.09 | 0.93 | −0.05 |
| 3.0R | 1.30 | 0.16 | 1.08 | 0.03 |

The PF > 1.3 bar is not cleared anywhere in the sweep (pullback only *touches*
1.30 at 3R, not above it). MAR never approaches SPY's 0.41 — the failure is
robust to the exit assumption, not an artefact of the chosen target.

## Ship gate (TRA-449: PF > 1.3 **and** beats B&H risk-adjusted)

- **Signal 2 — Pullback-to-200 bounce: FAIL.** PF 1.18 < 1.3; MAR 0.09 ≪ SPY 0.41.
  Positive but thin edge (+0.09 R) that does not survive costs into a shippable
  profit factor, and capital sat in low-conviction chop — well short of simply
  holding the index.
- **Signal 3 — 200-SMA reclaim reversal: FAIL.** PF 0.93 (losing), expectancy
  −0.04 R, and only 17 fires in 4.4 years — too rare to validate and negative on
  the sample we have.

## Recommendation

Do **not** wire an entry path for `sma200_pullback` / `sma200_reclaim`. Keep both
display-only in `runSma200Scan`. The signals are sound as *context badges* on the
Signals tab but are not tradeable as specified. Findings routed to TRA-451 for a
quant-logic revision (see follow-up issue).
