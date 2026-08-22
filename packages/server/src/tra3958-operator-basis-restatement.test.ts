/**
 * TRA-3958 — the operator restatement of an ADOPTED row's basis.
 *
 * ── What is actually being graded ───────────────────────────────────────────
 * Not "does a setter set a field". The live `BAC260925C00063000` row is managed
 * off 1.41 — the broker's average of two lots, one of which the engine already
 * closed — and every threshold is `premiumPaid × k`, so the overstatement lands
 * directly on the stop: 1.0575 against a 0.94 mark, BREACHED. At the 1.17 the
 * desk actually paid, the SAME shipped schedule gives 0.8775 and the contract
 * is held. The defect is therefore observable as an EXIT, and this file grades
 * it that way — ARM A drives the real `checkExits` and requires the sell to
 * FIRE, ARM B restates and requires it not to.
 *
 * A file that only asserted refusals would be unfalsifiable: a guard graded
 * solely in the refusing direction is indistinguishable from a guard bolted
 * onto a path that could never have fired. ARM A is the containment.
 *
 * ── PRE-REGISTERED NUMBERS (written before the first run) ──────────────────
 * From the live row (`3da6a6f8ed08`, 2026-08-22T06:27Z) and the shipped RV
 * schedule — `RV_RISK_PARAMS.slPct 0.25`, `slDollarFloor 0.10` (not binding at
 * this premium), `tp1Pct 0.40`, `trailActivatePct 0.25`:
 *
 *   basis 1.41 (the BLEND, what is live)   stop 1.0575  tp1 1.974  trail 1.7625
 *   basis 1.17 (what the desk paid)        stop 0.8775  tp1 1.638  trail 1.4625
 *   mark 0.94  ⇒ BREACHED at 1.41, ~7% of headroom at 1.17
 *
 * Those literals are the ORDER's numbers, and they are asserted. They are not
 * the only assertion, because a test that recomputes `premium − premium × slPct`
 * in its own body and compares it to the row grades a local copy against a
 * literal and agrees with itself. So the schedule is ALSO pinned by equivalence:
 * a second book that adopts the same contract at 1.17 from the start — through
 * `reconcileTradierPositions` + `handOverAdoptedOption`, never through the code
 * under test — must land on exactly the same four levels. The claim being made
 * is "the row ends where it would have been had the basis never been wrong",
 * and that is what equivalence states.
 *
 * ── Fixture provenance ─────────────────────────────────────────────────────
 * Every row here is minted by the PRODUCTION adoption path from the live
 * broker shape: one Tradier `/positions` row per OCC symbol, 1 contract,
 * `premiumPaid` = `cost_basis / quantity / 100` = the blend. `foreign` is the
 * real live `adoptionAuthority` for this row, and `resolveLiveOpenSleeve: () =>
 * null` is the FACT behind it — the fill ledger has no `buy_to_open` for the
 * desk's contract, which is exactly why no oracle on the box can price it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TradierOpenOptionPosition } from '@trading-app/engine';
import type { OptionPosition } from '@trading-app/shared';

import { PaperOptionsAccount } from './options-account.js';
import {
  configureEngineBasisRestatementLog,
  readEngineBasisRestatements,
  clearEngineBasisRestatementLogErrors,
} from './engine-basis-restatement-log.js';

const OCC = 'BAC260925C00063000';
/** The desk's fill: 2026-08-20T19:36Z, order `142769192`. Prior day, no PDT latch. */
const ACQUIRED = Date.parse('2026-08-20T19:36:00.000Z');
const GRANTED_AT = Date.parse('2026-08-22T06:27:15.918Z');

/** The blend the broker reports once the engine's own lot has been closed. */
const BLEND = 1.41;
/** What the desk paid. `live-lot-adoption.ts`: (282 − 165) / (2 − 1) = 1.17. */
const DESK = 1.17;
const MARK = 0.94;

const PROVENANCE =
  'live-lot-adoption.ts header, computed 2026-08-20 against broker order 142769192: '
  + 'BAC (282 − 165) / (2 − 1) = 1.17. CEO ruling TRA-3895 `7adbb4b1`.';

/** Pre-registered, from the order. NOT recomputed anywhere in this file. */
const STOP_AT_BLEND = 1.0575;
const TP1_AT_BLEND = 1.974;
const STOP_AT_DESK = 0.8775;
const TP1_AT_DESK = 1.638;

function brokerPayload(premiumPaid: number): TradierOpenOptionPosition[] {
  return [
    {
      optionSymbol: OCC,
      underlying: 'BAC',
      optionType: 'call',
      strike: 63,
      expiration: '2026-09-25',
      contracts: 1,
      premiumPaid,
      acquiredAt: ACQUIRED,
    },
  ];
}

const UNDERLYINGS = new Map([['BAC', 62.0]]);
const MARKS = new Map([[OCC, MARK]]);

function liveBook(overrides: Record<string, unknown> = {}): PaperOptionsAccount {
  return new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    // The factual state: this application never recorded opening this contract.
    resolveLiveOpenSleeve: () => null,
    actOnAdoptedBrokerRows: true,
    ...overrides,
  });
}

/** Adopt the broker row and hand it to the engine — the live row's history. */
function adoptedAndHandedOver(
  premiumPaid: number,
  overrides: Record<string, unknown> = {},
): { acct: PaperOptionsAccount; row: () => OptionPosition } {
  const acct = liveBook(overrides);
  const summary = acct.reconcileTradierPositions(brokerPayload(premiumPaid), 'live');
  expect(summary.added).toBe(1);
  const id = acct.getState().openOptions[0]!.id;
  const grant = acct.handOverAdoptedOption(id, 'admin', GRANTED_AT);
  expect(grant.status).toBe('granted');
  return { acct, row: () => acct.getState().openOptions.find(o => o.id === id)! };
}

function levels(o: OptionPosition): Record<string, number> {
  return {
    premiumPaid: o.premiumPaid,
    stopLossPremium: o.stopLossPremium,
    tp1Premium: o.tp1Premium,
    trailingStopPremium: o.trailingStopPremium,
  };
}

function request(over: Record<string, unknown> = {}): {
  premiumPaid: number;
  expectedPremiumPaid: number;
  provenance: string;
  apply?: boolean;
} {
  return { premiumPaid: DESK, expectedPremiumPaid: BLEND, provenance: PROVENANCE, ...over } as never;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra3958-'));
  configureEngineBasisRestatementLog(dir);
  clearEngineBasisRestatementLogErrors();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── ARM A — the control CONTAINS the condition ──────────────────────────────

describe('TRA-3958 ARM A — the blend really does sell the desk\'s contract', () => {
  it('adopts at 1.41, arms a 1.0575 stop, and the real exit path stages the sell at a 0.94 mark', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);

    // The live state, reproduced through the production path.
    expect(row().adoptionAuthority).toBe('foreign');
    expect(row().premiumPaid).toBeCloseTo(BLEND, 10);
    expect(row().stopLossPremium).toBeCloseTo(STOP_AT_BLEND, 10);
    expect(row().tp1Premium).toBeCloseTo(TP1_AT_BLEND, 10);
    expect(row().riskUnmanagedReason).toBeUndefined();

    // THE CONDITION THIS FILE EXISTS TO PREVENT. If this ever stops staging, ARM
    // B below is measuring nothing and must fail rather than quietly pass.
    const exited = acct.checkExits(UNDERLYINGS, MARKS, 'live', { waitAndHold: true });
    expect(exited).toHaveLength(1);
    expect(row().pendingExit?.kind).toBe('sl');
  });
});

// ─── ARM B — the restatement, and the exit that no longer fires ──────────────

describe('TRA-3958 ARM B — restated to the desk\'s own basis, the row is held', () => {
  it('writes 1.17 and re-derives 0.8775 / 1.638, and the same exit path stages nothing', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const id = row().id;

    const out = acct.restateAdoptedBasisFromOperator(id, request());
    expect(out.status).toBe('restated');
    if (out.status !== 'restated') throw new Error('unreachable');

    // The order's numbers.
    expect(out.before.premiumPaid).toBeCloseTo(BLEND, 10);
    expect(out.before.stopLossPremium).toBeCloseTo(STOP_AT_BLEND, 10);
    expect(out.after.premiumPaid).toBeCloseTo(DESK, 10);
    expect(out.after.stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
    expect(out.after.tp1Premium).toBeCloseTo(TP1_AT_DESK, 10);
    expect(out.armedNow).toBe(true);
    expect(out.riskUnmanagedReason).toBeNull();
    expect(out.provenance).toBe(PROVENANCE);

    // The row itself, not just the report.
    expect(row().premiumPaid).toBeCloseTo(DESK, 10);
    expect(row().stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
    expect(row().tp1Premium).toBeCloseTo(TP1_AT_DESK, 10);
    expect(row().riskUnmanagedReason).toBeUndefined();
    // A price was restated, never a size.
    expect(row().contractsRemaining ?? row().contracts).toBe(1);

    // ARM A's exit, on the corrected row: the whole point of the ticket.
    const exited = acct.checkExits(UNDERLYINGS, MARKS, 'live', { waitAndHold: true });
    expect(exited).toHaveLength(0);
    expect(row().pendingExit).toBeUndefined();
  });

  it('EQUIVALENCE — the restated row is byte-for-byte the row that never had the wrong basis', () => {
    // The independent side is built by the ADOPTION path at 1.17, so the two
    // sides of this comparison share no arithmetic written in this file.
    const virgin = adoptedAndHandedOver(DESK);
    const restated = adoptedAndHandedOver(BLEND);
    const out = restated.acct.restateAdoptedBasisFromOperator(restated.row().id, request());
    expect(out.status).toBe('restated');

    expect(levels(restated.row())).toEqual(levels(virgin.row()));
    // And the pre-registered literal agrees with both, so neither side can have
    // drifted together into a shared wrong answer.
    expect(virgin.row().stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
  });

  it('a revoked hand-over restates the NUMBER and says the row is not armed', () => {
    // The sentinel is a legitimate outcome here, and the caller must never have
    // to infer that they got a corrected basis and no stop.
    const { acct, row } = adoptedAndHandedOver(BLEND);
    expect(acct.revokeEngineHandover(row().id).status).toBe('revoked');

    const out = acct.restateAdoptedBasisFromOperator(row().id, request());
    expect(out.status).toBe('restated');
    if (out.status !== 'restated') throw new Error('unreachable');
    expect(out.armedNow).toBe(false);
    expect(out.riskUnmanagedReason).toBe('adopted_not_authorized');
    expect(row().premiumPaid).toBeCloseTo(DESK, 10);
    expect(row().stopLossPremium).toBe(0);
  });
});

// ─── The correction has to SURVIVE, and that is a separate claim ─────────────
//
// Measured on bqb1 2026-08-22T15:19Z, minutes after the first version of this
// route shipped: the write landed and read back exact (1.17 / 0.8775 / 1.638),
// and the next Tradier reconcile 30 seconds later put 1.41 straight back. An
// adopted `foreign` row takes the "premium changed ⇒ copy the broker's number"
// branch on every sweep, and for a symbol whose sibling lot has closed the
// broker's number IS the blend. Nothing in the immediate read-back can tell the
// two worlds apart — which is the whole reason these arms exist.

describe('TRA-3958 — the reconcile is what took the correction back', () => {
  it('CONTAINMENT — an unpinned adopted row really does follow the broker\'s figure', () => {
    // Without this arm every assertion below is vacuous: a reconcile that never
    // writes the basis would "hold" a pinned row by doing nothing at all.
    const { acct, row } = adoptedAndHandedOver(BLEND);
    acct.reconcileTradierPositions(brokerPayload(1.3), 'live');
    expect(row().premiumPaid).toBeCloseTo(1.3, 10);
    expect(row().stopLossPremium).toBeCloseTo(0.975, 10);
  });

  it('the pinned basis survives the sweep that used to overwrite it', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    expect(acct.restateAdoptedBasisFromOperator(row().id, request()).status).toBe('restated');

    // The broker still reports the blend, every 30 seconds, forever.
    for (let i = 0; i < 3; i += 1) acct.reconcileTradierPositions(brokerPayload(BLEND), 'live');

    expect(row().premiumPaid).toBeCloseTo(DESK, 10);
    expect(row().stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
    expect(row().tp1Premium).toBeCloseTo(TP1_AT_DESK, 10);
    // And the reader that says so: `restated: 1, holds: 0` after a sweep is a
    // correction that has already been lost.
    expect(acct.getEngineBasisRestatementCensus().operatorPin.holds).toBe(3);

    // The behavioural claim, after the sweeps: still not sold.
    expect(acct.checkExits(UNDERLYINGS, MARKS, 'live', { waitAndHold: true })).toHaveLength(0);
  });

  it('the pin rides the snapshot, so a restart does not undo the correction', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    acct.restateAdoptedBasisFromOperator(row().id, request());

    // The real durability path: export, JSON round-trip (bqb1 persists with
    // `JSON.stringify`), import into a fresh account, then reconcile.
    const snap = JSON.parse(JSON.stringify(acct.exportSnapshot()));
    const rebooted = liveBook();
    rebooted.importSnapshot(snap);
    rebooted.reconcileTradierPositions(brokerPayload(BLEND), 'live');

    const after = rebooted.getState().openOptions.find(o => o.optionSymbol === OCC)!;
    expect(after.operatorBasisPin?.premiumPaid).toBeCloseTo(DESK, 10);
    expect(after.premiumPaid).toBeCloseTo(DESK, 10);
    expect(after.stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
  });

  it('a LARGER broker lot is refused, not absorbed — the row keeps basis and size', () => {
    // A second lot means the broker's average now describes something the
    // operator never priced. Same posture as a `desk_add` lot.
    const { acct, row } = adoptedAndHandedOver(BLEND);
    acct.restateAdoptedBasisFromOperator(row().id, request());
    acct.reconcileTradierPositions(
      [{ ...brokerPayload(1.05)[0]!, contracts: 2 }],
      'live',
    );
    expect(row().premiumPaid).toBeCloseTo(DESK, 10);
    expect(row().contractsRemaining ?? row().contracts).toBe(1);
    expect(acct.getEngineBasisRestatementCensus().operatorPin.absorptionRefusals).toBe(1);
  });

  it('a SMALLER broker lot is a real partial close: quantity follows, the price does not', () => {
    const two = liveBook();
    two.reconcileTradierPositions([{ ...brokerPayload(BLEND)[0]!, contracts: 2 }], 'live');
    const id = two.getState().openOptions[0]!.id;
    expect(two.handOverAdoptedOption(id, 'admin', GRANTED_AT).status).toBe('granted');
    expect(two.restateAdoptedBasisFromOperator(id, request()).status).toBe('restated');

    two.reconcileTradierPositions(brokerPayload(BLEND), 'live'); // 1 contract left
    const row = two.getState().openOptions.find(o => o.id === id)!;
    expect(row.contractsRemaining).toBe(1);
    expect(row.premiumPaid).toBeCloseTo(DESK, 10);
    expect(row.stopLossPremium).toBeCloseTo(STOP_AT_DESK, 10);
    expect(row.operatorBasisPin?.contracts).toBe(1);
  });

  it('a pin whose row moved off the pinned figure is VOIDED, not left dormant', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    acct.restateAdoptedBasisFromOperator(row().id, request());
    // Something else moves the basis — the pin no longer describes the row.
    acct.getState(); // (read-only; the mutation below is deliberate and direct)
    const live = (acct as unknown as { openOptions: Map<string, OptionPosition> }).openOptions.get(row().id)!;
    live.premiumPaid = 1.05;

    acct.reconcileTradierPositions(brokerPayload(BLEND), 'live');
    expect(row().operatorBasisPin).toBeUndefined();
    expect(row().premiumPaid).toBeCloseTo(BLEND, 10);
    expect(acct.getEngineBasisRestatementCensus().operatorPin.releases).toBe(1);
  });
});

// ─── The negative control ────────────────────────────────────────────────────

describe('TRA-3958 — `basis_moved` is the refusal that stops a stale figure', () => {
  it('refuses when the row is not at the basis the operator says they are correcting, and changes NOTHING', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const before = levels(row());

    // The operator read the row when it said 1.30. It says 1.41.
    const out = acct.restateAdoptedBasisFromOperator(row().id, request({ expectedPremiumPaid: 1.3 }));
    expect(out.status).toBe('refused');
    if (out.status !== 'refused') throw new Error('unreachable');
    expect(out.reason).toBe('basis_moved');

    // All four levels, unchanged.
    expect(levels(row())).toEqual(before);
    expect(row().premiumPaid).toBeCloseTo(BLEND, 10);
    expect(row().stopLossPremium).toBeCloseTo(STOP_AT_BLEND, 10);

    // And nothing was written anywhere else either: no ledger line, no counter.
    expect(readEngineBasisRestatements(dir).records).toHaveLength(0);
    const census = acct.getEngineBasisRestatementCensus();
    expect(census.operatorRestated).toBe(0);
    expect(census.restated).toBe(0);
    expect(census.repaired).toBe(0);
  });
});

// ─── The rest of the refusal set ─────────────────────────────────────────────

describe('TRA-3958 — every refusal is named, and none of them writes', () => {
  it('`no_provenance` — a figure from a human with no citation is not admissible', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const before = levels(row());
    const out = acct.restateAdoptedBasisFromOperator(row().id, request({ provenance: '   ' }));
    expect(out.status === 'refused' && out.reason).toBe('no_provenance');
    expect(levels(row())).toEqual(before);
  });

  it('`unreadable_value` — a missing or non-finite figure is a stop priced off nothing', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const before = levels(row());
    for (const bad of [undefined, Number.NaN, 0, -1, '1.17']) {
      const out = acct.restateAdoptedBasisFromOperator(row().id, request({ premiumPaid: bad }));
      expect(out.status === 'refused' && out.reason).toBe('unreadable_value');
    }
    const missingExpected = acct.restateAdoptedBasisFromOperator(
      row().id,
      request({ expectedPremiumPaid: undefined }),
    );
    expect(missingExpected.status === 'refused' && missingExpected.reason).toBe('unreadable_value');
    expect(levels(row())).toEqual(before);
  });

  it('`sub_floor_premium` — says out loud that it would install the sentinel, and refuses', () => {
    // 0.30 is under RV_MIN_MARK_FLOOR (0.40), so re-deriving the schedule off it
    // takes TRA-462's path: a live row with NO stop, from a request that asked
    // for a corrected one.
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const before = levels(row());
    const out = acct.restateAdoptedBasisFromOperator(row().id, request({ premiumPaid: 0.3 }));
    expect(out.status).toBe('refused');
    if (out.status !== 'refused') throw new Error('unreachable');
    expect(out.reason).toBe('sub_floor_premium');
    expect(out.detail).toContain('sentinel');
    expect(levels(row())).toEqual(before);
    expect(row().stopLossPremium).toBeCloseTo(STOP_AT_BLEND, 10);
  });

  it('`not_adopted` — an import the ledger PROVED is ours belongs to `repair-engine-basis`', () => {
    // No hand-over here, and that is itself the point: `handOverAdoptedOption`
    // already refuses an `engine_origin` row (`status: 'engine_origin'`) because
    // it was never the human's to hand over. This route refuses it for the same
    // reason one layer along — the basis is recoverable from our own records.
    const acct = liveBook({
      // The oracle answers: this contract IS one of ours.
      resolveLiveOpenSleeve: () => 'single_leg_rv',
    });
    expect(acct.reconcileTradierPositions(brokerPayload(BLEND), 'live').added).toBe(1);
    const id = acct.getState().openOptions[0]!.id;
    const row = (): OptionPosition => acct.getState().openOptions.find(o => o.id === id)!;
    expect(row().adoptionAuthority).toBe('engine_origin');
    const before = levels(row());
    const out = acct.restateAdoptedBasisFromOperator(row().id, request({
      expectedPremiumPaid: row().premiumPaid,
    }));
    expect(out.status).toBe('refused');
    if (out.status !== 'refused') throw new Error('unreachable');
    expect(out.reason).toBe('not_adopted');
    expect(out.detail).toContain('repair-engine-basis');
    expect(levels(row())).toEqual(before);
  });

  it('`in_flight` — the pollers own a row with an exit at the broker', () => {
    // Produced by ARM A's real exit, not by hand-setting a flag.
    const { acct, row } = adoptedAndHandedOver(BLEND);
    expect(acct.checkExits(UNDERLYINGS, MARKS, 'live', { waitAndHold: true })).toHaveLength(1);
    const before = levels(row());
    const out = acct.restateAdoptedBasisFromOperator(row().id, request());
    expect(out.status === 'refused' && out.reason).toBe('in_flight');
    expect(levels(row())).toEqual(before);
  });

  it('`not_found` — an id this book does not hold', () => {
    const { acct } = adoptedAndHandedOver(BLEND);
    const out = acct.restateAdoptedBasisFromOperator('6bbc5d17-40da-4999-ab4e-f8920fe42adb', request());
    expect(out.status).toBe('not_found');
  });
});

// ─── The dry run cannot disagree with the write ──────────────────────────────

describe('TRA-3958 — dry run and write agree by construction', () => {
  it('previews the exact levels the write installs, and writes nothing while previewing', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const before = levels(row());

    const preview = acct.restateAdoptedBasisFromOperator(row().id, request({ apply: false }));
    expect(preview.status).toBe('would_restate');
    if (preview.status !== 'would_restate') throw new Error('unreachable');
    // Nothing moved, on any level, and no ledger line was cut.
    expect(levels(row())).toEqual(before);
    expect(readEngineBasisRestatements(dir).records).toHaveLength(0);
    expect(acct.getEngineBasisRestatementCensus().operatorRestated).toBe(0);

    const applied = acct.restateAdoptedBasisFromOperator(row().id, request());
    expect(applied.status).toBe('restated');
    if (applied.status !== 'restated') throw new Error('unreachable');
    // The preview claimed a schedule; the write installed one. They are equal.
    expect(applied.after).toEqual(preview.after);
    expect(applied.before).toEqual(preview.before);
    expect(applied.armedNow).toBe(preview.armedNow);
    expect(levels(row())).toEqual({ ...preview.after });
  });

  it('every refusal reads identically with and without `confirm`', () => {
    // The refusal set has ONE implementation, so this is a property of the code
    // rather than a coincidence — and this is the assertion that would catch a
    // future refactor splitting the preview off into its own function.
    const cases: Array<Record<string, unknown>> = [
      { expectedPremiumPaid: 1.3 },
      { provenance: '' },
      { premiumPaid: Number.NaN },
      { premiumPaid: 0.3 },
    ];
    for (const over of cases) {
      const dry = adoptedAndHandedOver(BLEND);
      const wet = adoptedAndHandedOver(BLEND);
      const a = dry.acct.restateAdoptedBasisFromOperator(dry.row().id, request({ ...over, apply: false }));
      const b = wet.acct.restateAdoptedBasisFromOperator(wet.row().id, request(over));
      expect(a.status).toBe('refused');
      // Same verdict, same reason, same prose — modulo the row id, which is the
      // only thing that differs between the two books.
      expect({ ...a, positionId: 'x' }).toEqual({ ...b, positionId: 'x' });
    }
  });
});

// ─── Idempotence, the census, and the durable line ───────────────────────────

describe('TRA-3958 — a second post is not a second restatement', () => {
  it('`already_correct` writes nothing and is distinct from `restated`', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    expect(acct.restateAdoptedBasisFromOperator(row().id, request()).status).toBe('restated');

    // The identical request, replayed. The row is now 1.17 and `expected` still
    // says 1.41 — the operator did not go stale, they succeeded.
    const again = acct.restateAdoptedBasisFromOperator(row().id, request());
    expect(again.status).toBe('already_correct');

    expect(acct.getEngineBasisRestatementCensus().operatorRestated).toBe(1);
    expect(readEngineBasisRestatements(dir).records).toHaveLength(1);
  });

  it('the operator\'s figure is counted apart from the sweep\'s and the repair\'s', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    acct.restateAdoptedBasisFromOperator(row().id, request());
    const census = acct.getEngineBasisRestatementCensus();
    expect(census.operatorRestated).toBe(1);
    // A human's number must never be readable as one of ours.
    expect(census.restated).toBe(0);
    expect(census.repaired).toBe(0);
  });

  it('the durable line survives a reload, carrying both sides and the citation', () => {
    const { acct, row } = adoptedAndHandedOver(BLEND);
    const id = row().id;
    acct.restateAdoptedBasisFromOperator(id, request());

    // A fresh read off disk — the process that wrote it is not consulted.
    const read = readEngineBasisRestatements(dir);
    expect(read.logPresent).toBe(true);
    expect(read.malformedLines).toBe(0);
    expect(read.appendErrors).toBe(0);
    expect(read.records).toHaveLength(1);

    const rec = read.records[0]!;
    expect(rec.source).toBe('operator_restatement');
    expect(rec.provenance).toBe(PROVENANCE);
    expect(rec.positionId).toBe(id);
    expect(rec.optionSymbol).toBe(OCC);
    expect(rec.premiumPaidBefore).toBeCloseTo(BLEND, 10);
    expect(rec.premiumPaidAfter).toBeCloseTo(DESK, 10);
    expect(rec.stopLossPremiumBefore).toBeCloseTo(STOP_AT_BLEND, 10);
    expect(rec.stopLossPremiumAfter).toBeCloseTo(STOP_AT_DESK, 10);
    expect(rec.tp1PremiumBefore).toBeCloseTo(TP1_AT_BLEND, 10);
    expect(rec.tp1PremiumAfter).toBeCloseTo(TP1_AT_DESK, 10);
    // Both halves came off the same object: a NaN here means the post-half was
    // stitched from a different row, which is the failure TRA-3010 named.
    expect(Number.isFinite(rec.premiumPaidAfter)).toBe(true);
    expect(Number.isFinite(rec.stopLossPremiumAfter)).toBe(true);
  });
});
