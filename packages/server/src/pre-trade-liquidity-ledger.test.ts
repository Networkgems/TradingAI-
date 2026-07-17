import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import {
  PRE_TRADE_LIQUIDITY_FLAG,
  isPreTradeLiquidityEnabled,
  setPreTradeLiquidityLedgerFileForTests,
  initPreTradeLiquidityLedger,
  recordLiquidityGateDecision,
  listLiquidityGateDecisions,
  liquidityGateSummary,
  type LiquidityGateCandidate,
} from './pre-trade-liquidity-ledger.js';

const DAY = Date.UTC(2026, 6, 16); // 2026-07-16
const MIN = 60_000;
const ON = { [PRE_TRADE_LIQUIDITY_FLAG]: 'true' } as NodeJS.ProcessEnv;

/** A tight, deep book — the gate allows full size. */
function allowCandidate(over: Partial<LiquidityGateCandidate> = {}): LiquidityGateCandidate {
  return {
    id: 'AAPL:buy:1',
    ts: DAY + 5 * MIN,
    symbol: 'AAPL',
    engine: 'equity',
    input: { side: 'buy', bid: 99.95, ask: 100.05, orderQty: 100, bidSize: 1e6, askSize: 1e6 },
    ...over,
  };
}

/** A pathologically wide book — spread cost alone vetoes. */
function vetoCandidate(over: Partial<LiquidityGateCandidate> = {}): LiquidityGateCandidate {
  return {
    id: 'XYZ:buy:1',
    ts: DAY + 6 * MIN,
    symbol: 'XYZ',
    engine: 'options',
    input: { side: 'buy', bid: 90, ask: 110, orderQty: 10, bidSize: 100, askSize: 100 },
    ...over,
  };
}

/** Tight spread but the order dwarfs the touch depth — downsize. */
function downsizeCandidate(over: Partial<LiquidityGateCandidate> = {}): LiquidityGateCandidate {
  return {
    id: 'THIN:buy:1',
    ts: DAY + 7 * MIN,
    symbol: 'THIN',
    engine: 'equity',
    input: { side: 'buy', bid: 99.95, ask: 100.05, orderQty: 1000, bidSize: 1000, askSize: 1000 },
    ...over,
  };
}

describe('pre-trade-liquidity-ledger — flag', () => {
  it('is OFF by default and reads the flag from the env', () => {
    expect(isPreTradeLiquidityEnabled({})).toBe(false);
    expect(isPreTradeLiquidityEnabled({ [PRE_TRADE_LIQUIDITY_FLAG]: 'true' })).toBe(true);
    expect(isPreTradeLiquidityEnabled({ [PRE_TRADE_LIQUIDITY_FLAG]: 'on' })).toBe(true);
    expect(isPreTradeLiquidityEnabled({ [PRE_TRADE_LIQUIDITY_FLAG]: '1' })).toBe(true);
    expect(isPreTradeLiquidityEnabled({ [PRE_TRADE_LIQUIDITY_FLAG]: 'off' })).toBe(false);
    expect(isPreTradeLiquidityEnabled({ [PRE_TRADE_LIQUIDITY_FLAG]: 'false' })).toBe(false);
  });
});

describe('pre-trade-liquidity-ledger — durable append-only store', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    n += 1;
    file = join(tmpdir(), `pre-trade-liquidity-test-${process.pid}-${n}.jsonl`);
    try { rmSync(file); } catch { /* fresh */ }
    setPreTradeLiquidityLedgerFileForTests(file);
  });
  afterEach(() => {
    setPreTradeLiquidityLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('FLAG OFF: evaluates but writes nothing (zero behavior change)', async () => {
    await initPreTradeLiquidityLedger();
    const { result, recorded } = await recordLiquidityGateDecision(allowCandidate(), undefined, {});
    expect(result.action).toBe('allow'); // pure gate still evaluates
    expect(recorded).toBe(false); // but nothing persisted
    expect(await listLiquidityGateDecisions()).toHaveLength(0);
  });

  it('FLAG ON: records an allow decision with the modeled cost detail', async () => {
    await initPreTradeLiquidityLedger();
    const { result, recorded } = await recordLiquidityGateDecision(allowCandidate(), undefined, ON);
    expect(recorded).toBe(true);
    expect(result.action).toBe('allow');
    const rows = await listLiquidityGateDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('allow');
    expect(rows[0].reasons).toEqual([]);
    expect(rows[0].symbol).toBe('AAPL');
    expect(rows[0].engine).toBe('equity');
    expect(rows[0].spreadCostBps).toBeCloseTo(5, 6); // half of a 0.10 spread on a 100 mid
    expect(rows[0].impactMeasured).toBe(true);
    expect(rows[0].askSize).toBe(1e6);
  });

  it('records a veto with its reason and a zero size factor', async () => {
    await initPreTradeLiquidityLedger();
    await recordLiquidityGateDecision(vetoCandidate(), undefined, ON);
    const rows = await listLiquidityGateDecisions();
    expect(rows[0].action).toBe('veto');
    expect(rows[0].reasons).toEqual(['SPREAD_TOO_WIDE']);
    expect(rows[0].sizeFactor).toBe(0);
  });

  it('records a downsize with its recommended fraction', async () => {
    await initPreTradeLiquidityLedger();
    const { result } = await recordLiquidityGateDecision(downsizeCandidate(), undefined, ON);
    const rows = await listLiquidityGateDecisions();
    expect(rows[0].action).toBe('downsize');
    expect(rows[0].reasons).toEqual(['THIN_BOOK_DOWNSIZE']);
    expect(rows[0].sizeFactor).toBeGreaterThan(0);
    expect(rows[0].sizeFactor).toBeLessThan(1);
    expect(rows[0].sizeFactor).toBe(result.sizeFactor);
  });

  it('dedupes by id (a per-tick re-fire on the same bar is a no-op)', async () => {
    await initPreTradeLiquidityLedger();
    expect((await recordLiquidityGateDecision(allowCandidate(), undefined, ON)).recorded).toBe(true);
    expect((await recordLiquidityGateDecision(allowCandidate(), undefined, ON)).recorded).toBe(false);
    expect(await listLiquidityGateDecisions()).toHaveLength(1);
  });

  it('windows by ts', async () => {
    await initPreTradeLiquidityLedger();
    await recordLiquidityGateDecision(allowCandidate({ id: 'A:buy:1', ts: DAY + 1 * MIN }), undefined, ON);
    await recordLiquidityGateDecision(allowCandidate({ id: 'A:buy:2', ts: DAY + 10 * MIN }), undefined, ON);
    const windowed = await listLiquidityGateDecisions({ from: DAY + 5 * MIN });
    expect(windowed).toHaveLength(1);
    expect(windowed[0].id).toBe('A:buy:2');
  });

  it('persists across a reload (append-only, folded by id)', async () => {
    await initPreTradeLiquidityLedger();
    await recordLiquidityGateDecision(allowCandidate(), undefined, ON);
    // Force a fresh in-memory cache off the same file.
    setPreTradeLiquidityLedgerFileForTests(file);
    await initPreTradeLiquidityLedger();
    expect(await listLiquidityGateDecisions()).toHaveLength(1);
  });
});

describe('liquidityGateSummary', () => {
  it('is empty-safe (null rates, zeroed reason counts)', () => {
    const s = liquidityGateSummary([]);
    expect(s.total).toBe(0);
    expect(s.vetoRate).toBeNull();
    expect(s.interventionRate).toBeNull();
    expect(s.meanTotalCostBps).toBeNull();
    expect(s.medianTotalCostBps).toBeNull();
    expect(s.reasonCounts).toEqual({
      UNUSABLE_QUOTE: 0,
      SPREAD_TOO_WIDE: 0,
      THIN_BOOK_DOWNSIZE: 0,
      THIN_BOOK_VETO: 0,
    });
  });

  it('computes action-mix, intervention rate, cost stats, and per-engine split', async () => {
    const sumFile = join(tmpdir(), `pre-trade-liquidity-sum-${process.pid}.jsonl`);
    try { rmSync(sumFile); } catch { /* fresh */ }
    setPreTradeLiquidityLedgerFileForTests(sumFile);
    await initPreTradeLiquidityLedger();
    await recordLiquidityGateDecision(allowCandidate({ id: 'a1' }), undefined, ON);
    await recordLiquidityGateDecision(vetoCandidate({ id: 'v1' }), undefined, ON); // options
    await recordLiquidityGateDecision(downsizeCandidate({ id: 'd1' }), undefined, ON); // equity
    const s = liquidityGateSummary(await listLiquidityGateDecisions());
    setPreTradeLiquidityLedgerFileForTests(null);
    try { rmSync(sumFile); } catch { /* ignore */ }

    expect(s.total).toBe(3);
    expect(s.allowed).toBe(1);
    expect(s.downsized).toBe(1);
    expect(s.vetoed).toBe(1);
    expect(s.vetoRate).toBeCloseTo(1 / 3, 6);
    expect(s.interventionRate).toBeCloseTo(2 / 3, 6);
    expect(s.reasonCounts.SPREAD_TOO_WIDE).toBe(1);
    expect(s.reasonCounts.THIN_BOOK_DOWNSIZE).toBe(1);
    expect(s.byEngine.equity.total).toBe(2);
    expect(s.byEngine.equity.allowed).toBe(1);
    expect(s.byEngine.equity.downsized).toBe(1);
    expect(s.byEngine.options.vetoed).toBe(1);
    expect(s.meanTotalCostBps).not.toBeNull();
    expect(s.medianTotalCostBps).not.toBeNull();
  });
});
