// TRA-2888 (parent TRA-2886, CFO ruling 2026-08-04) — the permanent EOD ledger
// gap of 2026-07-30 / 07-31 / 08-03, and the INTERIOR-ABSENCE detector that
// exists because nothing in this codebase could see it.
//
// ── Why an absent session is invisible to every axis we already publish ───────
//
// There are three EOD presence axes in `pnl-reconciliation.ts`, and an absent
// session defeats all three by the same mechanism:
//
//   `eodRowMissing`      per-row — walks `days[]`, which is built FROM the
//                        persisted snapshots. A session with no snapshot is not
//                        in `days[]`, so it is never walked, so it can never be
//                        flagged. There is no row to mark missing.
//   `eodRowsPresentOk`   folds the above. Inherits the blindness exactly.
//   `eodTailStaleSessions` (TRA-2817) DOES enumerate from the calendar — but
//                        only over `(newestRow, lastSettledSession]`. It is a
//                        TAIL construction, and a tail collapses to empty the
//                        moment a later row lands. When the fleet wrote its
//                        2026-08-04 rows, the anchor advanced 07-29 -> 08-04 and
//                        three sessions of missing ledger moved from "the tail"
//                        to "the interior", where nothing looks.
//
// Measured on live bqb1 2026-08-05T03:17Z, build `237c147e`, 62 engines:
//
//     liveEodRowsPresentOk         true
//     liveEodRowMissingBooks       []
//     liveEodTailStaleBooks        []
//     liveEodTailMaxStaleSessions  0
//     eodTailSettledSession        "2026-08-04"
//
// Every field green. Three sessions of fleet-wide ledger permanently gone. The
// tail metric going 3 -> 0 across the 08-04 archive reads as a full recovery and
// is in fact the evidence being evicted from the only cohort that could see it.
//
// This is the same failure class as TRA-2635 / TRA-2637 / TRA-2633: a clean
// reading and a never-measured one rendering identically. The fix is the same
// shape it always is here — enumerate the cohort from a source INDEPENDENT of
// the thing being graded. The exchange calendar knows what a session is without
// asking the ledger whether it wrote one.
//
// ── Why this is not folded into the tail axis ────────────────────────────────
//
// The tail axis answers "has the writer stopped?" and must stay cheap to read
// daily. This axis answers "is the recorded history complete?" — a different
// question with a different remediation and a different decay profile. A tail
// red is urgent and self-clearing; an interior red is permanent until someone
// rules on it, which is exactly what happened here. Pooling them would let a
// resumed writer's green tail mask a hole it left behind, which is precisely the
// eviction this ticket exists to stop.

import type { EodTailCalendar } from './pnl-reconciliation.js';

/**
 * The three sessions the 21:00 ET archive never captured, fleet-wide.
 *
 * ── Why a hardcoded literal is correct HERE and was wrong in the back-fill ───
 *
 * `eod-row-backfill.ts` carries an explicit note explaining why it contains no
 * date literal: the set it operates on is "sessions whose row is missing", which
 * is open-ended and decays (a fourth failed night would silently fall outside a
 * writer pinned to three). That reasoning is sound and still holds for a WRITER.
 *
 * This constant is a different kind of object. It is not a derived working set —
 * it is the RULING: a closed, adjudicated historical fact about three specific
 * dates, authorised once, never to grow. If a fourth session goes absent it must
 * NOT be absorbed here; it is a new incident and the detector below is built to
 * make it fire. That is the entire point of keeping the exclusion a three-
 * element allow-list rather than a date range, a `>=` bound, or a suppression
 * window: a range would swallow the next incident, and a bound would swallow
 * every incident after it. This list can only ever fail closed.
 */
export const EOD_DOCUMENTED_GAP_DATES: readonly string[] = Object.freeze([
  '2026-07-30',
  '2026-07-31',
  '2026-08-03',
]);

/** The ruling that authorised recording the gap as permanent. */
export const EOD_DOCUMENTED_GAP_TICKET = 'TRA-2888';

/**
 * The gap, as a structured record published on
 * `/api/health/pnl-reconciliation` beside the presence axes it explains.
 *
 * Published as DATA and not only as prose for the reason TRA-2630 AC1 gives:
 * a checker cannot assert an English sentence in a string array, but it can
 * assert `backfillAuthorised === false`. The `caveats` prose ships too — see
 * `PNL_EOD_DOCUMENTED_GAP_NOTE` — but the machine-readable form is what a future
 * gate should key on.
 */
export interface EodDocumentedGap {
  ticket: string;
  dates: readonly string[];
  /** Fleet-wide, not live-book-only. Measured, not assumed — see `scope`. */
  scope: string;
  cause: string;
  /** Were these sessions written and then lost, or never written at all? */
  capture: string;
  /** Is reconstructing these rows authorised? Permanently false. */
  backfillAuthorised: false;
  backfillFlag: string;
  /** Acceptance predicates this ruling RETIRES, with the reason each is dead. */
  retiredAcceptanceLines: ReadonlyArray<{ ticket: string; line: string; why: string }>;
}

export const EOD_DOCUMENTED_GAP: EodDocumentedGap = Object.freeze({
  ticket: EOD_DOCUMENTED_GAP_TICKET,
  dates: EOD_DOCUMENTED_GAP_DATES,
  scope:
    'Fleet-wide, not live-book-only. Re-measured independently on bqb1 2026-08-05T03:17Z (build 237c147e): of the 47 books whose history spans the window (a row on/before 2026-07-29 AND a row on/after 2026-08-04), 47 of 47 are missing all three dates, with zero partials -- every book steps 2026-07-29 -> 2026-08-04. No book anywhere holds a row on any of the three. (The parent ruling cited 61; 61 is the count of engines with any rows at all, 47 is the count whose history actually spans the window and can be graded on it. The finding is unchanged.)',
  cause:
    '/data was at ENOSPC from 2026-07-30 through 2026-08-04T21:20Z -- out of INODES, not bytes, so appends survived while file CREATES failed and every disk axis read green (TRA-2817). The 21:00 ET archive fired on time on the closes on tape; each EOD report/snapshot write then died with "EOD report failed ... ENOSPC" across 47 books. The capture failed at the only moment the figures existed.',
  capture:
    'NEVER CAPTURED. These sessions were not lost in transit, not written-then-deleted, and not held in any upstream store awaiting recovery. No source holds them. There is nothing to restore, which is why widening the back-fill was refused rather than merely deferred.',
  backfillAuthorised: false,
  backfillFlag: 'ENABLE_EOD_ROW_BACKFILL',
  retiredAcceptanceLines: Object.freeze([
    Object.freeze({
      ticket: 'TRA-2829',
      line: 'liveEodTailStaleBooks is empty',
      why: 'Already true, and true for the WRONG reason. The tail cohort is (newestRow, lastSettledSession]; when the 2026-08-04 rows landed the anchor advanced 07-29 -> 08-04 and the three absent sessions left the cohort entirely. The predicate went green by eviction, not by repair, and now discriminates nothing -- it reads identically on a healthy ledger and on this one. Retired. Grade the SET OF USERNAMES in eodInteriorAbsentBooks instead: that cohort is enumerated from the calendar and therefore cannot be emptied by a later row. Do NOT grade the fleet boolean eodInteriorAbsentOk -- it was this ticket\'s original replacement pointer and TRA-2943 has since retired it as pinned-false; see EOD_INTERIOR_ABSENT_OK_RETIREMENT, published as eodInteriorAbsentOkRetirement.',
    }),
  ]),
});

/** Prose form of the ruling, spread into the endpoint's top-level `caveats`. */
export const PNL_EOD_DOCUMENTED_GAP_NOTE =
  'TRA-2888: 2026-07-30, 2026-07-31 and 2026-08-03 are a PERMANENT, UNRECOVERABLE gap in the EOD ledger, FLEET-WIDE. These sessions were NEVER CAPTURED -- not lost in transit. /data was at ENOSPC (out of INODES, not bytes -- appends survived, file creates failed, every disk axis read green) from 2026-07-30 through 2026-08-04T21:20Z; the 21:00 ET archive fired on time and every EOD report/snapshot write died with ENOSPC across 47 books on both nights. No source holds these figures. Re-measured on bqb1 2026-08-05T03:17Z build 237c147e: of 47 books whose history spans the window, 47 of 47 miss all three dates, zero partials -- every book steps 2026-07-29 -> 2026-08-04. Back-fill is NOT authorised and ENABLE_EOD_ROW_BACKFILL stays false; if anyone proposes arming it, this ruling is the answer. RETIRED by this ruling: the TRA-2829 acceptance line "liveEodTailStaleBooks is empty" -- it is already true and discriminates nothing, because the tail cohort is (newestRow, lastSettledSession] and the three absent sessions left it when the 2026-08-04 rows advanced the anchor. It went green by EVICTION, not repair. Grade the SET OF USERNAMES in `eodInteriorAbsentBooks` instead: that cohort is enumerated from the exchange calendar and diffed against rows present, so it cannot be emptied by a later row. Do NOT grade the fleet boolean `eodInteriorAbsentOk` -- this ticket originally pointed there and TRA-2943 has since RETIRED it as pinned-false; read `eodInteriorAbsentOkRetirement` for the ruling and the identity it is pinned by. NOTE the three dates are excluded from that verdict as this documented gap and are published separately -- fleet-level under `eodInteriorDocumentedGapBooks`, per book under `engines[].eodInterior.interiorAbsentDocumented`; the exclusion is a three-element allow-list, never a range or a cutoff, so a NEW interior hole still goes red -- one already does (`enock`; the route shows 10 clamped post-baseline dates, but the INCIDENT is thirty absent sessions -- see `eodInteriorAbsentOkRetirement.adjudicated` -- and was invisible to every field published before this ticket). This ruling does NOT discharge the TRA-2829 provenance ceiling: the live book\'s post-baseline `optionsDailyPnlSource` is `journal-repair`, not `journal`. A resumed ledger confirms the ledger resumed, nothing more.';

/**
 * TRA-2943 (CFO ruling 2026-08-05, adjudicating TRA-2942) — the adjudicated
 * interior absence that pins `eodInteriorAbsentOk` false, recorded as an
 * IDENTITY rather than as a date list.
 *
 * ── Why an identity and not the ten dates on the wire ────────────────────────
 *
 * The published route names ten dates (2026-07-13..07-24). Those ten are a CLAMP
 * ARTIFACT, not the incident: `spanStart = max(firstRow, baselineDate)` and
 * `baselineDate` comes from `resolvePnlBaselineDate(process.env)`, which is
 * env-pinned at 2026-07-12 and does not roll. Move that env and the list changes
 * without a single ledger row changing. A dates-list record therefore DECAYS; an
 * identity does not. The incident is thirty absent sessions, and the ten on the
 * wire under-size it by 64%.
 *
 * ── Why this record is not an exclusion ──────────────────────────────────────
 *
 * Nothing here is subtracted from any verdict. `enock` stays inside
 * `eodInteriorAbsentBooks` with its dates, `interiorAbsentNet` keeps them, and
 * `eodInteriorAbsentOk` stays `false`. That is the whole difference between this
 * and the rejected option A: misuse of an annotation stays visible in the raw
 * array, misuse of an exclusion does not. If a future change makes a mistake
 * here invisible in `eodInteriorAbsentBooks`, that change has drifted into A.
 */
export interface EodInteriorAdjudicatedAbsence {
  /** The ruling that adjudicated it. */
  ticket: string;
  /** The incident ticket that carries the finding. */
  incidentTicket: string;
  book: string;
  mode: string;
  /** THE RECORD. Scope-stable across any `baselineDate` move. */
  identity: string;
  /** Thirty: 28 contiguous NYSE sessions plus two isolated legacy absences. */
  sessionCount: number;
  contiguousSpan: string;
  contiguousSessionCount: number;
  isolatedLegacySessions: readonly string[];
  legacyIncidentTicket: string;
  /** Why the wire shows ten and the incident is thirty. */
  publishedDatesAreClamped: string;
  /** Were these rows written and then lost, or never written at all? */
  capture: string;
  /** Ratified NOT MEASURED — no durable artifact survives to decide it. */
  cause: string;
  /** Is this book excluded from the verdict? Permanently no. */
  excludedFromVerdict: false;
  /** Is reconstructing these rows authorised? Permanently no. */
  backfillAuthorised: false;
  /** Live capital exposed by this absence. */
  exposure: string;
}

export const EOD_INTERIOR_ADJUDICATED_ABSENCE: EodInteriorAdjudicatedAbsence = Object.freeze({
  ticket: 'TRA-2943',
  incidentTicket: 'TRA-2903',
  book: 'enock',
  mode: 'demo',
  identity:
    'enock has no EOD ledger row for any NYSE session in 2026-06-15..2026-07-24; the rows were never written. Plus two isolated legacy absences, 2026-05-08 and 2026-05-15 (the TRA-388 blank-calendar incident). Thirty absent sessions in total.',
  sessionCount: 30,
  contiguousSpan: '2026-06-15..2026-07-24',
  contiguousSessionCount: 28,
  isolatedLegacySessions: Object.freeze(['2026-05-08', '2026-05-15']),
  legacyIncidentTicket: 'TRA-388',
  publishedDatesAreClamped:
    'The ten dates on the wire (2026-07-13..07-24) are the post-baseline REMAINDER of this absence, not its size. spanStart = max(firstRow, baselineDate) and baselineDate is env-pinned at 2026-07-12 via resolvePnlBaselineDate(process.env) -- it does not roll, so this red does not self-heal, and moving that env would change the published list without changing one ledger row. Record and grade the identity above, never the ten dates.',
  capture:
    'NEVER CAPTURED. No row was written for these sessions on any night; nothing was written-then-lost and no upstream store holds them. catchUpMissedEodReports cannot recover them either -- it fills the dated report FILE and is gated `if (!backfill)` out of saveSnapshot, so it never creates the ledger row (and it caps at maxLookbackDays 14 regardless).',
  cause:
    'NOT MEASURED, and ratified as such by the TRA-2943 ruling. The two candidates -- (a) the book had no UserContext in getAllUserContexts() those nights, (b) generateAndSaveReport threw inside runDailyCloseForAllUsers -- are both swallowed to a single log.warn, neither leaves a durable artifact, and Render log retention does not reach 2026-06-15. The 2026-07-27 resumption is suggestive and is explicitly NOT evidence. Making the swallowed warn durable so the NEXT occurrence is measurable is separate work (TRA-2930 is its front edge), not a re-forensics of this one.',
  excludedFromVerdict: false,
  backfillAuthorised: false,
  exposure:
    'ZERO LIVE CAPITAL. enock is mode `demo`. The live cohort is clean and separately published: liveEodInteriorAbsentOk true, liveEodInteriorAbsentBooks empty across both live books, liveEodBackfillArmed false (re-read off bqb1 2026-08-05T15:58Z).',
});

/**
 * TRA-2943 — the IN-BAND retirement of `eodInteriorAbsentOk`, published beside
 * the field it retires.
 *
 * ── Why this ships as data next to the field ─────────────────────────────────
 *
 * `eodInteriorAbsentOk` is now permanently `false` for an adjudicated reason. A
 * boolean pinned false discriminates exactly as little as one pinned true: if a
 * SECOND book went interior-absent tomorrow it would not move. Without this
 * record a reader six weeks from now sees a red field and reads it as a live
 * signal — which is the failure TRA-2886 left behind and the ruling explicitly
 * refuses to repeat.
 *
 * A count is NOT the escape hatch. `eodInteriorAbsentBooks.length` and every
 * gradeable-book count are exactly as dead as the boolean the moment `enock`
 * permanently occupies slot one. The discriminator of record is the SET OF
 * USERNAMES in `eodInteriorAbsentBooks`: a new offender changes the set even
 * though it changes neither the boolean nor (usefully) the count.
 *
 * Scope: the FLEET fold only. `liveEodInteriorAbsentOk` is unaffected and stays
 * gradeable — `enock` is demo, so it is not in that cohort, and the live axis has
 * a reachable green state today (it is green).
 */
export interface EodInteriorAbsentOkRetirement {
  ticket: string;
  field: string;
  state: string;
  since: string;
  /** What to grade instead. A SET, not a boolean and not a count. */
  discriminatorOfRecord: string;
  why: string;
  /** Explicitly still gradeable, so the retirement is not over-read. */
  stillGradeable: readonly string[];
  /** Does the red clear on its own? No — the clamp is env-pinned. */
  selfHeals: false;
  /** Remedies the ruling closed, so a future reader does not re-propose them. */
  forbiddenRemedies: readonly string[];
  adjudicated: EodInteriorAdjudicatedAbsence;
}

export const EOD_INTERIOR_ABSENT_OK_RETIREMENT: EodInteriorAbsentOkRetirement = Object.freeze({
  ticket: 'TRA-2943',
  field: 'eodInteriorAbsentOk',
  state: 'RETIRED -- PINNED FALSE. Not a live signal.',
  since: '2026-08-05',
  discriminatorOfRecord:
    'eodInteriorAbsentBooks -- the SET OF USERNAMES. Not this boolean, and not a count: a count is as dead as the boolean once one book permanently occupies slot one. A new offender is a new username in that set.',
  why:
    'TRA-2943 (CFO, adjudicating TRA-2942) adopted disposition C: accept the standing red rather than suppress it. The fleet fold is false for as long as the adjudicated absence below stands, which is for as long as baselineDate stays 2026-07-12 -- i.e. indefinitely. A second book going interior-absent would not move this field, because it is already false.',
  stillGradeable: Object.freeze([
    'liveEodInteriorAbsentOk -- the live cohort is a different cohort; enock is demo and not in it, and it is green today with a reachable red.',
    'eodInteriorAbsentBooks -- the set of usernames, the discriminator of record.',
    'engines[].eodInterior.interiorAbsentNet -- per book, still exact.',
    'eodInteriorAbsentRawBookCount -- the pre-exclusion acceptance arm; a drop to 0 while the fleet still steps 2026-07-29 -> 2026-08-04 is a REGRESSION, not a repair.',
  ]),
  selfHeals: false,
  forbiddenRemedies: Object.freeze([
    'Adding enock\'s dates to EOD_DOCUMENTED_GAP_DATES in any form. That constant is fleet-wide and cannot scope per book: 28 sessions across 61 books that have nothing wrong with them would be suppressed to green one demo book. REJECTED by TRA-2943.',
    'Building a per-book exclusion or allow-list primitive. The cost is not one keyed entry -- it is a permanent blinding primitive plus the raw audit arm needed to keep it honest, bought to green a demo book while the live axis is already green. REJECTED by TRA-2943.',
    'Arming ENABLE_EOD_ROW_BACKFILL. These rows were NEVER CAPTURED; a writer that manufactures them fabricates a ledger, and saveSnapshot rebases openingEquity to the row it closes, so a back-filled row would rewrite the telescoped opening chain that is currently the evidence the hole is clean. TRA-2888 stands verbatim and is NOT reopened.',
    'Advancing the baselineDate env past 2026-07-24 to clamp the absence out of the span. That greens the field by moving a data-integrity cutoff and changes what every other post-baseline verdict is measuring. Worse than either rejected option.',
  ]),
  adjudicated: EOD_INTERIOR_ADJUDICATED_ABSENCE,
});

/** Prose form of the retirement, spread into the endpoint's top-level `caveats`. */
export const PNL_EOD_INTERIOR_RETIREMENT_NOTE =
  'TRA-2943: `eodInteriorAbsentOk` is RETIRED -- PINNED FALSE, and is NOT a live signal. It is false because the `enock` book carries an adjudicated interior absence, and it will stay false for as long as `baselineDate` is env-pinned at 2026-07-12; it does not self-heal and a SECOND book going interior-absent would not move it. GRADE `eodInteriorAbsentBooks` -- the SET OF USERNAMES -- instead. Do not grade this boolean and do not substitute a COUNT: a count is exactly as dead as the boolean once one book permanently occupies slot one. `liveEodInteriorAbsentOk` is a different cohort and stays gradeable (enock is demo; the live axis is green today with a reachable red). THE RECORD IS AN IDENTITY, NOT A DATE LIST: enock has no EOD ledger row for any NYSE session in 2026-06-15..2026-07-24 -- the rows were NEVER WRITTEN -- plus two isolated legacy absences 2026-05-08 and 2026-05-15 (TRA-388). Thirty absent sessions. The ten dates published under `eodInteriorAbsentBooks` for enock are the post-baseline remainder only, a clamp artifact of `spanStart = max(firstRow, baselineDate)`, and they under-size the incident by 64%. CAUSE: NOT MEASURED -- the two candidates (contextless book / generateAndSaveReport threw) are both swallowed to one log.warn and Render retention does not reach 2026-06-15. NOTHING IS EXCLUDED BY THIS RECORD: enock stays in `eodInteriorAbsentBooks` with its dates and the verdict stays red. Adding enock to `EOD_DOCUMENTED_GAP_DATES`, building a per-book exclusion, arming `ENABLE_EOD_ROW_BACKFILL`, and advancing the baseline env are all REFUSED by this ruling -- see `eodInteriorAbsentOkRetirement.forbiddenRemedies`. Zero live capital: enock is `mode: demo`.';

/**
 * Every NYSE session in `[start, end]` inclusive, per the supplied calendar.
 *
 * The whole detector turns on this function existing SEPARATELY from `days[]`.
 * Enumerating the expected set from the calendar is what gives absence a
 * failing state: you cannot discover a missing session by iterating the
 * sessions you have.
 *
 * Bounded so a malformed pair cannot spin, the same discipline
 * `staleTailSessions` follows.
 */
export function sessionsInRange(
  start: string,
  end: string,
  isMarketDay: (dateIso: string) => boolean,
  maxDays = 4000,
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  if (start > end) return [];
  let t = Date.parse(`${start}T00:00:00Z`);
  const stop = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(stop)) return [];
  const out: string[] = [];
  for (let i = 0; i < maxDays && t <= stop; i++) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDay(iso)) out.push(iso);
    t += 86_400_000;
  }
  return out;
}

export interface EodInteriorAbsence {
  /** Lower bound of the graded span: `max(firstRowDate, baselineDate)`. */
  spanStart: string | null;
  /** Upper bound: the calendar's `lastSettledSession`. */
  spanEnd: string | null;
  /** Sessions the calendar says exist in `[spanStart, spanEnd]`. */
  spanSessions: number;
  /**
   * THE DENOMINATOR. Expected sessions strictly before this book's newest row —
   * i.e. the ones the INTERIOR axis actually examined. `0` means nothing was
   * looked at and the verdict below is `null`.
   *
   * Published for the reason `stockLegMeasuredCount` and `eodRowGradeableCount`
   * are: without it, a `null` from an empty cohort is indistinguishable from a
   * graded pass. The parent ticket names this trap explicitly —
   * `absentSessionsCovered` / `absentSessionsUncovered` both score 0 on an empty
   * `absentSessions`, and 0 there means "nothing was examined", not "nothing was
   * wrong". This field is what keeps that reading available.
   */
  interiorGradeableCount: number;
  /**
   * Every expected session in the span with no ledger row — interior AND tail,
   * BEFORE any exclusion. The rawest form of the measurement.
   */
  absentSessions: string[];
  /**
   * Interior absence BEFORE the documented-gap exclusion. This is the arm that
   * must go RED on the known 07-30/07-31/08-03 hole: a detector that cannot go
   * red on a hole we know is there has not been tested. Live 2026-08-05: red on
   * 47 of 47 participating books.
   */
  interiorAbsentRaw: string[];
  /** The subset of `interiorAbsentRaw` that IS the documented AC1 gap. */
  interiorAbsentDocumented: string[];
  /**
   * Interior absence AFTER excluding the documented gap — the graded set. A
   * non-empty value here is a NEW hole and is never the TRA-2888 incident.
   */
  interiorAbsentNet: string[];
  /**
   * TRI-STATE. `false` = a new interior hole. `true` = the interior is complete
   * apart from the documented gap, over a span that was genuinely examined.
   * `null` = NOT MEASURED (no rows, no calendar, or an empty interior span) —
   * never read as a pass.
   */
  interiorAbsentOk: boolean | null;
}

/**
 * The interior-absence detector: enumerate expected sessions from the exchange
 * calendar, diff against the rows actually present, and grade what is missing
 * INSIDE the recorded history rather than only off its end.
 *
 * ── Why the span starts at the reconciliation baseline ───────────────────────
 *
 * `[firstRow, lastSettled]` is the honest raw span, but grading it makes the
 * axis permanently and unreadably red on legacy history: measured live, `enock`
 * alone carries 30 absent sessions once pre-baseline dates are counted, several
 * from a period when the book demonstrably was not being archived at all. An
 * axis that is red forever for reasons nobody will ever act on is one nobody
 * reads on the day it is right — the same argument `EodTailCalendar` makes for
 * grading against the last SETTLED session instead of the last market day.
 *
 * So the verdict is bounded below by the reconciliation baseline (the module's
 * established "rows we hold the writer to" cutoff, TRA-1636), while the
 * pre-baseline absences remain visible in `absentSessions` when the caller asks
 * for the unbounded span. This mirrors `unbookedEquityMoveDates`, which is
 * published as evidence WITHOUT folding into a verdict.
 *
 * Note the baseline is a LOWER bound only, applied via `max`: a book whose
 * history starts after the baseline is graded from its own first row, never from
 * a date before it existed. Grading a book over sessions that predate its first
 * row would manufacture absence out of a book that simply had not started yet.
 *
 * ── Why interior is `absent < newestRow` and not `absent` ────────────────────
 *
 * The tail already has an owner (`eodTailStaleSessions`, TRA-2817) and a
 * different remediation. Splitting on the book's own newest row keeps the two
 * axes disjoint, so a stale tail cannot double-count into this verdict and a
 * resumed writer's green tail cannot mask the hole behind it. Both axes are
 * published; a reader who wants total absence adds them, and `absentSessions`
 * holds the union already.
 */
export function detectEodInteriorAbsence(
  rowDates: readonly string[],
  calendar: EodTailCalendar | null,
  baselineDate: string | null = null,
  documentedGapDates: readonly string[] = EOD_DOCUMENTED_GAP_DATES,
): EodInteriorAbsence {
  const notMeasured: EodInteriorAbsence = {
    spanStart: null,
    spanEnd: null,
    spanSessions: 0,
    interiorGradeableCount: 0,
    absentSessions: [],
    interiorAbsentRaw: [],
    interiorAbsentDocumented: [],
    interiorAbsentNet: [],
    interiorAbsentOk: null,
  };

  const sorted = [...rowDates].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (sorted.length === 0) return notMeasured;
  const spanEnd = calendar?.lastSettledSession ?? null;
  if (!calendar || spanEnd == null) return notMeasured;

  const firstRow = sorted[0]!;
  const newestRow = sorted[sorted.length - 1]!;
  // `max` — never grade a book over sessions that predate its own first row.
  const spanStart = baselineDate != null && baselineDate > firstRow ? baselineDate : firstRow;
  if (spanStart > spanEnd) return notMeasured;

  const expected = sessionsInRange(spanStart, spanEnd, calendar.isMarketDay);
  if (expected.length === 0) return notMeasured;

  const present = new Set(sorted);
  const absentSessions = expected.filter(s => !present.has(s));
  // The interior cohort: expected sessions the book's own history brackets.
  const interiorExpected = expected.filter(s => s < newestRow);
  const interiorAbsentRaw = absentSessions.filter(s => s < newestRow);
  const documented = new Set(documentedGapDates);
  const interiorAbsentDocumented = interiorAbsentRaw.filter(s => documented.has(s));
  const interiorAbsentNet = interiorAbsentRaw.filter(s => !documented.has(s));

  return {
    spanStart,
    spanEnd,
    spanSessions: expected.length,
    interiorGradeableCount: interiorExpected.length,
    absentSessions,
    interiorAbsentRaw,
    interiorAbsentDocumented,
    interiorAbsentNet,
    // Empty interior cohort => NOT MEASURED. `true` here would be `every` on the
    // empty set, which is the exact vacuous pass this ticket was filed over.
    interiorAbsentOk: interiorExpected.length === 0 ? null : interiorAbsentNet.length === 0,
  };
}

export interface EodInteriorAbsenceBook {
  username: string;
  mode: string;
  interior: EodInteriorAbsence;
}

/**
 * Fleet fold, live-scoped and whole-fleet, folded RED > NOT MEASURED > GREEN —
 * the verdict order every tri-state in `pnl-reconciliation.ts` uses.
 *
 * `eodInteriorAbsentRawBookCount` is deliberately published alongside the
 * verdict. It is the acceptance arm: it counts books whose interior is absent
 * BEFORE the documented-gap exclusion, so a reader can confirm the detector
 * still sees the known hole rather than having been quietly blinded by the
 * exclusion list. A build where the raw count drops to 0 while the fleet still
 * steps 07-29 -> 08-04 is a REGRESSION, not a repair.
 */
export function summarizeEodInteriorAbsence(books: ReadonlyArray<EodInteriorAbsenceBook>): {
  eodDocumentedGap: EodDocumentedGap;
  eodInteriorAbsentOkRetirement: EodInteriorAbsentOkRetirement;
  eodInteriorBookCount: number;
  eodInteriorGradeableBookCount: number;
  eodInteriorAbsentOk: boolean | null;
  eodInteriorAbsentBooks: Array<{ username: string; dates: string[]; gradeableCount: number }>;
  eodInteriorDocumentedGapBooks: Array<{ username: string; dates: string[] }>;
  eodInteriorAbsentRawBookCount: number;
  liveEodInteriorAbsentOk: boolean | null;
  liveEodInteriorAbsentBooks: Array<{ username: string; dates: string[]; gradeableCount: number }>;
  liveEodInteriorBookCount: number;
} {
  const fold = (cohort: ReadonlyArray<EodInteriorAbsenceBook>): boolean | null =>
    cohort.some(b => b.interior.interiorAbsentOk === false)
      ? false
      : cohort.some(b => b.interior.interiorAbsentOk === true)
        ? true
        : null;

  const named = (cohort: ReadonlyArray<EodInteriorAbsenceBook>) =>
    cohort
      .filter(b => b.interior.interiorAbsentNet.length > 0)
      .map(b => ({
        username: b.username,
        dates: b.interior.interiorAbsentNet,
        gradeableCount: b.interior.interiorGradeableCount,
      }));

  const live = books.filter(b => b.mode === 'live');

  return {
    eodDocumentedGap: EOD_DOCUMENTED_GAP,
    // TRA-2943 — the retirement travels WITH the field it retires. A reader who
    // pulls this payload and finds `eodInteriorAbsentOk: false` finds the ruling,
    // the identity it is pinned by, and what to grade instead in the same object.
    // It excludes nothing: `enock` is still named below with its dates.
    eodInteriorAbsentOkRetirement: EOD_INTERIOR_ABSENT_OK_RETIREMENT,
    eodInteriorBookCount: books.length,
    eodInteriorGradeableBookCount: books.filter(b => b.interior.interiorAbsentOk != null).length,
    eodInteriorAbsentOk: fold(books),
    eodInteriorAbsentBooks: named(books),
    eodInteriorDocumentedGapBooks: books
      .filter(b => b.interior.interiorAbsentDocumented.length > 0)
      .map(b => ({ username: b.username, dates: b.interior.interiorAbsentDocumented })),
    eodInteriorAbsentRawBookCount: books.filter(b => b.interior.interiorAbsentRaw.length > 0).length,
    liveEodInteriorAbsentOk: fold(live),
    liveEodInteriorAbsentBooks: named(live),
    liveEodInteriorBookCount: live.length,
  };
}
