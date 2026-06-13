# Archived / dormant strategies — TRA-816 (TRA-814 workstream B)

These strategies are **OOS-failed** and are **not wired into the live or demo
crypto router**. They are retained here, not deleted, so the research history is
preserved.

## Why they are here

The owner asked us to clean up the system so the codebase reflects reality. Per
the TRA-814 turnaround diagnosis, we carry ~20 strategies and **zero** have a
validated positive out-of-sample edge after costs:

- **TRA-306** (SOL+DOGE, 12 mo): only `bb_fade` showed positive PnL and only on
  SOL — classic regime luck. `momentum` was robustly negative (−$1,489, n=44),
  `macd_trend` −$790, `breakout_vol` −$681; `reversal`/`scalping`/`swing` fired
  zero trades.
- **TRA-523** (43 symbols, OOS 2025→2026, keeper gate = pooled OOS bootstrap p5
  final-equity > 1.0 AND pooled OOS expectancy > 0): **0 of 10 strategy×cost
  pools passed.**

The live engine is halted (`LIVE_STRATEGY_PRESET=no_trade`) and the demo engine
runs **DCA only** (`crypto_core`). No selectable preset in
`packages/shared` (`STRATEGY_PRESETS`) enables any strategy in this folder, so
they are unreachable from the live/demo router. The crypto engine stopped
instantiating them in TRA-699; this move (TRA-816) completes the cleanup by
relocating the source.

## What's in here

`momentum`, `breakout-vol`, `mean-reversion-crypto` (generic mean reversion),
`macd-trend`, `reversal`, `scalping-strategy`, `swing-strategy`.

They remain re-exported from `@trading-app/engine` (unchanged public API) **only**
so the backtest research harnesses (`packages/backtest`) keep compiling and the
dormant `StrategyRouter` continues to type-check. The router itself is no longer
instantiated by any production engine.

## Not archived (deliberately)

- **`bb_fade`** — listed in TRA-816 scope, but it is still the **live stock /
  options** BbFade source (`packages/server/src/signal-engine.ts`). Filing a
  live strategy under "archived" would misrepresent reality, so it stays in
  `strategies/`. It is already unreachable from any *crypto* preset.
- **`supertrend_confluence`** — shadow-only, gate OFF (TRA-728). Left as-is.
- **`crypto-dca`** — the live demo roster. Stays in `strategies/`.

## Re-wiring guard

Do **not** wire any strategy in this folder back into a live or demo path until
it clears the TRA-814 §4-C OOS keeper gate on the full universe with the fixed
fee-aware harness (TRA-814 §4-A) plus a walk-forward across ≥2 regime cycles.

See [/TRA/issues/TRA-816](/TRA/issues/TRA-816) and `docs/strategy-turnaround-TRA-814.md`.
