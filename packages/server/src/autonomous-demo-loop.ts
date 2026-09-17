// ── Autonomous demo trading loop (TRA-1004) ──────────────────────────────────
//
// Parent: TRA-990. The owner wants the in-app brain to self-run and self-adjust
// on the DEMO book continuously, with nobody on the team driving it daily. The
// brain already exists — the per-user `SignalEngine` (stocks/options) ticks
// on its own 30s timer, and the TRA-995 risk autopilot
// already runs inside the daily governor. This module is the standing CONDUCTOR
// that makes the demo book drive itself unattended:
//
//   • a fast intraday cadence (per-minute by default, NOT sub-minute HFT — that
//     was analysed NO-GO for this stack on TRA-960/963),
//   • that, each tick, enables demo auto-trading and drives one decision cycle
//     across stocks/options on every DEMO-mode book,
//   • with the TRA-995 autopilot kept in-loop as the guard: a halted book is
//     skipped (no new entries forced), so an autopilot halt demonstrably stops
//     the loop,
//   • and surfaces its activity (ticks, books driven, halts, throttles) for the
//     `/api/health` + EOD surfaces.
//
// STRICTLY behind `ENABLE_AUTONOMOUS_DEMO_LOOP` (default-OFF). Like the TRA-1003
// external-intel scheduler, every tick checks the flag FIRST and short-circuits
// BEFORE it enumerates books or reads any engine state, so a deploy with the
// flag off does ZERO work — it is just one cheap env read per interval. Flipping
// the flag ON is a demo-sandbox operator decision (NO board gate — demo is the
// sandbox, no live-capital path) and is picked up on the next tick without a
// restart.
//
// DEMO ONLY. The driver this module is given only ever enables the *demo* book
// (`setAutoTrading(true, 'demo')`); there is no path here that can flip a live
// auto-trade flag or place a live order. The adapter that builds the drivers
// (index.ts) filters to `mode === 'demo'` books before this module ever sees
// them.

import { logger } from './observability/index.js';
import type { AutopilotAction } from './risk-autopilot.js';

const log = logger.child({ module: 'autonomous-demo-loop' });

export const AUTONOMOUS_DEMO_LOOP_FLAG = 'ENABLE_AUTONOMOUS_DEMO_LOOP';

/** True when the autonomous demo loop is enabled. Default OFF. */
export function isAutonomousDemoLoopEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[AUTONOMOUS_DEMO_LOOP_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Default cadence: per-minute. Continuous-but-sane intraday decisioning, on the
 * same order as the engines' own 30s internal tick. NOT per-second HFT.
 */
export const DEFAULT_INTERVAL_MS = 60 * 1000;
/**
 * Floor so a misconfigured env can't turn this into a sub-minute scalper — that
 * regime was analysed NO-GO for this stack (TRA-960/963). 15s is fast-but-sane.
 */
const MIN_INTERVAL_MS = 15 * 1000;

/** Parse a positive-int interval from env, clamped to the floor; default 60s. */
export function resolveAutonomousLoopIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env['AUTONOMOUS_DEMO_LOOP_INTERVAL_MS'] ?? '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(Math.round(n), MIN_INTERVAL_MS);
}

/** Gating context handed to each book's drive — what may fire this tick. */
export interface DemoLoopGates {
  /**
   * True when the US equity market is open. Stocks/options decisioning only
   * fires in-session.
   */
  stocksMarketOpen: boolean;
}

/**
 * The read-only + drive seam for ONE demo book. The index.ts adapter implements
 * this over a real `UserContext` (stocks `SignalEngine`); tests inject a fake.
 * The loop only ever calls `driveStocks` on a book it has NOT found halted, which is what makes "autopilot halt stops the
 * loop" hold and be unit-testable.
 */
export interface DemoBookEngine {
  username: string;
  /**
   * Equity/options halt state — true ⇒ the STOCKS leg is skipped this tick.
   * Includes the transient equity feed-stale gate (latched breakers + kill +
   * feed_stale). This is the book-wide "halted" flag surfaced for health/EOD.
   */
  isHalted(): boolean;
  /** Human-readable halt reason, surfaced when halted. */
  haltReason(): string | null;
  /** Tighten-only risk multiplier in (0, 1]; 1 ⇒ full size. */
  riskThrottle(): number;
  /** Active market regime if known (regime-adaptive selection signal). */
  regime(): string | null;
  /** Newest autopilot actions to surface (already capped by the engine). */
  recentAutopilotActions(): AutopilotAction[];
  /** Open stock/option position count after the cycle (visibility). */
  openStocks(): number;
  /** Enable demo auto-trading + drive one stocks/options decision cycle. */
  driveStocks(): void | Promise<void>;
}

/** Per-book decision summary the loop records for health + EOD. */
export interface DemoBookDecision {
  username: string;
  /** True if a stocks/options decision cycle was driven this tick. */
  droveStocks: boolean;
  /** Autopilot/kill halt state — when true the book was skipped (no entries). */
  halted: boolean;
  haltReason: string | null;
  /** Tighten-only risk multiplier in (0, 1] (1 = full size). */
  riskThrottle: number;
  /** Newest autopilot actions surfaced this tick. */
  autopilotActions: AutopilotAction[];
  openStocks: number;
  /** Active regime if known. */
  regime: string | null;
}

/** What one scheduled tick did — for logging, health, and tests. */
export interface AutonomousDemoTickOutcome {
  ran: boolean;
  /** Why a tick didn't run, when `ran` is false. */
  reason?: 'disabled';
  /** `nowMs` the tick was evaluated at. */
  tickAtMs: number;
  stocksMarketOpen: boolean;
  /** Count of books that had at least one engine driven this tick. */
  booksDriven: number;
  decisions: DemoBookDecision[];
}

/** Injectable seams — the schedule supplies these; tests inject fakes. */
export interface AutonomousDemoLoopDeps {
  /**
   * Enumerate the DEMO-mode books to drive. Only ever called once the flag is
   * on, so a disabled loop never touches engine state.
   */
  listBooks: () => DemoBookEngine[];
  /** True when the US equity market is open (scheduler `isMarketOpen`). */
  isStocksMarketOpen: () => boolean;
}

/**
 * Run ONE autonomous-demo tick. The flag is checked FIRST, before any books are
 * enumerated, so a tick with `ENABLE_AUTONOMOUS_DEMO_LOOP` off does zero IO and
 * never touches an engine. With the flag on it drives stocks/options only
 * in-session, SKIPPING any book the autopilot has halted, and
 * records the outcome for the health + EOD surfaces.
 */
export async function runAutonomousDemoTick(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  deps?: AutonomousDemoLoopDeps,
): Promise<AutonomousDemoTickOutcome> {
  // Gate BEFORE enumerating books — this is what makes the loop free while off.
  if (!isAutonomousDemoLoopEnabled(env)) {
    status.enabled = false;
    return {
      ran: false,
      reason: 'disabled',
      tickAtMs: nowMs,
      stocksMarketOpen: false,
      booksDriven: 0,
      decisions: [],
    };
  }
  status.enabled = true;

  if (!deps) {
    // Armed without a driver (shouldn't happen in prod); nothing to do.
    return { ran: true, tickAtMs: nowMs, stocksMarketOpen: false, booksDriven: 0, decisions: [] };
  }

  const stocksMarketOpen = deps.isStocksMarketOpen();
  const books = deps.listBooks();
  const decisions: DemoBookDecision[] = [];
  let booksDriven = 0;

  for (const book of books) {
    const halted = book.isHalted();
    let droveStocks = false;

    // Stocks/options only when the equity market is open AND the equity leg is
    // not halted (a halted book forces NO new equity entries).
    if (!halted && stocksMarketOpen) {
      try {
        await book.driveStocks();
        droveStocks = true;
      } catch (err) {
        log.error('autonomous demo book stocks drive failed', {
          username: book.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (droveStocks) booksDriven += 1;

    decisions.push({
      username: book.username,
      droveStocks,
      halted,
      haltReason: halted ? book.haltReason() : null,
      riskThrottle: book.riskThrottle(),
      autopilotActions: book.recentAutopilotActions(),
      openStocks: book.openStocks(),
      regime: book.regime(),
    });
  }

  const outcome: AutonomousDemoTickOutcome = {
    ran: true,
    tickAtMs: nowMs,
    stocksMarketOpen,
    booksDriven,
    decisions,
  };
  recordTick(outcome);
  return outcome;
}

// ── Status registry (firm-wide; surfaced in /api/health + EOD) ────────────────

const MAX_RECENT_TICKS = 20;

interface LoopStatus {
  enabled: boolean;
  intervalMs: number;
  ticksRun: number;
  lastTickAtMs: number | null;
  lastOutcome: AutonomousDemoTickOutcome | null;
  recent: AutonomousDemoTickOutcome[];
}

const status: LoopStatus = {
  enabled: false,
  intervalMs: 0,
  ticksRun: 0,
  lastTickAtMs: null,
  lastOutcome: null,
  recent: [],
};

function recordTick(outcome: AutonomousDemoTickOutcome): void {
  status.ticksRun += 1;
  status.lastTickAtMs = outcome.tickAtMs;
  status.lastOutcome = outcome;
  status.recent.push(outcome);
  if (status.recent.length > MAX_RECENT_TICKS) {
    status.recent = status.recent.slice(-MAX_RECENT_TICKS);
  }
}

/** Live status snapshot for the `/api/health/autonomous-demo` surface. */
export function getAutonomousDemoStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  intervalMs: number;
  ticksRun: number;
  lastTickAt: string | null;
  lastOutcome: AutonomousDemoTickOutcome | null;
  recent: AutonomousDemoTickOutcome[];
} {
  return {
    enabled: isAutonomousDemoLoopEnabled(env),
    intervalMs: status.intervalMs,
    ticksRun: status.ticksRun,
    lastTickAt: status.lastTickAtMs == null ? null : new Date(status.lastTickAtMs).toISOString(),
    lastOutcome: status.lastOutcome,
    recent: [...status.recent],
  };
}

/** Compact rollup folded into the EOD report (one block per demo book run). */
export interface AutonomousDemoLoopReport {
  enabled: boolean;
  intervalMs: number;
  ticksRun: number;
  lastTickAt: string | null;
  lastBooksDriven: number;
  /** Halts seen in the most recent tick. */
  halts: Array<{ username: string; reason: string | null }>;
  /** Active throttles (<1) seen in the most recent tick. */
  throttles: Array<{ username: string; riskThrottle: number }>;
}

/** Build the EOD-report rollup from the live status. Null when never ran. */
export function buildAutonomousDemoLoopReport(
  env: NodeJS.ProcessEnv = process.env,
): AutonomousDemoLoopReport {
  const last = status.lastOutcome;
  const halts = (last?.decisions ?? [])
    .filter((d) => d.halted)
    .map((d) => ({ username: d.username, reason: d.haltReason }));
  const throttles = (last?.decisions ?? [])
    .filter((d) => d.riskThrottle < 1)
    .map((d) => ({ username: d.username, riskThrottle: d.riskThrottle }));
  return {
    enabled: isAutonomousDemoLoopEnabled(env),
    intervalMs: status.intervalMs,
    ticksRun: status.ticksRun,
    lastTickAt: status.lastTickAtMs == null ? null : new Date(status.lastTickAtMs).toISOString(),
    lastBooksDriven: last?.booksDriven ?? 0,
    halts,
    throttles,
  };
}

/** Test seam — reset the in-memory status registry. */
export function resetAutonomousDemoStatusForTest(): void {
  status.enabled = false;
  status.intervalMs = 0;
  status.ticksRun = 0;
  status.lastTickAtMs = null;
  status.lastOutcome = null;
  status.recent = [];
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/** Handle for a running schedule; call `stop()` on shutdown. */
export interface AutonomousDemoSchedule {
  stop(): void;
}

export interface StartAutonomousDemoScheduleOpts {
  env?: NodeJS.ProcessEnv;
  /**
   * TRA-1008 — optional per-tick env resolver. When provided, the EFFECTIVE env
   * for every tick (and the cheap-off gate) is re-resolved on each fire instead
   * of captured once at arm time. This is how the file-backed demo-flag override
   * (`<DATA_DIR>/demo-flags.json`) flips the loop on/off without a restart on a
   * host where the PM2 daemon is unreachable to a non-admin user. Falls back to
   * `env` when omitted (the unit-test path).
   */
  resolveEnv?: () => NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
  /** Required in prod: the book enumerator + market-open check. */
  deps?: AutonomousDemoLoopDeps;
  /** Test seam — defaults to the real tick. */
  tick?: typeof runAutonomousDemoTick;
}

/**
 * Start the autonomous-demo conductor. The interval is ALWAYS armed (so an
 * operator can flip the flag on without a restart), but each tick no-ops cheaply
 * while `ENABLE_AUTONOMOUS_DEMO_LOOP` is off. The timer is `unref`'d so it never
 * keeps the process alive on its own, and a tick that throws is logged, never
 * crashing the boot path or a future tick. Returns a handle whose `stop()`
 * clears the timer.
 */
export function startAutonomousDemoSchedule(
  opts: StartAutonomousDemoScheduleOpts = {},
): AutonomousDemoSchedule {
  const resolveEnv = opts.resolveEnv ?? (() => opts.env ?? process.env);
  const env = resolveEnv();
  const intervalMs = opts.intervalMs ?? resolveAutonomousLoopIntervalMs(env);
  const now = opts.now ?? (() => Date.now());
  const tick = opts.tick ?? runAutonomousDemoTick;
  const deps = opts.deps;
  status.intervalMs = intervalMs;

  const fire = (): void => {
    // Re-resolve per tick so a file-backed demo-flag flip (TRA-1008) takes
    // effect without a restart; defaults to the arm-time env in unit tests.
    void tick(now(), resolveEnv(), deps)
      .then((outcome) => {
        if (outcome.ran) {
          log.info('autonomous demo loop tick', {
            booksDriven: outcome.booksDriven,
            books: outcome.decisions.length,
            stocksMarketOpen: outcome.stocksMarketOpen,
            halted: outcome.decisions.filter((d) => d.halted).length,
          });
        }
      })
      .catch((err) => {
        log.error('autonomous demo loop tick failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const timer = setInterval(fire, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('autonomous demo loop armed', {
    intervalMs,
    enabledNow: isAutonomousDemoLoopEnabled(env),
  });
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
