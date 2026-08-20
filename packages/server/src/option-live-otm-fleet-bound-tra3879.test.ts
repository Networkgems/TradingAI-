// TRA-3879 — the fleet bound stops being FITTED and becomes STRUCTURAL.
//
// TRA-3723 shipped a DETECTOR for `Σ_i B_i > A` and left the fail-open live;
// TRA-3737 gave that detector a reader. On 2026-08-20T03:12Z the reader was
// red on real money: `Σ B_i` $558.68 against a $500 authorization, φ 0.4858
// stale against fleet capital $1,150.04, OTM sleeve ARMED. Nobody deposited
// anything — `A` came DOWN (TRA-3827) and the basis drifted UP.
//
// This suite grades remedy (f): `φ_eff = min(φ, A / Σ E_i)`.
//
// ⭐ EVERY SCENARIO IS BUILT FROM THE SHIPPED RESOLVER AND THE CAPTURED LIVE
// PAYLOAD — never from literals typed into the test. That split is what made
// TRA-3723's control suite worth anything: against the shipped-BEFORE bytes the
// assertions that DEMONSTRATE the defect pass and the ones that DETECT it fail,
// so the file states the defect rather than restating arithmetic. The two
// `demonstrates the defect` tests below are written against the pre-fix call
// shape (`fleetCapitalUsd: null`, which IS the old bytes' behaviour, preserved
// deliberately as the no-fleet-read fallback) and they PASS in both builds.
//
// AC1 the deployed live read · AC2 structural, not fitted · AC3 the detector is
// not blinded · AC4 no book is darked without saying so.
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveLiveOptionTestBookAggregateCapUsd,
  resolveEffectiveFleetRiskFraction,
  sumLiveOtmFleetCapitalUsd,
  gradeLiveOtmFleetBound,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING,
  type LiveOtmFleetBoundRow,
  type LiveOtmFleetCapitalRow,
} from './option-exec-flag.js';
import {
  setLiveOtmFleetCapitalProvider,
  readLiveOtmFleetCapitalRows,
  isLiveOtmFleetCapitalProviderWired,
} from './live-otm-fleet-capital.js';

/**
 * The VERBATIM capture of the live breach (TRA-3737 shipped it as the reader's
 * positive control). Balances, `A` and φ all come from the money host on
 * 2026-08-20; nothing in this file re-types them.
 */
const CAPTURE = JSON.parse(
  readFileSync(
    new URL('../../../scripts/fixtures/tra3737-live-breach-2026-08-20.json', import.meta.url),
    'utf8',
  ),
) as {
  live: { build: { commitShort: string; startedAt: string } };
  fee: {
    aggregateCapUsd: number;
    fleetRiskFraction: number;
    aggregateExposure: Array<{
      book: string;
      liveEntryGateOpen: boolean;
      availableCashUsd: number | null;
      capUsd: number;
    }>;
  };
};

const A = CAPTURE.fee.aggregateCapUsd; // 500 — TRA-3827's tightened authorization
const PHI = CAPTURE.fee.fleetRiskFraction; // 0.4858 — φ as it was in force
const CAPTURED_ROWS = CAPTURE.fee.aggregateExposure;

/** The fleet-capital rows exactly as the cross-engine read publishes them. */
function capitalRows(
  balances: ReadonlyArray<{ book: string; availableCashUsd: number | null; open?: boolean }>,
): LiveOtmFleetCapitalRow[] {
  return balances.map(b => ({
    book: b.book,
    liveEntryGateOpen: b.open ?? true,
    availableCashUsd: b.availableCashUsd,
    // TRA-3897 — this file's fleet is FLAT by construction (it varies balances
    // only), and on a flat fleet the capital basis `cash + atRisk` reduces to
    // `cash` EXACTLY. Every claim below is therefore preserved verbatim across
    // the basis change; that is the strict-generalization proof, not a re-base.
    openPremiumAtRiskUsd: 0,
  }));
}

/** The captured live fleet, as balances. */
const LIVE_FLEET = CAPTURED_ROWS.map(r => ({
  book: r.book,
  availableCashUsd: r.availableCashUsd,
  open: r.liveEntryGateOpen,
}));

/**
 * `Σ B_i` over the gate-open books, with every `B_i` produced by the SHIPPED
 * resolver. `fleetBasis: 'per_book'` is the pre-TRA-3879 call shape.
 */
function sumBudgets(
  balances: ReadonlyArray<{ book: string; availableCashUsd: number | null; open?: boolean }>,
  fleetBasis: 'per_book' | 'fleet',
): number {
  const rows = capitalRows(balances);
  const fleetCapitalUsd =
    fleetBasis === 'fleet' ? sumLiveOtmFleetCapitalUsd(rows).fleetCapitalUsd : null;
  return (
    rows
      .filter(r => r.liveEntryGateOpen)
      .reduce(
        (acc, r) =>
          acc
          + Math.round(
            resolveLiveOptionTestBookAggregateCapUsd(
              r.availableCashUsd, r.openPremiumAtRiskUsd, A, PHI, fleetCapitalUsd,
            ) * 100,
          ),
        0,
      ) / 100
  );
}

/** The health route's row, budget from the shipped resolver. */
function boundRows(
  balances: ReadonlyArray<{ book: string; availableCashUsd: number | null; open?: boolean }>,
  fleetBasis: 'per_book' | 'fleet',
): LiveOtmFleetBoundRow[] {
  const rows = capitalRows(balances);
  const fleetCapitalUsd =
    fleetBasis === 'fleet' ? sumLiveOtmFleetCapitalUsd(rows).fleetCapitalUsd : null;
  return rows.map(r => ({
    book: r.book,
    liveEntryGateOpen: r.liveEntryGateOpen,
    availableCashUsd: r.availableCashUsd,
    capUsd: resolveLiveOptionTestBookAggregateCapUsd(
      r.availableCashUsd, r.openPremiumAtRiskUsd, A, PHI, fleetCapitalUsd,
    ),
  }));
}

afterEach(() => setLiveOtmFleetCapitalProvider(null));

describe('TRA-3879 AC2 — the bound is STRUCTURAL, not fitted', () => {
  it('DEMONSTRATES THE DEFECT: the shipped-before bytes admit $558.68 against a $500 authorization', () => {
    // Passes in BOTH builds — `fleetCapitalUsd: null` is the old behaviour,
    // kept as the no-fleet-read fallback. This is the incident, reproduced from
    // the captured balances through the shipped resolver.
    const sum = sumBudgets(LIVE_FLEET, 'per_book');
    expect(sum).toBeCloseTo(558.68, 2);
    expect(sum).toBeGreaterThan(A);
    // …and it matches the `capUsd` the live host actually published, so this is
    // the money path's own arithmetic and not a re-derivation of it.
    const published = CAPTURED_ROWS
      .filter(r => r.liveEntryGateOpen)
      .reduce((acc, r) => acc + Math.round(r.capUsd * 100), 0) / 100;
    expect(sum).toBe(published);
  });

  it('DETECTS IT: the shipped-after bytes refuse the same balances', () => {
    const sum = sumBudgets(LIVE_FLEET, 'fleet');
    expect(sum).toBeLessThanOrEqual(A);
    // Not by darking anything — it is within a cent of the full authorization.
    expect(sum).toBeGreaterThan(A - 0.05);
  });

  it('holds at balances that would have breached under any fitted φ', () => {
    // The deposit the parent filing predicted, the drift that actually
    // happened, an order-of-magnitude deposit, a new book joining the arm, and
    // a book that ran to zero. `min(…, A)` clears NONE of these on the sum.
    const scenarios: Array<[string, Array<{ book: string; availableCashUsd: number | null }>]> = [
      ['admin deposits to $2,000', [
        { book: 'admin', availableCashUsd: 2000 }, { book: 'v0nni', availableCashUsd: 400 },
      ]],
      ['the drift that happened', LIVE_FLEET.filter(b => b.open).map(
        b => ({ book: b.book, availableCashUsd: b.availableCashUsd }),
      )],
      ['both books 10x', [
        { book: 'admin', availableCashUsd: 7500.4 }, { book: 'v0nni', availableCashUsd: 4000 },
      ]],
      ['a THIRD book joins the arm', [
        { book: 'admin', availableCashUsd: 750.04 },
        { book: 'v0nni', availableCashUsd: 400 },
        { book: 'Richard', availableCashUsd: 5000 },
      ]],
      ['one book at zero, one enormous', [
        { book: 'admin', availableCashUsd: 0 }, { book: 'v0nni', availableCashUsd: 10_000_000 },
      ]],
      ['a book with no snapshot alongside a huge one', [
        { book: 'admin', availableCashUsd: null }, { book: 'v0nni', availableCashUsd: 250_000 },
      ]],
    ];
    for (const [name, fleet] of scenarios) {
      const before = sumBudgets(fleet, 'per_book');
      const after = sumBudgets(fleet, 'fleet');
      expect(after, `${name}: Σ B_i must fit A`).toBeLessThanOrEqual(A);
      expect(after, `${name}: tightening only`).toBeLessThanOrEqual(before);
    }
  });

  it('holds under a swept balance space — no scenario in the sweep breaches', () => {
    // Deterministic (a fixed LCG, never Math.random): a control that only fails
    // on some runs is a control nobody trusts.
    let seed = 3879;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const books = 1 + Math.floor(next() * 5);
      const fleet = Array.from({ length: books }, (_, i) => ({
        book: `book${i}`,
        availableCashUsd: Math.round(next() * 500_000 * 100) / 100,
      }));
      expect(sumBudgets(fleet, 'fleet')).toBeLessThanOrEqual(A);
    }
  });

  it('keeps every property TRA-3674 bought — per-book clamp, equal concentration, tightening only', () => {
    const fleet = [
      { book: 'admin', availableCashUsd: 2000 },
      { book: 'v0nni', availableCashUsd: 400 },
    ];
    const basis = sumLiveOtmFleetCapitalUsd(capitalRows(fleet)).fleetCapitalUsd;
    const budgets = fleet.map(
      b => resolveLiveOptionTestBookAggregateCapUsd(b.availableCashUsd, 0, A, PHI, basis),
    );
    for (const b of budgets) expect(b).toBeLessThanOrEqual(A); // min(…, A) survives
    // Same fraction of itself for every book — the concentration property.
    const fractions = budgets.map((b, i) => b / fleet[i].availableCashUsd);
    expect(Math.abs(fractions[0] - fractions[1])).toBeLessThan(1e-4);
    // Never larger than the pre-fix budget for the same book.
    fleet.forEach((b, i) => {
      expect(budgets[i]).toBeLessThanOrEqual(
        resolveLiveOptionTestBookAggregateCapUsd(b.availableCashUsd, 0, A, PHI, null),
      );
    });
  });

  it('φ still binds when the fleet is small — the fix is not a floor on exposure', () => {
    // Below the ceiling `A/φ` the derivation must NOT hand out more than φ.
    const small = [{ book: 'admin', availableCashUsd: 100 }, { book: 'v0nni', availableCashUsd: 50 }];
    const basis = sumLiveOtmFleetCapitalUsd(capitalRows(small)).fleetCapitalUsd;
    const sizing = resolveEffectiveFleetRiskFraction(PHI, A, basis, 2);
    expect(sizing.reason).toBe('phi_configured');
    expect(sizing.phiEffective).toBe(PHI);
    expect(sumBudgets(small, 'fleet')).toBe(sumBudgets(small, 'per_book'));
  });

  it('the SELF basis is folded in even when the fleet read cannot see this book', () => {
    // A read that misses the caller understates Σ E_i, which LOOSENS the bound.
    // The one failure this fold must not have is an optimistic one.
    const others = capitalRows([{ book: 'v0nni', availableCashUsd: 400 }]);
    const withSelf = sumLiveOtmFleetCapitalUsd(others, { book: 'admin', availableCashUsd: 750.04 });
    expect(withSelf.fleetCapitalUsd).toBeCloseTo(1150.04, 2);
    expect(withSelf.books).toBe(2);
    expect(withSelf.selfIncluded).toBe(true);
    // And a book already present is not double-counted.
    const both = capitalRows(LIVE_FLEET.filter(b => b.open).map(
      b => ({ book: b.book, availableCashUsd: b.availableCashUsd }),
    ));
    expect(
      sumLiveOtmFleetCapitalUsd(both, { book: 'admin', availableCashUsd: 750.04 }).fleetCapitalUsd,
    ).toBeCloseTo(1150.04, 2);
  });

  it('an empty fleet read is UNREADABLE, never zero capital', () => {
    // `Σ E_i = 0` would make `A / Σ E_i` infinite — unlimited headroom, the
    // exact fail-open shape this ticket closes.
    expect(sumLiveOtmFleetCapitalUsd([]).fleetCapitalUsd).toBeNull();
    expect(sumLiveOtmFleetCapitalUsd(null).fleetCapitalUsd).toBeNull();
    const sizing = resolveEffectiveFleetRiskFraction(PHI, A, null, 0);
    expect(Number.isFinite(sizing.phiEffective)).toBe(true);
    expect(sizing.phiEffective).toBeLessThanOrEqual(LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING);
  });
});

describe('TRA-3879 AC3 — the fix does not blind the detector', () => {
  it('the TRA-3723 grader still reads BREACH on the captured live rows', () => {
    // A fix that also removes the evidence is worse than the fail-open. The
    // rows here are the pre-fix bytes' own output, replayed.
    const grade = gradeLiveOtmFleetBound(boundRows(LIVE_FLEET, 'per_book'), A, PHI);
    expect(grade.verdict).toBe('breach');
    expect(grade.sumBookCapUsd).toBeCloseTo(558.68, 2);
    expect(grade.overageUsd).toBeCloseTo(58.68, 2);
  });

  it('and reads WITHIN on the post-fix rows — the 1 → 0 flip is the evidence', () => {
    const grade = gradeLiveOtmFleetBound(boundRows(LIVE_FLEET, 'fleet'), A, PHI);
    expect(grade.verdict).toBe('within');
    expect(grade.sumBookCapUsd).toBeLessThanOrEqual(A);
    // Coverage is unchanged — the fix must not shrink the graded population.
    expect(grade.gateOpenBooks).toBe(
      CAPTURED_ROWS.filter(r => r.liveEntryGateOpen).length,
    );
    expect(grade.unreadableBalanceBooks).toEqual([]);
  });

  it('a CONSTRUCTED breach against post-fix bytes is still detected', () => {
    // The detector grades whatever `capUsd` the rows carry. Any future path
    // that publishes an over-sum — a mis-wire, a re-point, a regression — is
    // still red. The detector is independent of how the budgets were made.
    const rows = boundRows(LIVE_FLEET, 'fleet').map(
      r => (r.liveEntryGateOpen ? { ...r, capUsd: r.capUsd * 2 } : r),
    );
    expect(gradeLiveOtmFleetBound(rows, A, PHI).verdict).toBe('breach');
  });
});

describe('TRA-3879 AC4 — no book is darked, and the fallback says so', () => {
  it('a book with a real balance NEVER sizes to 0 from a fleet read', () => {
    // The hazard that kept remedy (e) off the table: a missing declaration
    // darking a book silently, indistinguishable from "the market offered
    // nothing". (f) cannot produce it — φ_eff > 0 whenever A > 0.
    for (const basis of [null, 1150.04, 10_000, 10_000_000, 0, Number.NaN]) {
      const b = resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, A, PHI, basis as number | null);
      expect(b, `basis ${String(basis)}`).toBeGreaterThan(0);
    }
  });

  it('an unreadable fleet degrades to the PER-BOOK bound, byte for byte', () => {
    const sizing = resolveEffectiveFleetRiskFraction(PHI, A, null, 0);
    expect(sizing.reason).toBe('fleet_capital_unreadable');
    expect(sizing.phiEffective).toBe(PHI);
    expect(sizing.fleetCapitalUsd).toBeNull();
    // Identical to the bound in force before this ticket — the fallback is the
    // status quo, not a new posture.
    expect(resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, A, PHI, null))
      .toBe(Math.min(Math.floor(750.04 * PHI * 100) / 100, A));
  });

  it('the reason code DISCRIMINATES — three states, three values', () => {
    expect(resolveEffectiveFleetRiskFraction(PHI, A, 1150.04, 2).reason).toBe('phi_fleet_derived');
    expect(resolveEffectiveFleetRiskFraction(PHI, A, 150, 2).reason).toBe('phi_configured');
    expect(resolveEffectiveFleetRiskFraction(PHI, A, null, 0).reason).toBe('fleet_capital_unreadable');
    // A marker that fires on every verdict is boilerplate (TRA-3723).
  });

  it('φ_eff is published at full precision, not rounded to φ\'s four places', () => {
    // Rounding φ_eff UP at the 4th place is exactly what put the live fleet 11¢
    // past its own ceiling in the first place.
    const sizing = resolveEffectiveFleetRiskFraction(PHI, A, 1150.04, 2);
    expect(sizing.phiEffective).toBe(A / 1150.04);
    expect(sizing.phiEffective).toBeLessThan(PHI);
    expect(sizing.phiConfigured).toBe(PHI);
  });

  it('the unusable-input verdicts are unchanged — still fail CLOSED at 0', () => {
    for (const bad of [null, undefined, Number.NaN, -1]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(bad, 0, A, PHI, 1150.04)).toBe(0);
    }
    for (const badCap of [0, -1, Number.NaN]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, badCap, PHI, 1150.04)).toBe(0);
    }
    for (const badPhi of [0, -1, Number.NaN]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, A, badPhi, 1150.04)).toBe(0);
    }
  });
});

describe('TRA-3879 — the cross-engine READ itself', () => {
  it('unwired reads null, never [] — and "wired" is published, not inferred', () => {
    setLiveOtmFleetCapitalProvider(null);
    expect(isLiveOtmFleetCapitalProviderWired()).toBe(false);
    expect(readLiveOtmFleetCapitalRows()).toBeNull();
  });

  it('a THROWING provider is contained — it degrades, it does not abort an order path', () => {
    setLiveOtmFleetCapitalProvider(() => {
      throw new Error('engine registry exploded');
    });
    expect(isLiveOtmFleetCapitalProviderWired()).toBe(true);
    expect(readLiveOtmFleetCapitalRows()).toBeNull();
    // …and the degraded path is the per-book bound, not a dark book.
    const fleet = sumLiveOtmFleetCapitalUsd(readLiveOtmFleetCapitalRows(), {
      book: 'admin', availableCashUsd: 750.04,
    });
    expect(fleet.fleetCapitalUsd).toBe(750.04);
    expect(resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, A, PHI, fleet.fleetCapitalUsd))
      .toBe(resolveLiveOptionTestBookAggregateCapUsd(750.04, 0, A, PHI, null));
  });

  it('a wired provider is summed on liveEntryGateOpen, never on book count', () => {
    setLiveOtmFleetCapitalProvider(() => capitalRows([
      { book: 'admin', availableCashUsd: 750.04 },
      { book: 'v0nni', availableCashUsd: 400 },
      { book: 'Richard', availableCashUsd: 9_000, open: false }, // live MODE, not armed
    ]));
    const fleet = sumLiveOtmFleetCapitalUsd(readLiveOtmFleetCapitalRows(), {
      book: 'admin', availableCashUsd: 750.04,
    });
    expect(fleet.fleetCapitalUsd).toBeCloseTo(1150.04, 2);
    expect(fleet.books).toBe(2);
  });
});
