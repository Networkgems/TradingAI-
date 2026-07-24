// TRA-2208 — the durable PRE-floor credit/width ledger.
//
// The ledger exists because the floor really REMOVES ideas: without a reader the
// slate would just get quietly shorter and the survival rate would be unknowable.
// So the assertions here are about observability, not arithmetic:
//   • `enabled:false` + `slates:0` must stay distinguishable from "nothing rejected"
//   • the rolled-up survival rate is over the PROPOSED credit book
//   • a reboot must not read as a quiet floor (hydrate from JSONL)
//
// Verdicts are produced by the REAL scorer (`evaluateIdeasCreditWidthFloor` from
// @trading-app/agents), never a hand-rolled fixture that would drift from the gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateIdeasCreditWidthFloor,
  DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
  CREDIT_WIDTH_FLOOR_ENABLE_VAR,
} from '@trading-app/agents';
import {
  recordCreditWidthSlate,
  summarizeCreditWidthSlate,
  summarizeOptionsIdeasCreditWidth,
  hydrateOptionsIdeasCreditWidthFromDisk,
  clearOptionsIdeasCreditWidthLedger,
  optionsIdeasCreditWidthLogPath,
} from './options-ideas-credit-width-ledger.js';

const NOW = Date.parse('2026-07-23T18:00:00Z');

/** The measured bqb1 shape: one 0.20 survivor, one 0.03 reject, one unpriced, one debit. */
function shadow() {
  return evaluateIdeasCreditWidthFloor(
    [
      { ticker: 'AAPL', strategy: 'bull_put_spread', creditUsd: 100, maxLossUsd: 400 },
      { ticker: 'MSFT', strategy: 'bull_put_spread', creditUsd: 15, maxLossUsd: 485 },
      { ticker: 'NVDA', strategy: 'bear_call_spread', maxLossUsd: 400 },
      { ticker: 'TSLA', strategy: 'long_call', maxLossUsd: 400 },
    ],
    DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
  );
}

let dir: string;

beforeEach(() => {
  clearOptionsIdeasCreditWidthLedger();
  dir = mkdtempSync(join(tmpdir(), 'cw-ledger-'));
});

afterEach(() => {
  clearOptionsIdeasCreditWidthLedger();
  delete process.env[CREDIT_WIDTH_FLOOR_ENABLE_VAR];
  rmSync(dir, { recursive: true, force: true });
});

describe('summarizeCreditWidthSlate', () => {
  it('is the redaction boundary — counts and config survive, tickers do not', () => {
    const rec = summarizeCreditWidthSlate(shadow(), NOW);
    expect(rec.etDay).toBe('2026-07-23');
    expect(rec.counts).toEqual({ total: 4, credit: 3, pass: 1, reject: 1, unpriced: 1, notCredit: 1 });
    expect(rec.config.minCreditWidth).toBe(0.2);
    expect(JSON.stringify(rec)).not.toContain('AAPL');
    expect(JSON.stringify(rec)).not.toContain('NVDA');
  });

  it('slices counts by structure FAMILY so a failing family is attributable', () => {
    const rec = summarizeCreditWidthSlate(shadow(), NOW);
    expect(rec.byStrategy['bull_put_spread']).toMatchObject({ credit: 2, pass: 1, reject: 1 });
    expect(rec.byStrategy['bear_call_spread']).toMatchObject({ credit: 1, unpriced: 1 });
    expect(rec.byStrategy['long_call']).toMatchObject({ credit: 0, notCredit: 1 });
  });
});

describe('summarizeOptionsIdeasCreditWidth', () => {
  it('reports enabled:false with nothing recorded — NOT "nothing was rejected"', () => {
    const s = summarizeOptionsIdeasCreditWidth(NOW, {});
    expect(s.enabled).toBe(false);
    expect(s.flag).toBe(CREDIT_WIDTH_FLOOR_ENABLE_VAR);
    expect(s.slates).toBe(0);
    // Null, not 0: with no credit idea proposed there is no basis for a rate.
    expect(s.survivalRate).toBeNull();
  });

  it('rolls the survival rate up over the PROPOSED credit book across slates', () => {
    recordCreditWidthSlate(shadow(), NOW);
    recordCreditWidthSlate(shadow(), NOW - 60_000);
    const s = summarizeOptionsIdeasCreditWidth(NOW, { [CREDIT_WIDTH_FLOOR_ENABLE_VAR]: '1' });
    expect(s.enabled).toBe(true);
    expect(s.slates).toBe(2);
    expect(s.counts.credit).toBe(6);
    expect(s.counts.pass).toBe(2);
    // unpriced stays in the denominator — excluding it would flatter the rate.
    expect(s.survivalRate).toBeCloseTo(2 / 6, 10);
    expect(s.stats.priced).toBe(4);
    expect(s.stats.minCreditWidth).toBeCloseTo(0.03, 10);
    expect(s.config!.minCreditWidth).toBe(0.2);
  });

  it('drops slates older than the rolling window', () => {
    recordCreditWidthSlate(shadow(), NOW - 31 * 24 * 60 * 60 * 1000);
    recordCreditWidthSlate(shadow(), NOW);
    const s = summarizeOptionsIdeasCreditWidth(NOW, {});
    expect(s.slates).toBe(1);
  });
});

describe('durability', () => {
  it('survives a reboot — a wiped counter must never read as a quiet floor', () => {
    hydrateOptionsIdeasCreditWidthFromDisk(dir);
    recordCreditWidthSlate(shadow(), NOW);
    expect(readFileSync(optionsIdeasCreditWidthLogPath(dir), 'utf8').trim().split('\n')).toHaveLength(1);

    // Simulate the ~daily bqb1 restart.
    clearOptionsIdeasCreditWidthLedger();
    expect(summarizeOptionsIdeasCreditWidth(NOW, {}).slates).toBe(0);

    const h = hydrateOptionsIdeasCreditWidthFromDisk(dir);
    expect(h).toEqual({ slates: 1, days: 1 });
    expect(summarizeOptionsIdeasCreditWidth(NOW, {}).counts.credit).toBe(3);
  });

  it('skips a torn trailing line rather than aborting the hydrate', () => {
    hydrateOptionsIdeasCreditWidthFromDisk(dir);
    recordCreditWidthSlate(shadow(), NOW);
    const path = optionsIdeasCreditWidthLogPath(dir);
    // Append a half-written record, as a crash mid-append would leave.
    appendFileSync(path, '{"ts":123,"cou', 'utf8');

    clearOptionsIdeasCreditWidthLedger();
    expect(hydrateOptionsIdeasCreditWidthFromDisk(dir).slates).toBe(1);
  });

  it('still rolls up in memory when no DATA_DIR is configured (unit/CLI use)', () => {
    recordCreditWidthSlate(shadow(), NOW);
    const s = summarizeOptionsIdeasCreditWidth(NOW, {});
    expect(s.slates).toBe(1);
    expect(s.durability.dataDir).toBeNull();
  });
});
