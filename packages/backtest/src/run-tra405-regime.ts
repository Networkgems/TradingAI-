/**
 * TRA-405 — regime-threshold calibration check on real 4H crypto data.
 *
 * TRA-402 §4: ADX 25/20 and the 0.5% ATR floor are TradingView equity defaults,
 * never calibrated to crypto. This slides the engine's `classifyRegime` over the
 * cached real 4H series and tallies the label mix under the shipped defaults vs
 * candidate crypto-tuned thresholds, so the recommendation is data-grounded.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { classifyRegime, type Regime, type RegimeDetectorOptions } from '@trading-app/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'];

const VARIANTS: Array<{ label: string; opts: RegimeDetectorOptions }> = [
  { label: 'default (ADX 25/20, ATRfloor 0.50%)', opts: {} },
  { label: 'crypto-A (ADX 22/18, ATRfloor 0.25%)', opts: { adxTrend: 22, adxRange: 18, atrPctFloor: 0.0025 } },
  { label: 'crypto-B (ADX 20/15, ATRfloor 0.15%)', opts: { adxTrend: 20, adxRange: 15, atrPctFloor: 0.0015 } },
];

function load(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`), 'utf-8'));
  return raw.candles as Candle[];
}

function tally(candles: Candle[], opts: RegimeDetectorOptions): Record<Regime, number> {
  const counts: Record<Regime, number> = { trend_up: 0, trend_down: 0, range: 0, high_vol: 0, flat: 0 };
  // Stateless candidate-label tally (no hysteresis) — measures how often each
  // raw label is reachable, which is what threshold calibration cares about.
  for (let i = 60; i <= candles.length; i++) {
    counts[classifyRegime(candles.slice(Math.max(0, i - 250), i), opts)] += 1;
  }
  return counts;
}

function main() {
  for (const variant of VARIANTS) {
    console.log(`\n=== ${variant.label} ===`);
    console.log('symbol     trend%  range%  highVol%  flat%');
    for (const symbol of SYMBOLS) {
      const candles = load(symbol);
      const c = tally(candles, variant.opts);
      const n = Object.values(c).reduce((s, v) => s + v, 0);
      const pct = (v: number) => ((v / n) * 100).toFixed(1).padStart(6);
      console.log(
        `${symbol.padEnd(10)} ${pct(c.trend_up + c.trend_down)} ${pct(c.range)} ${pct(c.high_vol)}   ${pct(c.flat)}`,
      );
    }
  }
}

main();
