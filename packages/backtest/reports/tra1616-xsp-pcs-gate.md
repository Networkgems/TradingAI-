# TRA-1616 — XSP 1-wide ATM PCS + 20-SMA through the promotion gate (Stage-1)

**Verdict: FAIL — quantitative NO-TRADE.** This is the gate's own six-guard
re-evaluation of the strategy the TRA-1613 / SMB "$100 New Options Strategy" clip
sells, not a hand-typed claim (TRA-527 §3). It confirms the TRA-1613 teardown
(NO-TRADE-as-is) with numbers over every regime the single-bull clip never showed,
per the machine-testable **TRA-1615** spec.

## What was modeled (verbatim from the TRA-1615 spec)
- **Regime filter (§2):** 20-day SMA state machine, one position at a time. ENTRY
  on the clean up-cross (close > SMA20 **and** the prior close ≤ SMA20). EXIT on the
  first of **(E1)** a clean close back below SMA20, or **(E2)** the DTE expiry
  (cash-settle at intrinsic).
- **Structure (§3):** 1-wide ATM put credit spread — sell the first listed strike
  ≤ spot, buy one strike ($1) lower. Width = 1.0 index point = **$100 max structural
  risk**. DTE = 14 calendar (≈ 10 trading) days.
- **Skip rules:** credit must be > 0 or the signal is skipped; a new up-cross while a
  spread is open is ignored (one position at a time).

## Realism (TRA-1615 §1/§4)
- **Data:** real **SPX (^GSPC)** daily bars ÷10 → **XSP** terms (XSP cash-settles to
  SPX/10), 2015-01-01 → 2025-12-30 (2,787 bars incl. Dec-2014 SMA warmup), covering
  Q4-2018, Mar-2020, all-2022, Aug-2024, **Apr-2025**.
- **Pricing:** Black-Scholes (engine pricer) on a realized-vol IV model (VRP 1.05,
  floor 0.10) — the TRA-731 board-ratified synthetic basis (real ≥12mo XSP option
  history does not exist). Identical vol engine to the QQQ-track TRA-1617 so the two
  credit-spread verdicts are apples-to-apples.
- **Costs:** $0.65/contract commission on every leg open and close (full round-trip
  = 4 × $0.65 = $2.60); worthless expiry pays no exit commission. Bid/ask fills with
  a spread that **widens for cheap options**, 1-tick ($0.05) floor on every leg —
  the ATM legs are crossed both ways, eating most of the mid credit (the leg the
  video's mid-price math hand-waves). No mid-price fantasy.
- **E1 cost-to-close cap:** a regime exit's cost-to-close is bounded at the width —
  a defined-risk vertical's remaining max loss is the width, so a rational operator
  holds to expiry rather than paying *more* than that to close. This keeps realized
  R bounded at ~−1 (per-leg proportional slippage on deep-ITM legs would otherwise
  imply an uncloseable >1R loss on a $100-risk spread). Exit commissions still apply.

## Headline (primary params: 14 DTE / ATM / $300 working base)
| Metric | Value |
|---|---|
| Spreads (trades) | 133 |
| Win rate | 37.6% |
| Avg credit | $0.20/share ($20/spread) — the ATM mid credit after crossing two bid/asks |
| **Expectancy** | **−0.40 R/spread (−$32.71/spread)** |
| Total P&L | −$4,350 |
| **Profit factor** | **0.17** — fails Stage-1 minProfitFactor 1.3 |
| **Sharpe (ann.)** | **−2.59** — fails Stage-1 minSharpe 1.0 outright |
| Sortino | −2.14 |
| **Max drawdown** | **1,453%** ($4,359 on the $300 base) — fails 20% ceiling |
| Worst R | −1.04 (bounded at the defined-risk max, as expected) |
| Tail:win ratio | 4.3 : 1 — the negative-skew the teardown named |

## OOS split (IS < 2022-01-01 | OOS ≥ 2022-01-01)
| | IS | OOS |
|---|---|---|
| Expectancy (R) | −0.35 | −0.55 |
| Trade count | 97 | **36** |
| OOS Sharpe (per-trade) | — | −1.02 |

OOS is **worse** than IS (efficiency 0 → G1 fail) and OOS n = **36 < 100** — itself a
Stage-1 FAIL under TRA-527 §Stage-1-minimum, and a direct corroboration of the
teardown's tiny-sample critique. The regime-gated entry simply does not fire often
enough to be a real programme; the spec (§8 sample-size clause) forbids widening the
entry to manufacture trades.

## Regime split (primary)
Every named regime prints **negative** expectancy — there is no benign regime where
this edge survives realistic fills:

| Regime | n | win | exp (R) | worstR | P&L |
|---|---|---|---|---|---|
| 2015-2017 grind-up | 65 | 27.7% | −0.414 | −1.04 | −$2,016 |
| Q4-2018 selloff | 3 | 0.0% | −1.005 | −1.03 | −$248 |
| 2019 recovery | 12 | 66.7% | −0.057 | −1.04 | −$56 |
| 2020-2021 melt-up | 17 | 64.7% | −0.177 | −1.03 | −$289 |
| **2022 bear** | 7 | 14.3% | **−0.880** | −1.03 | −$569 |
| 2023-2024H1 bull | 19 | 36.8% | −0.528 | −1.03 | −$827 |
| 2024H2-2025Q1 | 3 | 33.3% | −0.418 | −1.03 | −$119 |
| 2025 remainder | 7 | 57.1% | −0.359 | −1.03 | −$226 |

## Six-guard overfitting battery (TRA-540)
| Guard | Result | Value | Meaning |
|---|---|---|---|
| G1 — OOS holdout efficiency | **FAIL** | 0.00 | OOS expectancy ≤ 0 (and < 0.5× IS) |
| G2 — Deflated Sharpe (PSR) | **FAIL** | 0.00 | below the 0.95 PSR threshold across the 9 trials |
| G3 — PBO (CSCV, 16 partitions) | PASS | 0.017 | passes only because *every* trial is uniformly negative — no ranking to overfit |
| G4 — Bootstrap OOS floor | **FAIL** | −0.70 | 5% CI lower bound of mean OOS R < 0 |
| G5 — Crisis holdout Sharpe | **FAIL** | −2.24 | crisis-regime (2022 / Aug-24 / Apr-25) Sharpe < 0 |
| G6 — Cost stress (1.5× slip) | **FAIL** | −0.49 | expectancy stays < 0 under stressed fills |

Trial grid (multiple-testing honesty): DTE ∈ {7, 14, 21} × strikeOffset ∈ {ATM,
ATM−1, ATM−2} = 9 trials; primary = {14 DTE, ATM}. Every trial prints negative
expectancy.

**VERDICT = FAIL. GATE (Stage-1) = FAIL** — "optimization verdict FAIL: TRA-540
six-guard battery not all green (failed: G1, G2, G4, G5, G6)."

## Pre-registered kill criteria (TRA-1615 §10) — all tripped
- `profitFactor 0.17 < 1.2` ✗
- `maxDrawdownPct 14.5× > 0.35` ✗
- DSR/PBO fail (G2 fail) ✗
- OOS `tradeCount 36 < 100` ✗

## Why the marketed math misleads
The ATM 1-wide credit is ~$0.50/share at the mid, but you cross **two** bid/asks to
open it — each ~$0.18 on a $4–5 ATM put — leaving only ~$0.20 net. Max structural
loss is (1 − 0.20) × $100 = **$80** against a $20 credit: a **4 : 1 loss:win** payoff
that a ~38% ITM rate (an ATM short put is ~50Δ) and frequent regime-exit closes turn
decisively negative. The 20-SMA close is the only stop and it does not save the
payoff asymmetry. The video's "$100" framing shows the width, not the realistic net
credit or the regime tape.

## Disposition
Ready-to-POST registration body emitted in `tra1616-xsp-pcs-gate.json`:
```
POST /api/promotion/optimization   (admin)
{ strategyId: "xsp_atm_pcs_sma20", reportId: "TRA-1616-xsp-atm-pcs-2015-2025", verdict: {...} }
```
Registering records the **NO-GO**; it flips **no** live flag — Stage-2 (≥50 paper) and
Stage-3 board sign-off still gate any live transition (TRA-532). Given the teardown
verdict and the crisis-window design, FAIL was the pre-registered expected outcome;
this harness makes it the gate's own, quantitative and reproducible.
