import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadChainDays, estimateSpotFromChain, type ChainDay } from '@trading-app/backtest';
import type { OptionChainRow } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { isoWeek, type IdeaJournalEntry } from './options-idea-journal.js';
import type { IdeaLeg } from './options-ideas-feed.js';

// TRA-601 (TRA-595 C6) — the forward-test *valuation* + weekly report.
//
// This is the validation backbone's scoring layer. For each idea the journal
// captured, we re-price its defined-risk structure against the option chains the
// recorder wrote AFTER it was surfaced — no look-ahead, real marks — and roll
// the result up into a weekly hit-rate / expectancy / max-loss-adherence /
// POP-calibration report. The live-capital gate (`live-capital-gate.ts`) reads
// this report; it wires no capital — it is evidence for a human decision.
//
// Valuation identity. A defined-risk structure's *liquidation value* is
//   L = Σ_legs (buy ? +mid : −mid) × 100.
// At entry the panel's `entryNetUsd` equals −L_entry (a debit paid is a negative
// net but a positive liquidation value, and vice-versa for a credit). So for any
// later valuation snapshot the position P/L is simply
//   pnl = L_now − L_entry = L_now + entryNetUsd,
// which holds for both debit- and credit-class structures. Held to expiry, L is
// the intrinsic value of the (fully-specified) legs at the settlement spot, so a
// complete structure is naturally bounded to [−maxLoss, +maxProfit].

const log = logger.child({ module: 'options-forward-test' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT = 100;

/** Default chain-recorder output root — mirrors `index.ts` CHAIN_RECORD_OUT_DIR. */
export function defaultChainsDir(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return process.env['CHAINS_OUT_DIR'] ?? join(root, 'option-chains');
}

export type IdeaStatus =
  /** Expiration in the future; marked-to-market against the latest chain. */
  | 'open'
  /** Past expiration and settled against a recorded chain at/after expiry. */
  | 'resolved'
  /** Past expiration but no recorded chain to settle against yet. */
  | 'awaiting_data'
  /** No recorded chain after the surface date can value this idea. */
  | 'no_data';

export interface IdeaOutcome {
  key: string;
  ticker: string;
  strategy: string;
  surfacedDate: string;
  surfacedWeek: string;
  expiration: string;
  pop: number;
  maxLossUsd: number;
  maxProfitUsd: number;
  entryNetUsd: number;
  status: IdeaStatus;
  /** ET date of the chain snapshot used to value the idea (null when unvalued). */
  valuedAt: string | null;
  /** Structure liquidation value (USD per 1-lot) at the valuation snapshot. */
  liquidationUsd: number | null;
  /** Position P/L (USD per 1-lot) = liquidation + entryNet. Null when unvalued. */
  pnlUsd: number | null;
  /** Risk-normalized P/L (pnl / maxLoss) — the R-multiple. Null when unvalued. */
  pnlR: number | null;
  /** Win iff a RESOLVED idea's realized P/L > 0. Null while open/unvalued. */
  win: boolean | null;
  /** True when realized loss exceeded the stated defined-risk max (integrity flag). */
  maxLossBreached: boolean;
}

// ── chain pricing ─────────────────────────────────────────────────────────────

function rowMid(r: OptionChainRow): number | null {
  if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid >= 0 && r.ask > 0) {
    return (r.bid + r.ask) / 2;
  }
  if (typeof r.last === 'number' && r.last > 0) return r.last;
  return null;
}

function legMid(rows: readonly OptionChainRow[], leg: IdeaLeg): number | null {
  const r = rows.find(
    (x) => x.optionType === leg.optionType && x.expiration === leg.expiration && x.strike === leg.strike,
  );
  return r ? rowMid(r) : null;
}

function intrinsic(leg: IdeaLeg, spot: number): number {
  return leg.optionType === 'call' ? Math.max(0, spot - leg.strike) : Math.max(0, leg.strike - spot);
}

const sign = (leg: IdeaLeg): number => (leg.action === 'buy' ? 1 : -1);

/**
 * Mark-to-market liquidation value of the structure at a snapshot. Every leg
 * must price (a half-priced structure is not a fair mark) → returns null if any
 * leg is missing from the chain.
 */
function liquidationFromMarks(legs: readonly IdeaLeg[], rows: readonly OptionChainRow[]): number | null {
  let total = 0;
  for (const leg of legs) {
    const mid = legMid(rows, leg);
    if (mid == null) return null;
    total += sign(leg) * mid * CONTRACT;
  }
  return total;
}

/** Settlement liquidation value at expiry: intrinsic value of every leg vs spot. */
function liquidationAtExpiry(legs: readonly IdeaLeg[], spot: number): number {
  let total = 0;
  for (const leg of legs) total += sign(leg) * intrinsic(leg, spot) * CONTRACT;
  return total;
}

function snapshotSpot(day: ChainDay, ticker: string): number | null {
  const snap = day.bySymbol.get(ticker.toUpperCase());
  if (!snap) return null;
  if (typeof snap.spot === 'number' && Number.isFinite(snap.spot) && snap.spot > 0) return snap.spot;
  return estimateSpotFromChain(snap.rows);
}

// ── per-idea valuation ─────────────────────────────────────────────────────────

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Value one journaled idea against the recorded chain history. Pure given
 * `chainDays` (ascending) so it is fully unit-testable with synthetic chains.
 */
export function valueIdea(entry: IdeaJournalEntry, chainDays: readonly ChainDay[], asOf: number): IdeaOutcome {
  const asOfDate = etDateKey(asOf);
  const base: IdeaOutcome = {
    key: entry.key,
    ticker: entry.ticker,
    strategy: entry.strategy,
    surfacedDate: entry.surfacedDate,
    surfacedWeek: entry.surfacedWeek || isoWeek(entry.surfacedDate),
    expiration: entry.expiration,
    pop: entry.pop,
    maxLossUsd: entry.maxLossUsd,
    maxProfitUsd: entry.maxProfitUsd,
    entryNetUsd: entry.entryNetUsd,
    status: 'no_data',
    valuedAt: null,
    liquidationUsd: null,
    pnlUsd: null,
    pnlR: null,
    win: null,
    maxLossBreached: false,
  };

  // Only chains AT/AFTER the surface date are admissible (no look-ahead, and an
  // entry-day snapshot is the basis, not a forward mark).
  const forward = chainDays.filter((d) => d.date >= entry.surfacedDate && d.bySymbol.has(entry.ticker));
  if (forward.length === 0) return base;

  const finish = (
    status: IdeaStatus,
    day: ChainDay,
    liquidation: number,
    resolved: boolean,
  ): IdeaOutcome => {
    const pnl = r2(liquidation + entry.entryNetUsd);
    const denom = entry.maxLossUsd > 0 ? entry.maxLossUsd : 1;
    return {
      ...base,
      status,
      valuedAt: day.date,
      liquidationUsd: r2(liquidation),
      pnlUsd: pnl,
      pnlR: r2(pnl / denom),
      win: resolved ? pnl > 0 : null,
      // A held-to-expiry defined-risk loss should never exceed the stated max;
      // a breach (beyond a $1 rounding cushion) flags a modeling/data fault.
      maxLossBreached: resolved && pnl < -(entry.maxLossUsd + 1),
    };
  };

  const expired = asOfDate >= entry.expiration;
  if (expired) {
    // Settle at the first recorded chain on/after expiration (intrinsic value).
    const settleDay = forward.find((d) => d.date >= entry.expiration);
    if (settleDay) {
      const spot = snapshotSpot(settleDay, entry.ticker);
      if (spot != null) {
        return finish('resolved', settleDay, liquidationAtExpiry(entry.legs, spot), true);
      }
    }
    // Past expiry but nothing to settle against yet.
    return { ...base, status: 'awaiting_data' };
  }

  // Open: mark-to-market at the latest snapshot on/before today whose chain can
  // price every leg. Walk newest→oldest so a thin latest chain falls back.
  const usable = forward.filter((d) => d.date <= asOfDate);
  for (let i = usable.length - 1; i >= 0; i--) {
    const day = usable[i]!;
    const snap = day.bySymbol.get(entry.ticker.toUpperCase());
    if (!snap) continue;
    const liq = liquidationFromMarks(entry.legs, snap.rows);
    if (liq != null) return finish('open', day, liq, false);
  }
  return base;
}

/**
 * Forward-test every journaled idea against the recorded chains under `dataDir`.
 * Loads the chain history once and values each idea. Returns outcomes in journal
 * order.
 */
export async function forwardTestIdeas(
  entries: readonly IdeaJournalEntry[],
  dataDir: string = defaultChainsDir(),
  asOf: number = Date.now(),
): Promise<IdeaOutcome[]> {
  const chainDays = await loadChainDays(dataDir);
  if (chainDays.length === 0) {
    log.info('forward-test: no recorded chains found', { dataDir });
  }
  return entries.map((e) => valueIdea(e, chainDays, asOf));
}

// ── weekly report ───────────────────────────────────────────────────────────

export interface WeeklyStats {
  week: string;
  surfaced: number;
  resolved: number;
  open: number;
  awaitingData: number;
  noData: number;
  wins: number;
  losses: number;
  scratches: number;
  /** wins / resolved — null when nothing resolved this week. */
  hitRate: number | null;
  /** Mean realized P/L (USD) over resolved ideas — null when none resolved. */
  expectancyUsd: number | null;
  /** Mean realized R-multiple (P/L ÷ maxLoss) over resolved — the risk-normalized edge. */
  expectancyR: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  /** Σ win P/L ÷ |Σ loss P/L| — null when no losses (or nothing resolved). */
  profitFactor: number | null;
  /** Mean model POP over resolved ideas. */
  avgPredictedPop: number | null;
  /** hitRate − avgPredictedPop: + = model under-promised, − = over-promised. */
  popCalibrationGap: number | null;
  /** Count of resolved ideas whose realized loss breached the stated max-loss. */
  maxLossBreaches: number;
  /** Convenience: expectancyR != null && > 0. */
  positiveExpectancy: boolean;
}

export interface ForwardTestReport {
  generatedAt: number;
  asOfDate: string;
  /** Where the recorded chains were read from. */
  chainsDir: string;
  totals: {
    surfaced: number;
    resolved: number;
    open: number;
    awaitingData: number;
    noData: number;
    wins: number;
    losses: number;
    scratches: number;
    hitRate: number | null;
    expectancyUsd: number | null;
    expectancyR: number | null;
    profitFactor: number | null;
    avgPredictedPop: number | null;
    popCalibrationGap: number | null;
    maxLossBreaches: number;
    /** Distinct ISO weeks that have ≥1 resolved idea. */
    weeksWithResolved: number;
    /** Of those, how many had positive R-expectancy. */
    weeksPositiveExpectancy: number;
  };
  /** Per-week breakdown, ascending by ISO week. */
  weeks: WeeklyStats[];
  /** Methodology + look-ahead note, surfaced to the report consumer/QA. */
  methodology: string;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function statsFor(week: string, outcomes: readonly IdeaOutcome[]): WeeklyStats {
  const resolved = outcomes.filter((o) => o.status === 'resolved');
  const wins = resolved.filter((o) => o.win === true);
  const losses = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd < 0);
  const scratches = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd === 0);
  const winPnl = wins.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const lossPnl = losses.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const hitRate = resolved.length ? wins.length / resolved.length : null;
  const expectancyR = mean(resolved.map((o) => o.pnlR ?? 0));
  const avgPredictedPop = mean(resolved.map((o) => o.pop));
  return {
    week,
    surfaced: outcomes.length,
    resolved: resolved.length,
    open: outcomes.filter((o) => o.status === 'open').length,
    awaitingData: outcomes.filter((o) => o.status === 'awaiting_data').length,
    noData: outcomes.filter((o) => o.status === 'no_data').length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    hitRate: hitRate == null ? null : r2(hitRate),
    expectancyUsd: mean(resolved.map((o) => o.pnlUsd ?? 0)),
    expectancyR: expectancyR == null ? null : r2(expectancyR),
    avgWinUsd: wins.length ? r2(winPnl / wins.length) : null,
    avgLossUsd: losses.length ? r2(lossPnl / losses.length) : null,
    profitFactor: losses.length && lossPnl !== 0 ? r2(winPnl / Math.abs(lossPnl)) : null,
    avgPredictedPop: avgPredictedPop == null ? null : r2(avgPredictedPop),
    popCalibrationGap: hitRate != null && avgPredictedPop != null ? r2(hitRate - avgPredictedPop) : null,
    maxLossBreaches: resolved.filter((o) => o.maxLossBreached).length,
    positiveExpectancy: expectancyR != null && expectancyR > 0,
  };
}

const METHODOLOGY =
  'Each surfaced idea is captured at generation time (entry net/max-loss the panel showed = a paper mid-fill), ' +
  'then re-priced ONLY against option chains the recorder wrote on/after the surface date (no look-ahead). ' +
  'Resolved = held to expiry and settled at intrinsic value vs the recorded settlement-day spot; open = ' +
  'marked-to-market at the latest chain that prices every leg. P/L = structure liquidation value + entry net. ' +
  'Hit-rate = wins ÷ resolved; expectancy is reported in USD/1-lot and as an R-multiple (P/L ÷ defined max-loss). ' +
  'POP calibration compares the model’s mean stated probability-of-profit to the realized hit-rate. No live ' +
  'capital is wired by this report; it is the evidence input to the documented live-capital gate.';

/** Roll a set of idea outcomes into the weekly + overall forward-test report. */
export function buildForwardTestReport(
  outcomes: readonly IdeaOutcome[],
  opts: { asOf?: number; chainsDir?: string } = {},
): ForwardTestReport {
  const asOf = opts.asOf ?? Date.now();
  const byWeek = new Map<string, IdeaOutcome[]>();
  for (const o of outcomes) {
    const arr = byWeek.get(o.surfacedWeek) ?? [];
    arr.push(o);
    byWeek.set(o.surfacedWeek, arr);
  }
  const weeks = [...byWeek.keys()].sort().map((w) => statsFor(w, byWeek.get(w)!));

  const resolved = outcomes.filter((o) => o.status === 'resolved');
  const wins = resolved.filter((o) => o.win === true);
  const losses = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd < 0);
  const scratches = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd === 0);
  const winPnl = wins.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const lossPnl = losses.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const hitRate = resolved.length ? wins.length / resolved.length : null;
  const expectancyR = mean(resolved.map((o) => o.pnlR ?? 0));
  const avgPredictedPop = mean(resolved.map((o) => o.pop));
  const weeksWithResolved = weeks.filter((w) => w.resolved > 0);

  return {
    generatedAt: asOf,
    asOfDate: etDateKey(asOf),
    chainsDir: opts.chainsDir ?? defaultChainsDir(),
    totals: {
      surfaced: outcomes.length,
      resolved: resolved.length,
      open: outcomes.filter((o) => o.status === 'open').length,
      awaitingData: outcomes.filter((o) => o.status === 'awaiting_data').length,
      noData: outcomes.filter((o) => o.status === 'no_data').length,
      wins: wins.length,
      losses: losses.length,
      scratches: scratches.length,
      hitRate: hitRate == null ? null : r2(hitRate),
      expectancyUsd: mean(resolved.map((o) => o.pnlUsd ?? 0)),
      expectancyR: expectancyR == null ? null : r2(expectancyR),
      profitFactor: losses.length && lossPnl !== 0 ? r2(winPnl / Math.abs(lossPnl)) : null,
      avgPredictedPop: avgPredictedPop == null ? null : r2(avgPredictedPop),
      popCalibrationGap:
        hitRate != null && avgPredictedPop != null ? r2(hitRate - avgPredictedPop) : null,
      maxLossBreaches: resolved.filter((o) => o.maxLossBreached).length,
      weeksWithResolved: weeksWithResolved.length,
      weeksPositiveExpectancy: weeksWithResolved.filter((w) => w.positiveExpectancy).length,
    },
    weeks,
    methodology: METHODOLOGY,
  };
}
