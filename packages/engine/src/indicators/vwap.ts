import type { Candle } from '@trading-app/shared';

export interface VwapState {
  vwap: number;
  stdDev: number;
  upperBand: number;
  lowerBand: number;
}

/** Session VWAP with standard deviation bands. Reset on each new trading session. */
export class VwapTracker {
  private cumulativePV = 0;
  private cumulativeV = 0;
  private squaredDeviations: number[] = [];

  reset(): void {
    this.cumulativePV = 0;
    this.cumulativeV = 0;
    this.squaredDeviations = [];
  }

  update(candle: Candle): VwapState {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    this.cumulativePV += typicalPrice * candle.volume;
    this.cumulativeV += candle.volume;

    const vwap = this.cumulativeV === 0 ? typicalPrice : this.cumulativePV / this.cumulativeV;
    this.squaredDeviations.push((typicalPrice - vwap) ** 2);

    const variance =
      this.squaredDeviations.reduce((a, b) => a + b, 0) / this.squaredDeviations.length;
    const stdDev = Math.sqrt(variance);

    return {
      vwap,
      stdDev,
      upperBand: vwap + stdDev * 1.5,
      lowerBand: vwap - stdDev * 1.5,
    };
  }

  /** Returns true when price is extended beyond 1.5 std from VWAP. */
  isExtended(price: number, state: VwapState): 'above' | 'below' | null {
    if (price > state.upperBand) return 'above';
    if (price < state.lowerBand) return 'below';
    return null;
  }
}
