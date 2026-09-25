// TRA-4578 — the per-cell PROVENANCE block and the net-of-modelled-cross
// companion, and the guard the ticket asks for by name.
//
// ── What these tests have to be able to fail ─────────────────────────────────
//
// The defect being closed is that `arm.costBar.edge.otmCells[]` and
// `table.cells[]` read IDENTICALLY in the state where they are trustworthy (desk
// real-money closes) and the state where they are not (demo rows booked at mid,
// `demoSlippagePct: 0`). A test that only asserts "the key exists" reproduces
// that defect one level up: it passes against a hardcoded `{ demo: 0, live: 0 }`.
//
// So the load-bearing assertion in this file is a DISCRIMINATION: two cells built
// from IDENTICAL R values, differing only in provenance, must publish provenance
// blocks that DIFFER — and their statistics must be byte-identical, which is what
// proves the difference came from the new axis rather than from the numbers. Each
// such test carries its own negative control (`NEGATIVE CONTROL:` below): the
// literal a constant implementation would emit, asserted NOT to match.

import { describe, expect, it } from 'vitest';
import {
  buildTapeExpectancyTable,
  tapeExpectancyCellKey,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';
import { GATE_R_PER_PREMIUM_R, type OptionTradeJournalRecord } from './option-trade-journal.js';
import { TapeExpectancyCache } from './option-tape-expectancy-cache.js';

const OTM = 'single_leg_otm';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** A synthetic CLOSED row. `realizedR` is PREMIUM R; gate R is 4x. */
function row(opts: {
  delta: number;
  realizedR: number;
  mode?: 'demo' | 'live';
  account?: string;
  closeTs?: number;
  structure?: string;
  outcome?: string;
}): OptionTradeJournalRecord {
  return {
    structure: opts.structure ?? OTM,
    outcome: opts.outcome ?? 'WIN',
    entryDelta: opts.delta,
    realizedR: opts.realizedR,
    closeTs: opts.closeTs ?? T0,
    mode: opts.mode ?? 'demo',
    ...(opts.account === undefined ? {} : { account: opts.account }),
  } as unknown as OptionTradeJournalRecord;
}

function cell(cells: readonly TapeExpectancyCell[], bucket: string): TapeExpectancyCell {
  const found = cells.find((c) => c.cellKey === tapeExpectancyCellKey(OTM, bucket));
  if (!found) throw new Error(`no cell ${bucket} in [${cells.map((c) => c.cellKey).join(', ')}]`);
  return found;
}

/** The same R values in both cells — only the provenance differs. */
const R_VALUES = [0.4, -0.2, 0.9, -0.5, 0.3, 0.75, -0.1, 0.2];

describe('TRA-4578 — the per-cell provenance census', () => {
  it('DISCRIMINATES an all-demo cell from an all-live cell whose R values are IDENTICAL', () => {
    // Band 0.50-0.55 is all demo/unattributed; band 0.45-0.50 is all live/desk.
    // Same eight realized R values in both, in the same order.
    const rows = [
      ...R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'demo' })),
      ...R_VALUES.map((r) => row({ delta: 0.47, realizedR: r, mode: 'live', account: 'desk1' })),
    ];
    const t = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 });
    const demoCell = cell(t.cells, '0.50-0.55');
    const liveCell = cell(t.cells, '0.45-0.50');

    // The STATISTICS are identical — which is the point: without provenance these
    // two rows are byte-identical, and one of them is real money.
    expect(demoCell.n).toBe(liveCell.n);
    expect(demoCell.meanR_gate).toBe(liveCell.meanR_gate);
    expect(demoCell.lowerCI95).toBe(liveCell.lowerCI95);

    // The PROVENANCE is not.
    expect(JSON.stringify(demoCell.provenance)).not.toBe(JSON.stringify(liveCell.provenance));
    expect(demoCell.provenance.byMode).toEqual({ demo: 8 });
    expect(liveCell.provenance.byMode).toEqual({ live: 8 });
    expect(demoCell.provenance.byAccountClass).toEqual({ desk: 0, unattributed: 8 });
    expect(liveCell.provenance.byAccountClass).toEqual({ desk: 8, unattributed: 0 });

    // NEGATIVE CONTROL: the two shapes a constant implementation would emit. If
    // either of these ever matched, every assertion above would be vacuous.
    const CONSTANT_MODE = { demo: 0, live: 0 };
    const CONSTANT_CLASS = { desk: 0, unattributed: 0 };
    for (const c of [demoCell, liveCell]) {
      expect(c.provenance.byMode).not.toEqual(CONSTANT_MODE);
      expect(c.provenance.byAccountClass).not.toEqual(CONSTANT_CLASS);
    }
  });

  it('splits mode and account class INDEPENDENTLY — a live row can be unattributed', () => {
    // The two axes are orthogonal (TRA-3831): `desk+unattributed` is silent about
    // `mode`. A census that folded them into one field would fail here.
    const rows = [
      row({ delta: 0.52, realizedR: 0.1, mode: 'demo', account: 'desk1' }),
      row({ delta: 0.52, realizedR: 0.1, mode: 'demo' }),
      row({ delta: 0.52, realizedR: 0.1, mode: 'live', account: 'desk1' }),
      row({ delta: 0.52, realizedR: 0.1, mode: 'live' }),
    ];
    const c = cell(buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 }).cells, '0.50-0.55');
    expect(c.provenance.byMode).toEqual({ demo: 2, live: 2 });
    expect(c.provenance.byAccountClass).toEqual({ desk: 2, unattributed: 2 });
    // The identity that makes the census readable at all.
    expect(c.provenance.byAccountClass.desk + c.provenance.byAccountClass.unattributed).toBe(c.n);
    expect(Object.values(c.provenance.byMode).reduce((a, v) => a + v, 0)).toBe(c.n);
  });

  it('censuses only the rows the fold USED — every drop predicate is respected', () => {
    // This is why the census lives in the fold and not beside the table-level one
    // in the cache: only this loop knows which rows survived. A census re-derived
    // upstream would have to re-implement all four predicates plus the window.
    const rows = [
      row({ delta: 0.52, realizedR: 0.4, mode: 'demo' }), // kept
      row({ delta: 0.52, realizedR: 0.4, mode: 'live', account: 'desk1' }), // kept
      row({ delta: 0.52, realizedR: 0.4, mode: 'live', outcome: 'OPEN' }), // unresolved
      row({ delta: 0.52, realizedR: 0.4, mode: 'live', structure: 'credit_spread' }), // no gate basis
      row({ delta: 1.4, realizedR: 0.4, mode: 'live' }), // unknown delta
      row({ delta: 0.52, realizedR: 0.4, mode: 'live', closeTs: T0 - 400 * DAY }), // out of window
    ];
    const t = buildTapeExpectancyTable(rows, { windowDays: 365, nowMs: T0 });
    const c = cell(t.cells, '0.50-0.55');
    expect(c.n).toBe(2);
    // Four live rows were offered; exactly ONE of them landed in the cell.
    expect(c.provenance.byMode).toEqual({ demo: 1, live: 1 });
    expect(t.rowsDroppedUnresolved + t.rowsDroppedNoGateBasis
      + t.rowsDroppedUnknownDelta + t.rowsDroppedOutOfWindow).toBe(4);
  });

  it('carries a PER-CELL fromTs/toTs that the table-level span cannot express', () => {
    const rows = [
      row({ delta: 0.52, realizedR: 0.4, closeTs: T0 }),
      row({ delta: 0.52, realizedR: 0.4, closeTs: T0 + 5 * DAY }),
      row({ delta: 0.47, realizedR: 0.4, closeTs: T0 + 40 * DAY }),
      row({ delta: 0.47, realizedR: 0.4, closeTs: T0 + 60 * DAY }),
    ];
    const t = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 + 90 * DAY });
    // The table span covers both populations at once and separates nothing.
    expect(t.fromTs).toBe(T0);
    expect(t.toTs).toBe(T0 + 60 * DAY);
    // The cells do separate them.
    expect(cell(t.cells, '0.50-0.55').provenance.fromTs).toBe(T0);
    expect(cell(t.cells, '0.50-0.55').provenance.toTs).toBe(T0 + 5 * DAY);
    expect(cell(t.cells, '0.45-0.50').provenance.fromTs).toBe(T0 + 40 * DAY);
    expect(cell(t.cells, '0.45-0.50').provenance.toTs).toBe(T0 + 60 * DAY);
  });
});

describe('TRA-4578 — the net-of-modelled-cross companion', () => {
  const key = tapeExpectancyCellKey(OTM, '0.50-0.55');

  it('charges DEMO rows only, per row — so it moves the SE, not just the mean', () => {
    const rows = [
      ...R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'demo' })),
      ...R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'live', account: 'd' })),
    ];
    const costR = 0.3347;
    const t = buildTapeExpectancyTable(rows, {
      windowDays: null,
      nowMs: T0,
      modelledCrossRByCell: new Map([[key, costR]]),
      modelledCrossRSource: 'test-source',
    });
    const c = cell(t.cells, '0.50-0.55');

    expect(c.netOfModelledCross.rowsCharged).toBe(8);
    expect(c.netOfModelledCross.rowsUncharged).toBe(8);
    expect(c.netOfModelledCross.costR_gate).toBe(costR);
    expect(c.netOfModelledCross.source).toBe('test-source');
    expect(c.netOfModelledCross.unavailableReason).toBeNull();

    // Mean shifts by the charged FRACTION, exactly once.
    expect(c.meanR_gate_netOfModelledCross!).toBeCloseTo(c.meanR_gate - costR * (8 / 16), 12);
    // …and the dispersion MOVES, because the deduction lands on a subset. This is
    // the assertion that fails if the companion is ever "reconstructed" at render
    // time from the served summary statistics, which cannot recover it.
    expect(c.netOfModelledCross.sdR_gate).not.toBeCloseTo(c.sdR_gate!, 6);
    expect(c.lowerCI95_netOfModelledCross!).not.toBeCloseTo(c.lowerCI95! - costR * 0.5, 6);
  });

  it('is a COMPANION: `admits` is byte-identical charged and uncharged', () => {
    // 40 rows at a steady +0.5 premium R (= +2.0 gate R) clears the bar; charging
    // a 2.0 gate-R cross takes the net mean to ~0, which flips `wouldAdmit` —
    // and MUST NOT touch `admits`.
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ delta: 0.52, realizedR: 0.5 + (i % 2 === 0 ? 0.01 : -0.01), mode: 'demo' }));
    const uncharged = cell(buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 }).cells, '0.50-0.55');
    const charged = cell(buildTapeExpectancyTable(rows, {
      windowDays: null,
      nowMs: T0,
      modelledCrossRByCell: new Map([[key, 2.0]]),
      modelledCrossRSource: 'test-source',
    }).cells, '0.50-0.55');

    // TRA-4894 — the attestation is now on `admitsPooled`, which IS the field
    // this test was written about: the pre-TRA-4894 predicate, unchanged by the
    // cross charge. `admits` is the conjunction and reads `false` on both sides
    // here because these 40 fixture rows carry no `pnlBasis: 'broker-fill'`
    // stamp — which is the correct new behaviour and is itself asserted, so the
    // pair below cannot degenerate into "both false for the same boring reason".
    expect(uncharged.admitsPooled).toBe(true);
    expect(charged.admitsPooled).toBe(true);
    expect(uncharged.nRealFill).toBe(0);
    expect(uncharged.admits).toBe(false);
    expect(charged.admits).toBe(false);
    expect(charged.meanR_gate).toBe(uncharged.meanR_gate);
    expect(charged.lowerCI95).toBe(uncharged.lowerCI95);
    expect(charged.barR).toBe(uncharged.barR);

    // The counterfactual DID move — so the equality above is a real attestation,
    // not a pair of numbers that could not have differed.
    expect(charged.netOfModelledCross.wouldAdmit).toBe(false);
    expect(charged.lowerCI95_netOfModelledCross!).toBeLessThan(charged.lowerCI95!);
    expect(charged.meanR_gate_netOfModelledCross!)
      .toBeCloseTo(uncharged.meanR_gate - 2.0, 12);
    // Sanity on the unit: gate R = premium R / 0.25.
    expect(uncharged.meanR_gate).toBeCloseTo(0.5 * GATE_R_PER_PREMIUM_R, 9);
  });

  it('FAILS NULL, never zero — and distinguishes NO SOURCE from NO SAMPLE', () => {
    const rows = R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'demo' }));

    const noSource = cell(buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 }).cells, '0.50-0.55');
    expect(noSource.meanR_gate_netOfModelledCross).toBeNull();
    expect(noSource.lowerCI95_netOfModelledCross).toBeNull();
    expect(noSource.netOfModelledCross.costR_gate).toBeNull();
    expect(noSource.netOfModelledCross.source).toBeNull();
    expect(noSource.netOfModelledCross.wouldAdmit).toBeNull();
    expect(noSource.netOfModelledCross.unavailableReason).toContain('no per-cell cross-cost source');

    // A source that exists but cannot price THIS cell is a different state, and
    // reads differently. Both are null; neither is a zero charge.
    const noSample = cell(buildTapeExpectancyTable(rows, {
      windowDays: null,
      nowMs: T0,
      modelledCrossRByCell: new Map([[tapeExpectancyCellKey(OTM, '0.00-0.10'), 0.4]]),
      modelledCrossRSource: 'test-source',
    }).cells, '0.50-0.55');
    expect(noSample.netOfModelledCross.costR_gate).toBeNull();
    expect(noSample.netOfModelledCross.unavailableReason).toContain('no measured round-trip costR');
    expect(noSample.netOfModelledCross.unavailableReason)
      .not.toBe(noSource.netOfModelledCross.unavailableReason);

    // NEGATIVE CONTROL: a zero charge would make the companion byte-identical to
    // the gross column — i.e. it would reproduce the defect. Assert the shipped
    // null case is NOT that.
    const zeroCharged = cell(buildTapeExpectancyTable(rows, {
      windowDays: null,
      nowMs: T0,
      modelledCrossRByCell: new Map([[key, 0]]),
      modelledCrossRSource: 'test-source',
    }).cells, '0.50-0.55');
    expect(zeroCharged.meanR_gate_netOfModelledCross).toBe(zeroCharged.meanR_gate);
    expect(noSource.meanR_gate_netOfModelledCross).not.toBe(noSource.meanR_gate);
  });

  it('a non-finite charge is treated as ABSENT, not as a NaN companion', () => {
    const rows = R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'demo' }));
    const c = cell(buildTapeExpectancyTable(rows, {
      windowDays: null,
      nowMs: T0,
      modelledCrossRByCell: new Map([[key, Number.NaN]]),
      modelledCrossRSource: 'test-source',
    }).cells, '0.50-0.55');
    expect(c.netOfModelledCross.costR_gate).toBeNull();
    expect(c.meanR_gate_netOfModelledCross).toBeNull();
  });
});

describe('TRA-4578 — the cache seam that supplies the charge', () => {
  const rows = () => [
    ...R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'demo' })),
    ...R_VALUES.map((r) => row({ delta: 0.52, realizedR: r, mode: 'live', account: 'd' })),
  ];

  it('publishes the charge source on the census, and 0-cells is NOT no-source', () => {
    const key = tapeExpectancyCellKey(OTM, '0.50-0.55');
    const opts = { windowDays: null, env: {} as NodeJS.ProcessEnv, load: async () => rows() };

    return (async () => {
      const charged = new TapeExpectancyCache({
        ...opts,
        crossCost: () => ({ byCell: new Map([[key, 0.3347]]), source: 'ledger-under-test' }),
      });
      const c = await charged.get();
      expect(c!.census.crossCostSource).toBe('ledger-under-test');
      expect(c!.census.crossCostCells).toBe(1);
      expect(cell(c!.table.cells, '0.50-0.55').netOfModelledCross.costR_gate).toBe(0.3347);

      // Source present, nothing priceable yet — `crossCostCells: 0`.
      const empty = new TapeExpectancyCache({
        ...opts,
        crossCost: () => ({ byCell: new Map(), source: 'ledger-under-test' }),
      });
      const e = await empty.get();
      expect(e!.census.crossCostSource).toBe('ledger-under-test');
      expect(e!.census.crossCostCells).toBe(0);

      // No source at all — a DIFFERENT state, and it must read differently.
      const none = new TapeExpectancyCache({ ...opts, crossCost: () => null });
      const n = await none.get();
      expect(n!.census.crossCostSource).toBeNull();
      expect(n!.census.crossCostCells).toBe(0);
      expect(e!.census.crossCostSource).not.toBe(n!.census.crossCostSource);
    })();
  });

  it('a THROWING cross-cost source publishes an uncharged table — it never darks the fold', async () => {
    // The companion is observability. It must not be able to take down the table
    // the gate decides on (a null table declines every candidate).
    const c = await new TapeExpectancyCache({
      windowDays: null,
      env: {} as NodeJS.ProcessEnv,
      load: async () => rows(),
      crossCost: () => {
        throw new Error('ledger exploded');
      },
    }).get();

    expect(c).not.toBeNull();
    expect(c!.freshness.lastError).toBeNull();
    const only = cell(c!.table.cells, '0.50-0.55');
    expect(only.n).toBe(16);
    expect(only.provenance.byMode).toEqual({ demo: 8, live: 8 });
    expect(only.netOfModelledCross.unavailableReason).toContain('no per-cell cross-cost source');
  });
});
