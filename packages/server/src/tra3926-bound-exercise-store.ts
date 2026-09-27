/**
 * TRA-3926 (2026-09-27) — the DURABLE CARRIER for the BOUND half.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `PaperOptionsAccount.getExitQuantityBoundCensus()` publishes
 * `{ checked, bounded, refusedContracts, blindRows, suppressedExits,
 *    netOfCloses, reconcileTerminal, deskAddExempt }` — and every one of those
 * is a `private` field on a process-lifetime object. They are **boot-scoped**.
 * The only durable byte the bound has ever had is `outstanding`, which is
 * derived from `exitQuantityRefusal` stamps on OPEN rows and is therefore
 * erased by the very event that ends the refusal: the row closing.
 *
 * Measured 2026-09-27 on bqb1 `66a8a1ab`, pid 76, `startedAt 2026-09-25T04:13:12Z`:
 * `exitQuantityBound.checked = 0`. The fix deployed 2026-08-21T20:12Z, 37 days
 * earlier. Across every boot in between the census said exactly what it says
 * now, because each boot's census begins at zero and no surface carries the
 * prior one's. So the live grader could only ever conclude
 *
 *     "the BOUND is UNEXERCISED on this boot ... AC1–AC4 are proven by the unit
 *      suite and by deployed bytes ONLY, never by this reading"
 *
 * and it would have concluded that on day 400 as readily as on day 37. **A
 * boot-scoped counter cannot accumulate evidence, so "has this guard ever bitten
 * on real money" was not a question that could be answered slowly — it was a
 * question that could not be answered at all.** That is the same shape as the
 * detector's 30-day tape horizon, one layer down and with a horizon measured in
 * hours, and it gets the same remedy as `tra3926-judged-oversold-store.ts`:
 * write the verdict somewhere the restart cannot reach.
 *
 * ⛔ This changes NO exit decision. `stageableExitContracts` reaches its number
 * exactly as before and this store observes the verdict on the way out. A
 * carrier that could alter what it records would not be a carrier.
 *
 * ── Why `clean` IS captured here, when the sibling store refuses blinds ─────
 * `tra3926-judged-oversold-store.ts` deliberately drops blind closes: there, a
 * blind is an unanswered question and persisting one freezes a shrug as
 * testimony. The opposite is true on this side, for the reason the
 * `exitQuantityChecked` field already states in its own docblock — a refusal
 * counter alone cannot separate "armed and nothing has tried" from "never
 * runs", because both publish 0. **Here the denominator is the testimony.** A
 * store holding only the bites would answer "did it bite" and leave "did it
 * ever run" exactly as unanswerable as the boot-scoped census left it, which is
 * the defect being repaired. So all four verdicts are captured, and `clean` is
 * the one that makes the other three legible.
 *
 * ── Population ──────────────────────────────────────────────────────────────
 * `importedFromTradier === true` rows only, matching `exitQuantityChecked`'s
 * denominator exactly so the two can be reconciled against each other on one
 * read. A demo box stages exits all day and none of them are imported; counting
 * those would bury the numbers that matter under a rising total that proves
 * nothing about live imported rows.
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 * Book-scoped, and that is not decoration: TRA-3977 measured a fill placed on
 * one book authorising a `sell_to_close` on another book's row against a
 * different broker account. Both oracles behind this verdict are scoped to
 * `owner`; a carrier keyed without it would fold two books' verdicts onto one
 * key and reproduce that defect in the evidence.
 *
 * ── Growth ──────────────────────────────────────────────────────────────────
 * `checkExits` runs every tick, so an unchanged row must write nothing. A line
 * is appended only when the key's verdict SIGNATURE changes — the same
 * granularity `exitQuantityLoggedSignatures` already uses for the operator warn,
 * chosen there for the same reason (a permanently-refused row would otherwise
 * emit the same line forever and bury its first occurrence). The file is
 * therefore bounded by distinct verdict TRANSITIONS, not by ticks.
 *
 * `MAX_LINES` is a hard stop, not a rotation: at the cap this store STOPS
 * APPENDING and counts the drops on `droppedAtCap`, because the first lines are
 * the ones with the earliest exercise and silently discarding them would make a
 * carrier that erases the oldest testimony it exists to keep. A non-zero
 * `droppedAtCap` on the health route means this file needs a human, and the
 * summary publishes the cap itself so a reader never has to guess it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

import type { EngineExitQuantityBound } from './option-exec-flag.js';

const log = logger.child({ module: 'tra3926-bound-exercise-store' });

export const BOUND_EXERCISE_LOG_FILENAME = 'tra3926-bound-exercise.jsonl';

/**
 * Hard ceiling on stored lines. Read it off this constant, never off a recalled
 * number: a count is a census only if its cap is read from source.
 */
export const BOUND_EXERCISE_MAX_LINES = 5000;

/**
 * What the bound DID, folded to the four outcomes an operator acts on.
 *
 * `clean` covers every branch that let the requested quantity through without
 * the oracle refusing — including the two board grants (`handed_over`,
 * `desk_add_exempt`). Those are not bites and must not be counted as such, but
 * they ARE exercises of this code path and the `reason` on the line names which
 * one, so the grant populations stay separable without a fifth verdict.
 */
export type BoundExerciseVerdict = 'bounded' | 'suppressed' | 'blind' | 'clean';

/**
 * The ARMING marker, written once when a store is first pointed at a DATA_DIR.
 *
 * Without it an EMPTY store is ambiguous in the one direction that matters: it
 * reads identically whether the carrier has watched this box for a year and
 * seen nothing, or was installed ninety seconds ago. Measured 2026-09-27 at
 * 23:46Z, six minutes after this carrier first deployed, the grader's own BLIND
 * banner said the zero was "a measured never across every boot this DATA_DIR
 * has survived" — which was false, and falsely reassuring, because the store
 * could not testify about a single boot before its own installation.
 *
 * `armedAt` makes the claim exactly as strong as the evidence: a never SINCE a
 * stated instant, which is worth nothing on day one and a great deal on day 90.
 */
export interface BoundExerciseArmedLine {
  kind: 'armed';
  at: number;
}

export interface BoundExerciseLine {
  kind: 'bound-exercise';
  /** ms epoch of the capture — when the bound reached this verdict. */
  at: number;
  /** Book the row belongs to. `null` only where the account has no owner. */
  owner: string | null;
  optionSymbol: string | null;
  positionId: string;
  verdict: BoundExerciseVerdict;
  /** `EngineExitQuantityBound['reason']`, carried verbatim. */
  reason: string;
  requestedContracts: number;
  exitContracts: number;
  refusedContracts: number;
  oracleRefused: boolean;
  netOfCloses: boolean;
}

let dataDir: string | null = null;

/**
 * Point the store at a DATA_DIR, and stamp the {@link BoundExerciseArmedLine}
 * if this dir has never carried one.
 *
 * Best-effort and never throws: an arming stamp that could break a boot would
 * be a worse defect than the ambiguity it removes. A dir whose stamp could not
 * be written reports `armedAt: null`, which the route must read as "this
 * store's own start is UNKNOWN" — not as "since forever".
 */
export function setBoundExerciseDataDir(dir: string | null): void {
  dataDir = dir;
  storedSignatureByKey.clear();
  if (dir == null) return;
  const path = boundExerciseLogPath(dir);
  try {
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    const line: BoundExerciseArmedLine = { kind: 'armed', at: Date.now() };
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
  } catch (err) {
    log.warn('tra3926 bound-exercise arming stamp failed — the store cannot date its own zero', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export function boundExerciseLogPath(dir: string): string {
  return join(dir, BOUND_EXERCISE_LOG_FILENAME);
}

/** Book + OCC + row. See the keying note in the module docblock. */
export function boundExerciseKey(row: {
  owner: string | null;
  optionSymbol: string | null;
  positionId: string;
}): string {
  return `${row.owner ?? 'null'}|${row.optionSymbol ?? 'null'}|${row.positionId}`;
}

/**
 * The change detector. Two verdicts on one key are the SAME exercise only when
 * every number an operator would act on matches — a partial bound that moved
 * from refusing 1 contract to refusing 2 is a new fact about real money, not a
 * repeat of the old one.
 */
function exerciseSignature(line: BoundExerciseLine): string {
  return [
    line.verdict,
    line.reason,
    line.requestedContracts,
    line.exitContracts,
    line.refusedContracts,
    line.oracleRefused ? '1' : '0',
    line.netOfCloses ? '1' : '0',
  ].join('|');
}

/** Classify a verdict the same way `stageableExitContracts` branches on it. */
export function classifyBoundExercise(bound: EngineExitQuantityBound): BoundExerciseVerdict {
  if (bound.blind) return 'blind';
  if (!bound.bounded) return 'clean';
  return bound.exitContracts === 0 ? 'suppressed' : 'bounded';
}

/**
 * Read every stored line. Corrupt lines are skipped here and COUNTED by the
 * summary's `lines` vs `parsed` delta, never folded into a clean answer.
 */
export function readBoundExercise(): {
  lines: BoundExerciseLine[];
  rawLines: number;
  /** Lines this build understood — verdicts PLUS the arming stamp. */
  understood: number;
  /** ms epoch this dir was first armed, or `null` if it carries no stamp. */
  armedAt: number | null;
} {
  const empty = { lines: [], rawLines: 0, understood: 0, armedAt: null };
  if (dataDir == null) return empty;
  let raw: string;
  try {
    raw = readFileSync(boundExerciseLogPath(dataDir), 'utf8');
  } catch {
    return empty;
  }
  const out: BoundExerciseLine[] = [];
  let rawLines = 0;
  let understood = 0;
  let armedAt: number | null = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    rawLines += 1;
    try {
      const parsed = JSON.parse(line) as BoundExerciseLine | BoundExerciseArmedLine;
      // The arming stamp is UNDERSTOOD, not damage. Counting it against
      // `parsed` would make a healthy store red D9b on its very first read.
      if (parsed && parsed.kind === 'armed' && typeof parsed.at === 'number') {
        understood += 1;
        if (armedAt === null || parsed.at < armedAt) armedAt = parsed.at;
      } else if (parsed && parsed.kind === 'bound-exercise' && typeof parsed.positionId === 'string') {
        understood += 1;
        out.push(parsed);
      }
    } catch {
      // surfaced by the summary as a lines/understood mismatch, not swallowed
    }
  }
  return { lines: out, rawLines, understood, armedAt };
}

let droppedAtCap = 0;

/**
 * Per-key signature of the last verdict THIS boot stored or confirmed.
 *
 * `checkExits` runs on every tick, so the unchanged path is the hot one and it
 * must not read the file. The cache is a fast NEGATIVE only: a hit means "we
 * already know this exact verdict is on disk" and skips the read; a miss falls
 * through to the file, which stays authoritative across boots. It can never
 * cause a write to be skipped that disk would have accepted, because it is only
 * ever populated from a line disk has confirmed or accepted.
 */
const storedSignatureByKey = new Map<string, string>();

/** Drops caused by {@link BOUND_EXERCISE_MAX_LINES} on THIS boot. */
export function boundExerciseDroppedAtCap(): number {
  return droppedAtCap;
}

/** Test seam only — the cap counter and cache are process state, like the census they mirror. */
export function resetBoundExerciseDropCounter(): void {
  droppedAtCap = 0;
  storedSignatureByKey.clear();
}

/**
 * Capture one bound verdict. Idempotent on content: a key whose latest stored
 * signature already matches is skipped, so `checkExits` may call this on every
 * tick and the file grows only when the verdict actually changes.
 *
 * Best-effort on IO and COUNTED, matching the sibling ledgers — a carrier that
 * throws into the exit path would be a guard that closes positions by failing.
 *
 * ⚠ Must be handed the REAL verdict the exit path is about to act on. Capturing
 * from a re-derivation or a spy is how a durable carrier diverges from the
 * behaviour it exists to preserve (TRA-3730).
 */
export function captureBoundExercise(
  row: { owner: string | null; optionSymbol: string | null; positionId: string },
  bound: EngineExitQuantityBound,
  nowMs: number = Date.now(),
): { appended: boolean; unchanged: boolean; appendError: boolean; dropped: boolean } {
  const miss = { appended: false, unchanged: false, appendError: false, dropped: false };
  if (dataDir == null) return miss;
  const line: BoundExerciseLine = {
    kind: 'bound-exercise',
    at: nowMs,
    owner: row.owner,
    optionSymbol: row.optionSymbol,
    positionId: row.positionId,
    verdict: classifyBoundExercise(bound),
    reason: bound.reason,
    requestedContracts: bound.requestedContracts,
    exitContracts: bound.exitContracts,
    refusedContracts: bound.refusedContracts,
    oracleRefused: bound.oracleRefused,
    netOfCloses: bound.netOfCloses,
  };
  const key = boundExerciseKey(row);
  const signature = exerciseSignature(line);
  if (storedSignatureByKey.get(key) === signature) return { ...miss, unchanged: true };
  const { lines } = readBoundExercise();
  let latest: BoundExerciseLine | null = null;
  for (const stored of lines) {
    if (boundExerciseKey(stored) === key) latest = stored;
  }
  if (latest && exerciseSignature(latest) === signature) {
    storedSignatureByKey.set(key, signature);
    return { ...miss, unchanged: true };
  }
  if (lines.length >= BOUND_EXERCISE_MAX_LINES) {
    droppedAtCap += 1;
    log.warn('tra3926 bound-exercise store at cap — verdict NOT captured', {
      component: 'live-exit-quantity-bound',
      issue: 'TRA-3926',
      cap: BOUND_EXERCISE_MAX_LINES,
      optionSymbol: row.optionSymbol,
      verdict: line.verdict,
      note: 'the store stops appending rather than discard its oldest testimony; this file needs a human',
    });
    return { ...miss, dropped: true };
  }
  const path = boundExerciseLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
    storedSignatureByKey.set(key, signature);
    return { ...miss, appended: true };
  } catch (err) {
    log.warn('tra3926 bound-exercise append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ...miss, appendError: true };
  }
}

export interface BoundExerciseSummary {
  dataDir: string | null;
  ephemeral: boolean;
  /** Lines on disk, INCLUDING any this build could not parse. */
  lines: number;
  /** Lines this build understood (verdicts + the arming stamp). `lines - parsed > 0` means the file is damaged. */
  parsed: number;
  /**
   * When this DATA_DIR was first armed. **Read it before believing a zero.**
   * `everExercised: false` is a never SINCE THIS INSTANT and no earlier — the
   * store cannot testify about a boot that predates its own installation, and
   * on day one that zero is worth nothing at all. `null` means the arming stamp
   * could not be written or has been lost, i.e. this store's own start is
   * UNKNOWN, which must never be read as "since forever".
   */
  armedAt: number | null;
  /** Distinct (book, OCC, row) keys the store testifies to. */
  rows: number;
  /**
   * LIFETIME verdict counts, across every boot this DATA_DIR has seen. These
   * are counts of verdict TRANSITIONS, not of ticks — see the growth note.
   */
  verdicts: Record<BoundExerciseVerdict, number>;
  /** Contracts this engine declined to sell, summed over the latest verdict per key. */
  refusedContracts: number;
  firstAt: number | null;
  lastAt: number | null;
  cap: number;
  /** Verdicts this boot could not store because the cap was reached. > 0 needs a human. */
  droppedAtCap: number;
  /**
   * The headline, and it is only as strong as {@link armedAt}. `false` means no
   * imported row has reached an exit staging site since this store was armed —
   * the bound is deployed and untested by the tape, which is a statement about
   * the market, not about the guard. `true` means AC1's live grade is
   * answerable from this block. **Never quote the `false` without its date.**
   */
  everExercised: boolean;
  latest: Array<{
    key: string;
    owner: string | null;
    optionSymbol: string | null;
    positionId: string;
    verdict: BoundExerciseVerdict;
    reason: string;
    requestedContracts: number;
    exitContracts: number;
    refusedContracts: number;
    oracleRefused: boolean;
    netOfCloses: boolean;
    /** How many times this key's verdict CHANGED. > 1 is history, never an overwrite. */
    attempts: number;
    firstAt: number;
    lastAt: number;
  }>;
}

/**
 * Fold the store, newest verdict per key wins.
 *
 * The verdict counts are over the LATEST line per key, not over every line: a
 * row that went `blind` then `bounded` when its ledger hydrated is one row that
 * is now bounded, and counting it in both buckets would let a single row inflate
 * the exercise record it exists to report honestly. `attempts` carries the
 * history the fold drops.
 */
export function summarizeBoundExercise(): BoundExerciseSummary {
  const { lines, rawLines, understood, armedAt } = readBoundExercise();
  const byKey = new Map<string, BoundExerciseLine[]>();
  for (const l of lines) {
    const k = boundExerciseKey(l);
    const g = byKey.get(k);
    if (g) g.push(l);
    else byKey.set(k, [l]);
  }
  const verdicts: Record<BoundExerciseVerdict, number> = {
    bounded: 0,
    suppressed: 0,
    blind: 0,
    clean: 0,
  };
  let refusedContracts = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  const latest: BoundExerciseSummary['latest'] = [];
  for (const [key, group] of byKey) {
    const ordered = [...group].sort((a, b) => a.at - b.at);
    const newest = ordered[ordered.length - 1]!;
    verdicts[newest.verdict] += 1;
    refusedContracts += Number.isFinite(newest.refusedContracts) ? newest.refusedContracts : 0;
    const first = ordered[0]!.at;
    if (firstAt === null || first < firstAt) firstAt = first;
    if (lastAt === null || newest.at > lastAt) lastAt = newest.at;
    latest.push({
      key,
      owner: newest.owner,
      optionSymbol: newest.optionSymbol,
      positionId: newest.positionId,
      verdict: newest.verdict,
      reason: newest.reason,
      requestedContracts: newest.requestedContracts,
      exitContracts: newest.exitContracts,
      refusedContracts: newest.refusedContracts,
      oracleRefused: newest.oracleRefused,
      netOfCloses: newest.netOfCloses,
      attempts: ordered.length,
      firstAt: first,
      lastAt: newest.at,
    });
  }
  latest.sort((a, b) => a.lastAt - b.lastAt || (a.key < b.key ? -1 : 1));
  return {
    dataDir,
    ephemeral: dataDir === null ? true : isEphemeralDataDir(dataDir),
    lines: rawLines,
    parsed: understood,
    armedAt,
    rows: byKey.size,
    verdicts,
    refusedContracts,
    firstAt,
    lastAt,
    cap: BOUND_EXERCISE_MAX_LINES,
    droppedAtCap,
    everExercised: byKey.size > 0,
    latest,
  };
}
