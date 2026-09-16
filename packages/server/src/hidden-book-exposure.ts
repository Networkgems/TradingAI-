// TRA-4502 (parent TRA-4284) — what the dashboard is NOT showing.
//
// ── The defect this exists for ──────────────────────────────────────────────
// `viewMode` (TRA-3910) lets a live-armed operator LOOK at the demo book
// without standing the live arm down. That feature is ratified and stays. On
// 2026-09-01 the bqb1 `admin` account carried `mode: "live"` with
// `viewMode: "demo"` PERSISTED, so `/api/state` rendered `Options (0)`,
// `Positions (0)`, no Greeks panel and the demo Calendar — while three
// real-money rows sat BREACHED and INERT in the book that was not on screen.
//
// The TRA-3910 chip did fire (`Viewing DEMO book · engine is LIVE`) and it was
// true. It is a statement about ROUTING. Nothing anywhere said "and there are
// three breached rows in the book you are not looking at", so an operator could
// read the chip, correctly conclude nothing was disarmed, and still not know
// the money book was in trouble — because every panel that would tell them was
// rendering the other book.
//
// ── Why this is a FOLD and not a new measurement ────────────────────────────
// The census already exists and is already the one the exit pass is graded by:
// `summarizeLiveStopActionability` (TRA-3822, the nine-gate `checkExits` walk)
// joined to the cadence fact by `qualifyLiveStopActionability` (TRA-3839). A
// second stop-breach detector written for a banner would be a second opinion
// about real money, and the two would disagree on exactly the day it mattered.
// So this module INVENTS NOTHING: it re-shapes one book's existing qualified
// census plus one existing exposure fold (`openPremiumAtRiskForMode`) into the
// wire payload, drops the OCC-bearing fields, and stops.
//
// Pure by construction (caller owns every read), so both directions —
// "breached rows are disclosed" and "a clean book stays quiet" — are reachable
// from a test with no engine, no broker and no clock.
import type { HiddenBookExposure, HiddenBookStopExposure } from '@trading-app/shared';

/**
 * The exposure half — `OpenPremiumAtRisk` narrowed to the three fields this
 * fold reads, so a test does not have to build the adopted/pinned/unbooked
 * attribution overlay that lives on the real type.
 */
export interface HiddenBookPremiumRead {
  /** Σ `premiumPaid × contractsRemaining × 100` over priced open rows, USD. */
  usd: number;
  /** Open rows that contributed a positive figure. */
  rows: number;
  /** Open rows skipped because their premium / remaining count was unusable. */
  unpricedRows: number;
}

/**
 * The census half — `LiveStopActionabilityQualified` narrowed to what crosses
 * the wire. `byReason` is `Partial<Record<LiveStopInertReason, number>>` on the
 * real type; keyed loosely here because the labels travel as DATA (the
 * authoritative union stays with the walk it describes).
 */
export interface HiddenBookStopRead {
  breached: number;
  actionable: number;
  inFlight: number;
  inert: number;
  unacted: number;
  indefinite: number;
  byReason: Readonly<Record<string, number | undefined>>;
  releasesAt: string | null;
  exitPass: { reaches: boolean; blockedBy: string | null };
}

/** Why {@link foldHiddenBookExposure} was handed no census. */
export type HiddenBookStopsAbsence =
  /**
   * The hidden book is the DEMO one (the operator is looking at the live book
   * under an override). There is no real money to census and a `0` would read
   * as "measured, clean", so the census is absent WITH THIS REASON instead.
   */
  | { kind: 'hidden_book_is_demo' }
  /** The census threw. The instrument is BLIND, which is not the same as clean. */
  | { kind: 'blind'; reason: string };

function roundUsd(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * TRA-4502 — one book's stop census, reduced to the wire shape.
 *
 * `inertReasons` is count-descending, then label-ascending, so the payload is
 * stable across frames for a given census (a banner that re-orders its own
 * reasons every tick reads as new information arriving when none did).
 */
export function foldHiddenBookStopExposure(read: HiddenBookStopRead): HiddenBookStopExposure {
  const inertReasons = Object.entries(read.byReason)
    .flatMap(([reason, count]) =>
      typeof count === 'number' && Number.isFinite(count) && count > 0
        ? [{ reason, count }]
        : [],
    )
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    breached: read.breached,
    actionable: read.actionable,
    inFlight: read.inFlight,
    inert: read.inert,
    unacted: read.unacted,
    indefinite: read.indefinite,
    inertReasons,
    releasesAt: read.releasesAt,
    // TRA-3839 — `reaches: true` is the only reading that means no cadence
    // blocker. A `blockedBy: null` alongside `reaches: false` would be the
    // walk's own bug, and it must not publish as "a pass reaches these rows":
    // that is the all-clear this ticket exists to stop manufacturing.
    exitPassBlockedBy: read.exitPass.reaches ? null : (read.exitPass.blockedBy ?? 'unknown'),
  };
}

/**
 * TRA-4502 — the `/api/state` payload describing the book that is NOT on screen.
 *
 * `stops` is present ⇔ `absence` is undefined. Callers must pass an
 * {@link HiddenBookStopsAbsence} rather than omitting the census silently: the
 * two reasons a census can be missing need opposite responses from a reader
 * (nothing to measure vs. the instrument is down) and a bare `null` cannot tell
 * them apart.
 */
export function foldHiddenBookExposure(input: {
  /** The book NOT being rendered — the engine's routing book while an override is set. */
  hiddenBook: 'demo' | 'live';
  /** The book being rendered. */
  shownBook: 'demo' | 'live';
  premium: HiddenBookPremiumRead;
  stops?: HiddenBookStopRead;
  absence?: HiddenBookStopsAbsence;
}): HiddenBookExposure {
  const { hiddenBook, shownBook, premium } = input;
  const stops = input.stops === undefined ? null : foldHiddenBookStopExposure(input.stops);
  const stopsUnavailableReason =
    stops !== null
      ? null
      : input.absence === undefined
        ? 'unspecified'
        : input.absence.kind === 'blind'
          ? `census_failed: ${input.absence.reason}`
          : input.absence.kind;
  return {
    book: hiddenBook,
    shownBook,
    // Every open row lands in exactly one of the two buckets the fold keeps
    // (`foldOpenPremiumAtRisk` either prices a row or counts it unpriced), so
    // this is the open-row count and not an approximation of one.
    openOptionRows: premium.rows + premium.unpricedRows,
    openPremiumUsd: roundUsd(premium.usd),
    unpricedRows: premium.unpricedRows,
    stops,
    stopsUnavailableReason,
  };
}
