import { ExitReason, Position, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import type { LifecycleState } from './lifecycle.js';

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  /**
   * TRA-211: per-position lifecycle state (barsHeld, entry RSI/ATR snapshots,
   * running extreme since entry). Kept off the `Position` type so it doesn't
   * leak engine internals into the cross-package shared schema; the runner /
   * future live position manager round-trips it through `getLifecycle` /
   * `setLifecycle` between bars.
   */
  private lifecycle: Map<string, LifecycleState> = new Map();

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

  close(id: string, exitPrice: number, exitReason: ExitReason = 'stop'): Position {
    const position = this.positions.get(id);
    if (!position) throw new Error(`Position ${id} not found`);
    const multiplier = position.side === 'buy' ? 1 : -1;
    position.pnl = (exitPrice - position.entryPrice) * position.quantity * multiplier;
    position.closedAt = Date.now();
    position.exitPrice = exitPrice;
    position.exitReason = exitReason;
    const ls = this.lifecycle.get(id);
    if (ls) position.barsHeld = ls.barsHeld;
    this.positions.delete(id);
    this.lifecycle.delete(id);
    return position;
  }

  getOpen(): Position[] {
    return Array.from(this.positions.values());
  }

  /** TRA-211: read-back of the per-position lifecycle state for the runner. */
  getLifecycle(id: string): LifecycleState | undefined {
    return this.lifecycle.get(id);
  }

  /** TRA-211: replace (or seed) the lifecycle state slot for a position. */
  setLifecycle(id: string, state: LifecycleState): void {
    this.lifecycle.set(id, state);
  }

  /** TRA-211: in-place stop update used by trailing-stop ratchets. */
  updateStop(id: string, newStopLoss: number): void {
    const position = this.positions.get(id);
    if (!position) return;
    position.stopLoss = newStopLoss;
  }
}
