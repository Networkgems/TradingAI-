// Cooperative event-loop yielding for the signal engines: the per-loop
// EvalYielder, the tick-wide TickPacer, and (TRA-4524) the PROCESS-WIDE gate
// both of them yield through. Moved out of signal-engine.ts (TRA-4524) so the
// real primitives can be driven by a harness at test-sized budgets; the
// TRA-1082 / TRA-1905 / TRA-1942 rationale below moved with them verbatim.

// The REAL timer, not the global: a test's fake timers replace
// `globalThis.setTimeout`, and must not be able to freeze the gate's sentinel.
import { setTimeout as realSetTimeout } from 'node:timers';
import { SyncSliceMeter } from './phase-timing.js';
import { logger } from './observability/index.js';

const gateLog = logger.child({ module: 'loop-yield-gate' });

// TRA-1082 — yield to the libuv event loop between batches of the full-universe
// equity sweeps. Each engine tick iterates the ENTIRE active/watchlist universe
// running synchronous indicator math (adx/orb/bbFade/ichimoku in the main pass,
// supertrend()/confluenceSide()/reversalChecklist() in the shadow passes) with
// no await inside the loop body when nothing fires — one uninterrupted
// synchronous burst. At full breadth on bqb1 that burst exceeded Render's 5s
// HTTP health-check budget (logs showed silent 5-8s gaps between `supertrend
// shadow signal` lines), so `http.accept` never got a turn and Render
// hard-restarted the instance (~90s flap loop, residual TRA-1082 root cause the
// crypto fix at 28af16b did NOT cover — that only chunked crypto-engine). This
// mirrors the crypto-engine treatment verbatim: awaiting a `setImmediate` every
// EQUITY_EVAL_YIELD_EVERY symbols hands control back so the HTTP listener answers
// the health probe between chunks, keeping any single synchronous span well
// under ~1s. `setImmediate` (vs `setTimeout(0)`/microtask) runs after pending
// I/O callbacks, so queued HTTP accepts are serviced before the next chunk.
export const EQUITY_EVAL_YIELD_EVERY = 25;
export const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

// TRA-1905 — the count-based yield above ("every 25 symbols") assumes a UNIFORM
// per-symbol cost. That assumption does not hold: under a wide/heavy universe or a
// slow indicator recompute, a single 25-symbol batch can still hold the loop past
// the 4s watchdog budget. The residual bqb1 block proves it — lagMax 9420ms in one
// window, attributed to the COARSE `signal.doTick` with NO wrapped sync sub-phase
// (autopilot-introspection, risk-autopilot, prune-signals, getstate-broadcast,
// equity-checkExits, scaleout-ladder, imported-marks, rv-exit-state-build, the
// per-symbol supertrend) ever crossing the 1s record threshold, and with the trip's
// `activePhase` reading `signal.doTick` (the main tick body) rather than a nested
// shadow-eval phase. That signature is the ACCUMULATED cost of a batch, not any one
// named op. Bound the CONTIGUOUS synchronous stretch by WALL TIME instead of by an
// item count: hand control back once more than EVAL_YIELD_BUDGET_MS have elapsed
// since the last yield, so the loop services the health probe well under the 4s/5s
// budget no matter how many symbols run or how heavy each one is. The legacy count
// gate is retained as a cheap secondary floor (yield at least every 25 symbols even
// when each is fast) so behaviour is a strict superset of the prior yielding.
export const EVAL_YIELD_BUDGET_MS = 750;

// TRA-1942 — the TICK-WIDE macrotask pacer budget (see {@link TickPacer}).
export const TICK_PACER_BUDGET_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4524 (TRA-3660 trip #14) — the budgets above are PER YIELDER, and a
// per-yielder budget does not bound the event loop once several engines share it.
//
// Trip #14 (2026-09-10T16:43:42Z, lagMax 6694ms): about 11 per-book engines were
// co-resumed when a shared await settled (the demo-directional per-symbol loop
// rides a shared chain cache, so every engine's remaining symbols resolve in
// microtasks). Each engine then ran ~550ms (its own budget plus overshoot) before
// it reached a boundary and queued a `setImmediate`, and Node runs every immediate
// queued before a check phase inside THAT ONE phase. So the loop saw N x ~550ms
// as one contiguous block. The Render tape shows it directly: 10
// `yield-preempt@signal.doTick.pacer` witnesses (6104..1123ms, FIFO), each queued
// at the exact ms another engine reached `pre-tick-complete`, ~550ms apart. A
// local harness on the same primitive measured N=1 1070 / N=4 2151 / N=8 4310 /
// N=12 6470ms: linear in N.
//
// The gate makes the budget PROCESS-WIDE:
//
// - It tracks the current CONTIGUOUS RUN: the time since the loop last provably
//   turned. The run starts at the first yielder observation after a turn. A
//   one-shot 0ms TIMER sentinel, armed at that start, ends it when it fires. A
//   timer can only fire in the timers phase, which is the phase the watchdog's
//   lag probe lives in, so a run ends exactly when the loop has really turned.
//   An immediate would NOT do: one queued from a timer callback or an I/O
//   completion fires in the SAME iteration's check phase, so a run begun in
//   timers/poll would chain straight into a fresh check-phase run. That is 2x
//   budget with no timers phase between (the N=1 row of the harness: 1070ms on
//   a 500ms budget). The sentinel uses the REAL `node:timers` timeout, so a
//   test's fake timers cannot freeze it; the slots stay on the global
//   `setImmediate` exactly as before.
// - `shouldYield` on both yielders answers true when EITHER the yielder's own
//   clock OR the process run has reached the yielder's budget. So an engine
//   co-resumed into a run that another engine already spent stops at its FIRST
//   boundary, instead of spending a full budget of its own on top.
// - A yield resumes through a gate SLOT. If the run has already reached the gate
//   budget, the slot re-queues itself (to the next loop iteration) instead of
//   resuming anyone, so the timers/poll phases run in between. Slots are
//   anonymous and resume the OLDEST waiter (FIFO by yield time). An engine that
//   ran and yields again queues BEHIND everyone already waiting, which makes the
//   schedule round-robin: no engine's exit pass can be starved by a sibling that
//   keeps re-yielding (AC3).
//
// Single-engine cost: one extra (sentinel) immediate per run. A lone engine's
// yield always resumes into a fresh run, because its own sentinel precedes its
// slot, so it resumes exactly as before. One deliberate difference: a yielder
// constructed mid-run now inherits the run it was born into instead of starting
// its clock at zero. It can yield EARLIER than before, never later and never
// less often.
//
// Kill switch: `LOOP_YIELD_GATE=0` restores the per-yielder behaviour exactly
// (a bare `setImmediate` per yield, no process clock). It is read on every call,
// so it takes effect on the next restart without a code change.
// ─────────────────────────────────────────────────────────────────────────────
export const LOOP_YIELD_GATE_BUDGET_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4920 — GATE HEADROOM.
//
// TRA-4524's mechanism is LINEAR IN N: N per-book engines co-resume on a shared
// settled await, each runs ~one budget to its boundary, and Node drains every
// queued immediate inside one check phase, so the loop sees N x per-book
// contiguous (harness: N=1 1070ms / N=4 2151 / N=8 4310 / N=12 6470). The gate
// is what breaks that chain. So the gate's own safety margin is a FUNCTION OF N,
// and N is not a constant: measured `maxQueueDepth` on bqb1 went 3 (10 min into
// an off-RTH boot, 2026-09-25T02:31Z) to 19 (RTH peak, 19:48Z) — 73% past the
// N~11 the remedy was modelled on.
//
// Everything that alarms today fires only AFTER a block ends: `lagMaxMs` is
// sampled by a timer that cannot run during the block, and a watchdog trip is by
// construction post-hoc. This publishes the margin BEFORE the block, from the
// two quantities that produce it.
//
// ⚠️ The per-book constant is MEASURED HERE, not inherited from TRA-4524's
// harness. Book count and per-book work have both moved. The measurement is
// taken at the run-end SENTINEL — a 0ms `node:timers` timeout can only fire in
// the timers phase, so its `now - runStartAt` is the full CONTIGUOUS run as the
// loop actually experienced it, and `resumesInRun` is how many waiters ran
// inside it. `runMs / resumesInRun` is therefore a direct in-band reading of
// "one book's cost per resume", from production traffic.
//
// This is strictly better instrumentation than `maxRunObservedMs`, which is
// stamped only inside `slot()` — i.e. only on turns where a waiter was ALREADY
// queued — so it measures observation range, not run length. Both are published;
// `maxRunCompletedMs` is the one that is a run length.
//
// ⚠️ `level` reads `unmeasured`, never `ok`, until a per-resume sample exists.
// "Not measured" and "measured and fine" must not share a reading.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render's HTTP health-check budget. A contiguous loop block past this is the
 * TRA-1082/TRA-2111 incident: `http.accept` never gets a turn, the probe times
 * out, and Render hard-restarts the instance.
 */
export const LOOP_BLOCK_BUDGET_MS = 5_000;
/** Fraction of {@link LOOP_BLOCK_BUDGET_MS} at which headroom reads `warn`. */
export const GATE_HEADROOM_WARN_AT = 0.5;
/** Fraction of {@link LOOP_BLOCK_BUDGET_MS} at which headroom reads `page`. */
export const GATE_HEADROOM_PAGE_AT = 0.75;

export type GateHeadroomLevel = 'unmeasured' | 'ok' | 'warn' | 'page';

export interface GateHeadroom {
  /** Denominator: Render's health-check budget (ms). */
  blockBudgetMs: number;
  warnAt: number;
  pageAt: number;
  /**
   * Measured per-resume cost (ms), mean over completed runs that resumed at
   * least one waiter. `null` until the gate has completed such a run — the box
   * has to be doing the work before the constant exists.
   */
  perResumeMs: number | null;
  /** Worst single completed run's per-resume cost (ms). */
  perResumeMaxMs: number | null;
  perResumeSamples: number;
  /** The N the projection uses: the deepest queue the gate has ever held. */
  queueDepth: number;
  /** `queueDepth x perResumeMs` — what one co-resume burst would cost unguarded. */
  projectedBlockMs: number | null;
  projectedUtilization: number | null;
  /** The longest contiguous run actually measured at the sentinel (ms). */
  observedMaxRunMs: number;
  observedUtilization: number;
  /** `max(projected, observed)` — an already-observed run cannot read `ok`. */
  utilization: number | null;
  level: GateHeadroomLevel;
  /** Why the level reads what it reads, in one line. Never omitted. */
  reason: string;
}

export interface LoopYieldGateSnapshot {
  enabled: boolean;
  budgetMs: number;
  /** Contiguous runs the gate has opened (one per observed loop turn). */
  runsStarted: number;
  /** Slot re-queues: a resume refused because the run had spent the budget. */
  deferrals: number;
  /** `shouldYield` answers that were true ONLY because of the process run. */
  forcedYields: number;
  /** Waiters currently queued on the gate. */
  queueDepth: number;
  maxQueueDepth: number;
  /** Most loop turns any single waiter was held before it resumed. */
  maxHeldTurns: number;
  /**
   * Longest run any gate slot OBSERVED when it decided (ms).
   *
   * ⚠️ Stamped only inside `slot()`, so a waiter must already have been queued.
   * It is an observation range, not a time-join to any specific block — do not
   * report it as "the gate saw that block". {@link maxRunCompletedMs} is the
   * field that is a run length.
   */
  maxRunObservedMs: number;
  lastDeferralAtMs: number | null;
  /** TRA-4920 — runs that reached their sentinel (i.e. the loop really turned). */
  runsCompleted: number;
  /** TRA-4920 — longest CONTIGUOUS run, measured at the sentinel (ms). */
  maxRunCompletedMs: number;
  /** TRA-4920 — most waiters resumed inside one contiguous run (the live N). */
  maxResumesInRun: number;
  /** TRA-4920 — total waiters resumed since boot. */
  resumesTotal: number;
  /** TRA-4920 — the pre-block margin tripwire. */
  headroom: GateHeadroom;
}

interface GateWaiter {
  epoch: number;
  resolve: (heldTurns: number) => void;
}

export interface LoopYieldGateOptions {
  budgetMs?: number;
  /** Read on every call. Default: on unless `LOOP_YIELD_GATE=0`. */
  enabled?: () => boolean;
  /**
   * TRA-4920 — the block budget the headroom tripwire measures against.
   * Defaults to {@link LOOP_BLOCK_BUDGET_MS}; tests inject a small one so a
   * headroom escalation can be driven without burning 5 real seconds.
   */
  blockBudgetMs?: number;
  /** TRA-4920 — called once per upward headroom transition (default: log). */
  onHeadroomEscalation?: (h: GateHeadroom) => void;
}

const HEADROOM_RANK: Record<GateHeadroomLevel, number> = { unmeasured: 0, ok: 1, warn: 2, page: 3 };

export class LoopYieldGate {
  private readonly budgetMs: number;
  private readonly isEnabled: () => boolean;
  private runStartAt: number | null = null;
  private runEpoch = 0;
  private readonly waiters: GateWaiter[] = [];
  private runsStarted = 0;
  private deferrals = 0;
  private forcedYields = 0;
  private maxQueueDepth = 0;
  private maxHeldTurns = 0;
  private maxRunObservedMs = 0;
  private lastDeferralAtMs: number | null = null;
  // TRA-4920 — run-end (sentinel) measurements. See the GATE HEADROOM block.
  private readonly blockBudgetMs: number;
  private readonly onHeadroomEscalation: (h: GateHeadroom) => void;
  private resumesInRun = 0;
  private runsCompleted = 0;
  private maxRunCompletedMs = 0;
  private maxResumesInRun = 0;
  private resumesTotal = 0;
  private perResumeSumMs = 0;
  private perResumeSamples = 0;
  private perResumeMaxMs = 0;
  private reportedHeadroom: GateHeadroomLevel = 'unmeasured';

  constructor(opts: LoopYieldGateOptions = {}) {
    this.budgetMs = opts.budgetMs ?? LOOP_YIELD_GATE_BUDGET_MS;
    this.isEnabled = opts.enabled ?? (() => process.env.LOOP_YIELD_GATE !== '0');
    this.blockBudgetMs = opts.blockBudgetMs ?? LOOP_BLOCK_BUDGET_MS;
    this.onHeadroomEscalation = opts.onHeadroomEscalation ?? defaultHeadroomEscalation;
  }

  enabled(): boolean {
    return this.isEnabled();
  }

  /**
   * Stamp the current contiguous run and return how long it has lasted. The
   * first observation after a loop turn opens a new run and returns 0. Always
   * 0 when the gate is disabled.
   */
  observe(nowMs: number): number {
    if (!this.isEnabled()) return 0;
    if (this.runStartAt === null) {
      this.startRun(nowMs);
      return 0;
    }
    return nowMs - this.runStartAt;
  }

  /** Book a `shouldYield` that was true only because of the process run. */
  noteForcedYield(): void {
    this.forcedYields++;
  }

  /**
   * Yield to the event loop through the gate. Resolves with the number of loop
   * turns the gate HELD this waiter beyond the first one. 0 means it resumed
   * as a bare `setImmediate` yield would have.
   */
  yieldTurn(): Promise<number> {
    if (!this.isEnabled()) {
      return new Promise<number>(resolve => setImmediate(() => resolve(0)));
    }
    return new Promise<number>(resolve => {
      this.waiters.push({ epoch: this.runEpoch, resolve });
      if (this.waiters.length > this.maxQueueDepth) this.maxQueueDepth = this.waiters.length;
      setImmediate(this.slot);
    });
  }

  snapshot(): LoopYieldGateSnapshot {
    return {
      enabled: this.isEnabled(),
      budgetMs: this.budgetMs,
      runsStarted: this.runsStarted,
      deferrals: this.deferrals,
      forcedYields: this.forcedYields,
      queueDepth: this.waiters.length,
      maxQueueDepth: this.maxQueueDepth,
      maxHeldTurns: this.maxHeldTurns,
      maxRunObservedMs: this.maxRunObservedMs,
      lastDeferralAtMs: this.lastDeferralAtMs,
      runsCompleted: this.runsCompleted,
      maxRunCompletedMs: this.maxRunCompletedMs,
      maxResumesInRun: this.maxResumesInRun,
      resumesTotal: this.resumesTotal,
      headroom: this.headroom(),
    };
  }

  /** TRA-4920 — the pre-block margin. See the GATE HEADROOM block above. */
  headroom(): GateHeadroom {
    const perResumeMs = this.perResumeSamples > 0 ? this.perResumeSumMs / this.perResumeSamples : null;
    const projectedBlockMs = perResumeMs !== null ? this.maxQueueDepth * perResumeMs : null;
    const projectedUtilization = projectedBlockMs !== null ? projectedBlockMs / this.blockBudgetMs : null;
    const observedUtilization = this.maxRunCompletedMs / this.blockBudgetMs;
    const utilization =
      projectedUtilization !== null ? Math.max(projectedUtilization, observedUtilization) : null;

    let level: GateHeadroomLevel;
    let reason: string;
    if (!this.isEnabled()) {
      // A disabled gate is the TRA-4524 pre-remedy world: N x per-book runs
      // contiguous with nothing bounding them. It is never `ok`, and it is not
      // `unmeasured` either — we know exactly why it cannot be graded.
      level = 'unmeasured';
      reason = 'gate disabled (LOOP_YIELD_GATE=0) — the process-wide bound is off, headroom is not defined';
    } else if (utilization === null) {
      level = 'unmeasured';
      reason =
        `no completed run has resumed a waiter yet (runsCompleted=${this.runsCompleted}, resumesTotal=${this.resumesTotal})` +
        ' — the per-resume cost is UNMEASURED, which is not the same as safe';
    } else {
      level = utilization >= GATE_HEADROOM_PAGE_AT ? 'page' : utilization >= GATE_HEADROOM_WARN_AT ? 'warn' : 'ok';
      reason =
        `${(utilization * 100).toFixed(1)}% of the ${this.blockBudgetMs}ms health-check budget` +
        ` (projected ${projectedBlockMs === null ? 'n/a' : Math.round(projectedBlockMs)}ms =` +
        ` maxQueueDepth ${this.maxQueueDepth} x ${perResumeMs === null ? 'n/a' : perResumeMs.toFixed(1)}ms/resume` +
        ` over ${this.perResumeSamples} runs; observed max run ${Math.round(this.maxRunCompletedMs)}ms)`;
    }

    return {
      blockBudgetMs: this.blockBudgetMs,
      warnAt: GATE_HEADROOM_WARN_AT,
      pageAt: GATE_HEADROOM_PAGE_AT,
      perResumeMs: perResumeMs === null ? null : Math.round(perResumeMs * 10) / 10,
      perResumeMaxMs: this.perResumeSamples > 0 ? Math.round(this.perResumeMaxMs * 10) / 10 : null,
      perResumeSamples: this.perResumeSamples,
      queueDepth: this.maxQueueDepth,
      projectedBlockMs: projectedBlockMs === null ? null : Math.round(projectedBlockMs),
      projectedUtilization: projectedUtilization === null ? null : Math.round(projectedUtilization * 1000) / 1000,
      observedMaxRunMs: Math.round(this.maxRunCompletedMs),
      observedUtilization: Math.round(observedUtilization * 1000) / 1000,
      utilization: utilization === null ? null : Math.round(utilization * 1000) / 1000,
      level,
      reason,
    };
  }

  private startRun(nowMs: number): void {
    this.runStartAt = nowMs;
    this.runEpoch++;
    this.runsStarted++;
    this.resumesInRun = 0;
    // The sentinel: a timer can only fire in the timers phase, so the run ends
    // exactly when the loop has really turned (see above). Unref'd: it must
    // never hold a process open.
    realSetTimeout(() => {
      // TRA-4920 — the run-end measurement. Taken HERE and nowhere else: this
      // callback runs in the timers phase, i.e. the first moment after the
      // contiguous run, so `endedAt - nowMs` is the run length the event loop
      // actually experienced. `resumesInRun` is the live N that length was
      // spread across.
      const endedAt = Date.now();
      const runMs = endedAt - nowMs;
      this.runsCompleted++;
      if (runMs > this.maxRunCompletedMs) this.maxRunCompletedMs = runMs;
      const resumes = this.resumesInRun;
      if (resumes > this.maxResumesInRun) this.maxResumesInRun = resumes;
      if (resumes > 0) {
        const perResume = runMs / resumes;
        this.perResumeSumMs += perResume;
        this.perResumeSamples++;
        if (perResume > this.perResumeMaxMs) this.perResumeMaxMs = perResume;
      }
      this.runStartAt = null;
      this.noteHeadroom();
    }, 0).unref();
  }

  /**
   * TRA-4920 — fire the escalation hook on an UPWARD transition only, so the
   * log carries one line per real degradation instead of one per run. The latch
   * never walks back down: a box that reached `page` once stays reported, and
   * the live level is always readable from {@link headroom} regardless.
   */
  private noteHeadroom(): void {
    const h = this.headroom();
    if (HEADROOM_RANK[h.level] <= HEADROOM_RANK[this.reportedHeadroom]) return;
    this.reportedHeadroom = h.level;
    if (h.level === 'warn' || h.level === 'page') this.onHeadroomEscalation(h);
  }

  // One slot is queued per waiter. A slot either resumes the OLDEST waiter or
  // re-queues itself, so there is never a waiter without a pending slot.
  private readonly slot = (): void => {
    if (this.waiters.length === 0) return;
    const nowMs = Date.now();
    if (this.runStartAt !== null) {
      const runMs = nowMs - this.runStartAt;
      if (runMs > this.maxRunObservedMs) this.maxRunObservedMs = runMs;
      if (runMs >= this.budgetMs && this.isEnabled()) {
        // Spent: do NOT start anyone's work in this run. An immediate queued
        // from inside a check phase runs in the next loop iteration.
        this.deferrals++;
        this.lastDeferralAtMs = nowMs;
        setImmediate(this.slot);
        return;
      }
    } else {
      this.startRun(nowMs);
    }
    const waiter = this.waiters.shift()!;
    const heldTurns = Math.max(0, this.runEpoch - waiter.epoch - 1);
    if (heldTurns > this.maxHeldTurns) this.maxHeldTurns = heldTurns;
    // TRA-4920 — count the resume BEFORE handing control over: the waiter's
    // work runs synchronously off `resolve()`'s microtask inside this same run,
    // so it is part of the run length the sentinel is about to measure.
    this.resumesInRun++;
    this.resumesTotal++;
    waiter.resolve(heldTurns);
  };
}

/**
 * TRA-4920 — default escalation sink: one structured log line per upward
 * transition. Deliberately NOT a throw or a restart — the whole point is to
 * surface the margin while it is still a margin.
 */
function defaultHeadroomEscalation(h: GateHeadroom): void {
  const line = h.level === 'page' ? gateLog.error : gateLog.warn;
  line.call(
    gateLog,
    h.level === 'page'
      ? 'loop-yield-gate headroom PAGE: a co-resume burst projects past 75% of the health-check budget'
      : 'loop-yield-gate headroom WARN: a co-resume burst projects past 50% of the health-check budget',
    {
      level: h.level,
      utilization: h.utilization,
      projectedBlockMs: h.projectedBlockMs,
      observedMaxRunMs: h.observedMaxRunMs,
      queueDepth: h.queueDepth,
      perResumeMs: h.perResumeMs,
      perResumeSamples: h.perResumeSamples,
      blockBudgetMs: h.blockBudgetMs,
      reason: h.reason,
    },
  );
}

/** The process-wide gate every signal-engine yielder shares. */
export const loopYieldGate = new LoopYieldGate();

export function getLoopYieldGateSnapshot(): LoopYieldGateSnapshot {
  return loopYieldGate.snapshot();
}

export interface YielderOptions {
  /** Own wall-time budget (ms). Defaults to the production constant. */
  budgetMs?: number;
  /** Gate to yield through. Defaults to the process-wide {@link loopYieldGate}. */
  gate?: LoopYieldGate;
  /** Env for the slice meter (tests inject a low slow-threshold). */
  env?: NodeJS.ProcessEnv;
  /**
   * EvalYielder only: keep the legacy every-EQUITY_EVAL_YIELD_EVERY count floor
   * (default true). A loop that never had a count floor passes false, so gaining
   * a yielder adds no extra hops when its symbols are fast.
   */
  countFloor?: boolean;
}

/**
 * Cooperative wall-time yielder for a hot synchronous per-symbol loop. Construct
 * one immediately before the loop, then use it as the loop's yield gate:
 *
 *     if (evalYielder.shouldYield(symIdx, sym)) await evalYielder.yieldNow(sym);
 *
 * `shouldYield` is SYNCHRONOUS and returns true (resetting its clock) when EITHER
 * more than EVAL_YIELD_BUDGET_MS have elapsed since the last yield (the real bound
 * on the contiguous block) OR the legacy every-EQUITY_EVAL_YIELD_EVERY count is hit
 * (the cheap floor) OR (TRA-4524) the process-wide contiguous run has reached the
 * same budget. It must NOT be an `async` method that the caller always awaits:
 * `await asyncFn()` defers the continuation to a microtask even when the method did
 * no internal awaiting, which would add a microtask hop to EVERY iteration and break
 * callers that rely on a single-symbol pass completing synchronously (TRA-936). By
 * keeping the decision sync and awaiting only when a yield is actually due, the
 * behaviour is a strict superset of the prior `symIdx % 25 === 0` gate: identical
 * (fully synchronous) when nothing is due, an extra macrotask yield when a batch
 * runs long. Cost is one `Date.now()` per symbol — negligible against the indicator
 * math it guards.
 */
export class EvalYielder {
  private lastYieldAt = Date.now();
  // TRA-3660 — sync-slice attribution. The yielder BOUNDS a contiguous stretch
  // but never MEASURES it, so a single un-preemptible 8s slice (trips #7-#11,
  // all `slowSyncPhase: null` under a 22s async envelope) had no instrument
  // that could name it. Constructed with a phase name, the yielder now records
  // (a) its own slow slices with the symbol range that blocked, and (b) slow
  // yield-resume delays as `yield-preempt@<phase>` — foreign uninstrumented
  // work starving the loop DURING the yield, the reading that stops a straddle
  // sample from convicting the innocent yielded envelope. Nameless construction
  // is byte-identical to the old behaviour.
  private readonly meter: SyncSliceMeter | null;
  private readonly budgetMs: number;
  private readonly gate: LoopYieldGate;
  private readonly countFloor: boolean;
  constructor(phase?: string, opts: YielderOptions = {}) {
    this.meter = phase != null ? new SyncSliceMeter(phase, opts.env) : null;
    this.budgetMs = opts.budgetMs ?? EVAL_YIELD_BUDGET_MS;
    this.gate = opts.gate ?? loopYieldGate;
    this.countFloor = opts.countFloor ?? true;
  }
  shouldYield(symIdx: number, label?: string): boolean {
    const nowMs = Date.now();
    const overCount = this.countFloor && symIdx > 0 && symIdx % EQUITY_EVAL_YIELD_EVERY === 0;
    const overTime = nowMs - this.lastYieldAt >= this.budgetMs;
    const overRun = this.gate.observe(nowMs) >= this.budgetMs;
    if (overCount || overTime || overRun) {
      if (overRun && !overCount && !overTime) this.gate.noteForcedYield();
      this.meter?.endSlice(label);
      this.lastYieldAt = Date.now();
      return true;
    }
    return false;
  }
  /**
   * TRA-3660 — yield via the yielder (instead of a bare `yieldToEventLoop()`)
   * so the scheduled→resumed delay is measured: a slow resume means the loop
   * ran someone ELSE's work for that long, and the meter records it as a
   * `yield-preempt@<phase>` observation. Also re-stamps the slice clock at the
   * RESUME, so queue time is never charged to the loop's own next slice.
   * TRA-4524 — the yield goes through the process-wide gate.
   */
  async yieldNow(label?: string): Promise<void> {
    const scheduledAtMs = Date.now();
    const heldTurns = await this.gate.yieldTurn();
    this.meter?.onYieldResumed(scheduledAtMs, label, heldTurns);
    this.lastYieldAt = Date.now();
  }
  /** Close out the final slice at loop end (no-op when constructed nameless). */
  finish(label?: string): void {
    this.meter?.endSlice(label);
  }
}

// TRA-1942 — the TICK-WIDE macrotask pacer (the root-cause fix for the residual
// bqb1 `signal.doTick` event-loop-block self-restart loop, parent TRA-1894).
//
// The watchdog's `block` trip named the COARSE `signal.doTick` with NO wrapped
// sub-phase ever crossing the 1s record threshold (every timeSyncPhase region —
// checkExits, getstate-broadcast, imported-marks, prune-signals, autopilot-
// introspection, risk-autopilot, scaleout-ladder, rv-exit-state-build — is
// individually FAST; the withPhase shadow evals name themselves). That signature
// is not one hot op — it is the SUM of the whole tick body running as ONE
// contiguous event-loop block.
//
// Why the whole body runs contiguously: on the cache-served path (the 2nd tick of
// each minute, a warm minute-bar cache, or an open feed breaker) EVERY `await`
// inside doTick — fetchQuotes, refreshCandles, the reconciles, refreshOptionMarks,
// the RV/OTM/technical scans — resolves from cache SYNCHRONOUSLY, i.e. in a
// MICROTASK (see fetchMinuteBarsWithSource's cache-hit early return). A chain of
// microtask-only awaits never lets libuv advance to the timer/check phase, so the
// watchdog's `setInterval` and the HTTP health listener cannot fire: the loop is
// starved for the full span of back-to-back synchronous sub-phases even though NO
// single phase blocks >1s. The cost grows with the session (more open positions /
// active-interest symbols / accrued state → heavier per-phase sync work), which is
// the observed grows-with-uptime trip cadence.
//
// EvalYielder already paces the two hot per-symbol LOOPS; this paces the tick as a
// WHOLE. A `setImmediate` (macrotask) yield is inserted between the major phases
// whenever the contiguous synchronous stretch since the last real yield crosses
// TICK_PACER_BUDGET_MS, so the event loop reaches its timer/check phase well under
// the 4s watchdog budget no matter how many sub-1s phases run back-to-back.
// Behaviour-preserving: it only interleaves a macrotask hop at a phase boundary,
// and doTick already awaits repeatedly mid-tick, so every boundary is already a
// legal suspension point. The gate is a single Date.now() read when not due.
//
// TRA-4524 — the rationale above composes for ONE engine. Across N co-resumed
// engines the per-engine budgets sum; the process-wide gate (top of file) is what
// bounds the loop.
export class TickPacer {
  private lastYieldAt = Date.now();
  // TRA-3660 — same sync-slice attribution as EvalYielder, at tick-body
  // granularity: a slow pacer slice names the doTick REGION (the label passed
  // at the boundary) rather than the coarse parent, and a slow yield-resume
  // records `yield-preempt@signal.doTick.pacer` (foreign work, not this tick).
  private readonly meter: SyncSliceMeter | null;
  private readonly budgetMs: number;
  private readonly gate: LoopYieldGate;
  constructor(phase?: string, opts: YielderOptions = {}) {
    this.meter = phase != null ? new SyncSliceMeter(phase, opts.env) : null;
    this.budgetMs = opts.budgetMs ?? TICK_PACER_BUDGET_MS;
    this.gate = opts.gate ?? loopYieldGate;
  }
  /**
   * SYNCHRONOUS decision: true (resetting the clock) once more than
   * TICK_PACER_BUDGET_MS have elapsed since the last macrotask yield, or
   * (TRA-4524) once the process-wide run has. Kept sync
   * for the same reason as {@link EvalYielder.shouldYield} — the caller awaits a
   * real yield ONLY when a yield is actually due, so a tick whose
   * awaits already hit real I/O (macrotask boundaries) adds zero extra hops.
   */
  shouldYield(label?: string): boolean {
    const nowMs = Date.now();
    const overTime = nowMs - this.lastYieldAt >= this.budgetMs;
    const overRun = this.gate.observe(nowMs) >= this.budgetMs;
    if (overTime || overRun) {
      if (overRun && !overTime) this.gate.noteForcedYield();
      this.meter?.endSlice(label);
      this.lastYieldAt = Date.now();
      return true;
    }
    return false;
  }
  /** TRA-3660 — see {@link EvalYielder.yieldNow}: measures the resume delay. */
  async yieldNow(label?: string): Promise<void> {
    const scheduledAtMs = Date.now();
    const heldTurns = await this.gate.yieldTurn();
    this.meter?.onYieldResumed(scheduledAtMs, label, heldTurns);
    this.lastYieldAt = Date.now();
  }
}
