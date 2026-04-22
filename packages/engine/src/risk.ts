import { AccountState, DEFAULT_RISK_PER_TRADE, MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';

export class RiskManager {
  private equity: number;

  constructor(account: AccountState) {
    this.equity = account.totalEquity * MANAGED_ACCOUNT_RATIO;
  }

  /** Maximum dollar risk for one trade (1% of managed equity). */
  maxRiskPerTrade(): number {
    return this.equity * DEFAULT_RISK_PER_TRADE;
  }

  /** Position size in shares given a stop distance. */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const stopDistance = Math.abs(entryPrice - stopPrice);
    if (stopDistance === 0) return 0;
    return Math.floor(this.maxRiskPerTrade() / stopDistance);
  }
}
