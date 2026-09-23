import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_SYMBOL_LIMIT,
  SCAN_SYMBOL_LIMIT_OPT_OUT,
  TRADIER_SCAN_SYMBOL_LIMIT_ENV,
  boundScanUniverse,
  resolveScanSymbolLimit,
} from './scan-universe-limit.js';
import { DEFAULT_STREAM_SYMBOL_LIMIT } from './tradier-stream-status.js';

describe('TRA-4830 resolveScanSymbolLimit', () => {
  it('unset and blank fail closed to the default cap, with no error', () => {
    expect(resolveScanSymbolLimit({})).toEqual({ limit: DEFAULT_SCAN_SYMBOL_LIMIT, raw: null, error: null });
    expect(resolveScanSymbolLimit({ TRADIER_SCAN_SYMBOL_LIMIT: '  ' }).limit).toBe(DEFAULT_SCAN_SYMBOL_LIMIT);
  });

  it('the documented opt-out is the only path to an uncapped universe', () => {
    for (const optOut of [SCAN_SYMBOL_LIMIT_OPT_OUT, 'NONE', ' none ']) {
      expect(resolveScanSymbolLimit({ TRADIER_SCAN_SYMBOL_LIMIT: optOut }).limit).toBeNull();
    }
  });

  it('garbage fails CLOSED to the default cap and is discriminated from unset by `error`', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '25 symbols']) {
      const r = resolveScanSymbolLimit({ TRADIER_SCAN_SYMBOL_LIMIT: bad });
      expect(r.limit).toBe(DEFAULT_SCAN_SYMBOL_LIMIT);
      expect(r.error).toContain(TRADIER_SCAN_SYMBOL_LIMIT_ENV);
      expect(r.raw).toBe(bad.trim());
    }
  });

  it('an explicit integer is honoured verbatim', () => {
    expect(resolveScanSymbolLimit({ TRADIER_SCAN_SYMBOL_LIMIT: '130' })).toEqual({ limit: 130, raw: '130', error: null });
  });

  it('one sizing decision, not two: the stream cap must fit inside the scan bound', () => {
    // TRA-4656 subscribes the stream out of the fleet union of BOUNDED scan
    // universes, so subscription ⊆ polled universe only holds while this does.
    expect(DEFAULT_STREAM_SYMBOL_LIMIT).toBeLessThanOrEqual(DEFAULT_SCAN_SYMBOL_LIMIT);
  });
});

describe('TRA-4830 boundScanUniverse', () => {
  const tail = (n: number): string[] => Array.from({ length: n }, (_, i) => `DYN${i}`);
  const noCap = { limit: null, raw: 'none', error: null };
  const cap = (n: number): { limit: number; raw: string; error: null } => ({ limit: n, raw: String(n), error: null });

  it('is the identity (minus dupes) when the universe fits the cap', () => {
    const r = boundScanUniverse({ universe: ['AAPL', 'MSFT', 'AAPL', 'SPY'] }, cap(10));
    expect(r).toEqual({ selected: ['AAPL', 'MSFT', 'SPY'], before: 3, after: 3, forcedBeyondLimit: 0 });
  });

  it('`none` is the identity even over an oversized universe — not even a reorder', () => {
    const universe = [...tail(300), 'AAPL'];
    const r = boundScanUniverse({ universe, held: ['AAPL'] }, noCap);
    expect(r.selected).toEqual(universe);
    expect(r.after).toBe(301);
  });

  it('cuts the discovery tail, never held/signalled/base, and reports honest counts', () => {
    // Universe in "historical" order: discovery tail first so the test fails if
    // the bound ever truncates by array position instead of by priority tier.
    const universe = [...tail(200), 'HELD1', 'SIG1', 'BASE1', 'BASE2'];
    const r = boundScanUniverse(
      { universe, held: ['HELD1'], signalled: ['SIG1'], base: ['BASE1', 'BASE2'] },
      cap(50),
    );
    expect(r.before).toBe(204);
    expect(r.after).toBe(50);
    expect(r.forcedBeyondLimit).toBe(0);
    for (const kept of ['HELD1', 'SIG1', 'BASE1', 'BASE2']) expect(r.selected).toContain(kept);
    // Order is the INPUT's order (the dashboard render order, TRA-2643), not
    // the priority permutation: the surviving tail rows still precede HELD1.
    expect(r.selected.slice(-4)).toEqual(['HELD1', 'SIG1', 'BASE1', 'BASE2']);
    expect(r.selected).toEqual(universe.filter((s) => r.selected.includes(s)));
  });

  it('NEVER cuts held/signalled — the bound widens past the cap instead (TRA-931)', () => {
    const held = ['H1', 'H2', 'H3'];
    const signalled = ['S1', 'S2'];
    const r = boundScanUniverse(
      { universe: [...tail(20), ...held, ...signalled], held, signalled },
      cap(3),
    );
    expect(r.after).toBe(5);
    expect(r.forcedBeyondLimit).toBe(2);
    for (const kept of [...held, ...signalled]) expect(r.selected).toContain(kept);
  });

  it('held symbols absent from the universe are ignored — a bound reorders membership, it never widens the tape', () => {
    const r = boundScanUniverse({ universe: tail(5), held: ['NOT_TRACKED'] }, cap(3));
    expect(r.selected).toEqual(['DYN0', 'DYN1', 'DYN2']);
    expect(r.selected).not.toContain('NOT_TRACKED');
  });
});
