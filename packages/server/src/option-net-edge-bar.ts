// TRA-3272 (parent TRA-3271) — the NET-EDGE form of the options cost bar.
//
// What the flat form did to the live OTM sleeve (measured, TRA-3271): the armed
// bar is one constant R number (0.485R) tested against a modeled edge that is
// linear in |delta| (`3·|delta| − 1` on the 2:1 OTM bracket), so the ONLY
// candidates that clear it are |delta| ≥ ~0.50 — i.e. ATM. All 4 live entries
// after the 08-05 arm sit at |delta| 0.5044–0.5111 on a sleeve authorized to
// trade OTM mispricing; block rate 0.9921, all in scope `single_leg_otm`. The
// constant bar charges every candidate the UNIVERSE-MEAN spread cross (0.235R)
// regardless of what the candidate's own quote says, and on the cheap OTM band
// the fee floor ($0.229/contract round trip, TRA-2810) is structurally 21–24%
// of gross premium — so a bar expressed off blended constants rejects nearly
// the whole OTM band and admits ATM.
//
// The net-edge form re-expresses the SAME economics per candidate:
//
//   block  iff  expectedRoundTripCostR  >  k · modeledGrossR
//
//     expectedRoundTripCost  =  (ask − bid)            full taker spread cross,
//                                                       THIS candidate's quote
//                            +  fees/contract ÷ 100     $0.229 RT (TRA-2810)
//     …R                     =  cost ÷ (mark − stop)    the trade's own at-risk
//                                                       R basis (0.25·mark on
//                                                       the 2:1 bracket)
//
// plus an ABSOLUTE CEILING that keeps structurally uneconomic deep-cheap
// contracts blocked regardless of modeled edge: when round-trip cost exceeds
// `absCostFracCeiling` of the gross premium itself, no edge model rescues the
// trade (you pay the ceiling fraction of your stake to the market makers just
// to hold it round trip).
//
// A tight-quoted OTM contract with real modeled edge can now clear; a
// wide-quoted or fee-dominated one still cannot. It is still purely a
// REJECTION filter relative to the un-enforced live path (tightening-only in
// the TRA-1897-HOLD sense), but relative to the ARMED FLAT bar it re-admits
// the tight-quoted OTM band — which is exactly the QuantTrader-ordered redesign
// (TRA-3271: "the fix is NOT to loosen the flat fraction … the bar needs a
// per-band or net-edge form").
//
// ── OFF BY DEFAULT; PARAMETERS ARE NOT THE IMPLEMENTER'S TO PICK ────────────
// `ENABLE_OPTION_COST_BAR_NET_EDGE` is unset in every environment. The shipped
// k / ceiling defaults below are PLACEHOLDERS so the resolver is total; the
// authoritative values are pre-registered by QuantTrader off the TRA-3216
// reason-split tape (TRA-3272 item 4) BEFORE any arming. Do not arm this flag
// on bqb1 without that pre-registration recorded on TRA-3272.

/**
 * Master switch for the net-edge cost-bar form. OFF by default. When armed the
 * net-edge verdict REPLACES the flat `modeledGrossR >= barR` test for the
 * structures in {@link NetEdgeBarConfig.structures}; every other structure
 * keeps the flat form byte-for-byte. Live reads the PROCESS env (the same
 * secret-adjacent contract as `ENABLE_OPTION_COST_GATE_LIVE_ENFORCE`, which
 * must ALSO be armed for any live cost gating to run at all); demo reads the
 * demo-flags env, giving a shadow-arm path that cannot touch real money.
 */
export const OPTION_NET_EDGE_BAR_FLAG = 'ENABLE_OPTION_COST_BAR_NET_EDGE';

// Operator-tunable knobs (QuantTrader pre-registers the live values; each falls
// back to the shipped placeholder so an unset/malformed env stays total).
//
//  - K: the cost/edge multiple. Block when costR > k·edgeR, i.e. k=1.0 demands
//    modeled edge at least covers expected round-trip cost; k=0.5 demands edge
//    at 2× cost. LOWER k = TIGHTER bar.
//  - FEES_PER_CONTRACT_RT: dollars per contract round trip. Default 0.229 =
//    $0.1145/contract/leg × 2 (MEASURED, TRA-2810).
//  - ABS_COST_FRAC_CEILING: block regardless of edge when round-trip cost
//    exceeds this fraction of gross premium (mark). The deep-cheap backstop.
//  - STRUCTURES: CSV of structures the net-edge form governs. Default
//    `single_leg_otm` — the sleeve TRA-3271 diagnosed; other sleeves keep the
//    flat bar until QuantTrader extends the list.
export const OPTION_NET_EDGE_K_VAR = 'OPTION_NET_EDGE_K';
export const OPTION_NET_EDGE_FEES_PER_CONTRACT_RT_VAR = 'OPTION_NET_EDGE_FEES_PER_CONTRACT_RT';
export const OPTION_NET_EDGE_ABS_COST_FRAC_CEILING_VAR = 'OPTION_NET_EDGE_ABS_COST_FRAC_CEILING';
export const OPTION_NET_EDGE_STRUCTURES_VAR = 'OPTION_NET_EDGE_STRUCTURES';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** A parsed finite float in [min, max], or undefined when unset/invalid. */
function parseBoundedFloat(raw: string | undefined, min: number, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

// ── TRA-3483 — the RECORDER half: `k` is a RATIO and only the denominator ships ──
//
// QuantTrader read the deployed surface on 2026-08-13 and found `k` UNIDENTIFIABLE
// from any published instrument. `admit ⟺ costR ≤ k · modeledGrossR`. The
// expectancy table publishes `modeledGrossR` per cell; `live-enforce-gates`
// publishes the shortfall against `barR` and names the cell. **Nothing anywhere
// emits `costR`** — and inside a cell every row shares the SAME `modeledGrossR`
// (the cell lower bound), so `costR` is the ONLY axis `k` can discriminate on.
// Pre-registering a `k` against `byReason` is unfalsifiable by construction.
//
// So the numerator is published per decision, and a counterfactual sweep over
// candidate `k` is folded from the SAME recorded rows. This is instrumentation,
// NOT an arm: `ENABLE_OPTION_COST_BAR_NET_EDGE` stays `false`, the flat form keeps
// deciding, and the sweep never touches a verdict. TRA-3272 item 5 (no unilateral
// arming) is intact — the recorder is precisely what lets someone else pick `k`
// from evidence instead of from a prior.

/**
 * The cost side of the net-edge form, decomposed — computed for EVERY cost_bar
 * decision (admits included) regardless of which form is armed.
 *
 * Extracted from {@link netEdgeBarVerdict} rather than re-derived beside it: a
 * recorder that computes its own copy of the arithmetic is a recorder that can
 * silently measure a different number than the gate would use, which is the whole
 * failure this ticket exists to close.
 */
export interface NetEdgeCostBreakdown {
  /** Full taker spread cross, this candidate's own quote (per share). */
  spreadPerShare: number;
  /** Fees per share = feesPerContractRoundTrip / 100. Constant across candidates. */
  feesPerShare: number;
  /** spreadPerShare + feesPerShare. */
  costPerShare: number;
  /** The at-risk basis the cost is expressed in (`mark − stop`, else 0.25·mark). */
  riskPerShare: number;
  /** costPerShare / riskPerShare — the NUMERATOR of the `k` comparison, in `R_gate`. */
  costR: number;
  /** The spread-cross term alone, same R unit. Sums with feeR to costR. */
  spreadR: number;
  /** The commission/fee term alone, same R unit. */
  feeR: number;
  /** costPerShare / mark — the fraction {@link NetEdgeBarConfig.absCostFracCeiling} tests. */
  costFracOfPremium: number;
}

/**
 * The per-candidate cost ingredients, or `null` when the quote is unusable
 * (non-finite / inverted / non-positive mark) — the same fail-closed predicate
 * {@link netEdgeBarVerdict} blocks on. `null` means "cost UNKNOWN for this row",
 * which the ledger must publish as a missing sample, never as a zero.
 */
export function netEdgeCostBreakdown(
  inputs: { mark: number; bid: number | undefined; ask: number | undefined; riskPerShare?: number },
  feesPerContractRoundTrip: number,
): NetEdgeCostBreakdown | null {
  const { mark, bid, ask } = inputs;
  const quoteUsable =
    typeof bid === 'number' && typeof ask === 'number'
    && Number.isFinite(bid) && Number.isFinite(ask)
    && Number.isFinite(mark) && mark > 0
    && bid >= 0 && ask >= bid;
  if (!quoteUsable) return null;

  const riskPerShare =
    typeof inputs.riskPerShare === 'number' && Number.isFinite(inputs.riskPerShare) && inputs.riskPerShare > 0
      ? inputs.riskPerShare
      : mark * 0.25;
  const spreadPerShare = ask - bid;
  const feesPerShare = feesPerContractRoundTrip / 100;
  const costPerShare = spreadPerShare + feesPerShare;
  return {
    spreadPerShare,
    feesPerShare,
    costPerShare,
    riskPerShare,
    costR: costPerShare / riskPerShare,
    spreadR: spreadPerShare / riskPerShare,
    feeR: feesPerShare / riskPerShare,
    costFracOfPremium: costPerShare / mark,
  };
}

/**
 * The `k` grid TRA-3481 pre-registers against. Fixed in code rather than
 * env-resolved: a sweep whose grid can move is a sweep whose published row set is
 * not reproducible, and this exists to make a decision auditable after the fact.
 * `0.5876` is QuantTrader's; the rest bracket it.
 */
export const NET_EDGE_SHADOW_K_SWEEP: readonly number[] = [
  0.40, 0.45, 0.50, 0.5876, 0.65, 0.75, 1.00, 1.25,
];

/** The recorded per-decision facts a counterfactual `k` verdict needs. */
export interface NetEdgeShadowSample {
  costR: number;
  costFracOfPremium: number;
  /** The modeled gross edge at decision time; `null` ⇒ the edge was unknown. */
  grossR: number | null;
}

/**
 * Would the net-edge form at this `k` have ADMITTED this recorded decision?
 *
 * Replays {@link netEdgeBarVerdict}'s admit path in the same order: the absolute
 * ceiling is `k`-independent and blocks first, an unknown edge fails closed, and
 * only then does the ratio decide. Rows whose quote was unusable never produce a
 * sample at all (see {@link netEdgeCostBreakdown}) — under the real form those are
 * `net_edge_quote_unusable` blocks, so the ledger counts them as blocked-at-every-k
 * rather than dropping them from the denominator.
 */
export function netEdgeShadowAdmits(sample: NetEdgeShadowSample, k: number, absCostFracCeiling: number): boolean {
  if (!Number.isFinite(sample.costR) || !Number.isFinite(sample.costFracOfPremium)) return false;
  if (sample.costFracOfPremium > absCostFracCeiling) return false;
  if (sample.grossR === null || !Number.isFinite(sample.grossR)) return false;
  return sample.costR <= k * sample.grossR;
}

/** Resolved, fully-defaulted net-edge bar configuration. Pure — no env access. */
export interface NetEdgeBarConfig {
  /** {@link OPTION_NET_EDGE_BAR_FLAG} resolved. */
  enabled: boolean;
  /** Block when costR > k · modeledGrossR. */
  k: number;
  /** Dollars per contract, round trip (TRA-2810: 0.229). */
  feesPerContractRoundTrip: number;
  /** Block regardless of edge when cost/premium exceeds this fraction. */
  absCostFracCeiling: number;
  /** Lower-cased structures the net-edge form governs; others keep the flat bar. */
  structures: string[];
}

/**
 * Shipped placeholders. `k: 1.0` (edge must cover expected cost),
 * `absCostFracCeiling: 0.5` (a contract that pays half its own premium back to
 * the market round trip is uneconomic at any modeled edge). PLACEHOLDERS ONLY —
 * QuantTrader pre-registers the authoritative values from the TRA-3216
 * reason-split tape before any arming (TRA-3272 item 4). The fee default is
 * not a placeholder: it is the TRA-2810 measurement.
 */
export const DEFAULT_NET_EDGE_BAR_CONFIG: Omit<NetEdgeBarConfig, 'enabled'> = {
  k: 1.0,
  feesPerContractRoundTrip: 0.229,
  absCostFracCeiling: 0.5,
  structures: ['single_leg_otm'],
};

/** True iff `structure` is governed by the net-edge form under `config`. */
export function isNetEdgeGovernedStructure(structure: string, config: NetEdgeBarConfig): boolean {
  return config.enabled && config.structures.includes(structure.trim().toLowerCase());
}

/** The per-candidate ingredients of a net-edge verdict. All per-share dollars. */
export interface NetEdgeBarInputs {
  /** Option premium mid (per share) — the candidate's `mark`. */
  mark: number;
  /** The candidate's OWN quote at decision time (per share). */
  bid: number | undefined;
  ask: number | undefined;
  /**
   * The trade's at-risk basis per share (`mark − stop`). Optional — when the
   * open site carries no stop (directional) the 2:1 bracket's 0.25·mark is
   * assumed, matching the estimator's R definition.
   */
  riskPerShare?: number;
  /** The modeled GROSS edge in R ({@link estimateModeledGrossR} output). */
  modeledGrossR: number;
}

/**
 * Bounded, foldable classification of a net-edge BLOCK — the `reasonCode` the
 * live-enforce ledger folds on (`byReason`), sibling to the flat form's
 * `shortfall_*` buckets. `null` ⇔ admitted.
 */
export type NetEdgeReasonCode =
  | 'net_edge_quote_unusable'
  | 'net_edge_abs_ceiling'
  | 'net_edge_edge_unknown'
  | 'net_edge_cost_exceeds_k_edge';

/** The admit/reject verdict for one candidate under the net-edge form. */
export interface NetEdgeBarVerdict {
  admit: boolean;
  /** Expected round-trip cost per share: (ask − bid) + fees/100. NaN when quote unusable. */
  costPerShare: number;
  /** costPerShare / riskPerShare — the cost in the trade's own R units. */
  costR: number;
  /** costPerShare / mark — the fraction the ceiling tests. */
  costFracOfPremium: number;
  /**
   * The EQUIVALENT flat bar this candidate faced: admit needed
   * `modeledGrossR ≥ costR / k`. Recorded so the ledger's per-decision fold
   * still has a scale even though the bar now moves per candidate.
   */
  requiredEdgeR: number;
  /** Bounded classification for the ledger fold; null when admitted. */
  reasonCode: NetEdgeReasonCode | null;
  /** Human-readable rejection reason (empty when admitted). */
  reason: string;
}

/**
 * The net-edge admission decision. Pure — no env, no I/O. FAIL-CLOSED: an
 * unusable quote (non-finite / inverted / non-positive mark) or an unknown
 * modeled edge blocks; we never admit on an unknown cost or edge.
 */
export function netEdgeBarVerdict(
  inputs: NetEdgeBarInputs,
  config: Omit<NetEdgeBarConfig, 'enabled' | 'structures'>,
): NetEdgeBarVerdict {
  const { mark, bid, ask, modeledGrossR } = inputs;
  // TRA-3483 — ONE arithmetic, shared with the recorder. See netEdgeCostBreakdown.
  const cost = netEdgeCostBreakdown(
    { mark, bid, ask, riskPerShare: inputs.riskPerShare },
    config.feesPerContractRoundTrip,
  );
  if (cost === null) {
    return {
      admit: false,
      costPerShare: Number.NaN,
      costR: Number.NaN,
      costFracOfPremium: Number.NaN,
      requiredEdgeR: Number.NaN,
      reasonCode: 'net_edge_quote_unusable',
      reason: `net-edge bar: quote unusable (bid ${bid ?? 'n/a'} / ask ${ask ?? 'n/a'} / mark ${mark}) — cost unknown, fail closed`,
    };
  }

  const { costPerShare, costR, costFracOfPremium } = cost;
  const requiredEdgeR = costR / config.k;

  if (costFracOfPremium > config.absCostFracCeiling) {
    return {
      admit: false,
      costPerShare,
      costR,
      costFracOfPremium,
      requiredEdgeR,
      reasonCode: 'net_edge_abs_ceiling',
      reason: `net-edge bar: round-trip cost $${costPerShare.toFixed(4)}/share is ${(costFracOfPremium * 100).toFixed(1)}% of premium (> ${(config.absCostFracCeiling * 100).toFixed(0)}% absolute ceiling) — structurally uneconomic at any modeled edge`,
    };
  }

  if (!Number.isFinite(modeledGrossR)) {
    return {
      admit: false,
      costPerShare,
      costR,
      costFracOfPremium,
      requiredEdgeR,
      reasonCode: 'net_edge_edge_unknown',
      reason: 'net-edge bar: modeled gross R non-finite — edge unknown, fail closed (estimator defect, not a bar-tuning problem)',
    };
  }

  const admit = costR <= config.k * modeledGrossR;
  return {
    admit,
    costPerShare,
    costR,
    costFracOfPremium,
    requiredEdgeR,
    reasonCode: admit ? null : 'net_edge_cost_exceeds_k_edge',
    reason: admit
      ? ''
      : `net-edge bar: expected round-trip cost ${costR.toFixed(3)}R > k(${config.k}) × modeled edge ${modeledGrossR.toFixed(3)}R (needed ≥ ${requiredEdgeR.toFixed(3)}R)`,
  };
}

/**
 * Resolve the net-edge bar config from env, falling back field-by-field to
 * {@link DEFAULT_NET_EDGE_BAR_CONFIG}. Bounds are defensive: k in [0.01, 100],
 * fees in [0, 10] dollars/contract, ceiling in (0, 1] (a 0 ceiling would block
 * everything and can only be a typo — it falls back). An empty/whitespace
 * STRUCTURES value falls back to the default list; only an explicit CSV
 * narrows or widens it.
 */
export function resolveNetEdgeBarConfig(env: NodeJS.ProcessEnv = process.env): NetEdgeBarConfig {
  const k = parseBoundedFloat(env[OPTION_NET_EDGE_K_VAR], 0.01, 100);
  const fees = parseBoundedFloat(env[OPTION_NET_EDGE_FEES_PER_CONTRACT_RT_VAR], 0, 10);
  const ceilingRaw = parseBoundedFloat(env[OPTION_NET_EDGE_ABS_COST_FRAC_CEILING_VAR], 0, 1);
  const ceiling = ceilingRaw !== undefined && ceilingRaw > 0 ? ceilingRaw : undefined;
  const structuresRaw = env[OPTION_NET_EDGE_STRUCTURES_VAR];
  const structures =
    typeof structuresRaw === 'string'
      ? structuresRaw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
      : [];
  return {
    enabled: flagOn(env[OPTION_NET_EDGE_BAR_FLAG]),
    k: k ?? DEFAULT_NET_EDGE_BAR_CONFIG.k,
    feesPerContractRoundTrip: fees ?? DEFAULT_NET_EDGE_BAR_CONFIG.feesPerContractRoundTrip,
    absCostFracCeiling: ceiling ?? DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling,
    structures: structures.length > 0 ? structures : [...DEFAULT_NET_EDGE_BAR_CONFIG.structures],
  };
}

/** The arm-block description for the health route — the CONSTANT half of the form. */
export interface NetEdgeBarDescription {
  flag: string;
  enabled: boolean;
  k: number;
  feesPerContractRoundTrip: number;
  absCostFracCeiling: number;
  structures: string[];
  /** RAW env values so a typo'd knob (which falls back) is visible, not inferred. */
  raw: {
    k: string | null;
    fees: string | null;
    absCostFracCeiling: string | null;
    structures: string | null;
  };
}

/** Describe the resolved net-edge config for `/api/health/live-enforce-gates`. Pure over env. */
export function describeNetEdgeBar(env: NodeJS.ProcessEnv = process.env): NetEdgeBarDescription {
  const config = resolveNetEdgeBarConfig(env);
  return {
    flag: OPTION_NET_EDGE_BAR_FLAG,
    enabled: config.enabled,
    k: config.k,
    feesPerContractRoundTrip: config.feesPerContractRoundTrip,
    absCostFracCeiling: config.absCostFracCeiling,
    structures: config.structures,
    raw: {
      k: env[OPTION_NET_EDGE_K_VAR] ?? null,
      fees: env[OPTION_NET_EDGE_FEES_PER_CONTRACT_RT_VAR] ?? null,
      absCostFracCeiling: env[OPTION_NET_EDGE_ABS_COST_FRAC_CEILING_VAR] ?? null,
      structures: env[OPTION_NET_EDGE_STRUCTURES_VAR] ?? null,
    },
  };
}
