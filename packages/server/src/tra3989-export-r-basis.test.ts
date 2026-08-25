import { describe, it, expect } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import {
  rowFromOption,
  rowFromPosition,
  buildRows,
  toCsv,
  toJsonDocument,
  applyMoneyRestatement,
  optionPremiumRiskUsd,
  optionStopRiskUsd,
  EXPORT_COLUMNS,
  type ExportMoneyRestatement,
} from './export.js';
import { rowFromJournalRecord } from './export-history.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3989 — `/api/trades/export` published `pnl_r` in TWO units, selected by
// whether the 21:00 ET archive had run:
//
//   BOOK-served rows (today's closes):   R = pnl ÷ stop distance   ("gate R")
//   JOURNAL-served rows (archived):      R = pnl ÷ full premium    (`realizedR`)
//
// Measured live 2026-08-24T20:4xZ on bqb1 `07cc4ba4`: 96/98 rows reconciled to
// the premium basis; the two that did not were the two closes from THAT day,
// still book-served, inflated 5.0× (RIG) and 4.0× (BAC). TRA-3945's verdict rule
// (`avgR > 0 AND seR < 0.1` at 30 closes) is graded off this column, and the
// bias is directional: losers terminate at a stop and are read same-day.
//
// The fixtures below are the two live rows from the filing, verbatim.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN = Date.parse('2026-08-21T18:04:24.494Z');
const CLOSE = Date.parse('2026-08-24T15:15:55.327Z');

/** RIG260925C00006000 — entry 0.33, gross −15.00, 20% stop ⇒ stopLossPremium 0.264. */
function rig(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'lot-rig',
    symbol: 'RIG',
    optionSymbol: 'RIG260925C00006000',
    optionType: 'call',
    strike: 6,
    expiration: '2026-09-25',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 0.33,
    currentPremium: 0.18,
    tp1Premium: 0.4125,
    tp1Hit: false,
    stopLossPremium: 0.264,
    peakPremium: 0.33,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 6.2,
    openedAt: OPEN,
    closedAt: CLOSE,
    pnl: -15,
    exitReason: 'sl_otm_premium_pct',
    signalId: 'sig-rig',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...over,
  } as OptionPosition;
}

/** BAC260925C00063000 — entry 1.17, gross −3.00, 25% stop ⇒ stopLossPremium 0.8775. */
function bac(over: Partial<OptionPosition> = {}): OptionPosition {
  return rig({
    id: 'lot-bac',
    symbol: 'BAC',
    optionSymbol: 'BAC260925C00063000',
    strike: 63,
    premiumPaid: 1.17,
    currentPremium: 1.14,
    tp1Premium: 1.4625,
    stopLossPremium: 0.8775,
    peakPremium: 1.2,
    pnl: -3,
    exitReason: 'chandelier_daily_close',
    signalId: 'sig-bac',
    ...over,
  });
}

/** The journal's record of the SAME close — `atRiskUsd` is the full premium at open. */
function journalTwin(opt: OptionPosition, over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  const atRiskUsd = opt.premiumPaid * opt.contracts * 100;
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
    entryDte: 35,
    atRiskUsd,
    account: 'admin',
    outcome: 'LOSS',
    closeTs: opt.closedAt,
    realizedPnlUsd: opt.pnl,
    realizedR: (opt.pnl as number) / atRiskUsd,
    exitReason: opt.exitReason,
    optionSymbol: opt.optionSymbol,
    contracts: opt.contracts,
    entryMarkUsd: opt.premiumPaid,
    ...over,
  } as OptionTradeJournalRecord;
}

// ── AC1 — ONE basis for every options row, and it is the journal's ───────────

describe('TRA-3989 AC1 — `pnl_r` on a BOOK-served options row is in the JOURNAL basis', () => {
  it('RIG reads −0.455, not the −2.273 the stop basis published (5.0× inflation)', () => {
    const row = rowFromOption(rig());
    expect(row.pnl_r).toBeCloseTo(-0.455, 3);
    expect(row.pnl_r).not.toBeCloseTo(-2.273, 2);
  });

  it('BAC reads −0.026, not the −0.103 the stop basis published (4.0× inflation)', () => {
    const row = rowFromOption(bac());
    expect(row.pnl_r).toBeCloseTo(-0.026, 3);
    expect(row.pnl_r).not.toBeCloseTo(-0.103, 2);
  });

  it('a journal-served twin of the same close publishes the SAME `pnl_r`', () => {
    const book = rowFromOption(rig());
    const journal = rowFromJournalRecord(journalTwin(rig()));
    expect(journal.source).toBe('journal');
    expect(book.source).toBe('book');
    expect(book.pnl_r).toBe(journal.pnl_r);
  });

  it('the unit is stated on the row, never inferred from the clock', () => {
    expect(rowFromOption(rig()).pnl_r_basis).toBe('premium');
    expect(rowFromJournalRecord(journalTwin(rig())).pnl_r_basis).toBe('premium');
    // …and an equity row says the OTHER thing, because for equities the stop IS
    // the risk unit. A reader of the JSON never has to know which market does what.
    const eq = rowFromPosition(
      {
        id: 's1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout', entryPrice: 100, quantity: 10,
        stopLoss: 95, takeProfit: 115, openedAt: OPEN, closedAt: CLOSE, exitPrice: 110, pnl: 100,
        exitReason: 'target', mode: 'live',
      },
      'stocks',
    );
    expect(eq.pnl_r_basis).toBe('stop-distance');
    expect(eq.pnl_r).toBe(2);
    expect(eq.pnl_r_stop_basis).toBe(2);
  });
});

// ── AC2 — the book computes the premium basis INLINE, no journal needed ──────

describe('TRA-3989 AC2 — a book row with no journal twin reconciles to gross ÷ (entry × 100 × qty)', () => {
  it('holds to 3dp on both filed rows and on a multi-contract row', () => {
    for (const opt of [rig(), bac(), rig({ id: 'lot-3', contracts: 3, pnl: -45 })]) {
      const row = rowFromOption(opt);
      const implied = (row.gross_pnl_usd as number) / ((row.entry_price as number) * 100 * row.quantity);
      expect(row.pnl_r).toBeCloseTo(implied, 3);
    }
  });

  it('divides by the contracts OPENED, not the contracts remaining (a TP1 scale-out does not shrink the basis)', () => {
    // Journal `atRiskUsd` was captured at open for all 2 contracts; a scale-out
    // to 1 remaining must not halve the denominator, or the two emitters drift.
    const scaled = rig({ id: 'lot-scaled', contracts: 2, contractsRemaining: 1, tp1Hit: true, pnl: -20 });
    const book = rowFromOption(scaled);
    const journal = rowFromJournalRecord(journalTwin(scaled));
    expect(book.pnl_r).toBe(journal.pnl_r);
    expect(book.pnl_r).toBeCloseTo(-20 / 66, 3);
  });

  it('is null — never a stop-distance fallback — when the premium is unreadable', () => {
    const row = rowFromOption(rig({ premiumPaid: NaN }));
    expect(row.pnl_r).toBeNull();
    expect(optionPremiumRiskUsd({ premiumPaid: NaN, contracts: 1 })).toBeNaN();
  });
});

// ── AC3 — the stop-distance R is RELABELLED, not deleted ─────────────────────

describe('TRA-3989 AC3 — `pnl_r_stop_basis` keeps the gate-basis reading under its own name', () => {
  it('the CSV header carries BOTH column names', () => {
    const header = toCsv([]).split('\r\n')[0].split(',');
    expect(header).toContain('pnl_r');
    expect(header).toContain('pnl_r_stop_basis');
    expect(EXPORT_COLUMNS).toContain('pnl_r_stop_basis');
  });

  it('the two columns DIFFER on the RIG row: −0.455 (premium) vs −2.273 (stop)', () => {
    const row = rowFromOption(rig());
    expect(row.pnl_r_stop_basis).toBeCloseTo(-2.273, 3);
    expect(row.pnl_r).toBeCloseTo(-0.455, 3);
    expect(row.pnl_r_stop_basis).not.toBe(row.pnl_r);
    // …and the CSV data line renders both, in that order, last.
    const line = toCsv([row]).split('\r\n')[1].split(',');
    expect(line[EXPORT_COLUMNS.indexOf('pnl_r')]).toBe('-0.455');
    expect(line[EXPORT_COLUMNS.indexOf('pnl_r_stop_basis')]).toBe('-2.273');
  });

  it('is null when `stopLossPremium` is absent', () => {
    const row = rowFromOption(rig({ stopLossPremium: undefined as unknown as number }));
    expect(row.pnl_r_stop_basis).toBeNull();
    // …and the premium-basis R is untouched by a missing stop.
    expect(row.pnl_r).toBeCloseTo(-0.455, 3);
  });

  it('is null on the `stopLossPremium: 0` "never stop" sentinel — a distance from no stop is not a unit', () => {
    // Before this ticket the sentinel made `pnl_r` silently EQUAL the premium
    // basis (|p − 0| × n × 100 = the premium), which read as a coincidence.
    expect(optionStopRiskUsd({ premiumPaid: 0.33, contracts: 1, stopLossPremium: 0 })).toBeNaN();
    expect(rowFromOption(rig({ stopLossPremium: 0 })).pnl_r_stop_basis).toBeNull();
  });

  it('is null on every journal-served row — the journal records no stop', () => {
    expect(rowFromJournalRecord(journalTwin(rig())).pnl_r_stop_basis).toBeNull();
  });

  it('on a RESTATED book row it is re-derived against the restated NET, not left as book arithmetic', () => {
    const row = rowFromOption(rig());
    const restatement: ExportMoneyRestatement = {
      gross_pnl_usd: -15, fees_usd: 0.35, net_pnl_usd: -15.35, pnl_r: -0.465,
      exit_price: 0.18, entry_price: 0.33, broker_order_id: 'ord-42',
    };
    const out = applyMoneyRestatement(row, restatement, optionStopRiskUsd(rig()));
    expect(out.pnl_r).toBe(-0.465);
    expect(out.pnl_r_stop_basis).toBeCloseTo(-15.35 / 6.6, 3);
    // An overlay that was handed no stop risk publishes NO stop-basis figure:
    // broker money over a book-mark stop is the mix this ticket exists to kill.
    expect(applyMoneyRestatement(row, restatement).pnl_r_stop_basis).toBeNull();
  });

  it('`buildRows` threads the stop risk into the overlay on its own', () => {
    const opt = rig();
    const rows = buildRows({
      optionsClosed: [opt],
      optionMoneyRestatements: new Map([[opt.id, {
        gross_pnl_usd: -15, fees_usd: 0.35, net_pnl_usd: -15.35, pnl_r: -0.465,
        exit_price: 0.18, entry_price: 0.33, broker_order_id: 'ord-42',
      }]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl_basis).toBe('broker-fill');
    expect(rows[0].pnl_r).toBe(-0.465);
    expect(rows[0].pnl_r_stop_basis).toBeCloseTo(-15.35 / 6.6, 3);
  });
});

// ── AC4 — the two emitters cannot drift apart again ──────────────────────────

describe('TRA-3989 AC4 — the book mapper and the journal mapper agree on `pnl_r` for one synthetic twin', () => {
  // This is the regression the ticket asks for. It is written so that reverting
  // `rowFromOption`'s denominator to the stop distance FAILS it: the fixture's
  // stop is 20% below the premium, so the two bases differ by exactly 5×, and
  // the assertion is equality, not closeness.
  it('equality on a twin whose stop basis would read 5× larger', () => {
    const opt = rig({ id: 'twin-1', premiumPaid: 0.5, stopLossPremium: 0.4, contracts: 2, pnl: -40 });
    const book = rowFromOption(opt);
    const journal = rowFromJournalRecord(journalTwin(opt));
    expect(book.pnl_r).toBe(journal.pnl_r);
    expect(book.pnl_r).toBe(-0.4); // −40 ÷ (0.5 × 2 × 100)
    // NEGATIVE CONTROL — the stop basis on this twin is −2.0, so a mapper that
    // reverted would publish −2.0 here and the equality above would fail loudly.
    expect(book.pnl_r_stop_basis).toBe(-2);
    expect(book.pnl_r).not.toBe(book.pnl_r_stop_basis);
  });

  it('equality holds on a WINNER too — the bias is directional, so both signs are pinned', () => {
    const opt = rig({ id: 'twin-w', premiumPaid: 0.5, stopLossPremium: 0.4, contracts: 2, pnl: 30, exitReason: 'trail' });
    const book = rowFromOption(opt);
    const journal = rowFromJournalRecord(journalTwin(opt, { outcome: 'WIN' }));
    expect(book.pnl_r).toBe(journal.pnl_r);
    expect(book.pnl_r).toBe(0.3);
  });

  it('the premium-basis helper IS the journal\'s `atRiskUsd` arithmetic', () => {
    // `totalCost = contracts × premiumPaid × 100` at the open site
    // (`options-account.ts`, `queueJournalOpen`) — same three factors.
    expect(optionPremiumRiskUsd({ premiumPaid: 0.33, contracts: 1 })).toBeCloseTo(33, 10);
    expect(optionPremiumRiskUsd({ premiumPaid: 1.17, contracts: 4 })).toBeCloseTo(468, 10);
  });
});

// ── AC5 — `pnl_basis` on every options row, in one read ─────────────────────

describe('TRA-3989 AC5 — `pnl_basis` and `source` are populated on a book row and a journal row in the same document', () => {
  it('both rows carry a non-null `pnl_basis`, `source`, and `pnl_r_basis`', () => {
    const bookOpt = rig();
    const archived = bac();
    const doc = toJsonDocument(
      buildRows({
        optionsClosed: [bookOpt],
        preMappedRows: [rowFromJournalRecord(journalTwin(archived, { pnlBasis: 'broker-fill', feesUsd: 0.12 } as Partial<OptionTradeJournalRecord>))],
      }),
      {},
    );
    expect(doc.trades).toHaveLength(2);
    const book = doc.trades.find(r => r.source === 'book')!;
    const journal = doc.trades.find(r => r.source === 'journal')!;
    expect(book.pnl_basis).toBe('book');
    expect(journal.pnl_basis).toBe('broker-fill');
    for (const r of doc.trades) {
      expect(r.pnl_basis).not.toBeNull();
      expect(r.pnl_basis).toBeDefined();
      expect(r.pnl_r_basis).toBe('premium');
    }
    expect(doc.summary.sources).toEqual({ book: 1, journal: 1 });
  });
});
