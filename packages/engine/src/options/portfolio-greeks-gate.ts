/**
 * TRA-913 (TRA-908 Phase C) — portfolio-level pre-trade gate for the
 * advisory -> capital bridge. Pure and total: the current open-book exposure
 * plus a single proposed structure's incremental contribution map to one
 * allow/reject verdict with no side effects, so this is the explicitly-tested
 * artifact the board acceptance pins down ("vetted ideas route to the paper
 * executor ONLY when all Greeks/loss gates pass; rejected-by-gate paths
 * covered by tests").
 *
 * This sits ABOVE the TRA-912 per-trade {@link evaluateMultiLegPreTrade} gate
 * (which caps a single combo's max loss at 1% of equity + buying power). Phase C
 * adds the *portfolio* guards that a single-trade gate can't see:
 *
 *  1. Net-delta band — the post-trade net delta (equivalent shares) must stay
 *     inside `+/- maxAbsNetDelta`. Keeps the book from drifting into a large
 *     one-sided directional bet as accepted ideas stack up.
 *  2. Net-vega cap (bounds SHORT vega) — the post-trade |net vega| ($/vol-pt)
 *     must stay <= `maxAbsNetVega`. Short-premium structures (credit spreads,
 *     condors) are net short vega; without a cap a run of them leaves the book
 *     dangerously short volatility. The cap is two-sided so a stack of long-vega
 *     debit spreads is bounded too.
 *  3. Per-trade max loss — the structure's own capital-at-risk must not exceed
 *     `maxTradeLossUsd` (an absolute USD ceiling, complementing the TRA-912
 *     %-of-equity cap).
 *  4. Concentration cap — the post-trade premium/risk notional in the
 *     candidate's underlying must not exceed `maxNameConcentrationPct` of the
 *     post-trade book notional. Stops one name from dominating the book.
 *  5. Position cap — the count of open structures after this open must not
 *     exceed `maxOpenPositions`.
 *
 * The gate never sizes anything — it only accepts or rejects. ASCII-only reject
 * reasons so they are safe to surface through the comment/log API.
 */

/** Tunable portfolio-Greeks gate thresholds. Paper-only Phase C defaults. */
export interface PortfolioGreeksGateConfig {
  /** Max |post-trade net delta|, in equivalent shares of underlying. */
  maxAbsNetDelta: number;
  /** Max |post-trade net vega|, in $ per +1 IV vol-point (bounds short vega). */
  maxAbsNetVega: number;
  /** Absolute per-trade capital-at-risk ceiling, USD. */
  maxTradeLossUsd: number;
  /** Max single-name notional as a fraction (0-1) of post-trade book notional. */
  maxNameConcentrationPct: number;
  /** Max number of open structures permitted after this open. */
  maxOpenPositions: number;
}

/**
 * TRA-913 v1 defaults. Sized for the demo paper book (~$100k equity): a roughly
 * delta-light, vega-bounded book that no single underlying can dominate.
 */
export const DEFAULT_PORTFOLIO_GREEKS_GATE: PortfolioGreeksGateConfig = {
  maxAbsNetDelta: 500, // ~5 ES-equivalent deltas of net directional drift
  maxAbsNetVega: 750, // $750 / vol-point either side
  maxTradeLossUsd: 2_000,
  maxNameConcentrationPct: 0.35,
  maxOpenPositions: 12,
};

export interface PortfolioGreeksGateInput {
  /** Current netted delta (equivalent shares) of the OPEN book, pre-trade. */
  currentNetDelta: number;
  /** Current netted vega ($/vol-pt) of the OPEN book, pre-trade. */
  currentNetVega: number;
  /** Total premium/risk notional of the OPEN book, USD, pre-trade. */
  currentBookNotional: number;
  /** Notional already held in the candidate's underlying, USD, pre-trade. */
  currentNameNotional: number;
  /** Count of open structures, pre-trade. */
  currentOpenPositions: number;
  /** Proposed structure's incremental net delta (equivalent shares, signed). */
  tradeNetDelta: number;
  /** Proposed structure's incremental net vega ($/vol-pt, signed; <0 = short vega). */
  tradeNetVega: number;
  /** Proposed structure's capital-at-risk (defined-risk max loss), USD. */
  tradeMaxLossUsd: number;
  /** Premium/risk notional the proposed structure adds to the book + name, USD. */
  tradeNotional: number;
  /** Gate thresholds. Defaults to {@link DEFAULT_PORTFOLIO_GREEKS_GATE}. */
  config?: PortfolioGreeksGateConfig;
}

export type PortfolioGreeksGateVerdict =
  | {
      allowed: true;
      /** Net delta the book would carry after the open (equivalent shares). */
      postNetDelta: number;
      /** Net vega the book would carry after the open ($/vol-pt). */
      postNetVega: number;
      /** Candidate-name notional as a fraction (0-1) of the post-trade book. */
      postNameConcentrationPct: number;
      /** Count of open structures after the open. */
      postOpenPositions: number;
    }
  | { allowed: false; reason: string };

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * TRA-913 — evaluate the portfolio-Greeks pre-trade gate. Returns the projected
 * post-trade exposures on accept, or the first failing reason on reject.
 * Checks run in a deterministic order (input validity, max-loss, delta band,
 * vega cap, concentration, position count) so the surfaced reason is stable.
 */
export function evaluatePortfolioGreeksGate(
  input: PortfolioGreeksGateInput,
): PortfolioGreeksGateVerdict {
  const cfg = input.config ?? DEFAULT_PORTFOLIO_GREEKS_GATE;

  // --- input validity -------------------------------------------------------
  const finite = [
    input.currentNetDelta,
    input.currentNetVega,
    input.currentBookNotional,
    input.currentNameNotional,
    input.tradeNetDelta,
    input.tradeNetVega,
    input.tradeMaxLossUsd,
    input.tradeNotional,
  ];
  if (finite.some((v) => !Number.isFinite(v))) {
    return { allowed: false, reason: 'non-finite Greeks/notional input' };
  }
  if (!Number.isInteger(input.currentOpenPositions) || input.currentOpenPositions < 0) {
    return { allowed: false, reason: 'current open-position count must be a non-negative integer' };
  }
  if (!Number.isFinite(input.tradeMaxLossUsd) || input.tradeMaxLossUsd <= 0) {
    return { allowed: false, reason: 'trade max loss must be a positive number' };
  }
  if (
    !Number.isFinite(cfg.maxNameConcentrationPct) ||
    cfg.maxNameConcentrationPct <= 0 ||
    cfg.maxNameConcentrationPct > 1
  ) {
    return { allowed: false, reason: 'concentration cap must be a fraction in (0, 1]' };
  }

  // --- 3. per-trade max loss (absolute USD ceiling) -------------------------
  if (input.tradeMaxLossUsd > cfg.maxTradeLossUsd + 1e-9) {
    return {
      allowed: false,
      reason:
        `trade max loss $${r2(input.tradeMaxLossUsd).toFixed(2)} ` +
        `exceeds per-trade cap $${cfg.maxTradeLossUsd.toFixed(2)}`,
    };
  }

  // --- 1. net-delta band ----------------------------------------------------
  const postNetDelta = input.currentNetDelta + input.tradeNetDelta;
  if (Math.abs(postNetDelta) > cfg.maxAbsNetDelta + 1e-9) {
    return {
      allowed: false,
      reason:
        `post-trade net delta ${r2(postNetDelta).toFixed(2)} ` +
        `outside +/-${cfg.maxAbsNetDelta} share band`,
    };
  }

  // --- 2. net-vega cap (bounds short vega) ----------------------------------
  const postNetVega = input.currentNetVega + input.tradeNetVega;
  if (Math.abs(postNetVega) > cfg.maxAbsNetVega + 1e-9) {
    return {
      allowed: false,
      reason:
        `post-trade net vega $${r2(postNetVega).toFixed(2)}/vol-pt ` +
        `exceeds +/-$${cfg.maxAbsNetVega.toFixed(2)} cap`,
    };
  }

  // --- 4. concentration cap -------------------------------------------------
  // Concentration is a multi-position property: the FIRST trade onto an empty
  // book is trivially 100% of one name and can't meaningfully "concentrate"
  // (there is nothing to diversify against yet), so it is exempt. Once the book
  // already holds notional in OTHER names, adding a trade that would push one
  // name past the cap of the resulting book is blocked. Per-trade max-loss +
  // position caps bound that first trade independently.
  const postBookNotional = input.currentBookNotional + input.tradeNotional;
  const postNameNotional = input.currentNameNotional + input.tradeNotional;
  const postNameConcentrationPct = postBookNotional > 0 ? postNameNotional / postBookNotional : 0;
  const otherNameNotional = input.currentBookNotional - input.currentNameNotional;
  if (otherNameNotional > 1e-9 && postNameConcentrationPct > cfg.maxNameConcentrationPct + 1e-9) {
    return {
      allowed: false,
      reason:
        `post-trade name concentration ${(postNameConcentrationPct * 100).toFixed(1)}% ` +
        `exceeds ${(cfg.maxNameConcentrationPct * 100).toFixed(1)}% cap`,
    };
  }

  // --- 5. position cap ------------------------------------------------------
  const postOpenPositions = input.currentOpenPositions + 1;
  if (postOpenPositions > cfg.maxOpenPositions) {
    return {
      allowed: false,
      reason: `open positions ${postOpenPositions} exceeds cap ${cfg.maxOpenPositions}`,
    };
  }

  return {
    allowed: true,
    postNetDelta,
    postNetVega,
    postNameConcentrationPct,
    postOpenPositions,
  };
}
