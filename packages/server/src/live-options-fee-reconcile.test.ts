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

/**
 * TRA-2959 — a CLOSE fill, the actionable population: a close's lot settles on
 * its own clock, so an unmeasured close inside the horizon feeds the stalled
 * alarm (an open with no recorded close is 'awaitingClose' — no lot exists).
 */
function seedCloseFill(over: { ts?: number; etDay?: string; fees?: number | null; optionSymbol?: string } = {}): void {
  recordLiveOptionFill({
    ts: over.ts ?? NOW - 30_000,
    etDay: over.etDay ?? '2026-07-30',
    sleeve: 'single_leg_otm',
    optionSymbol: over.optionSymbol ?? 'AAPL260904P00280000',
    side: 'sell_to_close',
    contracts: 4,
    submittedLimit: 1.2,
    askAtSubmit: 1.22,
    midAtSubmit: 1.2,
    filledPrice: 1.2,
    fees: over.fees === undefined ? null : over.fees,
    orderId: 139511864,
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
  it('is quiescent when nothing is unmeasured AND nothing is recent — the client factory is never invoked', async () => {
    clearLiveOptionsFeeSlippageLedger();
    // TRA-2959 — quiescence needs BOTH: fully measured AND no ledger activity
    // inside the measurable horizon (a recent ledger still gets the hourly
    // coverage cross-check even when every row is measured — the fill coverage
    // exists to find is one the ledger does NOT contain).
    seedOpenFill({ fees: 1.4, etDay: '2026-07-20', ts: NOW - 10 * 86_400_000 });
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
    // TRA-2959 — a CLOSE is the actionable shape ('no-match' evidence); a lone
    // open would read 'no-actionable' (no lot can exist for it yet).
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    // wrong symbol — neither orderId nor composite key matches, and (TRA-2959)
    // a prior-day unmatched HISTORY fill becomes an imported ledger row, so use
    // an equity row the option joins/import must both skip.
    const { client } = fakeClient([histFill({ orderId: 999999999, tradeType: 'equity', symbol: 'ZZZZ' })]);
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
    // TRA-2959 — an unmeasured CLOSE inside the horizon is the actionable
    // population the alarm is keyed on.
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    const { client } = fakeClient([], []); // fetches succeed, nothing ever joins
    const s1 = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s1.lastOutcome).toBe('no-match');
    expect(s1.consecutiveNoMatch).toBe(1);
    expect(s1.stalled).toBe(false);
    expect(s1.unmeasuredActionable).toBe(1);
    await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    const s3 = await runLiveOptionsFeeReconcile(async () => client, NOW + 7_200_000);
    expect(s3.consecutiveNoMatch).toBe(3);
    expect(s3.stalled).toBe(true);
    // a successful back-fill clears it
    const { client: good } = fakeClient(
      [],
      [{
        symbol: 'AAPL260904P00280000',
        quantity: 4,
        cost: 300,
        proceeds: 479.56, // 4 × 1.20 × 100 = 480 gross − 0.44 close-side fees
        gainLoss: 179.56,
        openDate: '2026-07-28',
        closeDate: '2026-07-29',
      }],
    );
    const s4 = await runLiveOptionsFeeReconcile(async () => good, NOW + 10_800_000);
    expect(s4.lastOutcome).toBe('backfilled');
    expect(s4.consecutiveNoMatch).toBe(0);
    expect(s4.stalled).toBe(false);
  });

  it('self-quenches once measured AND out of the horizon; a recent measured ledger still gets the coverage fetch (TRA-2959)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const { client, calls } = fakeClient([histFill()]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(calls).toHaveLength(1);
    // Fully measured but still RECENT: the tick fetches again — that is the
    // coverage cross-check running against a ledger with nothing unmeasured
    // (the one state in which a silently-missing fill would otherwise never
    // be looked for). Outcome stays no-unmeasured.
    const s2 = await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    expect(s2.lastOutcome).toBe('no-unmeasured');
    expect(calls).toHaveLength(2);
    expect(s2.coverage).not.toBeNull();
    expect(s2.coverage!.missingContracts).toBe(0);
    // Once the activity ages past the horizon the pass is fully quiescent.
    const s3 = await runLiveOptionsFeeReconcile(async () => client, NOW + 9 * 86_400_000);
    expect(s3.lastOutcome).toBe('no-unmeasured');
    expect(calls).toHaveLength(2); // no further fetch
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

// ── TRA-2959: coverage cross-check + unmeasured partition ────────────────────
//
// 2026-08-04, live: 7 of 11 filled orders never reached the ledger and
// `appendErrors` read 0 (the writer was never CALLED — a write-failure counter
// cannot count calls that never happen), while `stalled: true` was pinned
// forever by pre-account-migration rows no reconcile can ever measure. These
// tests cover the two answers: broker history as the independent coverage
// denominator (with import), and the actionable/awaitingClose/aged partition
// that gives `stalled` back its meaning.

describe('live-options fee reconcile coverage + partition (TRA-2959)', () => {
  it('imports a prior-day broker fill the ledger is missing, and the gainloss join measures it in the SAME pass', async () => {
    clearLiveOptionsFeeSlippageLedger();
    // The ledger knows the open (recorded at fill time)…
    seedOpenFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    // …but the close went through a path that never called the recorder. The
    // broker's history has it; gainloss has the settled lot.
    const { client } = fakeClient(
      [
        histFill({
          date: '2026-07-29',
          description: 'PUT AAPL   09/04/26   280',
          orderId: null,
          commission: 0,
          quantity: 4,
          price: 1.2,
          amount: 479.56, // positive ⇒ sell_to_close via the amount-sign fallback
          transactionId: 't-close-1',
        }),
      ],
      [{
        symbol: 'AAPL260904P00280000',
        quantity: 4,
        cost: 416.42, // 416.00 gross + 0.42 open fees
        proceeds: 479.56, // 480.00 gross − 0.44 close fees
        gainLoss: 63.14,
        openDate: '2026-07-29',
        closeDate: '2026-07-29',
      }],
    );
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.coverage).not.toBeNull();
    expect(s.coverage!.missingContracts).toBe(4);
    expect(s.coverage!.importedRows).toBe(1);
    expect(s.totalImportedRows).toBe(1);
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.n).toBe(2);
    const imported = summary.records.find((r) => r.side === 'sell_to_close')!;
    expect(imported.origin).toBe('history_import');
    expect(imported.contracts).toBe(4);
    expect(imported.filledPrice).toBeCloseTo(1.2, 6);
    // the close inherits its sleeve from the ledger's own open row
    expect(imported.sleeve).toBe('single_leg_otm');
    // no submit-time quote ⇒ slippage is a NAMED exclusion, not a zero
    expect(imported.slippageVsAsk).toBeNull();
    expect(summary.slippage.nTotal).toBe(2);
    expect(summary.slippage.excludedNoAskQuote).toBe(1);
    // and the same pass derived BOTH legs' fees from the settled lot —
    // the import repaired the group-total reconciliation the missing row broke
    expect(s.lastOutcome).toBe('backfilled');
    expect(summary.feesMeasured).toBe(2);
    expect(summary.records.find((r) => r.side === 'buy_to_open')!.fees).toBeCloseTo(0.42, 6);
    expect(imported.fees).toBeCloseTo(0.44, 6);
  });

  it('does NOT import same-ET-day fills — intraday belongs to the fill-time recorders', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedCloseFill(); // any unmeasured row so the fetch runs; etDay = today
    const { client } = fakeClient([
      histFill({ date: '2026-07-30', symbol: 'TSLA260911C00560000', description: 'CALL TSLA  09/11/26  560', orderId: null, commission: 0, amount: -108 }),
    ]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW); // today ET = 2026-07-30
    expect(s.coverage!.importedRows).toBe(0);
    expect(s.coverage!.missingContracts).toBe(0); // not counted missing — not yet importable
    expect(summarizeLiveOptionsFeeSlippage().n).toBe(1);
  });

  it('an imported row is durable — it survives a rehydrate like any fill', async () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW - 120_000);
    seedOpenFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    const { client } = fakeClient([
      histFill({
        date: '2026-07-29',
        description: 'PUT AAPL   09/04/26   280',
        orderId: null,
        commission: 0,
        quantity: 4,
        price: 1.2,
        amount: 479.56,
        transactionId: 't-close-1',
      }),
    ]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW + 60_000);
    expect(h.records).toBe(2);
    const imported = summarizeLiveOptionsFeeSlippage().records.find((r) => r.side === 'sell_to_close')!;
    expect(imported.origin).toBe('history_import');
  });

  it('idempotent: the pass after an import finds nothing missing and imports nothing', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    const fills = [
      histFill({
        date: '2026-07-29',
        description: 'PUT AAPL   09/04/26   280',
        orderId: null,
        commission: 0,
        quantity: 4,
        price: 1.2,
        amount: 479.56,
        transactionId: 't-close-1',
      }),
    ];
    const { client } = fakeClient(fills);
    const s1 = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s1.coverage!.importedRows).toBe(1);
    const s2 = await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    expect(s2.coverage!.importedRows).toBe(0);
    expect(s2.totalImportedRows).toBe(1); // cumulative, not double-counted
    expect(summarizeLiveOptionsFeeSlippage().n).toBe(2);
  });

  it("partitions the unmeasured set: aged rows read 'no-actionable' and do NOT pin stalled", async () => {
    clearLiveOptionsFeeSlippageLedger();
    // The live 2026-08-05 shape: pre-migration closes 20 days old that this
    // account's gainloss can never report…
    seedCloseFill({ etDay: '2026-07-10', ts: NOW - 20 * 86_400_000, optionSymbol: 'ORCL260821P00100000' });
    const { client } = fakeClient([], []);
    const s1 = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s1.lastOutcome).toBe('no-actionable');
    expect(s1.unmeasuredAged).toBe(1);
    expect(s1.unmeasuredActionable).toBe(0);
    expect(s1.consecutiveNoMatch).toBe(0);
    const s2 = await runLiveOptionsFeeReconcile(async () => client, NOW + 3_600_000);
    const s3 = await runLiveOptionsFeeReconcile(async () => client, NOW + 7_200_000);
    expect(s3.stalled).toBe(false); // 3 fruitless ticks over an aged-only set is NOT a stall
    expect(s2.lastOutcome).toBe('no-actionable');
    // …while an ACTIONABLE row (a fresh close) re-arms the alarm on the same ledger
    seedCloseFill({ etDay: '2026-07-30' });
    const s4 = await runLiveOptionsFeeReconcile(async () => client, NOW + 10_800_000);
    expect(s4.lastOutcome).toBe('no-match');
    expect(s4.unmeasuredActionable).toBe(1);
    expect(s4.unmeasuredAged).toBe(1);
    expect(s4.consecutiveNoMatch).toBe(1);
  });

  it("an unmeasured OPEN with no recorded close is 'awaitingClose' — no lot exists to derive from", async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill({ etDay: '2026-07-20', ts: NOW - 10 * 86_400_000 }); // old, but its position never closed
    const { client } = fakeClient([], []);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('no-actionable');
    expect(s.unmeasuredAwaitingClose).toBe(1);
    expect(s.unmeasuredAged).toBe(0);
    expect(s.stalled).toBe(false);
  });

  it("an old OPEN whose close IS recorded ages from the CLOSE day, so it stays actionable while the lot settles", async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill({ etDay: '2026-07-14', ts: NOW - 16 * 86_400_000 }); // open 16 days ago…
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 }); // …closed yesterday
    const { client } = fakeClient([], []);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('no-match');
    expect(s.unmeasuredActionable).toBe(2); // BOTH legs: settlement clock runs from the close
    expect(s.unmeasuredAged).toBe(0);
  });
});
