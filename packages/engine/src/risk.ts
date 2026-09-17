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
  /**
   * TRA-186: when true, returned quantities are not floored to whole units —
   * essential for high-priced fractional assets (a $100k account at 1% risk
   * has a $500 budget; a high-priced asset with a 2% stop floors a 0.31-unit
   * sized position to 0 and the BacktestRunner skips the trade entirely while
   * still logging the signal). Quantities are rounded down to 8 decimal
   * places to keep float noise out of PnL math.
   * Default false preserves equity-share semantics for stock callers.
   */
  fractionalQuantity?: boolean;
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
  private readonly fractionalQuantity: boolean;
  private peakManagedEquity: number;

  constructor(account: AccountState, opts: RiskManagerOptions = {}) {
    this.account = account;
    this.drawdownBrakeThreshold = opts.drawdownBrakeThreshold ?? 0.10;
    this.drawdownBrakeMultiplier = opts.drawdownBrakeMultiplier ?? 0.5;
    this.maxNotionalRatio = opts.maxNotionalRatio ?? 1.0;
    this.fractionalQuantity = opts.fractionalQuantity ?? false;
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
   *
   * @param riskPct optional per-call override (TRA-211) — used by per-strategy
   *   risk budgets such as mean reversion's 0.75% (spec §3). Falls back to the
   *   global `DEFAULT_RISK_PER_TRADE` (1%) when omitted. The drawdown brake
   *   still applies to the overridden risk budget.
   */
  maxRiskPerTrade(riskPct?: number): number {
    const equity = this.managedEquity();
    const fraction = riskPct !== undefined && Number.isFinite(riskPct) && riskPct > 0
      ? riskPct
      : DEFAULT_RISK_PER_TRADE;
    let perTrade = equity * fraction;
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
   *
   * Pass `opts.riskPct` to override the global 1% per-trade budget — used by
   * mean reversion's 0.75% spec value (TRA-211 / spec §3) without changing
   * sizing for momentum/breakout trades that share the same RiskManager.
   */
  sizeFromStop(entryPrice: number, stopPrice: number, opts: { riskPct?: number } = {}): number {
    const stopDistance = Math.abs(entryPrice - stopPrice);
    if (stopDistance === 0) return 0;
    const truncate = (n: number): number => this.fractionalQuantity
      // Round down to 8 dp; keeps float noise
      // (1e-15 scraps) out of qty × price PnL math without shaving real size.
      ? Math.floor(n * 1e8) / 1e8
      : Math.floor(n);
    const riskBased = truncate(this.maxRiskPerTrade(opts.riskPct) / stopDistance);
    if (entryPrice <= 0) return Math.max(0, riskBased);
    const notionalCap = truncate((this.managedEquity() * this.maxNotionalRatio) / entryPrice);
    return Math.max(0, Math.min(riskBased, notionalCap));
  }

  /**
   * Volatility-adaptive sizing: stop distance is `atr × atrMultiplier`
   * instead of a fixed price offset, so the achieved $-risk-per-trade
   * stays at `maxRiskPerTrade()` across vol regimes (a 2× ATR stop in a
   * calm tape is small; in a volatile tape it widens automatically).
   *
   * Quantity is the smaller of the risk-budget size and the notional cap
   * (same protections as `sizeFromStop`). Rounding granularity:
   *   - explicit `lotSize` (e.g. 1e-6 for 6dp BTC, 0.01 for fractional
   *     equity, 1 for whole shares) rounds the quantity DOWN to that step;
   *   - omitted, falls back to the RiskManager's `fractionalQuantity`
   *     setting (8dp truncation when true, whole-unit floor otherwise).
   *
   * Returns 0 when the inputs cannot produce a finite stop distance, so
   * callers can short-circuit signals where ATR is unavailable.
   *
   * Pass `opts.riskPct` to override the global 1% per-trade budget — mirrors
   * `sizeFromStop` (TRA-211) and is the hook the TRA-430 vol-/Kelly sizer uses
   * to feed an effective per-trade risk fraction into ATR-stop callers.
   * Defaults to `DEFAULT_RISK_PER_TRADE` when omitted.
   */
  sizeFromAtr(
    entryPrice: number,
    atr: number,
    atrMultiplier: number,
    lotSize?: number,
    opts: { riskPct?: number } = {},
  ): number {
    if (!Number.isFinite(atr) || atr <= 0) return 0;
    if (!Number.isFinite(atrMultiplier) || atrMultiplier <= 0) return 0;
    const stopDistance = atr * atrMultiplier;
    const truncate = (n: number): number => {
      if (lotSize !== undefined && lotSize > 0) return Math.floor(n / lotSize) * lotSize;
      return this.fractionalQuantity ? Math.floor(n * 1e8) / 1e8 : Math.floor(n);
    };
    const riskBased = truncate(this.maxRiskPerTrade(opts.riskPct) / stopDistance);
    if (entryPrice <= 0) return Math.max(0, riskBased);
    const notionalCap = truncate((this.managedEquity() * this.maxNotionalRatio) / entryPrice);
    return Math.max(0, Math.min(riskBased, notionalCap));
  }
}
