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
  backfillLiveOptionFees,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';
import type { TradierTradeHistoryFill } from '@trading-app/engine';

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
      fees: null, slippageVsAsk: 0.01, slippageVsMid: 0.03, orderId: 42,
      ...over,
    };
  }

  function histFill(over: Partial<TradierTradeHistoryFill>): TradierTradeHistoryFill {
    return {
      date: '2026-07-16', symbol: 'AAPL240705C00210000', tradeType: 'option',
      description: 'Buy to Open 1 AAPL240705C00210000 @ 0.83', price: 0.83, quantity: 1,
      amount: -83, commission: 0.35, transactionId: 't1',
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
    // Two identical ledger rows, but only ONE history fill: the earlier-ts row wins,
    // the other stays honest-null (never a fabricated 0).
    const rows = [
      ledgerRow({ ts: 3000, orderId: 2 }),
      ledgerRow({ ts: 1000, orderId: 1 }),
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

  it('ignores equity and non-open/close history rows', () => {
    const { updated, records } = reconcileLedgerFees(
      [ledgerRow({})],
      [
        histFill({ tradeType: 'equity', commission: 0.35 }),
        histFill({ description: 'Sell to Open 1 ...', commission: 0.35 }),
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
      fees: null, orderId: 42,
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
