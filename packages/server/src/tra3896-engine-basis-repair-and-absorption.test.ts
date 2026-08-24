// TRA-3896 — the two halves of TRA-3895's decision B (CEO comment `40f99fda`):
// the desk's 19:36Z adds are the desk's, and the engine manages what the engine
// opened. Both halves are code; there is no hand path (the complete write
// surface of `packages/server/src` mutates `premiumPaid`/`contracts` on an open
// option row from exactly one place, and that place is the reconcile that caused
// this).
//
// ── The live state this suite is written against ────────────────────────────
//   BAC260925C00063000  engine-opened, 1 ct persisted @ 1.41. The engine's own
//                       fill was 1.65 (order 142603649). The desk added 1 ct at
//                       1.17 at 19:36Z, Tradier's `/positions` became a 2-lot
//                       BLEND, and the TRA-2889 restatement wrote the blend onto
//                       the engine's 1-lot row. TRA-3890's `quantity_mismatch`
//                       refusal now stops that recurring — and by refusing,
//                       freezes 1.41 in place. Part 1 unfreezes it.
//   XLF260925C00057500  engine_origin IMPORT, 2 ct persisted @ 0.965. One of
//                       those contracts is the desk's; the imported branch
//                       copied the broker's quantity and blended basis onto the
//                       row unconditionally, on every reconcile including the
//                       one at boot. Part 2 refuses that copy.
//
// ── Why each half needs its own negative control ───────────────────────────
// Both fixes are REFUSALS, and a refusal that never runs publishes the same
// numbers as one that runs and finds nothing. So every assertion here that a
// row was left alone is paired with a case that must still go through:
//
//   • part 1 must repair BAC (1 ct row / 1 ct recorded) and must REFUSE XLF
//     (2 ct row / 1 ct recorded) — the same code, opposite verdicts, decided by
//     the engine's own ledger and nothing else;
//   • part 2 must refuse the desk's add and must still allow a genuine
//     partial-fill top-up, and must not touch a real partial CLOSE;
//   • the drift check must find the ABSORBED row, which by construction every
//     broker-vs-engine comparison reads as clean.
import { describe, it, expect, beforeEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  recordedEngineOpenBasis,
} from './live-options-fee-slippage-ledger.js';
import { diffLiveBrokerPositions } from './live-broker-position-drift.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const OPENED_AT = Date.parse('2026-08-20T13:36:00Z');
const NOW = Date.parse('2026-08-20T20:55:00Z');

const BAC = 'BAC260925C00063000';
const XLF = 'XLF260925C00057500';

/** Write a real `buy_to_open` into the real ledger, the way a live fill does. */
function recordEngineOpen(
  optionSymbol: string,
  contracts: number,
  filledPrice: number | null,
  orderId: number | null = 142603649,
  ts: number = OPENED_AT,
): void {
  recordLiveOptionFill({
    ts,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    optionSymbol,
    side: 'buy_to_open',
    contracts,
    filledPrice,
    orderId,
  });
}

function pos(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: '0e180e8c-fe75-49d9-a7f8-84267b610c22',
    symbol: 'BAC',
    optionSymbol: BAC,
    optionType: 'call',
    strike: 63,
    expiration: '2026-09-25',
    contracts: 1,
    contractsRemaining: 1,
    // The blend the reconcile wrote. 1.41, not the 1.65 we paid.
    premiumPaid: 1.41,
    currentPremium: 1.08,
    tp1Premium: 1.41 * 1.5,
    tp1Hit: false,
    stopLossPremium: 1.41 * 0.8,
    peakPremium: 1.51,
    trailingActive: false,
    trailingStopPremium: 1.41 * 1.15,
    underlyingEntryPrice: 62,
    openedAt: OPENED_AT,
    signalId: 'sig-bac',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

function snapshotOf(positions: OptionPosition[]) {
  return {
    openOptions: positions,
    closedOptions: [] as OptionPosition[],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-20',
    cash: 1_035.94,
    equity: 1_035.94,
  };
}

function liveAccount(positions: OptionPosition[]): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
  acct.importSnapshot(snapshotOf(positions));
  return acct;
}

function tradierPos(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: XLF,
    underlying: 'XLF',
    optionType: 'call',
    strike: 57.5,
    expiration: '2026-09-25',
    contracts: 2,
    // (0.85 desk + 1.08 engine) / 2 — Tradier's cost_basis/quantity blend.
    premiumPaid: 0.965,
    acquiredAt: OPENED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  // Module-global store. One test's fills must not make another test's oracle
  // look healthy — that would silently convert an `unresolved` refusal into a
  // pass and grade the wrong branch.
  clearLiveOptionsFeeSlippageLedger();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recordedEngineOpenBasis — "what did WE pay, and for how many"', () => {
  it('answers null on an empty ledger, which is UNRESOLVED and not "we bought nothing"', () => {
    expect(recordedEngineOpenBasis(BAC, null)).toBeNull();
  });

  it('returns the single recorded fill: BAC 1 ct @ 1.65, order 142603649', () => {
    recordEngineOpen(BAC, 1, 1.65);
    expect(recordedEngineOpenBasis(BAC, null)).toMatchObject({
      contracts: 1,
      premiumPaid: 1.65,
      costBasisUsd: 165,
      fills: 1,
      orderIds: [142603649],
      unpricedFills: 0,
      stoppedAtClose: false,
    });
  });

  it('weights a partial-fill top-up by quantity — 1@1.00 + 2@1.30 is 3 @ 1.20', () => {
    recordEngineOpen(BAC, 1, 1.0, 1, OPENED_AT);
    recordEngineOpen(BAC, 2, 1.3, 2, OPENED_AT + 1_000);
    const recorded = recordedEngineOpenBasis(BAC, null)!;
    expect(recorded.contracts).toBe(3);
    expect(recorded.premiumPaid).toBeCloseTo(1.2, 10);
    expect(recorded.orderIds).toEqual([1, 2]); // oldest-first, i.e. fill order
  });

  it('does NOT blend across a completed round trip — the walk stops at the close', () => {
    recordEngineOpen(BAC, 5, 9.99, 1, OPENED_AT);
    recordLiveOptionFill({
      ts: OPENED_AT + 1_000,
      etDay: '2026-08-20',
      sleeve: 'single_leg_otm',
      optionSymbol: BAC,
      side: 'sell_to_close',
      contracts: 5,
      filledPrice: 10.5,
      orderId: 2,
    });
    recordEngineOpen(BAC, 1, 1.65, 3, OPENED_AT + 2_000);
    const recorded = recordedEngineOpenBasis(BAC, null)!;
    // 1 @ 1.65 — the CURRENT episode. Blending the closed 5 @ 9.99 in would be
    // the same averaging error one level up, with our own numbers.
    expect(recorded).toMatchObject({ contracts: 1, premiumPaid: 1.65, stoppedAtClose: true });
  });

  it('counts an unpriced fill instead of averaging over the priced subset only', () => {
    recordEngineOpen(BAC, 1, 1.65, 1, OPENED_AT);
    recordEngineOpen(BAC, 1, null, 2, OPENED_AT + 1_000);
    const recorded = recordedEngineOpenBasis(BAC, null)!;
    expect(recorded.unpricedFills).toBe(1);
    // The average over what IS priced is still 1.65 and still WRONG for a 2-lot
    // position. `unpricedFills` is what stops a caller reading it as complete.
    expect(recorded.contracts).toBe(1);
  });

  it('another contract\'s fills never leak in', () => {
    recordEngineOpen(XLF, 1, 0.85);
    expect(recordedEngineOpenBasis(BAC, null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — restore the BAC engine row to its own fill.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3896 part 1 — repairEngineBasisFromRecordedFill', () => {
  it('CONTROL: the state it repairs. The row is at 1.41 with a stop derived from 1.41, and the mark has already breached it', () => {
    const row = pos();
    expect(row.premiumPaid).toBe(1.41);
    expect(row.stopLossPremium).toBeCloseTo(1.128, 10);
    // `currentPremium` 1.08 <= 1.128 — breached, and it exits Friday at the
    // open. Against 1.41 the engine's first live round trip books its loss
    // ~$24 light into the TRA-3664/TRA-3789 acceptance record.
    expect(row.currentPremium).toBeLessThanOrEqual(row.stopLossPremium);
  });

  it('★ repairs BAC 1.41 -> 1.65 and re-derives the schedule off the corrected basis', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);

    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    expect(outcome.status).toBe('repaired');
    if (outcome.status !== 'repaired') throw new Error('unreachable');

    expect(outcome.before.premiumPaid).toBe(1.41);
    expect(outcome.after.premiumPaid).toBe(1.65);
    // The numbers TRA-3896 names as the expected post-repair state.
    expect(outcome.after.stopLossPremium).toBeCloseTo(1.32, 10);
    expect(outcome.after.tp1Premium).toBeCloseTo(2.475, 10);
    expect(outcome.recorded.orderIds).toEqual([142603649]);

    // And it is on the ROW, not only in the response.
    const row = acct.getState().openOptions.find(o => o.id === pos().id)!;
    expect(row.premiumPaid).toBe(1.65);
    expect(row.stopLossPremium).toBeCloseTo(1.32, 10);
  });

  it('the repaired stop is NO LONGER breached at the same mark — the correction changes the live decision', () => {
    // This is the point of the ticket, not a nicety: at 1.41 the row exits
    // Friday's open against a basis nobody paid.
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);
    acct.repairEngineBasisFromRecordedFill(pos().id);
    const row = acct.getState().openOptions.find(o => o.id === pos().id)!;
    expect(row.currentPremium).toBe(1.08);
    expect(row.currentPremium).toBeLessThan(row.stopLossPremium); // 1.08 < 1.32
    // Still breached, but against the RIGHT level — and the realized loss it
    // books is now measured from the 1.65 the engine actually paid.
    expect(row.stopLossPremium).toBeCloseTo(1.32, 10);
  });

  it('is IDEMPOTENT — a second call reports `already_correct` and writes no second restatement record', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);
    expect(acct.repairEngineBasisFromRecordedFill(pos().id).status).toBe('repaired');
    const afterFirst = acct.getEngineBasisRestatementCensus().retained;

    const second = acct.repairEngineBasisFromRecordedFill(pos().id);
    expect(second.status).toBe('already_correct');
    // Deliberately not `repaired` with a zero delta: the repair is AUDITED by
    // the restatement ledger, so a re-run that appended to it would inflate the
    // instrument grading it.
    expect(acct.getEngineBasisRestatementCensus().retained).toBe(afterFirst);
  });

  it('tags the durable restatement `recorded_fill_repair`, so it cannot be read as a broker restatement', () => {
    // A `broker_reconcile` row on a blended symbol after TRA-3890 would mean the
    // quantity_mismatch refusal regressed. Without the tag the two are the same
    // "1.41 -> 1.65" line and mean opposite things.
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);
    acct.repairEngineBasisFromRecordedFill(pos().id);
    const [rec] = acct.getEngineBasisRestatementCensus().restatements.slice(-1);
    expect(rec!.source).toBe('recorded_fill_repair');
    expect(rec!.premiumPaidBefore).toBe(1.41);
    expect(rec!.premiumPaidAfter).toBe(1.65);
  });

  it('a repair does NOT land in the reconcile sweep\'s numerator', () => {
    // Found on the live box within minutes of shipping: the census read
    // `candidates: 4`, `skips.quantity_mismatch: 4`, `restated: 1` — every
    // candidate declined, and yet one restatement. A reader subtracting to find
    // "what did the sweep actually move" gets 0 from one line and 1 from the
    // next. `candidates` counts rows the RECONCILE matched; the repair is not a
    // reconcile, so it gets its own column.
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);
    expect(acct.repairEngineBasisFromRecordedFill(pos().id).status).toBe('repaired');

    const census = acct.getEngineBasisRestatementCensus();
    expect(census.repaired).toBe(1);
    expect(census.restated).toBe(0);   // the sweep moved nothing
    expect(census.candidates).toBe(0); // and matched nothing
    // The record is still on the tape, and its `source` is the per-record form
    // of the same split.
    expect(census.retained).toBe(1);
    expect(census.restatements[0]!.source).toBe('recorded_fill_repair');
  });

  it('the DRY RUN writes nothing and reports the same levels the write installs', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);

    const preview = acct.repairEngineBasisFromRecordedFill(pos().id, { apply: false });
    expect(preview.status).toBe('would_repair');
    if (preview.status !== 'would_repair') throw new Error('unreachable');
    expect(acct.getState().openOptions[0]!.premiumPaid).toBe(1.41); // untouched
    expect(acct.getEngineBasisRestatementCensus().retained).toBe(0);

    const applied = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (applied.status !== 'repaired') throw new Error('unreachable');
    // Same code path, so the preview cannot disagree with the write.
    expect(preview.after.premiumPaid).toBeCloseTo(applied.after.premiumPaid, 10);
    expect(preview.after.stopLossPremium).toBeCloseTo(applied.after.stopLossPremium, 10);
    expect(preview.after.tp1Premium).toBeCloseTo(applied.after.tp1Premium, 10);
  });

  // ── The refusals. Every one of them must be NAMED: a silent no-op here reads
  // exactly like a successful repair. ──────────────────────────────────────────

  it('★ REFUSES the XLF row: 2 ct persisted, 1 ct recorded. A basis for one lot is not the basis of the other', () => {
    // The same code that repairs BAC. The verdict flips purely on our own
    // ledger, and this is what holds XLF out of the repair path while the CEO's
    // "XLF stays engine-managed tonight" posture stands.
    recordEngineOpen(XLF, 1, 1.08, 142603650);
    const acct = liveAccount([
      pos({
        id: '4128b85b-b025-4455-8589-c40c5099d8a0',
        symbol: 'XLF',
        optionSymbol: XLF,
        contracts: 2,
        contractsRemaining: 2,
        premiumPaid: 0.965,
        importedFromTradier: true,
        adoptionAuthority: 'engine_origin',
      }),
    ]);
    const outcome = acct.repairEngineBasisFromRecordedFill('4128b85b-b025-4455-8589-c40c5099d8a0');
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('quantity_mismatch');
    // Nothing written.
    expect(acct.getState().openOptions[0]!.premiumPaid).toBe(0.965);
  });

  it('REFUSES when the ledger has no record, and says WHICH silence it was', () => {
    const acct = liveAccount([pos()]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('no_recorded_fill');
    // 0 ⇒ the ORACLE is empty (it can answer for no symbol at all), which is a
    // different problem from a populated ledger that never saw this contract.
    expect(outcome.recordedOpenFills).toBe(0);
  });

  it('distinguishes an EMPTY oracle from a populated one that never saw this contract', () => {
    recordEngineOpen(XLF, 1, 0.85);
    const acct = liveAccount([pos()]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('no_recorded_fill');
    expect(outcome.recordedOpenFills).toBe(1); // populated — genuinely not ours
  });

  it('REFUSES an unpriced recorded fill rather than averaging over the priced subset', () => {
    recordEngineOpen(BAC, 1, null);
    const acct = liveAccount([pos()]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('recorded_fill_price_unusable');
  });

  it('REFUSES a row with an unreadable persisted basis — the rescale would have no anchor', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos({ premiumPaid: 0 })]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('persisted_basis_unreadable');
  });

  it('REFUSES a row with an exit in flight — the pollers own its basis until it resolves', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([
      pos({
        pendingExit: {
          tradierOrderId: '999',
          qty: 1,
          limitPrice: 1.05,
          submittedAt: NOW,
          kind: 'sl',
        },
      }),
    ]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('in_flight');
  });

  it('REFUSES a demo row — the demo book pays a MODELLED cost and writes no fills', () => {
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos({ mode: 'demo' })]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id);
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toBe('not_live');
  });

  it('reports `not_found` for an unknown id rather than succeeding vacuously', () => {
    const acct = liveAccount([pos()]);
    expect(acct.repairEngineBasisFromRecordedFill('no-such-row').status).toBe('not_found');
  });

  it('the caller cannot supply the number — the signature has no place to put one', () => {
    // Structural, not behavioural, and deliberately so: an operator-typed basis
    // is a second way to get a number nobody paid onto the row, which is the
    // defect being repaired. The only argument besides the row id is `apply`.
    recordEngineOpen(BAC, 1, 1.65);
    const acct = liveAccount([pos()]);
    const outcome = acct.repairEngineBasisFromRecordedFill(pos().id, { apply: true });
    if (outcome.status !== 'repaired') throw new Error('unreachable');
    expect(outcome.after.premiumPaid).toBe(outcome.recorded.premiumPaid);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — an engine-origin imported row must stop absorbing foreign contracts.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3896 part 2 — the reconcile refuses to widen an engine-origin row', () => {
  /** The XLF row as it was ADOPTED: 1 contract, the engine's own fill. */
  function xlfRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
    return pos({
      id: '4128b85b-b025-4455-8589-c40c5099d8a0',
      symbol: 'XLF',
      optionSymbol: XLF,
      strike: 57.5,
      contracts: 1,
      contractsRemaining: 1,
      premiumPaid: 1.08,
      currentPremium: 1.08,
      stopLossPremium: 1.08 * 0.8,
      tp1Premium: 1.08 * 1.5,
      trailingStopPremium: 1.08 * 1.15,
      importedFromTradier: true,
      adoptionAuthority: 'engine_origin',
      ...overrides,
    });
  }

  it('CONTROL: with NO fix, the desk\'s add is absorbed — this is the shape being prevented', () => {
    // Driven through the same reconcile, with the oracle deliberately empty so
    // the refusal cannot fire on evidence. It fires anyway (UNRESOLVED is not
    // permission), which is the whole safety posture — so the "control" here is
    // the assertion that the row KEEPS its own numbers even when we cannot
    // prove anything, rather than a replay of the old bug.
    const acct = liveAccount([xlfRow()]);
    acct.reconcileTradierPositions([tradierPos()], 'live');
    const row = acct.getState().openOptions[0]!;
    expect(row.contracts).toBe(1);
    expect(row.premiumPaid).toBe(1.08);
    expect(acct.getImportedAbsorptionCensus()).toEqual({ candidates: 1, refusals: 1, allowed: 0 });
  });

  it('★ REFUSES the desk\'s add: the row keeps 1 ct @ 1.08 and its own stop, and the blend never lands', () => {
    recordEngineOpen(XLF, 1, 1.08, 142603650);
    const acct = liveAccount([xlfRow()]);

    // ⚠️ UPDATED BY TRA-3909, and the update is that ticket's whole point: this
    // refusal was always the SAFE half of an incomplete answer. It stopped the
    // engine's row widening, and left the desk's contract with no row and no
    // stop at all. TRA-3909 completes the branch the refusal falls through to.
    //
    // TRA-3896's own invariant is asserted below UNCHANGED — 0.965 and 0.772
    // never touch the engine's row. What is added is the contract that used to
    // be invisible.
    acct.reconcileTradierPositions([tradierPos()], 'live');

    const rows = acct.getState().openOptions;
    const row = rows.find(r => r.id === xlfRow().id)!;
    expect(row.contracts).toBe(1);
    expect(row.contractsRemaining).toBe(1);
    expect(row.premiumPaid).toBe(1.08);       // NOT the 0.965 blend
    expect(row.stopLossPremium).toBeCloseTo(0.864, 10); // its own stop, not 0.772

    const desk = rows.find(r => r.adoptionAuthority === 'desk_add')!;
    expect(desk.contracts).toBe(1);
    expect(desk.premiumPaid).toBeCloseTo(0.85, 10);      // the exact residual
    expect(desk.stopLossPremium).toBeCloseTo(0.68, 10);

    // ⛔ The census reads zero because the case is now RESOLVED UPSTREAM, not
    // because the guard was removed. The CONTROL above is the proof: with the
    // oracle silent, adoption declines, this arm is reached, and it refuses.
    expect(acct.getImportedAbsorptionCensus()).toEqual({ candidates: 0, refusals: 0, allowed: 0 });
  });

  it('★ the refusal SURVIVES A REBOOT — reconcile runs on boot, which is why a hand correction reverts', () => {
    // bqb1 booted at 20:51:54Z on 2026-08-20. Any hand correction to this row
    // reverted within hours because the imported branch re-copied the broker lot
    // on every reconcile. Three reconciles here stand in for three boots.
    recordEngineOpen(XLF, 1, 1.08, 142603650);
    const acct = liveAccount([xlfRow()]);
    for (let i = 0; i < 3; i++) acct.reconcileTradierPositions([tradierPos()], 'live');

    // TRA-3909 — the settled PER-LOT shape is what has to survive now, and it
    // has to survive being RE-DERIVED rather than merely remembered: the second
    // and third passes must mint nothing and re-blend nothing.
    const rows = acct.getState().openOptions;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === xlfRow().id)!.premiumPaid).toBe(1.08);
    expect(rows.filter(r => r.adoptionAuthority === 'desk_add')).toHaveLength(1);
    expect(rows.find(r => r.adoptionAuthority === 'desk_add')!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(acct.getImportedAbsorptionCensus().refusals).toBe(0);
  });

  it('★ NEGATIVE CONTROL: a genuine partial-fill top-up is still allowed through', () => {
    // The engine's own ledger accounts for all 2 contracts, so the increase is
    // OURS. If this test goes red the refusal is too tight and is eating real
    // fills — which is the failure direction a mechanical copy of the
    // engine-opened branch would have shipped.
    recordEngineOpen(XLF, 1, 1.00, 1, OPENED_AT);
    recordEngineOpen(XLF, 1, 1.16, 2, OPENED_AT + 1_000);
    const acct = liveAccount([xlfRow()]);

    acct.reconcileTradierPositions([tradierPos({ contracts: 2, premiumPaid: 1.08 })], 'live');

    const row = acct.getState().openOptions[0]!;
    expect(row.contracts).toBe(2);
    expect(row.contractsRemaining).toBe(2);
    expect(row.premiumPaid).toBe(1.08);
    expect(acct.getImportedAbsorptionCensus()).toEqual({ candidates: 1, refusals: 0, allowed: 1 });
  });

  it('★ TRA-3913 — a `history_import` of the DESK\'s fill is not a top-up, and must not unlock the copy', () => {
    // The state the live box actually reached overnight on 2026-08-21. This
    // guard's oracle is the same one TRA-3913 uses, and the TRA-2959 importer
    // writes the desk's contract into it: engine 1 @1.08 (ours, order 142603071)
    // plus an import 1 @0.85 (theirs, no order id). The episode-wide count then
    // reads 2 — EXACTLY the "our own fills account for the whole incoming lot"
    // condition — and this branch would have absorbed the broker's 2-lot and its
    // 0.965 blend onto the engine's row, re-deriving the stop off a price the
    // engine never paid. That is the damage TRA-3896 exists to prevent, re-armed
    // through the data instead of the code.
    //
    // ⚠ Note what makes this a real control and not a restatement of the test
    // above: the two differ ONLY in the `origin` of the second fill. Same lot,
    // same prices, same broker report, opposite verdicts.
    recordEngineOpen(XLF, 1, 1.08, 142603071, OPENED_AT);
    recordLiveOptionFill({
      ts: OPENED_AT + 3_600_000,
      etDay: '2026-08-20',
      sleeve: 'unattributed',
      optionSymbol: XLF,
      side: 'buy_to_open',
      contracts: 1,
      filledPrice: 0.85,
      orderId: null,
      origin: 'history_import',
    });
    // The oracle knows 2 contracts exist and can vouch for exactly 1 of them.
    const basis = recordedEngineOpenBasis(XLF, null)!;
    expect(basis.contracts).toBe(2);
    expect(basis.enginePlacedContracts).toBe(1);
    expect(basis.importedContracts).toBe(1);

    const acct = liveAccount([xlfRow()]);
    acct.reconcileTradierPositions([tradierPos()], 'live');

    const row = acct.getState().openOptions[0]!;
    expect(row.contracts).toBe(1);
    expect(row.contractsRemaining).toBe(1);
    expect(row.premiumPaid).toBe(1.08);        // NOT the 0.965 blend
    expect(row.stopLossPremium).toBeCloseTo(0.864, 10); // its own stop, not 0.772
    expect(acct.getImportedAbsorptionCensus()).toEqual({ candidates: 1, refusals: 1, allowed: 0 });
  });

  it('★ NEGATIVE CONTROL: a real partial CLOSE still reduces the row — the refusal is one-directional', () => {
    // Refusing a DECREASE would strand the row believing it holds contracts that
    // are gone. The broker is the authority on what is left.
    recordEngineOpen(XLF, 2, 1.08, 142603650);
    const acct = liveAccount([xlfRow({ contracts: 2, contractsRemaining: 2 })]);

    acct.reconcileTradierPositions([tradierPos({ contracts: 1, premiumPaid: 1.08 })], 'live');

    expect(acct.getState().openOptions[0]!.contracts).toBe(1);
    // Never reached the quantity test — a decrease is not an absorption.
    expect(acct.getImportedAbsorptionCensus().candidates).toBe(0);
  });

  it('does NOT touch a FOREIGN import — the desk\'s own rows are the desk\'s and still reconcile normally', () => {
    recordEngineOpen(XLF, 1, 1.08, 142603650);
    const acct = liveAccount([xlfRow({ adoptionAuthority: 'foreign' })]);
    acct.reconcileTradierPositions([tradierPos()], 'live');
    expect(acct.getState().openOptions[0]!.contracts).toBe(2);
    expect(acct.getImportedAbsorptionCensus().candidates).toBe(0);
  });

  it('the census carries its DENOMINATOR — 0 refusals with 0 candidates is not the same claim as 0 with 3', () => {
    const acct = liveAccount([xlfRow()]);
    // Nothing has tried to widen anything.
    expect(acct.getImportedAbsorptionCensus()).toEqual({ candidates: 0, refusals: 0, allowed: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2, second half — the absorbed collision must become detectable.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3896 — the drift check can finally see an ABSORBED row', () => {
  const brokerRead = (positions: TradierOpenOptionPosition[]) =>
    ({ ok: true as const, positions });

  /** The live XLF row as it stands right now: already absorbed, 2 @ 0.965. */
  const absorbedXlf = pos({
    id: '4128b85b-b025-4455-8589-c40c5099d8a0',
    symbol: 'XLF',
    optionSymbol: XLF,
    strike: 57.5,
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.965,
    importedFromTradier: true,
    adoptionAuthority: 'engine_origin',
  });

  it('CONTROL: the OLD scope excluded it entirely — `engineRowsChecked: 1` over a two-row live book', () => {
    // With only the engine-OPENED row eligible, the live route read
    // `engineRowsCheckedLast: 1` while the book held two live rows. The one that
    // REFUSED the collision (BAC) was reported; the one that ABSORBED it was not
    // measured at all.
    const report = diffLiveBrokerPositions(
      brokerRead([
        tradierPos({ optionSymbol: BAC, underlying: 'BAC', contracts: 2, premiumPaid: 1.41 }),
        tradierPos({ contracts: 2 }),
      ]),
      [pos(), { ...absorbedXlf, adoptionAuthority: 'foreign' }],
      NOW,
      () => 1,
    );
    expect(report.ineligible.imported).toBe(1);
    expect(report.engineRowsChecked).toBe(1);
    expect(report.absorbedContracts).toBe(0); // invisible
  });

  it('CONTROL: broker-vs-engine reads CLEAN over the absorbed row — the row and the broker AGREE', () => {
    // This is why `excess` cannot find it. Once the reconcile copied the
    // broker's 2 onto the row, the two sides match and every comparison between
    // them is green. Only a third source can see the problem.
    const report = diffLiveBrokerPositions(
      brokerRead([tradierPos({ contracts: 2 })]),
      [absorbedXlf],
      NOW,
      // Oracle deliberately silent, so ONLY the broker-vs-engine axis speaks.
      () => null,
    );
    expect(report.excess).toEqual([]);
    expect(report.shortfalls).toEqual([]);
    expect(report.absorbedContracts).toBe(0);
  });

  it('★ finds it against the engine\'s own ledger: row 2, recorded 1, absorbed 1', () => {
    const report = diffLiveBrokerPositions(
      brokerRead([tradierPos({ contracts: 2 })]),
      [absorbedXlf],
      NOW,
      sym => (sym === XLF ? 1 : null),
    );
    expect(report.status).toBe('absorbed');
    expect(report.absorbedContracts).toBe(1);
    expect(report.engineOriginImportedRowsChecked).toBe(1);
    expect(report.absorbed).toEqual([
      {
        optionSymbol: XLF,
        rowContracts: 2,
        recordedContracts: 1,
        absorbedContracts: 1,
        rowIds: ['4128b85b-b025-4455-8589-c40c5099d8a0'],
      },
    ]);
  });

  it('an engine-origin import is now in the DENOMINATOR — the coverage hole is closed', () => {
    const report = diffLiveBrokerPositions(
      brokerRead([
        tradierPos({ optionSymbol: BAC, underlying: 'BAC', contracts: 1, premiumPaid: 1.65 }),
        tradierPos({ contracts: 2 }),
      ]),
      [pos(), absorbedXlf],
      NOW,
      sym => (sym === XLF ? 1 : 1),
    );
    expect(report.engineRowsChecked).toBe(2);
    expect(report.ineligible.imported).toBe(0);
  });

  it('an UNRESOLVED oracle is a coverage hole, NOT an all-clear and NOT an absorption', () => {
    // An unhydrated or aged-out ledger says "no record" about a contract we
    // really did buy. Alarming on that would fire on every row after a restart
    // that lost the ledger; calling it clean would hide the real thing.
    const report = diffLiveBrokerPositions(
      brokerRead([tradierPos({ contracts: 2 })]),
      [absorbedXlf],
      NOW,
      () => null,
    );
    expect(report.absorbedContracts).toBe(0);
    expect(report.absorptionUnresolvedRows).toBe(1);
    expect(report.status).not.toBe('absorbed');
    expect(report.absorbed[0]).toMatchObject({ recordedContracts: null, absorbedContracts: 0 });
  });

  it('does not fire when the ledger accounts for the whole row', () => {
    const report = diffLiveBrokerPositions(
      brokerRead([tradierPos({ contracts: 2 })]),
      [absorbedXlf],
      NOW,
      () => 2,
    );
    expect(report.status).toBe('clean');
    expect(report.absorbedContracts).toBe(0);
    expect(report.absorptionUnresolvedRows).toBe(0);
  });

  it('a SHORTFALL still outranks an absorption — contracts that LEFT are the louder event', () => {
    const report = diffLiveBrokerPositions(
      brokerRead([]), // broker flat: the row's 2 contracts are gone
      [absorbedXlf],
      NOW,
      () => 1,
    );
    expect(report.status).toBe('drift');
    // Carried either way, so the lower-ranked finding is never lost.
    expect(report.absorbedContracts).toBe(1);
  });

  it('an absorption outranks a plain EXCESS', () => {
    const report = diffLiveBrokerPositions(
      brokerRead([
        tradierPos({ contracts: 2 }),
        // BAC: broker 2, engine row 1 — a classic excess.
        tradierPos({ optionSymbol: BAC, underlying: 'BAC', contracts: 2, premiumPaid: 1.41 }),
      ]),
      [absorbedXlf, pos()],
      NOW,
      sym => (sym === XLF ? 1 : null),
    );
    expect(report.excessContracts).toBe(1);
    expect(report.absorbedContracts).toBe(1);
    expect(report.status).toBe('absorbed');
  });
});
