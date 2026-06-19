# TRA-965 demo acceptance — CryptoDCA accumulation per-fill evidence

Caps (QuantTrader sign-off, commit `b159ee1`): `maxSymbolNotionalFracOfManagedEquity = 0.10`, `exitMode = 'hold'`.
Core: shipped `CryptoPaperAccount`; `accumulateDca` ported verbatim from `crypto-engine.ts:1496-1522`.
Deterministic; regenerate with `node packages/backtest/reports/tra965-cryptodca-accumulation-evidence.mjs`.

**Acceptance held: YES** — 7 averaging adds onto ONE growing position; final blended entry 54282.90 over 8 fills, total qty 0.030488; 0 cap breaches (max overshoot $0.0100, within the 6-dp qty rounding step).

Invariants: notional ≤ 0.10 cap = **PASS**; stop held fixed (average SIZE never STOP) = **PASS**; per-leg TP dropped under hold = **PASS**; catastrophe stop still exits = **PASS**; per-symbol cap binds = **PASS**.

| week | add price | action | add qty | total qty | blended entry | stop | fills | notional | 0.10 cap | ≤cap | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 60000 | `open` | 0.000000 | 0.006250 | 60000.00 | 40000 | 1 | 375.00 | 1250.00 | Y | initial held DCA tranche |
| 1 | 58000 | `add` | 0.006944 | 0.013194 | 58947.40 | 40000 | 2 | 765.25 | 1250.00 | Y | full risk-sized add |
| 2 | 55000 | `add` | 0.008333 | 0.021527 | 57419.38 | 40000 | 3 | 1183.99 | 1250.00 | Y | full risk-sized add |
| 3 | 52000 | `add-trimmed-to-cap` | 0.002511 | 0.024038 | 56853.27 | 40000 | 4 | 1249.98 | 1250.00 | Y | add trimmed to per-symbol headroom |
| 4 | 49000 | `add-trimmed-to-cap` | 0.001472 | 0.025510 | 56400.12 | 40000 | 5 | 1249.99 | 1250.00 | Y | add trimmed to per-symbol headroom |
| 5 | 46000 | `add-trimmed-to-cap` | 0.001664 | 0.027174 | 55763.27 | 40000 | 6 | 1250.00 | 1250.00 | Y | add trimmed to per-symbol headroom |
| 6 | 43000 | `add-trimmed-to-cap` | 0.001896 | 0.029070 | 54930.82 | 40000 | 7 | 1250.01 | 1250.00 | Y | add trimmed to per-symbol headroom |
| 7 | 41000 | `add-trimmed-to-cap` | 0.001418 | 0.030488 | 54282.90 | 40000 | 8 | 1250.01 | 1250.00 | Y | add trimmed to per-symbol headroom |
