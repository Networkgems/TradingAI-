// TRA-3688 — S-1 env resolution guard + S-3 void verdicts.
import { describe, it, expect } from 'vitest';
import {
  resolveSma200PullbackMaxDistAtr,
  sma200VoidVerdict,
  SMA200_DRIFT_VOID_ATR,
} from './sma200-validity.js';

describe('resolveSma200PullbackMaxDistAtr (TRA-3440-guarded parse)', () => {
  it('absent / blank / whitespace mean the DARK default (Infinity)', () => {
    expect(resolveSma200PullbackMaxDistAtr({})).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '   ' })).toBe(Infinity);
  });

  it('garbage means the default, never 0 — Number("") is 0 and a 0 gate rejects every signal silently', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: 'abc' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: 'NaN' })).toBe(Infinity);
  });

  it('non-positive values are refused as a config, not honored as a reject-all', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '0' })).toBe(Infinity);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '-2' })).toBe(Infinity);
  });

  it('a real threshold parses', () => {
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '2.0' })).toBe(2.0);
    expect(resolveSma200PullbackMaxDistAtr({ SMA200_PULLBACK_MAX_DIST_ATR: '2.5' })).toBe(2.5);
  });
});

describe('sma200VoidVerdict (S-3)', () => {
  const sig = { entryPrice: 100, atr14: 4, barTimestamp: 1_000 };

  it('S-3a — void on bar rollover: a newer daily bar exists for the symbol', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 2_000 })).toBe('bar_rollover');
  });

  it('S-3a — the signal\'s own bar is NOT a rollover (same-day scan must not void it)', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 1_000 })).toBeNull();
  });

  it('S-3b — void on drift beyond 0.5 × ATR14 from the recorded entry, either direction', () => {
    const bound = SMA200_DRIFT_VOID_ATR * sig.atr14; // 2.0
    expect(sma200VoidVerdict(sig, { lastPrice: 100 + bound + 0.01 })).toBe('price_drift');
    expect(sma200VoidVerdict(sig, { lastPrice: 100 - bound - 0.01 })).toBe('price_drift');
    // AT the bound is not beyond it.
    expect(sma200VoidVerdict(sig, { lastPrice: 100 + bound })).toBeNull();
  });

  it('S-3a outranks S-3b when both would void (rollover carries the weight)', () => {
    expect(sma200VoidVerdict(sig, { latestBarTs: 2_000, lastPrice: 200 })).toBe('bar_rollover');
  });

  it('degrades safely on legacy rows: no atr14 ⇒ no drift verdict, no barTimestamp ⇒ no rollover verdict', () => {
    expect(sma200VoidVerdict({ entryPrice: 100, atr14: NaN as number, barTimestamp: undefined }, {
      latestBarTs: 2_000, lastPrice: 200,
    })).toBeNull();
  });

  it('a dark / broken quote (non-finite, 0) never voids — TRA-3440: a dark feed is not a low reading', () => {
    expect(sma200VoidVerdict(sig, { lastPrice: NaN })).toBeNull();
    expect(sma200VoidVerdict(sig, { lastPrice: 0 })).toBeNull();
  });
});
