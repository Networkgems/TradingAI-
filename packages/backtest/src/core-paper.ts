/**
 * CORE paper runner — the pure half (no I/O).
 *
 * Applies the frozen {@link CORE_RULES} (35 DTE, 16Δ short put, $5 wide, 50%
 * take-profit, 2× stop, 21-DTE exit, ≤2 open, one entry per 5 trading days) to a
 * LIVE option chain, so the Tradier sandbox account can trade exactly what the
 * backtest graded and the fills can be compared with the model.
 *
 * Deltas are computed here from each row's own mid (implied vol solved locally),
 * not from vendor greeks: sandbox chains carry none, and production greeks are
 * up to an hour old. Strikes come from the chain, not from a $1 grid.
 */
import type { OptionChainRow } from '@trading-app/engine';
import { blackScholesDelta, bsImpliedVolatility } from '@trading-app/engine';
import { CORE_RULES, type PutSpreadRules } from './put-spread-core.js';

const DAY = 86_400_000;

export interface CorePaperPosition {
  id: string;
  underlying: string;
  expiration: string;
  shortSymbol: string;
  longSymbol: string;
  shortStrike: number;
  longStrike: number;
  /** Net credit per share the model expected at entry (chain mid). */
  modelCredit: number;
  /** Limit sent to the broker. */
  limitCredit: number;
  /** Actual fill, once known. */
  fillCredit: number | null;
  openOrderId: string | null;
  closeOrderId: string | null;
  closeReason: CoreExitReason | null;
  closeDebit: number | null;
  status: 'pending_open' | 'open' | 'pending_close' | 'closed' | 'canceled';
  openedAt: number;
  closedAt: number | null;
}

export interface CorePaperState {
  version: 1;
  positions: CorePaperPosition[];
  /** ms epoch of the last ACCEPTED entry order (the 5-trading-day cadence). */
  lastEntryAt: number | null;
}

export const EMPTY_STATE: CorePaperState = { version: 1, positions: [], lastEntryAt: null };

export type CoreExitReason = 'take_profit' | 'stop_loss' | 'time_exit';

/** Calendar days from `now` to the expiration date (UTC midnight convention). */
export function dteDays(expiration: string, now: number): number {
  return (Date.parse(`${expiration}T00:00:00Z`) - now) / DAY;
}

/** Weekdays strictly after `from` up to and including `to` — a trading-day proxy (holidays ignored). */
export function weekdaysBetween(from: number, to: number): number {
  let n = 0;
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime() + DAY; t <= to; t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}

/** The listed expiration nearest the target DTE, inside [target − 7, target + 10]. */
export function pickCoreExpiration(
  expirations: readonly string[],
  now: number,
  rules: PutSpreadRules = CORE_RULES,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const e of expirations) {
    const dte = dteDays(e, now);
    if (dte < rules.targetDte - 7 || dte > rules.targetDte + 10) continue;
    const dist = Math.abs(dte - rules.targetDte);
    if (dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

export interface CoreEntryPlan {
  expiration: string;
  short: OptionChainRow;
  long: OptionChainRow;
  shortDelta: number;
  shortIv: number;
  /** Net credit at the two mids. */
  midCredit: number;
  /** Net credit at the touch (short bid − long ask): what a marketable order gets. */
  naturalCredit: number;
  /** Limit to send: mid − $0.01, floored to the cent, never below natural. */
  limitCredit: number;
}

export type CoreEntryRefusal =
  | 'max_open'
  | 'cadence'
  | 'no_expiration'
  | 'no_short_strike'
  | 'no_long_strike'
  | 'no_quote'
  | 'credit_too_small';

const mid = (r: OptionChainRow): number | null => {
  const b = r.bid ?? 0;
  const a = r.ask ?? 0;
  return b > 0 && a >= b ? (b + a) / 2 : null;
};

/** |Δ| of a put from its own mid. Null when the quote is one-sided or no σ solves. */
export function putAbsDelta(
  row: OptionChainRow,
  spot: number,
  now: number,
  riskFreeRate: number,
): { absDelta: number; iv: number } | null {
  const m = mid(row);
  const T = dteDays(row.expiration, now) / 365;
  if (m == null || T <= 0) return null;
  const iv = bsImpliedVolatility({
    spot, strike: row.strike, timeToExpiryYears: T, riskFreeRate, optionType: 'put', marketPrice: m,
  });
  if (iv == null) return null;
  const d = blackScholesDelta({
    spot, strike: row.strike, timeToExpiryYears: T, riskFreeRate, volatility: iv, optionType: 'put',
  });
  return Number.isFinite(d) ? { absDelta: Math.abs(d), iv } : null;
}

/**
 * Decide whether to open a spread now and, if so, which one.
 * Entry gates first (max open, cadence), then the chain.
 */
export function planCoreEntry(input: {
  state: CorePaperState;
  expiration: string | null;
  chain: readonly OptionChainRow[];
  spot: number;
  now: number;
  rules?: PutSpreadRules;
  riskFreeRate?: number;
  /** Refuse a spread whose mid credit is below this (default $0.20 — costs eat the rest). */
  minCredit?: number;
}): { ok: true; plan: CoreEntryPlan } | { ok: false; reason: CoreEntryRefusal; detail?: string } {
  const rules = input.rules ?? CORE_RULES;
  const r = input.riskFreeRate ?? 0.04;
  const live = input.state.positions.filter((p) => p.status !== 'closed' && p.status !== 'canceled');
  if (live.length >= rules.maxOpen) return { ok: false, reason: 'max_open' };
  if (
    input.state.lastEntryAt != null &&
    weekdaysBetween(input.state.lastEntryAt, input.now) < rules.entryEveryNDays
  ) {
    return { ok: false, reason: 'cadence' };
  }
  if (!input.expiration) return { ok: false, reason: 'no_expiration' };
  const puts = input.chain
    .filter((c) => c.optionType === 'put' && c.expiration === input.expiration && c.strike < input.spot)
    .sort((a, b) => b.strike - a.strike); // nearest-the-money first

  // The first strike, walking down from spot, whose |Δ| is at or below the target.
  let short: OptionChainRow | null = null;
  let shortDelta = 0;
  let shortIv = 0;
  for (const p of puts) {
    const g = putAbsDelta(p, input.spot, input.now, r);
    if (!g) continue;
    if (g.absDelta <= rules.shortDelta) {
      short = p;
      shortDelta = g.absDelta;
      shortIv = g.iv;
      break;
    }
  }
  if (!short) return { ok: false, reason: 'no_short_strike' };
  const longStrike = short.strike - rules.width;
  const long = puts.find((p) => Math.abs(p.strike - longStrike) < 1e-6);
  if (!long) return { ok: false, reason: 'no_long_strike', detail: `no ${longStrike} put listed` };
  const sm = mid(short);
  const lm = mid(long);
  if (sm == null || lm == null) return { ok: false, reason: 'no_quote' };
  const midCredit = sm - lm;
  const naturalCredit = (short.bid ?? 0) - (long.ask ?? 0);
  const minCredit = input.minCredit ?? 0.2;
  if (!(midCredit >= minCredit)) {
    return { ok: false, reason: 'credit_too_small', detail: `mid credit ${midCredit.toFixed(2)} < ${minCredit}` };
  }
  const limitCredit = Math.max(Math.floor((midCredit - 0.01) * 100) / 100, Math.ceil(naturalCredit * 100) / 100, 0.01);
  return {
    ok: true,
    plan: { expiration: input.expiration, short, long, shortDelta, shortIv, midCredit, naturalCredit, limitCredit },
  };
}

/** Exit decision for one open spread given the current debit to close (per share, at mid). */
export function decideCoreExit(
  position: Pick<CorePaperPosition, 'expiration' | 'fillCredit' | 'modelCredit'>,
  closeDebit: number,
  now: number,
  rules: PutSpreadRules = CORE_RULES,
): CoreExitReason | null {
  const credit = position.fillCredit ?? position.modelCredit;
  if (closeDebit <= (1 - rules.takeProfitFrac) * credit) return 'take_profit';
  if (closeDebit - credit >= rules.stopLossMultiple * credit) return 'stop_loss';
  if (dteDays(position.expiration, now) <= rules.exitAtDte) return 'time_exit';
  return null;
}

/** Close limit: debit at mid + $0.01, rounded up to the cent; stops pay up to the natural. */
export function closeLimitDebit(midDebit: number, naturalDebit: number, reason: CoreExitReason): number {
  const base = Math.ceil((midDebit + 0.01) * 100) / 100;
  const limit = reason === 'stop_loss' ? Math.max(base, Math.ceil(naturalDebit * 100) / 100) : base;
  return Math.max(0.01, limit);
}

export interface CorePaperSummary {
  closed: number;
  wins: number;
  winRate: number | null;
  totalPnlUsd: number;
  meanReturnOnRisk: number | null;
  /** Mean (fill − model) entry credit, per share. Negative = fills worse than the model. */
  meanEntrySlippage: number | null;
  /** The pre-registered paper gate: 40 closed trades. */
  gateTrades: number;
}

export function summarizeCorePaper(state: CorePaperState, rules: PutSpreadRules = CORE_RULES): CorePaperSummary {
  const closed = state.positions.filter((p) => p.status === 'closed' && p.closeDebit != null);
  let wins = 0;
  let pnl = 0;
  let ror = 0;
  let slip = 0;
  let slipN = 0;
  for (const p of closed) {
    const credit = p.fillCredit ?? p.modelCredit;
    const tradePnl = (credit - (p.closeDebit as number)) * 100;
    pnl += tradePnl;
    if (tradePnl > 0) wins += 1;
    ror += tradePnl / ((rules.width - credit) * 100);
    if (p.fillCredit != null) {
      slip += p.fillCredit - p.modelCredit;
      slipN += 1;
    }
  }
  const n = closed.length;
  return {
    closed: n,
    wins,
    winRate: n > 0 ? wins / n : null,
    totalPnlUsd: Math.round(pnl * 100) / 100,
    meanReturnOnRisk: n > 0 ? ror / n : null,
    meanEntrySlippage: slipN > 0 ? slip / slipN : null,
    gateTrades: 40,
  };
}

export interface AccountFit {
  verdict: 'ready' | 'not_ready';
  reasons: string[];
}

/**
 * Can this account trade CORE live? Credit spreads need a MARGIN account with
 * spread approval, and FINRA requires ≥ $2,000 equity for margin.
 * `optionLevel` follows Tradier's numbering, where spreads sit at level 3.
 */
export function assessCoreAccountFit(input: {
  accountType: string | null;
  totalEquity: number | null;
  optionLevel: number | null;
}): AccountFit {
  const reasons: string[] = [];
  const type = (input.accountType ?? '').toLowerCase();
  if (type !== 'margin' && type !== 'pdt') {
    reasons.push(`account type is "${input.accountType ?? 'unknown'}" — credit spreads need a margin account`);
  }
  if (input.totalEquity == null || input.totalEquity < 2000) {
    reasons.push(`equity ${input.totalEquity ?? 'unknown'} < $2,000 FINRA margin minimum`);
  }
  if (input.optionLevel == null || input.optionLevel < 3) {
    reasons.push(`option level ${input.optionLevel ?? 'unknown'} — spreads need level 3`);
  }
  return { verdict: reasons.length === 0 ? 'ready' : 'not_ready', reasons };
}
