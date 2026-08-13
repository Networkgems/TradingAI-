import { describe, it, expect } from 'vitest';
import {
  foldMarketableMtmDemoJournalBasis,
  demoJournalSide,
  classifyAccount,
  type MarketableMtmDemoJournalRow,
} from './marketable-mtm-demo-journal-basis.js';
import { MODELED_H_CALIBRATION } from './marketable-mtm-forward-validation.js';

// TRA-3502 Task 2 — the demo-journal basis: forward cohort, in-sample REFUSAL,
// mean/median/p90 per structure × account class.

const CAL_FROM = Date.parse(MODELED_H_CALIBRATION.windowUtc.from);
const CAL_TO = Date.parse(MODELED_H_CALIBRATION.windowUtc.to);
const DAY = 86_400_000;

/** A quote-bearing forward row. `bid`/`ask` straddle `mark`, so h = (mark−bid)/mark. */
function row(over: Partial<MarketableMtmDemoJournalRow> = {}): MarketableMtmDemoJournalRow {
  return {
    structure: 'single_leg',
    account: 'trader1',
    openTs: CAL_TO + DAY,
    entryBid: 1.25,
    entryAsk: 1.40,
    entryMarkUsd: 1.325,
    ...over,
  };
}

const isTestAccount = (u: string) => /^(qa|ctoverify)/i.test(u);

describe('in-sample refusal (TRA-3502 Task 2 — rejected by construction)', () => {
  it('REFUSES a cohort that starts inside the calibration window, and emits no moments', () => {
    const out = foldMarketableMtmDemoJournalBasis([row()], {
      cohortFromTsExclusive: CAL_FROM + DAY,
      isTestAccount,
    });
    expect(out.refusal?.code).toBe('IN_SAMPLE_COHORT');
    // The point of refusing rather than warning: there is NOTHING here to grade.
    expect(out.pooled).toBeNull();
    expect(out.cells).toEqual([]);
    expect(out.refusal?.reason).toContain(MODELED_H_CALIBRATION.windowUtc.to);
  });

  it('REFUSES a cohort starting before the window too — not just inside it', () => {
    const out = foldMarketableMtmDemoJournalBasis([row()], {
      cohortFromTsExclusive: CAL_FROM - DAY,
      isTestAccount,
    });
    expect(out.refusal?.code).toBe('IN_SAMPLE_COHORT');
    expect(out.pooled).toBeNull();
  });

  it('does NOT clamp a bad cohort forward to a safe one — a silent widening would hide the ask', () => {
    const out = foldMarketableMtmDemoJournalBasis([row()], {
      cohortFromTsExclusive: CAL_TO - 1,
      isTestAccount,
    });
    // One millisecond inside the window is still inside it.
    expect(out.refusal).not.toBeNull();
    expect(out.cohort.fromTsExclusive).toBe(CAL_TO - 1); // echoed as ASKED, not as applied
  });

  it('defaults the cohort to the calibration close and grades forward rows', () => {
    const out = foldMarketableMtmDemoJournalBasis([row()], { isTestAccount });
    expect(out.refusal).toBeNull();
    expect(out.cohort.fromTsExclusive).toBe(CAL_TO);
    expect(out.rowsRetained).toBe(1);
  });

  /**
   * The boundary row sits EXACTLY on the calibration close — i.e. inside the training
   * set. Retention is strictly `openTs > fromTsExclusive`, so it drops. This is the
   * assertion the `IN_SAMPLE_ROWS` tripwire backs: weaken that comparison to `<` and
   * the row is admitted and the fold refuses instead of grading it.
   */
  it('excludes the row sitting exactly ON the calibration close', () => {
    const out = foldMarketableMtmDemoJournalBasis(
      [row({ openTs: CAL_TO }), row({ openTs: CAL_TO + 1 })],
      { isTestAccount },
    );
    expect(out.refusal).toBeNull();
    expect(out.rowsRetained).toBe(1);
    expect(out.drops.before_cohort).toBe(1);
    expect(out.retainedOpenTsMin).toBe(CAL_TO + 1);
  });

  it('publishes the retained bounds as null (not 0) when nothing was retained', () => {
    const out = foldMarketableMtmDemoJournalBasis([row({ openTs: CAL_FROM })], { isTestAccount });
    expect(out.rowsRetained).toBe(0);
    // A `0` here would be a real 1970 epoch and would read as "retained rows from 1970".
    expect(out.retainedOpenTsMin).toBeNull();
    expect(out.retainedOpenIsoMin).toBeNull();
  });
});

describe('drop reasons stay distinguishable', () => {
  it('separates a pre-TRA-1656 row (no keys) from a present-but-corrupt book', () => {
    const out = foldMarketableMtmDemoJournalBasis(
      [
        { structure: 'single_leg', account: 'trader1', openTs: CAL_TO + DAY }, // no quote keys
        row({ entryBid: 1.5, entryAsk: 1.2 }), // crossed book: keys present, unusable
        row({ openTs: null }),
      ],
      { isTestAccount },
    );
    expect(out.drops.no_quote_field).toBe(1);
    expect(out.drops.quote_unusable).toBe(1);
    expect(out.drops.no_open_ts).toBe(1);
    expect(out.rowsRetained).toBe(0);
    // Zero retained ⇒ moments are NaN, NOT 0. A 0 half-spread is a real (and very
    // wrong) measurement; an absent one must not impersonate it.
    expect(out.pooled!.n).toBe(0);
    expect(Number.isNaN(out.pooled!.quotedH.mean)).toBe(true);
    expect(Number.isNaN(out.pooled!.quotedH.p90)).toBe(true);
  });
});

describe('moments per structure × account class (TRA-3502 acceptance #3)', () => {
  const rows: MarketableMtmDemoJournalRow[] = [
    // desk / single_leg — h = (1.325 − 1.25)/1.325 ≈ 0.056603
    row({ account: 'trader1' }),
    row({ account: 'trader2', entryBid: 1.20, entryAsk: 1.45, entryMarkUsd: 1.325 }),
    // fixture / single_leg — must NOT contaminate the desk cell
    row({ account: 'qa_bot', entryBid: 0.10, entryAsk: 2.50, entryMarkUsd: 1.30 }),
    // desk / debit_vertical
    row({ account: 'trader1', structure: 'debit_vertical', entryBid: 2.0, entryAsk: 2.2, entryMarkUsd: 2.1 }),
    // unattributed
    row({ account: undefined }),
  ];

  it('emits mean AND median AND p90 on every cell, never a lone scalar', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    expect(out.refusal).toBeNull();
    expect(out.rowsRetained).toBe(5);
    for (const c of [out.pooled!, ...out.cells]) {
      for (const m of [c.quotedH, c.quotedCrossUsd, c.modeledCrossUsdOnQuoted, c.midUsd, c.fullSpreadUsd]) {
        expect(m).toHaveProperty('mean');
        expect(m).toHaveProperty('median');
        expect(m).toHaveProperty('p90');
      }
    }
  });

  /**
   * The reason the account axis exists at all: `desk` is the deployment population and
   * the pooled number carries QA fixture books. The wide fixture quote (h ≈ 0.923 →
   * clamped to 0.50) must be reachable ONLY through the fixture cell.
   */
  it('keeps the DESK cell free of fixture books', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    const desk = out.cells.find((c) => c.structure === 'single_leg' && c.accountClass === 'desk');
    const fixture = out.cells.find((c) => c.structure === 'single_leg' && c.accountClass === 'fixture');
    expect(desk?.n).toBe(2);
    expect(fixture?.n).toBe(1);
    // desk h: 0.056603 and 0.094340 → mean ≈ 0.075472. The fixture 0.50 is nowhere near.
    expect(desk!.quotedH.mean).toBeCloseTo(((1.325 - 1.25) / 1.325 + (1.325 - 1.20) / 1.325) / 2, 6);
    expect(fixture!.quotedH.mean).toBeCloseTo(0.5, 6); // hit the shared MAX clamp
    expect(desk!.quotedH.mean).toBeLessThan(fixture!.quotedH.mean);
  });

  it('emits the marginals on both axes AND the pooled cell, each labelled with `*`', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    const structureMarginal = out.cells.find((c) => c.structure === 'single_leg' && c.accountClass === '*');
    const accountMarginal = out.cells.find((c) => c.structure === '*' && c.accountClass === 'desk');
    expect(structureMarginal?.n).toBe(4);   // 2 desk + 1 fixture + 1 unattributed
    expect(accountMarginal?.n).toBe(3);     // 2 single_leg + 1 debit_vertical
    expect(out.pooled!.structure).toBe('*');
    expect(out.pooled!.accountClass).toBe('*');
    expect(out.pooled!.n).toBe(5);
  });

  it('reports meanHError SIGNED, so an over-charging h is visible as over-charging', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    const desk = out.cells.find((c) => c.structure === 'single_leg' && c.accountClass === 'desk')!;
    // Measured mean ≈ 0.0755 vs modeled 0.134 ⇒ NEGATIVE: h over-charges. Understating
    // realizable P&L is the conservative direction and the opposite of the TRA-2233 bias.
    expect(desk.meanHError).toBeLessThan(0);
    expect(desk.meanHError).toBeCloseTo(desk.quotedH.mean - 0.134, 12);
  });

  it('runs the SHIPPED dollar tail predicate, and both of its states are reachable', () => {
    // (a) modeled p90 covers the quoted p90 — narrow books under h=0.134.
    const covered = foldMarketableMtmDemoJournalBasis(
      [row(), row({ account: 'trader2' })],
      { isTestAccount },
    );
    expect(covered.pooled!.quotedTailUnderCharged).toBe(false);
    expect(covered.pooled!.quotedTailUnderChargeRatio).toBeNull();

    // (b) a wider book than h prices ⇒ UNDER-charged, with the ratio published.
    const under = foldMarketableMtmDemoJournalBasis(
      [row({ entryBid: 1.00, entryAsk: 1.65, entryMarkUsd: 1.325 })],
      { isTestAccount },
    );
    expect(under.pooled!.quotedTailUnderCharged).toBe(true);
    expect(under.pooled!.quotedTailUnderChargeRatio).toBeGreaterThan(1);
  });

  it('never emits a retune target — the payload carries the ruling instead', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    expect(out.modeledH).toBe(0.134);
    expect(out.retuneNote).toContain('h stays 0.134');
    expect(out.seamCaveat).toContain('ENTRY QUOTE, EXIT HAIRCUT');
    expect(JSON.stringify(out)).not.toMatch(/suggestedH|proposedH|retuneTo/);
  });
});

describe('side and account classification', () => {
  it('reads credit structures as SHORT (they buy back at the ask)', () => {
    expect(demoJournalSide('bull_put')).toBe('short');
    expect(demoJournalSide('bear_call')).toBe('short');
    expect(demoJournalSide('iron_condor')).toBe('short');
    expect(demoJournalSide('single_leg')).toBe('long');
    expect(demoJournalSide('debit_vertical')).toBe('long');
  });

  it('measures the SHORT haircut on the ask side, not the bid side', () => {
    // bid 1.25 / ask 1.40 / mark 1.325 ⇒ long h = 0.0566, short h = (1.40−1.325)/1.325.
    const long = foldMarketableMtmDemoJournalBasis([row({ structure: 'single_leg' })], { isTestAccount });
    const short = foldMarketableMtmDemoJournalBasis([row({ structure: 'bull_put' })], { isTestAccount });
    expect(long.pooled!.quotedH.mean).toBeCloseTo((1.325 - 1.25) / 1.325, 10);
    expect(short.pooled!.quotedH.mean).toBeCloseTo((1.40 - 1.325) / 1.325, 10);
  });

  it('keeps `unattributed` distinct from `fixture` — unclassifiable is not "not a fixture"', () => {
    expect(classifyAccount(undefined, isTestAccount)).toBe('unattributed');
    expect(classifyAccount('   ', isTestAccount)).toBe('unattributed');
    expect(classifyAccount('qa_bot', isTestAccount)).toBe('fixture');
    expect(classifyAccount('trader1', isTestAccount)).toBe('desk');
  });
});
