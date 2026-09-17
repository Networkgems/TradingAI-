# Archived / dormant strategies — TRA-816 (TRA-814 workstream B)

These strategies are **OOS-failed** and are **not wired into any live or demo
router**. They are retained here, not deleted, so the research history is
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

No selectable preset in `packages/shared` (`STRATEGY_PRESETS`) enables any
strategy in this folder, so they are unreachable from the live/demo router.
The retired engine stopped instantiating them in TRA-699; this move (TRA-816)
completed the cleanup by relocating the source.

## What's in here

`momentum`, `breakout-vol`, `macd-trend`, `reversal`, `scalping-strategy`,
`swing-strategy`. (`mean-reversion-crypto` lived here too until TRA-4629
removed the crypto strategy modules outright.)

They remain re-exported from `@trading-app/engine` (unchanged public API) **only**
so the backtest research harnesses (`packages/backtest`) keep compiling.

## Not archived (deliberately)

- **`bb_fade`** — listed in TRA-816 scope, but it is still the **live stock /
  options** BbFade source (`packages/server/src/signal-engine.ts`). Filing a
  live strategy under "archived" would misrepresent reality, so it stays in
  `strategies/`.
- **`supertrend_confluence`** — shadow-only, gate OFF (TRA-728). Left as-is.

## Re-wiring guard

Do **not** wire any strategy in this folder back into a live or demo path until
it clears the TRA-814 §4-C OOS keeper gate on the full universe with the fixed
fee-aware harness (TRA-814 §4-A) plus a walk-forward across ≥2 regime cycles.

See [/TRA/issues/TRA-816](/TRA/issues/TRA-816) and `docs/strategy-turnaround-TRA-814.md`.
