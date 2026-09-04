// TRA-4343 — the DURABLE twin of the entry-site asset-class census.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `underlying-asset-class.ts` keeps the entry-site census in module memory and
// discloses it as `durability: 'ephemeral_since_boot'`. Its stated durable twin
// is the `underlying_asset_class` gate in the live-enforce ledger — but that
// ledger stamps `reasonCode` (which carries the CLASS) only on BLOCKS. While
// the refusal ships disarmed nothing blocks, so every admitted evaluation lands
// there class-less, and the class census has no durable form at all.
//
// On 2026-09-03 that cost us a session. Close 16:00 ET; the 18:40 ET postmarket
// slot did not fire; bqb1 restarted 21:11 ET onto `a22668a3`; the retry read at
// 21:59 ET saw `evaluated: 0, refused: 0, byClass: []` and the record was
// unrecoverable. `scripts/render-redeploy.mjs` REFUSES 13:25–20:00Z on
// weekdays, so the safest time to deploy is the only time these counters exist:
// this recurs on every post-close deploy until the counters outlive the process.
//
// ── DURABILITY ───────────────────────────────────────────────────────────────
// JSONL under DATA_DIR, ET-day-keyed, rebuilt on boot, compacted to
// {@link RETAIN_MS} — the same shape `entry-greeks-ledger.ts` (TRA-1682) and
// `directional-open-ledger.ts` (TRA-1486) already use for exactly this failure.
//
// ⛔ `wired: false` is NOT an empty measurement. With no DATA_DIR configured
// nothing is persisted, so an absent day means "never stored", not "never
// evaluated" — the same conflation this ledger exists to end, one layer up.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. Never places an order, never influences the entry
// verdict — {@link recordEntrySiteCensus} is called from the census recorder
// AFTER the classifier has ruled. No balances or PII: an ET day, an asset
// class, the classifier's source, the refusal bit, and the book label.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'entry-site-census-ledger' });

export const ENTRY_SITE_CENSUS_LOG_FILENAME = 'entry-site-asset-class.jsonl';

/**
 * Retain this many ms on disk (compacted on boot). The consumer is a postmarket
 * read of the session that just closed, and the worst realistic gap is a Monday
 * morning read of the previous Tuesday over a long weekend, so 14 days is
 * generous while keeping the file small.
 */
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;

/** How many ET days {@link summarizeEntrySiteCensus} renders, newest last. */
const MAX_DAYS_PUBLISHED = 14;

/** One durable entry-site evaluation. */
interface EntrySiteCensusRecord {
  /** Evaluation time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** The classifier's verdict for the underlying. */
  assetClass: string;
  /** How the classifier reached it (`static_list`, …). */
  source: string;
  /** TRUE ⇒ the entry site REFUSED this candidate on asset class. */
  refused: boolean;
  /** The live book the evaluation governed; absent ⇒ unattributable, folded as `unattributed`. */
  book?: string;
}

/**
 * ⭐ THE LEDGER'S OWN BIRTH STAMP, and it is not bookkeeping.
 *
 * Caught on this instrument's FIRST live read (bqb1 pid 76, 2026-09-04T02:36Z):
 * with the file freshly created, `wired: true` + no record for 2026-09-03 was
 * rendered as "the entry site evaluated nothing that session" — a durable ZERO
 * for a session that ended before this code existed. That is the ticket's own
 * defect, one layer down: A LEDGER CANNOT DISTINGUISH AN EMPTY DAY FROM A DAY
 * IT WAS NOT ALIVE FOR UNLESS IT RECORDS WHEN IT OPENED.
 *
 * So the first line of the file is a marker, and every fold publishes
 * `observingSince`. On compaction the marker is CLAMPED FORWARD to the
 * retention cutoff rather than aged out — "I have been observing since at
 * least the retention edge" stays true, and anything older is unanswerable
 * anyway.
 */
interface EntrySiteCensusMarker {
  ts: number;
  kind: 'ledger_opened';
}

function isMarker(v: unknown): v is EntrySiteCensusMarker {
  return typeof v === 'object' && v !== null
    && (v as { kind?: unknown }).kind === 'ledger_opened'
    && typeof (v as { ts?: unknown }).ts === 'number'
    && Number.isFinite((v as { ts: number }).ts);
}

interface DayAccum {
  evaluated: number;
  refused: number;
  byClass: Map<string, { evaluated: number; refused: number }>;
  bySource: Map<string, number>;
  books: Set<string>;
  firstAt: number;
  lastAt: number;
}

// ── In-memory store (backs the durable counts + the health surface) ──────────
//
// Module-global + observe-only, mirroring `entry-greeks-ledger`. `dataDir` is set
// once at boot by {@link hydrateEntrySiteCensusFromDisk} so the deep entry-site
// recorder can append without threading a path through the SignalEngine.

let dataDir: string | null = null;
const byDay = new Map<string, DayAccum>();
/** ms epoch this ledger has been observing from. `null` ⇒ not wired. */
let observingSince: number | null = null;

export function entrySiteCensusLogPath(dir: string): string {
  return join(dir, ENTRY_SITE_CENSUS_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearEntrySiteCensusLedger(): void {
  dataDir = null;
  byDay.clear();
  observingSince = null;
}

/** Apply one evaluation to the in-memory counts (shared by record + hydrate). */
function apply(rec: EntrySiteCensusRecord): void {
  let day = byDay.get(rec.etDay);
  if (day === undefined) {
    day = {
      evaluated: 0,
      refused: 0,
      byClass: new Map(),
      bySource: new Map(),
      books: new Set(),
      firstAt: rec.ts,
      lastAt: rec.ts,
    };
    byDay.set(rec.etDay, day);
  }
  day.evaluated += 1;
  if (rec.refused) day.refused += 1;
  let cls = day.byClass.get(rec.assetClass);
  if (cls === undefined) {
    cls = { evaluated: 0, refused: 0 };
    day.byClass.set(rec.assetClass, cls);
  }
  cls.evaluated += 1;
  if (rec.refused) cls.refused += 1;
  day.bySource.set(rec.source, (day.bySource.get(rec.source) ?? 0) + 1);
  day.books.add(rec.book !== undefined && rec.book !== '' ? rec.book : 'unattributed');
  if (rec.ts < day.firstAt) day.firstAt = rec.ts;
  if (rec.ts > day.lastAt) day.lastAt = rec.ts;
}

/**
 * Record one entry-site asset-class evaluation against the durable per-ET-day
 * tally AND append one JSONL line under the configured DATA_DIR.
 *
 * Best-effort on IO: a write failure logs and is swallowed so this accounting
 * can never break the trade pass. With no dataDir configured (unit tests, CLI
 * without boot) the in-memory counts still update; only the file write is
 * skipped — and {@link summarizeEntrySiteCensus} publishes `wired: false` so
 * that state is never mistaken for a durable zero.
 */
export function recordEntrySiteCensus(
  assetClass: string,
  source: string,
  refused: boolean,
  book: string | null,
  etDay: string,
  now: number = Date.now(),
): void {
  const rec: EntrySiteCensusRecord = {
    ts: now,
    etDay,
    assetClass,
    source,
    refused,
    ...(book !== null && book !== '' ? { book } : {}),
  };
  apply(rec);
  if (dataDir === null) return;
  const path = entrySiteCensusLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('entry-site census append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateEntrySiteCensusFromDisk} recovered (for the boot log line). */
export interface EntrySiteCensusHydration {
  /** Distinct ET days retained. */
  days: number;
  /** Total evaluations retained. */
  evaluated: number;
  /** Of those, refusals. */
  refused: number;
}

/**
 * Rebuild the in-memory per-day tally from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call exactly
 * once at startup before any trade pass. Only records within {@link RETAIN_MS}
 * of `now` are kept, and the file is COMPACTED to exactly those lines.
 * Best-effort: a missing or corrupt file yields an empty hydration; a torn
 * trailing line is skipped rather than throwing.
 */
export function hydrateEntrySiteCensusFromDisk(
  dir: string,
  now: number = Date.now(),
): EntrySiteCensusHydration {
  clearEntrySiteCensusLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(entrySiteCensusLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  let evaluated = 0;
  let refused = 0;
  // The earliest instant the file can speak for. A marker older than the
  // retention cutoff is CLAMPED FORWARD rather than dropped — see
  // {@link EntrySiteCensusMarker}. Absent entirely ⇒ this boot opened it.
  let openedAt: number | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: EntrySiteCensusRecord;
    try {
      rec = JSON.parse(trimmed) as EntrySiteCensusRecord;
    } catch {
      // skip a torn/partial line rather than abort the hydrate
      continue;
    }
    if (isMarker(rec)) {
      const at = Math.max(rec.ts, cutoff);
      openedAt = openedAt === null ? at : Math.min(openedAt, at);
      continue;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (typeof rec.assetClass !== 'string' || rec.assetClass === '') continue;
    if (typeof rec.refused !== 'boolean') continue;
    const normalized: EntrySiteCensusRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      assetClass: rec.assetClass,
      source: typeof rec.source === 'string' && rec.source !== '' ? rec.source : 'unknown',
      refused: rec.refused,
      ...(typeof rec.book === 'string' && rec.book !== '' ? { book: rec.book } : {}),
    };
    apply(normalized);
    kept.push(JSON.stringify(normalized));
    evaluated += 1;
    if (normalized.refused) refused += 1;
  }

  // No marker in the file ⇒ either it did not exist, or it predates this field.
  // Either way THIS boot is the earliest instant we can honestly claim, and a
  // day before it must never read as a durable zero.
  const markerWasPresent = openedAt !== null;
  observingSince = openedAt ?? now;

  // Compact: rewrite the file to the marker plus the retained lines
  // (best-effort). Skipped when nothing was dropped AND the marker is already
  // on disk, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  const markerLine = JSON.stringify({ ts: observingSince, kind: 'ledger_opened' });
  if (!markerWasPresent || kept.length + 1 < nonEmptyLines) {
    const path = entrySiteCensusLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, [markerLine, ...kept].join('\n') + '\n', 'utf8');
    } catch (err) {
      log.warn('entry-site census compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { days: byDay.size, evaluated, refused };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface EntrySiteCensusDay {
  etDay: string;
  evaluated: number;
  refused: number;
  byClass: Array<{ assetClass: string; evaluated: number; refused: number }>;
  bySource: Array<{ source: string; evaluated: number }>;
  /** Books the day's evaluations governed; `unattributed` when the call site could not say. */
  books: string[];
  firstAt: number;
  lastAt: number;
}

export interface EntrySiteCensusDurable {
  issue: 'TRA-4343';
  /**
   * ⛔ FALSE ⇒ no DATA_DIR was configured, nothing was persisted, and the
   * absence of a day means "never stored", NOT "never evaluated". Read this
   * before reading `days`.
   */
  wired: boolean;
  retentionDays: number;
  /** Retained ET days, ascending, newest last. */
  days: EntrySiteCensusDay[];
  /**
   * The day the caller asked about — normally the most recently closed ET
   * session. `null` ⇒ no record retained for it. ⛔ That is only a ZERO when
   * `sessionObservation === 'observed'`; read that field first.
   */
  session: EntrySiteCensusDay | null;
  /** The ET day `session` was selected by; `null` when the caller named none. */
  sessionDate: string | null;
  /** ISO of the earliest instant this ledger can speak for. `null` ⇒ not wired. */
  observingSince: string | null;
  /**
   * Whether this ledger was alive for the session it is being asked about.
   * ⛔ `not_observed` ⇒ `session: null` is NOT a zero — the ledger did not
   * exist yet (a deploy, a wiped DATA_DIR, a day past retention).
   */
  sessionObservation: 'observed' | 'partial' | 'not_observed' | 'unknown';
  statement: string;
}

/** The ET session window `summarizeEntrySiteCensus` grades `observingSince` against. */
export interface EntrySiteCensusSessionWindow {
  openMs: number;
  closeMs: number;
}

function renderDay(etDay: string, d: DayAccum): EntrySiteCensusDay {
  const byClass = [...d.byClass.entries()]
    .map(([assetClass, c]) => ({ assetClass, evaluated: c.evaluated, refused: c.refused }))
    .sort((x, y) => (y.evaluated - x.evaluated)
      || (x.assetClass < y.assetClass ? -1 : x.assetClass > y.assetClass ? 1 : 0));
  const bySource = [...d.bySource.entries()]
    .map(([source, evaluated]) => ({ source, evaluated }))
    .sort((x, y) => (y.evaluated - x.evaluated) || (x.source < y.source ? -1 : 1));
  return {
    etDay,
    evaluated: d.evaluated,
    refused: d.refused,
    byClass,
    bySource,
    books: [...d.books].sort(),
    firstAt: d.firstAt,
    lastAt: d.lastAt,
  };
}

/**
 * Fold the store into the read-only durable view. Pure — no IO.
 *
 * `sessionDate` is the ET day the reader is grading (the most recently CLOSED
 * session, per `session-coverage.ts`), NOT necessarily today.
 */
export function summarizeEntrySiteCensus(
  sessionDate: string | null = null,
  sessionWindow: EntrySiteCensusSessionWindow | null = null,
): EntrySiteCensusDurable {
  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(-MAX_DAYS_PUBLISHED)
    .map(([etDay, d]) => renderDay(etDay, d));
  const sessionAccum = sessionDate !== null ? byDay.get(sessionDate) : undefined;
  const session = sessionAccum !== undefined && sessionDate !== null
    ? renderDay(sessionDate, sessionAccum)
    : null;
  const wired = dataDir !== null;

  // ⛔ The half this instrument's own first live read got wrong: an absent day
  // is a ZERO only if the ledger was open across that day. `observingSince`
  // decides it, and a missing window is `unknown` — never `observed`.
  let sessionObservation: EntrySiteCensusDurable['sessionObservation'] = 'unknown';
  if (wired && observingSince !== null && sessionWindow !== null) {
    if (observingSince <= sessionWindow.openMs) sessionObservation = 'observed';
    else if (observingSince <= sessionWindow.closeMs) sessionObservation = 'partial';
    else sessionObservation = 'not_observed';
  }

  const dayLabel = sessionDate ?? '(no session named)';
  const statement = !wired
    ? '⛔ NOT WIRED — no DATA_DIR configured, so nothing is persisted and an absent day means '
      + '"never stored", not "never evaluated" (TRA-4343).'
    : session !== null
      ? `${dayLabel}: ${String(session.evaluated)} evaluated / ${String(session.refused)} refused `
        + `at the entry site, DURABLE — survives a post-close redeploy (observation: `
        + `${sessionObservation}) (TRA-4343).`
      : sessionDate === null
        ? `${String(days.length)} ET day(s) retained; name a sessionDate to select one (TRA-4343).`
        : sessionObservation === 'observed'
          ? `${dayLabel}: no entry-site evaluation retained, and this ledger was open across the whole `
            + 'session ⇒ this IS a measurement: the entry site evaluated nothing (TRA-4343).'
          : sessionObservation === 'partial'
            ? `⚠ ${dayLabel}: no entry-site evaluation retained, but this ledger only opened MID-session `
              + `(${new Date(observingSince ?? 0).toISOString()}) ⇒ a LOWER BOUND, not a zero (TRA-4343).`
            : sessionObservation === 'not_observed'
              ? `⛔ ${dayLabel}: NOT OBSERVED — this ledger has only been recording since `
                + `${new Date(observingSince ?? 0).toISOString()}, after that session closed. The absence `
                + 'of a record is NOT a zero and NOT a quiet day; the session is UNMEASURED (TRA-4343).'
              : `⛔ ${dayLabel}: observation window UNKNOWN (no session window supplied) ⇒ an absent day `
                + 'cannot be read as a zero (TRA-4343).';
  return {
    issue: 'TRA-4343',
    wired,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    days,
    session,
    sessionDate,
    observingSince: observingSince === null ? null : new Date(observingSince).toISOString(),
    sessionObservation,
    statement,
  };
}
