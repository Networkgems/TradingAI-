// TRA-3485 — the PARTITIONED repair for the 13 stale live `OPEN` journal rows.
//
// Every fixture below is a SHAPE OBSERVED ON THE LIVE ADMIN BOOK on 2026-08-13,
// not an invention. That matters because the two failure modes this planner has
// to avoid are symmetric and both are one-way:
//
//   * back-filling a close for a row that never filled INVENTS a trade — into
//     the learner, the expectancy fold, and every verdict that reads the journal
//     as the desk's record;
//   * retracting a row that DID fill ERASES a real live trade and its P&L.
//
// So the tests that matter most are the REFUSALS. A planner that "does its best"
// on an ambiguous row produces a plausible number, and a plausible wrong number
// in this file is indistinguishable from a right one downstream.
import { describe, it, expect } from 'vitest';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { planStaleOpenRepair, RECONSTRUCTED_EXIT_REASON, ENTRY_MATCH_WINDOW_MS } from './tra3485-stale-open-repair.js';

const T = (iso: string): number => Date.parse(iso);

function row(overrides: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'row-1',
    openTs: T('2026-07-31T13:36:02Z'),
    symbol: 'AMZN',
    optionSymbol: 'AMZN260904P00245000',
    structure: 'single_leg_otm',
    mode: 'live',
    outcome: 'OPEN',
    ivRank: 40,
    trend: 'down',
    sentiment: null,
    entryDelta: -0.22,
    entryDte: 35,
    atRiskUsd: 280.5,
    contracts: 1,
    ...overrides,
  };
}

function fill(overrides: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: T('2026-07-31T13:36:03Z'),
    etDay: '2026-07-31',
    sleeve: 'single_leg_otm',
    optionSymbol: 'AMZN260904P00245000',
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: 2.8,
    askAtSubmit: 2.8,
    midAtSubmit: 2.79,
    filledPrice: 2.78,
    fees: 0.11,
    feeSource: 'gainloss_derived',
    slippageVsAsk: -0.02,
    slippageVsMid: -0.01,
    orderId: 139506961,
    origin: 'fill',
    ...overrides,
  };
}

describe('TRA-3485 — Group A: never filled, therefore RETRACT', () => {
  it('retracts a live OPEN row with no fill on either leg', () => {
    // The live SO260918C00092500 shape: journalled, aborted inside the mirror,
    // position deleted, journal row stranded. No ledger row on either side.
    const plan = planStaleOpenRepair(
      [row({ id: 'so', symbol: 'SO', optionSymbol: 'SO260918C00092500', contracts: 2, atRiskUsd: 345 })],
      [],
    );
    expect(plan.counts).toEqual({ retract: 1, backfillClose: 0, noAction: 0 });
    expect(plan.rows[0]!.treatment).toBe('retract');
    expect(plan.rows[0]!.close).toBeUndefined();
    expect(plan.rows[0]!.reason).toMatch(/never filled|no buy_to_open/);
  });

  it('does NOT retract on the strength of an unrelated contract having no fills', () => {
    // The join is per-OCC. A ledger full of OTHER contracts' fills must not make
    // this row look filled, and must not make it look un-filled either — the
    // discriminator is this contract's own rows.
    const plan = planStaleOpenRepair(
      [row({ id: 'so', optionSymbol: 'SO260918C00092500', contracts: 2 })],
      [fill({ optionSymbol: 'NVDA260918C00280000' }), fill({ optionSymbol: 'NVDA260918C00280000', side: 'sell_to_close' })],
    );
    expect(plan.rows[0]!.treatment).toBe('retract');
    expect(plan.rows[0]!.ledgerOpens).toBe(0);
    expect(plan.rows[0]!.ledgerCloses).toBe(0);
  });
});

describe('TRA-3485 — Group B: filled both legs, therefore BACKFILL a CLOSE', () => {
  it('reconstructs the close at broker-exact cents, net of measured fees', () => {
    // Live AMZN260904P00245000: 1 @ 2.78 in, 1 @ 0.89 out, 0.11 + 0.13 fees.
    const plan = planStaleOpenRepair(
      [row()],
      [
        fill(),
        fill({
          ts: T('2026-08-03T13:30:16Z'),
          side: 'sell_to_close',
          filledPrice: 0.89,
          fees: 0.13,
          // The live close carried a DIFFERENT sleeve than the open. Matching on
          // sleeve would have split this round trip in half.
          sleeve: 'single_leg_directional',
        }),
      ],
    );
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('backfill_close');
    // 89 − 278 − 0.11 − 0.13
    expect(r.close!.realizedPnlUsd).toBe(-189.24);
    // Denominator is the entry basis captured AT OPEN (atRiskUsd), not the fill
    // cost — that is what makes R comparable across rows.
    expect(r.close!.realizedR).toBe(-0.6747); // −189.24 / 280.5
    expect(r.close!.outcome).toBe('LOSS');
    expect(r.close!.closeTs).toBe(T('2026-08-03T13:30:16Z'));
    expect(r.close!.holdDays).toBeCloseTo(2.997, 2);
    expect(r.feesComplete).toBe(true);
  });

  it('marks the exit reason RECONSTRUCTED rather than borrowing the engine vocabulary', () => {
    // The whole TRA-2937 complaint is that the exit DECISION is unrecoverable.
    // Broker fills say what happened, never why. A close wearing `stop` would
    // assert a decision nobody made and join the byExitReason rollup as observed.
    const plan = planStaleOpenRepair(
      [row()],
      [fill(), fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 })],
    );
    expect(plan.rows[0]!.close!.exitReason).toBe(RECONSTRUCTED_EXIT_REASON);
    expect(['tp1', 'stop', 'time_stop', 'expired', 'manual']).not.toContain(plan.rows[0]!.close!.exitReason);
  });

  it('omits exitSlippageUsd — no closing mark was ever captured', () => {
    // Deriving it from the fill would make the measurement equal its own input
    // and report 0 slippage on trades whose slippage is unknown.
    const plan = planStaleOpenRepair(
      [row()],
      [fill(), fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 })],
    );
    expect(plan.rows[0]!.close).not.toHaveProperty('exitSlippageUsd');
  });

  it('folds a TWO-SLICE exit into one cumulative close stamped at the LAST slice', () => {
    // Live TSLA260911C00560000: 4 in, out as 2 + 2 on the same day.
    const plan = planStaleOpenRepair(
      [row({ id: 'tsla', symbol: 'TSLA', optionSymbol: 'TSLA260911C00560000', contracts: 4, atRiskUsd: 100, openTs: T('2026-08-04T13:47:53Z') })],
      [
        fill({ optionSymbol: 'TSLA260911C00560000', ts: T('2026-08-04T13:47:54Z'), contracts: 4, filledPrice: 0.27, fees: 0.42 }),
        fill({ optionSymbol: 'TSLA260911C00560000', ts: T('2026-08-05T13:34:21Z'), side: 'sell_to_close', contracts: 2, filledPrice: 0.25, fees: 0.24 }),
        fill({ optionSymbol: 'TSLA260911C00560000', ts: T('2026-08-05T15:13:47Z'), side: 'sell_to_close', contracts: 2, filledPrice: 0.24, fees: 0.24 }),
      ],
    );
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('backfill_close');
    // (50 + 48) − 108 − 0.42 − 0.24 − 0.24
    expect(r.close!.realizedPnlUsd).toBe(-10.9);
    expect(r.close!.realizedR).toBe(-0.109);
    // −0.109 is outside the ±0.1 scratch band. A planner that rounded R to 1dp
    // would call this a SCRATCH.
    expect(r.close!.outcome).toBe('LOSS');
    expect(r.close!.closeTs).toBe(T('2026-08-05T15:13:47Z'));
    expect(r.allocations.filter((a) => a.side === 'sell_to_close')).toHaveLength(2);
  });
});

describe('TRA-3485 — the allocation guards, where a wrong number would look right', () => {
  it('claims only the journalled contracts from an OVER-COVERING exit, and pro-rates its fee', () => {
    // Live QQQ260911P00545000: the row is 4 contracts; the exit sold 5, because
    // it also closed 1 contract of an unattributed imported position. Crediting
    // the whole 5 would overstate this row's proceeds by 25%.
    const plan = planStaleOpenRepair(
      [row({ id: 'qqq', symbol: 'QQQ', optionSymbol: 'QQQ260911P00545000', contracts: 4, atRiskUsd: 222, openTs: T('2026-08-04T13:47:54Z') })],
      [
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-04T13:47:55Z'), contracts: 4, filledPrice: 0.58, fees: null, feeSource: null }),
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-05T13:44:17Z'), side: 'sell_to_close', contracts: 5, filledPrice: 0.438, fees: 0.55 }),
      ],
    );
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('backfill_close');
    const exit = r.allocations.find((a) => a.side === 'sell_to_close')!;
    expect(exit.recordContracts).toBe(5);
    expect(exit.allocatedContracts).toBe(4);
    expect(exit.allocatedFees).toBe(0.44); // 0.55 × 4/5
    // 175.2 − 232 − 0.44   (the entry fee is unmeasured, see below)
    expect(r.close!.realizedPnlUsd).toBe(-57.24);
    expect(r.close!.realizedR).toBe(-0.2578);
  });

  it('reports feesComplete:false when a leg carries fees:null instead of zero-filling it', () => {
    // `fees:null` means UNMEASURED, not free (TRA-1707). Excluding it silently
    // would understate the loss and read as a broker-exact number.
    const plan = planStaleOpenRepair(
      [row({ id: 'qqq', optionSymbol: 'QQQ260911P00545000', contracts: 4, atRiskUsd: 222, openTs: T('2026-08-04T13:47:54Z') })],
      [
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-04T13:47:55Z'), contracts: 4, filledPrice: 0.58, fees: null, feeSource: null }),
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-05T13:44:17Z'), side: 'sell_to_close', contracts: 5, filledPrice: 0.438, fees: 0.55 }),
      ],
    );
    expect(plan.rows[0]!.feesComplete).toBe(false);
  });

  it('EXCLUDES a buy_to_open outside the entry window and says why', () => {
    // Live QQQ260911P00545000 also carries a `history_import` buy_to_open stamped
    // 17:00:00Z, 3h13m after the real entry, belonging to a different position.
    // Pricing the entry off both would size this row at 5 contracts.
    const plan = planStaleOpenRepair(
      [row({ id: 'qqq', optionSymbol: 'QQQ260911P00545000', contracts: 4, atRiskUsd: 222, openTs: T('2026-08-04T13:47:54Z') })],
      [
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-04T13:47:55Z'), contracts: 4, filledPrice: 0.58 }),
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-04T17:00:00Z'), contracts: 1, filledPrice: 0.58, sleeve: 'unattributed', origin: 'history_import', orderId: null }),
        fill({ optionSymbol: 'QQQ260911P00545000', ts: T('2026-08-05T13:44:17Z'), side: 'sell_to_close', contracts: 5, filledPrice: 0.438, fees: 0.55 }),
      ],
    );
    const r = plan.rows[0]!;
    const entries = r.allocations.filter((a) => a.side === 'buy_to_open');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.allocatedContracts).toBe(4);
    expect(r.excluded.some((e) => e.origin === 'history_import' && /entry window/.test(e.why))).toBe(true);
  });

  it('flags closeTsImported when the close came from a history import, not a fill-time capture', () => {
    // Live PLTR260911C00170000: the close is a `history_import` stamped 17:00:00Z
    // — an EOD-ish synthetic instant, not the true fill time. The closeTs inherits
    // that imprecision and must say so.
    const plan = planStaleOpenRepair(
      [row({ id: 'pltr', symbol: 'PLTR', optionSymbol: 'PLTR260911C00170000', contracts: 1, atRiskUsd: 410, openTs: T('2026-08-04T13:43:02Z') })],
      [
        fill({ optionSymbol: 'PLTR260911C00170000', ts: T('2026-08-04T13:43:03Z'), filledPrice: 4.44, fees: 0.11 }),
        fill({ optionSymbol: 'PLTR260911C00170000', ts: T('2026-08-04T17:00:00Z'), side: 'sell_to_close', filledPrice: 6, fees: 0.14, origin: 'history_import', orderId: null }),
      ],
    );
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('backfill_close');
    expect(r.closeTsImported).toBe(true);
    expect(r.close!.realizedPnlUsd).toBe(155.75);
    expect(r.close!.outcome).toBe('WIN');
  });
});

describe('TRA-3485 — REFUSALS: the ambiguous shapes get no_action, never a guess', () => {
  it('REFUSES a row whose entry filled but has no exit — it may still be open at the broker', () => {
    // The single most dangerous shape. Retracting it erases a live position that
    // is genuinely still on; closing it invents an exit that has not happened.
    const plan = planStaleOpenRepair([row()], [fill()]);
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/still be OPEN at the broker/);
    expect(plan.counts.retract).toBe(0);
  });

  it('REFUSES when the exit does not cover the journalled contracts', () => {
    const plan = planStaleOpenRepair(
      [row({ contracts: 4, atRiskUsd: 200 })],
      [
        fill({ contracts: 4 }),
        fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', contracts: 2, filledPrice: 0.89, fees: 0.13 }),
      ],
    );
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/2\/4 journalled contracts/);
  });

  it('REFUSES when the entry does not cover the journalled contracts', () => {
    const plan = planStaleOpenRepair(
      [row({ contracts: 4, atRiskUsd: 200 })],
      [
        fill({ contracts: 1 }),
        fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', contracts: 4, filledPrice: 0.89, fees: 0.13 }),
      ],
    );
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/1\/4 journalled contracts/);
  });

  it('REFUSES a contract with fills but no in-window entry — and never retracts it', () => {
    // Fills exist, so "no ledger row means no fill" does not apply; but none of
    // them can be this row's entry, so there is no basis to price a close either.
    const plan = planStaleOpenRepair(
      [row()],
      [
        fill({ ts: row().openTs + ENTRY_MATCH_WINDOW_MS + 1000 }),
        fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 }),
      ],
    );
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/none of the opens is within the entry window/);
  });

  it('REFUSES a row with no optionSymbol rather than retracting it as unjoinable', () => {
    // It cannot be joined to the ledger at all, so its partition is UNKNOWABLE.
    // Unknowable must not collapse into "never filled" — that is a delete.
    const plan = planStaleOpenRepair([row({ optionSymbol: undefined })], []);
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/no optionSymbol/);
  });

  it('REFUSES to price a row that carries no contract count', () => {
    const plan = planStaleOpenRepair(
      [row({ contracts: undefined })],
      [fill(), fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 })],
    );
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/no contract count/);
  });

  it('REFUSES when an allocated fill carries no filledPrice', () => {
    const plan = planStaleOpenRepair(
      [row()],
      [
        fill({ filledPrice: null }),
        fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 }),
      ],
    );
    expect(plan.rows[0]!.treatment).toBe('no_action');
    expect(plan.rows[0]!.reason).toMatch(/entry basis is unmeasured/);
  });
});

describe('TRA-3485 — scope: the pass cannot reach outside live OPEN rows', () => {
  it('ignores demo rows and already-CLOSED rows', () => {
    const plan = planStaleOpenRepair(
      [
        row({ id: 'demo', mode: 'demo' }),
        row({ id: 'closed', outcome: 'WIN', realizedPnlUsd: 12, realizedR: 0.4, closeTs: T('2026-08-03T13:30:16Z') }),
        row({ id: 'live-open' }),
      ],
      [],
    );
    expect(plan.scanned).toBe(1);
    expect(plan.rows.map((r) => r.id)).toEqual(['live-open']);
  });

  it('partitions a mixed cohort into both treatments in one pass', () => {
    // The headline assertion: 1 retract + 1 backfill from the SAME call. A
    // planner that applied one treatment uniformly fails here and nowhere else.
    const plan = planStaleOpenRepair(
      [
        row({ id: 'never', optionSymbol: 'SO260918C00092500', contracts: 2, atRiskUsd: 345 }),
        row({ id: 'roundtrip' }),
      ],
      [fill(), fill({ ts: T('2026-08-03T13:30:16Z'), side: 'sell_to_close', filledPrice: 0.89, fees: 0.13 })],
    );
    expect(plan.counts).toEqual({ retract: 1, backfillClose: 1, noAction: 0 });
    expect(plan.rows.find((r) => r.id === 'never')!.treatment).toBe('retract');
    expect(plan.rows.find((r) => r.id === 'roundtrip')!.treatment).toBe('backfill_close');
  });
});
