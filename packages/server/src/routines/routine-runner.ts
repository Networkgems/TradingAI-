// TRA-851 — routine fire loop.
//
// The scheduler polls every 60s; on each tick it calls {@link RoutineRunner.tick}.
// The runner owns the timing + dedup: for every user with routines, it fires any
// ENABLED routine whose `timeEt` equals the current ET minute (and, when
// `marketDaysOnly`, only on NYSE trading days), then asks the injected executor
// to produce the message and the injected sink to deliver it.
//
// Dedup mirrors the scheduler's own per-day guards: an in-memory
// `lastFired[user::routineId] = etDate` keeps a routine to one fire per ET day
// even though the 60s poll lands on the same minute more than once under clock
// jitter. The delivery layer (dispatcher) dedups again by the same day key, so a
// process restart inside the minute still can't double-send.
//
// The runner is engine-agnostic: `execute` and `emit` are injected, so the whole
// loop is unit-testable with fakes and zero engine/dispatcher wiring.

import { logger, type Logger } from '../observability/index.js';
import type { StoredRoutine } from './routine-store.js';

const log = logger.child({ module: 'routine-runner' });

/** The rendered output of a routine action, pushed to the user's channels. */
export interface RoutineRendered {
  title: string;
  body: string;
}

export interface RoutineRunnerDeps {
  /** Current ET wall-clock parts + date for time-matching + the per-day dedup key. */
  nowEt: { hour: number; minute: number; date: string };
  /** Whether `date` (YYYY-MM-DD) is a NYSE trading day — gates `marketDaysOnly`. */
  isMarketDay: (date: string) => boolean;
  /** Users that currently have routines. */
  users: () => string[];
  /** A user's routines (enabled + disabled). */
  listRoutines: (user: string) => StoredRoutine[];
  /** Run the routine's action for the user; null when there is nothing to send. */
  execute: (user: string, routine: StoredRoutine) => Promise<RoutineRendered | null>;
  /** Deliver a fired routine's output to the user. */
  emit: (user: string, routine: StoredRoutine, rendered: RoutineRendered) => void;
}

/**
 * Pure selector: the routines that should fire at `hhmm` on a day that is
 * (`marketDay`) a trading day or not. Disabled routines and time mismatches are
 * skipped; `marketDaysOnly` routines are skipped on non-trading days.
 */
export function selectDueRoutines(
  routines: readonly StoredRoutine[],
  hhmm: string,
  marketDay: boolean,
): StoredRoutine[] {
  return routines.filter((r) => {
    if (!r.enabled) return false;
    if (r.timeEt !== hhmm) return false;
    if (r.marketDaysOnly && !marketDay) return false;
    return true;
  });
}

export class RoutineRunner {
  /** `user::routineId` → ET date (YYYY-MM-DD) of the last fire. Per-day dedup. */
  private readonly lastFired = new Map<string, string>();
  private readonly log: Logger;

  constructor(logOverride?: Logger) {
    this.log = logOverride ?? log;
  }

  /**
   * One scheduler tick. Fires every due, not-yet-fired-today routine for every
   * user. Per-routine failures are isolated so one bad routine (or user) can't
   * starve the rest. Always resolves.
   */
  async tick(deps: RoutineRunnerDeps): Promise<void> {
    const { hour, minute, date } = deps.nowEt;
    const hhmm = `${pad2(hour)}:${pad2(minute)}`;
    const marketDay = deps.isMarketDay(date);

    let fired = 0;
    for (const user of deps.users()) {
      let routines: StoredRoutine[];
      try {
        routines = deps.listRoutines(user);
      } catch (err) {
        this.log.warn('routine list failed', { user, reason: errMsg(err) });
        continue;
      }
      for (const routine of selectDueRoutines(routines, hhmm, marketDay)) {
        const key = `${user}::${routine.id}`;
        if (this.lastFired.get(key) === date) continue; // already fired today
        this.lastFired.set(key, date);
        try {
          const rendered = await deps.execute(user, routine);
          if (rendered) {
            deps.emit(user, routine, rendered);
            fired += 1;
          }
        } catch (err) {
          this.log.error('routine fire failed', {
            user,
            id: routine.id,
            action: routine.action,
            reason: errMsg(err),
          });
        }
      }
    }
    if (fired > 0) this.log.info('routines fired', { date, time: hhmm, fired });
  }

  /** Test seam — clear the per-day dedup memory. */
  resetForTests(): void {
    this.lastFired.clear();
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
