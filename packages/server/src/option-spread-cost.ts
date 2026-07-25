// TRA-1656 (TRA-1602B) — MEASURE the option spread cross, in R units.
//
// The cost-aware fire bar (TRA-1602, `option-cost-gate.ts`) rests on a spread
// cross that was never measured: `makerAdjustedSpreadCrossR = 1.00R`, carrying
// its own admission that it is "INTERIM (modeled, not measured)". That number is
// the DOMINANT term in the shipped 1.25R bar, so every downstream verdict — most
// of all TRA-1647's "the book cannot cover its cost" — is an artifact of it until
// it is replaced by a measurement. This module is the measurement.
//
// ── The R basis (this is the whole ballgame) ─────────────────────────────────
// Both option sites stop at `mark * 0.75` (see `signal-engine.ts`, the RV and OTM
// signal builders), so the trade's at-risk STOP distance is
//
//     R = entryMark − stopPrice = 0.25 · entryMark
//
// which is the unit `estimateModeledGrossR` and therefore the cost gate speak in.
// The ROUND-TRIP spread cross (buy at the ask, sell at the bid) costs the full
// quoted spread, so
//
//     spreadCrossR = (ask − bid) / (0.25 · mark) = 4 · spreadPct
//
// where `spreadPct = (ask − bid) / mark` is the quantity the scanners already
// compute and liquidity-filter on. That identity is the load-bearing fact here.
//
// ⚠ The journal's OWN `realizedR` uses a DIFFERENT basis: `atRiskUsd` is stamped
// as the full premium paid (`options-account.ts` passes `totalCost`), so journal
// R = premium, not 0.25·premium. The two are a factor of 4 apart. We therefore
// report BOTH bases on every row so a reader can never silently compare a
// stop-basis cost against a premium-basis return. `spreadCrossR` is the STOP
// basis (the gate's unit, the one TRA-1656 asks for); `spreadCrossRPremiumBasis`
// is the journal's.
//
// ── The ceiling, and TRA-2295: where it is actually enforced ─────────────────
// ⚠ CORRECTED BY TRA-2295 (raised from TRA-2291). This block used to assert that
// the ceiling held for EVERY sleeve "independently of selection", on the grounds
// that "the scanners hard-reject `spreadPct > maxSpreadPct` BEFORE selection".
// That sentence was true of the scanners and FALSE of the book, and the gap
// between the two is the whole bug:
//
//   • `single_leg_otm` — enforced. `otm-mispricing.ts:185` runs on every chain
//     row before a candidate exists. Live desk journal: max spreadPct 0.196
//     against a 0.20 ceiling, 0/27 over. THAT is what an enforced ceiling reads
//     like, and it is the positive control for the formula below.
//   • `single_leg_rv` — the reject at `relative-value.ts:396` sits inside the RV
//     SCANNER, and `RV_ENGINE_ENABLED = false` has been a compile-time constant
//     since TRA-1207 (2026-06-30). The code path never executes.
//   • the DIRECTIONAL sleeve (`evaluateDemoDirectional` → `openOptionFromRvCandidate`,
//     journal label `single_leg_directional` since TRA-2245, `single_leg_rv`
//     before it) reads `RelativeValueScanner.getSelectorChain`, which returns the
//     RAW `fetchChain` rows — the `prepareChain` filter that carries the ceiling
//     is only reached from `scan()`. So the sleeve wore the LABEL of a gate it
//     never ran: 59 of 83 desk entries crossed the 0.10 ceiling, worst 1.933
//     (19×), on contracts quoted bid 0.01 / ask 0.59.
//
// A ceiling nothing evaluates and a ceiling nothing violates produce the IDENTICAL
// reading of zero rejections, which is why this went 83 fills without surfacing.
// TRA-2295 closes it at the entry path with {@link spreadGateVerdict} below —
// evaluated on the SAME quote that is journaled as `entryBid`/`entryAsk` and sets
// the fill, so the gate and the fill cannot disagree — and records BOTH admits and
// rejects to `/api/health/cost-aware-gate` so "ran, rejected nothing" is legible
// as something other than "never ran".
//
// Consequence for the cost model: the bound below is NOT selection-independent for
// any sleeve whose gate does not run. On the worst admitted contract the true cross
// was 4 · 1.933 = 7.73R, so the gate's 1.00R input UNDER-billed it ~7.7×, the
// opposite direction from the "conservative" claim TRA-1647 leaned on. Forward of
// the TRA-2295 enforcement the bound is real again — but only for sleeves listed in
// {@link SLEEVE_SPREAD_CEILINGS} whose entry path actually calls the verdict.
//
// The MEASUREMENT half of this module remains observe-only: nothing below
// `spreadGateVerdict` routes an order. `spreadGateVerdict` itself is a pure
// predicate — the caller decides what to do with it.

/** The at-risk stop distance as a fraction of the entry mark (stop = mark·0.75). */
export const STOP_DISTANCE_FRACTION_OF_MARK = 0.25;

/** Per-sleeve admission thresholds on the fill-time quote. */
export interface SleeveSpreadCeiling {
  /** `(ask − bid) / mark` may not exceed this. */
  maxSpreadPct: number;
  /** The same bound expressed in the gate's R unit: `4 · maxSpreadPct`. */
  maxSpreadCrossR: number;
  /**
   * TRA-2295 — minimum per-share BID for the quote to count as a market at all.
   *
   * A spread ceiling alone is not enough. `bid 0.05 / ask 2.75` is not a wide
   * market, it is an ABSENT one, and a ratio test can be passed by a book so thin
   * that the mid it is measured against is fiction (`bid 0.01 / ask 0.012` crosses
   * at 18% of mark on a contract nobody will fill). The ratio and the level have to
   * be checked together.
   */
  minBidUsd: number;
}

/**
 * The `maxSpreadPct` per sleeve, converted through `spreadCrossR = 4 · spreadPct`
 * into the ceiling on the round-trip cross of any contract that sleeve may admit.
 * Sourced from the engine scanner option defaults (`otm-mispricing.ts` 0.20,
 * `relative-value.ts` 0.10).
 *
 * THE SINGLE SOURCE OF TRUTH for both the cost model and the entry gate
 * ({@link spreadGateVerdict}), so the two cannot drift apart the way they did
 * before TRA-2295 — when the cost model quoted a 0.10 ceiling attributed to a
 * scanner the entry path never reached.
 *
 * `single_leg_directional` (TRA-2245 label) inherits RV's 0.10: it is the same
 * near-ATM single-leg long the 0.10 was written for. Read
 * {@link SLEEVE_SPREAD_CEILINGS} as "what this sleeve is allowed to buy" — whether
 * anything ENFORCES it is a property of the entry path, not of this table, and the
 * `spreadCeilingEvaluated` counter on `/api/health/cost-aware-gate` is what answers
 * that question for a given sleeve on a given day.
 */
export const SLEEVE_SPREAD_CEILINGS: Readonly<Record<string, SleeveSpreadCeiling>> = {
  single_leg_otm: { maxSpreadPct: 0.2, maxSpreadCrossR: 0.8, minBidUsd: 0.05 },
  single_leg_rv: { maxSpreadPct: 0.1, maxSpreadCrossR: 0.4, minBidUsd: 0.1 },
  single_leg_directional: { maxSpreadPct: 0.1, maxSpreadCrossR: 0.4, minBidUsd: 0.1 },
};

/** A two-sided quote captured at fill time. */
export interface FillQuote {
  /** Per-share bid at fill. */
  bid: number;
  /** Per-share ask at fill. */
  ask: number;
  /** Per-share mark (mid) the fill booked against. */
  mark: number;
}

/** The measured spread cross for one fill, in dollars and in both R bases. */
export interface SpreadCrossMeasurement {
  /** Round-trip cross in dollars per share: `ask − bid`. */
  spreadCrossUsdPerShare: number;
  /** `(ask − bid) / mark` — the quantity the scanners liquidity-filter on. */
  spreadPct: number;
  /** Round-trip cross in the GATE's R unit (R = 0.25·mark). The number TRA-1656 asks for. */
  spreadCrossR: number;
  /** Round-trip cross in the JOURNAL's R unit (R = full premium). 4× smaller. */
  spreadCrossRPremiumBasis: number;
  /** The mark the cross is measured against — makes the R conversion auditable. */
  entryMarkUsd: number;
}

/**
 * Measure the round-trip spread cross for a single fill quote. Returns `null`
 * when the quote is unusable (non-finite, non-positive mark, crossed book), so
 * an unmeasurable fill DROPS OUT of the rollup rather than being counted as a
 * free (zero-cost) fill — the failure mode that would bias the measured cost
 * toward zero and re-open exactly the hole this ticket exists to close.
 */
export function measureSpreadCross(quote: FillQuote): SpreadCrossMeasurement | null {
  const { bid, ask, mark } = quote;
  if (![bid, ask, mark].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (mark <= 0 || bid < 0 || ask <= 0) return null;
  if (ask < bid) return null; // crossed / corrupt book

  const spreadCrossUsdPerShare = ask - bid;
  const spreadPct = spreadCrossUsdPerShare / mark;
  return {
    spreadCrossUsdPerShare,
    spreadPct,
    spreadCrossR: spreadPct / STOP_DISTANCE_FRACTION_OF_MARK,
    spreadCrossRPremiumBasis: spreadPct,
    entryMarkUsd: mark,
  };
}

// ── TRA-2295 — the ENTRY GATE ────────────────────────────────────────────────

/** Kill switch for {@link isSpreadCeilingEnforceEnabled}. Set to `0`/`false`/`off` to disarm. */
export const OPTION_SPREAD_CEILING_ENFORCE_FLAG = 'OPTION_SPREAD_CEILING_ENFORCE';

/**
 * TRA-2295 — is the entry-path spread ceiling ENFORCING? **Default TRUE.**
 *
 * Opt-OUT, not opt-in, and deliberately the opposite polarity from the dark demo
 * gates around it (`ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE`, `ENABLE_OPTION_COST_AWARE_GATE`,
 * …). Those arm a NEW admission policy that has to be forward-validated before it is
 * trusted. This one restores a bound that `signal-engine.ts`, `option-spread-cost.ts`
 * and `health-routes.ts` all already documented as being in force — the defect was
 * that no code applied it. Shipping it dark would leave the documentation and the
 * behaviour disagreeing until somebody remembered to set a variable, which is the
 * failure mode, not the fix. (An unset flag is also indistinguishable from a wiped
 * one — TRA-2136 erased twelve Render env vars and every dependent gate went silently
 * inert; a default-ON gate survives that class of accident.)
 *
 * Only an EXPLICIT off value disarms it, so a typo'd or empty value keeps the ceiling
 * on rather than quietly dropping it.
 */
export function isSpreadCeilingEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_SPREAD_CEILING_ENFORCE_FLAG];
  if (typeof raw !== 'string') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Why {@link spreadGateVerdict} refused (or `ok` / `no_ceiling` when it did not). */
export type SpreadGateCode =
  /** Admitted: quote is usable and inside both thresholds. */
  | 'ok'
  /** Admitted: this sleeve has no entry in {@link SLEEVE_SPREAD_CEILINGS}. */
  | 'no_ceiling'
  /** REJECTED: the quote is not a measurable two-sided book. */
  | 'no_quote'
  /** REJECTED: `bid < minBidUsd` — an absent market, not a wide one. */
  | 'min_bid'
  /** REJECTED: `(ask − bid) / mark > maxSpreadPct`. */
  | 'max_spread_pct';

export interface SpreadGateVerdict {
  /** False ⇒ the caller must NOT open. */
  admitted: boolean;
  code: SpreadGateCode;
  /** Human-readable rejection reason, `null` when admitted. */
  reason: string | null;
  /** The measured `(ask − bid) / mark`, `null` when the quote was unmeasurable. */
  spreadPct: number | null;
  /** The thresholds applied, `null` when the sleeve has no ceiling configured. */
  thresholds: SleeveSpreadCeiling | null;
}

/** Optional per-call overrides (env-tunable at the caller). Absent ⇒ table default. */
export interface SpreadGateOverrides {
  minBidUsd?: number;
  maxSpreadPct?: number;
}

/**
 * TRA-2295 — the admission predicate for the fill-time quote. Pure.
 *
 * Applied by the ENTRY path to the exact quote it is about to fill and journal
 * (`entryBid`/`entryAsk`/`entryMarkUsd`), not to a scanner's pre-selection view of
 * the chain. That is the fix: the previous ceiling lived in a chain filter that the
 * directional caller never executed, so the gate and the fill were describing
 * different contracts — and nothing anywhere compared them.
 *
 * FAILS CLOSED on an unmeasurable quote (`no_quote`). An entry whose spread cannot
 * be computed is not an entry whose spread is zero; admitting it would restore, at
 * the gate, the exact writer-side false-zero this module refuses at the measurement
 * (see {@link measureSpreadCross}).
 *
 * A sleeve absent from {@link SLEEVE_SPREAD_CEILINGS} is ADMITTED with code
 * `no_ceiling` rather than rejected against an invented bound — but the code says so
 * out loud, so a caller that wired the wrong sleeve name reads `no_ceiling` on every
 * candidate instead of a silent, uniformly-passing gate.
 */
export function spreadGateVerdict(
  sleeve: string,
  quote: FillQuote,
  overrides: SpreadGateOverrides = {},
): SpreadGateVerdict {
  const base = SLEEVE_SPREAD_CEILINGS[sleeve];
  if (!base) {
    return { admitted: true, code: 'no_ceiling', reason: null, spreadPct: null, thresholds: null };
  }
  const maxSpreadPct = Number.isFinite(overrides.maxSpreadPct as number)
    ? (overrides.maxSpreadPct as number)
    : base.maxSpreadPct;
  const minBidUsd = Number.isFinite(overrides.minBidUsd as number)
    ? (overrides.minBidUsd as number)
    : base.minBidUsd;
  const thresholds: SleeveSpreadCeiling = {
    maxSpreadPct,
    maxSpreadCrossR: maxSpreadPct / STOP_DISTANCE_FRACTION_OF_MARK,
    minBidUsd,
  };

  const m = measureSpreadCross(quote);
  if (!m) {
    return {
      admitted: false,
      code: 'no_quote',
      reason: `no measurable two-sided quote (bid ${quote.bid}, ask ${quote.ask}, mark ${quote.mark}) — cannot bound the spread cross, refusing the entry`,
      spreadPct: null,
      thresholds,
    };
  }

  // Level BEFORE ratio: on `bid 0.05 / ask 2.75` both fire, and `min_bid` is the
  // more honest description of what is wrong with that book.
  if (quote.bid < minBidUsd) {
    return {
      admitted: false,
      code: 'min_bid',
      reason: `bid $${quote.bid.toFixed(2)} is below the $${minBidUsd.toFixed(2)} quotability floor for ${sleeve} — an absent market, not a wide one`,
      spreadPct: m.spreadPct,
      thresholds,
    };
  }

  if (m.spreadPct > maxSpreadPct) {
    return {
      admitted: false,
      code: 'max_spread_pct',
      reason: `spreadPct ${m.spreadPct.toFixed(4)} exceeds the ${maxSpreadPct.toFixed(2)} ceiling for ${sleeve} (round-trip cross ${m.spreadCrossR.toFixed(2)}R vs ${thresholds.maxSpreadCrossR.toFixed(2)}R)`,
      spreadPct: m.spreadPct,
      thresholds,
    };
  }

  return { admitted: true, code: 'ok', reason: null, spreadPct: m.spreadPct, thresholds };
}

/** Commission in R (stop basis) for a round trip on `contracts` contracts. */
export function commissionR(
  entryMarkUsd: number,
  contracts: number,
  perContractPerSideUsd: number,
): number | null {
  if (!Number.isFinite(entryMarkUsd) || entryMarkUsd <= 0) return null;
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  if (!Number.isFinite(perContractPerSideUsd) || perContractPerSideUsd < 0) return null;
  // Round trip = 2 sides. R in dollars = 0.25 · mark · 100 · contracts.
  const roundTripUsd = 2 * perContractPerSideUsd * contracts;
  const rUsd = STOP_DISTANCE_FRACTION_OF_MARK * entryMarkUsd * 100 * contracts;
  if (rUsd <= 0) return null;
  return roundTripUsd / rUsd;
}

/** One measurable fill: the structure it fired under plus its fill-time quote. */
export interface SpreadCostSample {
  structure: string;
  quote: FillQuote;
  /** Contracts filled — only needed for the commission-in-R term. */
  contracts?: number;
}

/** The measured rollup for one structure. Mirrors the TRA-1656 probe shape. */
export interface StructureSpreadCost {
  structure: string;
  /** Fills carrying a usable fill-time quote. The honest `n`. */
  n: number;
  /** THE number: measured round-trip cross / R, R = 0.25·mark (the gate's unit). */
  avgSpreadCrossR: number;
  medianSpreadCrossR: number;
  /** The mean is skewed by illiquid names; p90 is the tail a bar must survive. */
  p90SpreadCrossR: number;
  /** Same measurement in the journal's premium basis (4× smaller). */
  avgSpreadCrossRPremiumBasis: number;
  /** Dollar terms, so the R conversion is auditable end-to-end. */
  avgSpreadCrossUsd: number;
  avgEntryMarkUsd: number;
  /** Measured round-trip commission in R — checks the gate's 0.05R input. */
  avgCommissionR: number | null;
  /** The scanner-enforced ceiling, when the structure has one. */
  maxSpreadCrossR: number | null;
  /**
   * Re-derived admission bar for this structure from the MEASURED cross:
   * `avgCommissionR + avgSpreadCrossR + safetyMargin`. Derived from the
   * MEASUREMENT, independently of whatever the gate's config currently charges —
   * that independence is what lets this probe re-falsify the gate's cost input if
   * the two ever drift apart (it is what refuted the original 1.00R input, and it
   * is the check on the 0.235R that replaced it in TRA-1661).
   */
  impliedBarR: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo] as number;
  if (lo === hi) return loV;
  const hiV = sorted[hi] as number;
  return loV + (hiV - loV) * (idx - lo);
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface SpreadCostSummaryOptions {
  /** Tradier options commission per contract per side (default $0.35). */
  commissionPerContractPerSideUsd?: number;
  /** Safety margin used to re-derive the implied bar (default 0.20R, the gate's). */
  safetyMarginR?: number;
}

/**
 * Fold a set of measurable fills into the per-structure measured spread-cost
 * rollup. Samples whose quote is unusable are dropped (never zero-filled), so
 * `n` is always the count of genuinely MEASURED fills — the quantity the
 * TRA-1656 acceptance bar (`n >= 50`) is stated against. Pure.
 */
export function summarizeSpreadCost(
  samples: readonly SpreadCostSample[],
  options: SpreadCostSummaryOptions = {},
): StructureSpreadCost[] {
  const commissionPerSide = options.commissionPerContractPerSideUsd ?? 0.35;
  const safetyMarginR = options.safetyMarginR ?? 0.2;

  const byStructure = new Map<string, Array<{ m: SpreadCrossMeasurement; contracts?: number }>>();
  for (const s of samples) {
    const m = measureSpreadCross(s.quote);
    if (!m) continue;
    const bucket = byStructure.get(s.structure) ?? [];
    bucket.push({ m, ...(s.contracts !== undefined ? { contracts: s.contracts } : {}) });
    byStructure.set(s.structure, bucket);
  }

  const out: StructureSpreadCost[] = [];
  for (const [structure, rows] of byStructure) {
    const crossR = rows.map((r) => r.m.spreadCrossR).sort((a, b) => a - b);
    const commissions = rows
      .map((r) => (r.contracts === undefined ? null : commissionR(r.m.entryMarkUsd, r.contracts, commissionPerSide)))
      .filter((v): v is number => v !== null);

    const avgSpreadCrossR = mean(crossR);
    const avgCommissionR = commissions.length > 0 ? mean(commissions) : null;
    const ceiling = SLEEVE_SPREAD_CEILINGS[structure]?.maxSpreadCrossR ?? null;

    out.push({
      structure,
      n: rows.length,
      avgSpreadCrossR,
      medianSpreadCrossR: quantile(crossR, 0.5),
      p90SpreadCrossR: quantile(crossR, 0.9),
      avgSpreadCrossRPremiumBasis: mean(rows.map((r) => r.m.spreadCrossRPremiumBasis)),
      avgSpreadCrossUsd: mean(rows.map((r) => r.m.spreadCrossUsdPerShare)),
      avgEntryMarkUsd: mean(rows.map((r) => r.m.entryMarkUsd)),
      avgCommissionR,
      maxSpreadCrossR: ceiling,
      impliedBarR: (avgCommissionR ?? 0.05) + avgSpreadCrossR + safetyMarginR,
    });
  }
  return out.sort((a, b) => a.structure.localeCompare(b.structure));
}

// ── TRA-2316 — the INDEPENDENT ceiling-compliance read ───────────────────────
//
// TRA-2306 verifies TRA-2295 with two reads. Read #1 is the gate's own counters
// (`spreadCeilingEvaluated` / `maxAdmittedSpreadPct` / the TRA-2311 `armed` bit)
// on `/api/health/cost-aware-gate`. That read is sound but it is NOT independent:
// **a gate that records its own admissions cannot falsify itself.** Read #2 was
// supposed to supply the independence by counting ceiling-breaching rows straight
// out of the journal — and as of live SHA `8ff43a30` no deployed route could
// execute it:
//
//   • `/api/health/option-journal?rows=demo` has the `account` axis but its row
//     projection carries NO quote fields (`rowsCarryMarks: false`). Computing
//     `(entryAsk − entryBid) / entryMarkUsd` off that projection yields `NaN`, and
//     `NaN > 0.10` is `false` — so the check reported "0 rows above the ceiling"
//     on EVERY possible input, including a completely broken gate. No failing state.
//   • `/api/health/option-spread-cost` has the quotes but pooled `qa_*`/`ctoverify*`
//     fixture books in with desk rows (the TRA-2100 mirror trap), and published only
//     avg/median/p90 — and `p90 <= ceiling` is consistent with 10% of rows ABOVE it,
//     so it structurally could not answer "0 rows above".
//
// This fold is the missing read: a TRUE MAX and a strict count of breaches, per
// structure, PARTITIONED BY ACCOUNT CLASS, computed from the journal's own
// fill-time quotes with no reference to anything the gate wrote.
//
// Two disciplines are load-bearing here, both inherited from the bugs above:
//
//  1. **An unmeasurable quote drops out of the denominator — it is never a zero.**
//     Same rule as {@link measureSpreadCross} and `cost-aware-gate-ledger.ts:481`.
//     A row with no fill-time quote is not a row with a zero-width spread, and
//     zero-filling one would let a compaction publish a falsely-cheap max. Dropped
//     rows are COUNTED (`rowsDroppedNoQuote`) rather than silently vanishing, so a
//     partition reading `n: 0` after discarding forty rows cannot be misread as a
//     clean, quiet book.
//  2. **"No rows to check" is `null`, never `0`.** `countAboveCeiling: 0` means the
//     check ran over real rows and found none over; an empty partition means it did
//     not run at all. Conflating those two is the entire reason TRA-2295 (a ceiling
//     nothing evaluated read identically to a ceiling nothing violated) and TRA-2311
//     (`spreadCeilingEvaluated: 0` read identically whether QUIET or DISARMED) both
//     had to exist. Mirrors `maxAdmittedSpreadPct` / `spreadCeilingRejectRate`.

/**
 * TRA-2193's three account classes. `unattributed` = rows written before TRA-1475
 * added `account`; it is NOT desk, and folding it into desk would re-commit the
 * pooling bug for exactly the historical rows a long-window grade leans on hardest.
 */
export type SpreadCeilingAccountClass = 'desk' | 'fixture' | 'unattributed';

export const SPREAD_CEILING_ACCOUNT_CLASSES: readonly SpreadCeilingAccountClass[] = [
  'desk',
  'fixture',
  'unattributed',
];

/**
 * One journal row's entry economics for the compliance fold.
 *
 * `quote` is NULLABLE by design: the caller passes rows that carry no fill-time
 * quote as `quote: null` instead of filtering them out, so the fold can report how
 * many rows it had to discard. A caller that pre-filters hides the denominator.
 */
export interface SpreadCeilingSample {
  structure: string;
  accountClass: SpreadCeilingAccountClass;
  quote: FillQuote | null;
}

/**
 * The compliance readout for ONE (structure × accountClass) cell.
 *
 * Every numeric field is `null` when there is nothing to compute it from. Read
 * `n: 0` + all-null as "this check did not run here", and `countAboveCeiling: 0`
 * with `n > 0` as "it ran over `n` real rows and found none over the ceiling".
 */
export interface SpreadCeilingStat {
  structure: string;
  accountClass: SpreadCeilingAccountClass;
  /** Rows in this cell carrying a MEASURABLE two-sided fill-time quote. The honest `n`. */
  n: number;
  /**
   * Rows in this cell whose quote was absent or unusable. Dropped from every stat
   * below — never zero-filled — but counted here so the drop is visible.
   */
  rowsDroppedNoQuote: number;
  /** The thresholds applied. `null` ⇒ this structure has no configured ceiling. */
  ceiling: SleeveSpreadCeiling | null;
  /** TRUE max of `(ask − bid) / mark`, not a quantile. `null` when `n === 0`. */
  maxSpreadPct: number | null;
  /**
   * Rows with `spreadPct > ceiling.maxSpreadPct` — the strict comparison the entry
   * gate uses. `null` when `n === 0` OR the structure has no ceiling to breach.
   */
  countAboveCeiling: number | null;
  /** Lowest per-share entry bid seen. `null` when `n === 0`. */
  minEntryBidUsd: number | null;
  /** Rows with `bid < ceiling.minBidUsd` — an ABSENT market, not merely a wide one. */
  countBelowMinBid: number | null;
}

/**
 * Fold journal entry quotes into the per-(structure × accountClass) ceiling
 * compliance grid. Pure.
 *
 * Emits the FULL GRID — every sleeve in {@link SLEEVE_SPREAD_CEILINGS} (plus any
 * structure actually observed) crossed with all three account classes — rather
 * than only the cells that happen to have rows. A cell that is merely ABSENT from
 * a response reads exactly like a cell that passed, which is the failure shape this
 * whole ticket exists to remove: the consumer asking "is `single_leg_directional`
 * clean on the desk book?" must get an answer object back even when the desk book
 * is empty, and that answer must say `n: 0` / `null` rather than nothing at all.
 */
export function summarizeSpreadCeilingCompliance(
  samples: readonly SpreadCeilingSample[],
): SpreadCeilingStat[] {
  const cellKey = (structure: string, accountClass: SpreadCeilingAccountClass): string =>
    `${structure}\u0000${accountClass}`;

  const measured = new Map<string, SpreadCrossMeasurement[]>();
  const bids = new Map<string, number[]>();
  const dropped = new Map<string, number>();

  const structures = new Set<string>(Object.keys(SLEEVE_SPREAD_CEILINGS));
  for (const s of samples) structures.add(s.structure);

  for (const s of samples) {
    const key = cellKey(s.structure, s.accountClass);
    const m = s.quote === null ? null : measureSpreadCross(s.quote);
    if (!m || s.quote === null) {
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
      continue;
    }
    const bucket = measured.get(key) ?? [];
    bucket.push(m);
    measured.set(key, bucket);
    const bidBucket = bids.get(key) ?? [];
    bidBucket.push(s.quote.bid);
    bids.set(key, bidBucket);
  }

  const out: SpreadCeilingStat[] = [];
  for (const structure of [...structures].sort((a, b) => a.localeCompare(b))) {
    const ceiling = SLEEVE_SPREAD_CEILINGS[structure] ?? null;
    for (const accountClass of SPREAD_CEILING_ACCOUNT_CLASSES) {
      const key = cellKey(structure, accountClass);
      const rows = measured.get(key) ?? [];
      const rowBids = bids.get(key) ?? [];
      const n = rows.length;
      out.push({
        structure,
        accountClass,
        n,
        rowsDroppedNoQuote: dropped.get(key) ?? 0,
        ceiling: ceiling ? { ...ceiling } : null,
        // `null`, not 0 — an empty cell must not read as a zero-spread book.
        maxSpreadPct: n === 0 ? null : Math.max(...rows.map((m) => m.spreadPct)),
        countAboveCeiling:
          n === 0 || !ceiling
            ? null
            : rows.filter((m) => m.spreadPct > ceiling.maxSpreadPct).length,
        minEntryBidUsd: n === 0 ? null : Math.min(...rowBids),
        countBelowMinBid:
          n === 0 || !ceiling ? null : rowBids.filter((b) => b < ceiling.minBidUsd).length,
      });
    }
  }
  return out;
}
