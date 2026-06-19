# TRA-954 acceptance #1 — DCA per-fill evidence

Core: `@trading-app/shared/conviction-dca` (commits 0d56029 + d305bfb, incl. TRA-958 gates A/B/C).
Deterministic; regenerate with `node packages/backtest/reports/tra954-dca-perfill-evidence.mjs`.

**Invariant held (no post-add risk > R): YES** — 3 adds, 5 gated skips, 0 budget breaches across 8 decisions.

| scenario | step | event | action | qty | post-add risk | <=R | reason |
|---|---|---|---|---|---|---|---|
| E equity ladder | 1 | add@97 (1.5 ATR pullback) | `add` | 3 | 71.00 | Y | add 3; blended risk 71.00 <= R=100 |
| E equity ladder | 2 | add@95 same session | `skip` | 0 | — | Y | already added 1x today (max 1/name/day) |
| E equity ladder | 3 | add@94.5 next day | `add` | 2 | 80.00 | Y | add 2; blended risk 80.00 <= R=100 |
| E equity ladder | 4 | add@93 pre-earnings | `skip` | 0 | — | Y | earnings in 1 trading day(s) — inside 2-day blackout, no add |
| E equity ladder | 5 | add@91 below SMA-50 | `skip` | 0 | — | Y | price below trend reference (95) — trend break is an exit, not an add |
| O option call | 1 | add 1x @ delta 0.55 | `add` | 1 | 300.00 | Y | add 1 contract(s); total premium 300.00 <= R=500 |
| O option call | 2 | add @ delta 0.20 | `skip` | 0 | — | Y | add |delta| 0.20 < floor 0.35 — too far OTM for a conviction add |
| O option call | 3 | add @ DTE 18 | `skip` | 0 | — | Y | DTE 18 < 21 — theta-dominated, no add |
