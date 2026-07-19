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
 * live-options broker seam.
 */
export type LiveEnforceGate = 'cost_bar' | 'spread';

/** One durable ARMED-LIVE enforcement decision — a write-through of the verdict. */
export interface LiveEnforceRecord {
  /** Decision time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** Which gate ruled. */
  gate: LiveEnforceGate;
  /** For `cost_bar`, the structure (single_leg_rv / single_leg_otm / directional); for `spread`, the underlying symbol. */
  scope: string;
  /** TRUE ⇒ the order was BLOCKED (rejected). FALSE ⇒ evaluated and allowed to proceed. */
  blocked: boolean;
  /** Human-readable rejection reason (present only when blocked). */
  reason?: string;
}

interface GateScopeTally {
  evaluated: number;
  blocked: number;
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-through. `dataDir` is set once at boot by
// hydrateLiveEnforceGateFromDisk so the engine chokepoints can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (gate -> (scope -> tally)). */
const byDay = new Map<string, Map<LiveEnforceGate, Map<string, GateScopeTally>>>();
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

const GATES: LiveEnforceGate[] = ['cost_bar', 'spread'];

/** Apply one decision to the in-memory tallies (shared by record + hydrate). */
function apply(rec: LiveEnforceRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  let scopes = day.get(rec.gate);
  if (!scopes) {
    scopes = new Map();
    day.set(rec.gate, scopes);
  }
  let tally = scopes.get(rec.scope);
  if (!tally) {
    tally = { evaluated: 0, blocked: 0 };
    scopes.set(rec.scope, tally);
  }
  tally.evaluated += 1;
  if (rec.blocked) tally.blocked += 1;
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
): void {
  const rec: LiveEnforceRecord = {
    ts: now,
    etDay,
    gate,
    scope,
    blocked,
    ...(blocked && reason ? { reason } : {}),
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
    if (rec.gate !== 'cost_bar' && rec.gate !== 'spread') continue;
    if (typeof rec.scope !== 'string' || rec.scope === '') continue;
    if (typeof rec.blocked !== 'boolean') continue;
    const clean: LiveEnforceRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      gate: rec.gate,
      scope: rec.scope,
      blocked: rec.blocked,
      ...(rec.blocked && typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
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

export interface LiveEnforceGateSummary {
  gate: LiveEnforceGate;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /** Per-scope split, busiest first. */
  byScope: LiveEnforceScopeSummary[];
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

/** Fold a gate->(scope->tally) map for one or more days into the per-gate rows. */
function foldGates(acc: Map<LiveEnforceGate, Map<string, GateScopeTally>>): LiveEnforceGateSummary[] {
  const out: LiveEnforceGateSummary[] = [];
  for (const gate of GATES) {
    const scopes = acc.get(gate) ?? new Map<string, GateScopeTally>();
    let evaluated = 0;
    let blocked = 0;
    const byScope: LiveEnforceScopeSummary[] = [];
    for (const [scope, t] of scopes.entries()) {
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
    out.push({
      gate,
      evaluated,
      blocked,
      blockRate: evaluated > 0 ? round(blocked / evaluated) : null,
      byScope,
    });
  }
  return out;
}

/** Merge every retained day into one gate->(scope->tally) accumulator. */
function accumulateAllDays(): Map<LiveEnforceGate, Map<string, GateScopeTally>> {
  const acc = new Map<LiveEnforceGate, Map<string, GateScopeTally>>();
  for (const day of byDay.values()) {
    for (const [gate, scopes] of day.entries()) {
      let into = acc.get(gate);
      if (!into) {
        into = new Map();
        acc.set(gate, into);
      }
      for (const [scope, t] of scopes.entries()) {
        const cur = into.get(scope) ?? { evaluated: 0, blocked: 0 };
        cur.evaluated += t.evaluated;
        cur.blocked += t.blocked;
        into.set(scope, cur);
      }
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
  const day = byDay.get(etDay) ?? new Map<LiveEnforceGate, Map<string, GateScopeTally>>();
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
