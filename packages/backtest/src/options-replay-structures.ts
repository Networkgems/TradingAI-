/**
 * TRA-800 — defined-risk structure modeler for the chain-replay engine.
 *
 * Builds the two TRA-592-approved structures from a recorded option chain so
 * `run-options-replay.ts` can enter them through
 * `OptionsReplayAccount.openSpread`:
 *
 *   • put_write — cash-secured short put (primary, credit). One short put leg,
 *     ~`targetOtmPct` below spot. Credit = put mid; max loss = (strike − credit)
 *     ×100 (assignment at strike, underlying → 0); max profit = credit ×100.
 *
 *   • call_debit_spread — trend-filtered defined-risk bull call spread (debit).
 *     Buy a near-ATM call, sell one `step` higher. Debit = long − short; max
 *     loss = debit ×100; max profit = (width − debit) ×100.
 *
 * The payoff math mirrors `packages/server/src/options-ideas-feed.ts`
 * `modelStructure` (`bull_call_spread` and a single short-put leg); the chain
 * pricing helpers are local copies (the server can't be imported — it already
 * depends on @trading-app/backtest). All dollar figures are per 1-lot (×100).
 */

import type { OptionChainRow } from '@trading-app/engine';
import type { OptionLeg } from '@trading-app/shared';
import type { OpenSpreadCandidate, ReplaySpreadStrategy } from './options-replay-account.js';

const CONTRACT = 100;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Mid mark for a chain row, falling back to last. Null when unpriceable. */
function rowMid(r: OptionChainRow): number | null {
  if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid >= 0 && r.ask > 0) {
    return (r.bid + r.ask) / 2;
  }
  if (typeof r.last === 'number' && r.last > 0) return r.last;
  return null;
}

/** Distinct ascending strikes available for `(optionType, expiration)`. */
function strikesFor(
  rows: readonly OptionChainRow[],
  optionType: 'call' | 'put',
  expiration: string,
): number[] {
  const set = new Set<number>();
  for (const r of rows) if (r.optionType === optionType && r.expiration === expiration) set.add(r.strike);
  return [...set].sort((a, b) => a - b);
}

/** Median adjacent-strike gap (the contract's strike increment). */
function strikeStep(strikes: number[], spot: number): number {
  if (strikes.length >= 2) {
    const gaps = strikes.slice(1).map((s, i) => s - strikes[i]!).filter((g) => g > 0);
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)]!;
    }
  }
  return Math.max(1, Math.round(spot * 0.025));
}

function nearestStrike(strikes: number[], target: number): number | null {
  if (!strikes.length) return null;
  return strikes.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), strikes[0]!);
}

function midAt(
  rows: readonly OptionChainRow[],
  optionType: 'call' | 'put',
  expiration: string,
  strike: number,
): number | null {
  const r = rows.find((x) => x.optionType === optionType && x.expiration === expiration && x.strike === strike);
  return r ? rowMid(r) : null;
}

/** Whole calendar days from `now` (ms) to an expiration date (UTC midnight). */
export function dteDays(expiration: string, now: number): number {
  const expMs = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return Number.NEGATIVE_INFINITY;
  return Math.floor((expMs - now) / 86_400_000);
}

/**
 * Pick the expiration with the most listed strikes (the deepest chain to model
 * against), considering only expirations at/above the `minDteDays` entry floor
 * — mirrors the live C3 no-day-trading order-time DTE guard so the replay never
 * opens a same-session / 0-DTE structure.
 */
export function pickExpiration(
  rows: readonly OptionChainRow[],
  now: number,
  minDteDays: number,
): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (dteDays(r.expiration, now) < minDteDays) continue;
    counts.set(r.expiration, (counts.get(r.expiration) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [exp, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = exp;
    }
  }
  return best;
}

const leg = (
  action: 'buy' | 'sell',
  optionType: 'call' | 'put',
  strike: number,
  expiration: string,
): OptionLeg => ({ action, optionType, strike, expiration });

export interface StructureModelConfig {
  /** How far OTM the short put strike sits below spot (put-write). Default 5%. */
  putWriteOtmPct: number;
  /**
   * Minimum days-to-expiration at order time — mirrors the live no-day-trading
   * entry-DTE floor (TRA-598 C3). Structures are not modeled against an
   * expiration nearer than this. Default 2 (the live `minEntryDteDays`).
   */
  minEntryDteDays: number;
}

export const DEFAULT_STRUCTURE_CONFIG: StructureModelConfig = {
  putWriteOtmPct: 0.05,
  minEntryDteDays: 2,
};

/**
 * Model a cash-secured short put (put-write) from the chain. Returns null when
 * the chain can't price a put leg at/below spot.
 */
export function modelPutWrite(
  symbol: string,
  spot: number,
  rows: readonly OptionChainRow[],
  now: number,
  cfg: StructureModelConfig = DEFAULT_STRUCTURE_CONFIG,
): OpenSpreadCandidate | null {
  const exp = pickExpiration(rows, now, cfg.minEntryDteDays);
  if (!exp) return null;
  const putStrikes = strikesFor(rows, 'put', exp);
  if (!putStrikes.length) return null;

  const target = spot * (1 - cfg.putWriteOtmPct);
  // Prefer an OTM short put (strike ≤ spot); fall back to the nearest listed strike.
  const otmStrikes = putStrikes.filter((k) => k <= spot);
  const k = nearestStrike(otmStrikes.length ? otmStrikes : putStrikes, target) ?? putStrikes[0]!;
  const credit = midAt(rows, 'put', exp, k);
  if (credit == null || !(credit > 0)) return null;

  const maxLossUsd = r2(Math.max(0.01, k - credit) * CONTRACT); // assignment at strike → 0
  return {
    symbol,
    strategy: 'put_write',
    legs: [leg('sell', 'put', k, exp)],
    netUsd: r2(credit * CONTRACT),
    maxLossUsd,
    maxProfitUsd: r2(credit * CONTRACT),
    breakevens: [r2(k - credit)],
    expiration: exp,
    spot,
    classification: 'put_write',
  };
}

/**
 * Model a defined-risk bull call DEBIT spread from the chain. Buys a near-ATM
 * call and sells one `step` higher. Returns null when either leg can't be
 * priced. `trendOk` is the trend filter — the spread is only modeled when the
 * caller's trend gate passes (the structure is "trend-filtered" by approval).
 */
export function modelCallDebitSpread(
  symbol: string,
  spot: number,
  rows: readonly OptionChainRow[],
  trendOk: boolean,
  now: number,
  cfg: StructureModelConfig = DEFAULT_STRUCTURE_CONFIG,
): OpenSpreadCandidate | null {
  if (!trendOk) return null;
  const exp = pickExpiration(rows, now, cfg.minEntryDteDays);
  if (!exp) return null;
  const callStrikes = strikesFor(rows, 'call', exp);
  if (callStrikes.length < 2) return null;

  const step = strikeStep(callStrikes, spot);
  const kLong = nearestStrike(callStrikes, spot) ?? callStrikes[0]!;
  const kShort = nearestStrike(callStrikes, kLong + step) ?? kLong + step;
  if (!(kShort > kLong)) return null;

  const longMid = midAt(rows, 'call', exp, kLong);
  const shortMid = midAt(rows, 'call', exp, kShort);
  if (longMid == null || shortMid == null) return null;

  const debit = Math.max(0.01, longMid - shortMid);
  const width = kShort - kLong;
  return {
    symbol,
    strategy: 'call_debit_spread',
    legs: [leg('buy', 'call', kLong, exp), leg('sell', 'call', kShort, exp)],
    netUsd: r2(-debit * CONTRACT),
    maxLossUsd: r2(debit * CONTRACT),
    maxProfitUsd: r2(Math.max(0, width - debit) * CONTRACT),
    breakevens: [r2(kLong + debit)],
    expiration: exp,
    spot,
    classification: 'call_debit_spread',
  };
}

/** The structure ids this modeler can build (order matters only for display). */
export const REPLAY_SPREAD_STRATEGIES: readonly ReplaySpreadStrategy[] = ['put_write', 'call_debit_spread'];
