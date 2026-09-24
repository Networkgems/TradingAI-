import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  evaluateSetupTaxonomy,
  SETUP_TAXONOMY_REGISTRY,
  SETUP_TAXONOMY_REASON_CODES,
  SETUP_TAXONOMY_MIN_BARS,
  type SetupTaxonomyDefinition,
} from './setup-taxonomy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function series(n: number, stepMs = DAY_MS, symbol = 'AAPL'): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    timestamp: 1_700_000_000_000 + i * stepMs,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1_000,
  }));
}

/** A setup that always confirms on the side it was constructed with. */
function alwaysSetup(setupId: string, side: 'call' | 'put', minBars = 10): SetupTaxonomyDefinition {
  return { setupId, label: setupId, minBars, evaluate: () => ({ setupId, side }) };
}

/** A setup that never confirms. */
function neverSetup(setupId: string, minBars = 10): SetupTaxonomyDefinition {
  return { setupId, label: setupId, minBars, evaluate: () => null };
}

describe('setup taxonomy — the shipped state (TRA-4422)', () => {
  it('ships ZERO setups, so nothing can confirm and the gate above it admits everything', () => {
    expect(SETUP_TAXONOMY_REGISTRY).toHaveLength(0);
    const v = evaluateSetupTaxonomy({
      symbol: 'AAPL', series: series(120), nomineeSide: 'call',
    });
    expect(v.confirmed).toBe(false);
    expect(v.setupsScored).toBe(0);
  });

  it('publishes setupsScored so an empty registry reads UNMEASURED, not "found nothing"', () => {
    // The whole point of the instrument: `no_setup_matched` at `setupsScored: 0`
    // must be distinguishable from `no_setup_matched` after scoring real setups.
    const empty = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' }, [],
    );
    const scored = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' }, [neverSetup('E')],
    );
    expect(empty.reasonCode).toBe('no_setup_matched');
    expect(scored.reasonCode).toBe('no_setup_matched');
    // Same reason code, different denominators. This is the discriminator.
    expect(empty.setupsScored).toBe(0);
    expect(scored.setupsScored).toBe(1);
  });
});

describe('setup taxonomy — series readability is split out from refusal', () => {
  it('an absent series is series_unreadable, never no_setup_matched', () => {
    const v = evaluateSetupTaxonomy({ symbol: 'AAPL', series: [], nomineeSide: 'call' });
    expect(v.reasonCode).toBe('series_unreadable');
    expect(v.bars).toBe(0);
    expect(v.setupsScored).toBe(0);
  });

  it('a series shorter than the deepest enabled setup needs is series_unreadable', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(9), nomineeSide: 'call' },
      [alwaysSetup('E', 'call', 10)],
    );
    expect(v.reasonCode).toBe('series_unreadable');
    // ⛔ It did NOT score the setup — an unreadable input voids the row's grade.
    expect(v.setupsScored).toBe(0);
    expect(v.confirmed).toBe(false);
  });

  it('takes the MAX bar requirement over enabled setups, not the min', () => {
    const shallow = alwaysSetup('E', 'call', 10);
    const deep = alwaysSetup('C', 'call', 100);
    const s = series(50);
    expect(evaluateSetupTaxonomy({ symbol: 'AAPL', series: s, nomineeSide: 'call' }, [shallow]).confirmed).toBe(true);
    expect(evaluateSetupTaxonomy({ symbol: 'AAPL', series: s, nomineeSide: 'call' }, [shallow, deep]).reasonCode)
      .toBe('series_unreadable');
  });

  it('an empty registry falls back to the documented global bar floor', () => {
    const under = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(SETUP_TAXONOMY_MIN_BARS - 1), nomineeSide: 'call' }, [],
    );
    const over = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(SETUP_TAXONOMY_MIN_BARS), nomineeSide: 'call' }, [],
    );
    expect(under.reasonCode).toBe('series_unreadable');
    expect(over.reasonCode).toBe('no_setup_matched');
  });
});

describe('setup taxonomy — side conflict refuses, it does not flip (TRA-4421 §11 default 2)', () => {
  it('a same-side match confirms', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' }, [alwaysSetup('E', 'call')],
    );
    expect(v.confirmed).toBe(true);
    expect(v.reasonCode).toBeNull();
    expect(v.setupId).toBe('E');
    expect(v.confirmedSide).toBe('call');
  });

  it('an opposite-side match is setup_side_conflict — the nominee is NOT flipped to the other wing', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' }, [alwaysSetup('B', 'put')],
    );
    expect(v.confirmed).toBe(false);
    expect(v.reasonCode).toBe('setup_side_conflict');
    expect(v.setupId).toBe('B');
    // The verdict REPORTS the other side; it does not adopt it.
    expect(v.confirmedSide).toBe('put');
  });

  it('scores every setup, so a same-side match still wins after an earlier conflict', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' },
      [alwaysSetup('B', 'put'), alwaysSetup('E', 'call')],
    );
    expect(v.confirmed).toBe(true);
    expect(v.setupId).toBe('E');
    expect(v.setupsScored).toBe(2);
  });

  it('a setup that throws declines — it does not void the row as unreadable', () => {
    const thrower: SetupTaxonomyDefinition = {
      setupId: 'X', label: 'X', minBars: 10,
      evaluate: () => { throw new Error('boom'); },
    };
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(120), nomineeSide: 'call' }, [thrower],
    );
    expect(v.reasonCode).toBe('no_setup_matched');
    expect(v.setupsScored).toBe(1);
  });
});

describe('setup taxonomy — the timeframe tell', () => {
  it('publishes seriesSpanMs, so 60 intraday bars and 60 daily bars are distinguishable', () => {
    const intraday = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(78, 5 * 60_000), nomineeSide: 'call' }, [],
    );
    const daily = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: series(78, DAY_MS), nomineeSide: 'call' }, [],
    );
    // Same bar count, same reason code, same everything a naive readout shows.
    expect(intraday.bars).toBe(daily.bars);
    expect(intraday.reasonCode).toBe(daily.reasonCode);
    // The span is the ONLY field that separates 6.4 hours from 77 days.
    expect(intraday.seriesSpanMs).toBe(77 * 5 * 60_000);
    expect(daily.seriesSpanMs).toBe(77 * DAY_MS);
  });

  it('a single-bar series has no span rather than a span of zero', () => {
    const v = evaluateSetupTaxonomy({ symbol: 'AAPL', series: series(1), nomineeSide: 'call' });
    expect(v.seriesSpanMs).toBeNull();
  });
});

describe('setup taxonomy — reason-code roster', () => {
  it('every code the evaluator can emit is in the published roster', () => {
    // The health route folds on this roster; a code it can emit but not publish
    // would vanish into an unlabelled bucket.
    const emitted = new Set(
      [
        evaluateSetupTaxonomy({ symbol: 'A', series: [], nomineeSide: 'call' }),
        evaluateSetupTaxonomy({ symbol: 'A', series: series(120), nomineeSide: 'call' }, []),
        evaluateSetupTaxonomy({ symbol: 'A', series: series(120), nomineeSide: 'call' }, [alwaysSetup('B', 'put')]),
      ].map((v) => v.reasonCode).filter((c): c is NonNullable<typeof c> => c !== null),
    );
    for (const code of emitted) expect(SETUP_TAXONOMY_REASON_CODES).toContain(code);
    expect(SETUP_TAXONOMY_REASON_CODES).toHaveLength(5);
  });
});

describe('TRA-4423 — scoreAll: per-setup truth WITHOUT changing the verdict', () => {
  const input = { symbol: 'AAPL', series: series(120), nomineeSide: 'call' as const };

  it('⛔ the verdict is IDENTICAL with and without scoreAll, on all three outcomes', () => {
    const cases: Array<[string, SetupTaxonomyDefinition[]]> = [
      ['confirm', [neverSetup('A'), alwaysSetup('B', 'call'), alwaysSetup('C', 'call')]],
      ['conflict', [neverSetup('A'), alwaysSetup('B', 'put'), alwaysSetup('C', 'put')]],
      ['no match', [neverSetup('A'), neverSetup('B')]],
      ['conflict THEN confirm — first-match-wins must still pick the confirm', [
        alwaysSetup('A', 'put'), alwaysSetup('B', 'call'),
      ]],
    ];
    for (const [label, setups] of cases) {
      const plain = evaluateSetupTaxonomy(input, setups);
      const dense = evaluateSetupTaxonomy(input, setups, { scoreAll: true });
      expect(
        { c: dense.confirmed, r: dense.reasonCode, s: dense.setupId, side: dense.confirmedSide },
        label,
      ).toEqual({ c: plain.confirmed, r: plain.reasonCode, s: plain.setupId, side: plain.confirmedSide });
    }
  });

  it('⛔ THE DISCRIMINATOR: a setup masked by an earlier confirm is reached+matched, not silent', () => {
    // B confirms first, so the verdict credits B and C is never called by the
    // default walk. C matching is invisible to any counter folded off setupId.
    const setups = [alwaysSetup('B', 'call'), alwaysSetup('C', 'call')];
    const plain = evaluateSetupTaxonomy(input, setups);
    expect(plain.setupId).toBe('B');
    expect(plain.perSetup).toBeUndefined();
    expect(plain.setupsScored).toBe(1); // stopped at B

    const dense = evaluateSetupTaxonomy(input, setups, { scoreAll: true });
    expect(dense.setupId).toBe('B'); // verdict unmoved
    expect(dense.setupsScored).toBe(2); // truthful call count
    const c = dense.perSetup?.find((p) => p.setupId === 'C');
    expect(c).toEqual({ setupId: 'C', reached: true, matched: true, side: 'call', threw: false });
  });

  it('separates NEVER FIRES from NEVER REACHED — the two that used to read alike', () => {
    const neverFires = evaluateSetupTaxonomy(
      input, [alwaysSetup('B', 'call'), neverSetup('C')], { scoreAll: true },
    ).perSetup?.find((p) => p.setupId === 'C');
    expect(neverFires).toMatchObject({ reached: true, matched: false });

    // Same C, same zero matches — but never given the chance, under the
    // default walk. `perSetup` is ABSENT, which a fold must skip, not zero.
    const neverReached = evaluateSetupTaxonomy(input, [alwaysSetup('B', 'call'), neverSetup('C')]);
    expect(neverReached.perSetup).toBeUndefined();
  });

  it('is dense over the ENABLED list and keeps registry order', () => {
    const v = evaluateSetupTaxonomy(
      input, [alwaysSetup('A', 'call'), neverSetup('B'), alwaysSetup('C', 'put')], { scoreAll: true },
    );
    expect(v.perSetup?.map((p) => p.setupId)).toEqual(['A', 'B', 'C']);
    expect(v.perSetup?.every((p) => p.reached)).toBe(true);
  });

  it('a THROWING setup is a decline with threw:true, never a series fault', () => {
    const boom: SetupTaxonomyDefinition = {
      setupId: 'X', label: 'X', minBars: 10,
      evaluate: () => { throw new Error('boom'); },
    };
    const v = evaluateSetupTaxonomy(input, [boom, neverSetup('B')], { scoreAll: true });
    expect(v.reasonCode).toBe('no_setup_matched');
    expect(v.perSetup?.find((p) => p.setupId === 'X'))
      .toEqual({ setupId: 'X', reached: true, matched: false, side: null, threw: true });
  });

  it('an unreadable series short-circuits BEFORE scoring, so perSetup stays absent', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'AAPL', series: [], nomineeSide: 'call' }, [alwaysSetup('A', 'call')], { scoreAll: true },
    );
    expect(v.reasonCode).toBe('series_unreadable');
    expect(v.setupsScored).toBe(0);
    expect(v.perSetup).toBeUndefined();
  });

  it('⛔ a later setup can NEVER overwrite a settled confirm, even while still being scored', () => {
    // A confirms; C matches the opposite side afterwards. Under scoreAll the
    // walk continues — if `conflict` were still assignable the verdict would
    // flip to setup_side_conflict, which is the mutation this guards.
    const v = evaluateSetupTaxonomy(
      input, [alwaysSetup('A', 'call'), alwaysSetup('C', 'put')], { scoreAll: true },
    );
    expect(v.confirmed).toBe(true);
    expect(v.reasonCode).toBeNull();
    expect(v.setupId).toBe('A');
    expect(v.perSetup?.find((p) => p.setupId === 'C'))
      .toMatchObject({ reached: true, matched: true, side: 'put' });
  });
});
