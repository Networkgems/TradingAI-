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

// The module's only dependency, and deliberately a leaf one: `test-accounts.ts`
// imports nothing, so {@link classifySpreadCeilingAccount} can be called from the
// deep engine chokepoint without dragging a cycle through it.
import { isTestAccount } from './test-accounts.js';

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

/**
 * TRA-2350 — which entry archetypes under a structure key ACTUALLY evaluate that
 * structure's ceiling.
 *
 * `'all'` = the gate sits in the scanner's chain filter, above archetype, so every
 * row under the key passed it. `'none'` = no live path evaluates it. A LIST = the
 * gate sits on ONE entry path and only rows stamped with those archetypes went
 * through it.
 *
 * Why this table has to exist: a structure label is NOT a sleeve. Three call sites
 * stamp `structureLabel: 'single_leg_directional'` on a journal row —
 * `signal-engine.ts:8484` (the directional sleeve, `entryArchetype: 'directional'`),
 * `:9226` (iv-rv mispricing, `entryArchetype: 'iv-rv-buy-premium'`) and `:12180`
 * (AI-Options-Ideas single-leg, which stamps NO archetype at all) — and
 * `spreadCeilingRejectReason` has exactly ONE call site, `:8315`, reached only by
 * the first. So two of the three write into TRA-2295's structure key without ever
 * having been gated by it.
 *
 * The failure that follows is silent and points the wrong way: a wide-spread fill
 * from either ungated sleeve lands in the `single_leg_directional` compliance cell
 * and reads as **TRA-2295 enforcement falsified** for a gate that was never on its
 * path — a FALSE FAIL whose documented remedy is to re-open a correct ticket. The
 * telemetry side (`spreadCeilingEvaluated`) does not have this problem: it is
 * written only by `recordSpreadCeilingDecision` from the single gated site, so it
 * counts the directional sleeve alone. Only the JOURNAL-derived side pools. The two
 * are published as independent confirmations of each other, so before this table a
 * disagreement between them had two indistinguishable causes.
 *
 * ⚠ An archetype absent from a sleeve's list is UNGATED — including `unspecified`
 * (a row that stamped no archetype). That is the fail-closed direction on purpose:
 * an unrecognised writer must never be admitted to the gated cohort silently. Add a
 * new archetype here only when its entry path actually calls {@link spreadGateVerdict}.
 */
export type SleeveGatedArchetypes = 'all' | 'none' | readonly string[];

export const SLEEVE_GATED_ARCHETYPES: Readonly<Record<string, SleeveGatedArchetypes>> = {
  // `otm-mispricing.ts:185` — inside the scanner chain filter, so it runs before
  // anything downstream can pick a contract, for every archetype under the key.
  single_leg_otm: 'all',
  // `relative-value.ts:396` — inside the RV scanner chain filter, which NEVER RUNS
  // (`RV_ENGINE_ENABLED` is a compile-time false since TRA-1207/2026-06-30). No live
  // sleeve is gated by this entry, so NOTHING under this key may be graded as gated.
  single_leg_rv: 'none',
  // TRA-2295, `signal-engine.ts:8315` — on the directional ENTRY PATH itself, not in
  // a scanner. Only rows stamped `entryArchetype: 'directional'` (`:8476`, written in
  // the SAME object literal as the `:8484` structure stamp) reached it.
  single_leg_directional: ['directional'],
};

/**
 * TRA-2350 — the archetype bucket for a row that stamped none. Matches the
 * `r.entryArchetype ?? 'unspecified'` convention already used by the journal's own
 * archetype rollups (`option-trade-journal.ts:1055`, `:1129`), so the two surfaces
 * name the same cohort the same way.
 */
export const UNSPECIFIED_ENTRY_ARCHETYPE = 'unspecified';

/** Is `archetype` gated under `structure`, per {@link SLEEVE_GATED_ARCHETYPES}? */
export function isGatedArchetype(structure: string, archetype: string): boolean {
  // A structure with no entry here is UNKNOWN, not gated — same fail-closed default
  // as an archetype missing from a list.
  const gated = SLEEVE_GATED_ARCHETYPES[structure] ?? 'none';
  if (gated === 'all') return true;
  if (gated === 'none') return false;
  return gated.includes(archetype);
}

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
 * TRA-2355 — classify ONE owning account into its class. THE single implementation.
 *
 * Extracted so the two independent readouts of the same ceiling cannot drift on the
 * partition rule: the journal-derived side (`/api/health/option-spread-cost` →
 * `ceilingCompliance.byAccountClass`, which classifies a row's stored `account`) and
 * the gate's own counters (`/api/health/cost-aware-gate`, which classifies the owning
 * book at DECISION time). Those two are published as cross-checks of each other, so a
 * second copy of this three-line rule would make a disagreement between them
 * indistinguishable from a real enforcement failure — the same trap the structure-key
 * split set in TRA-2350.
 *
 * Absent/blank ⇒ `unattributed`, NEVER `desk`. That is the load-bearing branch: the
 * gate ledger hydrates pre-TRA-2355 JSONL lines that carry no class at all, and
 * defaulting those to `desk` would manufacture desk evidence out of records whose
 * owner is genuinely unknown — the exact pooling this ticket exists to end, laundered
 * through the hydrate instead of through the counter.
 */
export function classifySpreadCeilingAccount(
  account: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): SpreadCeilingAccountClass {
  if (typeof account !== 'string' || account.trim().length === 0) return 'unattributed';
  return isTestAccount(account, env) ? 'fixture' : 'desk';
}

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
  /**
   * TRA-2350 — the row's `entryArchetype`, or `null` when it stamped none. This is
   * the axis that separates the GATED sleeve from the other writers of the same
   * structure key; see {@link SLEEVE_GATED_ARCHETYPES}. A `null` here buckets under
   * {@link UNSPECIFIED_ENTRY_ARCHETYPE} and is treated as UNGATED.
   */
  entryArchetype: string | null;
}

/**
 * TRA-2350 — the ceiling statistics over ONE cohort of rows, with the module's null
 * discipline intact: every number is `null` when there is nothing to compute it
 * from, and `countAboveCeiling: 0` means the check RAN over `n` real rows.
 *
 * Shared by the pooled cell, by the gated/ungated partition and by each per-archetype
 * row, so the three can never be folded on different rules.
 */
export interface SpreadCeilingCohortStat {
  /** Rows in this cohort carrying a MEASURABLE two-sided fill-time quote. The honest `n`. */
  n: number;
  /**
   * Rows in this cohort whose quote was absent or unusable. Dropped from every stat
   * below — never zero-filled — but counted here so the drop is visible.
   */
  rowsDroppedNoQuote: number;
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

/** TRA-2350 — one archetype's slice of a (structure × accountClass) cell. */
export interface SpreadCeilingArchetypeStat extends SpreadCeilingCohortStat {
  /** `unspecified` when the rows stamped no archetype. */
  entryArchetype: string;
  /** Did this archetype's entry path evaluate the ceiling? Drives `gated`/`ungated`. */
  gated: boolean;
}

/**
 * The compliance readout for ONE (structure × accountClass) cell.
 *
 * Every numeric field is `null` when there is nothing to compute it from. Read
 * `n: 0` + all-null as "this check did not run here", and `countAboveCeiling: 0`
 * with `n > 0` as "it ran over `n` real rows and found none over the ceiling".
 *
 * ⚠ TRA-2350 — the TOP-LEVEL numbers on this cell are POOLED over every archetype
 * that wrote this structure label, INCLUDING sleeves that never evaluated the
 * ceiling. They are kept at the top level for consumer stability and they remain the
 * right read for "what did the book actually buy under this label" — but they are
 * NOT a verdict on whether an enforcement is holding. **Grade {@link gated}.**
 */
export interface SpreadCeilingStat extends SpreadCeilingCohortStat {
  structure: string;
  accountClass: SpreadCeilingAccountClass;
  /** The thresholds applied. `null` ⇒ this structure has no configured ceiling. */
  ceiling: SleeveSpreadCeiling | null;
  /**
   * TRA-2350 — the declared gated archetype set for this structure, echoed into the
   * payload so a consumer asserts the partition rule instead of assuming it.
   */
  gatedArchetypes: SleeveGatedArchetypes;
  /**
   * TRA-2350 — rows whose entry path ACTUALLY evaluated this ceiling. **This is the
   * enforcement verdict cell.** `countAboveCeiling > 0` here falsifies the gate;
   * `countAboveCeiling: 0` with `n > 0` is the pass; `n: 0` is NOT a pass.
   */
  gated: SpreadCeilingCohortStat;
  /**
   * TRA-2350 — rows under this structure key from sleeves that never called the
   * gate. A breach here is EXPECTED and falsifies nothing: it is an ungated sleeve
   * buying a wide contract, which is a separate finding (should that sleeve be
   * gated?) and not evidence about TRA-2295. Before this split those rows landed in
   * the graded cell.
   */
  ungated: SpreadCeilingCohortStat;
  /**
   * TRA-2350 — the per-archetype detail behind `gated`/`ungated`, so a disagreement
   * between this instrument and the gate's own counters is diagnosable rather than
   * merely visible. Always contains a row for every DECLARED gated archetype (at
   * `n: 0` if it did not trade), because an absent row reads exactly like a clean one.
   */
  byArchetype: SpreadCeilingArchetypeStat[];
}

/**
 * Fold journal entry quotes into the per-(structure × accountClass × entryArchetype)
 * ceiling compliance grid. Pure.
 *
 * Emits the FULL GRID — every sleeve in {@link SLEEVE_SPREAD_CEILINGS} (plus any
 * structure actually observed) crossed with all three account classes — rather
 * than only the cells that happen to have rows. A cell that is merely ABSENT from
 * a response reads exactly like a cell that passed, which is the failure shape this
 * whole ticket exists to remove: the consumer asking "is `single_leg_directional`
 * clean on the desk book?" must get an answer object back even when the desk book
 * is empty, and that answer must say `n: 0` / `null` rather than nothing at all.
 *
 * TRA-2350 adds the THIRD axis, for the same reason at one level down. A structure
 * key is NOT a sleeve: two ungated sleeves also stamp `single_leg_directional`, so
 * the pooled cell could report a breach against a gate that was never on the
 * breaching row's path — a false FAIL of a correct enforcement. Each cell therefore
 * also carries a `gated` / `ungated` partition plus per-archetype detail.
 * **`gated` is the enforcement verdict; the pooled top level is not.** See
 * {@link SLEEVE_GATED_ARCHETYPES}.
 */
export function summarizeSpreadCeilingCompliance(
  samples: readonly SpreadCeilingSample[],
): SpreadCeilingStat[] {
  // TRA-2350 — the cell key gains the archetype. NUL stays the separator: it cannot
  // occur in a structure or archetype label, so no two distinct triples can collide
  // into one bucket.
  const cellKey = (
    structure: string,
    accountClass: SpreadCeilingAccountClass,
    archetype: string,
  ): string => `${structure}\u0000${accountClass}\u0000${archetype}`;

  const measured = new Map<string, SpreadCrossMeasurement[]>();
  const bids = new Map<string, number[]>();
  const dropped = new Map<string, number>();

  const structures = new Set<string>(Object.keys(SLEEVE_SPREAD_CEILINGS));
  for (const s of samples) structures.add(s.structure);

  // Every archetype OBSERVED under a structure, plus every archetype DECLARED gated
  // for it — so a gated sleeve that did not trade still emits a row saying `n: 0`
  // instead of being absent, which would read exactly like a clean one.
  const archetypesByStructure = new Map<string, Set<string>>();
  const noteArchetype = (structure: string, archetype: string): void => {
    const set = archetypesByStructure.get(structure) ?? new Set<string>();
    set.add(archetype);
    archetypesByStructure.set(structure, set);
  };
  for (const structure of structures) {
    if (!archetypesByStructure.has(structure)) archetypesByStructure.set(structure, new Set());
    const gated = SLEEVE_GATED_ARCHETYPES[structure];
    if (Array.isArray(gated)) for (const a of gated) noteArchetype(structure, a);
  }

  const archetypeOf = (s: SpreadCeilingSample): string =>
    typeof s.entryArchetype === 'string' && s.entryArchetype.trim().length > 0
      ? s.entryArchetype
      : UNSPECIFIED_ENTRY_ARCHETYPE;

  for (const s of samples) {
    const archetype = archetypeOf(s);
    noteArchetype(s.structure, archetype);
    const key = cellKey(s.structure, s.accountClass, archetype);
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

  /**
   * Fold one already-selected set of rows into the shared cohort shape. The pooled
   * cell, the gated/ungated partition and every per-archetype row all go through
   * THIS function, so the three can never end up folded on different rules — which
   * is the only reason a disagreement between them is readable as a finding.
   */
  const foldCohort = (
    rows: readonly SpreadCrossMeasurement[],
    rowBids: readonly number[],
    rowsDroppedNoQuote: number,
    ceiling: SleeveSpreadCeiling | null,
  ): SpreadCeilingCohortStat => {
    const n = rows.length;
    return {
      n,
      rowsDroppedNoQuote,
      // `null`, not 0 — an empty cohort must not read as a zero-spread book.
      maxSpreadPct: n === 0 ? null : Math.max(...rows.map((m) => m.spreadPct)),
      countAboveCeiling:
        n === 0 || !ceiling ? null : rows.filter((m) => m.spreadPct > ceiling.maxSpreadPct).length,
      minEntryBidUsd: n === 0 ? null : Math.min(...rowBids),
      countBelowMinBid:
        n === 0 || !ceiling ? null : rowBids.filter((b) => b < ceiling.minBidUsd).length,
    };
  };

  const out: SpreadCeilingStat[] = [];
  for (const structure of [...structures].sort((a, b) => a.localeCompare(b))) {
    const ceiling = SLEEVE_SPREAD_CEILINGS[structure] ?? null;
    const archetypes = [...(archetypesByStructure.get(structure) ?? new Set<string>())].sort(
      (a, b) => a.localeCompare(b),
    );
    for (const accountClass of SPREAD_CEILING_ACCOUNT_CLASSES) {
      const byArchetype: SpreadCeilingArchetypeStat[] = [];
      // Three accumulators per cell. Each row contributes to `pooled` and to exactly
      // one of `gatedAcc`/`ungatedAcc`, so `gated.n + ungated.n === n` by construction
      // — a consumer can assert that identity to detect a partition that silently
      // dropped rows.
      const pooled = { rows: [] as SpreadCrossMeasurement[], bids: [] as number[], dropped: 0 };
      const gatedAcc = { rows: [] as SpreadCrossMeasurement[], bids: [] as number[], dropped: 0 };
      const ungatedAcc = { rows: [] as SpreadCrossMeasurement[], bids: [] as number[], dropped: 0 };

      for (const archetype of archetypes) {
        const key = cellKey(structure, accountClass, archetype);
        const rows = measured.get(key) ?? [];
        const rowBids = bids.get(key) ?? [];
        const rowsDropped = dropped.get(key) ?? 0;
        const gated = isGatedArchetype(structure, archetype);

        byArchetype.push({
          entryArchetype: archetype,
          gated,
          ...foldCohort(rows, rowBids, rowsDropped, ceiling),
        });

        for (const acc of [pooled, gated ? gatedAcc : ungatedAcc]) {
          acc.rows.push(...rows);
          acc.bids.push(...rowBids);
          acc.dropped += rowsDropped;
        }
      }

      out.push({
        structure,
        accountClass,
        ceiling: ceiling ? { ...ceiling } : null,
        gatedArchetypes: SLEEVE_GATED_ARCHETYPES[structure] ?? 'none',
        ...foldCohort(pooled.rows, pooled.bids, pooled.dropped, ceiling),
        gated: foldCohort(gatedAcc.rows, gatedAcc.bids, gatedAcc.dropped, ceiling),
        ungated: foldCohort(ungatedAcc.rows, ungatedAcc.bids, ungatedAcc.dropped, ceiling),
        byArchetype,
      });
    }
  }
  return out;
}
