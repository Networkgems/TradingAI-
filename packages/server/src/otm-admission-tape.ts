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
// being measured) AND — since policy v2 — independent of time-of-day:
//   1. SLOT SAMPLER — the ET day is cut into 30-minute slots. A (book × symbol)
//      pass is recorded iff it is the first `ok` pass of that pair inside the
//      slot AND `fnv1a(book|symbol|etDay|slot) % SAMPLE_MOD[class] === 0`. The
//      selection is decided BEFORE the scan from identity and the clock alone —
//      never from a quote, never from scan order. Unselected passes still scan
//      and trade exactly as before; they are simply not written.
//   2. WHOLE-PASS DROPS ONLY — a pass whose decision count exceeds
//      `MAX_ROWS_PER_PASS` is dropped IN FULL and counted
//      (`oversizedPassesDropped`), never truncated: truncation by chain position
//      correlates with strike and therefore with mark.
//   3. PER-SLOT BUDGET — a (accountClass × ET day × slot) cell holds at most
//      `MAX_ROWS_PER_SLOT[class]` candidate rows; further passes in that cell are
//      dropped whole and counted (`slotBudgetPassesDropped`). The budget is per
//      SLOT, never per day, so exhausting it can only thin one half-hour.
// ⚠ Policy v1 (f39e939b, live 2026-09-17..18) had a 2h per-pair throttle and a
// first-come 6000-row DAILY budget. On its first session (2026-09-18) the desk
// budget was exhausted by 10:17 ET and the fixture budget within one minute of
// the open, so the whole day's tape was the opening 47 minutes — the widest-
// spread half-hour, and entirely outside `OTM_ENTRY_WINDOWS_ET`. Time-of-day
// correlates with spread, so v1 rows are NOT a quote-independent sample; they
// carry no `samplingPolicy` field and are excluded from the AC4 session count.
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
import { etClockParts } from './et-clock.js';
import {
  classifySpreadCeilingAccount,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';

const log = logger.child({ module: 'otm-admission-tape' });

export const OTM_ADMISSION_TAPE_FILENAME = 'otm-admission-tape.jsonl';

/** Rows written by this build carry this; v1 rows (no field) are open-biased. */
export const OTM_ADMISSION_SAMPLING_POLICY = 2;
/** ET slot width for the sampler (rule 1) and the budget (rule 3). */
const SLOT_MINUTES = 30;
/**
 * Rule-1 modulus per class. Sized off the 2026-09-18 desk tape (192 symbols,
 * ~31 decisions per pass, one universe cycle ≈ 45 min ⇒ ~53k rows/day
 * unsampled): 12 ⇒ ~4.5k desk rows/day ≈ 1.5 MB, so the byte cap holds well
 * over the ≥20 desk sessions AC4 needs. Non-desk classes are retention-shape
 * only and scan far faster (fixture: 113 passes in the first minute), so they
 * are sampled harder.
 */
const SAMPLE_MOD: Record<string, number> = { desk: 12 };
const SAMPLE_MOD_OTHER = 48;
/** Rule-3 per (class × ET day × slot) row budget — a backstop, ~3x desk's expected slot volume. */
const MAX_ROWS_PER_SLOT: Record<string, number> = { desk: 1000 };
const MAX_ROWS_PER_SLOT_OTHER = 200;
/** A pass bigger than this is dropped WHOLE (rule 2 above), never truncated. */
const MAX_ROWS_PER_PASS = 400;
/** Keep this many ms on disk — comfortably over the ≥20 RTH desk sessions AC4 needs. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * After time compaction, prune whole OLDEST ET days until the file fits this.
 * Sized off MEASURED v2 volume (2026-09-21/22: ~20.9k rows/day at ~308 B/row
 * ≈ 6.4 MB per desk session — 2.7x the pre-deploy estimate): the AC4 bar needs
 * ≥20 desk sessions of RAW rows simultaneously on disk for the TRA-4623 re-run,
 * and `sessionsWithAdmissions` itself is rebuilt from hydrated days, so a cap
 * that holds fewer sessions than the bar makes the bar unreachable. 192 MB
 * holds ~30 v2 sessions; the 60-day time retention binds first.
 */
const MAX_FILE_BYTES = 192 * 1024 * 1024;
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
  /**
   * Sampling policy that selected this row. ABSENT on v1 rows (the open-biased
   * first-come daily budget — see the policy header); `2` = the slot sampler.
   * A readout MUST filter to `samplingPolicy >= 2`.
   */
  samplingPolicy?: number;
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
  /** Admitted rows selected by policy >= 2 — the only ones AC4 counts. */
  admittedSampled: number;
  /** Candidate rows with no `samplingPolicy` (v1, open-biased). */
  legacyRows: number;
  byBindingReason: Record<string, number>;
  passesRecorded: number;
  ranked: number;
  ordered: number;
  firstTs: number;
  lastTs: number;
  /** Candidate rows per ET 30-minute slot — rule-3 budget AND time coverage. */
  rowsBySlot: Map<number, number>;
  /** `${underlying}|${ts}` of the last candidate row — rows of a pass are contiguous. */
  lastPassKey: string;
}

// ── Module state (bounded: aggregates + per-pair slot map, never raw rows) ───
let dataDir: string | null = null;
/** etDay → accountClass → tally. */
const byDay = new Map<string, Map<string, ClassDayTally>>();
/** `${book}|${symbol}` → `${etDay}|${slot}` of the pair's last COMMITTED pass (rule 1). */
const lastSlotByPair = new Map<string, string>();
let oversizedPassesDropped = 0;
let slotBudgetPassesDropped = 0;
let unsampledPasses = 0;
let emptyPasses = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedDays = 0;
let hydratedRecords = 0;
/** Approximate on-disk bytes: hydrated size plus every append since boot. */
let fileBytes = 0;

export function otmAdmissionTapePath(dir: string): string {
  return join(dir, OTM_ADMISSION_TAPE_FILENAME);
}

/** Test seam — clears every tally and forgets the data dir. */
export function clearOtmAdmissionTape(): void {
  dataDir = null;
  byDay.clear();
  lastSlotByPair.clear();
  oversizedPassesDropped = 0;
  slotBudgetPassesDropped = 0;
  unsampledPasses = 0;
  emptyPasses = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedDays = 0;
  hydratedRecords = 0;
  fileBytes = 0;
}

/** ET 30-minute slot index (0–47) of an instant. */
export function otmAdmissionSlot(ms: number): number {
  const { hour, minute } = etClockParts(new Date(ms));
  return Math.floor((hour * 60 + minute) / SLOT_MINUTES);
}

// Hydrate memo: every row of a pass shares one ts, so this almost always hits.
let slotMemoTs = Number.NaN;
let slotMemo = 0;
function slotOf(ms: number): number {
  if (ms !== slotMemoTs) {
    slotMemoTs = ms;
    slotMemo = otmAdmissionSlot(ms);
  }
  return slotMemo;
}

/** 32-bit FNV-1a — a stable, quote-blind hash for the rule-1 sampler. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Rule 1, pure: is this (book × symbol) pair selected in this ET slot?
 * Depends on identity and the clock ONLY — never on a quote, never on scan order.
 */
export function otmAdmissionSlotSelected(
  book: string,
  symbol: string,
  etDay: string,
  slot: number,
  accountClass: string,
): boolean {
  const mod = SAMPLE_MOD[accountClass] ?? SAMPLE_MOD_OTHER;
  return fnv1a(`${book}|${symbol}|${etDay}|${slot}`) % mod === 0;
}

function tallyFor(etDay: string, accountClass: string): ClassDayTally {
  let classes = byDay.get(etDay);
  if (!classes) {
    classes = new Map();
    byDay.set(etDay, classes);
  }
  let t = classes.get(accountClass);
  if (!t) {
    t = {
      candidateRows: 0,
      admitted: 0,
      admittedSampled: 0,
      legacyRows: 0,
      byBindingReason: {},
      passesRecorded: 0,
      ranked: 0,
      ordered: 0,
      firstTs: 0,
      lastTs: 0,
      rowsBySlot: new Map(),
      lastPassKey: '',
    };
    classes.set(accountClass, t);
  }
  return t;
}

function applyRow(row: OtmAdmissionTapeRow): void {
  const t = tallyFor(row.etDay, row.accountClass);
  if (row.kind === 'candidate') {
    t.candidateRows += 1;
    const sampled = typeof row.samplingPolicy === 'number' && row.samplingPolicy >= 2;
    if (!sampled) t.legacyRows += 1;
    if (row.admitted) {
      t.admitted += 1;
      if (sampled) t.admittedSampled += 1;
    }
    t.byBindingReason[row.bindingReason] = (t.byBindingReason[row.bindingReason] ?? 0) + 1;
    const slot = slotOf(row.ts);
    t.rowsBySlot.set(slot, (t.rowsBySlot.get(slot) ?? 0) + 1);
    // Rebuilt on hydrate too (v1 read 0 after every reboot).
    const passKey = `${row.underlying}|${row.ts}`;
    if (passKey !== t.lastPassKey) {
      t.lastPassKey = passKey;
      t.passesRecorded += 1;
    }
  } else if (row.kind === 'ranked') {
    t.ranked += 1;
  } else {
    t.ordered += 1;
  }
  if (t.firstTs === 0 || row.ts < t.firstTs) t.firstTs = row.ts;
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
    const chunk = lines.join('\n') + '\n';
    appendFileSync(path, chunk, 'utf8');
    fileBytes += chunk.length;
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
   * rows (or counts a whole-pass drop) and consumes the pair's ET slot. A pass
   * abandoned without commit (breaker, no chain, fetch error) costs nothing.
   */
  commit: () => void;
}

/**
 * Begin a recorded scan pass, or return `null` when rule 1 does not select this
 * (symbol × book) pass — the caller then scans exactly as before, untaped.
 * Nothing here reads or alters any selection parameter (observe-only).
 */
export function beginOtmAdmissionPass(ctx: OtmAdmissionPassContext): OtmAdmissionPassRecorder | null {
  const now = ctx.now ?? Date.now();
  const book = ctx.book ?? '';
  const key = `${book}|${ctx.symbol}`;
  const accountClass = classifySpreadCeilingAccount(ctx.book ?? undefined);
  const etDay = etDateString(new Date(now));
  const slot = otmAdmissionSlot(now);
  const slotKey = `${etDay}|${slot}`;
  if (
    lastSlotByPair.get(key) === slotKey
    || !otmAdmissionSlotSelected(book, ctx.symbol, etDay, slot, accountClass)
  ) {
    unsampledPasses += 1;
    return null;
  }
  const decisions: OtmAdmissionDecision[] = [];
  return {
    onAdmission: (d) => {
      // Buffer capped at MAX_ROWS_PER_PASS + 1 so a pathological chain cannot
      // grow an unbounded array (TRA-4158); the one extra slot is what lets
      // commit() see "oversized" and drop the pass WHOLE.
      if (decisions.length <= MAX_ROWS_PER_PASS) decisions.push(d);
    },
    commit: () => {
      lastSlotByPair.set(key, slotKey);
      if (decisions.length === 0) {
        emptyPasses += 1;
        return;
      }
      if (decisions.length > MAX_ROWS_PER_PASS) {
        oversizedPassesDropped += 1;
        return;
      }
      const t = tallyFor(etDay, accountClass);
      const slotBudget = MAX_ROWS_PER_SLOT[accountClass] ?? MAX_ROWS_PER_SLOT_OTHER;
      if ((t.rowsBySlot.get(slot) ?? 0) + decisions.length > slotBudget) {
        slotBudgetPassesDropped += 1;
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
          samplingPolicy: OTM_ADMISSION_SAMPLING_POLICY,
        };
        applyRow(row);
        lines.push(JSON.stringify(row));
      }
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
  fileBytes = totalBytes;
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
  /** Admitted rows selected by sampling policy >= 2 (what AC4 counts). OPTIONAL: older builds lack it. */
  admittedSampled?: number;
  /** Candidate rows with no `samplingPolicy` — v1, open-biased; exclude from any readout. */
  legacyRows?: number;
  /** Candidate rows per ET 30-minute slot, `HH:MM` slot start → rows. The time-coverage check. */
  rowsBySlotEt?: Record<string, number>;
  firstTs?: number;
  lastTs: number;
}

export interface OtmAdmissionTapeClassSummary {
  accountClass: string;
  /**
   * Distinct ET days holding ≥1 ADMITTED candidate row selected by sampling
   * policy >= 2 — the AC4 session unit. v1 (open-biased) days never count.
   */
  sessionsWithAdmissions: number;
  /** Days whose admitted rows are ALL v1 — shown, never counted. */
  legacySessions?: number;
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
    samplingPolicy: number;
    slotMinutes: number;
    sampleModDesk: number;
    sampleModOther: number;
    maxRowsPerPass: number;
    maxRowsPerSlotDesk: number;
    maxRowsPerSlotOther: number;
    retainDays: number;
    maxFileBytes: number;
    /** The independence statement, published so a grader need not read source. */
    sampling: string;
  };
  counters: {
    unsampledPasses: number;
    oversizedPassesDropped: number;
    slotBudgetPassesDropped: number;
    emptyPasses: number;
  };
  durability: {
    dataDirConfigured: boolean;
    appendErrors: number;
    lastAppendError: string | null;
    hydratedDays: number;
    hydratedRecords: number;
    /** Approximate file size — pruning whole oldest days starts at `policy.maxFileBytes`. */
    fileBytes: number;
  };
}

function slotLabel(slot: number): string {
  const m = slot * SLOT_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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
          legacySessions: 0,
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
      if (t.admittedSampled > 0) c.sessionsWithAdmissions += 1;
      else if (t.admitted > 0) c.legacySessions = (c.legacySessions ?? 0) + 1;
      const rowsBySlotEt: Record<string, number> = {};
      for (const slot of [...t.rowsBySlot.keys()].sort((a, b) => a - b)) {
        rowsBySlotEt[slotLabel(slot)] = t.rowsBySlot.get(slot)!;
      }
      c.days.push({
        etDay,
        candidateRows: t.candidateRows,
        admitted: t.admitted,
        admittedSampled: t.admittedSampled,
        legacyRows: t.legacyRows,
        byBindingReason: { ...t.byBindingReason },
        passesRecorded: t.passesRecorded,
        ranked: t.ranked,
        ordered: t.ordered,
        rowsBySlotEt,
        firstTs: t.firstTs,
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
      samplingPolicy: OTM_ADMISSION_SAMPLING_POLICY,
      slotMinutes: SLOT_MINUTES,
      sampleModDesk: SAMPLE_MOD.desk,
      sampleModOther: SAMPLE_MOD_OTHER,
      maxRowsPerPass: MAX_ROWS_PER_PASS,
      maxRowsPerSlotDesk: MAX_ROWS_PER_SLOT.desk,
      maxRowsPerSlotOther: MAX_ROWS_PER_SLOT_OTHER,
      retainDays: Math.round(RETAIN_MS / (24 * 60 * 60 * 1000)),
      maxFileBytes: MAX_FILE_BYTES,
      sampling:
        'v2 slot sampler: first ok pass per (book×symbol) per ET 30-min slot, selected by fnv1a(book|symbol|etDay|slot) % sampleMod — decided from identity and clock before the scan, independent of mark, spreadPct, scan order and time-of-day. Whole-pass drops only; per-(class×day×slot) row budget, never a daily first-come one. Rows without samplingPolicy are v1 (open-biased) and excluded from sessionsWithAdmissions.',
    },
    counters: {
      unsampledPasses,
      oversizedPassesDropped,
      slotBudgetPassesDropped,
      emptyPasses,
    },
    durability: {
      dataDirConfigured: dataDir != null,
      appendErrors,
      lastAppendError,
      hydratedDays,
      hydratedRecords,
      fileBytes,
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
