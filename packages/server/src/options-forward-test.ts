import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadChainDays, estimateSpotFromChain, type ChainDay } from '@trading-app/backtest';
import type { OptionChainRow } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { isoWeek, type IdeaJournalEntry } from './options-idea-journal.js';
import type { IdeaLeg } from './options-ideas-feed.js';
import {
  DEFAULT_COST_MODEL,
  structureCostUsd,
  costEfficiencyRatio,
  COST_EFFICIENCY_MAX,
  type CostModel,
} from './options-cost-model.js';

// TRA-678 (F1) + TRA-1991 — the cost model + cost-efficiency threshold live in a
// leaf module (`options-cost-model.ts`) to keep them a single source of truth
// without a forward-test ⇄ journal import cycle. Re-exported here so existing
// importers (tests, callers) resolve these names from this module unchanged.
export { DEFAULT_COST_MODEL, structureCostUsd, costEfficiencyRatio, COST_EFFICIENCY_MAX };
export type { CostModel };

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

/**
 * TRA-678 — why an outcome is excluded from the gate's aggregate metrics. An
 * excluded idea is still valued and reported (for transparency) but never counts
 * toward sample-size, hit-rate, expectancy, calibration, or breach totals.
 */
export type ExcludeReason =
  /** F2 — entry was a thin-chain fallback placeholder (fabricated basis). */
  | 'fallback_priced'
  /** F4 — non-positive defined max-loss makes its R meaningless. */
  | 'non_positive_max_loss'
  /** F3 — settled on a chain too many trading days after expiry (drifted spot). */
  | 'stale_settlement'
  /**
   * TRA-1991 — modeled round-trip cost exceeds `COST_EFFICIENCY_MAX` of the
   * defined max-loss (a penny-wide, high-credit spread whose fixed retail cost
   * dwarfs its risk denominator). We would never take it with real capital, so it
   * is valued and reported but excluded from the gate's aggregate metrics — the
   * gate must measure the strategy as we would actually trade it live. The
   * surface-time filter (`options-ideas-feed`) now stops NEW such ideas from being
   * journaled; this reclassifies pre-existing journaled history at scoring time.
   */
  | 'cost_uneconomic';

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
  /**
   * TRA-678 (F1) — modeled round-trip transaction cost (USD/1-lot): commissions
   * + half bid/ask spread crossed per leg, entry and exit. The mid-priced `pnl`
   * above is PRE-cost; subtract this for the net figure the gate actually uses.
   */
  costsUsd: number;
  /** F1 — cost-net P/L (USD/1-lot) = pnl − costsUsd. Null when unvalued. */
  pnlNetUsd: number | null;
  /** F1 — cost-net R-multiple (pnlNet ÷ maxLoss). Null when unvalued or no denom. */
  pnlNetR: number | null;
  /**
   * TRA-1991 — cost-efficiency ratio = modeled round-trip cost ÷ defined max-loss
   * (lot-invariant). Null when max-loss is non-positive. An idea whose ratio
   * exceeds `COST_EFFICIENCY_MAX` is excluded (`cost_uneconomic`).
   */
  costEfficiencyRatio: number | null;
  /** Win iff a RESOLVED idea's realized P/L > 0. Null while open/unvalued. */
  win: boolean | null;
  /** True when realized loss exceeded the stated defined-risk max (integrity flag). */
  maxLossBreached: boolean;
  /** TRA-678 — true when this idea is excluded from the gate's aggregate metrics. */
  excluded: boolean;
  /** TRA-678 — why it was excluded (null when included). */
  excludeReason: ExcludeReason | null;
  /** F3 — trading days between expiry and the settlement chain (null unless resolved). */
  settleLagDays: number | null;
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

/** F3 — max trading days a settlement chain may lag expiry before it's quarantined. */
const MAX_SETTLE_LAG_TRADING_DAYS = 1;

/**
 * Weekday count strictly after `from` up to and including `to` (calendar-only, no
 * exchange-holiday adjustment — a conservative over-count if a holiday falls in
 * the window, which only quarantines MORE aggressively). Used to detect a
 * settlement chain recorded well after expiry (drifted intrinsic spot).
 */
function tradingDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0;
  let count = 0;
  const cur = new Date(a);
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= b) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/**
 * Value one journaled idea against the recorded chain history. Pure given
 * `chainDays` (ascending) so it is fully unit-testable with synthetic chains.
 */
export function valueIdea(
  entry: IdeaJournalEntry,
  chainDays: readonly ChainDay[],
  asOf: number,
  costModel: CostModel = DEFAULT_COST_MODEL,
  costEfficiencyMax: number = COST_EFFICIENCY_MAX,
): IdeaOutcome {
  const asOfDate = etDateKey(asOf);
  const costsUsd = structureCostUsd(entry.legs.length, costModel);
  const hasDenom = entry.maxLossUsd > 0;
  // TRA-1991 — recompute the cost-efficiency ratio from the entry's leg-count +
  // defined max-loss (not the persisted stamp) so the exclusion applies uniformly
  // to legacy journal history captured before the surface-time filter existed.
  const costEffRatio = costEfficiencyRatio(entry.legs.length, entry.maxLossUsd, costModel);

  // Exclusion is decided from the captured entry up-front (F2/F4/TRA-1991); a
  // settlement lag (F3) can add an exclusion at resolve time. An excluded outcome
  // is still valued and reported, but never counts toward the gate's metrics.
  const entryExclude: ExcludeReason | null = !hasDenom
    ? 'non_positive_max_loss' // F4 — no meaningful R denominator
    : entry.priced === false
      ? 'fallback_priced' // F2 — fabricated entry basis
      : costEffRatio != null && costEffRatio > costEfficiencyMax
        ? 'cost_uneconomic' // TRA-1991 — cost dwarfs defined risk; uneconomic live
        : null;

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
    costsUsd,
    pnlNetUsd: null,
    pnlNetR: null,
    costEfficiencyRatio: costEffRatio,
    win: null,
    maxLossBreached: false,
    excluded: entryExclude != null,
    excludeReason: entryExclude,
    settleLagDays: null,
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
    reason: ExcludeReason | null,
    settleLagDays: number | null,
  ): IdeaOutcome => {
    const pnl = r2(liquidation + entry.entryNetUsd);
    const pnlNet = r2(pnl - costsUsd);
    // F4 — never substitute denom = 1 for a missing max-loss; leave R null (and
    // the outcome is already excluded for `non_positive_max_loss`).
    const pnlR = hasDenom ? r2(pnl / entry.maxLossUsd) : null;
    const pnlNetR = hasDenom ? r2(pnlNet / entry.maxLossUsd) : null;
    return {
      ...base,
      status,
      valuedAt: day.date,
      liquidationUsd: r2(liquidation),
      pnlUsd: pnl,
      pnlR,
      pnlNetUsd: pnlNet,
      pnlNetR,
      win: resolved ? pnl > 0 : null,
      // A held-to-expiry defined-risk loss should never exceed the stated max;
      // a breach (beyond a $1 rounding cushion) flags a modeling/data fault.
      maxLossBreached: resolved && hasDenom && pnl < -(entry.maxLossUsd + 1),
      excluded: reason != null,
      excludeReason: reason,
      settleLagDays,
    };
  };

  const expired = asOfDate >= entry.expiration;
  if (expired) {
    // Settle at the first recorded chain on/after expiration — the expiration-day
    // chain when present (intrinsic value). F3 — if the nearest settlement chain
    // lags expiry by more than one trading day, its spot may have drifted, so
    // quarantine the settlement (still reported, excluded from gate metrics).
    const settleDay = forward.find((d) => d.date >= entry.expiration);
    if (settleDay) {
      const spot = snapshotSpot(settleDay, entry.ticker);
      if (spot != null) {
        const lag = tradingDaysBetween(entry.expiration, settleDay.date);
        const staleReason = lag > MAX_SETTLE_LAG_TRADING_DAYS ? 'stale_settlement' : null;
        return finish(
          'resolved',
          settleDay,
          liquidationAtExpiry(entry.legs, spot),
          true,
          entryExclude ?? staleReason,
          lag,
        );
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
    if (liq != null) return finish('open', day, liq, false, entryExclude, null);
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
  costModel: CostModel = DEFAULT_COST_MODEL,
): Promise<IdeaOutcome[]> {
  const chainDays = await loadChainDays(dataDir);
  if (chainDays.length === 0) {
    log.info('forward-test: no recorded chains found', { dataDir });
  }
  return entries.map((e) => valueIdea(e, chainDays, asOf, costModel));
}

// ── weekly report ───────────────────────────────────────────────────────────

export interface WeeklyStats {
  week: string;
  surfaced: number;
  resolved: number;
  open: number;
  awaitingData: number;
  noData: number;
  /** TRA-678 — resolved/open ideas excluded from these metrics (fallback/stale/no-denom). */
  excluded: number;
  wins: number;
  losses: number;
  scratches: number;
  /** wins / resolved — null when nothing resolved this week. */
  hitRate: number | null;
  /** Mean PRE-cost realized P/L (USD) over resolved ideas — null when none resolved. */
  expectancyUsd: number | null;
  /** Mean PRE-cost realized R-multiple (P/L ÷ maxLoss) over resolved. */
  expectancyR: number | null;
  /** F1 — mean COST-NET realized P/L (USD) over resolved ideas. */
  expectancyNetUsd: number | null;
  /** F1 — mean COST-NET realized R-multiple over resolved — the gated edge. */
  expectancyNetR: number | null;
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
  /** Convenience: expectancyR (pre-cost) != null && > 0. */
  positiveExpectancy: boolean;
  /** F1 — convenience: expectancyNetR != null && > 0 (the gated condition). */
  positiveExpectancyNet: boolean;
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
    /** TRA-678 — outcomes excluded from every aggregate metric below. */
    excluded: number;
    /** TRA-1991 — of `excluded`, how many were dropped as `cost_uneconomic`. */
    excludedCostUneconomic: number;
    /**
     * TRA-1991 — mean cost-efficiency ratio (cost ÷ max-loss) across ALL surfaced
     * outcomes with a positive max-loss denominator. Null when none have one.
     * Inspectable proxy for "how close to the cost floor is the surfaced slate".
     */
    avgCostEfficiencyRatio: number | null;
    wins: number;
    losses: number;
    scratches: number;
    hitRate: number | null;
    /** Mean PRE-cost P/L (USD) over included resolved ideas. */
    expectancyUsd: number | null;
    /** Mean PRE-cost R-multiple over included resolved ideas. */
    expectancyR: number | null;
    /** F1 — mean COST-NET P/L (USD) over included resolved ideas. */
    expectancyNetUsd: number | null;
    /** F1 — mean COST-NET R-multiple — the metric the gate evaluates. */
    expectancyNetR: number | null;
    profitFactor: number | null;
    avgPredictedPop: number | null;
    popCalibrationGap: number | null;
    maxLossBreaches: number;
    /** Distinct ISO weeks that have ≥1 (included) resolved idea. */
    weeksWithResolved: number;
    /** Of those, how many had positive PRE-cost R-expectancy. */
    weeksPositiveExpectancy: number;
    /** F1 — of those, how many had positive COST-NET R-expectancy (the gated count). */
    weeksPositiveExpectancyNet: number;
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
  // TRA-678 — only INCLUDED (non-excluded) resolved ideas feed the metrics; a
  // fabricated/stale/no-denom entry is reported separately and never aggregated.
  const resolved = outcomes.filter((o) => o.status === 'resolved' && !o.excluded);
  const wins = resolved.filter((o) => o.win === true);
  const losses = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd < 0);
  const scratches = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd === 0);
  const winPnl = wins.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const lossPnl = losses.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const hitRate = resolved.length ? wins.length / resolved.length : null;
  const expectancyR = mean(resolved.map((o) => o.pnlR ?? 0));
  const expectancyNetR = mean(resolved.map((o) => o.pnlNetR ?? 0));
  const avgPredictedPop = mean(resolved.map((o) => o.pop));
  return {
    week,
    surfaced: outcomes.length,
    resolved: resolved.length,
    open: outcomes.filter((o) => o.status === 'open').length,
    awaitingData: outcomes.filter((o) => o.status === 'awaiting_data').length,
    noData: outcomes.filter((o) => o.status === 'no_data').length,
    excluded: outcomes.filter((o) => o.excluded).length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    hitRate: hitRate == null ? null : r2(hitRate),
    expectancyUsd: mean(resolved.map((o) => o.pnlUsd ?? 0)),
    expectancyR: expectancyR == null ? null : r2(expectancyR),
    expectancyNetUsd: mean(resolved.map((o) => o.pnlNetUsd ?? 0)),
    expectancyNetR: expectancyNetR == null ? null : r2(expectancyNetR),
    avgWinUsd: wins.length ? r2(winPnl / wins.length) : null,
    avgLossUsd: losses.length ? r2(lossPnl / losses.length) : null,
    profitFactor: losses.length && lossPnl !== 0 ? r2(winPnl / Math.abs(lossPnl)) : null,
    avgPredictedPop: avgPredictedPop == null ? null : r2(avgPredictedPop),
    popCalibrationGap: hitRate != null && avgPredictedPop != null ? r2(hitRate - avgPredictedPop) : null,
    maxLossBreaches: resolved.filter((o) => o.maxLossBreached).length,
    positiveExpectancy: expectancyR != null && expectancyR > 0,
    positiveExpectancyNet: expectancyNetR != null && expectancyNetR > 0,
  };
}

const METHODOLOGY =
  'Each surfaced idea is captured at generation time (entry net/max-loss the panel showed = a paper mid-fill), ' +
  'then re-priced ONLY against option chains the recorder wrote on/after the surface date (no look-ahead). ' +
  'Resolved = held to expiry and settled at intrinsic value vs the recorded settlement-day spot; open = ' +
  'marked-to-market at the latest chain that prices every leg. P/L = structure liquidation value + entry net. ' +
  'COSTS (TRA-678 F1): entry/exit marks are MIDs, so the raw R is PRE-cost and optimistically biased. A ' +
  'conservative round-trip transaction-cost haircut (commission + half bid/ask spread per leg, entry and exit) ' +
  'is modeled; expectancy is reported BOTH pre-cost and cost-NET, and the live-capital gate evaluates the ' +
  'NET R-expectancy. A future live-wiring proposal must still re-validate costs against realized fills. ' +
  'Hit-rate = wins ÷ resolved; expectancy is reported in USD/1-lot and as an R-multiple (P/L ÷ defined max-loss). ' +
  'DATA HYGIENE (TRA-678 F2/F3/F4): ideas whose legs could not be priced off real marks (thin-chain fallback ' +
  'placeholders), whose defined max-loss is non-positive, or whose settlement chain lagged expiry by more than ' +
  'one trading day (drifted spot) are reported but EXCLUDED from every gate metric. ' +
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

  // TRA-678 — aggregate only INCLUDED (non-excluded) resolved ideas.
  const resolved = outcomes.filter((o) => o.status === 'resolved' && !o.excluded);
  const wins = resolved.filter((o) => o.win === true);
  const losses = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd < 0);
  const scratches = resolved.filter((o) => o.pnlUsd != null && o.pnlUsd === 0);
  const winPnl = wins.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const lossPnl = losses.reduce((a, o) => a + (o.pnlUsd ?? 0), 0);
  const hitRate = resolved.length ? wins.length / resolved.length : null;
  const expectancyR = mean(resolved.map((o) => o.pnlR ?? 0));
  const expectancyNetR = mean(resolved.map((o) => o.pnlNetR ?? 0));
  const avgPredictedPop = mean(resolved.map((o) => o.pop));
  const weeksWithResolved = weeks.filter((w) => w.resolved > 0);
  // TRA-1991 — cost-efficiency inspection over ALL surfaced outcomes (not just
  // included/resolved): the surfaced slate's mean cost/max-loss ratio + the count
  // dropped as uneconomic make the gate's cost haircut directly auditable.
  const costRatios = outcomes.map((o) => o.costEfficiencyRatio).filter((x): x is number => x != null);
  const avgCostEfficiencyRatio = costRatios.length ? r2(mean(costRatios) ?? 0) : null;

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
      excluded: outcomes.filter((o) => o.excluded).length,
      excludedCostUneconomic: outcomes.filter((o) => o.excludeReason === 'cost_uneconomic').length,
      avgCostEfficiencyRatio,
      wins: wins.length,
      losses: losses.length,
      scratches: scratches.length,
      hitRate: hitRate == null ? null : r2(hitRate),
      expectancyUsd: mean(resolved.map((o) => o.pnlUsd ?? 0)),
      expectancyR: expectancyR == null ? null : r2(expectancyR),
      expectancyNetUsd: mean(resolved.map((o) => o.pnlNetUsd ?? 0)),
      expectancyNetR: expectancyNetR == null ? null : r2(expectancyNetR),
      profitFactor: losses.length && lossPnl !== 0 ? r2(winPnl / Math.abs(lossPnl)) : null,
      avgPredictedPop: avgPredictedPop == null ? null : r2(avgPredictedPop),
      popCalibrationGap:
        hitRate != null && avgPredictedPop != null ? r2(hitRate - avgPredictedPop) : null,
      maxLossBreaches: resolved.filter((o) => o.maxLossBreached).length,
      weeksWithResolved: weeksWithResolved.length,
      weeksPositiveExpectancy: weeksWithResolved.filter((w) => w.positiveExpectancy).length,
      weeksPositiveExpectancyNet: weeksWithResolved.filter((w) => w.positiveExpectancyNet).length,
    },
    weeks,
    methodology: METHODOLOGY,
  };
}

// ── TRA-1971 (TRA-1965) — accumulation monitor ────────────────────────────────
//
// The live-capital gate is stuck at 0/6 not because the strategy is bad but
// because the forward-test RECORD is empty: both accumulation feeds must be on
// AND writing to the DURABLE data dir before the ≥8-week clock can even start.
// This is the pure shape behind `GET /api/health/options-accumulation`: it makes
// accumulation progress visible without manual polling — the first/last recorded
// chain date, the first/last journaled idea date, the current
// surfaced/resolved/weeksWithResolved counts, and — for at-a-glance ops — WHY the
// clock has or hasn't started (which feed's credential is unset, which artifact
// is still missing). Secrets-free: it reports whether each credential is
// CONFIGURED as a boolean, never the value.

/** Snapshot of AI-Options-Ideas forward-test accumulation progress. */
export interface AccumulationMonitor {
  asOfDate: string;
  /** Whether each accumulation feed's credential is configured (never the value). */
  feeds: {
    /** `TRADIER_API_TOKEN` present → the daily chain recorder can write. */
    tradierConfigured: boolean;
    /** `ANTHROPIC_API_KEY` present → the live ideas pass can surface + journal. */
    anthropicConfigured: boolean;
  };
  chains: {
    /** The durable chain-recorder output root the report read from. */
    outDir: string;
    /** Count of date-partitioned chain snapshots on disk. */
    partitionDays: number;
    /** Earliest recorded chain partition date (ET, YYYY-MM-DD), or null if none. */
    firstRecordedDate: string | null;
    /** Latest recorded chain partition date, or null if none. */
    lastRecordedDate: string | null;
  };
  journal: {
    /** Count of journaled surfaced ideas. */
    ideaCount: number;
    /** ET date the first idea was journaled, or null if none. */
    firstJournaledDate: string | null;
    /** ET date the most recent idea was journaled, or null if none. */
    lastJournaledDate: string | null;
  };
  accumulation: {
    surfaced: number;
    resolved: number;
    open: number;
    excluded: number;
    /** TRA-1991 — of `excluded`, how many were dropped as `cost_uneconomic`. */
    costUneconomicExcluded: number;
    /** TRA-1991 — mean cost ÷ max-loss across surfaced ideas (null when none priced). */
    avgCostEfficiencyRatio: number | null;
    weeksWithResolved: number;
    weeksPositiveExpectancyNet: number;
    expectancyNetR: number | null;
  };
  gate: {
    minWeeksWithResolved: number;
    minResolvedIdeas: number;
    /** Weeks-with-resolved still needed to clear the gate's sample-window bar. */
    weeksRemaining: number;
    /** Resolved ideas still needed to clear the gate's sample-size floor. */
    resolvedRemaining: number;
  };
  clock: {
    /** True once BOTH feeds have produced their first durable artifact. */
    started: boolean;
    /** Machine-readable reasons the clock hasn't started (empty once started). */
    blockedOn: string[];
  };
}

/**
 * Assemble the accumulation monitor from already-computed inputs. Pure — no I/O,
 * no `Date.now()`, no `process.env` reads — so the route stays a thin adapter and
 * the interesting logic (blocked-reason derivation, gate remaining-to-threshold
 * clamping) is unit-testable in isolation. `chainDates` is the ascending list of
 * recorded partition dates (as `loadChainDays` returns them); the journal scalars
 * are pre-extracted so this stays decoupled from the entry shape.
 */
export function buildAccumulationMonitor(input: {
  report: ForwardTestReport;
  /** Gate thresholds (subset) — passed in to avoid a live-capital-gate import cycle. */
  gate: { minWeeksWithResolved: number; minResolvedIdeas: number };
  chainOutDir: string;
  /** Recorded chain partition dates, ascending. */
  chainDates: readonly string[];
  journalCount: number;
  firstJournaledDate: string | null;
  lastJournaledDate: string | null;
  tradierConfigured: boolean;
  anthropicConfigured: boolean;
}): AccumulationMonitor {
  const t = input.report.totals;
  const firstRecordedDate = input.chainDates[0] ?? null;
  const lastRecordedDate =
    input.chainDates.length > 0 ? input.chainDates[input.chainDates.length - 1] : null;

  // The clock starts only once BOTH feeds have produced their first durable
  // artifact on disk. Surface the specific reasons it hasn't so ops reads
  // "why 0/6" directly instead of inferring it from empty counts.
  const blockedOn: string[] = [];
  if (!input.tradierConfigured) blockedOn.push('tradier_token_unset');
  if (!input.anthropicConfigured) blockedOn.push('anthropic_key_unset');
  if (firstRecordedDate === null) blockedOn.push('no_chain_partitions');
  if (input.firstJournaledDate === null) blockedOn.push('no_journaled_ideas');
  const started = firstRecordedDate !== null && input.firstJournaledDate !== null;

  return {
    asOfDate: input.report.asOfDate,
    feeds: {
      tradierConfigured: input.tradierConfigured,
      anthropicConfigured: input.anthropicConfigured,
    },
    chains: {
      outDir: input.chainOutDir,
      partitionDays: input.chainDates.length,
      firstRecordedDate,
      lastRecordedDate,
    },
    journal: {
      ideaCount: input.journalCount,
      firstJournaledDate: input.firstJournaledDate,
      lastJournaledDate: input.lastJournaledDate,
    },
    accumulation: {
      surfaced: t.surfaced,
      resolved: t.resolved,
      open: t.open,
      excluded: t.excluded,
      costUneconomicExcluded: t.excludedCostUneconomic,
      avgCostEfficiencyRatio: t.avgCostEfficiencyRatio,
      weeksWithResolved: t.weeksWithResolved,
      weeksPositiveExpectancyNet: t.weeksPositiveExpectancyNet,
      expectancyNetR: t.expectancyNetR,
    },
    gate: {
      minWeeksWithResolved: input.gate.minWeeksWithResolved,
      minResolvedIdeas: input.gate.minResolvedIdeas,
      weeksRemaining: Math.max(0, input.gate.minWeeksWithResolved - t.weeksWithResolved),
      resolvedRemaining: Math.max(0, input.gate.minResolvedIdeas - t.resolved),
    },
    clock: { started, blockedOn },
  };
}

// ── TRA-1971 — weekly roll-up (item 5) ────────────────────────────────────────
//
// The parent's "publish the weekly roll-up" deliverable. A weekly scheduler hook
// (see index.ts) renders this markdown from the forward-test report + gate verdict
// + accumulation monitor and publishes it to the Stocks → News tab via the
// in-process research store, so the live-capital-gate track record is auditable
// weekly WITHOUT manual polling or an admin-token HTTP hop. Pure (no I/O) so the
// content is unit-testable.

const fmtR = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));
const fmtPct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

/** Render the AI-Options-Ideas weekly forward-test roll-up as News-tab markdown. */
export function renderWeeklyRollupMarkdown(input: {
  monitor: AccumulationMonitor;
  report: ForwardTestReport;
  gatePassed: boolean;
  gateSummary: string;
}): string {
  const { monitor: m, report } = input;
  const t = report.totals;
  const clockLine = m.clock.started
    ? `▶ **Accumulation clock: STARTED** (first chain ${m.chains.firstRecordedDate}, first idea ${m.journal.firstJournaledDate})`
    : `⏸ **Accumulation clock: NOT started** — blocked on: ${m.clock.blockedOn.join(', ') || 'unknown'}`;

  const lines: string[] = [];
  lines.push(`## AI Options Ideas — Forward-Test Roll-Up`);
  lines.push('');
  lines.push(`_As of ${report.asOfDate}. Read-only track record for the live-capital gate — wires no capital._`);
  lines.push('');
  lines.push(clockLine);
  lines.push('');
  lines.push(`**Live-capital gate:** ${input.gatePassed ? '✅ PASS' : '⛔ HOLD'} — ${input.gateSummary}`);
  lines.push('');
  lines.push(`### Accumulation progress`);
  lines.push('');
  lines.push(`| Metric | Current | Gate bar | Remaining |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  lines.push(`| Weeks with resolved ideas | ${t.weeksWithResolved} | ${m.gate.minWeeksWithResolved} | ${m.gate.weeksRemaining} |`);
  lines.push(`| Resolved ideas | ${t.resolved} | ${m.gate.minResolvedIdeas} | ${m.gate.resolvedRemaining} |`);
  lines.push(`| Surfaced (journaled) | ${t.surfaced} | — | — |`);
  lines.push(`| Open / awaiting settle | ${t.open} | — | — |`);
  lines.push(`| Excluded (data hygiene) | ${t.excluded} | — | — |`);
  lines.push('');
  lines.push(`**Cost-net expectancy (R):** ${fmtR(t.expectancyNetR)} · **Weeks positive (net):** ${t.weeksPositiveExpectancyNet}/${t.weeksWithResolved} · **Hit-rate:** ${fmtPct(t.hitRate)}`);
  lines.push('');
  // TRA-1991 — surface the cost-efficiency effect so the net-R haircut is auditable.
  lines.push(`**Cost-efficiency (TRA-1991):** avg cost/max-loss ${fmtR(t.avgCostEfficiencyRatio)} · ${t.excludedCostUneconomic} idea(s) excluded as cost-uneconomic (cost > ${Math.round(COST_EFFICIENCY_MAX * 100)}% of defined risk)`);
  lines.push('');
  lines.push(`### Feeds`);
  lines.push('');
  lines.push(`- Chain recorder (Tradier): ${m.feeds.tradierConfigured ? 'configured' : 'NOT configured'} — ${m.chains.partitionDays} partition day(s) on disk${m.chains.lastRecordedDate ? `, latest ${m.chains.lastRecordedDate}` : ''}`);
  lines.push(`- Ideas pass (Anthropic): ${m.feeds.anthropicConfigured ? 'configured' : 'NOT configured'} — ${m.journal.ideaCount} idea(s) journaled${m.journal.lastJournaledDate ? `, latest ${m.journal.lastJournaledDate}` : ''}`);

  // Most-recent weeks (up to 6), newest first, so the roll-up reads at a glance.
  const recent = [...report.weeks].slice(-6).reverse();
  if (recent.length > 0) {
    lines.push('');
    lines.push(`### Recent weeks`);
    lines.push('');
    lines.push(`| Week | Resolved | Hit-rate | Net R |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const w of recent) {
      lines.push(`| ${w.week} | ${w.resolved} | ${fmtPct(w.hitRate)} | ${fmtR(w.expectancyNetR)} |`);
    }
  }
  lines.push('');
  lines.push(`_Methodology: no look-ahead; each idea re-priced only against chains recorded on/after its surface date. Gate evaluates the cost-NET R-expectancy. A pass is permission to PROPOSE live wiring — nothing is auto-wired._`);
  return lines.join('\n');
}
