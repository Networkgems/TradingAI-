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
import {
  buildPopCalibrationSummary,
  DEFAULT_POP_CALIBRATION_CONFIG,
  type PopCalibrationConfig,
  type PopCalibrationSummary,
} from './options-pop-calibration.js';
import {
  buildIvSeriesFromChains,
  reconstructIvRankAt,
  MAX_IV_STALENESS_DAYS,
  type IvRankSource,
  type ReconstructionMiss,
} from './iv-rank-archive.js';
import { MIN_IV_SAMPLES, type IvSample } from './iv-rank-store.js';
// TRA-2335 — the payoff-ceiling feasibility precondition. Leaf module: pure, no I/O,
// no env, and imported by BOTH gate sites, so it adds no cycle.
import {
  computeBookCeiling,
  evaluateFeasibility,
  type FeasibilityResult,
  type RewardSourceCounts,
} from './gate-feasibility.js';
// TRA-2208 — the floor + its governed families, imported (not restated) so the
// counterfactual this probe reports is measured against the exact bar the emission
// gate enforces. See `CellCreditWidthFloor`.
import { DEFAULT_CREDIT_WIDTH_FLOOR, FLOORED_CREDIT_STRUCTURES } from '@trading-app/agents';

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
  /**
   * TRA-2004 — days-to-expiration at surface time, carried from the journal entry
   * so the decomposition probe can slice by DTE bucket. Optional (absent on legacy
   * outcomes / hand-built test fixtures) → those land in the `unknown` DTE cell.
   */
  dte?: number | null;
  /**
   * TRA-2004 — IV-rank (0–100) at surface time, carried from the journal entry so
   * the decomposition probe can slice by IV-rank bucket. Null/absent when unknown
   * → those land in the `unknown` IV-rank cell.
   *
   * TRA-2206 — may ALSO be back-filled from the recorded chain archive when the
   * journal stamp is null (the trailing-IV store was still cold at surface time).
   * The reconstruction is backward-only; see {@link ivRankSource} for provenance.
   */
  ivRank?: number | null;
  /**
   * TRA-2206 — provenance of {@link ivRank}: `journal` (stamped live at surface
   * time), `reconstructed` (re-derived from chain partitions dated at/before the
   * surface date — no look-ahead), or `unknown` (neither available). Present only
   * once the reconstruction pass has run; absent on hand-built fixtures.
   */
  ivRankSource?: IvRankSource;
  /** TRA-2206 — why reconstruction produced nothing. Set only when `ivRankSource === 'unknown'`. */
  ivRankMiss?: ReconstructionMiss | null;
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

/**
 * TRA-2335 — 4-dp rounding for the feasibility figures. The reporting figures round
 * to 2 dp, which is far too coarse here: the live credit book's gross ceiling is
 * `+0.0380R` and its cost-net ceiling `≈ −0.001R`, both of which 2-dp rounding
 * collapses to `0.04` / `-0.00` and destroys the comparison the gate turns on.
 */
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

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
    // TRA-2004 — carry DTE + IV-rank for the decomposition slices. Legacy journal
    // entries may lack a finite dte → null (lands in the `unknown` bucket).
    dte: typeof entry.dte === 'number' && Number.isFinite(entry.dte) ? entry.dte : null,
    ivRank: entry.ivRank ?? null,
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
 * TRA-2206 — stamp IV-rank provenance on already-valued outcomes, back-filling
 * `ivRank` from the chain archive wherever the journal stamp is null.
 *
 * Pure given `ivSeries`, so the no-look-ahead property is unit-testable in
 * isolation. Precedence is journal-first: a live stamp is never overwritten by a
 * reconstruction, so this can only ADD coverage, never revise a recorded value.
 * A row that cannot be reconstructed keeps `ivRank: null` and carries the reason
 * — the decomposition's `unknown` bucket stays honest rather than being papered
 * over with a synthesised number.
 */
export function applyIvRankReconstruction(
  outcomes: readonly IdeaOutcome[],
  ivSeries: ReadonlyMap<string, readonly IvSample[]>,
): IdeaOutcome[] {
  return outcomes.map((o) => {
    if (o.ivRank != null && Number.isFinite(o.ivRank)) {
      return { ...o, ivRankSource: 'journal' as const, ivRankMiss: null };
    }
    const series = ivSeries.get(o.ticker.toUpperCase()) ?? [];
    const r = reconstructIvRankAt(series, o.surfacedDate);
    if (r.ivRank == null) {
      return { ...o, ivRank: null, ivRankSource: 'unknown' as const, ivRankMiss: r.miss };
    }
    return {
      ...o,
      ivRank: r2(r.ivRank),
      ivRankSource: 'reconstructed' as const,
      ivRankMiss: null,
    };
  });
}

/**
 * Forward-test every journaled idea against the recorded chains under `dataDir`.
 * Loads the chain history once and values each idea. Returns outcomes in journal
 * order.
 *
 * TRA-2206 — the same already-loaded `chainDays` also feed the IV-rank
 * reconstruction pass, so back-filling costs no extra I/O. Read-only: it stamps
 * a diagnostic field on the returned outcomes and never writes the journal.
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
  const valued = entries.map((e) => valueIdea(e, chainDays, asOf, costModel));
  const ivSeries = buildIvSeriesFromChains(chainDays, estimateSpotFromChain);
  return applyIvRankReconstruction(valued, ivSeries);
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
    /**
     * TRA-2335 — mean cost ÷ max-loss over the GRADED set only (the same
     * `status === 'resolved' && !excluded` population every expectancy above is
     * averaged over). The sibling of `avgCostEfficiencyRatio`, which spans ALL
     * SURFACED outcomes — a different, larger population. The feasibility check
     * nets cost off a ceiling computed on the graded set, so it must use THIS
     * one: a ceiling from one population compared against a measurement from
     * another is not a comparison. Cross-checks to `expectancyR − expectancyNetR`
     * within ±0.01 (both sides are 2-dp rounded, so not to equality).
     */
    avgCostR: number | null;
    /**
     * TRA-2335 — the graded book's PAYOFF CEILING: `mean(maxProfitUsd ÷ maxLossUsd)`
     * over the graded set. Because loss is pinned at −1R, realized `pnlR ≤ rewardR`
     * holds pathwise, so this bounds `expectancyR` as an accounting identity. An
     * UPPER bound (fabricated sketch-cap rewards are included at their inflated
     * value), which is what makes an `INFEASIBLE` verdict derived from it sound.
     */
    ceilingGrossR: number | null;
    /** TRA-2335 — cost-NET ceiling = `ceilingGrossR − avgCostR`; bounds `expectancyNetR`. */
    ceilingNetR: number | null;
    /** TRA-2335 — ceiling over the `priced_structure` subset only (no fabricated rewards). */
    ceilingGrossRPriced: number | null;
    /**
     * TRA-2335 — reward-provenance histogram. A bare ceiling reads IDENTICALLY
     * whether it came from real prices or a `long_call` 2×-debit sketch cap; that
     * indistinguishability is what let a 5.3×-unreachable bar run for four weeks.
     */
    ceilingSourceCounts: RewardSourceCounts;
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
    /**
     * TRA-2006 — mean CALIBRATED POP over included resolved ideas (each stated POP
     * mapped through the post-calibration fit). Null when none resolved.
     */
    avgCalibratedPop: number | null;
    /**
     * TRA-2006 — `hitRate − avgCalibratedPop`: the POP-calibration gap measured
     * against the CALIBRATED POP. SHADOW: the gate scores `popCalibrationGap` (raw)
     * unless `ENABLE_POP_CALIBRATION` is set. Retained alongside raw for audit.
     */
    popCalibrationGapCalibrated: number | null;
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
  /**
   * TRA-2004 — per-cell decomposition of the RESOLVED (non-excluded) idea set,
   * sliced by structure / DTE bucket / IV-rank bucket / ticker. The `overall`
   * cell reconciles with `totals` (gross `expectancyR`, net `expectancyNetR`,
   * calib `popCalibrationGap`) — same resolved-and-included basis. Diagnostic
   * only; wires nothing.
   */
  decomposition: IdeasDecomposition;
  /**
   * TRA-2006 — POP post-calibration audit: the fit (flat / isotonic), raw-vs-
   * calibrated mean POP, and both gaps over the same resolved-and-included set.
   * `avgStatedPop`/`rawGap` reconcile with `totals.avgPredictedPop`/
   * `totals.popCalibrationGap`; `avgCalibratedPop`/`calibratedGap` reconcile with
   * `totals.avgCalibratedPop`/`totals.popCalibrationGapCalibrated`. SHADOW —
   * surfaced regardless of the flag; the gate consumes it only when enabled.
   */
  popCalibration: PopCalibrationSummary;
  /** Methodology + look-ahead note, surfaced to the report consumer/QA. */
  methodology: string;
}

// ── TRA-2004 (TRA-2000) — per-cell decomposition of the resolved idea set ──────
//
// Read-only diagnostic (no live wiring — that is TRA-1985). QuantTrader needs to
// LOCATE the gross-edge leak (which structure/DTE/IVR/ticker bleeds R) and FIT the
// POP calibration map (where stated POP diverges from the realized hit-rate). The
// gate's `totals` roll everything into one number; this decomposes the SAME
// resolved-and-included set into marginal slices so the leak is attributable.
//
// Basis: RESOLVED and NON-excluded outcomes only — identical to the filter the
// live-capital gate aggregates — so the `overall` cell reconciles exactly with the
// gate's gross/net R and calibration gap. Marginal 1-D slices (not the full
// cross-product, which is mostly n=1 at these sample sizes) keep every cell large
// enough to read.

/** One decomposition cell — a slice of the resolved idea set. Null-never-0. */
export interface DecompositionCell {
  /** Bucket label (structure id, DTE/IVR bucket, ticker, or `overall`). */
  key: string;
  /** Resolved, non-excluded ideas in this cell. */
  n: number;
  /** Mean PRE-cost R (`pnlR`) — the gross edge. Null when the cell is empty. */
  grossR: number | null;
  /** Mean COST-NET R (`pnlNetR`) — the gated edge. Null when empty. */
  netR: number | null;
  /** Mean stated model POP (0–1). Null when empty. */
  meanPop: number | null;
  /** Realized hit-rate (wins ÷ n). Null when empty. */
  hitRate: number | null;
  /** `hitRate − meanPop`: + = POP under-promised, − = over-promised. Null when empty. */
  popCalibrationGap: number | null;
  /**
   * Mean credit/width = `entryNetUsd ÷ (maxProfitUsd + maxLossUsd)` (signed:
   * + = net credit as a fraction of defined width, − = net debit). Averaged over
   * cell members with a positive width denominator. Null when none have one.
   */
  meanCreditWidth: number | null;
  /**
   * TRA-2208 — how much of THIS cell's realized credit book would have survived the
   * hard credit/width floor. Null when the cell holds no floored credit structure
   * (debit families are out of the floor's scope, so a null here means "not
   * governed", never "nothing survived").
   */
  creditWidthFloor: CellCreditWidthFloor | null;
}

/**
 * TRA-2208 — the counterfactual the CUT/continue fork on TRA-1965 turns on, applied
 * to the REALIZED book rather than to future emissions.
 *
 * WHY IT LIVES HERE. The emission-side floor (`options-idea-credit-width-floor.ts`)
 * can only report a survival rate once it has been deployed and has accrued fresh
 * slates. The resolved journal already holds the answer for the book we actually
 * traded: every resolved idea carries `entryNetUsd` and its defined width, so the
 * floor can be replayed over it exactly. This column is that replay — read-only,
 * flag-INDEPENDENT (it measures the book, not the gate), and available the moment
 * the probe is reachable.
 *
 * A floored structure whose entry collected no net credit counts as a NON-survivor,
 * mirroring the emission gate's `unpriced` verdict: an unverifiable credit entry
 * cannot clear a hard floor, and excluding it would flatter the rate.
 */
export interface CellCreditWidthFloor {
  /** The floor replayed — the same constant the emission gate enforces. */
  floor: number;
  /** Cell members belonging to a floored credit family. */
  n: number;
  /** Of `n`, how many collected at least `floor` of their defined width. */
  pass: number;
  /** `pass / n`, 0–1, rounded to 2dp. Null when `n === 0` (never a fabricated 0). */
  survivalRate: number | null;
}

/** The full per-cell decomposition returned by {@link buildIdeasDecomposition}. */
export interface IdeasDecomposition {
  asOfDate: string;
  /** Resolved, non-excluded ideas the decomposition is fit on (reconciles w/ the gate). */
  n: number;
  /** Overall row over the whole resolved-and-included set — reconciles with `totals`. */
  overall: DecompositionCell;
  /** By engine structure id (bull_put / bear_call / iron_condor / long_call / …). */
  byStructure: DecompositionCell[];
  /** By DTE bucket (≤14 / 15–30 / 31–45 / >45 / unknown). */
  byDteBucket: DecompositionCell[];
  /** By IV-rank-at-entry bucket (<25 / 25–50 / 50–75 / >75 / unknown). */
  byIvRankBucket: DecompositionCell[];
  /** By ticker / universe. */
  byTicker: DecompositionCell[];
  /**
   * TRA-2206 — first-class IV-rank COVERAGE over the same resolved-and-included
   * set. `byIvRankBucket` alone shows the `unknown` cell's size but not whether
   * an IVR-conditioned read is ADMISSIBLE; this is that admissibility number.
   */
  ivRankCoverage: IvRankCoverage;
  /** Methodology + reconciliation note. */
  note: string;
}

/**
 * TRA-2206 — how much of the resolved cohort carries a usable IV-rank, split by
 * provenance and, for the remainder, by the reason it could not be obtained.
 *
 * Read this BEFORE reading any IVR-conditioned cell. At `pct` well below 100 the
 * IV-rank slices describe a minority sub-cohort, and — because the TRA-2005
 * expectancy gate treats an unknown IV-rank as a hard fail at check 3 of 6 — the
 * missing rows are exactly the ones whose expectancy was never evaluated. A
 * shadow-ledger drop-rate read against low coverage measures data completeness,
 * not edge.
 */
export interface IvRankCoverage {
  /** Resolved, non-excluded ideas the coverage is computed over (= `IdeasDecomposition.n`). */
  n: number;
  /** Rows carrying a usable IV-rank from either source. */
  stamped: number;
  /** Rows with no usable IV-rank — the `unknown` bucket. */
  unknown: number;
  /** `stamped / n` as a 0–100 percentage, rounded to 2dp. Null when `n === 0`. */
  pct: number | null;
  /** Of `stamped`, how many were stamped live at surface time by `ivRankSync`. */
  fromJournal: number;
  /** Of `stamped`, how many were back-filled from the chain archive (no look-ahead). */
  reconstructed: number;
  /** Of `unknown`, a count per reason the backward-only reconstruction produced nothing. */
  unknownReasons: Record<string, number>;
  /** The sample floor a trailing window must clear before any rank is emitted. */
  minSamples: number;
  /** Max calendar-day gap allowed between surface date and the IV read used. */
  maxStalenessDays: number;
  /** Method statement — how the back-filled values were obtained, and why they are sound. */
  method: string;
}

const IV_RANK_METHOD_NOTE =
  'TRA-2206. `journal` rows carry the IV-rank `ivRankSync` stamped live at surface time. ' +
  '`reconstructed` rows were RE-DERIVED, not synthesised: for each idea we take the ' +
  'at-the-money IV of every recorded option-chain partition (the daily recorder writes ' +
  '<DATA_DIR>/option-chains/<ET-DATE>/<SYMBOL>.json, each stamped with its OWN capture date), ' +
  'filter that series to `day <= surfacedDate`, and rank the newest surviving sample against ' +
  'the trailing 366d of the same backward-only window. Because the filter precedes every ' +
  'computation and each sample is dated by its capture day, a reconstructed rank uses only ' +
  'information available at surface time — NO LOOK-AHEAD. The floor (>= minSamples in-window, ' +
  'non-flat range) and the trailing window are identical to the live `ivRankSync` path, so a ' +
  'reconstructed value is the SAME statistic, not a differently-scoped proxy. Where the ' +
  'backward window cannot support a rank the row stays `unknown` with a reason — a ' +
  'look-ahead-contaminated IV-rank would be strictly worse than a null, because it would ' +
  'silently poison every IVR-conditioned grade downstream. Journal stamps are never overwritten.';

/** Build the coverage block from resolved, non-excluded outcomes. Pure. */
export function buildIvRankCoverage(resolved: readonly IdeaOutcome[]): IvRankCoverage {
  const n = resolved.length;
  const has = (o: IdeaOutcome): boolean => o.ivRank != null && Number.isFinite(o.ivRank);
  const stamped = resolved.filter(has).length;
  const fromJournal = resolved.filter((o) => has(o) && o.ivRankSource === 'journal').length;
  const reconstructed = resolved.filter((o) => has(o) && o.ivRankSource === 'reconstructed').length;
  const unknownReasons: Record<string, number> = {};
  for (const o of resolved) {
    if (has(o)) continue;
    // A hand-built fixture / pre-TRA-2206 outcome carries no miss reason; label it
    // rather than dropping it, so the reasons always sum to `unknown`.
    const reason = o.ivRankMiss ?? 'not_evaluated';
    unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
  }
  return {
    n,
    stamped,
    unknown: n - stamped,
    pct: n ? r2((stamped / n) * 100) : null,
    fromJournal,
    reconstructed,
    unknownReasons,
    minSamples: MIN_IV_SAMPLES,
    maxStalenessDays: MAX_IV_STALENESS_DAYS,
    method: IV_RANK_METHOD_NOTE,
  };
}

/** Fixed display order for the DTE buckets (unknown last). */
const DTE_BUCKET_ORDER = ['≤14', '15–30', '31–45', '>45', 'unknown'] as const;
/** Fixed display order for the IV-rank buckets (unknown last). */
const IVR_BUCKET_ORDER = ['<25', '25–50', '50–75', '>75', 'unknown'] as const;

function dteBucket(dte: number | null | undefined): string {
  if (dte == null || !Number.isFinite(dte)) return 'unknown';
  if (dte <= 14) return '≤14';
  if (dte <= 30) return '15–30';
  if (dte <= 45) return '31–45';
  return '>45';
}

function ivRankBucket(ivr: number | null | undefined): string {
  if (ivr == null || !Number.isFinite(ivr)) return 'unknown';
  if (ivr < 25) return '<25';
  if (ivr < 50) return '25–50';
  if (ivr < 75) return '50–75';
  return '>75';
}

/** Signed credit/width ratio, or null when the defined width is non-positive. */
function creditWidthRatio(o: IdeaOutcome): number | null {
  const width = o.maxProfitUsd + o.maxLossUsd;
  return width > 0 ? o.entryNetUsd / width : null;
}

/**
 * TRA-2208 — replay the emission floor over a cell's realized credit members. The
 * floor constant is IMPORTED from the emission gate rather than restated, so the
 * bar QuantTrader grades against here can never drift from the bar the engine
 * actually enforces. Returns null when the cell governs no credit structure.
 */
function cellCreditWidthFloor(os: readonly IdeaOutcome[]): CellCreditWidthFloor | null {
  const governed = os.filter((o) => FLOORED_CREDIT_STRUCTURES.has(o.strategy));
  if (governed.length === 0) return null;
  const pass = governed.filter((o) => {
    const r = creditWidthRatio(o);
    // A non-positive / unformable ratio is a non-survivor, not an exclusion —
    // see the `CellCreditWidthFloor` doc on the `unpriced` mirror.
    return r != null && r >= DEFAULT_CREDIT_WIDTH_FLOOR;
  }).length;
  return {
    floor: DEFAULT_CREDIT_WIDTH_FLOOR,
    n: governed.length,
    pass,
    survivalRate: r2(pass / governed.length),
  };
}

/**
 * Build one decomposition cell from a set of resolved, non-excluded outcomes.
 * Gross/net R use the SAME `?? 0` fold the gate's `statsFor` uses, so a cell over
 * the full set reproduces the gate's `expectancyR`/`expectancyNetR` exactly.
 */
function cellFor(key: string, os: readonly IdeaOutcome[]): DecompositionCell {
  const n = os.length;
  const wins = os.filter((o) => o.win === true).length;
  const grossR = mean(os.map((o) => o.pnlR ?? 0));
  const netR = mean(os.map((o) => o.pnlNetR ?? 0));
  const meanPop = mean(os.map((o) => o.pop));
  const hitRate = n ? wins / n : null;
  const cw = os.map(creditWidthRatio).filter((x): x is number => x != null);
  const meanCreditWidth = cw.length ? mean(cw) : null;
  return {
    key,
    n,
    grossR: grossR == null ? null : r2(grossR),
    netR: netR == null ? null : r2(netR),
    meanPop: meanPop == null ? null : r2(meanPop),
    hitRate: hitRate == null ? null : r2(hitRate),
    popCalibrationGap: hitRate != null && meanPop != null ? r2(hitRate - meanPop) : null,
    meanCreditWidth: meanCreditWidth == null ? null : r2(meanCreditWidth),
    creditWidthFloor: cellCreditWidthFloor(os),
  };
}

function groupOutcomes(
  os: readonly IdeaOutcome[],
  keyFn: (o: IdeaOutcome) => string,
): Map<string, IdeaOutcome[]> {
  const m = new Map<string, IdeaOutcome[]>();
  for (const o of os) {
    const k = keyFn(o);
    const arr = m.get(k) ?? [];
    arr.push(o);
    m.set(k, arr);
  }
  return m;
}

/** Cells in a fixed bucket order (buckets with no members are omitted, not zero-filled). */
function orderedCells(m: Map<string, IdeaOutcome[]>, order: readonly string[]): DecompositionCell[] {
  return [...m.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, os]) => cellFor(k, os));
}

/** Cells sorted alphabetically by key (structure ids, tickers). */
function alphaCells(m: Map<string, IdeaOutcome[]>): DecompositionCell[] {
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, os]) => cellFor(k, os));
}

const DECOMPOSITION_NOTE =
  'TRA-2004 diagnostic. Cells cover RESOLVED, non-excluded ideas only — the same basis the ' +
  'live-capital gate aggregates — so the `overall` cell reconciles with the gate totals ' +
  '(grossR = expectancyR, netR = expectancyNetR, popCalibrationGap = hitRate − avgPredictedPop). ' +
  'Slices are 1-D marginals (structure / DTE / IV-rank / ticker), NOT the full cross-product, ' +
  'so each cell stays large enough to read at current sample sizes. popCalibrationGap < 0 means ' +
  'stated POP over-promised vs realized hit-rate. Null-never-0: an empty statistic is null, not 0. ' +
  'TRA-2206: read `ivRankCoverage` BEFORE `byIvRankBucket` — at low coverage the IV-rank cells ' +
  'describe a minority sub-cohort, and the missing rows are exactly the ones the TRA-2005 ' +
  'expectancy gate hard-fails at check 3 of 6 without ever evaluating their expectancy. ' +
  'TRA-2208: `creditWidthFloor` REPLAYS the hard credit/width floor over each cell\'s realized ' +
  'credit members — `survivalRate` is the fraction of the book we actually traded that collected ' +
  'at least `floor` of its defined width. It is flag-INDEPENDENT (it measures the book, not the ' +
  'gate) and is the number the TRA-1965 CUT/continue fork turns on. A low survival rate is a ' +
  'valid and informative answer: it says our universe/IV regime does not offer sellable premium ' +
  'at our cost base, NOT that the floor is mis-set. Null on a cell governing no credit family. ' +
  'Read-only; wires no capital.';

/**
 * Decompose the resolved (non-excluded) idea set into marginal slices. Pure given
 * the outcomes; `asOf` only stamps the readout date. Exported so the health probe
 * and unit tests can call it directly.
 */
export function buildIdeasDecomposition(
  outcomes: readonly IdeaOutcome[],
  opts: { asOf?: number } = {},
): IdeasDecomposition {
  const asOf = opts.asOf ?? Date.now();
  const resolved = outcomes.filter((o) => o.status === 'resolved' && !o.excluded);
  return {
    asOfDate: etDateKey(asOf),
    n: resolved.length,
    overall: cellFor('overall', resolved),
    byStructure: alphaCells(groupOutcomes(resolved, (o) => o.strategy)),
    byDteBucket: orderedCells(groupOutcomes(resolved, (o) => dteBucket(o.dte)), DTE_BUCKET_ORDER),
    byIvRankBucket: orderedCells(
      groupOutcomes(resolved, (o) => ivRankBucket(o.ivRank)),
      IVR_BUCKET_ORDER,
    ),
    byTicker: alphaCells(groupOutcomes(resolved, (o) => o.ticker)),
    ivRankCoverage: buildIvRankCoverage(resolved),
    note: DECOMPOSITION_NOTE,
  };
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
  opts: { asOf?: number; chainsDir?: string; popCalibration?: PopCalibrationConfig } = {},
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

  // TRA-2335 — the feasibility precondition's inputs, computed from the SAME
  // `resolved` array above. Deliberately NOT a parallel filter: the looser
  // `maxLossUsd > 0` predicate re-admits the F2 `fallback_priced` entries whose
  // fabricated `maxProfit = maxLoss` gives `rewardR ≡ 1.000` — 26× a real
  // vertical's 0.0380 — which inflates the ceiling until an unreachable bar reads
  // as reachable. That failure is silent and fails OPEN, i.e. it would make the
  // check built to catch this defect report that there is nothing to catch.
  const ceiling = computeBookCeiling(resolved);
  const gradedCostRatios = resolved.map((o) => o.costEfficiencyRatio).filter((x): x is number => x != null);
  const avgCostR = gradedCostRatios.length ? r4(mean(gradedCostRatios) ?? 0) : null;
  const ceilingNetR =
    ceiling.ceilingGrossR == null ? null : r4(ceiling.ceilingGrossR - (avgCostR ?? 0));

  // TRA-2006 — fit the POP post-calibration on the SAME resolved-and-included set
  // (refit on every report build → "refits weekly as the sample grows") and
  // surface raw-vs-calibrated POP. Pure measurement; the gate consumes the
  // calibrated gap only when ENABLE_POP_CALIBRATION is set (SHADOW by default).
  const popCalibration = buildPopCalibrationSummary(
    resolved.map((o) => ({ pop: o.pop, win: o.win === true })),
    opts.popCalibration ?? DEFAULT_POP_CALIBRATION_CONFIG,
  );

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
      // TRA-2335 — feasibility inputs, all over the GRADED set (see above).
      avgCostR,
      ceilingGrossR: ceiling.ceilingGrossR,
      ceilingNetR,
      ceilingGrossRPriced: ceiling.ceilingGrossRPriced,
      ceilingSourceCounts: ceiling.sourceCounts,
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
      // TRA-2006 — calibrated-POP mirror of the two lines above (SHADOW audit).
      avgCalibratedPop: popCalibration.avgCalibratedPop,
      popCalibrationGapCalibrated: popCalibration.calibratedGap,
      maxLossBreaches: resolved.filter((o) => o.maxLossBreached).length,
      weeksWithResolved: weeksWithResolved.length,
      weeksPositiveExpectancy: weeksWithResolved.filter((w) => w.positiveExpectancy).length,
      weeksPositiveExpectancyNet: weeksWithResolved.filter((w) => w.positiveExpectancyNet).length,
    },
    weeks,
    // TRA-2004 — per-cell decomposition of the same resolved-and-included set the
    // totals aggregate, so QuantTrader can locate the gross-edge leak + fit POP.
    decomposition: buildIdeasDecomposition(outcomes, { asOf }),
    // TRA-2006 — POP post-calibration audit (raw vs calibrated); SHADOW.
    popCalibration,
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
    /**
     * Weeks-with-resolved still needed to clear the gate's sample-window bar.
     *
     * TRA-2335 — **null when `feasible === false`.** A countdown is a claim that
     * arriving at zero clears the gate. When the expectancy bar is above the book's
     * payoff ceiling that claim is false at every sample size, and suppressing the
     * number is the point: the countdown was not a passive omission, it was an
     * ACTIVE weekly publication of "N weeks to go" — an artifact whose plain reading
     * is *on track, keep going*. A gate that silently fails is bad; one that
     * publishes a countdown to an event that cannot occur manufactures false
     * confidence on a schedule.
     */
    weeksRemaining: number | null;
    /** Resolved ideas still needed to clear the sample-size floor. Null when infeasible — see above. */
    resolvedRemaining: number | null;
    /** TRA-2335 — the cost-NET expectancy bar the gate grades against. */
    minExpectancyR: number;
    /** TRA-2335 — the book's cost-NET payoff ceiling; `expectancyNetR` cannot exceed it. */
    ceilingNetR: number | null;
    /**
     * TRA-2335 — true only on a clean, fully-priced `feasible` verdict. NOT the flag
     * the countdown keys off: `unknown` (early book, or a ceiling partly derived from
     * sketch caps) leaves `feasible` false while the countdown still renders, because
     * `unknown` is "we cannot tell", not "we have shown it is unreachable".
     */
    feasible: boolean;
    /** TRA-2335 — `feasible` | `infeasible` | `unknown`, with the reason naming both numbers. */
    feasibility: FeasibilityResult;
  };
  clock: {
    /** True once BOTH feeds have produced their first durable artifact. */
    started: boolean;
    /** Machine-readable reasons the clock hasn't started (empty once started). */
    blockedOn: string[];
  };
}

/**
 * TRA-2335 — the book-level feasibility verdict: is `minExpectancyR` reachable at all
 * by the graded book? THE single code path for that question. `live-capital-gate.ts`
 * (criterion 3) and {@link buildAccumulationMonitor} both call this, so the health
 * route's verdict and the weekly roll-up's countdown can never disagree.
 *
 * The gate grades `expectancyNetR` — a cost-NET figure — against a cost-FREE bar, so
 * cost is netted off the CEILING here. (The per-open gate is the mirror image: its bar
 * is cost-INCLUSIVE, so netting there too would double-count. See
 * `evaluatePerOpenFeasibility`.)
 *
 * `provenanceKnown` is false whenever any graded outcome's reward was fabricated by a
 * sketch cap — the verdict may then be `infeasible` (sound: the ceiling is an upper
 * bound) or `unknown`, but never a clean `feasible`.
 */
export function evaluateBookFeasibility(
  report: ForwardTestReport,
  minExpectancyR: number,
): FeasibilityResult {
  const t = report.totals;
  // Tolerate a report built before these fields existed (a persisted snapshot, or a
  // partial hand-built one). Degrade to `unknown` — never throw. This function is on
  // the `/api/health/live-capital-gate` path, and a gate probe that 500s is strictly
  // worse than one that reports "ceiling not established": the 500 removes the whole
  // readout, including the five criteria that are still perfectly measurable.
  const sourceCounts = t.ceilingSourceCounts as RewardSourceCounts | undefined;
  return evaluateFeasibility({
    barR: minExpectancyR,
    ceilingR: t.ceilingNetR ?? null,
    provenanceKnown: sourceCounts != null && sourceCounts.sketch_capped === 0,
    subject: `the graded book (n=${t.resolved})`,
  });
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
  /**
   * Gate thresholds (subset) — passed in to avoid a live-capital-gate import cycle.
   * TRA-2335 — `minExpectancyR` joins them: without it this monitor had no term that
   * could express "the bar is unreachable", so it could only ever count sample.
   */
  gate: { minWeeksWithResolved: number; minResolvedIdeas: number; minExpectancyR: number };
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

  // TRA-2335 — the same verdict criterion 3 publishes, via the same function.
  const feasibility = evaluateBookFeasibility(input.report, input.gate.minExpectancyR);
  const countdownWithheld = feasibility.verdict === 'infeasible';

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
      // TRA-2335 — a countdown asserts that reaching zero clears the gate. Withhold it
      // ONLY on a POSITIVE determination of unreachability (`infeasible`), never on
      // `unknown`. An empty/early book has no ceiling yet and is `unknown` by
      // construction — that is the monitor's normal starting state and its entire
      // reason to exist, so suppressing the countdown there would both destroy the
      // instrument's primary function and fire the alarm every week from day one. A
      // warning that is always on is a warning nobody reads.
      weeksRemaining: countdownWithheld
        ? null
        : Math.max(0, input.gate.minWeeksWithResolved - t.weeksWithResolved),
      resolvedRemaining: countdownWithheld
        ? null
        : Math.max(0, input.gate.minResolvedIdeas - t.resolved),
      minExpectancyR: input.gate.minExpectancyR,
      ceilingNetR: t.ceilingNetR,
      feasible: feasibility.feasible,
      feasibility,
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
/** TRA-2335 — 4 dp: the live ceiling figures (+0.0380 / ≈−0.001) vanish at 2 dp. */
const fmtR4 = (v: number | null): string => (v == null ? 'unknown' : v.toFixed(4));
/**
 * TRA-2335 — a withheld countdown must read as WITHHELD, never as `0` or `n/a`.
 * `0` is the single worst rendering available: it says "you have arrived".
 */
const fmtRemaining = (v: number | null): string => (v == null ? '— (bar unreachable)' : String(v));

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
  // TRA-2335 — when the expectancy bar sits above the book's payoff ceiling, the
  // accumulation countdown is a claim that cannot come true, so it is REPLACED (not
  // annotated) by the reachability statement. Rendering both would let the reader keep
  // the "N weeks to go" reading that four weeks of roll-ups already established.
  if (m.gate.feasibility.verdict === 'infeasible') {
    lines.push(`> ⛔ **Gate not reachable — this is NOT a sample-size problem.** The cost-net expectancy bar is **${m.gate.minExpectancyR.toFixed(2)}R**, but the graded book's cost-net payoff **ceiling is ${fmtR4(m.gate.ceilingNetR)}R** (loss is pinned at −1R; reward is capped at maxProfit ÷ maxLoss, so realized R can never exceed it). **No amount of additional sample can clear this bar** — the accumulation countdown below is withheld because reaching zero would not open the gate. ${m.gate.feasibility.reason}`);
    lines.push('');
  }
  lines.push(`### Accumulation progress`);
  lines.push('');
  lines.push(`| Metric | Current | Gate bar | Remaining |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  lines.push(`| Weeks with resolved ideas | ${t.weeksWithResolved} | ${m.gate.minWeeksWithResolved} | ${fmtRemaining(m.gate.weeksRemaining)} |`);
  lines.push(`| Resolved ideas | ${t.resolved} | ${m.gate.minResolvedIdeas} | ${fmtRemaining(m.gate.resolvedRemaining)} |`);
  lines.push(`| Cost-net expectancy (R) | ${fmtR(t.expectancyNetR)} | > ${m.gate.minExpectancyR.toFixed(2)} | ceiling ${fmtR4(m.gate.ceilingNetR)} |`);
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
