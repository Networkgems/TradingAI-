// GENERATED FROM THE LIVE PRODUCTION HOST -- do not hand-edit. See TRA-3101 (A5).
//
// Verbatim `GET /api/reports/<date>?mode=live` payloads for every stored June
// 2026 cell, pulled from tradingai-bqb1 on 2026-09-16 against live build
// `f3ce18b6205edc61d4519cfdaca831858d53ddb2` (admin login, read-only). Nothing
// is trimmed, re-shaped or hand-written: the point of this fixture is that the
// OTHER side of the assertion comes from the shipped server, not from the same
// head that wrote the test. A hand-built `{ pnlUnknown: { detail: 'x' } }` row
// would agree with the component by construction -- the mirrored-gate trap the
// server half of this ticket was already restructured to avoid.
//
// Why June 2026, and why the whole month: it contains the cohort cell this
// ticket is named after (06-12, `stale_balance_anchor`, 1 open position, equity
// byte-identical to the 06-11 anchor) AND -- the part that makes it a real
// instrument -- FIVE other live cells whose `combinedPnl` is also exactly 0 and
// which carry NO `pnlUnknown` at all: 06-01, 06-02, 06-05, 06-17, 06-26. Those
// five are a negative control the live data supplies for free. If the render
// keyed on the ZERO instead of on the server's stamp, they would light up too,
// and a test that only ever showed it one flagged row could not tell.
//
// 22 rows. 1 unknown. 0 unreconciled (TRA-3102). Every row carries a
// `brokerRealized` companion, so the R view is exercisable too.

import type { EodReport } from '@trading-app/shared';

/** The live build these bytes were served by, per `/api/health/version`. */
export const LIVE_BUILD_SHA = 'f3ce18b6205edc61d4519cfdaca831858d53ddb2';

/** The one cell TRA-3101 is named after. */
export const COHORT_DATE = '2026-06-12';

/**
 * Live cells in the same month whose `combinedPnl` is ALSO exactly 0 and which
 * the server did NOT flag. The render must leave every one of these alone.
 */
export const LIVE_FLAT_BUT_MEASURED_DATES = [
  '2026-06-01',
  '2026-06-02',
  '2026-06-05',
  '2026-06-17',
  '2026-06-26',
];

/** As `GET /api/reports?mode=live` returns it (newest-first), June rows only. */
export const LIVE_JUNE_2026_DATES: string[] = [
 "2026-06-30",
 "2026-06-29",
 "2026-06-26",
 "2026-06-25",
 "2026-06-24",
 "2026-06-23",
 "2026-06-22",
 "2026-06-18",
 "2026-06-17",
 "2026-06-16",
 "2026-06-15",
 "2026-06-14",
 "2026-06-12",
 "2026-06-11",
 "2026-06-10",
 "2026-06-09",
 "2026-06-08",
 "2026-06-05",
 "2026-06-04",
 "2026-06-03",
 "2026-06-02",
 "2026-06-01"
];

/** Keyed by ISO date, exactly as `GET /api/reports/<date>?mode=live` returned it. */
export const LIVE_JUNE_2026_REPORTS = {
 "2026-06-30": {
  "date": "2026-06-30",
  "generatedAt": 1782877860652,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": -88.04000000000002,
  "totalEquity": 327.08,
  "managedEquity": 163.54,
  "availableCash": 8.08,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "UNCY",
    "price": 4.69,
    "changePct": -39.1,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6420361247947455,
     "impliedPrevClose": 7.701149425287357,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ABVX",
    "price": 133.26,
    "changePct": 38.6,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3860000000000001,
     "impliedPrevClose": 96.14718614718613,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782877860652
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-30 = today's Tradier equity ($327.08) − prev snapshot 2026-06-29 ($415.12) − net cash flow (+0.00) = **-88.04**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-30\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $327.08 |\n| Managed (50%) | $163.54 |\n| Available Cash | $8.08 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| HCWB | $4.99 | +469.64% |\n| BIYA | $0.56 | +98.23% |\n| UPC | $6.10 | -49.92% |\n| UNCY | $4.69 | -39.10% |\n| ABVX | $133.26 | +38.60% |\n\n> ⚠️ **PROVENANCE — 3 of 5 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | HCWB | 4.99 / +469.64% | suspect (implausible_move_ratio) | 0.8760 | 5.70 |\n> | 2 | BIYA | 0.56 / +98.23% | suspect (near_split_ratio) | 0.2820 | 1.98 |\n> | 3 | UPC | 6.10 / -49.92% | suspect (near_split_ratio) | 12.1805 | 2.00 |\n>\n> ⛔ 3 of the suppressed row(s) (HCWB, BIYA, UPC) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n\n\n## Option-Trade Journal (TRA-990, observe-only)\n| Metric | Value |\n|--------|-------|\n| Rows (open / closed) | 56 / 492 |\n| Realized P&L | +$2816.27 |\n| Win / Loss / Scratch | 42 / 44 / 406 |\n| Win Rate (closed) | 8.5% |\n| Avg R (closed) | 0.03R |\n\n## Journal P&L by Structure\n| Structure | Closed | Realized P&L | Win Rate | Avg R |\n|-----------|--------|--------------|----------|-------|\n| single_leg_rv | 492 | +$2816.27 | 8.5% | 0.03R |\n\n## Learned Option Weights (confident, off-neutral)\n| Dimension | Multiplier | Resolved | Win Rate |\n|-----------|-----------|----------|----------|\n| single_leg_rv | 0.585 | 492 | 8.5% |\n| high | 0.500 | 12 | 0.0% |\n| low | 0.570 | 86 | 7.0% |\n| mid | 0.500 | 37 | 0.0% |\n| unknown | 0.601 | 357 | 10.1% |\n| down | 0.521 | 285 | 2.1% |\n| up | 0.674 | 207 | 17.4% |\n| neutral | 0.585 | 492 | 8.5% |\n| 30to45 | 0.564 | 359 | 6.4% |\n| gt45 | 0.612 | 116 | 11.2% |\n| lt30 | 0.853 | 17 | 35.3% |\n| unknown | 0.585 | 492 | 8.5% |\n\n## Firm Introspection — Per-Strategy Attribution (TRA-995)\n| Strategy | Trades | Realized P&L | Win Rate | Expectancy | Sharpe |\n|----------|--------|--------------|----------|------------|--------|\n| single_leg_rv | 492 | +$2816.27 | 17.5% | 0.03R | 0.09 |\n\n## Edge-Decay Detector (TRA-995)\n| Strategy | Status | Baseline | Recent | Note |\n|----------|--------|----------|--------|------|\n| single_leg_rv | ok | 0.02R | 0.61R | Edge intact: recent 0.61R vs baseline +0.02R |\n\n## Risk Autopilot Actions (TRA-995, observe-and-tighten only)\n_The autopilot may only tighten risk autonomously (halt / throttle / de-risk); raising any limit requires board ratification._\n| Action | Trigger | Reason |\n|--------|---------|--------|\n_No autopilot actions today — risk at full size._",
  "pnlSource": "tradier-balance",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 2,
   "filteredCount": 3,
   "filtered": [
    {
     "symbol": "HCWB",
     "price": 4.99,
     "changePct": 469.64,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 5.6964,
      "impliedPrevClose": 0.8759918545045995,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "BIYA",
     "price": 0.559,
     "changePct": 98.23,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 1.9823,
      "impliedPrevClose": 0.2819956616052061,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "near_split_ratio"
     }
    },
    {
     "symbol": "UPC",
     "price": 6.1,
     "changePct": -49.92,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 1.9968051118210866,
      "impliedPrevClose": 12.180511182108628,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "near_split_ratio"
     }
    }
   ]
  }
 },
 "2026-06-29": {
  "date": "2026-06-29",
  "generatedAt": 1782789463391,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 13.610000000000014,
  "totalEquity": 415.12,
  "managedEquity": 207.56,
  "availableCash": 8.12,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "DCOY",
    "price": 9.59,
    "changePct": 73.8,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.738,
     "impliedPrevClose": 5.517836593785961,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SDOT",
    "price": 35.85,
    "changePct": 67.14,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6713999999999998,
     "impliedPrevClose": 21.44908459973675,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782789463390
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-29 = today's Tradier equity ($415.12) − prev snapshot 2026-06-26 ($401.51) − net cash flow (+0.00) = **+13.61**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-29\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $415.12 |\n| Managed (50%) | $207.56 |\n| Available Cash | $8.12 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| UPC | $12.18 | +311.49% |\n| TNMG | $1.01 | +106.97% |\n| FLYYQ | $0.02 | +100.00% |\n| DCOY | $9.59 | +73.80% |\n| SDOT | $35.85 | +67.14% |\n\n> ⚠️ **PROVENANCE — 3 of 5 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | UPC | 12.18 / +311.49% | suspect (implausible_move_ratio) | 2.9600 | 4.11 |\n> | 2 | TNMG | 1.01 / +106.97% | suspect (implausible_move_ratio) | 0.4880 | 2.07 |\n> | 3 | FLYYQ | 0.02 / +100.00% | suspect (implausible_move_ratio) | 0.0100 | 2.00 |\n>\n> ⛔ 3 of the suppressed row(s) (UPC, TNMG, FLYYQ) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n\n\n## Option-Trade Journal (TRA-990, observe-only)\n| Metric | Value |\n|--------|-------|\n| Rows (open / closed) | 32 / 320 |\n| Realized P&L | +$1234.27 |\n| Win / Loss / Scratch | 27 / 26 / 267 |\n| Win Rate (closed) | 8.4% |\n| Avg R (closed) | 0.03R |\n\n## Journal P&L by Structure\n| Structure | Closed | Realized P&L | Win Rate | Avg R |\n|-----------|--------|--------------|----------|-------|\n| single_leg_rv | 320 | +$1234.27 | 8.4% | 0.03R |\n\n## Learned Option Weights (confident, off-neutral)\n| Dimension | Multiplier | Resolved | Win Rate |\n|-----------|-----------|----------|----------|\n| single_leg_rv | 0.584 | 320 | 8.4% |\n| high | 0.500 | 12 | 0.0% |\n| low | 0.579 | 76 | 7.9% |\n| mid | 0.500 | 17 | 0.0% |\n| unknown | 0.598 | 215 | 9.8% |\n| down | 0.532 | 188 | 3.2% |\n| up | 0.659 | 132 | 15.9% |\n| neutral | 0.584 | 320 | 8.4% |\n| 30to45 | 0.575 | 266 | 7.5% |\n| gt45 | 0.526 | 37 | 2.7% |\n| lt30 | 0.853 | 17 | 35.3% |\n| unknown | 0.584 | 320 | 8.4% |\n\n## Firm Introspection — Per-Strategy Attribution (TRA-995)\n| Strategy | Trades | Realized P&L | Win Rate | Expectancy | Sharpe |\n|----------|--------|--------------|----------|------------|--------|\n| single_leg_rv | 320 | +$1234.27 | 19.7% | 0.03R | 0.09 |\n\n## Edge-Decay Detector (TRA-995)\n| Strategy | Status | Baseline | Recent | Note |\n|----------|--------|----------|--------|------|\n| single_leg_rv | ok | 0.03R | 0.02R | Edge intact: recent 0.02R vs baseline +0.03R |\n\n## Risk Autopilot Actions (TRA-995, observe-and-tighten only)\n_The autopilot may only tighten risk autonomously (halt / throttle / de-risk); raising any limit requires board ratification._\n| Action | Trigger | Reason |\n|--------|---------|--------|\n_No autopilot actions today — risk at full size._",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 2,
   "filteredCount": 3,
   "filtered": [
    {
     "symbol": "UPC",
     "price": 12.18,
     "changePct": 311.49,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 4.1149000000000004,
      "impliedPrevClose": 2.959974725995771,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "TNMG",
     "price": 1.01,
     "changePct": 106.97,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2.0697,
      "impliedPrevClose": 0.48799342899937187,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "FLYYQ",
     "price": 0.02,
     "changePct": 100,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2,
      "impliedPrevClose": 0.01,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-26": {
  "date": "2026-06-26",
  "generatedAt": 1782446407493,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 401.51,
  "managedEquity": 200.755,
  "availableCash": 401.51,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "AZI",
    "price": 1.98,
    "changePct": 73.69,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7368999999999999,
     "impliedPrevClose": 1.1399620012666245,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "IQST",
    "price": 1.59,
    "changePct": 47.23,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4723,
     "impliedPrevClose": 1.0799429464103785,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "NNOX",
    "price": 0.8794,
    "changePct": -43.99,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7853954650955184,
     "impliedPrevClose": 1.5700767720049988,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782446407493
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-26 = today's Tradier equity ($401.51) − prev snapshot 2026-06-25 ($401.51) − net cash flow (+0.00) = **+0.00**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-26\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $401.51 |\n| Managed (50%) | $200.76 |\n| Available Cash | $401.51 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| ILLR | $3.05 | +296.57% |\n| NEXR | $1.10 | +95.56% |\n| AZI | $1.98 | +73.69% |\n| IQST | $1.59 | +47.23% |\n| NNOX | $0.88 | -43.99% |\n\n> ⚠️ **PROVENANCE — 2 of 5 published row(s) SUPPRESSED as unverified. 3 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | ILLR | 3.05 / +296.57% | suspect (implausible_move_ratio) | 0.7691 | 3.97 |\n> | 2 | NEXR | 1.10 / +95.56% | suspect (near_split_ratio) | 0.5625 | 1.96 |\n>\n> ⛔ 2 of the suppressed row(s) (ILLR, NEXR) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n\n\n## Option-Trade Journal (TRA-990, observe-only)\n| Metric | Value |\n|--------|-------|\n| Rows (open / closed) | 9 / 44 |\n| Realized P&L | +$966.64 |\n| Win / Loss / Scratch | 9 / 2 / 33 |\n| Win Rate (closed) | 20.5% |\n| Avg R (closed) | 0.13R |\n\n## Journal P&L by Structure\n| Structure | Closed | Realized P&L | Win Rate | Avg R |\n|-----------|--------|--------------|----------|-------|\n| single_leg_rv | 44 | +$966.64 | 20.5% | 0.13R |\n\n## Learned Option Weights (confident, off-neutral)\n| Dimension | Multiplier | Resolved | Win Rate |\n|-----------|-----------|----------|----------|\n| single_leg_rv | 0.705 | 44 | 20.5% |\n| unknown | 0.705 | 44 | 20.5% |\n| down | 0.694 | 31 | 19.4% |\n| up | 0.731 | 13 | 23.1% |\n| neutral | 0.705 | 44 | 20.5% |\n| 30to45 | 0.611 | 27 | 11.1% |\n| lt30 | 0.853 | 17 | 35.3% |\n| unknown | 0.705 | 44 | 20.5% |\n\n## Firm Introspection — Per-Strategy Attribution (TRA-995)\n| Strategy | Trades | Realized P&L | Win Rate | Expectancy | Sharpe |\n|----------|--------|--------------|----------|------------|--------|\n| single_leg_rv | 44 | +$966.64 | 47.7% | 0.13R | 0.39 |\n\n## Edge-Decay Detector (TRA-995)\n| Strategy | Status | Baseline | Recent | Note |\n|----------|--------|----------|--------|------|\n| single_leg_rv | ⚠️ DECAYING | 0.16R | 0.06R | Edge eroding: recent expectancy 0.06R is below 50% of baseline +0.16R |\n\n## Risk Autopilot Actions (TRA-995, observe-and-tighten only)\n_The autopilot may only tighten risk autonomously (halt / throttle / de-risk); raising any limit requires board ratification._\n| Action | Trigger | Reason |\n|--------|---------|--------|\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 3,
   "filteredCount": 2,
   "filtered": [
    {
     "symbol": "ILLR",
     "price": 3.05,
     "changePct": 296.57,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 3.9656999999999996,
      "impliedPrevClose": 0.7690949895352649,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "NEXR",
     "price": 1.1,
     "changePct": 95.56,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 1.9556000000000002,
      "impliedPrevClose": 0.5624872161996318,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "near_split_ratio"
     }
    }
   ]
  }
 },
 "2026-06-25": {
  "date": "2026-06-25",
  "generatedAt": 1782435607297,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": -86.60000000000002,
  "totalEquity": 401.51,
  "managedEquity": 200.755,
  "availableCash": 401.51,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "AZI",
    "price": 1.98,
    "changePct": 73.69,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7368999999999999,
     "impliedPrevClose": 1.1399620012666245,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "IQST",
    "price": 1.59,
    "changePct": 47.23,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4723,
     "impliedPrevClose": 1.0799429464103785,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "NNOX",
    "price": 0.8794,
    "changePct": -43.99,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7853954650955184,
     "impliedPrevClose": 1.5700767720049988,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 22,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782435607295
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-25 = today's Tradier equity ($401.51) − prev snapshot 2026-06-24 ($488.11) − net cash flow (+0.00) = **-86.60**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-25\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $401.51 |\n| Managed (50%) | $200.76 |\n| Available Cash | $401.51 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| ILLR | $3.05 | +296.57% |\n| NEXR | $1.10 | +95.56% |\n| AZI | $1.98 | +73.69% |\n| IQST | $1.59 | +47.23% |\n| NNOX | $0.88 | -43.99% |\n\n> ⚠️ **PROVENANCE — 2 of 5 published row(s) SUPPRESSED as unverified. 3 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | ILLR | 3.05 / +296.57% | suspect (implausible_move_ratio) | 0.7691 | 3.97 |\n> | 2 | NEXR | 1.10 / +95.56% | suspect (near_split_ratio) | 0.5625 | 1.96 |\n>\n> ⛔ 2 of the suppressed row(s) (ILLR, NEXR) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 22 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n\n\n## Option-Trade Journal (TRA-990, observe-only)\n| Metric | Value |\n|--------|-------|\n| Rows (open / closed) | 9 / 44 |\n| Realized P&L | +$966.64 |\n| Win / Loss / Scratch | 9 / 2 / 33 |\n| Win Rate (closed) | 20.5% |\n| Avg R (closed) | 0.13R |\n\n## Journal P&L by Structure\n| Structure | Closed | Realized P&L | Win Rate | Avg R |\n|-----------|--------|--------------|----------|-------|\n| single_leg_rv | 44 | +$966.64 | 20.5% | 0.13R |\n\n## Learned Option Weights (confident, off-neutral)\n| Dimension | Multiplier | Resolved | Win Rate |\n|-----------|-----------|----------|----------|\n| single_leg_rv | 0.705 | 44 | 20.5% |\n| unknown | 0.705 | 44 | 20.5% |\n| down | 0.694 | 31 | 19.4% |\n| up | 0.731 | 13 | 23.1% |\n| neutral | 0.705 | 44 | 20.5% |\n| 30to45 | 0.611 | 27 | 11.1% |\n| lt30 | 0.853 | 17 | 35.3% |\n| unknown | 0.705 | 44 | 20.5% |\n\n## Firm Introspection — Per-Strategy Attribution (TRA-995)\n| Strategy | Trades | Realized P&L | Win Rate | Expectancy | Sharpe |\n|----------|--------|--------------|----------|------------|--------|\n| single_leg_rv | 44 | +$966.64 | 47.7% | 0.13R | 0.39 |\n\n## Edge-Decay Detector (TRA-995)\n| Strategy | Status | Baseline | Recent | Note |\n|----------|--------|----------|--------|------|\n| single_leg_rv | ⚠️ DECAYING | 0.16R | 0.06R | Edge eroding: recent expectancy 0.06R is below 50% of baseline +0.16R |\n\n## Risk Autopilot Actions (TRA-995, observe-and-tighten only)\n_The autopilot may only tighten risk autonomously (halt / throttle / de-risk); raising any limit requires board ratification._\n| Action | Trigger | Reason |\n|--------|---------|--------|\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |\n| THROTTLE | edge_decay | Strategy \"single_leg_rv\" flagged edge-decaying — autopilot throttled risk to 50% and queued for review |",
  "brokerRealized": {
   "combinedPnl": -409.59,
   "optionsPnl": -409.59,
   "equityPnl": 0,
   "closeCount": 2,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 3,
   "filteredCount": 2,
   "filtered": [
    {
     "symbol": "ILLR",
     "price": 3.05,
     "changePct": 296.57,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 3.9656999999999996,
      "impliedPrevClose": 0.7690949895352649,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "NEXR",
     "price": 1.1,
     "changePct": 95.56,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 1.9556000000000002,
      "impliedPrevClose": 0.5624872161996318,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "near_split_ratio"
     }
    }
   ]
  }
 },
 "2026-06-24": {
  "date": "2026-06-24",
  "generatedAt": 1782349231630,
  "realizedPnl": -118.64167046977508,
  "unrealizedPnl": 0,
  "totalPnl": -118.64167046977508,
  "optionsPnl": 0,
  "combinedPnl": -61.92999999999995,
  "totalEquity": 488.11,
  "managedEquity": 244.055,
  "availableCash": 12.11,
  "trades": [
   {
    "id": "0b36324e-d11a-4355-ae8f-acbc9a44f654",
    "symbol": "CNSP",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 4.25,
    "exitPrice": 4.459395998428791,
    "quantity": 588,
    "pnl": -29.399999999999896,
    "rr": -0.2,
    "openedAt": 1782222097689,
    "closedAt": 1782308446476
   },
   {
    "id": "5394d86c-1600-42e3-867f-d600a26c0f87",
    "symbol": "GLW",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 191.4,
    "exitPrice": 198.0366024575707,
    "quantity": 18,
    "pnl": -48.059999999999775,
    "rr": -0.4,
    "openedAt": 1782223745249,
    "closedAt": 1782308446488
   },
   {
    "id": "5773907a-b3e6-44c0-83a4-10eaf19fa7d5",
    "symbol": "META",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 563.34,
    "exitPrice": 566.8352931973238,
    "quantity": 21,
    "pnl": 23.520000000000095,
    "rr": 0.3,
    "openedAt": 1782239711386,
    "closedAt": 1782308446491
   },
   {
    "id": "d28e7f4e-11b6-402d-b14b-4a6a97b9f005",
    "symbol": "PRIM",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 82.015,
    "exitPrice": 84.40958340939551,
    "quantity": 50,
    "pnl": -119.72917046977543,
    "rr": -1,
    "openedAt": 1782241498347,
    "closedAt": 1782308446492
   },
   {
    "id": "778f2de8-78f4-4124-8afc-d5c2ce95b139",
    "symbol": "CAST",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 9.0437,
    "exitPrice": 10.643317928688786,
    "quantity": 75,
    "pnl": 55.02749999999992,
    "rr": 0.5,
    "openedAt": 1782243444234,
    "closedAt": 1782308446493
   }
  ],
  "openPositionCount": 0,
  "winRate": 0.4,
  "avgRR": 0.4800000000000001,
  "totalTrades": 5,
  "winners": 2,
  "losers": 3,
  "expectancy": -0.17239867349344978,
  "maxDrawdown": 0.2862277582776365,
  "sharpeRatio": -0.2931582336018194,
  "top5Movers": [
   {
    "symbol": "ICCM",
    "price": 9.3,
    "changePct": 51.97,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5196999999999998,
     "impliedPrevClose": 6.119628874119893,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ATLN",
    "price": 0.7801,
    "changePct": -41.35,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7050298380221653,
     "impliedPrevClose": 1.3300937766410912,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HTZ",
    "price": 3,
    "changePct": -40.72,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6869095816464237,
     "impliedPrevClose": 5.060728744939271,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ABSI",
    "price": 10.075,
    "changePct": 35.97,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3597,
     "impliedPrevClose": 7.409722732955799,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "FRTT",
    "price": 1.27,
    "changePct": -28.25,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3937282229965156,
     "impliedPrevClose": 1.7700348432055748,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782349231630
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-24 = today's Tradier equity ($488.11) − prev snapshot 2026-06-23 ($550.04) − net cash flow (+0.00) = **-61.93**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-24\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | -118.64 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **-118.64** |\n| Total Equity | $488.11 |\n| Managed (50%) | $244.06 |\n| Available Cash | $12.11 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 5 |\n| Winners | 2 |\n| Losers | 3 |\n| Win Rate | 40.0% |\n| Avg R:R Achieved | 1:0.48 |\n| Expectancy (avg R / trade) | -0.17R |\n| Max Drawdown | 28.6% |\n| Sharpe (per-trade) | -0.29 |\n\n## Trade Log\n| Symbol | Strategy | Side | Qty | Entry | Exit | P&L | R:R |\n|--------|----------|------|-----|-------|------|-----|-----|\n| CNSP | ORB | SELL | 588 | $4.25 | $4.46 | -29.40 | 1:-0.2 |\n| GLW | ORB | SELL | 18 | $191.40 | $198.04 | -48.06 | 1:-0.4 |\n| META | ORB | SELL | 21 | $563.34 | $566.84 | +23.52 | 1:0.3 |\n| PRIM | ORB | SELL | 50 | $82.02 | $84.41 | -119.73 | 1:-1 |\n| CAST | ORB | SELL | 75 | $9.04 | $10.64 | +55.03 | 1:0.5 |\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| ICCM | $9.30 | +51.97% |\n| ATLN | $0.78 | -41.35% |\n| HTZ | $3.00 | -40.72% |\n| ABSI | $10.08 | +35.97% |\n| FRTT | $1.27 | -28.25% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-23": {
  "date": "2026-06-23",
  "generatedAt": 1782273195861,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": -9,
  "totalEquity": 550.04,
  "managedEquity": 275.02,
  "availableCash": 10.04,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "BOLD",
    "price": 2.6,
    "changePct": 85.72,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.8572,
     "impliedPrevClose": 1.3999569244023262,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HSCS",
    "price": 2.75,
    "changePct": 55.37,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5537,
     "impliedPrevClose": 1.7699684623801248,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782273195860
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-23 = today's Tradier equity ($550.04) − prev snapshot 2026-06-22 ($559.04) − net cash flow (+0.00) = **-9.00**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-23\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $550.04 |\n| Managed (50%) | $275.02 |\n| Available Cash | $10.04 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| FCUV | $4.11 | +656.91% |\n| ATLN | $1.33 | +202.41% |\n| BOLD | $2.60 | +85.72% |\n| HSCS | $2.75 | +55.37% |\n| FLYYQ | $0.01 | -50.00% |\n\n> ⚠️ **PROVENANCE — 3 of 5 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | FCUV | 4.11 / +656.91% | suspect (implausible_move_ratio) | 0.5430 | 7.57 |\n> | 2 | ATLN | 1.33 / +202.41% | suspect (implausible_move_ratio) | 0.4398 | 3.02 |\n> | 3 | FLYYQ | 0.01 / -50.00% | suspect (implausible_move_ratio) | 0.0200 | 2.00 |\n>\n> ⛔ 3 of the suppressed row(s) (FCUV, ATLN, FLYYQ) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 2,
   "filteredCount": 3,
   "filtered": [
    {
     "symbol": "FCUV",
     "price": 4.11,
     "changePct": 656.91,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 7.569099999999999,
      "impliedPrevClose": 0.5429971859269928,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "ATLN",
     "price": 1.33,
     "changePct": 202.41,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 3.0241,
      "impliedPrevClose": 0.43980027115505443,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    },
    {
     "symbol": "FLYYQ",
     "price": 0.01,
     "changePct": -50,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2,
      "impliedPrevClose": 0.02,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-22": {
  "date": "2026-06-22",
  "generatedAt": 1782176401027,
  "realizedPnl": -158.6743248116976,
  "unrealizedPnl": 0,
  "totalPnl": -158.6743248116976,
  "optionsPnl": 0,
  "combinedPnl": -131.04000000000008,
  "totalEquity": 559.04,
  "managedEquity": 279.52,
  "availableCash": 10.04,
  "trades": [
   {
    "id": "dded04e1-3723-436f-a220-70b349dc3489",
    "symbol": "CLS",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 378.265,
    "exitPrice": 382.7699623094311,
    "quantity": 27,
    "pnl": 243.2679647092798,
    "rr": 2,
    "openedAt": 1781801669319,
    "closedAt": 1782135142522
   },
   {
    "id": "4ce3b3dc-3aeb-4b04-8bf7-e5de160e03f2",
    "symbol": "WOLF",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 54.85,
    "exitPrice": 58.87988171969631,
    "quantity": 61,
    "pnl": 245.82278490147465,
    "rr": 2,
    "openedAt": 1781801670203,
    "closedAt": 1782135142522
   },
   {
    "id": "74eff7a2-bff5-43f5-94be-91e07d5d27b0",
    "symbol": "LAC",
    "strategy": "ORB",
    "side": "sell",
    "entryPrice": 4.335,
    "exitPrice": 4.394948486610143,
    "quantity": 2064,
    "pnl": -82.56000000000007,
    "rr": -0.7,
    "openedAt": 1781801669330,
    "closedAt": 1782135597394
   },
   {
    "id": "f4349929-0397-41aa-b142-847bcd9cb59e",
    "symbol": "AMZN",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 244.37,
    "exitPrice": 247.700080101332,
    "quantity": 51,
    "pnl": -84.91704258396567,
    "rr": -1,
    "openedAt": 1782135142551,
    "closedAt": 1782135597394
   },
   {
    "id": "2ce40992-062a-459d-8c5e-13abc7de9899",
    "symbol": "WDC",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 761.505,
    "exitPrice": 794.9715496640296,
    "quantity": 7,
    "pnl": -117.1329238241035,
    "rr": -1,
    "openedAt": 1782135597705,
    "closedAt": 1782135819256
   },
   {
    "id": "41b65832-4b20-4dd1-812a-9b138c5bf2f6",
    "symbol": "WDC",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 761.505,
    "exitPrice": 794.9715496640296,
    "quantity": 7,
    "pnl": -117.1329238241035,
    "rr": -1,
    "openedAt": 1782135819579,
    "closedAt": 1782136748838
   },
   {
    "id": "e347abfc-1fe0-4634-80b5-e8a578f3203d",
    "symbol": "RMBS",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 143.94,
    "exitPrice": 150.35591312591106,
    "quantity": 38,
    "pnl": -121.90234939231016,
    "rr": -1,
    "openedAt": 1782136749004,
    "closedAt": 1782140615221
   },
   {
    "id": "60e12977-89f2-41bc-a142-08501bdf3914",
    "symbol": "ATER",
    "strategy": "ORB",
    "side": "buy",
    "entryPrice": 1.4,
    "exitPrice": 1.490236157613936,
    "quantity": 2751,
    "pnl": -124.11983479796912,
    "rr": -1,
    "openedAt": 1782135597630,
    "closedAt": 1782153098071
   }
  ],
  "openPositionCount": 0,
  "winRate": 0.25,
  "avgRR": 1.2125,
  "totalTrades": 8,
  "winners": 2,
  "losers": 6,
  "expectancy": -0.20840494118752367,
  "maxDrawdown": 0.5367603170979846,
  "sharpeRatio": -0.1523557055041195,
  "top5Movers": [
   {
    "symbol": "DFTX",
    "price": 36.67,
    "changePct": 49.8,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.498,
     "impliedPrevClose": 24.479305740987986,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "APGE",
    "price": 132.55,
    "changePct": 46.66,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4666,
     "impliedPrevClose": 90.37910814127916,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SDOT",
    "price": 9.25,
    "changePct": -42.84,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7494751574527645,
     "impliedPrevClose": 16.18264520643807,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SPCH",
    "price": 12.68,
    "changePct": -33.16,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4961101137043682,
     "impliedPrevClose": 18.97067624177139,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1782176401026
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-22 = today's Tradier equity ($559.04) − prev snapshot 2026-06-18 ($690.08) − net cash flow (+0.00) = **-131.04**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-22\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | -158.67 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **-158.67** |\n| Total Equity | $559.04 |\n| Managed (50%) | $279.52 |\n| Available Cash | $10.04 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 8 |\n| Winners | 2 |\n| Losers | 6 |\n| Win Rate | 25.0% |\n| Avg R:R Achieved | 1:1.21 |\n| Expectancy (avg R / trade) | -0.21R |\n| Max Drawdown | 53.7% |\n| Sharpe (per-trade) | -0.15 |\n\n## Trade Log\n| Symbol | Strategy | Side | Qty | Entry | Exit | P&L | R:R |\n|--------|----------|------|-----|-------|------|-----|-----|\n| CLS | ORB | SELL | 27 | $378.27 | $382.77 | +243.27 | 1:2 |\n| WOLF | ORB | BUY | 61 | $54.85 | $58.88 | +245.82 | 1:2 |\n| LAC | ORB | SELL | 2064 | $4.34 | $4.39 | -82.56 | 1:-0.7 |\n| AMZN | ORB | BUY | 51 | $244.37 | $247.70 | -84.92 | 1:-1 |\n| WDC | ORB | BUY | 7 | $761.51 | $794.97 | -117.13 | 1:-1 |\n| WDC | ORB | BUY | 7 | $761.51 | $794.97 | -117.13 | 1:-1 |\n| RMBS | ORB | BUY | 38 | $143.94 | $150.36 | -121.90 | 1:-1 |\n| ATER | ORB | BUY | 2751 | $1.40 | $1.49 | -124.12 | 1:-1 |\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| GETY | $1.15 | +90.06% |\n| DFTX | $36.67 | +49.80% |\n| APGE | $132.55 | +46.66% |\n| SDOT | $9.25 | -42.84% |\n| SPCH | $12.68 | -33.16% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | GETY | 1.15 / +90.06% | suspect (near_split_ratio) | 0.6051 | 1.90 |\n>\n> ⛔ 1 of the suppressed row(s) (GETY) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "GETY",
     "price": 1.15,
     "changePct": 90.06,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 1.9006,
      "impliedPrevClose": 0.605072082500263,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "near_split_ratio"
     }
    }
   ]
  }
 },
 "2026-06-18": {
  "date": "2026-06-18",
  "generatedAt": 1781838443017,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": -110.75,
  "totalEquity": 690.08,
  "managedEquity": 345.04,
  "availableCash": 10.08,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "CAST",
    "price": 8.07,
    "changePct": 56.7,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.567,
     "impliedPrevClose": 5.149968091895341,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "TDIC",
    "price": 6.13,
    "changePct": -21.31,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2708095056551023,
     "impliedPrevClose": 7.790062269665777,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "FCEL",
    "price": 24.04,
    "changePct": 19.96,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.1996,
     "impliedPrevClose": 20.04001333777926,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 3.59,
    "changePct": -19.51,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2423903590508139,
     "impliedPrevClose": 4.460181388992422,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "GCTS",
    "price": 3.18,
    "changePct": 19.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.1911,
     "impliedPrevClose": 2.669801024263286,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1781838443016
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-18 = today's Tradier equity ($690.08) − prev snapshot 2026-06-17 ($800.83) − net cash flow (+0.00) = **-110.75**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-18\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $690.08 |\n| Managed (50%) | $345.04 |\n| Available Cash | $10.08 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| CAST | $8.07 | +56.70% |\n| TDIC | $6.13 | -21.31% |\n| FCEL | $24.04 | +19.96% |\n| SOXS | $3.59 | -19.51% |\n| GCTS | $3.18 | +19.11% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-17": {
  "date": "2026-06-17",
  "generatedAt": 1781668834658,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 800.83,
  "managedEquity": 400.415,
  "availableCash": 650.83,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "TDIC",
    "price": 7.6,
    "changePct": 39.97,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3997,
     "impliedPrevClose": 5.4297349432021145,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AHMA",
    "price": 2.69,
    "changePct": 39.38,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3938000000000001,
     "impliedPrevClose": 1.9299756062562776,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "RGNT",
    "price": 6.1,
    "changePct": -35.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5410695022345506,
     "impliedPrevClose": 9.400523963630759,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PRFX",
    "price": 1.84,
    "changePct": -26.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3533631073216945,
     "impliedPrevClose": 2.490188117471918,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1781668834657
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-17 = today's Tradier equity ($800.83) − prev snapshot 2026-06-16 ($800.83) − net cash flow (+0.00) = **+0.00**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-17\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $800.83 |\n| Managed (50%) | $400.42 |\n| Available Cash | $650.83 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SDOT | $8.67 | -63.06% |\n| TDIC | $7.60 | +39.97% |\n| AHMA | $2.69 | +39.38% |\n| RGNT | $6.10 | -35.11% |\n| PRFX | $1.84 | -26.11% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | SDOT | 8.67 / -63.06% | suspect (implausible_move_ratio) | 23.4705 | 2.71 |\n>\n> ⛔ 1 of the suppressed row(s) (SDOT) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "SDOT",
     "price": 8.67,
     "changePct": -63.06,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2.707092582566324,
      "impliedPrevClose": 23.47049269085003,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-16": {
  "date": "2026-06-16",
  "generatedAt": 1781667873914,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": -122.76999999999998,
  "totalEquity": 800.83,
  "managedEquity": 400.415,
  "availableCash": 650.83,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "TDIC",
    "price": 7.6,
    "changePct": 39.97,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3997,
     "impliedPrevClose": 5.4297349432021145,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AHMA",
    "price": 2.69,
    "changePct": 39.38,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3938000000000001,
     "impliedPrevClose": 1.9299756062562776,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "RGNT",
    "price": 6.1,
    "changePct": -35.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5410695022345506,
     "impliedPrevClose": 9.400523963630759,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PRFX",
    "price": 1.84,
    "changePct": -26.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3533631073216945,
     "impliedPrevClose": 2.490188117471918,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 10,
   "winningSignals": 2,
   "winRate": 0.2,
   "avgRR": 0.16457237427326624
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1781667873913
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-16 = today's Tradier equity ($800.83) − prev snapshot 2026-06-15 ($923.60) − net cash flow (+0.00) = **-122.77**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-16\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $800.83 |\n| Managed (50%) | $400.42 |\n| Available Cash | $650.83 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SDOT | $8.67 | -63.06% |\n| TDIC | $7.60 | +39.97% |\n| AHMA | $2.69 | +39.38% |\n| RGNT | $6.10 | -35.11% |\n| PRFX | $1.84 | -26.11% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | SDOT | 8.67 / -63.06% | suspect (implausible_move_ratio) | 23.4705 | 2.71 |\n>\n> ⛔ 1 of the suppressed row(s) (SDOT) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 10 |\n| Winning Signals | 2 |\n| Signal Win Rate | 20.0% |\n| Avg R:R | 1:0.16 |\n",
  "brokerRealized": {
   "combinedPnl": -163.15,
   "optionsPnl": -163.15,
   "equityPnl": 0,
   "closeCount": 2,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "SDOT",
     "price": 8.67,
     "changePct": -63.06,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2.707092582566324,
      "impliedPrevClose": 23.47049269085003,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-15": {
  "date": "2026-06-15",
  "generatedAt": 1781576174912,
  "realizedPnl": 0,
  "unrealizedPnl": 0.13000000000000256,
  "totalPnl": 0.13000000000000256,
  "optionsPnl": 0,
  "combinedPnl": 104.84000000000003,
  "totalEquity": 923.6,
  "managedEquity": 461.8,
  "availableCash": 558.84,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "PRFX",
    "price": 2.49,
    "changePct": 83.09,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.8309000000000002,
     "impliedPrevClose": 1.3599868916926101,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "GPUS",
    "price": 0.2713,
    "changePct": 75.49,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.7549,
     "impliedPrevClose": 0.15459570345888654,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SDOT",
    "price": 23.47,
    "changePct": 44.79,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4479000000000002,
     "impliedPrevClose": 16.209682989156708,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AHMA",
    "price": 1.93,
    "changePct": 42.97,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4297,
     "impliedPrevClose": 1.34993355249353,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 1,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 1
  },
  "portfolioGreeks": {
   "netDelta": 0,
   "netGamma": 0,
   "netVega": 0,
   "thetaDollarsPerDay": 0,
   "netNotional": 0,
   "positionsValued": 0,
   "positionsTotal": 0,
   "byName": [],
   "bySector": [],
   "asOf": 1781576174912
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-15 = today's Tradier equity ($923.60) − prev snapshot 2026-06-14 ($818.76) − net cash flow (+0.00) = **+104.84**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-15\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.13 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $923.60 |\n| Managed (50%) | $461.80 |\n| Available Cash | $558.84 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| TDIC | $5.43 | +2263.96% |\n| PRFX | $2.49 | +83.09% |\n| GPUS | $0.27 | +75.49% |\n| SDOT | $23.47 | +44.79% |\n| AHMA | $1.93 | +42.97% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | TDIC | 5.43 / +2263.96% | suspect (implausible_move_ratio) | 0.2297 | 23.64 |\n>\n> ⛔ 1 of the suppressed row(s) (TDIC) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 1 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:1.00 |\n",
  "brokerRealized": {
   "combinedPnl": 125.75,
   "optionsPnl": 125.75,
   "equityPnl": 0,
   "closeCount": 1,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "TDIC",
     "price": 5.43,
     "changePct": 2263.96,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 23.6396,
      "impliedPrevClose": 0.22969931809336872,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-14": {
  "date": "2026-06-14",
  "generatedAt": 1781489675282,
  "realizedPnl": 0,
  "unrealizedPnl": -0.07000000000000028,
  "totalPnl": -0.07000000000000028,
  "optionsPnl": 0,
  "combinedPnl": -200.9131,
  "totalEquity": 818.76,
  "managedEquity": 409.38,
  "availableCash": 706.2,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "SDOT",
    "price": 16.21,
    "changePct": -34.06,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5165301789505612,
     "impliedPrevClose": 24.5829542007886,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "BIYA",
    "price": 0.6678,
    "changePct": -33.89,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5126304643775528,
     "impliedPrevClose": 1.0101346241113296,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SPCE",
    "price": 3.91,
    "changePct": -31.77,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.465630954125751,
     "impliedPrevClose": 5.730617030631687,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HTCO",
    "price": 3.98,
    "changePct": -31.27,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4549687181725592,
     "impliedPrevClose": 5.790775498326786,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ASTC",
    "price": 19.01,
    "changePct": -28.27,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3941168269901016,
     "impliedPrevClose": 26.502160881081835,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-14 = today's Tradier equity ($818.76) − prev snapshot 2026-06-12 ($1,019.67) − net cash flow (+0.00) = **-200.91**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-14\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.07 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $818.76 |\n| Managed (50%) | $409.38 |\n| Available Cash | $706.20 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SDOT | $16.21 | -34.06% |\n| BIYA | $0.67 | -33.89% |\n| SPCE | $3.91 | -31.77% |\n| HTCO | $3.98 | -31.27% |\n| ASTC | $19.01 | -28.27% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-12": {
  "date": "2026-06-12",
  "generatedAt": 1781239900680,
  "realizedPnl": 0,
  "unrealizedPnl": -0.8168999999999997,
  "totalPnl": -0.8168999999999997,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 1019.6731,
  "managedEquity": 509.83655,
  "availableCash": 324.48,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "MNTS",
    "price": 16.3,
    "changePct": 43.74,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4374,
     "impliedPrevClose": 11.339919298733825,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "RUBI",
    "price": 0.6203,
    "changePct": 31.98,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3198,
     "impliedPrevClose": 0.4699954538566449,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HTCO",
    "price": 5.79,
    "changePct": 26.15,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2615,
     "impliedPrevClose": 4.589774078478002,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "MASK",
    "price": 2.27,
    "changePct": -25.09,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3349352556401015,
     "impliedPrevClose": 3.0303030303030303,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 4.97,
    "changePct": -24.36,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3220518244315178,
     "impliedPrevClose": 6.570597567424643,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-12 = today's Tradier equity ($1,019.67) − prev snapshot 2026-06-11 ($1,019.67) − net cash flow (+0.00) = **+0.00**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-12\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.82 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $1,019.67 |\n| Managed (50%) | $509.84 |\n| Available Cash | $324.48 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| MNTS | $16.30 | +43.74% |\n| RUBI | $0.62 | +31.98% |\n| HTCO | $5.79 | +26.15% |\n| MASK | $2.27 | -25.09% |\n| SOXS | $4.97 | -24.36% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": -141.72,
   "optionsPnl": -141.72,
   "equityPnl": 0,
   "closeCount": 3,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "pnlUnknown": {
   "reason": "stale_balance_anchor",
   "anchorDate": "2026-06-11",
   "anchorBalance": 1019.67,
   "reportedBalance": 1019.67,
   "spanDays": 1,
   "evidence": {
    "known": true,
    "brokerCloses": 0,
    "brokerRealizedUsd": 0,
    "engineTrades": 0,
    "openPositions": 1
   },
   "detail": "The balance snapshot for 2026-06-12 ($1,019.67) is identical to the 2026-06-11 anchor to the cent, yet the day shows 1 open position carrying mark-to-market. Equity cannot be unchanged across that, so the 2026-06-12 snapshot did not land and the reconcile subtracted a stale anchor from itself. This day's P&L is UNKNOWN — it is NOT $0.00, and it has deliberately not been re-derived (the equity series has a hole; filling it by inference is TRA-2864's phantom-green calendar).",
   "at": "2026-09-16T16:14:20.707Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-11": {
  "date": "2026-06-11",
  "generatedAt": 1781235932902,
  "realizedPnl": 0,
  "unrealizedPnl": -0.8168999999999997,
  "totalPnl": -0.8168999999999997,
  "optionsPnl": 0,
  "combinedPnl": 23.813099999999963,
  "totalEquity": 1019.6731,
  "managedEquity": 509.83655,
  "availableCash": 324.48,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "MNTS",
    "price": 16.3,
    "changePct": 43.74,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4374,
     "impliedPrevClose": 11.339919298733825,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "RUBI",
    "price": 0.6203,
    "changePct": 31.98,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3198,
     "impliedPrevClose": 0.4699954538566449,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HTCO",
    "price": 5.79,
    "changePct": 26.15,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2615,
     "impliedPrevClose": 4.589774078478002,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "MASK",
    "price": 2.27,
    "changePct": -25.09,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3349352556401015,
     "impliedPrevClose": 3.0303030303030303,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 4.97,
    "changePct": -24.36,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3220518244315178,
     "impliedPrevClose": 6.570597567424643,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 166,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-11 = today's Tradier equity ($1,019.67) − prev snapshot 2026-06-10 ($995.86) − net cash flow (+0.00) = **+23.81**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-11\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.82 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $1,019.67 |\n| Managed (50%) | $509.84 |\n| Available Cash | $324.48 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| MNTS | $16.30 | +43.74% |\n| RUBI | $0.62 | +31.98% |\n| HTCO | $5.79 | +26.15% |\n| MASK | $2.27 | -25.09% |\n| SOXS | $4.97 | -24.36% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 166 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": -80.72,
   "optionsPnl": -80.72,
   "equityPnl": 0,
   "closeCount": 3,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-10": {
  "date": "2026-06-10",
  "generatedAt": 1781150337037,
  "realizedPnl": 0,
  "unrealizedPnl": -0.49000000000000005,
  "totalPnl": -0.49000000000000005,
  "optionsPnl": 0,
  "combinedPnl": -76.16809999999998,
  "totalEquity": 995.86,
  "managedEquity": 497.93,
  "availableCash": 557.34,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "FAC",
    "price": 21.94,
    "changePct": 37.13,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3713,
     "impliedPrevClose": 15.999416611974041,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "BIYA",
    "price": 1.21,
    "changePct": 36.36,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3636,
     "impliedPrevClose": 0.887356996186565,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "STI",
    "price": 27.59,
    "changePct": 34.79,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3479,
     "impliedPrevClose": 20.468877513168632,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HCAI",
    "price": 9.19,
    "changePct": 31.29,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3129,
     "impliedPrevClose": 6.99977149821007,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 1441,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-10 = today's Tradier equity ($995.86) − prev snapshot 2026-06-09 ($1,072.03) − net cash flow (+0.00) = **-76.17**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-10\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.49 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $995.86 |\n| Managed (50%) | $497.93 |\n| Available Cash | $557.34 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SDOT | $28.11 | +108.23% |\n| FAC | $21.94 | +37.13% |\n| BIYA | $1.21 | +36.36% |\n| STI | $27.59 | +34.79% |\n| HCAI | $9.19 | +31.29% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | SDOT | 28.11 / +108.23% | suspect (implausible_move_ratio) | 13.4995 | 2.08 |\n>\n> ⛔ 1 of the suppressed row(s) (SDOT) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 1441 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-03T20:13:29.973Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "SDOT",
     "price": 28.11,
     "changePct": 108.23,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2.0823,
      "impliedPrevClose": 13.499495749891945,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-09": {
  "date": "2026-06-09",
  "generatedAt": 1781063768037,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 11.85,
  "optionsPnl": 11.85,
  "combinedPnl": 11.85,
  "totalEquity": 1072.0281,
  "managedEquity": 536.01405,
  "availableCash": 1069.2869,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "SUNE",
    "price": 3.56,
    "changePct": -39.46,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6518004625041296,
     "impliedPrevClose": 5.8804096465147015,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "NUVL",
    "price": 123.25,
    "changePct": 39.29,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3929,
     "impliedPrevClose": 88.48445688850599,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AHMA",
    "price": 1.47,
    "changePct": 36.12,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3611999999999997,
     "impliedPrevClose": 1.0799294739935352,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SDOT",
    "price": 13.5,
    "changePct": -34.25,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5209125475285172,
     "impliedPrevClose": 20.53231939163498,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "HTCO",
    "price": 4.47,
    "changePct": 33.84,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3384,
     "impliedPrevClose": 3.339808726838015,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 1797,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-09 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+11.85** (options $+11.85 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-09 = today's Tradier equity ($1,072.03) − prev snapshot 2026-06-08 ($816.35) − net cash flow (+0.00) = **+255.68**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-09\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.27 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $1,072.03 |\n| Managed (50%) | $536.01 |\n| Available Cash | $1,069.29 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SUNE | $3.56 | -39.46% |\n| NUVL | $123.25 | +39.29% |\n| AHMA | $1.47 | +36.12% |\n| SDOT | $13.50 | -34.25% |\n| HTCO | $4.47 | +33.84% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 1797 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 11.85,
   "optionsPnl": 11.85,
   "equityPnl": 0,
   "closeCount": 6,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-08": {
  "date": "2026-06-08",
  "generatedAt": 1780977133096,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 816.3524,
  "managedEquity": 408.1762,
  "availableCash": 225.3504,
  "trades": [],
  "openPositionCount": 1,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "SDOT",
    "price": 20.53,
    "changePct": 69.11,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6911,
     "impliedPrevClose": 12.14002720122997,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PN",
    "price": 4.21,
    "changePct": 42.23,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4223,
     "impliedPrevClose": 2.9599943753076006,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SBEV",
    "price": 0.3162,
    "changePct": 26.48,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2648,
     "impliedPrevClose": 0.25,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "FLYYQ",
    "price": 0.015,
    "changePct": -25,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3333333333333335,
     "impliedPrevClose": 0.02,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 1847,
   "winningSignals": 1,
   "winRate": 0.0005414185165132648,
   "avgRR": 0.00884239306984341
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-08 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+0.00** (options $+0.00 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-08 = today's Tradier equity ($816.35) − prev snapshot 2026-06-02 ($550.73) − net cash flow (+0.00) = **+265.62**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-08\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | -0.03 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $816.35 |\n| Managed (50%) | $408.18 |\n| Available Cash | $225.35 |\n| Open Positions | 1 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| TDIC | $0.50 | +123.67% |\n| SDOT | $20.53 | +69.11% |\n| PN | $4.21 | +42.23% |\n| SBEV | $0.32 | +26.48% |\n| FLYYQ | $0.02 | -25.00% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | TDIC | 0.50 / +123.67% | suspect (implausible_move_ratio) | 0.2240 | 2.24 |\n>\n> ⛔ 1 of the suppressed row(s) (TDIC) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 1847 |\n| Winning Signals | 1 |\n| Signal Win Rate | 0.1% |\n| Avg R:R | 1:0.01 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "TDIC",
     "price": 0.501,
     "changePct": 123.67,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 2.2367,
      "impliedPrevClose": 0.22399070058568427,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-05": {
  "date": "2026-06-05",
  "generatedAt": 1780718437394,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 770.46,
  "managedEquity": 385.23,
  "availableCash": 770.46,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "STI",
    "price": 35.72,
    "changePct": 57.29,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5729,
     "impliedPrevClose": 22.709644605505755,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "TDIC",
    "price": 0.224,
    "changePct": -38.7,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6313213703099512,
     "impliedPrevClose": 0.36541598694942906,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "WCT",
    "price": 1.41,
    "changePct": -32.86,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4894250819183794,
     "impliedPrevClose": 2.100089365504915,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 6.84,
    "changePct": 31.54,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3154,
     "impliedPrevClose": 5.1999391819978715,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PL",
    "price": 32.22,
    "changePct": -25.99,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3511687609782461,
     "impliedPrevClose": 43.53465747871909,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-05 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+0.00** (options $+0.00 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n# Daily EOD Report — 2026-06-05\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | -79.50 |\n| **Combined P&L** | **-79.50** |\n| Total Equity | $770.46 |\n| Managed (50%) | $385.23 |\n| Available Cash | $770.46 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| STI | $35.72 | +57.29% |\n| TDIC | $0.22 | -38.70% |\n| WCT | $1.41 | -32.86% |\n| SOXS | $6.84 | +31.54% |\n| PL | $32.22 | -25.99% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-04": {
  "date": "2026-06-04",
  "generatedAt": 1780718437386,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": -180.27,
  "optionsPnl": -180.27,
  "combinedPnl": -180.27,
  "totalEquity": 770.46,
  "managedEquity": 385.23,
  "availableCash": 770.46,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "STI",
    "price": 35.72,
    "changePct": 57.29,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5729,
     "impliedPrevClose": 22.709644605505755,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "TDIC",
    "price": 0.224,
    "changePct": -38.7,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6313213703099512,
     "impliedPrevClose": 0.36541598694942906,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "WCT",
    "price": 1.41,
    "changePct": -32.86,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4894250819183794,
     "impliedPrevClose": 2.100089365504915,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 6.84,
    "changePct": 31.54,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3154,
     "impliedPrevClose": 5.1999391819978715,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PL",
    "price": 32.22,
    "changePct": -25.99,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3511687609782461,
     "impliedPrevClose": 43.53465747871909,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 521,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0.0019193857965451055
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-04 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$-180.27** (options $-180.27 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n# Daily EOD Report — 2026-06-04\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | -79.50 |\n| **Combined P&L** | **-79.50** |\n| Total Equity | $770.46 |\n| Managed (50%) | $385.23 |\n| Available Cash | $770.46 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| STI | $35.72 | +57.29% |\n| TDIC | $0.22 | -38.70% |\n| WCT | $1.41 | -32.86% |\n| SOXS | $6.84 | +31.54% |\n| PL | $32.22 | -25.99% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 521 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": -180.27,
   "optionsPnl": -180.27,
   "equityPnl": 0,
   "closeCount": 4,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-03": {
  "date": "2026-06-03",
  "generatedAt": 1780718437380,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 770.46,
  "managedEquity": 385.23,
  "availableCash": 770.46,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "STI",
    "price": 35.72,
    "changePct": 57.29,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5729,
     "impliedPrevClose": 22.709644605505755,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "TDIC",
    "price": 0.224,
    "changePct": -38.7,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.6313213703099512,
     "impliedPrevClose": 0.36541598694942906,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "WCT",
    "price": 1.41,
    "changePct": -32.86,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4894250819183794,
     "impliedPrevClose": 2.100089365504915,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "SOXS",
    "price": 6.84,
    "changePct": 31.54,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3154,
     "impliedPrevClose": 5.1999391819978715,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PL",
    "price": 32.22,
    "changePct": -25.99,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.3511687609782461,
     "impliedPrevClose": 43.53465747871909,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 81,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-03 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+0.00** (options $+0.00 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n# Daily EOD Report — 2026-06-03\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | -79.50 |\n| **Combined P&L** | **-79.50** |\n| Total Equity | $770.46 |\n| Managed (50%) | $385.23 |\n| Available Cash | $770.46 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| STI | $35.72 | +57.29% |\n| TDIC | $0.22 | -38.70% |\n| WCT | $1.41 | -32.86% |\n| SOXS | $6.84 | +31.54% |\n| PL | $32.22 | -25.99% |\n\n> ⚠️ **PROVENANCE — 0 of 5 row(s) suppressed at read time. Whether anything was dropped before this report was written is UNKNOWN.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 81 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 5,
   "filteredCount": 0,
   "filtered": []
  }
 },
 "2026-06-02": {
  "date": "2026-06-02",
  "generatedAt": 1780372818414,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 550.73,
  "managedEquity": 275.365,
  "availableCash": 550.73,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "MASK",
    "price": 5.45,
    "changePct": 52.24,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5224,
     "impliedPrevClose": 3.5798738833420916,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PRFX",
    "price": 2.02,
    "changePct": -32.67,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.485222040695084,
     "impliedPrevClose": 3.0001485222040696,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ASTC",
    "price": 35.4,
    "changePct": -28.92,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4068655036578503,
     "impliedPrevClose": 49.8030388294879,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AIIO",
    "price": 2.92,
    "changePct": 23.21,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2321,
     "impliedPrevClose": 2.3699375050726403,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 0,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-02 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+0.00** (options $+0.00 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-06-02 = today's Tradier equity ($550.73) − prev snapshot 2026-05-31 ($550.73) − net cash flow (+0.00) = **+0.00**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.\n\n# Daily EOD Report — 2026-06-02\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $550.73 |\n| Managed (50%) | $275.37 |\n| Available Cash | $550.73 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SBFM | $2.39 | +840.58% |\n| MASK | $5.45 | +52.24% |\n| PRFX | $2.02 | -32.67% |\n| ASTC | $35.40 | -28.92% |\n| AIIO | $2.92 | +23.21% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | SBFM | 2.39 / +840.58% | suspect (implausible_move_ratio) | 0.2541 | 9.41 |\n>\n> ⛔ 1 of the suppressed row(s) (SBFM) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 0 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "SBFM",
     "price": 2.39,
     "changePct": 840.58,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 9.405800000000001,
      "impliedPrevClose": 0.25409853494652235,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 },
 "2026-06-01": {
  "date": "2026-06-01",
  "generatedAt": 1780372818332,
  "realizedPnl": 0,
  "unrealizedPnl": 0,
  "totalPnl": 0,
  "optionsPnl": 0,
  "combinedPnl": 0,
  "totalEquity": 550.73,
  "managedEquity": 275.365,
  "availableCash": 550.73,
  "trades": [],
  "openPositionCount": 0,
  "winRate": 0,
  "avgRR": 0,
  "totalTrades": 0,
  "winners": 0,
  "losers": 0,
  "expectancy": 0,
  "maxDrawdown": 0,
  "sharpeRatio": 0,
  "top5Movers": [
   {
    "symbol": "MASK",
    "price": 5.45,
    "changePct": 52.24,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.5224,
     "impliedPrevClose": 3.5798738833420916,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "PRFX",
    "price": 2.02,
    "changePct": -32.67,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.485222040695084,
     "impliedPrevClose": 3.0001485222040696,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "ASTC",
    "price": 35.4,
    "changePct": -28.92,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.4068655036578503,
     "impliedPrevClose": 49.8030388294879,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   },
   {
    "symbol": "AIIO",
    "price": 2.92,
    "changePct": 23.21,
    "provenance": {
     "ruleId": "TRA-3241:session-move-ratio",
     "threshold": 1.9,
     "ratio": 1.2321,
     "impliedPrevClose": 2.3699375050726403,
     "build": "f3ce18b6205e",
     "verdict": "plausible"
    }
   }
  ],
  "signalAccuracy": {
   "totalSignals": 186,
   "winningSignals": 0,
   "winRate": 0,
   "avgRR": 0
  },
  "markdown": "> **Live calendar backfill (TRA-244).** 2026-06-01 P&L = Tradier broker-truth realized P&L for positions that *closed* this day = **$+0.00** (options $+0.00 · stocks $+0.00). Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds. **Stock realized withheld this pass** — all equity withheld: adjustment moved -7 shares on 2026-06-12 and could not be attributed to a ticker (0 candidates). The figure above is options only and will not match an all-instrument Tradier statement.\n\n# Daily EOD Report — 2026-06-01\n\n## P&L Summary\n| Metric | Value |\n|--------|-------|\n| Realized P&L (equity) | +0.00 |\n| Unrealized P&L (open) | +0.00 |\n| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |\n| Total Equity | $550.73 |\n| Managed (50%) | $275.37 |\n| Available Cash | $550.73 |\n| Open Positions | 0 |\n\n## Performance\n| Metric | Value |\n|--------|-------|\n| Total Trades | 0 |\n| Winners | 0 |\n| Losers | 0 |\n| Win Rate | 0.0% |\n| Avg R:R Achieved | 1:0.00 |\n| Expectancy (avg R / trade) | 0.00R |\n| Max Drawdown | 0.0% |\n| Sharpe (per-trade) | 0.00 |\n\n## Trade Log\n_No closed trades today._\n\n## Top 5 Movers (Watchlist)\n| Symbol | Price | Change % |\n|--------|-------|----------|\n| SBFM | $2.39 | +840.58% |\n| MASK | $5.45 | +52.24% |\n| PRFX | $2.02 | -32.67% |\n| ASTC | $35.40 | -28.92% |\n| AIIO | $2.92 | +23.21% |\n\n> ⚠️ **PROVENANCE — 1 of 5 published row(s) SUPPRESSED as unverified. 4 row(s) shown above.**\n> Filtered at read time by rule `TRA-3241:session-move-ratio` (threshold `SUSPECT_MOVE_RATIO_FLOOR = 1.9`), build `f3ce18b6205e` (TRA-2631, board ruling A).\n> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite, so the published artifact remains the record of what we served on this date. The suppressed rows are reproduced verbatim below and in the response's `moversProvenance.filtered`, so nothing is lost:\n> _Session-move test only — it asks whether a row's own price and change % believe each other. It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._\n>\n> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296, which is the change that started recording rows dropped during report GENERATION (a corporate action, a level discontinuity, or a move the feed condemned earlier in the session). Those rows never reached the file, so the read-time filter above cannot see them and **this note cannot tell you whether any exist.** The stored artifact is not repairable — no per-symbol quote tape is retained for past sessions — so this is recorded as unknown rather than resolved.\n>\n> | # | Symbol | Published | Verdict | Implied prev close | Ratio |\n> |---|--------|-----------|---------|--------------------|-------|\n> | 1 | SBFM | 2.39 / +840.58% | suspect (implausible_move_ratio) | 0.2541 | 9.41 |\n>\n> ⛔ 1 of the suppressed row(s) (SBFM) could not be matched to a line in the table above (this document was rendered by an older formatter) and are therefore **still rendered in the table** while being absent from the JSON array. Treat the table above as containing those rows in error.\n\n## Signal Accuracy\n| Metric | Value |\n|--------|-------|\n| Total Signals Fired | 186 |\n| Winning Signals | 0 |\n| Signal Win Rate | 0.0% |\n| Avg R:R | 1:0.00 |\n",
  "pnlSource": "realized-backfill",
  "brokerRealized": {
   "combinedPnl": 0,
   "optionsPnl": 0,
   "equityPnl": 0,
   "closeCount": 0,
   "equityIncluded": false,
   "reconstructedAt": "2026-09-15T20:11:18.270Z"
  },
  "moversProvenance": {
   "ruleId": "TRA-3241:session-move-ratio",
   "threshold": 1.9,
   "build": "f3ce18b6205e",
   "publishedCount": 5,
   "servedCount": 4,
   "filteredCount": 1,
   "filtered": [
    {
     "symbol": "SBFM",
     "price": 2.39,
     "changePct": 840.58,
     "provenance": {
      "ruleId": "TRA-3241:session-move-ratio",
      "threshold": 1.9,
      "ratio": 9.405800000000001,
      "impliedPrevClose": 0.25409853494652235,
      "build": "f3ce18b6205e",
      "verdict": "suspect",
      "reason": "implausible_move_ratio"
     }
    }
   ]
  }
 }
} as unknown as Record<string, EodReport>;
