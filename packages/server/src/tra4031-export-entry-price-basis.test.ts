// TRA-4031 (parent TRA-3989) — `/api/trades/export` published `entry_price` in
// TWO bases for the SAME closed option row, selected by whether the 21:00 ET
// `archiveClosedOptions()` had run:
//
//   BOOK-sourced row (`rowFromOption`):            entry_price ← `premiumPaid`
//     — the broker-reconciled basis `restateEngineOpenedBasis()` installs and the
//     stop schedule / `profitLockDecision` consume.
//   JOURNAL-sourced row (`rowFromJournalRecord`):  entry_price ← `entryMarkUsd`
//     — the scanner's PRE-TRADE MID stamped at the journal OPEN write, on every
//     row the TRA-2819 sweep did not restate (it skips `fees_unmeasured` lots).
//
// Measured on `NVTS261002C00012500` (live, otm_mispricing, journal `63a5bc3a`):
//
//   | read                      | route   | entry_price | exit_price | pnl_r_stop_basis |
//   | 2026-08-25 pre-archive    | book    | 1.51        | 1.52       | 0.033            |
//   | 2026-08-26T04:3xZ post    | journal | 1.395       | null       | null             |
//
// 1.51 / 1.395 = 1.082 — the row was rebased +8.2% to broker truth after open and
// the journal-served export never learned it. The fixtures below are those
// literals, verbatim (entry mid 1.395 / basis 1.51 / exit 1.52 / net +1.00).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';
import {
  rowFromOption,
  rowFromPosition,
  buildRows,
  toCsv,
  toJsonDocument,
  applyMoneyRestatement,
  EXPORT_COLUMNS,
  type ExportMoneyRestatement,
} from './export.js';
import { rowFromJournalRecord, collectJournalMoneyRestatements } from './export-history.js';
import {
  listOptionTradeJournal,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseSupersede,
  getOptionTradeJournalRecord,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
  type OptionTradeJournalOpen,
} from './option-trade-journal.js';
import { PaperOptionsAccount } from './options-account.js';

const OPEN = Date.parse('2026-08-24T14:44:33Z');
const CLOSE = Date.parse('2026-08-25T13:45:23Z');

const NVTS_MID = 1.395;   // scanner mid at the journal OPEN write (`entryMarkUsd`)
const NVTS_BASIS = 1.51;  // `premiumPaid` after `restateEngineOpenedBasis` — the basis the exit rule consumed
const NVTS_EXIT = 1.52;   // `currentPremium` at close
const NVTS_NET = 1.00;    // (1.52 − 1.51) × 1 × 100

/** The NVTS book row as `archiveClosedOptions()` would have found it. */
function nvts(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'lot-nvts',
    symbol: 'NVTS',
    optionSymbol: 'NVTS261002C00012500',
    optionType: 'call',
    strike: 12.5,
    expiration: '2026-10-02',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: NVTS_BASIS,
    currentPremium: NVTS_EXIT,
    tp1Premium: 1.8875,
    tp1Hit: false,
    stopLossPremium: 1.208,
    peakPremium: 1.822,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 12.9,
    openedAt: OPEN,
    closedAt: CLOSE,
    pnl: NVTS_NET,
    exitReason: 'profit_lock',
    signalId: 'sig-nvts',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...over,
  } as OptionPosition;
}

/**
 * The journal's record of the same close. `entryMarkUsd` is the OPEN write's
 * mid; `entryBasisPremium` is what the CLOSE write carries since this ticket —
 * omitted by default so each test says which world it is in.
 */
function journalTwin(opt: OptionPosition, over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  const atRiskUsd = NVTS_MID * opt.contracts * 100;
  return {
    id: opt.id,
    openTs: opt.openedAt,
    symbol: opt.symbol,
    structure: 'single_leg_otm',
    mode: opt.mode ?? 'live',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    entryDelta: 0.52,
    entryDte: 39,
    atRiskUsd,
    account: 'admin',
    outcome: 'WIN',
    closeTs: opt.closedAt,
    realizedPnlUsd: opt.pnl,
    realizedR: (opt.pnl as number) / atRiskUsd,
    exitReason: opt.exitReason,
    optionSymbol: opt.optionSymbol,
    contracts: opt.contracts,
    entryMarkUsd: NVTS_MID,
    ...over,
  } as OptionTradeJournalRecord;
}

// ── AC1 / AC3 — one basis per row, named; the two mappers agree ─────────────

describe('TRA-4031 AC1/AC3 — the journal-sourced row publishes the SAME `entry_price` the book-sourced row did (NVTS literals)', () => {
  it('book 1.51 == journal 1.51 once the CLOSE row carries `entryBasisPremium`; both labelled `book-basis`', () => {
    // TRA-4031 — the regression the ticket asks for: entry mid 1.395 / basis
    // 1.51 / exit 1.52 / net +1.00. Equality, not closeness.
    const book = rowFromOption(nvts());
    const journal = rowFromJournalRecord(journalTwin(nvts(), { entryBasisPremium: NVTS_BASIS }));
    expect(book.source).toBe('book');
    expect(journal.source).toBe('journal');
    expect(book.entry_price).toBe(NVTS_BASIS);
    expect(journal.entry_price).toBe(NVTS_BASIS);
    expect(book.entry_price).toBe(journal.entry_price);
    expect(book.entry_price_basis).toBe('book-basis');
    expect(journal.entry_price_basis).toBe('book-basis');
    // The book-only columns from the filing table still read as filed.
    expect(book.exit_price).toBe(NVTS_EXIT);
    expect(book.net_pnl_usd).toBe(NVTS_NET);
    expect(book.pnl_r_stop_basis).toBeCloseTo(0.033, 3);
    expect(journal.net_pnl_usd).toBe(NVTS_NET);
  });

  it('NEGATIVE CONTROL — without the stamp the journal row publishes the 1.395 mid, and the two mappers DISAGREE by 8.2%', () => {
    // This is the live 2026-08-26T04:3xZ read. The assertion is the defect,
    // pinned, so a mapper that silently stopped preferring the basis fails here
    // by AGREEING with this block's inequality being violated in the block above.
    const book = rowFromOption(nvts());
    const journal = rowFromJournalRecord(journalTwin(nvts()));
    expect(journal.entry_price).toBe(NVTS_MID);
    expect(book.entry_price).not.toBe(journal.entry_price);
    expect((book.entry_price as number) / (journal.entry_price as number)).toBeCloseTo(1.082, 3);
    expect(journal.entry_price_basis).toBe('pre-trade-mid');
  });

  it('a restated row (broker fill measured) wins over the book basis, and says `broker-fill`', () => {
    const journal = rowFromJournalRecord(journalTwin(nvts(), {
      entryBasisPremium: NVTS_BASIS,
      pnlBasis: 'broker-fill', feesUsd: 0.35, entryFillPremium: 1.505, exitFillPremium: 1.52,
      realizedPnlUsd: 1.15,
    } as Partial<OptionTradeJournalRecord>));
    expect(journal.entry_price).toBe(1.505);
    expect(journal.entry_price_basis).toBe('broker-fill');
  });

  it('a restated row whose restatement carries NO entry fill falls back to the book basis, not the mid', () => {
    const journal = rowFromJournalRecord(journalTwin(nvts(), {
      entryBasisPremium: NVTS_BASIS,
      pnlBasis: 'broker-fill', feesUsd: 0.35, exitFillPremium: 1.52,
    } as Partial<OptionTradeJournalRecord>));
    expect(journal.entry_price).toBe(NVTS_BASIS);
    expect(journal.entry_price_basis).toBe('book-basis');
  });

  it('a non-finite or non-positive `entryBasisPremium` is not a basis — the row falls through to the mid and says so', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const journal = rowFromJournalRecord(journalTwin(nvts(), { entryBasisPremium: bad }));
      expect(journal.entry_price).toBe(NVTS_MID);
      expect(journal.entry_price_basis).toBe('pre-trade-mid');
    }
  });

  it('a row with no entry at all publishes null AND a null label (never a stand-in)', () => {
    const journal = rowFromJournalRecord(journalTwin(nvts(), { entryMarkUsd: undefined } as Partial<OptionTradeJournalRecord>));
    expect(journal.entry_price).toBeNull();
    expect(journal.entry_price_basis).toBeNull();
    const book = rowFromOption(nvts({ premiumPaid: NaN }));
    expect(book.entry_price).toBeNull();
    expect(book.entry_price_basis).toBeNull();
  });
});

// ── AC1 (cont.) — the label is on EVERY row, JSON-only ──────────────────────

describe('TRA-4031 AC1 — `entry_price_basis` is on every row, and is JSON-only', () => {
  it('book, journal and equity rows all carry a label in one document; the CSV header is byte-identical', () => {
    const eq = rowFromPosition(
      {
        id: 's1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout', entryPrice: 100, quantity: 10,
        stopLoss: 95, takeProfit: 115, openedAt: OPEN, closedAt: CLOSE, exitPrice: 110, pnl: 100,
        exitReason: 'target', mode: 'live',
      },
      'stocks',
    );
    expect(eq.entry_price_basis).toBe('book-basis');
    const doc = toJsonDocument(
      buildRows({
        optionsClosed: [nvts()],
        preMappedRows: [
          rowFromJournalRecord(journalTwin(nvts({ id: 'lot-archived-new' }), { id: 'lot-archived-new', entryBasisPremium: NVTS_BASIS })),
          rowFromJournalRecord(journalTwin(nvts({ id: 'lot-archived-old' }), { id: 'lot-archived-old' })),
        ],
      }),
      {},
    );
    expect(doc.trades).toHaveLength(3);
    const labels = doc.trades.map(r => `${r.source}:${r.entry_price_basis}`).sort();
    expect(labels).toEqual(['book:book-basis', 'journal:book-basis', 'journal:pre-trade-mid']);
    for (const r of doc.trades) expect(r.entry_price_basis).toBeDefined();
    // JSON-only, like `source` / `pnl_basis` / `pnl_r_basis`.
    expect(EXPORT_COLUMNS).not.toContain('entry_price_basis');
    const header = toCsv(doc.trades).split('\r\n')[0];
    expect(header.split(',')).not.toContain('entry_price_basis');
    expect(header).toBe(EXPORT_COLUMNS.join(','));
  });

  it('the restatement overlay moves the label WITH the figure, and an unmeasured entry deletes neither', () => {
    const row = rowFromOption(nvts());
    const restatement: ExportMoneyRestatement = {
      gross_pnl_usd: 1.0, fees_usd: 0.35, net_pnl_usd: 0.65, pnl_r: 0.005,
      exit_price: 1.52, entry_price: 1.505, entry_price_basis: 'broker-fill', broker_order_id: 143032832,
    };
    const restated = applyMoneyRestatement(row, restatement);
    expect(restated.entry_price).toBe(1.505);
    expect(restated.entry_price_basis).toBe('broker-fill');
    // A pre-ticket fixture that names no label but states a fill is a broker fill.
    const unlabelled = applyMoneyRestatement(row, { ...restatement, entry_price_basis: undefined });
    expect(unlabelled.entry_price_basis).toBe('broker-fill');
    // No entry measured ⇒ the book's figure AND label survive (same rule as `entry_price`).
    const kept = applyMoneyRestatement(row, { ...restatement, entry_price: null, entry_price_basis: null });
    expect(kept.entry_price).toBe(NVTS_BASIS);
    expect(kept.entry_price_basis).toBe('book-basis');
  });

  it('`collectJournalMoneyRestatements` carries the label onto the book row it restates', () => {
    const opt = nvts();
    const twin = journalTwin(opt, {
      entryBasisPremium: NVTS_BASIS,
      pnlBasis: 'broker-fill', feesUsd: 0.35, entryFillPremium: 1.505, exitFillPremium: 1.52, realizedPnlUsd: 0.65,
    } as Partial<OptionTradeJournalRecord>);
    const restatements = collectJournalMoneyRestatements([twin], new Set([opt.id]));
    expect(restatements.get(opt.id)?.entry_price_basis).toBe('broker-fill');
    const row = buildRows({ optionsClosed: [opt], optionMoneyRestatements: restatements })[0];
    expect(row.pnl_basis).toBe('broker-fill');
    expect(row.entry_price).toBe(1.505);
    expect(row.entry_price_basis).toBe('broker-fill');
  });
});

// ── AC2 — the reconcile amends, or the close carries it (real journal) ───────

describe('TRA-4031 AC2 — open at mark 1.395, restate to 1.51, close at 1.52 → journal-sourced row reads 1.51 / `book-basis`', () => {
  let tmpFile: string;
  let fileCounter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra4031-journal-${process.pid}-${fileCounter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
    vi.useFakeTimers();
    vi.setSystemTime(OPEN);
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  function signal(): OtmMispricingSignal {
    return {
      id: 'sig-nvts',
      symbol: 'NVTS',
      type: 'otm_mispricing',
      side: 'buy',
      entryPrice: NVTS_MID,
      stopLoss: 1.116,
      takeProfit: 2.0,
      riskRewardRatio: 2,
      timestamp: OPEN,
      optionSymbol: 'NVTS261002C00012500',
      optionType: 'call',
      strike: 12.5,
      expiration: '2026-10-02',
      mark: NVTS_MID,
      // `quoteOf(signal, rawMark)` stamps `entryMarkUsd` on the journal OPEN
      // only when the signal carries a bid/ask; 1.38/1.41 straddles the 1.395 mid.
      bid: 1.38,
      ask: 1.41,
      theo: 1.7,
      mispricingPct: -0.18,
      delta: 0.2,
    } as OtmMispricingSignal;
  }

  it('the CLOSE write carries the POST-restatement `premiumPaid`, and the folded record publishes it', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(signal(), 'live', 50_000, undefined, {
      ivRank: 18, trend: 'up', sentiment: null,
      riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: 'options_single_leg',
    });
    expect(pos).not.toBeNull();
    expect(pos!.premiumPaid).toBe(NVTS_MID);
    await acct.flushOptionTradeJournal();
    const openRec = await getOptionTradeJournalRecord(pos!.id);
    expect(openRec?.entryMarkUsd).toBe(NVTS_MID);
    expect(openRec?.entryBasisPremium).toBeUndefined();

    // The mirror reconcile's `restateEngineOpenedBasis` (`options-account.ts`)
    // is exactly `opt.premiumPaid = brokerPremium` plus a schedule rescale; it
    // is module-private, so the write it does is reproduced on the live row.
    const live = acct.getState().openOptions.find(o => o.id === pos!.id)!;
    live.premiumPaid = NVTS_BASIS;

    vi.setSystemTime(CLOSE);
    const closed = acct.closeOption(pos!.id, NVTS_EXIT, 'profit_lock');
    expect(closed).not.toBeNull();
    expect(closed!.pnl).toBeCloseTo(NVTS_NET, 9);
    await acct.flushOptionTradeJournal();

    const rec = (await listOptionTradeJournal()).find(r => r.id === pos!.id)!;
    expect(rec.outcome).not.toBe('OPEN');
    expect(rec.entryMarkUsd).toBe(NVTS_MID);        // the OPEN write is NOT rewritten (AC4)
    expect(rec.entryBasisPremium).toBe(NVTS_BASIS); // the CLOSE write carries the basis
    // …and the two export reads of this close agree.
    const bookRow = rowFromOption(closed!);
    const journalRow = rowFromJournalRecord(rec);
    expect(bookRow.entry_price).toBe(NVTS_BASIS);
    expect(journalRow.entry_price).toBe(NVTS_BASIS);
    expect(journalRow.entry_price_basis).toBe('book-basis');
    expect(bookRow.entry_price_basis).toBe('book-basis');
  });

  it('the field survives a cold re-fold of the file (it is on the LINE, not just in memory)', async () => {
    const open: OptionTradeJournalOpen = {
      id: 'cold-1', openTs: OPEN, symbol: 'NVTS', structure: 'single_leg_otm', mode: 'live',
      ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.2, entryDte: 39, atRiskUsd: 139.5,
      account: 'admin', optionSymbol: 'NVTS261002C00012500', contracts: 1, entryMarkUsd: NVTS_MID,
    } as OptionTradeJournalOpen;
    expect(await recordOptionTradeOpen(open)).toBe(true);
    expect(await recordOptionTradeClose('cold-1', {
      closeTs: CLOSE, outcome: 'WIN', realizedPnlUsd: NVTS_NET, realizedR: NVTS_NET / 139.5,
      exitReason: 'profit_lock', holdDays: 0.96, brokerOrderId: 143196771, entryBasisPremium: NVTS_BASIS,
    })).toBe('written');
    // Re-point at the same file: drops the cache, replays the lines.
    setOptionTradeJournalFileForTests(tmpFile);
    const rec = await getOptionTradeJournalRecord('cold-1');
    expect(rec?.entryBasisPremium).toBe(NVTS_BASIS);
    expect(rowFromJournalRecord(rec!).entry_price).toBe(NVTS_BASIS);
  });

  it('a SUPERSEDING close (TRA-4004) names its own basis or none — never the replaced close\'s', async () => {
    const open: OptionTradeJournalOpen = {
      id: 'sup-1', openTs: OPEN, symbol: 'NVTS', structure: 'single_leg_otm', mode: 'live',
      ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.2, entryDte: 39, atRiskUsd: 139.5,
      account: 'admin', optionSymbol: 'NVTS261002C00012500', contracts: 1, entryMarkUsd: NVTS_MID,
    } as OptionTradeJournalOpen;
    await recordOptionTradeOpen(open);
    await recordOptionTradeClose('sup-1', {
      closeTs: CLOSE, outcome: 'LOSS', realizedPnlUsd: -74, realizedR: -74 / 139.5,
      exitReason: 'reconstructed-TRA-3472', holdDays: 0.96, brokerOrderId: null, entryBasisPremium: 0.99,
    });
    // The real close, three days later, with no basis on it.
    const bare = await recordOptionTradeCloseSupersede('sup-1', {
      closeTs: CLOSE + 3 * 86_400_000, outcome: 'WIN', realizedPnlUsd: NVTS_NET, realizedR: NVTS_NET / 139.5,
      exitReason: 'profit_lock', holdDays: 3.96, brokerOrderId: 143196771,
    }, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, CLOSE + 3 * 86_400_000);
    expect(bare.applied).toBe(true);
    let rec = await getOptionTradeJournalRecord('sup-1');
    expect(rec?.entryBasisPremium).toBeUndefined();
    expect(rowFromJournalRecord(rec!).entry_price_basis).toBe('pre-trade-mid');
    // And a superseding close that DOES carry one installs its own.
    const named = await recordOptionTradeCloseSupersede('sup-1', {
      closeTs: CLOSE + 6 * 86_400_000, outcome: 'WIN', realizedPnlUsd: NVTS_NET, realizedR: NVTS_NET / 139.5,
      exitReason: 'profit_lock', holdDays: 6.96, brokerOrderId: 143196771, entryBasisPremium: NVTS_BASIS,
    }, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, CLOSE + 6 * 86_400_000);
    expect(named.applied).toBe(true);
    rec = await getOptionTradeJournalRecord('sup-1');
    expect(rec?.entryBasisPremium).toBe(NVTS_BASIS);
  });
});

// ── AC4 — forward-only: a pre-fix row keeps the mid, and SAYS so ─────────────

describe('TRA-4031 AC4 — a pre-fix journal row keeps publishing `entryMarkUsd` under `pre-trade-mid`; nothing is backfilled', () => {
  it('the discontinuity is visible in the column, not hidden', () => {
    const preFix = rowFromJournalRecord(journalTwin(nvts({ id: 'lot-pre' }), { id: 'lot-pre' }));
    const postFix = rowFromJournalRecord(journalTwin(nvts({ id: 'lot-post' }), { id: 'lot-post', entryBasisPremium: NVTS_BASIS }));
    expect(preFix.entry_price).toBe(NVTS_MID);
    expect(preFix.entry_price_basis).toBe('pre-trade-mid');
    expect(postFix.entry_price).toBe(NVTS_BASIS);
    expect(postFix.entry_price_basis).toBe('book-basis');
    // A reader partitions on the label; it never has to know the deploy date.
    expect(preFix.entry_price_basis).not.toBe(postFix.entry_price_basis);
  });
});
