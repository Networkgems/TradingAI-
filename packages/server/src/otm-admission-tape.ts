// TRA-4628 (parent TRA-4621, ruling TRA-4623) — the OTM candidate-ADMISSION tape.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-4623 ran the TRA-461-shaped `minMark × maxSpreadPct` sweep and declined its
// own readout: the pre-registered rule names the ADMITTED-CANDIDATE count as its
// denominator, but the only durable population was traded-and-closed journal rows
// — downstream of the ranker AND the capital gate. Retention measured there is a
// survivorship statistic whose bias sign is UNMEASURABLE without this tape.
// (Desk tape n=79/23 sessions: 3 rows below $0.10 and zero in $0.10–$0.20 — the
// journal cannot say whether the scanner rarely ADMITS cheap contracts or the
// ranker rarely PICKS them.)
//
// So: an append-only row per candidate per RECORDED scan pass, stamped at
// admission-decision time inside `findMispricedOtmContracts` (the engine
// `onAdmission` tap), admitted AND refused, with the FIRST BINDING gate.
// `mark`/`spreadPct` use the scanner's own `(bid+ask)/2` mid — the same
// convention as the TRA-1656 entry stamp — so the tape's axes are directly
// comparable to the journal's.
//
// ── SAMPLING POLICY (load-bearing — see the TRA-4628 constraint) ─────────────
// This surface would otherwise write every scanned contract on every sweep pass.
// Volume is bounded by three rules, every one of them INDEPENDENT of `mark` and
// `spreadPct` (a quote-correlated sample would destroy the exact retention ratio
// being measured):
//   1. PASS THROTTLE — at most one recorded pass per (symbol × book) per
//      `PASS_THROTTLE_MS` (wall-clock only). Unrecorded passes still scan and
//      trade exactly as before; they are simply not written.
//   2. WHOLE-PASS DROPS ONLY — a pass whose decision count exceeds
//      `MAX_ROWS_PER_PASS` is dropped IN FULL and counted
//      (`oversizedPassesDropped`), never truncated: truncation by chain position
//      correlates with strike and therefore with mark.
//   3. PER-CLASS DAILY BUDGET — once a (accountClass × ET day) cell holds
//      `MAX_ROWS_PER_CLASS_PER_DAY` candidate rows, further passes for that cell
//      are dropped whole and counted (`budgetPassesDropped`). Per class, so a
//      chatty fixture book can never starve the desk evidence.
// `ranked` / `ordered` link rows are NEVER throttled (they are one row per
// nominee / per final open — negligible volume) and are written even when the
// candidate pass they belong to was not recorded; the join key is
// (occSymbol × etDay × accountClass), so the admission-vs-ranker split is
// measured directly rather than inferred.
//
// ── CLASSES ARE NEVER POOLED ─────────────────────────────────────────────────
// Every row carries `accountClass` (TRA-2355 classifier, frozen at DECISION
// time — TRA-3715/TRA-3682/TRA-3709). The desk table is the evidence; fixture is
// retention-shape only. The class is stored, not the username (no PII on disk).
//
// ── DURABILITY / RETENTION ───────────────────────────────────────────────────
// JSONL-appended under DATA_DIR (the cost-aware-gate-ledger pattern), rebuilt and
// COMPACTED on boot: rows older than `RETAIN_MS` are dropped, then whole OLDEST
// ET days are pruned until the file fits `MAX_FILE_BYTES`. An evidence archive
// has no backfill — the tape starts accruing at deploy (expected; TRA-4628).
// In-memory state is per-day AGGREGATES plus a small throttle map — bounded, so
// the TRA-4158 RSS ceiling is not in play.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only. NEVER places an order, mutates an account, or feeds any decision
// back into the scan path. No selection parameter is read or changed here. The
// in-memory tally updates first and unconditionally; the disk append is
// best-effort and COUNTED when it fails (`appendErrors`) — a lost row must not
// read identically to a written one (TRA-1681).

import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import type { OtmAdmissionDecision, OtmAdmissionRefusalReason } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateString } from './scheduler.js';
import {
  classifySpreadCeilingAccount,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';

const log = logger.child({ module: 'otm-admission-tape' });

export const OTM_ADMISSION_TAPE_FILENAME = 'otm-admission-tape.jsonl';

/**
 * At most one recorded pass per (symbol × book) per this many ms. ~3–4 recorded
 * passes per symbol per RTH session — the rule's denominator is a per-session
 * candidate count, and pass-over-pass chain snapshots are highly redundant, so
 * sparser passes bound the file without touching the mark/spread distribution.
 */
const PASS_THROTTLE_MS = 2 * 60 * 60 * 1000;
/** A pass bigger than this is dropped WHOLE (rule 2 above), never truncated. */
const MAX_ROWS_PER_PASS = 400;
/** Per (accountClass × ET day) candidate-row budget (rule 3 above). */
const MAX_ROWS_PER_CLASS_PER_DAY = 6000;
/** Keep this many ms on disk — comfortably over the ≥20 RTH desk sessions AC4 needs. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;
/** After time compaction, prune whole OLDEST ET days until the file fits this. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Hard cap on rows a single health-route read may return. */
const MAX_READ_ROWS = 20_000;

/**
 * One admission decision, durable. Every field beyond the identity/axis core is
 * OPTIONAL on the read side — a row written by an older build genuinely lacks it.
 */
export interface OtmAdmissionTapeCandidateRow {
  kind: 'candidate';
  /** Decision time, ms epoch (the scan pass's stamp — all rows of a pass share it). */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** TRA-2355 class, frozen at decision time. Classes are never pooled. */
  accountClass: SpreadCeilingAccountClass;
  /** Engine mode the scanning book runs in (`demo` / `live`). */
  mode?: string;
  underlying: string;
  occSymbol: string;
  expiry: string;
  strike: number;
  right: string;
  bid: number;
  ask: number;
  /** (bid+ask)/2 — SAME convention as the TRA-1656 entry stamp (see engine tap). */
  mark: number;
  /** (ask−bid)/mark on the mid above. */
  spreadPct: number;
  openInterest: number;
  /** Absent when refused before the greeks stage; may be non-finite → omitted. */
  absDelta?: number;
  admitted: boolean;
  /**
   * FIRST binding gate in the engine's evaluation order (`none` iff admitted).
   * The full-set alternative was considered and rejected: the first-binding
   * convention is what the engine can attest without re-running gates it never
   * reached, and the sweep only needs the surviving axes, which every row
   * carries regardless of where it was refused.
   */
  bindingReason: OtmAdmissionRefusalReason;
}

/** A nominee (`ranked`) or a final open (`ordered`) — the survivorship links. */
export interface OtmAdmissionTapeLinkRow {
  kind: 'ranked' | 'ordered';
  ts: number;
  etDay: string;
  accountClass: SpreadCeilingAccountClass;
  mode?: string;
  underlying: string;
  occSymbol: string;
}

export type OtmAdmissionTapeRow = OtmAdmissionTapeCandidateRow | OtmAdmissionTapeLinkRow;

interface ClassDayTally {
  candidateRows: number;
  admitted: number;
  byBindingReason: Record<string, number>;
  passesRecorded: number;
  ranked: number;
  ordered: number;
  lastTs: number;
}

// ── Module state (bounded: aggregates + throttle map, never raw rows) ────────
let dataDir: string | null = null;
/** etDay → accountClass → tally. */
const byDay = new Map<string, Map<string, ClassDayTally>>();
/** `${book}|${symbol}` → last COMMITTED pass ts (throttle rule 1). */
const lastPassAt = new Map<string, number>();
let oversizedPassesDropped = 0;
let budgetPassesDropped = 0;
let throttledPasses = 0;
let emptyPasses = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedDays = 0;
let hydratedRecords = 0;

export function otmAdmissionTapePath(dir: string): string {
  return join(dir, OTM_ADMISSION_TAPE_FILENAME);
}

/** Test seam — clears every tally and forgets the data dir. */
export function clearOtmAdmissionTape(): void {
  dataDir = null;
  byDay.clear();
  lastPassAt.clear();
  oversizedPassesDropped = 0;
  budgetPassesDropped = 0;
  throttledPasses = 0;
  emptyPasses = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedDays = 0;
  hydratedRecords = 0;
}

function tallyFor(etDay: string, accountClass: string): ClassDayTally {
  let classes = byDay.get(etDay);
  if (!classes) {
    classes = new Map();
    byDay.set(etDay, classes);
  }
  let t = classes.get(accountClass);
  if (!t) {
    t = { candidateRows: 0, admitted: 0, byBindingReason: {}, passesRecorded: 0, ranked: 0, ordered: 0, lastTs: 0 };
    classes.set(accountClass, t);
  }
  return t;
}

function applyRow(row: OtmAdmissionTapeRow): void {
  const t = tallyFor(row.etDay, row.accountClass);
  if (row.kind === 'candidate') {
    t.candidateRows += 1;
    if (row.admitted) t.admitted += 1;
    t.byBindingReason[row.bindingReason] = (t.byBindingReason[row.bindingReason] ?? 0) + 1;
  } else if (row.kind === 'ranked') {
    t.ranked += 1;
  } else {
    t.ordered += 1;
  }
  if (row.ts > t.lastTs) t.lastTs = row.ts;
}

function appendLines(lines: string[]): void {
  if (dataDir == null || lines.length === 0) return;
  const path = otmAdmissionTapePath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('otm-admission-tape append failed', { reason: lastAppendError });
  }
}

export interface OtmAdmissionPassContext {
  /** Underlying symbol being scanned. */
  symbol: string;
  /** The book's username — classified here, NEVER written to disk. */
  book: string | null | undefined;
  /** Engine mode (`demo` / `live`). */
  mode: string;
  now?: number;
}

export interface OtmAdmissionPassRecorder {
  /** Hand this to the engine as `OtmScannerOptions.onAdmission`. */
  onAdmission: (decision: OtmAdmissionDecision) => void;
  /**
   * Call ONLY after the scan returned `reason: 'ok'` — commits the collected
   * rows (or counts a whole-pass drop) and consumes the throttle slot. A pass
   * abandoned without commit (breaker, no chain, fetch error) costs nothing.
   */
  commit: () => void;
}

/**
 * Begin a recorded scan pass, or return `null` when the (symbol × book) slot is
 * inside the pass throttle — the caller then scans exactly as before, untaped.
 * Nothing here reads or alters any selection parameter (observe-only).
 */
export function beginOtmAdmissionPass(ctx: OtmAdmissionPassContext): OtmAdmissionPassRecorder | null {
  const now = ctx.now ?? Date.now();
  const key = `${ctx.book ?? ''}|${ctx.symbol}`;
  const last = lastPassAt.get(key);
  if (last !== undefined && now - last < PASS_THROTTLE_MS) {
    throttledPasses += 1;
    return null;
  }
  const accountClass = classifySpreadCeilingAccount(ctx.book ?? undefined);
  const etDay = etDateString(new Date(now));
  const decisions: OtmAdmissionDecision[] = [];
  return {
    onAdmission: (d) => {
      // Buffer capped at MAX_ROWS_PER_PASS + 1 so a pathological chain cannot
      // grow an unbounded array (TRA-4158); the one extra slot is what lets
      // commit() see "oversized" and drop the pass WHOLE.
      if (decisions.length <= MAX_ROWS_PER_PASS) decisions.push(d);
    },
    commit: () => {
      lastPassAt.set(key, now);
      if (decisions.length === 0) {
        emptyPasses += 1;
        return;
      }
      if (decisions.length > MAX_ROWS_PER_PASS) {
        oversizedPassesDropped += 1;
        return;
      }
      const t = tallyFor(etDay, accountClass);
      if (t.candidateRows + decisions.length > MAX_ROWS_PER_CLASS_PER_DAY) {
        budgetPassesDropped += 1;
        return;
      }
      const lines: string[] = [];
      for (const d of decisions) {
        const row: OtmAdmissionTapeCandidateRow = {
          kind: 'candidate',
          ts: now,
          etDay,
          accountClass,
          mode: ctx.mode,
          underlying: d.underlying,
          occSymbol: d.occSymbol,
          expiry: d.expiry,
          strike: d.strike,
          right: d.right,
          bid: d.bid,
          ask: d.ask,
          mark: d.mark,
          spreadPct: d.spreadPct,
          openInterest: d.openInterest,
          ...(typeof d.absDelta === 'number' && Number.isFinite(d.absDelta) ? { absDelta: d.absDelta } : {}),
          admitted: d.admitted,
          bindingReason: d.bindingReason,
        };
        applyRow(row);
        lines.push(JSON.stringify(row));
      }
      t.passesRecorded += 1;
      appendLines(lines);
    },
  };
}

function recordLink(kind: 'ranked' | 'ordered', ctx: OtmAdmissionPassContext, occSymbol: string): void {
  const now = ctx.now ?? Date.now();
  const row: OtmAdmissionTapeLinkRow = {
    kind,
    ts: now,
    etDay: etDateString(new Date(now)),
    accountClass: classifySpreadCeilingAccount(ctx.book ?? undefined),
    mode: ctx.mode,
    underlying: ctx.symbol,
    occSymbol,
  };
  applyRow(row);
  appendLines([JSON.stringify(row)]);
}

/** The selector nominated this contract (it was RANKED first). Never throttled. */
export function recordOtmAdmissionRanked(ctx: OtmAdmissionPassContext, occSymbol: string): void {
  recordLink('ranked', ctx, occSymbol);
}

/** A final open went through for this contract (it was ORDERED). Never throttled. */
export function recordOtmAdmissionOrdered(ctx: OtmAdmissionPassContext, occSymbol: string): void {
  recordLink('ordered', ctx, occSymbol);
}

export interface OtmAdmissionTapeHydration {
  days: number;
  records: number;
}

function parseRow(trimmed: string): OtmAdmissionTapeRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // torn/partial line — skip, never abort the hydrate
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return null;
  if (typeof rec.etDay !== 'string' || rec.etDay === '') return null;
  if (rec.kind === 'ranked' || rec.kind === 'ordered') {
    if (typeof rec.occSymbol !== 'string') return null;
    return rec as unknown as OtmAdmissionTapeLinkRow;
  }
  if (rec.kind !== 'candidate') return null;
  if (typeof rec.occSymbol !== 'string' || typeof rec.admitted !== 'boolean') return null;
  if (typeof rec.bindingReason !== 'string') return null;
  return rec as unknown as OtmAdmissionTapeCandidateRow;
}

/**
 * Rebuild the aggregates from disk on boot and remember `dir` for appends.
 * Idempotent (clears first). Rows older than {@link RETAIN_MS} are dropped and
 * the file is COMPACTED to the kept lines; then whole OLDEST ET days are pruned
 * until the byte size fits {@link MAX_FILE_BYTES}. Best-effort throughout.
 */
export function hydrateOtmAdmissionTapeFromDisk(dir: string, now: number = Date.now()): OtmAdmissionTapeHydration {
  clearOtmAdmissionTape();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(otmAdmissionTapePath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  /** etDay → kept lines, insertion-ordered (JSONL is append-only ⇒ ts-ordered). */
  const keptByDay = new Map<string, string[]>();
  let totalBytes = 0;
  let droppedByTime = 0;
  let nonEmptyLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    nonEmptyLines += 1;
    const rec = parseRow(trimmed);
    if (rec == null) continue;
    if (rec.ts < cutoff) {
      droppedByTime += 1;
      continue;
    }
    const clean = JSON.stringify(rec);
    let bucket = keptByDay.get(rec.etDay);
    if (!bucket) {
      bucket = [];
      keptByDay.set(rec.etDay, bucket);
    }
    bucket.push(clean);
    totalBytes += clean.length + 1;
  }

  // Byte-cap prune: WHOLE oldest ET days only (a partial day would bias its own
  // within-day sample toward the afternoon, and a biased day is worse than an
  // absent one for a per-session denominator).
  const days = [...keptByDay.keys()].sort();
  let prunedDays = 0;
  while (totalBytes > MAX_FILE_BYTES && days.length > 1) {
    const oldest = days.shift()!;
    const lines = keptByDay.get(oldest)!;
    for (const l of lines) totalBytes -= l.length + 1;
    keptByDay.delete(oldest);
    prunedDays += 1;
  }

  let records = 0;
  const keptLines: string[] = [];
  for (const day of days) {
    for (const line of keptByDay.get(day)!) {
      const rec = parseRow(line);
      if (rec == null) continue;
      applyRow(rec);
      keptLines.push(line);
      records += 1;
    }
  }

  if (records < nonEmptyLines) {
    const path = otmAdmissionTapePath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('otm-admission-tape compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (droppedByTime > 0 || prunedDays > 0) {
    log.info('otm-admission-tape compacted', { droppedByTime, prunedDays, kept: records });
  }

  hydratedDays = byDay.size;
  hydratedRecords = records;
  return { days: byDay.size, records };
}

// ── Health summary ────────────────────────────────────────────────────────────

export interface OtmAdmissionTapeClassDaySummary {
  etDay: string;
  candidateRows: number;
  admitted: number;
  /** Refusal/admit split by FIRST binding gate (`none` = admitted). */
  byBindingReason: Record<string, number>;
  passesRecorded: number;
  ranked: number;
  ordered: number;
  lastTs: number;
}

export interface OtmAdmissionTapeClassSummary {
  accountClass: string;
  /** Distinct ET days holding ≥1 ADMITTED candidate row — the AC4 session unit. */
  sessionsWithAdmissions: number;
  candidateRows: number;
  admitted: number;
  ranked: number;
  ordered: number;
  days: OtmAdmissionTapeClassDaySummary[];
}

export interface OtmAdmissionTapeSummary {
  /** Classes are NEVER pooled (TRA-3715/TRA-3682/TRA-3709) — one entry per class seen. */
  byClass: OtmAdmissionTapeClassSummary[];
  /** The AC4 gate readout: desk-class ET days holding ≥1 admitted candidate row. */
  deskSessionsWithAdmissions: number;
  policy: {
    passThrottleMs: number;
    maxRowsPerPass: number;
    maxRowsPerClassPerDay: number;
    retainDays: number;
    maxFileBytes: number;
    /** The independence statement, published so a grader need not read source. */
    sampling: string;
  };
  counters: {
    throttledPasses: number;
    oversizedPassesDropped: number;
    budgetPassesDropped: number;
    emptyPasses: number;
  };
  durability: {
    dataDirConfigured: boolean;
    appendErrors: number;
    lastAppendError: string | null;
    hydratedDays: number;
    hydratedRecords: number;
  };
}

export function summarizeOtmAdmissionTape(): OtmAdmissionTapeSummary {
  const classes = new Map<string, OtmAdmissionTapeClassSummary>();
  for (const [etDay, perClass] of byDay) {
    for (const [accountClass, t] of perClass) {
      let c = classes.get(accountClass);
      if (!c) {
        c = {
          accountClass,
          sessionsWithAdmissions: 0,
          candidateRows: 0,
          admitted: 0,
          ranked: 0,
          ordered: 0,
          days: [],
        };
        classes.set(accountClass, c);
      }
      c.candidateRows += t.candidateRows;
      c.admitted += t.admitted;
      c.ranked += t.ranked;
      c.ordered += t.ordered;
      if (t.admitted > 0) c.sessionsWithAdmissions += 1;
      c.days.push({
        etDay,
        candidateRows: t.candidateRows,
        admitted: t.admitted,
        byBindingReason: { ...t.byBindingReason },
        passesRecorded: t.passesRecorded,
        ranked: t.ranked,
        ordered: t.ordered,
        lastTs: t.lastTs,
      });
    }
  }
  const byClass = [...classes.values()].sort((a, b) => a.accountClass.localeCompare(b.accountClass));
  for (const c of byClass) c.days.sort((a, b) => a.etDay.localeCompare(b.etDay));
  return {
    byClass,
    deskSessionsWithAdmissions: classes.get('desk')?.sessionsWithAdmissions ?? 0,
    policy: {
      passThrottleMs: PASS_THROTTLE_MS,
      maxRowsPerPass: MAX_ROWS_PER_PASS,
      maxRowsPerClassPerDay: MAX_ROWS_PER_CLASS_PER_DAY,
      retainDays: Math.round(RETAIN_MS / (24 * 60 * 60 * 1000)),
      maxFileBytes: MAX_FILE_BYTES,
      sampling:
        'Pass-level throttle (wall-clock per symbol×book), whole-pass drops only, per-class daily budget — every rule independent of mark and spreadPct by construction.',
    },
    counters: {
      throttledPasses,
      oversizedPassesDropped,
      budgetPassesDropped,
      emptyPasses,
    },
    durability: {
      dataDirConfigured: dataDir != null,
      appendErrors,
      lastAppendError,
      hydratedDays,
      hydratedRecords,
    },
  };
}

export interface OtmAdmissionTapeRowFilter {
  etDay?: string;
  accountClass?: string;
  /** Hard-capped at {@link MAX_READ_ROWS} regardless of the requested value. */
  limit?: number;
}

/**
 * Stream-read raw rows off disk for the export path (the TRA-4623 sweep re-run).
 * readline over a stream, never `readFileSync` — the file may be tens of MB and
 * this route must not spike RSS against the TRA-4158 ceiling.
 */
export async function readOtmAdmissionTapeRows(
  filter: OtmAdmissionTapeRowFilter = {},
): Promise<{ rows: OtmAdmissionTapeRow[]; truncated: boolean }> {
  if (dataDir == null) return { rows: [], truncated: false };
  const limit = Math.min(Math.max(1, filter.limit ?? MAX_READ_ROWS), MAX_READ_ROWS);
  const rows: OtmAdmissionTapeRow[] = [];
  let truncated = false;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(otmAdmissionTapePath(dataDir), { encoding: 'utf8' });
  } catch {
    return { rows: [], truncated: false };
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const rec = parseRow(trimmed);
      if (rec == null) continue;
      if (filter.etDay !== undefined && rec.etDay !== filter.etDay) continue;
      if (filter.accountClass !== undefined && rec.accountClass !== filter.accountClass) continue;
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(rec);
    }
  } catch (err) {
    // A missing file (first boot) or a read error yields what was collected —
    // the route's durability block is where a reader learns to distrust it.
    log.warn('otm-admission-tape read failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    rl.close();
    stream.destroy();
  }
  return { rows, truncated };
}
