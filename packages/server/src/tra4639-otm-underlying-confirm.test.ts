import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import {
  OTM_UNDERLYING_CONFIRM_SHADOW_FLAG,
  OTM_EMA_PULLBACK_CODES,
  OTM_VOLUME_BREAKOUT_CODES,
  isOtmUnderlyingConfirmShadowEnabled,
  evaluateOtmUnderlyingConfirm,
  recordOtmUnderlyingConfirm,
  resetOtmUnderlyingConfirmCountersForTest,
  otmUnderlyingConfirmHealth,
} from './otm-underlying-confirm.js';

/**
 * TRA-4639 (parent TRA-4413 item A) — the underlying-confirmation SHADOW.
 *
 * What these lock down, in order of how much it would hurt to lose:
 *   1. the flag is STANDALONE — arming the observer must not require (or be
 *      confused with) `ENABLE_OPTION_EXEC_SELECTOR`, the AND-trap the issue
 *      warns about on the TRA-1028 flags themselves;
 *   2. every refusal code discriminates a distinct leg (a histogram whose
 *      buckets pool is not a histogram);
 *   3. an unreadable daily cache is `*_series_unreadable`, never a verdict
 *      about the symbol (the TRA-4424 cold-cache laundering trap);
 *   4. the counter read is DENSE over the vocabulary (absent is not zero) and
 *      carries the `evaluated` denominator beside every numerator;
 *   5. the seam census: exactly one call site, inside `otmSetupTaxonomyDecision`,
 *      so the denominator is the `setup_confirmation` population by construction.
 */

function candle(partial: Partial<Candle> & { close: number }): Candle {
  const c = partial.close;
  return {
    symbol: partial.symbol ?? 'TEST',
    timestamp: partial.timestamp ?? 0,
    open: partial.open ?? c,
    high: partial.high ?? Math.max(partial.open ?? c, c),
    low: partial.low ?? Math.min(partial.open ?? c, c),
    close: c,
    volume: partial.volume ?? 1000,
  };
}

function uptrend(n: number, start = 100, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push(candle({ close: c, open: c - step * 0.5, high: c + step * 0.2, low: c - step * 0.6, timestamp: i }));
  }
  return out;
}

function flat(n: number, level = 100, vol = 1000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push(candle({ close: level, open: level, high: level + 0.5, low: level - 0.5, volume: vol, timestamp: i }));
  }
  return out;
}

/** Uptrend + pullback to the 9 EMA + bullish engulfing — the confirming shape. */
function confirmingCallSeries(): Candle[] {
  const bars = uptrend(30, 100, 1);
  const fastArea = bars[bars.length - 1]!.close;
  bars.push(candle({ close: fastArea - 2, open: fastArea, high: fastArea, low: fastArea - 4, timestamp: 30 }));
  const prev = bars[bars.length - 1]!;
  bars.push(candle({ open: prev.close - 0.5, close: prev.open + 1, high: prev.open + 1.5, low: prev.close - 1, timestamp: 31 }));
  return bars;
}

describe('flag resolution (TRA-4639)', () => {
  it('defaults OFF with no env at all', () => {
    expect(isOtmUnderlyingConfirmShadowEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is STANDALONE: arms WITHOUT ENABLE_OPTION_EXEC_SELECTOR', () => {
    // ⛔ The TRA-1028 flags are AND-ed with the exec flag; this one must not
    // be, or arming the observer would also be an exec-path act.
    const env = { [OTM_UNDERLYING_CONFIRM_SHADOW_FLAG]: '1' } as NodeJS.ProcessEnv;
    expect(isOtmUnderlyingConfirmShadowEnabled(env)).toBe(true);
  });

  it('rejects garbage values (UNKNOWN IS NOT ON)', () => {
    const env = { [OTM_UNDERLYING_CONFIRM_SHADOW_FLAG]: 'enable' } as NodeJS.ProcessEnv;
    expect(isOtmUnderlyingConfirmShadowEnabled(env)).toBe(false);
  });
});

describe('evaluateOtmUnderlyingConfirm — reason codes discriminate', () => {
  it('unreadable series stamps *_series_unreadable on BOTH archetypes, triggers never run', () => {
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', [], false);
    expect(v.ema.code).toBe('ema_series_unreadable');
    expect(v.volume.code).toBe('vb_series_unreadable');
    expect(v.ema.confirmed).toBe(false);
    expect(v.volume.confirmed).toBe(false);
  });

  it('an empty-but-"readable" series still refuses as unreadable, never as a symbol property', () => {
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', [], true);
    expect(v.ema.code).toBe('ema_series_unreadable');
    expect(v.volume.code).toBe('vb_series_unreadable');
  });

  it('a short readable series is *_insufficient_series — distinct from unreadable', () => {
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', uptrend(5), true);
    expect(v.ema.code).toBe('ema_insufficient_series');
    expect(v.volume.code).toBe('vb_insufficient_series');
  });

  it('confirms the EMA pullback on the canonical call shape', () => {
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', confirmingCallSeries(), true);
    expect(v.ema.confirmed).toBe(true);
    expect(v.ema.code).toBe('ema_confirmed');
  });

  it('a put nominee against an uptrend is ema_trend_misaligned', () => {
    const v = evaluateOtmUnderlyingConfirm('SPY', 'put', confirmingCallSeries(), true);
    expect(v.ema.confirmed).toBe(false);
    expect(v.ema.code).toBe('ema_trend_misaligned');
  });

  it('an extended uptrend with no pullback is ema_no_pullback', () => {
    // Steep rise: lows never come back to the 9 EMA band.
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', uptrend(30, 100, 3), true);
    expect(v.ema.code).toBe('ema_no_pullback');
  });

  it('pullback without a confirming candle is ema_no_reversal', () => {
    const bars = uptrend(30, 100, 1);
    const fastArea = bars[bars.length - 1]!.close;
    bars.push(candle({ close: fastArea - 2, open: fastArea, high: fastArea, low: fastArea - 4, timestamp: 30 }));
    const prev = bars[bars.length - 1]!;
    // Bearish continuation bar — no reversal print.
    bars.push(candle({ open: prev.close, close: prev.close - 2, high: prev.close + 0.2, low: prev.close - 2.5, timestamp: 31 }));
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', bars, true);
    expect(v.ema.code).toBe('ema_no_reversal');
  });

  it('confirms the volume breakout on a high-volume channel break', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 105, open: 100.5, high: 105.2, low: 100, volume: 3000, timestamp: 25 }));
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', bars, true);
    expect(v.volume.confirmed).toBe(true);
    expect(v.volume.code).toBe('vb_confirmed');
  });

  it('a close inside the channel is vb_no_channel_break', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 100.2, open: 100, high: 100.4, low: 99.8, volume: 5000, timestamp: 25 }));
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', bars, true);
    expect(v.volume.code).toBe('vb_no_channel_break');
  });

  it('a channel break on quiet volume is vb_volume_unconfirmed — the leg TRA-1028 exists to add', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 105, open: 100.5, high: 105.2, low: 100, volume: 1000, timestamp: 25 }));
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', bars, true);
    expect(v.volume.code).toBe('vb_volume_unconfirmed');
  });
});

describe('counters and the health read', () => {
  beforeEach(() => resetOtmUnderlyingConfirmCountersForTest());

  it('folds verdicts per book with the evaluated denominator beside every numerator', () => {
    recordOtmUnderlyingConfirm('live', evaluateOtmUnderlyingConfirm('SPY', 'call', confirmingCallSeries(), true));
    recordOtmUnderlyingConfirm('live', evaluateOtmUnderlyingConfirm('QQQ', 'put', confirmingCallSeries(), true));
    recordOtmUnderlyingConfirm('demo', evaluateOtmUnderlyingConfirm('TSLA', 'call', [], false));
    const h = otmUnderlyingConfirmHealth({} as NodeJS.ProcessEnv);
    expect(h.books.live.evaluated).toBe(2);
    expect(h.books.demo.evaluated).toBe(1);
    const emaConfirmed = h.books.live.emaPullback.find((r) => r.code === 'ema_confirmed');
    expect(emaConfirmed?.count).toBe(1);
    expect(emaConfirmed?.share).toBe(0.5);
    const misaligned = h.books.live.emaPullback.find((r) => r.code === 'ema_trend_misaligned');
    expect(misaligned?.count).toBe(1);
    // The demo unreadable row landed in the unreadable bucket, not a verdict one.
    expect(h.books.demo.emaPullback.find((r) => r.code === 'ema_series_unreadable')?.count).toBe(1);
  });

  it('the read is DENSE over both vocabularies — absent is not zero (TRA-4154)', () => {
    const h = otmUnderlyingConfirmHealth({} as NodeJS.ProcessEnv);
    expect(h.books.live.emaPullback.map((r) => r.code)).toEqual([...OTM_EMA_PULLBACK_CODES]);
    expect(h.books.live.volumeBreakout.map((r) => r.code)).toEqual([...OTM_VOLUME_BREAKOUT_CODES]);
    for (const row of [...h.books.live.emaPullback, ...h.books.live.volumeBreakout]) {
      expect(row.count).toBe(0);
      expect(row.share).toBeNull(); // 0/0 is null, never a forged 0%.
    }
  });

  it('bothConfirmed / eitherConfirmed track the AND and OR folds', () => {
    // The canonical pullback shape: EMA confirms; the reversal bar is INSIDE
    // the Donchian channel on flat volume, so the volume breakout refuses.
    const v = evaluateOtmUnderlyingConfirm('SPY', 'call', confirmingCallSeries(), true);
    expect(v.ema.confirmed).toBe(true);
    expect(v.volume.confirmed).toBe(false);
    recordOtmUnderlyingConfirm('live', v);
    const h = otmUnderlyingConfirmHealth({} as NodeJS.ProcessEnv);
    expect(h.books.live.eitherConfirmed).toBe(1);
    expect(h.books.live.bothConfirmed).toBe(0);
  });

  it('dark flag publishes a DARK note, never a clean bill', () => {
    const h = otmUnderlyingConfirmHealth({} as NodeJS.ProcessEnv);
    expect(h.enabled).toBe(false);
    expect(h.note).toMatch(/DARK/);
    expect(h.note).toMatch(/not a clean bill/);
  });
});

describe('seam census — the denominator is setup_confirmation by construction', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ENGINE_SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('signal-engine calls evaluateOtmUnderlyingConfirm exactly once, inside otmSetupTaxonomyDecision', () => {
    // The import line has no paren, so this pattern counts CALL SITES only.
    const calls = ENGINE_SRC.match(/evaluateOtmUnderlyingConfirm\(/g) ?? [];
    expect(calls.length).toBe(1);
    const methodStart = ENGINE_SRC.indexOf('private otmSetupTaxonomyDecision(');
    expect(methodStart).toBeGreaterThan(-1);
    // The next private member after the method bounds it from below.
    const methodEnd = ENGINE_SRC.indexOf('private otmContractFloor()', methodStart);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const callAt = ENGINE_SRC.indexOf('evaluateOtmUnderlyingConfirm(');
    expect(callAt).toBeGreaterThan(methodStart);
    expect(callAt).toBeLessThan(methodEnd);
  });

  it('the seam records BEFORE the mode gate, so demo wiring is checkable', () => {
    const seam = ENGINE_SRC.slice(
      ENGINE_SRC.indexOf('private otmSetupTaxonomyDecision('),
      ENGINE_SRC.indexOf('private otmContractFloor()'),
    );
    expect(seam).toContain("const confirmBook = this.mode === 'live' ? 'live' : 'demo';");
    expect(seam).toContain('recordOtmUnderlyingConfirm(confirmBook, confirm);');
  });
});
