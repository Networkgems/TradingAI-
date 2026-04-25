import { Position, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';

export class PositionManager {
  private positions: Map<string, Position> = new Map();

  open(signal: TradeSignal, quantity: number): Position {
    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      entryPrice: signal.entryPrice,
      quantity,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
    };
    this.positions.set(position.id, position);
    return position;
  }

  close(id: string, exitPrice: number): Position {
    const position = this.positions.get(id);
    if (!position) throw new Error(`Position ${id} not found`);
    const multiplier = position.side === 'buy' ? 1 : -1;
    position.pnl = (exitPrice - position.entryPrice) * position.quantity * multiplier;
    position.closedAt = Date.now();
    this.positions.delete(id);
    return position;
  }

  getOpen(): Position[] {
    return Array.from(this.positions.values());
  }
}
