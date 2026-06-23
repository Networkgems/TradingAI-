# TRA-1026 - Options Trade Review: Swing-Trading Playbook vs TradeAI

Author: CTO (agent 671785a4)
Date: 2026-06-23
Scope: Compare the swing-options playbook in the TRA-1026 description (Trend
Pullback, Breakout, and the "Essential Rules") against what the TradeAI engine
actually does today, and map every gap to an owner/issue.

## TL;DR

The external best-practice playbook independently re-derives the exact two
remediation themes we already scoped from the TRA-1022 selection-quality
review:

1. **IV control** (buy when IV/IVR is low, avoid high-IV/earnings) -> already
   queued as **TRA-1024** (IVR ceiling + high-IVR defined-risk spread routing +
   hard earnings gate).
2. **Structure-aware exits** (stop below swing low / breakout level, take profit
   at resistance) -> already queued as **TRA-1025** (structure-aware
   evaluateExit for single-leg RV).

So the playbook is, in large part, a confirmation of our existing roadmap.

The playbook adds **two net-new ideas** beyond the current backlog, both of
which should be sequenced AFTER TRA-1024/1025 land:

- An explicit **EMA-pullback entry archetype** (pullback to 9/21 EMA + bullish
  reversal candle). We do not have this on the executing path.
- **Volume-confirmed breakout** entry (breakout close above resistance on
  above-average volume). We have a Donchian breakout path, but it is
  shadow/paper-only and does not include a volume gate.

A **DTE-window reconsideration** (playbook 45-90 DTE for pullbacks) is a tunable
worth revisiting; our executing RV-long window is currently 30-45 DTE.

All live-capital promotion of any of this remains gated on **TRA-382**.

## What the executing path does today (production default)

The path that actually opens RV single-leg long calls/puts
(`runRelativeValueScan -> findRelativeValueOpportunities -> selectRvLongCandidate
-> openOptionFromRvCandidate`, packages/.../signal-engine.ts + relative-value.ts):

- Strike: delta band 0.55-0.65 (floor 0.45) - slightly-ITM/ATM, directional.
- Candidate filter: "cheap-vs-fitted-IV" residual (z <= -2 below the fitted
  skew) and/or below-intrinsic; trend confluence (Supertrend / MA-stack / MACD /
  RSI from the 5m shadow series); DTE 30-45; earnings gate.
- Exits: premium-percent based - stop at -25% of premium (with a $0.05 dollar
  floor), TP1 at +25% (half size), trailing stop armed at +20% / 12% give-back.
- Sizing/risk: ~2.5% budget ratio per ticket, 15% position cap, $150 floor,
  forced 1-contract floor, daily cap of 4 RV contracts in demo.
- IVR gate: NONE in the default prod path. The absolute IVR<=25 ceiling and the
  high-IVR -> defined-risk-spread routing exist in code but are wrapped behind
  `ENABLE_OPTION_EXEC_SELECTOR` (default OFF). That flag's contents == TRA-1024.

Separately, the disciplined **shadow** selector (strategy-selector.ts, TRA-908
Phase A/B) does have a full IVR gate matrix, delta-anchored-to-S/R strikes, a
Donchian breakout -> debit-spread path, and a reversal-at-zone checklist
(TRA-924) - but it is observe-only (Phase A ledger) and demo-paper (Phase B). No
live capital. Phase C (advisory -> capital bridge) is deferred.

Important nuance: "cheap-vs-fitted-IV" is a cross-sectional cheapness measure
(how far an option sits below its own expiration's fitted skew). It is NOT the
same as the playbook's "buy when IV is relatively low" - an option can be cheap
vs its skew while the name's absolute IVR is high. That is precisely why an
absolute IVR ceiling (TRA-1024) is still needed.

## Comparison matrix

Legend: ALIGNED / PARTIAL / GAP. "Owner" is the issue that closes the gap.

### A. Trend Pullback Strategy

| Playbook element | TradeAI today | Verdict | Owner |
|---|---|---|---|
| Setup: leading stock above 21 EMA (daily) | Trend confluence from 5m series (Supertrend/MA-stack/MACD/RSI), not a daily-21EMA leadership screen | PARTIAL | (enhancement) |
| Trigger: pullback to 9/21 EMA + bullish reversal candle | No EMA-pullback trigger on executing path. Closest analog = reversal-at-S/R checklist, shadow-only | GAP (net-new) | new follow-up |
| Contract: ATM/slightly-OTM calls | We use slightly-ITM/ATM (delta 0.55-0.65). Reasonable; we trade a touch more delta for less theta/vega sensitivity | ALIGNED | - |
| DTE 45-90 | Executing RV longs use 30-45 DTE | PARTIAL (shorter) | DTE review |
| Exit: stop below swing low; TP at extension/resistance | Premium-percent stop/TP/trailing; not underlying-structure based | GAP | TRA-1025 |

### B. Breakout Strategy

| Playbook element | TradeAI today | Verdict | Owner |
|---|---|---|---|
| Setup: tight consolidation (flag/cup) | Not on executing path | GAP | (enhancement) |
| Trigger: breakout close above resistance on above-avg volume | Donchian breakout path exists in disciplined selector but is shadow/paper-only and routes to a debit SPREAD; no volume gate | PARTIAL | TRA-1024 (wiring) + new follow-up (volume gate) |
| Contract: ATM 30-60 DTE, avoid front-month | We avoid front-month (longs skip 21-30 DTE); 30-45 fits inside 30-60 | ALIGNED | - |
| Exit: stop below breakout level; scale out at resistance | Premium-percent based; not structural | GAP | TRA-1025 |

### C. Essential Rules

| Rule | TradeAI today | Verdict | Owner |
|---|---|---|---|
| 1. Manage time decay (30+ days buffer) | Longs skip 21-30 DTE, 30-45 window, hard earnings gate (behind exec flag) | ALIGNED | (earnings gate -> TRA-1024) |
| 2. 2% rule (max 2% equity at risk) | 2% default risk fraction; RV budget ratio ~2.5% with 15% position cap | ALIGNED (RV budget slightly above 2%) | tunable |
| 3. Control volatility / buy low IV, avoid high IV + earnings | Executing path is IVR-BLIND in prod (only cross-sectional cheap-vs-skew). Absolute IVR<=25 ceiling + earnings gate exist behind a default-OFF flag | GAP (highest priority) | TRA-1024 |

## Conclusions

1. The playbook validates our post-TRA-1022 roadmap. The single most important
   playbook rule ("control IV") is exactly the gap TRA-1024 closes: turn the
   IVR<=25 ceiling + high-IVR spread routing + hard earnings gate from a
   default-OFF flag into live behavior (pending QuantTrader sign-off).
2. The second playbook theme (structure-aware exits) is exactly TRA-1025.
3. Net-new vs our backlog: (a) EMA-pullback entry archetype, (b) volume-confirmed
   breakout entry, (c) DTE-window review (45-90 for swing). These are candidate
   enhancements to sequence AFTER TRA-1024/1025, because the executing path must
   first become IV-aware and structure-exit-aware before layering new entry
   archetypes on top.
4. No change is recommended to strike selection (our slightly-ITM/ATM band is a
   sound directional choice) or to the 2%/front-month/time-decay discipline,
   which already match the playbook.
5. Everything live-capital remains gated on TRA-382.

## Disposition

- TRA-1024 and TRA-1025 already own the two primary gaps - no duplicates created.
- One follow-up child issue is created for the net-new playbook enhancements
  (EMA-pullback archetype + volume-confirmed breakout + DTE-window review),
  blocked on TRA-1024 so it cannot start before the foundational IV/structure
  wiring lands.
- TRA-1026 (review) closed as done with this document as the work product.

## Addendum - Schwab "Swing Trading" webcast (Mike Fairbourn), board follow-up 2026-06-23

The board reopened TRA-1026 with a Charles Schwab webcast ("anything we can learn
from this?"). Distinctive, implementable content beyond the original playbook:

1. TTM Squeeze as the consolidation/breakout detector. Bollinger Bands compressing
   INSIDE the Keltner Channel = volatility compression; the longer the squeeze
   (filter used: >= 3 consecutive squeeze days), the larger the expected breakout
   magnitude. This operationalizes the Breakout SETUP far more precisely than our
   range-based Donchian path, and gives a magnitude prior, not just a level break.
   - What we have: Bollinger Bands exist only in the equity/crypto mean-reversion
     backtests (macd_bollinger, bb_fade). We have NO Keltner Channel, NO BB-in-KC
     squeeze test, NO squeeze-duration counter, and the options breakout path uses
     Donchian, not the squeeze.
   - Learnable (NET-NEW): add Keltner + the BB-in-KC compression boolean +
     squeeze-days counter as a scan/gate for the options breakout archetype. This
     is the one genuinely new capability in the webcast. Folded into TRA-1028 item 2.

2. Longer-dated options to suppress theta: the webcast buys 4-6 month (~120-180
   DTE) calls even though the move is expected in 3-20 days ("put time on our
   side"). This pushes the DTE-window review past the playbook's 45-90 toward a
   120-180 DTE upper bound. Reinforces TRA-1028 item 3.

3. Delta selection: 0.6-0.7 (slightly-ITM) calls for near dollar-for-dollar
   movement and lower relative theta. This VALIDATES our current strike band
   (delta 0.55-0.65, floor 0.45) - corroboration, no change needed.

4. Defined risk + measured-move targets via bracket orders: stop below the
   flag/breakout level, take-profit at the projected measured move (flag/range
   height projected off the breakout, e.g. the T1/T2 the presenter hit on KMI).
   A concrete underlying-structure target method that feeds TRA-1025
   (structure-aware exits).

Net learning: one new concrete capability worth building - the TTM Squeeze
detector (we already have BB; add Keltner + compression test + squeeze-days) as
the breakout-archetype trigger, with measured-move targets. Everything else
either reinforces existing backlog items (extended DTE, measured-move exits) or
validates current behavior (high-delta ITM strikes). No change to the IV-control
(TRA-1024) priority - the webcast is consistent with it (long premium, defined
risk, low theta).
