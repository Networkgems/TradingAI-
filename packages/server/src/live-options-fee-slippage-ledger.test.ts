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
  diffMissingFillsFromHistory,
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
      origin: 'fill',
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

// ── TRA-2959: coverage diff against broker history ───────────────────────────

// ── TRA-3558: a rejection must NAME its reason ───────────────────────────────
//
// TRA-3554's residual: the gainloss join reported a bare `no-match` on 4 rows
// that plainly should have derived, and from outside the process it was
// impossible to tell WHICH of the five tests below rejected them. These cases
// pin one rejection reason per branch, the two numbers that decided it, and —
// the load-bearing one — that NO unmeasured group can leave the join silently.

describe('gainloss join rejection reasons (TRA-3558)', () => {
  // The live TRA-3558 shape: TROW 1 contract @ 3.79 opened 2026-08-06.
  function row(over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-08-06', sleeve: 'single_leg_otm',
      optionSymbol: 'TROW260918C00115000', side: 'buy_to_open', contracts: 1,
      submittedLimit: 3.9, askAtSubmit: 3.9, midAtSubmit: 3.55, filledPrice: 3.79,
      fees: null, feeSource: null, slippageVsAsk: -0.11, slippageVsMid: 0.24,
      orderId: 140730135, origin: 'fill',
      ...over,
    };
  }
  function glLot(over: Partial<TradierGainLossLot> = {}): TradierGainLossLot {
    // Matches row(): 1 contract @ 3.79 = 379.00 gross opened 2026-08-06.
    return {
      symbol: 'TROW260918C00115000',
      quantity: 1,
      cost: 379.11,
      proceeds: 299.89,
      gainLoss: -79.22,
      openDate: '2026-08-06',
      closeDate: '2026-08-07',
      ...over,
    };
  }

  it('a group that DERIVES produces no rejection at all', () => {
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot()]);
    expect(r.updated).toBe(1);
    expect(r.rejections).toEqual([]);
  });

  it('an already-measured group is not a rejection — quiet is not a failure', () => {
    const r = reconcileLedgerFeesFromGainLoss([row({ fees: 0.11 })], []);
    expect(r.updated).toBe(0);
    expect(r.rejections).toEqual([]);
  });

  it("names 'no-lot' when NOTHING in the fetch keys to the group — absent, not mis-joined", () => {
    const r = reconcileLedgerFeesFromGainLoss([row()], []);
    expect(r.updated).toBe(0);
    expect(r.rejections).toHaveLength(1);
    const [rej] = r.rejections;
    expect(rej!.reason).toBe('no-lot');
    expect(rej!.symbol).toBe('TROW260918C00115000');
    expect(rej!.day).toBe('2026-08-06');
    expect(rej!.side).toBe('buy_to_open');
    expect(rej!.unmeasuredRows).toBe(1);
    expect(rej!.observed).toBe(0); // lots keyed here
    expect(rej!.expected).toBe(1); // contracts the ledger holds
  });

  it("a MIS-KEYED lot still reads 'no-lot' — which is why the raw sample ships with it", () => {
    // The lot exists in the fetch but its openDate is a day off, so it keys to
    // a group the ledger does not have. Indistinguishable from absence WITHOUT
    // the raw sample — see the reconcile-state test for the other half.
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot({ openDate: '2026-08-05' })]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['no-lot']);
  });

  it("names 'qty-mismatch' with BOTH totals — ledger contracts vs settled lot contracts", () => {
    const r = reconcileLedgerFeesFromGainLoss([row({ contracts: 3 })], [glLot({ quantity: 1 })]);
    expect(r.updated).toBe(0);
    const [rej] = r.rejections;
    expect(rej!.reason).toBe('qty-mismatch');
    expect(rej!.observed).toBe(3); // ledger
    expect(rej!.expected).toBe(1); // lots
  });

  it("names 'priceless-row' with the priced/total row counts", () => {
    const rows = [
      row({ ts: 1000, contracts: 1 }),
      row({ ts: 2000, contracts: 3, filledPrice: null }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, [glLot({ quantity: 4, cost: 1516.44 })]);
    expect(r.updated).toBe(0);
    const [rej] = r.rejections;
    expect(rej!.reason).toBe('priceless-row');
    expect(rej!.observed).toBe(1); // priced rows
    expect(rej!.expected).toBe(2); // rows in the group
  });

  it("names 'negative-fee' with the fee and the 0 floor — never clamped", () => {
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot({ cost: 375.0 })]);
    expect(r.updated).toBe(0);
    const [rej] = r.rejections;
    expect(rej!.reason).toBe('negative-fee');
    expect(rej!.observed).toBeCloseTo(-4, 6);
    expect(rej!.expected).toBe(0);
  });

  it("names 'above-bound' with the fee and the per-contract ceiling it broke", () => {
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot({ cost: 381.0 })]);
    expect(r.updated).toBe(0);
    const [rej] = r.rejections;
    expect(rej!.reason).toBe('above-bound');
    expect(rej!.observed).toBeCloseTo(2, 6);
    expect(rej!.expected).toBeCloseTo(0.9, 6); // 0.90 × 1 contract
  });

  it('EVERY still-unmeasured group carries a reason — no silent survivor (the invariant)', () => {
    // One group per branch plus one that derives cleanly. The assertion is not
    // "some rejections were produced" — it is that the set of unmeasured groups
    // AFTER the pass is exactly the set of rejected groups. A future branch that
    // forgets to call reject() fails here, not silently in production.
    const rows = [
      row({ ts: 1, optionSymbol: 'AAA260918C00010000' }),                                    // derives
      row({ ts: 2, optionSymbol: 'BBB260918C00010000' }),                                    // no-lot
      row({ ts: 3, optionSymbol: 'CCC260918C00010000', contracts: 3 }),                      // qty-mismatch
      row({ ts: 4, optionSymbol: 'DDD260918C00010000', filledPrice: null }),                 // priceless-row
      row({ ts: 5, optionSymbol: 'EEE260918C00010000' }),                                    // negative-fee
      row({ ts: 6, optionSymbol: 'FFF260918C00010000' }),                                    // above-bound
    ];
    const lots = [
      glLot({ symbol: 'AAA260918C00010000' }),
      glLot({ symbol: 'CCC260918C00010000', quantity: 1 }),
      glLot({ symbol: 'DDD260918C00010000' }),
      glLot({ symbol: 'EEE260918C00010000', cost: 375.0 }),
      glLot({ symbol: 'FFF260918C00010000', cost: 381.0 }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.updated).toBe(1);
    const unmeasured = new Set(r.records.filter((x) => x.fees === null).map((x) => x.optionSymbol));
    const explained = new Set(r.rejections.map((x) => x.symbol));
    expect([...explained].sort()).toEqual([...unmeasured].sort());
    expect(r.rejections.map((x) => x.reason).sort()).toEqual(
      ['above-bound', 'negative-fee', 'no-lot', 'priceless-row', 'qty-mismatch'],
    );
  });

  // ── TRA-3558: the broker sends a TRUNCATED symbol ────────────────────────
  //
  // Measured on the live ***0154 gainloss payload 2026-08-13: two of 22 lots came
  // back as `KVYO260918C0` / `TROW260918C0` — 12 chars, cut one digit into the
  // strike — while every other lot in the SAME response carried its full 18-19
  // char OCC symbol. The lots were present and correctly priced; they simply keyed
  // to a symbol no ledger row has, and four rows sat unmeasured for six days.

  it('resolves a truncated lot symbol onto the one ledger symbol it can belong to', () => {
    const rows = [
      row(),
      row({ ts: 2, etDay: '2026-08-07', side: 'sell_to_close', filledPrice: 3.0 }),
    ];
    const lots = [glLot({ symbol: 'TROW260918C0' })]; // cost 379.11 / proceeds 299.87
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.updated).toBe(2);
    expect(r.rejections).toEqual([]);
    const byDay = new Map(r.records.map((x) => [x.etDay, x.fees]));
    expect(byDay.get('2026-08-06')).toBeCloseTo(0.11, 6); // 379.11 − 379.00
    expect(byDay.get('2026-08-07')).toBeCloseTo(0.11, 6); // 300.00 − 299.89
    expect(r.prefixRepairs).toEqual([
      { lotSymbol: 'TROW260918C0', resolvedSymbol: 'TROW260918C00115000', day: '2026-08-06', side: 'buy_to_open' },
      { lotSymbol: 'TROW260918C0', resolvedSymbol: 'TROW260918C00115000', day: '2026-08-07', side: 'sell_to_close' },
    ]);
  });

  it('refuses an AMBIGUOUS truncated symbol — two strikes, same root/expiry/day/side', () => {
    // The exact case the repair must not guess at: the short symbol prefixes both.
    const rows = [
      row({ ts: 1, optionSymbol: 'TROW260918C00115000' }),
      row({ ts: 2, optionSymbol: 'TROW260918C00120000' }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, [glLot({ symbol: 'TROW260918C0' })]);
    expect(r.updated).toBe(0);
    expect(r.prefixRepairs).toEqual([]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['no-lot', 'no-lot']);
  });

  it('never repairs a lot whose symbol matches a ledger row exactly', () => {
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot()]);
    expect(r.updated).toBe(1);
    expect(r.prefixRepairs).toEqual([]);
  });

  it('leaves a truncated symbol with NO candidate on that day/side alone', () => {
    // Right root, wrong day: the repair is scoped to the lot\u2019s own (day, side).
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot({ symbol: 'TROW260918C0', openDate: '2026-08-05' })]);
    expect(r.updated).toBe(0);
    expect(r.prefixRepairs).toEqual([]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['no-lot']);
  });

  it('a symbol that is not OCC-shaped is never treated as truncated', () => {
    // An equity lot on the same account: no digits/right shape, so it cannot enter
    // the repair path even though it prefixes nothing.
    const r = reconcileLedgerFeesFromGainLoss([row()], [glLot({ symbol: 'TROW' })]);
    expect(r.prefixRepairs).toEqual([]);
    expect(r.updated).toBe(0);
  });

  it('a repaired lot still faces the qty reconciliation and the sanity bound', () => {
    // Repair is a KEYING fix, not a licence: the derived fee must still pass.
    const overpriced = reconcileLedgerFeesFromGainLoss([row()], [glLot({ symbol: 'TROW260918C0', cost: 381.0 })]);
    expect(overpriced.updated).toBe(0);
    expect(overpriced.rejections.map((x) => x.reason)).toEqual(['above-bound']);
    // repaired on the OPEN leg (the only leg with a row on that day/side), then
    // rejected on merit — the repair is a keying fix, it grants nothing.
    expect(overpriced.prefixRepairs).toHaveLength(1);
    const shortQty = reconcileLedgerFeesFromGainLoss(
      [row({ contracts: 3 })],
      [glLot({ symbol: 'TROW260918C0', quantity: 1 })],
    );
    expect(shortQty.updated).toBe(0);
    expect(shortQty.rejections.map((x) => x.reason)).toEqual(['qty-mismatch']);
  });

  it('rejections lead with the most recent ET day — a truncated publish keeps the actionable ones', () => {
    const rows = [
      row({ ts: 1, etDay: '2026-07-16', optionSymbol: 'OLD260918C00010000' }),
      row({ ts: 2, etDay: '2026-08-12', optionSymbol: 'NEW260918C00010000' }),
      row({ ts: 3, etDay: '2026-08-01', optionSymbol: 'MID260918C00010000' }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, []);
    expect(r.rejections.map((x) => x.day)).toEqual(['2026-08-12', '2026-08-01', '2026-07-16']);
  });
});

describe('diffMissingFillsFromHistory (TRA-2959)', () => {
  function rec(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-08-04', sleeve: 'single_leg_otm',
      optionSymbol: 'TSLA260911C00560000', side: 'buy_to_open', contracts: 4,
      submittedLimit: 0.27, askAtSubmit: 0.27, midAtSubmit: 0.25, filledPrice: 0.27,
      fees: null, feeSource: null, slippageVsAsk: 0, slippageVsMid: 0.02,
      orderId: null, origin: 'fill',
      ...over,
    };
  }
  function hist(over: Partial<TradierTradeHistoryFill>): TradierTradeHistoryFill {
    return {
      date: '2026-08-04', symbol: 'TSLA260911C00560000', tradeType: 'option',
      description: 'CALL TSLA   09/11/26   560', price: 0.27, quantity: 4,
      amount: -108, commission: 0, transactionId: 't1', orderId: null,
      ...over,
    };
  }

  it('a partial shortfall imports only the uncovered contracts, from the LAST executions', () => {
    // Broker: two executions 3 + 2 = 5 contracts sold. Ledger recorded only 3.
    const { inputs, coverage } = diffMissingFillsFromHistory(
      [rec({ side: 'sell_to_close', contracts: 3, etDay: '2026-08-04' })],
      [
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 80, quantity: 3, price: 0.26, transactionId: 'a' }),
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 55, quantity: 2, price: 0.28, transactionId: 'b' }),
      ],
      '2026-08-05',
    );
    expect(coverage.brokerContracts).toBe(5);
    expect(coverage.ledgerContracts).toBe(3);
    expect(coverage.missingContracts).toBe(2);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.contracts).toBe(2);
    expect(inputs[0]!.filledPrice).toBeCloseTo(0.28, 6); // the later execution
    expect(inputs[0]!.origin).toBe('history_import');
  });

  it('skips equity rows, unclassifiable sides, and ledger-only groups (pre-migration rows are not a gap)', () => {
    const { inputs, coverage } = diffMissingFillsFromHistory(
      // A pre-migration ledger row history knows nothing about: NOT a coverage gap.
      [rec({ optionSymbol: 'ORCL260821P00100000', side: 'sell_to_close', etDay: '2026-07-16' })],
      [
        hist({ tradeType: 'equity', symbol: 'TSLA' }),
        hist({ amount: 0, description: 'CALL TSLA   09/11/26   560' }), // side unclassifiable
      ],
      '2026-08-05',
    );
    expect(coverage.brokerContracts).toBe(0);
    expect(coverage.missingContracts).toBe(0);
    expect(inputs).toHaveLength(0);
  });

  it('publishes the slippage denominator: nMeasured + excludedNoAskQuote === nTotal', () => {
    clearLiveOptionsFeeSlippageLedger();
    recordLiveOptionFill({
      ts: 1, etDay: '2026-08-04', sleeve: 'single_leg_otm',
      optionSymbol: 'TSLA260911C00560000', side: 'buy_to_open', contracts: 4,
      submittedLimit: 0.27, askAtSubmit: 0.27, midAtSubmit: 0.25, filledPrice: 0.27,
      fees: null, orderId: null,
    });
    recordLiveOptionFill({
      // a market exit: no submit-time quote — the structurally unmeasurable case
      ts: 2, etDay: '2026-08-04', sleeve: 'single_leg_directional',
      optionSymbol: 'SPY260807P00760000', side: 'sell_to_close', contracts: 4,
      submittedLimit: null, askAtSubmit: null, midAtSubmit: null, filledPrice: 0.4575,
      fees: null, orderId: null,
    });
    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.slippage.nTotal).toBe(2);
    expect(s.slippage.nMeasured).toBe(1);
    expect(s.slippage.excludedNoAskQuote).toBe(1);
    expect(s.slippage.nMeasured + s.slippage.excludedNoAskQuote).toBe(s.slippage.nTotal);
  });
});
