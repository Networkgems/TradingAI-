// TRA-1051 (TRA-1044 F2) — rate-limit-aware cold-start daily-candle prefetch.
//
// Background: TRA-1044 F2 as originally specced (raise CANDLE_BATCH /
// DAILY_REFRESH_PER_TICK) was NOT shipped because those caps are hard-won
// 429-avoidance tuning — DAILY_REFRESH_PER_TICK=16 + the COLD_SCAN sharding
// (TRA-739) keep the rolling Tradier/Coinbase candle meter under the ~200/min
// target. Raising them trades per-tick latency for request bursts that trip
// 429s, and a 429 cold start is a no-data-skip flood = changed signals, which
// fails TRA-1044's identical-signals acceptance.
//
// This flag governs the SAFE alternative: an async one-shot boot warmer that
// front-loads the daily-candle cache through the SAME paced fetch path the
// steady-state loop uses (so it shares the pacer + breaker + the 1h fetch-gate
// in `refreshDailyCandles`, and cannot double-fetch a symbol the tick already
// warmed). The warmer self-throttles to a configurable per-minute budget that
// is INDEPENDENT of the steady-state per-tick cap, so it can use cold-start
// headroom to shrink the no-data-skip window — without permanently raising the
// steady-state burst the way bumping the per-tick caps would.
//
// OFF by default. Per the TRA-1044 acceptance, any rate change above the
// steady-state daily budget must be gated on a measured rate-limit-headroom
// check + a 429-free soak with QuantTrader sign-off before enabling. With the
// flag OFF the warmer never runs, so prod behaviour is byte-for-byte unchanged.

export const COLD_START_DAILY_PREFETCH_FLAG = 'ENABLE_COLD_START_DAILY_PREFETCH';
export const COLD_START_DAILY_PREFETCH_PER_MIN_VAR = 'COLD_START_DAILY_PREFETCH_PER_MIN';

/**
 * Default per-minute fetch budget for the boot warmer when enabled. Chosen
 * conservatively: 48/min is 3× the steady-state crypto daily cap (16/min) yet
 * still far under the ~200/min meter ceiling, leaving headroom for the quote
 * fan-out + intraday loop that share the budget. QuantTrader tunes this on the
 * soak via {@link COLD_START_DAILY_PREFETCH_PER_MIN_VAR} before flag-on.
 */
export const DEFAULT_PREFETCH_PER_MIN = 48;

/** Hard ceiling on the configurable budget so a fat-finger env can't unleash a
 *  full-speed burst that breaches the meter. */
export const MAX_PREFETCH_PER_MIN = 120;

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the cold-start daily-candle prefetch warmer is enabled. */
export function isColdStartDailyPrefetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[COLD_START_DAILY_PREFETCH_FLAG]);
}

/**
 * Resolve the warmer's per-minute fetch budget. Falls back to
 * {@link DEFAULT_PREFETCH_PER_MIN} when unset/invalid, and is clamped to
 * (0, {@link MAX_PREFETCH_PER_MIN}] so the warmer can never be configured to
 * exceed the meter-ceiling guardrail.
 */
export function resolveColdStartPrefetchPerMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[COLD_START_DAILY_PREFETCH_PER_MIN_VAR];
  const n = typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PREFETCH_PER_MIN;
  return Math.min(Math.floor(n), MAX_PREFETCH_PER_MIN);
}

// ── TRA-1059: last-run status for the boot warmer ────────────────────────────
// `warmDailyCandlesOnBoot` only logged its start/done lines, which are
// Render-log-only on prod. QuantTrader needs to confirm from an HTTP probe that
// (a) the flag is actually set on the demo book and (b) what the warm produced,
// without log access. This in-memory singleton holds the most recent run so
// `/api/health/cold-start-prefetch` can surface it. Process-global (the warmer is
// a one-shot per boot) and resets with the process — no persistence needed.

/** Most-recent cold-start prefetch run, as surfaced by the health probe. */
export interface ColdStartPrefetchRun {
  /** ISO-8601 start time of the run. */
  startedAt: string;
  /** Active-symbol universe size the warmer set out to warm. */
  symbols: number;
  /** Resolved per-minute fetch budget for this run. */
  perMin: number;
  /** Symbols warmed so far (== `symbols` once `completed`). */
  warmed: number;
  /** Wall-clock ms elapsed (final once `completed`, in-progress otherwise). */
  elapsedMs: number;
  /** False while the warmer loop is still running; true once it finished. */
  completed: boolean;
}

let lastColdStartPrefetchRun: ColdStartPrefetchRun | null = null;

/** Record (or update) the current/last warmer run. Called by the warmer at
 *  start (completed=false) and on completion (completed=true). */
export function recordColdStartPrefetchRun(run: ColdStartPrefetchRun): void {
  lastColdStartPrefetchRun = run;
}

/** Read-only snapshot for `/api/health/cold-start-prefetch`: the flag/budget the
 *  process currently sees plus the most-recent run (null if the warmer never ran
 *  this boot — i.e. flag OFF or no active symbols). */
export function getColdStartPrefetchStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  perMin: number;
  lastRun: ColdStartPrefetchRun | null;
} {
  return {
    enabled: isColdStartDailyPrefetchEnabled(env),
    perMin: resolveColdStartPrefetchPerMin(env),
    lastRun: lastColdStartPrefetchRun,
  };
}

/** Test seam — clear the recorded run between unit tests. */
export function _resetColdStartPrefetchRunForTests(): void {
  lastColdStartPrefetchRun = null;
}
