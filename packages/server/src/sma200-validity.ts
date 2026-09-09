/**
 * TRA-3688 — SMA-200 signal validity (S-3) and the S-1 max-dist gate's env
 * resolution. Pure helpers, unit-tested apart from the engine loop.
 */
import type { Sma200Signal, Sma200VoidReason } from '@trading-app/shared';

/**
 * TRA-3688 S-1 — resolve `SMA200_PULLBACK_MAX_DIST_ATR` from the environment.
 *
 * Ships DARK: the default is `Infinity` (zero behavior change), and the finite
 * threshold is a backtest output owned by QuantTrader's `{1.5, 2.0, 2.5, 3.0,
 * Infinity}` sweep — never asserted here.
 *
 * Guarded the TRA-3440 way: an absent / blank / garbage / non-positive value
 * means the DEFAULT, never `0`. `Number('')` is `0`, and a max-dist of 0 would
 * reject every pullback signal silently — a dark feed misread as a low reading.
 */
export function resolveSma200PullbackMaxDistAtr(env: NodeJS.ProcessEnv): number {
  const raw = env.SMA200_PULLBACK_MAX_DIST_ATR;
  if (raw === undefined || raw.trim() === '') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return n;
}

/**
 * TRA-3688 S-3b — drift bound: a resting signal is void once the live quote
 * has moved more than this many ATR14s from the recorded entry. 0.5 because
 * 1.0 demonstrably bound on zero of the 8 live rows at spec time — a bound
 * that never binds is not a control.
 */
export const SMA200_DRIFT_VOID_ATR = 0.5;

/**
 * TRA-3688 S-3 — decide whether a resting SMA-200 signal is void.
 *
 * - **S-3a (`bar_rollover`, primary):** void once a NEWER daily bar exists for
 *   the symbol. Expressed as bar identity, not an hours threshold — XETRA's
 *   session is not NYSE's, so any single hours rule is wrong for one venue.
 *   The caller supplies `latestBarTs` from the daily series it just fetched;
 *   this degrades to "a newer `barTimestamp` exists", which is calendar-free
 *   and still correct.
 * - **S-3b (`price_drift`, backstop):** void when `|lastPrice − entryPrice| >
 *   0.5 × atr14`. Does no work on the fire day (entry IS the daily close) and
 *   all of its work on a signal still resting inside a live session.
 *
 * Returns the void reason, or `null` when the signal remains valid. Order
 * matters: S-3a carries the weight and is checked first.
 */
export function sma200VoidVerdict(
  sig: Pick<Sma200Signal, 'entryPrice' | 'atr14' | 'barTimestamp'>,
  ctx: { latestBarTs?: number; lastPrice?: number },
): Sma200VoidReason | null {
  if (
    ctx.latestBarTs !== undefined
    && typeof sig.barTimestamp === 'number'
    && ctx.latestBarTs > sig.barTimestamp
  ) {
    return 'bar_rollover';
  }
  if (
    ctx.lastPrice !== undefined
    && Number.isFinite(ctx.lastPrice)
    && ctx.lastPrice > 0
    && Number.isFinite(sig.atr14)
    && sig.atr14 > 0
    && Math.abs(ctx.lastPrice - sig.entryPrice) > SMA200_DRIFT_VOID_ATR * sig.atr14
  ) {
    return 'price_drift';
  }
  return null;
}

/**
 * TRA-4457 — the subset of a sweep census needed to decide whether an empty
 * `signals[]` carries any information. Structurally compatible with
 * `Sma200ScanStats`; kept narrow so this stays a pure helper with no dependency
 * on the engine module.
 */
export interface Sma200SweepCensus {
  /** Symbols handed to the sweep. */
  considered: number;
  /** Symbols that yielded >= SMA200_MIN_BARS bars and were actually scored. */
  evaluated: number;
  /** Came back short while the Yahoo breaker was open — we never asked. */
  starvedBreakerOpen: number;
  /** Came back short with the breaker closed — genuinely short listing history. */
  starvedShortHistory: number;
  /** Fetch threw outright. */
  fetchFailed: number;
}

/**
 * TRA-4457 — what a sweep's empty feed is allowed to mean.
 *
 * - `SWEPT`   — at least one symbol was scored. An empty `signals[]` is a real
 *               "no setup fired" and may be reported as such.
 * - `BLIND`   — nothing was scored though symbols were offered. The feed is
 *               empty because the sweep could not look, so NO conclusion about
 *               the market may be drawn from it.
 * - `NO_UNIVERSE` — the sweep was handed no symbols at all. A different fault
 *               (upstream watchlist) from a starved feed, so it is not folded
 *               into `BLIND`.
 */
export type Sma200SweepVerdict = 'SWEPT' | 'BLIND' | 'NO_UNIVERSE';

/**
 * Grade a sweep census.
 *
 * ⚠️ The load-bearing case is the one that looks like nothing: a HEALTHY sweep
 * that scored symbols and fired nothing must read `SWEPT`, not `BLIND` — that is
 * the arm that separates a quiet market from a starved one, and it is the whole
 * reason this function exists. Grading on `fired` instead of `evaluated` would
 * collapse both into one verdict and re-create the defect.
 */
export function sma200SweepVerdict(c: Sma200SweepCensus): Sma200SweepVerdict {
  if (c.considered <= 0) return 'NO_UNIVERSE';
  if (c.evaluated > 0) return 'SWEPT';
  return 'BLIND';
}

/** Total symbols the sweep failed to score, by any cause. */
export function sma200SweepStarved(c: Sma200SweepCensus): number {
  return c.starvedBreakerOpen + c.starvedShortHistory + c.fetchFailed;
}
