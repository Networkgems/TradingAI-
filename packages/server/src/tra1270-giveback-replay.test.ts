import { describe, it, expect } from 'vitest';
import { BOOK_GIVEBACK_CAP_PCT, BOOK_SESSION_STOP_R } from '@trading-app/shared';
import {
  replayGivebackSession,
  BOARD_GIVEBACK_SESSION,
  SESSION_STOP_SESSION,
  formatReplayReport,
} from './tra1270-giveback-replay.js';

// TRA-1270 (TRA-1250 Rule 3) — replay proof that the book-level give-back guard
// "demonstrably fires" against the board's cached +$1,599 → +$483 session,
// driven through the REAL production DailyRiskGovernor.

describe('TRA-1270 give-back replay — board +$1,599 → +$483 cached session', () => {
  const r = replayGivebackSession(BOARD_GIVEBACK_SESSION);

  it('latches the give-back halt BEFORE the day round-trips to the +$483 close', () => {
    expect(r.haltIndex).toBeGreaterThanOrEqual(0);
    expect(r.haltReason).toMatch(/give-back/i);
    // The un-guarded day closed at +$483; the guard stopped the bleed while the
    // book was still up near the +$960 floor — nowhere near +$483.
    expect(r.haltAtPnl).toBeGreaterThan(r.endPnlWithoutGuard);
    expect(r.endPnlWithoutGuard).toBe(483);
  });

  it('floors the day near +$960 — Appendix A parity (peak × (1 − 40%))', () => {
    expect(r.peakGain).toBe(1_599);
    // 1599 × 0.60 = 959.40 — Appendix A's promised "~+$960" floor.
    expect(r.retainedFloor).toBeCloseTo(1_599 * (1 - BOOK_GIVEBACK_CAP_PCT), 5);
    expect(r.retainedFloor).toBeCloseTo(959.4, 2);
    // Halt latched just below the 60% floor (retained ≈ 59% of the peak).
    expect(r.haltAtPnl).toBeLessThan(r.retainedFloor);
    expect(r.haltAtPnl / r.peakGain).toBeGreaterThan(0.55);
    expect(r.haltAtPnl / r.peakGain).toBeLessThan(0.61);
  });

  it('banks the gain the un-guarded day gave back and halts new entries', () => {
    // Guard banked (haltAtPnl − un-guarded close) that would otherwise be lost.
    expect(r.givebackBlocked).toBeGreaterThan(400);
    expect(r.entriesBlockedAfterHalt).toBe(true);
  });
});

describe('TRA-1270 give-back replay — hard session-stop cached session', () => {
  const r = replayGivebackSession(SESSION_STOP_SESSION);

  it('latches the session-stop when the book flips net-negative after the +1R arm', () => {
    expect(r.haltIndex).toBeGreaterThanOrEqual(0);
    expect(r.haltReason).toMatch(/session stop/i);
    // Peak (+$1,050) cleared the max(1R, $100) arm ($1,000 on $100k) before the flip.
    expect(r.peakGain).toBeGreaterThan(BOOK_SESSION_STOP_R * 0.01 * SESSION_STOP_SESSION.bookEquity);
    expect(r.entriesBlockedAfterHalt).toBe(true);
  });
});

describe('TRA-1270 give-back replay — report renders for evidence', () => {
  it('produces a non-empty human-readable report for the board session', () => {
    const report = formatReplayReport(replayGivebackSession(BOARD_GIVEBACK_SESSION));
    expect(report).toMatch(/halt fired\s*:\s*YES/);
    expect(report).toMatch(/give-back floor/);
  });
});
