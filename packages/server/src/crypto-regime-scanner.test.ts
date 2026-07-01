import { describe, it, expect, beforeEach } from 'vitest';
import {
  scanCryptoRegime,
  recordCryptoRegimeScan,
  summarizeCryptoRegimeScans,
  clearCryptoRegimeScans,
  buildCryptoRegimeEodSection,
  observeCryptoRegime,
} from './crypto-regime-scanner.js';
import { CRYPTO_REGIME_DEFAULTS, type CryptoRegimeReading } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

// TRA-1220 — the observe-only crypto regime scanner (sibling to the TRA-1216
// funding-carry scanner). Proves the pure scan folds classifier readings, the
// trend-first + confidence ranking, and the in-memory store's cap-128 oldest-first
// eviction + TTL sweep. Read-only: nothing here places or sizes an order.

const NOW = Date.parse('2026-01-15T00:00:00Z');
const FOUR_H = 4 * 60 * 60 * 1000;

function candle(i: number, high: number, low: number, close: number, open = close): Candle {
  return { symbol: 'X', timestamp: NOW - (200 - i) * FOUR_H, open, high, low, close, volume: 1 };
}

function uptrend(symbol: string, n = 80, step = 2): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + step;
    out.push({ ...candle(i, close + 0.5, open - 0.5, close, open), symbol });
    price = close;
  }
  return out;
}

function chop(symbol: string, n = 80): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const up = i % 2 === 0;
    out.push({ ...candle(i, 101.5, 98.5, up ? 101 : 99, up ? 99 : 101), symbol });
  }
  return out;
}

/** Minimal well-formed reading for store-level (cap/TTL) tests. */
function reading(symbol: string): CryptoRegimeReading {
  return {
    symbol,
    adx: 30,
    plusDI: 25,
    minusDI: 10,
    choppiness: 30,
    efficiencyRatio: 0.5,
    regime: 'chop',
    direction: null,
    confidence: 0.5,
    trendVotes: 1,
    reason: null,
    barCount: 80,
    lastBarTime: new Date(NOW).toISOString(),
    asOf: new Date(NOW).toISOString(),
  };
}

beforeEach(() => clearCryptoRegimeScans());

describe('scanCryptoRegime — pure fold + ranking', () => {
  it('classifies each symbol and ranks trend before chop', () => {
    const barsBySymbol = new Map<string, Candle[]>([
      ['BTC-USD', uptrend('BTC-USD')],
      ['DOGE-USD', chop('DOGE-USD')],
    ]);
    const readings = scanCryptoRegime(barsBySymbol, CRYPTO_REGIME_DEFAULTS, NOW);
    expect(readings).toHaveLength(2);
    expect(readings[0].regime).toBe('trend_up');
    expect(readings[0].symbol).toBe('BTC-USD');
    expect(readings[1].regime).toBe('chop');
  });

  it('accepts a plain record and keys the reading on the map key', () => {
    const readings = scanCryptoRegime({ 'eth-usd': uptrend('whatever') }, CRYPTO_REGIME_DEFAULTS, NOW);
    expect(readings[0].symbol).toBe('ETH-USD');
    expect(readings[0].regime).toBe('trend_up');
  });

  it('surfaces insufficient_data (not a thrown error) for short series, ranked last', () => {
    const barsBySymbol = new Map<string, Candle[]>([
      ['BTC-USD', uptrend('BTC-USD')],
      ['SHORT', uptrend('SHORT', 10)],
    ]);
    const readings = scanCryptoRegime(barsBySymbol, CRYPTO_REGIME_DEFAULTS, NOW);
    expect(readings[readings.length - 1].symbol).toBe('SHORT');
    expect(readings[readings.length - 1].reason).toBe('insufficient_data');
    expect(readings[readings.length - 1].regime).toBeNull();
  });
});

describe('crypto regime store — cap + TTL', () => {
  it('summarizes counts and folds into the health shape', () => {
    const readings = scanCryptoRegime(
      new Map([
        ['BTC-USD', uptrend('BTC-USD')],
        ['DOGE-USD', chop('DOGE-USD')],
      ]),
      CRYPTO_REGIME_DEFAULTS,
      NOW,
    );
    recordCryptoRegimeScan(readings, NOW);
    const summary = summarizeCryptoRegimeScans(NOW);
    expect(summary.symbolCount).toBe(2);
    expect(summary.trendCount).toBe(1);
    expect(summary.chopCount).toBe(1);
    expect(summary.scans[0].recordedAt).toBe(new Date(NOW).toISOString());
  });

  it('evicts oldest-first past the 128-symbol cap', () => {
    for (let i = 0; i < 130; i++) {
      recordCryptoRegimeScan([reading(`SYM${i}`)], NOW + i);
    }
    const summary = summarizeCryptoRegimeScans(NOW + 200);
    expect(summary.symbolCount).toBe(128);
    // SYM0 / SYM1 (oldest two) evicted; SYM2 survives.
    const symbols = summary.scans.map((s) => s.symbol);
    expect(symbols).not.toContain('SYM0');
    expect(symbols).not.toContain('SYM1');
    expect(symbols).toContain('SYM2');
  });

  it('sweeps entries past the 5h TTL on read', () => {
    recordCryptoRegimeScan(scanCryptoRegime(new Map([['BTC-USD', uptrend('BTC-USD')]]), CRYPTO_REGIME_DEFAULTS, NOW), NOW);
    // Just under 5h → still fresh.
    expect(summarizeCryptoRegimeScans(NOW + 5 * 60 * 60_000 - 1).symbolCount).toBe(1);
    // At/after 5h → swept.
    expect(summarizeCryptoRegimeScans(NOW + 5 * 60 * 60_000).symbolCount).toBe(0);
  });

  it('latest-wins per symbol', () => {
    recordCryptoRegimeScan(scanCryptoRegime(new Map([['BTC-USD', uptrend('BTC-USD')]]), CRYPTO_REGIME_DEFAULTS, NOW), NOW);
    recordCryptoRegimeScan(scanCryptoRegime(new Map([['BTC-USD', chop('BTC-USD')]]), CRYPTO_REGIME_DEFAULTS, NOW + 1), NOW + 1);
    const summary = summarizeCryptoRegimeScans(NOW + 2);
    expect(summary.symbolCount).toBe(1);
    expect(summary.scans[0].regime).toBe('chop');
  });
});

describe('observeCryptoRegime — zero-IO when off + dedupe (invariants #1/#3/#6)', () => {
  it('flag OFF ⇒ fetch4h is NEVER called, store stays empty', async () => {
    let calls = 0;
    const fetch4h = async (s: string) => {
      calls++;
      return uptrend(s);
    };
    const res = await observeCryptoRegime({
      enabled: false,
      watchlist: ['BTC-USD', 'ETH-USD'],
      cfg: CRYPTO_REGIME_DEFAULTS,
      fetch4h,
      lastBarBySymbol: new Map(),
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(res).toEqual({ fetched: 0, recorded: 0, readings: [] });
    expect(summarizeCryptoRegimeScans(NOW).symbolCount).toBe(0);
  });

  it('flag ON ⇒ fetches, classifies, and records', async () => {
    const res = await observeCryptoRegime({
      enabled: true,
      watchlist: ['BTC-USD'],
      cfg: CRYPTO_REGIME_DEFAULTS,
      fetch4h: async (s) => uptrend(s),
      lastBarBySymbol: new Map(),
      now: NOW,
    });
    expect(res.fetched).toBe(1);
    expect(res.recorded).toBe(1);
    expect(summarizeCryptoRegimeScans(NOW).scans[0].symbol).toBe('BTC-USD');
  });

  it('drops the in-progress forming bar (no lookahead)', async () => {
    const forming: Candle = { symbol: 'BTC-USD', timestamp: NOW, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    let seenBarCount = -1;
    await observeCryptoRegime({
      enabled: true,
      watchlist: ['BTC-USD'],
      cfg: CRYPTO_REGIME_DEFAULTS,
      fetch4h: async (s) => [...uptrend(s), forming],
      lastBarBySymbol: new Map(),
      now: NOW,
    });
    seenBarCount = summarizeCryptoRegimeScans(NOW).scans[0].barCount;
    // The forming bar (timestamp == NOW, bucket not elapsed) must be excluded.
    expect(seenBarCount).toBe(80);
  });

  it('dedupes: a symbol whose newest closed bar is unchanged is not re-recorded', async () => {
    const dedupe = new Map<string, string>();
    const first = await observeCryptoRegime({
      enabled: true,
      watchlist: ['BTC-USD'],
      cfg: CRYPTO_REGIME_DEFAULTS,
      fetch4h: async (s) => uptrend(s),
      lastBarBySymbol: dedupe,
      now: NOW,
    });
    expect(first.recorded).toBe(1);
    const second = await observeCryptoRegime({
      enabled: true,
      watchlist: ['BTC-USD'],
      cfg: CRYPTO_REGIME_DEFAULTS,
      fetch4h: async (s) => uptrend(s), // same bars ⇒ same last bar time
      lastBarBySymbol: dedupe,
      now: NOW,
    });
    expect(second.fetched).toBe(1); // still fetched
    expect(second.recorded).toBe(0); // but not re-classified/recorded
  });
});

describe('buildCryptoRegimeEodSection', () => {
  it('renders a disabled fallback when the overlay is off', () => {
    const md = buildCryptoRegimeEodSection(false, summarizeCryptoRegimeScans(NOW));
    expect(md).toContain('## Crypto Regime Overlay');
    expect(md).toContain('overlay disabled');
  });

  it('renders an empty fallback when enabled but no fresh labels', () => {
    const md = buildCryptoRegimeEodSection(true, summarizeCryptoRegimeScans(NOW));
    expect(md).toContain('no fresh regime labels');
  });

  it('renders a table of labels when populated', () => {
    recordCryptoRegimeScan(scanCryptoRegime(new Map([['BTC-USD', uptrend('BTC-USD')]]), CRYPTO_REGIME_DEFAULTS, NOW), NOW);
    const md = buildCryptoRegimeEodSection(true, summarizeCryptoRegimeScans(NOW));
    expect(md).toContain('| BTC-USD | trend_up |');
    expect(md).toContain('| Symbol | Regime | Conf | ADX | CHOP | ER | Last 4H bar |');
  });
});
