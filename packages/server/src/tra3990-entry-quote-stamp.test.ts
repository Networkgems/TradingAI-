import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { TradierOptionQuote, TradierOrderDetail } from '@trading-app/engine';
import {
  buildEntryQuoteStamp,
  deriveEntrySpreadPct,
  type OptionPosition,
} from '@trading-app/shared';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeEntryQuote,
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { EXPORT_COLUMNS, rowFromOption, toCsv } from './export.js';
import { rowFromJournalRecord } from './export-history.js';
import {
  entryQuoteStampSinceBoot,
  recordEntryQuoteStampOutcome,
  resetEntryQuoteStampForTests,
  summarizeEntryQuoteStamp,
} from './entry-quote-stamp.js';
import { submitSmartBuyToOpen } from './tradier-smart-open.js';

// TRA-3990 (parent TRA-3945) — stamp the entry quote (bid/ask/spread) on the
// option row, from the SAME snapshot the fill price came from.

// ── AC1 — the derivation ─────────────────────────────────────────────────────

describe('deriveEntrySpreadPct / buildEntryQuoteStamp (TRA-3990 AC1 + AC4)', () => {
  it('reconciles (ask − bid) / mid to 4dp on a two-sided quote', () => {
    const bid = 1.0;
    const ask = 1.2;
    const s = deriveEntrySpreadPct(bid, ask);
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo((ask - bid) / ((ask + bid) / 2), 4); // 0.1818…
    const stamp = buildEntryQuoteStamp('broker_submit', { bid, ask });
    expect(stamp).toEqual({
      entryBidAtOpen: 1.0,
      entryAskAtOpen: 1.2,
      entrySpreadPct: s,
      entryQuoteSource: 'broker_submit',
      entryQuoteReason: null,
    });
  });

  it('a perfectly tight quote is a real 0 — the only way 0 can appear', () => {
    expect(deriveEntrySpreadPct(0.5, 0.5)).toBe(0);
  });

  it('AC4 — absent quote data fails to NULL with `no_quote_snapshot`, never to a default', () => {
    for (const q of [undefined, null, {}, { bid: null, ask: null }, { bid: NaN, ask: NaN }]) {
      const stamp = buildEntryQuoteStamp('scanner', q as never);
      expect(stamp.entryBidAtOpen).toBeNull();
      expect(stamp.entryAskAtOpen).toBeNull();
      expect(stamp.entrySpreadPct).toBeNull();
      expect(stamp.entrySpreadPct).not.toBe(0);
      expect(stamp.entryQuoteReason).toBe('no_quote_snapshot');
    }
  });

  it('AC4 — an ask with no bid is `one_sided_quote`; a zero bid is NOT a tight quote', () => {
    for (const q of [{ ask: 0.75 }, { bid: 0, ask: 0.75 }, { bid: null, ask: 0.75 }]) {
      const stamp = buildEntryQuoteStamp('broker_submit', q);
      expect(stamp.entrySpreadPct).toBeNull();
      expect(stamp.entryQuoteReason).toBe('one_sided_quote');
    }
  });

  it('an inverted book (ask < bid) yields null, not a negative spread', () => {
    expect(deriveEntrySpreadPct(1.3, 1.2)).toBeNull();
    expect(buildEntryQuoteStamp('scanner', { bid: 1.3, ask: 1.2 }).entryQuoteReason).toBe('no_quote_snapshot');
  });

  it('the three numbers are non-null together or null together', () => {
    const cases = [{ bid: 1, ask: 1.1 }, { bid: 1 }, { ask: 1 }, undefined];
    for (const q of cases) {
      const s = buildEntryQuoteStamp('scanner', q);
      const nulls = [s.entryBidAtOpen, s.entryAskAtOpen, s.entrySpreadPct].filter((v) => v === null).length;
      expect(nulls === 0 || nulls === 3).toBe(true);
      expect(s.entryQuoteReason === null).toBe(nulls === 0);
    }
  });
});

// ── AC1 — the live seam carries the bid on the SAME pull as the ask ──────────

describe('submitSmartBuyToOpen carries the bid of the quote it walked (TRA-3990 AC1)', () => {
  function buildClient(over: Record<string, unknown>) {
    return {
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote)),
      buyContractsLimit: vi.fn(async () => ({ id: 100, status: 'ok' } as never)),
      cancelOrder: vi.fn(async () => undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ status: 'filled', avg_fill_price: 1.11 } as TradierOrderDetail)),
      ...over,
    };
  }

  it('two-sided quote: `bid` is the pulled bid, and the stamp built from the outcome reconciles', async () => {
    const getOptionQuote = vi.fn(async () => ({ symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote));
    const outcome = await submitSmartBuyToOpen(buildClient({ getOptionQuote }) as never, 'X', 1, { sleep: async () => {} });
    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.bid).toBe(1.0);
    expect(outcome.ask).toBe(1.2);
    // ONE quote pull — the stamp is the snapshot the ladder was priced off, not a re-fetch.
    expect(getOptionQuote).toHaveBeenCalledTimes(1);
    const stamp = buildEntryQuoteStamp('broker_submit', { bid: outcome.bid, ask: outcome.ask });
    expect(stamp.entrySpreadPct!).toBeCloseTo(0.2 / 1.1, 4);
  });

  it('ask-only quote: `bid` is null and the stamp is `one_sided_quote`', async () => {
    const outcome = await submitSmartBuyToOpen(
      buildClient({ getOptionQuote: vi.fn(async () => ({ symbol: 'X', ask: 0.75 } as TradierOptionQuote)) }) as never,
      'X', 1, { sleep: async () => {} },
    );
    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.bid).toBeNull();
    const stamp = buildEntryQuoteStamp('broker_submit', { bid: outcome.bid, ask: outcome.ask });
    expect(stamp.entrySpreadPct).toBeNull();
    expect(stamp.entryQuoteReason).toBe('one_sided_quote');
  });
});

// ── AC2 — survives the close and a reload from disk (the archive-served path) ─

describe('journal: the stamp survives the close and a reload (TRA-3990 AC2)', () => {
  let tmpFile: string;
  let counter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra3990-${process.pid}-${counter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  function baseOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
    return {
      id: 'pos-1',
      openTs: 1,
      symbol: 'AAPL',
      structure: 'single_leg_otm',
      mode: 'live',
      ivRank: null,
      trend: 'up',
      sentiment: null,
      entryDelta: 0.5,
      entryDte: 40,
      atRiskUsd: 100,
      ...over,
    };
  }

  it('open with a scanner stamp → broker amend → close → reload: the broker stamp is what is served', async () => {
    const scanner = buildEntryQuoteStamp('scanner', { bid: 1.0, ask: 1.2 });
    await recordOptionTradeOpen(baseOpen({ ...scanner }));
    let rows = await listOptionTradeJournal();
    expect(rows[0].entryQuoteSource).toBe('scanner');
    expect(rows[0].entrySpreadPct!).toBeCloseTo(0.2 / 1.1, 4);

    const broker = buildEntryQuoteStamp('broker_submit', { bid: 1.05, ask: 1.15 });
    expect(await recordOptionTradeEntryQuote('pos-1', broker)).toBe(true);
    await recordOptionTradeClose('pos-1', {
      closeTs: 10, outcome: 'WIN', realizedPnlUsd: 50, realizedR: 0.5, exitReason: 'tp1', holdDays: 1,
    });

    // Re-point at the same file to force a fresh fold from the JSONL — this is
    // the archive-served path: the book row is gone, the journal is the source.
    setOptionTradeJournalFileForTests(tmpFile);
    rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('WIN');
    expect(rows[0].entryQuoteSource).toBe('broker_submit');
    expect(rows[0].entryBidAtOpen).toBe(1.05);
    expect(rows[0].entryAskAtOpen).toBe(1.15);
    expect(rows[0].entrySpreadPct!).toBeCloseTo(0.1 / 1.1, 4);
    expect(rows[0].entryQuoteReason).toBeNull();
    // The TRA-1656 scanner triple is NOT moved out from under the spread-cost rollup.
    expect(rows[0].entryBid).toBeUndefined();

    // And the export publishes it from the journal-served row.
    const exported = rowFromJournalRecord(rows[0]);
    expect(exported.source).toBe('journal');
    expect(exported.entry_spread_pct!).toBeCloseTo(0.1 / 1.1, 4);
  });

  it('an unmeasured broker quote supersedes the scanner figure with NULLS + reason, never leaves it standing', async () => {
    await recordOptionTradeOpen(baseOpen({ ...buildEntryQuoteStamp('scanner', { bid: 1.0, ask: 1.2 }) }));
    await recordOptionTradeEntryQuote('pos-1', buildEntryQuoteStamp('broker_submit', { ask: 1.2 }));
    const rows = await listOptionTradeJournal();
    expect(rows[0].entryQuoteSource).toBe('broker_submit');
    expect(rows[0].entrySpreadPct).toBeNull();
    expect(rows[0].entryQuoteReason).toBe('one_sided_quote');
    expect(rowFromJournalRecord(rows[0]).entry_spread_pct).toBeNull();
  });

  it('refuses to amend a closed row and an unknown id', async () => {
    await recordOptionTradeOpen(baseOpen());
    await recordOptionTradeClose('pos-1', {
      closeTs: 10, outcome: 'LOSS', realizedPnlUsd: -50, realizedR: -0.5, exitReason: 'sl', holdDays: 1,
    });
    expect(await recordOptionTradeEntryQuote('pos-1', buildEntryQuoteStamp('broker_submit', { bid: 1, ask: 1.1 }))).toBe(false);
    expect(await recordOptionTradeEntryQuote('missing', buildEntryQuoteStamp('broker_submit', { bid: 1, ask: 1.1 }))).toBe(false);
  });

  it('a malformed amend line (spread that does not reconcile to its bid/ask) is ignored, not half-applied', async () => {
    await recordOptionTradeOpen(baseOpen({ ...buildEntryQuoteStamp('scanner', { bid: 1.0, ask: 1.2 }) }));
    // The writer refuses it whole (no line appended) …
    expect(await recordOptionTradeEntryQuote('pos-1', {
      entryBidAtOpen: 1.0, entryAskAtOpen: 1.2, entrySpreadPct: 0, entryQuoteSource: 'broker_submit', entryQuoteReason: null,
    })).toBe(false);
    // … and a `0` with no quote behind it is refused too: a zero is only ever a REAL tight quote.
    expect(await recordOptionTradeEntryQuote('pos-1', {
      entryBidAtOpen: null, entryAskAtOpen: null, entrySpreadPct: 0, entryQuoteSource: 'broker_submit', entryQuoteReason: null,
    })).toBe(false);
    const rows = await listOptionTradeJournal();
    expect(rows[0].entryQuoteSource).toBe('scanner');
    expect(rows[0].entrySpreadPct!).toBeCloseTo(0.2 / 1.1, 4);
  });

  it('AC5 — a pre-TRA-3990 row (no stamp) is served with no spread and no reason: absent, never reconstructed', async () => {
    await recordOptionTradeOpen(baseOpen({ entryBid: 1.0, entryAsk: 1.2, entryMarkUsd: 1.1 }));
    const rows = await listOptionTradeJournal();
    expect(rows[0].entrySpreadPct).toBeUndefined();
    expect(rows[0].entryQuoteSource).toBeUndefined();
    // The TRA-1656 scanner quote is on the row and is deliberately NOT used to
    // synthesize `entry_spread_pct`: null, never a number this build did not stamp.
    expect(rowFromJournalRecord(rows[0]).entry_spread_pct).toBeNull();
  });
});

// ── AC3 — the export column ──────────────────────────────────────────────────

describe('/api/trades/export `entry_spread_pct` (TRA-3990 AC3)', () => {
  function opt(over: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: 'lot-1',
      symbol: 'SPY',
      optionSymbol: 'SPY260918C00650000',
      optionType: 'call',
      strike: 650,
      expiration: '2026-09-18',
      contracts: 1,
      contractsRemaining: 0,
      premiumPaid: 1.1,
      currentPremium: 0.9,
      tp1Premium: 1.375,
      tp1Hit: false,
      stopLossPremium: 0.88,
      peakPremium: 1.1,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: 640,
      openedAt: Date.UTC(2026, 7, 25, 14, 0, 0),
      closedAt: Date.UTC(2026, 7, 25, 18, 0, 0),
      pnl: -20,
      signalId: 'sig',
      signalType: 'otm_mispricing',
      mode: 'live',
      ...over,
    };
  }

  it('header contains it, LAST', () => {
    expect(EXPORT_COLUMNS[EXPORT_COLUMNS.length - 1]).toBe('entry_spread_pct');
    expect(toCsv([]).split('\r\n')[0].endsWith(',entry_spread_pct')).toBe(true);
  });

  it('a stamped row publishes the stamp; a pre-ship row publishes NULL (never 0)', () => {
    const stamped = rowFromOption(opt({ ...buildEntryQuoteStamp('broker_submit', { bid: 1.0, ask: 1.2 }) }));
    expect(stamped.entry_spread_pct!).toBeCloseTo(0.2 / 1.1, 4);
    const pre = rowFromOption(opt());
    expect(pre.entry_spread_pct).toBeNull();
    expect(pre.entry_spread_pct).not.toBe(0);
    // CSV: blank cell, not "0".
    const line = toCsv([pre]).split('\r\n')[1];
    expect(line.endsWith(',')).toBe(true);
    expect(line.split(',')[EXPORT_COLUMNS.indexOf('entry_spread_pct')]).toBe('');
  });

  it('a stamped-but-unmeasured row (no_quote_snapshot) publishes NULL', () => {
    const row = rowFromOption(opt({ ...buildEntryQuoteStamp('scanner', undefined) }));
    expect(row.entry_spread_pct).toBeNull();
  });

  it('a NaN on the row is a blank, not a number', () => {
    expect(rowFromOption(opt({ entrySpreadPct: NaN })).entry_spread_pct).toBeNull();
  });
});

// ── AC4 — the health surface ─────────────────────────────────────────────────

describe('entry-quote stamp health surface (TRA-3990 AC4)', () => {
  beforeEach(() => resetEntryQuoteStampForTests());

  it('since-boot: counts measured and unmeasured by reason and source; stamped === measured + Σ byReason', () => {
    recordEntryQuoteStampOutcome(buildEntryQuoteStamp('scanner', { bid: 1, ask: 1.1 }), 100);
    recordEntryQuoteStampOutcome(buildEntryQuoteStamp('broker_submit', { bid: 1, ask: 1.1 }), 200);
    recordEntryQuoteStampOutcome(buildEntryQuoteStamp('broker_submit', { ask: 1.1 }), 300);
    recordEntryQuoteStampOutcome(buildEntryQuoteStamp('scanner', undefined), 400);
    const s = entryQuoteStampSinceBoot();
    expect(s.stamped).toBe(4);
    expect(s.measured).toBe(2);
    expect(s.byReason).toEqual({ no_quote_snapshot: 1, one_sided_quote: 1 });
    expect(s.bySource).toEqual({ scanner: 2, broker_submit: 2 });
    expect(s.stamped).toBe(s.measured + s.byReason.no_quote_snapshot + s.byReason.one_sided_quote);
    expect(s.lastStampedAt).toBe(400);
  });

  it('a fresh boot reads 0 everywhere and `lastStampedAt: null` — never-exercised, not clean', () => {
    const s = entryQuoteStampSinceBoot();
    expect(s.stamped).toBe(0);
    expect(s.lastStampedAt).toBeNull();
  });

  function rec(over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
    return {
      id: over.id ?? 'x', openTs: 1, symbol: 'AAPL', structure: 'single_leg_otm', mode: 'live', ivRank: null,
      trend: 'up', sentiment: null, entryDelta: 0.5, entryDte: 40, atRiskUsd: 100, outcome: 'OPEN', ...over,
    };
  }

  it('durable: pre-stamp rows are `unstamped`, NOT a refusal; live is folded separately', () => {
    const d = summarizeEntryQuoteStamp([
      rec({ id: 'a' }), // pre-TRA-3990
      rec({ id: 'b', mode: 'demo' }), // pre-TRA-3990, demo
      rec({ id: 'c', ...buildEntryQuoteStamp('broker_submit', { bid: 1, ask: 1.1 }) }),
      rec({ id: 'd', ...buildEntryQuoteStamp('broker_submit', { ask: 1.1 }) }),
      rec({ id: 'e', mode: 'demo', ...buildEntryQuoteStamp('scanner', undefined) }),
      // A spread with no source was never written by this build — untrusted, unstamped.
      rec({ id: 'f', entrySpreadPct: 0.05 }),
    ]);
    expect(d.rowsTraversed).toBe(6);
    expect(d.unstamped).toBe(3);
    expect(d.stamped).toBe(3);
    expect(d.measured).toBe(1);
    expect(d.byReason).toEqual({ no_quote_snapshot: 1, one_sided_quote: 1 });
    expect(d.live).toEqual({
      rowsTraversed: 4, unstamped: 2, stamped: 2, measured: 1,
      byReason: { no_quote_snapshot: 0, one_sided_quote: 1 },
      bySource: { scanner: 0, broker_submit: 2 },
    });
  });
});
