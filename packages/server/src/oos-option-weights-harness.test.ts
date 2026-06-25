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
});
