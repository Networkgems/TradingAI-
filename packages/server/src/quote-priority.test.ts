import { describe, it, expect } from 'vitest';

import { prioritizeQuoteUniverse, RISK_INPUT_SYMBOLS } from './quote-priority.js';

// TRA-2643 — the fan-out truncates by ARRAY POSITION at ~200 of 614 symbols, so
// the order of the universe decides which two thirds of the tape go unpriced on
// a degraded tick. These tests grade the ordering AND — more importantly — the
// invariant that it is a permutation, because a filter here would silently stop
// quoting symbols with no log line at all (the failure mode TRA-2627 spent an
// incident diagnosing).
describe('prioritizeQuoteUniverse (TRA-2643 fan-out importance order)', () => {
  it('is a PERMUTATION — nothing is dropped, only reordered', () => {
    const universe = ['AAPL', 'MSFT', 'ZZZ', '^VIX', 'SPCX', 'NVDA', 'OXY'];
    const out = prioritizeQuoteUniverse({
      universe,
      held: ['SPCX'],
      signalled: ['NVDA'],
      base: ['AAPL', 'MSFT'],
    });
    expect(out.length).toBe(universe.length);
    expect([...out].sort()).toEqual([...universe].sort());
  });

  it('ranks held > signalled > risk inputs > base watchlist > discovery tail', () => {
    const out = prioritizeQuoteUniverse({
      // Deliberately worst-case: the important names are all at the BACK, which
      // is the shape measured on bqb1 (^VIX at index 510 of 614).
      universe: ['TAIL1', 'TAIL2', 'AAPL', 'MSFT', '^VIX', 'NVDA', 'SPCX'],
      held: ['SPCX'],
      signalled: ['NVDA'],
      base: ['AAPL', 'MSFT'],
    });
    expect(out).toEqual(['SPCX', 'NVDA', '^VIX', 'AAPL', 'MSFT', 'TAIL1', 'TAIL2']);
  });

  it('rescues the exact 07-29 loss: ^VIX and the energy complex clear a 200-symbol ceiling', () => {
    // Reconstruct the measured shape — 614 symbols with ^VIX at 510, USO at
    // 488, OXY at 486, XLE at 489 (read off bqb1 `GET /api/state`, 2026-07-30).
    const universe = Array.from({ length: 614 }, (_, i) => `T${i}`);
    universe[486] = 'OXY';
    universe[488] = 'USO';
    universe[489] = 'XLE';
    universe[510] = '^VIX';
    universe[105] = 'XOM';
    universe[108] = 'CVX';

    const CEILING = 200;
    const before = universe.slice(0, CEILING);
    expect(before).not.toContain('^VIX');   // the incident, restated as a test
    expect(before).not.toContain('USO');

    const after = prioritizeQuoteUniverse({ universe, base: ['XOM', 'CVX'] }).slice(0, CEILING);
    expect(after).toContain('^VIX');
    // XOM/CVX were already inside the ceiling by luck; the base tier keeps them
    // there by construction rather than by luck.
    expect(after).toContain('XOM');
    expect(after).toContain('CVX');
    // Honest bound: ordering does NOT rescue the whole energy complex. USO/OXY/
    // XLE are discovery-tail names with no held position and no live signal, so
    // they stay outside the ceiling. Ordering buys back the rows we can NAME as
    // important; it is not a coverage fix, and this assertion exists so nobody
    // reads it as one.
    expect(after).not.toContain('USO');
  });

  it('keeps a held OFF-WATCHLIST underlying inside the ceiling (the TRA-931 regression)', () => {
    // getActiveSymbols() appended open-option underlyings LAST, after the whole
    // discovery tail. TRA-931 forced them in precisely so an off-watchlist
    // position still had a live spot for the Greeks gate and the stale-mark exit
    // backstop — and an off-watchlist underlying is by construction at the very
    // end, i.e. beyond the ceiling on every degraded tick.
    const universe = [...Array.from({ length: 614 }, (_, i) => `T${i}`), 'SPCX'];
    expect(universe.slice(0, 200)).not.toContain('SPCX');
    const out = prioritizeQuoteUniverse({ universe, held: ['SPCX'] });
    expect(out[0]).toBe('SPCX');
  });

  it('preserves the caller order WITHIN each tier (stable, tail untouched)', () => {
    const out = prioritizeQuoteUniverse({
      universe: ['D1', 'D2', 'D3', 'D4'],
      held: ['D4', 'D2'],   // held order must NOT leak into the result
    });
    // D2 before D4 because that is the universe's order, not `held`'s.
    expect(out).toEqual(['D2', 'D4', 'D1', 'D3']);
  });

  it('dedupes, first-seen wins', () => {
    const out = prioritizeQuoteUniverse({ universe: ['A', 'B', 'A', 'C', 'B'] });
    expect(out).toEqual(['A', 'B', 'C']);
  });

  it('never WIDENS the fan-out — a priority symbol absent from the universe stays absent', () => {
    // The whole point is that this costs zero extra requests. If a held symbol
    // that is not in the universe got injected here, an ordering change would
    // quietly become a coverage change and re-open the Yahoo 429 risk.
    const out = prioritizeQuoteUniverse({
      universe: ['A', 'B'],
      held: ['NOT_IN_UNIVERSE'],
      signalled: ['ALSO_NOT_HERE'],
    });
    expect(out).toEqual(['A', 'B']);
  });

  it('prioritises ^VIX by default — the risk tier needs no caller wiring', () => {
    const out = prioritizeQuoteUniverse({ universe: ['ZZZ', '^VIX', 'AAA'] });
    expect(out[0]).toBe('^VIX');
    expect(RISK_INPUT_SYMBOLS).toContain('^VIX');
    // Tradier's un-prefixed spelling (TRA-586) and the documented ETF proxies
    // (TRA-469 / TRA-2197) are the fallbacks a dark index leg falls to, which is
    // exactly a degraded tick — so they ride in the same tier.
    expect(RISK_INPUT_SYMBOLS).toContain('VIX');
    expect(RISK_INPUT_SYMBOLS).toContain('SPY');
    expect(RISK_INPUT_SYMBOLS).toContain('QQQ');
  });

  it('degenerate inputs: empty universe, empty tiers, falsy symbols', () => {
    expect(prioritizeQuoteUniverse({ universe: [] })).toEqual([]);
    expect(prioritizeQuoteUniverse({ universe: ['A'], held: [], signalled: [], base: [] })).toEqual(['A']);
    expect(prioritizeQuoteUniverse({ universe: ['A', '', 'B'] })).toEqual(['A', 'B']);
    // An explicitly empty riskInputs override must DISABLE the default tier, not
    // silently fall back to it — otherwise the override is not a control.
    expect(prioritizeQuoteUniverse({ universe: ['ZZZ', '^VIX'], riskInputs: [] })).toEqual(['ZZZ', '^VIX']);
  });

  it('NEGATIVE CONTROL: with no tiers asserted the order is unchanged', () => {
    // If this ever fails, the function has grown an opinion of its own and the
    // tier assertions above stop being evidence of what the CALLER asked for.
    const universe = ['M', 'A', 'Z', 'B'];
    expect(prioritizeQuoteUniverse({ universe, riskInputs: [] })).toEqual(universe);
  });
});
