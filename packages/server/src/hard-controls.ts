// TRA-4655 — Week-1 hard operating controls: the SEVEN board-mandated safety
// gates, as ONE fail-closed choke point instead of seven scattered guards.
//
// Why a new module when pieces already exist: the TRA-526 kill switch is
// per-user/per-engine, the DailyRiskGovernor's loss halt is PERCENTAGE-based
// (−8%) and in-memory, the canary ceiling binds only the live-options seam,
// and order-intent idempotency covers only Tradier. TRA-4657 (paper trading
// against LIVE data) introduces a brand-new order path, and the board's
// ordering is explicit: these controls land BEFORE anything that can emit an
// order-shaped action. `admitOrderThroughHardControls` is the single call that
// path must make; TRA-4650 (LeadDev) extends/verifies on top of this interface.
//
// Posture (inherited from canary-ceiling.ts, TRA-3486/TRA-3688):
//   • REFUSE, NEVER CLAMP — an over-cap order is rejected, not resized.
//   • REFUSE ON UNREADABLE — every comparison is written so NaN/undefined land
//     in the refusing branch. Unreadable persisted state refuses everything;
//     an unreadable P&L report locks the rest of the ET day. "Could not check"
//     and "checked and it is fine" never share an outcome.
//   • COMPILED CONSTANTS — the limits ship in code. There is no env var that
//     raises them; raising any of them is a reviewed deploy of this file.
//   • DURABLE LATCHES — kill switch, force-close latch, day-loss lockout and
//     idempotency keys are write-through persisted to `<DATA_DIR>/hard-controls.json`
//     so a pm2 restart cannot silently un-latch a lockout (the restart-wipes
//     hazard measured on TRA-3804). Ephemerality is PUBLISHED, not hidden.
//
// The seven controls and where each lives:
//   1. Global kill switch        — engageHardKillSwitch / check (1)
//   2. Daily loss lockout $500   — recordHardControlsPnl latch + headroom arm (4)
//   3. Max $300 per trade        — check (5)
//   4. Max 3 open positions      — check (6)
//   5. Stale quote >5s blocks    — check (7)
//   6. Idempotency keys          — check (8), consume-on-admit
//   7. Force-close-all           — requestForceCloseAll + handler registry

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir, isEphemeralDataDir } from './data-dir.js';
import { etDateKey } from './et-clock.js';
import {
  auditIntervention,
  auditOrderAdmit,
  auditStateChange,
  __resetDecisionAuditForTest,
} from './decision-audit-log.js';

/** Daily realized-loss lockout, USD. Board number ("$500 → auto-disable"). */
export const HARD_DAILY_LOSS_LIMIT_USD = 500;
/** Per-trade notional hard cap, USD ("$300 hard cap"). */
export const HARD_MAX_ORDER_NOTIONAL_USD = 300;
/** Max simultaneously open positions, fleet-wide ("3 positions max"). */
export const HARD_MAX_OPEN_POSITIONS = 3;
/** Max age of the quote an order prices against ("no orders if quote >5s old"). */
export const HARD_MAX_QUOTE_AGE_MS = 5_000;
/**
 * Max tolerated FUTURE quote timestamp. A quote from the future means clock
 * skew, and under skew "fresh within 5s" is unprovable — refuse.
 */
export const HARD_MAX_QUOTE_SKEW_MS = 1_000;
/** Idempotency keys are retained this long; a key older than this may recur. */
export const HARD_IDEMPOTENCY_RETAIN_MS = 48 * 60 * 60 * 1_000;

export const HARD_CONTROLS_STATE_FILENAME = 'hard-controls.json';

export type HardControlReasonCode =
  | 'hard_controls_state_unreadable'
  | 'kill_switch_engaged'
  | 'force_close_engaged'
  | 'daily_loss_lockout'
  | 'daily_loss_headroom'
  | 'day_pnl_unreadable'
  | 'order_notional_unreadable'
  | 'max_order_notional'
  | 'open_positions_unreadable'
  | 'max_open_positions'
  | 'quote_timestamp_unreadable'
  | 'stale_quote'
  | 'quote_clock_skew'
  | 'idempotency_key_missing'
  | 'duplicate_order';

export interface HardControlVerdict {
  allowed: boolean;
  /** Present exactly when refused. */
  reasonCode?: HardControlReasonCode;
  /** Human-readable; discloses every term the verdict was computed from. */
  reason?: string;
}

export interface HardControlIntent {
  /** 'open' runs all seven checks; 'close' is risk-reducing — see admit() doc. */
  kind: 'open' | 'close';
  /** Order notional, USD (price × qty × multiplier). Required for opens. */
  notionalUsd: number;
  /** CURRENT fleet-wide open position count, supplied by the order site. */
  openPositionCount: number;
  /** Epoch-ms timestamp of the quote this order prices against. */
  quoteAsOfMs: number;
  /** Caller-chosen unique key for this order intent; duplicates are refused. */
  idempotencyKey: string;
}

interface HardControlsPersisted {
  killSwitch: { engaged: boolean; by: string | null; atMs: number | null; reason: string | null };
  forceClose: { engaged: boolean; by: string | null; atMs: number | null };
  dayLoss: { etDay: string; realizedPnlUsd: number; lockedOut: boolean; lockedAtMs: number | null; unreadable: boolean };
  /** idempotency key → admitted-at epoch ms. Pruned at HARD_IDEMPOTENCY_RETAIN_MS. */
  idempotency: Record<string, number>;
}

interface HardControlsState extends HardControlsPersisted {
  /** TRUE ⇒ the persisted state file exists but could not be parsed ⇒ refuse ALL. */
  degraded: boolean;
  hydrated: boolean;
}

export type ForceCloseHandler = () => Promise<{ closed: number; errors: string[] }>;

/**
 * TRA-4650 — fired on every kill-switch transition (engage AND release; a
 * force-close-all fires it too, via its internal engage). Lets the fleet
 * bridge push the latch into each engine's own TRA-526 kill switch without
 * this module importing any engine. Observers are best-effort: one throwing
 * must never stop the latch itself, nor the other observers.
 */
export type HardControlsKillObserver = (ev: {
  engaged: boolean;
  by: string | null;
  reason: string | null;
}) => void;

export interface ForceCloseHandlerResult {
  name: string;
  ok: boolean;
  closed: number;
  errors: string[];
}

function freshState(nowMs: number): HardControlsState {
  return {
    killSwitch: { engaged: false, by: null, atMs: null, reason: null },
    forceClose: { engaged: false, by: null, atMs: null },
    dayLoss: { etDay: etDateKey(nowMs), realizedPnlUsd: 0, lockedOut: false, lockedAtMs: null, unreadable: false },
    idempotency: {},
    degraded: false,
    hydrated: false,
  };
}

let state: HardControlsState = freshState(Date.now());
let dataDirOverride: string | null = null;
const forceCloseHandlers = new Map<string, ForceCloseHandler>();
const killObservers = new Set<HardControlsKillObserver>();

/** TRA-4650 — subscribe to kill-switch transitions. See {@link HardControlsKillObserver}. */
export function registerHardControlsKillObserver(observer: HardControlsKillObserver): void {
  killObservers.add(observer);
}

function notifyKillObservers(): void {
  const ev = {
    engaged: state.killSwitch.engaged,
    by: state.killSwitch.by,
    reason: state.killSwitch.reason,
  };
  for (const observer of killObservers) {
    try {
      observer(ev);
    } catch {
      // Best-effort by contract: the latch is already persisted; a broken
      // observer must not block the remaining observers or the caller.
    }
  }
}

function stateFilePath(): string {
  return join(dataDirOverride ?? resolveDataDir(), HARD_CONTROLS_STATE_FILENAME);
}

/**
 * Write-through persist. Fail-SOFT on the write itself (a full disk must not
 * take the evaluation path down — the in-memory latch still binds this
 * process), but REFUSED while degraded: overwriting an unparseable state file
 * would destroy the only evidence of what corrupted it.
 */
function persist(): void {
  if (state.degraded) return;
  try {
    const dir = dataDirOverride ?? resolveDataDir();
    mkdirSync(dir, { recursive: true });
    const persisted: HardControlsPersisted = {
      killSwitch: state.killSwitch,
      forceClose: state.forceClose,
      dayLoss: state.dayLoss,
      idempotency: state.idempotency,
    };
    const tmp = stateFilePath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf8');
    renameSync(tmp, stateFilePath());
  } catch {
    // fail-soft: in-memory latches still bind; durability status is published.
  }
}

/**
 * Boot hydrate. Missing file ⇒ clean cold start (normal). Present-but-
 * unparseable ⇒ DEGRADED: every admit() refuses until an operator inspects
 * the file — fail closed, per the deploy-hold precedent.
 */
export function hydrateHardControlsFromDisk(nowMs: number = Date.now()): void {
  state = freshState(nowMs);
  state.hydrated = true;
  const file = stateFilePath();
  if (!existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HardControlsPersisted>;
    if (raw && typeof raw === 'object'
      && raw.killSwitch && typeof raw.killSwitch.engaged === 'boolean'
      && raw.forceClose && typeof raw.forceClose.engaged === 'boolean'
      && raw.dayLoss && typeof raw.dayLoss.etDay === 'string'
      && raw.idempotency && typeof raw.idempotency === 'object') {
      state.killSwitch = raw.killSwitch;
      state.forceClose = raw.forceClose;
      // A hand-edited file missing the flag reads as readable=false, never as a latch.
      state.dayLoss = { ...raw.dayLoss, unreadable: raw.dayLoss.unreadable === true };
      state.idempotency = raw.idempotency;
      rollDayIfNeeded(nowMs);
    } else {
      state.degraded = true;
    }
  } catch {
    state.degraded = true;
  }
}

/** Day-loss state is scoped to the ET calendar day; the roll clears the latch. */
function rollDayIfNeeded(nowMs: number): void {
  const today = etDateKey(nowMs);
  if (state.dayLoss.etDay !== today) {
    const wasLatched = state.dayLoss.lockedOut || state.dayLoss.unreadable;
    const priorDay = state.dayLoss.etDay;
    state.dayLoss = { etDay: today, realizedPnlUsd: 0, lockedOut: false, lockedAtMs: null, unreadable: false };
    persist();
    // TRA-4658 — a roll that RE-ARMS trading is a state change worth a row;
    // a roll off a quiet day is not.
    if (wasLatched) {
      auditStateChange({
        action: 'daily_loss_lockout_cleared', outcome: 'rearmed', atMs: nowMs,
        reason: `ET day rolled ${priorDay} → ${today}; day-loss latch cleared`,
      });
    }
  }
}

function pruneIdempotency(nowMs: number): void {
  for (const [key, atMs] of Object.entries(state.idempotency)) {
    if (!(nowMs - atMs < HARD_IDEMPOTENCY_RETAIN_MS)) delete state.idempotency[key];
  }
}

/** Engage the fleet-wide kill switch. Synchronous — the very next admit() refuses. */
export function engageHardKillSwitch(by: string, reason: string, nowMs: number = Date.now()): void {
  state.killSwitch = { engaged: true, by, atMs: nowMs, reason: reason || null };
  persist();
  notifyKillObservers();
  // TRA-4658 — every manual intervention lands in the decision audit log.
  auditIntervention({
    action: 'hard_kill_switch_engaged', actor: by, reason: reason || null, atMs: nowMs,
  });
}

/**
 * Release. ALSO clears the force-close latch — a release is an explicit
 * operator statement that trading may resume, and leaving a hidden second
 * latch behind is how "released but still refusing" tickets get filed.
 */
export function releaseHardKillSwitch(by?: string): void {
  state.killSwitch = { engaged: false, by: null, atMs: null, reason: null };
  state.forceClose = { engaged: false, by: null, atMs: null };
  persist();
  notifyKillObservers();
  auditIntervention({
    action: 'hard_kill_switch_released', actor: by ?? null,
    reason: 'kill switch + force-close latch released; trading may resume',
  });
}

/**
 * Order sites that can flatten their own book register here at boot
 * (paper-trading engine in TRA-4657; existing engines when their wiring
 * ticket lands). The registry means force-close works against every engine
 * that exists WITHOUT this module importing any of them.
 */
export function registerForceCloseHandler(name: string, handler: ForceCloseHandler): void {
  forceCloseHandlers.set(name, handler);
}

/**
 * Control 7 — one-click exit everything at market. Engages the kill switch
 * FIRST (nothing may open while we are flattening), latches the force-close
 * flag (which waives quote-staleness on 'close' admits — the button's entire
 * point is "at market, now"), then runs every registered handler. A handler
 * that throws is reported, never swallowed.
 */
export async function requestForceCloseAll(
  by: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ handlers: ForceCloseHandlerResult[] }> {
  engageHardKillSwitch(by, `force-close-all: ${reason}`, nowMs);
  state.forceClose = { engaged: true, by, atMs: nowMs };
  persist();
  const results: ForceCloseHandlerResult[] = [];
  for (const [name, handler] of forceCloseHandlers) {
    try {
      const r = await handler();
      results.push({ name, ok: r.errors.length === 0, closed: r.closed, errors: r.errors });
    } catch (err) {
      results.push({ name, ok: false, closed: 0, errors: [err instanceof Error ? err.message : String(err)] });
    }
  }
  // TRA-4658 — the flatten order AND what every handler did, one audit row.
  auditIntervention({
    action: 'force_close_all', actor: by, reason, atMs: nowMs,
    outcome: results.every((r) => r.ok) ? 'executed' : 'partial',
    detail: { handlers: results },
  });
  return { handlers: results };
}

/**
 * Control 2 — fold a realized P&L delta into the ET day. Latches the lockout
 * at ≤ −$500. A NON-FINITE delta latches `unreadable` for the rest of the day:
 * once one fill's P&L is unknown the day total is unknown, and an unknown
 * total cannot be proven under the limit.
 */
export function recordHardControlsPnl(deltaUsd: number, nowMs: number = Date.now()): void {
  rollDayIfNeeded(nowMs);
  if (!Number.isFinite(deltaUsd)) {
    const wasUnreadable = state.dayLoss.unreadable;
    state.dayLoss.unreadable = true;
    persist();
    // TRA-4658 — the fail-closed latch is a state change; log the transition.
    if (!wasUnreadable) {
      auditStateChange({
        action: 'day_pnl_unreadable_latched', outcome: 'halted', atMs: nowMs,
        reason: `a fill's P&L on ${state.dayLoss.etDay} was non-finite; day total unprovable — opens refused for the day`,
      });
    }
    return;
  }
  state.dayLoss.realizedPnlUsd += deltaUsd;
  if (state.dayLoss.realizedPnlUsd <= -HARD_DAILY_LOSS_LIMIT_USD && !state.dayLoss.lockedOut) {
    state.dayLoss.lockedOut = true;
    state.dayLoss.lockedAtMs = nowMs;
    auditStateChange({
      action: 'daily_loss_lockout_latched', outcome: 'halted', atMs: nowMs,
      reason: `realized $${state.dayLoss.realizedPnlUsd.toFixed(2)} on ${state.dayLoss.etDay} breached the −$${HARD_DAILY_LOSS_LIMIT_USD} limit; auto-disabled until the ET day rolls`,
      detail: { realizedPnlUsd: state.dayLoss.realizedPnlUsd, limitUsd: HARD_DAILY_LOSS_LIMIT_USD },
    });
  }
  persist();
}

function refuse(reasonCode: HardControlReasonCode, reason: string): HardControlVerdict {
  return { allowed: false, reasonCode, reason };
}

/**
 * THE choke point. Every order-shaped action passes here before it may reach
 * a broker (or the paper book). NOT a pure function on purpose: an ALLOWED
 * verdict CONSUMES the intent's idempotency key, so calling it twice with the
 * same key refuses the second — which is the control. Grade-only callers
 * (health routes, dashboards) read `getHardControlsState()` instead.
 *
 * 'open' runs all seven checks. 'close' is risk-REDUCING and runs only:
 * state-readable, idempotency, and quote staleness — and staleness is waived
 * while the force-close latch is engaged (a mandated market exit must not be
 * stopped by the very feed problem that may have prompted it). The kill
 * switch does NOT block closes: "halt all strategies" halts risk-taking, and
 * being unable to exit while halted is the worse failure.
 */
export function admitOrderThroughHardControls(
  intent: HardControlIntent,
  nowMs: number = Date.now(),
): HardControlVerdict {
  const verdict = evaluateAdmitOrder(intent, nowMs);
  // TRA-4658 — EVERY choke-point verdict, allowed or refused, lands in the
  // decision audit log. Inside the choke point on purpose: an order path
  // cannot reach a broker without also reaching this line.
  auditOrderAdmit(intent, verdict, nowMs);
  return verdict;
}

function evaluateAdmitOrder(
  intent: HardControlIntent,
  nowMs: number,
): HardControlVerdict {
  // (0) fail-closed on unreadable persisted state — never grade off bytes we
  // could not read; a wiped latch and a clean slate must not look alike.
  if (state.degraded) {
    return refuse('hard_controls_state_unreadable',
      `hard controls REFUSED — persisted state (${HARD_CONTROLS_STATE_FILENAME}) exists but is unreadable; `
      + 'inspect/repair it before any order (fail-closed, TRA-4655)');
  }
  rollDayIfNeeded(nowMs);

  const isClose = intent.kind === 'close';

  if (!isClose) {
    // (1) global kill switch
    if (state.killSwitch.engaged) {
      return refuse('kill_switch_engaged',
        `hard controls REFUSED — global kill switch engaged by ${String(state.killSwitch.by)} `
        + `at ${state.killSwitch.atMs != null ? new Date(state.killSwitch.atMs).toISOString() : 'unknown'} `
        + `(${state.killSwitch.reason ?? 'no reason recorded'})`);
    }
    // (2) force-close latch: while a flatten is mandated, nothing opens.
    if (state.forceClose.engaged) {
      return refuse('force_close_engaged',
        `hard controls REFUSED — force-close-all engaged by ${String(state.forceClose.by)}; no opens while flattening`);
    }
    // (3) daily loss lockout
    if (state.dayLoss.unreadable) {
      return refuse('day_pnl_unreadable',
        `hard controls REFUSED — a fill's P&L on ${state.dayLoss.etDay} was unreadable, so the day total `
        + `cannot be proven under the $${HARD_DAILY_LOSS_LIMIT_USD} limit (fail-closed)`);
    }
    if (state.dayLoss.lockedOut) {
      return refuse('daily_loss_lockout',
        `hard controls REFUSED — daily loss lockout: realized $${state.dayLoss.realizedPnlUsd.toFixed(2)} `
        + `on ${state.dayLoss.etDay} breached the −$${HARD_DAILY_LOSS_LIMIT_USD} limit; auto-disabled until the ET day rolls`);
    }
    // (4) per-trade notional — `!(x > 0)` so NaN/undefined refuse.
    const notional = intent.notionalUsd;
    if (!(notional > 0) || !Number.isFinite(notional)) {
      return refuse('order_notional_unreadable',
        `hard controls REFUSED — order notional is unreadable (${String(notional)}); `
        + 'a non-finite notional cannot be graded against the cap');
    }
    if (notional > HARD_MAX_ORDER_NOTIONAL_USD) {
      return refuse('max_order_notional',
        `hard controls REFUSED — order notional $${notional.toFixed(2)} exceeds the `
        + `$${HARD_MAX_ORDER_NOTIONAL_USD} per-trade hard cap (refuse, never resize)`);
    }
    // (4b) headroom: refuse an open whose FULL loss would carry the day past
    // the limit — "triggers before exceeding $500", not after.
    if (state.dayLoss.realizedPnlUsd - notional < -HARD_DAILY_LOSS_LIMIT_USD) {
      return refuse('daily_loss_headroom',
        `hard controls REFUSED — day realized $${state.dayLoss.realizedPnlUsd.toFixed(2)} minus this order's `
        + `full $${notional.toFixed(2)} at risk would pass the −$${HARD_DAILY_LOSS_LIMIT_USD} daily limit`);
    }
    // (5) open position count — supplied by the order site; unreadable refuses.
    const count = intent.openPositionCount;
    if (!Number.isInteger(count) || count < 0) {
      return refuse('open_positions_unreadable',
        `hard controls REFUSED — open position count is unreadable (${String(count)})`);
    }
    if (count >= HARD_MAX_OPEN_POSITIONS) {
      return refuse('max_open_positions',
        `hard controls REFUSED — ${count} positions already open; the fleet-wide cap is ${HARD_MAX_OPEN_POSITIONS}`);
    }
  }

  // (6) quote staleness — on closes too, EXCEPT under the force-close mandate.
  if (!(isClose && state.forceClose.engaged)) {
    const asOf = intent.quoteAsOfMs;
    if (!Number.isFinite(asOf)) {
      return refuse('quote_timestamp_unreadable',
        `hard controls REFUSED — quote timestamp is unreadable (${String(asOf)}); `
        + 'a quote with no timestamp is not provably fresh');
    }
    const ageMs = nowMs - asOf;
    if (ageMs > HARD_MAX_QUOTE_AGE_MS) {
      return refuse('stale_quote',
        `hard controls REFUSED — quote is ${ageMs}ms old, over the ${HARD_MAX_QUOTE_AGE_MS}ms staleness limit`);
    }
    if (ageMs < -HARD_MAX_QUOTE_SKEW_MS) {
      return refuse('quote_clock_skew',
        `hard controls REFUSED — quote timestamp is ${-ageMs}ms in the FUTURE; under clock skew freshness is unprovable`);
    }
  }

  // (7) idempotency — consume-on-admit.
  const key = intent.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '') {
    return refuse('idempotency_key_missing',
      'hard controls REFUSED — order carries no idempotency key; every order must be deduplicable');
  }
  const priorAdmitMs = state.idempotency[key];
  if (priorAdmitMs !== undefined) {
    return refuse('duplicate_order',
      `hard controls REFUSED — idempotency key "${key}" was already admitted at `
      + `${new Date(priorAdmitMs).toISOString()}; duplicate submission blocked`);
  }
  pruneIdempotency(nowMs);
  state.idempotency[key] = nowMs;
  persist();

  return { allowed: true };
}

export interface HardControlsPublicState {
  degraded: boolean;
  killSwitch: HardControlsPersisted['killSwitch'];
  forceClose: HardControlsPersisted['forceClose'];
  dayLoss: HardControlsPersisted['dayLoss'];
  limits: {
    dailyLossLimitUsd: number;
    maxOrderNotionalUsd: number;
    maxOpenPositions: number;
    maxQuoteAgeMs: number;
  };
  idempotencyKeysHeld: number;
  forceCloseHandlers: string[];
  durability: { dataDir: string; ephemeral: boolean };
}

/** Read-only publication for the routes/health surface. Never spends anything. */
export function getHardControlsState(nowMs: number = Date.now()): HardControlsPublicState {
  if (!state.degraded) rollDayIfNeeded(nowMs);
  const dir = dataDirOverride ?? resolveDataDir();
  return {
    degraded: state.degraded,
    killSwitch: { ...state.killSwitch },
    forceClose: { ...state.forceClose },
    dayLoss: { ...state.dayLoss },
    limits: {
      dailyLossLimitUsd: HARD_DAILY_LOSS_LIMIT_USD,
      maxOrderNotionalUsd: HARD_MAX_ORDER_NOTIONAL_USD,
      maxOpenPositions: HARD_MAX_OPEN_POSITIONS,
      maxQuoteAgeMs: HARD_MAX_QUOTE_AGE_MS,
    },
    idempotencyKeysHeld: Object.keys(state.idempotency).length,
    forceCloseHandlers: [...forceCloseHandlers.keys()],
    durability: {
      dataDir: dir,
      ephemeral: isEphemeralDataDir(dataDirOverride ?? resolveDataDir(),
        dataDirOverride ? { DATA_DIR: dataDirOverride } as NodeJS.ProcessEnv : process.env),
    },
  };
}

/** Test seam: reset all module state; optionally pin DATA_DIR. */
export function __resetHardControlsForTest(opts?: { dataDir?: string; nowMs?: number }): void {
  dataDirOverride = opts?.dataDir ?? null;
  state = freshState(opts?.nowMs ?? Date.now());
  forceCloseHandlers.clear();
  killObservers.clear();
  // TRA-4658 — the audit tees fire from inside this module, so pin their dir
  // to the same sandbox; otherwise a hard-controls test writes audit rows
  // into the real DATA_DIR.
  __resetDecisionAuditForTest({
    dir: opts?.dataDir ? join(opts.dataDir, 'decision-audit') : null,
  });
}
