import { describe, it, expect } from 'vitest';
import {
  summarizeOptionTradeJournal,
  entryDeltaBucket,
  deltaBucketOrder,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';

// TRA-1661 (TRA-1647A) — the byDelta rollup: the WITHIN-sleeve measurement of the
// cost gate estimator's one load-bearing claim ("realized gross R rises with entry
// delta"). Cross-sleeve, the realized book already contradicts that slope — but that
// comparison is confounded by scanner/signal/exit differences, so only a per-structure
// read can establish the true slope. These tests pin the properties the re-grade
// depends on: no pooling, both R bases, and an honest dispersion.

function closed(over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
  return {
    id: over.id ?? 'x',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.35,
    entryDte: 40,
    atRiskUsd: 100,
    outcome: 'WIN',
    realizedR: 0.1,
    realizedPnlUsd: 10,
    exitReason: 'tp1',
    holdDays: 3,
    ...over,
  };
}

describe('entryDeltaBucket', () => {
  it('buckets in 0.05-wide half-open bands across [0.20, 0.70]', () => {
    expect(entryDeltaBucket(0.2)).toBe('0.20-0.25');
    expect(entryDeltaBucket(0.249)).toBe('0.20-0.25');
    expect(entryDeltaBucket(0.25)).toBe('0.25-0.30'); // half-open: upper edge rolls up
    expect(entryDeltaBucket(0.42)).toBe('0.40-0.45');
    expect(entryDeltaBucket(0.6999)).toBe('0.65-0.70');
  });

  it('sends out-of-range deltas to the catch-alls, never dropping a row', () => {
    expect(entryDeltaBucket(0.19)).toBe('lt0.20');
    expect(entryDeltaBucket(0)).toBe('lt0.20');
    expect(entryDeltaBucket(0.7)).toBe('gte0.70');
    expect(entryDeltaBucket(0.95)).toBe('gte0.70');
  });

  it('TRA-1691: an UNMEASURED delta is `unknown`, never `lt0.20`', () => {
    // `lt0.20` is not an inert catch-all — it is the band the OTM entry-delta floor
    // (TRA-1407) exists to cut. Folding an unmeasured row in there grades a missing
    // measurement as evidence against low delta.
    expect(entryDeltaBucket(Number.NaN)).toBe('unknown');
    expect(entryDeltaBucket(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(entryDeltaBucket(undefined as unknown as number)).toBe('unknown');
  });

  it('folds sign — the estimator uses |delta| (a 0.40-delta put is a 0.40 read)', () => {
    expect(entryDeltaBucket(-0.42)).toBe('0.40-0.45');
  });

  it('deltaBucketOrder covers [0.20,0.70) in 10 bands plus 2 catch-alls, ascending', () => {
    const order = deltaBucketOrder();
    expect(order).toHaveLength(13);
    expect(order[0]).toBe('lt0.20');
    expect(order[1]).toBe('0.20-0.25');
    expect(order[10]).toBe('0.65-0.70');
    expect(order[11]).toBe('gte0.70');
    // `unknown` is not a point on the delta axis, so it sorts LAST — never as the
    // leftmost (lowest-delta) band of a slope chart.
    expect(order[12]).toBe('unknown');
  });
});

describe('summarizeOptionTradeJournal — byDelta (TRA-1661)', () => {
  it('NEVER pools the sleeves — they are the confound the cross-sleeve read died of', () => {
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', structure: 'single_leg_rv', entryDelta: 0.35 }),
      closed({ id: 'b', structure: 'single_leg_otm', entryDelta: 0.42 }),
      closed({ id: 'c', structure: 'single_leg_otm', entryDelta: 0.42 }),
    ]);
    expect(byDelta.map((s) => s.structure).sort()).toEqual(['single_leg_otm', 'single_leg_rv']);
    // Same delta band in two sleeves must never merge into one row.
    const otm = byDelta.find((s) => s.structure === 'single_leg_otm')!;
    const rv = byDelta.find((s) => s.structure === 'single_leg_rv')!;
    expect(otm.closed).toBe(2);
    expect(rv.closed).toBe(1);
  });
});

describe('summarizeOptionTradeJournal — byDelta cohort key (TRA-1691)', () => {
  // The structure label is NOT the sleeve. `openOptionFromRvCandidate` journals
  // `structure: 'single_leg_rv'` for all of its callers (TRA-1682), so keying the
  // rollup on structure pools the gated RV long with the ungated demo directional
  // churner and the IV-vs-RV premium buyer — re-committing, one rollup over, the exact
  // pooling TRA-1661's own comment forbids.
  it('splits one structure into its ARCHETYPE sleeves — the tail is not one population', () => {
    // This is the live shape, scaled down: the |Δ|≥0.65 tail on the running book is
    // n=94, of which 37 are `iv-rv-buy-premium` — a 40% dose of a different scanner in
    // a verdict that will be read as the RV long's.
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', entryArchetype: 'rv-long', entryDelta: 0.66, realizedR: -0.2 }),
      closed({ id: 'b', entryArchetype: 'rv-long', entryDelta: 0.67, realizedR: -0.4 }),
      closed({ id: 'c', entryArchetype: 'iv-rv-buy-premium', entryDelta: 0.66, realizedR: 0.9 }),
    ]);

    expect(byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::iv-rv-buy-premium',
      'single_leg_rv::rv-long',
    ]);

    const rvLong = byDelta.find((c) => c.cohort === 'single_leg_rv::rv-long')!;
    expect(rvLong.structure).toBe('single_leg_rv');
    expect(rvLong.entryArchetype).toBe('rv-long');
    expect(rvLong.closed).toBe(2);
    // The RV long's own tail: −0.30R premium basis. Pooled with the premium buyer it
    // would read +0.10R — a sign flip, i.e. the ceiling verdict inverts.
    const band = rvLong.buckets.find((b) => b.bucket === '0.65-0.70')!;
    expect(band.avgRealizedR_premiumBasis).toBeCloseTo(-0.3, 10);
    expect(band.avgRealizedR_gateBasis).toBeCloseTo(-1.2, 10); // 4x

    const ivRv = byDelta.find((c) => c.cohort === 'single_leg_rv::iv-rv-buy-premium')!;
    expect(ivRv.closed).toBe(1);
    expect(ivRv.buckets[0]!.avgRealizedR_premiumBasis).toBeCloseTo(0.9, 10);
  });

  it('keeps the R basis keyed on the STRUCTURE, not the archetype', () => {
    // The premium→gate 4× conversion is a property of the instrument (full-premium
    // atRisk + mark·0.75 stop), not of the scanner that picked it. Every archetype
    // inside a credit spread must still null the gate basis.
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', structure: 'bull_put', entryArchetype: 'ema-pullback', entryDelta: 0.3 }),
      closed({ id: 'b', structure: 'single_leg_rv', entryArchetype: 'ema-pullback', entryDelta: 0.3 }),
    ]);
    expect(byDelta.find((c) => c.structure === 'bull_put')!.gateBasisValid).toBe(false);
    expect(byDelta.find((c) => c.structure === 'single_leg_rv')!.gateBasisValid).toBe(true);
  });

  it('folds UNTAGGED rows to `unspecified` — history, and it must stop growing post-deploy', () => {
    // Tagging is forward-only: pre-TRA-1682 rows cannot be back-attributed, so the
    // `unspecified` cohort is the historical blend. Post-deploy it must STOP GROWING —
    // if it doesn't, tagging is broken, and this rollup is where that shows.
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', entryDelta: 0.66 }), // untagged (legacy)
      closed({ id: 'b', entryArchetype: 'rv-long', entryDelta: 0.66 }),
    ]);
    expect(byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::rv-long',
      'single_leg_rv::unspecified',
    ]);
    expect(byDelta.find((c) => c.cohort === 'single_leg_rv::unspecified')!.closed).toBe(1);
  });

  it('quarantines an UNMEASURED delta in `unknown` instead of the floor-cut band', () => {
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', entryDelta: Number.NaN, realizedR: -0.9 }),
      closed({ id: 'b', entryDelta: 0.1, realizedR: 0.1 }),
    ]);
    const buckets = byDelta[0]!.buckets;
    expect(buckets.map((b) => b.bucket)).toEqual(['lt0.20', 'unknown']);

    // The genuine low-delta row keeps its own mean — the unmeasured row does not drag it.
    const low = buckets.find((b) => b.bucket === 'lt0.20')!;
    expect(low.closed).toBe(1);
    expect(low.avgRealizedR_premiumBasis).toBeCloseTo(0.1, 10);

    const unknown = buckets.find((b) => b.bucket === 'unknown')!;
    expect(unknown.closed).toBe(1);
    expect(unknown.deltaFrom).toBeNull();
    expect(unknown.deltaTo).toBeNull();
    expect(unknown.avgEntryDelta).toBeNull(); // no measurement to average
  });

  it('reports realized R in BOTH bases — gate R is 4x the journal R (TRA-1656 #5)', () => {
    // The journal divides by atRiskUsd = the FULL premium; the gate's R is the stop
    // distance = 0.25·premium. Emitting one ambiguous number is how the phantom 1.00R
    // cost input survived review.
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', structure: 'single_leg_rv', entryDelta: 0.35, realizedR: 0.1 }),
      closed({ id: 'b', structure: 'single_leg_rv', entryDelta: 0.36, realizedR: 0.2 }),
    ]);
    const b = byDelta[0]!.buckets.find((x) => x.bucket === '0.35-0.40')!;
    expect(b.closed).toBe(2);
    expect(b.avgRealizedR_premiumBasis).toBeCloseTo(0.15, 10);
    expect(b.avgRealizedR_gateBasis).toBeCloseTo(0.6, 10); // 4x
    expect(b.sdRealizedR_gateBasis).toBeCloseTo(4 * b.sdRealizedR_premiumBasis!, 10);
    expect(b.seRealizedR_gateBasis).toBeCloseTo(4 * b.seRealizedR_premiumBasis!, 10);
  });

  it('NULLS the gate basis on structures where the 4x conversion does not hold', () => {
    // A credit spread's atRiskUsd is (width − credit), not a premium, and it has no
    // mark·0.75 stop — so there is no valid premium→gate conversion. A wrong number
    // scaled by an inapplicable factor is worse than no number.
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', structure: 'bull_put', entryDelta: 0.3, realizedR: 0.5 }),
      closed({ id: 'b', structure: 'bull_put', entryDelta: 0.31, realizedR: 0.1 }),
    ]);
    const s = byDelta[0]!;
    expect(s.gateBasisValid).toBe(false);
    const b = s.buckets[0]!;
    expect(b.avgRealizedR_premiumBasis).toBeCloseTo(0.3, 10); // still measured
    expect(b.avgRealizedR_gateBasis).toBeNull();
    expect(b.sdRealizedR_gateBasis).toBeNull();
    expect(b.seRealizedR_gateBasis).toBeNull();
  });

  it('uses the SAMPLE sd (n−1) and nulls it at n=1 — no fake-confident zero dispersion', () => {
    // This is the TRA-992 / TRA-1585 coin-flip guard: a 1-row bucket has NO measurable
    // dispersion, and reporting sd=0 there would manufacture a CI of zero width.
    const one = summarizeOptionTradeJournal([closed({ id: 'a', entryDelta: 0.42, realizedR: 0.9 })]);
    const b1 = one.byDelta[0]!.buckets[0]!;
    expect(b1.closed).toBe(1);
    expect(b1.avgRealizedR_premiumBasis).toBeCloseTo(0.9, 10);
    expect(b1.sdRealizedR_premiumBasis).toBeNull();
    expect(b1.seRealizedR_premiumBasis).toBeNull();

    // n=3, values 0.0 / 0.3 / 0.6 → mean 0.3, sample sd = 0.3, se = 0.3/√3.
    const three = summarizeOptionTradeJournal([
      closed({ id: 'a', entryDelta: 0.42, realizedR: 0.0 }),
      closed({ id: 'b', entryDelta: 0.42, realizedR: 0.3 }),
      closed({ id: 'c', entryDelta: 0.42, realizedR: 0.6 }),
    ]);
    const b3 = three.byDelta[0]!.buckets[0]!;
    expect(b3.avgRealizedR_premiumBasis).toBeCloseTo(0.3, 10);
    expect(b3.sdRealizedR_premiumBasis).toBeCloseTo(0.3, 10);
    expect(b3.seRealizedR_premiumBasis).toBeCloseTo(0.3 / Math.sqrt(3), 10);
  });

  it('emits bands ascending in delta with parseable edges, and win/pnl per band', () => {
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', entryDelta: 0.62, realizedR: 0.4, outcome: 'WIN', realizedPnlUsd: 40 }),
      closed({ id: 'b', entryDelta: 0.22, realizedR: -0.5, outcome: 'LOSS', realizedPnlUsd: -50 }),
      closed({ id: 'c', entryDelta: 0.9, realizedR: 0.1, outcome: 'WIN', realizedPnlUsd: 10 }),
      closed({ id: 'd', entryDelta: 0.05, realizedR: 0.0, outcome: 'SCRATCH', realizedPnlUsd: 0 }),
    ]);
    const buckets = byDelta[0]!.buckets;
    expect(buckets.map((b) => b.bucket)).toEqual(['lt0.20', '0.20-0.25', '0.60-0.65', 'gte0.70']);

    const low = buckets[0]!;
    expect(low.deltaFrom).toBeNull(); // open-ended below
    expect(low.deltaTo).toBe(0.2);
    const mid = buckets[1]!;
    expect(mid.deltaFrom).toBe(0.2);
    expect(mid.deltaTo).toBe(0.25);
    expect(mid.win).toBe(0);
    expect(mid.winRate).toBe(0);
    expect(mid.realizedPnlUsd).toBe(-50);
    const high = buckets[3]!;
    expect(high.deltaFrom).toBe(0.7);
    expect(high.deltaTo).toBeNull(); // open-ended above
    expect(high.winRate).toBe(1);
    expect(high.avgEntryDelta).toBeCloseTo(0.9, 10);
  });

  it('excludes still-OPEN rows — an unresolved trade has no realized R to fit a slope on', () => {
    const { byDelta } = summarizeOptionTradeJournal([
      closed({ id: 'a', entryDelta: 0.42, realizedR: 0.5 }),
      { ...closed({ id: 'b', entryDelta: 0.42 }), outcome: 'OPEN', realizedR: undefined, realizedPnlUsd: undefined },
    ]);
    expect(byDelta[0]!.closed).toBe(1);
    expect(byDelta[0]!.buckets[0]!.closed).toBe(1);
    expect(byDelta[0]!.buckets[0]!.avgRealizedR_premiumBasis).toBeCloseTo(0.5, 10);
  });

  it('is empty on an empty book rather than throwing', () => {
    expect(summarizeOptionTradeJournal([]).byDelta).toEqual([]);
  });
});
