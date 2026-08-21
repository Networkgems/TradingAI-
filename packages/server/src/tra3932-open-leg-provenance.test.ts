/**
 * TRA-3932 — the open-leg provenance resolver.
 *
 * The suite is organised around ONE property: **no failure of the broker read may
 * ever become an accusation.** Every blind limb is asserted with its own reason
 * (a shared `blind` would let three different refusals collapse into one), and the
 * two terminal limbs are each proved REACHABLE — a resolver whose only possible
 * output is blind emits the same bytes as a resolver that cannot answer at all,
 * which is TRA-3926's C8 lesson one ticket over.
 */

import { describe, it, expect } from 'vitest';
import {
  measureBrokerOrderReach,
  reachCovers,
  deriveOpenLegSubjects,
  engineFilledOrderIds,
  resolveOpenLegProvenance,
  etDayOfIso,
  isTerminalProvenanceVerdict,
} from './tra3932-open-leg-provenance.js';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OversoldCloseCensus } from './tra3926-oversold-close-detector.js';
import type { TradierAccountOrder } from '@trading-app/engine';
import { parseTradierOrders } from '@trading-app/engine';

// ── fixtures ────────────────────────────────────────────────────────────────

const OCC = 'SPY260807P00760000';

function fill(over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: Date.parse('2026-08-04T17:00:00Z'),
    etDay: '2026-08-04',
    sleeve: 'unattributed',
    optionSymbol: OCC,
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: 1.31,
    fees: null,
    feeSource: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'history_import',
    ...over,
  } as LiveOptionFillRecord;
}

function order(over: Partial<TradierAccountOrder> = {}): TradierAccountOrder {
  return {
    id: 900001,
    status: 'filled',
    orderClass: 'option',
    side: 'buy_to_open',
    symbol: 'SPY',
    optionSymbol: OCC,
    quantity: 1,
    execQuantity: 1,
    avgFillPrice: 1.31,
    createDate: '2026-08-04T13:40:00.000Z',
    transactionDate: '2026-08-04T13:40:02.000Z',
    tag: null,
    ...over,
  };
}

/** One import-only blind close, the live 2026-08-21 shape. */
function blindCensus(over: Partial<OversoldCloseCensus> = {}): OversoldCloseCensus {
  return {
    status: 'oversold',
    engineCloses: 1,
    judgedCloses: 0,
    importedCloses: 0,
    excessContracts: 0,
    findings: [],
    blindCloses: [
      {
        optionSymbol: OCC,
        ts: Date.parse('2026-08-05T13:31:18.854Z'),
        reason: 'import_only',
        soldContracts: 4,
        importedOpenContracts: 4,
      },
    ],
    ...over,
  };
}

const IMPORT_ONLY_RECORDS: LiveOptionFillRecord[] = [
  fill({ filledPrice: 1.31 }),
  fill({ filledPrice: 1.19 }),
  fill({ filledPrice: 0.99 }),
  fill({ filledPrice: 0.93 }),
  fill({
    ts: Date.parse('2026-08-05T13:31:18.854Z'),
    etDay: '2026-08-05',
    side: 'sell_to_close',
    contracts: 4,
    filledPrice: 0.4575,
    orderId: 140277035,
    origin: 'fill',
    sleeve: 'single_leg_directional',
  }),
];

function resolve(
  brokerOrders: readonly TradierAccountOrder[] | null,
  opts: {
    census?: OversoldCloseCensus;
    records?: LiveOptionFillRecord[];
    submitted?: ReadonlySet<number> | null;
  } = {},
) {
  return resolveOpenLegProvenance({
    census: opts.census ?? blindCensus(),
    records: opts.records ?? IMPORT_ONLY_RECORDS,
    brokerOrders,
    engineSubmittedOrderIds: opts.submitted ?? null,
    resolvedAt: Date.parse('2026-08-21T22:00:00Z'),
  });
}

// ── reach: the axis every refusal hangs off ─────────────────────────────────

describe('TRA-3932 reach — what the order list actually covered', () => {
  it('an UNREAD list is not an empty one, and only the unread state says read:false', () => {
    expect(measureBrokerOrderReach(null).read).toBe(false);
    expect(measureBrokerOrderReach([]).read).toBe(true);
    expect(measureBrokerOrderReach([]).orders).toBe(0);
  });

  it('measures the oldest create_date and the ET days spanned', () => {
    const reach = measureBrokerOrderReach([
      order({ id: 1, createDate: '2026-08-21T14:00:00.000Z' }),
      order({ id: 2, createDate: '2026-08-20T18:30:00.000Z' }),
    ]);
    expect(reach.oldestCreateDate).toBe('2026-08-20T18:30:00.000Z');
    expect(reach.newestCreateDate).toBe('2026-08-21T14:00:00.000Z');
    expect(reach.etDaysCovered).toEqual(['2026-08-20', '2026-08-21']);
    expect(reach.rowsMissingCreateDate).toBe(0);
  });

  it('a row with no parseable create_date is COUNTED, never treated as reaching anything', () => {
    const reach = measureBrokerOrderReach([
      order({ id: 1, createDate: null }),
      order({ id: 2, createDate: 'not-a-date' }),
    ]);
    expect(reach.orders).toBe(2);
    expect(reach.rowsMissingCreateDate).toBe(2);
    expect(reach.oldestCreateDate).toBeNull();
    // The whole point: 2 rows in hand and the reach is still FALSE.
    expect(reachCovers(reach, '2026-08-04')).toBe(false);
  });

  it('all three ways of having seen nothing answer FALSE to reachCovers', () => {
    expect(reachCovers(measureBrokerOrderReach(null), '2026-08-04')).toBe(false);
    expect(reachCovers(measureBrokerOrderReach([]), '2026-08-04')).toBe(false);
    expect(
      reachCovers(measureBrokerOrderReach([order({ createDate: null })]), '2026-08-04'),
    ).toBe(false);
  });

  it('reach is inclusive of the boundary day and uses ET, not UTC', () => {
    // 2026-08-05T01:30Z is 2026-08-04 21:30 ET — the ET day is 08-04, not 08-05.
    const reach = measureBrokerOrderReach([order({ createDate: '2026-08-05T01:30:00.000Z' })]);
    expect(etDayOfIso(reach.oldestCreateDate)).toBe('2026-08-04');
    expect(reachCovers(reach, '2026-08-04')).toBe(true);
    expect(reachCovers(reach, '2026-08-03')).toBe(false);
  });
});

// ── subjects ────────────────────────────────────────────────────────────────

describe('TRA-3932 subjects — the population, and which DAY the reach test asks about', () => {
  it('an import_only blind contributes its imported open contracts', () => {
    const subjects = deriveOpenLegSubjects(blindCensus(), IMPORT_ONLY_RECORDS);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]!.kind).toBe('blind');
    expect(subjects[0]!.contracts).toBe(4);
    // The OPEN's day, off the ledger — not the close's 08-05.
    expect(subjects[0]!.openEtDay).toBe('2026-08-04');
    expect(subjects[0]!.closeEtDay).toBe('2026-08-05');
    expect(subjects[0]!.closeOrderId).toBe(140277035);
  });

  it('the OLDEST imported open sets the day — the reach test must clear the hardest one', () => {
    const records = [
      ...IMPORT_ONLY_RECORDS,
      fill({ ts: Date.parse('2026-08-01T17:00:00Z'), etDay: '2026-08-01' }),
    ];
    expect(deriveOpenLegSubjects(blindCensus(), records)[0]!.openEtDay).toBe('2026-08-01');
  });

  it('a FINDING contributes only its EXCESS contracts, keyed on the IMPORTED leg day', () => {
    const census = blindCensus({
      blindCloses: [],
      findings: [
        {
          optionSymbol: OCC,
          ts: Date.parse('2026-08-05T13:44:17.690Z'),
          etDay: '2026-08-05',
          orderId: 140287732,
          soldContracts: 5,
          engineOpenContracts: 4,
          importedOpenContracts: 1,
          excessContracts: 1,
        },
      ],
    });
    const subjects = deriveOpenLegSubjects(census, IMPORT_ONLY_RECORDS);
    expect(subjects[0]!.kind).toBe('finding');
    expect(subjects[0]!.contracts).toBe(1);
    // The excess came out of the DESK's outstanding contracts, so the leg whose
    // provenance is in question is the imported one — 08-04, not the close's 08-05.
    expect(subjects[0]!.openEtDay).toBe('2026-08-04');
  });

  it('blind closes that are NOT import_only are out of scope — this ticket owns one shape', () => {
    const census = blindCensus({
      blindCloses: [
        {
          optionSymbol: OCC,
          ts: Date.parse('2026-08-05T13:31:18.854Z'),
          reason: 'no_open_record',
          soldContracts: 4,
          importedOpenContracts: 0,
        },
      ],
    });
    expect(deriveOpenLegSubjects(census, IMPORT_ONLY_RECORDS)).toHaveLength(0);
  });
});

// ── the id set: a POSITIVE witness in one direction only ────────────────────

describe('TRA-3932 engineFilledOrderIds', () => {
  it('collects fill-time ids and EXCLUDES history_import rows', () => {
    const ids = engineFilledOrderIds([
      fill({ orderId: 111, origin: 'fill' }),
      fill({ orderId: 222, origin: 'history_import' }),
      fill({ orderId: null, origin: 'fill' }),
    ]);
    expect([...ids]).toEqual([111]);
  });
});

// ── the six verdicts, each on its own limb ──────────────────────────────────

describe('TRA-3932 verdicts — a blind never becomes an accusation', () => {
  it('a FAILED fetch is blind_broker_unreadable, not "no order exists"', () => {
    const r = resolve(null);
    expect(r.rows[0]!.verdict).toBe('blind_broker_unreadable');
    expect(r.contractsByVerdict.desk_placed).toBe(0);
    expect(r.unresolvedContracts).toBe(4);
  });

  it('AC5 — a list that does not reach the open day is blind_broker_window', () => {
    // Today-only, the shape `/orders` is documented to have in our own tooling.
    const r = resolve([order({ id: 7, createDate: '2026-08-21T14:00:00.000Z', optionSymbol: 'XLF260925C00057500' })]);
    expect(r.rows[0]!.verdict).toBe('blind_broker_window');
    expect(r.rows[0]!.detail).toContain('2026-08-21T14:00:00.000Z');
    expect(r.rows[0]!.detail).toContain('2026-08-04');
  });

  it('an EMPTY list — read, but holding nothing — is blind_broker_window, never desk_placed', () => {
    const r = resolve([]);
    expect(r.rows[0]!.verdict).toBe('blind_broker_window');
    expect(r.contractsByVerdict.desk_placed).toBe(0);
  });

  it('reaching the day but holding no opening order for the OCC is blind_no_order_record', () => {
    const r = resolve([order({ id: 7, optionSymbol: 'QQQ260807P00700000' })]);
    expect(r.rows[0]!.verdict).toBe('blind_no_order_record');
  });

  it('a CLOSING order on the subject OCC does not count as an opening record', () => {
    const r = resolve([order({ id: 7, side: 'sell_to_close' })]);
    expect(r.rows[0]!.verdict).toBe('blind_no_order_record');
    expect(r.rows[0]!.brokerOpeningOrderIds).toEqual([]);
  });

  it('AC4 — an opening id in our own FILL ledger is engine_placed, and routes to TRA-2959', () => {
    const records = [
      ...IMPORT_ONLY_RECORDS,
      // A different contract we DID record, whose order id is the one the broker
      // shows against the subject's open. This is the positive-witness shape.
      fill({ optionSymbol: 'RIG260925C00006000', orderId: 900001, origin: 'fill' }),
    ];
    const r = resolve([order({ id: 900001 })], { records });
    expect(r.rows[0]!.verdict).toBe('engine_placed');
    expect(r.rows[0]!.matchedEngineOrderIds).toEqual([900001]);
    expect(r.rows[0]!.detail).toContain('TRA-2959');
    expect(r.unresolvedContracts).toBe(0);
  });

  it('THE LIVE STATE — a record exists, is not ours by fill, and no submit witness exists ⇒ blind_no_issuer_witness', () => {
    const r = resolve([order({ id: 900001 })]);
    expect(r.rows[0]!.verdict).toBe('blind_no_issuer_witness');
    // The verdict must name OUR gap, not the broker's.
    expect(r.rows[0]!.detail).toContain('submit-time');
    expect(r.contractsByVerdict.desk_placed).toBe(0);
  });

  it('AC3 — with a submit witness present, an unknown opening id IS desk_placed', () => {
    const r = resolve([order({ id: 900001 })], { submitted: new Set([555555]) });
    expect(r.rows[0]!.verdict).toBe('desk_placed');
    expect(r.rows[0]!.detail).toContain('predating the bound');
    expect(r.contractsByVerdict.desk_placed).toBe(4);
    expect(r.unresolvedContracts).toBe(0);
  });

  it('the same witness, with the id IN it, flips the SAME fixture to engine_placed', () => {
    // The pair is the point: one input, two verdicts, differing only in the
    // witness. A `desk_placed` that fires on every witnessed input would be the
    // accusation machine this module exists to refuse.
    const r = resolve([order({ id: 900001 })], { submitted: new Set([900001]) });
    expect(r.rows[0]!.verdict).toBe('engine_placed');
  });

  it('only engine_placed / desk_placed are terminal — every blind stays unresolved', () => {
    expect(isTerminalProvenanceVerdict('engine_placed')).toBe(true);
    expect(isTerminalProvenanceVerdict('desk_placed')).toBe(true);
    expect(isTerminalProvenanceVerdict('blind_broker_window')).toBe(false);
    expect(isTerminalProvenanceVerdict('blind_no_issuer_witness')).toBe(false);
    expect(isTerminalProvenanceVerdict('blind_no_order_record')).toBe(false);
    expect(isTerminalProvenanceVerdict('blind_broker_unreadable')).toBe(false);
  });

  it('subjectContracts is conserved across the verdict fold', () => {
    const r = resolve([order({ id: 900001 })]);
    const summed = Object.values(r.contractsByVerdict).reduce((a, b) => a + b, 0);
    expect(summed).toBe(r.subjectContracts);
    expect(r.subjectContracts).toBe(4);
  });
});

// ── the parser ──────────────────────────────────────────────────────────────

describe('TRA-3932 parseTradierOrders', () => {
  it('normalises the single-order envelope Tradier sends when there is exactly one', () => {
    const rows = parseTradierOrders({
      orders: {
        order: {
          id: 142603071,
          status: 'filled',
          class: 'option',
          side: 'buy_to_open',
          symbol: 'XLF',
          option_symbol: 'XLF260925C00057500',
          quantity: '1',
          exec_quantity: '1',
          avg_fill_price: '1.08',
          create_date: '2026-08-20T13:35:29.000Z',
          transaction_date: '2026-08-20T13:35:30.000Z',
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(142603071);
    expect(rows[0]!.optionSymbol).toBe('XLF260925C00057500');
    // Tradier sends numerics as strings on some shapes; both coerce.
    expect(rows[0]!.quantity).toBe(1);
    expect(rows[0]!.avgFillPrice).toBe(1.08);
    expect(rows[0]!.tag).toBeNull();
  });

  it("the string 'null' envelope and a missing one both yield []", () => {
    expect(parseTradierOrders({ orders: 'null' })).toEqual([]);
    expect(parseTradierOrders({})).toEqual([]);
    expect(parseTradierOrders(null)).toEqual([]);
  });

  it('a row with no coercible id is DROPPED — it can be joined to nothing', () => {
    expect(parseTradierOrders({ orders: { order: [{ status: 'filled' } as never] } })).toEqual([]);
  });

  it('multileg legs are FLATTENED, so an OCC traded inside a spread is still found', () => {
    const rows = parseTradierOrders({
      orders: {
        order: {
          id: 5,
          status: 'filled',
          class: 'multileg',
          symbol: 'SPY',
          create_date: '2026-08-04T13:40:00.000Z',
          leg: [
            { side: 'buy_to_open', option_symbol: OCC, quantity: 1, exec_quantity: 1 },
            { side: 'sell_to_open', option_symbol: 'SPY260807P00750000', quantity: 1 },
          ],
        },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.optionSymbol)).toEqual([OCC, 'SPY260807P00750000']);
    // Both legs inherit the parent's id and create date — the reach axis is the order's.
    expect(rows.every((r) => r.id === 5)).toBe(true);
    expect(rows.every((r) => r.createDate === '2026-08-04T13:40:00.000Z')).toBe(true);
  });

  it('a flattened multileg leg reaches the resolver as a real opening record', () => {
    const rows = parseTradierOrders({
      orders: {
        order: {
          id: 900001,
          status: 'filled',
          class: 'multileg',
          symbol: 'SPY',
          create_date: '2026-08-04T13:40:00.000Z',
          leg: [{ side: 'buy_to_open', option_symbol: OCC, quantity: 1 }],
        },
      },
    });
    // Without the flattening this would read blind_no_order_record — the
    // false-negative direction, which downstream becomes a false accusation.
    expect(resolve(rows, { submitted: new Set([900001]) }).rows[0]!.verdict).toBe('engine_placed');
  });
});
