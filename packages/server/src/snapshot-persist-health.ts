/**
 * TRA-3407 (delivery of TRA-2892) — the WRITE axis of snapshot durability.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY `/api/health/storage` DOES NOT ALREADY COVER IT
 * ─────────────────────────────────────────────────────────────────────────────
 * `persistStocksNow` / `persistCryptoNow` swallow every write failure into a
 * `log.warn`. ENOSPC, EIO, EACCES, an unmounted volume — all of them land in
 * that one catch and nowhere else. There is no counter, no health field, no
 * gate.
 *
 * That is not hypothetical. `/data` returned ENOSPC on EVERY write from
 * 2026-07-30T23:40:19Z until the TRA-2817 inode prune at 2026-08-04T21:20Z.
 * For five days the box restored a five-day-old book on every boot. The only
 * symptom anyone noticed was three option rows flickering back onto a table for
 * ~90 seconds — filed as TRA-2816, a bug in the CLOSE path. It was not; the
 * close was perfectly durable. A five-day total loss of durability presented as
 * a 90-second UI flicker.
 *
 * `/api/health/storage` is the DISK axis: "is there room on the volume". TRA-2817
 * made it honest about inodes as well as blocks and that work is not in question
 * — but a write can fail with a healthy disk, and that payload reads green on the
 * write axis through all five ENOSPC days. This is a SEPARATE axis with a
 * SEPARATE verdict, deliberately: the whole point is that the two can disagree.
 * Do not fold this into `disk.*`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERAND INDEPENDENCE — the part that is load-bearing
 * ─────────────────────────────────────────────────────────────────────────────
 * The TRA-2641 / TRA-2924 lesson on this codebase is that a verdict goes green
 * when its operands quietly lose independence, and it reads exactly like "fixed".
 * So the staleness verdict is NEVER derived from a field the persist path writes
 * on success. If the writer is dead, such a field is stale in the same direction
 * and the verdict self-confirms.
 *
 * Three operands, three independent producers:
 *
 *   1. `lastTickAt`         ← the ENGINE tick hook. Fires whether or not the
 *                             write lands. This is the LIVENESS qualifier.
 *   2. `consecutiveFailures`← the in-process persist outcome counter (this file).
 *   3. `fileMtimeMs`        ← `stat()` of the snapshot file ON DISK, read by the
 *                             route at request time. Not written by this module,
 *                             not cached, not touched by the persist path except
 *                             as the side effect being measured.
 *
 * `lastSuccessAt` IS published (the CFO asked for it) but it is deliberately NOT
 * an operand of the verdict. `gradePersistRow` never reads it. There is a test
 * that mutates it to `now` on an otherwise-STALE row and asserts the verdict does
 * not move — see `tra3407-snapshot-persist-staleness.test.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRI-STATE, FAIL CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 * Same convention already load-bearing on `/api/health/pnl-reconciliation`:
 * `null` = NOT MEASURED and is NEVER read as green. Precedence is
 * RED > NOT MEASURED > GREEN, and the denominator is published alongside the
 * verdict — `stale: false` over 0 graded rows and over 61 graded rows are
 * different claims and without the denominator they are the same reading
 * (the TRA-2630 lesson).
 *
 * An unreadable mtime grades NOT MEASURED, never CURRENT.
 * A quiet box (no ticks) grades IDLE and is excluded from the denominator, so it
 * does not manufacture a STALE.
 * A dead writer on a LIVE box grades STALE. That is the whole deliverable.
 */

/** The two snapshot writers this axis grades. */
export type PersistAxis = 'stocks' | 'crypto';

/**
 * Nominal tick period per axis, in ms. `SignalEngine.start` arms a 30s tick
 * (`signal-engine.ts`), `CryptoSignalEngine.start` a 60s one (`crypto-engine.ts`).
 * Every tick schedules a persist unconditionally (`scheduleStocksPersist` /
 * `scheduleCryptoPersist`), so on a healthy writer the file's mtime advances
 * once per tick — which is what makes mtime age a valid staleness measure rather
 * than a proxy for "did anything change".
 */
export const AXIS_TICK_MS: Readonly<Record<PersistAxis, number>> = {
  stocks: 30_000,
  crypto: 60_000,
};

/**
 * How many tick intervals of silence make a LIVE writer STALE. 10 ticks is
 * 5 minutes on stocks / 10 on crypto — long enough that a single slow write or
 * a GC pause cannot trip it, short enough that the five-day ENOSPC incident
 * would have been red within minutes of the first failed write.
 */
export const STALENESS_TICKS = 10;

/**
 * How many tick intervals since the last observed tick still counts as LIVE.
 * Tighter than the staleness budget on purpose: a context must be demonstrably
 * ticking before its writer can be accused. 3 ticks tolerates one dropped tick
 * plus scheduling jitter.
 */
export const LIVENESS_TICKS = 3;

/** Per (context, axis) persist-outcome accounting. Counted, never folded. */
export interface PersistOutcomeRecord {
  username: string;
  axis: PersistAxis;
  /** ISO of the last write that RESOLVED successfully. Published, not graded. */
  lastSuccessAt: string | null;
  /** ISO of the last write that THREW. */
  lastFailureAt: string | null;
  /** Message of the last write that threw; survives a later success. */
  lastError: string | null;
  /** Reset to 0 by every success. Non-zero ⇒ the writer is failing RIGHT NOW. */
  consecutiveFailures: number;
  /** Lifetime totals for this process, so a flapping writer is distinguishable. */
  successes: number;
  failures: number;
  /**
   * ISO of the last ENGINE tick observed for this axis. Written by the tick hook,
   * NOT by the persist path — this is what separates "quiet box" from "dead
   * writer on a live box".
   */
  lastTickAt: string | null;
  /** Lifetime tick count for this axis in this process. */
  ticks: number;
}

/** Per-row verdict. `IDLE` is excluded from the graded denominator. */
export type PersistRowVerdict = 'STALE' | 'CURRENT' | 'NOT_MEASURED' | 'IDLE';

/** Why a row graded the way it did. Published so a red row is actionable. */
export type PersistRowReason =
  | 'persist-failing'
  | 'file-age'
  | 'file-unreadable'
  | 'no-tick-observed'
  // TRA-3432 — an IDLE row whose engine is switched OFF at the flag. Strictly a
  // REFINEMENT of `no-tick-observed`: same IDLE verdict, same exclusion from the
  // denominator, but it names a DELIBERATE dark engine rather than leaving the
  // reader to guess whether a writer died. See `engineEnabled` below.
  | 'engine-disabled'
  | 'fresh';

export interface PersistRowInput {
  username: string;
  axis: PersistAxis;
  lastTickAt: string | null;
  consecutiveFailures: number;
  /**
   * `stat().mtimeMs` of the snapshot file, read INDEPENDENTLY of this module.
   * `null` ⇔ the file is absent or the stat threw — that is NOT MEASURED, and it
   * must never grade CURRENT (fail closed).
   */
  fileMtimeMs: number | null;
  /** Published for context; NOT an operand. See the header note on independence. */
  lastSuccessAt?: string | null;
  /**
   * TRA-3432 — is the engine that drives this axis switched ON at all?
   * `false` ⇔ a master kill (crypto's TRA-1580 `CRYPTO_ENGINE_ENABLED`, off by
   * compiled default) means `start()` never arms the tick interval, so the tick
   * hook — and therefore the persist scheduler wired to it — can never fire.
   *
   * This is a LABEL, NOT AN OPERAND. It only refines the reason on a row that
   * ALREADY grades IDLE on the liveness qualifier; it can never turn a red row
   * green. That ordering is deliberate: were it checked first, a flag that read
   * `false` while the engine was in fact ticking would mask a genuinely failing
   * writer — swapping a visible red for a plausible-looking IDLE, which is the
   * exact class of defect this instrument exists to catch. Omitted ⇒ treated as
   * enabled, so a caller that forgets to pass it loses legibility, not safety.
   */
  engineEnabled?: boolean;
}

export interface PersistRowGrade {
  username: string;
  axis: PersistAxis;
  verdict: PersistRowVerdict;
  reason: PersistRowReason;
  /** Age of the ON-DISK file in seconds, or null when unreadable. */
  fileAgeSec: number | null;
  /** Seconds since the last observed engine tick, or null when none observed. */
  tickAgeSec: number | null;
  /** The budget this row was held to, in seconds. Published so it is auditable. */
  budgetSec: number;
  consecutiveFailures: number;
}

function ageSec(nowMs: number, thenMs: number): number {
  return Math.round(((nowMs - thenMs) / 1000) * 10) / 10;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Grade ONE (context, axis) row. Pure — no clock, no fs, no module state — so
 * the negative control can drive it directly and so the route and the
 * `pnpm check:snapshot-persist` gate cannot drift apart.
 *
 * Branch order is the contract:
 *   not live                → IDLE          (a quiet box never grades STALE)
 *   consecutiveFailures > 0 → STALE         (in-process counter alone; operand 2)
 *   mtime unreadable        → NOT_MEASURED  (fail closed; never CURRENT)
 *   mtime age > budget      → STALE         (on-disk read alone; operand 3)
 *   otherwise               → CURRENT
 *
 * Note that operands 2 and 3 each turn the row red ON THEIR OWN. Neither is
 * gated behind the other, so killing one producer cannot silently disarm the
 * verdict — that is the failure this issue exists to prevent.
 */
export function gradePersistRow(row: PersistRowInput, nowMs: number): PersistRowGrade {
  const tickMs = AXIS_TICK_MS[row.axis];
  const budgetMs = tickMs * STALENESS_TICKS;
  const livenessMs = tickMs * LIVENESS_TICKS;
  const tickMsAt = parseIsoMs(row.lastTickAt);
  const tickAgeSec = tickMsAt === null ? null : ageSec(nowMs, tickMsAt);
  const fileAgeSec = row.fileMtimeMs === null ? null : ageSec(nowMs, row.fileMtimeMs);
  const base = {
    username: row.username,
    axis: row.axis,
    fileAgeSec,
    tickAgeSec,
    budgetSec: budgetMs / 1000,
    consecutiveFailures: row.consecutiveFailures,
  };

  // LIVENESS QUALIFIER. A box nobody is ticking has no writer to accuse. This
  // is checked FIRST and off the tick hook, which is upstream of — and blind to
  // — whether the write itself landed.
  //
  // TRA-3432 — the reason (never the verdict) distinguishes the two ways a row
  // can be quiet: an engine deliberately switched off at the flag, versus a
  // ticking engine that simply has not ticked yet. `engineEnabled` is consulted
  // only INSIDE this already-IDLE branch, so it cannot suppress a red.
  const live = tickMsAt !== null && nowMs - tickMsAt <= livenessMs;
  if (!live) {
    return {
      ...base,
      verdict: 'IDLE',
      reason: row.engineEnabled === false ? 'engine-disabled' : 'no-tick-observed',
    };
  }

  // OPERAND 2, alone. The writer is throwing right now.
  if (row.consecutiveFailures > 0) return { ...base, verdict: 'STALE', reason: 'persist-failing' };

  // FAIL CLOSED. No mtime ⇒ we did not measure it. Never green.
  if (row.fileMtimeMs === null) {
    return { ...base, verdict: 'NOT_MEASURED', reason: 'file-unreadable' };
  }

  // OPERAND 3, alone. The bytes on disk have not moved inside the budget even
  // though the engine is ticking — which, on a healthy writer, is impossible.
  if (nowMs - row.fileMtimeMs > budgetMs) {
    return { ...base, verdict: 'STALE', reason: 'file-age' };
  }

  return { ...base, verdict: 'CURRENT', reason: 'fresh' };
}

export interface SnapshotPersistVerdict {
  /**
   * TRI-STATE. `true` = at least one live writer is STALE. `false` = every graded
   * row is CURRENT. `null` = NOT MEASURED (nothing gradeable, or something was
   * unreadable and no row was outright red). NEVER read `null` as a pass.
   */
  stale: boolean | null;
  /** `'STALE' | 'CURRENT' | null`, the same verdict in the route's words. */
  verdict: 'STALE' | 'CURRENT' | null;
  /** THE DENOMINATOR. Rows that could actually have produced a verdict. */
  gradedRowCount: number;
  /** Rows excluded because their context is not ticking. */
  idleRowCount: number;
  /** Rows whose on-disk mtime could not be read. */
  notMeasuredRowCount: number;
  staleRowCount: number;
  currentRowCount: number;
  /** Every row that graded STALE, per context — never folded to a scalar. */
  staleRows: PersistRowGrade[];
  /** Every row that graded NOT_MEASURED, per context. */
  notMeasuredRows: PersistRowGrade[];
}

/**
 * Fold the per-row grades. Precedence RED > NOT MEASURED > GREEN, and an EMPTY
 * graded cohort is `null`, not `false`.
 *
 * `[].every(...)` is `true` — the exact shape that let the TRA-2630 real-money
 * tripwire report OK over a cohort it never looked at. It is not spelled `every`
 * here for that reason.
 */
export function foldPersistVerdict(grades: PersistRowGrade[]): SnapshotPersistVerdict {
  const staleRows = grades.filter(g => g.verdict === 'STALE');
  const notMeasuredRows = grades.filter(g => g.verdict === 'NOT_MEASURED');
  const currentRows = grades.filter(g => g.verdict === 'CURRENT');
  const idleRows = grades.filter(g => g.verdict === 'IDLE');
  // The denominator counts rows that COULD have gone either way. IDLE rows could
  // not, so including them would let a fleet of quiet books dilute a real red.
  const gradedRowCount = staleRows.length + notMeasuredRows.length + currentRows.length;

  const stale: boolean | null = staleRows.length > 0
    ? true
    : notMeasuredRows.length > 0
      ? null
      : currentRows.length > 0
        ? false
        : null;

  return {
    stale,
    verdict: stale === true ? 'STALE' : stale === false ? 'CURRENT' : null,
    gradedRowCount,
    idleRowCount: idleRows.length,
    notMeasuredRowCount: notMeasuredRows.length,
    staleRowCount: staleRows.length,
    currentRowCount: currentRows.length,
    staleRows,
    notMeasuredRows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const outcomes = new Map<string, PersistOutcomeRecord>();

function key(username: string, axis: PersistAxis): string {
  return `${axis}:${username}`;
}

function ensureRecord(username: string, axis: PersistAxis): PersistOutcomeRecord {
  const k = key(username, axis);
  let rec = outcomes.get(k);
  if (!rec) {
    rec = {
      username,
      axis,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
      lastTickAt: null,
      ticks: 0,
    };
    outcomes.set(k, rec);
  }
  return rec;
}

/** Called from the engine tick hook — INDEPENDENT of whether the write lands. */
export function recordPersistTick(username: string, axis: PersistAxis, at: Date = new Date()): void {
  const rec = ensureRecord(username, axis);
  rec.lastTickAt = at.toISOString();
  rec.ticks += 1;
}

/** Called from the persist path when the write RESOLVES. Clears the streak. */
export function recordPersistSuccess(username: string, axis: PersistAxis, at: Date = new Date()): void {
  const rec = ensureRecord(username, axis);
  rec.lastSuccessAt = at.toISOString();
  rec.consecutiveFailures = 0;
  rec.successes += 1;
}

/**
 * Called from the persist path's catch. `lastError` deliberately SURVIVES a
 * later success (a writer that fails every other tick should still name its
 * error); `consecutiveFailures` is the field that says "failing right now".
 */
export function recordPersistFailure(
  username: string,
  axis: PersistAxis,
  err: unknown,
  at: Date = new Date(),
): void {
  const rec = ensureRecord(username, axis);
  rec.lastFailureAt = at.toISOString();
  rec.lastError = err instanceof Error ? err.message : String(err);
  rec.consecutiveFailures += 1;
  rec.failures += 1;
}

/** Snapshot of every (context, axis) record. Copies, so callers cannot mutate. */
export function getPersistOutcomes(): PersistOutcomeRecord[] {
  return Array.from(outcomes.values()).map(r => ({ ...r }));
}

/** One record, or `null` if that pair has never been touched. */
export function getPersistOutcome(username: string, axis: PersistAxis): PersistOutcomeRecord | null {
  const rec = outcomes.get(key(username, axis));
  return rec ? { ...rec } : null;
}

/** Drop a context's rows on delete-user, so a deleted book cannot grade forever. */
export function forgetPersistOutcomes(username: string): void {
  for (const axis of ['stocks', 'crypto'] as const) outcomes.delete(key(username, axis));
}

/** Test-only reset. The registry is process-global by design. */
export function __resetPersistOutcomesForTest(): void {
  outcomes.clear();
}
