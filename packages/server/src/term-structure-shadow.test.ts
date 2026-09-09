import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TermStructureReport } from '@trading-app/engine';
import {
  TERM_STRUCTURE_SHADOW_FLAG,
  TERM_SHADOW_MIN_INTERVAL_MS,
  isTermStructureShadowEnabled,
  maybeCaptureTermStructureShadow,
  summarizeTermStructureShadow,
  __resetTermStructureShadow,
} from './term-structure-shadow.js';
import type { RelativeValueScannerService, TermStructureScanResult } from './relative-value-scanner.js';

// TRA-4413 item 4 — the server shadow seam: flag gating, per-symbol throttle,
// counter accumulation, and the negative-control invalidation rule. The engine
// fold and the scanner transport carry their own suites.

const ON_ENV = { [TERM_STRUCTURE_SHADOW_FLAG]: '1' } as NodeJS.ProcessEnv;
const OFF_ENV = {} as NodeJS.ProcessEnv;
const NOW = Date.parse('2026-09-09T14:00:00Z');

function report(overrides: Partial<TermStructureReport> = {}): TermStructureReport {
  return {
    rowsIn: 40,
    rowsPrepared: 30,
    rowsEvaluated: 24,
    bucketsTotal: 5,
    bucketsFitted: 3,
    bucketsSkipped: [
      { bucketKey: 'call|0.6', reason: 'insufficient_expirations', rows: 4, distinctExpirations: 2 },
      { bucketKey: 'put|0.1', reason: 'degenerate_time_axis', rows: 3, distinctExpirations: 3 },
    ],
    bucketFits: [],
    dislocations: [
      dislocation('term_cheap'),
      dislocation('term_rich'),
      dislocation('term_cheap'),
    ],
    calendarPairsTested: 12,
    markCalendarViolations: [],
    ...overrides,
  };
}

function dislocation(classification: 'term_cheap' | 'term_rich') {
  return {
    optionSymbol: 'TEST240315C00100000',
    underlying: 'TEST',
    optionType: 'call' as const,
    strike: 100,
    expiration: '2026-10-16',
    daysToExpiration: 37,
    deltaBucket: 0.3,
    absDelta: 0.34,
    ivUsed: 0.31,
    ivFittedTerm: 0.35,
    ivResidualTerm: -0.04,
    zScoreTerm: classification === 'term_cheap' ? -2.4 : 2.4,
    classification,
    bucketKey: 'call|0.3',
  };
}

function okResult(overrides: Partial<TermStructureScanResult> = {}): TermStructureScanResult {
  return {
    symbol: 'TEST',
    spot: 100,
    expirations: ['2026-10-02', '2026-10-16', '2026-11-20'],
    report: report(),
    reason: 'ok',
    ...overrides,
  };
}

function fakeScanner(result: TermStructureScanResult): {
  scanner: RelativeValueScannerService;
  scanTermStructure: ReturnType<typeof vi.fn>;
} {
  const scanTermStructure = vi.fn(async () => result);
  const scanner = { scanTermStructure } as unknown as RelativeValueScannerService;
  return { scanner, scanTermStructure };
}

beforeEach(() => {
  __resetTermStructureShadow();
});

describe('isTermStructureShadowEnabled', () => {
  it('defaults OFF and honours the usual truthy spellings', () => {
    expect(isTermStructureShadowEnabled(OFF_ENV)).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isTermStructureShadowEnabled({ [TERM_STRUCTURE_SHADOW_FLAG]: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    expect(isTermStructureShadowEnabled({ [TERM_STRUCTURE_SHADOW_FLAG]: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('maybeCaptureTermStructureShadow', () => {
  it('does nothing — not even a scanner call — when the flag is off', async () => {
    const { scanner, scanTermStructure } = fakeScanner(okResult());
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: OFF_ENV, now: NOW });
    expect(scanTermStructure).not.toHaveBeenCalled();
    expect(summarizeTermStructureShadow(OFF_ENV).scans).toBe(0);
  });

  it('accumulates finding and refusal counters from a clean scan', async () => {
    const { scanner } = fakeScanner(okResult());
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW, spot: 100 });
    const s = summarizeTermStructureShadow(ON_ENV);
    expect(s.scans).toBe(1);
    expect(s.scansByReason.ok).toBe(1);
    expect(s.rowsEvaluated).toBe(24);
    expect(s.bucketsFitted).toBe(3);
    expect(s.dislocationsByClass).toEqual({ term_cheap: 2, term_rich: 1 });
    expect(s.bucketSkipsByReason).toEqual({ insufficient_expirations: 1, degenerate_time_axis: 1 });
    expect(s.calendarPairsTested).toBe(12);
    expect(s.invalidatedScans).toBe(0);
    expect(s.recentDislocations).toHaveLength(3);
    expect(s.lastScan?.symbol).toBe('TEST');
  });

  it('counts a failed scan under its reason without touching finding counters', async () => {
    const { scanner } = fakeScanner(okResult({ reason: 'breaker_open', report: null, expirations: [] }));
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW });
    const s = summarizeTermStructureShadow(ON_ENV);
    expect(s.scans).toBe(1);
    expect(s.scansByReason.breaker_open).toBe(1);
    expect(s.rowsEvaluated).toBe(0);
    expect(s.dislocationsByClass).toEqual({ term_cheap: 0, term_rich: 0 });
  });

  it('NEGATIVE CONTROL: a mark-calendar violation voids the scan findings but publishes loudly', async () => {
    const { scanner } = fakeScanner(
      okResult({
        report: report({
          markCalendarViolations: [
            {
              optionType: 'call',
              strike: 100,
              shortExpiration: '2026-10-02',
              longExpiration: '2026-10-16',
              shortMark: 3.1,
              longMark: 2.9,
              shortSymbol: 'S',
              longSymbol: 'L',
            },
          ],
        }),
      }),
    );
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW });
    const s = summarizeTermStructureShadow(ON_ENV);
    // The violation and the invalidation are COUNTED…
    expect(s.markCalendarViolations).toBe(1);
    expect(s.invalidatedScans).toBe(1);
    expect(s.lastViolationAt).not.toBeNull();
    // …and the voided scan's dislocations are NOT folded into the findings.
    expect(s.dislocationsByClass).toEqual({ term_cheap: 0, term_rich: 0 });
    expect(s.recentDislocations).toHaveLength(0);
  });

  it('throttles per symbol and counts the suppression', async () => {
    const { scanner, scanTermStructure } = fakeScanner(okResult());
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW });
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW + 60_000 });
    expect(scanTermStructure).toHaveBeenCalledTimes(1);
    // A different symbol is not throttled by TEST's stamp.
    await maybeCaptureTermStructureShadow({ symbol: 'OTHER', scanner, env: ON_ENV, now: NOW + 60_000 });
    expect(scanTermStructure).toHaveBeenCalledTimes(2);
    // And TEST recaptures once its own interval has elapsed.
    await maybeCaptureTermStructureShadow({
      symbol: 'TEST', scanner, env: ON_ENV, now: NOW + TERM_SHADOW_MIN_INTERVAL_MS,
    });
    expect(scanTermStructure).toHaveBeenCalledTimes(3);
    expect(summarizeTermStructureShadow(ON_ENV).throttledSkips).toBe(1);
  });

  it('counts a scanner without the capability instead of throwing', async () => {
    const scanner = {} as RelativeValueScannerService;
    await maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW });
    expect(summarizeTermStructureShadow(ON_ENV).unsupportedScanner).toBe(1);
  });

  it('swallows and counts a throwing scanner (never propagates into the scan loop)', async () => {
    const scanTermStructure = vi.fn(async () => { throw new Error('boom'); });
    const scanner = { scanTermStructure } as unknown as RelativeValueScannerService;
    await expect(
      maybeCaptureTermStructureShadow({ symbol: 'TEST', scanner, env: ON_ENV, now: NOW }),
    ).resolves.toBeUndefined();
    expect(summarizeTermStructureShadow(ON_ENV).errors).toBe(1);
  });
});
