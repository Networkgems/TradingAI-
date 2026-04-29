/**
 * TRA-186 BTC kumo-breakout diagnostic.
 *
 * Reproduces the IchimokuStrategy kumo-breakout entry logic on BTC/ETH/SOL
 * 1h Yahoo candles for 90d and 365d windows, but instead of running through
 * BacktestRunner it logs *why* each bar was/was not a signal. Goals:
 *
 *   1. Bar count + gap analysis — is BTC's stream materially shorter / gappier?
 *   2. Indicator readiness — at how many bars does ichimoku() return non-null?
 *   3. Breakout-attempt funnel — for each of:
 *        a) prev close ≤ prev cloudTop AND curr close > curr cloudTop  (bull cross)
 *        b) prev close ≥ prev cloudBottom AND curr close < curr cloudBottom (bear cross)
 *      record how many bars made the cross and how many of *those* failed each
 *      downstream gate (kumoThicknessFloor, TK bias, chikou).
 *   4. Min/max/median priceVsCloud distance for context — is price genuinely
 *      stuck inside the cloud the whole window?
 *
 * Run:
 *   node --import tsx/esm packages/server/src/diagnose-ichimoku-btc.ts
 */

import YahooFinance from 'yahoo-finance2';
import type { Candle } from '@trading-app/shared';
import { ichimoku } from '@trading-app/engine';
import { BacktestRunner } from '@trading-app/backtest';
import { COMMISSION_BPS, SLIPPAGE_BPS } from './backtest-crypto.js';

const yf = new YahooFinance({ validation: { logErrors: false } });

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const WINDOWS = [90, 365];
const KUMO_THICKNESS_FLOOR = 0.005;

interface FunnelCounts {
  bars: number;
  indicatorReady: number;
  // Cross stage: prev/curr cloud-edge cross occurred (regardless of other gates)
  bullCross: number;
  bearCross: number;
  // After-cross gate failures (counted independently per cross side)
  bullKumoTooThin: number;
  bullTKDisagree: number;
  bullChikouDisagree: number;
  bullEmitted: number;
  bearKumoTooThin: number;
  bearTKDisagree: number;
  bearChikouDisagree: number;
  bearEmitted: number;
  // Cloud-position histogram across all indicator-ready bars
  priceAboveCloud: number;
  priceInCloud: number;
  priceBelowCloud: number;
  // Cloud-thickness stats (% of price)
  thicknessSamples: number[];
  // Gap stats: max & median bar-to-bar gap in hours
  gapsHours: number[];
  // Retest path: of armed pendings, why they died
  retestArmed: number;
  retestStopBreached: number;
  retestExpired: number;
  retestTKReversed: number;
  retestChikouReversed: number;
  retestFired: number;
  // Stop-distance stats per breakout (% of price): tight stops mean retest midpoints
  // are very close to breakout close, hard to revisit.
  stopDistancePct: number[];
}

async function fetchCandles(symbol: string, days: number): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1h' });
    const quotes = result.quotes ?? [];
    return quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
      .map(q => ({
        symbol,
        timestamp: new Date(q.date).getTime(),
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
      }));
  } catch (err) {
    console.error(`Failed to fetch ${symbol}:`, err);
    return [];
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

interface PendingProbe {
  side: 'buy' | 'sell';
  armedAtBars: number;
  expiresAtBars: number;
  originalEntry: number;
  retestLevel: number;
  originalStop: number;
}

function analyse(candles: Candle[], retestExpiryBars = 16): FunnelCounts {
  const counts: FunnelCounts = {
    bars: candles.length,
    indicatorReady: 0,
    bullCross: 0, bearCross: 0,
    bullKumoTooThin: 0, bullTKDisagree: 0, bullChikouDisagree: 0, bullEmitted: 0,
    bearKumoTooThin: 0, bearTKDisagree: 0, bearChikouDisagree: 0, bearEmitted: 0,
    priceAboveCloud: 0, priceInCloud: 0, priceBelowCloud: 0,
    thicknessSamples: [],
    gapsHours: [],
    retestArmed: 0, retestStopBreached: 0, retestExpired: 0,
    retestTKReversed: 0, retestChikouReversed: 0, retestFired: 0,
    stopDistancePct: [],
  };
  let pending: PendingProbe | null = null;

  for (let i = 1; i < candles.length; i++) {
    const dtH = (candles[i].timestamp - candles[i - 1].timestamp) / (60 * 60 * 1000);
    counts.gapsHours.push(dtH);
  }

  // Strategy needs candles.length >= 79 (78 for ichimoku + 1 for prev-bar comparison)
  for (let n = 79; n <= candles.length; n++) {
    const window = candles.slice(0, n);
    const cloud = ichimoku(window);
    const prevCloud = ichimoku(window.slice(0, -1));
    if (!cloud || !prevCloud) continue;
    counts.indicatorReady++;

    const latest = window[window.length - 1];
    const prevClose = window[window.length - 2].close;
    const price = latest.close;
    if (price <= 0) continue;

    // First check whether an armed pending fires/dies on this bar — mirrors
    // the strategy's tryFireRetest call which runs *before* the breakout gate.
    if (pending) {
      const breached = pending.side === 'buy'
        ? latest.low <= pending.originalStop
        : latest.high >= pending.originalStop;
      if (breached) {
        counts.retestStopBreached++;
        pending = null;
      } else if (window.length > pending.expiresAtBars) {
        counts.retestExpired++;
        pending = null;
      } else {
        const buyTouch = pending.retestLevel; // tolerance=0
        const sellTouch = pending.retestLevel;
        const touched = pending.side === 'buy'
          ? latest.low <= buyTouch
          : latest.high >= sellTouch;
        if (touched) {
          if (pending.side === 'buy') {
            if (cloud.tenkan <= cloud.kijun) {
              counts.retestTKReversed++;
              pending = null;
            } else if (!cloud.chikouAbove) {
              counts.retestChikouReversed++;
              pending = null;
            } else {
              counts.retestFired++;
              pending = null;
            }
          } else {
            if (cloud.tenkan >= cloud.kijun) {
              counts.retestTKReversed++;
              pending = null;
            } else if (cloud.chikouAbove) {
              counts.retestChikouReversed++;
              pending = null;
            } else {
              counts.retestFired++;
              pending = null;
            }
          }
        }
      }
    }

    if (price > cloud.cloudTop) counts.priceAboveCloud++;
    else if (price < cloud.cloudBottom) counts.priceBelowCloud++;
    else counts.priceInCloud++;

    const thicknessPct = (cloud.cloudTop - cloud.cloudBottom) / price;
    counts.thicknessSamples.push(thicknessPct);

    const bullCross = prevClose <= prevCloud.cloudTop && price > cloud.cloudTop;
    const bearCross = prevClose >= prevCloud.cloudBottom && price < cloud.cloudBottom;

    if (bullCross) {
      counts.bullCross++;
      const kumoOk = thicknessPct >= KUMO_THICKNESS_FLOOR;
      const tkOk = cloud.tenkan > cloud.kijun;
      const chikouOk = cloud.chikouAbove;
      if (!kumoOk) counts.bullKumoTooThin++;
      if (!tkOk) counts.bullTKDisagree++;
      if (!chikouOk) counts.bullChikouDisagree++;
      if (kumoOk && tkOk && chikouOk) {
        counts.bullEmitted++;
        const stopLoss = Math.min(cloud.kijun, cloud.cloudBottom);
        const stopDist = Math.abs(price - stopLoss);
        if (stopDist > 0) {
          counts.stopDistancePct.push(stopDist / price);
          // Arm a new pending — strategy overwrites, so we do too.
          counts.retestArmed++;
          pending = {
            side: 'buy',
            armedAtBars: window.length,
            expiresAtBars: window.length + retestExpiryBars,
            originalEntry: price,
            retestLevel: (price + stopLoss) / 2,
            originalStop: stopLoss,
          };
        }
      }
    }

    if (bearCross) {
      counts.bearCross++;
      const kumoOk = thicknessPct >= KUMO_THICKNESS_FLOOR;
      const tkOk = cloud.tenkan < cloud.kijun;
      const chikouOk = !cloud.chikouAbove;
      if (!kumoOk) counts.bearKumoTooThin++;
      if (!tkOk) counts.bearTKDisagree++;
      if (!chikouOk) counts.bearChikouDisagree++;
      if (kumoOk && tkOk && chikouOk) {
        counts.bearEmitted++;
        const stopLoss = Math.max(cloud.kijun, cloud.cloudTop);
        const stopDist = Math.abs(price - stopLoss);
        if (stopDist > 0) {
          counts.stopDistancePct.push(stopDist / price);
          counts.retestArmed++;
          pending = {
            side: 'sell',
            armedAtBars: window.length,
            expiresAtBars: window.length + retestExpiryBars,
            originalEntry: price,
            retestLevel: (price + stopLoss) / 2,
            originalStop: stopLoss,
          };
        }
      }
    }
  }

  return counts;
}

function pctIn(c: FunnelCounts, side: 'bull' | 'bear'): number {
  return side === 'bull'
    ? (c.indicatorReady > 0 ? (c.bullCross / c.indicatorReady) * 100 : 0)
    : (c.indicatorReady > 0 ? (c.bearCross / c.indicatorReady) * 100 : 0);
}

function printSymbol(symbol: string, days: number, c: FunnelCounts) {
  const expected = days * 24; // hourly bars per day if 24/7 stream were complete
  const coverage = c.bars > 0 ? (c.bars / expected) * 100 : 0;

  const gapMax = c.gapsHours.length > 0 ? Math.max(...c.gapsHours) : 0;
  const gapMed = median(c.gapsHours);
  const gapsBig = c.gapsHours.filter(g => g > 1.5).length;

  const thinMin = c.thicknessSamples.length > 0 ? Math.min(...c.thicknessSamples) * 100 : 0;
  const thinMax = c.thicknessSamples.length > 0 ? Math.max(...c.thicknessSamples) * 100 : 0;
  const thinMed = median(c.thicknessSamples) * 100;
  const thinAboveFloor = c.thicknessSamples.filter(t => t >= KUMO_THICKNESS_FLOOR).length;
  const thinAboveFloorPct = c.thicknessSamples.length > 0 ? (thinAboveFloor / c.thicknessSamples.length) * 100 : 0;

  console.log(`\n  [${symbol}]  bars=${c.bars}  expected≈${expected}  coverage=${coverage.toFixed(1)}%`);
  console.log(`    gaps:    max=${gapMax.toFixed(2)}h  median=${gapMed.toFixed(2)}h  >1.5h=${gapsBig}`);
  console.log(`    indicatorReady=${c.indicatorReady}`);
  console.log(`    cloud position: above=${c.priceAboveCloud}  inside=${c.priceInCloud}  below=${c.priceBelowCloud}`);
  console.log(`    cloudThickness%: min=${thinMin.toFixed(3)}  median=${thinMed.toFixed(3)}  max=${thinMax.toFixed(3)}  ≥0.5%=${thinAboveFloorPct.toFixed(1)}%`);
  console.log(`    bullCross=${c.bullCross} (${pctIn(c, 'bull').toFixed(2)}% of ready)  bearCross=${c.bearCross} (${pctIn(c, 'bear').toFixed(2)}%)`);
  console.log(`    bull funnel: kumoThin=${c.bullKumoTooThin}  tkDisagree=${c.bullTKDisagree}  chikouDisagree=${c.bullChikouDisagree}  → emitted=${c.bullEmitted}`);
  console.log(`    bear funnel: kumoThin=${c.bearKumoTooThin}  tkDisagree=${c.bearTKDisagree}  chikouDisagree=${c.bearChikouDisagree}  → emitted=${c.bearEmitted}`);
  console.log(`    TOTAL EMITTED (immediate-entry baseline) = ${c.bullEmitted + c.bearEmitted}`);

  const stopMin = c.stopDistancePct.length > 0 ? Math.min(...c.stopDistancePct) * 100 : 0;
  const stopMed = median(c.stopDistancePct) * 100;
  const stopMax = c.stopDistancePct.length > 0 ? Math.max(...c.stopDistancePct) * 100 : 0;
  console.log(`    stop dist% per breakout: min=${stopMin.toFixed(3)}  median=${stopMed.toFixed(3)}  max=${stopMax.toFixed(3)}`);
  console.log(`    RETEST FUNNEL: armed=${c.retestArmed}  fired=${c.retestFired}  stopBreached=${c.retestStopBreached}  expired=${c.retestExpired}  tkReversed=${c.retestTKReversed}  chikouReversed=${c.retestChikouReversed}`);
  const fireRate = c.retestArmed > 0 ? (c.retestFired / c.retestArmed) * 100 : 0;
  console.log(`    retest fire rate = ${fireRate.toFixed(1)}%`);
}

async function main() {
  for (const days of WINDOWS) {
    console.log('\n' + '='.repeat(80));
    console.log(`Window: ${days} days × 1h Yahoo candles`);
    console.log('='.repeat(80));
    const symbolCandles = new Map<string, Candle[]>();
    for (const symbol of SYMBOLS) {
      const candles = await fetchCandles(symbol, days);
      symbolCandles.set(symbol, candles);
      if (candles.length === 0) {
        console.log(`\n  [${symbol}]  EMPTY — Yahoo returned 0 valid bars`);
        continue;
      }
      const c = analyse(candles);
      printSymbol(symbol, days, c);
    }

    // Sweep kumoThicknessFloor across {0.005, 0.01, 0.015, 0.02} per symbol
    // to surface the threshold sensitivity that's hiding BTC in the TRA-183
    // sweep's "best config" rows.
    console.log(`\n  KUMO-FLOOR SWEEP (retest fires): how does each floor suppress per-symbol signals?`);
    console.log('  ' + 'Symbol'.padEnd(12) + 'kumo=0.005'.padStart(14) + 'kumo=0.01'.padStart(14) + 'kumo=0.015'.padStart(14) + 'kumo=0.02'.padStart(14));
    for (const [sym, candles] of symbolCandles) {
      if (candles.length === 0) continue;
      const cells: string[] = [];
      for (const floor of [0.005, 0.01, 0.015, 0.02]) {
        const c = analyseFloor(candles, floor);
        cells.push(`${c.retestArmed}→${c.retestFired}`);
      }
      console.log('  ' + sym.padEnd(12) + cells.map(s => s.padStart(14)).join(''));
    }

    // Cross-check vs BacktestRunner so we anchor the diagnostic counts to the
    // actual sweep harness numbers — eliminates "your reproducer disagrees
    // with the runner" doubt when posting back to TRA-186.
    console.log(`\n  BACKTEST-RUNNER CROSS-CHECK (kumo=0.005 baseline retest, costs ON):`);
    const runner = new BacktestRunner();
    for (const [sym, candles] of symbolCandles) {
      if (candles.length === 0) continue;
      const r = await runner.run({
        symbol: sym,
        startDate: candles[0].timestamp,
        endDate: candles[candles.length - 1].timestamp,
        initialEquity: 100_000,
        strategyType: 'ichimoku',
        ichimokuOpts: {
          enforceTimeFilter: false,
          retestEntry: true,
          retestRewardMultiple: 2,
          retestTolerancePct: 0,
          retestExpiryBars: 16,
          kumoThicknessFloor: 0.005,
        },
        commissionBps: COMMISSION_BPS,
        slippageBps: SLIPPAGE_BPS,
      }, candles);
      console.log(`    ${sym.padEnd(10)} runner.totalTrades=${r.totalTrades}  signals=${r.signalEdge?.totalSignals ?? 0}  reachedOneR=${r.signalEdge?.reachedOneR ?? 0}  avgRR=${r.avgRiskReward.toFixed(3)}  pnl=$${r.totalPnl.toFixed(0)}`);
    }
  }
}

function analyseFloor(candles: Candle[], floor: number): FunnelCounts {
  // mutate the module-level constant via a thin wrapper without touching analyse()
  const saved = (globalThis as any).__KUMO_FLOOR__;
  (globalThis as any).__KUMO_FLOOR__ = floor;
  const result = analyseWithFloor(candles, floor);
  (globalThis as any).__KUMO_FLOOR__ = saved;
  return result;
}

function analyseWithFloor(candles: Candle[], floor: number): FunnelCounts {
  // Lightweight reimplementation of analyse() that takes the floor explicitly,
  // to keep the original analyse() call unchanged for the per-symbol detail output.
  const counts: FunnelCounts = {
    bars: candles.length, indicatorReady: 0,
    bullCross: 0, bearCross: 0,
    bullKumoTooThin: 0, bullTKDisagree: 0, bullChikouDisagree: 0, bullEmitted: 0,
    bearKumoTooThin: 0, bearTKDisagree: 0, bearChikouDisagree: 0, bearEmitted: 0,
    priceAboveCloud: 0, priceInCloud: 0, priceBelowCloud: 0,
    thicknessSamples: [], gapsHours: [],
    retestArmed: 0, retestStopBreached: 0, retestExpired: 0,
    retestTKReversed: 0, retestChikouReversed: 0, retestFired: 0,
    stopDistancePct: [],
  };
  let pending: PendingProbe | null = null;
  for (let n = 79; n <= candles.length; n++) {
    const window = candles.slice(0, n);
    const cloud = ichimoku(window);
    const prevCloud = ichimoku(window.slice(0, -1));
    if (!cloud || !prevCloud) continue;
    counts.indicatorReady++;
    const latest = window[window.length - 1];
    const prevClose = window[window.length - 2].close;
    const price = latest.close;
    if (price <= 0) continue;

    if (pending) {
      const breached = pending.side === 'buy'
        ? latest.low <= pending.originalStop
        : latest.high >= pending.originalStop;
      if (breached) { counts.retestStopBreached++; pending = null; }
      else if (window.length > pending.expiresAtBars) { counts.retestExpired++; pending = null; }
      else {
        const touched = pending.side === 'buy'
          ? latest.low <= pending.retestLevel
          : latest.high >= pending.retestLevel;
        if (touched) {
          if (pending.side === 'buy') {
            if (cloud.tenkan <= cloud.kijun) { counts.retestTKReversed++; pending = null; }
            else if (!cloud.chikouAbove) { counts.retestChikouReversed++; pending = null; }
            else { counts.retestFired++; pending = null; }
          } else {
            if (cloud.tenkan >= cloud.kijun) { counts.retestTKReversed++; pending = null; }
            else if (cloud.chikouAbove) { counts.retestChikouReversed++; pending = null; }
            else { counts.retestFired++; pending = null; }
          }
        }
      }
    }

    const thicknessPct = (cloud.cloudTop - cloud.cloudBottom) / price;
    const bullCross = prevClose <= prevCloud.cloudTop && price > cloud.cloudTop;
    const bearCross = prevClose >= prevCloud.cloudBottom && price < cloud.cloudBottom;
    if (bullCross && thicknessPct >= floor && cloud.tenkan > cloud.kijun && cloud.chikouAbove) {
      const stopLoss = Math.min(cloud.kijun, cloud.cloudBottom);
      const stopDist = Math.abs(price - stopLoss);
      if (stopDist > 0) {
        counts.retestArmed++;
        pending = {
          side: 'buy', armedAtBars: window.length, expiresAtBars: window.length + 16,
          originalEntry: price, retestLevel: (price + stopLoss) / 2, originalStop: stopLoss,
        };
      }
    }
    if (bearCross && thicknessPct >= floor && cloud.tenkan < cloud.kijun && !cloud.chikouAbove) {
      const stopLoss = Math.max(cloud.kijun, cloud.cloudTop);
      const stopDist = Math.abs(price - stopLoss);
      if (stopDist > 0) {
        counts.retestArmed++;
        pending = {
          side: 'sell', armedAtBars: window.length, expiresAtBars: window.length + 16,
          originalEntry: price, retestLevel: (price + stopLoss) / 2, originalStop: stopLoss,
        };
      }
    }
  }
  return counts;
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.replace(/\\/g, '/').endsWith('/diagnose-ichimoku-btc.ts')
      || entry.replace(/\\/g, '/').endsWith('/diagnose-ichimoku-btc.js');
})();
if (invokedAsScript) {
  main().catch(err => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
  });
}

export { analyse, fetchCandles };
