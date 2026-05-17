import type {
  EodReport,
  EodTradeEntry,
  EodMover,
  EodSignalAccuracy,
  Position,
  SignalType,
} from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';
import type { EngineState, SymbolState } from '../signal-engine.js';

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

function dateString(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function todayET(): string {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/')
    .reverse()
    .join('-')
    // mm-dd-yyyy → yyyy-mm-dd
    .replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$3-$2');
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
    case 'otm_mispricing': return 'OTM';
    case 'relative_value': return 'RV';
    // TRA-323 — imported Tradier positions don't trade through the local
    // engine, so they never reach the EOD trade exporter. Map to a label
    // for completeness (and to keep the switch exhaustive); this label is
    // never emitted to disk in practice.
    case 'tradier_import': return 'Tradier';
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

function buildMarkdown(report: Omit<EodReport, 'markdown'>): string {
  const { date, realizedPnl, unrealizedPnl, optionsPnl, combinedPnl,
          totalEquity, managedEquity, availableCash,
          trades, openPositionCount,
          winRate, avgRR, totalTrades, winners, losers,
          expectancy, maxDrawdown, sharpeRatio,
          top5Movers: movers, signalAccuracy } = report;

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
`;
}

export interface ReportInput {
  state: EngineState;
  /** All closed positions for the current session (not capped to 20) */
  allClosedPositions: Position[];
  /** Signals fired today with their outcomes once known */
  dailySignals: DailySignalRecord[];
  /** Map from signal id → SignalType for strategy tagging */
  signalTypeMap: Map<string, SignalType>;
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
  const { state, allClosedPositions, dailySignals, signalTypeMap } = input;
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

  const optionsPnl = state.options.optionsPnl;
  const combinedPnl = realizedPnl + unrealizedPnl + optionsPnl;

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
  };

  return { ...partial, markdown: buildMarkdown(partial) };
}
