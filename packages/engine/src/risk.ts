import { AccountState, DEFAULT_RISK_PER_TRADE, MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';

export interface RiskManagerOptions {
  /**
   * Drawdown threshold (peak-to-current, as a fraction of peak managed equity)
   * at which the per-trade risk multiplier is halved. Default: 0.10 (10%).
   * Set to >= 1 to disable the brake.
   */
  drawdownBrakeThreshold?: number;
  /**
   * Multiplier applied to per-trade risk while the drawdown brake is engaged.
   * Default: 0.5 (halve the size).
   */
  drawdownBrakeMultiplier?: number;
}

/**
 * Sizes positions from a stop distance using a fixed % of current managed
 * equity, with two volatility-survival features:
 *
 *   1. Compounding: equity is re-read from `AccountState` on every call,
 *      so position size grows with profits and shrinks with losses instead
 *      of being frozen at construction time.
 *   2. Drawdown brake: when running equity is `drawdownBrakeThreshold`
 *      below its peak, per-trade risk is multiplied by
 *      `drawdownBrakeMultiplier` (defaults: 10% drawdown → halve size)
 *      until the equity recovers above the brake threshold.
 */
export class RiskManager {
  private readonly account: AccountState;
  private readonly drawdownBrakeThreshold: number;
  private readonly drawdownBrakeMultiplier: number;
  private peakManagedEquity: number;

  constructor(account: AccountState, opts: RiskManagerOptions = {}) {
    this.account = account;
    this.drawdownBrakeThreshold = opts.drawdownBrakeThreshold ?? 0.10;
    this.drawdownBrakeMultiplier = opts.drawdownBrakeMultiplier ?? 0.5;
    this.peakManagedEquity = this.currentManagedEquity();
  }

  private currentManagedEquity(): number {
    return this.account.totalEquity * MANAGED_ACCOUNT_RATIO;
  }

  /** Live managed equity (re-read on every call so sizing compounds). */
  managedEquity(): number {
    const equity = this.currentManagedEquity();
    if (equity > this.peakManagedEquity) this.peakManagedEquity = equity;
    return equity;
  }

  /**
   * Maximum dollar risk for one trade. Compounds with current equity, and
   * is halved when running equity is `drawdownBrakeThreshold` below its peak.
   */
  maxRiskPerTrade(): number {
    const equity = this.managedEquity();
    let perTrade = equity * DEFAULT_RISK_PER_TRADE;
    if (this.peakManagedEquity > 0) {
      const drawdown = (this.peakManagedEquity - equity) / this.peakManagedEquity;
      if (drawdown >= this.drawdownBrakeThreshold) perTrade *= this.drawdownBrakeMultiplier;
    }
    return Math.max(0, perTrade);
  }

  /** Position size in shares given a stop distance. */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const stopDistance = Math.abs(entryPrice - stopPrice);
    if (stopDistance === 0) return 0;
    return Math.floor(this.maxRiskPerTrade() / stopDistance);
  }
}
