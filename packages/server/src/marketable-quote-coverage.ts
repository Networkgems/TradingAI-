// TRA-3502 (carrier from TRA-3499; parent TRA-2242 → TRA-2233 → TRA-2174) — the
// QUOTE-COVERAGE ledger for the marketable(bid) mark.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `marketable-open-mtm.ts` haircuts the mid by a MODELED scalar `h` (0.134) because
// "the engine's `optionMarks` feed is `Map<string, number>` — a mid, with no two-sided
// quote threaded into the per-tick exit path" (that module's own header). TRA-3502
// threads the quote in. Once it is threaded, the question that decides whether `h`
// still matters at all is:
//
//     of the marks the demo book actually values/exits at, what fraction were served
//     by a real two-sided book, and for the rest — WHY not?
//
// That number was UNKNOWN. 529/529 demo rows carry a two-sided quote at ENTRY, but
// entries are quote-GATED, so 100% there is partly selection and says nothing about
// the EXIT/MTM seam. This ledger measures the exit/MTM seam directly.
//
// ── THE FAILURE MODE THIS MODULE IS BUILT AGAINST ────────────────────────────
// "A fallback counter that cannot distinguish 'never fired' from 'never wired' is the
// defect this ticket family is about." A ledger that starts at all-zero and is never
// written reads EXACTLY like a ledger that is written every tick and always finds a
// quote. Both render `fallbacks: 0`. So:
//
//   • {@link MarketableQuoteCoverageSnapshot.instrumentState} is a FIRST-CLASS field
//     with three values, and `UNWIRED` ≠ `NO_OBSERVATIONS` ≠ `LIVE`. A reader never
//     has to infer liveness from a zero.
//   • {@link MarketableQuoteCoverageSnapshot.fallbackRate} is `null` — never `0` —
//     until at least one resolution has been observed. An absent rate must not read
//     as a perfect one.
//   • The fallback reasons are SPLIT, and a one-sided book renders differently from
//     an absent row and from a breaker-open scanner. Collapsing them to a single
//     `null` is exactly what {@link RelativeValueScanner.getOptionQuote} does, which
//     is why TRA-3502 added `getOptionQuoteDetail` beside it.
//
// ── TWO SEAMS, DELIBERATELY SEPARATE ─────────────────────────────────────────
// `resolution` — what the SCANNER returned, recorded in `refreshOptionMarks`. Runs on
//    every tick REGARDLESS of `ENABLE_MARKETABLE_OPEN_MTM`, so it has a live failing
//    state today, while the flag is DARK. This is the number that says how much `h`
//    still matters.
// `application` — what the MARK PATH did with it (`demoExitFillPrice`,
//    `marketableUnrealizedUsd`). Under the DARK flag the exit arm is not reached, so
//    this seam legitimately reads zero — and `instrumentState` says WHY rather than
//    letting a structural zero pass for a measured one. Reading the application seam
//    as "no fallbacks ever happen" would be the dead-instrument bug one level down.
//
// Pure state + pure folds; no IO, no clock of its own (callers pass `now`).

/** Why one mark-resolution attempt did or did not yield a usable two-sided book. */
export type MarketableQuoteOutcome =
  /** A two-sided, uncrossed book came back and IS the mark. */
  | 'served'
  /** The chain row exists but the book is one-sided / crossed / non-positive. `h` is correct here. */
  | 'one_sided'
  /** No row for that contract in the snapshot — delisted, wrong expiration, or an empty chain. */
  | 'absent'
  /** The scanner's Tradier breaker was OPEN, so no question was asked of the venue at all. */
  | 'breaker_open'
  /** The call threw. Distinct from `absent`: an exception is an outage, not an empty book. */
  | 'error'
  /** The scanner holds no Tradier client — venue unconfigured. Distinct from a tripped breaker. */
  | 'no_client'
  /** The wired scanner does not implement `getOptionQuoteDetail`. Structural, not market. */
  | 'no_capability'
  /**
   * APPLICATION SEAM ONLY — no usable quote was on hand when the mark was computed, so
   * the mark took the modeled `h`. Deliberately NOT reported as `absent`: this seam
   * cannot see whether the book was one-sided, the row missing, or the breaker open —
   * it only sees that nothing arrived. Claiming `absent` here would fabricate a
   * diagnosis. The WHY lives on the `resolution` seam; join the two.
   */
  | 'unquoted_at_mark';

export const MARKETABLE_QUOTE_OUTCOMES: readonly MarketableQuoteOutcome[] = [
  'served',
  'one_sided',
  'absent',
  'breaker_open',
  'error',
  'no_client',
  'no_capability',
  'unquoted_at_mark',
] as const;

/** Which seam an observation came from. See the module header. */
export type MarketableQuoteSeam = 'resolution' | 'application';

/** Book the observation belongs to. The marketable path is demo-only by construction. */
export type MarketableQuoteMode = 'demo' | 'live';

type OutcomeCounts = Record<MarketableQuoteOutcome, number>;

function emptyCounts(): OutcomeCounts {
  return {
    served: 0,
    one_sided: 0,
    absent: 0,
    breaker_open: 0,
    error: 0,
    no_client: 0,
    no_capability: 0,
    unquoted_at_mark: 0,
  };
}

/**
 * Liveness of one seam, as DATA rather than as an inference off a zero.
 *
 * - `UNWIRED`          — nothing has ever called `markSeamWired` for this seam. The
 *                        code path that should be recording is not running at all.
 * - `WIRED_NO_OBSERVATIONS` — the seam is wired and ran, but had nothing to resolve
 *                        (no open positions this tick / flag DARK so the exit arm was
 *                        never reached). Zero counts here are HONEST zeros.
 * - `LIVE`             — at least one resolution has been observed. The counts mean
 *                        what they say.
 */
export type MarketableQuoteInstrumentState = 'UNWIRED' | 'WIRED_NO_OBSERVATIONS' | 'LIVE';

export interface MarketableQuoteSeamSnapshot {
  seam: MarketableQuoteSeam;
  instrumentState: MarketableQuoteInstrumentState;
  /** Total resolutions observed on this seam (`served` + every fallback). */
  observations: number;
  /** Resolutions that used a real two-sided book. */
  served: number;
  /** Resolutions that fell back to the modeled `h`, split by reason. Sums to `fallbackTotal`. */
  fallback: Omit<OutcomeCounts, 'served'> & { total: number };
  /**
   * `fallbackTotal / observations`. **`null`, never `0`, at `observations === 0`** — an
   * unmeasured rate must not render as a perfect one. This is THE number TRA-3502 asks
   * for on the `resolution` seam: near 0 ⇒ `h`'s accuracy has stopped being load-bearing.
   */
  fallbackRate: number | null;
  /** Same split by book. `live` is expected to stay 0 on the application seam (demo-only path). */
  byMode: Record<MarketableQuoteMode, OutcomeCounts>;
  /** Epoch ms of the first/last observation; `null` until one lands. */
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

export interface MarketableQuoteCoverageSnapshot {
  resolution: MarketableQuoteSeamSnapshot;
  application: MarketableQuoteSeamSnapshot;
  /** Rides the payload so the two seams are never read as one number. */
  note: string;
}

export const MARKETABLE_QUOTE_COVERAGE_NOTE =
  'TWO SEAMS, READ THEM SEPARATELY. `resolution` = what the scanner returned on the '
  + 'per-tick mark pass; it runs whether or not ENABLE_MARKETABLE_OPEN_MTM is armed, so '
  + 'it has a live failing state TODAY and is the number that says how much the modeled '
  + 'h=0.134 still matters. `application` = what the marketable mark path did with the '
  + 'quote; the exit arm is only reached when the flag is ARMED, so a zero there is '
  + 'structural, not measured — read `instrumentState` before reading any count. '
  + 'UNWIRED (never recorded) is NOT the same as WIRED_NO_OBSERVATIONS (recorded, nothing '
  + 'to resolve) is NOT the same as LIVE with zero fallbacks. `fallbackRate` is null, '
  + 'never 0, when nothing has been observed.';

interface SeamState {
  wired: boolean;
  byMode: Record<MarketableQuoteMode, OutcomeCounts>;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

function emptySeam(): SeamState {
  return {
    wired: false,
    byMode: { demo: emptyCounts(), live: emptyCounts() },
    firstObservedAt: null,
    lastObservedAt: null,
  };
}

const seams: Record<MarketableQuoteSeam, SeamState> = {
  resolution: emptySeam(),
  application: emptySeam(),
};

/**
 * Declare that a seam's recording code path RAN this pass, independently of whether it
 * had anything to resolve. This is the positive control: without it, "the engine never
 * called us" and "the engine called us and every mark was quote-served" are the same
 * all-zero render. Idempotent; call it unconditionally at the top of the seam.
 */
export function markMarketableQuoteSeamWired(seam: MarketableQuoteSeam): void {
  seams[seam].wired = true;
}

/** Record one mark-resolution outcome. Cheap, total, never throws. */
export function recordMarketableQuoteResolution(input: {
  seam: MarketableQuoteSeam;
  outcome: MarketableQuoteOutcome;
  mode: MarketableQuoteMode;
  now: number;
}): void {
  const state = seams[input.seam];
  if (state == null) return;
  const counts = state.byMode[input.mode];
  if (counts == null) return;
  if (!(input.outcome in counts)) return;
  state.wired = true;
  counts[input.outcome] += 1;
  const ts = Number.isFinite(input.now) ? input.now : null;
  if (ts != null) {
    if (state.firstObservedAt == null) state.firstObservedAt = ts;
    state.lastObservedAt = ts;
  }
}

function foldSeam(seam: MarketableQuoteSeam, state: SeamState): MarketableQuoteSeamSnapshot {
  const total = emptyCounts();
  for (const mode of ['demo', 'live'] as const) {
    for (const outcome of MARKETABLE_QUOTE_OUTCOMES) {
      total[outcome] += state.byMode[mode][outcome];
    }
  }
  const observations = MARKETABLE_QUOTE_OUTCOMES.reduce((acc, o) => acc + total[o], 0);
  const fallbackTotal = observations - total.served;
  return {
    seam,
    instrumentState: !state.wired
      ? 'UNWIRED'
      : observations === 0
        ? 'WIRED_NO_OBSERVATIONS'
        : 'LIVE',
    observations,
    served: total.served,
    fallback: {
      one_sided: total.one_sided,
      absent: total.absent,
      breaker_open: total.breaker_open,
      error: total.error,
      no_client: total.no_client,
      no_capability: total.no_capability,
      unquoted_at_mark: total.unquoted_at_mark,
      total: fallbackTotal,
    },
    // The whole point of the module header's second bullet: an absent rate is `null`.
    fallbackRate: observations === 0 ? null : fallbackTotal / observations,
    byMode: {
      demo: { ...state.byMode.demo },
      live: { ...state.byMode.live },
    },
    firstObservedAt: state.firstObservedAt,
    lastObservedAt: state.lastObservedAt,
  };
}

/** Pure read of the process-wide ledger. */
export function marketableQuoteCoverageSnapshot(): MarketableQuoteCoverageSnapshot {
  return {
    resolution: foldSeam('resolution', seams.resolution),
    application: foldSeam('application', seams.application),
    note: MARKETABLE_QUOTE_COVERAGE_NOTE,
  };
}

/** Test seam — drop every count AND the wired flags back to a virgin process. */
export function resetMarketableQuoteCoverage(): void {
  seams.resolution = emptySeam();
  seams.application = emptySeam();
}
