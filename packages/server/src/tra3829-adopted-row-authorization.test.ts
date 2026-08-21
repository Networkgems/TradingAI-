// TRA-3829 AC4 — the positive control for the adopted-row authorisation guard.
//
// ── What AC4 asks for, and why the obvious test does not satisfy it ─────────
// "Prove the guard by driving a REAL adopted row through the exit path and
// showing it is refused -- not by asserting on a spy or a synthetic fixture. A
// control that cannot produce the condition proves nothing."
//
// So this file does not hand-build an `OptionPosition` and assert that a
// predicate returns false. Every row here is minted by the PRODUCTION adoption
// path -- `PaperOptionsAccount.reconcileTradierPositions`, the same method the
// 30s live portfolio sweep and `POST /api/tradier/positions/sync` call -- from
// the actual broker payload of the six tickets the account owner placed by hand
// in Tradier's web UI on 2026-08-17 (TRA-3826 closed that attribution in
// writing, corroborated against `/v1/accounts/***0154/orders` including both
// cancels). The exit is then driven by the production `checkExits`.
//
// The control has to CONTAIN what it detects, so ARM A deliberately runs the
// engine ARMED and requires the exit to FIRE. If ARM A ever stops firing, this
// file is measuring nothing and must fail rather than quietly pass -- a guard
// graded only in the refusing direction is indistinguishable from a guard
// bolted onto a path that could never have fired anyway. That is the failure
// this project has already paid for twice (TRA-3442, TRA-3529).
//
// ── PRE-REGISTERED NUMBERS (written before the first run) ──────────────────
// Derived by hand from TRA-3826's broker facts and the shipped RV schedule
// (`RV_RISK_PARAMS.slPct = 0.25`), NOT read off a run:
//
//   PLTR260821C00180000  2 contracts  premiumPaid 1.435  (1.52 + 1.35, avg)
//     stop = 1.435 x 0.75 = 1.07625      mark 1.04  => BREACHED by 3.4%
//   SPY260821C00777000   2 contracts  premiumPaid 2.02   (2.19 + 1.85, avg)
//     stop = 2.02  x 0.75 = 1.51500      mark 1.42  => BREACHED by 6.3%
//   cost basis 287.00 + 404.00 = 691.00 USD  (= 6.91x the ratified $100 ceiling)
//
//   ARM A  (actOnAdoptedBrokerRows: true AND each row HANDED OVER by a human
//           -- board ruling B, card 331ddc56, 2026-08-21. Before the ruling this
//           arm was the pre-TRA-3829 box with the flag alone; under (b) the
//           flag alone is no longer sufficient, see ARM D.)
//     exits staged                 : 2
//     pendingExit.qty each         : 2
//     pendingExit.kind each        : 'sl'
//     adopted premium at risk      : 691.00 USD, all of it attributed to the
//                                    engine (adoptedUsd 0.00) because the arm
//                                    is what makes it the engine's to spend
//
//   ARM B  (actOnAdoptedBrokerRows: false -- the SHIPPED TRA-3829 default)
//     exits staged                 : 0
//     stopLossPremium each         : 0        (sentinel, never armed)
//     riskUnmanagedReason each     : 'adopted_not_authorized'
//     adoptedUsd                   : 691.00  (separated at the measurement layer)
//
//   ARM C  (a row adopted by the OLD build, carrying an ARMED stop, restored
//          into a NEW build through the real snapshot path)
//     exits staged                 : 0        <- the gate alone, sentinel absent
//     stopLossPremium each         : unchanged and still armed
//     byReason                     : { adopted_not_authorized: 2 }
//
// ARM C is the one that grades the GATE rather than the schedule. In ARM B the
// sentinel disarms the stop, so `checkExits` would refuse the row even with no
// guard at all -- passing ARM B alone would prove nothing about the gate. ARM C
// removes that cover: the stop is armed, the breach is real, and the ONLY thing
// standing between the row and a `sell_to_close` is the new `continue`.

import { describe, it, expect } from 'vitest';
import type { TradierOpenOptionPosition } from '@trading-app/engine';
import type { OptionPosition } from '@trading-app/shared';
import { PaperOptionsAccount, summarizeLiveStopActionability } from './options-account.js';
import { engineMayActOnAdoptedRow, hasEngineHandover } from './option-exec-flag.js';

/** Ruling B: a human hands EVERY adopted row on the book to the engine. */
function handOverAll(acct: PaperOptionsAccount, by = 'board-member'): void {
  for (const opt of acct.getState().openOptions) {
    const out = acct.handOverAdoptedOption(opt.id, by, Date.parse('2026-08-21T13:00:00.000Z'));
    expect(out.status).toBe('granted');
  }
}

/** 2026-08-17, the ET session the owner hand-traded. Prior-day, so no PDT latch. */
const PLTR_ACQUIRED = Date.parse('2026-08-17T13:46:42.898Z');
const SPY_ACQUIRED = Date.parse('2026-08-17T17:04:49.351Z');

/**
 * The two ***0154 contracts EXACTLY as Tradier's `/positions` payload reported
 * them. A broker position row is an AGGREGATE -- the four fills collapse into
 * two rows and `premiumPaid` is the volume-weighted average, which is why the
 * numbers here are 1.435 and 2.02 rather than any single ticket's price
 * (TRA-3826: count on `/orders`, never on `/positions`).
 */
function handPlacedPayload(): TradierOpenOptionPosition[] {
  return [
    {
      optionSymbol: 'PLTR260821C00180000',
      underlying: 'PLTR',
      optionType: 'call',
      strike: 180,
      expiration: '2026-08-21',
      contracts: 2,
      premiumPaid: 1.435,
      acquiredAt: PLTR_ACQUIRED,
    },
    {
      optionSymbol: 'SPY260821C00777000',
      underlying: 'SPY',
      optionType: 'call',
      strike: 777,
      expiration: '2026-08-21',
      contracts: 2,
      premiumPaid: 2.02,
      acquiredAt: SPY_ACQUIRED,
    },
  ];
}

/** The marks at which both rows sat THROUGH their stops. */
function breachedMarks(): Map<string, number> {
  return new Map([
    ['PLTR260821C00180000', 1.04],
    ['SPY260821C00777000', 1.42],
  ]);
}

const UNDERLYINGS = new Map([['PLTR', 178.0], ['SPY', 771.0]]);

/**
 * A production-env live options book.
 *
 * `resolveLiveOpenSleeve: () => null` is not a convenience: it is the FACTUAL
 * state for these two contracts. The live fee/slippage ledger has no
 * `buy_to_open` row for either, because this application did not place them --
 * that is TRA-3826's finding, and it is what makes the provenance oracle return
 * `foreign` rather than `engine`.
 */
function liveBook(overrides: Record<string, unknown> = {}): PaperOptionsAccount {
  return new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    resolveLiveOpenSleeve: () => null,
    ...overrides,
  });
}

// ─── ARM A — the control CONTAINS the condition ──────────────────────────────

describe('TRA-3829 ARM A — master arm ON and HANDED OVER: the engine really does exit', () => {
  it('stages a sell_to_close on BOTH hand-placed rows once a human hands each one over', () => {
    const acct = liveBook({ actOnAdoptedBrokerRows: true });

    // The production adoption path. Nothing else touches the book.
    const summary = acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    expect(summary.added).toBe(2);

    // Ruling B: adopted, foreign, and STILL on the sentinel until handed over --
    // even with the deployment master arm on.
    for (const opt of acct.getState().openOptions) {
      expect(opt.importedFromTradier).toBe(true);
      expect(opt.signalType).toBe('tradier_import');
      expect(opt.adoptionAuthority).toBe('foreign');
      expect(opt.stopLossPremium).toBe(0);
      expect(opt.riskUnmanagedReason).toBe('adopted_not_authorized');
    }

    // The explicit per-row opt-in. This is the only thing that changes.
    handOverAll(acct);
    for (const opt of acct.getState().openOptions) {
      expect(opt.engineHandover).toEqual({ grantedAt: '2026-08-21T13:00:00.000Z', grantedBy: 'board-member' });
      // Armed NOW, because a human said so for THIS row and the deployment allows it.
      expect(opt.stopLossPremium).toBeGreaterThan(0);
      expect(opt.riskUnmanagedReason).toBeUndefined();
    }

    // Pre-registered: 1.435 x 0.75 and 2.02 x 0.75.
    const bySym = new Map(acct.getState().openOptions.map(o => [o.optionSymbol!, o]));
    expect(bySym.get('PLTR260821C00180000')!.stopLossPremium).toBeCloseTo(1.07625, 10);
    expect(bySym.get('SPY260821C00777000')!.stopLossPremium).toBeCloseTo(1.515, 10);

    // Drive the REAL exit path, exactly as the live tick does.
    const exited = acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true });

    // THE CONDITION THIS FILE EXISTS TO DETECT. If this ever drops to 0 the
    // control is void and every refusal below becomes unfalsifiable.
    expect(exited).toHaveLength(2);
    for (const opt of acct.getState().openOptions) {
      expect(opt.pendingExit).toBeDefined();
      expect(opt.pendingExit!.kind).toBe('sl');
      expect(opt.pendingExit!.qty).toBe(2);
    }
  });
});

// ─── ARM B — the shipped default refuses, and separates at the measurement layer ─

describe('TRA-3829 ARM B — default-safe: adoption still happens, action does not', () => {
  it('adopts both rows, arms neither, and fires nothing', () => {
    // No `actOnAdoptedBrokerRows` override at all: this is the SHIPPED default,
    // resolved from an env flag that is off unless someone sets it.
    const acct = liveBook();

    const summary = acct.reconcileTradierPositions(handPlacedPayload(), 'live');

    // Adoption is NOT what was disabled. The rows are still visible and still
    // reconciled -- option (a), "visible but never actioned", not option (c).
    expect(summary.added).toBe(2);
    expect(acct.getState().openOptions).toHaveLength(2);

    for (const opt of acct.getState().openOptions) {
      expect(opt.adoptionAuthority).toBe('foreign');
      expect(opt.stopLossPremium).toBe(0);
      expect(opt.tp1Premium).toBe(Number.POSITIVE_INFINITY);
      // The label names the BINDING refusal. Not `auto_manage_off` (nobody
      // turned a user setting off) and not `provenance_unresolved` (the oracle
      // answered perfectly well -- it said "not ours").
      expect(opt.riskUnmanagedReason).toBe('adopted_not_authorized');
    }

    const exited = acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true });
    expect(exited).toHaveLength(0);
    for (const opt of acct.getState().openOptions) {
      expect(opt.pendingExit).toBeUndefined();
    }

    // VISIBLE but never actioned. `checkExits` returns before its own mark
    // write, so if this were the only mark path the rows would freeze at their
    // entry premium and "not actioned" would quietly become "not reported".
    // TRA-351's pass is what keeps them live, and it does not consult the guard.
    expect(acct.refreshImportedMarks(breachedMarks())).toBe(2);
    const marks = new Map(
      acct.getState().openOptions.map(o => [o.optionSymbol!, o.currentPremium]),
    );
    expect(marks.get('PLTR260821C00180000')).toBe(1.04);
    expect(marks.get('SPY260821C00777000')).toBe(1.42);
  });

  it('AC5 — the $691.00 is separated from engine exposure at the point of measurement', () => {
    const acct = liveBook();
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');

    const atRisk = acct.openPremiumAtRiskForMode('live');

    // The TOTAL still tells the truth about the account -- understating real
    // exposure would be the failure in the other direction.
    expect(atRisk.usd).toBeCloseTo(691.0, 2);
    expect(atRisk.rows).toBe(2);

    // ...and all of it is attributable to the human, so the engine's own figure
    // (`usd - adoptedUsd`) is 0.00. Before TRA-3829 these were the same bytes,
    // which is how $691.00 of discretionary money came to consume the engine's
    // aggregate entry budget and to land inside the ceiling TRA-3827 bounds.
    expect(atRisk.adoptedUsd).toBeCloseTo(691.0, 2);
    expect(atRisk.adoptedRows).toBe(2);
    expect(atRisk.usd - atRisk.adoptedUsd).toBeCloseTo(0, 2);
  });
});

// ─── ARM C — the gate alone, with the sentinel removed as cover ──────────────

describe('TRA-3829 ARM C — a row adopted by the OLD build keeps its armed stop and is still refused', () => {
  it('refuses an ARMED, BREACHED, foreign row restored through the real snapshot path', () => {
    // Adopt on a build that was allowed to act -- this produces rows with REAL
    // armed stops, which is what is sitting in production snapshots today.
    const oldBuild = liveBook({ actOnAdoptedBrokerRows: true });
    oldBuild.reconcileTradierPositions(handPlacedPayload(), 'live');
    handOverAll(oldBuild);
    const snapshot = oldBuild.exportSnapshot();
    // A pre-TRA-3829 snapshot carries armed stops and NO grant field. Strip the
    // grant so the restored rows are byte-for-byte what production holds today.
    for (const row of snapshot.openOptions) delete row.engineHandover;

    // Deploy the guard. Same rows, restored through the production persistence
    // path (`importSnapshot`, including its TRA-2957 threshold healing).
    const newBuild = liveBook();
    newBuild.importSnapshot(snapshot);

    // TRA-351's mark pass -- the production path that maintains `currentPremium`
    // on imported rows every doTick. It runs INDEPENDENTLY of the exit guard
    // (it was written for the "imports are user-closed only" posture in the
    // first place), which is what stops "never actioned" from degrading into
    // "never observed": the row keeps a live mark, a live P&L and a live entry
    // in the actionability summary. That is the difference between option (a)
    // and simply not looking.
    expect(newBuild.refreshImportedMarks(breachedMarks())).toBe(2);

    const restored = newBuild.getState().openOptions;
    expect(restored).toHaveLength(2);
    // The cover is genuinely absent: these stops are armed and breached.
    for (const opt of restored) {
      expect(opt.stopLossPremium).toBeGreaterThan(0);
      const mark = breachedMarks().get(opt.optionSymbol!)!;
      expect(mark).toBeLessThan(opt.stopLossPremium);
    }

    const exited = newBuild.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true });

    // Nothing but the `continue` in `checkExits` stopped this.
    expect(exited).toHaveLength(0);
    for (const opt of newBuild.getState().openOptions) {
      expect(opt.pendingExit).toBeUndefined();
    }

    // And the health route says WHY, on the same rows, via the same predicate.
    const s = summarizeLiveStopActionability(restored, {
      brokerMirroring: true,
      autoManageImportedTradierOptions: true,
      actOnAdoptedBrokerRows: false,
      holdLiveOptionsOvernightForPdt: false,
      swingHoldOptions: false,
      // TRA-3902 — window off: this call reads the wall clock, and a run that
      // happens to land inside 13:30–13:45Z must not re-attribute the gate.
      openingRangeGuardMin: 0,
    });
    expect(s.breached).toBe(2);
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ adopted_not_authorized: 2 });
  });
});

// ─── ARM D — board ruling B: two keys, per row ──────────────────────────────

describe('TRA-3829 ARM D — ruling B: the deployment flag alone is NOT a hand-over', () => {
  it('master arm ON, no grant: both rows adopted, neither armed, nothing fires', () => {
    // This is the case that separates (b) from (a)-with-a-switch. Pre-ruling
    // this configuration exited both rows (old ARM A).
    const acct = liveBook({ actOnAdoptedBrokerRows: true });
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    for (const opt of acct.getState().openOptions) {
      expect(opt.stopLossPremium).toBe(0);
      expect(opt.riskUnmanagedReason).toBe('adopted_not_authorized');
      expect(hasEngineHandover(opt)).toBe(false);
    }
    expect(acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true })).toHaveLength(0);
    // Still the human's exposure at the measurement layer.
    expect(acct.openPremiumAtRiskForMode('live').adoptedUsd).toBeCloseTo(691.0, 2);
  });

  it('grant written, master arm OFF: recorded but inert, and the method SAYS so', () => {
    const acct = liveBook();
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    const [first] = acct.getState().openOptions;
    const out = acct.handOverAdoptedOption(first!.id, 'board-member');
    expect(out.status).toBe('granted');
    if (out.status !== 'granted') return;
    expect(out.armedNow).toBe(false);
    expect(out.position.engineHandover?.grantedBy).toBe('board-member');
    expect(out.position.stopLossPremium).toBe(0);
    expect(out.position.riskUnmanagedReason).toBe('adopted_not_authorized');
    expect(acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true })).toHaveLength(0);
  });

  it('hand-over is PER ROW: granting one arms one, the other stays refused', () => {
    const acct = liveBook({ actOnAdoptedBrokerRows: true });
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    const bySym = new Map(acct.getState().openOptions.map(o => [o.optionSymbol!, o]));
    const out = acct.handOverAdoptedOption(bySym.get('PLTR260821C00180000')!.id, 'board-member');
    expect(out.status).toBe('granted');
    const exited = acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true });
    expect(exited).toHaveLength(1);
    expect(exited[0]!.optionSymbol).toBe('PLTR260821C00180000');
    const spy = acct.getState().openOptions.find(o => o.optionSymbol === 'SPY260821C00777000')!;
    expect(spy.pendingExit).toBeUndefined();
    expect(spy.riskUnmanagedReason).toBe('adopted_not_authorized');
    // A hand-over changes who may EXIT the row, not who BOUGHT it (TRA-3913:
    // exposure attribution is provenance-based and independent of this
    // predicate). Both rows stay the human's $691.00 at the measurement layer
    // even though the engine is now minding one of them.
    const atRisk = acct.openPremiumAtRiskForMode('live');
    expect(atRisk.adoptedRows).toBe(2);
    expect(atRisk.adoptedUsd).toBeCloseTo(691.0, 2);
  });

  it("idempotent: a second hand-over keeps the FIRST human's name and instant", () => {
    const acct = liveBook({ actOnAdoptedBrokerRows: true });
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    const [row] = acct.getState().openOptions;
    expect(acct.handOverAdoptedOption(row!.id, 'alice', Date.parse('2026-08-21T13:00:00Z')).status).toBe('granted');
    const again = acct.handOverAdoptedOption(row!.id, 'bob', Date.parse('2026-08-21T14:00:00Z'));
    expect(again.status).toBe('already_granted');
    expect(acct.getState().openOptions[0]!.engineHandover).toEqual({
      grantedAt: '2026-08-21T13:00:00.000Z',
      grantedBy: 'alice',
    });
  });

  it('revoke re-installs the sentinel and the predicate refuses again', () => {
    const acct = liveBook({ actOnAdoptedBrokerRows: true });
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    handOverAll(acct);
    const [row] = acct.getState().openOptions;
    expect(row!.stopLossPremium).toBeGreaterThan(0);
    const out = acct.revokeEngineHandover(row!.id);
    expect(out.status).toBe('revoked');
    const after = acct.getState().openOptions.find(o => o.id === row!.id)!;
    expect(after.engineHandover).toBeUndefined();
    expect(after.stopLossPremium).toBe(0);
    expect(after.riskUnmanagedReason).toBe('adopted_not_authorized');
    expect(acct.revokeEngineHandover(row!.id).status).toBe('not_granted');
  });

  it('refuses to hand over what is not adoptable, and a grant must be legible', () => {
    const acct = liveBook({
      actOnAdoptedBrokerRows: true,
      resolveLiveOpenSleeve: (sym: string) => (sym === 'PLTR260821C00180000' ? 'single_leg_otm' : null),
    });
    acct.reconcileTradierPositions(handPlacedPayload(), 'live');
    const bySym = new Map(acct.getState().openOptions.map(o => [o.optionSymbol!, o]));
    // Engine-origin (TRA-2820) needs no permission and must not take a grant.
    expect(acct.handOverAdoptedOption(bySym.get('PLTR260821C00180000')!.id, 'x').status).toBe('engine_origin');
    expect(acct.handOverAdoptedOption('nope', 'x').status).toBe('not_found');
    expect(acct.handOverAdoptedOption(bySym.get('SPY260821C00777000')!.id, '   ').status).toBe('bad_grantor');

    // A truthy byte is not a grant. Allow-list, not deny-list.
    const base = { importedFromTradier: true, adoptionAuthority: 'foreign', tradierEnv: 'production' };
    expect(engineMayActOnAdoptedRow({ ...base, engineHandover: { grantedAt: '2026-08-21T13:00:00Z', grantedBy: 'a' } }, true)).toBe(true);
    expect(engineMayActOnAdoptedRow({ ...base, engineHandover: { grantedAt: 'soon', grantedBy: 'a' } }, true)).toBe(false);
    expect(engineMayActOnAdoptedRow({ ...base, engineHandover: { grantedAt: '2026-08-21T13:00:00Z', grantedBy: '' } }, true)).toBe(false);
    expect(engineMayActOnAdoptedRow({ ...base, engineHandover: true as unknown as { grantedAt: string } }, true)).toBe(false);
    expect(engineMayActOnAdoptedRow({ ...base, engineHandover: { grantedAt: '2026-08-21T13:00:00Z', grantedBy: 'a' } }, false)).toBe(false);
  });
});

// ─── The guard must not widen. TRA-2820 is the regression that would hurt. ───

describe('TRA-3829 — what the guard must NOT catch', () => {
  it('an ENGINE-OPENED row re-adopted after a lost local row keeps its stops (TRA-2820)', () => {
    // The ledger DOES have a `buy_to_open` for this contract: the app placed it
    // and then lost the position row (fill poll did not terminate, or a reboot).
    // Refusing to manage this one would be TRA-2820 all over again -- 8 live
    // contracts with no stop for a session.
    const acct = liveBook({
      resolveLiveOpenSleeve: (sym: string) =>
        sym === 'PLTR260821C00180000' ? 'single_leg_otm' : null,
    });

    acct.reconcileTradierPositions(handPlacedPayload(), 'live');

    const bySym = new Map(acct.getState().openOptions.map(o => [o.optionSymbol!, o]));
    const ours = bySym.get('PLTR260821C00180000')!;
    const theirs = bySym.get('SPY260821C00777000')!;

    // Proven ours => managed, on its ORIGINATING sleeve's schedule.
    expect(ours.adoptionAuthority).toBe('engine_origin');
    expect(ours.stopLossPremium).toBeGreaterThan(0);
    expect(ours.riskUnmanagedReason).toBeUndefined();

    // Proven theirs => refused. Both rows, same sweep, same account.
    expect(theirs.adoptionAuthority).toBe('foreign');
    expect(theirs.riskUnmanagedReason).toBe('adopted_not_authorized');

    const exited = acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true });
    expect(exited).toHaveLength(1);
    expect(exited[0]!.optionSymbol).toBe('PLTR260821C00180000');
  });

  it('a SANDBOX import is untouched — TRA-323/TRA-361 served exactly that case', () => {
    // The guard is scoped on `tradierEnv`, never on `mode`: TRA-3112 item 3 --
    // an imported row's `mode` is stamped 'live' unconditionally, so a demo book
    // importing its sandbox account would be caught by a `mode` test.
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      resolveLiveOpenSleeve: () => null,
    });

    acct.reconcileTradierPositions(handPlacedPayload(), 'live');

    for (const opt of acct.getState().openOptions) {
      expect(opt.tradierEnv).toBe('sandbox');
      expect(opt.stopLossPremium).toBeGreaterThan(0);
      expect(opt.riskUnmanagedReason).toBeUndefined();
    }
    expect(acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true }))
      .toHaveLength(2);
  });

  it('a plain ENGINE-OPENED row is not an adoption and is never even asked', () => {
    const acct = liveBook();
    const engineRow: OptionPosition = {
      id: 'engine-1',
      symbol: 'PLTR',
      optionSymbol: 'PLTR260821C00180000',
      optionType: 'call',
      strike: 180,
      expiration: '2026-08-21',
      contracts: 2,
      contractsRemaining: 2,
      premiumPaid: 1.435,
      currentPremium: 1.04,
      tp1Premium: 2.1525,
      tp1Hit: false,
      stopLossPremium: 1.07625,
      peakPremium: 1.435,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: 178.5,
      openedAt: PLTR_ACQUIRED,
      signalId: 'otm-1',
      signalType: 'otm_mispricing',
      mode: 'live',
    };
    acct.importSnapshot({
      openOptions: [engineRow],
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-08-18',
      cash: 25_000,
      equity: 25_000,
    });

    expect(acct.checkExits(UNDERLYINGS, breachedMarks(), 'live', { waitAndHold: true }))
      .toHaveLength(1);
    // And it contributes nothing to the adopted split.
    expect(acct.openPremiumAtRiskForMode('live').adoptedUsd).toBe(0);
  });
});
