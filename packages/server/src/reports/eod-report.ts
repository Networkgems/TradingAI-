import type {
  EodReport,
  EodTradeEntry,
  EodMover,
  EodSignalAccuracy,
  OptionPosition,
  PortfolioGreeks,
  Position,
  SignalType,
} from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';
import type { EngineState, SymbolState } from '../signal-engine.js';
import { computePortfolioGreeks } from './portfolio-greeks.js';
import type { OptionTradeJournalSummary } from '../option-trade-journal.js';
import type { OptionLearnedWeights } from '../learned-option-weights.js';

/** Signals fired today, keyed by signal id */
export interface DailySignalRecord {
  id: string;
  symbol: string;
  type: SignalType;
  firedAt: number;
  /** Filled in once the position closes */
  outcome?: 'win' | 'loss';
  rr?: number;
}

// TRA-594 — bucket a trade by its US/Eastern calendar day, NOT its UTC day.
// `today` (and any `asOfDate` backfill key) is an Eastern date, so comparing
// against a UTC `toISOString().slice(0,10)` misattributed every trade closed
// in the evening ET (already the next calendar day in UTC) to the wrong day.
// For 24/7 crypto and any post-20:00-ET equity/options close this silently
// dropped the trade out of its day's report — a core reason the Calendar tab
// "tracked nothing": the close landed under tomorrow's (not-yet-generated)
// report instead of today's.
function dateString(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function strategyLabel(t: SignalType): EodTradeEntry['strategy'] {
  switch (t) {
    case 'orb_breakout': return 'ORB';
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';        // legacy positions still on disk
    case 'macd_trend': return 'MACD Trend';
    case 'bb_fade': return 'BB Fade';
    case 'momentum': return 'Momentum';
    case 'mean_reversion': return 'Mean Reversion';
    case 'breakout_vol': return 'Breakout';
    case 'ichimoku': return 'Ichimoku';
    case 'scalping': return 'Scalping';
    case 'swing_trade': return 'Swing';
    case 'dca': return 'DCA';                 // TRA-693 — DCA accumulation
    case 'otm_mispricing': return 'OTM';
    case 'relative_value': return 'RV';
    // TRA-323 — imported Tradier positions don't trade through the local
    // engine, so they never reach the EOD trade exporter. Map to a label
    // for completeness (and to keep the switch exhaustive); this label is
    // never emitted to disk in practice.
    case 'tradier_import': return 'Tradier';
    // TRA-451 — SMA-200 signals are display-only; the engine never opens a
    // position off them, so they never reach the EOD trade exporter. Mapped
    // here only to keep the switch exhaustive over `SignalType`.
    case 'sma200_pullback':
    case 'sma200_reclaim': return 'SMA-200';
    // TRA-728 — Supertrend confluence is an options signal, router-gated off in
    // Phase 1, so it never reaches the EOD trade exporter. Mapped here only to
    // keep the switch exhaustive over `SignalType`.
    case 'supertrend_confluence': return 'Supertrend';
    // TRA-821 — tsmom_majors is a crypto signal; it never reaches the equity EOD
    // exporter. Mapped only to keep the switch exhaustive over `SignalType`.
    case 'tsmom_majors': return 'TSMOM';
  }
}

function calcRR(pos: Position): number {
  if (!pos.closedAt || pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return Math.round((pos.pnl / risk) * 10) / 10;
}

/**
 * TRA-208: per-trade R = pnl / (|entry − stop| × qty). Same definition the
 * backtest uses (`tradeR()` in packages/backtest/src/runner.ts) so live
 * expectancy and backtest expectancy are directly comparable.
 */
function tradeR(pos: Position): number {
  if (pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return pos.pnl / risk;
}

/**
 * TRA-208: peak-to-trough drawdown over the cumulative-PnL series of `trades`
 * in close-time order. Returned as a fraction of the running peak equity in
 * [0,1]. Mirrors `BacktestResult.maxDrawdown` semantics for daily reporting,
 * but computed off the realized equity curve (open MTM excluded — daily
 * reports run after the close so MTM is a sideshow).
 *
 * `initialEquity` anchors the curve so a single losing trade against a small
 * book registers as a drawdown rather than a zero-base divide-by-zero.
 */
function computeMaxDrawdown(
  trades: ReadonlyArray<Position>,
  initialEquity: number,
): number {
  if (trades.length === 0 || initialEquity <= 0) return 0;
  const ordered = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDd = 0;
  for (const t of ordered) {
    equity += t.pnl ?? 0;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * TRA-208: trade-R Sharpe (NOT annualized). Matches the per-trade-R fallback
 * path of `BacktestResult.sharpeRatio` — a daily report typically has < 20
 * trades, so a √N annualization factor would massively overstate noise as
 * skill. Use `expectancy` (mean R) for systems-level signal-to-noise.
 */
function computeTradeSharpe(rs: ReadonlyArray<number>): number {
  if (rs.length < 2) return 0;
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / (rs.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

function toTradeEntry(pos: Position, signalType: SignalType): EodTradeEntry {
  const exitPrice = pos.side === 'buy' ? pos.takeProfit : pos.stopLoss;
  const rr = calcRR(pos);
  return {
    id: pos.id,
    symbol: pos.symbol,
    strategy: strategyLabel(signalType),
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice: pos.closedAt ? exitPrice : pos.entryPrice,
    quantity: pos.quantity,
    pnl: pos.pnl ?? 0,
    rr,
    openedAt: pos.openedAt,
    closedAt: pos.closedAt ?? Date.now(),
  };
}

function top5Movers(symbols: SymbolState[]): EodMover[] {
  // TRA-136: drop symbols that were never successfully fetched (lastUpdated === 0)
  // so the report shows "_No data._" rather than five rows of 0.00% when the feed
  // is failing on cold start.
  return [...symbols]
    .filter(s => s.lastUpdated > 0 && s.price > 0)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)
    .map(s => ({ symbol: s.symbol, price: s.price, changePct: s.changePct }));
}

/**
 * TRA-844 — render the portfolio Greeks + theta-$ bleed + allocation rollup as
 * Markdown sections for the EOD report. Returns an empty string when the book
 * is empty (no open option positions) so a flat day doesn't add noise.
 */
function buildPortfolioGreeksMarkdown(g: PortfolioGreeks | undefined): string {
  if (!g || g.positionsTotal === 0) return '';

  const signed = (n: number, digits = 0) => (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdSigned = (n: number) => (n >= 0 ? '+' : '-') + usd(n);
  const pctOf = (f: number) => (f * 100).toFixed(1) + '%';

  const nameRows = g.byName
    .map(b => `| ${b.key} | ${usd(b.notional)} | ${pctOf(b.pctOfBook)} | ${b.positions} |`)
    .join('\n');
  const sectorRows = g.bySector
    .map(b => `| ${b.key} | ${usd(b.notional)} | ${pctOf(b.pctOfBook)} | ${b.positions} |`)
    .join('\n');

  return `

## Portfolio Greeks (Open Options)
| Metric | Value |
|--------|-------|
| Net Delta (≈ shares) | ${signed(g.netDelta)} |
| Net Gamma (Δshares / $1) | ${signed(g.netGamma)} |
| Net Vega ($ / +1 vol pt) | ${usdSigned(g.netVega)} |
| Theta Bleed ($ / day) | ${usdSigned(g.thetaDollarsPerDay)} |
| Book Premium (notional) | ${usd(g.netNotional)} |
| Greeks coverage | ${g.positionsValued}/${g.positionsTotal} positions |${g.greeksUnvaluedReasons && Object.keys(g.greeksUnvaluedReasons).length > 0
  ? `\n| Greeks gaps (TRA-931) | ${Object.entries(g.greeksUnvaluedReasons).map(([r, n]) => `${r}: ${n}`).join(', ')} |`
  : ''}

## Allocation by Name
| Name | Notional | % Book | Positions |
|------|----------|--------|-----------|
${nameRows || '_No open option premium._'}

## Allocation by Sector
| Sector | Notional | % Book | Positions |
|--------|----------|--------|-----------|
${sectorRows || '_No open option premium._'}`;
}

/**
 * TRA-991 — render the option-trade journal P&L + learned-weights section.
 * Returns '' when there is no journal data (flag off / nothing accrued yet) so a
 * day with no option-trade learning adds no noise. Observe-only: the weights are
 * shown for visibility; they don't influence any decision.
 */
function buildOptionJournalMarkdown(
  summary: OptionTradeJournalSummary | undefined,
  weights: OptionLearnedWeights | undefined,
): string {
  if (!summary || summary.total === 0) return '';

  const usd = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
  const pct = (f: number | null) => (f == null ? '—' : (f * 100).toFixed(1) + '%');
  const r = (n: number | null) => (n == null ? '—' : n.toFixed(2) + 'R');

  const structureRows = summary.byStructure
    .map(s => `| ${s.structure} | ${s.closed} | ${usd(s.realizedPnlUsd)} | ${pct(s.winRate)} | ${r(s.avgR)} |`)
    .join('\n');

  // Only surface CONFIDENT learned multipliers (a dimension value that cleared
  // the min-sample guard and moved off 1.0) — the rest are still neutral.
  const movedWeights = weights
    ? [
        ...weights.byStructure,
        ...weights.byIvRank,
        ...weights.byTrend,
        ...weights.bySentiment,
        ...weights.byDte,
      ].filter(s => s.confident && s.multiplier !== 1)
    : [];
  const weightRows = movedWeights
    .map(s => `| ${s.key} | ${s.multiplier.toFixed(3)} | ${s.resolved} | ${pct(s.winRate)} |`)
    .join('\n');

  return `

## Option-Trade Journal (TRA-990, observe-only)
| Metric | Value |
|--------|-------|
| Rows (open / closed) | ${summary.open} / ${summary.closed} |
| Realized P&L | ${usd(summary.realizedPnlUsd)} |
| Win / Loss / Scratch | ${summary.win} / ${summary.loss} / ${summary.scratch} |
| Win Rate (closed) | ${pct(summary.winRate)} |
| Avg R (closed) | ${r(summary.avgR)} |

## Journal P&L by Structure
| Structure | Closed | Realized P&L | Win Rate | Avg R |
|-----------|--------|--------------|----------|-------|
${structureRows || '_No closed option trades yet._'}

## Learned Option Weights (confident, off-neutral)
| Dimension | Multiplier | Resolved | Win Rate |
|-----------|-----------|----------|----------|
${weightRows || '_No dimension has cleared the min-sample guard yet — all neutral (1.0)._'}`;
}

function buildMarkdown(
  report: Omit<EodReport, 'markdown'>,
  optionJournal?: OptionTradeJournalSummary,
  optionLearnedWeights?: OptionLearnedWeights,
): string {
  const { date, realizedPnl, unrealizedPnl, optionsPnl, combinedPnl,
          totalEquity, managedEquity, availableCash,
          trades, openPositionCount,
          winRate, avgRR, totalTrades, winners, losers,
          expectancy, maxDrawdown, sharpeRatio,
          top5Movers: movers, signalAccuracy, portfolioGreeks } = report;

  const pnlSign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tradeRows = trades.map(t =>
    `| ${t.symbol} | ${t.strategy} | ${t.side.toUpperCase()} | ${t.quantity} | ${usd(t.entryPrice)} | ${usd(t.exitPrice)} | ${pnlSign(t.pnl)} | 1:${t.rr} |`
  ).join('\n');

  const moverRows = movers.map(m =>
    `| ${m.symbol} | ${usd(m.price)} | ${pnlSign(m.changePct)}% |`
  ).join('\n');

  return `# Daily EOD Report — ${date}

## P&L Summary
| Metric | Value |
|--------|-------|
| Realized P&L (equity) | ${pnlSign(realizedPnl)} |
| Unrealized P&L (open) | ${pnlSign(unrealizedPnl)} |
| Options P&L | ${pnlSign(optionsPnl)} |
| **Combined P&L** | **${pnlSign(combinedPnl)}** |
| Total Equity | ${usd(totalEquity)} |
| Managed (50%) | ${usd(managedEquity)} |
| Available Cash | ${usd(availableCash)} |
| Open Positions | ${openPositionCount} |

## Performance
| Metric | Value |
|--------|-------|
| Total Trades | ${totalTrades} |
| Winners | ${winners} |
| Losers | ${losers} |
| Win Rate | ${pct(winRate)} |
| Avg R:R Achieved | 1:${avgRR.toFixed(2)} |
| Expectancy (avg R / trade) | ${expectancy.toFixed(2)}R |
| Max Drawdown | ${pct(maxDrawdown)} |
| Sharpe (per-trade) | ${sharpeRatio.toFixed(2)} |

## Trade Log
${tradeRows.length > 0
  ? `| Symbol | Strategy | Side | Qty | Entry | Exit | P&L | R:R |\n|--------|----------|------|-----|-------|------|-----|-----|\n${tradeRows}`
  : '_No closed trades today._'}

## Top 5 Movers (Watchlist)
| Symbol | Price | Change % |
|--------|-------|----------|
${moverRows || '_No data._'}

## Signal Accuracy
| Metric | Value |
|--------|-------|
| Total Signals Fired | ${signalAccuracy.totalSignals} |
| Winning Signals | ${signalAccuracy.winningSignals} |
| Signal Win Rate | ${pct(signalAccuracy.winRate)} |
| Avg R:R | 1:${signalAccuracy.avgRR.toFixed(2)} |
${buildPortfolioGreeksMarkdown(portfolioGreeks)}${buildOptionJournalMarkdown(optionJournal, optionLearnedWeights)}`;
}

export interface ReportInput {
  state: EngineState;
  /** All closed positions for the current session (not capped to 20) */
  allClosedPositions: Position[];
  /**
   * TRA-594 — all closed *options* for the active mode this session, full and
   * uncapped. The report sums only this day's closes for `optionsPnl`. Was
   * previously sourced from `state.options.optionsPnl`, which is the
   * all-time cumulative options P&L for the mode — folding that into every
   * day's `combinedPnl` made the whole calendar wrong (each cell carried the
   * running options total, not the day's). Optional so legacy/crypto callers
   * (no options) keep type-checking; an absent list means zero options P&L.
   */
  closedOptions?: OptionPosition[];
  /** Signals fired today with their outcomes once known */
  dailySignals: DailySignalRecord[];
  /** Map from signal id → SignalType for strategy tagging */
  signalTypeMap: Map<string, SignalType>;
  /**
   * TRA-991 — option-trade-journal rollup + learned weights for the demo book,
   * computed by the (async) caller from `listOptionTradeJournal()` /
   * `computeOptionLearnedWeights()`. Optional so legacy/crypto callers (and the
   * existing test surface) keep type-checking; absent ↔ no journal section.
   */
  optionJournal?: OptionTradeJournalSummary;
  optionLearnedWeights?: OptionLearnedWeights;
}

/**
 * Build an EOD report.
 *
 * `asOfDate` (TRA-388) — when supplied (a `YYYY-MM-DD` string), the report is
 * stamped with that date and "today's" closed trades / signals are selected
 * for that date instead of the current ET day. Used by the missed-day
 * catch-up to backfill a report for a day whose 21:00 ET archive tick was
 * missed: the day's closed positions are still retained in engine state
 * (archiving, which clears them, never ran), so filtering by `closedAt` for
 * the missed date reconstructs that day's realized P&L accurately.
 */
export function generateEodReport(input: ReportInput, asOfDate?: string): EodReport {
  const { state, allClosedPositions, closedOptions = [], dailySignals, signalTypeMap,
          optionJournal, optionLearnedWeights } = input;
  const today = asOfDate ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Closed trades for today only
  const todayClosed = allClosedPositions.filter(p =>
    p.closedAt != null && dateString(p.closedAt) === today
  );

  // Build trade log entries
  const trades: EodTradeEntry[] = todayClosed.map(p => {
    const sigType = signalTypeMap.get(p.id) ?? 'orb_breakout';
    return toTradeEntry(p, sigType);
  });

  // Realized P&L = sum of all today's closed trades
  const realizedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Unrealized P&L = estimate from open positions (no live MTM here, use entry as basis)
  const openPositions = state.account.openPositions;
  const unrealizedPnl = openPositions.reduce((sum, p) => {
    // Use current symbol price if available
    const sym = state.symbols.find(s => s.symbol === p.symbol);
    if (!sym) return sum;
    const multiplier = p.side === 'buy' ? 1 : -1;
    return sum + (sym.price - p.entryPrice) * p.quantity * multiplier;
  }, 0);

  // TRA-594 — the day's *realized* options P&L, summed from options that
  // actually closed on `today`. NOT `state.options.optionsPnl`, which is the
  // mode's all-time cumulative options P&L — using that booked the entire
  // running total into every single calendar cell.
  const todayClosedOptions = closedOptions.filter(o =>
    o.closedAt != null && dateString(o.closedAt) === today
  );
  const optionsPnl = todayClosedOptions.reduce((sum, o) => sum + (o.pnl ?? 0), 0);

  // TRA-594 — the Calendar is a *realized* per-day P&L view (Webull-style), so
  // a day's cell is the realized stock P&L plus the realized options P&L for
  // that day. Open-position MTM (`unrealizedPnl`) is deliberately excluded: a
  // position held open across N days would otherwise re-book its (drifting)
  // mark into every one of those N cells, so the monthly "Net P&L" total
  // multi-counted the same unclosed position. `unrealizedPnl` is still carried
  // on the report for the detail breakdown, just not in the calendar figure.
  const combinedPnl = realizedPnl + optionsPnl;

  const totalEquity = state.account.totalEquity;
  const managedEquity = totalEquity * MANAGED_ACCOUNT_RATIO;
  const availableCash = state.account.availableCash;

  // Win/loss stats
  const winners = trades.filter(t => t.pnl > 0).length;
  const losers = trades.filter(t => t.pnl <= 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;
  const avgRR = totalTrades > 0 ? trades.reduce((sum, t) => sum + Math.abs(t.rr), 0) / totalTrades : 0;

  // TRA-208: backtest-parity metrics. Anchor the equity curve at the close-of-
  // day equity *minus* today's realized PnL — that's the equity at session
  // open, which is the right baseline for an intra-day drawdown measurement.
  const tradeRs = todayClosed.map(tradeR);
  const expectancy = tradeRs.length > 0
    ? tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length
    : 0;
  const sharpeRatio = computeTradeSharpe(tradeRs);
  const sessionOpenEquity = state.account.totalEquity - realizedPnl;
  const maxDrawdown = computeMaxDrawdown(todayClosed, Math.max(sessionOpenEquity, 1));

  // Top 5 movers
  const movers = top5Movers(state.symbols);

  // TRA-844 — portfolio Greeks + theta-$ bleed + allocation rollup over the
  // open options book. Spot is resolved off the same symbol tape the report
  // already carries; positions whose spot/IV can't be solved still contribute
  // premium notional to the allocation buckets (just no Greeks).
  const spotBySymbol = new Map(state.symbols.map(s => [s.symbol.toUpperCase(), s.price] as const));
  const portfolioGreeks = computePortfolioGreeks(
    state.options.openOptions,
    (symbol: string) => spotBySymbol.get((symbol ?? '').toUpperCase()),
  );

  // Signal accuracy
  const todaySignals = dailySignals.filter(s => dateString(s.firedAt) === today);
  const winningSignals = todaySignals.filter(s => s.outcome === 'win').length;
  const sigAvgRR = todaySignals.filter(s => s.rr != null).reduce((sum, s) => sum + (s.rr ?? 0), 0)
    / Math.max(1, todaySignals.length);
  const signalAccuracy: EodSignalAccuracy = {
    totalSignals: todaySignals.length,
    winningSignals,
    winRate: todaySignals.length > 0 ? winningSignals / todaySignals.length : 0,
    avgRR: sigAvgRR,
  };

  const partial: Omit<EodReport, 'markdown'> = {
    date: today,
    generatedAt: Date.now(),
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    optionsPnl,
    combinedPnl,
    totalEquity,
    managedEquity,
    availableCash,
    trades,
    openPositionCount: openPositions.length,
    winRate,
    avgRR,
    totalTrades,
    winners,
    losers,
    expectancy,
    maxDrawdown,
    sharpeRatio,
    top5Movers: movers,
    signalAccuracy,
    portfolioGreeks,
  };

  return { ...partial, markdown: buildMarkdown(partial, optionJournal, optionLearnedWeights) };
}
