import type { OptionChainRow } from './otm-mispricing.js';
import { blackScholesDelta } from './black-scholes.js';

/**
 * TRA-1618 (parent TRA-1614) — weekly QQQ put-credit-spread ENTRY signal, pure
 * computation.
 *
 * TRA-1614 tore down the SMB "$500/wk small account" video (a weekly QQQ 25-wide
 * put-credit-spread, short put ~10–15Δ, opened Friday) and TRA-1617 priced its
 * full rules — PCS + martingale call-rescue — through the TRA-532 gate on 2015–
 * 2025 QQQ bars (verdict FAIL). This module is the LIVE forward-test leg: it
 * selects the exact entry the video sells from a real Tradier chain snapshot and
 * settles it to expiry, so we accrue genuine out-of-sample paper fills alongside
 * the historical backtest.
 *
 * DELIBERATELY the base PCS ONLY — the discretionary martingale rescue leg
 * (buy a far-dated call + sell weeklies to chase a breach) is NOT auto-emitted.
 * TRA-1617 showed the rescue is what drives the 41:1 tail; a shadow log must not
 * silently run a martingale add-on. The rescue's expectancy is captured in the
 * backtest; the forward test measures the mechanical spread the operator would
 * actually place.
 *
 * DECISION-FREE and I/O-free: it folds a chain snapshot into the selected spread
 * and, given a realized underlying settlement price, into the spread's expiry
 * P&L. The durable append-only capture, the per-week dedup, and the feed into
 * the TRA-532 Stage-2 paper leg live in the server ledger
 * (`pcs-shadow-ledger.ts`). NOTHING here routes an order or touches sizing/exits
 * — shadow-first, $0 live.
 */

/** Sub-set of {@link OptionChainRow} the selector needs (a put quote). */
export type PcsPutQuote = Pick<
  OptionChainRow,
  'strike' | 'optionType' | 'bid' | 'ask' | 'midIv' | 'smvVol'
>;

export interface WeeklyPcsParams {
  /** Centre of the target short-put delta band (spec: ~0.125, i.e. 10–15Δ). */
  shortPutDeltaTarget: number;
  /** Inclusive |delta| band the short put must fall within to take the trade. */
  shortPutDeltaBand: readonly [number, number];
  /** Dollar width of the spread (spec: 25-wide). */
  width: number;
  /** Per-contract commission charged on every leg open AND (non-expiry) close. */
  commissionPerContract: number;
  /** Annualized risk-free rate for the delta model. Default 0.045. */
  riskFreeRate?: number;
}

export const WEEKLY_PCS_DEFAULTS: WeeklyPcsParams = {
  shortPutDeltaTarget: 0.125,
  shortPutDeltaBand: [0.1, 0.15],
  width: 25,
  commissionPerContract: 0.65,
  riskFreeRate: 0.045,
};

/** The selected weekly PCS entry — everything the ledger persists at open. */
export interface WeeklyPcsSignal {
  /** Short put strike (the ~10–15Δ leg you SELL). */
  shortStrike: number;
  /** Long put strike = shortStrike − width (the leg you BUY for defined risk). */
  longStrike: number;
  /** |BS delta| of the selected short put at entry. */
  shortDelta: number;
  /** Net per-share credit received (short bid − long ask; marketable fills). */
  credit: number;
  /** Dollar width of the spread. */
  width: number;
  /** Defined max loss in $ = (width − credit) × 100. The R denominator. */
  riskDollars: number;
  /** Commissions paid to OPEN both legs ($). */
  entryCommission: number;
  /** Underlying spot at entry. */
  entrySpot: number;
}

function ivOf(row: PcsPutQuote): number | null {
  const iv = row.smvVol ?? row.midIv;
  return typeof iv === 'number' && Number.isFinite(iv) && iv > 0 ? iv : null;
}

/** Marketable mid — the price you'd actually SELL the short leg at (cross to bid). */
function sellPrice(row: PcsPutQuote): number | null {
  if (typeof row.bid === 'number' && row.bid > 0) return row.bid;
  return null;
}
/** The price you'd actually BUY the long leg at (cross to ask). */
function buyPrice(row: PcsPutQuote): number | null {
  if (typeof row.ask === 'number' && row.ask > 0) return row.ask;
  return null;
}

/**
 * Select the weekly PCS entry from a chain snapshot of PUT quotes for one expiry.
 *
 * Picks the put whose |BS delta| is closest to `shortPutDeltaTarget` AND inside
 * `shortPutDeltaBand`, then requires a real long put `width` below it. The credit
 * is the marketable net (short bid − long ask); the trade is only returned when
 * that credit is strictly positive (the rule wouldn't open for a debit) and both
 * legs carry usable quotes. Returns `null` when no in-band short put, no long
 * wing, or no positive credit exists — the caller then records nothing this week.
 */
export function selectWeeklyPcs(args: {
  spot: number;
  /** Calendar days to the weekly expiry (spec: ~7DTE). */
  dteDays: number;
  puts: readonly PcsPutQuote[];
  params?: WeeklyPcsParams;
}): WeeklyPcsSignal | null {
  const params = args.params ?? WEEKLY_PCS_DEFAULTS;
  const r = params.riskFreeRate ?? 0.045;
  const T = Math.max(args.dteDays, 0) / 365;
  const [bandLo, bandHi] = params.shortPutDeltaBand;

  if (!(args.spot > 0) || args.puts.length === 0) return null;

  // Index puts by strike (last quote wins) for the long-wing lookup.
  const byStrike = new Map<number, PcsPutQuote>();
  for (const row of args.puts) {
    if (row.optionType !== 'put') continue;
    byStrike.set(row.strike, row);
  }

  let best: { row: PcsPutQuote; delta: number } | null = null;
  let bestErr = Infinity;
  for (const row of byStrike.values()) {
    const iv = ivOf(row);
    if (iv == null) continue;
    const d = Math.abs(
      blackScholesDelta({
        spot: args.spot,
        strike: row.strike,
        timeToExpiryYears: T,
        riskFreeRate: r,
        volatility: iv,
        optionType: 'put',
      }),
    );
    if (d < bandLo || d > bandHi) continue;
    const err = Math.abs(d - params.shortPutDeltaTarget);
    if (err < bestErr) {
      bestErr = err;
      best = { row, delta: d };
    }
  }
  if (best == null) return null;

  const shortStrike = best.row.strike;
  const longStrike = shortStrike - params.width;
  if (longStrike <= 0) return null;
  const longRow = byStrike.get(longStrike);
  if (!longRow) return null;

  const shortBid = sellPrice(best.row);
  const longAsk = buyPrice(longRow);
  if (shortBid == null || longAsk == null) return null;

  const credit = shortBid - longAsk;
  if (!(credit > 0)) return null;

  return {
    shortStrike,
    longStrike,
    shortDelta: best.delta,
    credit,
    width: params.width,
    riskDollars: (params.width - credit) * 100,
    entryCommission: 2 * params.commissionPerContract,
    entrySpot: args.spot,
  };
}

export interface WeeklyPcsSettlement {
  /** Intrinsic value of the spread at expiry (per share), clamped to [0, width]. */
  spreadValueAtExpiry: number;
  /** True when the underlying settled below the short strike (a breach). */
  breached: boolean;
  /** True when the underlying settled at/below the long strike (max-loss). */
  maxLoss: boolean;
  /** Realized net P&L in $ (credit − intrinsic, ×100, net of all commissions). */
  pnl: number;
  /** Realized R = pnl / riskDollars. */
  R: number;
}

/**
 * Settle a held weekly PCS to expiry against the realized underlying price. The
 * shadow forward-test holds the spread to expiry (no intraday management — a
 * live shadow samples at the weekly cadence, not tick-by-tick), so settlement is
 * the cash intrinsic of the vertical:
 *
 *   spreadValue = clamp(shortStrike − expirySpot, 0, width)
 *   pnl = (credit − spreadValue) × 100 − entryComm − closeComm
 *
 * A spread that expires worthless (spot ≥ short strike) keeps the full credit and
 * pays NO close commission (it expires, unassigned). A breached spread is settled
 * (cash intrinsic) and pays the two-leg close commission — the same convention as
 * the TRA-1617 backtest's expiry leg.
 */
export function settleWeeklyPcs(
  signal: WeeklyPcsSignal,
  expirySpot: number,
  params: WeeklyPcsParams = WEEKLY_PCS_DEFAULTS,
): WeeklyPcsSettlement {
  const shortIntrinsic = Math.max(0, signal.shortStrike - expirySpot);
  const spreadValue = Math.min(signal.width, shortIntrinsic);
  const breached = expirySpot < signal.shortStrike;
  const maxLoss = expirySpot <= signal.longStrike;

  const closeComm = spreadValue > 0 ? 2 * params.commissionPerContract : 0;
  const pnl = (signal.credit - spreadValue) * 100 - signal.entryCommission - closeComm;

  return {
    spreadValueAtExpiry: spreadValue,
    breached,
    maxLoss,
    pnl,
    R: signal.riskDollars > 0 ? pnl / signal.riskDollars : 0,
  };
}
