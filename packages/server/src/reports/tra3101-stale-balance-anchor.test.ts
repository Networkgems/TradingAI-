import { describe, it, expect } from 'vitest';
import {
  classifyBalanceAnchor,
  decideBalanceCellDisposition,
  isPnlUnknown,
  shouldAuditBalanceAnchor,
  spanDaysBetween,
  type DayActivityEvidence,
} from './stale-balance-anchor.js';

/**
 * TRA-3101 — the whole point of this suite is that a `$0.00` cell and a
 * never-landed snapshot were the SAME rendered pixels. So every test here is
 * written as "which of the two indistinguishable states is this", not "does the
 * arithmetic work" — the arithmetic (`today − prev − cashFlow`) was already
 * exact when the calendar was wrong (TRA-2864).
 *
 * The anchor case is the board's own live book on **2026-06-12**: equity
 * 1019.67 against a 2026-06-11 anchor of 1019.67, while Tradier's `gainloss.csv`
 * books −$141.72 of realized closes (META, AAPL, RKLB) that same day.
 */

const QUIET: DayActivityEvidence = {
  known: true,
  brokerCloses: 0,
  brokerRealizedUsd: 0,
  engineTrades: 0,
  openPositions: 0,
};

describe('spanDaysBetween', () => {
  it('counts consecutive days as 1 and a Fri→Mon weekend hop as 3', () => {
    expect(spanDaysBetween('2026-06-11', '2026-06-12')).toBe(1);
    expect(spanDaysBetween('2026-07-02', '2026-07-05')).toBe(3);
  });

  it('returns 0 rather than NaN on an unparseable date', () => {
    expect(spanDaysBetween('not-a-date', '2026-06-12')).toBe(0);
  });
});

describe('classifyBalanceAnchor — the 2026-06-12 proof case', () => {
  it('calls the day UNKNOWN when the anchor is a copy and the broker booked closes', () => {
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 1019.67,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: {
        known: true,
        brokerCloses: 3,
        brokerRealizedUsd: -141.72,
        engineTrades: 3,
        openPositions: 0,
      },
    });
    expect(v.status).toBe('stale_anchor');
    expect(isPnlUnknown(v)).toBe(true);
    expect(v.flatVerified).toBe(false);
    expect(v.spanDays).toBe(1);
    // The detail must name the contradiction, not just assert a verdict.
    expect(v.detail).toContain('3 broker option closes');
    expect(v.detail).toContain('141.72');
    // And it must NOT propose a repaired figure — the series has a hole.
    expect(v.detail).toContain('has deliberately not been re-derived');
  });

  it('does NOT fire when the same day carries a real delta', () => {
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 877.95, // 1019.67 − 141.72, i.e. the snapshot landed
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: {
        known: true,
        brokerCloses: 3,
        brokerRealizedUsd: -141.72,
        engineTrades: 3,
        openPositions: 0,
      },
    });
    expect(v.status).toBe('ok');
    expect(isPnlUnknown(v)).toBe(false);
  });

  it('fires on a sub-cent difference only when the values are truly identical', () => {
    // One cent of movement is a landed snapshot. The defect signature is an
    // EXACT copy, so this must stay `ok` or the detector becomes a noise source.
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 1019.68,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: { known: true, brokerCloses: 3, brokerRealizedUsd: -141.72, engineTrades: 0, openPositions: 0 },
    });
    expect(v.status).toBe('ok');
  });
});

describe('classifyBalanceAnchor — the three activity channels are independent', () => {
  it('open positions alone are enough: marks move, so equity cannot be unchanged', () => {
    // This is the channel that reaches the JUNE cells. Their broker sidecar has
    // long since rolled out of the reconcile window, but `openPositionCount` is
    // on every stored row.
    const v = classifyBalanceAnchor({
      reportDate: '2026-07-15',
      reportBalance: 168.58,
      anchorDate: '2026-07-13',
      anchorBalance: 168.58,
      activity: { known: true, brokerCloses: 0, brokerRealizedUsd: 0, engineTrades: 0, openPositions: 2 },
    });
    expect(v.status).toBe('stale_anchor');
    expect(v.detail).toContain('2 open positions carrying mark-to-market');
    expect(v.spanDays).toBe(2);
  });

  it('engine trades alone are enough', () => {
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-17',
      reportBalance: 800.83,
      anchorDate: '2026-06-16',
      anchorBalance: 800.83,
      activity: { known: true, brokerCloses: 0, brokerRealizedUsd: 0, engineTrades: 1, openPositions: 0 },
    });
    expect(v.status).toBe('stale_anchor');
    expect(v.detail).toContain('1 engine-recorded trade');
  });

  it('broker realized $ with no close count still counts', () => {
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-26',
      reportBalance: 401.51,
      anchorDate: '2026-06-25',
      anchorBalance: 401.51,
      activity: { known: true, brokerCloses: 0, brokerRealizedUsd: -12.5, engineTrades: 0, openPositions: 0 },
    });
    expect(v.status).toBe('stale_anchor');
    expect(v.detail).toContain('of broker-realized P&L');
  });
});

describe('classifyBalanceAnchor — a verified quiet day is NOT flagged', () => {
  it('clears an identical balance when all three channels read a genuine zero', () => {
    // A dormant all-cash account really does sit still. Flagging it would train
    // the reader to ignore the badge, which costs more than it buys.
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 1019.67,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: QUIET,
    });
    expect(v.status).toBe('ok');
    expect(v.flatVerified).toBe(true);
    expect(isPnlUnknown(v)).toBe(false);
    expect(v.detail).toContain('confirmed quiet');
  });
});

describe('classifyBalanceAnchor — BLIND is not EMPTY (fails closed)', () => {
  it('an unreadable evidence source yields UNKNOWN, never a verified flat day', () => {
    // The whole shape of TRA-3073: a read that fails must not be spelled the
    // same way as a read that found nothing. Arms 2 and 4 differ ONLY here.
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 1019.67,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: { known: false, reason: 'tradier-options-pnl.production.json unparseable' },
    });
    expect(v.status).toBe('unverifiable');
    expect(isPnlUnknown(v)).toBe(true);
    expect(v.flatVerified).toBe(false);
    expect(v.detail).toContain('unparseable');
  });

  it('blindness does NOT flag a day that has a real delta', () => {
    // Fail-closed must not mean fail-everywhere: with a real delta there is
    // nothing for this detector to say, readable evidence or not.
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 877.95,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: { known: false, reason: 'broker unreachable' },
    });
    expect(v.status).toBe('ok');
  });

  it('a NaN balance is treated as "no delta claim", not as an identical pair', () => {
    const v = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: Number.NaN,
      anchorDate: '2026-06-11',
      anchorBalance: Number.NaN,
      activity: QUIET,
    });
    expect(v.status).toBe('ok');
    expect(v.flatVerified).toBe(false);
  });
});

describe('classifyBalanceAnchor — every one of the seven reported cells is reached', () => {
  // The full table from the ticket. Each row is `equity == prevEquity` and each
  // rendered a neutral `$0.00`. With activity present, all seven must come back
  // UNKNOWN — a detector that catches only 06-12 has not fixed the calendar.
  const CELLS: Array<[date: string, equity: number, prevDate: string]> = [
    ['2026-06-12', 1019.67, '2026-06-11'],
    ['2026-06-17', 800.83, '2026-06-16'],
    ['2026-06-26', 401.51, '2026-06-25'],
    ['2026-07-05', 284.82, '2026-07-02'],
    ['2026-07-06', 284.82, '2026-07-05'],
    ['2026-07-13', 168.58, '2026-07-10'],
    ['2026-07-15', 168.58, '2026-07-13'],
  ];

  it.each(CELLS)('%s renders UNKNOWN, not $0.00', (date, equity, prevDate) => {
    const v = classifyBalanceAnchor({
      reportDate: date,
      reportBalance: equity,
      anchorDate: prevDate,
      anchorBalance: equity,
      activity: { known: true, brokerCloses: 0, brokerRealizedUsd: 0, engineTrades: 0, openPositions: 1 },
    });
    expect(v.status).toBe('stale_anchor');
    expect(isPnlUnknown(v)).toBe(true);
  });

  it('spans the weekend hops the ticket recorded (3d on 07-05 and 07-13)', () => {
    expect(spanDaysBetween('2026-07-02', '2026-07-05')).toBe(3);
    expect(spanDaysBetween('2026-07-10', '2026-07-13')).toBe(3);
  });
});

// ── THE REACH GATE ───────────────────────────────────────────────────────────
//
// ★ The most important test in this file. A detector that is correct and cannot
// reach the broken rows has fixed nothing — that is the whole of TRA-2864, and
// this fix walked into it: the first draft scoped the read-time audit to
// `pnlSource === 'tradier-balance'`, which skips 2026-06-12.
//
// The scope was corrected only because the seven live cells were READ before
// shipping. These are the values that came back from the live book on
// 2026-08-06 (admin, read-only) — note the three `undefined`s.

describe('shouldAuditBalanceAnchor — measured against the live book, 2026-08-06', () => {
  const LIVE_CELLS: Array<[date: string, pnlSource: string | undefined]> = [
    ['2026-06-12', undefined],          // ⛔ THE PROOF CASE — carries no pnlSource
    ['2026-06-17', undefined],
    ['2026-06-26', undefined],
    ['2026-07-05', 'tradier-balance'],
    ['2026-07-06', 'tradier-balance'],
    ['2026-07-13', 'tradier-balance'],
    ['2026-07-15', 'tradier-balance'],
  ];

  it.each(LIVE_CELLS)('%s (pnlSource=%s) is IN SCOPE for the audit', (_date, pnlSource) => {
    expect(shouldAuditBalanceAnchor(pnlSource)).toBe(true);
  });

  it('an UNLABELLED row is audited — not knowing the measure is a reason to look', () => {
    // This single assertion is what separates the shipped gate from the draft
    // that could not reach 2026-06-12.
    expect(shouldAuditBalanceAnchor(undefined)).toBe(true);
  });

  it('rows with no balance anchor at all are skipped', () => {
    expect(shouldAuditBalanceAnchor('realized-backfill')).toBe(false);
    expect(shouldAuditBalanceAnchor('engine')).toBe(false);
    expect(shouldAuditBalanceAnchor('live-intraday')).toBe(false);
  });
});

// ── The WRITE DECISION ───────────────────────────────────────────────────────
//
// ★ These are the tests that matter. `classifyBalanceAnchor` returning the right
// verdict is worth nothing if the row still ships a bare `$0.00` — TRA-2864's
// whole lesson is that the compute can be exact while the write decision cannot
// reach the broken cells. This is the real gate, exported and graded directly
// rather than mirrored (see the module docblock).

const AT = '2026-08-06T12:00:00.000Z';

/** The 06-12 case, all the way through the decision. */
function decide0612(activity: DayActivityEvidence) {
  const verdict = classifyBalanceAnchor({
    reportDate: '2026-06-12',
    reportBalance: 1019.67,
    anchorDate: '2026-06-11',
    anchorBalance: 1019.67,
    activity,
  });
  return decideBalanceCellDisposition(
    {
      reportDate: '2026-06-12',
      todayBalance: 1019.67,
      prevDate: '2026-06-11',
      prevBalance: 1019.67,
      netCashFlow: 0,
      combinedPnl: 0,
      verdict,
    },
    AT,
  );
}

describe('decideBalanceCellDisposition', () => {
  it('stamps the absence state and REFUSES to present the zero as a finding', () => {
    const d = decide0612({
      known: true,
      brokerCloses: 3,
      brokerRealizedUsd: -141.72,
      engineTrades: 3,
      openPositions: 0,
    });
    expect(d.pnlUnknown).not.toBeNull();
    expect(d.pnlUnknown?.reason).toBe('stale_balance_anchor');
    expect(d.pnlUnknown?.anchorDate).toBe('2026-06-11');
    expect(d.pnlUnknown?.anchorBalance).toBe(1019.67);
    expect(d.pnlUnknown?.reportedBalance).toBe(1019.67);
    expect(d.pnlUnknown?.spanDays).toBe(1);
    expect(d.pnlUnknown?.at).toBe(AT);

    // The header is the raw-markdown surface an auditor reads. Pre-fix it said
    // "= +0.00" in the same breath as "broker balance", which is the sentence
    // that made this defect survive two months.
    expect(d.header).toContain('UNKNOWN');
    expect(d.header).toContain('ARTEFACT, not a flat day');
    expect(d.header).toContain('Do not read `combinedPnl` on this row');
    expect(d.header).not.toContain('Live P&L source: Tradier broker balance');
  });

  it('an unreadable evidence source gets its OWN reason code, not the stale one', () => {
    // Two different defects. `balance_evidence_unreadable` says "the instrument
    // was blind"; `stale_balance_anchor` says "the instrument saw a
    // contradiction". Collapsing them would hide an outage inside a data bug.
    const d = decide0612({ known: false, reason: 'sidecar unreadable' });
    expect(d.pnlUnknown?.reason).toBe('balance_evidence_unreadable');
    expect(d.pnlUnknown?.evidence).toEqual({ known: false, reason: 'sidecar unreadable' });
  });

  it('leaves a healthy cell completely alone — no pnlUnknown, original header', () => {
    const verdict = classifyBalanceAnchor({
      reportDate: '2026-06-12',
      reportBalance: 877.95,
      anchorDate: '2026-06-11',
      anchorBalance: 1019.67,
      activity: { known: true, brokerCloses: 3, brokerRealizedUsd: -141.72, engineTrades: 3, openPositions: 0 },
    });
    const d = decideBalanceCellDisposition(
      {
        reportDate: '2026-06-12',
        todayBalance: 877.95,
        prevDate: '2026-06-11',
        prevBalance: 1019.67,
        netCashFlow: 0,
        combinedPnl: -141.72,
        verdict,
      },
      AT,
    );
    expect(d.pnlUnknown).toBeNull();
    expect(d.header).toContain('Live P&L source: Tradier broker balance');
    expect(d.header).toContain('-141.72');
    expect(d.header).not.toContain('UNKNOWN');
  });

  it('a VERIFIED quiet day keeps the ordinary header — the badge must stay rare', () => {
    const d = decide0612({
      known: true,
      brokerCloses: 0,
      brokerRealizedUsd: 0,
      engineTrades: 0,
      openPositions: 0,
    });
    expect(d.pnlUnknown).toBeNull();
    expect(d.header).toContain('Live P&L source: Tradier broker balance');
  });

  it('carries the evidence onto the row so the verdict can be re-derived later', () => {
    // A verdict you cannot audit is a verdict you have to take on faith. Every
    // input that drove it travels with it.
    const d = decide0612({
      known: true,
      brokerCloses: 3,
      brokerRealizedUsd: -141.72,
      engineTrades: 3,
      openPositions: 1,
    });
    expect(d.pnlUnknown?.evidence).toEqual({
      known: true,
      brokerCloses: 3,
      brokerRealizedUsd: -141.72,
      engineTrades: 3,
      openPositions: 1,
    });
  });

  it('does NOT propose a repaired combinedPnl anywhere in its output', () => {
    // The ticket is explicit: do not silently repair by re-deriving. The
    // decision may relabel the row; it may not invent the missing equity point.
    const d = decide0612({
      known: true,
      brokerCloses: 3,
      brokerRealizedUsd: -141.72,
      engineTrades: 3,
      openPositions: 0,
    });
    expect(Object.keys(d.pnlUnknown ?? {})).not.toContain('correctedPnl');
    expect(Object.keys(d.pnlUnknown ?? {})).not.toContain('combinedPnl');
    // −141.72 appears in the PROSE as evidence of the contradiction, but the
    // header must never present it as this day's P&L.
    expect(d.header).not.toContain('= **-141.72**');
  });
});
