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
  /**
   * Cap a position's notional (qty × entryPrice) at this fraction of current
   * managed equity. Default: 1.0 (no leverage past the managed slice).
   *
   * Without this cap, a tight ATR/BB-derived stop drives the risk-budget
   * sizing toward unbounded notional — a $500 budget over a 5-bps stop on
   * BTC sized to ≈60 BTC ≈ $3.6M on a $100k account in TRA-168 round 2,
   * yielding -30,000% return rows that are leverage-blowups, not strategy
   * P&L. Set >1 only if you have explicit margin authorization and accept
   * the silent-broker-rejection risk in live trading.
   */
  maxNotionalRatio?: number;
}

/**
 * Sizes positions from a stop distance using a fixed % of current managed
 * equity, with three volatility-survival features:
 *
 *   1. Compounding: equity is re-read from `AccountState` on every call,
 *      so position size grows with profits and shrinks with losses instead
 *      of being frozen at construction time.
 *   2. Drawdown brake: when running equity is `drawdownBrakeThreshold`
 *      below its peak, per-trade risk is multiplied by
 *      `drawdownBrakeMultiplier` (defaults: 10% drawdown → halve size)
 *      until the equity recovers above the brake threshold.
 *   3. Notional cap (TRA-178): position notional is bounded by
 *      `maxNotionalRatio × managedEquity`. Without it, tiny ATR/BB stops
 *      blow position size up beyond available capital — fine when the
 *      broker rejects the order, catastrophic in backtests (which have no
 *      buying-power check) and unsafe if a margin/partial-fill bug ever
 *      lets one through in live.
 */
export class RiskManager {
  private readonly account: AccountState;
  private readonly drawdownBrakeThreshold: number;
  private readonly drawdownBrakeMultiplier: number;
  private readonly maxNotionalRatio: number;
  private peakManagedEquity: number;

  constructor(account: AccountState, opts: RiskManagerOptions = {}) {
    this.account = account;
    this.drawdownBrakeThreshold = opts.drawdownBrakeThreshold ?? 0.10;
    this.drawdownBrakeMultiplier = opts.drawdownBrakeMultiplier ?? 0.5;
    this.maxNotionalRatio = opts.maxNotionalRatio ?? 1.0;
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

  /**
   * Position size in shares given a stop distance.
   *
   * Returns the smaller of two limits:
   *   - risk-budget sizing: `maxRiskPerTrade() / stopDistance`
   *   - notional cap (TRA-178): `maxNotionalRatio × managedEquity / entryPrice`
   *
   * The notional cap protects against tiny ATR/BB-derived stops sizing into
   * leverage that the engine itself never authorized.
   */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const stopDistance = Math.abs(entryPrice - stopPrice);
    if (stopDistance === 0) return 0;
    const riskBased = Math.floor(this.maxRiskPerTrade() / stopDistance);
    if (entryPrice <= 0) return Math.max(0, riskBased);
    const notionalCap = Math.floor((this.managedEquity() * this.maxNotionalRatio) / entryPrice);
    return Math.max(0, Math.min(riskBased, notionalCap));
  }
}
