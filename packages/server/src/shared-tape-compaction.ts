// TRA-5038 — ONE periodic compaction hook, shared by every tape that needs one.
//
// ── WHY SHARED AND NOT FOUR COPIES ──────────────────────────────────────────
// TRA-4904 put `cost-aware-gate.jsonl` on a 6h timer and ruled the other boot-only
// tapes did not need one, naming the readings that would flip the answer. Two of
// them flipped inside seven days (TRA-5038), so three more 30-day tapes and one
// byte-capped tape now need the same hook.
//
// The thing that made TRA-4904's hook GRADEABLE was not the timer, it was
// `compaction.hookState`: a `RETAIN_MS` that ships without a working hook reads
// identically to one that works, on every other field. A fourth hand-rolled copy of
// that enum is a fourth chance to ship a retention whose hook was never armed and
// whose payload reads healthy anyway. So the enum, the arm instant, the append
// interlock and the rewrite live here ONCE, and each tape contributes only the two
// things that are genuinely per-tape: where its file is, and what its predicate is.
//
// ── THE PREDICATE IS PER TAPE, NOT A CUTOFF (TRA-5038 AC2) ──────────────────
// Three of the four registered tapes retain by AGE. `otm-admission-tape.jsonl`
// retains by a BYTE CAP — a 144 MiB ceiling, not a time horizon — and it is the one
// whose reservation dominated the whole census (TRA-4899). A hook that assumed a
// cutoff would either skip it or, worse, apply some invented age to it. The
// predicate is therefore a tagged union resolved per pass; see
// {@link TapeRetentionPredicate}.
//
// ── WHY THIS DOES NOT COPY THE PROTOTYPE'S WHOLE-FILE READ ──────────────────
// `compactCostAwareGateLedgerNow` does `readFile(path, 'utf8')` and holds the entire
// tape as one string. That was affordable for one 80 MiB file. It is NOT affordable
// here: the four tapes registered by TRA-5038 are 94.7 + 67.7 + 44.3 + 56.1 = 263 MiB
// on disk, and a JS string is UTF-16 — a 94 MiB ASCII tape is ~188 MiB of heap. Four
// of those in one pass, four times a day, on the box TRA-4158 just cut 330 MB of RSS
// out of and which has 141.7 MiB of DISK headroom, is a memory incident shipped to fix
// a disk problem.
//
// So the scan here is CHUNKED and the rewrite is STREAMED: memory is O(chunk), never
// O(file), and the only bytes read are the ones about to be dropped plus one chunk.
// Work stays O(dropped) exactly as the prototype intended — it just no longer pays
// O(file) in RAM to get there.
//
// ⚠ CONSEQUENCE, DELIBERATE: this module does NOT publish `linesBefore`/`linesAfter`.
// Those two fields cannot be computed without reading every retained byte, which is
// the whole cost just removed. `linesDropped` and `bytesDropped` ARE exact (the
// dropped prefix is walked), and `bytesBefore`/`bytesAfter` come off `stat`. Do not
// "complete" the payload by adding a full-file line count back — that reintroduces a
// 263 MiB read per pass to populate two fields no acceptance criterion asks for.
//
// ── WHY A PREFIX DROP IS SAFE ───────────────────────────────────────────────
// Both predicates drop a maximal CONTIGUOUS PREFIX and keep the remaining bytes
// verbatim. Records are appended in order, so that prefix is the aged (or
// over-cap) window in every normal file, and the rule is safe in the one case it is
// not: an out-of-order old row hiding behind a young one is simply kept. The failure
// direction is what matters — dropping a row still inside the window would delete
// live evidence from a tape a ceiling tripwire reads, while keeping one row too long
// costs bytes. This scan cannot do the former. Keeping the retained bytes verbatim
// also means no field can be erased by the rewrite (TRA-1703).
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It does not touch any in-memory fold. Each owner's fold is fed by its own hydrate
// and its live pass; pruning it from here would need every owner's provenance
// counters re-keyed by ET day first. The consequence is the same pre-existing
// reporting gap TRA-4904 recorded: on an uptime longer than the retention,
// `retained.etDays` can span more days than `retentionDays` claims. No byte of
// `/data` depends on it.

import { createReadStream, createWriteStream } from 'fs';
import { open, mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { pipeline } from 'stream/promises';
import { logger } from './observability/index.js';

const log = logger.child({ mod: 'shared-tape-compaction' });

/**
 * One shared interval for every registered tape.
 *
 * 6h is inherited from TRA-4904 rather than re-derived, and it clears AC2 with room:
 * the overshoot premium a periodic hook leaves is `interval / retain`, so 6h against
 * the 7-day `cost-aware-gate` is +3.6% — the ceiling AC2 sets — while the same 6h
 * against a 30-day tape is **+0.83%**. One number, well inside the bar on all of
 * them, is worth more than four tuned numbers nobody can re-check.
 */
export const SHARED_TAPE_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Slack on the due instant before an unfired hook is called dead. Matches TRA-4904. */
const COMPACTION_OVERDUE_GRACE_MS = 5 * 60 * 1000;

/** Bytes read per positioned read while walking the prefix. Memory is O(this). */
const SCAN_CHUNK_BYTES = 256 * 1024;

/** Bytes read off the end of the file to recover the newest retained `ts`. */
const TAIL_WINDOW_BYTES = 64 * 1024;

/** Prefix bytes walked between event-loop yields — see the TRA-2111 note on {@link yieldToLoop}. */
const YIELD_EVERY_BYTES = 4 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How close the oldest retained row must sit to the cutoff before the tape counts as
 * having FILLED its horizon (TRA-5038 AC1).
 *
 * One day, and the direction is deliberate: these tapes only write on sessions, so a
 * weekend or a holiday leaves a legitimate multi-day hole at the head of a tape that
 * is genuinely at steady state. A tolerance tighter than one day would read every
 * Monday boot as "still filling". A tolerance much wider would swallow the real
 * signal — a tape whose content starts days inside its own cutoff.
 */
const STEADY_STATE_TOLERANCE_MS = DAY_MS;

/**
 * What bounds a tape. Resolved per pass, never assumed.
 *
 *   `age`             — drop rows whose `ts` is below `now - retainMs`. Three of the four.
 *   `bytes`           — drop the oldest whole LINES until the file is at or under
 *                       `maxBytes`.
 *   `bytes_whole_day` — drop the oldest whole ET DAYS until the file is at or under
 *                       `maxBytes`. `otm-admission-tape.jsonl`, and the day alignment
 *                       is not cosmetic: that tape is an evidence archive whose
 *                       consumers divide by SESSIONS, so a partial day biases its own
 *                       within-day sample toward the afternoon and a biased day is
 *                       worse than an absent one. Its boot path has always pruned this
 *                       way; a plain `bytes` cut would silently change that.
 *
 * A byte cap has NO time horizon, so the fill question AC1 asks of the age tapes is
 * answered differently for both byte kinds — see {@link TapeSpan.fillBasis}.
 */
export type TapeRetentionPredicate =
  | { kind: 'age'; retainMs: number }
  | { kind: 'bytes'; maxBytes: number }
  | { kind: 'bytes_whole_day'; maxBytes: number };

/**
 * TRA-5038 AC1 — the span actually on disk, so "is this tape at its 30-day steady
 * state or still filling?" can be answered from outside the process.
 *
 * This exists because the question could NOT be answered from outside, and the two
 * answers imply different worst cases: `live-enforce-gate` at 94.7 MiB is either a
 * finished 30-day tape (3.16 MiB/day) or a 20-day-old one still climbing toward
 * ~141 MiB (4.70 MiB/day). TRA-5038 explicitly forbids settling it by differencing
 * two censuses, because TRA-4903 rewired the append paths inside that window, so a
 * growth delta cannot distinguish a rate change from a fill.
 *
 * ⚠ Published at the STATE level, not only inside `last`. A tape whose timer has not
 * fired yet has no `last` from the timer, and on bqb1 that is the ordinary case —
 * burying the span inside the fire outcome would make AC1 unreadable on the one host
 * that matters. A cheap measure-only pass at boot populates it; see
 * {@link measureSharedTapeSpan}.
 */
export interface TapeSpan {
  /** `ts` of the oldest line on disk, ISO. `null` when the tape is empty or unreadable. */
  oldestRetainedTs: string | null;
  /** `ts` of the newest line on disk, ISO. */
  newestRetainedTs: string | null;
  /** `newest - oldest` in days. The measured span, which is the AC1 deliverable. */
  spanDays: number | null;
  /** The cutoff this predicate implies, ISO. `null` for a byte cap — it has none. */
  cutoff: string | null;
  /**
   * `oldestRetainedTs - cutoff` in days: how far INSIDE its own cutoff the tape's
   * content begins. ~0 means the cutoff is binding. Large means it is not yet.
   * `null` for a byte cap.
   */
  cutoffHeadroomDays: number | null;
  /**
   * **THE AC1 FIELD.**
   *
   *   `at_steady_state` — the bound is binding. For an age tape: rows were dropped
   *                       this pass, or the oldest row sits within one day of the
   *                       cutoff. Rate is `size / retainDays`.
   *   `still_filling`   — the tape's content begins well inside its own cutoff, so
   *                       it has not reached its horizon and `size / retainDays`
   *                       UNDERSTATES the rate. Use `size / spanDays`.
   *   `unknown`         — the span could not be read (empty tape, no file, no `ts`).
   *                       Never guessed.
   */
  fill: 'at_steady_state' | 'still_filling' | 'unknown';
  /** One sentence naming the evidence for `fill`, so a reader can re-derive it. */
  fillBasis: string;
  /**
   * `bytesOnDisk / spanDays` — the rate implied by the MEASURED span rather than by
   * the configured retention. For a still-filling tape this is the honest figure and
   * the configured-retention one is wrong; for a steady-state tape they agree.
   */
  observedBytesPerDay: number | null;
}

/** What one pass actually DID. Published, never the constant alone. */
export interface TapeCompaction {
  /** Registry key, e.g. `live-enforce-gate`. */
  tape: string;
  /** `boot_measure` never rewrites — it exists to populate {@link TapeSpan}. */
  trigger: 'boot_measure' | 'timer' | 'manual';
  ranAt: string;
  predicate: TapeRetentionPredicate;
  bytesBefore: number;
  bytesAfter: number;
  bytesDropped: number;
  /** Exact — the dropped prefix is walked. See the module docblock on `linesBefore`. */
  linesDropped: number;
  rewrote: boolean;
  /** Rows a live append produced while the rewrite was in flight, then flushed. */
  bufferedAppendsFlushed: number;
  span: TapeSpan;
  /** The prefix walk hit a line with no readable `ts` and stopped there, keeping it. */
  stoppedOnUnreadableTs?: true;
  /** Named, never reported as a clean pass. */
  skipped?: 'not_registered' | 'no_path' | 'no_file' | 'already_in_flight' | 'measure_only';
  /** The rewrite itself failed. The bound is unchanged; disk is not compacted. */
  error?: string;
}

/** The shared hook's configuration and this tape's last outcome. Mirrors TRA-4904 AC2. */
export interface SharedTapeCompactionState {
  tape: string;
  predicate: TapeRetentionPredicate;
  /** {@link SHARED_TAPE_COMPACTION_INTERVAL_MS}. Premium is `intervalMs / retainMs`. */
  intervalMs: number;
  /** The overshoot premium this cadence leaves, as a fraction. `null` for a byte cap. */
  cadencePremium: number | null;
  /** Shared-hook passes completed this uptime. Interpret through `hookState`, never alone. */
  timerPasses: number;
  /** ISO time the shared interval was armed, `null` if nothing armed it. */
  timerArmedAt: string | null;
  nextFireDueAt: string | null;
  /**
   * **THE FIELD TO READ.** `timerPasses` alone cannot carry this: bqb1's uptime is
   * routinely shorter than one 6h interval, so a healthy hook reports 0 passes most
   * of the time, and that is not a defect — it is the case where the boot compaction
   * is already tighter than the timer (overshoot is `min(bootGap, interval)`).
   *
   *   `timer_not_armed`   — nothing scheduled a pass. THE ALARM. This is the
   *                         pre-TRA-5038 state, in which every other field here
   *                         still reads healthy.
   *   `armed_not_yet_due` — armed, 0 passes, inside the first interval. Not a reading.
   *   `firing`            — >=1 pass and the next is not overdue. The working state.
   *   `overdue`           — armed, past due, no pass. The interval died (or the event
   *                         loop is wedged).
   */
  hookState: 'timer_not_armed' | 'armed_not_yet_due' | 'firing' | 'overdue';
  /** Most recent outcome for THIS tape (boot measure, timer or manual). */
  last: TapeCompaction | null;
  /** Latest span — see {@link TapeSpan}. Refreshed by every pass including boot. */
  span: TapeSpan | null;
  note: string;
}

/**
 * What a tape contributes. Everything else is shared.
 *
 * `flushLine` is the OWNER'S OWN raw append, not a generic one: the owner records its
 * own `appendErrors` / `lastAppendError`, and a buffered row that silently failed to
 * reach disk is the exact lost-write shape those counters exist to make visible
 * (TRA-1681). Routing the flush through the owner keeps that accounting intact.
 */
export interface SharedTapeSpec {
  tape: string;
  /** `null` when no data dir is configured (unit tests / CLI without a boot). */
  resolvePath: () => string | null;
  predicate: () => TapeRetentionPredicate;
  flushLine: (line: string) => void;
  /**
   * Called after a SUCCESSFUL rewrite with the file's new size, for owners that keep
   * their own byte counter.
   *
   * `otm-admission-tape.ts` does (`durability.fileBytes`, incremented per append).
   * Without this the counter would survive the rewrite unchanged and overstate the
   * file by exactly the bytes just reclaimed — a field that keeps reading plausible
   * while being wrong, which is the defect class this whole hook exists to remove.
   */
  onRewrite?: (bytesAfter: number) => void;
  /** One line for the health payload saying what this tape is and why it is here. */
  note: string;
  /**
   * Per-tape dater for line kinds whose instant is not a head `"ts"` key. The walk
   * calls it with the decoded head of each line (see `tsHeadBytes`); `null` still
   * means "could not date it" and still STOPS an age walk at that line.
   *
   * Exists because `reversal-shadow-signals` is a two-kind union and its `resolve`
   * lines carry NO `ts` at all — by design (ageing the kinds independently would
   * orphan resolutions from their opens). On the first live timer fire
   * (2026-10-03T23:42Z) the default reader dropped the 106 aged opens, then stopped
   * dead on the first resolve line, which then HEADED the file: every later pass read
   * `cut=0`, so the timer predicate was inert for that tape until the next boot
   * hydrate, and its published span read `unknown`. Dating a resolve by `resolvedAt`
   * is safe IN A PREFIX WALK specifically: a resolve can only follow its own open in
   * an append-only file, so any resolve the walk reaches has its open already
   * dropped (it is an orphan the boot fold discards anyway), and
   * `resolvedAt > rec.ts` always, so the substitution can only retain a line longer,
   * never drop one whose open survived.
   */
  lineTs?: (head: string) => number | null;
  /**
   * Bytes of head decoded per line for `lineTs` (default {@link TS_HEAD_BYTES}).
   * Widening is safe, narrowing is safe — the failure mode is retaining bytes, not
   * losing rows. Reversal needs ~150: `resolvedAt` is the LAST key on a resolve line.
   */
  tsHeadBytes?: number;
}

interface TapeSlot {
  spec: SharedTapeSpec;
  /** True while a rewrite is between its first read and its rename. */
  inFlight: boolean;
  /** Lines a live append produced while `inFlight`. THE INTERLOCK — see below. */
  pending: string[];
  last: TapeCompaction | null;
  span: TapeSpan | null;
}

const slots = new Map<string, TapeSlot>();

/** Shared across every tape, because there is ONE hook. */
let timerArmedAt: number | null = null;
let timerPasses = 0;

export function registerSharedTape(spec: SharedTapeSpec): void {
  slots.set(spec.tape, { spec, inFlight: false, pending: [], last: null, span: null });
}

/** Test seam — drop the registry and the shared arm state. */
export function clearSharedTapeCompaction(): void {
  slots.clear();
  timerArmedAt = null;
  timerPasses = 0;
}

export function registeredSharedTapes(): string[] {
  return [...slots.keys()];
}

/**
 * THE INTERLOCK, and the reason a periodic compaction is safe to run mid-session at
 * all (TRA-5038 AC4, second property).
 *
 * The boot compaction cannot lose an append because it completes before the engine
 * ticks. A timer rewrite has no such ordering: a row written between the rewrite's
 * read and its rename would be silently erased by the rename — a lost row that reads
 * identically to a row never recorded (TRA-1681).
 *
 * Every registered owner's append path must call this FIRST and buffer instead of
 * writing when it returns true. Checking synchronously is what makes it exact rather
 * than probabilistic, and it matters that the check is sync even for the owners whose
 * append is `await appendFile` (`reversal-shadow-ledger.ts`): the flag is raised
 * synchronously before the rewrite's first `await`, so a sync check cannot observe a
 * stale `false` and then land inside the window.
 */
export function sharedTapeRewriteInFlight(tape: string): boolean {
  return slots.get(tape)?.inFlight === true;
}

/**
 * Buffer a line the owner could not write because a rewrite is in flight. Returns
 * false when the tape is not registered, so an owner can fall through to its normal
 * append rather than dropping the row.
 */
export function bufferSharedTapeAppend(tape: string, line: string): boolean {
  const slot = slots.get(tape);
  if (slot === undefined) return false;
  slot.pending.push(line);
  return true;
}

function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Read `ts` off a raw JSONL line WITHOUT parsing it (TRA-5038 AC4, first property).
 *
 * Every line these tapes write is `JSON.stringify` of an object carrying a numeric
 * `ts` in its first few dozen bytes. A full `JSON.parse` per line is what makes the
 * boot hydrate affordable only once: at the worst-case ~1.7M lines it is seconds of
 * BLOCKED EVENT LOOP, and this hook runs four times a day on a live money box —
 * straight into the TRA-2111 yield-preempt tripwire, which already fired at 1080 ms
 * on a sync `doTick` segment.
 *
 * `null` means "could not read it", never a guess.
 */
export function extractLineTs(line: string): number | null {
  const m = /"ts":\s*(-?\d+(?:\.\d+)?)/.exec(line.slice(0, TS_HEAD_BYTES));
  if (m === null) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Bytes of a line inspected for `ts`.
 *
 * ⚠ This is a CEILING on where `ts` may sit, not a formatting preference. 96 bytes
 * covers `ts` as the first or second key on every line these four tapes write; a line
 * that buried `ts` further in would read as UNDATABLE, and an undatable line STOPS the
 * walk and is kept (never deleted). So widening this is safe and narrowing it is
 * safe — the failure mode is retaining bytes, not losing rows. It is asserted by the
 * per-tape fixture tests rather than trusted.
 */
const TS_HEAD_BYTES = 96;

/** A tape's resolved dater: head window + reader. Defaulted in {@link runOne}. */
interface LineTsReader {
  headBytes: number;
  read: (head: string) => number | null;
}

const DEFAULT_LINE_TS_READER: LineTsReader = { headBytes: TS_HEAD_BYTES, read: extractLineTs };

/** No newline within this many bytes ⇒ refuse to line-split the file. See {@link scanAgedPrefix}. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Whitespace-only, decided on BYTES. A blank line carries no record, so it is neither
 * dropped nor allowed to stop the walk.
 */
function isBlank(raw: Buffer): boolean {
  for (const b of raw) {
    // space, tab, CR, LF, FF, VT
    if (b !== 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0a && b !== 0x0c && b !== 0x0b) {
      return false;
    }
  }
  return true;
}

/**
 * Decode only the head of a line, for {@link extractLineTs}.
 *
 * Decoding the HEAD and not the whole line is what keeps the walk byte-exact: a
 * whole-chunk `toString('utf8')` splits multi-byte characters across chunk
 * boundaries, which silently changes the string's byte length and therefore corrupts
 * every offset derived from it — i.e. it would move the cut. All offsets here are
 * computed on Buffers; this decode feeds the regex and nothing else.
 */
function decodeHead(raw: Buffer, headBytes: number = TS_HEAD_BYTES): string {
  return raw.subarray(0, headBytes).toString('latin1');
}

/** The cutoff instant a predicate implies, or `null` for the byte caps (they have none). */
function predicateCutoff(predicate: TapeRetentionPredicate, now: number): number | null {
  return predicate.kind === 'age' ? now - predicate.retainMs : null;
}

function emptySpan(cutoff: number | null, basis: string): TapeSpan {
  return {
    oldestRetainedTs: null,
    newestRetainedTs: null,
    spanDays: null,
    cutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
    cutoffHeadroomDays: null,
    fill: 'unknown',
    fillBasis: basis,
    observedBytesPerDay: null,
  };
}

/** Read `len` bytes at `pos` from an open handle. Returns the bytes actually read. */
async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  pos: number,
  len: number,
): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

interface PrefixScan {
  /** Byte offset of the first line to KEEP. `size` means everything aged out. */
  cut: number;
  linesDropped: number;
  /** `ts` of the first kept line, or `null` if there is none / it is unreadable. */
  oldestKeptTs: number | null;
  stoppedOnUnreadableTs: boolean;
}

/**
 * Walk the aged prefix in {@link SCAN_CHUNK_BYTES} chunks and return where to cut.
 *
 * Memory is O(chunk + one line), not O(file) — see the module docblock. Yields every
 * {@link YIELD_EVERY_BYTES} so a long prefix (a multi-day boot gap) cannot block the
 * loop. Unbounded in the length of the prefix on purpose: the prefix is exactly the
 * bytes being deleted, so the walk is O(dropped), which is the budget the prototype
 * already set.
 */
async function scanAgedPrefix(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  cutoff: number,
  reader: LineTsReader = DEFAULT_LINE_TS_READER,
): Promise<PrefixScan> {
  let pos = 0;
  /** Bytes of an incomplete trailing line carried from the previous chunk. */
  let partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** Absolute byte offset of `partial[0]` — i.e. of the line currently being assembled. */
  let lineStart = 0;
  let linesDropped = 0;
  let sinceYield = 0;

  while (pos < size) {
    const chunk = await readAt(fh, pos, Math.min(SCAN_CHUNK_BYTES, size - pos));
    if (chunk.length === 0) break;
    const buf = partial.length === 0 ? chunk : Buffer.concat([partial, chunk]);
    partial = Buffer.alloc(0);
    let from = 0;
    let idx = buf.indexOf(0x0a, from);
    while (idx !== -1) {
      const raw = buf.subarray(from, idx);
      if (!isBlank(raw)) {
        const ts = reader.read(decodeHead(raw, reader.headBytes));
        if (ts === null) {
          // Keep it. A line we cannot date is not a line we are entitled to delete.
          return { cut: lineStart, linesDropped, oldestKeptTs: null, stoppedOnUnreadableTs: true };
        }
        if (ts >= cutoff) {
          return { cut: lineStart, linesDropped, oldestKeptTs: ts, stoppedOnUnreadableTs: false };
        }
        linesDropped += 1;
      }
      lineStart += idx + 1 - from;
      from = idx + 1;
      idx = buf.indexOf(0x0a, from);
    }
    partial = buf.subarray(from);
    pos += chunk.length;
    if (partial.length > MAX_LINE_BYTES) {
      // No newline in 8 MiB. This is not a JSONL tape we can line-split, and the
      // fail-safe direction is to keep every byte rather than guess a boundary.
      return { cut: 0, linesDropped: 0, oldestKeptTs: null, stoppedOnUnreadableTs: true };
    }
    sinceYield += chunk.length;
    if (sinceYield >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }

  // Trailing line with no newline: an unterminated row is still a row.
  if (!isBlank(partial)) {
    const ts = reader.read(decodeHead(partial, reader.headBytes));
    if (ts === null) {
      return { cut: lineStart, linesDropped, oldestKeptTs: null, stoppedOnUnreadableTs: true };
    }
    if (ts >= cutoff) {
      return { cut: lineStart, linesDropped, oldestKeptTs: ts, stoppedOnUnreadableTs: false };
    }
    linesDropped += 1;
  }
  // Everything aged out.
  return { cut: size, linesDropped, oldestKeptTs: null, stoppedOnUnreadableTs: false };
}

/**
 * Find where to cut so the retained bytes are at or under `maxBytes`, aligned to a
 * line boundary. Also counts the dropped lines, which costs one walk of the dropped
 * prefix — the same O(dropped) budget as the age path.
 */
async function scanBytePrefix(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  maxBytes: number,
  reader: LineTsReader = DEFAULT_LINE_TS_READER,
): Promise<PrefixScan> {
  if (size <= maxBytes) {
    return {
      cut: 0,
      linesDropped: 0,
      oldestKeptTs: await firstLineTs(fh, 0, size, reader),
      stoppedOnUnreadableTs: false,
    };
  }

  const target = size - maxBytes;
  let pos = 0;
  let linesDropped = 0;
  let cut = size;
  let sinceYield = 0;
  let partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  // Walk to `target`, counting newlines, then take the NEXT boundary at or after it.
  while (pos < size) {
    const chunk = await readAt(fh, pos, Math.min(SCAN_CHUNK_BYTES, size - pos));
    if (chunk.length === 0) break;
    const buf = partial.length === 0 ? chunk : Buffer.concat([partial, chunk]);
    const base = pos - partial.length;
    partial = Buffer.alloc(0);
    let idx = buf.indexOf(0x0a);
    let last = 0;
    while (idx !== -1) {
      const absEnd = base + idx + 1;
      linesDropped += 1;
      if (absEnd >= target) {
        cut = absEnd;
        break;
      }
      last = idx + 1;
      idx = buf.indexOf(0x0a, idx + 1);
    }
    if (cut !== size) break;
    partial = buf.subarray(last);
    pos += chunk.length;
    if (partial.length > MAX_LINE_BYTES) {
      // Same fail-safe as the age path: a file we cannot line-split keeps every byte.
      return { cut: 0, linesDropped: 0, oldestKeptTs: null, stoppedOnUnreadableTs: true };
    }
    sinceYield += chunk.length;
    if (sinceYield >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }

  return {
    cut,
    linesDropped,
    oldestKeptTs: await firstLineTs(fh, cut, size, reader),
    stoppedOnUnreadableTs: false,
  };
}

/**
 * Read `etDay` off a raw JSONL line without parsing it. Same contract and the same
 * head window as {@link extractLineTs}: `null` means "could not read it".
 */
export function extractLineEtDay(line: string): string | null {
  const m = /"etDay":\s*"(\d{4}-\d{2}-\d{2})"/.exec(line.slice(0, TS_HEAD_BYTES));
  return m === null ? null : (m[1] as string);
}

/**
 * Find where to cut so the retained bytes are at or under `maxBytes`, aligned to an
 * ET DAY boundary rather than a line boundary.
 *
 * The cut is the FIRST day-start offset whose remaining suffix fits the cap. If no
 * such boundary exists before EOF, it is the LAST day-start found — i.e. the newest
 * day is always kept even if that single day exceeds the cap, which is the same
 * `days.length > 1` guard the boot prune has always applied. Over-cap-by-one-day is
 * a bounded overshoot; an empty evidence archive is not recoverable.
 *
 * A line with no readable `etDay` does not start a new day and cannot be a cut point
 * — the walk carries it inside whatever day precedes it, so an undatable row is
 * retained with its neighbours rather than becoming a boundary of its own.
 */
async function scanWholeDayPrefix(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  maxBytes: number,
  reader: LineTsReader = DEFAULT_LINE_TS_READER,
): Promise<PrefixScan> {
  if (size <= maxBytes) {
    return {
      cut: 0,
      linesDropped: 0,
      oldestKeptTs: await firstLineTs(fh, 0, size, reader),
      stoppedOnUnreadableTs: false,
    };
  }

  let pos = 0;
  let partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let lineStart = 0;
  let currentDay: string | null = null;
  /** Byte offset where `currentDay` began — the only legal cut point. */
  let currentDayStart = 0;
  /** Lines before `currentDayStart`; what gets dropped if we cut at the NEXT boundary. */
  let linesBeforeCurrentDay = 0;
  let linesInCurrentDay = 0;
  let sinceYield = 0;

  while (pos < size) {
    const chunk = await readAt(fh, pos, Math.min(SCAN_CHUNK_BYTES, size - pos));
    if (chunk.length === 0) break;
    const buf = partial.length === 0 ? chunk : Buffer.concat([partial, chunk]);
    partial = Buffer.alloc(0);
    let from = 0;
    let idx = buf.indexOf(0x0a, from);
    while (idx !== -1) {
      const raw = buf.subarray(from, idx);
      if (!isBlank(raw)) {
        const day = extractLineEtDay(decodeHead(raw));
        if (day !== null && day !== currentDay) {
          // A new day starts here. Is the suffix from this point small enough?
          if (currentDay !== null && size - lineStart <= maxBytes) {
            return {
              cut: lineStart,
              linesDropped: linesBeforeCurrentDay + linesInCurrentDay,
              oldestKeptTs: reader.read(decodeHead(raw, reader.headBytes)),
              stoppedOnUnreadableTs: false,
            };
          }
          if (currentDay !== null) {
            linesBeforeCurrentDay += linesInCurrentDay;
            linesInCurrentDay = 0;
          }
          currentDay = day;
          currentDayStart = lineStart;
        }
        linesInCurrentDay += 1;
      }
      lineStart += idx + 1 - from;
      from = idx + 1;
      idx = buf.indexOf(0x0a, from);
    }
    partial = buf.subarray(from);
    pos += chunk.length;
    if (partial.length > MAX_LINE_BYTES) {
      return { cut: 0, linesDropped: 0, oldestKeptTs: null, stoppedOnUnreadableTs: true };
    }
    sinceYield += chunk.length;
    if (sinceYield >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }

  // No boundary fit the cap. Keep the NEWEST day, whose start is `currentDayStart`.
  if (currentDayStart === 0) {
    // One day only (or no readable day at all): there is nothing to drop that would
    // not empty the archive. Keep everything and let the overshoot be visible.
    return { cut: 0, linesDropped: 0, oldestKeptTs: await firstLineTs(fh, 0, size, reader), stoppedOnUnreadableTs: false };
  }
  return {
    cut: currentDayStart,
    linesDropped: linesBeforeCurrentDay,
    oldestKeptTs: await firstLineTs(fh, currentDayStart, size, reader),
    stoppedOnUnreadableTs: false,
  };
}

/** `ts` of the first non-blank line at or after `from`, read off one bounded chunk. */
async function firstLineTs(
  fh: Awaited<ReturnType<typeof open>>,
  from: number,
  size: number,
  reader: LineTsReader = DEFAULT_LINE_TS_READER,
): Promise<number | null> {
  if (from >= size) return null;
  const head = await readAt(fh, from, Math.min(SCAN_CHUNK_BYTES, size - from));
  let start = 0;
  for (;;) {
    const nl = head.indexOf(0x0a, start);
    const end = nl === -1 ? head.length : nl;
    const raw = head.subarray(start, end);
    if (!isBlank(raw)) return reader.read(decodeHead(raw, reader.headBytes));
    if (nl === -1) return null;
    start = nl + 1;
  }
}

/** `ts` of the last complete line in the file, read off a bounded tail window. */
async function newestTs(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  reader: LineTsReader = DEFAULT_LINE_TS_READER,
): Promise<number | null> {
  if (size === 0) return null;
  const len = Math.min(TAIL_WINDOW_BYTES, size);
  const tail = await readAt(fh, size - len, len);
  // latin1 so the decode is byte-faithful: the window's FIRST line is usually a
  // fragment, and a utf8 decode of a split character would shift it. Irrelevant in
  // practice because the walk is backwards from the end, but the cheap decode is also
  // the correct one.
  const lines = tail.toString('latin1').split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const ts = reader.read((lines[i] as string).slice(0, reader.headBytes));
    if (ts !== null) return ts;
  }
  return null;
}

function buildSpan(
  predicate: TapeRetentionPredicate,
  now: number,
  bytesOnDisk: number,
  oldest: number | null,
  newest: number | null,
  droppedThisPass: number,
): TapeSpan {
  const cutoff = predicateCutoff(predicate, now);
  if (oldest === null) {
    return emptySpan(
      cutoff,
      'UNKNOWN — no datable line on disk (empty tape, missing file, or no readable `ts`). Not guessed.',
    );
  }
  const spanMs = newest === null ? null : Math.max(0, newest - oldest);
  const spanDays = spanMs === null ? null : spanMs / DAY_MS;
  const observedBytesPerDay =
    spanDays === null || spanDays <= 0 ? null : bytesOnDisk / spanDays;

  if (predicate.kind === 'bytes' || predicate.kind === 'bytes_whole_day') {
    const atCap = droppedThisPass > 0 || bytesOnDisk >= predicate.maxBytes;
    return {
      oldestRetainedTs: new Date(oldest).toISOString(),
      newestRetainedTs: newest === null ? null : new Date(newest).toISOString(),
      spanDays,
      cutoff: null,
      cutoffHeadroomDays: null,
      fill: atCap ? 'at_steady_state' : 'still_filling',
      fillBasis: atCap
        ? `AT CAP: ${bytesOnDisk} B against a ${predicate.maxBytes} B ceiling${
            droppedThisPass > 0 ? ` and ${droppedThisPass} line(s) dropped this pass` : ''
          }. A BYTE cap has no time horizon, so "steady state" here means the ceiling is binding, not that a retention window filled.`
        : `UNDER CAP: ${bytesOnDisk} B of ${predicate.maxBytes} B. A BYTE cap has no time horizon — this tape is not "filling toward" a retention, it is accumulating toward a ceiling, and the measured span (${
            spanDays === null ? 'unknown' : spanDays.toFixed(2)
          } d) is what its rate must be keyed on.`,
      observedBytesPerDay,
    };
  }

  const cut = cutoff as number;
  const headroomMs = oldest - cut;
  const steady = droppedThisPass > 0 || headroomMs <= STEADY_STATE_TOLERANCE_MS;
  const retainDays = predicate.retainMs / DAY_MS;
  return {
    oldestRetainedTs: new Date(oldest).toISOString(),
    newestRetainedTs: newest === null ? null : new Date(newest).toISOString(),
    spanDays,
    cutoff: new Date(cut).toISOString(),
    cutoffHeadroomDays: headroomMs / DAY_MS,
    fill: steady ? 'at_steady_state' : 'still_filling',
    fillBasis: steady
      ? `AT STEADY STATE: ${
          droppedThisPass > 0
            ? `${droppedThisPass} line(s) fell below the cutoff on this pass`
            : `the oldest row sits ${(headroomMs / DAY_MS).toFixed(2)} d inside the cutoff, within the ${
                STEADY_STATE_TOLERANCE_MS / DAY_MS
              } d session-gap tolerance`
        } ⇒ the ${retainDays} d horizon is FULL and size/${retainDays} is the honest rate.`
    : `STILL FILLING: the oldest row is ${(headroomMs / DAY_MS).toFixed(2)} d inside the cutoff, so the ${retainDays} d horizon is NOT full. size/${retainDays} UNDERSTATES the rate — use size/spanDays (${
        observedBytesPerDay === null ? 'unknown' : (observedBytesPerDay / (1024 * 1024)).toFixed(2)
      } MiB/day) and project the steady state as rate × ${retainDays} d.`,
    observedBytesPerDay,
  };
}

/**
 * One pass over one tape. `measureOnly` reads the span and rewrites nothing — that is
 * the boot call, and it is why AC1's span is readable on a host whose uptime never
 * reaches one interval.
 */
async function runOne(
  tape: string,
  now: number,
  trigger: TapeCompaction['trigger'],
  measureOnly: boolean,
): Promise<TapeCompaction> {
  const slot = slots.get(tape);
  if (slot === undefined) {
    return {
      tape,
      trigger,
      ranAt: new Date(now).toISOString(),
      predicate: { kind: 'age', retainMs: 0 },
      bytesBefore: 0,
      bytesAfter: 0,
      bytesDropped: 0,
      linesDropped: 0,
      rewrote: false,
      bufferedAppendsFlushed: 0,
      span: emptySpan(null, 'UNKNOWN — tape is not registered with the shared hook.'),
      skipped: 'not_registered',
    };
  }

  const predicate = slot.spec.predicate();
  const base = {
    tape,
    trigger,
    ranAt: new Date(now).toISOString(),
    predicate,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesDropped: 0,
    linesDropped: 0,
    rewrote: false,
    bufferedAppendsFlushed: 0,
  };
  const cutoff = predicateCutoff(predicate, now);

  const path = slot.spec.resolvePath();
  if (path === null) {
    // No boot hydrate ran (unit tests / CLI): nothing is durable, so there is nothing
    // to compact. Named, never reported as a clean pass.
    const out: TapeCompaction = {
      ...base,
      span: emptySpan(cutoff, 'UNKNOWN — no data dir configured, so nothing is durable.'),
      skipped: 'no_path',
    };
    slot.last = out;
    return out;
  }

  // An overlapping pass would read the file the in-flight one is about to replace.
  // Not counted and it does NOT overwrite the last real outcome.
  if (slot.inFlight) {
    return {
      ...base,
      span: slot.span ?? emptySpan(cutoff, 'UNKNOWN — a rewrite is already in flight.'),
      skipped: 'already_in_flight',
    };
  }

  const finish = (out: TapeCompaction): TapeCompaction => {
    slot.last = out;
    slot.span = out.span;
    return out;
  };

  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    // Missing (nothing written yet) or unreadable — the owner's append path surfaces
    // write failures; there is nothing for a compaction to do either way.
    return finish({
      ...base,
      span: emptySpan(cutoff, 'UNKNOWN — no file on disk yet.'),
      skipped: 'no_file',
    });
  }

  /**
   * The scan + rewrite. Separated from the interlock release below because the flush
   * has to be OUTSIDE it: a `finally` that mutates the result cannot change what an
   * inner `return` already captured, so publishing from a `finally` would ship a
   * payload whose `bufferedAppendsFlushed` was always 0 while the real flush happened
   * invisibly — a field that reads identically whether or not the interlock works,
   * which is the exact defect class this hook exists to remove one level up.
   */
  const reader: LineTsReader = {
    headBytes: slot.spec.tsHeadBytes ?? TS_HEAD_BYTES,
    read: slot.spec.lineTs ?? extractLineTs,
  };

  // When the walk stopped on a line it could not date, the generic empty-span basis
  // ("no datable line on disk") would MISATTRIBUTE the unknown — the tape has content,
  // its head is just undatable. Name the real cause so the surface stays truthful.
  const spanOf = (
    bytes: number,
    scan: PrefixScan,
    newest: number | null,
    dropped: number,
  ): TapeSpan => {
    const span = buildSpan(predicate, now, bytes, scan.oldestKeptTs, newest, dropped);
    if (scan.stoppedOnUnreadableTs && scan.oldestKeptTs === null) {
      span.fillBasis =
        'UNKNOWN — the walk STOPPED on a line it could not date, so the head of this '
        + 'tape is UNDATABLE, not absent. The tape has content; `fill` cannot be graded '
        + 'until the undatable head ages out at a boot hydrate or the tape supplies a '
        + '`lineTs` reader for that line kind.';
    }
    return span;
  };

  const pass = async (): Promise<TapeCompaction> => {
    const fh = await open(path, 'r');
    let scan: PrefixScan;
    let newest: number | null;
    try {
      scan =
        predicate.kind === 'age'
          ? await scanAgedPrefix(fh, size, now - predicate.retainMs, reader)
          : predicate.kind === 'bytes_whole_day'
            ? await scanWholeDayPrefix(fh, size, predicate.maxBytes, reader)
            : await scanBytePrefix(fh, size, predicate.maxBytes, reader);
      newest = await newestTs(fh, size, reader);
    } finally {
      await fh.close().catch(() => {});
    }

    if (measureOnly || scan.cut === 0) {
      // Nothing aged out (or we were only measuring). Do NOT rewrite: at ~95 MiB a
      // needless rewrite four times a day is the cost this hook removes, not adds.
      return {
        ...base,
        bytesBefore: size,
        bytesAfter: size,
        span: spanOf(size, scan, newest, 0),
        ...(measureOnly && scan.cut !== 0 ? { skipped: 'measure_only' as const } : {}),
        ...(scan.stoppedOnUnreadableTs ? { stoppedOnUnreadableTs: true as const } : {}),
      };
    }

    const tmp = `${path}.compact-${process.pid}-${now}.tmp`;
    let rewrote = false;
    let bytesAfter = Math.max(0, size - scan.cut);
    let error: string | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      // STREAMED, not a whole-file string — see the module docblock. `start === size`
      // (everything aged out) yields an empty file, which is the correct outcome for a
      // tape that has been silent longer than its own retention, not an error.
      await pipeline(
        createReadStream(path, { start: Math.min(scan.cut, size) }),
        createWriteStream(tmp),
      );
      await rename(tmp, path);
      rewrote = true;
      bytesAfter = await stat(path).then((s) => s.size).catch(() => bytesAfter);
      // Let the owner correct its own byte counter. A throw here must not turn a
      // successful rewrite into a reported failure.
      try {
        slot.spec.onRewrite?.(bytesAfter);
      } catch (err) {
        log.warn('shared tape compaction onRewrite hook threw', {
          tape,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      await rm(tmp, { force: true }).catch(() => {});
      bytesAfter = size; // the file is untouched
      log.warn('shared tape compaction rewrite failed', { tape, reason: error });
    }

    return {
      ...base,
      bytesBefore: size,
      bytesAfter,
      bytesDropped: rewrote ? size - bytesAfter : 0,
      linesDropped: rewrote ? scan.linesDropped : 0,
      rewrote,
      span: spanOf(bytesAfter, scan, newest, rewrote ? scan.linesDropped : 0),
      ...(scan.stoppedOnUnreadableTs ? { stoppedOnUnreadableTs: true as const } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };

  let out: TapeCompaction;
  // A measure-only pass never writes, so it must not raise the interlock — doing so
  // would buffer live appends for the duration of a read that cannot lose them.
  if (!measureOnly) slot.inFlight = true;
  try {
    out = await pass();
  } catch (err) {
    // Defensive: an unexpected throw must still release the interlock and flush, or
    // the buffer keeps growing and every subsequent append goes to memory only.
    out = {
      ...base,
      span: slot.span ?? emptySpan(cutoff, 'UNKNOWN — the pass threw before it could measure.'),
      error: err instanceof Error ? err.message : String(err),
    };
    log.warn('shared tape compaction threw', { tape, reason: out.error });
  } finally {
    // Drop the flag BEFORE the flush so the flush writes through instead of
    // re-buffering itself.
    slot.inFlight = false;
  }

  // A FAILED rewrite still flushes — those rows are already in the owner's in-memory
  // tally, and a buffered row that never reaches disk is the lost-write shape
  // `durability` exists to make visible (TRA-1681).
  const buffered = slot.pending.splice(0, slot.pending.length);
  for (const line of buffered) {
    try {
      slot.spec.flushLine(line);
    } catch (err) {
      log.warn('shared tape compaction flush failed', {
        tape,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  out = { ...out, bufferedAppendsFlushed: buffered.length };
  return finish(out);
}

/**
 * Populate {@link TapeSpan} without rewriting anything. Called at boot, right after
 * each owner's hydrate has applied its own cutoff, so the published span describes
 * the POST-boot-compaction file — which is the file AC1 asks about.
 */
export async function measureSharedTapeSpan(
  tape: string,
  now: number = Date.now(),
): Promise<TapeCompaction> {
  return runOne(tape, now, 'boot_measure', true);
}

/** Re-apply one tape's predicate to disk now. The timer body calls this per tape. */
export async function compactSharedTapeNow(
  tape: string,
  now: number = Date.now(),
  trigger: TapeCompaction['trigger'] = 'manual',
): Promise<TapeCompaction> {
  return runOne(tape, now, trigger, false);
}

/**
 * The shared timer body: every registered tape, SEQUENTIALLY.
 *
 * Sequential on purpose. Each pass is O(dropped) with O(chunk) memory, so running
 * them one after another costs wall-clock the box does not care about, while running
 * them concurrently would put four rewrites and four read streams on the same disk at
 * the same instant — on a volume whose free space is the thing this ticket is about.
 */
export async function runSharedTapeCompactionPass(
  now: number = Date.now(),
): Promise<TapeCompaction[]> {
  const out: TapeCompaction[] = [];
  for (const tape of slots.keys()) {
    out.push(await compactSharedTapeNow(tape, now, 'timer'));
  }
  timerPasses += 1;
  return out;
}

/**
 * Called by `index.ts` immediately after arming the interval, so each health payload
 * can tell an unarmed hook from one that is merely not due. NOT called from the timer
 * body: the point is to record that something SCHEDULED a pass, which is exactly the
 * fact a pass count cannot supply before the first pass.
 */
export function noteSharedTapeCompactionArmed(now: number = Date.now()): void {
  timerArmedAt = now;
}

/** The shared hook's state as one tape sees it. The AC3 surface. */
export function sharedTapeCompactionState(
  tape: string,
  now: number = Date.now(),
): SharedTapeCompactionState {
  const slot = slots.get(tape);
  const predicate = slot?.spec.predicate() ?? { kind: 'age' as const, retainMs: 0 };
  const dueAt =
    timerArmedAt === null
      ? null
      : timerArmedAt + SHARED_TAPE_COMPACTION_INTERVAL_MS * (timerPasses + 1);
  const hookState: SharedTapeCompactionState['hookState'] =
    timerArmedAt === null
      ? 'timer_not_armed'
      : dueAt !== null && now > dueAt + COMPACTION_OVERDUE_GRACE_MS
        ? 'overdue'
        : timerPasses > 0
          ? 'firing'
          : 'armed_not_yet_due';
  const cadencePremium =
    predicate.kind === 'age' && predicate.retainMs > 0
      ? SHARED_TAPE_COMPACTION_INTERVAL_MS / predicate.retainMs
      : null;
  return {
    tape,
    predicate,
    intervalMs: SHARED_TAPE_COMPACTION_INTERVAL_MS,
    cadencePremium,
    timerPasses,
    timerArmedAt: timerArmedAt === null ? null : new Date(timerArmedAt).toISOString(),
    nextFireDueAt: dueAt === null ? null : new Date(dueAt).toISOString(),
    hookState,
    last: slot?.last ?? null,
    span: slot?.span ?? null,
    note:
      `TRA-5038 — ONE shared ${SHARED_TAPE_COMPACTION_INTERVAL_MS / (60 * 60 * 1000)}h compaction hook covers `
      + `${slots.size} tape(s); this is the ${tape} view of it. ${slot?.spec.note ?? ''} `
      + 'READ `hookState` FIRST, not `timerPasses`: bqb1 is routinely up for LESS than one '
      + 'interval, so 0 passes is the ordinary HEALTHY reading (`armed_not_yet_due`) and the '
      + 'overshoot is then bounded by the boot gap instead, which is tighter. `timer_not_armed` '
      + 'is the alarm — it is the pre-TRA-5038 state, in which every other field here still '
      + 'reads healthy. `span.fill` is the TRA-5038 AC1 answer (steady state vs still filling); '
      + 'when it reads `still_filling`, size/retentionDays UNDERSTATES this tape\'s rate.',
  };
}
