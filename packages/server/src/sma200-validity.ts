/**
 * TRA-3688 — SMA-200 signal validity (S-3) and the S-1 max-dist gate's env
 * resolution. Pure helpers, unit-tested apart from the engine loop.
 */
import type { Sma200Signal, Sma200VoidReason } from '@trading-app/shared';

/**
 * TRA-4411 (TRA-3688 S-1 flip) — the default max-dist gate, finite since
 * 2026-09-23. `3.0` is QuantTrader's resolved sweep output (n=2,780 pullback
 * fires, 692 symbols / 10y, deployed `evaluateSma200` unmodified): strongest
 * KEEP-vs-REJECT separation on the 1.5–5.0 scan (t=3.66 date-clustered at the
 * 20-bar mark), on a 2.25–3.25 plateau, FLIP at all four horizons under the
 * pre-registered rule. The honest claim is "raises expectancy per unit of risk
 * width", not "removes a losing cohort" (the rejected tail is positive OOS).
 */
export const SMA200_PULLBACK_MAX_DIST_ATR_DEFAULT = 3.0;

/**
 * TRA-3688 S-1 — resolve `SMA200_PULLBACK_MAX_DIST_ATR` from the environment.
 *
 * TRA-4411 — a truly ABSENT var now means the finite sweep-ratified default
 * above. Explicit `Infinity` (or any non-finite spelling) restores the old
 * dark gate, so the flip is reversible by config without a deploy.
 *
 * The TRA-3440 parse guard is unchanged and deliberately does NOT fall to the
 * finite default: a blank / garbage / non-positive value is an EXPLICIT value
 * we could not use, and it resolves DARK (`Infinity`), never `3.0` and never
 * `0`. `Number('')` is `0`, and a max-dist of 0 would reject every pullback
 * signal silently — a dark feed misread as a low reading. Failing a garbled
 * override to the permissive arm keeps a config typo from silently tightening
 * (or un-tightening) admission to a number nobody set.
 */
export function resolveSma200PullbackMaxDistAtr(env: NodeJS.ProcessEnv): number {
  const raw = env.SMA200_PULLBACK_MAX_DIST_ATR;
  if (raw === undefined) return SMA200_PULLBACK_MAX_DIST_ATR_DEFAULT;
  if (raw.trim() === '') return Infinity;
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
): Exclude<Sma200VoidReason, 'evicted'> | null {
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

/** True for the two SMA-200 display kinds (`sma200_pullback` / `sma200_reclaim`). */
export function isSma200SignalType(type: string): type is Sma200Signal['type'] {
  return type === 'sma200_pullback' || type === 'sma200_reclaim';
}

/**
 * TRA-4529 — pick the row to evict from an over-cap display ring (NEWEST
 * FIRST, i.e. index 0 is the row just pushed).
 *
 * The ring is shared by 5-day SMA-200 rows and the intraday stream (OTM
 * refusals run to thousands per session), so a plain `pop()` evicted the
 * SMA-200 rows minutes after the open with no void record — a third exit path
 * outside the S-3 "removed AND recorded" contract. SMA-200 rows are bounded on
 * their own (universe × 2 kinds, 5-bar debounce, S-3 voiding), so they take no
 * ring pressure: evict the OLDEST non-SMA-200 row instead.
 *
 * Index 0 is never chosen while any older row is evictable, so the newest row
 * is always served. Falls back to the oldest row (necessarily SMA-200) only
 * when every older row is SMA-200 — the caller must RECORD that eviction.
 * Returns -1 for a ring of fewer than 2 rows (nothing evictable but the new one).
 */
export function signalRingEvictionIndex(ring: ReadonlyArray<{ type: string }>): number {
  if (ring.length < 2) return -1;
  for (let i = ring.length - 1; i >= 1; i--) {
    if (!isSma200SignalType(ring[i].type)) return i;
  }
  return ring.length - 1;
}
