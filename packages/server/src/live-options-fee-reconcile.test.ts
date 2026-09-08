import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  runLiveOptionsFeeReconcile,
  getLiveOptionsFeeReconcileState,
  clearLiveOptionsFeeReconcileState,
  detectPdtDayTradeLots,
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
    // partial failure must not self-report clean (TRA-4295: named per source)
    expect(s.lastError).toBe('history: 502 from Tradier');
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

  // ── TRA-3558: the gainloss join must be as instrumented as the commission one ──
  //
  // TRA-3554 residual: `lastHistorySample` shipped for the COMMISSION join,
  // which is structurally dead in production (commission is 0 on every row),
  // while the GAINLOSS join — which measures every real fee — published only a
  // bare lot COUNT. A 'no-match' was therefore a dead end from the health route.

  it('publishes the RAW gainloss lots pre-filter, so an ABSENT lot is distinguishable from a MIS-KEYED one (TRA-3558)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    seedCloseFill();
    // A lot that is PRESENT in the fetch but keyed to a day the ledger has no
    // row for: the join rejects it, and only the raw sample can say so.
    const misKeyed: TradierGainLossLot = {
      symbol: 'AAPL260904P00280000',
      quantity: 4,
      cost: 416.44,
      proceeds: 479.56,
      gainLoss: 63.12,
      openDate: '2026-07-29',
      closeDate: '2026-07-29',
    };
    const { client } = fakeClient([], [misKeyed]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('no-match');
    expect(s.lastGainLossLots).toBe(1);
    expect(s.lastGainLossSample).toEqual([
      {
        symbol: 'AAPL260904P00280000',
        quantity: 4,
        cost: 416.44,
        proceeds: 479.56,
        openDate: '2026-07-29',
        closeDate: '2026-07-29',
        book: null,
      },
    ]);
  });

  it("names the rejection reason per group instead of a bare 'no-match' (TRA-3558)", async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    seedCloseFill();
    const { client } = fakeClient([], []); // fetch succeeded, returned nothing
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('no-match');
    expect(s.lastGainLossRejections).not.toBeNull();
    // Both unmeasured groups (the open and the close) are named, not counted.
    expect(s.lastGainLossRejections!.length).toBe(2);
    for (const rej of s.lastGainLossRejections!) {
      expect(rej.reason).toBe('no-lot');
      expect(rej.observed).toBe(0);
      expect(rej.expected).toBe(4); // contracts the ledger holds
      expect(rej.detail).toContain(rej.symbol);
    }
    expect(s.lastGainLossRejectionCounts).toEqual({
      'no-lot': 2,
      'priceless-row': 0,
      'qty-mismatch': 0,
      'negative-fee': 0,
      'above-bound': 0,
    });
  });

  it('clears the rejections when the join actually measures the rows (TRA-3558)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const settled: TradierGainLossLot = {
      symbol: 'AAPL260904P00280000',
      quantity: 4,
      cost: 416.44, // 416.00 gross + 0.44
      proceeds: 479.56,
      gainLoss: 63.12,
      openDate: '2026-07-30',
      closeDate: '2026-07-31',
    };
    const { client } = fakeClient([], [settled]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.lastGainLossRejections).toEqual([]);
    expect(s.lastGainLossRejectionCounts!['no-lot']).toBe(0);
  });

  it('the published state is a COPY — a caller cannot mutate the pass through it (TRA-3558)', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    seedCloseFill();
    const { client } = fakeClient([], []);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    const first = getLiveOptionsFeeReconcileState();
    first.lastGainLossRejections!.length = 0;
    first.lastGainLossSample = null;
    expect(getLiveOptionsFeeReconcileState().lastGainLossRejections!.length).toBe(2);
  });
});

// TRA-4143 — the confirmed 2026-08-04 PLTR260911C00170000 same-day round trip
// (broker /gainloss: open_date === close_date, term 0) was closed OUT-OF-BAND,
// so holdLiveOptionsOvernightForPdt — engine-fired exits only — never saw it,
// and the ledger's fabricated import timestamps made an etDay-keyed detector
// undecidable in both directions (it manufactured the 08-24 RIG false pair AND
// could not confirm the true PLTR one). The decidable discriminator is the
// broker's own lot pairing, which this pass already fetches.
describe('PDT day-trade detection off broker gainloss lots (TRA-4143)', () => {
  function lot(over: Partial<TradierGainLossLot> = {}): TradierGainLossLot {
    return {
      symbol: 'PLTR260911C00170000',
      quantity: 1,
      cost: 444.11,
      proceeds: 599.86,
      gainLoss: 155.75,
      openDate: '2026-08-04',
      closeDate: '2026-08-04',
      ...over,
    };
  }

  it('detects a same-day lot and passes multi-day lots — including ISO-stamped dates', () => {
    const sameDay = lot();
    const isoSameDay = lot({ openDate: '2026-08-04T00:00:00.000Z', closeDate: '2026-08-04T00:00:00.000Z' });
    const overnight = lot({ openDate: '2026-08-04', closeDate: '2026-08-05' });
    expect(detectPdtDayTradeLots([sameDay, isoSameDay, overnight])).toEqual([sameDay, isoSameDay]);
  });

  it('an empty/absent open date never pairs — absent must not resolve to a value that matches', () => {
    expect(detectPdtDayTradeLots([lot({ openDate: '', closeDate: '' })])).toEqual([]);
  });

  it('is null before any gainloss fetch — undetected must never read as a measured zero', async () => {
    const s = getLiveOptionsFeeReconcileState();
    expect(s.lastPdtDayTradeCount).toBeNull();
    expect(s.lastPdtDayTradeLots).toBeNull();
  });

  it('stays null when the gainloss fetch fails even though history survived', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    const client: FeeReconcileHistoryClient = {
      listAccountHistory: async () => [],
      listGainLoss: async () => { throw new Error('503 from Tradier'); },
    };
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastPdtDayTradeCount).toBeNull();
    expect(s.lastPdtDayTradeLots).toBeNull();
  });

  it('publishes the day trade on the state (the alert surface) — and a clean fetch reads a MEASURED zero', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    const dayTrade = lot();
    const { client } = fakeClient([], [dayTrade, lot({ symbol: 'RIG260925C00006000', openDate: '2026-08-21', closeDate: '2026-08-24' })]);
    const s = await runLiveOptionsFeeReconcile(async () => client, NOW);
    expect(s.lastPdtDayTradeCount).toBe(1);
    expect(s.lastPdtDayTradeLots).toEqual([
      {
        symbol: 'PLTR260911C00170000',
        quantity: 1,
        cost: 444.11,
        proceeds: 599.86,
        openDate: '2026-08-04',
        closeDate: '2026-08-04',
        book: null,
      },
    ]);

    clearLiveOptionsFeeReconcileState();
    const cleanClient = fakeClient([], [lot({ openDate: '2026-08-03', closeDate: '2026-08-04' })]).client;
    const clean = await runLiveOptionsFeeReconcile(async () => cleanClient, NOW);
    expect(clean.lastPdtDayTradeCount).toBe(0); // measured zero — distinct from the null above
    expect(clean.lastPdtDayTradeLots).toEqual([]);
  });
});

// TRA-4143 ask 4 — the closing PLTR leg carried `ts` of exactly 17:00:00.000Z,
// a synthesised constant that read like a measured afternoon fill. Every row
// now says whether its ts was observed or fabricated, and hydrate retrofits
// the stamp onto pre-cut lines (they re-enter through toRecord).
describe('tsSynthetic stamp on import rows (TRA-4143)', () => {
  it('an imported row is stamped tsSynthetic:true, an engine fill row false — and both survive hydrate', async () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW);
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 });
    // a prior-day broker fill the ledger is missing → minted as history_import
    const { client } = fakeClient([
      histFill({
        date: '2026-07-29',
        symbol: 'MSFT260904C00520000',
        description: 'Buy to Open 1 MSFT260904C00520000 @ 1.10',
        quantity: 1,
        amount: -110,
        commission: 0,
        orderId: null,
        transactionId: 't-import',
      }),
    ]);
    await runLiveOptionsFeeReconcile(async () => client, NOW);
    const byOrigin = Object.fromEntries(
      summarizeLiveOptionsFeeSlippage().records.map((r) => [r.origin, r.tsSynthetic]),
    );
    expect(byOrigin).toEqual({ fill: false, history_import: true });

    // hydrate re-derives through toRecord — the stamps hold after a restart
    hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW);
    const rehydrated = Object.fromEntries(
      summarizeLiveOptionsFeeSlippage().records.map((r) => [r.origin, r.tsSynthetic]),
    );
    expect(rehydrated).toEqual({ fill: false, history_import: true });
  });

  it('retrofits a pre-cut import line that carries no tsSynthetic key on disk', () => {
    const dir = freshDir();
    const preCut = {
      mode: 'live', ts: NOW - 86_400_000, etDay: '2026-07-29', sleeve: 'single_leg_otm',
      optionSymbol: 'PLTR260911C00170000', side: 'sell_to_close', contracts: 1,
      submittedLimit: null, askAtSubmit: null, midAtSubmit: null, filledPrice: 6,
      fees: null, feeSource: null, slippageVsAsk: null, slippageVsMid: null,
      orderId: null, origin: 'history_import',
    };
    writeFileSync(join(dir, 'live-options-fee-slippage.jsonl'), JSON.stringify(preCut) + '\n', 'utf8');
    hydrateLiveOptionsFeeSlippageFromDisk(dir, NOW);
    const rec = summarizeLiveOptionsFeeSlippage().records[0]!;
    expect(rec.origin).toBe('history_import');
    expect(rec.tsSynthetic).toBe(true);
  });
});

// TRA-4295 — the v0nni stall. The ledger is process-global and holds every live
// book's fills, but the pass fetched exactly ONE Tradier account (the pinned
// operator's). The moment a second book traded, its lots settled in an account
// the pass never queried: every one of its groups rejected 'no-lot' forever,
// consecutiveNoMatch climbed monotonically (7 by 2026-09-01, spanning process
// restarts), and its rows aged toward permanently-unmeasured. The pass now
// takes the full production account roster and joins over the union of every
// account's lots.
describe('multi-account roster reconcile (TRA-4295)', () => {
  function v0nniOpenFill(): void {
    recordLiveOptionFill({
      ts: NOW - 50_000,
      etDay: '2026-07-30',
      book: 'v0nni',
      sleeve: 'single_leg_otm',
      optionSymbol: 'TTD261009C00014000',
      side: 'buy_to_open',
      contracts: 1,
      submittedLimit: 0.6,
      askAtSubmit: 0.6,
      midAtSubmit: 0.55,
      filledPrice: 0.6,
      fees: null,
      orderId: 222222222,
    });
  }

  it("measures a sibling book's row from ITS OWN account's gainloss — the exact shape the single-account pass stalled on", async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill(); // operator book: AAPL x4 @ 1.04 (gross 416.00)
    v0nniOpenFill(); // sibling book: TTD x1 @ 0.60 (gross 60.00)
    const adminLots: TradierGainLossLot[] = [
      { symbol: 'AAPL260904P00280000', quantity: 4, cost: 416.44, proceeds: 500, gainLoss: 83.56, openDate: '2026-07-30', closeDate: '2026-07-31' },
    ];
    const v0nniLots: TradierGainLossLot[] = [
      { symbol: 'TTD261009C00014000', quantity: 1, cost: 60.11, proceeds: 70, gainLoss: 9.89, openDate: '2026-07-30', closeDate: '2026-07-31' },
    ];
    const admin = fakeClient([], adminLots);
    const v0nni = fakeClient([], v0nniLots);
    const s = await runLiveOptionsFeeReconcile(
      async () => [
        { book: 'admin', client: admin.client },
        { book: 'v0nni', client: v0nni.client },
      ],
      NOW,
    );
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.lastUpdated).toBe(2);
    expect(s.lastGainLossLots).toBe(2); // the UNION of both accounts' fetches
    expect(s.lastGainLossSample!.map((l) => l.book)).toEqual(['admin', 'v0nni']);
    expect(s.lastAccounts).toEqual([
      { book: 'admin', historyFills: 0, gainLossLots: 1, historyError: null, gainLossError: null, coverage: expect.anything() },
      { book: 'v0nni', historyFills: 0, gainLossLots: 1, historyError: null, gainLossError: null, coverage: expect.anything() },
    ]);
    const bySymbol = Object.fromEntries(
      summarizeLiveOptionsFeeSlippage().records.map((r) => [r.optionSymbol, r.fees]),
    );
    expect(bySymbol['AAPL260904P00280000']).toBeCloseTo(0.44, 6);
    expect(bySymbol['TTD261009C00014000']).toBeCloseTo(0.11, 6);
  });

  it("stamps an imported row with the book whose account the history came from — never the operator's", async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedCloseFill({ etDay: '2026-07-29', ts: NOW - 86_400_000 }); // keeps the pass non-quiescent
    const v0nni = fakeClient([
      histFill({
        date: '2026-07-29',
        symbol: 'SOUN261009C00007000',
        description: 'Buy to Open 1 SOUN261009C00007000 @ 0.55',
        quantity: 1,
        amount: -55,
        commission: 0,
        orderId: null,
        transactionId: 't-v0nni-import',
      }),
    ]);
    await runLiveOptionsFeeReconcile(
      async () => [
        { book: 'admin', client: fakeClient([]).client },
        { book: 'v0nni', client: v0nni.client },
      ],
      NOW,
    );
    const imported = summarizeLiveOptionsFeeSlippage().records.find((r) => r.origin === 'history_import');
    expect(imported).toBeDefined();
    expect(imported!.optionSymbol).toBe('SOUN261009C00007000');
    expect(imported!.book).toBe('v0nni');
  });

  it("one account's total outage neither stops a sibling's join nor goes unrecorded", async () => {
    clearLiveOptionsFeeSlippageLedger();
    v0nniOpenFill();
    const dead: FeeReconcileHistoryClient = {
      listAccountHistory: async () => { throw new Error('502 from Tradier'); },
      listGainLoss: async () => { throw new Error('503 from Tradier'); },
    };
    const v0nni = fakeClient([], [
      { symbol: 'TTD261009C00014000', quantity: 1, cost: 60.11, proceeds: 70, gainLoss: 9.89, openDate: '2026-07-30', closeDate: '2026-07-31' },
    ]);
    const s = await runLiveOptionsFeeReconcile(
      async () => [
        { book: 'admin', client: dead },
        { book: 'v0nni', client: v0nni.client },
      ],
      NOW,
    );
    expect(s.lastOutcome).toBe('backfilled');
    expect(s.lastGainLossUpdated).toBe(1);
    expect(s.lastError).toContain('admin history: 502 from Tradier');
    expect(s.lastError).toContain('admin gainloss: 503 from Tradier');
    expect(s.lastAccounts![0]).toMatchObject({ book: 'admin', historyFills: null, gainLossLots: null });
  });

  it('every account failing every fetch reads fetch-failed with every error named', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const dead = (msg: string): FeeReconcileHistoryClient => ({
      listAccountHistory: async () => { throw new Error(`${msg} history`); },
      listGainLoss: async () => { throw new Error(`${msg} gainloss`); },
    });
    const s = await runLiveOptionsFeeReconcile(
      async () => [
        { book: 'admin', client: dead('A') },
        { book: 'v0nni', client: dead('B') },
      ],
      NOW,
    );
    expect(s.lastOutcome).toBe('fetch-failed');
    expect(s.lastError).toContain('admin history: A history');
    expect(s.lastError).toContain('v0nni gainloss: B gainloss');
    expect(summarizeLiveOptionsFeeSlippage().records[0]!.fees).toBeNull();
  });

  it('an EMPTY roster reads no-client — a box with no resolvable production account must not read fetch-failed', async () => {
    clearLiveOptionsFeeSlippageLedger();
    seedOpenFill();
    const s = await runLiveOptionsFeeReconcile(async () => [], NOW);
    expect(s.lastOutcome).toBe('no-client');
  });

  it('index.ts resolves the roster from resolveProductionCaptureAccounts, not a single-operator client (TRA-4295 wiring)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    expect(src).toContain('buildLiveFeeReconcileAccounts');
    expect(src).toMatch(/buildLiveFeeReconcileAccounts[\s\S]{0,400}?resolveProductionCaptureAccounts\(\)/);
    // both call sites ride the roster factory
    const calls = src.match(/runLiveOptionsFeeReconcile\(\s*buildLiveFeeReconcileAccounts/g) ?? [];
    expect(calls.length).toBe(2);
  });
});
