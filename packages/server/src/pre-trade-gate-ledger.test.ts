import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import {
  PRE_TRADE_GATE_FLAG,
  isPreTradeGateEnabled,
  setPreTradeGateLedgerFileForTests,
  initPreTradeGateLedger,
  recordPreTradeGateDecision,
  listPreTradeGateDecisions,
  preTradeGateSummary,
  type PreTradeGateCandidate,
} from './pre-trade-gate-ledger.js';

const DAY = Date.UTC(2026, 6, 8); // 2026-07-08
const MIN = 60_000;
const ON = { [PRE_TRADE_GATE_FLAG]: 'true' } as NodeJS.ProcessEnv;

/** A candidate that clears every gate rule (long, aligned, high RVOL, wide target). */
function passCandidate(over: Partial<PreTradeGateCandidate> = {}): PreTradeGateCandidate {
  return {
    id: 'AAPL:long:1',
    ts: DAY + 5 * MIN,
    symbol: 'AAPL',
    engine: 'equity',
    input: { entry: 100, direction: 'long', atr: 1, mtfTrend: 1, rvol: 1.5, target: 103 },
    ...over,
  };
}

/** A candidate that fails MTF + RVOL (down trend, thin volume). */
function failCandidate(over: Partial<PreTradeGateCandidate> = {}): PreTradeGateCandidate {
  return {
    id: 'TSLA:long:1',
    ts: DAY + 6 * MIN,
    symbol: 'TSLA',
    engine: 'equity',
    input: { entry: 100, direction: 'long', atr: 1, mtfTrend: -1, rvol: 0.5, target: 103 },
    ...over,
  };
}

describe('pre-trade-gate-ledger — flag', () => {
  it('is OFF by default and reads the flag from the env', () => {
    expect(isPreTradeGateEnabled({})).toBe(false);
    expect(isPreTradeGateEnabled({ [PRE_TRADE_GATE_FLAG]: 'true' })).toBe(true);
    expect(isPreTradeGateEnabled({ [PRE_TRADE_GATE_FLAG]: 'on' })).toBe(true);
    expect(isPreTradeGateEnabled({ [PRE_TRADE_GATE_FLAG]: '1' })).toBe(true);
    expect(isPreTradeGateEnabled({ [PRE_TRADE_GATE_FLAG]: 'off' })).toBe(false);
    expect(isPreTradeGateEnabled({ [PRE_TRADE_GATE_FLAG]: 'false' })).toBe(false);
  });
});

describe('pre-trade-gate-ledger — durable append-only store', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    n += 1;
    file = join(tmpdir(), `pre-trade-gate-test-${process.pid}-${n}.jsonl`);
    try { rmSync(file); } catch { /* fresh */ }
    setPreTradeGateLedgerFileForTests(file);
  });
  afterEach(() => {
    setPreTradeGateLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('FLAG OFF: evaluates but writes nothing (zero behavior change)', async () => {
    await initPreTradeGateLedger();
    const { result, recorded } = await recordPreTradeGateDecision(
      passCandidate(),
      undefined,
      {}, // flag off
    );
    expect(result.pass).toBe(true); // pure gate still evaluates
    expect(recorded).toBe(false); // but nothing persisted
    expect(await listPreTradeGateDecisions()).toHaveLength(0);
  });

  it('FLAG ON: records a decision row with the verdict + derived detail', async () => {
    await initPreTradeGateLedger();
    const { result, recorded } = await recordPreTradeGateDecision(passCandidate(), undefined, ON);
    expect(recorded).toBe(true);
    expect(result.pass).toBe(true);
    const rows = await listPreTradeGateDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe(true);
    expect(rows[0].reasons).toEqual([]);
    expect(rows[0].symbol).toBe('AAPL');
    expect(rows[0].engine).toBe('equity');
    expect(rows[0].stopDistance).toBeCloseTo(1.5, 10);
    expect(rows[0].rewardRisk).toBeCloseTo(2.0, 10);
  });

  it('records rejection reasons for a failing candidate', async () => {
    await initPreTradeGateLedger();
    await recordPreTradeGateDecision(failCandidate(), undefined, ON);
    const rows = await listPreTradeGateDecisions();
    expect(rows[0].pass).toBe(false);
    expect(new Set(rows[0].reasons)).toEqual(
      new Set(['MTF_MISALIGNED', 'RVOL_BELOW_THRESHOLD']),
    );
  });

  it('dedupes by id (a per-tick re-fire on the same bar is a no-op)', async () => {
    await initPreTradeGateLedger();
    expect((await recordPreTradeGateDecision(passCandidate(), undefined, ON)).recorded).toBe(true);
    expect((await recordPreTradeGateDecision(passCandidate(), undefined, ON)).recorded).toBe(false);
    expect(await listPreTradeGateDecisions()).toHaveLength(1);
  });

  it('windows by ts', async () => {
    await initPreTradeGateLedger();
    await recordPreTradeGateDecision(passCandidate({ id: 'A:long:1', ts: DAY + 1 * MIN }), undefined, ON);
    await recordPreTradeGateDecision(passCandidate({ id: 'A:long:2', ts: DAY + 10 * MIN }), undefined, ON);
    const windowed = await listPreTradeGateDecisions({ from: DAY + 5 * MIN });
    expect(windowed).toHaveLength(1);
    expect(windowed[0].id).toBe('A:long:2');
  });
});

describe('preTradeGateSummary', () => {
  it('is empty-safe (null pass-rate, zeroed reason counts)', () => {
    const s = preTradeGateSummary([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBeNull();
    expect(s.reasonCounts).toEqual({
      MTF_MISALIGNED: 0,
      RVOL_BELOW_THRESHOLD: 0,
      RR_BELOW_MIN: 0,
      ATR_STOP_MISSING: 0,
    });
  });

  it('computes pass-rate, per-reason counts, and per-engine split', async () => {
    setPreTradeGateLedgerFileForTests(join(tmpdir(), `pre-trade-gate-sum-${process.pid}.jsonl`));
    try { rmSync(join(tmpdir(), `pre-trade-gate-sum-${process.pid}.jsonl`)); } catch { /* fresh */ }
    await initPreTradeGateLedger();
    await recordPreTradeGateDecision(passCandidate({ id: 'p1' }), undefined, ON);
    await recordPreTradeGateDecision(failCandidate({ id: 'f1' }), undefined, ON);
    await recordPreTradeGateDecision(
      failCandidate({ id: 'f2', engine: 'crypto', input: { entry: 100, direction: 'long', atr: 0, mtfTrend: 1, rvol: 1.5, target: 103 } }),
      undefined,
      ON,
    );
    const s = preTradeGateSummary(await listPreTradeGateDecisions());
    setPreTradeGateLedgerFileForTests(null);

    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(2);
    expect(s.passRate).toBeCloseTo(1 / 3, 10);
    // f1 cites MTF+RVOL; f2 (atr 0) cites ATR_STOP_MISSING + RR_BELOW_MIN.
    expect(s.reasonCounts.MTF_MISALIGNED).toBe(1);
    expect(s.reasonCounts.RVOL_BELOW_THRESHOLD).toBe(1);
    expect(s.reasonCounts.ATR_STOP_MISSING).toBe(1);
    expect(s.reasonCounts.RR_BELOW_MIN).toBe(1);
    expect(s.byEngine.equity).toEqual({ total: 2, passed: 1 });
    expect(s.byEngine.crypto).toEqual({ total: 1, passed: 0 });
  });
});
