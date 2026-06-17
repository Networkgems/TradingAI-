import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  type TradierMultilegLeg,
  type TradierMultilegPricing,
  type TradierMultilegSide,
  TRADIER_REJECTED_STATUSES,
  roundToCent,
  underlyingFromOcc,
} from '@trading-app/engine';
import { SMART_BUY_WALK_FRACTIONS } from './tradier-smart-open.js';
import { logger } from './observability/index.js';

const mlLog = logger.child({ module: 'tradier-smart-multileg' });

/**
 * TRA-912 (TRA-908 Phase B) — net-price limit walk for a defined-risk
 * MULTI-LEG options combo (vertical spread, iron condor, …). This is the
 * multi-leg counterpart to {@link submitSmartBuyToOpen}: instead of walking a
 * single contract's limit from mid toward the ask, it walks the STRUCTURE's net
 * (debit or credit) from the mid toward the price at which we cross the market
 * on every leg, re-pricing the whole combo as one Tradier `class=multileg`
 * ticket on each attempt.
 *
 * Why net rather than per-leg: legging into a spread one contract at a time
 * leaves a naked leg live between fills (unbounded risk on the short side). A
 * single multileg ticket fills (or rejects) atomically at a net price, so the
 * defined-risk geometry is preserved no matter which way the underlying ticks
 * mid-fill.
 *
 * Paper-only in Phase B — the only callers are the paper book and tests; no
 * live-capital path invokes this (Phase C / TRA-382).
 */

/** A leg of the structure, described by its OPENING action. */
export interface SmartMultiLegInputLeg {
  /** The action used to OPEN this leg: `buy` (long) or `sell` (short). */
  action: 'buy' | 'sell';
  /** OCC option symbol. */
  optionSymbol: string;
}

export type SmartMultiLegOutcome =
  | {
      status: 'filled';
      orderId: number;
      /** Broker net fill per share (signed: + = net debit paid, - = net credit received). */
      avgNetPrice: number;
      /** Signed net limit that produced the fill. */
      netLimit: number;
      /** 0-indexed walk step (0 = mid, 4 = full cross). */
      walk: number;
      /** Signed structure mid at quote time. */
      mid: number;
    }
  | { status: 'rejected'; orderId?: number; reason: string }
  | { status: 'walk_exhausted'; reason: string; lastNetLimit: number }
  | { status: 'no_quote'; reason: string };

export interface SmartMultiLegOptions {
  /** Wait window per attempt (defaults to 30s, matching smart-open). */
  timeoutMs?: number;
  /** Injectable for tests so we don't need real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Combo lots (multiplies every leg's quantity). Defaults to 1. */
  contracts?: number;
  /** Underlying symbol; defaults to the underlying parsed off the first leg's OCC. */
  underlying?: string;
}

type SmartMultiLegClient = Pick<
  TradierOptionsClient,
  'getOptionQuote' | 'submitMultilegOrder' | 'cancelOrder' | 'waitForOrderTerminalStatus'
>;

/**
 * TRA-912 — map an opening leg action to the Tradier `multileg` side for the
 * requested intent. Opening a defined-risk spread pairs a `buy_to_open` long
 * with a `sell_to_open` short; closing it flattens each leg with the opposite
 * `*_to_close` side.
 */
export function legSideFor(action: 'buy' | 'sell', intent: 'open' | 'close'): TradierMultilegSide {
  if (intent === 'open') return action === 'buy' ? 'buy_to_open' : 'sell_to_open';
  // Closing flattens: a long leg is sold to close, a short leg is bought to close.
  return action === 'buy' ? 'sell_to_close' : 'buy_to_close';
}

/**
 * TRA-912 — open or close a defined-risk combo with a net-price limit walk.
 *
 * Net-price model — each leg carries a cash sign for the intent: a leg we BUY
 * (pay) is +1, a leg we SELL (receive) is -1. The structure net at any per-leg
 * price `p(leg)` is `sum( sign(leg) * p(leg) )`. We compute:
 *  - `mid`  = net of every leg's midpoint (the fair value),
 *  - `cross` = net when we pay the ask on each buy leg and hit the bid on each
 *    sell leg (the worst, guaranteed-marketable net).
 * `cross >= mid` always, so the walk runs `mid -> cross` across
 * {@link SMART_BUY_WALK_FRACTIONS}. A positive net limit submits as a Tradier
 * `debit`, a negative one as a `credit`, ~0 as `even`. If the full cross still
 * doesn't fill we give up (`walk_exhausted`) rather than chase past the market.
 */
export async function submitSmartMultiLeg(
  client: SmartMultiLegClient,
  legs: readonly SmartMultiLegInputLeg[],
  intent: 'open' | 'close',
  options: SmartMultiLegOptions = {},
): Promise<SmartMultiLegOutcome> {
  if (!Array.isArray(legs) || legs.length < 2) {
    return { status: 'rejected', reason: 'multileg requires at least two legs' };
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const contracts = options.contracts ?? 1;
  const underlying = options.underlying ?? underlyingFromOcc(legs[0]!.optionSymbol);

  // Pull a fresh quote for every leg and collapse the structure into its
  // signed mid + cross nets. Any leg missing a usable two-sided quote aborts
  // the whole combo — we can't triangulate a fair net off a one-sided leg.
  let mid = 0;
  let cross = 0;
  const tradierLegs: TradierMultilegLeg[] = [];
  for (const leg of legs) {
    let quote: TradierOptionQuote | null = null;
    try {
      quote = await client.getOptionQuote(leg.optionSymbol);
    } catch (err: unknown) {
      return {
        status: 'no_quote',
        reason: `Tradier quote lookup failed for ${leg.optionSymbol}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const bid = usable(quote?.bid);
    const ask = usable(quote?.ask);
    if (bid <= 0 || ask <= 0 || ask < bid) {
      return {
        status: 'no_quote',
        reason: `No two-sided quote for ${leg.optionSymbol} — refusing to price combo on a dead leg.`,
      };
    }
    const sign = leg.action === 'buy' ? 1 : -1; // +1 = we pay, -1 = we receive
    const legMid = (bid + ask) / 2;
    mid += sign * legMid;
    // Worst marketable price: pay the ask on buys, hit the bid on sells.
    cross += sign === 1 ? ask : -bid;
    tradierLegs.push({
      optionSymbol: leg.optionSymbol,
      side: legSideFor(leg.action, intent),
      quantity: contracts,
    });
  }

  const concession = cross - mid; // >= 0 by construction
  let lastOrderId: number | undefined;
  let lastNetLimit = 0;
  for (let attempt = 0; attempt < SMART_BUY_WALK_FRACTIONS.length; attempt += 1) {
    const netLimit = roundToCent(netForAttempt(mid, concession, attempt));
    lastNetLimit = netLimit;
    const pricing = pricingFor(netLimit);

    let order;
    try {
      order = await client.submitMultilegOrder(underlying, tradierLegs, pricing);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        ...(lastOrderId !== undefined ? { orderId: lastOrderId } : {}),
      };
    }
    lastOrderId = order.id;
    const detail: TradierOrderDetail | null = await client.waitForOrderTerminalStatus(order.id, {
      timeoutMs,
      sleep,
    });
    const status = detail?.status ?? '';
    if (status === 'filled') {
      const avgFill = detail?.avg_fill_price;
      // Tradier reports the absolute net fill; restore our signed convention.
      const signedFill =
        typeof avgFill === 'number' && Number.isFinite(avgFill)
          ? (netLimit < 0 ? -Math.abs(avgFill) : Math.abs(avgFill))
          : netLimit;
      return {
        status: 'filled',
        orderId: order.id,
        avgNetPrice: signedFill,
        netLimit,
        walk: attempt,
        mid: roundToCent(mid),
      };
    }
    if (TRADIER_REJECTED_STATUSES.has(status)) {
      return {
        status: 'rejected',
        orderId: order.id,
        reason: detail?.reason_description?.trim() || status,
      };
    }
    // Still working after the wait window — cancel before re-pricing so we never
    // leave two live multileg tickets racing on the broker. Cancel failures are
    // swallowed (the order may have terminated between poll and cancel) but logged.
    try {
      await client.cancelOrder(order.id);
    } catch (err) {
      mlLog.warn('cancelOrder failed during smart-multileg walk', {
        orderId: order.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    status: 'walk_exhausted',
    reason: 'Tradier multileg net-limit walk to full cross exhausted',
    lastNetLimit,
  };
}

function usable(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * TRA-912 — signed net limit for the n-th walk step. Attempt 0 nudges 1 cent
 * off the mid toward the cross (capped at the full concession so a 1-tick combo
 * doesn't overshoot); later attempts interpolate mid -> cross by the shared
 * fraction schedule.
 */
function netForAttempt(mid: number, concession: number, attempt: number): number {
  if (attempt === 0) return mid + Math.min(0.01, Math.max(0, concession));
  const fraction = SMART_BUY_WALK_FRACTIONS[Math.min(attempt, SMART_BUY_WALK_FRACTIONS.length - 1)] ?? 1;
  return mid + concession * fraction;
}

/** TRA-912 — translate a signed net limit into a Tradier multileg pricing block. */
export function pricingFor(netLimit: number): TradierMultilegPricing {
  if (netLimit > 0.005) return { type: 'debit', price: netLimit };
  if (netLimit < -0.005) return { type: 'credit', price: -netLimit };
  return { type: 'even' };
}
