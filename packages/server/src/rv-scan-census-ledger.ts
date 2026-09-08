/**
 * TRA-4350 — the DURABLE per-ET-day scan census.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * The option trade journal recorded no opens in EITHER book between
 * 2026-09-01T19:08:14Z and the filing on 2026-09-04. Three states render as that
 * same zero:
 *
 *   1. the engine RAN, evaluated candidates, and DECLINED every one of them;
 *   2. the engine NEVER RAN (flag off, book unreachable, loop wedged);
 *   3. the engine PASSED candidates and the open never reached the journal.
 *
 * `rv-scan-telemetry` already separates all three — `candidatesEvaluated`,
 * `candidatesPassed`, `opensPlaced` and `rejectionsByGate` are exactly the right
 * columns, and `RvScanRun` is careful enough that an abandoned pass records
 * nothing. What it cannot do is testify about a PAST day: `scanCountSinceBoot` is
 * a since-boot latch and `lastScan` holds ONE cycle, on a box that self-restarts
 * 6–12 times a session (TRA-4158 — the 2026-09-02 census alone added ~8). By the
 * time anyone reads the route, every counter that could have classified the
 * silence has been zeroed by a reboot, so the zero is UNMEASURED, not empty —
 * which is the same gap TRA-2193 named for the RV entry path and TRA-4254 is
 * still living with.
 *
 * This module is the retained half. It mirrors the TRA-3080 arm-record
 * discipline in `directional-open-ledger` (JSONL append + boot hydrate +
 * compaction + per-boot supersede), one axis over: instead of "was the pass
 * REACHABLE for this book" it carries "what did the pass DECIDE, and why".
 *
 * ── WHY IT IS A SEPARATE FILE FROM directional-opens.jsonl ───────────────────
 * That ledger's non-arm records are retained for 3 days and compacted against a
 * 3-day cutoff. These need 30, the same as the arm records; sharing a file means
 * one more `kind` that every future reader of that fold has to know not to
 * mis-cutoff. The cost of a second file is one more hydrate call at boot.
 *
 * ── HOW THE COUNTS STAY HONEST ACROSS REBOOTS ────────────────────────────────
 * Identical to the arm records, and for the identical reason. A line is appended
 * on the FIRST scan under a key and at most once per {@link CENSUS_FLUSH_MS}
 * thereafter, each carrying the running totals for THIS boot. `bootId` is part of
 * the key, so the hydrate folds to "last line wins per (key, bootId)" and the
 * summary then SUMS across boots — a same-day restart ADDS to the day instead of
 * resetting it.
 *
 * ⚠️ Every count here is a LOWER BOUND once it has been through a hydrate: the
 * 5-minute flush throttle means the tail of scans a dying boot had not yet
 * flushed is not on disk, and the watchdog kills this process mid-`otm-scan`
 * routinely. `state` is NOT a lower bound in the direction that matters — it is
 * derived from counts that only ever grow, and every one of the four live states
 * is reached by a count being NON-zero. A truncated tail can under-report how
 * MUCH happened; it cannot manufacture a `ran_and_declined` out of a day that
 * opened positions, because `opensPlaced > 0` is flushed on first sight.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { RV_SCAN_PATH_IDS, type RvScanPathId, type RvScanRecord } from './rv-scan-telemetry.js';
// Type-only (erased at compile ⇒ no runtime import edge), same contract as the
// directional ledger: the class string is produced by
// `classifySpreadCeilingAccount` at the CALL SITE and merely stored here.
import type { SpreadCeilingAccountClass } from './option-spread-cost.js';

const log = logger.child({ module: 'rv-scan-census-ledger' });

export const RV_SCAN_CENSUS_LOG_FILENAME = 'rv-scan-census.jsonl';

/**
 * Retain 30 days, matching the TRA-3080 arm records. The question these answer
 * ("what was the engine deciding LAST WEEK") is inherently retrospective, and
 * they are sparse: at most one line per (ET day × path × account class × boot)
 * per {@link CENSUS_FLUSH_MS}, with superseded lines dropped on boot compaction.
 */
export const CENSUS_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Append at most one census line per key per 5 minutes (plus one on first sight). */
const CENSUS_FLUSH_MS = 5 * 60 * 1000;

/**
 * Cap the distinct gate labels retained per key. The labels come from
 * `RvScanRun.reject(gate)` call sites and are a closed set in practice (~10), but
 * they are free-form strings, so a future caller interpolating a symbol into one
 * would otherwise grow the line without bound. Overflow folds into
 * {@link GATE_OVERFLOW} rather than being dropped, so the bucket sum still
 * reconciles against `candidatesEvaluated - candidatesPassed`.
 */
const MAX_GATE_LABELS = 32;

/** Where gate labels beyond {@link MAX_GATE_LABELS} are folded. */
export const GATE_OVERFLOW = 'gate_label_overflow';

/**
 * The three-way question TRA-4350 asked, answered per (ET day × path × class).
 *
 * `unmeasured` is deliberately NOT in this union: an absent cell is the absence
 * of a reading and is represented by the cell not existing, never by a state
 * string on a row of zeros. A zero row that claimed a state would be the exact
 * defect this module exists to remove.
 */
export type RvScanDayState =
  /** Scans ran and at least one open reached the account. The engine is trading. */
  | 'ran_and_opened'
  /**
   * Scans ran, candidates CLEARED every gate, and NOT ONE became an open.
   * This is TRA-4350's third state — "the engine traded and the journal did not
   * write" — and it is the reading that must never be pooled with a drought.
   */
  | 'passed_but_no_open'
  /**
   * Scans ran, candidates were evaluated, none cleared. A genuine drought.
   * `rejectionsByGate` names which gate consumed them.
   */
  | 'ran_and_declined'
  /**
   * The loop turned but was handed nothing to look at (empty universe, or every
   * symbol filtered upstream of `enterSymbol`). Distinct from a decline: no gate
   * on this path refused anything, so the cause is upstream.
   */
  | 'ran_unfed';

/** One durable scan-census record. */
interface RvScanCensusRecord {
  kind: 'scan-census';
  /** Time of the most recent scan folded into this line, ms epoch. */
  ts: number;
  /** ET calendar day the scans fell on. */
  etDay: string;
  path: RvScanPathId;
  /** Owning book label (the same string the options account stamps as `account`). */
  account: string;
  /** Class of that book, computed by `classifySpreadCeilingAccount` at the call site. */
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  /** Identifies the writing process so a re-flush supersedes rather than double-counts. */
  bootId: string;
  /** Completed passes under this key during THIS boot, as of the last flush. */
  scans: number;
  candidatesEvaluated: number;
  candidatesPassed: number;
  opensPlaced: number;
  rejectionsByGate: Record<string, number>;
  /**
   * TRA-4357 — passes where ONE gate took 100% of a non-empty `candidatesEvaluated`.
   *
   * Summing `rejectionsByGate` per day answers "which gate dominated" but NOT
   * "was the sleeve blind or was it choosing". A day of 20 blind cycles and a
   * day of 20 cycles that each declined for mixed strategy reasons can sum to
   * the same dominant gate. This counter is the discriminator, and it is a
   * COUNT OF CYCLES so it survives the summing that erases the per-cycle shape.
   */
  blindScans: number;
  /**
   * TRA-4357 — sum of `universeSize` over the folded passes. Retained because
   * `candidatesEvaluated` is what the budgeted sweep actually walked, not what
   * it was handed; the gap between them is its own diagnostic and the filing
   * asked for the universe to survive the fold.
   */
  universeSum: number;
  /** First scan under this key during this boot, ms epoch. */
  firstAt: number;
}

interface CensusTally {
  etDay: string;
  path: RvScanPathId;
  account: string;
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  bootId: string;
  scans: number;
  candidatesEvaluated: number;
  candidatesPassed: number;
  opensPlaced: number;
  rejectionsByGate: Map<string, number>;
  /** TRA-4357 — see {@link RvScanCensusRecord.blindScans}. */
  blindScans: number;
  /** TRA-4357 — see {@link RvScanCensusRecord.universeSum}. */
  universeSum: number;
  firstAt: number;
  lastAt: number;
  /** ms epoch of the last line appended for this tally (0 ⇒ never appended). */
  lastFlushedAt: number;
}

// ── In-memory store ──────────────────────────────────────────────────────────
//
// Module-global + observe-only, like the directional ledger: `dataDir` is set
// once at boot by the hydrate so `RvScanRun.finish()` can append without
// threading a path down through SignalEngine.

let dataDir: string | null = null;
const tallies = new Map<string, CensusTally>();

/**
 * Identifies THIS process for the supersede-vs-sum fold. Derived from pid +
 * module-load time, unique per boot on a box that restarts in place.
 */
let censusBootId = `${process.pid}-${Date.now()}`;

/** Test seam — pin the boot id so a test can simulate two distinct boots. */
export function __setRvScanCensusBootId(id: string): void {
  censusBootId = id;
}

/** Test seam — drop every counter and the configured dir. */
export function clearRvScanCensusLedger(): void {
  dataDir = null;
  tallies.clear();
}

export function rvScanCensusLogPath(dir: string): string {
  return join(dir, RV_SCAN_CENSUS_LOG_FILENAME);
}

function censusKey(
  etDay: string,
  path: RvScanPathId,
  account: string,
  mode: 'demo' | 'live',
  bootId: string,
): string {
  return `${etDay}\x00${path}\x00${account}\x00${mode}\x00${bootId}`;
}

function isPathId(v: unknown): v is RvScanPathId {
  return typeof v === 'string' && (RV_SCAN_PATH_IDS as readonly string[]).includes(v);
}

/**
 * Fold `add` into `into`, honouring the label cap.
 *
 * {@link GATE_OVERFLOW} does NOT consume one of the {@link MAX_GATE_LABELS}
 * slots. It must not: this fold runs twice on the same data — once into the
 * per-boot tally, once again when the summary merges tallies across boots — and
 * if the overflow bucket took a slot, the second pass would evict one more real
 * label than the first and the published overflow count would drift by the
 * number of times the data had been folded. A census whose numbers depend on how
 * often they were re-read is not a census.
 */
function mergeGates(into: Map<string, number>, add: Record<string, number>): void {
  for (const [gate, n] of Object.entries(add)) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    const distinctReal = into.size - (into.has(GATE_OVERFLOW) ? 1 : 0);
    const label =
      gate === GATE_OVERFLOW || into.has(gate) || distinctReal < MAX_GATE_LABELS
        ? gate
        : GATE_OVERFLOW;
    into.set(label, (into.get(label) ?? 0) + n);
  }
}

function gatesToObject(gates: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [gate, n] of [...gates.entries()].sort((a, b) => b[1] - a[1])) out[gate] = n;
  return out;
}

/** Append one census line for `tally` (best-effort IO), stamping the flush time. */
function flushCensus(tally: CensusTally): void {
  tally.lastFlushedAt = tally.lastAt;
  if (dataDir == null) return;
  const path = rvScanCensusLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: RvScanCensusRecord = {
      kind: 'scan-census',
      ts: tally.lastAt,
      etDay: tally.etDay,
      path: tally.path,
      account: tally.account,
      accountClass: tally.accountClass,
      mode: tally.mode,
      bootId: tally.bootId,
      scans: tally.scans,
      candidatesEvaluated: tally.candidatesEvaluated,
      candidatesPassed: tally.candidatesPassed,
      opensPlaced: tally.opensPlaced,
      rejectionsByGate: gatesToObject(tally.rejectionsByGate),
      blindScans: tally.blindScans,
      universeSum: tally.universeSum,
      firstAt: tally.firstAt,
    };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('rv-scan-census append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * TRA-4357 — did ONE gate take the WHOLE of a non-empty pass?
 *
 * Deliberately gate-AGNOSTIC. It would be easy to hard-code `scan:no_spot`,
 * since that is the gate that starved the OTM sleeve for four days; that would
 * also make this instrument blind to the next gate that saturates, which is the
 * failure mode it exists to catch. Any single gate at 100% is the signal — a
 * pass that rejected its entire universe for ONE reason did not exercise the
 * strategy, whatever the reason was.
 *
 * `candidatesPassed > 0` disqualifies: if anything cleared, the pass ruled.
 * An empty pass (`candidatesEvaluated === 0`) is `ran_unfed`, a DIFFERENT
 * reading that the day-state already carries — counting it here would pool two
 * distinct facts, which is the exact error this ticket was filed about.
 */
export function isBlindScan(record: {
  candidatesEvaluated: number;
  candidatesPassed: number;
  rejectionsByGate: Record<string, number>;
}): boolean {
  if (!(record.candidatesEvaluated > 0)) return false;
  if (record.candidatesPassed > 0) return false;
  const gates = Object.values(record.rejectionsByGate);
  if (gates.length !== 1) return false;
  return gates[0] === record.candidatesEvaluated;
}

/** The book a scan pass belongs to. Supplied by the caller; never inferred here. */
export interface RvScanCensusOwner {
  /** The options account label (`alertUsername`). Empty string is accepted and kept. */
  account: string;
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  etDay: string;
}

/**
 * Fold one COMPLETED scan pass into the retained census.
 *
 * Call it with the record `RvScanRun.finish()` returned — never before — so an
 * abandoned pass (the loop threw, or the watchdog killed the process mid
 * `otm-scan`, which on this box is routine) contributes nothing. That is the
 * correct direction: a crashed scan must not be able to publish itself as a
 * completed empty one.
 *
 * ⚠️ Called from the ENGINE, not from inside `finish()`. `rv-scan-telemetry` is
 * a pure counter module with no IO and no knowledge of which book it is counting
 * for; having it reach back into this ledger would both invert that and close an
 * import cycle (this module needs `RV_SCAN_PATH_IDS` from it to validate a
 * hydrated line).
 *
 * Best-effort on IO; a failure logs and is swallowed so this accounting can
 * never break the trade pass.
 */
export function recordRvScanCensus(
  owner: RvScanCensusOwner,
  path: RvScanPathId,
  record: RvScanRecord,
  now: number = Date.now(),
): void {
  if (owner.etDay === '') return;
  const key = censusKey(owner.etDay, path, owner.account, owner.mode, censusBootId);
  let tally = tallies.get(key);
  if (!tally) {
    tally = {
      etDay: owner.etDay,
      path,
      account: owner.account,
      accountClass: owner.accountClass,
      mode: owner.mode,
      bootId: censusBootId,
      scans: 0,
      candidatesEvaluated: 0,
      candidatesPassed: 0,
      opensPlaced: 0,
      rejectionsByGate: new Map(),
      blindScans: 0,
      universeSum: 0,
      firstAt: now,
      lastAt: now,
      lastFlushedAt: 0,
    };
    tallies.set(key, tally);
  }
  tally.scans += 1;
  tally.candidatesEvaluated += record.candidatesEvaluated;
  tally.candidatesPassed += record.candidatesPassed;
  tally.opensPlaced += record.opensPlaced;
  mergeGates(tally.rejectionsByGate, record.rejectionsByGate);
  if (isBlindScan(record)) tally.blindScans += 1;
  tally.universeSum += Number.isFinite(record.universeSize) ? record.universeSize : 0;
  tally.lastAt = now;

  // First sight always writes, so a path that scanned once before the box died
  // is still durable; after that the 5-minute throttle bounds the file.
  //
  // An open ALSO always writes, regardless of the throttle. `opensPlaced > 0` is
  // the single fact that distinguishes `ran_and_opened` from every failure state
  // below it, and losing it to an unflushed tail would let a session that traded
  // read back as a drought — the expensive direction of this instrument's error.
  if (
    tally.lastFlushedAt === 0
    || record.opensPlaced > 0
    || now - tally.lastFlushedAt >= CENSUS_FLUSH_MS
  ) {
    flushCensus(tally);
  }
}

/** What {@link hydrateRvScanCensusFromDisk} recovered (for the boot log line). */
export interface RvScanCensusHydration {
  /** Distinct ET days retained after compaction. */
  days: number;
  /** Distinct (day × path × book × boot) tallies retained. */
  tallies: number;
  /** Lines dropped as older than {@link CENSUS_RETAIN_MS}, torn, or malformed. */
  dropped: number;
}

/**
 * Rebuild the in-memory tallies from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call exactly
 * once at startup before any live pass. Best-effort — a missing or corrupt file
 * yields an empty hydration and a torn trailing line is skipped rather than
 * throwing.
 */
export function hydrateRvScanCensusFromDisk(
  dir: string,
  now: number = Date.now(),
): RvScanCensusHydration {
  clearRvScanCensusLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(rvScanCensusLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - CENSUS_RETAIN_MS;
  let dropped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: RvScanCensusRecord;
    try {
      rec = JSON.parse(trimmed) as RvScanCensusRecord;
    } catch {
      dropped += 1;
      continue;
    }
    if (
      typeof rec.ts !== 'number'
      || !Number.isFinite(rec.ts)
      || rec.ts < cutoff
      || typeof rec.etDay !== 'string'
      || rec.etDay === ''
      || !isPathId(rec.path)
      || typeof rec.account !== 'string'
      || (rec.mode !== 'demo' && rec.mode !== 'live')
      || typeof rec.bootId !== 'string'
      || rec.bootId === ''
      || typeof rec.scans !== 'number'
      || !Number.isFinite(rec.scans)
      || rec.scans < 0
    ) {
      dropped += 1;
      continue;
    }

    const key = censusKey(rec.etDay, rec.path, rec.account, rec.mode, rec.bootId);
    const prior = tallies.get(key);
    // Last line wins WITHIN a boot (it supersedes the earlier partial count);
    // distinct boots keep distinct keys and are SUMMED by the reader. Guard on
    // `scans` rather than `ts` so an out-of-order append cannot lose a count.
    if (prior && prior.scans >= rec.scans) {
      dropped += 1;
      continue;
    }
    const gates = new Map<string, number>();
    mergeGates(gates, rec.rejectionsByGate ?? {});
    tallies.set(key, {
      etDay: rec.etDay,
      path: rec.path,
      account: rec.account,
      accountClass: rec.accountClass,
      mode: rec.mode,
      bootId: rec.bootId,
      scans: rec.scans,
      candidatesEvaluated: num(rec.candidatesEvaluated),
      candidatesPassed: num(rec.candidatesPassed),
      opensPlaced: num(rec.opensPlaced),
      rejectionsByGate: gates,
      // TRA-4357 — `num()` floors a missing field to 0, which is right here:
      // lines written before this field existed carry no blind-cycle evidence,
      // and 0 is the honest "this line says nothing about it" value. It biases
      // the counter DOWN on pre-upgrade lines, never up, so a blind day can
      // read quieter than it was but a quiet day can never read blind.
      blindScans: num(rec.blindScans),
      universeSum: num(rec.universeSum),
      firstAt: Number.isFinite(rec.firstAt) ? rec.firstAt : rec.ts,
      lastAt: rec.ts,
      // Hydrated tallies belong to a PREVIOUS boot (different bootId ⇒ different
      // key), so this boot never appends to them; the value is inert.
      lastFlushedAt: rec.ts,
    });
  }

  // Re-emit ONE line per surviving tally. The fold above already dropped every
  // superseded re-flush, so this is where the throttled append's growth is
  // reclaimed: a path that scanned all session writes ~78 lines/day and compacts
  // back to 1.
  const kept: string[] = [];
  for (const t of tallies.values()) {
    const rec: RvScanCensusRecord = {
      kind: 'scan-census',
      ts: t.lastAt,
      etDay: t.etDay,
      path: t.path,
      account: t.account,
      accountClass: t.accountClass,
      mode: t.mode,
      bootId: t.bootId,
      scans: t.scans,
      candidatesEvaluated: t.candidatesEvaluated,
      candidatesPassed: t.candidatesPassed,
      opensPlaced: t.opensPlaced,
      rejectionsByGate: gatesToObject(t.rejectionsByGate),
      blindScans: t.blindScans,
      universeSum: t.universeSum,
      firstAt: t.firstAt,
    };
    kept.push(JSON.stringify(rec));
  }

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = rvScanCensusLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('rv-scan-census compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const days = new Set<string>([...tallies.values()].map((t) => t.etDay));
  return { days: days.size, tallies: tallies.size, dropped };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// ── Health summary ───────────────────────────────────────────────────────────

/** One (path × account class × mode) cell on one ET day. */
export interface RvScanCensusCell {
  path: RvScanPathId;
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  /** The TRA-4350 discriminator. See {@link RvScanDayState}. */
  state: RvScanDayState;
  /** Distinct books of this class that scanned this path on this day. */
  books: number;
  /** Distinct boots that contributed. High counts mean the census tail is lossy. */
  boots: number;
  /** ⚠️ LOWER BOUNDS — see the module header. */
  scans: number;
  candidatesEvaluated: number;
  candidatesPassed: number;
  opensPlaced: number;
  /**
   * Rejections by gate, busiest first. Summed across every pass on the day, so
   * this is the answer to "which gate consumed the candidates" — the column that
   * makes `ran_and_declined` an explanation rather than a restatement.
   */
  rejectionsByGate: Record<string, number>;
  /**
   * TRA-4357 — of `scans`, how many rejected their ENTIRE non-empty universe on
   * a SINGLE gate. This is the blind-vs-declining discriminator, and it is the
   * one number above that survives summing: `rejectionsByGate` pooled over a day
   * cannot tell 20 blind cycles from 20 mixed strategy declines that happen to
   * share a dominant gate.
   *
   * Read it as a RATIO against `scans`. `blindScans === scans` on a non-trivial
   * `scans` is the TRA-4357 condition itself (measured 2026-09-08: the `otm`
   * desk/demo cell was 383 of 383 on `scan:no_spot`). `blindScans === 0` means
   * every pass that day exercised the strategy, whatever it concluded.
   *
   * ⚠️ 0 on a cell whose lines were all written before 2026-09-08 means NOT
   * MEASURED, not "no blind cycles" — the field floors to 0 on hydration of an
   * older line. Check `etDay` before reading a zero as evidence.
   */
  blindScans: number;
  /**
   * TRA-4357 — summed `universeSize` over the folded passes. Divide by `scans`
   * for the mean universe the sweep was HANDED, which is a different number
   * from `candidatesEvaluated` (what the budget let it walk). Same
   * not-measured caveat as `blindScans` for pre-2026-09-08 lines.
   */
  universeSum: number;
  firstAt: number;
  lastAt: number;
}

export interface RvScanCensusDay {
  etDay: string;
  cells: RvScanCensusCell[];
}

/** Derive the day state from counts. See {@link RvScanDayState} for the ranking. */
export function classifyRvScanDayState(counts: {
  candidatesEvaluated: number;
  candidatesPassed: number;
  opensPlaced: number;
}): RvScanDayState {
  if (counts.opensPlaced > 0) return 'ran_and_opened';
  if (counts.candidatesPassed > 0) return 'passed_but_no_open';
  if (counts.candidatesEvaluated > 0) return 'ran_and_declined';
  return 'ran_unfed';
}

/**
 * The retained census, newest ET day first.
 *
 * ⚠️ An ABSENT (etDay, path, accountClass) cell means no book of that class
 * completed a pass on that path that day — it is the absence of a reading, NOT a
 * zero and NOT `ran_unfed`. Read it against `armByEtDay` on the same route,
 * which testifies about whether the pass was reachable at all.
 */
export function summarizeRvScanCensus(): RvScanCensusDay[] {
  interface Agg {
    path: RvScanPathId;
    accountClass: SpreadCeilingAccountClass;
    mode: 'demo' | 'live';
    books: Set<string>;
    boots: Set<string>;
    scans: number;
    candidatesEvaluated: number;
    candidatesPassed: number;
    opensPlaced: number;
    gates: Map<string, number>;
    blindScans: number;
    universeSum: number;
    firstAt: number;
    lastAt: number;
  }
  const byDay = new Map<string, Map<string, Agg>>();
  for (const t of tallies.values()) {
    let day = byDay.get(t.etDay);
    if (!day) {
      day = new Map();
      byDay.set(t.etDay, day);
    }
    const cellKey = `${t.path}\x00${t.accountClass}\x00${t.mode}`;
    let agg = day.get(cellKey);
    if (!agg) {
      agg = {
        path: t.path,
        accountClass: t.accountClass,
        mode: t.mode,
        books: new Set(),
        boots: new Set(),
        scans: 0,
        candidatesEvaluated: 0,
        candidatesPassed: 0,
        opensPlaced: 0,
        gates: new Map(),
        blindScans: 0,
        universeSum: 0,
        firstAt: t.firstAt,
        lastAt: t.lastAt,
      };
      day.set(cellKey, agg);
    }
    agg.books.add(t.account);
    agg.boots.add(t.bootId);
    // Summed across boots — keys are bootId-scoped, so a re-flushed line was
    // already collapsed at hydrate and cannot be counted twice here.
    agg.scans += t.scans;
    agg.candidatesEvaluated += t.candidatesEvaluated;
    agg.candidatesPassed += t.candidatesPassed;
    agg.opensPlaced += t.opensPlaced;
    mergeGates(agg.gates, gatesToObject(t.rejectionsByGate));
    agg.blindScans += t.blindScans;
    agg.universeSum += t.universeSum;
    if (t.firstAt < agg.firstAt) agg.firstAt = t.firstAt;
    if (t.lastAt > agg.lastAt) agg.lastAt = t.lastAt;
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([etDay, cells]) => ({
      etDay,
      cells: [...cells.values()]
        .map((a) => ({
          path: a.path,
          accountClass: a.accountClass,
          mode: a.mode,
          state: classifyRvScanDayState(a),
          books: a.books.size,
          boots: a.boots.size,
          scans: a.scans,
          candidatesEvaluated: a.candidatesEvaluated,
          candidatesPassed: a.candidatesPassed,
          opensPlaced: a.opensPlaced,
          rejectionsByGate: gatesToObject(a.gates),
          blindScans: a.blindScans,
          universeSum: a.universeSum,
          firstAt: a.firstAt,
          lastAt: a.lastAt,
        }))
        .sort((x, y) =>
          x.path < y.path ? -1 : x.path > y.path ? 1 : x.accountClass < y.accountClass ? -1 : 1,
        ),
    }));
}
