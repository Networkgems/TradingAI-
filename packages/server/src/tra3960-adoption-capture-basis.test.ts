import { describe, it, expect } from 'vitest';
import {
  planLotAdoption,
  priceResidualFromCapture,
  type LotAdoptionCaptureView,
  type LotAdoptionCapturedOrder,
  type LotAdoptionLedgerView,
  type LotAdoptionPlan,
  type LotAdoptionRowView,
} from './live-lot-adoption.js';

// TRA-3960 — the capture store as the basis source, and the zero-engine refusal.
//
// The hole (TRA-3958 ruling `d3c83e2c` §5): the residual's evidence expires the
// day the engine sibling closes. `/positions` folds the survivor to the AVERAGE,
// `/orders` serves today only, and the fill ledger never held a desk order. So
// (a) the capture store is consulted first for the PRICE, and (b) the identity
// refuses when its engine side is zero instead of returning the blend.
//
// Every `captureFallback` below is a NEGATIVE CONTROL: a residual-sourced mint
// beside a populated capture store must say WHY the capture declined, or the
// capture being unwired and the capture declining read identically.

const XLF = 'XLF260925C00057500';
const BAC = 'BAC260925C00063000';
const LIVE = { live: true };
// The engine opened BAC at 13:37Z on 08-20; the desk added at 19:36Z the same day.
const ENGINE_OPEN_MS = Date.parse('2026-08-20T13:37:00Z');
const DESK_FILL_MS = Date.parse('2026-08-20T19:36:00Z');

function row(over: Partial<LotAdoptionRowView> = {}): LotAdoptionRowView {
  return { id: 'row-1', contracts: 1, premiumPaid: 1.0, provenance: 'engine', inFlight: false, multiLeg: false, coveredWrite: false, ...over };
}

function ledger(over: Partial<LotAdoptionLedgerView> = {}): LotAdoptionLedgerView {
  const contracts = over.contracts ?? 1;
  const premiumPaid = over.premiumPaid ?? 1.0;
  return { contracts, premiumPaid, costBasisUsd: premiumPaid * contracts * 100, unpricedFills: 0, stoppedAtClose: false, ...over };
}

function order(over: Partial<LotAdoptionCapturedOrder> = {}): LotAdoptionCapturedOrder {
  // Order 142769192 — the desk's real BAC fill of 2026-08-20, 1 ct @ 1.17.
  return { orderId: 142769192, status: 'filled', orderClass: 'option', side: 'buy_to_open', optionSymbol: BAC, execQuantity: 1, avgFillPrice: 1.17, createMs: DESK_FILL_MS, etDay: '2026-08-20', ...over };
}

function capture(over: Partial<LotAdoptionCaptureView> = {}): LotAdoptionCaptureView {
  return { orders: [order()], attestedEtDays: ['2026-08-20'], engineOrderIds: new Set<number>([142769100]), episodeStartMs: ENGINE_OPEN_MS, ...over };
}

function reasonOf(plan: LotAdoptionPlan): string | undefined {
  return plan.refusals[0]?.reason;
}

const bacBroker = { optionSymbol: BAC, contracts: 2, premiumPaid: 1.41 };
const bacEngine = [row({ id: 'bac-engine', contracts: 1, premiumPaid: 1.65 })];
const bacLedger = ledger({ contracts: 1, premiumPaid: 1.65 });

describe('TRA-3960 — the capture store prices the lot first', () => {
  it('BAC: the desk fill from the capture (order 142769192 @ 1.17) is the basis, by id', () => {
    const plan = planLotAdoption(bacBroker, bacEngine, bacLedger, LIVE, capture());
    expect(plan.refusals).toEqual([]);
    expect(plan.mint).toMatchObject({
      contracts: 1,
      basisSource: 'capture_fill',
      captureOrderIds: [142769192],
      captureCostUsd: 117,
      captureFallback: null,
      captureAttestation: 'full',
    });
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 10);
    // The residual is still carried, so agreement is visible AS agreement.
    expect(plan.mint!.residualPremiumPaid).toBeCloseTo(1.17, 10);
  });

  it('when the two sources DISAGREE the capture wins and the residual is carried beside it', () => {
    // The broker's blend drifted: the residual says 1.20, the desk's own fill
    // says 1.17. An order id and a price beat arithmetic.
    const plan = planLotAdoption({ optionSymbol: BAC, contracts: 2, premiumPaid: 1.425 }, bacEngine, bacLedger, LIVE, capture());
    expect(plan.mint!.basisSource).toBe('capture_fill');
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 10);
    expect(plan.mint!.residualPremiumPaid).toBeCloseTo(1.2, 10);
  });

  it('two desk fills summing to the residual are priced quantity-weighted', () => {
    const plan = planLotAdoption(
      { optionSymbol: BAC, contracts: 3, premiumPaid: 1.4 },
      bacEngine,
      bacLedger,
      LIVE,
      capture({ orders: [order({ orderId: 1, avgFillPrice: 1.1 }), order({ orderId: 2, avgFillPrice: 1.3 })] }),
    );
    expect(plan.mint!.basisSource).toBe('capture_fill');
    expect(plan.mint!.contracts).toBe(2);
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.2, 10);
    expect(plan.mint!.captureOrderIds).toEqual([1, 2]);
  });

  it('the capture is scoped to the residual: an already-adopted desk row is not re-priced', () => {
    // XLF after one adoption (engine 1 @ 1.08 + desk 1 @ 0.85), then a SECOND
    // desk add. The capture holds BOTH desk fills; only the new one is the residual.
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 3, premiumPaid: 0.91 },
      [row({ id: 'e', contracts: 1, premiumPaid: 1.08 }), row({ id: 'd', contracts: 1, premiumPaid: 0.85, provenance: 'desk_add' })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
      capture({
        orders: [
          order({ orderId: 142769426, optionSymbol: XLF, avgFillPrice: 0.85 }),
          order({ orderId: 142769999, optionSymbol: XLF, avgFillPrice: 0.8, createMs: DESK_FILL_MS + 86_400_000, etDay: '2026-08-21' }),
        ],
        attestedEtDays: ['2026-08-20', '2026-08-21'],
      }),
    );
    // Two attested desk fills total 2 against a residual of 1 — the capture
    // cannot say WHICH one is the new lot, so it declines and the residual prices it.
    expect(plan.refusals).toEqual([]);
    expect(plan.mint!.contracts).toBe(1);
    expect(plan.mint!.basisSource).toBe('residual_identity');
    expect(plan.mint!.captureFallback).toBe('quantity_mismatch');
    expect(plan.mint!.premiumPaid).toBeCloseTo(0.8, 10);
  });

  it('NO capture view ⇒ the residual, and the mint SAYS the capture was never asked', () => {
    const plan = planLotAdoption(bacBroker, bacEngine, bacLedger, LIVE);
    expect(plan.mint).toMatchObject({ basisSource: 'residual_identity', captureFallback: 'capture_absent', captureOrderIds: [], captureCostUsd: null });
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 10);
  });

  it.each<[string, Partial<LotAdoptionCaptureView>, string]>([
    ["the fill is the ENGINE's own order id", { engineOrderIds: new Set([142769192]) }, 'no_desk_fill_captured'],
    ['no fill on this OCC', { orders: [order({ optionSymbol: XLF })] }, 'no_desk_fill_captured'],
    ['the order is not filled', { orders: [order({ status: 'canceled' })] }, 'no_desk_fill_captured'],
    ['the order is a sell_to_close', { orders: [order({ side: 'sell_to_close' })] }, 'no_desk_fill_captured'],
    ['the order is multileg', { orders: [order({ orderClass: 'multileg' })] }, 'no_desk_fill_captured'],
    ['the episode start is unknown (ledger not `open`)', { episodeStartMs: null }, 'episode_unknown'],
    ["the fill PREDATES the engine's episode (a desk round-trip from last week)", { orders: [order({ createMs: ENGINE_OPEN_MS - 7 * 86_400_000, etDay: '2026-08-13' })] }, 'outside_episode'],
    ['the order carries no createDate', { orders: [order({ createMs: null, etDay: null })] }, 'outside_episode'],
    ['a non-engine sell_to_close sits in the window (FIFO)', { orders: [order(), order({ orderId: 142769300, side: 'sell_to_close', createMs: DESK_FILL_MS + 60_000 })] }, 'desk_close_in_window'],
    ['the fill carries no price', { orders: [order({ avgFillPrice: null })] }, 'unpriced'],
    ['the fill carries no exec quantity', { orders: [order({ execQuantity: null })] }, 'unpriced'],
    ['the attested fills do not sum to the residual', { orders: [order({ execQuantity: 2 })] }, 'quantity_mismatch'],
  ])('declines when %s → residual identity, fallback named', (_label, over, reason) => {
    const plan = planLotAdoption(bacBroker, bacEngine, bacLedger, LIVE, capture(over));
    expect(plan.refusals).toEqual([]);
    expect(plan.mint!.basisSource).toBe('residual_identity');
    expect(plan.mint!.captureFallback).toBe(reason);
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 10);
    expect(plan.mint!.captureOrderIds).toEqual([]);
  });

  it('an UNATTESTED day is priced but STAMPED partial: attestation is legibility, not a gate', () => {
    // Measured live 2026-08-22: bqb1 boots mid-session, both captured days read
    // `partial`. Requiring `full` would decline on nearly every real day, and
    // the price does not depend on it: the residual identity already labels
    // this population `desk_add`; the capture only supplies what it paid.
    const r = priceResidualFromCapture(capture({ attestedEtDays: [] }), BAC, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.premiumPaid).toBeCloseTo(1.17, 10);
      expect(r.attestation).toBe('partial');
    }
    const plan = planLotAdoption(bacBroker, bacEngine, bacLedger, LIVE, capture({ attestedEtDays: [] }));
    expect(plan.mint!.basisSource).toBe('capture_fill');
    expect(plan.mint!.captureAttestation).toBe('partial');
  });

  it('a fill that predates the episode is NAMED in the detail, not used', () => {
    const r = priceResidualFromCapture(capture({ orders: [order({ createMs: ENGINE_OPEN_MS - 1, etDay: '2026-08-20' })] }), BAC, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('outside_episode');
      expect(r.detail).toContain('2026-08-20');
    }
  });

  it('a non-engine close BEFORE the episode does not poison the window; one INSIDE does', () => {
    const before = priceResidualFromCapture(capture({ orders: [order(), order({ orderId: 9, side: 'sell_to_close', createMs: ENGINE_OPEN_MS - 1 })] }), BAC, 1);
    expect(before.ok).toBe(true);
    const inside = priceResidualFromCapture(capture({ orders: [order(), order({ orderId: 9, side: 'sell_to_close', createMs: ENGINE_OPEN_MS + 1 })] }), BAC, 1);
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.reason).toBe('desk_close_in_window');
  });

  it("the ENGINE's own sell_to_close in the window is not a desk close (excluded by id)", () => {
    const r = priceResidualFromCapture(capture({ orders: [order(), order({ orderId: 142769100, side: 'sell_to_close', createMs: ENGINE_OPEN_MS + 1 })] }), BAC, 1);
    expect(r.ok).toBe(true);
  });

  it('a NON-POSITIVE residual is not rescued by a captured fill — an inconsistency is not a price', () => {
    const plan = planLotAdoption(
      { optionSymbol: BAC, contracts: 2, premiumPaid: 0.8 }, // $160 < engine-recorded $165
      bacEngine,
      bacLedger,
      LIVE,
      capture(),
    );
    expect(reasonOf(plan)).toBe('residual_non_positive');
    expect(plan.mint).toBeNull();
  });
});

describe('TRA-3960 — the identity REFUSES when its engine side is zero', () => {
  // The BAC shape after the engine sibling closed: the broker reports the
  // survivor at the two-lot average (1 ct @ 1.41) and the engine has nothing
  // recorded. `(141 − 0) / (1 − 0)` = 1.41 is the blend, not a residual.
  it('recorded 0 ct / $0 with an engine row present ⇒ engine_side_zero, never 1.41', () => {
    const plan = planLotAdoption(
      { optionSymbol: BAC, contracts: 1, premiumPaid: 1.41 },
      [row({ id: 'bac-row', contracts: 1, premiumPaid: 1.41 })],
      { contracts: 0, premiumPaid: 0, costBasisUsd: 0, unpricedFills: 0, stoppedAtClose: false },
      LIVE,
      // Even WITH a capture that could price the desk lot: the split side still
      // needs the engine's ledger, so nothing is derived.
      capture(),
    );
    expect(reasonOf(plan)).toBe('engine_side_zero');
    expect(plan.mint).toBeNull();
    expect(plan.split).toBeNull();
    expect(plan.refusals[0]!.detail).toContain('average');
  });

  it('engine rows holding 0 contracts ⇒ engine_side_zero', () => {
    const plan = planLotAdoption(
      { optionSymbol: BAC, contracts: 1, premiumPaid: 1.41 },
      [row({ id: 'bac-row', contracts: 0, premiumPaid: 1.65 })],
      bacLedger,
      LIVE,
    );
    expect(reasonOf(plan)).toBe('engine_side_zero');
  });

  it('recorded dollars of $0 with contracts > 0 ⇒ engine_side_zero (not oracle_unpriced)', () => {
    const plan = planLotAdoption(bacBroker, bacEngine, { contracts: 1, premiumPaid: 0, costBasisUsd: 0, unpricedFills: 0, stoppedAtClose: false }, LIVE);
    expect(reasonOf(plan)).toBe('engine_side_zero');
  });

  it('sits BEHIND no_engine_row, which still fires first on the live BAC shape (a sole foreign import)', () => {
    const plan = planLotAdoption(
      { optionSymbol: BAC, contracts: 1, premiumPaid: 1.41 },
      [row({ id: 'bac-row', contracts: 1, premiumPaid: 1.41, provenance: 'foreign' })],
      null,
      LIVE,
    );
    expect(reasonOf(plan)).toBe('no_engine_row');
  });

  it('the pre-TRA-3960 positive cases are byte-identical with no capture (BAC 1.17, XLF 1.08 + 0.85)', () => {
    const bac = planLotAdoption(bacBroker, bacEngine, bacLedger, LIVE, null);
    expect(bac.mint!.premiumPaid).toBeCloseTo(1.17, 10);
    const xlf = planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: 0.965 },
      [row({ id: 'xlf-row', contracts: 2, premiumPaid: 0.965 })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
      null,
    );
    expect(xlf.split!.toPremiumPaid).toBe(1.08);
    expect(xlf.mint!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(xlf.mint!.basisSource).toBe('residual_identity');
  });
});
