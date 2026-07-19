import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  evaluateCanaryGuards,
  applyGuardEvaluation,
  initialCanaryState,
  DEFAULT_CANARY_LIMITS,
  type CanaryLimits,
  type CanaryTelemetry,
  type CanaryGuardEvaluation,
  type CanaryState,
  type CanaryAction,
  type CanaryBreachReason,
} from '@trading-app/engine';
import { sizeFromStopViaRiskManager } from './account-sizing.js';
import { logger } from './observability/index.js';

// TRA-2051 — server seam for the live-canary staging harness. The pure guard
// logic + state machine live in the engine (packages/engine/src/live-canary.ts);
// this module owns the ENABLE_LIVE_CANARY kill switch, the durable JSONL state
// ledger, the demotion latch, the sizing call (via account-sizing.ts / TRA-2034),
// and the health readout the endpoint exposes.
//
// GOVERNANCE — flag OFF, fail-closed, NO live capital. The canary is a NEW stage
// between shadow (paper) and full live: shadow -> canary -> full_live. This is the
// board-approved deliverable of TRA-2040 (spend envelope `0516d471`). With
// ENABLE_LIVE_CANARY off (the default, and the state while TRA-382 holds live
// trading) EVERYTHING here is inert: no writes, no state mutation, no sizing that
// reaches a broker. Arming a real candidate is a SEPARATE future action, hard-
// blocked on TRA-382 + a real candidate + board go-ahead — it will be filed as its
// own issue, NOT done here.
//
// FAIL-CLOSED persistence: the current canary state is folded from an append-only
// JSONL ledger. Once a breach latches `canaryDemoted`, that latch is reloaded on
// boot and cannot silently clear — a demoted canary stays demoted across restarts
// until an explicit operator re-arm (fresh candidate + board sign-off).

const log = logger.child({ module: 'live-canary-ledger' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Kill switch. Nothing here mutates state or writes unless this is truthy, so the
 * canary is OFF by default and a deploy cannot start a live canary without an
 * explicit opt-in (mirrors ENABLE_PRE_TRADE_GATE / ENABLE_REVERSAL_SHADOW).
 */
export const LIVE_CANARY_FLAG = 'ENABLE_LIVE_CANARY';

export function isLiveCanaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LIVE_CANARY_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'live-canary-state.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setLiveCanaryLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/**
 * One persisted event. Every guard sweep and every arm/transition appends one
 * row carrying the full resulting state, so the current state is just the last
 * row (fold = last-wins). Carries the evaluation + allocation of the sweep so the
 * health readout can show per-limit headroom without re-reading live telemetry.
 */
export interface CanaryLedgerEvent {
  /** ms-epoch the event was recorded. */
  at: number;
  /** What the state machine did. */
  action: CanaryAction | 'arm';
  /** The full canary state AFTER this event. */
  state: CanaryState;
  /** The guard evaluation that drove a sweep (null for an arm event). */
  evaluation: CanaryGuardEvaluation | null;
  /** Canary allocation at the time (for the readout denominator). */
  allocation: number | null;
}

type LedgerLine = { kind: 'event'; rec: CanaryLedgerEvent };

/** Folded view: the current state + the last sweep's readout context. */
interface CanaryLedgerCache {
  state: CanaryState;
  lastEvent: CanaryLedgerEvent | null;
}

let cache: CanaryLedgerCache | null = null;

async function ensureLoaded(): Promise<CanaryLedgerCache> {
  if (cache) return cache;
  const loaded: CanaryLedgerCache = { state: initialCanaryState(), lastEvent: null };
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const line = JSON.parse(trimmed) as LedgerLine;
          // Fold = last-wins: the newest event carries the authoritative state,
          // so the demotion latch is preserved verbatim across a restart.
          loaded.state = line.rec.state;
          loaded.lastEvent = line.rec;
        } catch {
          // Skip a corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read live-canary ledger, starting from safe default', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = loaded;
  return cache;
}

async function appendLine(line: LedgerLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf-8');
}

/** Eagerly load the ledger so a health read has state right after boot. */
export async function initLiveCanaryLedger(): Promise<void> {
  await ensureLoaded();
}

/** Current folded canary state. Safe default (shadow, latch clear) when empty. */
export async function getCanaryState(): Promise<CanaryState> {
  return (await ensureLoaded()).state;
}

/**
 * Arm a candidate into the canary (shadow -> canary). FAIL-CLOSED and flag-gated:
 * refuses with the flag OFF, refuses if the demotion latch is set (re-arming after
 * a demotion is an explicit out-of-band operator action, never automatic), and
 * refuses if a candidate is already armed (one candidate at a time). Returns
 * `{ armed, state }`. NOTE: this is the encoded stage-transition primitive — it
 * moves NO capital. Actually running a candidate live is blocked on TRA-382 + a
 * real candidate + board go-ahead, filed separately.
 */
export async function armCanaryCandidate(
  candidateId: string,
  at: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ armed: boolean; reason?: string; state: CanaryState }> {
  const c = await ensureLoaded();
  if (!isLiveCanaryEnabled(env)) return { armed: false, reason: 'flag_off', state: c.state };
  if (c.state.canaryDemoted) return { armed: false, reason: 'demotion_latched', state: c.state };
  if (c.state.stage === 'canary') return { armed: false, reason: 'already_armed', state: c.state };
  if (c.state.stage === 'full_live') return { armed: false, reason: 'already_live', state: c.state };

  const state: CanaryState = { ...c.state, stage: 'canary', candidateId };
  const event: CanaryLedgerEvent = { at, action: 'arm', state, evaluation: null, allocation: null };
  c.state = state;
  c.lastEvent = event;
  await appendLine({ kind: 'event', rec: event });
  log.info('canary candidate armed', { candidateId });
  return { armed: true, state };
}

/**
 * Run one guard sweep against a live-book telemetry snapshot and, if armed, drive
 * the auto-demotion state machine. On ANY breach (real OR fail-closed) the canary
 * demotes to shadow, latches `canaryDemoted`, and records the reasons — the caller
 * is responsible for the physical halt-entries + flatten side of the demotion
 * (this module owns the state + audit trail).
 *
 * FLAG-OFF: computes the evaluation + transition (both pure) but PERSISTS NOTHING
 * and mutates no in-memory state — zero behaviour change. `recorded` is false.
 */
export async function recordCanaryGuardSweep(
  telemetry: CanaryTelemetry,
  at: number,
  limits: CanaryLimits = DEFAULT_CANARY_LIMITS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ evaluation: CanaryGuardEvaluation; action: CanaryAction; state: CanaryState; recorded: boolean }> {
  const c = await ensureLoaded();
  const evaluation = evaluateCanaryGuards(telemetry, limits);
  const { state, action } = applyGuardEvaluation(c.state, evaluation, at);

  if (!isLiveCanaryEnabled(env)) {
    // Inert: report what WOULD happen, persist/mutate nothing.
    return { evaluation, action, state: c.state, recorded: false };
  }

  const event: CanaryLedgerEvent = {
    at,
    action,
    state,
    evaluation,
    allocation: telemetry.allocation,
  };
  c.state = state;
  c.lastEvent = event;
  await appendLine({ kind: 'event', rec: event });
  if (action === 'demote') {
    log.error('canary AUTO-DEMOTED on guard breach — halt entries + flatten required', {
      reasons: evaluation.breaches,
      failClosed: evaluation.failClosed,
    });
  }
  return { evaluation, action, state, recorded: true };
}

/**
 * Size a canary trade through the SAME engine RiskManager the backtest runner and
 * live/paper accounts use (TRA-2034 account-sizing.ts). The canary `allocation` IS
 * the managed equity for the canary book, so sizing back-scales to it and the
 * TRA-178 notional cap runs on the live book. Parity: this returns exactly what a
 * `new RiskManager({ totalEquity: allocation / MANAGED_ACCOUNT_RATIO })
 * .sizeFromStop(...)` returns (pinned by the parity test).
 */
export function sizeCanaryTrade(
  entryPrice: number,
  stopPrice: number,
  opts: { allocation: number; riskPerTrade: number; fractionalQuantity?: boolean },
): number {
  return sizeFromStopViaRiskManager(entryPrice, stopPrice, {
    managedEquity: opts.allocation,
    riskPerTrade: opts.riskPerTrade,
    fractionalQuantity: opts.fractionalQuantity ?? false,
  });
}

/** The live-canary health readout shape. */
export interface CanaryHealthReadout {
  issue: 'TRA-2051';
  flagEnabled: boolean;
  stage: CanaryState['stage'];
  candidateId: string | null;
  canaryDemoted: boolean;
  demotionReasons: CanaryBreachReason[];
  demotedAt: number | null;
  limits: CanaryLimits;
  /** Allocation + per-limit headroom from the last sweep (null when none yet). */
  lastSweepAt: number | null;
  allocation: number | null;
  headroom: CanaryGuardEvaluation['headroom'];
  lastEvaluationFailClosed: boolean | null;
}

/**
 * Build the GET /api/health/live-canary payload: stage, allocation, per-limit
 * headroom, and breach/demotion state. Honest when the flag is off / nothing has
 * run — it reports the safe default state and an empty headroom.
 */
export async function buildCanaryHealth(
  limits: CanaryLimits = DEFAULT_CANARY_LIMITS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CanaryHealthReadout> {
  const c = await ensureLoaded();
  const last = c.lastEvent;
  return {
    issue: 'TRA-2051',
    flagEnabled: isLiveCanaryEnabled(env),
    stage: c.state.stage,
    candidateId: c.state.candidateId,
    canaryDemoted: c.state.canaryDemoted,
    demotionReasons: c.state.demotionReasons,
    demotedAt: c.state.demotedAt,
    limits,
    lastSweepAt: last?.at ?? null,
    allocation: last?.allocation ?? null,
    headroom: last?.evaluation?.headroom ?? [],
    lastEvaluationFailClosed: last?.evaluation?.failClosed ?? null,
  };
}
