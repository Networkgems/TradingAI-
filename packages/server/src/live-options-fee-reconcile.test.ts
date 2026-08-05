import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runLiveOptionsFeeReconcile,
  getLiveOptionsFeeReconcileState,
  clearLiveOptionsFeeReconcileState,
  type FeeReconcileHistoryClient,
} from './live-options-fee-reconcile.js';
import {
  recordLiveOptionFill,
  hydrateLiveOptionsFeeSlippageFromDisk,
  summarizeLiveOptionsFeeSlippage,
  clearLiveOptionsFeeSlippageLedger,
} from './live-options-fee-slippage-ledger.js';
import type { TradierTradeHistoryFill, TradierGainLossLot } from '@trading-app/engine';

// TRA-2810 (parents TRA-2536 / TRA-1929) — the AUTOMATIC fee back-fill pass.
// Two real-money windows ended feesMeasured 0/n because the TRA-1954 join only
// existed behind an unreachable admin POST. These tests cover the self-driving
// pass: quiescence (no broker call when nothing is unmeasured), the window
// derivation, the join + durable rewrite, every failure outcome, and — because
// a unit test on the module cannot see whether the scheduler actually calls it
// (TRA-2650: the defect can live in the caller, upstream of every test) — a
// source-level assertion that the boot kick, the hourly tick, and the health
// payload are all wired.

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tra2810-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  clearLiveOptionsFeeReconcileState();
  clearLiveOptionsFeeSlippageLedger();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Noon ET on 2026-07-30 — a fixed "now" so etDateString is deterministic. */
const NOW = Date.parse('2026-07-30T16:00:00Z');

function seedOpenFill(over: { ts?: number; etDay?: string; fees?: number | null } = {}): void {
  recordLiveOptionFill({
    ts: over.ts ?? NOW - 60_000,
    etDay: over.etDay ?? '2026-07-30',
    sleeve: 'single_leg_otm',
    optionSymbol: 'AAPL260904P00280000',
    side: 'buy_to_open',
    contracts: 4,
    submittedLimit: 1.04,
    askAtSubmit: 1.04,
    midAtSubmit: 0.985,
    filledPrice: 1.04,
    fees: over.fees === undefined ? null : over.fees,
    orderId: 139283844,
  });
}

function histFill(over: Partial<TradierTradeHistoryFill> = {}): TradierTradeHistoryFill {
  return {
    date: '2026-07-30',
    symbol: 'AAPL260904P00280000',
    tradeType: 'option',
    description: 'Buy to Open 4 AAPL260904P00280000 @ 1.04',
    price: 1.04,
    quantity: 4,
    amount: -416,
    commission: 1.4,
    transactionId: 't1',
    orderId: 139283844, // matches seedOpenFill — production history carries order_id
    ...over,
  };
}

function fakeClient(fills: TradierTradeHistoryFill[], lots: TradierGainLossLot[] = []): {
  client: FeeReconcileHistoryClient;
  calls: { start: string; end: string; limit?: number; type?: string }[];
  gainLossCalls: { start: string; end: string; limit?: number }[];
} {
  const calls: { start: string; end: string; limit?: number; type?: string }[] = [];
  const gainLossCalls: { start: string; end: string; limit?: number }[] = [];
  return {
    calls,
    gainLossCalls,
    client: {
      listAccountHistory: async (options) => {
        calls.push(options);
        return fills;
      },
      listGainLoss: async (options) => {
        gainLossCalls.push(options);
        return lots;
      },
    },
  };
}

describe('live-options fee auto-reconcile (TRA-2810)', () => {
  it('is quiescent when nothing is unmeasured — the client factory is never invoked', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill({ fees: 1.4 }); // already measured
    let factoryCalls = 0;
    const s = await runLiveOptionsFeeReconcile(async () => {
      factoryCalls += 1;
      return fakeClient([]).client;
    }, NOW);
    expect(s.lastOutcome).toBe('no-unmeasured');
    expect(s.ticks).toBe(1);
    expect(s.attempts).toBe(0);
    expect(factoryCalls).toBe(0); // no settings read, no broker call
  });

  it('back-fills an unmeasured row from history and records backfilled provenance', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const { client, calls } = fakeClient([histFill()]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.attempts).toBe(1);
    expect(s.lastUpdated).toBe(1);
    expect(s.totalUpdated).toBe(1);
    expect(s.lastHistoryFills).toBe(1);
    expect(calls).toHaveLength(1);
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.feesMeasured).toBe(1);
    expect(summary.totalFees).toBeCloseTo(1.4, 6);
  });

  it('derives the fetch window from the earliest unmeasured etDay through today', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill({ etDay: '2026-07-28', ts: NOW - 2 * 86_400_000 });
    seedOpenFill({ etDay: '2026-07-30' });
    const { client, calls } = fakeClient([]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.start).toBe('2026-07-28');
    expect(calls[0]!.end).toBe('2026-07-30'); // today ET at NOW, not max etDay
    expect(calls[0]!.type).toBe('trade');
  });

  it('a fetched history with no join leaves rows null (never 0) and reads no-match', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    // wrong orderId AND wrong symbol — neither orderId nor composite key matches
    const { client } = fakeClient([histFill({ orderId: 999999999, symbol: 'ZZZZZ260101C00001000' })]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('no-match');
    expect(s.lastUpdated).toBe(0);
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.feesMeasured).toBe(0);
    expect(summary.records[0]!.fees).toBeNull(); // unmeasured ⇒ null, NEVER 0 (TRA-1707)
    expect(summary.totalFees).toBeNull();
  });

  it('reads no-client (and does not throw) when no production creds resolve', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const s = await runLiveOptionsFeeReconcile(async () => null, NOW);
    expect(s.lastOutcome).toBe('no-client');
    expect(summarizeLiveOptionsFeeSlippage().records[0]!.fees).toBeNull();
  });

  it('captures a client-factory throw as no-client with the reason preserved', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const s = await runLiveOptionsFeeReconcile(async () => {
      throw new Error('settings store unreachable');
    }, NOW);
    expect(s.lastOutcome).toBe('no-client');
    expect(s.lastError).toBe('settings store unreachable');
  });

  it('captures a both-fetches throw as fetch-failed and never throws into the tick', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const client: FeeReconcileHistoryClient = {
      listAccountHistory: async () => {
        throw new Error('502 from Tradier');
      },
      listGainLoss: async () => {
        throw new Error('503 from Tradier');
      },
    };
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('fetch-failed');
    expect(s.lastError).toContain('502 from Tradier');
    expect(s.lastError).toContain('503 from Tradier');
    expect(summarizeLiveOptionsFeeSlippage().records[0]!.fees).toBeNull();
  });

  it('a history outage does not stop the gainloss derivation — and the error is still recorded (TRA-2850)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill(); // 4 contracts @ 1.04 = 416.00 gross
    const client: FeeReconcileHistoryClient = {
      listAccountHistory: async () => {
        throw new Error('502 from Tradier');
      },
      listGainLoss: async () => [
        {
          symbol: 'AAPL260904P00280000',
          quantity: 4,
          cost: 416.44, // 416.00 gross + 0.44 open-side fees
          proceeds: 500,
          gainLoss: 83.56,
          openDate: '2026-07-30',
          closeDate: '2026-07-30',
        },
      ],
    };
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.lastGainLossUpdated).toBe(1);
    // partial failure must not self-report clean
    expect(s.lastError).toBe('502 from Tradier');
    const rec = summarizeLiveOptionsFeeSlippage().records[0]!;
    expect(rec.fees).toBeCloseTo(0.44, 6);
    expect(rec.feeSource).toBe('gainloss_derived');
  });

  it('derives real fees from settled gainloss lots when history commission is 0 — the TRA-2850 production shape', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill(); // buy_to_open 4 @ 1.04
    // Production history: orderId null, commission 0 — the join must NOT write a false $0.
    const { client } = fakeClient(
      [histFill({ orderId: null, commission: 0, description: 'PUT AAPL   09/04/26   280', amount: -416 })],
      [{
        symbol: 'AAPL260904P00280000',
        quantity: 4,
        cost: 416.42,
        proceeds: 900,
        gainLoss: 483.58,
        openDate: '2026-07-30',
        closeDate: '2026-07-30',
      }],
    );
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.lastUpdated).toBe(1);
    // the commission join saw the zero-commission fill and correctly counted it un-joinable
    expect(s.lastJoinableCount).toBe(0);
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.feesMeasured).toBe(1);
    expect(summary.feesBySource.gainlossDerived).toBe(1);
    expect(summary.records[0]!.fees).toBeCloseTo(0.42, 6);
  });

  it('flips stalled after three consecutive no-match attempts — the non-green state (TRA-2850)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const { client } = fakeClient([], []); // fetches succeed, nothing ever joins
    const s1 = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s1.lastOutcome).toBe('no-match');
    expect(s1.consecutiveNoMatch).toBe(1);
    expect(s1.stalled).toBe(false);
    await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    const s3 = await runLiveOptionsFeeReconcile(async () => client, NOW + 7_200_000);
    expect(s3.consecutiveNoMatch).toBe(3);
    expect(s3.stalled).toBe(true);
    // a successful back-fill clears it
    const { client: good } = fakeClient([histFill()]);
    const s4 = await runLiveOptionsFeeReconcile(async () => good, NOW + 10_800_000);
    expect(s4.lastOutcome).toBe('backfilled');
    expect(s4.consecutiveNoMatch).toBe(0);
    expect(s4.stalled).toBe(false);
  });

  it('self-quenches: after a full back-fill the next tick makes no broker call', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const { client, calls } = fakeClient([histFill()]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(calls).toHaveLength(1);
    const s2 = await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    expect(s2.lastOutcome).toBe('no-unmeasured');
    expect(calls).toHaveLength(1); // no second fetch
    expect(s2.ticks).toBe(2);
    expect(s2.attempts).toBe(1);
  });

  it('the back-fill is durable — a rehydrate from disk keeps the fees', async () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW - 120_000);
    seedOpenFill();
    const { client } = fakeClient([histFill()]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    // simulate the next redeploy's boot
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW + 60_000);
    expect(h.records).toBe(1);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBeCloseTo(1.4, 6);
    expect(s.feesMeasured).toBe(1);
  });

  // ── Caller wiring (TRA-2650: a module test cannot see an unwired caller) ────
  //
  // The zero state this whole ticket exists to kill — feesMeasured 0/n forever —
  // is exactly what a green module suite over an UNWIRED pass would produce. So
  // assert the three call sites in source: the boot kick and the hourly tick in
  // index.ts, and the provenance field in the health payload.

  const here = dirname(fileURLToPath(import.meta.url));

  it('index.ts wires the pass into both the boot kick and the hourly tick', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const calls = src.match(/runLiveOptionsFeeReconcile\s*\(/g) ?? [];
    // ≥1 import + 2 call sites; assert on the call sites specifically.
    expect(src).toContain("from './live-options-fee-reconcile.js'");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // the boot kick must not hold the process open
    expect(src).toMatch(/runLiveOptionsFeeReconcile[\s\S]{0,200}?\.unref\(\)/);
  });

  it('the health payload publishes the autoReconcile provenance', () => {
    const src = readFileSync(join(here, 'observability', 'health-routes.ts'), 'utf8');
    expect(src).toContain('getLiveOptionsFeeReconcileState');
    expect(src).toMatch(/autoReconcile:\s*getLiveOptionsFeeReconcileState\(\)/);
  });
});
