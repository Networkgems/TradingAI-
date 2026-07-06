import { describe, it, expect } from 'vitest';
import type { OptionTradeJournalRecord, OptionTradeOutcome } from './option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  optionSetupMultiplier,
  setupKeyFromRow,
  DEFAULT_LEARNED_PARAMS,
} from './learned-option-weights.js';
import {
  buildOosReport,
  oosMultiplierForRow,
  cohortOf,
  resolvedRows,
  bootstrapGap,
  gradeVerdict,
  renderOosReport,
  expectancyCohortOf,
  decisiveWinRate,
  calibrateBaseline,
} from './oos-option-weights-harness.js';

// ── synthetic-row factory ──────────────────────────────────────────────────────
// Every fixture keeps ivRank/trend/sentiment/dte IDENTICAL across rows so those
// folds form a single bucket; `structure` and the WIN/LOSS outcome carry the signal.
// `outcome` (→ winRate → multiplier → cohort) and `realizedR` (→ the gap) are set
// independently so NOISE fixtures can decouple them.

let seq = 0;
function row(
  structure: string,
  outcome: OptionTradeOutcome,
  realizedR: number,
  extra: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord {
  seq += 1;
  const openTs = 1_700_000_000_000 + seq * 60_000;
  return {
    id: `r${seq}`,
    openTs,
    symbol: 'TEST',
    structure,
    mode: 'demo',
    ivRank: 40,
    trend: 'up',
    sentiment: 0.0,
    sentimentIcBand: 'weak',
    entryDelta: 0.5,
    entryDte: 35,
    atRiskUsd: 1000,
    outcome,
    closeTs: openTs + 86_400_000,
    realizedPnlUsd: realizedR * 1000,
    realizedR,
    exitReason: 'tp1',
    holdDays: 1,
    ...extra,
  };
}

/** N rows of one structure: `wins` WINs then `losses` LOSSes, with per-bucket R values. */
function bucket(
  structure: string,
  wins: number,
  losses: number,
  winR: number,
  lossR: number,
): OptionTradeJournalRecord[] {
  const out: OptionTradeJournalRecord[] = [];
  for (let i = 0; i < wins; i++) out.push(row(structure, 'WIN', winR));
  for (let i = 0; i < losses; i++) out.push(row(structure, 'LOSS', lossR));
  return out;
}

describe('oos-option-weights-harness', () => {
  describe('cohortOf', () => {
    it('buckets by the pre-registered thresholds', () => {
      expect(cohortOf(1.2)).toBe('up');
      expect(cohortOf(1.05)).toBe('neutral'); // strictly >
      expect(cohortOf(1.0)).toBe('neutral');
      expect(cohortOf(0.95)).toBe('neutral'); // strictly <
      expect(cohortOf(0.8)).toBe('down');
    });
  });

  describe('leave-one-out excludes the scored row', () => {
    it('a 10-row bucket goes neutral OOS because removing the row drops it below minSamples', () => {
      // 10 identical winning rows of one structure. In-sample the structure clears
      // minSamples (10) and up-weights; leave-one-out trains on 9 → below the guard
      // → neutral 1.0. The difference IS the exclusion.
      const rows = bucket('solo', 10, 0, 1.5, 0);
      const inSampleWeights = computeOptionLearnedWeights(rows);
      const inSample = optionSetupMultiplier(inSampleWeights, setupKeyFromRow(rows[0]!), false);
      const oos = oosMultiplierForRow(rows, rows[0]!, {
        mode: 'loo',
        useShrinkage: false,
        params: DEFAULT_LEARNED_PARAMS,
      });

      expect(inSample).toBeGreaterThan(1.05); // confident in-sample
      expect(oos).toBe(1.0); // the scored row was excluded → bucket falls below guard
      expect(oos).toBeLessThan(inSample);
    });
  });

  describe('verdict on synthetic fixtures', () => {
    it('REAL — clearly separating up/down cohorts with a positive CI-clean gap', () => {
      // 15 good (winRate .87, R≈+1.17) + 15 bad (winRate .13, R≈-1.17). Structure
      // drives the cohort; shared dims fold to a neutral 0.5 winRate.
      const rows = [
        ...bucket('good', 13, 2, 1.5, -1.0),
        ...bucket('bad', 2, 13, 1.0, -1.5),
      ];
      const report = buildOosReport(rows);

      expect(report.cohorts.up.n).toBeGreaterThanOrEqual(12);
      expect(report.cohorts.down.n).toBeGreaterThanOrEqual(12);
      expect(report.sample.resolvedTotal).toBeGreaterThanOrEqual(30);
      expect(report.gap.gap ?? 0).toBeGreaterThan(0);
      expect(report.gap.ciLower ?? -1).toBeGreaterThan(0);
      expect(report.verdict).toBe('REAL');
    });

    it('NOISE — cohorts populate (sample bar cleared) but realized-R gap is ~0', () => {
      // Outcomes drive the cohorts; realizedR is mean-0 in BOTH structures, so the
      // expectancy gap collapses even though the sample bar is cleared.
      const flatR = (structure: string, wins: number, losses: number) => {
        const rs = bucket(structure, wins, losses, 0, 0);
        // overwrite realizedR with a mean-0 ±1/0 pattern, independent of outcome
        const pattern = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 0];
        rs.forEach((r, i) => {
          r.realizedR = pattern[i % pattern.length]!;
          r.realizedPnlUsd = r.realizedR * 1000;
        });
        return rs;
      };
      const rows = [...flatR('A', 13, 2), ...flatR('B', 2, 13)];
      const report = buildOosReport(rows);

      expect(report.cohorts.up.n).toBeGreaterThanOrEqual(12);
      expect(report.cohorts.down.n).toBeGreaterThanOrEqual(12);
      expect(report.verdict).toBe('NOISE');
    });

    it('INCONCLUSIVE — too few rows, every cohort under the per-cohort bar', () => {
      // Handful of rows: no structure clears minSamples → all neutral → under bar.
      const rows = [...bucket('good', 4, 0, 1.5, 0), ...bucket('bad', 0, 4, 0, -1.5)];
      const report = buildOosReport(rows);

      expect(report.sample.resolvedTotal).toBeLessThan(30);
      expect(report.cohorts.up.n).toBeLessThan(12);
      expect(report.verdict).toBe('INCONCLUSIVE');
    });
  });

  describe('resolvedRows', () => {
    it('drops OPEN rows and rows without a realized R', () => {
      const rows = [
        row('s', 'WIN', 1.0),
        { ...row('s', 'WIN', 1.0), outcome: 'OPEN' as const, realizedR: undefined },
      ];
      expect(resolvedRows(rows)).toHaveLength(1);
    });
  });

  describe('bootstrapGap', () => {
    it('is deterministic across runs (seeded)', () => {
      const up = [1, 1.5, 0.8, 1.2, 1.1];
      const down = [-1, -0.8, -1.2, -0.9, -1.1];
      const a = bootstrapGap(up, down, { level: 0.9, iterations: 500, seed: 7 });
      const b = bootstrapGap(up, down, { level: 0.9, iterations: 500, seed: 7 });
      expect(a).toEqual(b);
      expect(a.gap ?? 0).toBeGreaterThan(0);
      expect(a.ciLower ?? -1).toBeGreaterThan(0);
    });

    it('returns nulls when a cohort is empty', () => {
      const g = bootstrapGap([], [1], { level: 0.9, iterations: 10, seed: 1 });
      expect(g.gap).toBeNull();
      expect(g.ciLower).toBeNull();
    });
  });

  describe('gradeVerdict precedence', () => {
    it('checks the sample bar before the signal', () => {
      const up = { cohort: 'up' as const, n: 5, meanR: 1, hitRate: 0.8 };
      const down = { cohort: 'down' as const, n: 5, meanR: -1, hitRate: 0.2 };
      const gap = { gap: 2, ciLower: 1, ciUpper: 3, level: 0.9, iterations: 100 };
      // gap would say REAL, but n<12 per cohort and total<30 → INCONCLUSIVE wins.
      expect(gradeVerdict(10, up, down, gap).verdict).toBe('INCONCLUSIVE');
    });
  });

  describe('time-split mode', () => {
    it('trains on rows closed before the split and scores rows closed at/after it', () => {
      // 12 good rows closed early (train), then 12 good rows closed late (scored).
      const early = bucket('good', 12, 0, 1.5, 0);
      const late = bucket('good', 12, 0, 1.5, 0);
      const splitTs = late[0]!.closeTs!; // boundary at the first late close
      const report = buildOosReport([...early, ...late], { mode: 'time-split', splitTs });
      // Only the 12 late rows are scored OUT of sample.
      expect(report.sample.scored).toBe(12);
      // Trained on 12 confident good rows → late rows up-weight.
      expect(report.cohorts.up.n).toBe(12);
    });
  });

  describe('renderOosReport', () => {
    it('emits a compact text report with verdict + Step-2 sentimentIc section', () => {
      const rows = [...bucket('good', 13, 2, 1.5, -1.0), ...bucket('bad', 2, 13, 1.0, -1.5)];
      const report = buildOosReport(rows);
      const text = renderOosReport(report, '2026-06-25T00:00:00Z');
      expect(text).toContain('TRA-1133');
      expect(text).toContain(`VERDICT: ${report.verdict}`);
      expect(text).toContain('TRA-992 Step 2 read');
      expect(text).toContain('bySentimentIc');
    });
  });

  // ── TRA-1321 protocol v2 (expectancy mode) ────────────────────────────────────
  // A trend-bucketed factory: a single structure so the per-structure baseline
  // equals the pooled one, and the WIN/LOSS mix within each `trend` bucket carries
  // the signal (above the family baseline → up-weight, below → down-weight).
  function trendBucket(
    trend: 'up' | 'down' | 'sideways',
    wins: number,
    losses: number,
    winR: number,
    lossR: number,
    scratches = 0,
  ): OptionTradeJournalRecord[] {
    const out: OptionTradeJournalRecord[] = [];
    for (let i = 0; i < wins; i++) out.push(row('s', 'WIN', winR, { trend }));
    for (let i = 0; i < losses; i++) out.push(row('s', 'LOSS', lossR, { trend }));
    for (let i = 0; i < scratches; i++) out.push(row('s', 'SCRATCH', 0, { trend }));
    return out;
  }

  describe('decisiveWinRate', () => {
    it('is WIN/(WIN+LOSS) and excludes SCRATCH from the denominator', () => {
      const rows = [...bucket('s', 3, 2, 1, -1), row('s', 'SCRATCH', 0)];
      // 3 WIN, 2 LOSS, 1 SCRATCH → 3/5 decisive, scratch ignored.
      expect(decisiveWinRate(rows)).toBeCloseTo(0.6, 10);
    });
    it('is null with no decisive rows', () => {
      expect(decisiveWinRate([row('s', 'SCRATCH', 0)])).toBeNull();
    });
  });

  describe('calibrateBaseline', () => {
    it('pools the decisive rate and only forms a per-structure baseline past the guard', () => {
      // structure A: 20 decisive (10W/10L → 0.5); structure B: 6 decisive (below the
      // MIN_DECISIVE_PER_STRUCTURE=12 guard → no per-structure baseline for B).
      const rows = [...bucket('A', 10, 10, 1, -1), ...bucket('B', 3, 3, 1, -1)];
      const calib = calibrateBaseline(resolvedRows(rows));
      expect(calib.pooled).toBeCloseTo(13 / 26, 10); // 13W / 26 decisive
      expect(calib.perStructure.A).toBeCloseTo(0.5, 10);
      expect(calib.perStructure.B).toBeUndefined();
      expect(calib.usedPerStructure).toBe(true);
      expect(calib.decisiveResolved).toBe(26);
    });
  });

  describe('expectancyCohortOf', () => {
    it('splits at the recalibrated null of 1.0', () => {
      expect(expectancyCohortOf(1.01)).toBe('up');
      expect(expectancyCohortOf(1.0)).toBe('neutral');
      expect(expectancyCohortOf(0.99)).toBe('down');
    });
  });

  describe('expectancy mode verdicts', () => {
    it('REAL — recalibrated cohorts form with a positive CI-clean expectancy gap', () => {
      // One structure, two trend buckets. Pooled decisive rate = 15/30 = 0.5. The
      // `up` trend wins 0.8 (big winners), the `down` trend wins 0.2 (bleeds), so the
      // decisive-basis fold pushes them either side of 1.0 and the realized-R gap is
      // large and clean. The legacy 0.5-floor path could never form the up-cohort.
      const rows = [
        ...trendBucket('up', 12, 3, 2.0, -1.0),
        ...trendBucket('down', 3, 12, 1.0, -1.0),
      ];
      const report = buildOosReport(rows, { expectancy: true });
      expect(report.expectancy?.enabled).toBe(true);
      expect(report.expectancy?.cohortBasis).toBe('absolute');
      expect(report.expectancy?.baseline.pooled).toBeCloseTo(0.5, 10);
      expect(report.cohorts.up.n).toBeGreaterThanOrEqual(12);
      expect(report.cohorts.down.n).toBeGreaterThanOrEqual(12);
      expect(report.gap.gap ?? 0).toBeGreaterThan(0);
      expect(report.gap.ciLower ?? -1).toBeGreaterThan(0);
      expect(report.verdict).toBe('REAL');
    });

    it('falls back to a median split when the absolute 1.0 split degenerates', () => {
      // 11 up-weighted rows (still below the per-cohort bar of 12, so the absolute
      // split degenerates) + 20 down-weighted rows. Buckets are >=11 so leave-one-out
      // keeps them confident (>=10). Median split rebalances the 31 rows into halves
      // by composite multiplier.
      const rows = [
        ...trendBucket('up', 9, 2, 2.0, -1.0), // 11 rows, rate 0.82 → mult > 1.0
        ...trendBucket('down', 4, 16, 1.0, -1.0), // 20 rows, rate 0.20 → mult < 1.0
      ];
      const report = buildOosReport(rows, { expectancy: true });
      expect(report.expectancy?.cohortBasis).toBe('median');
      expect(report.expectancy?.distinctMultipliers ?? 0).toBeGreaterThan(1);
      expect(report.cohorts.up.n).toBeGreaterThanOrEqual(12);
      expect(report.cohorts.down.n).toBeGreaterThanOrEqual(12);
      expect(report.cohorts.up.n + report.cohorts.down.n).toBe(31);
    });

    it('INCONCLUSIVE when every scored row shares one setup (no signal to split on)', () => {
      // time-split with a single setup across all late (scored) rows → they all get
      // the same OOS multiplier → distinctMultipliers === 1 → cohorts cannot form on
      // any basis. The distinct-value guard fires before the sample bar.
      const early = trendBucket('up', 8, 4, 1.0, -1.0); // train
      const late = trendBucket('up', 9, 6, 1.0, -1.0); // scored, identical setup
      const splitTs = late[0]!.closeTs!;
      const report = buildOosReport([...early, ...late], {
        expectancy: true,
        mode: 'time-split',
        splitTs,
      });
      expect(report.expectancy?.distinctMultipliers).toBe(1);
      expect(report.verdict).toBe('INCONCLUSIVE');
      expect(report.verdictReasons.join(' ')).toContain('no variation');
    });

    it('renders the recalibration block and protocol-v2 marker', () => {
      const rows = [
        ...trendBucket('up', 12, 3, 2.0, -1.0),
        ...trendBucket('down', 3, 12, 1.0, -1.0),
      ];
      const report = buildOosReport(rows, { expectancy: true });
      const text = renderOosReport(report, '2026-07-05T00:00:00Z');
      expect(text).toContain('Protocol:** v2 expectancy');
      expect(text).toContain('Recalibration (protocol v2)');
      expect(text).toContain('family decisive');
    });

    it('leaves the legacy default path unchanged (still INCONCLUSIVE on the sub-baseline family)', () => {
      // The exact pathology TRA-1321 fixes: every bucket wins < 50%, so the legacy
      // 0.5-baseline path floors all rows into `down` and the up-cohort is un-formable.
      const rows = [
        ...trendBucket('up', 4, 11, 2.0, -1.0),
        ...trendBucket('down', 3, 12, 1.0, -1.0),
      ];
      const legacy = buildOosReport(rows); // no expectancy flag
      expect(legacy.expectancy).toBeUndefined();
      expect(legacy.cohorts.up.n).toBe(0); // floored — cannot form
      expect(legacy.verdict).toBe('INCONCLUSIVE');
    });
  });
});
