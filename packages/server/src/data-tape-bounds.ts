// TRA-4903 — a finite bound on each of the 27 append-only `/data` tapes that had
// none, and therefore reserved the whole volume.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It is not a retention policy, and that is a deliberate ruling, not a shortcut.
// TRA-4903 AC2 says "prefer TIME over bytes where a consumer reasons in calendar
// time". Walking all 27 write paths to convert the census's `?` rows (AC1) turned
// up four ways a time prune applied from a central manifest silently corrupts the
// thing it retains. Each was MEASURED in this repo, not hypothesised:
//
//  1. **It splits a supersede pair, and the bias is not random.** Nine of these
//     tapes are folded by `id` with a later line superseding an earlier one
//     (`shadow-signal-ledger.ts:21` — "reads fold by `id` keeping the latest
//     line"). The superseding line is a different SHAPE: `ResolveLine` is
//     `{ kind:'resolve', id, res, resolvedAt }` and carries **no `ts` at all**
//     (`shadow-signal-ledger.ts:105`). A line-wise cutoff therefore ages an OPEN
//     row out from under a resolve line that is still on disk, and because slow
//     resolutions are the ones whose OPEN is oldest, **the survivors are biased
//     toward FAST resolutions** — it skews the outcome distribution the learner
//     exists to read, in the direction that flatters it. The AC2 template avoids
//     this only because it was written to: `reversal-shadow-ledger.ts:211` keys
//     the cutoff on the signal time "never on `resolvedAt`", and `:239` keeps a
//     resolve line "iff its open was". That is per-tape knowledge of the id field
//     and the line kinds. A manifest does not have it.
//  2. **It makes a RATIFIED bar unreachable.** `pcr-shadow-signals.jsonl` feeds a
//     promotion gate needing `PCR_PROMOTION_MIN_Z_SESSIONS = 20` trailing
//     SESSIONS on top of a 20-session z-window, and the TRA-1664 read is ratified
//     at N >= 90 SESSIONS ~ 126 calendar days. A 30-day horizon caps it near 21
//     sessions, so the gate could never pass. This is not a new failure mode: it
//     is exactly the defect `live-options-fee-slippage-ledger.ts:62-77` records
//     against TRA-4607, where every boot shrank the store, `fillsSeen` fell
//     41 -> 31, and a close read `noMatchingOpen` — "an exclusion MANUFACTURED BY
//     RETENTION".
//  3. **It drops pending work.** `hypothesis-queue.jsonl` is a log-structured
//     QUEUE, not a tape: `{kind:'enqueue'}` then a later decision line, folded by
//     id, where "a decision with no enqueue is ignored"
//     (`hypothesis-pipeline.ts:399`). An item may sit `queued` indefinitely
//     awaiting ratification, so age does not imply irrelevance, and dropping an
//     old enqueue deletes the item rather than ageing it.
//  4. **It rewrites a money total.** `paper-trading.jsonl` is replayed through
//     `foldRowIntoBook` to rebuild the book. Its rows are not independent
//     observations; they are the increments of a cumulative balance. Dropping the
//     oldest changes today's number.
//
// A byte ceiling has none of these properties, because it needs to know nothing
// about record shape, id folds, line kinds, or a consumer's lookback. So the
// 27-wide bound is byte-denominated, and per-tape time retention is a deliberate
// per-tape exercise against that tape's own consumer — the shape TRA-4883 used on
// `reversal-shadow-signals.jsonl`, one ticket per tape. Filed as the residual.
//
// ── THE POLICY: `seal`, NOT `truncate` ──────────────────────────────────────
// At the ceiling this REFUSES THE APPEND and raises a loud breach. It never drops
// a row. The direction matters and it is the whole argument:
//
//   * Truncating the oldest rows destroys PAST evidence. On these 27 that is
//     largely non-re-derivable — `tra3939-order-provenance-capture.ts:151` says
//     retention is "none ... evidence that expires at the source (the broker
//     serves ONE trading day of orders)", `tra3932-open-leg-provenance.ts:113`
//     says "none — verdicts are not re-derivable", and `option-trade-journal`
//     holds the pre-onset history a money gate keys on
//     (`pnl-reconciliation.ts:256`: "DURABLE history and does not age out").
//   * Refusing the append loses a FUTURE row, loudly, on a tape that is either
//     observe-only or whose next write re-observes the same live state.
//
// Losing a future row to a loud breach is recoverable. Losing a past verdict to a
// silent prune is not. Every existing `/data` compactor here truncates, which is
// right for a measurement tape and wrong for an evidence tape, and nothing in the
// repo drew that line before — which is how 27 files ended up with no bound at
// all rather than the wrong one.
//
// ── WHY A CEILING IS A BOUND AND `NONE` IS NOT ──────────────────────────────
// The census (`scripts/tra4899-tape-census.mjs`) ranks by worst-case bytes and
// scores an uncapped append-only file at THE WHOLE VOLUME, because that is what
// it reserves. It is ranked above every finite reservation on the box regardless
// of today's size, and today's size is a bad guide: **10 of these 27 do not exist
// on the money host at all** (measured on bqb1 2026-09-25T03:5xZ, build
// `a158c516`) yet each reserves the full 973 MiB the instant its flag flips on.
//
// ── BOOT OVERSHOOT (AC4): THERE ISN'T ONE ───────────────────────────────────
// Every existing `/data` compactor runs on boot only, so it reserves
// `cap + rate x maxBootInterval` — `docs/tra4899-data-tape-budget.md` AC4 measures
// the boot interval at 4.93 d and otm-admission-tape's true reservation at
// `151.0 + ~22` MB against a 144 MiB cap. **A seal has no such premium.** The
// ceiling is enforced at every append, not at boot, so the reservation is the
// ceiling, full stop. The boot pass below only seeds the size cache; it changes
// no file. That is the one respect in which this is strictly tighter than the
// pattern it replaces, and it is a consequence of refusing rather than
// truncating: a refusal can be checked in O(1) on the write path, a
// truncate-oldest cannot.

import { appendFile } from 'fs/promises';
import { appendFileSync, statSync } from 'fs';
import { basename } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'data-tape-bounds' });

const MiB = 1024 * 1024;

/**
 * Ceilings, keyed by the tape's basename so a caller passes the path it already
 * has and the manifest is greppable against the census.
 *
 * ── HOW THESE WERE SIZED ────────────────────────────────────────────────────
 * A seal ceiling is a TRIPWIRE ABOVE THE TRAJECTORY, not a budget allocation.
 * Its failure mode is "the tape stops recording", so a ceiling a healthy tape
 * sits near is worse than no ceiling at all — it converts growth into silent
 * data loss on a live surface. Every one is therefore set well above the size
 * measured on bqb1 2026-09-25T03:5xZ (build `a158c516`, `/api/health/storage/detail`),
 * with the fill fraction published on {@link dataTapeBoundsReport} so growth is
 * visible for months before a breach can happen.
 *
 * The aggregate: **248 MiB across all 27** (25.5% of the 973.4 MiB volume), versus
 * today's actual 17.87 MiB across the 17 that exist, so **7.2% subscribed**.
 * Compare the reservation this REPLACES: 27 uncapped files, each bounded by the
 * volume and nothing else. It is also worth stating plainly that 248 MiB is above
 * `otm-admission-tape`'s 144 MiB and above the 64 MiB the whole 68-book close
 * ledger shares — a ceiling is not free, and the honest comparison is against the
 * unbounded class it leaves, not against zero.
 *
 * `observedBytes` is what the census read that beat. It is recorded so the next
 * person to touch a ceiling can see what it was sized against instead of
 * re-deriving it, and `null` means the file did not exist on the money host —
 * those are sized off the record's role, never off "0 bytes today".
 */
export interface TapeBound {
  /** Byte ceiling. Appends are refused at or above it. */
  maxBytes: number;
  /** Size on bqb1 2026-09-25, or `null` when the tape did not exist there. */
  observedBytes: number | null;
  /** Why this ceiling and not a smaller one. */
  note: string;
}

export const DATA_TAPE_BOUNDS: Readonly<Record<string, TapeBound>> = {
  // ── 32 MiB — the three largest, all with a non-re-derivable or money reader ──
  'shadow-signals.jsonl': { maxBytes: 32 * MiB, observedBytes: 7_981_975,
    note: 'largest of the 27; supersede-fold (hazard 1) so no central prune. 23.8% subscribed.' },
  'paper-trading.jsonl': { maxBytes: 32 * MiB, observedBytes: 6_526_222,
    note: 'cumulative book fold (hazard 4) — a prune would rewrite today\'s balance. 19.4%.' },
  'option-trade-journal.jsonl': { maxBytes: 32 * MiB, observedBytes: 2_928_311,
    note: 'the only surviving source for the TRA-2919 pre-onset money axis; never age out.' },

  // ── 16 MiB — the ratified-lookback tape ─────────────────────────────────────
  'pcr-shadow-signals.jsonl': { maxBytes: 16 * MiB, observedBytes: null,
    note: 'TRA-1664 ratifies N>=90 SESSIONS (~126 d) — the one tape where the CEILING could '
      + 'itself manufacture the TRA-4607 exclusion, so it is sized 2x its band. Absent on bqb1.' },

  // ── 8 MiB — present-and-growing, or high-rate when their flag is on ─────────
  'option-maker-shadow.jsonl': { maxBytes: 8 * MiB, observedBytes: 359_880, note: '4.3% subscribed.' },
  'news-catalyst-runs.jsonl': { maxBytes: 8 * MiB, observedBytes: 497_931, note: '5.9% subscribed.' },
  'news-catalyst-signals.jsonl': { maxBytes: 8 * MiB, observedBytes: 227_083, note: '2.7% subscribed.' },
  'tra3939-engine-submitted-orders.jsonl': { maxBytes: 8 * MiB, observedBytes: 77_202,
    note: 'ORDER_PROVENANCE_RETENTION is explicitly "none — evidence expires at the source".' },
  'tra4476-order-intents.jsonl': { maxBytes: 8 * MiB, observedBytes: 38_848, note: 'order intents; evidence.' },
  'option-shadow-signals.jsonl': { maxBytes: 8 * MiB, observedBytes: 8_139,
    note: 'session-window consumer (TRA-1610/1664) — sized for the lookback, not for today.' },
  'live-options-fill-archive.jsonl': { maxBytes: 8 * MiB, observedBytes: 7_635,
    note: 'TRA-4727 overflow archive. NOTE: it bounded the 30 d ledger by moving aged rows HERE, '
      + 'onto the same volume, so the reservation moved rather than shrank. This is its bound.' },
  'pcs-shadow-signals.jsonl': { maxBytes: 8 * MiB, observedBytes: null, note: 'absent on bqb1; sized as its PCR sibling\'s band.' },
  'oi-shadow-signals.jsonl': { maxBytes: 8 * MiB, observedBytes: null, note: 'absent on bqb1; TRA-1610 overlay, session-window read.' },
  'pre-trade-gate-decisions.jsonl': { maxBytes: 8 * MiB, observedBytes: null,
    note: 'absent on bqb1, but one row PER GATE DECISION — the highest potential rate of the 27.' },
  'pre-trade-liquidity-decisions.jsonl': { maxBytes: 8 * MiB, observedBytes: null,
    note: 'absent on bqb1; per-decision, same rate class as its gate sibling.' },

  // ── 4 MiB — small, low-rate, or absent with a bounded subject set ───────────
  'tra3939-broker-order-capture.jsonl': { maxBytes: 4 * MiB, observedBytes: 23_460, note: 'evidence; expires at the broker.' },
  'tra3932-open-leg-provenance.jsonl': { maxBytes: 4 * MiB, observedBytes: 23_080,
    note: 'OPEN_LEG_PROVENANCE_RETENTION "none — verdicts are not re-derivable"; fixed 11-contract subject set.' },
  'news-catalyst-lean.jsonl': { maxBytes: 4 * MiB, observedBytes: 20_678, note: '0.5% subscribed.' },
  'engine-basis-restatements.jsonl': { maxBytes: 4 * MiB, observedBytes: 14_967, note: 'a restatement is a historical fact; never age out.' },
  'directional-exploration-allowance.jsonl': { maxBytes: 4 * MiB, observedBytes: 5_727, note: '0.1% subscribed.' },
  'tra3926-judged-oversold.jsonl': { maxBytes: 4 * MiB, observedBytes: 1_061, note: 'judged verdicts over a bounded population.' },
  'live-option-reconcile-terminations.jsonl': { maxBytes: 4 * MiB, observedBytes: 213, note: 'smallest present tape of the 27.' },
  'orb-options-shadow-signals.jsonl': { maxBytes: 4 * MiB, observedBytes: null, note: 'absent on bqb1; one row per ORB setup per session.' },
  'option-real-fill-shadow.jsonl': { maxBytes: 4 * MiB, observedBytes: null, note: 'absent on bqb1; one row per real fill.' },
  'option-maker-fills.jsonl': { maxBytes: 4 * MiB, observedBytes: null, note: 'absent on bqb1; one row per maker fill.' },
  'live-canary-state.jsonl': { maxBytes: 4 * MiB, observedBytes: null, note: 'absent on bqb1; canary transitions, audit trail.' },
  'hypothesis-queue.jsonl': { maxBytes: 4 * MiB, observedBytes: null,
    note: 'absent on bqb1. A QUEUE, not a tape (hazard 3) — an old enqueue is PENDING WORK, not stale data.' },
};

/** Sum of every ceiling. Asserted by the census so the budget cannot drift unstated. */
export const DATA_TAPE_BOUNDS_TOTAL_BYTES = Object.values(DATA_TAPE_BOUNDS)
  .reduce((n, b) => n + b.maxBytes, 0);

/** How many tapes this module bounds. The census asserts it equals its own `sealed` row count. */
export const DATA_TAPE_BOUNDS_COUNT = Object.keys(DATA_TAPE_BOUNDS).length;

/** Live state for one sealed tape. */
interface TapeState {
  /** Bytes on disk. Seeded by a `stat` on first touch, then maintained by adding what we write. */
  bytes: number;
  /** Appends refused because the tape is at its ceiling. */
  refused: number;
  /** Bytes those refused appends would have written. */
  refusedBytes: number;
  /** ISO time of the first refusal, or null. */
  breachedAt: string | null;
  /** True once the breach has been logged, so a saturated tape logs once and not per row. */
  breachLogged: boolean;
}

const state = new Map<string, TapeState>();

function bound(path: string): { name: string; bound: TapeBound } | null {
  const name = basename(path);
  const b = DATA_TAPE_BOUNDS[name];
  return b === undefined ? null : { name, bound: b };
}

/**
 * Size on disk, seeded lazily.
 *
 * It is maintained in-process rather than `stat`ed per append on purpose. These
 * stores are module-global singletons — one writer per process — so
 * `seeded + written` is exact for the process that owns the file, and the
 * alternative is a syscall on every row of a tape that can take one row per gate
 * decision. A missing file seeds 0, which is correct: the append creates it.
 *
 * The in-process count is only ever a FLOOR if something outside this process
 * also appends, so the ceiling would be enforced late rather than not at all.
 * Nothing does today (TRA-4903 walked all 27 write paths and every one is a
 * single module-global writer), and a late enforcement is the safe direction.
 */
function seed(name: string, path: string): TapeState {
  const existing = state.get(name);
  if (existing !== undefined) return existing;
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    bytes = 0; // absent — the append creates it
  }
  const fresh: TapeState = { bytes, refused: 0, refusedBytes: 0, breachedAt: null, breachLogged: false };
  state.set(name, fresh);
  return fresh;
}

/**
 * Decide whether `line` fits under the ceiling, and account for it if it does.
 *
 * Returns the byte length to write, or `null` to refuse. The accounting happens
 * HERE rather than after a successful write so the sync and async callers share
 * one implementation; a write that then throws leaves the counter high, which
 * again enforces early rather than not at all.
 */
function admit(path: string, line: string): number | null {
  const hit = bound(path);
  if (hit === null) return Buffer.byteLength(line, 'utf8'); // not a sealed tape — pass through
  const st = seed(hit.name, path);
  const len = Buffer.byteLength(line, 'utf8');
  if (st.bytes + len > hit.bound.maxBytes) {
    st.refused += 1;
    st.refusedBytes += len;
    if (st.breachedAt === null) st.breachedAt = new Date().toISOString();
    if (!st.breachLogged) {
      st.breachLogged = true;
      log.error(
        'TRA-4903 SEAL BREACHED — tape is at its byte ceiling and is NO LONGER RECORDING. '
        + 'This is a loud refusal, not a silent truncation: nothing on disk was destroyed. '
        + 'Raise the ceiling in data-tape-bounds.ts, or give this tape a per-tape time '
        + 'retention against its own consumer (the TRA-4883 shape).',
        { tape: hit.name, maxBytes: hit.bound.maxBytes, bytes: st.bytes, refusedLineBytes: len },
      );
    }
    return null;
  }
  st.bytes += len;
  return len;
}

/**
 * Append one JSONL line to a `/data` tape, under its TRA-4903 ceiling.
 *
 * Drop-in for `appendFile(path, line, 'utf-8')`. A path that is not in
 * {@link DATA_TAPE_BOUNDS} passes straight through, so this is safe to route any
 * tape through and a tape whose ceiling has not been decided yet is not silently
 * bounded at some default.
 *
 * @returns true if written, false if refused at the ceiling.
 */
export async function appendBoundedTapeLine(path: string, line: string): Promise<boolean> {
  if (admit(path, line) === null) return false;
  await appendFile(path, line, 'utf-8');
  return true;
}

/** Synchronous twin of {@link appendBoundedTapeLine}, for the `appendFileSync` writers. */
export function appendBoundedTapeLineSync(path: string, line: string): boolean {
  if (admit(path, line) === null) return false;
  appendFileSync(path, line, 'utf8');
  return true;
}

/** One tape's line in {@link dataTapeBoundsReport}. */
export interface TapeBoundStatus {
  tape: string;
  maxBytes: number;
  /** Bytes this process believes are on disk, or null if the tape has not been touched this boot. */
  bytes: number | null;
  /** `bytes / maxBytes` as a percentage, rounded to 2 dp. Null when untouched. */
  fillPct: number | null;
  /** True once an append has been refused. */
  breached: boolean;
  breachedAt: string | null;
  refusedAppends: number;
  refusedBytes: number;
  observedBytes: number | null;
  note: string;
}

/** What {@link dataTapeBoundsReport} publishes on `/api/health/storage/detail`. */
export interface DataTapeBoundsReport {
  /** Tapes this module bounds. */
  count: number;
  /** Sum of every ceiling, bytes. */
  totalMaxBytes: number;
  /** Tapes that have refused at least one append. Non-zero is an alert, not a stat. */
  breachedCount: number;
  /** Tapes an append has been attempted on this boot. */
  touchedCount: number;
  tapes: TapeBoundStatus[];
}

/**
 * The health surface. A ceiling that ships without a working enforcement path
 * reads identically to one that works, which is why the OUTCOME is published and
 * not the constants alone — the AC5 lesson from `reversal-shadow-ledger.ts:84`.
 *
 * `bytes: null` means no append has been attempted through this module for that
 * tape since boot. On a tape that is absent on the host and whose flag is off,
 * that is the correct standing read, and it is NOT the same as 0.
 */
export function dataTapeBoundsReport(): DataTapeBoundsReport {
  const tapes: TapeBoundStatus[] = Object.entries(DATA_TAPE_BOUNDS).map(([tape, b]) => {
    const st = state.get(tape);
    return {
      tape,
      maxBytes: b.maxBytes,
      bytes: st?.bytes ?? null,
      fillPct: st === undefined ? null : Math.round((st.bytes / b.maxBytes) * 10_000) / 100,
      breached: (st?.refused ?? 0) > 0,
      breachedAt: st?.breachedAt ?? null,
      refusedAppends: st?.refused ?? 0,
      refusedBytes: st?.refusedBytes ?? 0,
      observedBytes: b.observedBytes,
      note: b.note,
    };
  }).sort((a, b) => (b.fillPct ?? -1) - (a.fillPct ?? -1));
  return {
    count: DATA_TAPE_BOUNDS_COUNT,
    totalMaxBytes: DATA_TAPE_BOUNDS_TOTAL_BYTES,
    breachedCount: tapes.filter((t) => t.breached).length,
    touchedCount: tapes.filter((t) => t.bytes !== null).length,
    tapes,
  };
}

/**
 * Seed the size cache for every sealed tape that already exists, at boot.
 *
 * Changes no file — a seal never rewrites. Without this the first append of the
 * boot seeds the same value anyway; running it up front means
 * {@link dataTapeBoundsReport} is populated for a grader before any tape has been
 * written, so "is this enforcement wired in at all?" is answerable on a quiet box.
 * That is the hole the TRA-3514 zero fell into: a layer that is off publishes the
 * same reading as a layer that is on and found nothing.
 */
export function seedDataTapeBounds(dataDir: string): { seeded: number; existing: number } {
  let existing = 0;
  for (const name of Object.keys(DATA_TAPE_BOUNDS)) {
    const st = seed(name, `${dataDir}/${name}`);
    if (st.bytes > 0) existing += 1;
  }
  return { seeded: DATA_TAPE_BOUNDS_COUNT, existing };
}

/** Test seam — forget every cached size and refusal count. */
export function resetDataTapeBoundsForTests(): void {
  state.clear();
}
