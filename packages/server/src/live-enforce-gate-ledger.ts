// TRA-2048 (parent TRA-2044) — DURABLE enforcement telemetry for the two LIVE
// pre-trade gates promoted from shadow to ENFORCING (the cost-vs-edge bar and the
// liquidity / spread veto).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The CTO's assignment was explicit: "Do not silently enforce with no counter."
// A working admission gate's evidence is the trades that DIDN'T happen, so a live
// flip that rejects real orders is invisible from the fill tape alone — the exact
// trap that cost two demo sessions on the TRA-1476 quality gate (armed-but-inert,
// TRA-1486) and that the sibling cost-aware-gate ledger already guards for demo.
// This module makes the LIVE enforcement deterministic in one read:
//   • how many ARMED live evaluations each gate saw (allowed AND blocked), so an
//     armed-but-inert flip (`evaluated:0`) never reads the same as an armed gate
//     that saw candidates and passed them all (`evaluated>0, blocked:0`) or one
//     that is biting (`blocked>0`);
//   • split by gate (`cost_bar` / `spread`) and by scope (structure / symbol);
//   • whether any of it is actually ON DISK (the TRA-1681 durability caveat).
//
// The cost-aware-gate ledger is DELIBERATELY not reused: its header contract is
// that it is "structurally incapable of describing a live open," and graders read
// `/api/health/cost-aware-gate` as demo-only. Live enforcement records land here,
// on a separate axis and a separate `/api/health/live-enforce-gates` route.
//
// ── DURABILITY (TRA-1681 / TRA-1719) ─────────────────────────────────────────
// JSONL-appended under DATA_DIR, keyed by ET calendar day, rebuilt on boot. "A
// persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk; with DATA_DIR unset the fallback path is inside the build
// bundle and evaporates on redeploy with NO error to catch. `durability.ephemeral`
// (a property of the PATH, decisive on the first boot before a row exists) is
// published and MUST be read first.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-through accounting. NEVER places an order or mutates an account — it is
// a write-through of an enforcement decision the engine already made. Records are
// written ONLY from the engine's LIVE enforcing branches, which themselves bail
// unless the corresponding `ENABLE_OPTION_*_LIVE_ENFORCE` flag is armed — so every
// row reflects an ARMED LIVE evaluation. No balances / PII — gate, scope, ET day,
// and whether the order was blocked.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-enforce-gate-ledger' });

export const LIVE_ENFORCE_GATE_LOG_FILENAME = 'live-enforce-gate.jsonl';

/**
 * Retain this many ms of decisions on disk (compacted on boot). A month covers
 * reading enforcement back well after a bounded live window closes while bounding
 * a file that takes one line per armed live evaluation.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which live gate produced the record. `cost_bar` is the TRA-1602 modeled-gross-R
 * admission bar promoted to live enforcement; `spread` is the TRA-1967 liquidity /
 * spread veto (`SPREAD_TOO_WIDE` / thin-book / unusable-quote) enforced at the
 * live-options broker seam; `otm_delta_floor` is the TRA-2763 live arm of the
 * TRA-1407 OTM entry |delta| floor (the demo-only guard that left real money
 * running unfiltered at |delta| 0.03-0.07); `universe` is the TRA-3216 live OTM
 * underlying allowlist (the scan universe was the full ~614-name watchlist, so
 * real money opened on KVYO / TROW / ABCL because nothing restricted it).
 *
 * TRA-3394 adds the two CEILING axes. `entry_delta_ceiling` is the live arm of
 * the TRA-3392 upper band edge — the cut the cost bar is algebraically incapable
 * of making, since it is a floor. `entry_delta_ceiling_shadow` is the SAME
 * verdict recorded while the gate is dark: `blocked` there means WOULD HAVE
 * BLOCKED, and no live open was stopped. They are separate gates rather than one
 * gate with a mode field because a counter must report what the engine actually
 * did, not what the config intended (TRA-1682) — folding a shadow "block" into
 * the enforcing gate's `blocked` would claim a trade was prevented when it fired.
 *
 * TRA-3445 adds `aggregate_cap` — the board's "max $750 TOTAL" bound on the live
 * bounded-test sleeve, which until now had no enforcement path at all (every
 * other guard bounds a SINGLE entry). It is its own gate rather than a reason
 * code on an existing one for the usual reason: only a gate carries an
 * `evaluated` denominator, and "the cap never had to bite" (`evaluated > 0,
 * blocked: 0`) must not read the same as "the cap is inert" (`evaluated: 0`).
 */
export type LiveEnforceGate =
  | 'cost_bar'
  | 'spread'
  | 'otm_delta_floor'
  | 'universe'
  | 'entry_delta_ceiling'
  | 'entry_delta_ceiling_shadow'
  | 'aggregate_cap';

/** One durable ARMED-LIVE enforcement decision — a write-through of the verdict. */
export interface LiveEnforceRecord {
  /** Decision time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** Which gate ruled. */
  gate: LiveEnforceGate;
  /** For `cost_bar`, the structure (single_leg_rv / single_leg_otm / directional); for `spread` and `universe`, the underlying symbol. */
  scope: string;
  /** TRUE ⇒ the order was BLOCKED (rejected). FALSE ⇒ evaluated and allowed to proceed. */
  blocked: boolean;
  /** Human-readable rejection reason (present only when blocked). */
  reason?: string;
  /**
   * TRA-3216 — LOW-CARDINALITY classification of the block, present only when
   * blocked. `reason` above is per-candidate prose (it embeds the candidate's own
   * numbers), so folding on it yields one bucket per decision and answers
   * nothing. This is the tuneable axis: for `cost_bar` it says how far under the
   * bar the candidate fell, which is what turns "99.15% blocked" into "N of them
   * were within 0.10R of admission".
   */
  reasonCode?: string;
  /**
   * TRA-3216 — WHICH LIVE BOOK this verdict governed (the `alertUsername` the
   * options journal stamps as `account`, so this joins to the journal and to the
   * TRA-3117 per-book census without a translation table). A process-level flag
   * reads identically for a book it does not govern; this field is what makes the
   * fleet claim checkable. Absent ⇒ the call site could not attribute the book,
   * which folds to an explicit `unattributed` key rather than disappearing.
   */
  book?: string;
  /**
   * TRA-3391 — for `cost_bar`, WHICH tape cell (`structure::|delta| bucket`) the
   * verdict was decided under. The edge is no longer a per-candidate formula but
   * a lookup into a measured table, so "why did this block" is only answerable
   * with the cell identity: `insufficient_evidence` on `single_leg_otm::0.45-0.50`
   * and on `::0.00-0.10` are different facts about the book.
   *
   * Stamped on ADMITS too (unlike `reasonCode`) — the admitted cells are exactly
   * the ones a grader needs to check against the published table.
   *
   * Absent ⇒ the verdict predates this field or the gate does not use cells; that
   * folds to no `byCell` row at all rather than to a synthetic bucket, because
   * "never stamped" is not a cell.
   */
  cell?: string;
}

interface GateScopeTally {
  evaluated: number;
  blocked: number;
}

/** The per-gate accumulator: the same tally shape folded on four independent keys. */
interface GateTallies {
  /** structure (cost_bar) or underlying symbol (spread / universe). */
  byScope: Map<string, GateScopeTally>;
  /** normalized block classification — BLOCKED rows only (an admit has no reason). */
  byReason: Map<string, GateScopeTally>;
  /** live book (`alertUsername`), or `unattributed`. */
  byBook: Map<string, GateScopeTally>;
  /** TRA-3391 tape cell (`structure::bucket`) — rows that carry one, admits included. */
  byCell: Map<string, GateScopeTally>;
}

const UNATTRIBUTED_BOOK = 'unattributed';

function emptyTallies(): GateTallies {
  return { byScope: new Map(), byReason: new Map(), byBook: new Map(), byCell: new Map() };
}

function bump(map: Map<string, GateScopeTally>, key: string, blocked: boolean): void {
  let tally = map.get(key);
  if (!tally) {
    tally = { evaluated: 0, blocked: 0 };
    map.set(key, tally);
  }
  tally.evaluated += 1;
  if (blocked) tally.blocked += 1;
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-through. `dataDir` is set once at boot by
// hydrateLiveEnforceGateFromDisk so the engine chokepoints can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (gate -> per-axis tallies). */
const byDay = new Map<string, Map<LiveEnforceGate, GateTallies>>();
let decisionsTotal = 0;
let lastDecisionAt: number | null = null;
// TRA-1681 — durability provenance: `byDay` is fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
let hydratedRecords = 0;
let hydratedDays = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function liveEnforceGateLogPath(dir: string): string {
  return join(dir, LIVE_ENFORCE_GATE_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearLiveEnforceGateLedger(): void {
  dataDir = null;
  byDay.clear();
  decisionsTotal = 0;
  lastDecisionAt = null;
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
}

const GATES: LiveEnforceGate[] = [
  'cost_bar',
  'spread',
  'otm_delta_floor',
  'universe',
  // TRA-3394 — both ceiling axes are listed so each publishes a row at
  // `evaluated: 0` before it has ever fired. A gate that is absent from the
  // payload and a gate that is present-and-silent are the same JSON to a grader
  // otherwise, and this gate's expected healthy read is precisely
  // `evaluated > 0, blocked = 0` (n=20 above 0.55 on the whole tape).
  'entry_delta_ceiling',
  'entry_delta_ceiling_shadow',
  // TRA-3445 — same reasoning: publish a zero row so an aggregate cap that has
  // never been reached is distinguishable from one that is not wired in.
  'aggregate_cap',
];

/** Apply one decision to the in-memory tallies (shared by record + hydrate). */
function apply(rec: LiveEnforceRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  let tallies = day.get(rec.gate);
  if (!tallies) {
    tallies = emptyTallies();
    day.set(rec.gate, tallies);
  }
  bump(tallies.byScope, rec.scope, rec.blocked);
  bump(tallies.byBook, rec.book ?? UNATTRIBUTED_BOOK, rec.blocked);
  // Blocked rows ONLY: an admitted candidate has no rejection classification, and
  // folding admits into this axis under a synthetic "admitted" key would make the
  // dominant bucket of every gate the one that explains nothing.
  if (rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== '') {
    bump(tallies.byReason, rec.reasonCode, true);
  }
  // TRA-3391 — cell axis, admits INCLUDED (`bump` counts evaluated and, when
  // blocked, blocked). Only rows that actually carry a cell contribute: a missing
  // cell is "never stamped", not a bucket.
  if (typeof rec.cell === 'string' && rec.cell !== '') {
    bump(tallies.byCell, rec.cell, rec.blocked);
  }
  decisionsTotal += 1;
  lastDecisionAt = rec.ts;
}

/**
 * Record one ARMED-LIVE gate decision and append one JSONL line under the
 * configured DATA_DIR. Best-effort on IO — a write failure logs, is COUNTED
 * (`appendErrors`), and is swallowed so this accounting can never break a live
 * order path. When no dataDir is configured (unit tests / CLI without boot) the
 * in-memory counts still update; only the file write is skipped.
 */
export function recordLiveEnforceDecision(
  gate: LiveEnforceGate,
  scope: string,
  blocked: boolean,
  etDay: string,
  reason?: string,
  now: number = Date.now(),
  // TRA-3216 — trailing options bag so the three pre-existing call sites keep
  // their positional signature unchanged.
  opts?: { reasonCode?: string; book?: string | null; cell?: string | null },
): void {
  const rec: LiveEnforceRecord = {
    ts: now,
    etDay,
    gate,
    scope,
    blocked,
    ...(blocked && reason ? { reason } : {}),
    ...(blocked && opts?.reasonCode ? { reasonCode: opts.reasonCode } : {}),
    ...(typeof opts?.book === 'string' && opts.book !== '' ? { book: opts.book } : {}),
    ...(typeof opts?.cell === 'string' && opts.cell !== '' ? { cell: opts.cell } : {}),
  };
  applyAndAppend(rec);
}

function applyAndAppend(rec: LiveEnforceRecord): void {
  // In-memory tally updates FIRST and UNCONDITIONALLY, then the disk write is
  // attempted best-effort — so accounting can never break a live order pass. But
  // that means the counters are NOT proof anything reached disk: `durability`
  // below is the field that tells a memory-only / failed-append ledger apart from a
  // clean durable write (TRA-1681).
  apply(rec);
  if (dataDir == null) return;
  const path = liveEnforceGateLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-enforce-gate append failed', { reason: lastAppendError });
  }
}

/** What {@link hydrateLiveEnforceGateFromDisk} recovered (for the boot log line). */
export interface LiveEnforceGateHydration {
  days: number;
  records: number;
}

/**
 * Rebuild the in-memory tallies from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call once at
 * startup before any live pass. Only records within {@link RETAIN_MS} of `now` are
 * kept, and the file is COMPACTED to exactly those lines. Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped.
 */
export function hydrateLiveEnforceGateFromDisk(dir: string, now: number = Date.now()): LiveEnforceGateHydration {
  clearLiveEnforceGateLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveEnforceGateLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: LiveEnforceRecord;
    try {
      rec = JSON.parse(trimmed) as LiveEnforceRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (!GATES.includes(rec.gate)) continue;
    if (typeof rec.scope !== 'string' || rec.scope === '') continue;
    if (typeof rec.blocked !== 'boolean') continue;
    const clean: LiveEnforceRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      gate: rec.gate,
      scope: rec.scope,
      blocked: rec.blocked,
      ...(rec.blocked && typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
      // TRA-3216 — rows written before these fields existed simply lack them; they
      // hydrate into the `unattributed` book and contribute no byReason row, which
      // is the honest reading (the classification was never recorded), not a zero.
      ...(rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== ''
        ? { reasonCode: rec.reasonCode }
        : {}),
      ...(typeof rec.book === 'string' && rec.book !== '' ? { book: rec.book } : {}),
      ...(typeof rec.cell === 'string' && rec.cell !== '' ? { cell: rec.cell } : {}),
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped
  // when there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = liveEnforceGateLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-enforce-gate compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
  return { days: byDay.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface LiveEnforceScopeSummary {
  scope: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; **`null` when the gate ruled on nothing** (not 0 — TRA-1707/TRA-1682). */
  blockRate: number | null;
}

/**
 * TRA-3216 — the tuning axis. One row per normalized block classification,
 * heaviest first. **Blocks only** — `share` is of this gate's BLOCKED total, so
 * the rows sum to 1 and read directly as "which term dominated".
 */
export interface LiveEnforceReasonSummary {
  reasonCode: string;
  blocked: number;
  /** blocked / (this gate's blocked total); `null` when the gate blocked nothing. */
  share: number | null;
}

/**
 * TRA-3216 — the FLEET axis. One row per live book (`alertUsername`) the gate
 * actually ruled for, plus `unattributed` for verdicts whose call site could not
 * name a book. A process-level flag reads identically for a book it does not
 * govern; this is the split that tells the two apart.
 */
export interface LiveEnforceBookSummary {
  book: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

/**
 * TRA-3391 — the EVIDENCE axis. One row per tape cell (`structure::|delta|
 * bucket`) the gate decided under, busiest first. Unlike `byReason` this counts
 * ADMITS too: an admitted cell is exactly what a grader checks against the
 * published expectancy table, and a cell that only ever appears with
 * `evaluated === blocked` is one the live universe has never had evidence for.
 *
 * Empty on a gate that stamps no cell (`spread`, `universe`, `otm_delta_floor`)
 * and on rows written before the field existed — never a synthetic bucket.
 */
export interface LiveEnforceCellSummary {
  cell: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

export interface LiveEnforceGateSummary {
  gate: LiveEnforceGate;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /** Per-scope split, busiest first. */
  byScope: LiveEnforceScopeSummary[];
  /** Per-reason split of the BLOCKS, heaviest first (TRA-3216). */
  byReason: LiveEnforceReasonSummary[];
  /** Per-live-book split, busiest first (TRA-3216). */
  byBook: LiveEnforceBookSummary[];
  /** Per-tape-cell split, busiest first; admits included (TRA-3391). */
  byCell: LiveEnforceCellSummary[];
}

export interface LiveEnforceDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every count in this payload dies on the next redeploy (fix = DATA_DIR=/data). */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real floor from this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the counters overstate what is on disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

export interface LiveEnforceSummary {
  /** Total decisions recorded (live + hydrated, across retained days). */
  decisionsRecorded: number;
  /** Per-gate fold for the requested ET day. */
  byGate: LiveEnforceGateSummary[];
  /** Same fold across EVERY retained ET day (a one-day counter self-clears at midnight). */
  retained: {
    etDays: string[];
    retentionDays: number;
    byGate: LiveEnforceGateSummary[];
  };
  durability: LiveEnforceDurability;
  lastDecisionAt: number | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Fold a gate->tallies map for one or more days into the per-gate rows. */
function foldGates(acc: Map<LiveEnforceGate, GateTallies>): LiveEnforceGateSummary[] {
  const out: LiveEnforceGateSummary[] = [];
  for (const gate of GATES) {
    const tallies = acc.get(gate) ?? emptyTallies();
    let evaluated = 0;
    let blocked = 0;
    const byScope: LiveEnforceScopeSummary[] = [];
    for (const [scope, t] of tallies.byScope.entries()) {
      evaluated += t.evaluated;
      blocked += t.blocked;
      byScope.push({
        scope,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byScope.sort((a, b) => b.evaluated - a.evaluated);

    const byBook: LiveEnforceBookSummary[] = [];
    for (const [book, t] of tallies.byBook.entries()) {
      byBook.push({
        book,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byBook.sort((a, b) => b.evaluated - a.evaluated);

    // `share` denominator is the gate's BLOCKED total (from byScope, which counts
    // every row) — NOT the sum of the byReason rows. Using the rows' own sum would
    // silently renormalize away any block that carried no classification, making
    // partial coverage read as complete.
    const byReason: LiveEnforceReasonSummary[] = [];
    for (const [reasonCode, t] of tallies.byReason.entries()) {
      byReason.push({
        reasonCode,
        blocked: t.blocked,
        share: blocked > 0 ? round(t.blocked / blocked) : null,
      });
    }
    byReason.sort((a, b) => b.blocked - a.blocked);

    const byCell: LiveEnforceCellSummary[] = [];
    for (const [cell, t] of tallies.byCell.entries()) {
      byCell.push({
        cell,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byCell.sort((a, b) => b.evaluated - a.evaluated || a.cell.localeCompare(b.cell));

    out.push({
      gate,
      evaluated,
      blocked,
      blockRate: evaluated > 0 ? round(blocked / evaluated) : null,
      byScope,
      byReason,
      byBook,
      byCell,
    });
  }
  return out;
}

/** Merge one axis map into an accumulator. */
function mergeAxis(into: Map<string, GateScopeTally>, from: Map<string, GateScopeTally>): void {
  for (const [key, t] of from.entries()) {
    const cur = into.get(key) ?? { evaluated: 0, blocked: 0 };
    cur.evaluated += t.evaluated;
    cur.blocked += t.blocked;
    into.set(key, cur);
  }
}

/** Merge every retained day into one gate->tallies accumulator. */
function accumulateAllDays(): Map<LiveEnforceGate, GateTallies> {
  const acc = new Map<LiveEnforceGate, GateTallies>();
  for (const day of byDay.values()) {
    for (const [gate, tallies] of day.entries()) {
      let into = acc.get(gate);
      if (!into) {
        into = emptyTallies();
        acc.set(gate, into);
      }
      mergeAxis(into.byScope, tallies.byScope);
      mergeAxis(into.byReason, tallies.byReason);
      mergeAxis(into.byBook, tallies.byBook);
      mergeAxis(into.byCell, tallies.byCell);
    }
  }
  return acc;
}

/**
 * Fold the store into the read-only health diagnostics for `etDay`. Pure — no IO.
 * An all-zero read on an ARMED gate means it saw no live candidates this day, NOT
 * that it is inert; `blocked > 0` is the direct evidence it is biting, and
 * `evaluated > 0 with blocked === 0` is an armed gate that passed everything.
 */
export function summarizeLiveEnforceGate(etDay: string): LiveEnforceSummary {
  const day = byDay.get(etDay) ?? new Map<LiveEnforceGate, GateTallies>();
  return {
    decisionsRecorded: decisionsTotal,
    byGate: foldGates(day),
    retained: {
      etDays: [...byDay.keys()].sort(),
      retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
      byGate: foldGates(accumulateAllDays()),
    },
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
    lastDecisionAt,
  };
}
