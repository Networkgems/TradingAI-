import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PaperOptionsAccount, foldOpenPremiumAtRisk, summarizeLiveUnmanagedRisk } from './options-account.js';
import { diffLiveBrokerPositions } from './live-broker-position-drift.js';
import {
  recordLiveOptionFill,
  clearLiveOptionsFeeSlippageLedger,
  recordedEngineOpenBasis,
} from './live-options-fee-slippage-ledger.js';
import { engineMayActOnAdoptedRow } from './option-exec-flag.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// TRA-3909 — the live book of 2026-08-20T23:38Z, replayed end-to-end through the
// reconcile that is the only durable write surface on an open row.
//
// Live state this is written against (`/api/health/version`
// `f3718bcee7a642df7d42600e9f244219c30479f2`, admin ***0154, `mode: live`):
//
//   | row              | book                        | basis | stop  | cur  |
//   | BAC 260925C63    | 1 ct (engine-opened)        | 1.65  | 1.32  | 1.08 |
//   | XLF 260925C57.5  | 2 ct (`importedFromTradier`)| 0.965 | 0.772 | 0.82 |
//
// Broker holds BAC 2 ct / $282 and XLF 2 ct / $193 = $475. The desk added
// BAC 1 @ 1.17 (order 142769192) and XLF 1 @ 0.85 (order 142769426) at 19:36Z.
//
// ★ The finding this whole tree is about: XLF's `currentPremium` 0.82 sits
// BETWEEN the engine leg's true stop (0.864) and the blended row's stop (0.772).
// The engine's contract is through its stop and the row reads healthy with 6%
// headroom. The assertion at the bottom of the first test is that number.

const XLF = 'XLF260925C00057500';
const BAC = 'BAC260925C00063000';
const NOW = Date.parse('2026-08-20T23:38:00Z');
const OPENED = Date.parse('2026-08-20T13:37:00Z');

function brokerRow(over: Partial<TradierOpenOptionPosition> & { optionSymbol: string }): TradierOpenOptionPosition {
  return {
    underlying: over.optionSymbol.slice(0, 3),
    optionType: 'call',
    strike: 57.5,
    expiration: '2026-09-25',
    contracts: 1,
    premiumPaid: 1,
    acquiredAt: OPENED,
    ...over,
  };
}

/** The two broker rows exactly as Tradier reported them at 23:38Z. */
const BROKER_AT_2338: TradierOpenOptionPosition[] = [
  // 2 ct, cost basis $282 ⇒ Tradier's blended `cost_basis / qty / 100` = 1.41.
  brokerRow({ optionSymbol: BAC, strike: 63, contracts: 2, premiumPaid: 1.41 }),
  // 2 ct, cost basis $193 ⇒ blended 0.965.
  brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 2, premiumPaid: 0.965 }),
];

/** The engine's OWN two fills, as its ledger recorded them at fill time. */
function seedEngineFills(): void {
  recordLiveOptionFill({
    ts: OPENED, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
    side: 'buy_to_open', contracts: 1, submittedLimit: 1.08, askAtSubmit: 1.08,
    midAtSubmit: 1.06, filledPrice: 1.08, fees: null, orderId: 142603071,
  });
  recordLiveOptionFill({
    ts: OPENED + 1000, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: BAC,
    side: 'buy_to_open', contracts: 1, submittedLimit: 1.65, askAtSubmit: 1.65,
    midAtSubmit: 1.63, filledPrice: 1.65, fees: null, orderId: 142603649,
  });
}

/**
 * The persisted live book. Written as a snapshot import rather than driven
 * through the engine, because the state under repair is a PERSISTED one: the
 * XLF row was already widened to 2 ct and repriced to the blend by the shipped
 * reconcile, and TRA-3896 proved no hand path can move it back.
 */
function liveBookSnapshot(): OptionPosition[] {
  return [
    {
      id: 'bac-engine',
      symbol: 'BAC',
      optionSymbol: BAC,
      optionType: 'call',
      strike: 63,
      expiration: '2026-09-25',
      contracts: 1,
      contractsRemaining: 1,
      // TRA-3896 part 1, applied 23:24:11Z and durable across two redeploys.
      premiumPaid: 1.65,
      currentPremium: 1.08,
      tp1Premium: 2.475,
      tp1Hit: false,
      stopLossPremium: 1.32,
      peakPremium: 1.65,
      trailingActive: false,
      trailingStopPremium: 1.65 * 1.2,
      underlyingEntryPrice: 63,
      openedAt: OPENED,
      signalId: 'sig-bac',
      signalType: 'otm_mispricing',
      mode: 'live',
      tradierEnv: 'production',
    } as OptionPosition,
    {
      id: 'xlf-row',
      symbol: 'XLF',
      optionSymbol: XLF,
      optionType: 'call',
      strike: 57.5,
      expiration: '2026-09-25',
      // ⛔ THE DEFECT: adopted at 1, widened to 2 by the unconditional copy, and
      // repriced to the broker's blend — which re-derived the stop off it.
      contracts: 2,
      contractsRemaining: 2,
      premiumPaid: 0.965,
      currentPremium: 0.82,
      tp1Premium: 1.4475,
      tp1Hit: false,
      stopLossPremium: 0.772,
      peakPremium: 1.08,
      trailingActive: false,
      trailingStopPremium: 0.965 * 1.2,
      underlyingEntryPrice: 57.5,
      openedAt: OPENED,
      signalId: `tradier-import-${XLF}`,
      signalType: 'tradier_import',
      mode: 'live',
      importedFromTradier: true,
      adoptionAuthority: 'engine_origin',
      engineOriginSleeve: 'single_leg_otm',
      tradierEnv: 'production',
    } as OptionPosition,
  ];
}

function freshAccount(): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
  acct.importSnapshot({
    openOptions: liveBookSnapshot(),
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-20',
    cash: 1_035.94,
    equity: 1_035.94,
  });
  return acct;
}

function rowsFor(acct: PaperOptionsAccount, occ: string): OptionPosition[] {
  return acct.getState().openOptions
    .filter(o => o.optionSymbol === occ)
    .sort((a, b) => b.premiumPaid - a.premiumPaid);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearLiveOptionsFeeSlippageLedger();
  seedEngineFills();
});

afterEach(() => {
  vi.useRealTimers();
  clearLiveOptionsFeeSlippageLedger();
});

describe('per-lot adoption of desk-added Tradier lots (TRA-3909)', () => {
  it('AC1 — four rows: BAC 1@1.65/1.32, BAC 1@1.17/0.936, XLF 1@1.08/0.864, XLF 1@0.85/0.68', () => {
    const acct = freshAccount();

    // Pre-state: the defect, so the assertions below are a CHANGE and not a
    // description of what was already true.
    expect(acct.getState().openOptions).toHaveLength(2);
    const xlfBefore = rowsFor(acct, XLF)[0]!;
    expect(xlfBefore.contractsRemaining).toBe(2);
    expect(xlfBefore.premiumPaid).toBeCloseTo(0.965, 10);
    // ★ The blend disarms the stop: 0.772 < currentPremium 0.82 < true 0.864.
    expect(xlfBefore.stopLossPremium).toBeLessThan(xlfBefore.currentPremium);

    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    const rows = acct.getState().openOptions;
    expect(rows).toHaveLength(4);

    const [bacEngine, bacDesk] = rowsFor(acct, BAC);
    expect(bacEngine!.contractsRemaining).toBe(1);
    // ⛔ Byte-identical: TRA-3896 applied this and it survived two restarts.
    expect(bacEngine!.premiumPaid).toBeCloseTo(1.65, 10);
    expect(bacEngine!.stopLossPremium).toBeCloseTo(1.32, 10);
    expect(bacEngine!.importedFromTradier).toBeFalsy();

    expect(bacDesk!.contractsRemaining).toBe(1);
    expect(bacDesk!.premiumPaid).toBeCloseTo(1.17, 10);
    expect(bacDesk!.stopLossPremium).toBeCloseTo(0.936, 10);
    expect(bacDesk!.adoptionAuthority).toBe('desk_add');

    const [xlfEngine, xlfDesk] = rowsFor(acct, XLF);
    expect(xlfEngine!.contractsRemaining).toBe(1);
    expect(xlfEngine!.premiumPaid).toBeCloseTo(1.08, 10);
    // ★ THE NUMBER THIS TICKET IS ABOUT. 0.864 is ABOVE the 0.82
    // `currentPremium`, so the engine's leg now reads breached — which it is.
    expect(xlfEngine!.stopLossPremium).toBeCloseTo(0.864, 10);
    expect(xlfEngine!.stopLossPremium).toBeGreaterThan(xlfEngine!.currentPremium);
    expect(xlfEngine!.adoptionAuthority).toBe('engine_origin');

    expect(xlfDesk!.contractsRemaining).toBe(1);
    expect(xlfDesk!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(xlfDesk!.stopLossPremium).toBeCloseTo(0.68, 10);
    expect(xlfDesk!.adoptionAuthority).toBe('desk_add');
  });

  it('AC1b — every adopted lot has an ARMED stop the engine may actually act on', () => {
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    for (const lot of acct.getState().openOptions.filter(o => o.adoptionAuthority === 'desk_add')) {
      expect(lot.stopLossPremium).toBeGreaterThan(0);
      expect(lot.riskUnmanagedReason).toBeUndefined();
      // ⛔ The half that would make it theatre: a stop nothing will ever fire.
      // `armed: false` is the SHIPPED default of
      // ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS, so this is the real posture.
      expect(engineMayActOnAdoptedRow(lot, false)).toBe(true);
    }

    // …and the guard is NOT widened: a standalone foreign import still refuses.
    expect(engineMayActOnAdoptedRow(
      { importedFromTradier: true, adoptionAuthority: 'foreign' }, false,
    )).toBe(false);
    expect(engineMayActOnAdoptedRow(
      { importedFromTradier: true, adoptionAuthority: 'unresolved' }, false,
    )).toBe(false);
  });

  it('AC2 — brokerPositionDrift reads clean: 0 absorbed, 0 excess', () => {
    const acct = freshAccount();

    const before = diffLiveBrokerPositions(
      { ok: true, positions: BROKER_AT_2338 },
      acct.getState().openOptions,
      NOW,
      (sym) => recordedEngineOpenBasis(sym)?.contracts ?? null,
    );
    // The state the ticket was filed against.
    expect(before.absorbedContracts).toBe(1);
    expect(before.excessContracts).toBe(1);

    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    const after = diffLiveBrokerPositions(
      { ok: true, positions: BROKER_AT_2338 },
      acct.getState().openOptions,
      NOW,
      (sym) => recordedEngineOpenBasis(sym)?.contracts ?? null,
    );
    expect(after.absorbedContracts).toBe(0);
    expect(after.excessContracts).toBe(0);
    expect(after.absorptionUnresolvedRows).toBe(0);
    expect(after.status).toBe('clean');
    expect(after.engineRowsChecked).toBe(4);
    expect(after.engineContractsChecked).toBe(4);
  });

  it('AC3 — openPremiumAtRiskUsd closes 358 → 475, the dollars really at the broker', () => {
    const acct = freshAccount();
    expect(foldOpenPremiumAtRisk(acct.getState().openOptions, false).usd).toBeCloseTo(358, 6);

    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    const fold = foldOpenPremiumAtRisk(acct.getState().openOptions, false);
    expect(fold.usd).toBeCloseTo(475, 6);
    expect(fold.rows).toBe(4);

    // ⚠️ This assertion USED to read `adoptedUsd === 0`, on the pre-TRA-3913
    // rule that `adoptedUsd` was `!engineMayActOnAdoptedRow(row)` — and
    // `desk_add` is in that allow-list, so an adopted lot fell out of the
    // column entirely. TRA-3913 landed on `main` hours after this branch was
    // cut and made attribution a DIFFERENT question from authorisation:
    // `splitEngineExposureContracts` rule 3 sends any authority that is not
    // `engine_origin` — `desk_add` included — to wholly ADOPTED.
    //
    // The new reading is the correct one and it is the one TRA-3913 was filed
    // to get. "The engine MAY EXIT this lot" and "the engine PAID for this lot"
    // are not the same claim, and only the second one may spend the entry
    // budget. So the two columns now split the book exactly along the seam this
    // ticket cut it on:
    //
    //   desk   XLF 1 @ 0.85 = $85 + BAC 1 @ 1.17 = $117 → adoptedUsd  $202
    //   engine XLF 1 @ 1.08 = $108 + BAC 1 @ 1.65 = $165 → usd-adopted $273
    //                                                       total     $475
    //
    // and $273 is what the cap reads. Before this ticket the same book gave
    // TRA-3913 a $0.00 adopted figure against $85 of real desk premium,
    // because the blend hid the desk's contract inside an `engine_origin` row.
    expect(fold.adoptedUsd).toBeCloseTo(202, 6);
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(273, 6);
    // Each desk lot is a FINDING, not an oracle refusal: the authority is known,
    // so nothing here is attributed to the desk merely because we could not ask.
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('AC4 — the route names every adopted lot AND every refusal', () => {
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.ranAt).toBe(NOW);
    expect(report.symbolsExamined).toBe(2);
    expect(report.mintedLast).toBe(2);
    expect(report.splitLast).toBe(1);
    expect(report.adopted).toHaveLength(2);

    const bac = report.adopted.find(a => a.optionSymbol === BAC)!;
    expect(bac.premiumPaid).toBeCloseTo(1.17, 10);
    expect(bac.stopLossPremium).toBeCloseTo(0.936, 10);
    expect(bac.stopArmed).toBe(true);
    expect(bac.engineMayAct).toBe(true);
    expect(bac.sleeve).toBe('single_leg_otm');

    // ⚠️ THE NEGATIVE CONTROL. A book where nothing refuses cannot prove the
    // refusal path is reachable, so make one refuse and read it back.
    const stubborn = freshAccount();
    clearLiveOptionsFeeSlippageLedger();          // the oracle goes silent
    stubborn.reconcileTradierPositions(BROKER_AT_2338, 'live');
    const refusedReport = stubborn.liveLotAdoptionReport({ brokerMirroring: true });
    expect(refusedReport.adopted).toHaveLength(0);
    expect(refusedReport.mintedLast).toBe(0);
    expect(refusedReport.refused).toHaveLength(2);
    expect(refusedReport.refused.map(r => r.reason).sort()).toEqual(['oracle_silent', 'oracle_silent']);
    // …and the book was left EXACTLY as it was found. No half-application.
    expect(stubborn.getState().openOptions).toHaveLength(2);
    expect(rowsFor(stubborn, XLF)[0]!.premiumPaid).toBeCloseTo(0.965, 10);
    // The denominator that separates "ran and found nothing" from "never ran".
    expect(refusedReport.symbolsExamined).toBe(2);
  });

  it('AC5 — the shape SURVIVES a restart, and the reconcile does not re-blend it', () => {
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');
    const snap = acct.exportSnapshot();

    // The restart.
    const rebooted = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
    rebooted.importSnapshot(snap);
    expect(rebooted.getState().openOptions).toHaveLength(4);

    // …and the BOOT reconcile, which is what reverted every hand repair before
    // this ticket. Run it three times: the pass must be idempotent, not merely
    // survivable once.
    for (let i = 0; i < 3; i++) rebooted.reconcileTradierPositions(BROKER_AT_2338, 'live');

    expect(rebooted.getState().openOptions).toHaveLength(4);
    const [xlfEngine, xlfDesk] = rowsFor(rebooted, XLF);
    expect(xlfEngine!.premiumPaid).toBeCloseTo(1.08, 10);
    expect(xlfEngine!.stopLossPremium).toBeCloseTo(0.864, 10);
    expect(xlfDesk!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(xlfDesk!.stopLossPremium).toBeCloseTo(0.68, 10);
    const [bacEngine, bacDesk] = rowsFor(rebooted, BAC);
    expect(bacEngine!.premiumPaid).toBeCloseTo(1.65, 10);
    expect(bacDesk!.premiumPaid).toBeCloseTo(1.17, 10);

    const report = rebooted.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.mintedLast).toBe(0);
    expect(report.splitLast).toBe(0);
    // Still readable: the ADOPTED half is derived from the book, so a settled
    // pass does not publish the same payload as a build without the mechanism.
    expect(report.adopted).toHaveLength(2);
    // …and the blend was refused on every one of those passes.
    expect(report.brokerCopyRefusedOnSplitSymbol).toBeGreaterThanOrEqual(6);
  });

  it('the next desk add lands as its own lot with no ticket filed', () => {
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    // The desk buys one more XLF at 0.90 ⇒ broker 3 ct / $283.
    const next = [
      brokerRow({ optionSymbol: BAC, strike: 63, contracts: 2, premiumPaid: 1.41 }),
      brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 3, premiumPaid: 283 / 3 / 100 }),
    ];
    acct.reconcileTradierPositions(next, 'live');

    const xlf = rowsFor(acct, XLF);
    expect(xlf).toHaveLength(3);
    expect(xlf.map(r => Number(r.premiumPaid.toFixed(2))).sort()).toEqual([0.85, 0.90, 1.08]);
    const newest = xlf.find(r => Math.abs(r.premiumPaid - 0.90) < 1e-6)!;
    expect(newest.stopLossPremium).toBeCloseTo(0.72, 8);
    expect(newest.adoptionAuthority).toBe('desk_add');
  });

  it('⛔ a STANDALONE desk position is still refused — TRA-3829 is not widened', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
    // No engine fill for this contract, and no engine row.
    clearLiveOptionsFeeSlippageLedger();
    const foreign = 'MSFT260925C00500000';
    acct.reconcileTradierPositions(
      [brokerRow({ optionSymbol: foreign, strike: 500, contracts: 2, premiumPaid: 3.0 })],
      'live',
    );

    const rows = acct.getState().openOptions;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adoptionAuthority).not.toBe('desk_add');
    // The TRA-3829 posture, unchanged: sentinel schedule, and it says why.
    expect(rows[0]!.stopLossPremium).toBe(0);
    expect(engineMayActOnAdoptedRow(rows[0]!, false)).toBe(false);
  });

  it('liveUnmanagedRisk can no longer publish an all-clear it has not measured', () => {
    const acct = freshAccount();
    const rows = acct.getState().openOptions;

    // The 2026-08-20T23:38Z reading: a correct `{total: 0, unexplained: 0}` over
    // a real stopless $117 BAC contract at the broker.
    const unmeasured = summarizeLiveUnmanagedRisk(rows);
    expect(unmeasured.total).toBe(0);
    expect(unmeasured.unexplained).toBe(0);
    // ⛔ NOT 0. "Not measured" and "measured and clean" must not share a value.
    expect(unmeasured.uncoveredBrokerContracts).toBeNull();

    const drift = diffLiveBrokerPositions(
      { ok: true, positions: BROKER_AT_2338 }, rows, NOW,
      (sym) => recordedEngineOpenBasis(sym)?.contracts ?? null,
    );
    const measured = summarizeLiveUnmanagedRisk(
      rows, drift.excessContracts + drift.brokerOnlyContracts,
    );
    expect(measured.uncoveredBrokerContracts).toBe(1);

    // After adoption it falls to 0 — and 0 now means something.
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');
    const after = acct.getState().openOptions;
    const driftAfter = diffLiveBrokerPositions(
      { ok: true, positions: BROKER_AT_2338 }, after, NOW,
      (sym) => recordedEngineOpenBasis(sym)?.contracts ?? null,
    );
    expect(summarizeLiveUnmanagedRisk(
      after, driftAfter.excessContracts + driftAfter.brokerOnlyContracts,
    ).uncoveredBrokerContracts).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TRA-3916 (CTO review) — ★ THE DESK LOT MUST NOT DECAY.
  //
  // `desk_add` is decided once, at mint, from "does the engine hold a row on this
  // OCC". The row outlives that evaluation: the moment the engine's sibling exits,
  // the desk lot is the ONLY row on its symbol and falls into the pre-3909
  // single-row import branch — which copies the broker's blend and calls
  // `installReconcileRiskThresholds`, which re-stamps `adoptionAuthority` from an
  // oracle (`lastRecordedOpenFill`) that does NOT stop at a `sell_to_close` and so
  // answers `engine` for any OCC we ever bought.
  //
  // ⚠️ Not a corner case: XLF's engine leg is ALREADY through its stop
  // (0.82 < 0.864 is the number this whole ticket is about), so this is the state
  // the book reaches ~30s after the deploy.
  //
  // Both probes are CTO's, reproduced against the same 23:38Z fixture.
  // ───────────────────────────────────────────────────────────────────────────

  /** Adopt, then retire the engine's XLF leg the way its stop firing would. */
  function adoptThenEngineLegExits(acct: PaperOptionsAccount): void {
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');
    const engineRow = rowsFor(acct, XLF).find(r => r.adoptionAuthority !== 'desk_add')!;
    acct.dropImportedPosition(engineRow.id);
    recordLiveOptionFill({
      ts: NOW, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'sell_to_close', contracts: 1, filledPrice: 0.86, fees: null, orderId: 142900001,
    });
  }

  it('★ PROBE 1: the engine leg exits and the broker re-prices — the lot stays `desk_add` @ 0.85/0.68', () => {
    const acct = freshAccount();
    adoptThenEngineLegExits(acct);

    // Broker now reports the symbol at average cost over what is left.
    acct.reconcileTradierPositions(
      [
        brokerRow({ optionSymbol: BAC, strike: 63, contracts: 2, premiumPaid: 1.41 }),
        brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 1, premiumPaid: 0.965 }),
      ],
      'live',
    );

    const xlf = rowsFor(acct, XLF);
    expect(xlf).toHaveLength(1);
    const desk = xlf[0]!;
    // ⛔ NOT `engine_origin`. The desk placed this contract; recording it as
    // engine-placed is false provenance, and it silently confers eligibility for
    // `isEngineManagedRow`, `stampLegacyUnmanagedRows`, both `updateConfig`
    // re-apply loops and the TRA-3896 top-up arm.
    expect(desk.adoptionAuthority).toBe('desk_add');
    // ⛔ NOT the 0.965 blend, and therefore NOT a stop of 0.772.
    expect(desk.premiumPaid).toBeCloseTo(0.85, 10);
    expect(desk.stopLossPremium).toBeCloseTo(0.68, 10);
    expect(desk.deskAddSleeve).toBe('single_leg_otm');
    // …and it is still NAMEABLE. An empty `adopted` here would read identically
    // to a build where adoption never happened.
    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.adopted.map(a => a.optionSymbol)).toContain(XLF);
  });

  it('★ PROBE 2: a SECOND desk add on a symbol the engine left is REFUSED, never absorbed', () => {
    const acct = freshAccount();
    adoptThenEngineLegExits(acct);

    // The desk buys one more: broker 2 ct @ 0.80 blended.
    acct.reconcileTradierPositions(
      [
        brokerRow({ optionSymbol: BAC, strike: 63, contracts: 2, premiumPaid: 1.41 }),
        brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 2, premiumPaid: 0.80 }),
      ],
      'live',
    );

    const xlf = rowsFor(acct, XLF);
    expect(xlf).toHaveLength(1);
    // Row completely unchanged: not widened to 2, not repriced to 0.80, not
    // relabelled, and its stop is still its own.
    expect(xlf[0]!.contractsRemaining).toBe(1);
    expect(xlf[0]!.premiumPaid).toBeCloseTo(0.85, 10);
    expect(xlf[0]!.stopLossPremium).toBeCloseTo(0.68, 10);
    expect(xlf[0]!.adoptionAuthority).toBe('desk_add');

    // Counted, and VISIBLE as a broker excess — which is what an unadopted
    // broker contract is. Deliberately not routed through the drift detector's
    // absorption arm: that arm reads the fill ledger, and a desk lot is by
    // construction absent from it.
    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.deskLotAbsorptionRefusals).toBeGreaterThanOrEqual(1);
    const drift = diffLiveBrokerPositions(
      { ok: true, positions: [brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 2, premiumPaid: 0.80 })] },
      acct.getState().openOptions.filter(o => o.optionSymbol === XLF),
      NOW,
      (sym) => recordedEngineOpenBasis(sym)?.contracts ?? null,
    );
    expect(drift.excessContracts).toBe(1);
    expect(drift.absorbedContracts).toBe(0);
  });

  it('★ a desk-side PARTIAL CLOSE is still honoured — the refusal is one-directional', () => {
    // Refusing a DECREASE would strand the row believing it holds contracts that
    // are gone. Quantity follows the broker; the basis does not move.
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');
    // Give the desk lot 2 contracts so there is something to close half of.
    const desk = rowsFor(acct, XLF).find(r => r.adoptionAuthority === 'desk_add')!;
    desk.contracts = 2;
    desk.contractsRemaining = 2;
    acct.dropImportedPosition(rowsFor(acct, XLF).find(r => r.adoptionAuthority !== 'desk_add')!.id);

    acct.reconcileTradierPositions(
      [brokerRow({ optionSymbol: XLF, strike: 57.5, contracts: 1, premiumPaid: 0.85 })],
      'live',
    );

    const after = rowsFor(acct, XLF)[0]!;
    expect(after.contractsRemaining).toBe(1);
    expect(after.premiumPaid).toBeCloseTo(0.85, 10);
    expect(after.adoptionAuthority).toBe('desk_add');
  });

  it('★ `engineMayAct` is the WHOLE walk — auto-manage off makes it read false', () => {
    const acct = freshAccount();
    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    // Broker mirror down: the stop is written but `checkExits` will never fire it.
    const noMirror = acct.liveLotAdoptionReport({ brokerMirroring: false });
    expect(noMirror.adopted.every(a => a.stopArmed)).toBe(true);
    expect(noMirror.adopted.every(a => a.engineMayAct === false)).toBe(true);
    expect(noMirror.adopted.every(a => a.exitInertReason === 'imported_no_broker_mirror')).toBe(true);
    expect(noMirror.gates.brokerMirroring).toBe(false);

    // Auto-manage off precedes it in the walk, so it wins the label.
    acct.updateConfig({ autoManageImportedTradierOptions: false });
    const noAuto = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(noAuto.adopted.every(a => a.exitInertReason === 'imported_auto_manage_off')).toBe(true);
    expect(noAuto.gates.autoManageImportedTradierOptions).toBe(false);
    // ⛔ And the toggle must not have rewritten the desk lot's schedule.
    expect(rowsFor(acct, XLF).find(r => r.adoptionAuthority === 'desk_add')!.stopLossPremium)
      .toBeCloseTo(0.68, 10);
  });

  it('⛔ places no order and closes nothing', () => {
    const acct = freshAccount();
    const closedBefore = acct.getState().closedOptions.length;
    const cashBefore = acct.getState().optionsCash;

    acct.reconcileTradierPositions(BROKER_AT_2338, 'live');

    expect(acct.getState().closedOptions).toHaveLength(closedBefore);
    // Adopted contracts are the broker's cash, never the paper bucket's.
    expect(acct.getState().optionsCash).toBe(cashBefore);
    expect(acct.getState().openOptions.every(o => !o.pendingExit)).toBe(true);
    expect(acct.getState().openOptions.every(o => o.pendingCloseOrderId === undefined)).toBe(true);
  });
});
