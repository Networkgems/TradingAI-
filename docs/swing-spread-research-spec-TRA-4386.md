# TRA-4386 — Swing / multi-day defined-risk spreads: research spec + pre-registered backtest plan

**Author:** QuantTrader · **Date:** 2026-09-22 · **Status:** SPEC — no execution surface, no live-path code.
**Mandate:** board card `c4dd383c-3108-4247-8d47-b99329f65c5e` option `e-swing-spec` (2026-09-08T18:50Z), scheduled after the 09-08→09-18 freeze (carrier TRA-4384, `done` 2026-09-22).

## 0. Posture: this spec is written AGAINST the option-book stand-down, not around it

TRA-4750 (2026-09-20, executed 2026-09-22) stood down the option book, **both sleeves**. As of
2026-09-22T22:09Z the box runs `otmArmed:false, rvArmed:false, directionalArmed:false` and the
`PRODUCTION_ENV_INTENT` manifest row is `off`. **Re-opening any option exposure requires board
sign-off.** This document is the research half of exactly that path: deliverable 4 is a board
go/no-go card, and nothing here creates or modifies an execution surface. If every gate below
passes, the *output* is a card, not a position.

### 0.1 The dead list — refuted work this spec does NOT re-litigate

| Verdict | What died | Why it stays dead |
|---|---|---|
| TRA-4569 NO-GO | Intraday single-leg OTM, every delta band | No desk band clears zero; the one "winning" cell was a pooling artifact of pre-TRA-1475 demo tape; the implied re-point had already run live 08-20→09-01 and lost $497 (n=23, CI [−1.21, −0.46]R) |
| TRA-4750 §1 | Maker routing (Lever A) | Maker recovery measured **negative** on both sleeves |
| TRA-4750 §2 | Cost bar as rescue (Lever B) | A filter cannot manufacture edge (TRA-1647) |
| TRA-4750 | Ladder redesign / truncation family | Dominance + budget bound: truncation can only lose fills; OTM's bar 73.6% exceeds its 72.2% fill rate — unreachable even at zero cost |
| TRA-1933 | ICC | Killed net-of-fee |
| TRA-1440 | TSMOM | Killed, n=18 |

None of these are feeders, fallbacks, or comparators here. The single open question the TRA-4750
ruling said it would entertain — *does gross edge cover a full immediate cross?* — is the organizing
question of this spec, asked at a multi-day horizon where the arithmetic differs structurally (§2).

## 1. Strategy spec (deliverable 1)

### 1.1 Structure

**Debit verticals only** (bull call spread / bear put spread). Both legs opened and closed together;
no naked legs, no calendars/diagonals/ratios in v1, no assignment-risk-bearing short legs past
T−5 days to expiry.

- Long leg: 25–40 delta. Short leg: one strike width further OTM.
- Width: chosen so debit ≈ 30–40% of width (max payoff ≈ +1.5R to +2.3R against −1R max loss, R = debit).
- DTE at entry: 10–30 calendar days.
- Notional: irrelevant to the spec (research only); backtest normalizes to 1-lot, P&L in R = debit.

### 1.2 Entry / exit logic

- **Entry:** a multi-day directional signal (see §1.3) fires on an underlying in the liquid-options
  universe (penny-wide or ≤$0.05-wide markets at the 30-delta strike; universe frozen at
  pre-registration, not picked per-trade). Enter at mid ± modeled slippage next session open.
- **Exit, first of:**
  1. profit target: spread marks ≥ +50% of max-profit distance,
  2. stop: spread marks ≤ −50% of debit (thesis-invalidation, defined-risk means this is a soft stop — max loss is −1R by construction),
  3. time: 10 trading sessions held, or
  4. DTE guard: 5 days to expiry.
- **Holding-period distribution (design target):** 2–10 sessions, expected median ~4–5. The backtest
  reports the realized distribution; a realized median < 2 sessions means the strategy has collapsed
  back into the intraday regime whose costs killed the last book, and fails the gate on that alone (§3.4 G5).

### 1.3 Signal feeders — decided by Phase 1, not assumed

Candidate feeders are the signals the desk already computes: the daily-bar trend/regime signals in
`signal-engine`, the relative-value scanner bands (TRA-4344 lineage), and sentiment snapshots.
**No candidate is presumed to have 2–10-day horizon power.** Phase 1 (§3.2) tests each at the target
horizon on underlying returns; only feeders that clear the Phase-1 threshold are eligible inputs to
Phase 2. If none clear, the strategy family dies at Phase 1 without any option data being purchased.
ICC and TSMOM are excluded as feeders (dead list).

### 1.4 New data required

- Phase 1: daily OHLC history for the candidate universe (~2 years). (Availability: see §4.)
- Phase 2: **historical EOD option chain snapshots** (bid/ask/mid, delta, per strike) for the
  universe over the same window. We do not currently persist this; it is the one genuinely new data
  dependency, and it is only fetched if Phase 1 passes.

## 2. Cost model (deliverable 2)

Measured inputs (desk tape, per issue mandate and TRA-4569 §net-of-spread): **$0.196/fill** fees,
**$1.37/contract slippage vs mid** per crossed leg. A vertical doubles the legs.

| Path | Fills | Fees | Slippage vs mid | Total |
|---|---|---|---|---|
| Open + close both legs | 4 | $0.784 | 4 × $1.37 = $5.48 | **$6.26** |
| Open both, expire (no exit fills) | 2 | $0.392 | 2 × $1.37 = $2.74 | **$3.13** |

Conservative choices, stated: slippage is charged **per leg at the measured single-leg rate** — no
credit is taken for native spread-book execution (unmeasured on our tape). Cost is a full round-trip
charge **vs mid, deducted once** (the TRA-4569 rule: never twice).

**costR at candidate debit sizes** (R = debit per 1-lot, ×100 multiplier):

| Debit | costR (4-fill) | costR (expiry) |
|---|---|---|
| $50 (e.g. $1-wide @ 0.50) | 0.125R | 0.063R |
| $100 | 0.063R | 0.031R |
| $150 (e.g. $5-wide @ 1.50) | 0.042R | 0.021R |
| $250 | 0.025R | 0.013R |

**The structural claim this strategy stands or falls on:** the intraday single-leg book paid
costR p50 = **0.335R per round trip** (measured, `/api/health/option-spread-cost` lineage) against
gross edges earned over minutes. A swing vertical at ≥$100 debit pays ≤0.06R against gross edges
earned over 2–10 sessions — the cost is fixed per round trip while the gross-edge budget scales with
holding period. That is a ~5–8× reduction in the bar. **This is an arithmetic fact about costs, not
evidence of edge.** Whether any feeder has 2–10-day edge is precisely what Phases 1–2 measure.

**Cost-aware-gate implication:** under the live methodology (barR = costR + 0.10 safety margin,
TRA-4438), a $150-debit swing vertical would face a bar of ≈ **0.14R** net mean per trade, vs the
0.435R-equivalent the intraday book faced. Phase 0 kill rule: any configuration whose costR + 0.10
exceeds 0.25R (i.e. debit < ~$42) is excluded at pre-registration — small-debit spreads recreate
the intraday cost regime.

## 3. Pre-registered backtest + evidence gate (deliverable 3)

Registered here, BEFORE any backtest is run (TRA-4344 power discipline). Changes after first data
contact void the gate and require re-registration disclosed to the board.

### 3.1 Phase 0 — arithmetic screen (contained in this spec)

Already applied: cost model §2; dead-list fence §0.1; debit floor $42 (costR + margin ≤ 0.25R);
DTE/holding guards §1.2. One-comparison kill checks of the TRA-4750 style ("bar vs fill rate")
will be re-run against any Phase-2 fill assumptions before grading.

### 3.2 Phase 1 — does any feeder predict 2–10-day underlying returns? (equity data only)

- **Statistic:** for each candidate feeder, mean signed forward return (signal direction × 5-session
  forward log return) over **non-overlapping** entry events; one-sample t vs 0.
- **Threshold:** |t| ≥ 2.0, with Bonferroni across the k feeders tested (k declared before running;
  effective threshold p ≤ .05/k). Sign must match the signal's claimed direction.
- **Power:** daily equity vol ~1.2–2%/day ⇒ 5-day sd ≈ 3–4.5%. To detect a 0.75% mean 5-day signed
  edge (a Sharpe ~0.17/event) at 80% power, α=.05 two-sided: n = ((1.96+0.8416)·σ/δ)² ≈
  ((2.8016·4.0)/0.75)² ≈ **224 events per feeder**. Feeders with < 224 available non-overlapping
  events are reported UNDERPOWERED, not passed and not failed.
- **Kill rule:** if no feeder passes, TRA-4386 concludes NO-GO at Phase 1 — no option data is
  acquired, and the board card reports the family dead at the signal layer.

### 3.3 Phase 2 — option-level backtest (only if Phase 1 passes)

- Simulate §1.1–1.2 mechanically on historical EOD chains for passing feeders. Fills at mid ± the
  §2 slippage model; no intraday timing credit; entries next open after signal.
- **Primary statistic:** mean **net** R per trade (net of the full §2 cost, deducted once), one-sample
  t vs 0, computed on the full pre-registered configuration — **no per-cell selection**. Any
  secondary cuts (by feeder, by DTE bucket) are exploratory and cannot flip the verdict
  (the TRA-4569 pooling-artifact lesson).
- **Power / n (priced now):** spread payoff bounded [−1R, +2.3R]; assumed sd(R) = 1.2. To detect
  net mean 0.30R at 80% power, α=.05 two-sided: n = ((1.96+0.8416)·1.2/0.30)² ≈ **126 trades**.
  The gate requires **n ≥ 126** across **≥ 20 distinct underlyings**, entries spanning **≥ 6 months**.

### 3.4 The evidence gate (all must hold)

- **G1** n ≥ 126, ≥ 20 underlyings, ≥ 6 months of entries (per §3.3).
- **G2** net mean R > 0 with t ≥ 2.0 **and** lowerCI95(net mean R) > 0.
- **G3** net mean R ≥ costR + 0.10 (the cost-aware bar, at the configuration's realized mean costR).
- **G4** concentration: top 5 trades ≤ 35% of summed net R; median net R > −0.05R. (TRA-4569:
  a mean carried by a handful of rows is not edge.)
- **G5** realized median holding ≥ 2 sessions (else the strategy is intraday in disguise — auto-fail).
- **G6** cohort integrity: no era/account-class analog — backtest cohorts split by calendar half
  must both be ≥ 0 gross, or the gate reports the split and fails.

**Any gate failure ⇒ the board card is filed as NO-GO with the numbers.** A pass ⇒ the card is filed
as GO-pending-board with this spec attached; only an accepted card creates an implementation child.
There is no path from this research to live code that does not pass through a board card.

## 4. Data availability + execution plan (repo survey, 2026-09-22)

Surveyed this beat; file pointers verified in-tree.

| Need | What exists | Verdict |
|---|---|---|
| Daily bars (Phase 1) | `packages/backtest/data/<sym>.json` — 25 tickers, 45 sessions (2026-07-06→09-04), written by `packages/backtest/src/fetch-tra266-data.ts` (Yahoo, arbitrary lookback); Tradier `/markets/history` also available (`packages/engine/src/tradier/stocks-client.ts:465`) | **Re-pull ~2y deeper — vendor call, no new collection** |
| Signal history (Phase 1) | signal-engine keeps 50 in memory, nothing durable; RV census ledger is counts-only; supertrend shadow ledger (`shadow-signals.jsonl`, with forward TP/SL/timeout outcomes) lives on the Render disk only | **Recompute feeders by replay over bars** (harness exists: `packages/backtest/` runner/walk-forward/replay infra); pull the shadow ledger as a cross-check |
| Sentiment feature | 54 days of daily snapshots mirrored at `packages/backtest/data/sentiment-snapshots/` | Short-window check only |
| EOD option chains (Phase 2) | **75 days already recorded** — `packages/backtest/data/option-chains/` (2026-05-15→09-03, bid/ask/mid-IV per strike, no greeks; delta computable from midIv), pulled from prod via `scripts/pull-recorded-chains.mjs`; `iv-history.json` holds ≤400 daily IV samples/symbol | Covers ~3.5 months. **G1's ≥6-month span is NOT met by data on hand** — Phase 2 grades no earlier than ~mid-Nov 2026 on continued chain capture, unless the board elects to buy historical chains (a cost decision that goes on the card, not made here) |

The gate does **not** bend to the data on hand: ≥6 months stands. The chain recorder must keep
running through the window (it is passive observability, unaffected by the stand-down).

### Execution order

1. **Phase 1 (next step, runnable now):** deepen the daily-bar cache (~2y, existing fetcher), replay
   candidate feeders over it with the existing `packages/backtest` harness, grade §3.2. Research
   scripts only — no server code, no live path.
2. **Phase 2:** only on a Phase-1 pass, on the chain-snapshot window once G1's span is satisfiable.
3. **Board card (deliverable 4):** filed with the graded result either way — GO-pending-board or
   NO-GO with numbers. No implementation child before an accepted card.
