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
  premiumRBasisLabel,
  EXPORT_COLUMNS,
  type ExportMoneyRestatement,
} from './export.js';
import { rowFromJournalRecord, collectJournalPremiumBases } from './export-history.js';
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
    // TRA-4027 — the premium label now also names the INSTANT: a twin-less book
    // row divides by its own `premiumPaid` (the fill once reconciled), a journal
    // row by the open mark. Both are premium units; neither is bare `'premium'`.
    expect(rowFromOption(rig()).pnl_r_basis).toBe('premium-fill');
    expect(rowFromJournalRecord(journalTwin(rig())).pnl_r_basis).toBe('premium-open-mark');
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

  // TRA-4027 AC4 — the twins above carry EQUAL values on both sides
  // (`journalTwin` derives `atRiskUsd` from the book's `premiumPaid`), which is
  // exactly why this block passed while the fill/mark gap was live. The twin
  // below is the live NVTS row from the TRA-4027 filing: the book's
  // `premiumPaid` is the restated broker FILL (1.51) and the journal's
  // `atRiskUsd` is the OPEN MARK (1.395 × 100 = 139.5). Same close, 8.2% apart.
  it('equality on a twin whose book side holds the FILL and journal side the OPEN MARK (TRA-4027)', () => {
    const opt = rig({
      id: 'twin-nvts', symbol: 'NVTS', optionSymbol: 'NVTS261002C00012500',
      premiumPaid: 1.51, stopLossPremium: 1.208, contracts: 1, pnl: -74, exitReason: 'profit_lock',
    });
    const twin = journalTwin(opt, { atRiskUsd: 139.5, realizedR: -74 / 139.5, entryMarkUsd: 1.395 });
    const book = rowFromOption(opt, twin.atRiskUsd);
    const journal = rowFromJournalRecord(twin);
    expect(book.pnl_r).toBe(journal.pnl_r);
    expect(book.pnl_r).toBeCloseTo(-0.53, 3); // −74 ÷ 139.5 (mark), the reference
    // NEGATIVE CONTROL — the same book row WITHOUT the twin divides by the
    // fill and reads −0.490. A mapper that ignored the twin would publish
    // that here and the equality above would fail loudly.
    const untwinned = rowFromOption(opt);
    expect(untwinned.pnl_r).toBeCloseTo(-0.49, 3);
    expect(untwinned.pnl_r).not.toBe(journal.pnl_r);
    expect(book.pnl_r_basis).toBe('premium-open-mark');
    expect(untwinned.pnl_r_basis).toBe('premium-fill');
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
      // TRA-4027 — a premium unit, with its instant named; never the bare label.
      expect(r.pnl_r_basis).toMatch(/^premium-(open-mark|fill)$/);
    }
    expect(doc.summary.sources).toEqual({ book: 1, journal: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4027 — one UNIT, two INSTANTS. After TRA-3989 both emitters divided by
// "the premium", but the book read it off `premiumPaid` — which the mirror
// reconcile overwrites with the broker FILL (`restateEngineOpenedBasis`) — and
// the journal off `atRiskUsd`, the OPEN MARK frozen at open (TRA-991). Measured
// on `NVTS261002C00012500` (admin live, closed 2026-08-25T13:45:23Z
// `profit_lock`, net +$1): book-served at 20:2xZ over $151, journal-served at
// 05:1xZ over $139.5. The printed R agreed only because the pnl was $1.
// ─────────────────────────────────────────────────────────────────────────────

/** The filed NVTS row, with a −$74 pnl so 3dp can tell the two bases apart. */
function nvts(over: Partial<OptionPosition> = {}): OptionPosition {
  return rig({
    id: 'lot-nvts', symbol: 'NVTS', optionSymbol: 'NVTS261002C00012500', strike: 12.5,
    expiration: '2026-10-02', premiumPaid: 1.51, currentPremium: 0.77, stopLossPremium: 1.208,
    contracts: 1, pnl: -74, exitReason: 'profit_lock', signalId: 'sig-nvts',
    openedAt: Date.parse('2026-08-24T14:44:33Z'), closedAt: Date.parse('2026-08-25T13:45:23Z'),
    ...over,
  });
}
const NVTS_MARK_BASIS = 139.5; // 1.395 × 1 × 100 — the journal's `atRiskUsd`

describe('TRA-4027 AC1 — a book row with a journal twin divides by the twin\'s open-mark `atRiskUsd`', () => {
  it('`buildRows` joins the basis on `journal_id` and the pre-archive book row equals the post-archive journal row', () => {
    const opt = nvts();
    const twin = journalTwin(opt, { atRiskUsd: NVTS_MARK_BASIS, realizedR: -74 / NVTS_MARK_BASIS, entryMarkUsd: 1.395 });
    const bases = collectJournalPremiumBases([twin], new Set([opt.id]));
    expect(bases.get(opt.id)?.atRiskUsd).toBe(NVTS_MARK_BASIS);
    // BEFORE the archive: book-served, twin still in the journal.
    const before = buildRows({ optionsClosed: [opt], optionPremiumBases: bases })[0];
    // AFTER the archive: the book copy is gone; the journal serves the row.
    const after = rowFromJournalRecord(twin);
    expect(before.source).toBe('book');
    expect(after.source).toBe('journal');
    expect(before.pnl_r).toBe(after.pnl_r);
    expect(before.pnl_r).toBeCloseTo(-0.53, 3);
    expect(before.pnl_r_basis).toBe('premium-open-mark');
    expect(after.pnl_r_basis).toBe('premium-open-mark');
    expect(before.premium_basis_usd).toBe(NVTS_MARK_BASIS);
    expect(after.premium_basis_usd).toBe(NVTS_MARK_BASIS);
  });

  it('joins on the id the JOURNAL knows the position by, not the bare lot id (a rebound row has `journalId != id`)', () => {
    const opt = nvts({ id: 'lot-rebound', journalId: 'journal-rebound' } as Partial<OptionPosition>);
    const twin = journalTwin(opt, { id: 'journal-rebound', atRiskUsd: NVTS_MARK_BASIS, realizedR: -74 / NVTS_MARK_BASIS });
    const bases = collectJournalPremiumBases([twin], new Set(['journal-rebound']));
    const row = buildRows({ optionsClosed: [opt], optionPremiumBases: bases })[0];
    expect(row.lot_id).toBe('lot-rebound');
    expect(row.journal_id).toBe('journal-rebound');
    expect(row.pnl_r).toBeCloseTo(-0.53, 3);
    expect(row.pnl_r_basis).toBe('premium-open-mark');
  });

  it('a twin still `OPEN` in the journal (close write queued) already carries the open-mark basis and is joined', () => {
    const opt = nvts();
    const openTwin = journalTwin(opt, { atRiskUsd: NVTS_MARK_BASIS, outcome: 'OPEN', closeTs: undefined, realizedPnlUsd: undefined, realizedR: undefined } as Partial<OptionTradeJournalRecord>);
    expect(collectJournalPremiumBases([openTwin], new Set([opt.id])).get(opt.id)?.atRiskUsd).toBe(NVTS_MARK_BASIS);
  });

  it('the collector is scoped to the book\'s ids and skips a record with no finite positive basis', () => {
    const opt = nvts();
    const foreign = journalTwin(opt, { id: 'someone-else', atRiskUsd: 500 });
    const noBasis = journalTwin(opt, { atRiskUsd: NaN });
    const zero = journalTwin(nvts({ id: 'lot-zero' }), { atRiskUsd: 0 });
    const bases = collectJournalPremiumBases([foreign, noBasis, zero], new Set([opt.id, 'lot-zero']));
    expect(bases.size).toBe(0);
    // ...and the untwinned row falls back to the inline arithmetic, labelled.
    const row = buildRows({ optionsClosed: [opt], optionPremiumBases: bases })[0];
    expect(row.pnl_r_basis).toBe('premium-fill');
    expect(row.pnl_r).toBeCloseTo(-0.49, 3);
  });

  it('on a RESTATED twin the overlay\'s R and basis are the journal\'s, and they still reconcile', () => {
    const opt = nvts();
    const restated = journalTwin(opt, {
      atRiskUsd: NVTS_MARK_BASIS, realizedPnlUsd: -74.35, realizedR: -74.35 / NVTS_MARK_BASIS,
      pnlBasis: 'broker-fill', feesUsd: 0.35, entryFillPremium: 1.51, exitFillPremium: 0.77,
    } as Partial<OptionTradeJournalRecord>);
    const restatement: ExportMoneyRestatement = {
      gross_pnl_usd: -74, fees_usd: 0.35, net_pnl_usd: -74.35, pnl_r: -0.533,
      exit_price: 0.77, entry_price: 1.51, broker_order_id: 'ord-143032832', premium_basis_usd: restated.atRiskUsd,
    };
    const row = buildRows({
      optionsClosed: [opt],
      optionPremiumBases: new Map([[opt.id, NVTS_MARK_BASIS]]),
      optionMoneyRestatements: new Map([[opt.id, restatement]]),
    })[0];
    expect(row.pnl_basis).toBe('broker-fill');
    expect(row.pnl_r).toBe(-0.533);
    expect(row.pnl_r_basis).toBe('premium-open-mark');
    expect(row.premium_basis_usd).toBe(NVTS_MARK_BASIS);
    expect(row.pnl_r).toBeCloseTo((row.net_pnl_usd as number) / (row.premium_basis_usd as number), 3);
    // A restatement that states no basis deletes nothing (same rule as the fills).
    const kept = applyMoneyRestatement(rowFromOption(opt, NVTS_MARK_BASIS), { ...restatement, premium_basis_usd: null });
    expect(kept.premium_basis_usd).toBe(NVTS_MARK_BASIS);
    expect(kept.pnl_r_basis).toBe('premium-open-mark');
  });
});

describe('TRA-4027 AC2 — a book row with NO twin keeps the inline basis and SAYS so', () => {
  it('labels itself `premium-fill` and publishes the inline divisor', () => {
    const row = rowFromOption(nvts());
    expect(row.pnl_r_basis).toBe('premium-fill');
    expect(row.premium_basis_usd).toBe(151);
    expect(row.pnl_r).toBeCloseTo(-74 / 151, 3);
  });

  it('a reader can partition the two premium instants; the bare `premium` label is gone', () => {
    const opt = nvts();
    const twinned = rowFromOption(opt, NVTS_MARK_BASIS);
    const inline = rowFromOption(opt);
    expect(new Set([twinned.pnl_r_basis, inline.pnl_r_basis])).toEqual(new Set(['premium-open-mark', 'premium-fill']));
    expect(twinned.pnl_r_basis).not.toBe('premium');
    expect(inline.pnl_r_basis).not.toBe('premium');
  });

  it('the equity mapper publishes no premium basis (null, never 0)', () => {
    const eq = rowFromPosition(
      {
        id: 's1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout', entryPrice: 100, quantity: 10,
        stopLoss: 95, takeProfit: 115, openedAt: OPEN, closedAt: CLOSE, exitPrice: 110, pnl: 100,
        exitReason: 'target', mode: 'live',
      },
      'stocks',
    );
    expect(eq.premium_basis_usd).toBeNull();
    expect(eq.pnl_r_basis).toBe('stop-distance');
  });
});

describe('TRA-4027 AC3 — `entry_price` stays the FILL; `premium_basis_usd` carries the reconcile instead', () => {
  it('a twinned book row keeps entry_price 1.51 while dividing by 139.5', () => {
    const row = rowFromOption(nvts(), NVTS_MARK_BASIS);
    expect(row.entry_price).toBe(1.51);
    expect(row.premium_basis_usd).toBe(NVTS_MARK_BASIS);
    // The TRA-3989 AC2 identity is broken on this row BY DESIGN...
    const oldIdentity = (row.net_pnl_usd as number) / ((row.entry_price as number) * 100 * row.quantity);
    expect(row.pnl_r).not.toBeCloseTo(oldIdentity, 3);
    // ...and the replacement identity holds.
    expect(row.pnl_r).toBeCloseTo((row.net_pnl_usd as number) / (row.premium_basis_usd as number), 3);
  });

  it('`pnl_r == net_pnl_usd / premium_basis_usd` holds to 3dp on every options row regardless of source', () => {
    const twinned = nvts();
    const twin = journalTwin(twinned, { atRiskUsd: NVTS_MARK_BASIS, realizedR: -74 / NVTS_MARK_BASIS });
    const untwinned = rig({ id: 'lot-alone', pnl: -15 });
    const archived = journalTwin(bac({ id: 'lot-archived', pnl: -3 }));
    const doc = toJsonDocument(
      buildRows({
        optionsClosed: [twinned, untwinned],
        optionPremiumBases: collectJournalPremiumBases([twin], new Set([twinned.id])),
        preMappedRows: [rowFromJournalRecord(archived)],
      }),
      {},
    );
    expect(doc.trades).toHaveLength(3);
    const seen = new Set<string>();
    for (const r of doc.trades) {
      expect(r.premium_basis_usd).not.toBeNull();
      expect(r.pnl_r).toBeCloseTo((r.net_pnl_usd as number) / (r.premium_basis_usd as number), 3);
      seen.add(`${r.source}:${r.pnl_r_basis}`);
    }
    expect(seen).toEqual(new Set(['book:premium-open-mark', 'book:premium-fill', 'journal:premium-open-mark']));
  });

  it('`premium_basis_usd` is JSON-only — the CSV header is untouched', () => {
    expect(EXPORT_COLUMNS).not.toContain('premium_basis_usd');
    expect(EXPORT_COLUMNS).not.toContain('pnl_r_basis');
    expect(toCsv([]).split('\r\n')[0].split(',')).not.toContain('premium_basis_usd');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4035 — the label keyed on the PRESENCE of the twin's `atRiskUsd`, not on
// what the journal SAYS that figure is. TRA-4028 made the basis self-describing
// (`atRiskBasis: 'fill' | 'mark'`) and restated BAC `6bbc5d17` onto its $117
// ledger fill; read 2026-08-26T08:56Z off bqb1 `6b0cbb29`: journal `atRiskUsd
// 117`, `atRiskBasis 'fill'`, `realizedR -0.0256` — export `pnl_r -0.026`
// (correct), `premium_basis_usd 117` (correct), `pnl_r_basis
// 'premium-open-mark'` (WRONG: $117 is the 1.17 FILL, not any mark).
// ─────────────────────────────────────────────────────────────────────────────

/** The restated BAC desk lot as the journal holds it after the TRA-4028 AC3 apply. */
function bacFillTwin(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return journalTwin(bac({ id: '6bbc5d17', premiumPaid: 1.17, contracts: 1, pnl: -3 }), {
    id: '6bbc5d17',
    structure: 'tradier_import',
    atRiskUsd: 117,
    atRiskBasis: 'fill',
    atRiskProvenance: 'ledger_fill:history_import',
    realizedR: -3 / 117,
    entryMarkUsd: undefined,
    ...over,
  } as Partial<OptionTradeJournalRecord>);
}

describe('TRA-4035 AC1/AC2 — `pnl_r_basis` on a journal row names the instant the journal STATES, not the presence of a figure', () => {
  it("a twin with `atRiskBasis: 'fill'` (BAC 6bbc5d17 after TRA-4028) labels `'premium-fill'`; figure and R untouched", () => {
    const row = rowFromJournalRecord(bacFillTwin());
    expect(row.pnl_r_basis).toBe('premium-fill');
    // Non-goals held: neither the divisor nor the R moves with the label.
    expect(row.premium_basis_usd).toBe(117);
    expect(row.pnl_r).toBeCloseTo(-0.026, 3);
    expect(row.pnl_r).toBeCloseTo((row.net_pnl_usd as number) / (row.premium_basis_usd as number), 3);
  });

  it("a twin with `atRiskBasis: 'mark'` (an import the ledger could not attribute) labels `'premium-open-mark'`", () => {
    const row = rowFromJournalRecord(bacFillTwin({ atRiskUsd: 141, atRiskBasis: 'mark', atRiskProvenance: 'mark:remainder_excess', realizedR: -3 / 141 }));
    expect(row.pnl_r_basis).toBe('premium-open-mark');
    expect(row.premium_basis_usd).toBe(141);
  });

  it('a twin WITHOUT the field (pre-TRA-4028 row, engine `single_leg_otm` row) keeps `\'premium-open-mark\'` — absent is unknown, never fill', () => {
    const engine = journalTwin(rig());
    expect(engine.atRiskBasis).toBeUndefined();
    expect(rowFromJournalRecord(engine).pnl_r_basis).toBe('premium-open-mark');
    // …and an explicit garbage value is treated as absent, not as fill.
    expect(rowFromJournalRecord(bacFillTwin({ atRiskBasis: 'ledger' as unknown as 'fill' })).pnl_r_basis).toBe('premium-open-mark');
  });

  it('the helper is the single source of the label', () => {
    expect(premiumRBasisLabel('fill')).toBe('premium-fill');
    expect(premiumRBasisLabel('mark')).toBe('premium-open-mark');
    expect(premiumRBasisLabel(null)).toBe('premium-open-mark');
    expect(premiumRBasisLabel(undefined)).toBe('premium-open-mark');
  });
});

describe('TRA-4035 — the same fill-basis twin, read through the BOOK-served path (pre-archive), agrees with its journal-served row', () => {
  it('`collectJournalPremiumBases` carries `atRiskBasis` and `rowFromOption` labels off it', () => {
    const opt = bac({ id: '6bbc5d17', premiumPaid: 1.17, contracts: 1, pnl: -3 });
    const twin = bacFillTwin();
    const bases = collectJournalPremiumBases([twin], new Set([opt.id]));
    expect(bases.get(opt.id)).toEqual({ atRiskUsd: 117, atRiskBasis: 'fill' });
    const book = buildRows({ optionsClosed: [opt], optionPremiumBases: bases })[0];
    const journal = rowFromJournalRecord(twin);
    expect(book.pnl_r_basis).toBe('premium-fill');
    expect(journal.pnl_r_basis).toBe('premium-fill');
    expect(book.pnl_r).toBe(journal.pnl_r);
    expect(book.premium_basis_usd).toBe(117);
    // NEGATIVE CONTROL — the same twin without the field still reads open-mark
    // on the book side, so the label above is read off the field and not off
    // the twin's presence (the pre-ticket rule).
    const untagged = collectJournalPremiumBases([{ ...twin, atRiskBasis: undefined }], new Set([opt.id]));
    expect(untagged.get(opt.id)).toEqual({ atRiskUsd: 117, atRiskBasis: null });
    expect(buildRows({ optionsClosed: [opt], optionPremiumBases: untagged })[0].pnl_r_basis).toBe('premium-open-mark');
    // …and a bare number (a caller that predates the label) reads the same.
    expect(rowFromOption(opt, 117).pnl_r_basis).toBe('premium-open-mark');
  });

  it('a broker-fill RESTATEMENT of a fill-basis twin overlays `\'premium-fill\'`; one that names no label keeps the old default', () => {
    const opt = bac({ id: '6bbc5d17', premiumPaid: 1.17, contracts: 1, pnl: -3 });
    const restatement: ExportMoneyRestatement = {
      gross_pnl_usd: -2.9, fees_usd: 0.1, net_pnl_usd: -3, pnl_r: -0.026,
      exit_price: 1.14, entry_price: 1.17, broker_order_id: 'ord-bac', premium_basis_usd: 117, pnl_r_basis: 'premium-fill',
    };
    const row = buildRows({
      optionsClosed: [opt],
      optionPremiumBases: new Map([[opt.id, { atRiskUsd: 117, atRiskBasis: 'fill' as const }]]),
      optionMoneyRestatements: new Map([[opt.id, restatement]]),
    })[0];
    expect(row.pnl_basis).toBe('broker-fill');
    expect(row.pnl_r_basis).toBe('premium-fill');
    expect(row.premium_basis_usd).toBe(117);
    const legacy = applyMoneyRestatement(rowFromOption(opt, 117), { ...restatement, pnl_r_basis: undefined });
    expect(legacy.pnl_r_basis).toBe('premium-open-mark');
  });
});
