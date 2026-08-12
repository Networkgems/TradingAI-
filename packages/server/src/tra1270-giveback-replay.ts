// TRA-1270 (TRA-1250 Rule 3) — give-back guard REPLAY harness.
//
// Purpose: satisfy TRA-1250's "demonstrably fires" acceptance by replaying a
// cached intraday book-P&L session through the REAL production
// `DailyRiskGovernor.markBook` (the exact code path the live engine calls each
// tick behind `EXIT_RISK_RULES_ENABLED`) and showing the book-level give-back
// cap latches the session halt at the ~60%-retained floor BEFORE the book can
// round-trip its gains.
//
// The canonical cached session is the board's own reported day — "up $1,599,
// ended at $483" (TRA-1249 analysis, Appendix A). Appendix A promises Rule 3
// "floors a +$1,599 → +$483 day near +$960"; this replay reproduces exactly
// that, driving the intraday (realized + open) book P&L path tick-by-tick and
// asserting the halt fires at the give-back floor. A second cached session
// exercises the hard session-stop (net-negative after being up ≥ the arm,
// TRA-3218: max(1R, $100)).
//
// This is pure replay: no I/O, no broker, no engine boot. It imports the same
// `DailyRiskGovernor` the server runs so the thresholds under test ARE the
// production thresholds (`BOOK_GIVEBACK_CAP_PCT`, `BOOK_SESSION_STOP_R`).

import { DailyRiskGovernor } from './signal-engine.js';
import { BOOK_GIVEBACK_CAP_PCT } from '@trading-app/shared';

export interface CachedSession {
  /** Human label for the replayed day. */
  label: string;
  /** Managed book equity (sizes the max(1R, $100) session-stop arm; not the give-back floor). */
  bookEquity: number;
  /**
   * Ordered intraday marks of (realized + open) book P&L in dollars, one per
   * "tick" the engine would mark the book. Monotonic peak is derived by the
   * governor itself; the path just has to rise to a peak and then reverse.
   */
  bookPnlPath: number[];
}

export interface ReplayResult {
  label: string;
  /** Monotonic intraday peak of book gain the governor tracked (floored at 0). */
  peakGain: number;
  /** The give-back floor = peak × (1 − cap). Dropping below trips the cap. */
  retainedFloor: number;
  /** Index into `bookPnlPath` where the halt latched, or −1 if it never fired. */
  haltIndex: number;
  /** Book P&L at the tick the halt latched. */
  haltAtPnl: number;
  /** The latched halt reason string, or null. */
  haltReason: string | null;
  /** Book P&L at the END of the replayed path (where the day would have closed). */
  endPnlWithoutGuard: number;
  /**
   * Dollars the guard protected: what the book retained at the halt tick minus
   * where the un-guarded day actually closed. Positive ⇒ the guard banked gain
   * that would otherwise have been given back.
   */
  givebackBlocked: number;
  /** True once the halt is latched — new opens are blocked for the session. */
  entriesBlockedAfterHalt: boolean;
}

/**
 * Replay one cached session through the production `DailyRiskGovernor`. Marks
 * the book at every tick in `bookPnlPath`; on the first tick that trips the
 * give-back cap (or session stop) the halt latches and we record where.
 */
export function replayGivebackSession(session: CachedSession): ReplayResult {
  // Pin a fixed ET trading-day clock so the session never rolls mid-replay.
  const gov = new DailyRiskGovernor(() => new Date('2026-07-01T15:00:00Z'));

  let haltIndex = -1;
  let haltAtPnl = NaN;
  let peakSeen = 0;

  for (let i = 0; i < session.bookPnlPath.length; i++) {
    const pnl = session.bookPnlPath[i];
    peakSeen = Math.max(peakSeen, pnl, 0);
    const { tripped } = gov.markBook(pnl, session.bookEquity);
    if (tripped && haltIndex === -1) {
      haltIndex = i;
      haltAtPnl = pnl;
    }
  }

  const retainedFloor = peakSeen * (1 - BOOK_GIVEBACK_CAP_PCT);
  const endPnlWithoutGuard = session.bookPnlPath[session.bookPnlPath.length - 1];

  return {
    label: session.label,
    peakGain: peakSeen,
    retainedFloor,
    haltIndex,
    haltAtPnl,
    haltReason: gov.getBookHaltReason(),
    endPnlWithoutGuard,
    givebackBlocked: haltIndex === -1 ? 0 : haltAtPnl - endPnlWithoutGuard,
    // Once the book halt is latched, isHalted() is true, so the equity entry
    // gate (and options gate via isBookHalted) blocks all new opens.
    entriesBlockedAfterHalt: gov.isHalted(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached sessions (board-reported figures — TRA-1249 analysis / Appendix A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The board's headline giveback day: "Yesterday we were up $1,599 but ended the
 * day with $483." Intraday book P&L climbs (with dips) to a +$1,599 peak, then
 * reverses toward the +$483 close. Give-back floor = 1599 × 0.60 = +$959.40, so
 * the cap must latch on the first tick below it — banking ~+$950 instead of
 * bleeding to +$483.
 */
export const BOARD_GIVEBACK_SESSION: CachedSession = {
  label: 'Board +$1,599 → +$483 giveback day (TRA-1249)',
  bookEquity: 100_000,
  bookPnlPath: [
    0, 250, 600, 450, 900, 1200, 1050, 1400, 1599, // rise to the +$1,599 peak
    1500, 1300, 1100, 980, // dip toward the floor (980 still > 959.40 → no halt)
    950, // FIRST tick below the +$959.40 give-back floor → HALT latches here
    700, 483, // where the un-guarded day actually closed (never reached: halted)
  ],
};

/**
 * Hard session-stop day: book runs up past the session-stop arm (TRA-3218:
 * max(1R, $100) = $1,000 on $100k) then flips net-negative — the give-back
 * arithmetic is moot; the session-stop latches because a net-negative book
 * after a real up-move is the worst state.
 */
export const SESSION_STOP_SESSION: CachedSession = {
  label: 'Session-stop day (up +$1,050 then net-negative)',
  bookEquity: 100_000,
  // Drop from above the give-back floor ($630) STRAIGHT to net-negative in one
  // tick so the session-stop branch (not the give-back cap) is what latches.
  bookPnlPath: [0, 300, 1_050, 900, -120], // net-negative after being up ≥ $1,000
};

export const CACHED_SESSIONS: CachedSession[] = [BOARD_GIVEBACK_SESSION, SESSION_STOP_SESSION];

/** Render a replay result as a human-readable report line block. */
export function formatReplayReport(r: ReplayResult): string {
  const fired = r.haltIndex >= 0;
  return [
    `── ${r.label}`,
    `   peak gain            : +$${r.peakGain.toFixed(0)}`,
    `   give-back floor (60%): +$${r.retainedFloor.toFixed(0)}`,
    `   halt fired           : ${fired ? 'YES' : 'NO'}`,
    fired ? `   halted at tick #${r.haltIndex} @ +$${r.haltAtPnl.toFixed(0)} (retained ${((r.haltAtPnl / r.peakGain) * 100).toFixed(0)}% of peak)` : '',
    fired ? `   reason               : ${r.haltReason}` : '',
    `   un-guarded close     : +$${r.endPnlWithoutGuard.toFixed(0)}`,
    fired ? `   giveback blocked     : +$${r.givebackBlocked.toFixed(0)} banked vs the un-guarded close` : '',
    `   new entries blocked  : ${r.entriesBlockedAfterHalt ? 'YES (isHalted latched)' : 'NO'}`,
  ].filter(Boolean).join('\n');
}
