/**
 * TRA-5061 AC1 — the DURABLE half of the side-by-side ATR shadow.
 *
 * ── Why a since-boot counter would not have answered the question ──────────
 *
 * The instrument exists to tell the board, BEFORE anything arms, how often the
 * daily chandelier trail would even have had a level. That is a question about
 * a RATE over sessions, and a boot-scoped counter cannot accumulate a rate: it
 * answers "since the last restart", which on this service is often "since a few
 * minutes ago".
 *
 * Measured 2026-10-02 on live bqb1 `104bc8ed`: the graded process booted at
 * 12:51:47Z — AFTER the 10-01 close — so the live surface's own
 * `sessionCoverage` already read `boot_after_close` with
 * `zeroReading: "vacuous"` (TRA-4343). A since-boot-only shadow shipped that
 * morning would have published a 0 whose only content was the boot time, and
 * TRA-3926's carrier documents exactly where that road ends: a boot-scoped
 * census on that box read `checked = 0` for **37 days** after its subject
 * deployed, and would have read the same on day 400.
 *
 * So the counts are partitioned by ET DAY and written where a restart cannot
 * reach them, and the pre-registered stop ("<20 ratchets over 10 consecutive ET
 * sessions ⇒ the shadow cannot be fed either") becomes a query against this
 * file rather than a question nobody can answer.
 *
 * ── Snapshot semantics, and why they are exact ─────────────────────────────
 *
 * A line is a CUMULATIVE SNAPSHOT of one `(etDay, book)` key, not a delta. The
 * fold takes the NEWEST line per key, so:
 *
 *   • a day's total is one line, whatever the boot history;
 *   • summing the per-key totals across days double-counts nothing;
 *   • a lost or torn tail loses at most the most recent flush window, never an
 *     earlier day — and never corrupts an earlier day's total, which a
 *     delta-encoded log would.
 *
 * The one thing snapshots require is that the in-memory counters CONTINUE the
 * day rather than restart it, which is why
 * {@link readChandelierAtrShadowDay} exists and why the ledger seeds from it on
 * first touch. Without that seed a mid-session boot would write a snapshot that
 * REGRESSES the day's total — a silent undercount, which is the same shape as
 * the defect this file is here to remove.
 *
 * ── Growth ────────────────────────────────────────────────────────────────
 *
 * The exit pass ratchets every tick, so an unthrottled "append when the numbers
 * change" would append on every tick a row is open. Two rules bound it:
 *
 *   1. {@link SHADOW_FLUSH_INTERVAL_MS} — at most one routine snapshot per key
 *      per interval. Safe precisely because lines are snapshots: a skipped
 *      flush is superseded by the next one.
 *   2. A MILESTONE flushes immediately, bypassing the interval — the first
 *      observation, the first daily resolution, the first 3.5 on the daily arm,
 *      the first cold daily series, the first multiplier disagreement. These
 *      are the qualitative "it happened at all" facts the arm decision turns
 *      on, and a crash inside the flush window must not be able to lose one.
 *
 * A flat book writes NOTHING: with no open rows there are no ratchets, no
 * counter moves and no signature change. That is the common case today and it
 * is why the cap below is generous rather than tight.
 *
 * `SHADOW_MAX_LINES` is a hard stop, not a rotation: at the cap this store
 * STOPS APPENDING and counts the drops, because the earliest lines carry the
 * earliest sessions and a carrier that discards its oldest testimony to make
 * room for more is not a carrier. A non-zero `droppedAtCap` needs a human, and
 * the cap is published so a reader never has to guess it.
 *
 * ⛔ OBSERVE-ONLY, and best-effort on IO: every write is wrapped and counted.
 * An observability carrier that could throw into the exit path would be a guard
 * that closes positions by failing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { CHANDELIER_SKIP_REASONS, type ChandelierSkipReason } from './option-chandelier-trail.js';
// ⚠ TYPE-ONLY. `tra5061-chandelier-atr-shadow.ts` imports this module's
// functions at runtime, so a value import back would close an ESM cycle.
// `import type` is erased at compile time.
import type {
  ChandelierAtrShadowBook,
  ChandelierAtrShadowTally,
  ChandelierAtrShadowArmTally,
} from './tra5061-chandelier-atr-shadow.js';

const log = logger.child({ module: 'tra5061-chandelier-atr-shadow-store' });

export const CHANDELIER_ATR_SHADOW_LOG_FILENAME = 'tra5061-chandelier-atr-shadow.jsonl';

/** Hard ceiling on stored lines. Read it off this constant, never off a recalled number. */
export const SHADOW_MAX_LINES = 20_000;

/** Minimum gap between ROUTINE snapshots of one key. Milestones bypass it. */
export const SHADOW_FLUSH_INTERVAL_MS = 5 * 60_000;

/**
 * The ARMING marker, written once when this store is first pointed at a
 * DATA_DIR.
 *
 * Without it an empty store is ambiguous in the one direction that matters: it
 * reads identically whether the carrier has watched this box for ten sessions
 * and seen no ratchet, or was installed ninety seconds ago. TRA-3926's sibling
 * carrier recorded a grader asserting "a measured never across every boot this
 * DATA_DIR has survived" six minutes after installation — false, and falsely
 * reassuring. `armedAt` makes the claim exactly as strong as the evidence: a
 * never SINCE A STATED INSTANT, which is worth nothing on day one and a great
 * deal on day ten.
 */
export interface ChandelierAtrShadowArmedLine {
  kind: 'armed';
  at: number;
}

export interface ChandelierAtrShadowSnapshotLine {
  kind: 'chandelier-atr-shadow';
  /** ms epoch of this snapshot. */
  at: number;
  /** ET calendar day (`YYYY-MM-DD`) the counters belong to. */
  etDay: string;
  book: ChandelierAtrShadowBook;
  /** The day's CUMULATIVE counters as of `at`. Snapshot, not a delta. */
  counters: ChandelierAtrShadowTally;
}

type ShadowLine = ChandelierAtrShadowArmedLine | ChandelierAtrShadowSnapshotLine;

let dataDir: string | null = null;
let droppedAtCap = 0;

/** Per-key flush bookkeeping for THIS boot. */
const lastFlushAtByKey = new Map<string, number>();
const lastSignatureByKey = new Map<string, string>();
/** Milestones already flushed for a key, so each forces at most one extra append. */
const milestonesByKey = new Map<string, Set<string>>();

export function chandelierAtrShadowLogPath(dir: string): string {
  return join(dir, CHANDELIER_ATR_SHADOW_LOG_FILENAME);
}

function storeKey(etDay: string, book: ChandelierAtrShadowBook): string {
  return `${etDay}|${book}`;
}

/**
 * Point the store at a DATA_DIR and stamp the arming line if this dir has never
 * carried one.
 *
 * Best-effort and never throws: an arming stamp that could break a boot would
 * be a worse defect than the ambiguity it removes. A dir whose stamp could not
 * be written reports `armedAt: null`, which a reader must take as "this store's
 * own start is UNKNOWN" — never as "since forever".
 */
export function setChandelierAtrShadowDataDir(dir: string | null): void {
  dataDir = dir;
  lastFlushAtByKey.clear();
  lastSignatureByKey.clear();
  milestonesByKey.clear();
  if (dir == null) return;
  const path = chandelierAtrShadowLogPath(dir);
  try {
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    const line: ChandelierAtrShadowArmedLine = { kind: 'armed', at: Date.now() };
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
  } catch (err) {
    log.warn('tra5061 chandelier-atr-shadow arming stamp failed — the store cannot date its own zero', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export function chandelierAtrShadowDroppedAtCap(): number {
  return droppedAtCap;
}

/** Test seam — the cap counter and flush caches are process state. */
export function resetChandelierAtrShadowStoreForTests(): void {
  droppedAtCap = 0;
  lastFlushAtByKey.clear();
  lastSignatureByKey.clear();
  milestonesByKey.clear();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Coerce a stored arm tally into this build's shape.
 *
 * Defensive on purpose: a line written by an older or newer build may be
 * missing a field this build folds, and a missing count must read as 0 rather
 * than as `NaN` — one `NaN` would poison every total downstream of it and the
 * damage would be invisible on the route.
 */
function normalizeArm(raw: unknown): ChandelierAtrShadowArmTally {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    resolved: num(r.resolved),
    highBeta: num(r.highBeta),
    base: num(r.base),
    baseAtrPctAbsent: num(r.baseAtrPctAbsent),
    coldSeries: num(r.coldSeries),
    noPositiveAtr: num(r.noPositiveAtr),
    minAtrPct: numOrNull(r.minAtrPct),
    maxAtrPct: numOrNull(r.maxAtrPct),
    halfWidthUsdSum: num(r.halfWidthUsdSum),
    halfWidthSamples: num(r.halfWidthSamples),
  };
}

function normalizeTally(raw: unknown): ChandelierAtrShadowTally {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawSkipped = (r.rowsSkipped ?? {}) as Record<string, unknown>;
  const rowsSkipped = {} as Record<ChandelierSkipReason, number>;
  for (const reason of CHANDELIER_SKIP_REASONS) rowsSkipped[reason] = num(rawSkipped[reason]);
  const rawRatio = (r.widthRatio ?? {}) as Record<string, unknown>;
  return {
    rowsSeen: num(r.rowsSeen),
    observations: num(r.observations),
    pairAbsent: num(r.pairAbsent),
    rowsSkipped,
    shadow5m: normalizeArm(r.shadow5m),
    daily: normalizeArm(r.daily),
    multiplierDisagreements: num(r.multiplierDisagreements),
    widthRatio: {
      sum: num(rawRatio.sum),
      samples: num(rawRatio.samples),
      min: numOrNull(rawRatio.min),
      max: numOrNull(rawRatio.max),
    },
  };
}

export interface ChandelierAtrShadowRead {
  snapshots: ChandelierAtrShadowSnapshotLine[];
  rawLines: number;
  /** Lines this build understood — snapshots PLUS the arming stamp. */
  understood: number;
  armedAt: number | null;
}

/**
 * Read every stored line. Corrupt lines are skipped HERE and counted by the
 * `rawLines` vs `understood` delta, never folded into a clean answer.
 */
export function readChandelierAtrShadow(): ChandelierAtrShadowRead {
  const empty: ChandelierAtrShadowRead = { snapshots: [], rawLines: 0, understood: 0, armedAt: null };
  if (dataDir == null) return empty;
  let raw: string;
  try {
    raw = readFileSync(chandelierAtrShadowLogPath(dataDir), 'utf8');
  } catch {
    return empty;
  }
  const snapshots: ChandelierAtrShadowSnapshotLine[] = [];
  let rawLines = 0;
  let understood = 0;
  let armedAt: number | null = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    rawLines += 1;
    try {
      const parsed = JSON.parse(line) as ShadowLine;
      // The arming stamp is UNDERSTOOD, not damage — counting it against
      // `understood` would make a healthy store read as damaged on its first read.
      if (parsed && parsed.kind === 'armed' && typeof parsed.at === 'number') {
        understood += 1;
        if (armedAt === null || parsed.at < armedAt) armedAt = parsed.at;
      } else if (
        parsed
        && parsed.kind === 'chandelier-atr-shadow'
        && typeof parsed.etDay === 'string'
        && (parsed.book === 'live' || parsed.book === 'demo')
        && typeof parsed.at === 'number'
      ) {
        understood += 1;
        snapshots.push({
          kind: 'chandelier-atr-shadow',
          at: parsed.at,
          etDay: parsed.etDay,
          book: parsed.book,
          counters: normalizeTally(parsed.counters),
        });
      }
    } catch {
      // surfaced as a rawLines/understood mismatch, never swallowed
    }
  }
  return { snapshots, rawLines, understood, armedAt };
}

/**
 * The stored CUMULATIVE total for one `(etDay, book)`, or `null` if this day has
 * none — the seed that lets a fresh process continue a day instead of
 * restarting it.
 *
 * Reads the file. Called once per key per boot (the ledger memoizes the seed),
 * never on the ratchet path.
 */
export function readChandelierAtrShadowDay(
  etDay: string,
  book: ChandelierAtrShadowBook,
): ChandelierAtrShadowTally | null {
  if (dataDir == null) return null;
  const { snapshots } = readChandelierAtrShadow();
  let newest: ChandelierAtrShadowSnapshotLine | null = null;
  for (const s of snapshots) {
    if (s.etDay !== etDay || s.book !== book) continue;
    if (newest === null || s.at >= newest.at) newest = s;
  }
  return newest ? newest.counters : null;
}

/**
 * The change detector. Only the counts a reader would act on go in — the
 * running sums (`halfWidthUsdSum`, `widthRatio.sum`) are deliberately EXCLUDED,
 * because they move on literally every ratchet and including them would make
 * the signature change every tick, defeating the throttle it feeds.
 */
function snapshotSignature(t: ChandelierAtrShadowTally): string {
  const arm = (a: ChandelierAtrShadowArmTally): string => [
    a.resolved, a.highBeta, a.base, a.baseAtrPctAbsent, a.coldSeries, a.noPositiveAtr,
  ].join(',');
  return [
    t.rowsSeen,
    t.observations,
    t.pairAbsent,
    CHANDELIER_SKIP_REASONS.map((r) => t.rowsSkipped[r]).join(','),
    arm(t.shadow5m),
    arm(t.daily),
    t.multiplierDisagreements,
    t.widthRatio.samples,
  ].join('|');
}

/**
 * The qualitative facts that must survive a crash inside the flush window.
 *
 * Each fires at most once per key. These are "did it EVER happen" readings —
 * the ones the arm decision turns on — and unlike a rate they cannot be
 * recovered by a later snapshot if the process dies before one lands.
 */
function milestones(t: ChandelierAtrShadowTally): string[] {
  const out: string[] = [];
  if (t.observations > 0) out.push('first_observation');
  if (t.daily.resolved > 0) out.push('first_daily_resolved');
  if (t.daily.highBeta > 0) out.push('first_daily_high_beta');
  if (t.daily.coldSeries > 0) out.push('first_daily_cold');
  if (t.shadow5m.highBeta > 0) out.push('first_5m_high_beta');
  if (t.multiplierDisagreements > 0) out.push('first_multiplier_disagreement');
  if (t.pairAbsent > 0) out.push('first_pair_absent');
  return out;
}

/**
 * Persist one `(etDay, book)` snapshot, throttled.
 *
 * Called on EVERY note, so the unchanged/too-soon path must not touch disk —
 * it returns on in-memory state alone.
 *
 * ⚠ Hand this the LIVE counters the instrument is accruing, not a
 * re-derivation. A durable carrier fed from a spy diverges from the behaviour
 * it exists to preserve (TRA-3730).
 */
export function persistChandelierAtrShadowDay(
  etDay: string,
  book: ChandelierAtrShadowBook,
  counters: ChandelierAtrShadowTally,
  nowMs: number = Date.now(),
): { appended: boolean; throttled: boolean; unchanged: boolean; dropped: boolean; appendError: boolean } {
  const miss = { appended: false, throttled: false, unchanged: false, dropped: false, appendError: false };
  if (dataDir == null) return miss;
  const key = storeKey(etDay, book);
  const signature = snapshotSignature(counters);
  if (lastSignatureByKey.get(key) === signature) return { ...miss, unchanged: true };

  // A milestone bypasses the interval; anything else waits for it.
  const seen = milestonesByKey.get(key) ?? new Set<string>();
  const pendingMilestones = milestones(counters).filter((m) => !seen.has(m));
  if (pendingMilestones.length === 0) {
    const last = lastFlushAtByKey.get(key);
    if (last !== undefined && nowMs - last < SHADOW_FLUSH_INTERVAL_MS) {
      return { ...miss, throttled: true };
    }
  }

  const { snapshots } = readChandelierAtrShadow();
  if (snapshots.length >= SHADOW_MAX_LINES) {
    droppedAtCap += 1;
    log.warn('tra5061 chandelier-atr-shadow store at cap — snapshot NOT captured', {
      component: 'option-chandelier-atr-shadow',
      issue: 'TRA-5061',
      cap: SHADOW_MAX_LINES,
      etDay,
      book,
      note: 'the store stops appending rather than discard its oldest sessions; this file needs a human',
    });
    return { ...miss, dropped: true };
  }

  const line: ChandelierAtrShadowSnapshotLine = {
    kind: 'chandelier-atr-shadow',
    at: nowMs,
    etDay,
    book,
    counters,
  };
  const path = chandelierAtrShadowLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
    lastSignatureByKey.set(key, signature);
    lastFlushAtByKey.set(key, nowMs);
    for (const m of pendingMilestones) seen.add(m);
    milestonesByKey.set(key, seen);
    return { ...miss, appended: true };
  } catch (err) {
    log.warn('tra5061 chandelier-atr-shadow append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ...miss, appendError: true };
  }
}

export interface ChandelierAtrShadowDurableDay {
  etDay: string;
  book: ChandelierAtrShadowBook;
  counters: ChandelierAtrShadowTally;
  /** Snapshots stored for this key. > 1 is history, never an overwrite. */
  snapshots: number;
  firstAt: number;
  lastAt: number;
}

export interface ChandelierAtrShadowDurableRead {
  dataDir: string | null;
  /** `true` ⇒ this DATA_DIR does not survive a redeploy, so the "durable" half is not. */
  ephemeral: boolean;
  lines: number;
  /** `lines - parsed > 0` ⇒ the file is damaged. */
  parsed: number;
  /**
   * When this DATA_DIR was first armed. **Read it before believing a zero.**
   * `null` means the stamp could not be written or has been lost, i.e. this
   * store's own start is UNKNOWN — never "since forever".
   */
  armedAt: number | null;
  cap: number;
  droppedAtCap: number;
  /** Newest snapshot per `(etDay, book)`, oldest day first. */
  days: ChandelierAtrShadowDurableDay[];
}

/** Fold the store: newest snapshot per `(etDay, book)` wins. */
export function readChandelierAtrShadowDurable(): ChandelierAtrShadowDurableRead {
  const { snapshots, rawLines, understood, armedAt } = readChandelierAtrShadow();
  const byKey = new Map<string, ChandelierAtrShadowSnapshotLine[]>();
  for (const s of snapshots) {
    const k = storeKey(s.etDay, s.book);
    const g = byKey.get(k);
    if (g) g.push(s);
    else byKey.set(k, [s]);
  }
  const days: ChandelierAtrShadowDurableDay[] = [];
  for (const group of byKey.values()) {
    const ordered = [...group].sort((a, b) => a.at - b.at);
    const newest = ordered[ordered.length - 1]!;
    days.push({
      etDay: newest.etDay,
      book: newest.book,
      counters: newest.counters,
      snapshots: ordered.length,
      firstAt: ordered[0]!.at,
      lastAt: newest.at,
    });
  }
  days.sort((a, b) => (a.etDay < b.etDay ? -1 : a.etDay > b.etDay ? 1 : a.book < b.book ? -1 : 1));
  return {
    dataDir,
    ephemeral: dataDir === null ? true : isEphemeralDataDir(dataDir),
    lines: rawLines,
    parsed: understood,
    armedAt,
    cap: SHADOW_MAX_LINES,
    droppedAtCap,
    days,
  };
}
