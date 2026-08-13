import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PNL_LIVE_MODE_SPAN_NOTE,
  PNL_RECONCILIATION_CAVEATS,
  summarizeLiveCreditObservation,
} from './pnl-reconciliation.js';

/**
 * TRA-2922 — the CFO ruling on TRA-2919/TRA-2831 made the `liveUncreditedOptionsUsd`
 * suspension PERMANENT and, critically, keyed it to an IDENTITY rather than to a
 * dollar figure:
 *
 *   While `optionsRealizedBeforeLiveOnsetUsd >= postBaselineOptionsRealized` on a
 *   book, that book's `uncreditedOptionsUsd` carries ZERO live-onset options money
 *   and MUST NOT be reported, escalated or budgeted as a live-money shortfall — at
 *   any value, under any name.
 *
 * "Under any name" is the part with teeth. `liveUncreditedOptionsUsdUnscoped` is the
 * SAME suspended measurement published under a different key, kept as the evidence
 * the suspension rests on (TRA-2919 AC4). The published TRA-2831 caveat used to end
 * with "read `liveUncreditedOptionsUsdUnscoped` for the arithmetic" — an explicit
 * instruction to perform the exact fallback the ruling forbids, sitting on the live
 * wire at `/api/health/pnl-reconciliation`. This file pins the withdrawal.
 *
 * Why a value-keyed rule would have been useless: the same contaminated measurement
 * rendered 733.60 (2026-08-04), 371.59 (08-05) and -52.41 (08-06) as the day cells
 * moved under it. It changed SIGN inside 48 hours, so any guard phrased as "the
 * 733.60" or as "a positive shortfall" is already expired.
 */
describe('TRA-2922 — the suspended figure must not be readable under a second name', () => {
  const unscopedCaveats = PNL_RECONCILIATION_CAVEATS.filter(c =>
    c.includes('liveUncreditedOptionsUsdUnscoped'),
  );

  it('no published caveat INSTRUCTS a reader to take a value off the suspended key', () => {
    // Denominator first (TRA-2922 caution 2): a loop over an empty cohort passes
    // vacuously, and this is exactly the shape that rots silently under a rename.
    expect(unscopedCaveats.length).toBeGreaterThan(0);

    // Naming the key is FINE and required — TRA-2919's note names it to say the
    // day-cell evidence stays published (its AC4). What is forbidden is telling a
    // reader to take a NUMBER off it. `read <key>` is that instruction form, and
    // "for the arithmetic" is the exact notation the withdrawn sentence shipped in.
    for (const caveat of unscopedCaveats) {
      expect(caveat).not.toMatch(/read `liveUncreditedOptionsUsdUnscoped`/i);
      expect(caveat).not.toContain('for the arithmetic,');
    }
  });

  it('the prohibition itself ships on the wire, keyed to the identity', () => {
    const prohibiting = unscopedCaveats.filter(c =>
      c.includes('DO NOT FALL BACK TO `liveUncreditedOptionsUsdUnscoped`'),
    );
    // Exactly one caveat carries the rule. Zero = the ruling never landed; more
    // than one = two copies that will drift apart (TRA-2922's own lesson about a
    // pointer going stale inside the published data).
    expect(prohibiting).toHaveLength(1);
    const [rule] = prohibiting;

    // The rule as an IDENTITY over two operands, not as a constant.
    expect(rule).toContain('`optionsRealizedBeforeLiveOnsetUsd >= postBaselineOptionsRealized`');
    expect(rule).toContain('MUST NOT be reported, escalated or budgeted');
    expect(rule).toContain('at ANY value, under any name');
    // And it says WHO withdrew the old instruction, so a reader who saw the prior
    // revision knows this is a retraction rather than an omission.
    expect(rule).toContain('WITHDRAWN by TRA-2922');
  });

  it('the caveat carries the drift record, so no reader re-keys the rule to a constant', () => {
    // All three renders of the SAME contaminated measurement. A reader who sees only
    // one of them writes a guard keyed to that number.
    for (const rendered of ['733.60', '371.59', '-52.41']) {
      expect(PNL_LIVE_MODE_SPAN_NOTE).toContain(rendered);
    }
    expect(PNL_LIVE_MODE_SPAN_NOTE).toContain('changed SIGN');
    // And it points at the replacement, so "do not read this" is not a dead end.
    expect(PNL_LIVE_MODE_SPAN_NOTE).toContain('`engines[].postOnsetCredit`');
  });

  it('a NEGATIVE contaminated figure is still suspended, and still published as evidence', () => {
    // The 08-06 live shape: the day cells moved, the figure went negative, and the
    // contamination identity is untouched (987.60 >= 561.60). A rule keyed to
    // "> 0" or to "733.60" reads this book as clean; the identity does not.
    const fold = summarizeLiveCreditObservation([
      {
        username: 'admin',
        mode: 'live',
        equityAbsorbedOptionsOk: null,
        counterDurable: false,
        counterFrozenDates: ['2026-07-28', '2026-07-29'],
        counterNonDurableDates: ['2026-07-28', '2026-07-29'],
        maxUnbookedEquityMoveUsd: 24_672.34,
        optionsCreditedMeasuredCount: 5,
        optionsCreditedLatest: 0,
        optionsCreditedDates: [],
        closingEquityLatest: 2_603.49,
        closingEquityLatestDate: '2026-08-05',
        uncreditedOptionsUsd: -52.41,
        // TRA-3589 — this fixture is the 2026-08-06 shape, which PREDATES the
        // TRA-3349 broker boundary (2026-08-12). Its window sits wholly inside
        // the paper era, so it does not straddle and the TRA-2922 identity is
        // what suspends it — not the era gate. Set explicitly so a later change
        // to the era default cannot silently re-route which rule this test
        // grades.
        uncreditedOptionsNotMeasuredReason: null,
        postBaselineEquityGrowthSpansEquitySourceEras: false,
        equitySourceEraBoundary: {
          brokerOnsetDate: null,
          brokerOnsetOpeningEquity: null,
          priorEraRowDate: null,
          priorEraRowEquitySourceEra: null,
          priorEraRowClosingEquity: null,
          restatementUsd: null,
          eraCensus: { 'unstamped-pre-tra3349': 18 },
          seriesSpansBrokerBoundary: false,
        },
        postBaselineEquityGrowth: 595.2,
        postBaselineOptionsRealized: 561.6,
        postBaselineStockDaily: -18.81,
        liveOptionsOnsetDate: '2026-07-30',
        optionsRealizedBeforeLiveOnsetUsd: 987.6,
        preLiveOnsetOptionsDates: [
          '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21',
          '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-28',
          '2026-07-29',
        ],
        postOnsetCredit: {
          onsetDate: '2026-07-30',
          journalCensusAvailable: true,
          anchorBasis: 'pre-onset-close',
          leftAnchorDate: '2026-07-29',
          leftAnchorEquity: 2_243.48,
          rightAnchorDate: '2026-08-05',
          rightAnchorEquity: 2_603.49,
          leftAnchorEquityBasis: null,
          rightAnchorEquityBasis: null,
          windowSessions: 5,
          windowRowDates: ['2026-08-04', '2026-08-05'],
          absentSessions: ['2026-07-30', '2026-07-31', '2026-08-03'],
          journalOptionsUsd: 739,
          dayCellOptionsUsd: -426,
          stockDailyUsd: null,
          equityGrowthUsd: null,
          windowNetCashFlowUsd: null,
          uncreditedOptionsUsd: null,
          notMeasuredReason: 'equity-anchor-spans-absent-session',
          legs: [],
        },
      },
    ]);

    // Suspended — NOT because the figure is 733.60, but because the identity holds.
    expect(fold.liveUncreditedOptionsUsd).toBeNull();
    // Evidence still published (TRA-2919 AC4), sign and all.
    expect(fold.liveUncreditedOptionsUsdUnscoped).toBeCloseTo(-52.41, 2);
    expect(fold.liveModeSpanContaminatedBooks).toHaveLength(1);
    // Print the denominator beside the verdict (TRA-2922 caution 2).
    expect(fold.liveCreditBookCount).toBe(1);
    // And the live-money axis stays NOT MEASURED: the journal numerator exists
    // (attribution) but the comparison does not (the equity leg is holed).
    expect(fold.liveUncreditedOptionsGradeable).toBe(true);
    expect(fold.liveOnsetCreditNumeratorBookCount).toBe(1);
    expect(fold.liveOnsetUncreditedOptionsUsd).toBeNull();
    expect(fold.liveOnsetCreditComparisonBookCount).toBe(0);
  });

  it('no source file outside the producer and its tests READS the suspended key', () => {
    // The prohibition is on CONSUMERS, so grep for them. A greppable seam is blind
    // to notation variants, which is why the caveat arms above assert the rule
    // text separately — this arm catches the other failure mode: a new call site.
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const hits = readdirSync(srcDir)
      .filter(f => f.endsWith('.ts'))
      .filter(f =>
        readFileSync(join(srcDir, f), 'utf8').includes('liveUncreditedOptionsUsdUnscoped'),
      )
      .sort();

    // Guard for the guard: if a rename made the identifier unfindable, this whole
    // assertion would pass on an empty set. Name the producer explicitly.
    expect(hits).toContain('pnl-reconciliation.ts');

    const consumers = hits.filter(f => f !== 'pnl-reconciliation.ts' && !f.endsWith('.test.ts'));
    expect(consumers).toEqual([]);
  });
});
