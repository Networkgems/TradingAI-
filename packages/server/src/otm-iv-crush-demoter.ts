import {
  computeCatalystScore,
  CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS,
  EARNINGS_IV_CRUSH_TAG,
} from '@trading-app/shared';
import type { EarningsCalendarRead } from './earnings-store.js';

/**
 * TRA-4642 (parent TRA-4413, item 1) — ROUTE the OTM nomination through the
 * existing news-catalyst `EARNINGS_IV_CRUSH_RISK` demoter, SHADOW-first.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * The demoter has existed since TRA-1629 (`news-catalyst.ts`: earnings within
 * `CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS` ⇒ `demoted`, tagged
 * `EARNINGS_IV_CRUSH_TAG`) and is consulted nowhere on the OTM path — a cheap
 * contract is cheap and the sleeve never asks whether the cheapness is an
 * earnings print about to crush the IV it is buying. This module CONSULTS the
 * existing demoter on the OTM chain population and records what it would have
 * said. It does not re-implement the rule and does not fork it: the verdict
 * comes out of `computeCatalystScore` itself, so if the demoter's own logic
 * ever moves (the N, the null handling), this consult moves with it.
 *
 * The news legs of the scorer are fed NEUTRAL constants (no headlines, neutral
 * tilt, zero gap/rvol) because the OTM path has no news inputs here and the
 * demote leg of `computeCatalystScore` reads ONLY `earningsInDays`. The
 * composite `score` that comes back is DISCARDED — TRA-4413 do-not-build #1
 * (no composite score, no fixed weights, no ≥75 cut) — only `demoted`/`tags`
 * are read.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *   • NOT a gate. It never refuses anything, in any mode. There is NO enforce
 *     arm in this module at all — an enforce flip is a separate board decision
 *     with its own placement analysis (same posture as TRA-4639).
 *   • NOT a retune of `CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS` (N=1 today).
 *     Explicitly out of scope on TRA-4642: a new N is a threshold choice and
 *     goes through TRA-3392 §6 pre-registration. This consults the demoter AT
 *     its existing N; `demoteWithinSessions` is published on the health block
 *     so a shadow read arguing "N=1 is too tight" can cite the N it measured.
 *
 * ── PLACEMENT (the issue's "BEFORE ranking") ─────────────────────────────────
 * The call site is in the OTM scan loop at CHAIN level — immediately beside
 * `applyOtmContractFloor`, ABOVE the selector (`selectAdmissibleOtmCandidate`)
 * that ranks the nominee. Demotion is a property of the UNDERLYING, not of a
 * strike, so an eventual enforce arm belongs where it removes the name before
 * the ranker spends a nominee on it — refusing after ranking throws away the
 * whole symbol, the TRA-3401 shape. Shadow placement mirrors the enforce
 * placement so the measured population is the population an enforce arm would
 * actually see.
 *
 * ── DENOMINATOR (the issue's "check before minting a second one") ────────────
 * No second population is minted: the call site is adjacent to
 * `applyOtmContractFloor`, so `evaluated` here tracks the contract-floor
 * CHAIN-SURVEY population call-for-call BY CONSTRUCTION — every chain the
 * floor surveys, this consults, including chains the floor then refuses
 * (deliberate: a name can be both un-buyable under the floor and demoted, and
 * an enforce arm at this seam would see the pre-floor chain). The cross-check
 * identity against the scan census: `evaluated` = census symbols entered −
 * `scan:*` rejects − `no_candidates` rejects, over rows one process wrote
 * (these counters are SINCE-BOOT; the census resets per scan pass — compare
 * cumulatively from the same boot only).
 *
 * ── REASON CODES ─────────────────────────────────────────────────────────────
 * Four, low-cardinality, `otm-contract-floor.ts` pattern. ⚠️ TRA-4424 /
 * TRA-4639 precedent: `calendar_unreadable` (the earnings store is dark or
 * never populated — the FEED's defect) is DISTINCT from
 * `no_earnings_scheduled` (store readable, this name has no upcoming event —
 * the SYMBOL's property). Pooling them launders a calendar outage into a
 * clean pass over the whole universe.
 *
 * ── FLAG ─────────────────────────────────────────────────────────────────────
 * `ENABLE_OTM_IV_CRUSH_DEMOTER_SHADOW`, default OFF, STANDALONE (same rule as
 * TRA-4639: arming an observer must not arm anything capital-adjacent).
 */

export const OTM_IV_CRUSH_SHADOW_FLAG = 'ENABLE_OTM_IV_CRUSH_DEMOTER_SHADOW';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the shadow consult records. Standalone — see the module block. */
export function isOtmIvCrushDemoterShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_IV_CRUSH_SHADOW_FLAG]);
}

// ─── Reason codes ────────────────────────────────────────────────────────────

export const OTM_IV_CRUSH_CODES = [
  'ivcrush_demoted',
  'ivcrush_clear',
  'ivcrush_no_earnings_scheduled',
  'ivcrush_calendar_unreadable',
] as const;
export type OtmIvCrushCode = (typeof OTM_IV_CRUSH_CODES)[number];

export interface OtmIvCrushVerdict {
  readonly symbol: string;
  readonly code: OtmIvCrushCode;
  /** The demoter's OWN verdict (`computeCatalystScore(...).demoted`). */
  readonly demoted: boolean;
  /** The input the demoter saw — `earningsInDaysSync` semantics, null when uncovered/unreadable. */
  readonly earningsInDays: number | null;
  /** The tags the demoter stamped (contains `EARNINGS_IV_CRUSH_TAG` iff demoted). */
  readonly tags: readonly string[];
  /** The store read state behind the code, for the log line. */
  readonly calendarState: EarningsCalendarRead['state'];
}

/**
 * Consult the demoter on one underlying. PURE given the calendar read. The
 * demote decision is `computeCatalystScore`'s own — this function only
 * classifies WHICH world produced it (the code) and never overrides it.
 */
export function evaluateOtmIvCrushDemoter(
  symbol: string,
  calendar: EarningsCalendarRead,
): OtmIvCrushVerdict {
  // The demoter, consulted on exactly the input the news-catalyst path feeds
  // it (`earningsInDaysSync` → `earningsInDays`); news legs neutral, score
  // discarded (module block: do-not-build #1).
  const score = computeCatalystScore({
    netScore: 0,
    tilt: 'neutral',
    rvolZ: 0,
    gapPct: 0,
    freshHeadlineCount: 0,
    freshnessMinutes: Number.POSITIVE_INFINITY,
    earningsInDays: calendar.days,
  });
  let code: OtmIvCrushCode;
  if (score.demoted) {
    code = 'ivcrush_demoted';
  } else if (calendar.state === 'covered') {
    code = 'ivcrush_clear';
  } else if (calendar.state === 'uncovered') {
    code = 'ivcrush_no_earnings_scheduled';
  } else {
    // unloaded | unpopulated — the feed's defect, never the symbol's property.
    code = 'ivcrush_calendar_unreadable';
  }
  return {
    symbol,
    code,
    demoted: score.demoted,
    earningsInDays: calendar.days,
    tags: score.tags,
    calendarState: calendar.state,
  };
}

// ─── Counters ────────────────────────────────────────────────────────────────
// SINCE-BOOT, in-memory, keyed by book class — same shape and same rationale
// as `otm-underlying-confirm.ts` (TRA-4422 Finding 2: a shadow instrument's
// job is to be trivially attributable to the build that wrote it).

export type OtmIvCrushBook = 'live' | 'demo';

interface BookCounters {
  evaluated: number;
  byCode: Record<OtmIvCrushCode, number>;
  lastEvaluatedAt: number | null;
  lastSymbol: string | null;
  lastDemotedSymbol: string | null;
  lastDemotedAt: number | null;
}

function emptyBook(): BookCounters {
  const byCode = Object.fromEntries(OTM_IV_CRUSH_CODES.map((c) => [c, 0])) as Record<
    OtmIvCrushCode,
    number
  >;
  return {
    evaluated: 0,
    byCode,
    lastEvaluatedAt: null,
    lastSymbol: null,
    lastDemotedSymbol: null,
    lastDemotedAt: null,
  };
}

let counters: Record<OtmIvCrushBook, BookCounters> = {
  live: emptyBook(),
  demo: emptyBook(),
};
let sinceMs = Date.now();
/** Hourly per-(book,symbol,code) log brake — chain-level volume is ~79 sweeps/session/symbol. */
let logStamp = new Map<string, number>();
const LOG_BRAKE_MS = 60 * 60_000;

/** Test seam. */
export function resetOtmIvCrushDemoterCountersForTest(): void {
  counters = { live: emptyBook(), demo: emptyBook() };
  sinceMs = Date.now();
  logStamp = new Map();
}

/**
 * Fold one verdict into the counters. Returns TRUE when the caller should
 * emit the structured log line: only `ivcrush_demoted` and
 * `ivcrush_calendar_unreadable` are log-worthy (the two states someone acts
 * on), braked to one line per (book, symbol, code) per hour — the counters
 * carry every verdict regardless.
 */
export function recordOtmIvCrushDemoter(
  book: OtmIvCrushBook,
  verdict: OtmIvCrushVerdict,
  nowMs: number = Date.now(),
): boolean {
  const c = counters[book];
  c.evaluated += 1;
  c.byCode[verdict.code] += 1;
  c.lastEvaluatedAt = nowMs;
  c.lastSymbol = verdict.symbol;
  if (verdict.demoted) {
    c.lastDemotedSymbol = verdict.symbol;
    c.lastDemotedAt = nowMs;
  }
  if (verdict.code !== 'ivcrush_demoted' && verdict.code !== 'ivcrush_calendar_unreadable') {
    return false;
  }
  const key = `${book}:${verdict.symbol}:${verdict.code}`;
  const last = logStamp.get(key);
  if (last !== undefined && nowMs - last < LOG_BRAKE_MS) return false;
  logStamp.set(key, nowMs);
  return true;
}

/** Dense rows over the code vocabulary — absent is not zero (TRA-4154 trap). */
function denseRows(
  by: Record<OtmIvCrushCode, number>,
  evaluated: number,
): { code: OtmIvCrushCode; count: number; share: number | null }[] {
  return OTM_IV_CRUSH_CODES.map((code) => ({
    code,
    count: by[code],
    share: evaluated > 0 ? by[code] / evaluated : null,
  }));
}

export interface OtmIvCrushDemoterHealth {
  readonly issue: 'TRA-4642';
  readonly flag: string;
  readonly enabled: boolean;
  /** The raw env string, so a typo'd arm attempt is visible (UNKNOWN IS NOT OFF). */
  readonly raw: string | null;
  /** The demoter's N — published so a "N=1 too tight" read cites what it measured. */
  readonly demoteWithinSessions: number;
  readonly demoteTag: string;
  /** ⚠️ SINCE-BOOT. A restart zeroes every count below. */
  readonly sinceMs: number;
  readonly books: Record<
    OtmIvCrushBook,
    {
      evaluated: number;
      byCode: { code: OtmIvCrushCode; count: number; share: number | null }[];
      lastEvaluatedAt: string | null;
      lastSymbol: string | null;
      lastDemotedSymbol: string | null;
      lastDemotedAt: string | null;
    }
  >;
  /** The earnings store behind the codes, so an unreadable spike is diagnosable here. */
  readonly calendar: { loaded: boolean; coveredSymbols: number };
  readonly note: string;
}

export function otmIvCrushDemoterHealth(
  calendarStatus: { loaded: boolean; coveredSymbols: number },
  env: NodeJS.ProcessEnv = process.env,
): OtmIvCrushDemoterHealth {
  const raw = env[OTM_IV_CRUSH_SHADOW_FLAG];
  const enabled = isOtmIvCrushDemoterShadowEnabled(env);
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const book = (b: OtmIvCrushBook) => {
    const c = counters[b];
    return {
      evaluated: c.evaluated,
      byCode: denseRows(c.byCode, c.evaluated),
      lastEvaluatedAt: iso(c.lastEvaluatedAt),
      lastSymbol: c.lastSymbol,
      lastDemotedSymbol: c.lastDemotedSymbol,
      lastDemotedAt: iso(c.lastDemotedAt),
    };
  };
  return {
    issue: 'TRA-4642',
    flag: OTM_IV_CRUSH_SHADOW_FLAG,
    enabled,
    raw: raw ?? null,
    demoteWithinSessions: CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS,
    demoteTag: EARNINGS_IV_CRUSH_TAG,
    sinceMs,
    books: { live: book('live'), demo: book('demo') },
    calendar: calendarStatus,
    note: enabled
      ? 'SHADOW ONLY: the news-catalyst EARNINGS_IV_CRUSH_RISK demoter is CONSULTED on the OTM '
        + 'chain population (beside the contract floor, BEFORE the selector ranks) and NOTHING is '
        + 'refused. `evaluated` tracks the contract-floor chain-survey population call-for-call by '
        + 'construction; counters are SINCE-BOOT. `ivcrush_calendar_unreadable` is the FEED\'s '
        + 'defect and must never be pooled with `ivcrush_no_earnings_scheduled` — a demoted share '
        + 'is a real measurement only when evaluated > 0 AND the unreadable share is small.'
      : `DARK: set ${OTM_IV_CRUSH_SHADOW_FLAG}=1 to record. Counters below are structurally zero — `
        + 'this is the shipped-but-unarmed default (TRA-4642 deliverable 4), not a clean bill.',
  };
}
