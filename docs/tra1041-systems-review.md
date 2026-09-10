# TRA-1041 — Whole-System Review & Optimization Roadmap

**Author:** CTO · **Date:** 2026-06-23 · **Scope:** make TradeAI (agents ON *and* OFF) run faster, learn faster, improve faster, trade better faster.

Findings are grounded in the codebase (`packages/server` 206 ts, `packages/engine` 113 ts, `packages/agents` 19 ts, `packages/backtest` 89 ts) and the live prod probe `GET /api/health/options-pipeline` (commit `0c04e0d9`, two demo engines, `tradingAgentsEnabled:false` auto-trading confirmed). The three exec-selector sub-flags are verified **OFF** in prod (`optionExecSelectorEnabled/EmaPullback/VolumeBreakout = false`); learned-weight recompute is verified to run **only** in the EOD snapshot path (`index.ts:697`), not on trade close.

This is a candidate roadmap — each item ships flag-gated / behind a validation step. Live-capital promotion stays gated on TRA-382 throughout; nothing here changes that.

---

## Agents ON vs OFF (clarification)
The "Trading Agents" toggle gates **only** the LLM advisory layer + proposal queue (`signal-engine.ts` branch on `tradingAgentsEnabled`). With agents OFF, the deterministic router (ORB, BB-fade, Ichimoku, RV scanner, SMA200, options exec) still runs — this is by design (the prod engines auto-trade with agents OFF). So **runtime + trade-quality optimizations below benefit the OFF path** (the default prod path); **learning-loop + cost-cap items** primarily benefit the ON path. Both paths share the same tick loop and persistence, so the infra wins help everyone.

---

## Axis 1 — Run FASTER (per-cycle latency)
The main loop ticks every 60s over ~89/72-symbol watchlists. Hot spots:

| # | Finding | Anchor | Fix | Impact |
|---|---------|--------|-----|--------|
| F1 | Indicators (EMA/RSI/Donchian) recomputed once **per strategy** per symbol — ORB/BBfade/Ichimoku each recompute the same series | `signal-engine.ts` per-symbol strategy loop (~2017) | Compute a shared per-symbol indicator snapshot once/tick, pass to all strategies | HIGH (~25–35% of signal-eval CPU) |
| F2 | Candle fetches serialized in small batches (5) for daily warmup + minute bars; cold start floods "no data" skips | `crypto-engine.ts` (~1205, ~1214), `signal-engine.ts` SMA200 (~2223) | Raise batch size, async-prefetch daily cache on boot before first tick | HIGH on cold start, MED steady |
| F3 | `refreshOptionMarks()` makes one RV call per open position | `signal-engine.ts` (~2439) | Group calls by (symbol, expiration); one fetch per chain/tick | MED |

These are pure performance refactors with **no behavior change** → cheapest, safest wins. → **child: LeadDev.**

## Axis 2 — LEARN FASTER (feedback loop latency)
| # | Finding | Anchor | Fix | Impact |
|---|---------|--------|-----|--------|
| L1 | Learned weights recomputed **only at EOD snapshot** → mid-session closes don't update live selection weights until next day/restart | `index.ts:697` | Recompute (or incrementally update) on trade-close; cache with short TTL | HIGH (closes outcome→weight loop intraday) |
| L2 | Backtests run only when the analyst emits an EOD hypothesis — no on-demand validation | `backtest-executor.ts`, `hypothesis-pipeline.ts` | `POST /api/backtest` accepting a hypothesis, synchronous grade in <10s | MED (real-time what-if) |
| L3 | Hard `minSamples` cold-start: new structure/IV-band runs at neutral 1.0 until N closes | `learned-signal-weights.ts`, `learned-option-weights.ts` | Weak Bayesian prior / cross-asset transfer to start learning immediately | MED |

→ **child: LeadDev (L1/L2 mechanics), QuantTrader signs off on L3 priors.**

## Axis 3 — IMPROVE FASTER (promotion velocity)
The promotion gate is a 3-stage manual bottleneck (backtest pass → paper pass → human sign-off). For routine single-parameter nudges this overnight+board latency dominates.
- **Recommendation:** an **auto-accept tier** for low-risk hypotheses (single-param move within a bounded %, ≥N validated paper trades, no regime shift) that applies to **demo/paper only**, with board review reserved for structural / leverage changes and all live transitions. This preserves the TRA-382 live invariant while removing the human gate from incremental demo tuning.
- This is a **policy** change → I'll raise it to the board via interaction rather than ship it unilaterally.

## Axis 4 — TRADE BETTER (signal/exec quality)
| # | Finding | Anchor | Fix | Impact | Status |
|---|---------|--------|-----|--------|--------|
| T1 | Structure-aware exits + EMA-pullback + volume-breakout exist but are OFF | `option-exec-flag.ts` (all 3 default OFF) | Validate ON in shadow/paper | HIGH | **already in flight — TRA-1029/1032/1033; do NOT duplicate** |
| T2 | RV options selector filters on open-interest only — no daily-volume / bid-ask slippage gate; IVR floor (≤25) admits illiquid lottery tickets | `relative-value.ts` (~114), `signal-engine.ts` (~2750) | Add `minDailyVolume` + entry-slippage reject; raise IVR floor / OI on cheap chains | MED–HIGH | new |
| T3 | Options risk breaker trips late (−2R / 5%); position sizing fixed (vol-Kelly `enabled:false`) | `options-risk-breaker.ts` (~34), `vol-kelly-sizer.ts` (~76) | Tighten breaker; enable vol-adjusted sizing — **backtest first** | MED | new |

→ **child: QuantTrader (validate T2/T3 in backtest before any flag flip); T1 stays on the TRA-1029 line.**

## Axis 5 — Reliability/Scale (makes "faster" sustainable)
| # | Finding | Anchor | Fix | Impact |
|---|---------|--------|-----|--------|
| R1 | Hot state persisted as full-file JSON rewrites with no transactions: `account-settings`, `agent-spend`, `proposal-store` | `account-settings.ts:125`, `agent-spend-store.ts`, `proposal-store.ts:105` | Migrate to SQLite (Render disk); index by user/date | HIGH (I/O + corruption risk) |
| R2 | Agent-spend cap is read-then-write (TOCTOU) → per-user $/day LLM cap can be breached under concurrency | `agent-spend-store.ts` | Atomic append / mutex around read+write | HIGH (cost control, agents-ON) |
| R3 | Unbounded in-memory growth: proposal queue eviction drops pending audit records at 5k; `dailySignals`/DCA maps not GC'd; full closed-position history reloaded on boot | `proposal-store.ts`, `signal-engine.ts`, `index.ts:800` | Persistent queue + eviction alerts; EOD buffer clear; lazy history load | MED |

→ **child: LeadDev (R1/R2 are correctness, not just perf).**

---

## Disposition / sequencing
1. **F1–F3 + R1–R2** — engineering, no behavior change or pure correctness → LeadDev, ship behind small PRs, verify with targeted benchmarks.
2. **L1–L2** — learning-loop plumbing → LeadDev.
3. **T2–T3** — trade-quality, **backtest-validated before any flip** → QuantTrader.
4. **T1** — stays on the existing TRA-1029/1032/1033 deploy line (no duplication).
5. **Axis-3 auto-accept policy + L3 priors** — board/QuantTrader decision via interaction.

All demo/paper. Live promotion remains gated on TRA-382.
