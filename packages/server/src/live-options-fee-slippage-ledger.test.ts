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
  repriceImportedFillsFromHistory,
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
    expect(lastRecordedOpenSleeve('AMZN260904P00245000', null)).toBeNull();
    recordLiveOptionFill({
      ts: 1000,
      etDay: '2026-07-31',
      sleeve: 'single_leg_otm',
      optionSymbol: 'AMZN260904P00245000',
      side: 'buy_to_open',
      // TRA-3918 — 2 contracts, not the incident's 1, so the close below is a
      // PARTIAL one and the episode is still open when the side filter is
      // graded. At 1 contract the round trip FLATTENS, and the correct answer
      // after TRA-3918 is `null` — which would pass this assertion for the
      // wrong reason (or, as written before, fail it). The side filter and the
      // episode boundary are two different claims and they get two different
      // fixtures; the second one is the `it` immediately below.
      contracts: 2,
      submittedLimit: 2.0,
      askAtSubmit: 2.0,
      midAtSubmit: 1.9,
      filledPrice: 2.0,
      fees: null,
      orderId: 1,
    });
    // A close row for the same contract must NOT satisfy the lookup (side filter):
    // if the filter broke, this row's mislabeled sleeve is what would come back.
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
    expect(lastRecordedOpenSleeve('AMZN260904P00245000', null)).toBe('single_leg_otm');
    // A different contract's open does not leak across symbols.
    expect(lastRecordedOpenSleeve('QQQ260904C00797000', null)).toBeNull();
  });

  it('lastRecordedOpenSleeve stops at the close that FLATTENS the position (TRA-3918)', () => {
    // The other half of the claim above, and the one that used to be wrong: a
    // CLOSED episode kept voting, so an OCC this engine had ever bought answered
    // `engine` forever — including for a contract the desk later bought on the
    // same symbol. Full detail and the in-situ consequences:
    // `tra3918-open-episode-walk.test.ts`.
    clearLiveOptionsFeeSlippageLedger();
    const open = {
      ts: 1000, etDay: '2026-07-31', sleeve: 'single_leg_otm' as const,
      optionSymbol: 'AMZN260904P00245000', side: 'buy_to_open' as const,
      contracts: 1, filledPrice: 2.0, orderId: 1,
    };
    recordLiveOptionFill(open);
    expect(lastRecordedOpenSleeve('AMZN260904P00245000', null)).toBe('single_leg_otm');

    recordLiveOptionFill({
      ts: 2000, etDay: '2026-08-03', sleeve: 'single_leg_directional',
      optionSymbol: 'AMZN260904P00245000', side: 'sell_to_close',
      contracts: 1, filledPrice: 0.89, orderId: 139775135,
    });
    // We hold ZERO. The episode is over and does not get to answer again.
    expect(lastRecordedOpenSleeve('AMZN260904P00245000', null)).toBeNull();

    // …and a genuine RE-OPEN answers with the SECOND episode, not the first.
    recordLiveOptionFill({ ...open, ts: 3000, sleeve: 'single_leg_rv', orderId: 2 });
    expect(lastRecordedOpenSleeve('AMZN260904P00245000', null)).toBe('single_leg_rv');
  });

  it('hydrates prior fills from disk on boot (survives a reboot on a persistent dir)', () => {
    const dir = freshDir();
    const line = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-07-16', sleeve: 'single_leg_rv',
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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
      book: null, // TRA-3977 — single-book fixture tape
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

describe('gainloss wash-sale basis recovery (TRA-4408)', () => {
  // The live 2026-09-09 residue, real numbers: Tradier's `/gainloss` reports
  // the TAX basis — a lot bought back inside the wash window carries the
  // sibling's disallowed loss ADDED to its cost, so the open-side derivation
  // reads fee ≈ loss and the sanity bound (correctly) refuses it forever.
  function washRow(over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-08-20', sleeve: 'single_leg_otm',
      book: null,
      optionSymbol: 'BAC260925C00063000', side: 'buy_to_open', contracts: 1,
      submittedLimit: null, askAtSubmit: null, midAtSubmit: null, filledPrice: 1.65,
      fees: null, feeSource: null, slippageVsAsk: null, slippageVsMid: null,
      orderId: null, origin: 'fill',
      ...over,
    };
  }
  function washLot(over: Partial<TradierGainLossLot> = {}): TradierGainLossLot {
    return {
      symbol: 'BAC260925C00063000',
      quantity: 1,
      cost: 165.11,
      proceeds: 90.87,
      gainLoss: -74.24,
      openDate: '2026-08-20',
      closeDate: '2026-08-21',
      ...over,
    };
  }

  it('recovers the fee when exactly ONE same-symbol realized loss bridges it into the bound (live BAC shape)', () => {
    const rows = [
      washRow({ ts: 1, filledPrice: 1.65 }),
      washRow({ ts: 2, filledPrice: 1.17, origin: 'history_import' }),
    ];
    // Lot A closed 08-21 at a 74.24 loss; lot B's cost is the 1.17 execution
    // (117.11 with its real fee) PLUS that disallowed loss = 191.35.
    const lots = [
      washLot(), // loss lot: 165.11 → 90.87
      washLot({ cost: 191.35, proceeds: 113.87, gainLoss: -77.48, closeDate: '2026-08-24' }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.rejections).toEqual([]);
    expect(r.updated).toBe(2);
    for (const rec of r.records) {
      expect(rec.fees).toBeCloseTo(0.11, 6); // the fee every other measured open carries
      expect(rec.feeSource).toBe('gainloss_derived');
    }
    expect(r.washRepairs).toEqual([
      {
        symbol: 'BAC260925C00063000',
        day: '2026-08-20',
        side: 'buy_to_open',
        contracts: 2,
        rawDerived: 74.46, // (165.11 + 191.35) − (165 + 117)
        washAdjustment: 74.24,
        fee: 0.22,
        lossCloseDays: ['2026-08-21'],
      },
    ]);
  });

  it('the loss lot may sit INSIDE the group being repaired (live NOK shape — both lots same open day)', () => {
    const rows = [
      washRow({ ts: 1, optionSymbol: 'NOK261002C00010500', etDay: '2026-08-28', filledPrice: 0.73 }),
      washRow({ ts: 2, optionSymbol: 'NOK261002C00010500', etDay: '2026-08-28', filledPrice: 0.57, origin: 'history_import' }),
    ];
    const lots = [
      // Both opened 08-28, both closed 09-02. The 0.73 lot lost 39.24; that
      // loss washed onto the 0.57 sibling: 57.11 + 39.24 = 96.35.
      washLot({ symbol: 'NOK261002C00010500', cost: 73.11, proceeds: 33.87, gainLoss: -39.24, openDate: '2026-08-28', closeDate: '2026-09-02' }),
      washLot({ symbol: 'NOK261002C00010500', cost: 96.35, proceeds: 33.87, gainLoss: -62.48, openDate: '2026-08-28', closeDate: '2026-09-02' }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.rejections).toEqual([]);
    expect(r.updated).toBe(2);
    for (const rec of r.records) expect(rec.fees).toBeCloseTo(0.11, 6);
    expect(r.washRepairs).toHaveLength(1);
    expect(r.washRepairs[0]!.rawDerived).toBeCloseTo(39.46, 6);
    expect(r.washRepairs[0]!.washAdjustment).toBeCloseTo(39.24, 6);
    expect(r.washRepairs[0]!.fee).toBeCloseTo(0.22, 6);
  });

  it('refuses when MULTIPLE candidate adjustments land in-bound — ambiguity is a rejection, not a choice', () => {
    const rows = [
      washRow({ ts: 1, filledPrice: 1.65 }),
      washRow({ ts: 2, filledPrice: 1.17 }),
    ];
    const lots = [
      washLot(), // loss 74.24 → candidate fee 0.22 (group fee 74.46 = 356.46 − 282)
      washLot({ cost: 191.35, proceeds: 117.25, gainLoss: -74.1, closeDate: '2026-08-24' }), // loss 74.10 → candidate fee 0.36
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.updated).toBe(0);
    expect(r.washRepairs).toEqual([]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['above-bound']);
    expect(r.rejections[0]!.detail).toContain('MULTIPLE candidate adjustments');
  });

  it('a loss closed OUTSIDE the wash window is not a candidate', () => {
    const rows = [washRow({ ts: 1, filledPrice: 1.17 })];
    const lots = [
      washLot({ cost: 191.35, proceeds: 113.87, closeDate: '2026-08-24' }), // group lot, wash-adjusted
      washLot({ openDate: '2026-06-01', closeDate: '2026-06-02' }), // loss 74.24, 79 days before the open
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.updated).toBe(0);
    expect(r.washRepairs).toEqual([]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['above-bound']);
  });

  it('never applies to a CLOSE-side group — proceeds are reported raw, an above-bound close stays rejected', () => {
    const rows = [
      washRow({ ts: 1, side: 'sell_to_close', etDay: '2026-08-21', filledPrice: 1.65 }),
    ];
    const lots = [
      // Close-side derivation: 165.00 − 90.87 = 74.13 — way above bound. The
      // same-symbol loss (74.00) would bridge it to 0.13; it must not.
      washLot({ proceeds: 90.87 }),
      washLot({ cost: 190.87, proceeds: 116.87, gainLoss: -74.0, openDate: '2026-08-19', closeDate: '2026-08-20' }),
    ];
    const r = reconcileLedgerFeesFromGainLoss(rows, lots);
    expect(r.updated).toBe(0);
    expect(r.washRepairs).toEqual([]);
    expect(r.rejections.map((x) => x.reason)).toEqual(['above-bound']);
  });
});

describe('diffMissingFillsFromHistory (TRA-2959)', () => {
  function rec(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-08-04', sleeve: 'single_leg_otm',
      book: null, // TRA-3977 — single-book fixture tape
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

  it('a partial shortfall imports only the uncovered contracts, at the UNCOVERED execution price', () => {
    // Broker: two executions 3 + 2 = 5 contracts sold, at DIFFERENT prices.
    // Ledger recorded only the 3 @ 0.26 — so the missing 2 are the 0.28 leg, and
    // that is DERIVED by cancellation, not guessed off whichever execution the
    // shortfall walk lands on (TRA-3563).
    const { inputs, coverage } = diffMissingFillsFromHistory(
      [rec({ side: 'sell_to_close', contracts: 3, etDay: '2026-08-04', filledPrice: 0.26 })],
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
    expect(inputs[0]!.filledPrice).toBeCloseTo(0.28, 6);
    expect(inputs[0]!.origin).toBe('history_import');
    // The invariant that matters: ledger gross now equals the broker's.
    expect(0.26 * 100 * 3 + inputs[0]!.filledPrice! * 100 * inputs[0]!.contracts).toBeCloseTo(
      0.26 * 100 * 3 + 0.28 * 100 * 2,
      6,
    );
  });

  // ── TRA-3563: the imported row must never borrow a SIBLING's price ──────────

  it('POSITIVE CONTROL: a group filled at TWO prices, ledger holds ONE — the import does NOT inherit the recorded price', () => {
    // The live 2026-08-04 shape: the engine's order filled 4 @ 0.58 and was
    // recorded; a silent 1-contract fill at 0.53 was not. The old attribution
    // walked the executions in transactionId order, landed on the 4-contract
    // leg and minted the missing contract at 0.58 — contract totals reconciled
    // (5 == 5, `missingContracts: 0`) while the ledger gross overstated the
    // broker by $5.00 and the gainloss join derived a fee of -4.47.
    const { inputs, coverage } = diffMissingFillsFromHistory(
      [rec({ optionSymbol: 'QQQ260911P00545000', contracts: 4, filledPrice: 0.58 })],
      [
        hist({ symbol: 'QQQ260911P00545000', description: 'PUT QQQ   09/11/26   545',
          amount: -232.42, quantity: 4, price: 0.58, transactionId: 't9' }),
        hist({ symbol: 'QQQ260911P00545000', description: 'PUT QQQ   09/11/26   545',
          amount: -53.11, quantity: 1, price: 0.53, transactionId: 't2' }),
      ],
      '2026-08-05',
    );
    expect(coverage.missingContracts).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.contracts).toBe(1);
    // THE ASSERTION: not 0.58. The recorded row's price is not evidence about
    // the unrecorded fill, and `transactionId` order would have picked it.
    expect(inputs[0]!.filledPrice).not.toBeCloseTo(0.58, 6);
    expect(inputs[0]!.filledPrice).toBeCloseTo(0.53, 6);
    // Gross now matches the broker: 0.58*400 + 0.53*100 = 285.00 against a lot
    // basis of 285.53 ⇒ a derived fee of +0.53, not −4.47.
    expect(0.58 * 100 * 4 + inputs[0]!.filledPrice! * 100 * 1).toBeCloseTo(285, 6);
  });

  it('an undeterminable attribution writes filledPrice null, never a sibling price', () => {
    // The ledger row is priced at something NO execution filled at (0.27 against
    // 0.26/0.28), so the cancellation leaves a remainder and no execution can be
    // claimed as the uncovered one. `null` is honest-unmeasured — the gainloss
    // join names it 'priceless-row' instead of deriving a silent negative fee.
    const { inputs } = diffMissingFillsFromHistory(
      [rec({ side: 'sell_to_close', contracts: 3, filledPrice: 0.27 })],
      [
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 80, quantity: 3, price: 0.26, transactionId: 'a' }),
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 55, quantity: 2, price: 0.28, transactionId: 'b' }),
      ],
      '2026-08-05',
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.contracts).toBe(2);
    expect(inputs[0]!.filledPrice).toBeNull();
  });

  it('a group whose executions all filled at ONE price still prices the import (nothing to choose between)', () => {
    // No cancellation is needed when there is only one candidate price — and an
    // unpriced ledger row must not downgrade it to null.
    const { inputs } = diffMissingFillsFromHistory(
      [rec({ side: 'sell_to_close', contracts: 3, filledPrice: null })],
      [
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 80, quantity: 3, price: 0.26, transactionId: 'a' }),
        hist({ description: 'CALL TSLA   09/11/26   560', amount: 55, quantity: 2, price: 0.26, transactionId: 'b' }),
      ],
      '2026-08-05',
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.contracts).toBe(2);
    expect(inputs[0]!.filledPrice).toBeCloseTo(0.26, 6);
  });

  it('a multi-price shortfall spanning executions imports ONE row PER execution price', () => {
    // Ledger holds 1 of the 0.58 leg; the uncovered volume is 3 @ 0.58 + 1 @ 0.53
    // and each gets its own row, so no row carries a price its contracts did not
    // fill at (and the group gross is exact).
    const { inputs } = diffMissingFillsFromHistory(
      [rec({ optionSymbol: 'QQQ260911P00545000', contracts: 1, filledPrice: 0.58 })],
      [
        hist({ symbol: 'QQQ260911P00545000', description: 'PUT QQQ   09/11/26   545',
          amount: -232.42, quantity: 4, price: 0.58, transactionId: 't9' }),
        hist({ symbol: 'QQQ260911P00545000', description: 'PUT QQQ   09/11/26   545',
          amount: -53.11, quantity: 1, price: 0.53, transactionId: 't2' }),
      ],
      '2026-08-05',
    );
    expect(inputs.map((i) => [i.contracts, i.filledPrice])).toEqual([[3, 0.58], [1, 0.53]]);
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

describe('repriceImportedFillsFromHistory (TRA-3563)', () => {
  function rec(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
    return {
      mode: 'live', ts: 1000, etDay: '2026-08-04', sleeve: 'single_leg_otm',
      book: null, // TRA-3977 — single-book fixture tape
      optionSymbol: 'QQQ260911P00545000', side: 'buy_to_open', contracts: 4,
      submittedLimit: 0.58, askAtSubmit: 0.58, midAtSubmit: 0.555, filledPrice: 0.58,
      fees: null, feeSource: null, slippageVsAsk: 0, slippageVsMid: 0.025,
      orderId: 140028484, origin: 'fill',
      ...over,
    };
  }
  const imported = (over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord =>
    rec({
      ts: 900, contracts: 1, sleeve: 'unattributed', submittedLimit: null, askAtSubmit: null,
      midAtSubmit: null, slippageVsAsk: null, slippageVsMid: null, orderId: null,
      origin: 'history_import', ...over,
    });
  function hist(over: Partial<TradierTradeHistoryFill>): TradierTradeHistoryFill {
    return {
      date: '2026-08-04', symbol: 'QQQ260911P00545000', tradeType: 'option',
      description: 'PUT QQQ   09/11/26   545', price: 0.58, quantity: 4,
      amount: -232.42, commission: 0, transactionId: 't9', orderId: null,
      ...over,
    };
  }
  const executions = [hist({}), hist({ price: 0.53, quantity: 1, amount: -53.11, transactionId: 't2' })];

  it('heals a row already minted at a sibling execution price (the live 2026-08-04 group)', () => {
    const r = repriceImportedFillsFromHistory([imported({ filledPrice: 0.58 }), rec({})], executions);
    expect(r.updated).toBe(1);
    expect(r.repairs).toEqual([
      { optionSymbol: 'QQQ260911P00545000', day: '2026-08-04', side: 'buy_to_open',
        contracts: 1, from: 0.58, to: 0.53 },
    ]);
    expect(r.records.map((x) => x.filledPrice)).toEqual([0.53, 0.58]);
    // The fix the ledger actually needed: gross 285.00 against a 285.53 basis.
    const gross = r.records.reduce((s, x) => s + x.filledPrice! * 100 * x.contracts, 0);
    expect(gross).toBeCloseTo(285, 6);
    // Idempotent — the repaired prices now cancel, so a second pass is a no-op.
    const again = repriceImportedFillsFromHistory(r.records, executions);
    expect(again.updated).toBe(0);
    expect(again.repairs).toEqual([]);
  });

  it('the end-to-end grade: the negative-fee rejection clears and both rows measure', () => {
    const lots: TradierGainLossLot[] = [
      { symbol: 'QQQ260911P00545000', quantity: 4, cost: 232.42, proceeds: 174.76,
        gainLoss: -57.66, openDate: '2026-08-04', closeDate: '2026-08-05' },
      { symbol: 'QQQ260911P00545000', quantity: 1, cost: 53.11, proceeds: 43.69,
        gainLoss: -9.42, openDate: '2026-08-04', closeDate: '2026-08-05' },
    ];
    const before = reconcileLedgerFeesFromGainLoss([imported({ filledPrice: 0.58 }), rec({})], lots);
    expect(before.updated).toBe(0);
    const openLeg = before.rejections.find((x) => x.side === 'buy_to_open');
    expect(openLeg?.reason).toBe('negative-fee');
    expect(openLeg?.observed).toBeCloseTo(-4.47, 6);

    const repaired = repriceImportedFillsFromHistory([imported({ filledPrice: 0.58 }), rec({})], executions);
    const after = reconcileLedgerFeesFromGainLoss(repaired.records, lots);
    expect(after.rejections.filter((x) => x.side === 'buy_to_open')).toEqual([]);
    expect(after.updated).toBe(2);
    // Apportioned pro-rata, and it lands EXACTLY on the per-lot decomposition
    // (232.42 − 232.00 = 0.42; 53.11 − 53.00 = 0.11).
    expect(after.records.map((x) => x.fees)).toEqual([0.11, 0.42]);
  });

  it('a settled fee in the group is never re-priced underneath', () => {
    // A measured row means the group already reconciled at these prices; moving
    // one now would silently invalidate a written money number.
    const r = repriceImportedFillsFromHistory(
      [imported({ filledPrice: 0.58, fees: 0.11, feeSource: 'gainloss_derived' }), rec({})],
      executions,
    );
    expect(r.updated).toBe(0);
    expect(r.repairs).toEqual([]);
  });

  it('a `fill` row is input, never output — only imported rows move', () => {
    // Both ledger rows are fill-origin and mis-priced against the broker; with no
    // imported row in the group there is nothing this pass may touch.
    const r = repriceImportedFillsFromHistory([rec({ contracts: 1, filledPrice: 0.58, ts: 900 }), rec({})], executions);
    expect(r.updated).toBe(0);
    expect(r.repairs).toEqual([]);
  });

  it('an uncovered group is left to the import pass (totals must match first)', () => {
    const r = repriceImportedFillsFromHistory([imported({ filledPrice: 0.58 })], executions);
    expect(r.updated).toBe(0);
    expect(r.repairs).toEqual([]);
  });

  it('an undeterminable group still nulls a price NO execution filled at', () => {
    // The trusted row is priced at 0.60, so the cancellation leaves a remainder
    // and nothing is derivable. But the imported row's 0.575 matches no
    // execution either — provably not the broker's number — so it is nulled
    // (named 'priceless-row') rather than left reading as a measurement.
    const r = repriceImportedFillsFromHistory(
      [imported({ filledPrice: 0.575 }), rec({ filledPrice: 0.6 })],
      executions,
    );
    expect(r.updated).toBe(1);
    expect(r.repairs).toEqual([
      { optionSymbol: 'QQQ260911P00545000', day: '2026-08-04', side: 'buy_to_open',
        contracts: 1, from: 0.575, to: null },
    ]);
  });

  it('an undeterminable group LEAVES a price some execution did fill at', () => {
    // 0.58 is a real execution price here, so it may well be the right one —
    // an undeterminable cancellation is not a licence to overwrite it. The
    // group stays `negative-fee`: named, unmeasured, and honest.
    const r = repriceImportedFillsFromHistory([imported({ filledPrice: 0.58 }), rec({ filledPrice: 0.6 })], executions);
    expect(r.updated).toBe(0);
    expect(r.repairs).toEqual([]);
  });

  it('a row straddling two execution prices goes null, never a blended price', () => {
    const straddle = repriceImportedFillsFromHistory(
      [imported({ contracts: 5, filledPrice: 0.58 })],
      executions,
    );
    expect(straddle.updated).toBe(1);
    expect(straddle.repairs[0]).toMatchObject({ from: 0.58, to: null });
    expect(straddle.records[0]!.filledPrice).toBeNull();
  });
});
