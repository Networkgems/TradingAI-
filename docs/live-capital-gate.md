# AI Options Ideas — Live-Capital Gate

**Owner:** Lead Dev · **Reviewer:** QADesigner (methodology) · **Issue:** TRA-601 (TRA-595 C6)

> **The CTO's hard rule: "Gate on evidence, not vibes."** No live capital is wired
> for the "AI Options Ideas" product until the forward-tested track record below
> clears every criterion. This document is the written-down gate; the criteria
> are also the single source of truth in code
> (`packages/server/src/live-capital-gate.ts` → `LIVE_CAPITAL_GATE`). The two are
> kept in sync — change the stance in one place and mirror it here.

## What this gate is (and is not)

- It is an **evidence report that produces a pass/fail verdict**. Evaluating it
  wires **nothing**. There is no order path in or reachable from the gate code.
- A **`passed: true`** result is **permission to *propose* live wiring to the
  board** — not an auto-enable. Any live transition is *additionally* gated by
  the existing per-strategy promotion gate (TRA-532: backtest → paper → sign-off)
  and explicit human sign-off.
- Live auto-execution stays **out of scope** until this gate has passed on a real
  track record, per the approved [TRA-595 plan](/TRA/issues/TRA-595#document-plan).

## How the evidence is produced (methodology)

The pipeline has three layers, all paper / point-in-time — no money moves:

1. **Capture (idea journal).** Every time the live `GET /api/options/ideas` pass
   surfaces a ranked, defined-risk idea, an immutable entry is appended to the
   journal (`options-idea-journal.json`): ticker, strategy, legs, entry net,
   defined max-loss, modeled max-profit, breakevens, model POP, DTE, expiration,
   spot, IV-rank. The entry terms are the **chain-priced mids the panel showed**
   — i.e. a paper fill at the mid. Entries are deduped per
   `(ticker, strategy, expiration, ET surfaced-date)` so the panel's 60-second
   poll cannot inflate the sample. The journal is **joinable to the option-chain
   recorder** (`options-chain-recorder.ts`) by `(ticker, ET date)`.

2. **Score (forward-test).** Each journaled idea is re-priced **only against
   option chains the recorder wrote on/after its surface date** — there is no
   look-ahead.
   - *Resolved* — held to expiry, settled at the **intrinsic value** of its
     (fully specified) legs versus the recorded settlement-day spot.
   - *Open* — marked-to-market at the latest recorded chain that can price every
     leg.
   - *Awaiting data / no data* — past expiry but no settlement chain yet, or no
     forward chain at all; excluded from hit-rate, reported separately.

   Position P/L uses the liquidation identity `pnl = L_now + entryNet`, where
   `L = Σ_legs (buy:+mid, sell:−mid) × 100`. A complete defined-risk structure is
   therefore naturally bounded to `[−maxLoss, +maxProfit]` at expiry; any
   computed breach flags a modeling/data fault (see *defined-risk integrity*).

3. **Report (weekly).** Outcomes roll up by ISO week of the surface date:
   hit-rate, expectancy (USD/1-lot **and** as an R-multiple = P/L ÷ defined
   max-loss), profit factor, POP calibration (realized hit-rate − mean stated
   POP), and max-loss breach count. Served at
   `GET /api/options/forward-test/report`.

## The gate criteria

Live-capital wiring may be **proposed** only when **all** of the following hold
(defaults; see `LIVE_CAPITAL_GATE`):

| # | Criterion | Threshold | Why |
|---|-----------|-----------|-----|
| 1 | **Weeks of evidence** — distinct ISO weeks with ≥1 settled idea | **≥ 8** | ~2 months of weekly forward data; one lucky week is not a track record. |
| 2 | **Sample size** — total resolved (settled) ideas | **≥ 30** | A small-n floor so hit-rate / expectancy are not noise. |
| 3 | **Positive expectancy** — overall R-expectancy (P/L ÷ max-loss) | **> 0** | The edge must be positive *after* normalizing for risk taken. |
| 4 | **Expectancy durability** — fraction of resolved-bearing weeks with positive R-expectancy | **≥ 60%** | The edge must persist across weeks, not come from one outlier. |
| 5 | **POP calibration** — \|realized hit-rate − mean stated POP\| | **≤ 10 pts** | The model's stated probabilities must be honest, not optimistic. |
| 6 | **Defined-risk integrity** — realized losses that breached the stated max-loss | **= 0** | Defined-risk must actually be defined; any breach is disqualifying. |

The verdict and per-criterion booleans (no PII, no per-symbol P&L) are exposed
for acceptance verification at `GET /api/health/live-capital-gate`.

## Disposition when the gate passes

A pass does **not** ship live trading. It unlocks a single next step: **Lead Dev
files a follow-up issue proposing live wiring**, attaching the forward-test
report as evidence, for board / CTO decision under TRA-532 and human sign-off.
Until then the product ships as event-aware, risk-defined **idea generation +
paper entry**, exactly as today.
