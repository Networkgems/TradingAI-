// TRA-4646 — the per-idea journal readout (AC1), the per-sleeve R-unit
// expectancy (AC2) and the debit-sleeve retirement scoring pass + before/after
// comparison (AC3).
import { describe, it, expect } from 'vitest';
import type { IdeaOutcome } from './options-forward-test.js';
import { LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import {
  applyDebitRetirement,
  buildDebitRetirementComparison,
  buildIdeaJournalReadout,
  buildSleeveExpectancy,
  JOURNAL_READOUT_MAX_LIMIT,
} from './options-ideas-journal-readout.js';
import { creditAtCeiling, debitWinner, sketchCapped } from './gate-sleeve-blocking-fixtures.js';

const rows = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

describe('applyDebitRetirement', () => {
  it('excludes DEBIT-entry rows as off_mandate_debit and leaves credit rows untouched', () => {
    const debit = debitWinner(0);
    const credit = creditAtCeiling(0);
    const [d, c] = applyDebitRetirement([debit, credit]);
    expect(d!.excluded).toBe(true);
    expect(d!.excludeReason).toBe('off_mandate_debit');
    expect(c).toBe(credit); // untouched, same reference
  });

  it('keeps a pre-existing hygiene exclusion reason instead of overwriting it', () => {
    const staleDebit = debitWinner(1, { excluded: true, excludeReason: 'stale_settlement' });
    const [out] = applyDebitRetirement([staleDebit]);
    expect(out!.excluded).toBe(true);
    expect(out!.excludeReason).toBe('stale_settlement');
  });

  it('retires OPEN debit rows too (forward scoring covers rows that resolve later)', () => {
    const openDebit = debitWinner(2, { status: 'open', win: null });
    const [out] = applyDebitRetirement([openDebit]);
    expect(out!.excluded).toBe(true);
    expect(out!.excludeReason).toBe('off_mandate_debit');
  });

  it('never retires an unknown-direction entry (entryNetUsd 0)', () => {
    const unknown = debitWinner(3, { entryNetUsd: 0 });
    const [out] = applyDebitRetirement([unknown]);
    expect(out!.excluded).toBe(false);
  });
});

describe('buildSleeveExpectancy (AC2 — the R-unit sleeve read)', () => {
  // Hand-computed: credit pnlNetR [0.5, 0.1, −0.3] → mean 0.1, sd 0.4, se 0.4/√3;
  // debit pnlNetR [−0.8, −0.6] → mean −0.7, sd √0.02 ≈ 0.1414, se 0.1.
  const credit = [
    creditAtCeiling(0, { pnlNetR: 0.5, pnlUsd: 10, win: true }),
    creditAtCeiling(1, { pnlNetR: 0.1, pnlUsd: 5, win: true }),
    creditAtCeiling(2, { pnlNetR: -0.3, pnlUsd: -5, win: false }),
  ];
  const debit = [
    debitWinner(0, { pnlNetR: -0.8, pnlUsd: -200, win: false }),
    debitWinner(1, { pnlNetR: -0.6, pnlUsd: -150, win: false }),
  ];

  it('publishes n / expectancyNetR / sd / se per sleeve, in R', () => {
    const s = buildSleeveExpectancy([...credit, ...debit]);
    expect(s.n).toBe(5);
    const creditStat = s.byPremiumDirection.find((x) => x.key === 'credit')!;
    expect(creditStat.n).toBe(3);
    expect(creditStat.expectancyNetR).toBeCloseTo(0.1, 6);
    expect(creditStat.sdNetR).toBeCloseTo(0.4, 6);
    expect(creditStat.seNetR).toBeCloseTo(0.4 / Math.sqrt(3), 4);
    const debitStat = s.byPremiumDirection.find((x) => x.key === 'debit')!;
    expect(debitStat.n).toBe(2);
    expect(debitStat.expectancyNetR).toBeCloseTo(-0.7, 6);
    expect(debitStat.sdNetR).toBeCloseTo(Math.sqrt(0.02), 4);
    expect(debitStat.seNetR).toBeCloseTo(0.1, 4);
    // Sleeves are ordered largest-n first.
    expect(s.byPremiumDirection[0]!.key).toBe('credit');
  });

  it('pooled reproduces the gate expectancyNetR fold over the same rows', () => {
    const s = buildSleeveExpectancy([...credit, ...debit]);
    const expected = (0.5 + 0.1 - 0.3 - 0.8 - 0.6) / 5;
    expect(s.pooled.expectancyNetR).toBeCloseTo(expected, 6);
  });

  it('keeps rows the retirement excluded (they are the evidence) but drops hygiene exclusions', () => {
    const retired = applyDebitRetirement([...credit, ...debit]);
    const withHygiene = [
      ...retired,
      creditAtCeiling(9, { excluded: true, excludeReason: 'cost_uneconomic' }),
      debitWinner(9, { status: 'open', win: null }),
    ];
    const s = buildSleeveExpectancy(withHygiene);
    // 3 credit + 2 retired debit; the cost_uneconomic row and the open row stay out.
    expect(s.n).toBe(5);
    expect(s.byPremiumDirection.find((x) => x.key === 'debit')!.n).toBe(2);
  });
});

describe('buildIdeaJournalReadout (AC1 — pagination that cannot truncate)', () => {
  const resolved = rows(10, (i) => creditAtCeiling(i));
  const open = rows(3, (i) => debitWinner(100 + i, { status: 'open' as const, win: null }));
  const all = [...resolved, ...open];

  it('serves the AC1 row shape, defaulting to resolved rows', () => {
    const r = buildIdeaJournalReadout(all);
    expect(r.statusFilter).toBe('resolved');
    expect(r.total).toBe(10);
    const row = r.rows[0]!;
    expect(row.ideaId).toBe('crd-0');
    expect(row.structure).toBe('bull_put_spread');
    expect(row.premiumDirection).toBe('credit');
    expect(row.resolvedAt).toBe('2026-02-20');
    expect(row.outcome).toBe('win');
    expect(row.statedPop).toBe(0.95);
    expect(typeof row.pnlR).toBe('number');
    expect(typeof row.pnlNetR).toBe('number');
    expect(typeof row.costsUsd).toBe('number');
    expect(typeof row.maxLossUsd).toBe('number');
  });

  it('pages from the START: page k is rows [offset, offset+limit) and the union is the full set', () => {
    const page = (offset: number) => buildIdeaJournalReadout(all, { offset, limit: 4 });
    const p0 = page(0);
    const p1 = page(4);
    const p2 = page(8);
    expect(p0.rows.map((r) => r.ideaId)).toEqual(['crd-0', 'crd-1', 'crd-2', 'crd-3']);
    expect(p1.rows.map((r) => r.ideaId)).toEqual(['crd-4', 'crd-5', 'crd-6', 'crd-7']);
    expect(p2.rows.map((r) => r.ideaId)).toEqual(['crd-8', 'crd-9']);
    // The TRA-4607 property: `total` is offset-independent, and the union of
    // pages IS the filtered set — a larger offset can never be a strict subset
    // of offset=0's tail.
    expect([p0.total, p1.total, p2.total]).toEqual([10, 10, 10]);
    const union = [...p0.rows, ...p1.rows, ...p2.rows].map((r) => r.ideaId);
    expect(union).toEqual(buildIdeaJournalReadout(all, { limit: 1000 }).rows.map((r) => r.ideaId));
  });

  it('clamps malformed offset/limit instead of erroring, and reports past-the-end honestly', () => {
    expect(buildIdeaJournalReadout(all, { offset: -5 }).offset).toBe(0);
    expect(buildIdeaJournalReadout(all, { limit: 0 }).limit).toBe(1);
    expect(buildIdeaJournalReadout(all, { limit: 10_000 }).limit).toBe(JOURNAL_READOUT_MAX_LIMIT);
    expect(buildIdeaJournalReadout(all, { offset: Number.NaN, limit: Number.NaN }).rows.length).toBe(10);
    const past = buildIdeaJournalReadout(all, { offset: 50 });
    expect(past.rows).toEqual([]);
    expect(past.returned).toBe(0);
    expect(past.total).toBe(10);
  });

  it('filters by status: all / open', () => {
    expect(buildIdeaJournalReadout(all, { status: 'all' }).total).toBe(13);
    const openOnly = buildIdeaJournalReadout(all, { status: 'open' });
    expect(openOnly.total).toBe(3);
    expect(openOnly.rows.every((r) => r.status === 'open' && r.resolvedAt === null)).toBe(true);
    expect(openOnly.rows.every((r) => r.outcome === null)).toBe(true);
  });
});

describe('buildDebitRetirementComparison (AC3 — before/after, readable in both flag states)', () => {
  // A book shaped like the live one: a big credit sleeve, a losing debit sleeve,
  // and one sketch-capped long_call (the fabricated-reward row).
  const book: IdeaOutcome[] = [
    ...rows(35, (i) => creditAtCeiling(i, { pnlNetR: 0.05, pnlUsd: 10, win: true })),
    ...rows(14, (i) => debitWinner(i, { pnlNetR: -0.8, pnlUsd: -200, win: false })),
    sketchCapped(0, { pnlNetR: -0.3, pnlUsd: -90, win: false }),
  ];

  it('scores before on all structures and after credit-only, and counts the retired rows', () => {
    const cmp = buildDebitRetirementComparison(book, LIVE_CAPITAL_GATE, false);
    expect(cmp.before.resolved).toBe(50);
    expect(cmp.after.resolved).toBe(35);
    expect(cmp.resolvedRetired).toBe(15);
    expect(cmp.enabled).toBe(false);
    expect(cmp.scoringBasis).toBe('all_structures');
    // The lone sketch-capped reward row is a debit long_call, so retiring the
    // sleeve also cleans the ceiling provenance — the exact move the ticket's
    // `sketch_capped 1 → 0` expectation describes.
    expect(cmp.before.ceilingSources.sketch_capped).toBe(1);
    expect(cmp.after.ceilingSources.sketch_capped).toBe(0);
    // Removing an all-losing sleeve moves the cost-net expectancy up.
    expect(cmp.after.expectancyNetR!).toBeGreaterThan(cmp.before.expectancyNetR!);
    // Both snapshots publish the power figures AC3 asks for.
    for (const snap of [cmp.before, cmp.after]) {
      expect(typeof snap.sigmaUsed).toBe('number');
      expect(typeof snap.nRequired).toBe('number');
      expect(typeof snap.feasibilityVerdict).toBe('string');
    }
    // A mixed book carries more cost-net variance than the credit sleeve alone,
    // so the credit-only requirement must not exceed the mixed one.
    expect(cmp.after.nRequired!).toBeLessThanOrEqual(cmp.before.nRequired!);
  });

  it('names the credit_only scoring basis when the flag is armed', () => {
    const cmp = buildDebitRetirementComparison(book, LIVE_CAPITAL_GATE, true);
    expect(cmp.enabled).toBe(true);
    expect(cmp.scoringBasis).toBe('credit_only');
    expect(cmp.flag).toBe('ENABLE_OPTIONS_DEBIT_SLEEVE_RETIREMENT');
  });
});
