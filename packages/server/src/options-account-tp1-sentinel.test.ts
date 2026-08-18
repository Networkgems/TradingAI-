import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-2957 — `Infinity` cannot be a PERSISTED sentinel.
//
// `applyImportedRiskThresholds` writes `tp1Premium = +Infinity` to mean "never
// take profit" and `stopLossPremium = 0` to mean "never stop". Both survive in
// memory. Neither survives the snapshot: `trade-store` persists the book with
// `JSON.stringify` (:259) and reloads it with `JSON.parse` (:275), and
// `JSON.stringify(Infinity)` is the string `null`.
//
// After one round-trip the TP1 trigger `mark >= opt.tp1Premium` reads
// `mark >= null`, which ToNumber-coerces to `mark >= 0` — TRUE for every
// positive mark. The sentinel does not degrade, it INVERTS: from *never* to
// *always*.
//
// The 2026-08-05 live case, reproduced exactly. `TSLA260911C00555000`, 4
// contracts filled at 0.27 — below `RV_MIN_MARK_FLOOR` (0.40), so the import
// path took TRA-462's sub-floor sentinel. At 13:30:25Z — 25 seconds after the
// opening bell, the first tick with a mark — TP1 fired on a position trading
// BELOW its entry, staged `floor(4 × 0.5) = 2` contracts at a `null` limit that
// the submit path repriced to 0.36, and Tradier held that unfillable order
// `open` forever. `checkExits`' `if (opt.pendingExit) continue` then detached
// EVERY exit rule on the row for 5h09m (TRA-2956).
//
// A take-profit is not "slightly wrong" when it fires on a loser. It is
// inverted, and it traded.
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

/** The 08-05 TSLA contract, as Tradier reported it back to the reconcile. */
function buildTslaImport(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: 'TSLA260911C00555000',
    underlying: 'TSLA',
    optionType: 'call',
    strike: 555,
    expiration: '2026-09-11',
    contracts: 4,
    premiumPaid: 0.27,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

/**
 * The durable path, byte for byte: what `trade-store` does to the book on the
 * way to disk and back. Deliberately NOT a hand-written "pretend it was null" —
 * the whole finding is that `JSON.stringify` is the thing that does this, so the
 * test has to call it.
 */
function throughDisk(acct: PaperOptionsAccount): PaperOptionsAccount {
  const snap = acct.exportSnapshot();
  const onDisk = JSON.parse(JSON.stringify(snap)) as ReturnType<
    PaperOptionsAccount['exportSnapshot']
  >;
  const restored = new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    resolveLiveOpenSleeve: () => null,
    // TRA-3829 — armed, so the round-trip stays the subject. See the note on
    // `subFloorImportAccount` below.
    actOnAdoptedBrokerRows: true,
  });
  restored.importSnapshot(onDisk);
  return restored;
}

function subFloorImportAccount(): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    // Answers null ⇒ no ledger provenance ⇒ TRA-462's sub-floor sentinel path.
    resolveLiveOpenSleeve: () => null,
    // TRA-3829 — armed, on purpose. This file grades the TP1 SENTINEL: that
    // `+Infinity` survives a JSON round-trip as "never" rather than inverting to
    // "always". TRA-3829's authorisation guard sits ahead of the TP1 branch, so
    // on the shipped default the managed-row control could not stage its TP1 and
    // every sentinel assertion would pass without the comparison ever running —
    // a suite that is green because nothing executes. The two concerns are
    // independent; this file keeps the one it was written for.
    actOnAdoptedBrokerRows: true,
  });
  acct.reconcileTradierPositions([buildTslaImport()], 'live');
  return acct;
}

describe('TRA-2957 — the unmanaged sentinel must survive a persistence round-trip', () => {
  it('THE MECHANISM: JSON.stringify turns the +Infinity sentinel into null', () => {
    // Not a claim about our code — a claim about JSON, stated so the rest of
    // this file has a named cause rather than an assumed one.
    expect(JSON.stringify(Number.POSITIVE_INFINITY)).toBe('null');
    expect(JSON.parse(JSON.stringify({ tp1: Number.POSITIVE_INFINITY })).tp1).toBeNull();

    // And this is the comparison the pre-fix trigger performed on that value.
    // `null` ToNumber-coerces to 0, so a *take-profit* target became 0 — a
    // threshold every positive mark clears.
    const persisted = JSON.parse('{"tp1Premium":null}').tp1Premium;
    expect(0.265 >= persisted).toBe(true);
  });

  it('in memory (no round-trip) the sub-floor sentinel is the documented shape', () => {
    const opt = subFloorImportAccount().getState().openOptions[0]!;
    expect(opt.tp1Premium).toBe(Number.POSITIVE_INFINITY);
    expect(opt.stopLossPremium).toBe(0);
    expect(opt.riskUnmanagedReason).toBe('sub_floor_premium');
  });

  it('the round-trip must not silently convert "never" into a finite tradable target', () => {
    const opt = throughDisk(subFloorImportAccount()).getState().openOptions[0]!;

    // Whatever representation the fix settles on, the ONE thing that must never
    // be true is that a mark can CLEAR the restored target. Asserted in the
    // trigger's own direction (`mark >= tp1Premium`) rather than the reverse —
    // the reverse reads as a failure against the correct `+Infinity` sentinel,
    // which is how the sentinel is supposed to come back.
    // 0.265 was the live mark; 0.27 the entry; 0.355 the highest mark the row
    // ever printed.
    expect(0.265 >= opt.tp1Premium).toBe(false);
    expect(0.355 >= opt.tp1Premium).toBe(false);

    // The reason field is the durable discriminator (TRA-2820) and has to come
    // back with it, or the row reads as an ordinary managed position.
    expect(opt.riskUnmanagedReason).toBe('sub_floor_premium');
  });

  it('THE POSITIVE CONTROL: a restored sub-floor import stages NO exit on the first tick', () => {
    // Pre-registered on TRA-2957 before the fix existed: "a sub-floor import
    // that survives a full RTH open with no pendingExit staged." Pre-fix this
    // failed within 25 seconds of the bell.
    const acct = throughDisk(subFloorImportAccount());
    const opt0 = acct.getState().openOptions[0]!;

    acct.checkExits(
      new Map([['TSLA', 430]]),
      // The live mark at 13:30:25Z. Below the 0.27 entry — there is no profit
      // here to take.
      new Map([[opt0.optionSymbol!, 0.265]]),
      'live',
      { waitAndHold: true },
    );

    const opt = acct.getState().openOptions[0]!;
    expect(opt.pendingExit).toBeUndefined();
    expect(opt.tp1Hit).toBe(false);
    expect(opt.contractsRemaining).toBe(4);
  });

  it('and stages none at the row\'s all-time-high mark either — 0.355 is still a loss', () => {
    const acct = throughDisk(subFloorImportAccount());
    const opt0 = acct.getState().openOptions[0]!;

    acct.checkExits(
      new Map([['TSLA', 430]]),
      new Map([[opt0.optionSymbol!, 0.355]]),
      'live',
      { waitAndHold: true },
    );

    expect(acct.getState().openOptions[0]!.pendingExit).toBeUndefined();
  });

  it('the zero stop is equally inert after a round-trip — it must not fire either', () => {
    const acct = throughDisk(subFloorImportAccount());
    const opt0 = acct.getState().openOptions[0]!;

    // A mark in free-fall. `stopLossPremium: 0` means "no stop", so nothing
    // should close here — the row is the user's to manage, by policy.
    acct.checkExits(
      new Map([['TSLA', 380]]),
      new Map([[opt0.optionSymbol!, 0.01]]),
      'live',
      { waitAndHold: true },
    );

    const opt = acct.getState().openOptions[0]!;
    expect(opt.pendingExit).toBeUndefined();
    expect(opt.contractsRemaining).toBe(4);
  });

  it('a MANAGED row still takes its TP1 across the same round-trip (the fix is not a mute)', () => {
    // The guard must reject non-finite targets WITHOUT disarming real ones —
    // otherwise "no bogus TP1" is trivially satisfied by never taking profit.
    // 0.60 is above `RV_MIN_MARK_FLOOR`, so this import gets a real schedule.
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'production',
      resolveLiveOpenSleeve: () => null,
      // TRA-3829 — armed at ADOPTION time, not just at restore: the schedule is
      // written by `reconcileTradierPositions`, so an unarmed book here mints the
      // sentinel and there is no finite TP1 left for the round-trip to preserve.
      actOnAdoptedBrokerRows: true,
    });
    acct.reconcileTradierPositions([buildTslaImport({ premiumPaid: 0.6 })], 'live');

    const staged = throughDisk(acct);
    const opt0 = staged.getState().openOptions[0]!;
    expect(Number.isFinite(opt0.tp1Premium)).toBe(true);
    expect(opt0.tp1Premium).toBeGreaterThan(0.6);

    staged.checkExits(
      new Map([['TSLA', 460]]),
      new Map([[opt0.optionSymbol!, opt0.tp1Premium + 0.05]]),
      'live',
      { waitAndHold: true },
    );

    const opt = staged.getState().openOptions[0]!;
    expect(opt.pendingExit).toBeDefined();
    expect(opt.pendingExit!.kind).toBe('tp1');
    expect(opt.pendingExit!.qty).toBe(2);
    // And the staged limit is a real price, not a repriced null.
    expect(Number.isFinite(opt.pendingExit!.limitPrice)).toBe(true);
    expect(opt.pendingExit!.limitPrice).toBeGreaterThan(0);
  });

  it('no exit is ever staged with a non-finite or non-positive limit price', () => {
    // The backstop for whatever else learns to produce a bad threshold: an
    // untradeable limit must be refused at the staging site, not discovered by
    // the broker. A repriced `null` is how 0.36 reached Tradier on a row whose
    // mark never exceeded 0.355.
    const acct = throughDisk(subFloorImportAccount());
    const opt0 = acct.getState().openOptions[0]!;

    for (const mark of [0.01, 0.265, 0.355, 5]) {
      acct.checkExits(
        new Map([['TSLA', 430]]),
        new Map([[opt0.optionSymbol!, mark]]),
        'live',
        { waitAndHold: true },
      );
      const pending = acct.getState().openOptions[0]?.pendingExit;
      if (pending) {
        expect(Number.isFinite(pending.limitPrice)).toBe(true);
        expect(pending.limitPrice).toBeGreaterThan(0);
      }
    }
  });
});

describe('TRA-2957 — a basis restatement must not turn a disabled sentinel into a live 0', () => {
  it('rescaling a persisted (null) sentinel does not manufacture a tradable threshold', () => {
    // `restateEngineOpenedBasis` rescales thresholds by `broker / ours`, relying
    // on `Infinity × r = Infinity` and `0 × r = 0` to leave sentinels intact.
    // That identity holds in memory. Post-round-trip the value is `null`, and
    // `null × r` is **0** — the same inverted threshold by a second route.
    expect(Number.POSITIVE_INFINITY * 1.5).toBe(Number.POSITIVE_INFINITY);
    expect((null as unknown as number) * 1.5).toBe(0);

    const acct = throughDisk(subFloorImportAccount());
    // Broker restates the fill 0.27 -> 0.30 on the SAME contract.
    acct.reconcileTradierPositions([buildTslaImport({ premiumPaid: 0.3 })], 'live');

    const opt = acct.getState().openOptions[0]!;
    // Trigger direction, as above: no mark clears the target, and the stop
    // stays the inert 0 rather than becoming a level a real mark could cross.
    expect(0.355 >= opt.tp1Premium).toBe(false);
    expect(opt.stopLossPremium > 0).toBe(false);
  });
});

describe('TRA-2957 — a hand-built legacy row with a null threshold is still safe', () => {
  it('importSnapshot heals a threshold that reached disk as null', () => {
    // Rows already sitting in production snapshots carry `tp1Premium: null`
    // TODAY. The fix has to be retroactive: it cannot depend on the row having
    // been written by the corrected code.
    const legacy = {
      id: 'p-legacy',
      symbol: 'TSLA',
      optionSymbol: 'TSLA260911C00560000',
      optionType: 'call',
      contracts: 4,
      contractsRemaining: 4,
      premiumPaid: 0.27,
      currentPremium: 0.265,
      tp1Premium: null as unknown as number,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: 0.355,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: 0,
      openedAt: TRADING_TIME,
      signalId: 'tradier-import-TSLA260911C00560000',
      signalType: 'tradier_import',
      importedFromTradier: true,
      mode: 'live',
      riskUnmanagedReason: 'sub_floor_premium',
    } as unknown as OptionPosition;

    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'production',
      resolveLiveOpenSleeve: () => null,
    });
    acct.importSnapshot({
      openOptions: [legacy],
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-08-05',
      cash: 25_000,
      equity: 25_000,
    });

    acct.checkExits(
      new Map([['TSLA', 430]]),
      new Map([['TSLA260911C00560000', 0.265]]),
      'live',
      { waitAndHold: true },
    );

    expect(acct.getState().openOptions[0]!.pendingExit).toBeUndefined();
  });
});
