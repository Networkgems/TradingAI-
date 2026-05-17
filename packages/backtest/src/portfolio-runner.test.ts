import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { cryptoTieredCostModel } from '@trading-app/engine';
import { PortfolioBacktestRunner } from './portfolio-runner.js';
import type { PortfolioBacktestConfig } from './portfolio-runner.js';
import { cachePathFor4h } from './fetch-tra266-data.js';

/** Resample 4H bars to daily UTC closes — the §3 correlation source. */
function toDailyCandles(bars: Candle[]): Candle[] {
  const byDay = new Map<number, Candle[]>();
  for (const b of bars) {
    const day = Math.floor(b.timestamp / 864e5) * 864e5;
    const group = byDay.get(day);
    if (group) group.push(b);
    else byDay.set(day, [b]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, group]) => ({
      symbol: group[0].symbol,
      timestamp: day,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
    }));
}

/** Load a cached 4H Coinbase series from disk; returns null when absent. */
function loadCached4h(symbol: string): Candle[] | null {
  const path = cachePathFor4h(symbol);
  if (!existsSync(path)) return null;
  const cache = JSON.parse(readFileSync(path, 'utf-8')) as { candles: Candle[] };
  return cache.candles;
}

// ── TRA-429: synthetic deterministic check — no disk dependency ───────────────

/**
 * Planted-breakout 4H series for one symbol. A warmup-noise leg, a tight
 * consolidation coil, then a confirmed breakout bar with follow-through —
 * the same shape `runner.test.ts` uses to fire `breakout_vol` deterministically.
 * Parameterised by `symbol` so two co-timed series can be ticked together.
 */
function plantedBreakoutSeries(symbol: string): Candle[] {
  const candles: Candle[] = [];
  const baselineVolume = 1000;
  let timestamp = Date.UTC(2024, 0, 1);
  const step = 4 * 60 * 60 * 1000;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return (seed / 2 ** 32) - 0.5;
  };
  for (let i = 0; i < 80; i++) {
    const px = 100 + Math.sin(i * 0.4) * 0.4 + rand() * 0.2;
    candles.push({
      symbol, timestamp,
      open: px, high: px + 0.3, low: px - 0.3, close: px,
      volume: baselineVolume + rand() * 100,
    });
    timestamp += step;
  }
  for (let i = 0; i < 20; i++) {
    const px = i % 2 === 0 ? 100.5 : 99.5;
    candles.push({
      symbol, timestamp,
      open: px, high: 100.5, low: 99.5, close: px, volume: baselineVolume,
    });
    timestamp += step;
  }
  // Breakout bar with confirming volume.
  candles.push({
    symbol, timestamp,
    open: 100.5, high: 102.0, low: 100.0, close: 102.0,
    volume: baselineVolume * 2.5,
  });
  timestamp += step;
  // Follow-through up so the bracket has room to resolve.
  for (let i = 0; i < 30; i++) {
    const px = 102.0 + i * 0.25;
    candles.push({
      symbol, timestamp,
      open: px, high: px + 0.3, low: px - 0.2, close: px + 0.15,
      volume: baselineVolume + rand() * 100,
    });
    timestamp += step;
  }
  return candles;
}

describe('PortfolioBacktestRunner — shared portfolio state', () => {
  it('throws on an empty symbol list', async () => {
    await expect(
      new PortfolioBacktestRunner().run(
        {
          symbols: [],
          startDate: 0,
          endDate: Number.MAX_SAFE_INTEGER,
          initialEquity: 25_000,
          strategyType: 'breakout_vol',
        },
        {},
      ),
    ).rejects.toThrow(/symbols is empty/);
  });

  it('reports no cap stats when the correlation cap is disabled', async () => {
    const candlesBySymbol = {
      'AAA-USD': plantedBreakoutSeries('AAA-USD'),
      'BBB-USD': plantedBreakoutSeries('BBB-USD'),
    };
    const result = await new PortfolioBacktestRunner().run(
      {
        symbols: ['AAA-USD', 'BBB-USD'],
        startDate: 0,
        endDate: Number.MAX_SAFE_INTEGER,
        initialEquity: 25_000,
        strategyType: 'breakout_vol',
      },
      candlesBySymbol,
    );
    expect(result.correlationCap).toBeUndefined();
    // Both symbols are part of the same shared book.
    expect(Object.keys(result.bySymbol).sort()).toEqual(['AAA-USD', 'BBB-USD']);
  });

  it('ticks both symbols and books trades on each against one shared book', async () => {
    const candlesBySymbol = {
      'AAA-USD': plantedBreakoutSeries('AAA-USD'),
      'BBB-USD': plantedBreakoutSeries('BBB-USD'),
    };
    const result = await new PortfolioBacktestRunner().run(
      {
        symbols: ['AAA-USD', 'BBB-USD'],
        startDate: 0,
        endDate: Number.MAX_SAFE_INTEGER,
        initialEquity: 25_000,
        strategyType: 'breakout_vol',
        // Wide caps so both planted breakouts can open simultaneously.
        portfolioOpts: { maxOpenPositions: 10, maxSectorExposure: 10 },
      },
      candlesBySymbol,
    );
    expect(result.totalTrades).toBeGreaterThan(0);
    // Trades land on both symbols (the runner ticks each forward).
    expect(result.bySymbol['AAA-USD'].totalTrades).toBeGreaterThan(0);
    expect(result.bySymbol['BBB-USD'].totalTrades).toBeGreaterThan(0);
    // Per-symbol counts reconcile with the aggregate.
    expect(
      result.bySymbol['AAA-USD'].totalTrades + result.bySymbol['BBB-USD'].totalTrades,
    ).toBe(result.totalTrades);
  });

  it('binds the cross-symbol correlation-cluster cap on a co-moving basket', async () => {
    const candlesBySymbol = {
      'AAA-USD': plantedBreakoutSeries('AAA-USD'),
      'BBB-USD': plantedBreakoutSeries('BBB-USD'),
    };
    // Both symbols breakout on the same bar ⇒ two breakout_vol positions
    // target one ρ=1.0 cluster simultaneously. A cluster cap of one position
    // must reject the second symbol's entry — pure cross-symbol enforcement.
    const base: PortfolioBacktestConfig = {
      symbols: ['AAA-USD', 'BBB-USD'],
      startDate: 0,
      endDate: Number.MAX_SAFE_INTEGER,
      initialEquity: 25_000,
      strategyType: 'breakout_vol',
      // Wide count/sector caps so the correlation cluster cap — not the
      // legacy maxOpen/maxSector gate — is the thing that binds.
      portfolioOpts: { maxOpenPositions: 10, maxSectorExposure: 10 },
    };
    const off = await new PortfolioBacktestRunner().run(base, candlesBySymbol);
    const on = await new PortfolioBacktestRunner().run(
      {
        ...base,
        correlationCapOpts: {
          enabled: true,
          config: { maxPositionsPerCluster: 1 },
        },
      },
      candlesBySymbol,
    );
    expect(on.correlationCap?.enabled).toBe(true);
    // The cross-symbol cluster cap demonstrably binds (TRA-429 acceptance).
    const capActivity =
      (on.correlationCap?.rejected ?? 0) + (on.correlationCap?.scaledDown ?? 0);
    expect(capActivity).toBeGreaterThan(0);
    // Binding the cap can only remove or shrink entries, never add them.
    expect(on.totalTrades).toBeLessThanOrEqual(off.totalTrades);
  });
});

// ── TRA-429: regression on the real {BTC-USD, SOL-USD} macd_bollinger book ─────

describe('PortfolioBacktestRunner — BTC-USD + SOL-USD cross-symbol cap (TRA-429)', () => {
  const btc = loadCached4h('BTC-USD');
  const sol = loadCached4h('SOL-USD');
  const haveData = btc !== null && sol !== null;
  const maybe = haveData ? it : it.skip;

  maybe('binds the cross-symbol cluster cap on historical 4H data', async () => {
    const candlesBySymbol = { 'BTC-USD': btc!, 'SOL-USD': sol! };
    const daily = {
      'BTC-USD': toDailyCandles(btc!),
      'SOL-USD': toDailyCandles(sol!),
    };
    // Restrict to the genuinely-OOS window the TRA-423 §8 validation used.
    const OOS_START = Date.UTC(2025, 0, 1);
    const OOS_END = Date.now();
    const base: PortfolioBacktestConfig = {
      symbols: ['BTC-USD', 'SOL-USD'],
      startDate: OOS_START,
      endDate: OOS_END,
      initialEquity: 25_000,
      strategyType: 'macd_bollinger',
      macdBollingerOpts: { enforceTimeFilter: false },
      costModel: cryptoTieredCostModel(),
      // Wide legacy caps so the correlation cluster cap is the binding gate.
      portfolioOpts: { maxOpenPositions: 10, maxSectorExposure: 10 },
    };

    const off = await new PortfolioBacktestRunner().run(base, candlesBySymbol);
    const on = await new PortfolioBacktestRunner().run(
      {
        ...base,
        correlationCapOpts: { enabled: true, dailyCandlesBySymbol: daily },
      },
      candlesBySymbol,
    );

    // The runner shares one book — trades land on both BTC and SOL.
    expect(off.bySymbol['BTC-USD'].totalTrades).toBeGreaterThan(0);
    expect(off.bySymbol['SOL-USD'].totalTrades).toBeGreaterThan(0);

    // BTC-USD and SOL-USD are highly correlated ⇒ one cluster. With
    // macd_bollinger fanning to two sub-strategies per symbol, the shared
    // book exceeds the default maxPositionsPerCluster ⇒ the cross-symbol
    // cluster cap binds. This is the coverage TRA-423 §8 could not reach.
    expect(on.correlationCap?.enabled).toBe(true);
    const capActivity =
      (on.correlationCap?.rejected ?? 0) + (on.correlationCap?.scaledDown ?? 0);
    expect(capActivity).toBeGreaterThan(0);

    // Enforcing the cap can only drop / shrink entries.
    expect(on.totalTrades).toBeLessThanOrEqual(off.totalTrades);
  });
});
