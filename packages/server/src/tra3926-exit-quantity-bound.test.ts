// TRA-3926 — THE ENGINE SOLD TWO CONTRACTS HAVING BOUGHT ONE, ON REAL MONEY.
//
// 2026-08-21T13:48:04Z, production account ***0154, order 142806015. The tape,
// verbatim from `/api/health/live-options-fee-slippage` -> `records[]`:
//
//     08-20 13:35:30Z  buy_to_open   ct=1  @1.08  origin=fill            oid=142603071
//     08-20 17:00:00Z  buy_to_open   ct=1  @0.85  origin=history_import  oid=null
//     08-21 13:48:04Z  sell_to_close ct=2  @1.01  origin=fill            oid=142806015
//
// One engine buy, one DESK buy, one two-contract ENGINE sell. `maxContracts` is
// 1, so no engine entry can open a 2-lot, and there is no second XLF
// `buy_to_open` order id anywhere in the tape. The pre-TRA-3896 reconcile had
// widened the engine's row onto the broker's whole lot of 2 and the exit path
// took its quantity from the row's `contracts`.
//
// ── What each arm of this file is for ──────────────────────────────────────
// AC3 and AC4 are worth nothing apart (TRA-3913's own lesson, earned on the
// READER two days earlier): a predicate that is just `importedFromTradier`
// wearing a new name passes AC3 and fails AC4, and the pre-fix code does the
// reverse. So every refusal here is paired with a genuine 2-lot on the SAME
// fixture, differing ONLY in what the tape accounts for.
//
//   AC1/AC3 — the widened row stages ONE contract, not two.
//   AC4     — a real engine 2-lot (both contracts recorded as ours) stages TWO.
//             Without this the fix is "always exit 1" wearing a new name.
//   AC2     — a row the oracle cannot answer for reads BLIND and is COUNTED.
//             ⚠ NOT "exits nothing" — see the note above that describe block.
//   AC5     — the detector fires on the exact tape above, and stays silent on
//             the desk closing its own leg.
//   RULING B — an explicitly handed-over row still exits in full. That grant is
//             the board's answer to the transaction question and this fix must
//             not narrow it.
import { describe, it, expect, beforeEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';
import { boundExitContractsToEngineShare } from './option-exec-flag.js';
import { detectOversoldEngineCloses } from './tra3926-oversold-close-detector.js';
import type { OptionPosition } from '@trading-app/shared';

const XLF = 'XLF260925C00057500';
const OPENED_AT = Date.parse('2026-08-20T13:35:30Z');
const DESK_AT = Date.parse('2026-08-20T17:00:00Z');
const CLOSED_AT = Date.parse('2026-08-21T13:48:04Z');

/** The engine's own fill: through our chokepoint, so `origin: 'fill'` + an order id. */
function recordEngineOpen(
  contracts: number,
  filledPrice: number,
  orderId: number,
  ts: number = OPENED_AT,
): void {
  recordLiveOptionFill({
    ts,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    optionSymbol: XLF,
    side: 'buy_to_open',
    contracts,
    filledPrice,
    orderId,
  });
}

/**
 * The reconcile's reconstruction of a fill NO chokepoint of ours recorded
 * (TRA-2959): the broker's price, `orderId: null`, `sleeve: 'unattributed'`.
 * This is what the importer wrote for the DESK's contract overnight, and it is
 * the row that un-fixed TRA-3913 with no deploy.
 */
function recordDeskImport(
  contracts: number,
  filledPrice: number,
  ts: number = DESK_AT,
  side: 'buy_to_open' | 'sell_to_close' = 'buy_to_open',
): void {
  recordLiveOptionFill({
    ts,
    etDay: '2026-08-20',
    sleeve: 'unattributed',
    optionSymbol: XLF,
    side,
    contracts,
    filledPrice,
    orderId: null,
    origin: 'history_import',
  });
}

/**
 * The live row as it stood at 13:48:04Z: `engine_origin`, IMPORTED, 2 contracts
 * at the broker's blend of (1.08 + 0.85) / 2 = 0.965 EXACTLY. Its stop sits
 * above the mark the test feeds, so the SL/trail staging site fires.
 */
function widenedRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'xlf-widened',
    symbol: 'XLF',
    optionSymbol: XLF,
    optionType: 'call',
    strike: 57.5,
    expiration: '2026-09-25',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.965,
    currentPremium: 1.01,
    tp1Premium: 0.965 * 1.5,
    tp1Hit: false,
    stopLossPremium: 0.965 * 0.8,
    peakPremium: 1.2,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 57,
    openedAt: OPENED_AT,
    signalId: 'sig-xlf',
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    importedFromTradier: true,
    adoptionAuthority: 'engine_origin',
    engineOriginSleeve: 'single_leg_otm',
    ...overrides,
  };
}

function liveBook(row: OptionPosition, overrides: Record<string, unknown> = {}): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    autoManageImportedTradierOptions: true,
    ...overrides,
  });
  acct.importSnapshot({
    openOptions: [row],
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-21',
    cash: 1_035.94,
    equity: 1_035.94,
  });
  return acct;
}

/** A mark THROUGH the stop, so the SL branch fires on this tick. */
const BREACHED = new Map([[XLF, 0.5]]);
const UNDERLYINGS = new Map([['XLF', 55.0]]);

/** Drive the REAL live exit path, exactly as the tick does. */
function tick(acct: PaperOptionsAccount): OptionPosition[] {
  return acct.checkExits(UNDERLYINGS, BREACHED, 'live', { waitAndHold: true });
}

/**
 * The 2026-08-21 tape as the oracle reports it: ONE engine-placed contract,
 * ONE imported. A COMPLETE positive answer, which is what lets the bound bind —
 * see the AC2 note on why an oracle that REFUSES cannot.
 */
function partialOracle() {
  return {
    contracts: 2,
    premiumPaid: 0.965,
    unpricedFills: 0,
    enginePlacedContracts: 1,
    enginePlacedPremiumPaid: 1.08,
    enginePlacedUnpricedFills: 0,
    importedContracts: 1,
  };
}

beforeEach(() => {
  // Module-global store. One test's fills must not make another test's oracle
  // look healthy — that would convert a refusal into a pass and grade the wrong
  // branch entirely.
  clearLiveOptionsFeeSlippageLedger();
});

// ─── AC3 — the regression, on the exact records ─────────────────────────────

describe('TRA-3926 AC3 — the widened row stages ONE contract, not two', () => {
  it('sizes the sell_to_close off the engine\'s own fill, not the row\'s `contracts`', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());

    const staged = tick(acct);

    expect(staged).toHaveLength(1);
    const pending = acct.getState().openOptions[0]!.pendingExit!;
    // THE NUMBER. Pre-fix this was 2, and 2 is what reached Tradier.
    expect(pending.qty).toBe(1);
    expect(pending.kind).toBe('sl');
    // The row is NOT restated: `contracts` still says what the broker holds.
    // This ticket bounds what the engine SUBMITS (same posture as TRA-3913).
    expect(acct.getState().openOptions[0]!.contractsRemaining).toBe(2);
  });

  it('counts the refusal with its denominator, and names the leftover contract', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());
    tick(acct);

    const census = acct.getExitQuantityBoundCensus();
    expect(census).toMatchObject({
      checked: 1,
      bounded: 1,
      refusedContracts: 1,
      // A FINDING, not a blind read: the oracle answered COMPLETELY and the
      // contract is not ours. These must never share a column (TRA-3913 rule 4).
      blindRows: 0,
      suppressedExits: 0,
    });
    expect(census.last).toMatchObject({
      optionSymbol: XLF,
      requestedContracts: 2,
      exitContracts: 1,
      refusedContracts: 1,
      reason: 'engine_partial',
      oracleRefused: false,
    });
  });

  it('surfaces the refused contract on the row, where `summarizeLiveExitErrors` reads it', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());
    tick(acct);

    const row = acct.getState().openOptions[0]!;
    // A partial bound stages a perfectly good order for OUR share and leaves a
    // contract behind, so there is no failure for `exitErrorReason` to hold —
    // and the staging site clears that field on every fresh order anyway. The
    // residual needs its own, and it is the reason `exitQuantityRefusal` exists.
    expect(row.exitErrorReason).toBeUndefined();
    expect(row.exitQuantityRefusal).toMatchObject({
      requestedContracts: 2,
      exitContracts: 1,
      refusedContracts: 1,
      reason: 'engine_partial',
      oracleRefused: false,
    });
  });

  it('clears the residual once the bound stops biting', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());
    tick(acct);
    expect(acct.getState().openOptions[0]!.exitQuantityRefusal).toBeDefined();

    // The desk's contract is no longer foreign — a second engine fill lands and
    // the tape now accounts for both. A stale residual would assert a contract
    // nobody is holding back.
    const row = acct.getState().openOptions[0]!;
    delete row.pendingExit;
    acct.importSnapshot({
      openOptions: [row],
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-08-21',
      cash: 1_035.94,
      equity: 1_035.94,
    });
    recordEngineOpen(1, 0.85, 142603072, OPENED_AT + 1_000);

    tick(acct);
    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    expect(acct.getState().openOptions[0]!.exitQuantityRefusal).toBeUndefined();
  });
});

// ─── AC4 — the negative control. Without it the fix is "always exit 1" ───────

describe('TRA-3926 AC4 — a genuine engine 2-lot still exits TWO', () => {
  it('stages the full quantity when our own fills cover both contracts', () => {
    // Same row, same symbol, same 2 contracts. The ONLY difference from AC3 is
    // what the tape accounts for: a partial-fill top-up we really did place.
    recordEngineOpen(1, 1.08, 142603071, OPENED_AT);
    recordEngineOpen(1, 0.85, 142603072, OPENED_AT + 1_000);
    const acct = liveBook(widenedRow());

    const staged = tick(acct);

    expect(staged).toHaveLength(1);
    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({
      // The denominator moved: the bound RAN and found nothing to refuse. That
      // is a different fact from a branch that never ran, and only the pair
      // says which one happened.
      checked: 1,
      bounded: 0,
      refusedContracts: 0,
    });
  });

  it('leaves an ordinary engine-opened (non-imported) row completely alone', () => {
    // No ledger rows AT ALL, and the row must still exit in full: rule 1 of the
    // split short-circuits before the oracle is consulted. Consulting it here
    // would attribute the entire book to the desk (TRA-3913 rule 3's hazard,
    // arrived at from the write side).
    const acct = liveBook(widenedRow({
      importedFromTradier: false,
      adoptionAuthority: undefined,
      engineOriginSleeve: undefined,
    }));

    tick(acct);

    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    // ...and it is not even in the denominator: the bound cannot bite here.
    expect(acct.getExitQuantityBoundCensus().checked).toBe(0);
  });
});

// ─── AC2 — "cannot answer" is BLIND, and blind is measured, not silent ──────
//
// ⚠ AC2 AS LITERALLY WRITTEN ASKED FOR "EXIT 0 AND REFUSE THE RESIDUAL", AND
// THAT TURNS TRA-2820 BACK ON. The repository already carries the control that
// proves it: `TRA-3829 — an ENGINE-OPENED row re-adopted after a lost local row
// keeps its stops (TRA-2820)`. That fixture is a row the app really did place
// whose local row was lost to a reboot; the fill ledger holds nothing for it,
// and the strict rule leaves a real-money position under a breached stop with
// no exit at all. It went RED on the first implementation of AC2 verbatim.
//
// So the bound binds where the ledger makes a COMPLETE POSITIVE statement that
// contradicts the row (`engine_partial` — the 2026-08-21 state), and reads
// BLIND everywhere the oracle refused. Blind exits at the row's quantity, as
// before the fix, and is COUNTED. That residual fail-open is real and is
// reported as such; it is the smaller of two measured real-money hazards.

describe('TRA-3926 AC2 — a row the oracle cannot answer for is BLIND, and counted', () => {
  it('does NOT refuse the exit when the ledger holds no fill for the symbol — TRA-2820', () => {
    // Retention aged our opens out, or the ledger was never hydrated. Refusing
    // here strands a live position under a breached stop.
    const acct = liveBook(widenedRow());

    const staged = tick(acct);

    expect(staged).toHaveLength(1);
    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({
      checked: 1,
      bounded: 0,
      refusedContracts: 0,
      // The residual fail-open, made countable. `bounded: 0 / blindRows: 1`
      // means the bound ran once and could judge nothing — coverage, not health.
      blindRows: 1,
      suppressedExits: 0,
    });
  });

  it('an import-only episode is BLIND too — retention leaves that state on a row we DID open', () => {
    // `oracle_import_only`: the ledger holds rows for this OCC and not one of
    // them says WE placed it. That is what the overnight reconcile manufactured
    // on 2026-08-21 — and it is ALSO what 30-day retention plus a re-import
    // leaves on a row the engine genuinely opened, which is why it cannot bind.
    recordDeskImport(1, 0.85);
    recordDeskImport(1, 1.08, DESK_AT + 1_000);
    const acct = liveBook(widenedRow());

    expect(tick(acct)).toHaveLength(1);
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({ blindRows: 1, bounded: 0 });
    expect(acct.getState().openOptions[0]!.exitQuantityRefusal).toBeUndefined();
  });

  it('a FOREIGN row with no hand-over is refused outright — authorization, not blindness', () => {
    // Defence in depth. `checkExits` already refuses this row upstream, but the
    // bound must not be the thing that would have let it through: a foreign row
    // is the desk's by provenance and the oracle is never even asked.
    const bound = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'foreign', tradierEnv: 'production' },
      2,
      2,
      () => { throw new Error('the oracle must not be consulted on a foreign row'); },
      false,
    );
    expect(bound).toMatchObject({
      exitContracts: 0,
      refusedContracts: 2,
      reason: 'foreign_authority',
      blind: false,
      oracleRefused: false,
    });
  });
});

// ─── TP1 — the partial site is bounded too, and is silent where it should be ─

describe('TRA-3926 — the TP1 partial site', () => {
  it('is SILENT on a 2-lot holding one desk contract: a 50% partial asks for 1 and gets 1', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    // Mark THROUGH tp1, and nowhere near the stop.
    const acct = liveBook(widenedRow({ currentPremium: 1.6 }));

    const staged = acct.checkExits(UNDERLYINGS, new Map([[XLF, 1.6]]), 'live', { waitAndHold: true });

    expect(staged).toHaveLength(1);
    const pending = acct.getState().openOptions[0]!.pendingExit!;
    expect(pending.kind).toBe('tp1');
    expect(pending.qty).toBe(1);
    // Requested 1, allowed 1 — the bound RAN and refused nothing.
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({ checked: 1, bounded: 0 });
  });
});

// ─── Ruling B — a per-row hand-over is the board's answer, and it stands ─────

describe('TRA-3926 x TRA-3829 ruling B — an explicit hand-over still exits in full', () => {
  it('does not consult the oracle at all on a handed-over row', () => {
    // Nothing in the ledger, a FOREIGN row, and both of ruling B's keys. The
    // grant IS the authorization to sell contracts the engine never bought;
    // narrowing it here would be option (a) wearing ruling B's name.
    let consulted = 0;
    const bound = boundExitContractsToEngineShare(
      {
        importedFromTradier: true,
        adoptionAuthority: 'foreign',
        tradierEnv: 'production',
        engineHandover: { grantedAt: '2026-08-21T13:00:00.000Z', grantedBy: 'board-member' },
      },
      2,
      2,
      () => { consulted += 1; return null; },
      true,
    );
    expect(bound).toMatchObject({ exitContracts: 2, refusedContracts: 0, reason: 'handed_over' });
    expect(consulted).toBe(0);
  });

  it('a MALFORMED grant is not a grant — it falls back to the bound', () => {
    // `{ grantedAt: 'soon', grantedBy: '' }` is a truthy byte and not a
    // decision. The oracle answers 1-of-2, so the fallback is visible: a grant
    // that silently passed would stage 2.
    const bound = boundExitContractsToEngineShare(
      {
        importedFromTradier: true,
        adoptionAuthority: 'engine_origin',
        tradierEnv: 'production',
        engineHandover: { grantedAt: 'soon', grantedBy: '' },
      },
      2,
      2,
      partialOracle,
      true,
    );
    expect(bound).toMatchObject({
      exitContracts: 1,
      refusedContracts: 1,
      reason: 'engine_partial',
      blind: false,
    });
  });

  it('a well-formed grant with the master arm OFF is inert — it falls back to the bound', () => {
    // Ruling B needs BOTH keys. A grant recorded under the go-live code freeze
    // is legible and does nothing, which is what keeps the mechanism dark.
    const bound = boundExitContractsToEngineShare(
      {
        importedFromTradier: true,
        adoptionAuthority: 'engine_origin',
        tradierEnv: 'production',
        engineHandover: { grantedAt: '2026-08-21T13:00:00.000Z', grantedBy: 'board-member' },
      },
      2,
      2,
      partialOracle,
      false,
    );
    expect(bound.reason).toBe('engine_partial');
    expect(bound.exitContracts).toBe(1);
  });
});

// ─── The pure bound — the shapes the account-level tests cannot reach ────────

describe('TRA-3926 boundExitContractsToEngineShare — total over its input space', () => {
  const engineOriginRow = {
    importedFromTradier: true,
    adoptionAuthority: 'engine_origin',
    tradierEnv: 'production',
  };
  const oracle = (enginePlacedContracts: number, importedContracts = 0) => () => ({
    contracts: enginePlacedContracts + importedContracts,
    premiumPaid: 0.965,
    unpricedFills: 0,
    enginePlacedContracts,
    enginePlacedPremiumPaid: 1.08,
    enginePlacedUnpricedFills: 0,
    importedContracts,
  });

  it('only ever LOWERS — an oracle that over-counts cannot widen the request', () => {
    // The engine's own fills account for 5; the row holds 2 and asks for 2.
    // A partial CLOSE truncates the episode window and a partial close on the
    // ROW shrinks the remainder; the two move independently.
    expect(
      boundExitContractsToEngineShare(engineOriginRow, 2, 2, oracle(5), false).exitContracts,
    ).toBe(2);
  });

  it('a NaN request coerces to 0 rather than reaching the broker as a quantity', () => {
    // `Math.min(NaN, 1)` is `NaN`, and a NaN quantity reads as a number until
    // something compares it (TRA-3486).
    const bound = boundExitContractsToEngineShare(engineOriginRow, Number.NaN, 2, oracle(1), false);
    expect(bound.exitContracts).toBe(0);
    expect(bound.requestedContracts).toBe(0);
    // Nothing was refused: nothing was asked for. A zero request is not an alarm.
    expect(bound.bounded).toBe(false);
  });

  it('a SANDBOX import is never bounded — the LIVE ledger cannot answer for it', () => {
    expect(
      boundExitContractsToEngineShare(
        { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'sandbox' },
        2,
        2,
        () => null,
        false,
      ),
    ).toMatchObject({ exitContracts: 2, reason: 'sandbox_import' });
  });

  it('an ABSENT tradierEnv on an imported live row is guarded, not exempted', () => {
    // Unknown env on real money is the case this family of guards exists for.
    // A SANDBOX row never reaches the oracle at all (the case above); an
    // env-less one must, and must be bounded by what it says.
    let consulted = 0;
    const bound = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin' },
      2,
      2,
      () => { consulted += 1; return partialOracle(); },
      false,
    );
    expect(consulted).toBe(1);
    expect(bound).toMatchObject({ exitContracts: 1, refusedContracts: 1, reason: 'engine_partial' });
  });
});

// ─── AC5 — the detector, on the tape that already fired ─────────────────────

function ledgerRow(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: OPENED_AT,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    optionSymbol: XLF,
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: 1.08,
    fees: null,
    feeSource: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: 142603071,
    origin: 'fill',
    ...over,
  };
}

/** The 2026-08-21 tape, verbatim. */
const THE_EVENT: LiveOptionFillRecord[] = [
  ledgerRow({}),
  ledgerRow({ ts: DESK_AT, contracts: 1, filledPrice: 0.85, orderId: null, origin: 'history_import', sleeve: 'unattributed' }),
  ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: 142806015 }),
];

describe('TRA-3926 AC5 — the detector for the condition that has ALREADY occurred', () => {
  it('raises on the 2026-08-21T13:48:04Z close, and names where the excess came from', () => {
    const census = detectOversoldEngineCloses(THE_EVENT);
    expect(census.status).toBe('oversold');
    expect(census.excessContracts).toBe(1);
    expect(census.findings).toHaveLength(1);
    expect(census.findings[0]).toMatchObject({
      optionSymbol: XLF,
      orderId: 142806015,
      soldContracts: 2,
      engineOpenContracts: 1,
      // The desk's contract. This is the number that says the excess was not
      // simply invented — it came out of somebody's real inventory.
      importedOpenContracts: 1,
      excessContracts: 1,
    });
  });

  it('grades the SAME close CLEAN once both contracts are the engine\'s own', () => {
    // The AC4 control, at the detector layer. A detector that fires on every
    // 2-contract close is the same instrument as no detector.
    const clean = detectOversoldEngineCloses([
      ledgerRow({}),
      ledgerRow({ ts: OPENED_AT + 1_000, contracts: 1, filledPrice: 0.85, orderId: 142603072 }),
      ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: 142806015 }),
    ]);
    expect(clean.status).toBe('clean');
    expect(clean.judgedCloses).toBe(1);
    expect(clean.findings).toEqual([]);
  });

  it('does not judge the DESK closing its own leg — `origin` is the discriminator', () => {
    const census = detectOversoldEngineCloses([
      ledgerRow({ ts: DESK_AT, contracts: 2, filledPrice: 0.85, orderId: null, origin: 'history_import', sleeve: 'unattributed' }),
      ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: null, origin: 'history_import', sleeve: 'unattributed' }),
    ]);
    expect(census.importedCloses).toBe(1);
    expect(census.engineCloses).toBe(0);
    expect(census.findings).toEqual([]);
    // ...and it is VACUOUS, not clean: no engine close was judged, so nothing
    // about the engine has been proved.
    expect(census.status).toBe('vacuous');
  });

  it('reports a close whose opens aged out as BLIND, not as a finding', () => {
    const census = detectOversoldEngineCloses([
      ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: 142806015 }),
    ]);
    expect(census.status).toBe('vacuous');
    expect(census.findings).toEqual([]);
    expect(census.blindCloses).toEqual([
      { optionSymbol: XLF, ts: CLOSED_AT, reason: 'no_open_record' },
    ]);
  });

  it('is order-insensitive — it sorts the tape itself', () => {
    const shuffled = [THE_EVENT[2]!, THE_EVENT[0]!, THE_EVENT[1]!];
    expect(detectOversoldEngineCloses(shuffled).status).toBe('oversold');
  });

  it('a corrupt `contracts` on a close reads BLIND, never as a covered close', () => {
    const census = detectOversoldEngineCloses([
      ledgerRow({}),
      ledgerRow({ ts: CLOSED_AT, side: 'sell_to_close', contracts: Number.NaN, orderId: 142806015 }),
    ]);
    expect(census.blindCloses).toEqual([
      { optionSymbol: XLF, ts: CLOSED_AT, reason: 'unusable_quantity' },
    ]);
    expect(census.judgedCloses).toBe(0);
    expect(census.status).toBe('vacuous');
  });

  it('a later legitimate round trip is judged on its OWN episode, not the whole history', () => {
    // The over-sell consumed the desk's contract; the books must be left honest
    // or every subsequent close on the symbol inherits a phantom deficit.
    const census = detectOversoldEngineCloses([
      ...THE_EVENT,
      ledgerRow({ ts: CLOSED_AT + 60_000, etDay: '2026-08-21', contracts: 1, filledPrice: 1.0, orderId: 142900001 }),
      ledgerRow({ ts: CLOSED_AT + 120_000, etDay: '2026-08-21', side: 'sell_to_close', contracts: 1, filledPrice: 1.1, orderId: 142900002 }),
    ]);
    expect(census.findings).toHaveLength(1);
    expect(census.judgedCloses).toBe(2);
    expect(census.excessContracts).toBe(1);
  });
});
