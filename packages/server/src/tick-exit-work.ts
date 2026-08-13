// TRA-3444 — measure the EXIT-CRITICAL half of doTick's `tickExitRegionActive`
// interlock DIRECTLY, with no threshold.
//
// WHY THIS EXISTS AND WHY THE PHASE TAPE CANNOT REPLACE IT
//
// `recordPhaseDuration` (`phase-timing.ts`) is a NO-OP below
// PHASE_TIMING_SLOW_MS (1000ms by default). The doTick phase tape is therefore
// LEFT-CENSORED: a phase contributes nothing at all until one run of it crosses
// a full second, so a phase that is ABSENT from the tape and a phase that ran on
// every single tick at 999ms are BYTE-IDENTICAL in it.
//
// Measured on the 2026-08-12 RTH tape (25455 boot-excluded records, parent
// `signal.doTick` n=10946; census at `scripts/fixtures/tra3443-census-2026-08-12.json`):
//
//     sum(RESIDUAL) measured    =      392.2s    6 of 7 phases ABSENT
//     sum(RESIDUAL) upper bound =   76,852.2s    (each absent phase could carry nParent x 1000ms)
//     sum(PREFIX)   measured    =   15,869.9s   10 of 15 phases ABSENT
//     sum(PREFIX)   upper bound =  176,360.9s
//     measured region total     =   16,262.1s -> interval [16,262s, 253,213s] = 15.6x wide
//
// A factor of 15.6 is not a bound. TRA-2268 has to decide whether narrowing
// `tickExitRegionActive` is safe — narrowing loosens the ONLY thing serialising
// two concurrent callers of `submitStagedOptionExits` on a real broker — and the
// tape cannot tell it how much of the region is exit-critical work in EITHER
// direction.
//
// Lowering PHASE_TIMING_SLOW_MS on bqb1 is not the fix: it is an env write, and
// an env write redeploys bqb1 (`trigger: service_updated`) even under
// `autoDeploy=no` (TRA-2186), which resets the TRA-1648 go-live soak clock. It
// would also buy exactly one session and leave the instrument censored the next
// day.
//
// So measure the quantity directly, the same way `tickExitRegionMs` already
// measures the whole region: two `Date.now()` reads, one level in. PREFIX is
// then `tickExitRegionMs - exitWorkMs`, EXACTLY, per region, with no threshold
// and no absent-vs-zero ambiguity.
//
// THE ONE THING THIS MUST NOT DO is bracket more than the two containers the
// decoupled pass re-runs (`runEquityExitPass` + `runOptionsExitPass`, i.e.
// exactly what `refreshExitsOnly` calls). Bracketing more UNDERSTATES prefix,
// which makes narrowing look cheaper than it is — the expensive direction on a
// money-book interlock. `tick-exit-work.test.ts` asserts the bracket from the
// SOURCE for that reason.

// TRA-3464 — THE RTH PREDICATE IS INHERITED, NOT RE-DERIVED.
//
// TRA-2698 ordered that this accumulator carry the identical predicate as
// `tickExitRegionMs` itself, because two measurements of ONE region that
// disagree about which regions count surface downstream as a phase split whose
// parts do not reconcile with their own denominator — the exact failure TRA-3443
// was opened for.
//
// So this meter does not classify anything. `TickExitRegionMeter.release()`
// classifies ONCE and RETURNS the bin, and `commitRegion(bin)` takes that same
// value. There is one RTH test in the process and both accumulators are
// downstream of it; a shared return value cannot drift the way two copies of a
// predicate can.

import type { TickExitRegionBin } from './tick-exit-region.js';

/** What a meter publishes once it has taken at least one region. */
export interface TickExitWorkTerms {
  /** Regions COMMITTED — one per closed `tickExitRegionActive` region, so this is directly comparable with `tickExitRegionMs.samples`. */
  samples: number;
  /** Total exit-critical work across those regions. Monotonic, therefore differenceable between two reads. */
  sumMs: number;
  /** Worst single region's exit-critical work. A running MAXIMUM — NOT differenceable. */
  maxMs: number;
}

/**
 * Accumulate exit-critical work inside one interlock region, then fold it into
 * lifetime terms when the region closes.
 *
 * Ordering contract, mirroring `openTickExitRegion()` / `releaseTickExitRegion()`:
 *
 *   beginRegion() -> measure()/measureAsync() zero or more times -> commitRegion()
 *
 * `commitRegion()` is IDEMPOTENT because its caller is: doTick releases the
 * interlock on the happy path right after the options pass, and `runTickGuarded`
 * releases again in a `finally`. A second commit must not book a second sample.
 *
 * A `measure()` outside an open region is DROPPED rather than carried into the
 * next region. That can only happen if a future edit calls this from the
 * decoupled `refreshExitsOnly` path, whose work is by definition NOT inside the
 * interlock; carrying it forward would break the containment invariant
 * (`sumMs <= sum of region durations`) and quietly overstate exit-critical work,
 * which is the direction that makes narrowing look cheap.
 */
export class TickExitWorkMeter {
  private readonly now: () => number;

  private regionOpen = false;
  private pendingMs = 0;

  private samples = 0;
  private sumMs = 0;
  private maxMs = 0;

  // TRA-3464 — the same terms over the RTH-only population. Separate counters
  // rather than a filter applied at snapshot time, because the bin is only known
  // at commit and the pending accumulation is discarded immediately after.
  private rthSamples = 0;
  private rthSumMs = 0;
  private rthMaxMs = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Claim a fresh region. Any uncommitted accumulation is discarded, not carried. */
  beginRegion(): void {
    this.regionOpen = true;
    this.pendingMs = 0;
  }

  /**
   * Time a SYNCHRONOUS exit pass. Stamped in a `finally`, so a throw mid-pass
   * still attributes the work it did — an un-attributed throw would silently
   * move that time into PREFIX.
   *
   * Deliberately synchronous (no `async`): `runEquityExitPass` is sync, and
   * wrapping it in a promise would insert a microtask boundary into doTick that
   * the un-instrumented build does not have.
   */
  measure<T>(run: () => T): T {
    const startedAt = this.now();
    try {
      return run();
    } finally {
      this.add(this.now() - startedAt);
    }
  }

  /** Time an ASYNCHRONOUS exit pass. Same `finally` discipline. */
  async measureAsync<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await run();
    } finally {
      this.add(this.now() - startedAt);
    }
  }

  /**
   * Close the region and book ONE sample.
   *
   * A region that closed having done NO exit work books a 0ms sample rather
   * than no sample at all: `samples` then stays 1:1 with
   * `tickExitRegionMs.samples`, so PREFIX = regionSum - workSum is computed over
   * the same population. A tick that threw before reaching the passes really did
   * spend its whole region on prefix, and that is what it should read as.
   *
   * TRA-3464 — `bin` is the classification `TickExitRegionMeter.release()`
   * already computed for THIS region. Passing it (rather than re-deriving it)
   * is what keeps the two accumulators 1:1 in BOTH populations: `samples` stays
   * 1:1 with `tickExitRegionMs.lifetime.samples` and `rthSamples` stays 1:1 with
   * `tickExitRegionMs.samples`, so PREFIX differences over one population in
   * either scope. A `'boot'` bin is booked into lifetime and excluded from RTH,
   * exactly as the region meter does it.
   */
  commitRegion(bin: TickExitRegionBin): void {
    if (!this.regionOpen) return;
    this.regionOpen = false;
    const heldMs = this.pendingMs;
    this.pendingMs = 0;
    this.samples += 1;
    this.sumMs += heldMs;
    if (heldMs > this.maxMs) this.maxMs = heldMs;
    if (bin !== 'rth') return;
    this.rthSamples += 1;
    this.rthSumMs += heldMs;
    if (heldMs > this.rthMaxMs) this.rthMaxMs = heldMs;
  }

  /**
   * NULL until the first region commits — never a zero-filled object. A zero
   * here would be a claim about a measurement not taken, and this counter's
   * whole purpose is to distinguish "absent" from "zero" (TRA-1707 null
   * discipline, the same contract `/api/health/rv-scan` is built on).
   */
  snapshot(): TickExitWorkTerms | null {
    if (this.samples === 0) return null;
    return { samples: this.samples, sumMs: this.sumMs, maxMs: this.maxMs };
  }

  /**
   * TRA-3464 — the same terms over regions with BOTH endpoints inside RTH.
   *
   * NULL until an RTH region commits, and null INDEPENDENTLY of
   * {@link snapshot}: a process that booted post-close has a non-null lifetime
   * snapshot and a null RTH one, and that pair is the honest reading. Publishing
   * a zero-filled object here is the specific defect TRA-2698 was filed over —
   * a book that measured nothing in the window still published numbers that
   * read like a measurement.
   */
  rthSnapshot(): TickExitWorkTerms | null {
    if (this.rthSamples === 0) return null;
    return { samples: this.rthSamples, sumMs: this.rthSumMs, maxMs: this.rthMaxMs };
  }

  private add(elapsedMs: number): void {
    if (!this.regionOpen) return;
    // A non-monotonic clock (NTP step, container migration) must not be able to
    // subtract exit-critical work and manufacture a bigger PREFIX.
    this.pendingMs += elapsedMs > 0 ? elapsedMs : 0;
  }
}
