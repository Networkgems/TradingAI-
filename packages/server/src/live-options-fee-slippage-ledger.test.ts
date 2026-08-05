import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveOptionFill,
  hydrateLiveOptionsFeeSlippageFromDisk,
  summarizeLiveOptionsFeeSlippage,
  clearLiveOptionsFeeSlippageLedger,
  liveOptionsFeeSlippageLogPath,
  reconcileLedgerFees,
  reconcileLedgerFeesFromGainLoss,
  backfillLiveOptionFees,
  backfillLiveOptionFeesFromGainLoss,
  lastRecordedOpenSleeve,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';
import type { TradierTradeHistoryFill, TradierGainLossLot } from '@trading-app/engine';

// TRA-1929 — the durable per-trade fee/slippage calibration ledger for the bounded
// real-money options test. Covers: record→append→hydrate round-trip, the
// null-not-zero invariant on unmeasured legs (TRA-1707), the slippage derivation,
// and the durability provenance (ephemeral flag) the board must read first.

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tra1929-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  clearLiveOptionsFeeSlippageLedger();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('live-options fee/slippage ledger (TRA-1929)', () => {
  it('records an open fill, derives slippage, and appends a durable JSONL line', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill({
      ts: 1000,
      etDay: '2026-07-16',
      sleeve: 'single_leg_otm',
      optionSymbol: 'AAPL240705C00210000',
      side: 'buy_to_open',
      contracts: 1,
      submittedLimit: 0.82,
      askAtSubmit: 0.82,
      midAtSubmit: 0.80,
      filledPrice: 0.83,
      fees: null,
      orderId: 42,
    });
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.n).toBe(1);
    expect(summary.opens).toBe(1);
    expect(summary.closes).toBe(0);
    const rec = summary.records[0]!;
    expect(rec.mode).toBe('live');
    expect(rec.slippageVsAsk).toBeCloseTo(0.01, 6); // 0.83 − 0.82
    expect(rec.slippageVsMid).toBeCloseTo(0.03, 6); // 0.83 − 0.80
    // durable line on disk
    const raw = readFileSync(liveOptionsFeeSlippageLogPath(dir), 'utf8').trim();
    expect(raw.split('\n')).toHaveLength(1);
    expect(JSON.parse(raw).optionSymbol).toBe('AAPL240705C00210000');
  });

  it('uses null (never 0) for unmeasured legs — fees and one-sided quotes', () => {
    clearLiveOptionsFeeSlippageLedger();
    recordLiveOptionFill({
      ts: 2000,
      etDay: '2026-07-16',
      sleeve: 'single_leg_otm',
      optionSymbol: 'X',
      side: 'buy_to_open',
      contracts: 1,
      submittedLimit: 1.0,
      askAtSubmit: 1.0,
      midAtSubmit: null,   // one-sided quote — no mid to triangulate
      filledPrice: 1.0,
      fees: null,          // commission not available at fill time
      orderId: null,
    });
    const rec = summarizeLiveOptionsFeeSlippage().records[0]!;
    expect(rec.slippageVsAsk).toBe(0);      // measured: filled at ask (a REAL 0)
    expect(rec.slippageVsMid).toBeNull();   // unmeasured ⇒ null, NOT 0
    expect(rec.fees).toBeNull();            // unmeasured ⇒ null, NOT 0
    // the fee summary counts only MEASURED fees, so a null fee never reads as $0
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.feesMeasured).toBe(0);
    expect(s.totalFees).toBeNull();
  });

  it('lastRecordedOpenSleeve returns the open row sleeve so a close can inherit it (TRA-2811)', () => {
    clearLiveOptionsFeeSlippageLedger();
    // No open row yet — nothing to inherit.
    expect(lastRecordedOpenSleeve('AMZN260904P00245000')).toBeNull();
    recordLiveOptionFill({
      ts: 1000,
      etDay: '2026-07-31',
      sleeve: 'single_leg_otm',
      optionSymbol: 'AMZN260904P00245000',
      side: 'buy_to_open',
      contracts: 1,
      submittedLimit: 2.0,
      askAtSubmit: 2.0,
      midAtSubmit: 1.9,
      filledPrice: 2.0,
      fees: null,
      orderId: 1,
    });
    // A close row for the same contract must NOT satisfy the lookup (side filter).
    recordLiveOptionFill({
      ts: 2000,
      etDay: '2026-08-03',
      sleeve: 'single_leg_directional', // the mislabeled pre-2811 close shape
      optionSymbol: 'AMZN260904P00245000',
      side: 'sell_to_close',
      contracts: 1,
      submittedLimit: 0.17,
      askAtSubmit: 2.49,
      midAtSubmit: 1.33,
      filledPrice: 0.89,
      fees: null,
      orderId: 139775135,
    });
    expect(lastRecordedOpenSleeve('AMZN260904P00245000')).toBe('single_leg_otm');
    // A different contract's open does not leak across symbols.
    expect(lastRecordedOpenSleeve('QQQ260904C00797000')).toBeNull();
  });

  it('hydrates prior fills from disk on boot (survives a reboot on a persistent dir)', () => {
    const dir = freshDir();
    const line = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-07-16', sleeve: 'single_leg_rv',
      optionSymbol: 'MSFT', side: 'sell_to_close', contracts: 2,
      submittedLimit: 2.5, askAtSubmit: 2.6, midAtSubmit: 2.55, filledPrice: 2.5,
      fees: null, slippageVsAsk: -0.1, slippageVsMid: -0.05, orderId: 7,
    });
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), line + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 6000);
    expect(h.records).toBe(1);
    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.n).toBe(1);
    expect(summary.closes).toBe(1);
    expect(summary.durability.hydratedRecords).toBe(1);
    // re-derived slippage from the persisted legs
    expect(summary.records[0]!.slippageVsAsk).toBeCloseTo(-0.1, 6);
  });

  it('drops records older than the retention window on hydrate', () => {
    const dir = freshDir();
    const old = JSON.stringify({
      mode: 'live', ts: 1, etDay: '2020-01-01', sleeve: 'single_leg_otm',
      optionSymbol: 'OLD', side: 'buy_to_open', contracts: 1,
      submittedLimit: 1, askAtSubmit: 1, midAtSubmit: 1, filledPrice: 1,
      fees: null, slippageVsAsk: 0, slippageVsMid: 0, orderId: 1,
    });
    // now = 100 days after epoch ms 1 → well beyond the 30-day window
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), old + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 100 * 24 * 60 * 60 * 1000);
    expect(h.records).toBe(0);
    expect(summarizeLiveOptionsFeeSlippage().n).toBe(0);
  });

  // ── TRA-1954: fee back-fill reconcile ─────────────────────────────────────

  function ledgerRow(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-07-16', sleeve: 'single_leg_otm',
      optionSymbol: 'AAPL240705C00210000', side: 'buy_to_open', contracts: 1,
      submittedLimit: 0.82, askAtSubmit: 0.82, midAtSubmit: 0.80, filledPrice: 0.83,
      fees: null, feeSource: null, slippageVsAsk: 0.01, slippageVsMid: 0.03,
      orderId: null, // composite-path tests; orderId path tested separately below
      ...over,
    };
  }

  function histFill(over: Partial<TradierTradeHistoryFill>): TradierTradeHistoryFill {
    return {
      date: '2026-07-16', symbol: 'AAPL240705C00210000', tradeType: 'option',
      description: 'Buy to Open 1 AAPL240705C00210000 @ 0.83', price: 0.83, quantity: 1,
      amount: -83, commission: 0.35, transactionId: 't1',
      orderId: null, // composite path; set to a real number to test orderId join
      ...over,
    };
  }

  it('back-fills fees on an exact composite match (symbol/day/side/qty)', () => {
    const { updated, records } = reconcileLedgerFees(
      [ledgerRow({})],
      [histFill({ commission: 0.35 })],
    );
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBe(0.35);
    // slippage invariants preserved through the re-derive
    expect(records[0]!.slippageVsAsk).toBeCloseTo(0.01, 6);
  });

  it('never matches across a side or quantity mismatch — row stays fees:null', () => {
    const rows = [
      ledgerRow({ side: 'buy_to_open', contracts: 1 }),
      ledgerRow({ side: 'sell_to_close', contracts: 1, ts: 2000 }),
    ];
    // history has a SELL-to-close of qty 2 — wrong side for row[0], wrong qty for row[1]
    const { updated, records } = reconcileLedgerFees(rows, [
      histFill({ description: 'Sell to Close 2 ...', quantity: 2, commission: 0.7 }),
    ]);
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull(); // unmeasured ⇒ null, NEVER 0 (TRA-1707)
    expect(records[1]!.fees).toBeNull();
  });

  it('pairs duplicate (identical symbol/day/side/qty) fills by ascending ts and never double-assigns', () => {
    // Two identical ledger rows (orderId null = composite path), only ONE history fill:
    // the earlier-ts row wins, the other stays honest-null (never a fabricated 0).
    const rows = [
      ledgerRow({ ts: 3000 }),
      ledgerRow({ ts: 1000 }),
    ];
    const { updated, records } = reconcileLedgerFees(rows, [histFill({ commission: 0.35 })]);
    expect(updated).toBe(1);
    const byTs = new Map(records.map((r) => [r.ts, r.fees]));
    expect(byTs.get(1000)).toBe(0.35); // earlier ts paired first
    expect(byTs.get(3000)).toBeNull(); // no second fill ⇒ null, not double-assigned
  });

  it('assigns two identical fills to two identical rows exactly once each', () => {
    const rows = [ledgerRow({ ts: 1000 }), ledgerRow({ ts: 2000 })];
    const { updated, records } = reconcileLedgerFees(rows, [
      histFill({ transactionId: 'a', commission: 0.35 }),
      histFill({ transactionId: 'b', commission: 0.35 }),
    ]);
    expect(updated).toBe(2);
    expect(records.every((r) => r.fees === 0.35)).toBe(true);
  });

  it('is idempotent — a second reconcile over the same history changes nothing', () => {
    const once = reconcileLedgerFees([ledgerRow({})], [histFill({ commission: 0.35 })]);
    expect(once.updated).toBe(1);
    // feed the already-populated row back in with the same history
    const twice = reconcileLedgerFees(once.records, [histFill({ commission: 0.35 })]);
    expect(twice.updated).toBe(0); // already-filled row consumes the slot but is not re-counted
    expect(twice.records[0]!.fees).toBe(0.35);
  });

  it('ignores equity and side-mismatched history rows', () => {
    // equity fills → filtered by tradeType check
    // sell_to_close fill → doesn't match the buy_to_open ledger row
    const { updated, records } = reconcileLedgerFees(
      [ledgerRow({})], // buy_to_open, qty 1
      [
        histFill({ tradeType: 'equity', commission: 0.35 }),
        // positive amount → sell_to_close via amount fallback; side mismatch vs buy_to_open row
        histFill({ description: 'CALL AAPL240705C00210000', amount: 83, commission: 0.35 }),
      ],
    );
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull();
  });

  it('persists the back-fill so a redeploy re-hydrates with fees intact', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill({
      ts: 1000, etDay: '2026-07-16', sleeve: 'single_leg_otm',
      optionSymbol: 'AAPL240705C00210000', side: 'buy_to_open', contracts: 1,
      submittedLimit: 0.82, askAtSubmit: 0.82, midAtSubmit: 0.80, filledPrice: 0.83,
      fees: null, orderId: null, // composite path; matches histFill default
    });
    // back-fill from history, which rewrites the durable JSONL
    const { updated } = backfillLiveOptionFees([histFill({ commission: 0.35 })]);
    expect(updated).toBe(1);
    expect(summarizeLiveOptionsFeeSlippage().feesMeasured).toBe(1);
    expect(summarizeLiveOptionsFeeSlippage().totalFees).toBeCloseTo(0.35, 6);

    // simulate a redeploy: fresh boot re-hydrates from the same file
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 2000);
    expect(h.records).toBe(1);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBe(0.35); // fee survived the reboot
    expect(s.feesMeasured).toBe(1);
    expect(s.totalFees).toBeCloseTo(0.35, 6);
  });

  it('instrument-only description falls back to amount sign for side (TRA-2810 Tradier production format)', () => {
    // Tradier production returns "CALL AMZN   09/04/26   295" not "Buy to Open 4 AMZN..."
    // negative amount → buy/open; positive → sell/close
    const { updated, records } = reconcileLedgerFees(
      [ledgerRow({})], // buy_to_open
      [histFill({ description: 'CALL AAPL240705C00210000', amount: -83, commission: 0.35 })],
    );
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBe(0.35);
  });

  it('joins via orderId (primary path) — ignores composite key when orderId matches', () => {
    // Ledger row has orderId 139283844; history fill has same orderId but different qty
    // (which would prevent a composite match). orderId path must still match.
    const row = ledgerRow({ orderId: 139283844, contracts: 4 });
    const fill = histFill({ orderId: 139283844, quantity: 2 }); // qty mismatch — composite would fail
    const { updated, records } = reconcileLedgerFees([row], [fill]);
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBe(0.35);
  });

  it('orderId path never double-assigns — two rows same orderId only the first gets the fee', () => {
    const row1 = ledgerRow({ ts: 1000, orderId: 139283844 });
    const row2 = ledgerRow({ ts: 2000, orderId: 139283844 }); // duplicate orderId
    const fill = histFill({ orderId: 139283844 });
    const { updated, records } = reconcileLedgerFees([row1, row2], [fill]);
    expect(updated).toBe(1);
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    expect(sorted[0]!.fees).toBe(0.35);
    expect(sorted[1]!.fees).toBeNull();
  });

  // ── TRA-2850: the commission field is 0 on every production row ───────────

  it('a zero-commission history fill never writes a fee — 0 is "unmeasured", not "free" (TRA-2850)', () => {
    // The exact production shape that poisoned 14 rows: composite key matches
    // perfectly, commission is 0. The row must stay honest-null.
    const { updated, records } = reconcileLedgerFees(
      [ledgerRow({})],
      [histFill({ commission: 0 })],
    );
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull();
    expect(records[0]!.feeSource).toBeNull();
  });

  it('a positive commission write carries history_commission provenance (TRA-2850)', () => {
    const { records } = reconcileLedgerFees([ledgerRow({})], [histFill({ commission: 0.35 })]);
    expect(records[0]!.fees).toBe(0.35);
    expect(records[0]!.feeSource).toBe('history_commission');
  });

  // ── TRA-2850: gainloss-derived fees ───────────────────────────────────────

  function lot(over: Partial<TradierGainLossLot> = {}): TradierGainLossLot {
    // Matches ledgerRow(): 1 contract @ 0.83 = 83.00 gross on 2026-07-16.
    return {
      symbol: 'AAPL240705C00210000',
      quantity: 1,
      cost: 83.11,      // 83.00 gross + 0.11 open-side fee
      proceeds: 199.87, // 200.00 gross − 0.13 close-side fee (for sell tests)
      gainLoss: 116.76,
      openDate: '2026-07-16',
      closeDate: '2026-07-20',
      ...over,
    };
  }

  it('derives the open-side fee from a settled lot: cost − price×100×qty (TRA-2850)', () => {
    const { updated, records } = reconcileLedgerFeesFromGainLoss([ledgerRow({})], [lot()]);
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBeCloseTo(0.11, 6);
    expect(records[0]!.feeSource).toBe('gainloss_derived');
    // slippage invariants preserved through the re-derive
    expect(records[0]!.slippageVsAsk).toBeCloseTo(0.01, 6);
  });

  it('derives the close-side fee from a settled lot: price×100×qty − proceeds (TRA-2850)', () => {
    const sellRow = ledgerRow({ side: 'sell_to_close', etDay: '2026-07-20', filledPrice: 2.0 });
    const { updated, records } = reconcileLedgerFeesFromGainLoss([sellRow], [lot()]);
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBeCloseTo(0.13, 6); // 200.00 − 199.87
  });

  it('reconciles a FIFO lot split (1+3) against a single 4-contract fill via group totals (TRA-2850)', () => {
    // Tradier settles a 4-lot as 1+3; a per-lot qty==contracts join would skip both.
    const row = ledgerRow({ contracts: 4, filledPrice: 1.04 }); // 416.00 gross
    const lots = [
      lot({ quantity: 1, cost: 104.11 }),  // 104.00 + 0.11
      lot({ quantity: 3, cost: 312.31 }),  // 312.00 + 0.31
    ];
    const { updated, records } = reconcileLedgerFeesFromGainLoss([row], lots);
    expect(updated).toBe(1);
    expect(records[0]!.fees).toBeCloseTo(0.42, 6); // group fee lands on the one row
  });

  it('apportions a group fee pro-rata by contracts across split fills (TRA-2850)', () => {
    const rows = [
      ledgerRow({ ts: 1000, contracts: 1, filledPrice: 1.04 }),
      ledgerRow({ ts: 2000, contracts: 3, filledPrice: 1.04 }),
    ];
    const lots = [lot({ quantity: 4, cost: 416.44 })]; // 416.00 gross + 0.44
    const { updated, records } = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(updated).toBe(2);
    const byTs = new Map(records.map((r) => [r.ts, r.fees]));
    expect(byTs.get(1000)).toBeCloseTo(0.11, 6); // 0.44 × 1/4
    expect(byTs.get(2000)).toBeCloseTo(0.33, 6); // 0.44 × 3/4
  });

  it('a group whose lot/row quantities do not reconcile stays honest-null (TRA-2850)', () => {
    const { updated, records } = reconcileLedgerFeesFromGainLoss(
      [ledgerRow({ contracts: 2 })],
      [lot({ quantity: 1 })], // still-open remainder → totals don't reconcile
    );
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull();
  });

  it('a negative derived fee is a join artifact — skipped, never clamped to 0 (TRA-2850)', () => {
    // cost BELOW gross means this lot cannot have come from these fills
    const { updated, records } = reconcileLedgerFeesFromGainLoss(
      [ledgerRow({})],
      [lot({ cost: 80.0 })], // 83.00 gross − 3.00?! wrong lot
    );
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull();
  });

  it('a derived fee above the per-contract sanity bound is rejected (TRA-2850)', () => {
    // 83.00 gross + 2.00 "fee" on 1 contract ⇒ a ≥1-cent price mismatch, not a fee
    const { updated, records } = reconcileLedgerFeesFromGainLoss(
      [ledgerRow({})],
      [lot({ cost: 85.0 })],
    );
    expect(updated).toBe(0);
    expect(records[0]!.fees).toBeNull();
  });

  it('gainloss reconcile is idempotent — measured rows keep their value and still reconcile the totals (TRA-2850)', () => {
    const once = reconcileLedgerFeesFromGainLoss([ledgerRow({})], [lot()]);
    expect(once.updated).toBe(1);
    const twice = reconcileLedgerFeesFromGainLoss(once.records, [lot()]);
    expect(twice.updated).toBe(0);
    expect(twice.records[0]!.fees).toBeCloseTo(0.11, 6);
  });

  it('a priceless row in the group blocks the derivation for the whole group — no guessing (TRA-2850)', () => {
    const rows = [
      ledgerRow({ ts: 1000, contracts: 1 }),
      ledgerRow({ ts: 2000, contracts: 3, filledPrice: null }), // gross unknowable
    ];
    const { updated } = reconcileLedgerFeesFromGainLoss(rows, [lot({ quantity: 4, cost: 416.44 })]);
    expect(updated).toBe(0);
  });

  it('gainloss back-fill is durable — a rehydrate keeps the fee AND its provenance (TRA-2850)', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill({
      ts: 1000, etDay: '2026-07-16', sleeve: 'single_leg_otm',
      optionSymbol: 'AAPL240705C00210000', side: 'buy_to_open', contracts: 1,
      submittedLimit: 0.82, askAtSubmit: 0.82, midAtSubmit: 0.80, filledPrice: 0.83,
      fees: null, orderId: null,
    });
    const { updated } = backfillLiveOptionFeesFromGainLoss([lot()]);
    expect(updated).toBe(1);
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 2000);
    expect(h.records).toBe(1);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBeCloseTo(0.11, 6);
    expect(s.records[0]!.feeSource).toBe('gainloss_derived');
    expect(s.feesMeasured).toBe(1);
    expect(s.feesBySource.gainlossDerived).toBe(1);
  });

  // ── TRA-2850: hydrate migration of the pre-2850 poison ────────────────────

  it('hydrate resets a fees:0 row with no provenance back to null — the pre-2850 poison (TRA-2850)', () => {
    const dir = freshDir();
    const poisoned = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-08-03', sleeve: 'single_leg_otm',
      optionSymbol: 'AMZN260904C00295000', side: 'buy_to_open', contracts: 3,
      submittedLimit: 1.0, askAtSubmit: 1.0, midAtSubmit: 0.95, filledPrice: 1.0,
      fees: 0, slippageVsAsk: 0, slippageVsMid: 0.05, orderId: null, // no feeSource
    });
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), poisoned + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 6000);
    expect(h.records).toBe(1);
    expect(h.migrated).toBe(1);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBeNull(); // unmeasured again — honest
    expect(s.feesMeasured).toBe(0);
    // and the repair is DURABLE: the file was rewritten, so the next boot
    // does not re-report a migration
    const raw = readFileSync(liveOptionsFeeSlippageLogPath(dir), 'utf8');
    expect(JSON.parse(raw.trim()).fees).toBeNull();
    expect(hydrateLiveOptionsFeeSlippageFromDisk(dir, 7000).migrated).toBe(0);
  });

  it('hydrate keeps a genuine measured $0 that carries provenance (TRA-2850)', () => {
    const dir = freshDir();
    const genuine = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-08-03', sleeve: 'single_leg_otm',
      optionSymbol: 'AMZN260904C00295000', side: 'buy_to_open', contracts: 3,
      submittedLimit: 1.0, askAtSubmit: 1.0, midAtSubmit: 0.95, filledPrice: 1.0,
      fees: 0, feeSource: 'gainloss_derived', slippageVsAsk: 0, slippageVsMid: 0.05, orderId: null,
    });
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), genuine + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 6000);
    expect(h.migrated).toBe(0);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBe(0);
    expect(s.feesMeasured).toBe(1);
  });

  it('hydrate keeps a NONZERO legacy fee even without provenance — only the 0s were poison (TRA-2850)', () => {
    const dir = freshDir();
    const legacy = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-08-03', sleeve: 'single_leg_otm',
      optionSymbol: 'AMZN260904C00295000', side: 'buy_to_open', contracts: 3,
      submittedLimit: 1.0, askAtSubmit: 1.0, midAtSubmit: 0.95, filledPrice: 1.0,
      fees: 1.05, slippageVsAsk: 0, slippageVsMid: 0.05, orderId: null,
    });
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), legacy + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 6000);
    expect(h.migrated).toBe(0);
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.records[0]!.fees).toBeCloseTo(1.05, 6);
    expect(s.feesMeasured).toBe(1);
  });

  it('reports durability.ephemeral so a reader knows if the calibration survives a reboot', () => {
    // memory-only (no hydrate) ⇒ nothing durable
    clearLiveOptionsFeeSlippageLedger();
    expect(summarizeLiveOptionsFeeSlippage().durability.ephemeral).toBe(true);
    // a real temp dir hydrated with DATA_DIR set ⇒ not ephemeral
    const dir = freshDir();
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
      expect(summarizeLiveOptionsFeeSlippage().durability.ephemeral).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
    }
  });
});
