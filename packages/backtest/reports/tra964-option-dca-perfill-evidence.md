# TRA-964 — options conviction-DCA per-fill evidence (acceptance #1 + #4)

Core: `@trading-app/shared/conviction-dca` `evaluateOptionDcaAdd` (incl. TRA-958 gates A/B/C),
exercised exactly as `SignalEngine.evaluateOptionDcaAdds` builds the context.
R = `riskBudgetPerPosition()` = perPositionCap($50,000) = **$7,500**.
Deterministic; regenerate with `node packages/backtest/reports/tra964-option-dca-perfill-evidence.mjs`.

**Invariant held (no post-add premium-at-risk > R): YES** — 3 adds, 6 gated skips, 0 budget breaches across 9 decisions.

Acceptance #4 demonstrated: rows A/4 (DTE 18 < 21) and A/5 (thesis broken) are blocked.

| scenario | step | event | action | qty | premium-at-risk | <=R | reason |
|---|---|---|---|---|---|---|---|
| A long call | 1 | add @ $1.40 mark, delta 0.55 | `add` | 15 | 2700.00 | Y | add 15 contract(s); total premium 2700.00 <= R=7500 |
| A long call | 2 | add same session | `skip` | 0 | — | Y | already added 1x today (max 1/name/day) |
| A long call | 3 | add @ $1.30 mark next day | `add` | 11 | 4130.00 | Y | add 11 contract(s); total premium 4130.00 <= R=7500 |
| A long call | 4 | add @ DTE 18 (fresh) | `skip` | 0 | — | Y | DTE 18 < 21 — theta-dominated, no add |
| A long call | 5 | add with thesis broken (fresh) | `skip` | 0 | — | Y | underlying no longer confirms thesis — no averaging down on IV crush |
| A long call | 6 | add @ delta 0.20 (fresh) | `skip` | 0 | — | Y | add |delta| 0.20 < floor 0.35 — too far OTM for a conviction add |
| B debit spread | 1 | add 1 lot @ $400 reserved | `add` | 5 | 2400.00 | Y | add 5 contract(s); total premium 2400.00 <= R=7500 |
| B debit spread | 2 | add with daily-loss halt | `skip` | 0 | — | Y | daily-loss limit tripped — all adds blocked |
| B debit spread | 3 | add to short premium | `skip` | 0 | — | Y | not defined-risk (short premium) — DCA refused |
