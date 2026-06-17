// TRA-913 (TRA-908 Phase C) — Advisory -> capital bridge (gated, PAPER only).
//
// Wires a vetted Phase-A selector / advisory idea (a `ShadowOptionSignal` plus a
// risk-panel verdict) into the Phase-B paper executor
// (`PaperOptionsAccount.openDefinedRiskSpread`), but ONLY when:
//
//   1. the bridge is flag-enabled (paper, opt-in — never on by default),
//   2. the idea is APPROVED (a REVISE/VETO verdict is never routed to capital),
//   3. the WHOLE book's post-trade portfolio Greeks / concentration stay inside
//      their bands (`evaluatePortfolioGreeksGate`), evaluated on the actually-
//      sized lot count, AND
//   4. the executor's own per-trade gate + sizing admit the structure.
//
// On a successful paper open the accrual is recorded in the promotion store so
// the shadow -> paper -> live pipeline gains a Stage-2 source for options
// strategies. LIVE routing is explicitly out of scope (Phase E / TRA-382).
//
// Greeks of the proposed structure are derived from the signal's legs with the
// SAME Black-Scholes primitives the live portfolio-Greeks rollup uses: net delta
// from the per-leg deltas, net vega solved from each leg's mark. Short-premium
// structures (credit spreads / condors) come out net short vega, which is
// exactly what the vega cap is there to bound.

import { blackScholesGreeks, bsImpliedVolatility } from '@trading-app/engine';
import type { ShadowOptionSignal } from '@trading-app/engine';
import {
  evaluatePortfolioGreeksGate,
  DEFAULT_PORTFOLIO_GREEKS_GATE,
  type PortfolioGreeksGateConfig,
} from '@trading-app/engine';
import type { OptionPosition } from '@trading-app/shared';
import { PaperOptionsAccount } from './options-account.js';
import type { SpotResolver } from './reports/portfolio-greeks.js';
import { recordPaperAccrual } from './promotion-store.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'advisory-capital-bridge' });

const DEFAULT_RISK_FREE_RATE = 0.045;

/** Verdict from the advisory risk panel; only APPROVE is ever routed to capital. */
export type AdvisoryVerdict = 'APPROVE' | 'REVISE' | 'VETO';

/** A vetted idea presented to the bridge for possible paper placement. */
export interface VettedIdea {
  /** The Phase-A structured signal (legs/strikes/marks/sizing). */
  signal: ShadowOptionSignal;
  /** Risk-panel verdict; the bridge routes ONLY when this is 'APPROVE'. */
  verdict: AdvisoryVerdict;
  /**
   * Promotion-store strategy id the paper accrual is booked under. Defaults to
   * `option:<strategy>` (e.g. `option:bull_put_spread`) when omitted.
   */
  strategyId?: string;
}

export interface BridgeConfig {
  /** Master flag — paper bridge is opt-in and never routes when false. */
  enabled: boolean;
  /** Portfolio-Greeks gate thresholds. Defaults to the Phase-C v1 defaults. */
  gate?: PortfolioGreeksGateConfig;
  /** Annualized risk-free rate for the per-leg vega solve. Defaults to 0.045. */
  riskFreeRate?: number;
}

export type BridgeOutcome =
  | { status: 'disabled' }
  | { status: 'not_approved'; verdict: AdvisoryVerdict }
  | { status: 'no_spot'; symbol: string }
  | { status: 'rejected_by_gate'; reason: string }
  | { status: 'execution_rejected'; reason: string }
  | { status: 'placed'; strategyId: string; position: OptionPosition };

/** Default promotion-store strategy id for an option structure. */
export function defaultStrategyId(signal: ShadowOptionSignal): string {
  return `option:${signal.strategy}`;
}

/** Per-leg sign: a sold leg contributes the negative of the contract's Greeks. */
function legSign(action: 'buy' | 'sell'): number {
  return action === 'buy' ? 1 : -1;
}

interface PerLotGreeks {
  /** Net delta of one combo lot, in equivalent shares (signed). */
  deltaShares: number;
  /** Net vega of one combo lot, in $/vol-point (signed; <0 = short vega). */
  vegaDollars: number;
}

/**
 * Net delta + vega of ONE combo lot, derived from the signal's legs. Delta is
 * taken straight from the per-leg deltas (×100 shares/contract); vega is solved
 * per leg from its mark against the entry spot (matching the live rollup). A leg
 * whose IV won't solve contributes 0 vega — the same conservative skip the
 * portfolio-Greeks rollup makes — rather than fabricating an exposure.
 */
export function perLotStructureGreeks(
  signal: ShadowOptionSignal,
  spot: number,
  riskFreeRate: number,
  daysToExpiry: number,
): PerLotGreeks {
  const T = daysToExpiry / 365;
  let deltaShares = 0;
  let vegaDollars = 0;
  for (const leg of signal.legs) {
    const sign = legSign(leg.action);
    if (Number.isFinite(leg.delta)) deltaShares += sign * leg.delta * 100;
    if (
      spot > 0 &&
      Number.isFinite(T) &&
      T > 0 &&
      Number.isFinite(leg.strike) &&
      leg.strike > 0 &&
      Number.isFinite(leg.mark) &&
      leg.mark > 0
    ) {
      const iv = bsImpliedVolatility({
        spot,
        strike: leg.strike,
        timeToExpiryYears: T,
        riskFreeRate,
        optionType: leg.optionType,
        marketPrice: leg.mark,
      });
      if (iv != null && Number.isFinite(iv) && iv > 0) {
        const g = blackScholesGreeks({
          spot,
          strike: leg.strike,
          timeToExpiryYears: T,
          riskFreeRate,
          volatility: iv,
          optionType: leg.optionType,
        });
        // Match computePortfolioGreeks' single-contract vega convention
        // (`g.vega` per +1 vol-point per contract).
        vegaDollars += sign * g.vega;
      }
    }
  }
  return { deltaShares, vegaDollars };
}

/**
 * Map a `ShadowOptionSignal` to the executor's defined-risk payoff params
 * (per 1-lot, USD). `maxLossPerSpread` already carries the ×100 multiplier.
 */
function toSpreadParams(signal: ShadowOptionSignal, spot: number, strategyId: string) {
  const maxLossUsd = signal.sizingIntent.maxLossPerSpread;
  const credit = signal.netCredit;
  const debit = signal.netDebit;
  // + credit / - debit per 1-lot, USD.
  const netUsd = credit != null ? credit * 100 : -((debit ?? 0) * 100);
  // Credit structures cap profit at the credit; debit structures at width-debit.
  const maxProfitUsd =
    credit != null ? credit * 100 : Math.max(0, (signal.widthPoints - (debit ?? 0)) * 100);
  // The executor's `OptionLeg` (shared) carries a per-leg `expiration`; the
  // selector's leg omits it (the structure shares one expiration), so stamp the
  // signal's expiration onto each leg as the executor expects.
  const legs = signal.legs.map((l) => ({
    action: l.action,
    optionType: l.optionType,
    strike: l.strike,
    expiration: signal.expiration,
  }));
  return {
    symbol: signal.symbol,
    strategy: signal.strategy,
    legs,
    netUsd,
    maxLossUsd,
    maxProfitUsd,
    breakevens: [] as number[],
    spot,
    signalId: strategyId,
  };
}

/**
 * Route one vetted idea to the paper executor under the Phase-C gates. Returns a
 * structured outcome describing exactly which gate (if any) refused it. Never
 * touches live capital. On a placed trade, records the accrual in the promotion
 * store (creating the strategy's promotion record if absent).
 */
export async function routeVettedIdeaToPaper(
  idea: VettedIdea,
  account: PaperOptionsAccount,
  resolveSpot: SpotResolver,
  config: BridgeConfig,
  now: number = Date.now(),
): Promise<BridgeOutcome> {
  if (!config.enabled) return { status: 'disabled' };
  if (idea.verdict !== 'APPROVE') return { status: 'not_approved', verdict: idea.verdict };

  const signal = idea.signal;
  const spot = resolveSpot(signal.symbol);
  if (spot == null || !Number.isFinite(spot) || spot <= 0) {
    return { status: 'no_spot', symbol: signal.symbol };
  }

  const gateCfg = config.gate ?? DEFAULT_PORTFOLIO_GREEKS_GATE;
  const riskFreeRate = config.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const strategyId = idea.strategyId ?? defaultStrategyId(signal);

  // Current open-book exposure (paper/demo). Combos contribute capital-at-risk
  // notional but no Greeks in the rollup, so the book's netDelta/netVega reflect
  // single-leg legs; the proposed structure's Greeks are added on top.
  const book = account.getPortfolioGreeks('demo', resolveSpot, { now, riskFreeRate });
  const nameKey = signal.symbol.toUpperCase();
  const currentNameNotional = book.byName.find((b) => b.key === nameKey)?.notional ?? 0;

  const perLot = perLotStructureGreeks(signal, spot, riskFreeRate, signal.daysToExpiry);

  // Capture the portfolio-gate reject reason out of the executor callback so the
  // bridge can distinguish a Greeks reject from a sizing/window/cash reject.
  let gateReason: string | null = null;
  const params = toSpreadParams(signal, spot, strategyId);

  const position = account.openDefinedRiskSpread(params, 'demo', ({ contracts, totalRiskUsd }) => {
    const verdict = evaluatePortfolioGreeksGate({
      currentNetDelta: book.netDelta,
      currentNetVega: book.netVega,
      currentBookNotional: book.netNotional,
      currentNameNotional,
      currentOpenPositions: book.positionsTotal,
      tradeNetDelta: perLot.deltaShares * contracts,
      tradeNetVega: perLot.vegaDollars * contracts,
      tradeMaxLossUsd: totalRiskUsd,
      tradeNotional: totalRiskUsd,
      config: gateCfg,
    });
    if (!verdict.allowed) {
      gateReason = verdict.reason;
      return { allowed: false, reason: verdict.reason };
    }
    return { allowed: true };
  });

  if (!position) {
    if (gateReason != null) {
      log.info('idea rejected by portfolio-Greeks gate', { strategyId, reason: gateReason });
      return { status: 'rejected_by_gate', reason: gateReason };
    }
    // openDefinedRiskSpread returned null for a non-portfolio reason: outside the
    // trading window, daily cap hit, dup structure, sub-floor DTE, mispriced, the
    // TRA-912 per-trade gate, or paper cash can't cover a lot.
    return {
      status: 'execution_rejected',
      reason: 'executor declined (window/daily-cap/dup/DTE/per-trade-gate/cash)',
    };
  }

  await recordPaperAccrual({
    strategyId,
    id: position.id,
    openedAtMs: position.openedAt,
    entryRiskUsd: position.maxLossUsd ?? params.maxLossUsd,
    note: signal.strategy,
  });

  log.info('routed vetted idea to paper executor', {
    strategyId,
    symbol: signal.symbol,
    contracts: position.contracts,
    maxLossUsd: position.maxLossUsd,
  });
  return { status: 'placed', strategyId, position };
}
