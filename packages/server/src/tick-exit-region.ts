// TRA-3464 (impl child of TRA-2698) — bring `tickExitRegionMs` under the
// exit-cadence route's own discipline: an RTH predicate on BOTH endpoints, a
// cold-boot guard that PUBLISHES what it suppressed, and a partition that
// closes.
//
// WHAT WAS WRONG
//
// `releaseTickExitRegion()` booked every region it saw into one lifetime-since-
// boot accumulator with no market-hours predicate and no boot guard, and the
// route then published that accumulator TWICE: once fleet-summed at the top
// level, and once per book as a sibling of the RTH-only terms (`samples`,
// `atOrAbove30s`, `p99Under30s`, `intervalHistogram`). Measured on bqb1 build
// `10e68acf9c2e` on 2026-08-13:
//
//     books.demo.samples                  = 0      <- RTH intervals: NONE
//     books.demo.verdict                  = "armed_but_no_rth_interval"
//     books.demo.tickExitRegionMs.samples = 6810   <- at the RTH level, IS lifetime
//     $.window                            = "rth"
//
// A book that reports zero RTH intervals and refuses to grade published 6810
// region samples one key over, under a payload whose top level says
// `window: "rth"`. A PER-BOOK COPY OF A FLEET FIELD IS NOT A PARTITION: placing
// a lifetime accumulator among RTH-scoped siblings mislabels it BY POSITION,
// and position is the only label most readers ever read.
//
// WHY THIS IS A SEPARATE MODULE
//
// The route's own standing rule is that a grade must be controllable in BOTH
// directions. Driving a boundary region, a closed region and a cold-boot region
// out of a live `SignalEngine` means owning its clock, its market calendar and
// its whole tick — so the classifier would be exercised only through the one
// path that already exists, which is exactly the arrangement that let a
// lifetime accumulator sit unnoticed under an `rth` label for two weeks. Here
// the clock and the market predicate are constructor arguments, so
// `tick-exit-region.test.ts` can emit any of the four bins on demand. Same
// reason `TickExitWorkMeter` (TRA-3444) was extracted.
//
// THE ONE CLASSIFICATION, SHARED
//
// TRA-3444's `TickExitWorkMeter` measures the exit-critical half of the SAME
// region. TRA-2698 ordered that it inherit "the identical predicate", because
// two measurements of one region that disagree about which regions count
// surface downstream as a phase split whose parts do not reconcile with their
// own denominator (the failure TRA-3443 was opened for).
//
// "Identical predicate" is implemented here as ONE classification, computed
// once, RETURNED, and handed to both accumulators — not as two copies of the
// same test. Two copies can drift; a shared return value cannot. `release()`
// gives its caller the bin, and `signal-engine.ts` passes that exact value to
// `TickExitWorkMeter.commitRegion(bin)`.

/**
 * TRA-2269 — which population an exit-evaluation interval (TRA-3464: or an
 * interlock REGION) belongs to, from the market state at each of its two
 * endpoints.
 *
 * Only `rth` is graded. The asymmetry is deliberate and fail-CLOSED: a sample is
 * admitted only when BOTH endpoints were inside 09:30-16:00 ET, because the
 * decoupled timer refuses on `marketClosed` by design, so any sample with a
 * closed-market endpoint spent part of its length in a window the subject was
 * forbidden to run in — it grades doTick, not the hoist. `boundary` (exactly one
 * endpoint inside) is excluded but COUNTED, so the three bins partition the
 * lifetime population exactly and the route can publish a checkable invariant
 * instead of a silently lossy filter.
 *
 * `prevMarketOpen` is null only before the first exit pass, where there is no
 * interval to classify at all; treating it as non-RTH is unreachable in practice
 * and harmless if it were. A REGION always has a latched opening state, so it
 * never reaches this branch.
 *
 * TRA-3464 — this lives here, not in `signal-engine.ts`, only so
 * {@link TickExitRegionMeter} can call it without a module cycle.
 * `signal-engine.ts` re-exports it under its original name; that is the spelling
 * every existing caller imports and it is unchanged.
 */
export function classifyExitInterval(
  prevMarketOpen: boolean | null,
  marketOpen: boolean,
): 'rth' | 'boundary' | 'closed' {
  if (prevMarketOpen === null) return 'closed';
  if (prevMarketOpen && marketOpen) return 'rth';
  return prevMarketOpen === marketOpen ? 'closed' : 'boundary';
}

/**
 * Which bin one closed region lands in. Exactly one, always — that totality is
 * what makes `partitionHolds` checkable rather than merely plausible.
 *
 * `boot` is NOT an RTH judgement: it outranks the classification entirely, so a
 * cold-boot region that happens to sit inside RTH is still excluded. The point
 * of the guard is that the first region a process closes carries cold-start
 * work (universe loads, cold caches, first broker handshake) that no steady-
 * state region carries, and it is therefore a plausible candidate for the
 * published `maxMs` — which is the number TRA-2268's narrowing decision reads.
 */
export type TickExitRegionBin = 'rth' | 'boundary' | 'closed' | 'boot';

/** Lifetime-since-boot region terms. EVERY closed region, including the boot one. */
export interface TickExitRegionLifetimeTerms {
  samples: number;
  /** Total region time. Monotonic ⇒ differenceable across a same-process T0/T1 pair. */
  sumMs: number;
  /** Running MAXIMUM ⇒ NOT differenceable. Null until the first region closes. */
  maxMs: number | null;
  atOrAbove20s: number;
  atOrAbove30s: number;
}

/**
 * RTH-scoped region terms plus the counted exclusions that make the partition
 * checkable.
 *
 * Excluded regions are COUNTED, NOT DROPPED. A silently shrunken denominator is
 * the failure this whole route was rebuilt to prevent (TRA-2269/TRA-2645), and
 * the count is also how you find out you got the classifier wrong: a classifier
 * that mis-bins does not change `lifetime.samples`, so `partitionHolds` still
 * holds — but the bin totals move somewhere a reader can see them.
 */
export interface TickExitRegionRthTerms {
  /** Literal, so a reader cannot mistake the scope. This is the field TRA-2698 was filed over. */
  window: 'rth';
  samples: number;
  sumMs: number;
  maxMs: number | null;
  atOrAbove20s: number;
  atOrAbove30s: number;
  /** One endpoint each side of the open or the close. */
  boundaryRegions: number;
  /** Both endpoints outside RTH. */
  closedRegions: number;
  /** Did the cold-boot guard actually fire on this engine. */
  bootRegionExcluded: boolean;
  /**
   * WHAT the boot guard suppressed, in ms. Null when it has not fired.
   *
   * A guard whose effect is unobservable cannot be distinguished from a guard
   * that never fired, and this one is being added specifically because the
   * excluded sample is a plausible candidate for the published max. Publishing
   * the value is the difference between "excluded" and "vanished".
   */
  bootRegionMs: number | null;
  /**
   * `lifetime.samples === samples + boundaryRegions + closedRegions
   *  + (bootRegionExcluded ? 1 : 0)`.
   *
   * Published so a reader can CHECK the partition rather than trust it — the
   * same contract as `decoupledFireCount === sum(decoupledSkips) +
   * decoupledPassCount` and TRA-2269's interval partition.
   */
  partitionHolds: boolean;
}

export interface TickExitRegionSnapshot {
  /** Null until the first region closes — never 0 (TRA-1707 null discipline). */
  lastMs: number | null;
  lifetime: TickExitRegionLifetimeTerms;
  rth: TickExitRegionRthTerms;
}

/**
 * Accumulate `tickExitRegionActive` hold durations, partitioned by RTH and
 * guarded at boot.
 *
 * Ordering contract, mirroring `openTickExitRegion()` / `releaseTickExitRegion()`:
 *
 *   open() -> release()   (release outside an open region is a no-op)
 *
 * `release()` is IDEMPOTENT for the same reason `TickExitWorkMeter.commitRegion()`
 * is: doTick releases the interlock on the happy path right after the options
 * pass and `runTickGuarded` releases again in a `finally`. The second call must
 * book nothing — and, with a zeroed opener, would otherwise book an absurd
 * sample. It returns `null` on that second call so the caller can skip the work
 * meter too, keeping the two 1:1.
 */
export class TickExitRegionMeter {
  private readonly now: () => number;

  private readonly marketOpenAt: (ms: number) => boolean;

  private openedAt = 0;

  /**
   * The market state at the OPEN instant, latched. Read once and carried, not
   * re-derived at release: re-deriving would give a region that spans the close
   * two reads of "now" and no read of its own start, i.e. it would classify on
   * one endpoint while claiming two.
   */
  private openedMarketOpen = false;

  private lastMs: number | null = null;

  private samples = 0;

  private sumMs = 0;

  private maxMs = 0;

  private atOrAbove20s = 0;

  private atOrAbove30s = 0;

  private rthSamples = 0;

  private rthSumMs = 0;

  private rthMaxMs = 0;

  private rthAtOrAbove20s = 0;

  private rthAtOrAbove30s = 0;

  private boundaryRegions = 0;

  private closedRegions = 0;

  private bootRegionMs: number | null = null;

  /**
   * @param now clock, injectable so a test can drive a region of any duration.
   * @param marketOpenAt THE SAME predicate the producer gates on. `signal-engine.ts`
   *   passes `isStockMarketOpen`, which is what the decoupled exit gate itself
   *   refuses on (`refreshExitsOnly` -> `marketClosed`). TRA-2269's rule: if the
   *   population filter and the subject's own gate can disagree, a sample can be
   *   admitted to a window its producer was forbidden to run in. Do NOT write a
   *   second RTH test here.
   */
  constructor(now: () => number = Date.now, marketOpenAt: (ms: number) => boolean = () => false) {
    this.now = now;
    this.marketOpenAt = marketOpenAt;
  }

  /** Claim the region and latch both its start instant and its market state. */
  open(): void {
    this.openedAt = this.now();
    this.openedMarketOpen = this.marketOpenAt(this.openedAt);
  }

  /** True while a region is open. Mirrors `tickExitRegionActive` for assertions. */
  get regionOpen(): boolean {
    return this.openedAt > 0;
  }

  /**
   * Close the region, book it into lifetime, and bin it.
   *
   * Returns the bin so the caller can hand the SAME value to
   * `TickExitWorkMeter.commitRegion()` — see the header. Returns `null` when no
   * region was open (the idempotent second release), in which case the caller
   * must book nothing anywhere.
   */
  release(): TickExitRegionBin | null {
    if (this.openedAt <= 0) return null;
    const releasedAt = this.now();
    // A non-monotonic clock (NTP step, container migration) must not be able to
    // book a negative region and drag `sumMs` backwards — `sumMs` is
    // differenced across a T0/T1 pair and a backwards step there reads as
    // "negative region time during RTH", which is not a value the consumer has
    // a branch for. Same guard, same reason, as `TickExitWorkMeter.add()`.
    const heldMs = Math.max(0, releasedAt - this.openedAt);
    const openedMarketOpen = this.openedMarketOpen;
    this.openedAt = 0;

    // LIFETIME first, and unconditionally. This is the denominator the partition
    // is checked against, so it must count regions the bins deliberately drop —
    // otherwise the boot guard would shrink the very total that proves nothing
    // was shrunk.
    this.lastMs = heldMs;
    this.samples += 1;
    this.sumMs += heldMs;
    if (heldMs > this.maxMs) this.maxMs = heldMs;
    if (heldMs >= 20_000) this.atOrAbove20s += 1;
    if (heldMs >= 30_000) this.atOrAbove30s += 1;

    // BOOT GUARD outranks the RTH classification: the first region this process
    // closes is excluded whatever window it sat in.
    if (this.samples === 1) {
      this.bootRegionMs = heldMs;
      return 'boot';
    }

    // Both endpoints, one call, the producer's own predicate.
    const bin = classifyExitInterval(openedMarketOpen, this.marketOpenAt(releasedAt));
    switch (bin) {
      case 'rth':
        this.rthSamples += 1;
        this.rthSumMs += heldMs;
        if (heldMs > this.rthMaxMs) this.rthMaxMs = heldMs;
        if (heldMs >= 20_000) this.rthAtOrAbove20s += 1;
        if (heldMs >= 30_000) this.rthAtOrAbove30s += 1;
        break;
      case 'boundary':
        this.boundaryRegions += 1;
        break;
      default:
        this.closedRegions += 1;
        break;
    }
    return bin;
  }

  snapshot(): TickExitRegionSnapshot {
    const bootRegionExcluded = this.bootRegionMs != null;
    return {
      lastMs: this.lastMs,
      lifetime: {
        samples: this.samples,
        sumMs: this.sumMs,
        maxMs: this.samples > 0 ? this.maxMs : null,
        atOrAbove20s: this.atOrAbove20s,
        atOrAbove30s: this.atOrAbove30s,
      },
      rth: {
        window: 'rth',
        samples: this.rthSamples,
        sumMs: this.rthSumMs,
        maxMs: this.rthSamples > 0 ? this.rthMaxMs : null,
        atOrAbove20s: this.rthAtOrAbove20s,
        atOrAbove30s: this.rthAtOrAbove30s,
        boundaryRegions: this.boundaryRegions,
        closedRegions: this.closedRegions,
        bootRegionExcluded,
        bootRegionMs: this.bootRegionMs,
        partitionHolds:
          this.samples
          === this.rthSamples + this.boundaryRegions + this.closedRegions + (bootRegionExcluded ? 1 : 0),
      },
    };
  }
}
