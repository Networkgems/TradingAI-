import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  recordUnservableAttempt,
  recordServableSymbol,
  shouldSkipUnservable,
  unservableSymbols,
  getUnservableSymbolState,
  __resetUnservableSymbolsForTests,
  UNSERVABLE_TTL_MS,
  UNSERVABLE_STRIKES,
  UNSERVABLE_STRIKE_WINDOW_MS,
} from './unservable-symbols.js';

// TRA-3804 (measure 1 of TRA-3800). The registry behind the equity skip list.
// Every function takes an explicit `now`, so the TTL and the strike window are
// exercised at their boundaries with no clock manipulation and no sleeping.
describe('unservable-symbols registry (TRA-3804)', () => {
  const T0 = 1_700_000_000_000;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetUnservableSymbolsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  /** Drive a symbol onto the skip list with the minimum number of strikes.
   *  Returns the instant the mark was stamped — the LAST strike, not the first,
   *  which is what the TTL runs from. */
  const mark = (symbol: string, at = T0): number => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) recordUnservableAttempt(symbol, at + i);
    return at + UNSERVABLE_STRIKES - 1;
  };

  it('does not skip a symbol on its FIRST definitive failure', () => {
    // The whole point of the strike counter: one unlucky tick, where every
    // provider happens to time out at once, must not un-price a live symbol for
    // a whole TTL.
    const r = recordUnservableAttempt('SBLX', T0);
    expect(r.marked).toBe(false);
    expect(r.strikes).toBe(1);
    expect(shouldSkipUnservable('SBLX', false, T0)).toBe(false);
    expect(unservableSymbols(T0)).toEqual([]);
  });

  it('skips once the strike threshold is reached, and says so exactly once', () => {
    mark('SBLX');
    expect(shouldSkipUnservable('SBLX', false, T0)).toBe(true);
    expect(unservableSymbols(T0)).toEqual(['SBLX']);
    // The transition is logged once, not once per tick.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('SBLX');
    shouldSkipUnservable('SBLX', false, T0 + 1);
    shouldSkipUnservable('SBLX', false, T0 + 2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a serving quote clears strikes BEFORE the threshold (strikes are consecutive)', () => {
    recordUnservableAttempt('AZN.L', T0);
    recordServableSymbol('AZN.L');
    recordUnservableAttempt('AZN.L', T0 + 1);
    // Second failure is strike 1 again, not strike 2 — so no mark.
    expect(shouldSkipUnservable('AZN.L', false, T0 + 2)).toBe(false);
  });

  it('a serving quote retires an EXISTING mark immediately (the recovery path)', () => {
    mark('SELX');
    expect(shouldSkipUnservable('SELX', false, T0)).toBe(true);
    recordServableSymbol('SELX');
    expect(shouldSkipUnservable('SELX', false, T0)).toBe(false);
    expect(getUnservableSymbolState(T0).recoveries).toBe(1);
  });

  it('stale strikes decay, so two failures months apart never compound into a mark', () => {
    recordUnservableAttempt('WGRX', T0);
    // One tick past the strike window — the first strike is no longer evidence.
    const r = recordUnservableAttempt('WGRX', T0 + UNSERVABLE_STRIKE_WINDOW_MS + 1);
    expect(r.strikes).toBe(1);
    expect(r.marked).toBe(false);
    expect(shouldSkipUnservable('WGRX', false, T0 + UNSERVABLE_STRIKE_WINDOW_MS + 2)).toBe(false);
  });

  it('the mark is re-checkable, not permanent: it lapses at the TTL', () => {
    const markedAt = mark('SBLX');
    // Still skipped one millisecond before expiry…
    expect(shouldSkipUnservable('SBLX', false, markedAt + UNSERVABLE_TTL_MS - 1)).toBe(true);
    // …and fetched again the instant it lapses.
    expect(shouldSkipUnservable('SBLX', false, markedAt + UNSERVABLE_TTL_MS)).toBe(false);
    expect(getUnservableSymbolState(markedAt + UNSERVABLE_TTL_MS).expiries).toBe(1);
  });

  it('a lapsed symbol must re-earn the FULL strike count — it is forgotten, not un-marked', () => {
    const lapsed = mark('SBLX') + UNSERVABLE_TTL_MS;
    expect(shouldSkipUnservable('SBLX', false, lapsed)).toBe(false);
    // A single failure on the re-probe is not enough to re-skip it. A
    // half-remembered entry would re-mark on the first blip after recovery,
    // which is the failure mode that keeps a recovered symbol unpriced.
    expect(recordUnservableAttempt('SBLX', lapsed).marked).toBe(false);
    expect(shouldSkipUnservable('SBLX', false, lapsed + 1)).toBe(false);
    expect(recordUnservableAttempt('SBLX', lapsed + 2).marked).toBe(true);
  });

  it('a still-dead symbol re-confirmed on its re-probe gets a FULL fresh TTL', () => {
    const lapsed = mark('SBLX') + UNSERVABLE_TTL_MS;
    shouldSkipUnservable('SBLX', false, lapsed);           // expires the entry
    recordUnservableAttempt('SBLX', lapsed);               // strike 1 of the re-probe
    recordUnservableAttempt('SBLX', lapsed + 1);           // strike 2 → re-marked
    expect(shouldSkipUnservable('SBLX', false, lapsed + UNSERVABLE_TTL_MS - 10)).toBe(true);
    // …and a further failure while marked refreshes the clock rather than
    // stacking strikes.
    const again = recordUnservableAttempt('SBLX', lapsed + 100);
    expect(again.alreadyMarked).toBe(true);
    expect(again.marked).toBe(false);
  });

  it('NEVER skips a protected (active-interest) symbol, and counts the override', () => {
    // This is the structural form of "no open position references a skipped
    // symbol": the veto is re-evaluated on every single call, not audited once.
    mark('SBLX');
    expect(shouldSkipUnservable('SBLX', /*isProtected*/ true, T0)).toBe(false);
    const s = getUnservableSymbolState(T0);
    expect(s.protectedDeclines).toBe(1);
    expect(s.skips).toBe(0);
    // It stays visible on the census, so the operator can see a mark is being
    // deliberately overridden rather than silently absent.
    expect(s.skippedSymbols).toEqual(['SBLX']);
  });

  it('an unknown symbol is never skipped and costs one evaluation', () => {
    expect(shouldSkipUnservable('AAPL', false, T0)).toBe(false);
    expect(getUnservableSymbolState(T0).evaluations).toBe(1);
  });

  it('recordServableSymbol on an untracked symbol is a no-op (no phantom recovery)', () => {
    recordServableSymbol('AAPL');
    expect(getUnservableSymbolState(T0).recoveries).toBe(0);
  });
});

// The standing rule from TRA-3800: a suppression must ship a counter, and the
// counter must have a failing state. "Skipped 26" and "the skip path is dead"
// must not read the same.
describe('getUnservableSymbolState — the discriminator (TRA-3804)', () => {
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    __resetUnservableSymbolsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('every field is PRESENT on a virgin registry — never undefined, never absent', () => {
    const s = getUnservableSymbolState(T0);
    for (const key of [
      'skippedCount', 'skippedSymbols', 'trackedCount', 'ttlMs', 'strikesToMark',
      'evaluations', 'skips', 'marks', 'recoveries', 'expiries', 'protectedDeclines',
      'oldestMarkAgeMs',
    ]) {
      expect(s, `missing field ${key}`).toHaveProperty(key);
      expect((s as Record<string, unknown>)[key], `field ${key} is undefined`).not.toBeUndefined();
    }
  });

  it('separates "nothing is dead" from "the gate never ran" — the whole point', () => {
    // Gate never consulted: both counts zero.
    expect(getUnservableSymbolState(T0)).toMatchObject({ skippedCount: 0, evaluations: 0 });
    // Gate consulted, nothing dead: skippedCount still 0, evaluations is NOT.
    shouldSkipUnservable('AAPL', false, T0);
    shouldSkipUnservable('MSFT', false, T0);
    expect(getUnservableSymbolState(T0)).toMatchObject({ skippedCount: 0, evaluations: 2, skips: 0 });
  });

  it('counts symbols mid-accrual, so the detector is visible before any mark exists', () => {
    recordUnservableAttempt('SBLX', T0);
    const s = getUnservableSymbolState(T0);
    expect(s.skippedCount).toBe(0);
    expect(s.trackedCount).toBe(1); // ← the discriminator for "detecting, not yet suppressing"
  });

  it('reports the full skipped membership and the age of the oldest mark', () => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) recordUnservableAttempt('SELX', T0 + i);
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) recordUnservableAttempt('SBLX', T0 + 1000 + i);
    const s = getUnservableSymbolState(T0 + 5000);
    expect(s.skippedCount).toBe(2);
    expect(s.skippedSymbols).toEqual(['SBLX', 'SELX']); // sorted, full membership
    // Oldest mark is SELX's, stamped at its threshold-crossing strike.
    expect(s.oldestMarkAgeMs).toBe(5000 - (UNSERVABLE_STRIKES - 1));
    expect(s.marks).toBe(2);
  });

  it('drops a lapsed mark from the count even before the gate prunes it', () => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) recordUnservableAttempt('SBLX', T0 + i);
    const lapsed = T0 + UNSERVABLE_STRIKES - 1 + UNSERVABLE_TTL_MS;
    expect(getUnservableSymbolState(lapsed).skippedCount).toBe(0);
    expect(getUnservableSymbolState(lapsed).oldestMarkAgeMs).toBeNull();
  });
});
