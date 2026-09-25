import { describe, it, expect, beforeEach } from 'vitest';
import {
  summarizeRealFillShadow,
  finalizeRestingOrder,
  beginRestingOrder,
  buildTaxonomy,
  admissionOf,
  stratificationHash,
  RefusedCandidateSampler,
  resetRealFillSamplerForTests,
  realFillSampler,
  REAL_FILL_SHADOW_SCHEMA,
  REAL_FILL_MODEL_VERSION,
  REAL_FILL_ADMITTED_EMPTY_REASON,
  DEFAULT_REFUSED_SAMPLER_CONFIG,
  type RealFillShadowRow,
  type RealFillAdmission,
} from './option-real-fill-shadow.js';

// TRA-4897 — the admission partition, the sampler, and the v2 schema break.
//
// Ruling `01167edb` / build order `d9ea0632` on TRA-4897: record cost_bar-REFUSED
// candidates, under a hard partition, so that `rows: 0` stops reading as a
// statement about the market when it is a statement about a gate.
//
// ⚠️ Every assertion here is written to FAIL on the pre-change code. A test that
// passes against both states is the instrument this whole ticket is about.

const T0 = 1_760_000_000_000;

const TAXONOMY = buildTaxonomy({
  structure: 'single_leg_otm',
  delta: 0.34,
  dte: 21,
  bid: 1.0,
  ask: 1.2,
  openInterest: 5_000,
  entryType: 'maker_mid',
  hasExit: false,
});

function mkRow(over: Partial<RealFillShadowRow> = {}): RealFillShadowRow {
  const st = beginRestingOrder(
    { side: 'buy', optionSymbol: 'SPY260101C00500000', limitUsd: 1.1, contracts: 1, bid: 1.0, ask: 1.2 },
    T0,
  )!;
  const row = finalizeRestingOrder(
    st,
    {
      mode: 'demo',
      structure: 'single_leg_otm',
      underlying: 'SPY',
      taxonomy: TAXONOMY,
      admission: 'admitted',
    },
    T0 + 1_000,
  );
  return { ...row, ...over };
}

describe('TRA-4897 — the v2 schema break is DISCRIMINATING', () => {
  it('stamps `real_fill_shadow_v2`, and the tag is asserted as a STRING not an absence', () => {
    // ⚠️ The build order originally said to key a consumer on a TOP-LEVEL
    // `schema`. There is no such field and there never was — it lives under
    // `summary`. A gate written as `top.schema !== 'v2'` reads `undefined !== 'v2'`
    // = TRUE under v1 AND v2 alike: it cannot separate the state it is meant to
    // catch from the state it is meant to pass. Assert the string at the path we
    // actually publish.
    const s = summarizeRealFillShadow([mkRow()], T0);
    expect(s.schema).toBe('real_fill_shadow_v2');
    expect(REAL_FILL_SHADOW_SCHEMA).toBe('real_fill_shadow_v2');
  });

  it('does NOT bump modelVersion — the fill model is unchanged, only the partition', () => {
    // TRA-4885 child A keys on this. Bumping it would tell a downstream reader
    // the modelled PRICES moved, when what moved is which candidates are
    // admitted to the ledger.
    expect(REAL_FILL_MODEL_VERSION).toBe('tra4888.1');
    expect(summarizeRealFillShadow([mkRow()], T0).modelVersion).toBe('tra4888.1');
  });

  it('⛔ has NO pooled aggregate anywhere — the prohibition is STRUCTURAL', () => {
    const s = summarizeRealFillShadow(
      [mkRow(), mkRow({ admission: 'refused', refusedAtGate: 'cost_bar' })],
      T0,
    );
    // The single acceptance the ruling names: the pooled fold must be absent,
    // not merely documented as forbidden.
    expect((s as unknown as Record<string, unknown>).overall).toBeUndefined();
    // …and so must every other top-level fold that used to pool the two.
    for (const fold of [
      'byDeltaBand', 'byDteBand', 'bySpreadBand', 'byLiquidityBand',
      'byEntryType', 'byExitType', 'byCell', 'ruleDisagreement',
      'printTellCoverage', 'byEntryTaxonomySource', 'bySide',
      'rowsWithUnmodelledPartials',
    ]) {
      expect((s as unknown as Record<string, unknown>)[fold]).toBeUndefined();
    }
    // Each partition keeps its OWN aggregate — that is not pooling.
    expect(s.byAdmission.admitted.overall.n).toBe(1);
    expect(s.byAdmission.refused.overall.n).toBe(1);
  });
});

describe('TRA-4897 — the partition itself', () => {
  it('splits rows and never blends their fill rates', () => {
    // An admitted row that FILLED and a refused row that did NOT. Pooled, the
    // rate would be 0.5 and describe neither population.
    const admittedFilled = mkRow({ outcome: 'filled' });
    const refusedUnfilled = mkRow({
      admission: 'refused',
      refusedAtGate: 'cost_bar',
      refusalReasonCode: 'shortfall_gte_0.50',
      sizeBasis: 'refused_nominal_1',
      outcome: 'unfilled',
    });
    const s = summarizeRealFillShadow([admittedFilled, refusedUnfilled], T0);

    expect(s.nAdmitted).toBe(1);
    expect(s.nRefused).toBe(1);
    expect(s.byAdmission.admitted.overall.fillRate).toBe(1);
    expect(s.byAdmission.refused.overall.fillRate).toBe(0);
  });

  it('`nAdmitted` / `nRefused` are PRESENT AT ZERO — the fix for the filed defect', () => {
    // This is the whole ticket. `rows: 0` / `fillRate: null` used to be
    // byte-identical to "the tape never printed through our limits" — a claim
    // about the MARKET. It is a claim about a gate, and these two fields are
    // what say so.
    const s = summarizeRealFillShadow([], T0);
    expect(s.nAdmitted).toBe(0);
    expect(s.nRefused).toBe(0);
    expect(s.rows).toBe(0);
    expect(s.byAdmission.admitted.overall.fillRate).toBeNull();
  });

  it('`admittedEmptyReason` appears IFF the admitted partition is empty', () => {
    const empty = summarizeRealFillShadow(
      [mkRow({ admission: 'refused', refusedAtGate: 'cost_bar' })],
      T0,
    );
    expect(empty.admittedEmptyReason).toBe(REAL_FILL_ADMITTED_EMPTY_REASON);
    expect(empty.admittedEmptyReason).toContain('NOT a market finding');

    const nonEmpty = summarizeRealFillShadow([mkRow()], T0);
    expect(nonEmpty.admittedEmptyReason).toBeNull();
  });

  it('`admittedEmptyReason` quotes NO gate counts — a copied constant would age silently', () => {
    // TRA-4875's defect one layer down: four cells enforcing off an expectancy
    // constant from a tape 51-62 days stale at decision time. The reason text
    // must POINT AT the live surface, never embed a measurement.
    expect(REAL_FILL_ADMITTED_EMPTY_REASON).toContain('live-enforce-gates');
    expect(REAL_FILL_ADMITTED_EMPTY_REASON).not.toMatch(/\d{1,3},\d{3}/);
  });

  it('a refused row is never labelled as a trade we declined', () => {
    const s = summarizeRealFillShadow(
      [mkRow({ admission: 'refused', refusedAtGate: 'cost_bar' })],
      T0,
    );
    const json = JSON.stringify(s);
    expect(json).not.toContain('would_have_traded');
    expect(json).not.toContain('declined');
    expect(s.byAdmission.refused.overall.n).toBe(1);
  });
});

describe('TRA-4897 — legacy v1 rows', () => {
  it('resolve to `admitted` by CONSTRUCTION and are counted, not silently absorbed', () => {
    // Pre-TRA-4893 rows carry no `admission`. They are admitted by
    // construction — the only call sites were downstream of `if (!opened)
    // continue;` — but an INFERRED partition and a STAMPED one must not be
    // indistinguishable in the rollup.
    const legacy = mkRow();
    delete (legacy as Partial<RealFillShadowRow>).admission;
    expect(admissionOf(legacy)).toBe('admitted');

    const s = summarizeRealFillShadow([legacy, mkRow()], T0);
    expect(s.nAdmitted).toBe(2);
    expect(s.rowsMissingAdmission).toBe(1);
  });

  it('a v2 row does NOT inflate `rowsMissingAdmission`', () => {
    expect(summarizeRealFillShadow([mkRow()], T0).rowsMissingAdmission).toBe(0);
  });
});

describe('TRA-4897 — refused rows do not masquerade as opens', () => {
  it('bucket as `not_opened`, never `open_side`', () => {
    // `open_side` claims the position opened. A refused candidate never did,
    // and pooling the two would put positions that never existed into an exit
    // cohort's denominator.
    const s = summarizeRealFillShadow(
      [mkRow(), mkRow({ admission: 'refused', refusedAtGate: 'cost_bar' })],
      T0,
    );
    expect(s.byAdmission.admitted.byExitType.map((c) => c.key)).toEqual(['open_side']);
    expect(s.byAdmission.refused.byExitType.map((c) => c.key)).toEqual(['not_opened']);
  });

  it('carry the gate ledger reason code verbatim, and an unclassified refusal stays visible', () => {
    const s = summarizeRealFillShadow(
      [
        mkRow({ admission: 'refused', refusedAtGate: 'cost_bar', refusalReasonCode: 'shortfall_gte_0.50' }),
        mkRow({ admission: 'refused', refusedAtGate: 'cost_bar', refusalReasonCode: 'gross_negative' }),
        // The gate refused without publishing a code. It must NOT be
        // distributed into the coded buckets.
        mkRow({ admission: 'refused', refusedAtGate: 'cost_bar', refusalReasonCode: null }),
      ],
      T0,
    );
    expect(s.byAdmission.refused.byRefusalReasonCode.map((c) => c.key)).toEqual([
      'gross_negative', 'no_reason_code', 'shortfall_gte_0.50',
    ]);
    // Empty on the admitted partition by construction.
    expect(s.byAdmission.admitted.byRefusalReasonCode).toEqual([]);
  });

  it('are flagged as nominally sized, so a dollar total cannot be read as a portfolio number', () => {
    const s = summarizeRealFillShadow(
      [mkRow({ admission: 'refused', refusedAtGate: 'cost_bar', sizeBasis: 'refused_nominal_1' })],
      T0,
    );
    expect(s.byAdmission.refused.rowsWithNominalSize).toBe(1);
    expect(s.byAdmission.admitted.rowsWithNominalSize).toBe(0);
  });

  it('`finalizeRestingOrder` normalises the gate fields so disk can hold no contradiction', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.1, contracts: 1, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    // An ADMITTED row handed a gate name must not keep it.
    const admitted = finalizeRestingOrder(
      st,
      {
        mode: 'demo',
        structure: 's',
        underlying: 'X',
        taxonomy: TAXONOMY,
        admission: 'admitted',
        refusedAtGate: 'cost_bar',
        refusalReasonCode: 'shortfall_gte_0.50',
      },
      T0 + 1_000,
    );
    expect(admitted.refusedAtGate).toBeNull();
    expect(admitted.refusalReasonCode).toBeNull();
    expect(admitted.sizeBasis).toBe('actual_open');

    // A REFUSED row defaults to the nominal size basis.
    const refused = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 's', underlying: 'X', taxonomy: TAXONOMY, admission: 'refused' },
      T0 + 1_000,
    );
    expect(refused.sizeBasis).toBe('refused_nominal_1');
    expect(refused.refusedAtGate).toBeNull();
  });
});

describe('TRA-4897 §3 — the sampler is NOT first-come-wins', () => {
  const etDay = '2026-09-25';

  it('holds a contract to ONE row per re-observation bucket', () => {
    // 3,039 evaluations/day across ~318 symbols is overwhelmingly the same
    // contracts re-polled. Without this the row count measures POLL FREQUENCY,
    // not candidates.
    const s = new RefusedCandidateSampler();
    const offer = (nowMs: number) =>
      s.offer({ admission: 'refused', optionSymbol: 'SPY_C500', etDay, nowMs, inFlightForPartition: 0 });

    expect(offer(T0)).toBe('sampled');
    expect(offer(T0 + 60_000)).toBe('dropped_reobserve_interval');
    expect(offer(T0 + 29 * 60_000)).toBe('dropped_reobserve_interval');
    // A full interval later — sampled again.
    expect(offer(T0 + 31 * 60_000)).toBe('sampled');
  });

  it('⛔ the interval is ELAPSED TIME, not a grid cell — the boundary case', () => {
    // Regression. The first implementation keyed on `floor(now / bucketMs)`,
    // which bounds rows per CELL and places NO floor on the interval: two polls
    // straddling a boundary were both sampled even 1 ms apart. That re-admits,
    // at every grid edge, exactly the poll-frequency bias the interval exists to
    // remove — and it reads as a working sampler, because the common case
    // (two polls inside one cell) behaves identically either way.
    const bucketMs = DEFAULT_REFUSED_SAMPLER_CONFIG.bucketMs;
    // A timestamp 1 ms before a grid boundary.
    const justBefore = Math.ceil(T0 / bucketMs) * bucketMs - 1;
    const s = new RefusedCandidateSampler();
    const offer = (nowMs: number) =>
      s.offer({ admission: 'refused', optionSymbol: 'EDGE', etDay, nowMs, inFlightForPartition: 0 });

    expect(offer(justBefore)).toBe('sampled');
    // 2 ms later, across the boundary. A grid-keyed sampler says 'sampled'.
    expect(offer(justBefore + 2)).toBe('dropped_reobserve_interval');
    // Still inside the interval, well into the next cell.
    expect(offer(justBefore + bucketMs - 1)).toBe('dropped_reobserve_interval');
    // A full interval after the accepted sample.
    expect(offer(justBefore + bucketMs)).toBe('sampled');
  });

  it('does NOT let one contract starve another inside the same bucket', () => {
    const s = new RefusedCandidateSampler();
    for (const sym of ['A', 'B', 'C']) {
      expect(
        s.offer({ admission: 'refused', optionSymbol: sym, etDay, nowMs: T0, inFlightForPartition: 0 }),
      ).toBe('sampled');
    }
    expect(s.statsFor('refused').candidatesSampled).toBe(3);
  });

  it('⛔ reserves the admitted budget — a refused firehose can never evict it', () => {
    // The admitted partition grows at <=2/day and is currently 0/day. A shared
    // 200-slot arrival-order buffer would let 3,039 refusals/day starve the
    // only population that carries realised P&L.
    const s = new RefusedCandidateSampler();
    // Refused is full at its own ceiling…
    expect(
      s.offer({
        admission: 'refused', optionSymbol: 'R', etDay, nowMs: T0,
        inFlightForPartition: DEFAULT_REFUSED_SAMPLER_CONFIG.refusedSlots,
      }),
    ).toBe('dropped_for_budget');
    // …and the admitted partition is completely unaffected by that.
    expect(
      s.offer({ admission: 'admitted', optionSymbol: 'A', etDay, nowMs: T0, inFlightForPartition: 0 }),
    ).toBe('sampled');
    expect(s.slotsFor('admitted')).toBe(40);
    expect(s.slotsFor('refused')).toBe(160);
  });

  it('never applies stratification or the re-observe interval to an ADMITTED candidate', () => {
    // Those disciplines de-bias a 3,039/day firehose. Applied to a <=2/day
    // population they would discard most of the rows that carry realised P&L,
    // to fix a bias that population does not have.
    const s = new RefusedCandidateSampler({ ...DEFAULT_REFUSED_SAMPLER_CONFIG, keepRate: 0 });
    for (let i = 0; i < 5; i += 1) {
      expect(
        s.offer({ admission: 'admitted', optionSymbol: 'SAME', etDay, nowMs: T0, inFlightForPartition: 0 }),
      ).toBe('sampled');
    }
    // The same contract on the refused side is dropped by stratification.
    expect(
      s.offer({ admission: 'refused', optionSymbol: 'SAME', etDay, nowMs: T0, inFlightForPartition: 0 }),
    ).toBe('dropped_stratification');
  });

  it('stratifies DETERMINISTICALLY — the same key always decides the same way', () => {
    // Reproducible, and — unlike a PRNG — it cannot correlate with poll
    // cadence, which is exactly what arrival order is correlated with.
    const a = new RefusedCandidateSampler({ ...DEFAULT_REFUSED_SAMPLER_CONFIG, keepRate: 0.5 });
    const b = new RefusedCandidateSampler({ ...DEFAULT_REFUSED_SAMPLER_CONFIG, keepRate: 0.5 });
    const syms = Array.from({ length: 40 }, (_, i) => `SYM${i}`);
    const run = (s: RefusedCandidateSampler) =>
      syms.map((sym) =>
        s.offer({ admission: 'refused', optionSymbol: sym, etDay, nowMs: T0, inFlightForPartition: 0 }),
      );
    expect(run(a)).toEqual(run(b));
  });

  it('spreads a partial keepRate across the population rather than taking a prefix', () => {
    // The failure being excluded: an "every Nth arrival" sampler still keys on
    // arrival order. Assert the kept set is interior, not a prefix.
    const s = new RefusedCandidateSampler({ ...DEFAULT_REFUSED_SAMPLER_CONFIG, keepRate: 0.5 });
    const kept: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      if (
        s.offer({ admission: 'refused', optionSymbol: `S${i}`, etDay, nowMs: T0, inFlightForPartition: 0 })
        === 'sampled'
      ) kept.push(i);
    }
    expect(kept.length).toBeGreaterThan(60);
    expect(kept.length).toBeLessThan(140);
    // Kept indices reach both ends — not the first N arrivals.
    expect(Math.min(...kept)).toBeLessThan(20);
    expect(Math.max(...kept)).toBeGreaterThan(180);
  });

  it('counts every drop reason separately and reports a rate that is null, never 0, at n=0', () => {
    const s = new RefusedCandidateSampler();
    expect(s.statsFor('refused').samplingRate).toBeNull();
    s.offer({ admission: 'refused', optionSymbol: 'A', etDay, nowMs: T0, inFlightForPartition: 0 });
    s.offer({ admission: 'refused', optionSymbol: 'A', etDay, nowMs: T0, inFlightForPartition: 0 });
    const st = s.statsFor('refused');
    expect(st.candidatesSeen).toBe(2);
    expect(st.candidatesSampled).toBe(1);
    expect(st.droppedForReobserveInterval).toBe(1);
    expect(st.samplingRate).toBeCloseTo(0.5, 10);
  });

  it('hashes evenly enough that a keepRate is the rate it claims', () => {
    const keys = Array.from({ length: 5_000 }, (_, i) => `SYM${i}|2026-09-25|900`);
    const frac = keys.filter((k) => stratificationHash(k) / 0x1_0000_0000 < 0.25).length / keys.length;
    expect(frac).toBeGreaterThan(0.22);
    expect(frac).toBeLessThan(0.28);
  });
});

describe('TRA-4897 — the sampling counters ship LABELLED as since-boot', () => {
  beforeEach(() => resetRealFillSamplerForTests());

  it('publishes `samplingWindow` and `bootedAt` beside a DURABLE row count', () => {
    // A since-boot counter and a durable one render identically, and this desk
    // has been bitten by exactly that. The ledger is durable on a persistent
    // disk; these counters are not. Do not divide one by the other.
    const s = summarizeRealFillShadow([mkRow()], T0);
    expect(s.byAdmission.refused.sampling.samplingWindow).toBe('since_boot');
    expect(typeof s.byAdmission.refused.sampling.bootedAt).toBe('number');
    expect(s.byAdmission.admitted.sampling.slots).toBe(40);
    expect(s.byAdmission.refused.sampling.slots).toBe(160);
  });

  it('reflects the live process sampler rather than a recomputation', () => {
    realFillSampler().offer({
      admission: 'refused',
      optionSymbol: 'SPY_C1',
      etDay: '2026-09-25',
      nowMs: T0,
      inFlightForPartition: 0,
    });
    const s = summarizeRealFillShadow([], T0);
    expect(s.byAdmission.refused.sampling.candidatesSeen).toBe(1);
    expect(s.byAdmission.refused.sampling.candidatesSampled).toBe(1);
    // The admitted partition's counters are independent.
    expect(s.byAdmission.admitted.sampling.candidatesSeen).toBe(0);
    expect(s.byAdmission.admitted.sampling.samplingRate).toBeNull();
  });
});

describe('TRA-4897 — NEGATIVE CONTROLS (each must fail on the old code)', () => {
  it('a v1-shaped summary would fail every acceptance the ruling named', () => {
    const s = summarizeRealFillShadow([mkRow()], T0) as unknown as Record<string, unknown>;
    // The ruling's stated acceptance, verbatim:
    //   summary.schema === 'real_fill_shadow_v2' && summary.overall === undefined
    expect(s.schema).toBe('real_fill_shadow_v2');
    expect(s.overall).toBeUndefined();
  });

  it('a consumer keyed on a TOP-LEVEL schema cannot discriminate — proven, not asserted', () => {
    // Why the acceptance is written against `summary.schema`. The same faulty
    // predicate returns the SAME answer for both versions, so it is not a gate.
    const v2 = summarizeRealFillShadow([mkRow()], T0) as unknown as Record<string, unknown>;
    const fakeV1Payload: Record<string, unknown> = { summary: { schema: 'real_fill_shadow_v1' } };
    const faultyGate = (payload: Record<string, unknown>) => payload.schema !== 'real_fill_shadow_v2';
    expect(faultyGate(fakeV1Payload)).toBe(true);
    expect(faultyGate({ summary: v2 })).toBe(true); // identical verdict ⇒ blind
    // The correct keying separates them.
    const goodGate = (p: { summary?: { schema?: string } }) => p.summary?.schema === 'real_fill_shadow_v2';
    expect(goodGate({ summary: fakeV1Payload.summary as { schema: string } })).toBe(false);
    expect(goodGate({ summary: v2 as { schema: string } })).toBe(true);
  });

  it('the partition is exhaustive — every row lands in exactly one side', () => {
    const rows: RealFillShadowRow[] = [
      mkRow(),
      mkRow({ admission: 'refused', refusedAtGate: 'cost_bar' }),
      mkRow({ admission: undefined }),
    ];
    const s = summarizeRealFillShadow(rows, T0);
    expect(s.nAdmitted + s.nRefused).toBe(s.rows);
    expect(s.byAdmission.admitted.overall.n + s.byAdmission.refused.overall.n).toBe(rows.length);
    for (const a of ['admitted', 'refused'] as RealFillAdmission[]) {
      expect(s.byAdmission[a].admission).toBe(a);
    }
  });
});
