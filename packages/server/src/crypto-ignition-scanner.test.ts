import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scanIgnition,
  resolveIgnition,
  observeIgnition,
  summarizeIgnitionScans,
  clearIgnitionScans,
  MIN_RESOLVED_FOR_EXPECTANCY,
} from './crypto-ignition-scanner.js';
import {
  IGNITION_DEFAULTS,
  resolveIgnitionConfig,
  resolveIgnitionWatchlist,
  isCryptoIgnitionEnabled,
  CRYPTO_IGNITION_DEFAULT_WATCHLIST,
  type IgnitionConfig,
} from './crypto-ignition-flag.js';
import { CRYPTO_REGIME_DEFAULTS } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

// TRA-1271 — observe-only crypto ignition scanner (sibling to the TRA-1221
// regime-TSMOM + TRA-1216 funding-carry scanners). Proves the §2 five-condition
// AND trigger (fire + each single-condition fail + fail-closed), the §3 pessimistic
// forward resolution (stop-first), the §3 net-of-fee R for BOTH fee arms, the ★
// would-a-limit-fill instrument, flag-OFF zero-IO, and the §1 never-loosen config
// clamp. Read-only: nothing here places or sizes an order.

const SYM = 'TEST-USD';
const FOUR_H = 4 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00Z');

function bar(i: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return { symbol: SYM, timestamp: BASE + i * FOUR_H, open: o, high: h, low: l, close: c, volume: v };
}

/**
 * 60-bar coiled→breakout bull series that FIRES: 59 tight bars at 100 (channel
 * width 1.0), then a breakout close 103 on 6× volume. need = max(30,20,30,50)+1 = 51.
 */
function firingBars(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 59; i++) out.push(bar(i, 100, 100.5, 99.5, 100, 1));
  out.push(bar(59, 100, 103.5, 100, 103, 6)); // breakout
  return out;
}

describe('scanIgnition — §2 five-condition trigger', () => {
  it('fires on a coiled breakout + RVOL≥6 + EMA50-up + bull regime', () => {
    const sig = scanIgnition(firingBars(), IGNITION_DEFAULTS, 'trend_up');
    expect(sig.fired).toBe(true);
    expect(sig.signalClose).toBe(103);
    expect(sig.rvol).toBeGreaterThanOrEqual(6);
    expect(sig.signalBarTime).toBe(new Date(BASE + 59 * FOUR_H).toISOString());
  });

  it('does NOT fire when the Donchian breakout fails', () => {
    const bars = firingBars();
    bars[40] = bar(40, 100, 104, 99.5, 100, 1); // a prior high above the breakout close
    const sig = scanIgnition(bars, IGNITION_DEFAULTS, 'trend_up');
    expect(sig.fired).toBe(false);
    expect(sig.failReason).toBe('no_donchian_breakout');
  });

  it('does NOT fire when the squeeze (tightness) fails', () => {
    const bars = firingBars();
    bars[40] = bar(40, 100, 100.5, 80, 100, 1); // a deep prior low widens the channel
    const sig = scanIgnition(bars, IGNITION_DEFAULTS, 'trend_up');
    expect(sig.fired).toBe(false);
    expect(sig.failReason).toBe('no_squeeze');
  });

  it('does NOT fire when RVOL is below the threshold', () => {
    const bars = firingBars();
    bars[59] = bar(59, 100, 103.5, 100, 103, 1); // breakout on baseline volume
    const sig = scanIgnition(bars, IGNITION_DEFAULTS, 'trend_up');
    expect(sig.fired).toBe(false);
    expect(sig.failReason).toBe('low_rvol');
  });

  it('does NOT fire when the close is below the EMA50 trend', () => {
    // A far-back 10000 plateau (outside the donch/squeeze/vol windows but
    // inside the 50-bar EMA window) lifts EMA50 far above the breakout close.
    const out: Candle[] = [];
    for (let i = 0; i < 29; i++) out.push(bar(i, 10000, 10000, 10000, 10000, 1));
    for (let i = 29; i < 59; i++) out.push(bar(i, 100, 100.5, 99.5, 100, 1));
    out.push(bar(59, 100, 103.5, 100, 103, 6));
    const sig = scanIgnition(out, IGNITION_DEFAULTS, 'trend_up');
    expect(sig.fired).toBe(false);
    expect(sig.failReason).toBe('below_trend');
  });

  it('does NOT fire in a non-bull regime (bull-only) and fails closed on a missing regime', () => {
    expect(scanIgnition(firingBars(), IGNITION_DEFAULTS, 'chop').fired).toBe(false);
    expect(scanIgnition(firingBars(), IGNITION_DEFAULTS, 'trend_down').fired).toBe(false);
    const miss = scanIgnition(firingBars(), IGNITION_DEFAULTS, null);
    expect(miss.fired).toBe(false);
    expect(miss.failReason).toBe('no_regime');
  });

  it('allows any non-null regime when bullOnly is off', () => {
    const cfg: IgnitionConfig = { ...IGNITION_DEFAULTS, bullOnly: false };
    expect(scanIgnition(firingBars(), cfg, 'chop').fired).toBe(true);
    expect(scanIgnition(firingBars(), cfg, null).fired).toBe(false); // still fail-closed on missing
  });

  it('fails closed on short history, NaN, and a synthetic last bar', () => {
    expect(scanIgnition(firingBars().slice(0, 40), IGNITION_DEFAULTS, 'trend_up').failReason).toBe(
      'insufficient_history',
    );
    const nan = firingBars();
    nan[59] = bar(59, 100, NaN, 100, NaN, 6);
    expect(scanIgnition(nan, IGNITION_DEFAULTS, 'trend_up').fired).toBe(false);
    const synth = firingBars();
    synth[59] = { ...synth[59], synthetic: true };
    const s = scanIgnition(synth, IGNITION_DEFAULTS, 'trend_up');
    expect(s.fired).toBe(false);
    expect(s.failReason).toBe('synthetic_bar');
  });
});

describe('resolveIgnition — §3 pessimistic forward resolution + fee arms', () => {
  const CFG: IgnitionConfig = { ...IGNITION_DEFAULTS, maxHoldBars: 3 };
  // Series shape: [signalBar, entryBar, f1, f2, f3]. signalIdx=0, entryIdx=1.
  // entry open = 100 ⇒ tp10=110/sl4=96, tp15=115/sl5=95.

  it('resolves a clean TP as +2.5R gross with maker net-R > taker net-R', () => {
    const bars = [
      bar(0, 99, 99, 99, 99, 1), // signal close 99 ⇒ maker limit 99
      bar(1, 100, 100, 100, 100, 1),
      bar(2, 100, 111, 100, 110, 1), // hits tp10 (110), not tp15 (115), no stop
      bar(3, 110, 112, 108, 111, 1),
      bar(4, 111, 113, 109, 112, 1), // secondary times out at maxHold
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res).not.toBeNull();
    expect(res.byArm.tp10sl4.outcome).toBe('tp');
    expect(res.byArm.tp10sl4.grossR).toBeCloseTo(2.5, 6);
    expect(res.byArm.tp10sl4.netRMaker).toBeGreaterThan(0);
    expect(res.byArm.tp10sl4.netRMaker).toBeGreaterThan(res.byArm.tp10sl4.netRTaker);
    expect(res.byArm.tp15sl5.outcome).toBe('timeout');
  });

  it('resolves a clean stop as −1R gross with both fee arms negative', () => {
    const bars = [
      bar(0, 100, 100, 100, 100, 1),
      bar(1, 100, 100, 100, 100, 1),
      bar(2, 100, 101, 95, 96, 1), // low 95 ⇒ stop both arms, high 101 < tp
      bar(3, 96, 97, 95, 96, 1),
      bar(4, 96, 97, 95, 96, 1),
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res.byArm.tp10sl4.outcome).toBe('stop');
    expect(res.byArm.tp10sl4.grossR).toBeCloseTo(-1, 6);
    expect(res.byArm.tp10sl4.netRMaker).toBeLessThan(0);
    expect(res.byArm.tp10sl4.netRTaker).toBeLessThan(res.byArm.tp10sl4.netRMaker);
  });

  it('counts a single bar spanning BOTH TP and stop as a STOP (pessimistic)', () => {
    const bars = [
      bar(0, 100, 100, 100, 100, 1),
      bar(1, 100, 100, 100, 100, 1),
      bar(2, 100, 111, 95, 105, 1), // high 111 ≥ tp AND low 95 ≤ stop ⇒ pessimistic stop
      bar(3, 100, 101, 99, 100, 1),
      bar(4, 100, 101, 99, 100, 1),
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res.byArm.tp10sl4.outcome).toBe('stop');
  });

  it('resolves a max-hold timeout at the horizon bar close', () => {
    const bars = [
      bar(0, 100, 100, 100, 100, 1),
      bar(1, 100, 101, 100, 100, 1),
      bar(2, 100, 102, 99, 101, 1),
      bar(3, 100, 102, 99, 101, 1),
      bar(4, 100, 102, 100, 102, 1), // maxHoldIdx = 1 + 3 = 4 ⇒ timeout here
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res.byArm.tp10sl4.outcome).toBe('timeout');
    expect(res.byArm.tp15sl5.outcome).toBe('timeout');
  });

  it('returns null while the entry bar or the slower arm is not yet resolvable', () => {
    // No entry bar available.
    expect(resolveIgnition([bar(0, 100, 100, 100, 100, 1)], 0, CFG)).toBeNull();
    // Entry present but no forward bars to reach maxHold ⇒ unresolved.
    const bars = [bar(0, 100, 100, 100, 100, 1), bar(1, 100, 101, 100, 100, 1)];
    expect(resolveIgnition(bars, 0, CFG)).toBeNull();
  });
});

describe('would-a-limit-fill instrument (★)', () => {
  const CFG: IgnitionConfig = { ...IGNITION_DEFAULTS, maxHoldBars: 3 };

  it('logs a FILL when a later bar trades down through the maker limit', () => {
    const bars = [
      bar(0, 100, 100, 100, 100, 1), // maker limit = 100
      bar(1, 100, 101, 100, 100, 1), // low 100 ≤ 100 ⇒ a resting limit buy fills
      bar(2, 100, 102, 99, 101, 1),
      bar(3, 100, 102, 99, 101, 1),
      bar(4, 100, 102, 100, 102, 1),
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res.byArm.tp10sl4.makerFilled).toBe(true);
  });

  it('logs NO fill when price gaps away and never revisits the maker limit', () => {
    const bars = [
      bar(0, 99, 99, 99, 99, 1), // maker limit = 99
      bar(1, 100, 101, 100, 100, 1), // low 100 > 99 — never comes back to the limit
      bar(2, 100, 111, 100, 110, 1), // ignites to tp10 without a pullback
      bar(3, 110, 112, 108, 111, 1),
      bar(4, 111, 113, 109, 112, 1),
    ];
    const res = resolveIgnition(bars, 0, CFG)!;
    expect(res.byArm.tp10sl4.outcome).toBe('tp');
    expect(res.byArm.tp10sl4.makerFilled).toBe(false); // the winner would have been missed
  });
});

describe('flag + config (§1)', () => {
  it('is OFF by default and only true for 1/true/yes/on', () => {
    expect(isCryptoIgnitionEnabled({})).toBe(false);
    expect(isCryptoIgnitionEnabled({ ENABLE_CRYPTO_IGNITION_SCANNER: 'true' })).toBe(true);
    expect(isCryptoIgnitionEnabled({ ENABLE_CRYPTO_IGNITION_SCANNER: 'on' })).toBe(true);
    expect(isCryptoIgnitionEnabled({ ENABLE_CRYPTO_IGNITION_SCANNER: '0' })).toBe(false);
  });

  it('defaults to the strict spec params and the TRA-1217 42-name universe', () => {
    expect(resolveIgnitionConfig({})).toEqual(IGNITION_DEFAULTS);
    expect(resolveIgnitionWatchlist({})).toEqual([...CRYPTO_IGNITION_DEFAULT_WATCHLIST]);
    expect(resolveIgnitionWatchlist({})).toHaveLength(42);
  });

  it('NEVER loosens the trigger from a fat-finger env (falls back to strict default)', () => {
    // A looser RVOL / wider squeeze is rejected → strict default.
    expect(resolveIgnitionConfig({ CRYPTO_IGNITION_RVOL_MIN: '1' }).rvolMin).toBe(6.0);
    expect(resolveIgnitionConfig({ CRYPTO_IGNITION_SQUEEZE_PCT: '0.5' }).squeezePct).toBe(0.08);
    // A STRICTER override is honoured.
    expect(resolveIgnitionConfig({ CRYPTO_IGNITION_RVOL_MIN: '8' }).rvolMin).toBe(8);
    expect(resolveIgnitionConfig({ CRYPTO_IGNITION_SQUEEZE_PCT: '0.05' }).squeezePct).toBe(0.05);
  });
});

describe('observe pass — flag-OFF zero-IO + forward capture', () => {
  beforeEach(() => clearIgnitionScans());

  it('flag OFF ⇒ no-op, no fetch, empty store, health enabled:false', async () => {
    const fetch4h = vi.fn();
    const result = await observeIgnition({
      enabled: false,
      watchlist: [SYM],
      regimeCfg: CRYPTO_REGIME_DEFAULTS,
      cfg: IGNITION_DEFAULTS,
      fetch4h,
    });
    expect(fetch4h).not.toHaveBeenCalled();
    expect(result).toEqual({ fetched: 0, scanned: 0, opened: [], resolved: [] });
    const health = summarizeIgnitionScans(BASE, 0);
    expect(health.openRecords).toBe(0);
    expect(health.resolvedRecords).toBe(0);
    expect(health.expR.maker).toBeNull();
    expect(health.firesPerYr).toBeNull();
    expect(health.sufficientSample).toBe(false);
    expect(MIN_RESOLVED_FOR_EXPECTANCY).toBe(20);
  });

  it('opens a fire on pass 1 and resolves it forward on pass 2 (bull regime)', async () => {
    // 260-bar steady uptrend (⇒ classifier trend_up) with a tight 30-bar shelf and
    // a breakout on the last bar. FOUR_H bars, all closed well before `now`.
    const N = 260;
    const build = (extra: Candle[] = []): Candle[] => {
      const out: Candle[] = [];
      for (let i = 0; i < N - 1; i++) {
        const c = 70 + i * 0.12; // rises ~70 → ~101 (uptrend)
        out.push(bar(i, c, c + 0.2, c - 0.2, c, 1));
      }
      out.push(bar(N - 1, 100, 104.2, 101, 104, 6)); // breakout close 104 on 6× vol
      return out.concat(extra);
    };

    const pass1 = build();
    const now1 = BASE + N * FOUR_H;
    const r1 = await observeIgnition({
      enabled: true,
      watchlist: [SYM],
      regimeCfg: CRYPTO_REGIME_DEFAULTS,
      cfg: { ...IGNITION_DEFAULTS, maxHoldBars: 2, bullOnly: false },
      fetch4h: async () => pass1,
      now: now1,
    });
    expect(r1.opened).toHaveLength(1);
    expect(summarizeIgnitionScans(now1, 1).openRecords).toBe(1);

    // Pass 2: entry bar + a bar that runs to the primary TP, then a timeout horizon.
    const entryOpen = 104;
    const extra = [
      bar(N, entryOpen, 120, 103, 118, 1), // entry bar: high 120 ≥ tp10 (114.4)
      bar(N + 1, 118, 119, 116, 117, 1),
      bar(N + 2, 117, 119, 116, 118, 1), // maxHold horizon for the secondary arm
    ];
    const pass2 = build(extra);
    const now2 = BASE + (N + 3) * FOUR_H;
    const r2 = await observeIgnition({
      enabled: true,
      watchlist: [SYM],
      regimeCfg: CRYPTO_REGIME_DEFAULTS,
      cfg: { ...IGNITION_DEFAULTS, maxHoldBars: 2, bullOnly: false },
      fetch4h: async () => pass2,
      now: now2,
    });
    expect(r2.resolved).toHaveLength(1);
    expect(r2.resolved[0].byArm.tp10sl4.outcome).toBe('tp');

    const health = summarizeIgnitionScans(now2, 1);
    expect(health.resolvedRecords).toBe(1);
    expect(health.openRecords).toBe(0);
    expect(health.hitPct).toBe(100);
    expect(health.makerFillRate).not.toBeNull();
    expect(health.firesPerYr).not.toBeNull();
  });
});
