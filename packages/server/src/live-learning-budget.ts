// TRA-LIVE-LEARNING-BUDGET — the owner-approved, CAPPED live path for the
// directional sleeve (signal → near-ATM call on an uptrend confluence, put on a
// downtrend), so the desk can buy the real broker fills its own gates demand.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Live directional cannot open by construction, three ways at once:
//   1. `cost_bar` refuses every directional cell: the measured edge is negative
//      (best cell −0.19R on the 10-02 census), so no bar setting admits it;
//   2. the TRA-4894 real-fill arm needs 40 BROKER fills per cell, and broker
//      fills only come from admitted trades — a deadlock, recorded as a design
//      finding by TRA-4978;
//   3. TRA-4750's stand-down roster refuses `single_leg_directional` at the
//      broker seam, and says re-opening it is "a board decision and a code
//      change, not an environment variable".
// This module is that code change, made on the owner's direction: a fixed
// LOSS BUDGET the owner chooses, spent one capped contract at a time, after
// which the path disarms itself permanently. It is the live twin of the TRA-4378
// demo exploration allowance and copies its shape (grant checks, commit spends,
// terminal disarms are durable).
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
//  • It does not claim an edge. It pays for evidence; expect to lose up to the cap.
//  • It does not touch OTM, RV, wheel, equity or any other sleeve.
//  • It bypasses ONLY the cost bar and the directional stand-down roster entry.
//    Every other live gate (arm + test window, sizing, canary ceiling, hard
//    controls, buying-power checks, spread veto, churn brake) still runs.
//  • Default OFF. With the flag unset every consult refuses `flag_off` and the
//    live directional path is byte-identical to before (still stood down).
//
// ── CAPS (ENFORCED IN CODE; env may only TIGHTEN below the compiled ceilings) ─
//   LIVE_LEARNING_BUDGET_MAX_LOSS_USD      default 300   ceiling 1000  (realized, cumulative)
//   LIVE_LEARNING_BUDGET_PER_OPEN_USD      default 100   ceiling 150   (premium at risk per open)
//   LIVE_LEARNING_BUDGET_MAX_OPENS         default 40    ceiling 60    (40 = the real-fill arm's floor)
//   max 2 concurrent · max 2 new opens per ET session · 40-session box from arm
// Worst case in flight: committed realized loss + every open position going to
// zero. The loss cap counts OPEN at-risk too, so the budget cannot be overrun by
// positions that are still open when the cap would bind.
//
// ── DURABILITY ───────────────────────────────────────────────────────────────
// JSONL under DATA_DIR, hydrated at boot. An EPHEMERAL data dir or an unreadable
// file FAILS CLOSED: caps that cannot survive a reboot must not be presumed
// unbound on live capital.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { appendBoundedTapeLineSync } from './data-tape-bounds.js';
import { isMarketDayIso } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-learning-budget' });

export const LIVE_LEARNING_BUDGET_FLAG = 'ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET';
export const LIVE_LEARNING_BUDGET_LOG_FILENAME = 'live-learning-budget.jsonl';

export const LIVE_LEARNING_CEILINGS = Object.freeze({
  maxLossUsd: 1000,
  perOpenAtRiskUsd: 150,
  maxOpens: 60,
});
export const LIVE_LEARNING_DEFAULTS = Object.freeze({
  maxLossUsd: 300,
  perOpenAtRiskUsd: 100,
  maxOpens: 40,
  maxConcurrent: 2,
  maxPerSession: 2,
  sessionBox: 40,
});

export interface LiveLearningCaps {
  maxLossUsd: number;
  perOpenAtRiskUsd: number;
  maxOpens: number;
  maxConcurrent: number;
  maxPerSession: number;
  sessionBox: number;
}

function flagOn(raw: string | undefined): boolean {
  return typeof raw === 'string' && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function isLiveLearningBudgetFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[LIVE_LEARNING_BUDGET_FLAG]);
}

/** A positive env number, clamped DOWN to the ceiling; anything else ⇒ default. Tighten-only. */
function capFromEnv(raw: string | undefined, dflt: number, ceiling: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, ceiling);
}

export function resolveLiveLearningCaps(env: NodeJS.ProcessEnv = process.env): LiveLearningCaps {
  return {
    maxLossUsd: capFromEnv(env.LIVE_LEARNING_BUDGET_MAX_LOSS_USD, LIVE_LEARNING_DEFAULTS.maxLossUsd, LIVE_LEARNING_CEILINGS.maxLossUsd),
    perOpenAtRiskUsd: capFromEnv(env.LIVE_LEARNING_BUDGET_PER_OPEN_USD, LIVE_LEARNING_DEFAULTS.perOpenAtRiskUsd, LIVE_LEARNING_CEILINGS.perOpenAtRiskUsd),
    maxOpens: Math.floor(capFromEnv(env.LIVE_LEARNING_BUDGET_MAX_OPENS, LIVE_LEARNING_DEFAULTS.maxOpens, LIVE_LEARNING_CEILINGS.maxOpens)),
    maxConcurrent: LIVE_LEARNING_DEFAULTS.maxConcurrent,
    maxPerSession: LIVE_LEARNING_DEFAULTS.maxPerSession,
    sessionBox: LIVE_LEARNING_DEFAULTS.sessionBox,
  };
}

// ── state ────────────────────────────────────────────────────────────────────

export type LiveLearningTerminalReason = 'open_cap' | 'loss_cap' | 'box_expiry';

type LedgerEvent =
  | { kind: 'arm'; etDay: string; ts: number }
  | { kind: 'open'; id: string; occ: string | null; atRiskUsd: number; etDay: string; ts: number; book: string | null }
  | { kind: 'close'; id: string; realizedPnlUsd: number; etDay: string; ts: number }
  | { kind: 'disarm'; reason: LiveLearningTerminalReason; etDay: string; ts: number };

interface OpenRow {
  occ: string | null;
  atRiskUsd: number;
  etDay: string;
  closed: boolean;
  realizedPnlUsd: number | null;
}

let dataDir: string | null = null;
let unreadable = false;
let ephemeral = false;
let armedEtDay: string | null = null;
const opens = new Map<string, OpenRow>();
let disarm: { reason: LiveLearningTerminalReason; etDay: string } | null = null;
let pending: { etDay: string; ts: number } | null = null;
let appendErrors = 0;
const tallies = { consults: 0, grants: 0, refusals: {} as Record<string, number> };

export function clearLiveLearningBudgetForTests(): void {
  dataDir = null;
  unreadable = false;
  ephemeral = false;
  armedEtDay = null;
  opens.clear();
  disarm = null;
  pending = null;
  appendErrors = 0;
  tallies.consults = 0;
  tallies.grants = 0;
  tallies.refusals = {};
}

function apply(ev: LedgerEvent): void {
  if (ev.kind === 'arm') { if (armedEtDay == null) armedEtDay = ev.etDay; return; }
  if (ev.kind === 'open') {
    if (!opens.has(ev.id)) opens.set(ev.id, { occ: ev.occ, atRiskUsd: ev.atRiskUsd, etDay: ev.etDay, closed: false, realizedPnlUsd: null });
    return;
  }
  if (ev.kind === 'close') {
    const o = opens.get(ev.id);
    if (o && !o.closed) { o.closed = true; o.realizedPnlUsd = ev.realizedPnlUsd; }
    return;
  }
  if (disarm == null) disarm = { reason: ev.reason, etDay: ev.etDay };
}

function append(ev: LedgerEvent): void {
  apply(ev);
  if (dataDir == null) return;
  const path = join(dataDir, LIVE_LEARNING_BUDGET_LOG_FILENAME);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* surfaced by the append */ }
  try {
    if (!appendBoundedTapeLineSync(path, JSON.stringify(ev) + '\n')) appendErrors += 1;
  } catch (err) {
    appendErrors += 1;
    log.error('live learning budget append FAILED — further grants refuse', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface LiveLearningHydration {
  events: number;
  opensUsed: number;
  armedEtDay: string | null;
  disarmedReason: LiveLearningTerminalReason | null;
  unreadable: boolean;
  ephemeral: boolean;
}

export function hydrateLiveLearningBudgetFromDisk(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveLearningHydration {
  clearLiveLearningBudgetForTests();
  dataDir = dir;
  ephemeral = isEphemeralDataDir(dir, env);
  const path = join(dir, LIVE_LEARNING_BUDGET_LOG_FILENAME);
  let events = 0;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        apply(JSON.parse(line) as LedgerEvent);
        events += 1;
      }
    } catch (err) {
      unreadable = true;
      log.error('live learning budget ledger UNREADABLE — every grant refuses until inspected', {
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { events, opensUsed: opens.size, armedEtDay, disarmedReason: disarm?.reason ?? null, unreadable, ephemeral };
}

/** ET market sessions in [armedEtDay, todayIso], inclusive of both. */
export function sessionsSinceArm(armed: string, todayIso: string): number {
  if (todayIso < armed) return 0;
  let n = 0;
  const d = new Date(`${armed}T12:00:00Z`);
  const end = new Date(`${todayIso}T12:00:00Z`);
  while (d <= end && n < 10_000) {
    if (isMarketDayIso(d.toISOString().slice(0, 10))) n += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

function realizedPnl(): number {
  let s = 0;
  for (const o of opens.values()) if (o.closed && typeof o.realizedPnlUsd === 'number') s += o.realizedPnlUsd;
  return s;
}
function openAtRisk(): number {
  let s = 0;
  for (const o of opens.values()) if (!o.closed) s += o.atRiskUsd;
  return s;
}

export type LiveLearningRefusal =
  | 'flag_off'
  | 'no_data_dir'
  | 'ephemeral_data_dir'
  | 'ledger_unreadable'
  | 'ledger_write_failed'
  | 'disarmed'
  | 'open_cap'
  | 'loss_cap'
  | 'box_expiry'
  | 'max_concurrent'
  | 'max_per_session'
  | 'over_per_open_cap';

export interface LiveLearningConsult {
  granted: boolean;
  refusal: LiveLearningRefusal | null;
  caps: LiveLearningCaps;
}

function refuse(r: LiveLearningRefusal, caps: LiveLearningCaps): LiveLearningConsult {
  tallies.refusals[r] = (tallies.refusals[r] ?? 0) + 1;
  return { granted: false, refusal: r, caps };
}

/**
 * Consult the budget for ONE live directional candidate. A grant sets a one-shot
 * pending token (take it with {@link takeLiveLearningGrant}); it spends nothing.
 * `oneContractUsd` is the ask × 100 of a single contract: if one contract
 * already exceeds the per-open cap the consult refuses here rather than at
 * sizing, so the refusal is attributable.
 */
export function consultLiveLearningBudget(
  env: NodeJS.ProcessEnv,
  todayEtDay: string,
  oneContractUsd: number,
  nowMs: number = Date.now(),
): LiveLearningConsult {
  tallies.consults += 1;
  pending = null;
  const caps = resolveLiveLearningCaps(env);
  if (!isLiveLearningBudgetFlagOn(env)) return refuse('flag_off', caps);
  if (dataDir == null) return refuse('no_data_dir', caps);
  if (ephemeral) return refuse('ephemeral_data_dir', caps);
  if (unreadable) return refuse('ledger_unreadable', caps);
  if (appendErrors > 0) return refuse('ledger_write_failed', caps);
  if (disarm) return refuse('disarmed', caps);

  if (armedEtDay == null) append({ kind: 'arm', etDay: todayEtDay, ts: nowMs });
  if (appendErrors > 0) return refuse('ledger_write_failed', caps);

  if (opens.size >= caps.maxOpens) {
    append({ kind: 'disarm', reason: 'open_cap', etDay: todayEtDay, ts: nowMs });
    return refuse('open_cap', caps);
  }
  // Loss cap counts realized losses AND everything still at risk, plus this open.
  const worstCase = -realizedPnl() + openAtRisk();
  if (-realizedPnl() >= caps.maxLossUsd) {
    append({ kind: 'disarm', reason: 'loss_cap', etDay: todayEtDay, ts: nowMs });
    return refuse('loss_cap', caps);
  }
  if (sessionsSinceArm(armedEtDay as string, todayEtDay) > caps.sessionBox) {
    append({ kind: 'disarm', reason: 'box_expiry', etDay: todayEtDay, ts: nowMs });
    return refuse('box_expiry', caps);
  }
  const concurrent = [...opens.values()].filter((o) => !o.closed).length;
  if (concurrent >= caps.maxConcurrent) return refuse('max_concurrent', caps);
  const today = [...opens.values()].filter((o) => o.etDay === todayEtDay).length;
  if (today >= caps.maxPerSession) return refuse('max_per_session', caps);
  if (!(oneContractUsd > 0) || oneContractUsd > caps.perOpenAtRiskUsd) return refuse('over_per_open_cap', caps);
  if (worstCase + oneContractUsd > caps.maxLossUsd) return refuse('loss_cap', caps); // not terminal: headroom may return

  pending = { etDay: todayEtDay, ts: nowMs };
  tallies.grants += 1;
  return { granted: true, refusal: null, caps };
}

/** Take (and clear) the one-shot token the last consult set. */
export function takeLiveLearningGrant(): { etDay: string; ts: number } | null {
  const p = pending;
  pending = null;
  return p;
}

/** Spend one row — call ONLY after the broker mirror is FINAL. */
export function commitLiveLearningOpen(args: {
  id: string;
  occ: string | null;
  atRiskUsd: number;
  etDay: string;
  book: string | null;
  nowMs?: number;
}): void {
  append({ kind: 'open', id: args.id, occ: args.occ, atRiskUsd: args.atRiskUsd, etDay: args.etDay, ts: args.nowMs ?? Date.now(), book: args.book });
}

/** Journal close listener. Ignores ids this ledger never opened. */
export function handleLiveLearningClose(id: string, realizedPnlUsd: number | null | undefined, etDay: string, nowMs = Date.now()): void {
  const o = opens.get(id);
  if (!o || o.closed) return;
  append({ kind: 'close', id, realizedPnlUsd: typeof realizedPnlUsd === 'number' && Number.isFinite(realizedPnlUsd) ? realizedPnlUsd : 0, etDay, ts: nowMs });
}

export function summarizeLiveLearningBudget(env: NodeJS.ProcessEnv = process.env, todayEtDay?: string) {
  const caps = resolveLiveLearningCaps(env);
  const readable = !unreadable;
  return {
    flag: LIVE_LEARNING_BUDGET_FLAG,
    flagOn: isLiveLearningBudgetFlagOn(env),
    caps,
    durability: { dataDir, ephemeral, unreadable, appendErrors },
    armedEtDay,
    sessionsUsed: armedEtDay && todayEtDay ? sessionsSinceArm(armedEtDay, todayEtDay) : null,
    opensUsed: readable ? opens.size : null,
    openPositions: readable ? [...opens.values()].filter((o) => !o.closed).length : null,
    realizedPnlUsd: readable ? Math.round(realizedPnl() * 100) / 100 : null,
    openAtRiskUsd: readable ? Math.round(openAtRisk() * 100) / 100 : null,
    lossHeadroomUsd: readable ? Math.round((caps.maxLossUsd + realizedPnl() - openAtRisk()) * 100) / 100 : null,
    disarmed: disarm,
    sinceBoot: { ...tallies, refusals: { ...tallies.refusals } },
    statement:
      'Owner-approved LIVE learning budget for the directional sleeve. It buys real broker fills; it '
      + 'does not claim an edge. Bypasses ONLY cost_bar and the directional stand-down entry; every '
      + 'other live gate runs.',
  };
}
