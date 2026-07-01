# TRA-1217 — Crypto momentum-ignition / "about-to-pop" scanner

**Parent:** TRA-1210 · **Author:** QuantTrader · **Status:** decision-ready (design + fee-aware backtest, no build)
**Harness:** `packages/backtest/src/run-tra1217-ignition.ts` · **Data:** `tra1217-ignition.json`
**Coverage:** 42 liquid majors + mid-cap alts, Coinbase 4H, 2023-05-01 … 2026-06-03 (BULL to 2025-10-06 ATH, BEAR after).

---

## 1. Signal design (scope item 1)

Ported from the TRA-1207/1208 short-squeeze screener (RVOL / breakout / above-MA, observe-only, fail-closed, tunable). Crypto ignition = **coiled range → volume-backed breakout in an uptrend**:

1. **Donchian breakout** — close > highest-high of the prior `donchLen` bars.
2. **Squeeze** — pre-breakout channel width < `squeezePct` of price (a coiled consolidation).
3. **Volume ignition (RVOL)** — bar volume / SMA(volume, 30) ≥ `rvolMin`.
4. **Trend filter** — close > EMA(50).

**OHLCV-only, same data limit TRA-1211 flagged.** No funding / open-interest / on-chain / social history exists in the harness, so perp-OI surge, funding surge, and social-velocity features are **NOT tested here**. Literature ranks OI+funding surge as the highest-value *addable* feature (perp positioning leads spot ignitions); it should be the first add if this graduates to a build with a perp data feed.

## 2. Fee-aware discrete-trade backtest (scope item 2)

Signal fires on bar **close** → enter **next bar open** (no lookahead) → TP +10/+15%, hard stop −4/−5%, max-hold 12–60 bars. Non-overlapping per symbol. R normalised by stop distance (clean TP tp10/sl4 = +2.5R gross; full stop = −1R minus fees). Two fee arms: **taker 60 bps/side +3 slip** (status-quo Coinbase market) vs **maker 20 bps/side, 0 slip** (limit entry, per TRA-523).

### The decisive result: turnover, not target size, is the binding constraint

The board premise was "big target dwarfs fees, fires rarely → fees don't bind." **Half right.** At the *loose* baseline (RVOL≥3) the scanner fires **~490 trades/yr portfolio-wide** — that is NOT rare — and the ~1.2% round-trip taker cost, multiplied across a 20–30% hit rate, kills it:

| exit | fee | regime | n | t/yr | hit% | exp(R) | med(R) | PF |
|---|---|---|---|---|---|---|---|---|
| tp10/sl4/30b | taker | all | 1461 | 473 | 28.3 | **−0.111** | −1.32 | 0.86 |
| tp10/sl4/30b | maker | all | 1461 | 473 | 28.3 | +0.104 | −1.10 | 1.16 |
| tp15/sl5/60b | taker | bull | 1093 | 449 | 28.0 | +0.065 | −1.25 | 1.08 |
| tp15/sl5/60b | taker | all | 1349 | 436 | 25.9 | −0.021 | −1.25 | 0.97 |

At the loose setting the **median trade loses in every cell** (−1.1 to −1.3R) — the mean is entirely tail-driven, exactly the fragile profile TRA-992 warns against. Taker expectancy is ~0 or negative everywhere; only maker turns it positive, and only in bull.

### Conviction sweep — tightening to "few high-conviction ignitions" *does* rescue it

Fixing exit tp10/sl4/30b (pessimistic) and tightening the trigger (RVOL 3→6, squeeze 14%→8%, Donchian 20→30) cuts turnover to **~48 trades/yr** — genuinely rare — and materially improves quality (5,000-sample seeded bootstrap, 90% CI):

| rvol | regime | fee | n | hit% | exp(R) | med(R) | PF | 90% CI | P(exp>0) |
|---|---|---|---|---|---|---|---|---|---|
| 3 | all | taker | 1461 | 28.3 | −0.111 | −1.32 | 0.86 | — | — |
| **6** | **bull** | **taker** | 122 | 32.0 | **+0.171** | −0.31 | 1.27 | **[−0.057, +0.404]** | **0.89** |
| **6** | **all** | **taker** | 149 | 31.5 | **+0.113** | −0.57 | 1.17 | **[−0.092, +0.328]** | **0.81** |
| 6 | bear | taker | 27 | 29.6 | −0.148 | −1.32 | 0.82 | [−0.625, +0.361] | 0.30 |
| **6** | **bull** | **maker** | 122 | 32.0 | **+0.386** | −0.10 | 1.73 | **[+0.158, +0.619]** | **1.00** |
| **6** | **all** | **maker** | 149 | 31.5 | **+0.328** | −0.36 | 1.59 | **[+0.123, +0.543]** | **1.00** |
| 6 | bear | maker | 27 | 29.6 | +0.067 | −1.10 | 1.10 | [−0.410, +0.576] | 0.58 |

The median also lifts off the floor (−0.31/−0.57 vs −1.32), so it is far less purely tail-dependent than the loose setting.

## 3. Latency / feasibility honesty (scope item 3)

- **No lookahead.** Entry is the bar *after* the signal closes. Across the full exit grid the **pessimistic (stop-first) vs optimistic (TP-first) gap is 0.003–0.02R** — i.e. the "4H bars resolve TP-first optimistically" risk TRA-1211 flagged is **immaterial** here (a 4% stop and 10% TP rarely coexist in one 4H bar). The negative-at-taker finding is **not** a bar-resolution artifact.
- **Maker edge carries a fill-rate caveat.** The confirmed edge lives at *limit* execution, but a limit order at a breakout may not fill on the very ignition it is chasing (adverse selection). The backtest assumes fills; real maker fill-rate must be measured before trusting the maker column.
- **In-sample threshold selection.** RVOL≥6 was picked *because* it scored best across this one 3-year window. n=122–149 is thin. No walk-forward / OOS yet.

## 4. Verdict (scope item 4)

**CONDITIONAL — a real edge exists only at high conviction, and it is confirmed only at maker cost. At status-quo taker cost it is promising but NOT statistically confirmed.** Per the TRA-992 expectancy-with-CI discipline I will not call the taker case a live edge: its 90% CI straddles zero (P≈0.81–0.89) on a thin, in-sample sample.

What *is* solid:
- **Loose / high-turnover ignition loses at taker** — confirmed. Discrete +10-15% targets do **not** by themselves beat fees; turnover discipline does.
- **Strict / low-turnover (~48/yr) ignition is net-positive and significant at maker** (all-regime +0.33R, CI clears 0), promising-but-unconfirmed at taker (+0.11R, CI straddles 0).
- **Bull-only. No bear alpha** at either cost (consistent with TRA-1211's long-only families).
- **Honestly detectable** — no lookahead dependence.

### Recommendation: gated **observe-only capture** build, NOT live sizing

This is the exact profile that the TRA-1207/1208 observe-only pattern was built for. Recommend a flag-gated, demo-first, **no-orders** crypto ignition scanner that:
1. Fires at the strict-conviction params (**RVOL≥6, squeeze<8%, Donchian 30, EMA50 trend, bull-regime gate**) on the 4H cadence.
2. Captures forward outcomes toward +10/+15% TP with −4/−5% stop, **pessimistic** bar resolution.
3. Logs, per fire, **whether a limit entry would have filled** — to measure the maker fill-rate the backtest assumed.
4. Accrues the OOS / forward sample needed to confirm-or-kill the taker-cost CI (currently straddling zero) at **zero capital risk**.

**No live capital** until forward evidence moves the taker-cost expectancy CI clearly above zero. Same observe-only invariant as the rest of TRA-1210.

Open items the build should also fold in: perp OI+funding-surge feature (needs a perp feed), maker fill-rate telemetry, and a periodic re-fit guard against the in-sample overfit risk.
