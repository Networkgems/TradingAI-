import { describe, it, expect } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import {
  rowFromOption,
  rowFromPosition,
  buildRows,
  toCsv,
  applyMoneyRestatement,
  EXPORT_COLUMNS,
  type ExportMoneyRestatement,
} from './export.js';
import { rowFromJournalRecord, collectJournalMoneyRestatements } from './export-history.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  summarizeDayOneStopPosture,
  mergeDayOneStopPosture,
  blindDayOneStopPosture,
  summarizeOtmSleeveStopCoverage,
  mergeOtmSleeveStopCoverage,
  blindOtmSleeveStopCoverage,
} from './options-account.js';
import {
  resolveOtmDayOneStopRule,
  resolveOtmDayOneStopRelease,
} from './otm-day-one-stop.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3985 — two defects filed off one 2026-08-24 paired read, and the third
// that turned out not to be one.
//
//   Defect 2 (REAL, an observability gap) — no surface attributed an OTM exit to
//   a LOT. Two live rows shared `RIG260925C00006000`, opened 357ms apart, with
//   different premium anchors (0.33 vs a `residual_identity`-restated 0.22). The
//   same 0.18 fill grades −45.45% against one and −18.18% against the other, and
//   TRA-3943 AC3's bar is `>= −40%`: the verdict INVERTS on the attribution.
//
//   Defect 1 (already fixed by TRA-3981, live in `07cc4ba4`) — the residual is
//   that neither day-one counter published its POPULATION or its BOOK COUNT, so
//   a fleet-wide reading and a single-book `/api/state` could not be reconciled
//   and the gap read as an inconsistent instrument.
//
//   Defect 3 (NOT a defect) — `premiumAtRiskUsd: 305` against `$173` on
//   `/api/state` was the same missing book count, one field over. Same shape,
//   measured again live 2026-08-25T18:18Z: posture `rows: 3` and coverage
//   `rows: 4` against **2** rows on `/api/state`, because the health route folds
//   `getAllUserContexts()` and `/api/state` serves the CALLER'S book.
// ─────────────────────────────────────────────────────────────────────────────

// ── The live two-lot fixture ────────────────────────────────────────────────
//
// Both real, both live, same OCC, 357ms apart. The SURVIVOR is the one whose
// basis a desk-add restated; the CLOSED one is the engine sibling that filled.
const OPEN_A = Date.parse('2026-08-21T18:04:24.494Z');
const OPEN_B = Date.parse('2026-08-21T18:04:24.851Z');

function rigLot(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'lot-a',
    symbol: 'RIG',
    optionSymbol: 'RIG260925C00006000',
    optionType: 'call',
    strike: 6,
    expiration: '2026-09-25',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 0.33,
    currentPremium: 0.18,
    tp1Premium: 0.5,
    tp1Hit: false,
    stopLossPremium: 0.2145,
    peakPremium: 0.33,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 6.2,
    openedAt: OPEN_A,
    closedAt: Date.parse('2026-08-24T15:15:55.327Z'),
    pnl: -15,
    exitReason: 'sl_otm_premium_pct',
    signalId: 'sig-rig',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...over,
  } as OptionPosition;
}

// ── Defect 2 — the export names the lot ─────────────────────────────────────

describe('TRA-3985 Defect 2 — an exported exit names the LOT it consumed', () => {
  it('SUBJECT — the two 357ms-apart lots are distinguishable in the export', () => {
    // Pre-ticket, these two rows differed only in money — same OCC, same
    // side/strategy/quantity, exit times a few ms apart. Nothing on the row said
    // which lot each was, which is why the AC3 grade could not be settled.
    const a = rowFromOption(rigLot({ id: 'lot-a', openedAt: OPEN_A, premiumPaid: 0.33 }));
    const b = rowFromOption(rigLot({ id: 'lot-b', openedAt: OPEN_B, premiumPaid: 0.22 }));

    expect(a.lot_id).toBe('lot-a');
    expect(b.lot_id).toBe('lot-b');
    expect(a.lot_id).not.toBe(b.lot_id);

    // NEGATIVE CONTROL — the symbol, the one key a reader had before this, still
    // cannot tell them apart. The fix is the id, not a re-labelling of the OCC.
    expect(a.symbol).toBe(b.symbol);
  });

  it('SUBJECT — `journal_id` is the JOURNAL key and is NOT always `lot_id`', () => {
    // TRA-3078/TRA-3930: a position the reconcile REBOUND onto a pre-existing
    // open row is addressed by `journalId`, not by `id`. Publishing one of the
    // two and calling it "the id" already cost a -130.00 reading of a -65.00
    // day, so both are published and they are allowed to differ.
    const rebound = rowFromOption(rigLot({ id: 'book-99', journalId: 'jrn-7' } as Partial<OptionPosition>));
    expect(rebound.lot_id).toBe('book-99');
    expect(rebound.journal_id).toBe('jrn-7');
    expect(rebound.lot_id).not.toBe(rebound.journal_id);

    // …and they COINCIDE on an ordinary row, which is the case that made the
    // conflation survive for as long as it did.
    const plain = rowFromOption(rigLot({ id: 'book-1' }));
    expect(plain.lot_id).toBe('book-1');
    expect(plain.journal_id).toBe('book-1');
  });

  it('a JOURNAL-sourced row publishes `journal_id` and REFUSES to invent a lot', () => {
    const r: OptionTradeJournalRecord = {
      id: 'jrn-7',
      openTs: OPEN_A,
      symbol: 'RIG',
      structure: 'tradier_import',
      mode: 'live',
      ivRank: null,
      trend: 'unknown',
      sentiment: null,
      entryDelta: 0,
      entryDte: 35,
      atRiskUsd: 33,
      account: 'admin',
      outcome: 'LOSS',
      closeTs: Date.parse('2026-08-24T15:15:55.327Z'),
      realizedPnlUsd: -15,
      exitReason: 'sl_otm_premium_pct',
      optionSymbol: 'RIG260925C00006000',
      contracts: 1,
      brokerOrderId: 987654,
    } as OptionTradeJournalRecord;

    const row = rowFromJournalRecord(r);
    expect(row.journal_id).toBe('jrn-7');
    // The journal does not store the book position id. A copy of `r.id` here
    // would read as a successful lot attribution to anyone joining on it.
    expect(row.lot_id).toBeNull();
    expect(row.broker_order_id).toBe(987654);
  });

  it('a broker order id of `0` survives — `??`, never `||`', () => {
    const row = rowFromJournalRecord({
      id: 'jrn-0', openTs: OPEN_A, symbol: 'RIG', structure: 'tradier_import', mode: 'live',
      ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35,
      atRiskUsd: 33, account: 'admin', outcome: 'LOSS', closeTs: OPEN_B,
      realizedPnlUsd: -15, optionSymbol: 'RIG260925C00006000', contracts: 1,
      brokerOrderId: 0,
    } as OptionTradeJournalRecord);
    expect(row.broker_order_id).toBe(0);
    expect(row.broker_order_id).not.toBeNull();
  });

  it('an UNMEASURED order id is null, never a fabricated one', () => {
    const row = rowFromJournalRecord({
      id: 'jrn-x', openTs: OPEN_A, symbol: 'RIG', structure: 'tradier_import', mode: 'live',
      ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35,
      atRiskUsd: 33, account: 'admin', outcome: 'LOSS', closeTs: OPEN_B,
      realizedPnlUsd: -15, optionSymbol: 'RIG260925C00006000', contracts: 1,
    } as OptionTradeJournalRecord);
    expect(row.broker_order_id).toBeNull();
  });

  it('the restatement overlay moves the ORDER ID and never rewrites the IDENTITY', () => {
    const row = rowFromOption(rigLot({ id: 'book-99', journalId: 'jrn-7' } as Partial<OptionPosition>));
    const restatement: ExportMoneyRestatement = {
      gross_pnl_usd: -15, fees_usd: 0.35, net_pnl_usd: -15.35, pnl_r: -0.9,
      exit_price: 0.18, entry_price: 0.33, broker_order_id: 'ord-42',
    };
    const out = applyMoneyRestatement(row, restatement);
    // The join key survives the overlay — a restatement joined ON `journal_id`
    // that could rewrite `journal_id` would make the join unverifiable.
    expect(out.lot_id).toBe('book-99');
    expect(out.journal_id).toBe('jrn-7');
    expect(out.broker_order_id).toBe('ord-42');
    expect(out.pnl_basis).toBe('broker-fill');
  });

  it('a restatement that measured NO order id does not delete one already on the row', () => {
    const row = { ...rowFromOption(rigLot({})), broker_order_id: 'kept-1' };
    const out = applyMoneyRestatement(row, {
      gross_pnl_usd: -15, fees_usd: 0, net_pnl_usd: -15, pnl_r: null,
      exit_price: null, entry_price: null, broker_order_id: null,
    });
    expect(out.broker_order_id).toBe('kept-1');
  });

  it('the book↔journal restatement JOIN is now verifiable from the output alone', () => {
    // The whole point: a reader holding the export can now check that the money
    // on a row came from the journal record it claims, instead of trusting it.
    const pos = rigLot({ id: 'book-99', journalId: 'jrn-7' } as Partial<OptionPosition>);
    const record: OptionTradeJournalRecord = {
      id: 'jrn-7', openTs: OPEN_A, symbol: 'RIG', structure: 'single_leg_otm', mode: 'live',
      ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35,
      atRiskUsd: 33, account: 'admin', outcome: 'LOSS',
      closeTs: Date.parse('2026-08-24T15:15:55.327Z'),
      realizedPnlUsd: -15.35, feesUsd: 0.35, realizedR: -0.9, pnlBasis: 'broker-fill',
      entryFillPremium: 0.33, exitFillPremium: 0.18, brokerOrderId: 'ord-42',
      optionSymbol: 'RIG260925C00006000', contracts: 1,
    } as OptionTradeJournalRecord;

    const restatements = collectJournalMoneyRestatements([record], new Set(['jrn-7']));
    const [row] = buildRows({ optionsClosed: [pos], optionMoneyRestatements: restatements });

    expect(row!.lot_id).toBe('book-99');
    expect(row!.journal_id).toBe('jrn-7');
    expect(row!.pnl_basis).toBe('broker-fill');
    expect(row!.net_pnl_usd).toBeCloseTo(-15.35, 2);
    expect(row!.broker_order_id).toBe('ord-42');
  });

  it('equity rows carry a lot id and say the option journal does not apply', () => {
    const row = rowFromPosition({
      id: 'stk-1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout',
      entryPrice: 100, quantity: 10, stopLoss: 95, takeProfit: 115,
      openedAt: OPEN_A, closedAt: OPEN_B, exitPrice: 110, pnl: 100,
      exitReason: 'target', mode: 'live',
    } as never, 'stocks');
    expect(row.lot_id).toBe('stk-1');
    // Not "unmeasured" — there is no option-trade journal for equities to key on.
    expect(row.journal_id).toBeNull();
    expect(row.broker_order_id).toBeNull();
  });

  it('REGRESSION — the design §2.3 CSV header is byte-identical', () => {
    // JSON-only, exactly like `source`/`pnl_basis` (TRA-3875). An id column in
    // the CSV would break every consumer parsing the published header.
    const csv = toCsv([rowFromOption(rigLot({}))]);
    // RFC-4180 CRLF — split on the real terminator, not on `\n`, or the header
    // carries a trailing `\r` and this reads as a schema change that is not one.
    expect(csv.split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','));
    for (const key of ['lot_id', 'journal_id', 'broker_order_id']) {
      expect(EXPORT_COLUMNS as readonly string[]).not.toContain(key);
    }
  });
});

// ── Defect 1 residual + Defect 3 — the population and the book count ────────

const RULE = resolveOtmDayOneStopRule({});
const ARMED = {
  rule: RULE,
  release: resolveOtmDayOneStopRelease({ accountType: 'cash', dayTradeBuyingPower: null }),
};
const TODAY = Date.parse('2026-08-24T18:00:00.000Z');

function heldRow(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'p1', symbol: 'AAPL', optionSymbol: 'AAPL260905C00200000', optionType: 'call',
    strike: 200, expiration: '2026-09-05', contracts: 1, contractsRemaining: 1,
    premiumPaid: 2.5, currentPremium: 2.5, tp1Premium: 3.75, tp1Hit: false,
    stopLossPremium: 2, peakPremium: 2.5, trailingActive: false, trailingStopPremium: 3.25,
    underlyingEntryPrice: 200, openedAt: TODAY, signalId: 's1',
    signalType: 'otm_mispricing', mode: 'live',
    ...over,
  } as OptionPosition;
}

describe('TRA-3985 Defect 1/3 — the instrument states its population and its book count', () => {
  it('the day-one posture publishes WHAT it counted, as a literal', () => {
    const p = summarizeDayOneStopPosture([heldRow({})], {
      holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED,
    });
    // Its neighbour has carried this since TRA-3981; this one only had a comment,
    // and a comment in a source file is not on the wire beside the number.
    expect(p.population).toBe('live_held_rows_opened_today');
    expect(summarizeOtmSleeveStopCoverage([heldRow({})], { otmDayOneStop: ARMED }).population)
      .toBe('all_open_live_otm_sleeve_rows');
    expect(p.population).not.toBe(
      summarizeOtmSleeveStopCoverage([heldRow({})], { otmDayOneStop: ARMED }).population,
    );
  });

  it('SUBJECT — a FLEET reading says how many books it folded', () => {
    // This single number is both live filings on this ticket. A reader who can
    // see `books: 2` knows a reconciliation against one book's `/api/state`
    // cannot close, instead of concluding the counters disagree with each other.
    const bookA = summarizeDayOneStopPosture([heldRow({ id: 'a1' })], {
      holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED,
    });
    const bookB = summarizeDayOneStopPosture([heldRow({ id: 'b1' })], {
      holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED,
    });
    expect(bookA.books).toBe(1);

    const fleet = mergeDayOneStopPosture([bookA, bookB]);
    expect(fleet.books).toBe(2);
    expect(fleet.rows).toBe(2);
    // …and the single-book view a caller of `/api/state` would hold reads 1 row.
    expect(bookA.rows).toBe(1);
  });

  it('a merge of merges counts BOOKS, not merge calls', () => {
    const book = (id: string) => summarizeDayOneStopPosture([heldRow({ id })], {
      holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED,
    });
    const left = mergeDayOneStopPosture([book('a'), book('b')]);
    const right = mergeDayOneStopPosture([book('c')]);
    expect(mergeDayOneStopPosture([left, right]).books).toBe(3);

    const cov = (id: string) => summarizeOtmSleeveStopCoverage([heldRow({ id })], { otmDayOneStop: ARMED });
    expect(mergeOtmSleeveStopCoverage([
      mergeOtmSleeveStopCoverage([cov('a'), cov('b')]),
      mergeOtmSleeveStopCoverage([cov('c')]),
    ]).books).toBe(3);
  });

  it('an EMPTY fleet folds to zero books — not to one', () => {
    expect(mergeDayOneStopPosture([]).books).toBe(0);
    expect(mergeOtmSleeveStopCoverage([]).books).toBe(0);
  });

  it("SUBJECT — `atrLegPopulationRows` is the ATR counters' own denominator, and it is NOT `rows`", () => {
    // The question QuantTrader had to ask before it could qualify a population:
    // is `atrLegRows` the eligible set or the live-leg count? It is the latter.
    // An RV row is HELD (so it is in `rows`) and is outside the rule's reach (so
    // it is in neither ATR counter) — the two denominators genuinely differ.
    const p = summarizeDayOneStopPosture(
      [
        heldRow({ id: 'otm-stamped', otmAtrInvalidationLevel: 195 }),
        heldRow({ id: 'otm-blind' }),
        heldRow({ id: 'rv-1', signalType: 'relative_value' }),
      ],
      { holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED },
    );
    expect(p.rows).toBe(3);
    expect(p.otmDayOneStop!.atrLegRows).toBe(1);
    expect(p.otmDayOneStop!.atrLegInertRows).toBe(1);
    expect(p.otmDayOneStop!.atrLegPopulationRows).toBe(2);
    // The identity the field exists to stop a reader reconstructing wrongly.
    expect(p.otmDayOneStop!.atrLegPopulationRows)
      .toBe(p.otmDayOneStop!.atrLegRows + p.otmDayOneStop!.atrLegInertRows);
    // NEGATIVE CONTROL — the wrong denominator, which is the one a reader
    // without this field reaches for. 1/3 is not the coverage fraction; 1/2 is.
    expect(p.otmDayOneStop!.atrLegPopulationRows).not.toBe(p.rows);
  });

  it('the denominator survives the fleet fold', () => {
    const book = (id: string, level?: number) => summarizeDayOneStopPosture(
      [heldRow({ id, otmAtrInvalidationLevel: level })],
      { holdLiveOptionsOvernightForPdt: true, now: TODAY, otmDayOneStop: ARMED },
    );
    const fleet = mergeDayOneStopPosture([book('a', 195), book('b')]);
    expect(fleet.otmDayOneStop!.atrLegRows).toBe(1);
    expect(fleet.otmDayOneStop!.atrLegInertRows).toBe(1);
    expect(fleet.otmDayOneStop!.atrLegPopulationRows).toBe(2);
  });

  it('the BLIND twins null the measurement and keep the population literal', () => {
    const blind = blindDayOneStopPosture();
    // `books` is a measurement; a catch branch must not manufacture one. `1`
    // here would read as "one book, and it holds nothing".
    expect(blind.books).toBeNull();
    expect(blind.rows).toBeNull();
    // The population is what this instrument WOULD have counted — true whether
    // or not the count succeeded.
    expect(blind.population).toBe('live_held_rows_opened_today');

    const blindCov = blindOtmSleeveStopCoverage();
    expect(blindCov.books).toBeNull();
    expect(blindCov.population).toBe('all_open_live_otm_sleeve_rows');
  });
});
