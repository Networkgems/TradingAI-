import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECLARED_STRATEGY_ENVELOPES,
  DEFAULT_MIN_BASELINE_TRADES,
  DEFAULT_MIN_WINDOW_TRADES,
  DEGRADATION_TOLERANCE,
  MIN_RECOMMENDED_SIZE_FACTOR,
  POOLED_COHORT_SUFFIX,
  buildStrategyDegradationReport,
  degradationCohortKey,
  deriveTrailingEnvelope,
  recommendSizeDown,
  renderStrategyDegradationMarkdown,
  type DeclaredStrategyEnvelope,
  type StrategyDegradationRow,
} from './strategy-degradation-monitor.js';
import {
  OPTIONS_EVAL_CONSTRAINTS,
  extractEvaluatedTrades,
  type EvaluatedOptionTrade,
} from './options-evaluation-report.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-4913 — the per-strategy degradation monitor.
//
// The properties under test are the ones that decide whether this surface can be
// TRUSTED, not the ones that make it look busy. In order of how expensive they
// are to get wrong:
//
//   1. A thin window must not raise a flag, and must not raise a green one either.
//   2. "could not check" must never share a value with "checked and it is fine" —
//      INSUFFICIENT / NO_ENVELOPE / NOT_MEASURED are three distinct non-green
//      states and none of them is HEALTHY.
//   3. The comparison must be against the cohort's OWN recorded envelope, never a
//      global constant.
//   4. Nothing may reach a trade-execution path.

const DAY = 86_400_000;

/**
 * A closed journal row on the BROKER-FILL cost rung, so `netPnlUsd` is exactly
 * `realizedPnlUsd` and the fixtures' arithmetic is the arithmetic under test
 * rather than the fee model's.
 */
function closed(
  id: string,
  closeTs: number,
  pnlUsd: number,
  over: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord {
  return {
    id,
    openTs: closeTs - DAY,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    outcome: pnlUsd > 0 ? 'WIN' : 'LOSS',
    closeTs,
    realizedPnlUsd: pnlUsd,
    realizedR: pnlUsd / 100,
    exitReason: 'trail',
    pnlBasis: 'broker-fill',
    contracts: 1,
    ...over,
  } as OptionTradeJournalRecord;
}

/**
 * `count` rows alternating win/loss in a fixed ratio, so PF and expectancy are
 * both deterministic and independently steerable: `winUsd`/`lossUsd` set the
 * geometry, the win fraction sets the rate.
 */
function series(
  prefix: string,
  count: number,
  startTs: number,
  winUsd: number,
  lossUsd: number,
  winEvery: number,
  over: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord[] {
  const out: OptionTradeJournalRecord[] = [];
  for (let i = 0; i < count; i++) {
    const isWin = i % winEvery === 0;
    out.push(closed(`${prefix}-${i}`, startTs + i * DAY, isWin ? winUsd : -lossUsd, over));
  }
  return out;
}

const COHORT = `single_leg_rv${POOLED_COHORT_SUFFIX}`;

/**
 * The graded population for a row list, for the unit-level
 * `deriveTrailingEnvelope` cases. Uses the REAL TRA-4914 extractor so these
 * fixtures are priced exactly as production prices them.
 */
function extract(rows: OptionTradeJournalRecord[]): EvaluatedOptionTrade[] {
  const { trades, coverage } = extractEvaluatedTrades(rows);
  // A fixture silently falling out of the graded population would make every
  // assertion below vacuous, so the extraction is asserted, not assumed.
  expect(coverage.graded).toBe(rows.length);
  return trades;
}

function rowFor(report: { rows: StrategyDegradationRow[] }, strategy: string): StrategyDegradationRow {
  const r = report.rows.find((x) => x.strategy === strategy);
  if (!r) throw new Error(`no row for ${strategy}; got ${report.rows.map((x) => x.strategy).join(', ')}`);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4913 — small samples raise no flag in either direction', () => {
  it('reports INSUFFICIENT with NULL metrics when the window is below its floor', () => {
    // 6 trades. The AC names this n explicitly: a degradation call on n=6 is noise.
    const rows = series('thin', 6, 1_000_000, 100, 50, 2);
    const report = buildStrategyDegradationReport(rows, { asOfIso: '2026-09-25T00:00:00.000Z' });

    const row = rowFor(report, COHORT);
    expect(row.verdict).toBe('INSUFFICIENT');
    expect(row.window.n).toBe(6);
    expect(row.window.floor).toBe(DEFAULT_MIN_WINDOW_TRADES);
    // The load-bearing half: a thin cell leaks NO figure a dashboard could render.
    expect(row.window.profitFactor).toBeNull();
    expect(row.window.expectancyR).toBeNull();
    expect(row.breaches).toEqual([]);
    expect(row.sizeDown).toBeNull();
    expect(report.degradedStrategies).toEqual([]);
  });

  it('a thin window that is also catastrophically bad is still INSUFFICIENT, not DEGRADED', () => {
    // Every trade a loss. Under any threshold this "looks" degraded — and must
    // not be called, because at n=8 it is indistinguishable from a bad streak.
    const rows = series('awful', 8, 1_000_000, 0, 100, 999);
    const report = buildStrategyDegradationReport(rows);
    expect(rowFor(report, COHORT).verdict).toBe('INSUFFICIENT');
    expect(report.degradedStrategies).toEqual([]);
  });

  it('INSUFFICIENT is counted separately from HEALTHY in the census', () => {
    const report = buildStrategyDegradationReport(series('thin', 6, 1_000_000, 100, 50, 2));
    expect(report.verdictCensus.INSUFFICIENT).toBe(1);
    expect(report.verdictCensus.HEALTHY).toBe(0);
    expect(report.nonGreenStrategies).toContain(COHORT);
  });
});

describe('TRA-4913 — "could not check" never shares a value with "it is fine"', () => {
  it('a gradeable window with no envelope reads NO_ENVELOPE, not HEALTHY', () => {
    // 40 trades: the WINDOW clears its floor (30), but after the 50-trade window
    // is taken there is no baseline left to mint an envelope from.
    const rows = series('noenv', 40, 1_000_000, 100, 40, 2);
    const report = buildStrategyDegradationReport(rows);

    const row = rowFor(report, COHORT);
    expect(row.verdict).toBe('NO_ENVELOPE');
    expect(row.envelope).toBeNull();
    // It was measurable — the point is that there was nothing to measure AGAINST.
    expect(row.window.status).toBe('OK');
    expect(row.window.profitFactor).not.toBeNull();
    expect(row.reason).toContain('NOTHING TO GRADE IT AGAINST');
  });

  it('a DECLARED cohort that produced no gradeable rows reads NOT_MEASURED, and does not vanish', () => {
    const declared: DeclaredStrategyEnvelope[] = [
      {
        strategy: 'retired_sleeve::alpha',
        minProfitFactor: 1.4,
        minExpectancyR: 0.05,
        n: 500,
        asOf: '2026-01-01',
        provenance: 'TRA-0000 fixture',
      },
    ];
    const report = buildStrategyDegradationReport(series('other', 40, 1_000_000, 100, 40, 2), {
      declaredEnvelopes: declared,
    });

    const row = rowFor(report, 'retired_sleeve::alpha');
    expect(row.verdict).toBe('NOT_MEASURED');
    expect(row.window.n).toBe(0);
    expect(row.reason).toContain('DECLARED envelope');
    // A strategy going silent is exactly what a degradation monitor must notice.
    expect(report.nonGreenStrategies).toContain('retired_sleeve::alpha');
  });

  it('the four non-green verdicts are four distinct values', () => {
    const vals = new Set(['DEGRADED', 'INSUFFICIENT', 'NO_ENVELOPE', 'NOT_MEASURED', 'HEALTHY']);
    expect(vals.size).toBe(5);
  });
});

describe('TRA-4913 — the envelope is the cohort\'s own, never a global constant', () => {
  it('derives a trailing envelope only above the baseline floor', () => {
    const asOf = '2026-09-25T00:00:00.000Z';
    const thin = extract(series('b', DEFAULT_MIN_BASELINE_TRADES - 1, 1_000_000, 100, 40, 2));
    expect(deriveTrailingEnvelope('x::y', thin, asOf, DEFAULT_MIN_BASELINE_TRADES)).toBeNull();

    const enough = extract(series('b', DEFAULT_MIN_BASELINE_TRADES, 1_000_000, 100, 40, 2));
    const env = deriveTrailingEnvelope('x::y', enough, asOf, DEFAULT_MIN_BASELINE_TRADES);
    expect(env).not.toBeNull();
    expect(env!.source).toBe('trailing_baseline_derived');
    // A derived envelope is NOT a validation and must not be rendered as one.
    expect(env!.isValidation).toBe(false);
    expect(env!.provenance).toContain('NOT an out-of-sample validation');
  });

  it('refuses to mint an envelope from a NON-POSITIVE baseline', () => {
    // A losing baseline × (1 − tolerance) moves the floor UP toward zero, which
    // would hand a bleeding cohort a HARDER floor than a profitable one and flag
    // it for bleeding less. `detectEdgeDecay` carries the same `base > 0` guard.
    const losing = extract(series('l', 80, 1_000_000, 40, 100, 2));
    const env = deriveTrailingEnvelope('x::y', losing, '2026-09-25T00:00:00.000Z', DEFAULT_MIN_BASELINE_TRADES);
    expect(env).toBeNull();
  });

  it('the derived floor is the cohort\'s own figure less the RATIFIED tolerance', () => {
    const baseline = extract(series('b', 80, 1_000_000, 100, 40, 2));
    const env = deriveTrailingEnvelope('x::y', baseline, '2026-09-25T00:00:00.000Z', DEFAULT_MIN_BASELINE_TRADES)!;
    // 40 wins @ +100 vs 40 losses @ −40 ⇒ PF = 4000/1600 = 2.5.
    expect(env.minProfitFactor).toBeCloseTo(2.5 * (1 - DEGRADATION_TOLERANCE), 9);
    // The tolerance is the constraint table's, not a second local knob.
    expect(DEGRADATION_TOLERANCE).toBe(OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation);
  });

  it('a DECLARED envelope wins over the derived one and is marked as a validation', () => {
    const rows = series('d', 130, 1_000_000, 100, 40, 2);
    const report = buildStrategyDegradationReport(rows, {
      declaredEnvelopes: [
        {
          strategy: COHORT,
          minProfitFactor: 1.1,
          minExpectancyR: 0.01,
          n: 900,
          asOf: '2026-05-01',
          provenance: 'TRA-0000 fixture validation',
        },
      ],
    });
    const row = rowFor(report, COHORT);
    expect(row.envelope!.source).toBe('declared');
    expect(row.envelope!.isValidation).toBe(true);
    expect(row.envelope!.minProfitFactor).toBe(1.1);
    expect(report.declaredEnvelopeCount).toBe(1);
  });

  it('two cohorts with different histories get DIFFERENT floors', () => {
    const strong = series('s', 130, 1_000_000, 100, 40, 2, { entryArchetype: 'strong' });
    const weak = series('w', 130, 1_000_000, 100, 80, 2, { entryArchetype: 'weak' });
    const report = buildStrategyDegradationReport([...strong, ...weak]);

    const a = rowFor(report, 'single_leg_rv::strong').envelope!;
    const b = rowFor(report, 'single_leg_rv::weak').envelope!;
    expect(a.minProfitFactor).not.toBeCloseTo(b.minProfitFactor, 6);
  });
});

describe('TRA-4913 — degradation fires, and only as an advisory', () => {
  /**
   * 80 strong baseline trades (PF 2.5) then a 50-trade window whose geometry has
   * collapsed (PF 0.75). The window's PF falls far through the derived floor of
   * 2.5 × 0.65 = 1.625.
   */
  function degradedBook(): OptionTradeJournalRecord[] {
    const baseline = series('base', 80, 1_000_000, 100, 40, 2);
    const recent = series('rec', 50, 1_000_000 + 80 * DAY, 60, 80, 2);
    return [...baseline, ...recent];
  }

  it('flags DEGRADED with the breached metrics named and their shortfalls measured', () => {
    const report = buildStrategyDegradationReport(degradedBook());
    const row = rowFor(report, COHORT);

    expect(row.verdict).toBe('DEGRADED');
    expect(report.degradedStrategies).toEqual([COHORT]);
    expect(row.breaches.map((b) => b.metric).sort()).toEqual(['expectancyR', 'profitFactor']);
    for (const b of row.breaches) {
      expect(b.observed).toBeLessThan(b.floor);
      expect(b.shortfall).toBeGreaterThan(0);
      expect(b.shortfall).toBeLessThanOrEqual(1);
    }
  });

  it('the size-down is a RECOMMENDATION, bounded, and says so on its face', () => {
    const report = buildStrategyDegradationReport(degradedBook());
    const rec = rowFor(report, COHORT).sizeDown!;

    expect(rec.advisoryOnly).toBe(true);
    expect(rec.recommendedSizeFactor).toBeGreaterThanOrEqual(MIN_RECOMMENDED_SIZE_FACTOR);
    expect(rec.recommendedSizeFactor).toBeLessThan(1);
    expect(rec.rationale).toContain('nothing applies this automatically');
    // The whole payload states the posture, so no consumer has to infer it.
    expect(report.advisoryOnly).toBe(true);
  });

  it('the recommendation is monotone in the shortfall and never reaches zero', () => {
    const mild = recommendSizeDown('x::y', [
      { metric: 'profitFactor', observed: 0.9, floor: 1.0, shortfall: 0.1 },
    ])!;
    const severe = recommendSizeDown('x::y', [
      { metric: 'profitFactor', observed: 0.1, floor: 1.0, shortfall: 0.9 },
    ])!;
    expect(severe.recommendedSizeFactor).toBeLessThan(mild.recommendedSizeFactor);
    // A monitor that recommends ~0 is recommending a halt, and halts are owned
    // elsewhere (options-risk-breaker / DailyRiskGovernor / the churn brakes).
    expect(severe.recommendedSizeFactor).toBeGreaterThanOrEqual(MIN_RECOMMENDED_SIZE_FACTOR);
    expect(recommendSizeDown('x::y', [])).toBeNull();
  });

  it('a cohort still inside its envelope reads HEALTHY with no recommendation', () => {
    const rows = series('ok', 130, 1_000_000, 100, 40, 2);
    const report = buildStrategyDegradationReport(rows);
    const row = rowFor(report, COHORT);
    expect(row.verdict).toBe('HEALTHY');
    expect(row.breaches).toEqual([]);
    expect(row.sizeDown).toBeNull();
  });
});

describe('TRA-4913 — cohort keying', () => {
  it('keys on `structure::entryArchetype`, never on the bare structure', () => {
    expect(degradationCohortKey({ structure: 'single_leg_rv', entryArchetype: 'orb' }))
      .toBe('single_leg_rv::orb');
    expect(degradationCohortKey({ structure: 'single_leg_rv' })).toBe(COHORT);
  });

  it('does not POOL two sleeves that share a structure label', () => {
    // The TRA-2245 trap: four sleeves shared `single_leg_rv`. Keyed on the bare
    // structure, one sleeve's collapse drags the other into a single verdict.
    const healthy = series('h', 130, 1_000_000, 100, 40, 2, { entryArchetype: 'healthy' });
    const collapsed = [
      ...series('cb', 80, 1_000_000, 100, 40, 2, { entryArchetype: 'collapsed' }),
      ...series('cr', 50, 1_000_000 + 80 * DAY, 60, 80, 2, { entryArchetype: 'collapsed' }),
    ];
    const report = buildStrategyDegradationReport([...healthy, ...collapsed]);

    expect(report.degradedStrategies).toEqual(['single_leg_rv::collapsed']);
    expect(rowFor(report, 'single_leg_rv::healthy').verdict).toBe('HEALTHY');
  });

  it('marks the pre-tagging `::unspecified` cohort as POOLED, with the blast radius in the reason', () => {
    const report = buildStrategyDegradationReport(series('p', 130, 1_000_000, 100, 40, 2));
    const row = rowFor(report, COHORT);
    expect(row.pooledCohort).toBe(true);
    expect(row.reason).toContain('NOT a sleeve');

    const tagged = buildStrategyDegradationReport(
      series('t', 130, 1_000_000, 100, 40, 2, { entryArchetype: 'orb' }),
    );
    expect(rowFor(tagged, 'single_leg_rv::orb').pooledCohort).toBe(false);
  });
});

describe('TRA-4913 — the declared registry ships empty, and honestly', () => {
  it('holds no rows — nothing in this tree has a recorded validated envelope', () => {
    // If you are adding a row, this assertion is the place to say so. Changing
    // the number without a `provenance` naming the ticket and artifact is the
    // fabrication this module's header refuses.
    expect(DECLARED_STRATEGY_ENVELOPES).toHaveLength(0);
  });

  it('any row added later must carry a TRA-referenced provenance and a real n', () => {
    for (const d of DECLARED_STRATEGY_ENVELOPES) {
      expect(d.provenance).toMatch(/TRA-\d{3,}/);
      expect(d.n).toBeGreaterThan(0);
      expect(d.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.strategy).toContain('::');
    }
  });
});

describe('TRA-4913 — the rendered section cannot read as a clean day when it is not', () => {
  it('prints the census even when nothing degraded', () => {
    const report = buildStrategyDegradationReport(series('thin', 6, 1_000_000, 100, 50, 2));
    const md = renderStrategyDegradationMarkdown(report);
    expect(md).not.toBe('');
    expect(md).toContain('ADVISORY ONLY');
    expect(md).toContain('INSUFFICIENT');
    expect(md).toContain('1 insufficient');
  });

  it('warns in the section when ZERO declared envelopes are in force', () => {
    const md = renderStrategyDegradationMarkdown(
      buildStrategyDegradationReport(series('ok', 130, 1_000_000, 100, 40, 2)),
    );
    expect(md).toContain('Zero DECLARED envelopes are in force');
  });

  it('returns nothing only when there were no cohorts at all', () => {
    expect(renderStrategyDegradationMarkdown(buildStrategyDegradationReport([]))).toBe('');
  });
});

describe('TRA-4913 — ZERO writes to any trade-execution path', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), 'strategy-degradation-monitor.ts');
  const src = readFileSync(SRC, 'utf8');

  /** Blank out comments and string literals so prose is not read as code. */
  function mask(input: string): string {
    const out = input.split('');
    let i = 0;
    while (i < input.length) {
      const c = input[i]!;
      if (c === '/' && input[i + 1] === '/') {
        const j = input.indexOf('\n', i);
        const stop = j < 0 ? input.length : j;
        for (let k = i; k < stop; k++) out[k] = ' ';
        i = stop;
      } else if (c === '/' && input[i + 1] === '*') {
        const j = input.indexOf('*/', i + 2);
        const stop = j < 0 ? input.length : j + 2;
        for (let k = i; k < stop; k++) out[k] = ' ';
        i = stop;
      } else if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < input.length) {
          if (input[j] === '\\') { j += 2; continue; }
          if (input[j] === c) { j++; break; }
          j++;
        }
        for (let k = i; k < Math.min(j, input.length); k++) out[k] = ' ';
        i = j;
      } else {
        i++;
      }
    }
    return out.join('');
  }

  const masked = mask(src);

  /**
   * The module may import from EXACTLY these. Anything else is a new edge into
   * this module's dependency graph and has to be argued for here first — which is
   * the point: an execution-path import cannot arrive by accident.
   */
  const IMPORT_ALLOWLIST = ['./option-trade-journal.js', './options-evaluation-report.js'];

  it('imports nothing outside the allowlist', () => {
    // `from '…'` appears in a TS module only as an import/export specifier.
    const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(IMPORT_ALLOWLIST).toContain(s);
  });

  it('names no order, broker, chain or persistence call site', () => {
    // Substrings, checked against the MASKED source, so the module's own prose
    // about "no order path" cannot satisfy or trip this.
    const FORBIDDEN = [
      'placeOrder', 'submitOrder', 'cancelOrder', 'OrderIntent',
      'tradier', 'Tradier', 'broker', 'Broker',
      'writeFile', 'appendFile', 'readFile', 'fs.',
      'RiskManager', 'DailyRiskGovernor', 'riskBreaker',
      'applySettings', 'setRiskSize', 'openOption', 'closeOption',
      'process.env',
    ];
    for (const f of FORBIDDEN) expect(masked).not.toContain(f);
  });

  it('is a PURE fold — no clock of its own', () => {
    // The caller supplies `asOfIso`. `new Date()` inside this module would make
    // the same rows yield a different artifact on every call, which is what made
    // the TRA-4914 bootstrap seed load-bearing.
    expect(masked).not.toContain('Date.now(');
    expect(masked).not.toContain('new Date(');
  });

  it('does not re-implement a profit factor', () => {
    // PF / Sharpe / Sortino / drawdown come from `buildMetricsCell` →
    // `summarizeTrades` (TRA-731). A second copy is the TRA-4914 AC violation.
    expect(masked).not.toMatch(/grossWin|grossLoss/);
    expect(masked).toContain('buildMetricsCell');
  });
});

