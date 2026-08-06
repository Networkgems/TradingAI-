/**
 * TRA-2689 (leg 2 of TRA-2654) — intra-session denominator-flip candidate
 * recorder.
 *
 * ## THIS IS A WRITE-ONLY TAPE. IT IS NOT A DETECTOR.
 *
 * It emits **no verdict**. Nothing here excludes a row, changes a ranking,
 * writes `moveSuspect`, writes `quoteStatus`, or warns. If a consumer's
 * behaviour changes because of this module, that change is out of boundary and
 * is a defect — say so on TRA-2689 rather than widening it. The whole point of
 * the CTO's ruling on TRA-2654 is that an *unmeasured* detector shipped beside a
 * measured one is a fail-open, so the tape is the deliverable and the rule is a
 * later ticket (a new child of TRA-2380) that must carry the numbers listed in
 * the pre-registered promotion bar on TRA-2689.
 *
 * ## What a "denominator flip" is
 *
 * `changePct = (price - prevClose) / prevClose * 100`. The numerator is
 * observable; `prevClose` — the denominator — is not, it is only ever *implied*.
 * When a provider silently swaps the denominator underneath us (an unadjusted
 * prev close across a corporate action, a session rollover, a bad tape), the
 * published percentage moves **while the price does not**. That is the day-1
 * signature of the FGMC 07-28 fabrication: frozen price, moving denominator, a
 * 104-minute-stale quote. TRA-2634's residual is that we deliberately never
 * created the prior-session state needed to see it after the fact; the feed
 * boundary is the one place it is visible live.
 *
 * ## THE ADMISSION RULE, written down (see {@link isDenominatorFlipCandidate})
 *
 * A tape is only reinterpretable later if its own admission rule is on the
 * record, so both halves are named constants with their reasoning attached:
 *
 * 1. **"Price unchanged" is EXACT IEEE-754 equality (`===`). There is no eps.**
 *    The shape being hunted is a *republished* datum — the identical double
 *    coming back from the provider or being carried forward by us — not a small
 *    genuine tick. An eps window would admit real 1-cent moves on a $2 microcap
 *    (0.5%) as "unchanged" and drown the tape in ordinary trading. Exact
 *    equality is also the only rule whose false-positive population is
 *    describable without picking a second threshold. Its cost is stated
 *    honestly: a denominator flip that lands on a tick where the price ALSO
 *    moved is invisible to this recorder. Day 1 of the fabrication is the
 *    frozen-price case, and that is what was authorized.
 * 2. **The `changePct` delta is `|changePct - prevChangePct| > 0.01` percentage
 *    points, strict.** With the price exactly equal and the denominator
 *    unchanged, `changePct` is *arithmetically forced* to be equal too — so any
 *    non-zero delta already implies the denominator moved. The threshold exists
 *    solely to reject provider rounding: the feeds publish the percentage to
 *    2 dp, so 0.01 pp is one unit in the last published place and `> 0.01`
 *    means at least two. The comparison is made AT that precision — the delta is
 *    rounded to 2 dp first, because `110.67 - 110.66` is `0.010000000000019327`
 *    in IEEE-754 and a bare strict `>` would therefore admit a one-unit move and
 *    quietly degrade the threshold to "any change at all". It is NOT a magnitude
 *    filter and must not be retuned into one — magnitude is recorded per row and
 *    belongs in the later rule.
 *
 * ## Staleness is RECORDED, never FILTERED
 *
 * Explicitly rejected on TRA-2689: "exclude everything stale." TRA-2610's
 * known-good controls exist to reject precisely that over-broad fix, and FGMC's
 * 104-minute staleness is the *signal* here, not the noise. Every row carries
 * the staleness of both sides in ms and nothing anywhere filters on it.
 *
 * ## Benign causes are DISCRIMINATED, not guessed at
 *
 * Session rollover is the benign cause that cannot be separated a priori, so
 * every row carries {@link DenominatorFlipCandidate.straddlesSessionRollover}
 * plus the two ET session dates it was derived from — a later reader who
 * disagrees with this boundary definition can re-derive their own from the
 * recorded dates rather than being stuck with ours. Per the promotion bar, a
 * false-positive count must be reported on **non-rollover rows specifically,
 * never pooled**: pooling is exactly what makes rollover look like a detection.
 */

import { etDateKey } from './et-clock.js';

/**
 * Hard state budget from the CTO ruling: <=2,000 rows in process (~600 KB RSS).
 * `applyQuotes` is on the hot path for the watchlist and the signal engine.
 */
export const DENOM_FLIP_TAPE_CAPACITY = 2000;

/**
 * Minimum `|changePct - prevChangePct|`, in percentage points, for a row to be
 * admitted. See rule 2 in the module header: one unit in the last published
 * place is 0.01 pp, and the comparison is strict, so an admitted row moved by at
 * least two. This is a ROUNDING floor, not a magnitude filter.
 */
export const DENOM_FLIP_CHANGEPCT_DELTA_PP = 0.01;

/** The previous-tick side of a candidate, as read off `symbolState`. */
export interface DenominatorFlipPrevRow {
  price: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
  moveSuspect?: boolean;
}

/** The incoming-quote side of a candidate, as delivered by `fetchQuotes`. */
export interface DenominatorFlipNextRow {
  price: number;
  change: number;
  changePct: number;
  /**
   * TRA-1980 — L1 book presence. `fetchQuotes` does NOT expose a provider
   * name (see {@link DenominatorFlipCandidate.quoteSource}); a book is present
   * only on the Tradier path, so this is the honest proxy we have.
   */
  bid?: number;
  ask?: number;
}

/** One recorded candidate. Every field here is a benign-cause discriminator. */
export interface DenominatorFlipCandidate {
  symbol: string;
  /** Wall-clock of the tick that admitted the row. */
  ts: number;

  prevPrice: number;
  price: number;
  prevChange: number;
  change: number;
  prevChangePct: number;
  changePct: number;
  /** `changePct - prevChangePct`, signed. The magnitude the later rule ranks on. */
  changePctDelta: number;

  prevLastUpdated: number;
  lastUpdated: number;
  /** `ts - prevLastUpdated`. FGMC 07-28 was ~6.2e6 (104 min). */
  prevStalenessMs: number;
  /** `ts - lastUpdated`. Zero on the quoted branch by construction; recorded anyway. */
  stalenessMs: number;

  /**
   * THE FIELD THAT DECIDES THE FOLLOW-UP TICKET (CTO, TRA-2689).
   *
   * True when the previous tick and this tick fall on different ET session
   * dates, i.e. the pair straddles the boundary at which a provider rolls its
   * prev close — the benign cause of a moving denominator over a frozen price.
   * The two dates it was derived from ride alongside so a later reader can
   * substitute their own boundary definition.
   */
  straddlesSessionRollover: boolean;
  prevSessionEtDate: string;
  sessionEtDate: string;

  prevQuoteStatus: 'ok' | 'rate_limited' | 'unavailable' | null;
  /** The status about to be stamped. Always `'ok'`: this is the quoted branch. */
  quoteStatus: 'ok';
  prevMoveSuspect: boolean | null;

  /**
   * `null`, always, and deliberately.
   *
   * The CTO asked for the quote source/provider "**if `fetchQuotes` exposes
   * it**". It does not: `QuoteResult` (yahoo-feed.ts) carries only
   * price/volume/change/changePct plus an optional L1 book, and the merged map
   * handed to `applyQuotes` has already lost which of Tradier / Yahoo quote /
   * Yahoo chart / Stooq / the quote cache served each symbol. Threading a
   * provenance field down from the feed is a change to the feed's own contract
   * and is outside this ticket's boundary, so the field is present and honestly
   * empty rather than absent — a later reader must not mistake "we never
   * recorded it" for "the provider was unknown".
   *
   * {@link hasL1Book} is the available proxy: a book is present only on the
   * Tradier path. It is a proxy, not the provider.
   */
  quoteSource: null;
  hasL1Book: boolean;
}

/** What one session's flush contains. */
export interface DenominatorFlipTapeDump {
  /** Rows in admission order, oldest first. */
  rows: DenominatorFlipCandidate[];
  /**
   * Candidates admitted but NOT present in `rows` because the ring wrapped.
   * Nobody may compute a false-positive rate over a silently truncated tape and
   * report it as complete coverage — this number is what makes that visible.
   */
  droppedCandidates: number;
  /** `droppedCandidates > 0`. Stamped on the flushed tape. */
  saturated: boolean;
  capacity: number;
  /** Total admitted this session, `rows.length + droppedCandidates`. */
  admitted: number;
}

/**
 * Pure admission predicate. Both halves of the rule live here so a test can pin
 * them without an engine.
 *
 * Returns false — deliberately — when the previous row has never been quoted
 * (`lastUpdated <= 0`). A carried-forward zero stamp is not a prior
 * observation, and admitting it would manufacture a candidate out of boot state.
 */
export function isDenominatorFlipCandidate(
  prev: DenominatorFlipPrevRow | undefined,
  next: DenominatorFlipNextRow,
): boolean {
  if (!prev) return false;
  if (!(prev.lastUpdated > 0)) return false;
  // Rule 1 — EXACT equality. No eps. See the module header.
  if (prev.price !== next.price) return false;
  if (!Number.isFinite(prev.changePct) || !Number.isFinite(next.changePct)) return false;
  // Rule 2 — strictly more than one unit in the last published place, compared AT
  // that precision.
  //
  // The rounding is not decoration. `110.66 + 0.01` is `110.67000000000002` in
  // IEEE-754, so the difference of two legitimately-published 2 dp percentages
  // evaluates to `0.010000000000019327` and a bare `> 0.01` ADMITS a row that
  // moved by exactly one unit — i.e. the threshold silently becomes "any change
  // at all", which is the one thing it exists to prevent. Rounding to the
  // published precision first removes the representation error before the
  // comparison, so the rule the tape's `admissionRule` block advertises is the
  // rule that actually ran.
  const deltaPp = Math.round(Math.abs(next.changePct - prev.changePct) * 100) / 100;
  return deltaPp > DENOM_FLIP_CHANGEPCT_DELTA_PP;
}

/**
 * Build the row. Only ever called once the predicate has already fired, so the
 * `Intl` work behind {@link etDateKey} stays off the common path.
 */
export function buildDenominatorFlipCandidate(args: {
  symbol: string;
  prev: DenominatorFlipPrevRow;
  next: DenominatorFlipNextRow;
  now: number;
}): DenominatorFlipCandidate {
  const { symbol, prev, next, now } = args;
  const prevSessionEtDate = etDateKey(prev.lastUpdated);
  const sessionEtDate = etDateKey(now);
  return {
    symbol,
    ts: now,
    prevPrice: prev.price,
    price: next.price,
    prevChange: prev.change,
    change: next.change,
    prevChangePct: prev.changePct,
    changePct: next.changePct,
    changePctDelta: next.changePct - prev.changePct,
    prevLastUpdated: prev.lastUpdated,
    lastUpdated: now,
    prevStalenessMs: now - prev.lastUpdated,
    stalenessMs: 0,
    straddlesSessionRollover: prevSessionEtDate !== sessionEtDate,
    prevSessionEtDate,
    sessionEtDate,
    prevQuoteStatus: prev.quoteStatus ?? null,
    quoteStatus: 'ok',
    prevMoveSuspect: typeof prev.moveSuspect === 'boolean' ? prev.moveSuspect : null,
    quoteSource: null,
    hasL1Book: typeof next.bid === 'number' && typeof next.ask === 'number',
  };
}

/**
 * Bounded in-process ring. **No durable state on the feed path** — the feed
 * never writes to disk; the EOD archive drains this once per session.
 *
 * ## Saturation semantics, stated because they are load-bearing
 *
 * This is a true ring: on overflow the **OLDEST** row is overwritten, so a
 * saturated tape holds the LAST <=2,000 candidates of the session, not the
 * first. Every overwrite increments `droppedCandidates`, and the dump stamps
 * `saturated: true`. A later reader computing any rate over a saturated tape is
 * computing it over a *suffix* of the session and must say so.
 *
 * The backing array is allocated lazily, on the first candidate, so a session
 * that produces none allocates nothing at all.
 */
export class DenominatorFlipTape {
  private buf: (DenominatorFlipCandidate | undefined)[] | null = null;
  private head = 0;
  private size = 0;
  private dropped = 0;

  constructor(private readonly capacity: number = DENOM_FLIP_TAPE_CAPACITY) {}

  record(row: DenominatorFlipCandidate): void {
    if (this.capacity <= 0) {
      this.dropped += 1;
      return;
    }
    if (!this.buf) this.buf = new Array<DenominatorFlipCandidate | undefined>(this.capacity);
    if (this.size === this.capacity) this.dropped += 1;
    else this.size += 1;
    this.buf[this.head] = row;
    this.head = (this.head + 1) % this.capacity;
  }

  /**
   * TRA-3116 (2d) — put a drained batch back after a FAILED write.
   *
   * {@link drain} resets the ring before the writer is even called, so until
   * now a write failure destroyed the session's rows even though the process
   * lived on. With a shutdown drain in place there is a second chance worth
   * taking, so the flush paths re-admit on `written: false`.
   *
   * Deliberately plain {@link record} calls: if the ring has already refilled
   * past capacity while the write was in flight, re-admission overflows and
   * increments `droppedCandidates`, which is the correctly-named counter for
   * "admitted but not in `rows`". Silently discarding the overflow instead
   * would be the same unnamed loss this ticket exists to close.
   *
   * Rows must be handed back oldest-first (i.e. as `drain` returned them) for
   * the ring's suffix semantics to survive the round trip.
   */
  readmit(rows: readonly DenominatorFlipCandidate[]): void {
    for (const row of rows) this.record(row);
  }

  /** Rows currently held, oldest first. Does not clear. */
  peek(): DenominatorFlipCandidate[] {
    if (!this.buf || this.size === 0) return [];
    const out: DenominatorFlipCandidate[] = [];
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      const row = this.buf[(start + i) % this.capacity];
      if (row) out.push(row);
    }
    return out;
  }

  get droppedCandidates(): number {
    return this.dropped;
  }

  get saturated(): boolean {
    return this.dropped > 0;
  }

  get length(): number {
    return this.size;
  }

  /** Drain for the EOD flush: returns the dump and resets the ring. */
  drain(): DenominatorFlipTapeDump {
    const rows = this.peek();
    const dump: DenominatorFlipTapeDump = {
      rows,
      droppedCandidates: this.dropped,
      saturated: this.dropped > 0,
      capacity: this.capacity,
      admitted: rows.length + this.dropped,
    };
    this.buf = null;
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
    return dump;
  }
}
