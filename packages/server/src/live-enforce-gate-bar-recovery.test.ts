// TRA-4745 (2026-09-20 follow-up) — RECOVERING THE BAR THAT ACTUALLY BLOCKED.
//
// QuantTrader graded the first TRA-4745 build on the live route and raised two
// things this suite exists to answer (comment `ab8574c7`, pin
// `aba0b5bc9403bab4b471cb5a415f1e02fd2824bd`):
//
//   1. The per-row `predicate` stamp is EMPTY, not sparse — `predicateUnstamped`
//      9558 of 9558. It can only ever describe rows written after its own
//      deploy, so the question the ticket was cut to answer stays unanswerable
//      off the retained fold for a month.
//   2. `single_leg_otm::0.50-0.55` records grossR ∈ [0.428045, 0.658764] — its
//      ENTIRE distribution above `barR` 0.385 — yet 1627 of its 4159 rows are
//      recorded BLOCKED. Under `admit ⟺ grossR ≥ barR` that is impossible at a
//      constant bar, and the route could not separate "the quantiles were
//      back-filled from the current estimator" from "the bar was higher then".
//
// Both are the same missing fact: the payload publishes TODAY's bar as a scalar
// beside a 30-day fold. `impliedBarR` recovers the bar AS APPLIED from rows the
// ledger has held since TRA-3483, by inverting `reasonCode` — a bounded function
// of `barR − grossR` — over the `grossR` recorded on the same row.
//
// The fixtures below are the live cell-days, from `byEtDay` on pin
// `c59631663914b0ab9df662789961d67d23eb8216`, read 2026-09-20T05:56:15Z.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  hydrateLiveEnforceGateFromDisk,
} from './live-enforce-gate-ledger.js';
import { impliedBarR } from './live-enforce-gate-predicate.js';

const CELL = 'single_leg_otm::0.50-0.55';
const RV_CELL = 'single_leg_rv::0.55-1.00';
/** The bar the live route publishes today. The SUBJECT of every grade here. */
const PUBLISHED_BAR = 0.385;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra4745-bar-recovery-'));
  clearLiveEnforceGateLedger();
  hydrateLiveEnforceGateFromDisk(dir, 1_000);
});
afterEach(() => {
  clearLiveEnforceGateLedger();
  rmSync(dir, { recursive: true, force: true });
});

function row(opts: {
  day: string;
  cell: string;
  structure?: string;
  grossR: number | null;
  blocked: boolean;
  reasonCode?: string;
  ts: number;
}) {
  recordLiveEnforceDecision(
    'cost_bar',
    opts.structure ?? 'single_leg_otm',
    opts.blocked,
    opts.day,
    opts.blocked ? 'blocked' : undefined,
    opts.ts,
    {
      reasonCode: opts.reasonCode,
      cell: opts.cell,
      grossR: opts.grossR ?? undefined,
      cost: { costR: 0.3, spreadR: 0.29, feeR: 0.01, costFracOfPremium: 0.1 },
    },
  );
}

function dayCell(day: string, cell: string) {
  const summary = summarizeLiveEnforceGate(day, { flatFormBarR: PUBLISHED_BAR });
  const gate = summary.retained.byGate.find((g) => g.gate === 'cost_bar')!;
  return gate.byEtDay.find((d) => d.etDay === day)!.byCell.find((c) => c.cell === cell)!;
}

function pooledCell(anyDay: string, cell: string) {
  const summary = summarizeLiveEnforceGate(anyDay, { flatFormBarR: PUBLISHED_BAR });
  const gate = summary.retained.byGate.find((g) => g.gate === 'cost_bar')!;
  return gate.byCell.find((c) => c.cell === cell)!;
}

describe('TRA-4745 — the bar as applied, recovered from already-recorded rows', () => {
  it('recovers a two-sided bound from one blocked row, and it EXCLUDES the published bar', () => {
    // The live `0.50-0.55` shape: recorded edge 0.428045, recorded block, and
    // the `shortfall_lt_0.10` bucket. barR ∈ [grossR, grossR + 0.10).
    const got = impliedBarR(
      [{ grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10' }],
      PUBLISHED_BAR,
    );
    expect(got).not.toBeNull();
    expect(got!.lowerBound).toBeCloseTo(0.428045, 6);
    expect(got!.upperBound).toBeCloseTo(0.528045, 6);
    expect(got!.consistent).toBe(true);
    expect(got!.rowsBlockedUsed).toBe(1);
    // THE FINDING: 0.385 is not in [0.428045, 0.528045]. This row was not
    // decided against the bar the payload advertises.
    expect(got!.excludesPublishedBarR).toBe(true);
    expect(got!.publishedBarR).toBe(PUBLISHED_BAR);
  });

  it('the live rv cell reconciles at the published bar — so no separate rv bar is implied', () => {
    // `single_leg_rv::0.55-1.00`: grossR −0.051113, 633/633 blocked, every one
    // in `shortfall_0.25_0.50`. barR ∈ [0.198887, 0.448887], which CONTAINS
    // 0.385. QuantTrader asked which bar charges the rv rows; the recovered
    // interval says it is the same one, and `admissionBarR` is structure-keyed
    // only through the equity/option split, so there is no rv-specific bar to
    // publish.
    const got = impliedBarR(
      [{ grossR: -0.051113, blocked: true, reasonCode: 'shortfall_0.25_0.50' }],
      PUBLISHED_BAR,
    );
    expect(got!.lowerBound).toBeCloseTo(0.198887, 6);
    expect(got!.upperBound).toBeCloseTo(0.448887, 6);
    expect(got!.excludesPublishedBarR).toBe(false);
  });

  it('ADMITS bound the bar from above — an admitted row proves barR <= its grossR', () => {
    const got = impliedBarR([{ grossR: 0.42, blocked: false, reasonCode: null }], PUBLISHED_BAR);
    expect(got!.lowerBound).toBeNull();
    expect(got!.upperBound).toBeCloseTo(0.42, 6);
    expect(got!.rowsAdmittedUsed).toBe(1);
    // ⭐ TRA-4941 — the bound above is still RECOVERED and still published; what
    // changed is that it no longer produces a VERDICT. Nothing here bounded the
    // bar from below, so the interval is half-open and must not grade a published
    // scalar in EITHER direction. This assertion used to read `false`.
    expect(got!.consistentReason).toBe('one_sided_sample');
    expect(got!.consistent).toBeNull();
    expect(got!.excludesPublishedBarR).toBeNull();
  });

  // ⭐ TRA-4941 — the incident, as a unit. The 2026-09-25 / `0.30-0.40` shape:
  // admits only, no blocked row, and a published bar far ABOVE the recovered
  // upper bound. The old code rendered `consistent: true` +
  // `excludesPublishedBarR: true` off this — "the live bar is not 0.385" —
  // because `lower === null` made `lower <= upper` vacuously true.
  it('TRA-4941 — a HALF-OPEN interval must not refute the published bar', () => {
    const got = impliedBarR(
      Array.from({ length: 111 }, () => ({
        grossR: -0.215375,
        blocked: false,
        reasonCode: null,
      })),
      PUBLISHED_BAR,
    );
    expect(got!.rowsAdmittedUsed).toBe(111);
    expect(got!.rowsBlockedUsed).toBe(0);
    expect(got!.lowerBound).toBeNull();
    expect(got!.upperBound).toBeCloseTo(-0.215375, 6);
    // The published bar 0.385 IS numerically outside `barR <= -0.215375`. The
    // refusal is not about the arithmetic — it is that one side of the
    // comparison was never tested here, so the interval is not evidence.
    expect(got!.consistentReason).toBe('one_sided_sample');
    expect(got!.consistent).toBeNull();
    expect(got!.excludesPublishedBarR).toBeNull();
  });

  // The negative control for the assertion above: the guard must NOT fire on a
  // two-sided interval, or it would have suppressed TRA-4745's whole finding.
  it('TRA-4941 — ONE blocked row in a bounded bucket is still two-sided and still grades', () => {
    const got = impliedBarR(
      [{ grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10' }],
      PUBLISHED_BAR,
    );
    expect(got!.rowsAdmittedUsed).toBe(0);
    expect(got!.consistentReason).toBe('two_sided');
    expect(got!.consistent).toBe(true);
    expect(got!.excludesPublishedBarR).toBe(true);
  });

  it('an EMPTY intersection is a RESULT: consistent=false says the bar moved mid-group', () => {
    // Two rows that cannot both have faced one bar: one demands barR >= 0.90,
    // the other proves barR <= 0.20.
    const got = impliedBarR(
      [
        { grossR: 0.9, blocked: true, reasonCode: 'shortfall_lt_0.10' },
        { grossR: 0.2, blocked: false, reasonCode: null },
      ],
      PUBLISHED_BAR,
    );
    expect(got!.consistent).toBe(false);
    // An empty interval excludes EVERYTHING, so reporting `true` here would be a
    // false positive dressed as a finding. It must abstain.
    expect(got!.excludesPublishedBarR).toBeNull();
  });

  it('pre-comparison refusals constrain NOTHING — they are unusable, not evidence', () => {
    // These three branches refuse before any inequality runs. Folding them in
    // would manufacture a bound out of rows that never met a bar.
    for (const code of ['insufficient_evidence', 'band_deauthorized', 'gross_unknown']) {
      const got = impliedBarR(
        [{ grossR: 0.5, blocked: true, reasonCode: code }],
        PUBLISHED_BAR,
      );
      // No usable row at all ⇒ null, never a default interval.
      expect(got, code).toBeNull();
    }
  });

  it('a row with no recorded grossR is COVERAGE, counted, never silently dropped', () => {
    const got = impliedBarR(
      [
        { grossR: null, blocked: true, reasonCode: 'shortfall_lt_0.10' },
        { grossR: 0.5, blocked: false, reasonCode: null },
      ],
      PUBLISHED_BAR,
    );
    expect(got!.rowsUnusable).toBe(1);
    expect(got!.rowsAdmittedUsed).toBe(1);
  });

  it('grades nothing when there is no published bar to grade', () => {
    const got = impliedBarR([{ grossR: 0.5, blocked: false, reasonCode: null }], null);
    expect(got!.publishedBarR).toBeNull();
    expect(got!.excludesPublishedBarR).toBeNull();
  });
});

describe('TRA-4745 — the per-day cell edge axis separates recorded from back-filled', () => {
  it('a cell whose bound MOVES day to day can only have been recorded at the decision', () => {
    // The live `0.50-0.55` roll, compressed: 08-21 admitted at a high bound,
    // 08-26 blocked at a lower one. Two different values ⇒ not a back-fill.
    row({ day: '2026-08-21', cell: CELL, grossR: 0.658764, blocked: false, ts: 1 });
    row({ day: '2026-08-26', cell: CELL, grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10', ts: 2 });

    const d21 = dayCell('2026-08-21', CELL);
    const d26 = dayCell('2026-08-26', CELL);
    expect(d21.grossR!.distinct).toBe(1);
    expect(d26.grossR!.distinct).toBe(1);
    // The discriminator QuantTrader asked for as a `grossRSource` enum. An enum
    // would have been our assertion; this is the evidence, and it is falsifiable
    // in the direction that matters — a back-fill CANNOT produce two values.
    expect(d21.grossR!.min).not.toBe(d26.grossR!.min);

    // And neither day CONFLICTS with itself — but TRA-4941: say that with the
    // basis attached. 08-21 holds one ADMITTED row, so its interval is half-open
    // (`barR <= 0.658764`) and it grades nothing; 08-26 holds one blocked row in
    // a bounded bucket, which closes both ends and does grade.
    expect(d21.barRImplied!.consistentReason).toBe('one_sided_sample');
    expect(d21.barRImplied!.consistent).toBeNull();
    expect(d26.barRImplied!.consistentReason).toBe('two_sided');
    expect(d26.barRImplied!.consistent).toBe(true);
    expect(d26.barRImplied!.lowerBound).toBeCloseTo(0.428045, 6);
  });

  it('the POOLED cell reads inconsistent while every DAY reads consistent — which is the whole point', () => {
    // 08-21: admitted at 0.658764 ⇒ barR <= 0.658764.
    // 08-26: blocked at 0.428045 in `shortfall_lt_0.10` ⇒ barR >= 0.428045.
    // Those two are compatible, so make the conflict explicit the way the live
    // fold does: a LATER day admits BELOW what an earlier day blocked at.
    row({ day: '2026-08-26', cell: CELL, grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10', ts: 1 });
    row({ day: '2026-09-01', cell: CELL, grossR: 0.40, blocked: false, ts: 2 });

    const d0826 = dayCell('2026-08-26', CELL);
    const d0901 = dayCell('2026-09-01', CELL);
    expect(d0826.barRImplied!.consistent).toBe(true);
    // TRA-4941 — 09-01 holds ONE admitted row, so it is half-open and grades
    // nothing. It used to read `consistent: true`, which is the vacuous `true`
    // this ticket removed. (It was never the same claim as 08-26's.)
    expect(d0901.barRImplied!.consistentReason).toBe('one_sided_sample');
    expect(d0901.barRImplied!.consistent).toBeNull();

    const pooled = pooledCell('2026-09-01', CELL);
    // barR >= 0.428045 (from 08-26) AND barR <= 0.40 (from 09-01) is empty.
    expect(pooled.barRImplied!.consistent).toBe(false);
    expect(pooled.barRImplied!.consistentReason).toBe('two_sided');
    // This is the fact no other field on the payload can state: these rows did
    // not all face one bar, so the published scalar describes neither of them.
    expect(pooled.barRImplied!.excludesPublishedBarR).toBeNull();

    // ⭐ TRA-4941 DEFECT 2 ask 2 — the day-vs-window disagreement, IN BAND. A
    // reader of the 08-26 day row alone sees `consistent: true` and would publish
    // it; the scope check on that same row says the whole-window fold for this
    // cell disagrees, and that the window is the scope that wins.
    const check = d0826.barRImpliedScopeCheck!;
    expect(check.dayConsistent).toBe(true);
    expect(check.windowConsistent).toBe(false);
    expect(check.disagrees).toBe(true);
    expect(check.authoritativeScope).toBe('window');
    // The disagreement is published, NOT resolved: the day row still carries its
    // own verdict verbatim beside it.
    expect(d0826.barRImplied!.consistent).toBe(true);
  });

  // ⭐ TRA-4941 DEFECT 2 ACCEPTANCE — the live 2026-09-25 / `0.30-0.40` read,
  // reproduced end to end through the fold (not just the pure function).
  //
  // Day-scoped: `rowsAdmittedUsed` 111, `rowsBlockedUsed` 0, `upperBound`
  // -0.215375 ⇒ the old build published `consistent: true` +
  // `excludesPublishedBarR: true`, i.e. "the published bar 0.385 is REFUTED".
  // Whole-window, same cell: `lowerBound` 0.284625 > `upperBound` -0.215375 ⇒
  // `consistent: false`. The contradicting evidence lived ONLY outside the day.
  it('TRA-4941 ACCEPTANCE — the 09-25 cell abstains day-scoped AND publishes the scope disagreement', () => {
    const C = 'single_leg_otm::0.30-0.40';
    // The day's 111 admits, all at the same recorded edge.
    for (let i = 0; i < 111; i += 1) {
      row({ day: '2026-09-25', cell: C, grossR: -0.215375, blocked: false, ts: 1_000 + i });
    }
    // The contradicting evidence, OUTSIDE the day: a blocked row demanding
    // barR >= 0.284625. Present in the window fold, absent from 09-25.
    row({
      day: '2026-09-22',
      cell: C,
      grossR: 0.284625,
      blocked: true,
      reasonCode: 'shortfall_lt_0.10',
      ts: 900,
    });

    const day = dayCell('2026-09-25', C);
    expect(day.barRImplied!.rowsAdmittedUsed).toBe(111);
    expect(day.barRImplied!.rowsBlockedUsed).toBe(0);
    expect(day.barRImplied!.upperBound).toBeCloseTo(-0.215375, 6);
    expect(day.barRImplied!.lowerBound).toBeNull();
    // ACCEPTANCE 1 — `consistent: null` with a reason, never `true`, and no
    // verdict against the published bar off one side of the comparison.
    expect(day.barRImplied!.consistentReason).toBe('one_sided_sample');
    expect(day.barRImplied!.consistent).toBeNull();
    expect(day.barRImplied!.excludesPublishedBarR).toBeNull();

    // The window fold, for the same cell, reaches the opposite verdict.
    const pooled = pooledCell('2026-09-25', C);
    expect(pooled.barRImplied!.lowerBound).toBeCloseTo(0.284625, 6);
    expect(pooled.barRImplied!.upperBound).toBeCloseTo(-0.215375, 6);
    expect(pooled.barRImplied!.consistent).toBe(false);

    // ACCEPTANCE 2 — the disagreement is visible WITHOUT the reader holding both
    // payloads side by side: it is a field on the day row itself.
    const check = day.barRImpliedScopeCheck!;
    expect(check.dayConsistent).toBeNull();
    expect(check.dayConsistentReason).toBe('one_sided_sample');
    expect(check.windowConsistent).toBe(false);
    expect(check.windowConsistentReason).toBe('two_sided');
    expect(check.disagrees).toBe(true);
    // ⛔ Not resolved silently in either direction — the wider scope is NAMED as
    // the one that wins, and the day's own verdict is still published verbatim.
    expect(check.authoritativeScope).toBe('window');
  });

  // The negative control for the scope check: when the two scopes AGREE it must
  // read `false`, not `true`, or the field is a constant rather than a detector.
  it('TRA-4941 — agreeing scopes read disagrees:false, and an absent window scope reads null', () => {
    const C = 'single_leg_otm::0.30-0.40';
    // One blocked row, one day. Day fold and window fold see the same rows, so
    // every column matches.
    row({
      day: '2026-09-25',
      cell: C,
      grossR: 0.428045,
      blocked: true,
      reasonCode: 'shortfall_lt_0.10',
      ts: 1,
    });
    const check = dayCell('2026-09-25', C).barRImpliedScopeCheck!;
    expect(check.dayConsistent).toBe(true);
    expect(check.windowConsistent).toBe(true);
    expect(check.dayExcludesPublishedBarR).toBe(true);
    expect(check.windowExcludesPublishedBarR).toBe(true);
    expect(check.disagrees).toBe(false);
  });

  it('a cell-day that re-folds mid-session publishes distinct > 1 — the only way a day lands strictly between', () => {
    // The live 2026-08-28 shape on this cell: 168 of 387 blocked = 43.4%, which
    // a constant predicate cannot produce. Two bounds inside one day can.
    row({ day: '2026-08-28', cell: CELL, grossR: 0.37, blocked: true, reasonCode: 'shortfall_lt_0.10', ts: 1 });
    row({ day: '2026-08-28', cell: CELL, grossR: 0.42, blocked: false, ts: 2 });

    const d = dayCell('2026-08-28', CELL);
    expect(d.blockRate).toBeCloseTo(0.5, 4);
    expect(d.grossR!.distinct).toBe(2);
    expect(d.grossR!.min).toBeCloseTo(0.37, 6);
    expect(d.grossR!.max).toBeCloseTo(0.42, 6);
    // And the bar is pinned tightly by the pair: [0.37, 0.42].
    expect(d.barRImplied!.lowerBound).toBeCloseTo(0.37, 6);
    expect(d.barRImplied!.upperBound).toBeCloseTo(0.42, 6);
    expect(d.barRImplied!.consistent).toBe(true);
    expect(d.barRImplied!.excludesPublishedBarR).toBe(false);
  });

  it('a cell-day of pure pre-comparison refusals publishes no bound and no edge', () => {
    row({
      day: '2026-09-11',
      cell: RV_CELL,
      structure: 'single_leg_rv',
      grossR: null,
      blocked: true,
      reasonCode: 'insufficient_evidence',
      ts: 1,
    });
    const d = dayCell('2026-09-11', RV_CELL);
    expect(d.blocked).toBe(1);
    // 100% blocked with NOTHING recovered: neither a cost problem nor an edge
    // collapse, and no bar move can reach it.
    expect(d.grossR).toBeNull();
    expect(d.barRImplied).toBeNull();
  });

  it('the day roll still sums to the pooled fold — the new axes add no double count', () => {
    row({ day: '2026-08-26', cell: CELL, grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10', ts: 1 });
    row({ day: '2026-08-26', cell: CELL, grossR: 0.428045, blocked: true, reasonCode: 'shortfall_lt_0.10', ts: 2 });
    row({ day: '2026-09-01', cell: CELL, grossR: 0.40, blocked: false, ts: 3 });

    const gate = summarizeLiveEnforceGate('2026-09-01', { flatFormBarR: PUBLISHED_BAR }).retained.byGate.find(
      (g) => g.gate === 'cost_bar',
    )!;
    const summed = gate.byEtDay.reduce((a, d) => a + d.evaluated, 0);
    expect(summed).toBe(gate.evaluated);
    expect(gate.evaluated).toBe(3);
  });
});
