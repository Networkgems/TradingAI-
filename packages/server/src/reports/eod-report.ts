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

function calcRR(pos: Position): number {
  if (!pos.closedAt || pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return Math.round((pos.pnl / risk) * 10) / 10;
}

function toTradeEntry(pos: Position, signalType: SignalType): EodTradeEntry {
  const exitPrice = pos.side === 'buy' ? pos.takeProfit : pos.stopLoss;
  const rr = calcRR(pos);
  return {
    id: pos.id,
    symbol: pos.symbol,
    strategy: signalType === 'orb_breakout' ? 'ORB' : 'Reversal',
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
  return [...symbols]
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)
    .map(s => ({ symbol: s.symbol, price: s.price, changePct: s.changePct }));
}

function buildMarkdown(report: Omit<EodReport, 'markdown'>): string {
  const { date, realizedPnl, unrealizedPnl, optionsPnl, combinedPnl,
          totalEquity, managedEquity, availableCash,
          trades, openPositionCount,
          winRate, avgRR, totalTrades, winners, losers,
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

export function generateEodReport(input: ReportInput): EodReport {
  const { state, allClosedPositions, dailySignals, signalTypeMap } = input;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

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
    top5Movers: movers,
    signalAccuracy,
  };

  return { ...partial, markdown: buildMarkdown(partial) };
}
