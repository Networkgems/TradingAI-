import { describe, it, expect, beforeEach } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { SETUP_DEFINITIONS, setupDefinitionsById } from './setup-definitions.js';
import { evaluateSetupTaxonomy, isSetupTaxonomyMatch } from './setup-taxonomy.js';

/**
 * TRA-4423 — A-E.
 *
 * Every setup gets a CONFIRM arm and a paired REFUSE arm differing by one
 * variable, and the refuse arm is always "the dislocation happened but the
 * underlying has not confirmed". That pairing is the whole point: a taxonomy
 * that fires on magnitude alone is a falling-knife catcher, and every one of
 * these setups would be trivially "improved" by relaxing exactly that check.
 */

let t = 0;
function bar(over: Partial<Candle> = {}): Candle {
  t += 86_400_000;
  const close = over.close ?? 100;
  return {
    symbol: 'TEST',
    timestamp: t,
    open: over.open ?? close,
    high: over.high ?? Math.max(over.open ?? close, close),
    low: over.low ?? Math.min(over.open ?? close, close),
    close,
    volume: over.volume ?? 1_000_000,
    ...(over.synthetic ? { synthetic: true } : {}),
  };
}

/** A flat, unremarkable base the setups should never fire on. */
function flatBase(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, () => bar({ open: price, close: price, high: price * 1.005, low: price * 0.995 }));
}

function run(id: string, series: Candle[], nomineeSide: 'call' | 'put') {
  return evaluateSetupTaxonomy(
    { symbol: 'TEST', series, nomineeSide },
    setupDefinitionsById([id]),
  );
}

beforeEach(() => {
  t = 0;
});

describe('SETUP_DEFINITIONS registry', () => {
  it('registers exactly A-E with unique ids', () => {
    expect(SETUP_DEFINITIONS.map((d: { setupId: string }) => d.setupId)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('never fires on a flat, featureless series', () => {
    // The global negative control. If this goes red, every CONFIRM arm below is
    // suspect — a setup that fires on nothing will also fire on the fixtures.
    //
    // ⛔ ASSERTED AS "NOT A MATCH", NOT AS `null` (TRA-4423). A setup may decline
    // by returning an attributed `SetupTaxonomyDecline` rather than a bare
    // `null` — E does — and a decline is emphatically NOT a fire. Keying this
    // control on `toBeNull` would fail an attributed decline, which pressures the
    // next author to DROP attribution to keep the control green.
    const series = flatBase(40);
    for (const d of SETUP_DEFINITIONS) {
      for (const nomineeSide of ['call', 'put'] as const) {
        expect(isSetupTaxonomyMatch(d.evaluate({ symbol: 'TEST', series, nomineeSide }))).toBe(false);
      }
    }
  });

  it('setupDefinitionsById selects a subset and ignores unknown ids', () => {
    expect(setupDefinitionsById(['A', 'E', 'ZZZ']).map((d: { setupId: string }) => d.setupId)).toEqual(['A', 'E']);
  });
});

describe('Setup A — Panic Reversal', () => {
  // ~9% slide, then a reclaim of the prior bar's high on an up bar.
  const selloff = () => [
    ...flatBase(20),
    bar({ open: 100, close: 96, high: 100, low: 95.5 }),
    bar({ open: 96, close: 93, high: 96, low: 92.5 }),
    bar({ open: 93, close: 91, high: 93.2, low: 90.8 }),
  ];

  it('CONFIRMS a call after the reclaim', () => {
    const series = [...selloff(), bar({ open: 91.2, close: 94, high: 94.2, low: 91 })];
    const v = run('A', series, 'call');
    expect(v.confirmed).toBe(true);
    expect(v.setupId).toBe('A');
    expect(v.confirmedSide).toBe('call');
  });

  it('REFUSES while the stock is still falling — the one-variable pair', () => {
    // Identical dislocation; the last bar keeps going down instead of reclaiming.
    const series = [...selloff(), bar({ open: 91, close: 89.5, high: 91.1, low: 89 })];
    expect(run('A', series, 'call').confirmed).toBe(false);
  });

  it('REFUSES a reclaim with no preceding selloff', () => {
    const series = [...flatBase(23), bar({ open: 100, close: 103, high: 103.2, low: 99.9 })];
    expect(run('A', series, 'call').confirmed).toBe(false);
  });

  it('reports a side conflict rather than flipping the nominee', () => {
    const series = [...selloff(), bar({ open: 91.2, close: 94, high: 94.2, low: 91 })];
    const v = run('A', series, 'put');
    expect(v.confirmed).toBe(false);
    expect(v.reasonCode).toBe('setup_side_conflict');
  });
});

describe('Setup B — Blow-off Reversal', () => {
  const rally = () => [
    ...flatBase(20),
    bar({ open: 100, close: 104, high: 104.5, low: 99.8 }),
    bar({ open: 104, close: 108, high: 108.5, low: 103.8 }),
    bar({ open: 108, close: 110, high: 111, low: 107.5 }),
  ];

  it('CONFIRMS a put on the failure bar', () => {
    const series = [...rally(), bar({ open: 109.8, close: 106.9, high: 110, low: 106.5 })];
    const v = run('B', series, 'put');
    expect(v.confirmed).toBe(true);
    expect(v.confirmedSide).toBe('put');
  });

  it('REFUSES while the rally is still extending — the one-variable pair', () => {
    const series = [...rally(), bar({ open: 110, close: 113, high: 113.5, low: 109.8 })];
    expect(run('B', series, 'put').confirmed).toBe(false);
  });

  it('REFUSES a down bar that has not lost the prior low', () => {
    // Stalls, but holds. A pullback is not a failure.
    const series = [...rally(), bar({ open: 110, close: 109, high: 110.2, low: 108.6 })];
    expect(run('B', series, 'put').confirmed).toBe(false);
  });
});

describe('Setup C — Post-Earnings Continuation', () => {
  // +8% gap, then drift higher.
  const gapUp = () => [...flatBase(25), bar({ open: 108, close: 109, high: 110, low: 107.5 })];

  it('CONFIRMS the gap side once the gap has held for >2 sessions', () => {
    const series = [
      ...gapUp(),
      bar({ open: 109, close: 110, high: 110.5, low: 108.5 }),
      bar({ open: 110, close: 111, high: 111.5, low: 109.5 }),
    ];
    const v = run('C', series, 'call');
    expect(v.confirmed).toBe(true);
    expect(v.confirmedSide).toBe('call');
  });

  it('REFUSES inside the 2-session observation window', () => {
    // Same gap, same hold — only the elapsed sessions differ.
    const series = [...gapUp(), bar({ open: 109, close: 110, high: 110.5, low: 108.5 })];
    expect(run('C', series, 'call').confirmed).toBe(false);
  });

  it('REFUSES once the gap has been given back', () => {
    const series = [
      ...gapUp(),
      bar({ open: 109, close: 104, high: 109, low: 103.5 }),
      bar({ open: 104, close: 101, high: 104.2, low: 100.5 }),
    ];
    expect(run('C', series, 'call').confirmed).toBe(false);
  });
});

describe('Setup D — Post-Earnings Reversal', () => {
  const gapUp = () => [...flatBase(25), bar({ open: 108, close: 109, high: 110, low: 107.5 })];

  it('CONFIRMS the OPPOSITE side when the gap fills and the event low is lost', () => {
    const series = [
      ...gapUp(),
      bar({ open: 109, close: 105, high: 109.2, low: 104.5 }),
      bar({ open: 105, close: 101, high: 105.2, low: 100.5 }),
    ];
    const v = run('D', series, 'put');
    expect(v.confirmed).toBe(true);
    expect(v.confirmedSide).toBe('put');
  });

  it('REFUSES a partial fill that still holds the event low — pullback, not failure', () => {
    const series = [
      ...gapUp(),
      bar({ open: 109, close: 108.5, high: 109.2, low: 108 }),
      bar({ open: 108.5, close: 108, high: 108.8, low: 107.8 }),
    ];
    expect(run('D', series, 'put').confirmed).toBe(false);
  });
});

describe('Setup E — Breakout after consolidation', () => {
  // A tight 10-bar coil around 100, then a break.
  const coil = () =>
    Array.from({ length: 12 }, () =>
      bar({ open: 100, close: 100.2, high: 100.8, low: 99.4, volume: 1_000_000 }),
    );

  it('CONFIRMS a call on a CLOSE above the range with volume expansion', () => {
    const series = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 2_000_000 })];
    const v = run('E', series, 'call');
    expect(v.confirmed).toBe(true);
    expect(v.confirmedSide).toBe('call');
  });

  it('REFUSES a wick through the level that closes back inside', () => {
    // The classic false break. Differs from the confirm arm only in the close.
    const series = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 100.4, high: 103.2, low: 100.3, volume: 2_000_000 })];
    expect(run('E', series, 'call').confirmed).toBe(false);
  });

  it('REFUSES a breakout nobody participated in — the volume pair', () => {
    const series = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 900_000 })];
    expect(run('E', series, 'call').confirmed).toBe(false);
  });

  it('REFUSES when the prior window was never coiled', () => {
    const wide = Array.from({ length: 12 }, (_, i) =>
      bar({ open: 95 + i, close: 96 + i, high: 97 + i, low: 94 + i, volume: 1_000_000 }),
    );
    const series = [...flatBase(20, 100), ...wide, bar({ open: 108, close: 112, high: 112.5, low: 107.8, volume: 2_000_000 })];
    expect(run('E', series, 'call').confirmed).toBe(false);
  });

  // ─── leg attribution (TRA-4423) ───────────────────────────────────────────
  //
  // ⛔ WHY THESE EXIST. On 2026-09-25 E read an honest, dense `reached: 1869`
  // with `matchedSameSide: 0` on the live book, and that zero was STILL
  // unreadable: every one of E's four legs returned the same bare `null`, so
  // "no coiled breakout occurred today" and "a threshold is unsatisfiable" were
  // the same observation. Each arm below pins ONE leg to ONE key.

  /** E's own outcome, uncensored by the walk. */
  const legOf = (series: Candle[]): string | null => {
    const out = setupDefinitionsById(['E'])[0]!.evaluate({ symbol: 'TEST', series, nomineeSide: 'call' });
    if (out === null || isSetupTaxonomyMatch(out)) return null;
    return out.declinedAt;
  };

  it('the CONFIRM arm returns a match, so no leg is attributed', () => {
    const series = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 2_000_000 })];
    const out = setupDefinitionsById(['E'])[0]!.evaluate({ symbol: 'TEST', series, nomineeSide: 'call' });
    expect(isSetupTaxonomyMatch(out)).toBe(true);
  });

  it('each REFUSE arm names a DIFFERENT leg — the legs are not one bucket', () => {
    const wick = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 100.4, high: 103.2, low: 100.3, volume: 2_000_000 })];
    const thin = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 900_000 })];
    const wide = Array.from({ length: 12 }, (_, i) =>
      bar({ open: 95 + i, close: 96 + i, high: 97 + i, low: 94 + i, volume: 1_000_000 }),
    );
    const uncoiled = [...flatBase(20, 100), ...wide, bar({ open: 108, close: 112, high: 112.5, low: 107.8, volume: 2_000_000 })];

    expect(legOf(wick)).toBe('no_close_break');
    expect(legOf(thin)).toBe('volume_not_expanded');
    expect(legOf(uncoiled)).toBe('not_coiled');
    // ⛔ CAPABILITY ASSERT — three distinct keys. If a refactor ever collapses
    // the legs back to one symbol this goes red, which `toBe` on each alone
    // would not guarantee.
    expect(new Set([legOf(wick), legOf(thin), legOf(uncoiled)]).size).toBe(3);
  });

  it('⛔ THE SPLIT THAT MATTERS: a feed carrying NO volume is `no_volume_data`, never `volume_not_expanded`', () => {
    // E is the ONLY setup of the five that reads `volume`, and
    // `fetchDailyCandles` maps `volume: q.volume ?? 0`. So a provider answering
    // null volume coerces the whole expansion leg to zero and E can NEVER fire —
    // on any symbol, on any day, forever — while looking exactly like an ordinary
    // quiet session. A FEED FAULT and A QUIET MARKET must not share a key.
    const zeroVolCoil = Array.from({ length: 12 }, () =>
      bar({ open: 100, close: 100.2, high: 100.8, low: 99.4, volume: 0 }),
    );
    const series = [...flatBase(20, 100), ...zeroVolCoil, bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 2_000_000 })];
    expect(legOf(series)).toBe('no_volume_data');
    // The paired control: the SAME coil with real volume declines for a
    // genuinely different reason, on the market's merits.
    const withVol = [...flatBase(20, 100), ...coil(), bar({ open: 100.5, close: 103, high: 103.2, low: 100.3, volume: 900_000 })];
    expect(legOf(withVol)).toBe('volume_not_expanded');
  });
});

describe('series hygiene', () => {
  it('an unreadable (too short) series short-circuits before any setup runs', () => {
    const v = evaluateSetupTaxonomy(
      { symbol: 'TEST', series: flatBase(3), nomineeSide: 'call' },
      SETUP_DEFINITIONS,
    );
    expect(v.confirmed).toBe(false);
    expect(v.reasonCode).toBe('series_unreadable');
  });

  it('does not read structure out of synthetic gap-filler bars', () => {
    // TRA-427 synthetic bars are flat fabrications bridging a data outage. If
    // Setup E read them, the trailing run of identical flat bars would look like
    // a textbook coil and the next real bar would "break out" of a data gap.
    // The REAL bars here are deliberately wide-ranging, so the only way this can
    // confirm is by reading the fabrications.
    const wideReal = Array.from({ length: 12 }, (_, i) =>
      bar({ open: 95 + i, close: 96 + i, high: 97 + i, low: 94 + i, volume: 1_000_000 }),
    );
    const series = [
      ...flatBase(20, 100),
      ...wideReal,
      ...Array.from({ length: 12 }, () =>
        bar({ open: 108, close: 108, high: 108, low: 108, volume: 0, synthetic: true }),
      ),
      bar({ open: 108, close: 112, high: 112.5, low: 107.8, volume: 2_000_000 }),
    ];
    expect(run('E', series, 'call').confirmed).toBe(false);
  });
});
