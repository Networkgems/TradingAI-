import { describe, it, expect } from 'vitest';
import {
  planLotAdoption,
  type LotAdoptionLedgerView,
  type LotAdoptionRowView,
} from './live-lot-adoption.js';

// TRA-3909 — the PURE planner. Every refusal below is a NEGATIVE CONTROL: the
// standing rule on this ticket tree is that a green with no failing state is not
// a reading, so each of these pins a case where the plan MUST decline and leave
// the book alone.
//
// The two positive cases are the real live book of 2026-08-20T23:38Z, arithmetic
// and all:
//
//   BAC 260925C63    engine 1 ct @ 1.65 · broker 2 ct / $282 ⇒ desk 1 ct @ 1.17
//   XLF 260925C57.5  row    2 ct @ 0.965 (BLEND) · ledger 1 ct @ 1.08 ·
//                    broker 2 ct / $193 ⇒ split to 1 @ 1.08 + desk 1 @ 0.85

const XLF = 'XLF260925C00057500';
const BAC = 'BAC260925C00063000';

function row(over: Partial<LotAdoptionRowView> = {}): LotAdoptionRowView {
  return {
    id: 'row-1',
    contracts: 1,
    premiumPaid: 1.0,
    provenance: 'engine',
    inFlight: false,
    multiLeg: false,
    coveredWrite: false,
    ...over,
  };
}

function ledger(over: Partial<LotAdoptionLedgerView> = {}): LotAdoptionLedgerView {
  const contracts = over.contracts ?? 1;
  const premiumPaid = over.premiumPaid ?? 1.0;
  return {
    contracts,
    premiumPaid,
    costBasisUsd: premiumPaid * contracts * 100,
    unpricedFills: 0,
    stoppedAtClose: false,
    ...over,
  };
}

const LIVE = { live: true };

describe('planLotAdoption — the two live defects (TRA-3909)', () => {
  it('BAC: mints the desk contract at the exact residual, 1 ct @ 1.17', () => {
    const plan = planLotAdoption(
      // Broker: 2 ct, cost basis $282 ⇒ blended 1.41 — the number TRA-3890
      // refused to write onto the engine's 1.65 row.
      { optionSymbol: BAC, contracts: 2, premiumPaid: 1.41 },
      [row({ id: 'bac-engine', contracts: 1, premiumPaid: 1.65 })],
      ledger({ contracts: 1, premiumPaid: 1.65 }),
      LIVE,
    );

    expect(plan.refusals).toEqual([]);
    // The engine row is byte-identical — TRA-3896 applied 1.65 at 23:24:11Z and
    // it has survived two restarts. Splitting it would be a regression.
    expect(plan.split).toBeNull();
    expect(plan.mint).not.toBeNull();
    expect(plan.mint!.contracts).toBe(1);
    // (282 − 165) / 1 = 1.17 — order 142769192's real fill.
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 10);
    expect(plan.mint!.residualUsd).toBeCloseTo(117, 10);
    expect(plan.brokerCostBasisUsd).toBeCloseTo(282, 10);
    expect(plan.recordedCostBasisUsd).toBeCloseTo(165, 10);
  });

  it('XLF: splits the blended row back to 1 ct @ 1.08 AND mints 1 ct @ 0.85', () => {
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: 0.965 },
      // The live row: adopted at 1, widened to 2 by the unconditional copy, and
      // repriced to the blend. `engine_origin` ⇒ provenance `engine`.
      [row({ id: 'xlf-row', contracts: 2, premiumPaid: 0.965 })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.split).toEqual({
      positionId: 'xlf-row',
      fromContracts: 2,
      toContracts: 1,
      fromPremiumPaid: 0.965,
      toPremiumPaid: 1.08,
    });
    expect(plan.mint!.contracts).toBe(1);
    // (193 − 108) / 1 = 0.85 — order 142769426's real fill.
    expect(plan.mint!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(plan.brokerCostBasisUsd).toBeCloseTo(193, 10);
  });

  it('is IDEMPOTENT: the settled shape plans nothing, on both symbols', () => {
    // XLF after one application: engine 1 @ 1.08 + desk 1 @ 0.85 = broker 2.
    const xlf = planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: 0.965 },
      [
        row({ id: 'xlf-engine', contracts: 1, premiumPaid: 1.08 }),
        row({ id: 'xlf-desk', contracts: 1, premiumPaid: 0.85, provenance: 'desk_add' }),
      ],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(xlf.split).toBeNull();
    expect(xlf.mint).toBeNull();
    expect(xlf.refusals).toEqual([]);

    const bac = planLotAdoption(
      { optionSymbol: BAC, contracts: 2, premiumPaid: 1.41 },
      [
        row({ id: 'bac-engine', contracts: 1, premiumPaid: 1.65 }),
        row({ id: 'bac-desk', contracts: 1, premiumPaid: 1.17, provenance: 'desk_add' }),
      ],
      ledger({ contracts: 1, premiumPaid: 1.65 }),
      LIVE,
    );
    expect(bac.split).toBeNull();
    expect(bac.mint).toBeNull();
    expect(bac.refusals).toEqual([]);
  });

  it('adopts a SECOND desk add on an already-split symbol, at its own residual', () => {
    // Broker now 3 ct / $310: engine 1 @ 1.08 (108) + desk 1 @ 0.85 (85) leaves
    // $117 over 1 contract ⇒ 1.17. The residual net of already-adopted lots.
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 3, premiumPaid: 310 / 3 / 100 },
      [
        row({ id: 'xlf-engine', contracts: 1, premiumPaid: 1.08 }),
        row({ id: 'xlf-desk', contracts: 1, premiumPaid: 0.85, provenance: 'desk_add' }),
      ],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.mint!.contracts).toBe(1);
    expect(plan.mint!.premiumPaid).toBeCloseTo(1.17, 6);
  });
});

describe('planLotAdoption — negative controls: every way it must REFUSE', () => {
  const engineOnly = [row({ id: 'e', contracts: 1, premiumPaid: 1.08 })];
  const broker2 = { optionSymbol: XLF, contracts: 2, premiumPaid: 0.965 };

  function reasonOf(plan: ReturnType<typeof planLotAdoption>): string | undefined {
    return plan.refusals[0]?.reason;
  }

  it('a demo book: the fill ledger records LIVE fills only', () => {
    const plan = planLotAdoption(broker2, engineOnly, null, { live: false });
    expect(reasonOf(plan)).toBe('not_live');
    expect(plan.mint).toBeNull();
  });

  it('oracle SILENT (no recorded fill) is not permission', () => {
    const plan = planLotAdoption(broker2, engineOnly, null, LIVE);
    expect(reasonOf(plan)).toBe('oracle_silent');
    expect(plan.mint).toBeNull();
    expect(plan.split).toBeNull();
  });

  it('oracle UNPRICED (`unpricedFills > 0`) — the order\'s explicit refusal', () => {
    const plan = planLotAdoption(
      broker2,
      engineOnly,
      ledger({ contracts: 1, premiumPaid: 1.08, unpricedFills: 1 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('oracle_unpriced');
    expect(plan.mint).toBeNull();
  });

  it('a truncating close makes absorption and truncation the same shape', () => {
    const plan = planLotAdoption(
      broker2,
      [row({ id: 'e', contracts: 2, premiumPaid: 0.965 })],
      ledger({ contracts: 1, premiumPaid: 1.08, stoppedAtClose: true }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('ledger_truncated_by_close');
    expect(plan.split).toBeNull();
    expect(plan.mint).toBeNull();
  });

  it('a NEGATIVE residual (desk lot priced above the whole broker basis)', () => {
    // Broker 2 ct / $100 but our own single fill cost $108 ⇒ residual −$8.
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: 0.5 },
      engineOnly,
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('residual_non_positive');
    expect(plan.mint).toBeNull();
  });

  it('`broker_ct <= engine_ct` ⇒ there is no residual to adopt', () => {
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 1, premiumPaid: 1.08 },
      engineOnly,
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('no_residual');
    expect(plan.mint).toBeNull();
  });

  it('a STANDALONE desk position stays on the TRA-3829 guarded path', () => {
    const plan = planLotAdoption(
      broker2,
      [row({ id: 'f', contracts: 2, premiumPaid: 0.9, provenance: 'foreign' })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('no_engine_row');
    expect(plan.mint).toBeNull();
  });

  it('two engine rows, or a pre-existing foreign import, is ambiguous', () => {
    expect(reasonOf(planLotAdoption(
      broker2,
      [row({ id: 'a' }), row({ id: 'b' })],
      ledger({ contracts: 2, premiumPaid: 1.0 }),
      LIVE,
    ))).toBe('group_ambiguous');

    expect(reasonOf(planLotAdoption(
      broker2,
      [row({ id: 'a' }), row({ id: 'f', provenance: 'foreign' })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    ))).toBe('group_ambiguous');
  });

  it('an exit in flight: the pollers own the basis until it resolves', () => {
    const plan = planLotAdoption(
      broker2,
      [row({ id: 'e', contracts: 1, premiumPaid: 1.08, inFlight: true })],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('in_flight');
    expect(plan.mint).toBeNull();
  });

  it('multi-leg and covered writes are not one OCC row', () => {
    expect(reasonOf(planLotAdoption(
      broker2, [row({ multiLeg: true })], ledger(), LIVE,
    ))).toBe('multi_leg');
    expect(reasonOf(planLotAdoption(
      broker2, [row({ coveredWrite: true })], ledger(), LIVE,
    ))).toBe('covered_write');
  });

  it('an unreadable broker lot cannot have its cost basis reconstructed', () => {
    expect(reasonOf(planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: Number.NaN },
      engineOnly, ledger(), LIVE,
    ))).toBe('broker_lot_unreadable');
    expect(reasonOf(planLotAdoption(
      { optionSymbol: XLF, contracts: 0, premiumPaid: 0.965 },
      engineOnly, ledger(), LIVE,
    ))).toBe('broker_lot_unreadable');
  });

  it('engine rows SHORT of the ledger, with no close to explain it', () => {
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 3, premiumPaid: 1.0 },
      [row({ id: 'e', contracts: 1, premiumPaid: 1.08 })],
      ledger({ contracts: 2, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('engine_rows_short_of_ledger');
    expect(plan.mint).toBeNull();
  });

  it('desk rows exceeding the broker: reducing them means booking a close', () => {
    const plan = planLotAdoption(
      { optionSymbol: XLF, contracts: 2, premiumPaid: 0.965 },
      [
        row({ id: 'e', contracts: 1, premiumPaid: 1.08 }),
        row({ id: 'd1', contracts: 1, premiumPaid: 0.85, provenance: 'desk_add' }),
        row({ id: 'd2', contracts: 1, premiumPaid: 0.85, provenance: 'desk_add' }),
      ],
      ledger({ contracts: 1, premiumPaid: 1.08 }),
      LIVE,
    );
    expect(reasonOf(plan)).toBe('desk_rows_exceed_broker');
    expect(plan.mint).toBeNull();
    expect(plan.split).toBeNull();
  });

  it('every refusal carries the numbers a reader needs to act on it', () => {
    const plan = planLotAdoption(broker2, engineOnly, null, LIVE);
    const r = plan.refusals[0]!;
    expect(r.optionSymbol).toBe(XLF);
    expect(r.brokerContracts).toBe(2);
    expect(r.engineContracts).toBe(1);
    expect(r.recordedContracts).toBeNull();
    expect(r.detail.length).toBeGreaterThan(20);
  });
});
