import { isStockMarketOpen, nextStockMarketOpen, type AccountMode } from '@trading-app/shared';
import type { LiveExitPassBlocker, LiveExitPassStatus } from './options-account.js';

/**
 * TRA-3839 — does an options exit pass reach a given book's LIVE rows?
 *
 * Its own module, and not three expressions inside `signal-engine.ts`, for one
 * reason: this is the half of the instrument that decides whether a breached
 * real-money row counts as unattended, and a decision that cannot be exercised
 * without booting a `SignalEngine` is a decision that gets shipped ungraded.
 * `signal-engine.ts` imports both symbols below; the exit-pass site and the
 * health readout therefore share ONE expression rather than two copies kept
 * byte-comparable by hand.
 */

/**
 * Is an options exit pass calling `checkExits` at all right now?
 *
 * On a DEMO engine, around the clock. On a LIVE one, only inside RTH — TRA-726's
 * no-day-trading hold, `signal-engine.ts:5551`. That second clause is why a live
 * book can publish `actionable: 1` all evening with nothing evaluating it, and
 * it is the fact `/api/health/exit-cadence` does not carry.
 */
export function optionsExitPassRuns(mode: AccountMode, now: number = Date.now()): boolean {
  return mode === 'demo' || isStockMarketOpen(now);
}

/**
 * How stale `lastExitPassAt` has to get before we call the tick loop STOPPED
 * rather than merely between passes.
 *
 * Derived, not fitted: `tickTimer` is `setInterval(…, 30_000)`
 * (`signal-engine.ts:4103`) and `stampExitPass('tick')` fires once per tick, so
 * this is FOUR consecutive missed ticks. It is also exactly the `lt120s`
 * boundary the existing `bucketExitInterval` histogram already treats as the
 * pathological bin, so a stall this reports is a stall that bucket is already
 * counting.
 *
 * A false positive needs BOTH a stalled loop AND a breached live row, because
 * everything this qualifies is row-gated — the cost of being wrong is bounded by
 * the population that was already the incident.
 */
export const EXIT_PASS_STALE_MS = 4 * 30_000;

/** The engine facts the walk needs. All four are read off one engine instance. */
export interface LiveExitPassInput {
  /** The ENGINE's mode — what `checkExits` is handed, not the row's own stamp. */
  mode: AccountMode;
  /** `SignalEngine.exitPassCount` — passes stamped since boot. */
  exitPassCount: number;
  /** `SignalEngine.lastExitPassAt`, or 0 when none has been stamped. */
  lastExitPassAt: number;
  now?: number;
  /** Injectable for the controls only. */
  staleMs?: number;
}

/**
 * Walk the blockers OUTERMOST-FIRST and stop at the first that refuses, so
 * `blockedBy` names the thing that would still be refusing if everything below
 * it cleared. Same "first refusing gate" discipline `LiveStopInertReason` uses
 * one level down, for the same reason: a row can satisfy several, and only the
 * first is the one that actually did the not-running.
 *
 *   1. `no_pass_observed` — nothing stamped since boot.
 *   2. `pass_stalled`     — the tick loop has gone quiet.
 *   3. `engine_mode_demo` — the pass runs, but `checkExits` gets `'demo'` and
 *                           mode-skips every live row (TRA-231 filter).
 *   4. `market_closed`    — a live book does not call `checkExits` outside RTH.
 *
 * ⚠️ `armedEngineCount` / `timerArmed` off `/api/health/exit-cadence` is NOT in
 * this walk and must not be added. Those grade the DECOUPLED hoist, while
 * `doTick` calls `runOptionsExitPass` unconditionally at `signal-engine.ts:5905`
 * — TRA-3821 measured three live engines reading `armedEngineCount: 0` next to
 * `tickPassCount` 251/253/250. Keying on the timer arm would report the entire
 * healthy live fleet as unattended, and an over-matching detector voids every
 * future clean read.
 */
export function resolveLiveExitPassStatus(input: LiveExitPassInput): LiveExitPassStatus {
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? EXIT_PASS_STALE_MS;
  const lastPassAgeMs = input.lastExitPassAt > 0 ? now - input.lastExitPassAt : null;
  const blockedBy: LiveExitPassBlocker | null =
    input.exitPassCount === 0 ? 'no_pass_observed'
    : lastPassAgeMs !== null && lastPassAgeMs > staleMs ? 'pass_stalled'
    : input.mode !== 'live' ? 'engine_mode_demo'
    : !optionsExitPassRuns(input.mode, now) ? 'market_closed'
    : null;
  return {
    reaches: blockedBy === null,
    blockedBy,
    // Only `market_closed` releases on a clock. The other three need a human,
    // and a timestamp against them would advertise a resumption that nothing is
    // scheduled to deliver — the same reason `fullyReleasesAt` nulls rather than
    // publishing its clocked value while an indefinite row is outstanding.
    resumesAt: (() => {
      if (blockedBy !== 'market_closed') return null;
      const at = nextStockMarketOpen(now);
      return at === null ? null : new Date(at).toISOString();
    })(),
    lastPassAgeMs,
  };
}
