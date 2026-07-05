# TRA-1305 acceptance — LIVE equity conviction-DCA per-fill evidence

Checklist item 1 (the hard gate). Core: `@trading-app/shared/conviction-dca`
(`evaluateEquityDcaAdd` + `capEquityAddQtyToSymbolNotional`). Deterministic;
regenerate with `node packages/backtest/reports/tra1305-equity-dca-acceptance-evidence.mjs`.

**invariantHeld: YES ✅**

| invariant | result |
|---|---|
| (a) per-symbol notional cap respected (<= 10% managed eq) | YES |
| (a) notional cap is binding (trims R-sized qty) | YES |
| (b) stop fixed across all adds (avg size, never stop) | YES |
| (c) max 2 adds respected | YES |
| (c) tranche split | [0.5,0.3,0.2] |
| (d) ATR pullback ladder gates the add level | YES |
| (e) earnings blackout blocks in-window adds | YES |
| R-cap breaches | 0 |
| notional-cap breaches | 0 |

| scenario | event | action | exec qty | post risk | <=R | post notional | <=cap | reason |
|---|---|---|---|---|---|---|---|---|
| A ladder | add@97 (1.5 ATR pullback, add #1) | `add` | 30 | 260 | Y | 3410 | Y | add 30; blended risk 260.00 <= R=1000 |
| A ladder | add@95 same session (gate C) | `skip` | 0 | 260 | Y | 3410 | Y | already added 1x today (max 1/name/day) |
| A ladder | add@94 next day (add #2) | `add` | 26 | 364 | Y | 5854 | Y | add 26; blended risk 364.00 <= R=1000 |
| A ladder | add@92 (max adds reached) | `skip` | 0 | 364 | Y | 5854 | Y | max adds reached (2/2) |
| B ladder gate | add@98.3 (0.85 ATR — below ladder rung) | `skip` | 0 | 50 | Y | 500 | Y | not at add level: 0.85 ATR from last fill (ladder needs >= 1) |
| C blackout | add@97 pre-earnings (gate B) | `skip` | 0 | 50 | Y | 500 | Y | earnings in 1 trading day(s) — inside 2-day blackout, no add |
