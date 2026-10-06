/**
 * TRA-5154 — `no_candidates` split by first-binding reason on the rv_scan path.
 * AC: sum(no_candidates:*) === the census cell's `no_candidates` count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { explainRelativeValueNoCandidates, type OptionChainRow } from '@trading-app/engine';
import { beginRvScan, __resetRvScanTelemetry } from './rv-scan-telemetry.js';
import {
  recordRvScanCensus,
  hydrateRvScanCensusFromDisk,
  summarizeRvScanCensus,
  clearRvScanCensusLedger,
  __setRvScanCensusBootId,
} from './rv-scan-census-ledger.js';

const NOW = Date.parse('2026-10-05T15:00:00Z');
const row = (strike: number, over: Partial<OptionChainRow> = {}): OptionChainRow => ({
  optionSymbol: `X${strike}`, underlying: 'X', optionType: 'call', strike,
  expiration: '2026-11-20', bid: 1.0, ask: 1.04, openInterest: 500, volume: 50, midIv: 0.3,
  ...over,
} as OptionChainRow);

describe('explainRelativeValueNoCandidates', () => {
  it('names the modal first-binding row gate when every row dies at a gate', () => {
    const chain = [row(100, { bid: 1, ask: 2 }), row(101, { bid: 1, ask: 2 }), row(102, { openInterest: 1 })];
    expect(explainRelativeValueNoCandidates(chain, 100, { now: NOW })?.reason).toBe('row_gate:max_spread_pct');
  });
  it('min_group_size when rows survive but no group can fit a skew', () => {
    const r = explainRelativeValueNoCandidates([row(100), row(101)], 100, { now: NOW });
    expect(r?.reason).toBe('min_group_size');
  });
  it('returns null when the scan is not empty (no manufactured diagnosis)', () => {
    const chain = [90, 95, 100, 105, 110].map((k) => row(k));
    expect(explainRelativeValueNoCandidates(chain, 100, { now: NOW })).toBeNull();
  });
  it('covers the two early-out guards', () => {
    expect(explainRelativeValueNoCandidates([], 100)?.reason).toBe('empty_chain');
    expect(explainRelativeValueNoCandidates([row(100)], 0)?.reason).toBe('bad_underlying_price');
  });
});

describe('census cell: sub-reasons sum to the no_candidates bucket', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra5154-'));
    __resetRvScanTelemetry();
    __setRvScanCensusBootId('boot-1');
    hydrateRvScanCensusFromDisk(dir);
  });
  afterEach(() => { clearRvScanCensusLedger(); rmSync(dir, { recursive: true, force: true }); });

  it('sum(no_candidates:*) === rejectionsByGate.no_candidates, and the pass still balances', () => {
    const run = beginRvScan('rv_scan', 4);
    for (let i = 0; i < 4; i++) run.enterSymbol();
    run.rejectSub('no_candidates', 'row_gate:max_spread_pct');
    run.rejectSub('no_candidates', 'row_gate:max_spread_pct');
    run.rejectSub('no_candidates', 'min_group_size');
    run.reject('scan:no_chain');
    const rec = run.finish();
    expect(rec.bucketsBalance).toBe(true);
    recordRvScanCensus({ etDay: '2026-10-05', account: 'admin', accountClass: 'desk', mode: 'live' }, 'rv_scan', rec);
    const c = summarizeRvScanCensus()[0].cells[0];
    const subSum = Object.entries(c.rejectionSubReasons)
      .filter(([k]) => k.startsWith('no_candidates:')).reduce((a, [, n]) => a + n, 0);
    expect(c.rejectionsByGate.no_candidates).toBe(3);
    expect(subSum).toBe(3);
    expect(c.rejectionSubReasons['no_candidates:row_gate:max_spread_pct']).toBe(2);
  });
});
