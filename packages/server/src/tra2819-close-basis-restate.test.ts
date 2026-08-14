import { describe, expect, it } from 'vitest';

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { planCloseBasisRestate, EXIT_MATCH_GRACE_MS } from './tra2819-close-basis-restate.js';

// TRA-2819 — the fixtures below are the REAL 2026-07-30 live cohort, transcribed
// from `/api/health/option-journal?rows=all` and
// `/api/health/live-options-fee-slippage` on bqb1 build `06edb36c2eba`, read
// 2026-08-14T05:27Z. They are not invented numbers: the assertion that the
// planner lands on 695.09 / 15.11 / 3.53 is an assertion against Tradier's own
// `/gainloss` figures for the same three lots, which is what makes this suite a
// grader for the ticket and not merely a test of its own arithmetic.

const OPEN_TS_AAPL = 1785418939751;
const CLOSE_TS_AAPL = 1785505404222;

function fill(over: Partial<LiveOptionFillRecord> & Pick<LiveOptionFillRecord, 'optionSymbol' | 'side' | 'ts' | 'contracts'>): LiveOptionFillRecord {
  return {
    mode: 'live',
    etDay: '2026-07-30',
    sleeve: 'single_leg_otm',
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: null,
    fees: null,
    feeSource: 'gainloss_derived',
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'fill',
    ...over,
  } as LiveOptionFillRecord;
}

function row(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'aapl-row',
    openTs: OPEN_TS_AAPL,
    symbol: 'AAPL',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'sideways',
    entryDelta: 0.0667,
    entryDte: 36,
    atRiskUsd: 398.00000000000006,
    entrySlippageUsd: 20,
    optionSymbol: 'AAPL260904P00280000',
    contracts: 4,
    entryBid: 0.93,
    entryAsk: 1.06,
    entryMarkUsd: 0.9950000000000001,
    account: 'admin',
    outcome: 'WIN',
    closeTs: CLOSE_TS_AAPL,
    // The live figure this ticket is about: exit ingested correctly (2.78), but
    // priced against the scanner's 0.995 MID and gross of commission.
    realizedPnlUsd: 713.9999999999999,
    realizedR: 1.7939698492462306,
    exitReason: 'trail',
    holdDays: 1.0007461921296297,
    ...over,
  } as OptionTradeJournalRecord;
}

/** The AAPL round trip exactly as the durable ledger holds it. */
function aaplFills(): LiveOptionFillRecord[] {
  return [
    fill({ optionSymbol: 'AAPL260904P00280000', side: 'buy_to_open', ts: 1785418940914, contracts: 4, filledPrice: 1.04, fees: 0.42 }),
    fill({ optionSymbol: 'AAPL260904P00280000', side: 'sell_to_close', ts: 1785504713834, contracts: 1, filledPrice: 2.78, fees: 0.12 }),
    fill({ optionSymbol: 'AAPL260904P00280000', side: 'sell_to_close', ts: 1785505404223, contracts: 3, filledPrice: 2.78, fees: 0.37 }),
  ];
}

describe('TRA-2819 close-basis restatement — the live 2026-07-30 cohort', () => {
  it('lands on Tradier /gainloss to the cent on all three rows', () => {
    const rows: OptionTradeJournalRecord[] = [
      row(),
      row({
        id: 'spy816-row',
        symbol: 'SPY',
        optionSymbol: 'SPY260904C00816000',
        contracts: 4,
        atRiskUsd: 30.000000000000004,
        entryMarkUsd: 0.07500000000000001,
        openTs: 1785418942065,
        closeTs: 1785505194050,
        realizedPnlUsd: 17.999999999999993,
      }),
      row({
        id: 'spy820-row',
        symbol: 'SPY',
        optionSymbol: 'SPY260904C00820000',
        contracts: 2,
        atRiskUsd: 13,
        entryMarkUsd: 0.065,
        openTs: 1785419476058,
        closeTs: 1785524851983,
        realizedPnlUsd: 7.000000000000001,
      }),
    ];
    const ledger: LiveOptionFillRecord[] = [
      ...aaplFills(),
      fill({ optionSymbol: 'SPY260904C00816000', side: 'buy_to_open', ts: 1785418943134, contracts: 4, filledPrice: 0.08, fees: 0.42 }),
      fill({ optionSymbol: 'SPY260904C00816000', side: 'sell_to_close', ts: 1785504629807, contracts: 1, filledPrice: 0.12, fees: 0.12 }),
      fill({ optionSymbol: 'SPY260904C00816000', side: 'sell_to_close', ts: 1785505194051, contracts: 3, filledPrice: 0.12, fees: 0.35 }),
      fill({ optionSymbol: 'SPY260904C00820000', side: 'buy_to_open', ts: 1785419476574, contracts: 2, filledPrice: 0.08, fees: 0.22 }),
      fill({ optionSymbol: 'SPY260904C00820000', side: 'sell_to_close', ts: 1785524851984, contracts: 2, filledPrice: 0.1, fees: 0.25 }),
    ];

    const plan = planCloseBasisRestate(rows, ledger);
    expect(plan.counts).toEqual({ restate: 3, skip: 0 });

    const byId = new Map(plan.rows.map((r) => [r.id, r]));
    // Tradier `/gainloss` `gain_loss`, per lot, from the ticket's own table.
    expect(byId.get('aapl-row')?.realizedPnlUsdAfter).toBe(695.09);
    expect(byId.get('spy816-row')?.realizedPnlUsdAfter).toBe(15.11);
    expect(byId.get('spy820-row')?.realizedPnlUsdAfter).toBe(3.53);

    const total = plan.rows.reduce((s, r) => s + (r.realizedPnlUsdAfter ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBe(713.73);
    // The pre-registered acceptance target of the parent ticket: the journal
    // reads +739.00 today, the broker says +713.73, so the pass must move the
    // book by exactly −25.27.
    expect(plan.netDeltaUsd).toBe(-25.27);
  });

  it('decomposes the correction into entry-basis and fees, and the parts sum to the whole', () => {
    const plan = planCloseBasisRestate([row()], aaplFills());
    const r = plan.rows[0]!;
    // 0.045 of mid-vs-fill on 4 contracts, and the broker's 0.91 of commission.
    expect(r.entryBasisDeltaUsd).toBe(-18);
    expect(r.feeDeltaUsd).toBe(-0.91);
    expect(r.deltaUsd).toBe(-18.91);
    expect(Math.round(((r.entryBasisDeltaUsd ?? 0) + (r.feeDeltaUsd ?? 0)) * 100) / 100).toBe(r.deltaUsd);
    expect(r.entryFillPremium).toBe(1.04);
    expect(r.exitFillPremium).toBe(2.78);
  });

  it('recomputes R against the ORIGINAL atRiskUsd, not the restated fill cost', () => {
    // The entry basis moves 0.995 -> 1.04, so if R were re-divided by the fill
    // cost (416) instead of the open-time basis (398) it would read 1.6709. R is
    // what makes rows comparable across the cohort; restating its denominator is
    // a different ruling than "book the broker's money", and this pins that we
    // did not quietly make it.
    const plan = planCloseBasisRestate([row()], aaplFills());
    expect(plan.rows[0]!.basis?.realizedR).toBe(1.7465); // 695.09 / 398
    expect(plan.rows[0]!.basis?.realizedR).not.toBe(1.6709); // 695.09 / 416, the fill cost
    expect(plan.rows[0]!.basis?.outcome).toBe('WIN');
  });

  it('re-derives the outcome, so a fee correction can move a row across the scratch band', () => {
    // A row whose gross P&L sits just inside the +0.1R scratch band and whose
    // fees push it just outside. Carrying the old outcome over would leave the
    // money and the verdict disagreeing.
    const plan = planCloseBasisRestate(
      [row({ atRiskUsd: 100, contracts: 1, entryMarkUsd: 1, realizedPnlUsd: 9, outcome: 'SCRATCH' })],
      [
        fill({ optionSymbol: 'AAPL260904P00280000', side: 'buy_to_open', ts: OPEN_TS_AAPL, contracts: 1, filledPrice: 1, fees: 0.11 }),
        fill({ optionSymbol: 'AAPL260904P00280000', side: 'sell_to_close', ts: CLOSE_TS_AAPL, contracts: 1, filledPrice: 1.12, fees: 0.11 }),
      ],
    );
    expect(plan.rows[0]!.basis?.realizedPnlUsd).toBe(11.78);
    expect(plan.rows[0]!.basis?.outcome).toBe('WIN');
  });

  it('REFUSES a row with an unmeasured fee rather than booking a gross figure as broker truth', () => {
    // The whole point of the strictness: `fees: null` is UNMEASURED, not free
    // (TRA-1707). Zero-filling here would produce 696.00 — a number that looks
    // settled, is off by the commission, and stops anyone looking again.
    const partial = aaplFills();
    partial[2] = { ...partial[2]!, fees: null };
    const plan = planCloseBasisRestate([row()], partial);
    expect(plan.counts).toEqual({ restate: 0, skip: 1 });
    expect(plan.rows[0]!.skipReason).toBe('fees_unmeasured');
    expect(plan.rows[0]!.realizedPnlUsdAfter).toBeNull();
    expect(plan.netDeltaUsd).toBe(0);
  });

  it('skips a row that already agrees with the broker, and says so with its numbers', () => {
    // The PLTR round trip TRA-3485 reconstructed: priced from these same fills
    // and already netted of fees, so it is broker-exact. It is the positive
    // control — a row the arithmetic REACHES and finds nothing wrong with, which
    // is a different fact from a row it never reached.
    const plan = planCloseBasisRestate(
      [
        row({
          id: 'pltr-row',
          symbol: 'PLTR',
          optionSymbol: 'PLTR260911C00170000',
          contracts: 1,
          atRiskUsd: 409.99999999999994,
          entryMarkUsd: 4.1,
          openTs: 1785850982720,
          closeTs: 1785862800000,
          realizedPnlUsd: 155.75,
          exitReason: 'reconstructed-TRA-3472',
        }),
      ],
      [
        fill({ optionSymbol: 'PLTR260911C00170000', side: 'buy_to_open', ts: 1785850983942, contracts: 1, filledPrice: 4.44, fees: 0.11 }),
        fill({ optionSymbol: 'PLTR260911C00170000', side: 'sell_to_close', ts: 1785862800000, contracts: 1, filledPrice: 6, fees: 0.14, origin: 'history_import' }),
      ],
    );
    expect(plan.counts).toEqual({ restate: 0, skip: 1 });
    expect(plan.rows[0]!.skipReason).toBe('zero_delta');
    // Reported WITH its numbers: a bare skip could not be told from a miss.
    expect(plan.rows[0]!.realizedPnlUsdAfter).toBe(155.75);
    expect(plan.rows[0]!.deltaUsd).toBe(0);
  });

  it('is idempotent — a restated row is not re-priced on a second pass', () => {
    const plan = planCloseBasisRestate([row({ pnlBasis: 'broker-fill' })], aaplFills());
    expect(plan.counts).toEqual({ restate: 0, skip: 1 });
    expect(plan.rows[0]!.skipReason).toBe('already_restated');
  });

  it('never touches the demo book or an OPEN row', () => {
    const plan = planCloseBasisRestate(
      [row({ id: 'demo', mode: 'demo' }), row({ id: 'open', outcome: 'OPEN' })],
      aaplFills(),
    );
    expect(plan.scanned).toBe(0);
    expect(plan.rows).toHaveLength(0);
  });

  it('will not claim a LATER position\'s exit on the same contract', () => {
    // This book re-acquires the same OCC symbols. Without the upper bound on the
    // exit window, a re-entry's exit would be pulled back onto this settled row
    // and reprice it off somebody else's fill — the mirror of the TRA-3485 hook
    // about an unrelated fill DEFINING the size of the row it is matched to.
    const withLaterExit = [
      ...aaplFills().filter((f) => f.side === 'buy_to_open'),
      fill({
        optionSymbol: 'AAPL260904P00280000',
        side: 'sell_to_close',
        ts: CLOSE_TS_AAPL + EXIT_MATCH_GRACE_MS + 1,
        contracts: 4,
        filledPrice: 9.99,
        fees: 0.44,
      }),
    ];
    const plan = planCloseBasisRestate([row()], withLaterExit);
    expect(plan.rows[0]!.skipReason).toBe('no_exit_fill_in_window');
    expect(plan.rows[0]!.excluded.some((e) => e.why.includes('LATER position'))).toBe(true);
  });

  it('refuses a partially covered exit rather than pricing a fraction as the whole', () => {
    const half = [
      ...aaplFills().filter((f) => f.side === 'buy_to_open'),
      fill({ optionSymbol: 'AAPL260904P00280000', side: 'sell_to_close', ts: CLOSE_TS_AAPL, contracts: 2, filledPrice: 2.78, fees: 0.22 }),
    ];
    const plan = planCloseBasisRestate([row()], half);
    expect(plan.rows[0]!.skipReason).toBe('exit_partially_covered');
  });

  it('counts every skip by reason, so the denominator is never implicit', () => {
    const plan = planCloseBasisRestate(
      [row({ id: 'a', pnlBasis: 'broker-fill' }), row({ id: 'b', optionSymbol: undefined }), row({ id: 'c', contracts: undefined })],
      aaplFills(),
    );
    expect(plan.scanned).toBe(3);
    expect(plan.skipsByReason).toEqual({ already_restated: 1, no_option_symbol: 1, no_contract_count: 1 });
  });
});
