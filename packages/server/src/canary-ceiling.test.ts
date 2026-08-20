// TRA-3836 (parent TRA-3827) — the attended-canary ceiling, re-ratified by
// TRA-3870 (board, 2026-08-19): per-order $300 / aggregate $500.
//
// The controls here are chosen to CONTAIN what they detect (the recurring
// failure shape): the positive breach cases replay the actual 2026-08-17
// numbers ($272 and $419 orders, $691 aggregate on a $946.60 book), not
// synthetic round figures.
import { describe, expect, it } from 'vitest';
import {
  CANARY_AGGREGATE_DEFAULT_USD,
  CANARY_AGGREGATE_HARD_MAX_USD,
  CANARY_CEILING_DEFAULT_USD,
  CANARY_CEILING_HARD_MAX_USD,
  CANARY_CEILING_VAR,
  gradeCanaryCeiling,
  gradeCanaryCeilingHealth,
  resolveCanaryCeiling,
} from './canary-ceiling.js';

const pricedFlat = { usd: 0, rows: 0, unpricedRows: 0 };

describe('resolveCanaryCeiling', () => {
  it('unset env resolves the compiled $300/$500 defaults — the control is code-only armed', () => {
    const c = resolveCanaryCeiling({});
    expect(c).toEqual({ perOrderUsd: 300, aggregateUsd: 500, source: 'compiled_default' });
    expect(CANARY_CEILING_DEFAULT_USD).toBe(300);
    expect(CANARY_CEILING_HARD_MAX_USD).toBe(300);
    expect(CANARY_AGGREGATE_DEFAULT_USD).toBe(500);
    expect(CANARY_AGGREGATE_HARD_MAX_USD).toBe(500);
  });

  it('env may LOWER the ceiling (both scopes)', () => {
    const c = resolveCanaryCeiling({ [CANARY_CEILING_VAR]: '50' });
    expect(c).toEqual({ perOrderUsd: 50, aggregateUsd: 50, source: 'env' });
  });

  it('env between the hard maxes lowers only the aggregate', () => {
    const c = resolveCanaryCeiling({ [CANARY_CEILING_VAR]: '400' });
    expect(c).toEqual({ perOrderUsd: 300, aggregateUsd: 400, source: 'env' });
  });

  it('env above both hard maxes clamps DOWN to $300/$500 — no env value widens', () => {
    const c = resolveCanaryCeiling({ [CANARY_CEILING_VAR]: '750' });
    expect(c?.perOrderUsd).toBe(300);
    expect(c?.aggregateUsd).toBe(500);
  });

  it.each([
    ['malformed text', 'a hundred'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['negative', '-5'],
    ['NaN literal', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('%s resolves null (UNREADABLE, refuse-all) — never a fallback default', (_name, raw) => {
    expect(resolveCanaryCeiling({ [CANARY_CEILING_VAR]: raw })).toBeNull();
  });
});

describe('gradeCanaryCeiling', () => {
  const ceiling = resolveCanaryCeiling({})!;

  it('a $95 order on a flat book passes', () => {
    expect(gradeCanaryCeiling(95, pricedFlat, ceiling)).toEqual({ allowed: true });
  });

  it('an exactly-$300 order on a flat book passes (<=, not <)', () => {
    expect(gradeCanaryCeiling(300, pricedFlat, ceiling).allowed).toBe(true);
  });

  it('the first 2026-08-17 fill ($272) now passes per-order under the TRA-3870 $300 ratification', () => {
    expect(gradeCanaryCeiling(272, pricedFlat, ceiling).allowed).toBe(true);
  });

  it('POSITIVE CONTROL — the second 08-17 fill ($419) is still refused per-order', () => {
    const v = gradeCanaryCeiling(419, { usd: 272, rows: 1, unpricedRows: 0 }, ceiling);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_per_order');
  });

  it('POSITIVE CONTROL — the full 08-17 pair ($272 + $419 = $691) breaches the $500 aggregate even at a per-order cap it fits', () => {
    // Grade a hypothetical $419-sized order that FITS per-order ($280) against
    // the $272 already at risk: 272 + 280 = 552 > 500 ⇒ the aggregate arm rules.
    const v = gradeCanaryCeiling(280, { usd: 272, rows: 1, unpricedRows: 0 }, ceiling);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_aggregate');
  });

  it('a pair of per-order-fitting entries is caught by the AGGREGATE arm — why one cap alone is not enough', () => {
    const first = gradeCanaryCeiling(280, pricedFlat, ceiling);
    expect(first.allowed).toBe(true);
    const second = gradeCanaryCeiling(280, { usd: 280, rows: 1, unpricedRows: 0 }, ceiling);
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe('canary_ceiling_aggregate');
  });

  it('refuses when the ceiling is unreadable — null is REFUSE-ALL, never uncapped', () => {
    const v = gradeCanaryCeiling(10, pricedFlat, null);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_unreadable');
  });

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -50],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s order notional (TRA-3486 — !(x > 0) posture)', (_name, notional) => {
    const v = gradeCanaryCeiling(notional, pricedFlat, ceiling);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_per_order');
  });

  it('refuses while any open row is unpriced — an understated aggregate cannot be graded', () => {
    const v = gradeCanaryCeiling(10, { usd: 40, rows: 2, unpricedRows: 1 }, ceiling);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_unpriced_rows');
  });

  it('refuses a NaN at-risk figure rather than passing it', () => {
    const v = gradeCanaryCeiling(10, { usd: Number.NaN, rows: 1, unpricedRows: 0 }, ceiling);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('canary_ceiling_aggregate');
  });
});

describe('gradeCanaryCeilingHealth', () => {
  const admin0817 = {
    book: 'admin',
    liveEntryGateOpen: true,
    openPremiumAtRiskUsd: 691,
    unpricedOpenRows: 0,
  };

  it('POSITIVE CONTROL — the 08-17 book publishes a NEGATIVE residual and a breach verdict', () => {
    const h = gradeCanaryCeilingHealth([admin0817], {});
    expect(h.verdict).toBe('breach');
    expect(h.breachedBooks).toEqual(['admin']);
    // SIGNED: -$191 against the $500 aggregate, not the floored 0 that let
    // the 08-17 breach read as "within".
    expect(h.books?.[0]?.signedResidualUsd).toBe(-191);
  });

  it('a flat armed book reads within with the full $500 aggregate residual', () => {
    const h = gradeCanaryCeilingHealth(
      [{ book: 'v0nni', liveEntryGateOpen: true, openPremiumAtRiskUsd: 0, unpricedOpenRows: 0 }],
      {},
    );
    expect(h.verdict).toBe('within');
    expect(h.books?.[0]?.signedResidualUsd).toBe(500);
  });

  it('gate-closed books are excluded from the fold', () => {
    const h = gradeCanaryCeilingHealth(
      [{ ...admin0817, liveEntryGateOpen: false }],
      {},
    );
    expect(h.verdict).toBe('within');
    expect(h.books).toEqual([]);
  });

  it('an unwired provider publishes books: null and verdict blind — never within', () => {
    const h = gradeCanaryCeilingHealth(null, {});
    expect(h.books).toBeNull();
    expect(h.verdict).toBe('blind');
  });

  it('an unpriced row blinds that book residual and the verdict — understated is not within', () => {
    const h = gradeCanaryCeilingHealth(
      [{ book: 'admin', liveEntryGateOpen: true, openPremiumAtRiskUsd: 40, unpricedOpenRows: 2 }],
      {},
    );
    expect(h.books?.[0]?.signedResidualUsd).toBeNull();
    expect(h.verdict).toBe('blind');
  });

  it('an unreadable ceiling publishes refuse_all — the entry path is refusing, so nothing can breach', () => {
    const h = gradeCanaryCeilingHealth([admin0817], { [CANARY_CEILING_VAR]: 'garbage' });
    expect(h.resolved).toBeNull();
    expect(h.entryPathBehavior).toBe('refuse_all_unreadable');
    expect(h.verdict).toBe('refuse_all');
  });
});
