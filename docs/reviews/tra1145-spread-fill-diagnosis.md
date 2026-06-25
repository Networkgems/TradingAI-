# TRA-1145 — Why the 5 option spread strategies never filled the paper book

Parallel workstream 3 of 4 from TRA-1137. Acceptance: root cause named + a fix
(or a documented reason the spreads correctly stand down).

## TL;DR

The five coded spread strategies (`bull_put_spread`, `bear_call_spread`,
`iron_condor`, `debit_spread`, plus the reversal-biased credit verticals) are
**not** broken in `selectStrategyKind()`. Two compounding causes kept them out of
the paper journal:

1. **Data gap (dominant, self-resolving):** IV-rank was `null` (honest unknown)
   for essentially the entire journal history, so every spread correctly stood
   down on `iv_rank_unknown`. The trailing-year IV store only began accruing on
   2026-05-15 and needs `MIN_IV_SAMPLES = 20` trading days before
   `ivRankSync()` returns a number. It crossed that threshold in mid-June; the
   **first** non-null spread signals appear on 2026-06-24. The `single_leg_rv`
   path never reads IV-rank, so it kept filling throughout — hence "only
   single_leg_rv fills."

2. **Per-trade max-loss gate too tight for index-ETF verticals (the fixable
   part):** Now that IV-rank is online the selector *does* fire — but a selected
   `bull_put_spread` never reached the journal. Its defined risk
   `(4-pt wing − $0.76 credit) × 100 = $324` is **1.30%** of the $25k demo book,
   over the `DEFAULT_MAX_LOSS_PCT_CAP` (1% = $250) enforced in
   `evaluateMultiLegPreTrade`. A single lot can't be trimmed below one, so the
   gate rejects it outright. Only narrow-width iron condors (1–2 pt wings →
   $57–$133) slipped under the cap.

## Live evidence (prod `tradingai-bqb1`, 2026-06-25)

`GET /api/health/option-shadow-signals` → **3** signals, all 2026-06-24/25:

| symbol | strategy          | rationale                       | maxLoss |
|--------|-------------------|---------------------------------|---------|
| QQQ    | `bull_put_spread` | `ivr 56 >= 50 & trend up`       | $324    |
| SPY    | `iron_condor`     | `ivr 51 >= 50 & range-bound`    | $57.50  |
| QQQ    | `iron_condor`     | `ivr 53 >= 50 & range-bound`    | $133    |

`GET /api/health/option-journal` → 53 rows: `single_leg_rv` ×51, `iron_condor`
×2, **`bull_put_spread` ×0**. So the QQQ bull put was *selected* (in the shadow
ledger) but *rejected* at `openDefinedRiskSpread` — exactly the $324 > $250 cap
case. `phaseBPaperExecutionEnabled: true`, `shadowSelectorEnabled: true`,
`optionExecSelectorEnabled: false` (the exec-path spread routing at
`signal-engine.ts:~3199` is off; the live spread path is the shadow Phase-B pass
at `signal-engine.ts:~4288`).

## Why this isn't a selector/routing bug

- `selectStrategyKind()` is pure, total, and exhaustively tested. With a real
  IV-rank it routed `bull_put_spread` (trend up) and `iron_condor` (range)
  correctly. `debit_spread` needs `ivr ≤ 25 + breakout`; `bear_call` needs
  `ivr ≥ 50 + trend down`; reversal-biased credit needs a confirmed checklist in
  the mid-IVR dead zone — all rarer regime coincidences that simply hadn't
  occurred in the ~2-week window since IV-rank came online.
- The gate is also slightly conservative: credit spreads need `ivr ≥ 50`, which
  only fires near regime extremes. That is by design (TRA-1047/1057 affirmed the
  IVR levers) and is left unchanged here.

## Fix landed

The risk gate is shared with the live-capital advisory→capital bridge, so the 1%
default is **not** loosened globally. Instead the **demo** spread-routing paths
now pass the selector's own advisory `riskFraction` (default **2%**) as an
explicit `maxLossPctCap`, so a single one-wing index-ETF vertical clears the gate
and enters the OOS journal:

- `multi-leg-gate.ts` already accepts `maxLossPctCap` — no change.
- `options-account.ts::openDefinedRiskSpread` — new optional `params.maxLossPctCap`
  threaded into both the lot-trim and `evaluateMultiLegPreTrade`; default stays
  the strict 1% (`DEFAULT_MAX_LOSS_PCT_CAP`).
- `option-shadow-ledger.ts` — `shadowSignalToSpreadParams` sets
  `maxLossPctCap` from the signal's `sizingIntent.riskFraction` (new exported
  `DEMO_SPREAD_MAX_LOSS_PCT_CAP = 0.02` fallback). Covers both deterministic demo
  spread paths.
- `signal-engine.ts::enterPaperOptionsIdea` (user-facing "Paper entry") — same
  2% cap; this also fixes a **pre-existing failing test**
  (`routes a multi-leg idea to a single defined-risk spread combo position`).
- The live-capital bridge builds its params via `toSpreadParams` (not the shadow
  mapper) and omits the override → stays at the strict 1% gate.

Regression test added in `options-account.test.ts`: a $324 single-lot vertical is
rejected on a $25k book at the 1% default and admitted at 2%.

## Verification

- `pnpm --filter @trading-app/server build` — clean.
- Affected suites: `options-account.test.ts`, `option-shadow-ledger.test.ts`,
  `options-account-journal.test.ts` all green; new regression test passes.
- `signal-engine.test.ts`: 21 pre-existing failures → 20 (the multi-leg routing
  test now passes); **no new failures** introduced. The remaining 20 are
  pre-existing, environment/clock-related, and out of scope for TRA-1145.

## Forward expectation

With IV-rank now warm and the cap aligned to the 2% advisory, `bull_put_spread`
and `bear_call_spread` will enter the paper journal on the next high-IVR
directional setup, and `debit_spread` on the next low-IVR breakout. `iron_condor`
already fills. Monitoring the journal `byStructure` fold over the next RTH
sessions confirms the spread family is accruing.
