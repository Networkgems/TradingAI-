/**
 * TRA-827 (TRA-825 spec) — cross-sectional momentum portfolio runner.
 *
 * The single-symbol `BacktestRunner` (and the per-symbol pooling that
 * `run-tra523-fee-aware.ts` / `run-tra817-tsmom-majors.ts` use) cannot express
 * a *cross-sectional* signal: ranking N symbols against each other each week and
 * rotating an equal-weight top-K long book needs every symbol advanced on ONE
 * shared clock so the rank is computable at each rebalance. That joint-state
 * loop is the core build of TRA-827.
 *
 * This runner ONLY produces the pooled per-round-trip **net-of-fee R** sequence
 * (`tradeRsNet`) that the *unchanged* TRA-523 keeper gate scores — the harness
 * (`run-tra825-xsmom-liquid.ts`) feeds that sequence to the verbatim
 * `blockBootstrapR` / expectancy code. Nothing here touches the gate, the live
 * engine, or any preset.
 *
 * Mechanics (frozen TRA-825 spec §2):
 *   • Universe ticked together on the merged 4h timeline (warmup → end).
 *   • Rebalance every `rebalanceBars` (42 = weekly on 4h). At each rebalance bar
 *     CLOSE: for every name with a full `L`-bar lookback compute the trailing
 *     total return `r_i = close_t / close_{t-L} − 1`. Eligible-long set
 *     `E = { i : r_i ≥ absFloorPct/100 }` (dual-momentum filter). Target book =
 *     top `min(K, |E|)` of `E` by `r_i`, equal weight.
 *   • Held name not in target → exit (closes a round-trip). Target name not held
 *     → enter. Name in both → hold. Fills at the name's NEXT bar open (no
 *     look-ahead). Long-or-flat; no shorts / leverage; sizing-only protective
 *     stop (1R = one daily vol-target σ, reused from tsmom) — never armed as a
 *     real bracket, so the ONLY exit is a rebalance rank/floor crossing.
 *   • Sizing: VolKellySizer vol-target `volTargetAnnualPct`, risk clamped
 *     [0.5%, 1.75%] — identical conventions to tsmom_majors. (Position size
 *     cancels exactly out of the R denominator `netPnl / (stopDistance·qty)`, so
 *     it only governs realism, not the graded R — but it is wired faithfully.)
 *
 * Cost arithmetic (entry fill at next-bar open + slippage, maker/taker fees,
 * exit at next-bar open + adverse slippage) mirrors `runner.ts` byte-for-byte so
 * a round-trip's net R is identical to what the single-symbol runner would book.
 */

import type { Candle } from '@trading-app/shared';
import {
  RiskManager,
  resolveVolKellySizerConfig,
  effectiveRiskPct,
  trailingRealisedVol,
  tsmomSizingStopFraction,
} from '@trading-app/engine';

/** 4h bars per year (365·24/4) — the realised-vol annualiser for the sizer. */
export const XSMOM_BARS_PER_YEAR_4H = 2190;
/** 4h bars per calendar day (24/4) — converts spec lookback DAYS → bars. */
export const BARS_PER_DAY_4H = 6;

export interface XsmomParams {
  /** Ranking lookback in DAYS (`L`); converted ×6 to 4h bars. */
  lookbackDays: number;
  /** Top-K equal-weight long book. */
  topK: number;
  /** Dual-momentum floor: name eligible long only if `r_i ≥ absFloorPct/100`. */
  absFloorPct: number;
  /** Rebalance cadence in 4h bars (42 = weekly). */
  rebalanceBars: number;
  /** Annual vol target feeding the VolKellySizer + the 1R sizing stop. */
  volTargetAnnualPct: number;
}

export interface XsmomCostArm {
  name: string;
  feeBps: number | { maker: number; taker: number };
  executionMode: 'market' | 'limit';
}

export interface XsmomRoundTrip {
  symbol: string;
  entryTs: number;
  exitTs: number;
  /** Net-of-fee R multiple (the value the keeper gate pools). */
  rNet: number;
}

export interface XsmomRunResult {
  /** Pooled per-round-trip net R, in exit (close) order — the gate input. */
  tradeRsNet: number[];
  roundTrips: XsmomRoundTrip[];
  /** Per-symbol net-R list (round-trips attributed to the symbol exited). */
  perSymbolRs: Record<string, number[]>;
  /** Symbols that contributed ≥ 1 closed round-trip. */
  symbolsContributing: number;
  /** In-window rebalances that actually evaluated a ranking. */
  rebalancesEvaluated: number;
  /**
   * Min names carrying a full `L`-bar lookback across the in-window rebalances
   * that evaluated a ranking (the §1 ≥ 8-retained cross-section check).
   */
  minRetainedNames: number;
  /** Per-symbol count of in-window rebalances where the name was dropped for
   *  lack of `L`-bar history while the cross-section was otherwise rankable. */
  droppedForHistory: Record<string, number>;
}

interface SymSeries {
  symbol: string;
  /** Candles in `[warmupStart, endDate]`, ascending. */
  bars: Candle[];
  /** ts → own index, for O(1) rebalance lookup. */
  idxByTs: Map<number, number>;
  risk: RiskManager;
}

interface OpenLot {
  symbol: string;
  entryTs: number;
  entryFill: number;
  qty: number;
  stopLoss: number;
  /** |entryFill − stopLoss| — the R denominator's price leg. */
  stopDistance: number;
}

/** Resolve `feeBps` into per-fill maker/taker rates (mirrors runner.ts). */
function resolveFeeRates(
  feeBps: XsmomCostArm['feeBps'],
): { maker: number; taker: number } {
  if (typeof feeBps === 'number') {
    const r = feeBps / 10_000;
    return { maker: r, taker: r };
  }
  return { maker: feeBps.maker / 10_000, taker: feeBps.taker / 10_000 };
}

export interface XsmomRunArgs {
  candlesBySymbol: Record<string, Candle[]>;
  symbols: string[];
  params: XsmomParams;
  arm: XsmomCostArm;
  /** Warmup boundary — bars before `evalStart` only fill the lookback. */
  warmupStart: number;
  /** First timestamp at which entries/exits are recorded. */
  evalStart: number;
  /** Last timestamp processed. */
  evalEnd: number;
  initialEquity: number;
  slippageBps: number;
  /** Min names with `L`-history required to rank a rebalance (spec §1: 8). */
  minRetained?: number;
}

/**
 * Run the cross-sectional momentum book over one (params, arm, window) and
 * return the pooled net-R round-trip sequence + cross-section diagnostics.
 */
export function runXsmomPortfolio(args: XsmomRunArgs): XsmomRunResult {
  const {
    candlesBySymbol, symbols, params, arm,
    warmupStart, evalStart, evalEnd, initialEquity, slippageBps,
  } = args;
  const minRetained = args.minRetained ?? 8;

  const Lbars = Math.max(1, Math.round(params.lookbackDays * BARS_PER_DAY_4H));
  const stopFrac = tsmomSizingStopFraction(params.volTargetAnnualPct);
  const slipRate = slippageBps / 10_000;
  const feeRates = resolveFeeRates(arm.feeBps);
  const entryRate = arm.executionMode === 'limit' ? feeRates.maker : feeRates.taker;
  const exitRate = feeRates.taker; // exits always taker (rebalance market hit)

  // ── VolKellySizer config — identical conventions to tsmom_majors, but the
  // realised-vol estimator annualises on the 4h bar count (2190) not √365.
  // Omitting an expectancy table leaves the Kelly cap inactive (vol-only) — the
  // only honest choice in-backtest (OOS expectancy → OOS sizing is look-ahead).
  const volKellyConfig = resolveVolKellySizerConfig({
    baseRiskPct: 0.01,
    riskPctFloor: 0.005,
    riskPctCeil: 0.0175,
    volRefAnnual: params.volTargetAnnualPct / 100,
    barsPerYear: XSMOM_BARS_PER_YEAR_4H,
    volWindowBars: 30,
  });

  // Shared account so sizing compounds off one equity (magnitude only — it
  // cancels out of R). One RiskManager per symbol over the shared account.
  const account = {
    totalEquity: initialEquity,
    availableCash: initialEquity,
    openPositions: [],
    dailyPnl: 0,
  };

  const series = new Map<string, SymSeries>();
  const tsSet = new Set<number>();
  for (const symbol of symbols) {
    const raw = candlesBySymbol[symbol] ?? [];
    const bars = raw
      .filter((c) => c.timestamp >= warmupStart && c.timestamp <= evalEnd)
      .sort((a, b) => a.timestamp - b.timestamp);
    const idxByTs = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) {
      idxByTs.set(bars[i].timestamp, i);
      tsSet.add(bars[i].timestamp);
    }
    series.set(symbol, {
      symbol,
      bars,
      idxByTs,
      risk: new RiskManager(account, { fractionalQuantity: true }),
    });
  }
  const timeline = [...tsSet].sort((a, b) => a - b);

  const openBook = new Map<string, OpenLot>();
  const tradeRsNet: number[] = [];
  const roundTrips: XsmomRoundTrip[] = [];
  const perSymbolRs: Record<string, number[]> = {};
  for (const s of symbols) perSymbolRs[s] = [];
  const droppedForHistory: Record<string, number> = {};
  for (const s of symbols) droppedForHistory[s] = 0;
  let rebalancesEvaluated = 0;
  let minRetainedNames = Number.POSITIVE_INFINITY;

  // Close a held lot at `ts` using the symbol's NEXT bar open. Returns the net
  // R (qty cancels but is carried for fidelity). No next bar → cannot fill, the
  // lot stays open (and simply never books a round-trip — conservative).
  const closeLot = (lot: OpenLot, ts: number): void => {
    const s = series.get(lot.symbol)!;
    const idx = s.idxByTs.get(ts);
    if (idx === undefined) return;
    const nextOpen = s.bars[idx + 1]?.open;
    if (!(nextOpen > 0)) return;
    const exitFill = nextOpen * (1 - slipRate); // long exit: adverse slippage down
    const grossPerUnit = exitFill - lot.entryFill;
    const feePerUnit = lot.entryFill * entryRate + exitFill * exitRate;
    const netPnl = (grossPerUnit - feePerUnit) * lot.qty;
    const denom = lot.stopDistance * lot.qty;
    const rNet = denom > 0 ? netPnl / denom : 0;
    tradeRsNet.push(rNet);
    perSymbolRs[lot.symbol].push(rNet);
    roundTrips.push({ symbol: lot.symbol, entryTs: lot.entryTs, exitTs: s.bars[idx + 1].timestamp, rNet });
    openBook.delete(lot.symbol);
  };

  // Open a long for `symbol` at its NEXT bar open after `ts`.
  const openLot = (symbol: string, ts: number): void => {
    const s = series.get(symbol)!;
    const idx = s.idxByTs.get(ts)!;
    const signalClose = s.bars[idx].close; // decision price (already closed)
    const nextOpen = s.bars[idx + 1]?.open;
    if (!(signalClose > 0) || !(nextOpen > 0)) return;
    const stopLoss = signalClose * (1 - stopFrac);
    // σ over closes through the decision bar (fill bar's close excluded → no
    // look-ahead), mirroring runner.ts `window.slice(0, -1)`.
    const closedCloses = s.bars.slice(0, idx + 1).map((c) => c.close);
    const sigmaSym = trailingRealisedVol(closedCloses, volKellyConfig.volWindowBars, volKellyConfig.barsPerYear);
    const riskPct = effectiveRiskPct(volKellyConfig, sigmaSym);
    const qty = riskPct === 0 ? 0 : s.risk.sizeFromStop(signalClose, stopLoss, { riskPct });
    if (!(qty > 0)) return;
    const entryFill = nextOpen * (1 + slipRate); // long entry: adverse slippage up
    openBook.set(symbol, {
      symbol,
      entryTs: s.bars[idx + 1].timestamp,
      entryFill,
      qty,
      stopLoss,
      stopDistance: Math.abs(entryFill - stopLoss),
    });
  };

  // ── Walk rebalance bars on the merged timeline. Anchored at multiples of
  // `rebalanceBars` from the warmup start so the same calendar bars rebalance
  // across the IS / OOS / walk-forward windows (identical timeline prefix).
  for (let r = 0; r < timeline.length; r += params.rebalanceBars) {
    const ts = timeline[r];
    if (ts < evalStart || ts > evalEnd) continue;

    // Rank every name carrying a full L-bar lookback at this bar.
    const scored: Array<{ symbol: string; r: number }> = [];
    const hasHistory: string[] = [];
    for (const symbol of symbols) {
      const s = series.get(symbol)!;
      const idx = s.idxByTs.get(ts);
      if (idx === undefined || idx < Lbars) continue; // no bar here, or short history
      const cNow = s.bars[idx].close;
      const cThen = s.bars[idx - Lbars].close;
      if (!(cNow > 0) || !(cThen > 0)) continue;
      hasHistory.push(symbol);
      scored.push({ symbol, r: cNow / cThen - 1 });
    }

    // Insufficient cross-section → skip ranking this rebalance (spec §1).
    if (hasHistory.length < minRetained) continue;
    rebalancesEvaluated += 1;
    minRetainedNames = Math.min(minRetainedNames, hasHistory.length);
    for (const symbol of symbols) {
      if (!hasHistory.includes(symbol)) droppedForHistory[symbol] += 1;
    }

    // Eligible-long set (dual-momentum floor), ranked desc; target = top-K.
    const eligible = scored
      .filter((x) => x.r >= params.absFloorPct / 100)
      .sort((a, b) => b.r - a.r);
    const target = new Set(eligible.slice(0, params.topK).map((x) => x.symbol));

    // Exit held names no longer in target (closes round-trips at next open)…
    for (const lot of [...openBook.values()]) {
      if (!target.has(lot.symbol)) closeLot(lot, ts);
    }
    // …then enter target names not currently held.
    for (const symbol of target) {
      if (!openBook.has(symbol)) openLot(symbol, ts);
    }
  }

  const symbolsContributing = Object.values(perSymbolRs).filter((rs) => rs.length > 0).length;
  return {
    tradeRsNet,
    roundTrips,
    perSymbolRs,
    symbolsContributing,
    rebalancesEvaluated,
    minRetainedNames: Number.isFinite(minRetainedNames) ? minRetainedNames : 0,
    droppedForHistory,
  };
}
