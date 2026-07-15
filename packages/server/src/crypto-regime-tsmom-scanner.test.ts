import { describe, it, expect, beforeEach } from 'vitest';
import {
  scanRegimeTsmom,
  recordRegimeTsmomScan,
  summarizeRegimeTsmomScans,
  clearRegimeTsmomScans,
  buildRegimeTsmomEodSection,
  observeRegimeTsmom,
  MIN_ROUND_TRIPS_FOR_EXPECTANCY,
  type RegimeTsmomState,
} from './crypto-regime-tsmom-scanner.js';
import {
  REGIME_TSMOM_DEFAULTS,
  resolveRegimeTsmomConfig,
  resolveRegimeTsmomWatchlist,
  isRegimeTsmomEnabled,
  REGIME_TSMOM_OBSERVE_KILLED,
  type RegimeTsmomConfig,
} from './crypto-regime-tsmom-flag.js';
import { CRYPTO_REGIME_DEFAULTS, type CryptoRegimeReading, type CryptoRegimeLabel } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

// TRA-1221 — the observe-only regime-gated TSMOM scanner (sibling to the TRA-1220
// regime overlay + TRA-1216 funding-carry scanner). Proves the §3 regime gate
// truth table, the §5 net-of-taker R convention, the stateful entry/exit/turnover
// bookkeeping, flag-OFF zero-IO, no-lookahead (forming bar dropped), and fail-
// closed-on-null-regime. Read-only: nothing here places or sizes an order.

const NOW = Date.parse('2026-01-15T00:00:00Z');
const FOUR_H = 4 * 60 * 60 * 1000;
const CFG = REGIME_TSMOM_DEFAULTS; // L=100, ±10% bands, 60bps taker + 3bps slip, vol 60

/**
 * Build a closed 4H series (oldest-first) of `L+1` bars: all closes 100 except the
 * last = `price`, so the trailing L-bar return `r_L = price/100 − 1`. The last bar
 * closes one full 4H bucket before NOW so it counts as CLOSED.
 */
function barsAtPrice(symbol: string, price: number, L = 100): Candle[] {
  const n = L + 1;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = i === n - 1 ? price : 100;
    const ts = NOW - (n - i) * FOUR_H; // last bar at NOW - FOUR_H (closed)
    out.push({ symbol, timestamp: ts, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  }
  return out;
}

function reading(
  symbol: string,
  regime: CryptoRegimeLabel | null,
  confidence: number | null = 0.8,
): CryptoRegimeReading {
  return {
    symbol,
    adx: 30,
    plusDI: 25,
    minusDI: 10,
    choppiness: 30,
    efficiencyRatio: 0.5,
    regime,
    direction: regime === 'trend_up' ? 'up' : regime === 'trend_down' ? 'down' : null,
    confidence,
    trendVotes: regime === 'chop' ? 1 : 3,
    reason: regime == null ? 'insufficient_data' : null,
    barCount: 101,
    lastBarTime: new Date(NOW - FOUR_H).toISOString(),
    asOf: new Date(NOW).toISOString(),
  };
}

const flat: RegimeTsmomState = { position: 'flat', entryPrice: null, entryBarTime: null, entryRegime: null };

/**
 * Run the pure scan for one symbol and return its single result. `price` is the
 * last closed bar's close, so `r_L = price/100 − 1` and any would-be exit prices
 * off `price`.
 */
function one(
  symbol: string,
  price: number,
  regime: CryptoRegimeLabel | null,
  prev: RegimeTsmomState = flat,
  cfg: RegimeTsmomConfig = CFG,
  confidence: number | null = 0.8,
) {
  const bars = new Map([[symbol, barsAtPrice(symbol, price)]]);
  const regimes = new Map([[symbol, reading(symbol, regime, confidence)]]);
  const prevs = new Map([[symbol, prev]]);
  return scanRegimeTsmom(bars, regimes, cfg, prevs, NOW)[0];
}

beforeEach(() => clearRegimeTsmomScans());

describe('scanRegimeTsmom — §3 regime gate truth table (from flat)', () => {
  it('trend_up + rL above the entry band ⇒ enter_long', () => {
    const r = one('BTC-USD', 115, 'trend_up'); // rL = +15%
    expect(r.action).toBe('enter_long');
    expect(r.state.position).toBe('long');
    expect(r.wouldBeEntryPrice).toBeCloseTo(115, 6);
    expect(r.state.entryRegime).toBe('trend_up');
  });

  it('trend_up but rL inside the band ⇒ flat (band decides)', () => {
    const r = one('BTC-USD', 105, 'trend_up'); // rL = +5% < 10%
    expect(r.action).toBe('flat');
    expect(r.state.position).toBe('flat');
  });

  it('trend_down + down-momentum past the band ⇒ short_observe (never sized)', () => {
    const r = one('ETH-USD', 85, 'trend_down'); // rL = −15%
    expect(r.action).toBe('short_observe');
    expect(r.state.position).toBe('short_observe');
    expect(r.state.entryRegime).toBe('trend_down');
  });

  it('trend_down but shallow ⇒ flat', () => {
    const r = one('ETH-USD', 95, 'trend_down'); // rL = −5%
    expect(r.action).toBe('flat');
  });

  it('chop suppresses long by default (allowChopLong=false)', () => {
    const r = one('DOGE-USD', 120, 'chop'); // rL = +20%
    expect(r.action).toBe('flat');
    expect(r.state.position).toBe('flat');
  });

  it('chop long allowed when allowChopLong=true', () => {
    const r = one('DOGE-USD', 120, 'chop', flat, { ...CFG, allowChopLong: true });
    expect(r.action).toBe('enter_long');
  });

  it('null/insufficient regime ⇒ fail-closed flat even with strong momentum', () => {
    const r = one('XRP-USD', 130, null); // rL = +30%
    expect(r.action).toBe('flat');
    expect(r.state.position).toBe('flat');
  });

  it('short_observe suppressed when shortObserve=false', () => {
    const r = one('ETH-USD', 80, 'trend_down', flat, { ...CFG, shortObserve: false });
    expect(r.action).toBe('flat');
  });

  it('confidence floor gates a long: trend_up below floor ⇒ flat', () => {
    const r = one('BTC-USD', 120, 'trend_up', flat, { ...CFG, minRegimeConfidence: 0.5 }, 0.3);
    expect(r.action).toBe('flat');
  });

  it('insufficient bars (rL null) ⇒ null action, stays flat', () => {
    const bars = new Map([['BTC-USD', barsAtPrice('BTC-USD', 120).slice(-50)]]); // < L+1 closes
    const regimes = new Map([['BTC-USD', reading('BTC-USD', 'trend_up')]]);
    const r = scanRegimeTsmom(bars, regimes, CFG, new Map(), NOW)[0];
    expect(r.rL).toBeNull();
    expect(r.action).toBeNull();
  });
});

describe('scanRegimeTsmom — held-position transitions', () => {
  const longAt = (price: number): RegimeTsmomState => ({
    position: 'long',
    entryPrice: price,
    entryBarTime: new Date(NOW - 50 * FOUR_H).toISOString(),
    entryRegime: 'trend_up',
  });
  const shortAt = (price: number): RegimeTsmomState => ({
    position: 'short_observe',
    entryPrice: price,
    entryBarTime: new Date(NOW - 50 * FOUR_H).toISOString(),
    entryRegime: 'trend_down',
  });

  it('long held through the dead-zone ⇒ hold_long, no round trip', () => {
    const r = one('BTC-USD', 105, 'trend_up', longAt(100)); // rL +5%, in dead-zone
    expect(r.action).toBe('hold_long');
    expect(r.roundTrip).toBeNull();
    expect(r.state.position).toBe('long');
  });

  it('long exits at the lower band ⇒ exit_long + round trip', () => {
    const r = one('BTC-USD', 85, 'trend_up', longAt(100)); // rL −15% ≤ −10% band
    expect(r.action).toBe('exit_long');
    expect(r.state.position).toBe('flat');
    expect(r.roundTrip?.side).toBe('long');
    expect(r.roundTrip?.exitPrice).toBe(85);
  });

  it('long force-exits when regime leaves trend_up (chop) even if band not crossed', () => {
    const r = one('BTC-USD', 103, 'chop', longAt(100)); // rL +3% (no band), regime flipped
    expect(r.action).toBe('exit_long');
    expect(r.roundTrip?.exitPrice).toBe(103);
  });

  it('long force-exits on trend_down', () => {
    expect(one('BTC-USD', 100, 'trend_down', longAt(100)).action).toBe('exit_long');
  });

  it('long force-exits (fail-closed) on null regime', () => {
    expect(one('BTC-USD', 105, null, longAt(100)).action).toBe('exit_long');
  });

  it('short_observe held while trend_down persists', () => {
    const r = one('ETH-USD', 95, 'trend_down', shortAt(100)); // rL −5%, still bear
    expect(r.action).toBe('short_observe');
    expect(r.roundTrip).toBeNull();
  });

  it('short_observe closes (flat + short round trip) when regime leaves trend_down', () => {
    const r = one('ETH-USD', 95, 'trend_up', shortAt(100)); // regime flipped up
    expect(r.action).toBe('flat');
    expect(r.roundTrip?.side).toBe('short');
    expect(r.state.position).toBe('flat');
  });
});

describe('scanRegimeTsmom — §5 net-of-taker R convention', () => {
  it('long round trip: gross, net-of-fee, and 1R denominator', () => {
    const long = { position: 'long' as const, entryPrice: 100, entryBarTime: null, entryRegime: 'trend_up' as const };
    const r = one('BTC-USD', 105, 'chop', long); // force exit at 105 via regime flip
    const rt = r.roundTrip!;
    // dirGross = 105/100 - 1 = 5%; rtCost = 2*(60+3)bps = 1.26%; 1R = 0.6/√365 ≈ 3.1405%
    expect(rt.grossMovePct).toBeCloseTo(5, 4);
    expect(rt.netMovePct).toBeCloseTo(3.74, 4);
    expect(rt.netR).toBeCloseTo(0.0374 / (0.6 / Math.sqrt(365)), 3);
    expect(rt.netR).toBeCloseTo(1.191, 2);
  });

  it('short round trip earns on a price drop', () => {
    const short = { position: 'short_observe' as const, entryPrice: 100, entryBarTime: null, entryRegime: 'trend_down' as const };
    const r = one('ETH-USD', 95, 'trend_up', short); // regime flips up ⇒ close short at 95
    const rt = r.roundTrip!;
    // dirGross_short = 100/95 - 1 ≈ 5.263%; net ≈ 4.003%
    expect(rt.grossMovePct).toBeCloseTo(5.2632, 3);
    expect(rt.netMovePct).toBeCloseTo(4.0032, 3);
    expect(rt.netR).toBeGreaterThan(0);
  });
});

describe('store — turnover, expectancy, cap + TTL', () => {
  it('folds counts, turnover/yr and net expectancy R with n surfaced', () => {
    // Enter long, then exit after 10 days elapsed → one completed round trip.
    const long = { position: 'long' as const, entryPrice: 100, entryBarTime: null, entryRegime: 'trend_up' as const };
    const enter = one('BTC-USD', 115, 'trend_up');
    recordRegimeTsmomScan([enter], NOW);
    const exit = one('BTC-USD', 105, 'chop', long); // force exit at 105
    const tenDays = NOW + 10 * 86_400_000;
    recordRegimeTsmomScan([exit], tenDays);
    const s = summarizeRegimeTsmomScans(tenDays);
    expect(s.n).toBe(1);
    expect(s.sufficientSample).toBe(false); // 1 < MIN
    expect(s.rollingNetExpectancyR).toBeCloseTo(exit.roundTrip!.netR, 6);
    // 1 round trip over 10 days → 36.5 turnover/yr
    expect(s.rollingTurnoverPerYr).toBeCloseTo(36.5, 1);
  });

  it('marks sufficientSample once ≥ MIN round trips accrue (no silent cap on n)', () => {
    const long = { position: 'long' as const, entryPrice: 100, entryBarTime: null, entryRegime: 'trend_up' as const };
    for (let i = 0; i < MIN_ROUND_TRIPS_FOR_EXPECTANCY; i++) {
      const exit = one(`SYM${i}`, 85, 'trend_up', long); // rL −15% band exit
      recordRegimeTsmomScan([exit], NOW + i);
    }
    const s = summarizeRegimeTsmomScans(NOW + 1000);
    expect(s.n).toBe(MIN_ROUND_TRIPS_FOR_EXPECTANCY);
    expect(s.sufficientSample).toBe(true);
  });

  it('counts long / short_observe / chopped positions in the fresh view', () => {
    recordRegimeTsmomScan(
      [
        one('BTC-USD', 115, 'trend_up'),
        one('ETH-USD', 85, 'trend_down'),
        one('DOGE-USD', 120, 'chop'),
      ],
      NOW,
    );
    const s = summarizeRegimeTsmomScans(NOW);
    expect(s.longCount).toBe(1);
    expect(s.shortObserveCount).toBe(1);
    expect(s.choppedCount).toBe(1);
  });

  it('sweeps entries past the 5h TTL', () => {
    recordRegimeTsmomScan([one('BTC-USD', 115, 'trend_up')], NOW);
    expect(summarizeRegimeTsmomScans(NOW + 5 * 60 * 60_000 - 1).symbolCount).toBe(1);
    expect(summarizeRegimeTsmomScans(NOW + 5 * 60 * 60_000).symbolCount).toBe(0);
  });
});

describe('observeRegimeTsmom — invariants #1/#3', () => {
  it('flag OFF ⇒ fetch4h is NEVER called and the store stays empty (zero-IO)', async () => {
    let calls = 0;
    const res = await observeRegimeTsmom({
      enabled: false,
      watchlist: ['BTC-USD', 'ETH-USD'],
      regimeCfg: CRYPTO_REGIME_DEFAULTS,
      cfg: CFG,
      fetch4h: async (s) => {
        calls++;
        return barsAtPrice(s, 120);
      },
      lastBarBySymbol: new Map(),
      stateBySymbol: new Map(),
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(res).toEqual({ fetched: 0, scanned: 0, results: [] });
    expect(summarizeRegimeTsmomScans(NOW).symbolCount).toBe(0);
  });

  it('flag ON ⇒ fetches, drops the forming bar (no lookahead), scans, threads state', async () => {
    const forming: Candle = { symbol: 'BTC-USD', timestamp: NOW, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const state = new Map<string, RegimeTsmomState>();
    // A strong 4H uptrend so the regime classifier labels it trend_up.
    const up = (s: string): Candle[] => {
      const out: Candle[] = [];
      let price = 100;
      for (let i = 0; i < 130; i++) {
        const open = price;
        const close = price + 3;
        out.push({ symbol: s, timestamp: NOW - (131 - i) * FOUR_H, open, high: close + 0.5, low: open - 0.5, close, volume: 1 });
        price = close;
      }
      return out;
    };
    const res = await observeRegimeTsmom({
      enabled: true,
      watchlist: ['BTC-USD'],
      regimeCfg: CRYPTO_REGIME_DEFAULTS,
      cfg: CFG,
      fetch4h: async (s) => [...up(s), forming],
      lastBarBySymbol: new Map(),
      stateBySymbol: state,
      now: NOW,
    });
    expect(res.fetched).toBe(1);
    expect(res.scanned).toBe(1);
    const view = summarizeRegimeTsmomScans(NOW).scans[0];
    expect(view.symbol).toBe('BTC-USD');
    expect(view.regime).toBe('trend_up'); // classified off the SAME closed series
    expect(view.action).toBe('enter_long');
    // State threaded forward for the next pass.
    expect(state.get('BTC-USD')?.position).toBe('long');
  });
});

describe('buildRegimeTsmomEodSection', () => {
  it('renders a disabled fallback when the scanner is off', () => {
    const md = buildRegimeTsmomEodSection(false, summarizeRegimeTsmomScans(NOW));
    expect(md).toContain('## Crypto Regime-Gated TSMOM');
    expect(md).toContain('scanner disabled');
  });

  it('renders an empty fallback when enabled but no fresh signals', () => {
    expect(buildRegimeTsmomEodSection(true, summarizeRegimeTsmomScans(NOW))).toContain('no fresh signals');
  });

  it('renders a table + provisional expectancy note below the min sample', () => {
    recordRegimeTsmomScan([one('BTC-USD', 115, 'trend_up')], NOW);
    const md = buildRegimeTsmomEodSection(true, summarizeRegimeTsmomScans(NOW));
    expect(md).toContain('| BTC-USD | enter_long | trend_up |');
    expect(md).toContain('Would-be turnover/yr');
  });
});

describe('config + flag resolution (spec §4)', () => {
  it('defaults match the spec', () => {
    const c = resolveRegimeTsmomConfig({});
    expect(c).toMatchObject({ lookbackBars: 100, entryBandPct: 10, exitBandPct: 10, allowChopLong: false, shortObserve: true, volTargetPct: 60, feeBps: 60, slipBps: 3 });
  });

  it('honours valid overrides and fails-closed to defaults on garbage', () => {
    const c = resolveRegimeTsmomConfig({
      CRYPTO_REGIME_TSMOM_ENTRY_BAND_PCT: '15',
      CRYPTO_REGIME_TSMOM_EXIT_BAND_PCT: '-5', // ≤0 → default
      CRYPTO_REGIME_TSMOM_LOOKBACK_BARS: 'abc', // → default
      CRYPTO_REGIME_TSMOM_ALLOW_CHOP_LONG: 'true',
    });
    expect(c.entryBandPct).toBe(15);
    expect(c.exitBandPct).toBe(10); // rejected negative
    expect(c.lookbackBars).toBe(100);
    expect(c.allowChopLong).toBe(true);
  });

  it('watchlist defaults to the 12-major universe', () => {
    expect(resolveRegimeTsmomWatchlist({})).toContain('BTC-USD');
    expect(resolveRegimeTsmomWatchlist({ CRYPTO_REGIME_TSMOM_WATCHLIST: 'sol-usd, avax-usd' })).toEqual(['SOL-USD', 'AVAX-USD']);
  });

  // TRA-1734 — the RETIRE kill. The observe master is permanently dead (TRA-1219
  // RETIRE verdict, TRA-1229 forward gate NO-GO at n=18). `isRegimeTsmomEnabled()`
  // must stay hard-false even when the env flag is explicitly `on`, so no operator
  // and no stale bqb1 env can revive the scanner's cost/IO. If TSMOM is ever
  // revived by a fresh board decision, flip REGIME_TSMOM_OBSERVE_KILLED and this
  // assertion is the trip-wire that forces the revival to be deliberate.
  it('stays killed even with ENABLE_CRYPTO_REGIME_TSMOM=on in env (TRA-1734)', () => {
    expect(REGIME_TSMOM_OBSERVE_KILLED).toBe(true);
    expect(isRegimeTsmomEnabled({ ENABLE_CRYPTO_REGIME_TSMOM: 'on' })).toBe(false);
    expect(isRegimeTsmomEnabled({ ENABLE_CRYPTO_REGIME_TSMOM: 'true' })).toBe(false);
    expect(isRegimeTsmomEnabled({})).toBe(false);
  });
});
