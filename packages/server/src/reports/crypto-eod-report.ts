import type { EodReport, EodTradeEntry, EodMover, EodSignalAccuracy, Position, SignalType } from '@trading-app/shared';
type StrategyLabel = EodTradeEntry['strategy'];
import { MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';

function dateString(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function calcRR(pos: Position): number {
  if (!pos.closedAt || pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return Math.round((pos.pnl / risk) * 10) / 10;
}

function strategyLabel(t: SignalType): StrategyLabel {
  switch (t) {
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';        // legacy positions still on disk
    case 'macd_trend': return 'MACD Trend';
    case 'bb_fade': return 'BB Fade';
    case 'scalping': return 'Scalping';
    case 'swing_trade': return 'Swing';
    case 'ichimoku': return 'Ichimoku';
    case 'orb_breakout': return 'ORB';
    case 'otm_mispricing': return 'OTM';
    case 'relative_value': return 'RV';
  }
}

function toTradeEntry(pos: Position): EodTradeEntry {
  const exitPrice = pos.exitPrice ?? (pos.side === 'buy' ? pos.takeProfit : pos.stopLoss);
  const strategy = strategyLabel(pos.signalType);
  return {
    id: pos.id,
    symbol: pos.symbol,
    strategy,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    quantity: pos.quantity,
    pnl: pos.pnl ?? 0,
    rr: calcRR(pos),
    openedAt: pos.openedAt,
    closedAt: pos.closedAt ?? Date.now(),
  };
}

function buildMarkdown(report: Omit<EodReport, 'markdown'>): string {
  const { date, realizedPnl, unrealizedPnl, combinedPnl,
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

  return `# Crypto Daily EOD Report — ${date}

## P&L Summary
| Metric | Value |
|--------|-------|
| Realized P&L | ${pnlSign(realizedPnl)} |
| Unrealized P&L (open) | ${pnlSign(unrealizedPnl)} |
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

## Top Movers (Crypto Watchlist)
| Symbol | Price | Change % |
|--------|-------|----------|
${moverRows || '_No data._'}

## Signal Accuracy
| Metric | Value |
|--------|-------|
| Total Signals | ${signalAccuracy.totalSignals} |
| Winning Signals | ${signalAccuracy.winningSignals} |
| Signal Win Rate | ${pct(signalAccuracy.winRate)} |
`;
}

export interface CryptoReportSnapshot {
  allClosedPositions: Position[];
  accountState: { totalEquity: number; availableCash: number; openPositions: Position[]; dailyPnl: number };
  symbols: { symbol: string; price: number; changePct: number }[];
}

export function generateCryptoEodReport(snapshot: CryptoReportSnapshot): EodReport {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const todayClosed = snapshot.allClosedPositions.filter(p =>
    p.closedAt != null && dateString(p.closedAt) === today
  );

  const trades: EodTradeEntry[] = todayClosed.map(toTradeEntry);

  const realizedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  const openPositions = snapshot.accountState.openPositions;
  const unrealizedPnl = openPositions.reduce((sum, p) => {
    const sym = snapshot.symbols.find(s => s.symbol === p.symbol);
    if (!sym) return sum;
    const multiplier = p.side === 'buy' ? 1 : -1;
    return sum + (sym.price - p.entryPrice) * p.quantity * multiplier;
  }, 0);

  const combinedPnl = realizedPnl + unrealizedPnl;
  const totalEquity = snapshot.accountState.totalEquity;
  const managedEquity = totalEquity * MANAGED_ACCOUNT_RATIO;
  const availableCash = snapshot.accountState.availableCash;

  const winners = trades.filter(t => t.pnl > 0).length;
  const losers = trades.filter(t => t.pnl <= 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;
  const avgRR = totalTrades > 0 ? trades.reduce((sum, t) => sum + Math.abs(t.rr), 0) / totalTrades : 0;

  const top5Movers: EodMover[] = [...snapshot.symbols]
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)
    .map(s => ({ symbol: s.symbol, price: s.price, changePct: s.changePct }));

  const signalAccuracy: EodSignalAccuracy = {
    totalSignals: totalTrades,
    winningSignals: winners,
    winRate,
    avgRR,
  };

  const partial: Omit<EodReport, 'markdown'> = {
    date: today,
    generatedAt: Date.now(),
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    optionsPnl: 0,
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
    top5Movers,
    signalAccuracy,
  };

  return { ...partial, markdown: buildMarkdown(partial) };
}
