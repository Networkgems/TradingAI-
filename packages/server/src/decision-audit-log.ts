// TRA-4658 — Week-1 Day-7: the decision audit log. ONE append-only,
// disk-persisted trail for every trading decision the stack makes, unified
// across the per-concern ledgers that already exist (paper ledger, option
// trade journal, order-intent journal): every signal, every order verdict,
// every fill, every exit, every strategy state change, every manual
// intervention — queryable and exportable as CSV for post-trade analysis.
//
// Why a new module when ledgers already exist: each existing ledger covers
// ONE concern for ONE book (the paper ledger is flag-gated on
// ENABLE_PAPER_TRADING; the option journal knows options only; the order
// intent journal knows Tradier only). None of them answers "show me every
// decision on 2026-09-17, any category, one schema". This module is the
// union surface, ALWAYS ON — it has no arming flag on purpose, because an
// audit trail that can be dark is not an audit trail.
//
// Coverage argument (the AC's "100% decision coverage"), by construction:
//   • signals      — teed at `SignalEngine.pushRecentSignal`, THE single feed
//                    sink every fired signal passes through (TRA-4529).
//   • orders       — teed INSIDE `admitOrderThroughHardControls` (TRA-4655),
//                    the one fail-closed choke point every order-shaped
//                    action must call; both ALLOWED and REFUSED verdicts land
//                    here, so a refusal never reads like a decision that was
//                    never made. Fill detail is teed at the engine's fill
//                    emitters (the TRA-4657 seams).
//   • exits        — teed at the engine's exit emitters (planned stop/target
//                    vs. actual exit, P&L, hold time).
//   • state change — teed at the hard-controls latches (kill switch, day-loss
//                    lockout) and the DailyRiskGovernor halt transitions.
//   • intervention — teed at the operator routes (kill switch, reset-halt,
//                    force-close-all, manual position closes), with the actor.
//
// Posture (house rules):
//   • The recorder NEVER takes down a trade path: every public entry point
//     swallows its own throw. But a suppression must ship a counter
//     (TRA-3800/3802 lineage): every swallowed failure increments
//     `appendFailures` and stamps `lastAppendError`, both published on
//     `getDecisionAuditState()` — a dark audit log is visibly dark, never
//     silently green.
//   • Absent ≠ 0: unknown numeric facts are recorded as null, never coerced.
//   • Retention is a floor, not a cap: files are pruned only past
//     DECISION_AUDIT_RETENTION_DAYS (180 ET days — comfortably over the AC's
//     ≥90), and the prune counts what it deleted.
//
// Storage: one JSONL file per ET day under `<DATA_DIR>/decision-audit/`.
// Daily partitioning gives date-range queries and retention pruning for free,
// and an append-only line format survives a mid-write crash losing at most
// the line in flight.

import { appendFile, mkdir } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';
import { isEphemeralDataDir, resolveDataDir } from './data-dir.js';
import { etDateKey } from './et-clock.js';

const log = logger.child({ module: 'decision-audit-log' });

/** Keep at least this many ET days of audit files. AC floor is 90. */
export const DECISION_AUDIT_RETENTION_DAYS = 180;

export const DECISION_AUDIT_DIRNAME = 'decision-audit';
const FILE_PREFIX = 'decisions-';
const FILE_SUFFIX = '.jsonl';

export type DecisionAuditCategory =
  | 'signal'
  | 'order'
  | 'exit'
  | 'state_change'
  | 'intervention';

export const DECISION_AUDIT_CATEGORIES: readonly DecisionAuditCategory[] = [
  'signal', 'order', 'exit', 'state_change', 'intervention',
];

export interface DecisionAuditQuote {
  asOfMs: number | null;
  bid: number | null;
  ask: number | null;
  /** Age of the quote AT DECISION TIME (atMs − asOfMs); null when unknowable. */
  ageMs: number | null;
}

export interface DecisionAuditEvent {
  v: 1;
  /** Per-process monotonic sequence; ties broken by arrival order. */
  seq: number;
  atMs: number;
  at: string;
  etDay: string;
  category: DecisionAuditCategory;
  /** Machine verb, e.g. `signal_fired`, `hard_controls_admit`, `fill_booked`. */
  action: string;
  /** Filterable disposition, e.g. `fired`/`admitted`/`refused`/`filled`/`win`. */
  outcome: string;
  mode: string | null;
  strategy: string | null;
  symbol: string | null;
  positionId: string | null;
  signalId: string | null;
  /** WHO decided, when a human/agent identity exists. Null = the engine. */
  actor: string | null;
  /** Human-readable why — refusal text, halt reason, operator note. */
  reason: string | null;
  qty: number | null;
  /** Executed per-share price (fills/exits) or proposed entry (signals). */
  price: number | null;
  /** The PLANNED price the executed one is graded against, when distinct. */
  proposedPrice: number | null;
  notionalUsd: number | null;
  feesUsd: number | null;
  pnlUsd: number | null;
  holdMs: number | null;
  quote: DecisionAuditQuote | null;
  /** Category-specific extras, schema-free; goes to CSV JSON-encoded. */
  detail: Record<string, unknown> | null;
}

export type DecisionAuditInput = {
  category: DecisionAuditCategory;
  action: string;
  outcome: string;
  atMs?: number;
  mode?: string | null;
  strategy?: string | null;
  symbol?: string | null;
  positionId?: string | null;
  signalId?: string | null;
  actor?: string | null;
  reason?: string | null;
  qty?: number | null;
  price?: number | null;
  proposedPrice?: number | null;
  notionalUsd?: number | null;
  feesUsd?: number | null;
  pnlUsd?: number | null;
  holdMs?: number | null;
  quote?: Partial<DecisionAuditQuote> | null;
  detail?: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface AuditCounters {
  written: number;
  writtenByCategory: Record<string, number>;
  appendFailures: number;
  lastAppendError: { atMs: number; reason: string } | null;
  prunedFiles: number;
  droppedInputs: number;
  lastDropReason: string | null;
}

function freshCounters(): AuditCounters {
  return {
    written: 0,
    writtenByCategory: {},
    appendFailures: 0,
    lastAppendError: null,
    prunedFiles: 0,
    droppedInputs: 0,
    lastDropReason: null,
  };
}

let dirOverride: string | null = null;
let counters: AuditCounters = freshCounters();
let seq = 0;
let lastSeenDay: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function auditDir(): string {
  return dirOverride ?? join(resolveDataDir(), DECISION_AUDIT_DIRNAME);
}

function fileForDay(etDay: string): string {
  return join(auditDir(), `${FILE_PREFIX}${etDay}${FILE_SUFFIX}`);
}

function dayOfFile(name: string): string | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null;
  const day = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Test seam: pin the audit directory (null restores the DATA_DIR default). */
export function __resetDecisionAuditForTest(opts?: { dir?: string | null }): void {
  dirOverride = opts?.dir ?? null;
  counters = freshCounters();
  seq = 0;
  lastSeenDay = null;
  writeQueue = Promise.resolve();
}

/** Test seam: await the append queue so on-disk assertions don't race it. */
export function decisionAuditFlushForTests(): Promise<void> {
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Delete audit files STRICTLY OLDER than the retention window. Lexicographic
 * compare is correct on YYYY-MM-DD. Deleting is fail-soft per file (a locked
 * file must not abort the sweep) and every deletion is counted.
 */
export function pruneDecisionAuditFiles(nowMs: number = Date.now()): { pruned: number } {
  const dir = auditDir();
  if (!existsSync(dir)) return { pruned: 0 };
  const cutoffDay = etDateKey(nowMs - DECISION_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  let pruned = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    log.warn('decision-audit retention sweep could not list the dir', {
      dir, reason: err instanceof Error ? err.message : String(err),
    });
    return { pruned: 0 };
  }
  for (const name of names) {
    const day = dayOfFile(name);
    if (day === null || day >= cutoffDay) continue;
    try {
      rmSync(join(dir, name));
      pruned += 1;
    } catch (err) {
      log.warn('decision-audit retention sweep could not delete a file', {
        file: name, reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  counters.prunedFiles += pruned;
  return { pruned };
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * THE recorder. Never throws; a failed append is counted and stamped, never
 * silent. Returns the built event (or null when the input was unusable) so a
 * caller/test can assert what was written without re-reading the disk.
 */
export function recordDecisionAudit(input: DecisionAuditInput): DecisionAuditEvent | null {
  try {
    if (!DECISION_AUDIT_CATEGORIES.includes(input.category)
      || typeof input.action !== 'string' || input.action.trim() === ''
      || typeof input.outcome !== 'string' || input.outcome.trim() === '') {
      counters.droppedInputs += 1;
      counters.lastDropReason = `unusable input (category=${String(input.category)}, action=${String(input.action)})`;
      return null;
    }
    const atMs = typeof input.atMs === 'number' && Number.isFinite(input.atMs) ? input.atMs : Date.now();
    const etDay = etDateKey(atMs);
    const quote = input.quote
      ? {
        asOfMs: num(input.quote.asOfMs),
        bid: num(input.quote.bid),
        ask: num(input.quote.ask),
        ageMs: num(input.quote.asOfMs) !== null ? atMs - (num(input.quote.asOfMs) as number) : null,
      }
      : null;
    seq += 1;
    const event: DecisionAuditEvent = {
      v: 1,
      seq,
      atMs,
      at: new Date(atMs).toISOString(),
      etDay,
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      mode: str(input.mode) ?? null,
      strategy: str(input.strategy) ?? null,
      symbol: str(input.symbol) ?? null,
      positionId: str(input.positionId) ?? null,
      signalId: str(input.signalId) ?? null,
      actor: str(input.actor) ?? null,
      reason: str(input.reason) ?? null,
      qty: num(input.qty),
      price: num(input.price),
      proposedPrice: num(input.proposedPrice),
      notionalUsd: num(input.notionalUsd),
      feesUsd: num(input.feesUsd),
      pnlUsd: num(input.pnlUsd),
      holdMs: num(input.holdMs),
      quote,
      detail: input.detail ?? null,
    };
    // Day roll ⇒ run the retention sweep once, off the hot path's happy case.
    if (lastSeenDay !== etDay) {
      lastSeenDay = etDay;
      pruneDecisionAuditFiles(atMs);
    }
    const file = fileForDay(etDay);
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(auditDir(), { recursive: true });
        await appendFile(file, `${JSON.stringify(event)}\n`, 'utf-8');
        counters.written += 1;
        counters.writtenByCategory[event.category] = (counters.writtenByCategory[event.category] ?? 0) + 1;
      })
      .catch((err) => {
        counters.appendFailures += 1;
        counters.lastAppendError = {
          atMs: Date.now(),
          reason: err instanceof Error ? err.message : String(err),
        };
        log.warn('decision-audit append FAILED (counted — see getDecisionAuditState)', {
          file, reason: counters.lastAppendError.reason,
        });
      });
    return event;
  } catch (err) {
    counters.droppedInputs += 1;
    counters.lastDropReason = err instanceof Error ? err.message : String(err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typed tees — structural inputs so the engine's own types plug in verbatim.
// ---------------------------------------------------------------------------

export interface AuditSignalLike {
  id: string;
  symbol: string;
  type: string;
  side?: string;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskRewardRatio?: number | null;
  timestamp: number;
  signalSkipReason?: string;
  signalSkipCode?: string;
}

/** Every fired signal: what triggered it, proposed trade, skip disposition. */
export function auditSignalFired(signal: AuditSignalLike, mode: string): void {
  recordDecisionAudit({
    category: 'signal',
    action: 'signal_fired',
    outcome: signal.signalSkipCode || signal.signalSkipReason ? 'skipped' : 'fired',
    atMs: signal.timestamp,
    mode,
    strategy: str(signal.type),
    symbol: signal.symbol,
    signalId: signal.id,
    reason: signal.signalSkipReason ?? null,
    price: num(signal.entryPrice),
    detail: {
      side: signal.side ?? null,
      stopLoss: num(signal.stopLoss),
      takeProfit: num(signal.takeProfit),
      riskRewardRatio: num(signal.riskRewardRatio),
      skipCode: signal.signalSkipCode ?? null,
    },
  });
}

export interface AuditAdmitIntentLike {
  kind: 'open' | 'close';
  notionalUsd: number;
  openPositionCount: number;
  quoteAsOfMs: number;
  idempotencyKey: string;
}

/**
 * Every choke-point verdict (TRA-4655). Called from INSIDE
 * `admitOrderThroughHardControls`, so no order path can skip it: an order
 * that was never audited is an order that never reached the broker.
 */
export function auditOrderAdmit(
  intent: AuditAdmitIntentLike,
  verdict: { allowed: boolean; reasonCode?: string; reason?: string },
  nowMs: number,
): void {
  recordDecisionAudit({
    category: 'order',
    action: 'hard_controls_admit',
    outcome: verdict.allowed ? 'admitted' : 'refused',
    atMs: nowMs,
    reason: verdict.reason ?? null,
    notionalUsd: num(intent.notionalUsd),
    quote: { asOfMs: num(intent.quoteAsOfMs), bid: null, ask: null },
    detail: {
      kind: intent.kind,
      reasonCode: verdict.reasonCode ?? null,
      openPositionCount: num(intent.openPositionCount),
      idempotencyKey: str(intent.idempotencyKey),
    },
  });
}

export interface AuditEquityFillLike {
  id: string;
  symbol: string;
  side: string;
  signalType?: string;
  signalId?: string;
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
}

/** Every booked equity open (demo book fills at the mark — fees null, not 0). */
export function auditEquityFill(pos: AuditEquityFillLike, mode: string): void {
  recordDecisionAudit({
    category: 'order',
    action: 'fill_booked',
    outcome: 'filled',
    atMs: pos.openedAt,
    mode,
    strategy: str(pos.signalType),
    symbol: pos.symbol,
    positionId: pos.id,
    signalId: str(pos.signalId),
    qty: num(pos.quantity),
    price: num(pos.entryPrice),
    notionalUsd: num(pos.entryPrice) !== null && num(pos.quantity) !== null
      ? pos.entryPrice * pos.quantity : null,
    detail: {
      instrument: 'equity',
      side: pos.side,
      plannedStopLoss: num(pos.stopLoss),
      plannedTakeProfit: num(pos.takeProfit),
    },
  });
}

export interface AuditOptionFillLike {
  id: string;
  symbol: string;
  optionSymbol?: string;
  signalType?: string;
  signalId?: string;
  contracts: number;
  premiumPaid: number;
  stopLossPremium?: number;
  tp1Premium?: number;
  openedAt: number;
  entryBidAtOpen?: number | null;
  entryAskAtOpen?: number | null;
  entrySpreadPct?: number | null;
}

/** Every booked option open, with the TRA-3990 entry quote when stamped. */
export function auditOptionFill(opt: AuditOptionFillLike, mode: string): void {
  recordDecisionAudit({
    category: 'order',
    action: 'fill_booked',
    outcome: 'filled',
    atMs: opt.openedAt,
    mode,
    strategy: str(opt.signalType),
    symbol: opt.symbol,
    positionId: opt.id,
    signalId: str(opt.signalId),
    qty: num(opt.contracts),
    price: num(opt.premiumPaid),
    notionalUsd: num(opt.premiumPaid) !== null && num(opt.contracts) !== null
      ? opt.premiumPaid * opt.contracts * 100 : null,
    quote: { asOfMs: num(opt.openedAt), bid: num(opt.entryBidAtOpen), ask: num(opt.entryAskAtOpen) },
    detail: {
      instrument: 'option',
      occ: str(opt.optionSymbol),
      plannedStopPremium: num(opt.stopLossPremium),
      plannedTp1Premium: num(opt.tp1Premium),
      entrySpreadPct: num(opt.entrySpreadPct),
    },
  });
}

export interface AuditEquityExitLike {
  id: string;
  symbol: string;
  side: string;
  signalType?: string;
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  exitPrice?: number;
  openedAt?: number;
  closedAt?: number;
  pnl?: number;
  exitReason?: string;
}

function exitOutcome(pnl: number | null): string {
  if (pnl === null) return 'unknown';
  if (pnl > 0) return 'win';
  if (pnl < 0) return 'loss';
  return 'scratch';
}

/** Every equity exit: planned levels vs. actual, P&L attribution, hold time. */
export function auditEquityExit(pos: AuditEquityExitLike, mode: string): void {
  const atMs = num(pos.closedAt) ?? Date.now();
  const pnl = num(pos.pnl);
  recordDecisionAudit({
    category: 'exit',
    action: 'exit_booked',
    outcome: exitOutcome(pnl),
    atMs,
    mode,
    strategy: str(pos.signalType),
    symbol: pos.symbol,
    positionId: pos.id,
    reason: str(pos.exitReason),
    qty: num(pos.quantity),
    price: num(pos.exitPrice),
    proposedPrice: num(pos.stopLoss) !== null || num(pos.takeProfit) !== null
      ? (pos.exitReason === 'take_profit' ? num(pos.takeProfit) : num(pos.stopLoss))
      : null,
    pnlUsd: pnl,
    holdMs: num(pos.openedAt) !== null ? atMs - (pos.openedAt as number) : null,
    detail: {
      instrument: 'equity',
      side: pos.side,
      entryPrice: num(pos.entryPrice),
      plannedStopLoss: num(pos.stopLoss),
      plannedTakeProfit: num(pos.takeProfit),
    },
  });
}

export interface AuditOptionExitLike {
  id: string;
  symbol: string;
  optionSymbol?: string;
  signalType?: string;
  contracts: number;
  premiumPaid: number;
  currentPremium: number;
  stopLossPremium?: number;
  tp1Premium?: number;
  openedAt?: number;
  closedAt?: number;
  pnl?: number;
  exitReason?: string;
}

/** Every option exit (on a closed row `currentPremium` IS the exit fill, TRA-2890). */
export function auditOptionExit(opt: AuditOptionExitLike, mode: string): void {
  const atMs = num(opt.closedAt) ?? Date.now();
  const pnl = num(opt.pnl);
  recordDecisionAudit({
    category: 'exit',
    action: 'exit_booked',
    outcome: exitOutcome(pnl),
    atMs,
    mode,
    strategy: str(opt.signalType),
    symbol: opt.symbol,
    positionId: opt.id,
    reason: str(opt.exitReason),
    qty: num(opt.contracts),
    price: num(opt.currentPremium),
    proposedPrice: opt.exitReason === 'take_profit' ? num(opt.tp1Premium) : num(opt.stopLossPremium),
    pnlUsd: pnl,
    holdMs: num(opt.openedAt) !== null ? atMs - (opt.openedAt as number) : null,
    detail: {
      instrument: 'option',
      occ: str(opt.optionSymbol),
      entryPremium: num(opt.premiumPaid),
      plannedStopPremium: num(opt.stopLossPremium),
      plannedTp1Premium: num(opt.tp1Premium),
    },
  });
}

/** Strategy/engine state transitions: armed / disabled / halted / re-armed. */
export function auditStateChange(args: {
  action: string;
  outcome: string;
  reason?: string | null;
  actor?: string | null;
  mode?: string | null;
  atMs?: number;
  detail?: Record<string, unknown> | null;
}): void {
  recordDecisionAudit({
    category: 'state_change',
    action: args.action,
    outcome: args.outcome,
    atMs: args.atMs,
    mode: args.mode ?? null,
    actor: args.actor ?? null,
    reason: args.reason ?? null,
    detail: args.detail ?? null,
  });
}

/** Manual interventions: kill switch, force close, reset-halt, manual trades. */
export function auditIntervention(args: {
  action: string;
  actor: string | null;
  outcome?: string;
  reason?: string | null;
  mode?: string | null;
  symbol?: string | null;
  positionId?: string | null;
  atMs?: number;
  detail?: Record<string, unknown> | null;
}): void {
  recordDecisionAudit({
    category: 'intervention',
    action: args.action,
    outcome: args.outcome ?? 'executed',
    atMs: args.atMs,
    mode: args.mode ?? null,
    symbol: args.symbol ?? null,
    positionId: args.positionId ?? null,
    actor: args.actor,
    reason: args.reason ?? null,
    detail: args.detail ?? null,
  });
}

// ---------------------------------------------------------------------------
// Query + CSV export
// ---------------------------------------------------------------------------

export interface DecisionAuditFilter {
  /** Inclusive ET-day bounds, YYYY-MM-DD. Default: today only. */
  fromDay?: string;
  toDay?: string;
  category?: DecisionAuditCategory;
  action?: string;
  strategy?: string;
  symbol?: string;
  outcome?: string;
  positionId?: string;
  signalId?: string;
  /** Row cap AFTER filtering, newest rows kept. Default 5000, max 50000. */
  limit?: number;
}

export const DECISION_AUDIT_QUERY_DEFAULT_LIMIT = 5_000;
export const DECISION_AUDIT_QUERY_MAX_LIMIT = 50_000;

export interface DecisionAuditQueryResult {
  events: DecisionAuditEvent[];
  fromDay: string;
  toDay: string;
  /** Files that existed but held unparseable lines — published, never hidden. */
  corruptLines: number;
  truncated: boolean;
}

/**
 * Read matching events off disk, oldest-first. Reads only the files inside
 * the day range (the whole point of daily partitioning), tolerates a corrupt
 * line by counting it, and truncates from the OLD end so "the latest
 * decisions" survive the cap.
 */
export function queryDecisionAudit(
  filter: DecisionAuditFilter = {},
  nowMs: number = Date.now(),
): DecisionAuditQueryResult {
  const today = etDateKey(nowMs);
  const fromDay = filter.fromDay ?? today;
  const toDay = filter.toDay ?? today;
  const limit = Math.min(
    DECISION_AUDIT_QUERY_MAX_LIMIT,
    filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit > 0
      ? filter.limit
      : DECISION_AUDIT_QUERY_DEFAULT_LIMIT,
  );
  const dir = auditDir();
  const result: DecisionAuditQueryResult = { events: [], fromDay, toDay, corruptLines: 0, truncated: false };
  if (!existsSync(dir)) return result;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return result;
  }
  for (const name of names) {
    const day = dayOfFile(name);
    if (day === null || day < fromDay || day > toDay) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf-8');
    } catch {
      result.corruptLines += 1;
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: DecisionAuditEvent;
      try {
        event = JSON.parse(line) as DecisionAuditEvent;
      } catch {
        result.corruptLines += 1;
        continue;
      }
      if (filter.category !== undefined && event.category !== filter.category) continue;
      if (filter.action !== undefined && event.action !== filter.action) continue;
      if (filter.strategy !== undefined && event.strategy !== filter.strategy) continue;
      if (filter.symbol !== undefined && event.symbol !== filter.symbol) continue;
      if (filter.outcome !== undefined && event.outcome !== filter.outcome) continue;
      if (filter.positionId !== undefined && event.positionId !== filter.positionId) continue;
      if (filter.signalId !== undefined && event.signalId !== filter.signalId) continue;
      result.events.push(event);
    }
  }
  result.events.sort((a, b) => (a.atMs - b.atMs) || (a.seq - b.seq));
  if (result.events.length > limit) {
    result.events = result.events.slice(result.events.length - limit);
    result.truncated = true;
  }
  return result;
}

/** Fixed CSV schema — every envelope field, `detail` JSON-encoded last. */
export const DECISION_AUDIT_CSV_COLUMNS = [
  'seq', 'at', 'etDay', 'category', 'action', 'outcome', 'mode', 'strategy',
  'symbol', 'positionId', 'signalId', 'actor', 'qty', 'price', 'proposedPrice',
  'notionalUsd', 'feesUsd', 'pnlUsd', 'holdMs', 'quoteAsOfMs', 'quoteBid',
  'quoteAsk', 'quoteAgeMs', 'reason', 'detail',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function decisionAuditEventsToCsv(events: readonly DecisionAuditEvent[]): string {
  const lines: string[] = [DECISION_AUDIT_CSV_COLUMNS.join(',')];
  for (const e of events) {
    lines.push([
      e.seq, e.at, e.etDay, e.category, e.action, e.outcome, e.mode, e.strategy,
      e.symbol, e.positionId, e.signalId, e.actor, e.qty, e.price, e.proposedPrice,
      e.notionalUsd, e.feesUsd, e.pnlUsd, e.holdMs,
      e.quote?.asOfMs ?? null, e.quote?.bid ?? null, e.quote?.ask ?? null, e.quote?.ageMs ?? null,
      e.reason, e.detail,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// State publication + boot
// ---------------------------------------------------------------------------

export interface DecisionAuditState {
  dir: string;
  retentionDays: number;
  /** TRUE ⇒ this DATA_DIR evaporates on redeploy — the AC's persistence is NOT met. */
  ephemeral: boolean;
  written: number;
  writtenByCategory: Record<string, number>;
  appendFailures: number;
  lastAppendError: { atMs: number; reason: string } | null;
  droppedInputs: number;
  lastDropReason: string | null;
  prunedFiles: number;
  filesOnDisk: number;
  oldestDayOnDisk: string | null;
  newestDayOnDisk: string | null;
}

export function getDecisionAuditState(): DecisionAuditState {
  const dir = auditDir();
  let days: string[] = [];
  if (existsSync(dir)) {
    try {
      days = readdirSync(dir)
        .map(dayOfFile)
        .filter((d): d is string => d !== null)
        .sort();
    } catch {
      // published as zero files; append counters still tell the real story
    }
  }
  return {
    dir,
    retentionDays: DECISION_AUDIT_RETENTION_DAYS,
    ephemeral: dirOverride !== null ? false : isEphemeralDataDir(resolveDataDir(), process.env),
    written: counters.written,
    writtenByCategory: { ...counters.writtenByCategory },
    appendFailures: counters.appendFailures,
    lastAppendError: counters.lastAppendError,
    droppedInputs: counters.droppedInputs,
    lastDropReason: counters.lastDropReason,
    prunedFiles: counters.prunedFiles,
    filesOnDisk: days.length,
    oldestDayOnDisk: days[0] ?? null,
    newestDayOnDisk: days[days.length - 1] ?? null,
  };
}

/** Boot wiring: run the retention sweep once at startup. */
export function initDecisionAuditLog(nowMs: number = Date.now()): void {
  pruneDecisionAuditFiles(nowMs);
}
