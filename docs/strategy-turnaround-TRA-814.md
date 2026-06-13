# TRA-814 — Trading System Turnaround: Diagnosis, Cleanup & Path Forward

**Author:** CTO · **Date:** 2026-06-13 · **Status:** Decision pending (owner)
**Issue:** TRA-814 "We don't have the right trading plan/strategies"

> Owner's words: *"We have been adding features/trading strategies, nothing is working… 3 months and we are losing money. If you don't get it working, I will shut down the whole company."*

This is the honest, evidence-based read. No spin.

---

## TL;DR

1. **We built ~20 strategies. Zero have a validated, positive, out-of-sample edge after costs.** This is documented in our own backtest reports, not opinion.
2. **The reason we keep "losing money and nothing works" is a process failure, not a missing strategy.** We ship strategies that look good in-sample, they fail live, we ship another. That is the single most common way algo-trading shops die (industry: ~82% of backtest-profitable models fail live; in-sample Sharpe has ~zero predictive power for live results, R²<0.025).
3. **Good news that changes the panic math:** live real-money crypto is already halted (`LIVE_STRATEGY_PRESET=no_trade`, TRA-693) and the money-losing Relative-Value engine was killed 3 days ago (TRA-811). **We are not actively bleeding money on new live trades right now.** The bleed was the *past* live exposure to negative-edge strategies, now stopped.
4. **The fix is to stop adding strategies and impose discipline:** one hard out-of-sample (OOS) gate every strategy must pass before any capital, consolidate to the ONE approach with external + internal evidence of surviving costs (low-turnover trend/time-series momentum on the most liquid majors), and run it on a defined paper→live runway with a kill date.
5. **A bug in our own validation harness** (TRA-523 fee-aware sweep) means our "fee-aware" go/no-go numbers were never actually applying fees. Our decision tooling is partially blind. Fixing this is prerequisite to trusting any future "this one works" claim.

---

## 1. Evidence — what our own reports say

### 1.1 Strategy ranking (TRA-306, SOL+DOGE, 12 mo)
Of 8 strategies wired live, only `bb_fade` showed positive PnL — and only on SOL (+$1,451), driven by a handful of trades during one drawdown-recovery regime (classic regime luck). DOGE was breakeven. Everything else lost money: `momentum` −$1,489 (n=44, the only statistically robust sample — robustly negative), `macd_trend` −$790, `breakout_vol` −$681. `reversal`/`scalping`/`swing` fired **zero** trades.

### 1.2 Fee-aware universe validation (TRA-523, 43 symbols, OOS 2025→2026)
This is the decisive test — the same strategies across the full universe, out-of-sample, with a proper keeper gate (*pooled OOS bootstrap p5 final-equity > 1.0 AND pooled OOS expectancy > 0*):

| Strategy | Trades | OOS Expectancy | Profit Factor | Passes gate? |
|---|---:|---:|---:|:--:|
| `bb_fade` | 969 | **−0.206 R** | 0.75 | ❌ |
| `mean_reversion` | 84 | +0.079 R | 1.15 | ❌ (fails p5) |

**0 of 10 strategy×cost pools passed.** `bb_fade` — our one "winner" from TRA-306 — is **negative even at zero fees** once tested across the universe instead of cherry-picked SOL. Its TRA-306 success was in-sample regime luck, exactly the overfitting pattern the literature warns about.

### 1.3 The harness bug (must fix before trusting any future verdict)
In TRA-523, `bb_fade` expectancy is **identical (−0.2056) across all five cost arms** (gross 0 bps → taker 80 bps). That is impossible if fees were applied to the pooled metric. **Our "fee-aware" sweep is not fee-aware.** Conclusion still holds (it fails even gross), but every future "this strategy is profitable net of fees" claim from this tooling is untrustworthy until fixed.

### 1.4 The current paper strategy (DCA) is also weak
DCA (`crypto_core`, the only thing running, paper-only) showed negative OOS returns on BTC/ETH/DOGE in TRA-695. It is "robust by construction" (can't blow up) but is a bull-market-only accumulator, not an edge.

---

## 2. Root cause

**We optimized for "ship another strategy" instead of "prove one strategy survives reality."**

- No single, enforced OOS gate that capital cannot cross until passed. Strategies reached live/demo on in-sample numbers.
- Validation tooling itself is buggy (§1.3), so even our gate was measuring the wrong thing.
- Breadth over depth: 20 half-validated strategies instead of 1 fully-validated one. Every new strategy adds maintenance + a fresh chance to overfit.
- High-turnover designs (scalping, fade, intraday momentum) on a **40 bps Coinbase taker** cost base — most can't clear the cost hurdle even in theory.

This is not a "we picked the wrong indicator" problem. It is a "we never had a discipline that lets a real edge prove itself and kills the rest" problem.

---

## 3. What the external research says (owner asked: "is there better out there?")

Current (2025) systematic-trading evidence is blunt and consistent:

- **What survives costs:** low-turnover **time-series / trend momentum on the largest, most liquid assets** (BTC/ETH and a short majors list). Lower trade frequency = fewer fee hurdles. Adaptive trend-following with disciplined portfolio construction and a volatility filter is the strongest evidenced retail-accessible approach; pairs/relative-value can be strong on risk-adjusted basis **but ours lost money and is paused** — it would need rebuild + revalidation, not a restart.
- **What kills shops:** high parameter counts, high turnover, many strategies, trusting in-sample Sharpe. ~82% of backtest-profitable models fail live; in-sample metrics barely predict OOS (R²<0.025).
- **Implication for us:** the answer is *not* a 21st exotic strategy. It's fewer parameters, lower turnover, the most liquid assets, and a gate that assumes a strategy is overfit until proven otherwise.

Sources: Wiley *Journal of Futures Markets* 2025 (crypto trading vs passive); arXiv 2602.11708 (adaptive trend-following, crypto, realistic costs); Quantopian 888-strategy study (IS→OOS predictive power); industry overfitting analyses (pickmytrade, BuildAlpha robustness).

---

## 4. Recommendation (the plan)

**Stop adding strategies. Impose one gate. Consolidate to one approach. Defined runway with a kill date.** Four workstreams, sequenced:

**A. Fix the validation harness (prerequisite, blocks everything).** Repair the TRA-523 fee-aware sweep so cost arms actually apply. No go/no-go decision is trustworthy until this is green and re-run.

**B. Clean up — quarantine the dead roster.** Remove the OOS-failed strategies (`bb_fade`, `momentum`, `breakout_vol`, generic `mean_reversion`, `macd_trend`, `reversal`, `scalping`, `swing`) from the live/demo router so the codebase reflects reality. Keep code in an archived/clearly-dormant namespace (not deleted) for research history. Net live roster after cleanup: **DCA only**, until something passes the gate.

**C. Institute the hard capital gate (process, the actual "fix").** Codify a single rule, enforced in code: *no strategy touches demo or live capital until it clears the fixed OOS keeper gate on the full universe with the (fixed) fee-aware harness, plus a walk-forward across ≥2 regime cycles.* This is the discipline whose absence caused the 3 months of losses.

**D. Build the one candidate worth the runway.** A low-turnover, fee-aware **time-series trend-momentum** strategy restricted to the most liquid majors (BTC/ETH/SOL), low parameter count, volatility-scaled sizing (we already have `VolKellySizer`, currently disabled). Validate it through gate (C). If it passes → promote to paper forward-test → board sign-off → live. If it fails the gate → it does **not** ship, and we have an honest, data-backed basis for the wind-down conversation.

**Runway:** Propose a hard 6-week clock from owner go-ahead. If no strategy passes gate (C) and shows positive paper forward-test by then, we recommend winding down rather than burning more capital. A kill date is a feature, not a defeat — it bounds the owner's downside, which is exactly the complaint.

---

## 5. The decision only the owner can make

The engineering plan above is mine to own and execute. But the strategic fork is the owner's, because it's about money and risk appetite, not code:

1. **Continue with discipline (recommended):** fund the 6-week turnaround (A→D). Live stays halted; only paper until something passes the gate. Bounded downside.
2. **Minimal/cash mode:** keep the system halted (no live trades, already the case), do only the cleanup + harness fix, and pause new strategy R&D. Lowest spend, no upside attempt.
3. **Wind down:** if the owner has lost conviction, stop now. We are already not placing live trades, so this is mostly an orderly shutdown, not a fire sale.

I've opened this as a structured question on the issue so the owner can pick the direction; child issues for workstreams A–D are scoped and ready to start the moment direction is set (A and B are safe to start immediately under any "continue/minimal" choice).

---

## 6. Appendix — current system state (as audited 2026-06-13)

- **Live real-money crypto:** HALTED (`LIVE_STRATEGY_PRESET=no_trade`, TRA-693). Not trading.
- **Demo/paper:** DCA (`crypto_core`) only.
- **Relative-Value engine:** KILLED 3 days ago (TRA-811, board TRA-810) for losing money. Existing positions exit normally.
- **Supertrend-Confluence:** shadow-mode only, gate OFF (TRA-728), not validated.
- **Risk layer exists:** `RiskManager` (1% risk, 10% drawdown brake, notional cap), `VolKellySizer` (disabled), global kill-switch (TRA-526). Plumbing is fine; the *signals* are the problem.
- **Brokers:** Coinbase (crypto), Alpaca/Tradier (stocks).
- No live realized-P&L attribution is persisted in-repo; reconciliation is a gap to close if we continue.
