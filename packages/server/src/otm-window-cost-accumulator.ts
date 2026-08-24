// TRA-3974 (parent TRA-3945) — the WINDOW-SCOPED post-pin cost accumulator.
//
// ── The defect ──────────────────────────────────────────────────────────────
//
// The TRA-3945 pre-registration says the in-band contract-quality read comes off
// `/api/health/live-enforce-gates` → `byGate[cost_bar].byCell[...]`. Measured on
// bqb1 `3d0c3582` pid 73 on 2026-08-24T13:2xZ, that view cannot serve it:
//
//   1. NOT RESTRICTABLE. The route takes no query params. It publishes exactly
//      two views — the CURRENT ET day (which self-clears at ET midnight) and a
//      30-day rolling fold. On 08-24 the cell `single_leg_otm::0.50-0.55` read
//      `evaluated 2713 | blocked 0 | spreadR p50 0.356688`, and all 2713 rows
//      are PRE-pin. There is no `since` to ask for.
//   2. NOT RECOVERABLE BY DIFFERENCING. Counters subtract; QUANTILES DO NOT.
//      `costRQuantiles` is built from a retained sample list, so no sequence of
//      daily snapshots reconstructs a post-pin p50.
//   3. DOES NOT SURVIVE THE WINDOW. `RETAIN_MS` is 30 days. Baseline pace is 9
//      closes over 14 trading days, so 30 closes is ~47 trading days / ~9
//      calendar weeks. The FIRST HALF of the window ages out of the raw ledger
//      before the window closes.
//
// ── The shape of the fix ────────────────────────────────────────────────────
//
// A second accumulator that is post-pin BY CONSTRUCTION: it does not exist until
// the window stamps `startedAt`, it only ever accrues rows the ledger writes
// AFTER that instant, and it is persisted beside the window's own state file so
// it outlives the 30-day gate-ledger retention by not depending on it.
//
// Deliberately NOT solved by "snapshot the health route every day": a daily
// ritual that must be remembered is a ritual that will be missed once in nine
// weeks, and the miss is silent. There is no read-time restriction here and
// nothing to remember.
//
// ── Three properties worth stating, because each is a trap ──────────────────
//
//   • EXACT ON RESTART, not "best effort". The accumulator subscribes to the
//     ledger's `apply()`, which is called BOTH by the live write path AND by
//     `hydrateLiveEnforceGateFromDisk` replaying the JSONL at boot. So a crash
//     loses nothing — the replay carries it. But a replay would DOUBLE-COUNT
//     everything already persisted, so the cursor `(lastTs, lastTsCount)` is
//     persisted with the state and the replay is skipped up to it exactly. A
//     ts-only cursor is not enough: a burst can write several rows in one
//     millisecond, and dropping "everything at lastTs" silently under-counts.
//   • QUANTILES SURVIVE VOLUME. ~200 cost_bar evaluations/day over nine weeks is
//     ~12k rows, which must not live in a health payload or a state file. A
//     head-truncating cap (what the gate ledger does, with an honest
//     `samplesDropped`) would make the p50 a p50 OF THE WINDOW'S FIRST WEEKS. So
//     the sample list is a RESERVOIR (algorithm R), and its accept/replace draw
//     is a pure function of `(seed, sampleIndex)` via splitmix32 — no
//     `Math.random`, so a restart mid-window resumes the identical draw sequence
//     and the sample stays unbiased across it.
//   • THE CELL IS A SET, NOT A STRING. The window's frozen `populationCell` is a
//     `[min, max)` band; the ledger's `cell` stamp is a 0.05-wide bucket LABEL.
//     Under ruling option B those coincide (`[0.50,0.55)` ↔ `0.50-0.55`), but
//     under option A (`[0.25,0.40]`) the cell spans THREE buckets. The accepted
//     labels are therefore derived by asking `entryDeltaBucket` itself across
//     the band — the same function that produced the stamp — and published, so a
//     multi-bucket cell can never be silently narrowed to one.
//
// ⚠️ READ-ONLY. Nothing here gates, blocks, sizes or routes. It is a subscriber
// on a ledger that has already ruled. Every entry point is wrapped so that a
// failure inside this module can never propagate into a live order path.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { entryDeltaBucket } from './option-trade-journal.js';
import { canonicalTapeStructure, tapeExpectancyCellKey } from './option-tape-expectancy.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';
import { onLiveEnforceRecord, type LiveEnforceRecord } from './live-enforce-gate-ledger.js';

const log = logger.child({ module: 'otm-window-cost-accumulator' });

export const OTM_WINDOW_COST_ISSUE = 'TRA-3974';
/** Reservoir capacity. ~12k expected rows over the window; this holds a
 * representative 4k of them and says how many it replaced. */
export const OTM_WINDOW_COST_RESERVOIR_MAX = 4000;
/** Step used to walk the population band when deriving the accepted bucket set.
 * Half the narrowest catch-all edge granularity, so no 0.05-wide bucket the band
 * touches can be stepped over. */
const CELL_SCAN_STEP = 0.005;

/** One retained cost_bar decision. Mirrors the ledger's `cost` block plus the
 * identity the ledger's own `CostSample` does not keep. */
export interface OtmWindowCostSample {
  ts: number;
  cell: string;
  blocked: boolean;
  costR: number;
  spreadR: number;
  feeR: number;
  costFracOfPremium: number;
  grossR: number | null;
  book: string | null;
}

export interface OtmWindowCostRunning {
  n: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
}

function emptyRunning(): OtmWindowCostRunning {
  return { n: 0, sum: 0, sumSq: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
}

function push(r: OtmWindowCostRunning, x: number): void {
  r.n += 1;
  r.sum += x;
  r.sumSq += x * x;
  if (x < r.min) r.min = x;
  if (x > r.max) r.max = x;
}

export interface OtmWindowCostAccumulatorState {
  version: 1;
  windowId: string;
  /** The window pin. Rows at `ts < startedAt` are refused — post-pin by construction. */
  startedAt: number | null;
  /** When THIS accumulator armed. Later than `startedAt` iff the arm shipped after the pin. */
  armedAt: number | null;
  /** Ledger `cell` labels accepted, derived from the frozen population cell. */
  cellKeys: string[];
  /** The frozen band the labels came from, so a reader can re-derive them. */
  band: [number, number] | null;
  evaluated: number;
  blocked: number;
  spreadR: OtmWindowCostRunning;
  costR: OtmWindowCostRunning;
  feeR: OtmWindowCostRunning;
  costFracOfPremium: OtmWindowCostRunning;
  reservoir: OtmWindowCostSample[];
  /** Rows the reservoir accepted then evicted — the sampling is VISIBLE. */
  reservoirReplaced: number;
  firstTs: number | null;
  lastTs: number | null;
  /** How many accrued rows carried exactly `lastTs`. The replay cursor. */
  lastTsCount: number;
  refused: {
    notArmed: number;
    prePin: number;
    otherGate: number;
    otherCell: number;
    noCell: number;
    noCost: number;
    replayDuplicate: number;
  };
  persistedAt: number | null;
}

export function emptyOtmWindowCostAccumulatorState(windowId: string): OtmWindowCostAccumulatorState {
  return {
    version: 1,
    windowId,
    startedAt: null,
    armedAt: null,
    cellKeys: [],
    band: null,
    evaluated: 0,
    blocked: 0,
    spreadR: emptyRunning(),
    costR: emptyRunning(),
    feeR: emptyRunning(),
    costFracOfPremium: emptyRunning(),
    reservoir: [],
    reservoirReplaced: 0,
    firstTs: null,
    lastTs: null,
    lastTsCount: 0,
    refused: {
      notArmed: 0, prePin: 0, otherGate: 0, otherCell: 0, noCell: 0, noCost: 0, replayDuplicate: 0,
    },
    persistedAt: null,
  };
}

// ── The cell set ────────────────────────────────────────────────────────────

/**
 * The ledger `cell` labels a `[deltaAbsMin, deltaAbsMax)` population band
 * intersects, derived by asking {@link entryDeltaBucket} — the same function
 * that produced the stamp — rather than re-deriving the band arithmetic. If the
 * bucket definition ever moves, this moves with it instead of drifting silently.
 *
 * `unknown` is never accepted: a stamp with no measurable delta is not a member
 * of any cell, which is the same fail-closed reading the window's own
 * `entryDeltaUnknown` exclusion takes.
 */
export function resolveOtmWindowCostCellKeys(
  band: { deltaAbsMin: number; deltaAbsMax: number },
  structure: string = OTM_SLEEVE_MANDATE_STRUCTURE,
): string[] {
  const lo = band.deltaAbsMin;
  const hi = band.deltaAbsMax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
  const labels = new Set<string>();
  // Walk [lo, hi) inclusive of `lo`, exclusive of `hi` — the band's own
  // half-open convention. The final sample is nudged just inside `hi` so a band
  // ending exactly on a bucket edge does not pick up the bucket ABOVE it.
  for (let d = lo; d < hi; d = Math.min(d + CELL_SCAN_STEP, hi)) {
    const b = entryDeltaBucket(d);
    if (b !== 'unknown') labels.add(tapeExpectancyCellKey(structure, b));
    if (d === hi) break;
  }
  const last = entryDeltaBucket(hi - Math.min(CELL_SCAN_STEP, (hi - lo) / 2));
  if (last !== 'unknown') labels.add(tapeExpectancyCellKey(structure, last));
  return [...labels].sort();
}

// ── Deterministic reservoir ─────────────────────────────────────────────────

/** splitmix32 — a pure `uint32 -> [0,1)` draw. No global state, no Math.random,
 * so the sequence is identical across a restart. */
function draw(seed: number, index: number): number {
  let z = (seed ^ (index + 0x9e3779b9)) >>> 0;
  z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0);
  z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0);
  z = (z ^ (z >>> 15)) >>> 0;
  return z / 4294967296;
}

/**
 * Algorithm R, keyed on the sample INDEX rather than on a running PRNG, so the
 * accept/replace decision for sample `i` is the same whether it is seen in one
 * process or after five restarts.
 *
 * `index` is the 0-based ordinal of this sample within the window (i.e. the
 * value of `evaluated` BEFORE this row is counted).
 */
export function reservoirAdmit(
  seed: number,
  index: number,
  capacity: number,
): { admit: boolean; replaceAt: number } {
  if (index < capacity) return { admit: true, replaceAt: index };
  const j = Math.floor(draw(seed, index) * (index + 1));
  return j < capacity ? { admit: true, replaceAt: j } : { admit: false, replaceAt: -1 };
}

// ── Module state ────────────────────────────────────────────────────────────

let state: OtmWindowCostAccumulatorState | null = null;
let dirty = false;
let storeFileOverride: string | null = null;
let windowStateFileOverride: string | null = null;
let subscribed = false;
/**
 * How many rows carrying exactly `state.lastTs` are ALREADY folded into the
 * loaded state and must therefore be skipped if the boot replay offers them
 * again. Set from `lastTsCount` at load and consumed by the observer; NOT part
 * of the persisted shape (it is derived from it), and NOT reset by an ordinary
 * live append — a live row at a new `ts` leaves it at 0 for the rest of the run.
 */
let replayCursorPending = 0;

function storeFile(): string {
  // Beside the window's own `otm-evaluation-window.json`. "Alongside" is the
  // point: one directory, one lifetime, one backup.
  return storeFileOverride ?? join(resolveDataDir(), 'otm-evaluation-window-cost.json');
}

/**
 * The TRA-3945 window's own state file. Read SYNCHRONOUSLY, and only at boot —
 * `loadOtmEvaluationWindowState` is async and the boot prime has to happen
 * before `hydrateLiveEnforceGateFromDisk`, which has no await point.
 */
function windowStateFile(): string {
  return windowStateFileOverride ?? join(resolveDataDir(), 'otm-evaluation-window.json');
}

/** Test seam. Passing a path also DISCARDS the loaded state so each test starts clean. */
export function setOtmWindowCostAccumulatorFileForTests(
  path: string | null,
  windowStatePath: string | null = null,
): void {
  storeFileOverride = path;
  windowStateFileOverride = windowStatePath;
  state = null;
  dirty = false;
  replayCursorPending = 0;
}

/**
 * Synchronous load, because the first caller is the ledger's `apply()` — which
 * runs inside `hydrateLiveEnforceGateFromDisk` at boot, before any await point.
 * If the accumulator loaded lazily-async it would miss the entire boot replay
 * and then over-write the persisted state with the partial result.
 */
function ensureLoaded(windowId: string): OtmWindowCostAccumulatorState {
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<OtmWindowCostAccumulatorState>;
    if (parsed && parsed.version === 1 && typeof parsed.windowId === 'string') {
      state = { ...emptyOtmWindowCostAccumulatorState(parsed.windowId), ...parsed };
      // Everything at `lastTs` is already folded in; the boot replay must skip
      // exactly that many before it starts accruing again.
      replayCursorPending = state.lastTsCount;
      return state;
    }
    log.warn('TRA-3974 cost accumulator state unrecognised; starting empty', { file: storeFile() });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      log.warn('TRA-3974 cost accumulator state read failed; starting empty', {
        file: storeFile(), reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  state = emptyOtmWindowCostAccumulatorState(windowId);
  return state;
}

/**
 * Arm (or re-confirm) the accumulator against the window's frozen pin and cell.
 * Called from the window tick once — and only once — `startedAt` is stamped.
 *
 * The pin is WRITE-ONCE. A second arm carrying a DIFFERENT `startedAt` or cell
 * set is refused and logged rather than applied: silently re-keying would make
 * the accrued rows answer a different question than the one they were accrued
 * under, which is the exact class of defect this ticket is about.
 */
export function armOtmWindowCostAccumulator(args: {
  windowId: string;
  startedAt: number;
  band: { deltaAbsMin: number; deltaAbsMax: number };
  now?: number;
}): { armed: boolean; reason: string | null } {
  const s = ensureLoaded(args.windowId);
  const cellKeys = resolveOtmWindowCostCellKeys(args.band);
  if (cellKeys.length === 0) {
    return { armed: s.startedAt !== null, reason: 'population band resolves to no ledger cell label' };
  }
  if (s.startedAt === null) {
    s.startedAt = args.startedAt;
    s.armedAt = args.now ?? Date.now();
    s.cellKeys = cellKeys;
    s.band = [args.band.deltaAbsMin, args.band.deltaAbsMax];
    s.windowId = args.windowId;
    dirty = true;
    log.info('TRA-3974 post-pin cost accumulator ARMED', {
      windowId: args.windowId, startedAt: new Date(args.startedAt).toISOString(), cellKeys,
    });
    return { armed: true, reason: null };
  }
  const sameCells = s.cellKeys.length === cellKeys.length && s.cellKeys.every((k, i) => k === cellKeys[i]);
  if (s.startedAt !== args.startedAt || !sameCells) {
    log.error('TRA-3974 cost accumulator RE-ARM REFUSED (pin is write-once)', {
      heldStartedAt: s.startedAt, offeredStartedAt: args.startedAt,
      heldCellKeys: s.cellKeys, offeredCellKeys: cellKeys,
    });
    return { armed: true, reason: 'held pin differs from the offered pin; the HELD pin stands' };
  }
  return { armed: true, reason: null };
}

/**
 * The subscriber. Accrues one ledger decision, or refuses it under a NAMED
 * counter — every refusal is countable so the denominator is never invisible.
 */
export function observeLiveEnforceRecordForOtmWindow(rec: LiveEnforceRecord): void {
  const s = state;
  // Not armed yet — do NOT `ensureLoaded` here. Before the window stamps there
  // is nothing to accrue into, and touching disk on every gate decision in that
  // period would put file IO on the order path for no reading.
  if (!s || s.startedAt === null) {
    if (s) s.refused.notArmed += 1;
    return;
  }
  if (rec.gate !== 'cost_bar') { s.refused.otherGate += 1; return; }
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) { s.refused.prePin += 1; return; }
  if (rec.ts < s.startedAt) { s.refused.prePin += 1; return; }
  // Replay cursor. `apply()` is also the boot-hydrate path, so a row already
  // folded into the persisted state must be skipped EXACTLY, not approximately.
  if (s.lastTs !== null) {
    if (rec.ts < s.lastTs) { s.refused.replayDuplicate += 1; return; }
    if (rec.ts === s.lastTs && replayCursorPending > 0) {
      replayCursorPending -= 1;
      s.refused.replayDuplicate += 1;
      return;
    }
  }
  const cell = typeof rec.cell === 'string' ? rec.cell.trim() : '';
  if (cell === '') { s.refused.noCell += 1; return; }
  if (!s.cellKeys.includes(canonicalCell(cell))) { s.refused.otherCell += 1; return; }
  const cost = rec.cost;
  if (
    !cost
    || !Number.isFinite(cost.costR) || !Number.isFinite(cost.spreadR)
    || !Number.isFinite(cost.feeR) || !Number.isFinite(cost.costFracOfPremium)
  ) {
    // A cost_bar row in the cell with no usable cost is COUNTED as a coverage
    // hole, never skipped — a silently shorter sample list is how a gap reads
    // as a rate (the same discipline as `costRQuantiles.rowsMissingCostR`).
    s.refused.noCost += 1;
    bumpCursor(s, rec.ts);
    return;
  }

  const index = s.evaluated;
  const sample: OtmWindowCostSample = {
    ts: rec.ts,
    cell,
    blocked: rec.blocked === true,
    costR: cost.costR,
    spreadR: cost.spreadR,
    feeR: cost.feeR,
    costFracOfPremium: cost.costFracOfPremium,
    grossR: typeof rec.grossR === 'number' && Number.isFinite(rec.grossR) ? rec.grossR : null,
    book: typeof rec.book === 'string' && rec.book !== '' ? rec.book : null,
  };
  s.evaluated += 1;
  if (sample.blocked) s.blocked += 1;
  push(s.spreadR, sample.spreadR);
  push(s.costR, sample.costR);
  push(s.feeR, sample.feeR);
  push(s.costFracOfPremium, sample.costFracOfPremium);

  const seed = (s.startedAt ?? 0) >>> 0;
  const { admit, replaceAt } = reservoirAdmit(seed, index, OTM_WINDOW_COST_RESERVOIR_MAX);
  if (admit) {
    if (replaceAt < s.reservoir.length) {
      s.reservoir[replaceAt] = sample;
      s.reservoirReplaced += 1;
    } else {
      s.reservoir.push(sample);
    }
  }
  if (s.firstTs === null) s.firstTs = rec.ts;
  bumpCursor(s, rec.ts);
  dirty = true;
}

function bumpCursor(s: OtmWindowCostAccumulatorState, ts: number): void {
  if (s.lastTs === ts) s.lastTsCount += 1;
  else { s.lastTs = ts; s.lastTsCount = 1; }
  dirty = true;
}

/** `single_leg_otm::0.50-0.55` with the structure half canonicalised, so a
 * gate-side alias (`otm::…`) and a journal-side label fold to one key. */
function canonicalCell(cell: string): string {
  const i = cell.indexOf('::');
  if (i < 0) return cell;
  return tapeExpectancyCellKey(canonicalTapeStructure(cell.slice(0, i)), cell.slice(i + 2));
}

/** Persist. Atomic (tmp + rename), synchronous — it is called from a tick and
 * from a health read, both of which want the write to have HAPPENED. */
export function flushOtmWindowCostAccumulator(now: number = Date.now()): boolean {
  const s = state;
  if (!s || !dirty) return false;
  try {
    const file = storeFile();
    mkdirSync(dirname(file), { recursive: true });
    s.persistedAt = now;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    renameSync(tmp, file);
    dirty = false;
    return true;
  } catch (err) {
    log.warn('TRA-3974 cost accumulator persist failed (in-memory state kept)', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Subscribe to the ledger. Idempotent; safe to call from module init. */
export function ensureOtmWindowCostSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onLiveEnforceRecord((rec) => {
    try {
      observeLiveEnforceRecordForOtmWindow(rec);
    } catch (err) {
      log.warn('TRA-3974 cost accumulator observer threw (swallowed)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Test seam — read the live state without going through the record builder. */
export function peekOtmWindowCostAccumulatorState(): OtmWindowCostAccumulatorState | null {
  return state;
}

/**
 * Prime the module from disk WITHOUT waiting for the first observation. Called
 * at boot before `hydrateLiveEnforceGateFromDisk`, so the replay cursor is in
 * place before the replay starts.
 */
export function loadOtmWindowCostAccumulator(windowId: string): OtmWindowCostAccumulatorState {
  const fresh = state === null;
  const s = ensureLoaded(windowId);
  if (fresh) replayCursorPending = s.lastTsCount;
  return s;
}

/**
 * Boot prime — load, and if this accumulator has never armed, arm it from the
 * TRA-3945 window's OWN persisted state.
 *
 * This is what makes the ARM LAG partially recoverable rather than a permanent
 * hole. The window opened on 2026-08-23T01:40:43Z; this accumulator ships days
 * later. Arming only on the window tick would mean the boot replay of the gate
 * ledger's JSONL — which still holds every retained post-pin row — is refused
 * wholesale under `notArmed`, and those rows are then gone for good once the
 * 30-day retention rolls past them. Arming HERE, before
 * `hydrateLiveEnforceGateFromDisk` runs, recovers exactly the part of the lag
 * the ledger still holds.
 *
 * What it CANNOT recover is any post-pin row already aged out of that 30-day
 * retention. `armLagMs` on the published record is what says how much lag there
 * was; `firstTs` is what says how far back the recovery actually reached. Read
 * them together — neither alone answers it.
 */
export function primeOtmWindowCostAccumulatorFromWindowState(
  windowId: string,
): { armed: boolean; reason: string | null } {
  const s = loadOtmWindowCostAccumulator(windowId);
  if (s.startedAt !== null) return { armed: true, reason: 'already armed from its own persisted state' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(windowStateFile(), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      armed: false,
      reason: code === 'ENOENT'
        ? 'no TRA-3945 window state on disk yet — the window has never opened on this box'
        : `TRA-3945 window state unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const w = parsed as {
    version?: number; windowId?: string; startedAt?: number | null;
    populationCell?: { deltaAbsMin?: number; deltaAbsMax?: number; frozen?: boolean } | null;
  } | null;
  if (!w || w.version !== 1 || typeof w.startedAt !== 'number' || !Number.isFinite(w.startedAt)) {
    return { armed: false, reason: 'TRA-3945 window state present but the window has not stamped `startedAt`' };
  }
  const cell = w.populationCell;
  // `frozen` is required, not optional: a PREVIEW cell can still move, and
  // arming on one would key the accumulator to a band the window later changes.
  if (!cell || cell.frozen !== true
    || typeof cell.deltaAbsMin !== 'number' || typeof cell.deltaAbsMax !== 'number') {
    return { armed: false, reason: 'TRA-3945 window state has no FROZEN populationCell to key the cell set from' };
  }
  const r = armOtmWindowCostAccumulator({
    windowId: typeof w.windowId === 'string' && w.windowId !== '' ? w.windowId : windowId,
    startedAt: w.startedAt,
    band: { deltaAbsMin: cell.deltaAbsMin, deltaAbsMax: cell.deltaAbsMax },
  });
  if (r.armed) {
    log.info('TRA-3974 cost accumulator primed from the TRA-3945 window state at boot', {
      startedAt: new Date(w.startedAt).toISOString(),
      note: 'the ledger replay that follows recovers the post-pin rows still inside its 30-day retention',
    });
  }
  return r;
}

// ── The published record ────────────────────────────────────────────────────

function mean(r: OtmWindowCostRunning): number | null {
  return r.n === 0 ? null : round6(r.sum / r.n);
}

function sd(r: OtmWindowCostRunning): number | null {
  if (r.n < 2) return null;
  const m = r.sum / r.n;
  const v = Math.max(0, r.sumSq / r.n - m * m) * (r.n / (r.n - 1));
  return round6(Math.sqrt(v));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function q(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return round6(sorted[0]!);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return round6(sorted[lo]!);
  return round6(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

function quantiles(values: readonly number[]) {
  const xs = values.slice().sort((a, b) => a - b);
  return {
    n: xs.length,
    p10: q(xs, 0.1), p25: q(xs, 0.25), p50: q(xs, 0.5), p75: q(xs, 0.75), p90: q(xs, 0.9),
  };
}

export function buildOtmWindowCostAccumulatorRecord(
  s: OtmWindowCostAccumulatorState | null,
  now: number = Date.now(),
) {
  if (!s || s.startedAt === null) {
    return {
      issue: OTM_WINDOW_COST_ISSUE,
      readOnly: true as const,
      armed: false as const,
      startedAt: null,
      cellKeys: [] as string[],
      evaluated: 0,
      blocked: 0,
      note:
        'NOT ARMED - the TRA-3945 window has not stamped `startedAt`, so there is no post-pin population to accrue and nothing has been counted. This is the ARMED resting state, not a fault. It arms in the same tick the window opens.',
    };
  }
  const spreads = s.reservoir.map((x) => x.spreadR);
  const costs = s.reservoir.map((x) => x.costR);
  const sampled = s.reservoir.length;
  return {
    issue: OTM_WINDOW_COST_ISSUE,
    readOnly: true as const,
    armed: true as const,
    windowId: s.windowId,
    startedAt: new Date(s.startedAt).toISOString(),
    armedAt: s.armedAt === null ? null : new Date(s.armedAt).toISOString(),
    /**
     * How long after the window's pin this accumulator armed. Non-zero on any
     * build that shipped after the window opened.
     *
     * ⚠️ It is NOT the size of the hole. The boot prime arms BEFORE the gate
     * ledger's JSONL replays, so the lag is recovered as far back as that
     * ledger's own 30-day retention still reaches. `armLagMs` is how much lag
     * there was; `firstTs` is how far back the recovery actually got. Read them
     * together — `armLagMs` alone OVERSTATES the loss, and `firstTs` alone does
     * not reveal there was a lag at all.
     */
    armLagMs: s.armedAt === null ? null : Math.max(0, s.armedAt - s.startedAt),
    /** ms of the arm lag NOT covered by the recovery, or `null` when nothing has
     * accrued yet (which is not the same as "nothing was lost"). */
    armLagUnrecoveredMs:
      s.armedAt === null || s.firstTs === null
        ? null
        : Math.max(0, Math.min(s.firstTs, s.armedAt) - s.startedAt),
    cellKeys: s.cellKeys,
    band: s.band,
    postPinByConstruction: true as const,
    evaluated: s.evaluated,
    blocked: s.blocked,
    blockRate: s.evaluated === 0 ? null : round6(s.blocked / s.evaluated),
    firstTs: s.firstTs === null ? null : new Date(s.firstTs).toISOString(),
    lastTs: s.lastTs === null ? null : new Date(s.lastTs).toISOString(),
    persistedAt: s.persistedAt === null ? null : new Date(s.persistedAt).toISOString(),
    ageMs: s.firstTs === null ? null : now - s.firstTs,
    /** EXACT over every accrued row, at any volume — these never sample. */
    exact: {
      spreadR: { n: s.spreadR.n, mean: mean(s.spreadR), sd: sd(s.spreadR), min: s.spreadR.n ? round6(s.spreadR.min) : null, max: s.spreadR.n ? round6(s.spreadR.max) : null },
      costR: { n: s.costR.n, mean: mean(s.costR), sd: sd(s.costR), min: s.costR.n ? round6(s.costR.min) : null, max: s.costR.n ? round6(s.costR.max) : null },
      feeR: { n: s.feeR.n, mean: mean(s.feeR) },
      costFracOfPremium: { n: s.costFracOfPremium.n, mean: mean(s.costFracOfPremium) },
    },
    /** Quantiles over the RESERVOIR — representative of the whole window, not of
     * its first weeks. `sampled` < `evaluated` means sampling is in effect. */
    quantiles: {
      sampled,
      capacity: OTM_WINDOW_COST_RESERVOIR_MAX,
      replaced: s.reservoirReplaced,
      sampling: s.evaluated > OTM_WINDOW_COST_RESERVOIR_MAX,
      spreadR: quantiles(spreads),
      costR: quantiles(costs),
    },
    refused: s.refused,
    note:
      s.evaluated === 0
        ? `ARMED at ${new Date(s.startedAt).toISOString()} on cell(s) ${s.cellKeys.join(', ')}, ZERO post-pin cost_bar rows accrued so far. Zero here is a real reading (the gate has not evaluated a candidate in this cell since the pin), NOT an absence of instrument - refused counters are published beside it: ${JSON.stringify(s.refused)}.`
        : `${s.evaluated} post-pin cost_bar row(s) in cell(s) ${s.cellKeys.join(', ')}, ${s.blocked} blocked. Post-pin BY CONSTRUCTION: nothing before ${new Date(s.startedAt).toISOString()} can enter, so no read-time restriction is needed and none is offered. Survives the gate ledger's 30-day RETAIN_MS because it does not read from it. Quantiles are over a ${sampled}-row deterministic reservoir (${s.reservoirReplaced} replaced) - representative of the WHOLE window, unlike a head-truncated cap.`,
  };
}

export type OtmWindowCostAccumulatorRecord = ReturnType<typeof buildOtmWindowCostAccumulatorRecord>;
