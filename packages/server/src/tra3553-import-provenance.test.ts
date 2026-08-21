import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  lastRecordedOpenSleeve,
} from './live-options-fee-slippage-ledger.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';
import { OTM_RISK_PARAMS, RV_MIN_MARK_FLOOR } from '@trading-app/shared';
import type { RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3553 (TRA-2820 asks 1–3) — what the `tradier_import` path must not lose.
//
// ── Why this file exists and why it is a UNIT suite ─────────────────────────
// The live admin book was FLAT on 2026-08-13: zero open option positions at the
// broker, so zero `tradier_import` rows to read. An empty cohort satisfies every
// `every(...)` predicate anyone can write over it, so a live read of this fix is
// VACUOUS, not passing — it cannot distinguish "the import path now preserves
// everything" from "the import path never ran". These tests drive the path
// directly with the two shapes the ticket names:
//
//   (a) a contract the ENGINE placed, whose position row was lost, that the
//       reconcile is re-adopting as if it were foreign inventory — the risk
//       block AND the provenance must survive; and
//   (b) a genuinely UNKNOWN broker row — the sentinel schedule is correct, but
//       it must fail LOUD rather than presenting `0` / `null` as a decision.
//
// ── The oracle is exercised for real, not only through a stub ───────────────
// Half of these cases drive the DEFAULT provenance oracle by writing real rows
// into the live fee/slippage ledger module. A suite that only ever injects a
// test double grades the double: `ledgerOpenProvenance` is the function that
// runs on bqb1, and its `null`-handling is the entire subject of ask 1.
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

/** The 2026-08-04 TSLA contract, as Tradier reported it back to the reconcile. */
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
    // Below RV_MIN_MARK_FLOOR (0.40) — the premium that made TRA-462's
    // sub-floor sentinel swallow an OTM position the engine had chosen.
    premiumPaid: 0.27,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

/** Write a real `buy_to_open` into the real ledger, the way a live fill does. */
function recordEngineOpen(
  optionSymbol: string,
  sleeve: 'single_leg_otm' | 'single_leg_rv' | 'unattributed',
  orderId: number | null = 140022786,
): void {
  recordLiveOptionFill({
    ts: TRADING_TIME,
    etDay: '2026-08-04',
    sleeve,
    optionSymbol,
    side: 'buy_to_open',
    contracts: 4,
    filledPrice: 0.27,
    orderId,
  });
}

function liveAccount(config: Record<string, unknown> = {}): PaperOptionsAccount {
  return new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    ...config,
  });
}

beforeEach(() => {
  // Module-global store. Cleared per test so one test's fills cannot make
  // another test's oracle look healthy — which would silently convert the
  // `unresolved` cases below into `foreign` ones and pass for the wrong reason.
  clearLiveOptionsFeeSlippageLedger();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — the oracle can tell "not ours" from "I cannot tell"', () => {
  it('CONTROL: the pre-existing oracle collapses both states into null', () => {
    // Not a claim about the fix — a claim about the thing being fixed, stated
    // here so the rest of the file has a named cause rather than an assumed
    // one. `lastRecordedOpenSleeve` is null-for-both, which is exactly why a
    // caller reading its silence as "foreign" cannot be correct in both worlds.
    expect(lastRecordedOpenSleeve('TSLA260911C00555000')).toBeNull(); // empty ledger

    recordEngineOpen('SPY260515C00450000', 'single_leg_otm');
    // Populated ledger, different contract — still null, same value, different
    // meaning.
    expect(lastRecordedOpenSleeve('TSLA260911C00555000')).toBeNull();
  });

  it('BOTH DIRECTIONS: the same unknown contract reads foreign or unresolved by ledger health alone', () => {
    // The discriminator is controlled in both directions with ONE variable
    // moved — the health of the ledger — and nothing else. If this pair ever
    // reads the same, the new verdict is not doing any work.
    const sick = liveAccount();
    sick.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(sick.getState().openOptions[0]!.riskUnmanagedReason).toBe('provenance_unresolved');

    // A populated ledger that has never seen THIS contract. The row it holds is
    // for a different OCC symbol, so the oracle is demonstrably able to answer
    // and its answer here is a real "no".
    recordEngineOpen('SPY260515C00450000', 'single_leg_otm');
    const healthy = liveAccount();
    healthy.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(healthy.getState().openOptions[0]!.riskUnmanagedReason).toBe('sub_floor_premium');
  });

  it('a ledger holding only sell_to_close rows is still SICK for an open-provenance question', () => {
    // The health probe counts the side actually consulted. A `fills.length`
    // probe would call this oracle healthy and hand back a confident "foreign".
    recordLiveOptionFill({
      ts: TRADING_TIME,
      etDay: '2026-08-04',
      sleeve: 'single_leg_otm',
      optionSymbol: 'SPY260515C00450000',
      side: 'sell_to_close',
      contracts: 1,
      filledPrice: 1.1,
    });
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(acct.getState().openOptions[0]!.riskUnmanagedReason).toBe('provenance_unresolved');
  });

  it('an `unattributed` ledger row is a real ANSWER, not a sick oracle', () => {
    // TRA-2959: a fill recovered from broker account history has no engine
    // provenance to inherit. The oracle answered; the answer is "nothing of
    // ours". Mislabelling that as unresolved would put a permanent floor under
    // the unresolved count and make the signal unreadable.
    recordEngineOpen('TSLA260911C00555000', 'unattributed');
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;
    expect(opt.riskUnmanagedReason).toBe('sub_floor_premium');
    expect(opt.engineOriginSleeve).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 case (a) — an engine-created contract re-adopted as an import', () => {
  it('keeps the risk block AND the provenance, through the REAL ledger oracle', () => {
    recordEngineOpen('TSLA260911C00555000', 'single_leg_otm', 140022786);
    const acct = liveAccount();

    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;

    // ── the risk block survives (TRA-2820 ask 1) ──────────────────────────────
    // The exact arithmetic `openOtmMispricingPosition` would have installed, on
    // a premium BELOW the RV floor — i.e. the sub-floor sentinel is refused
    // precisely where it used to swallow the position.
    expect(opt.premiumPaid).toBeLessThan(RV_MIN_MARK_FLOOR);
    expect(opt.stopLossPremium).toBeCloseTo(0.27 * (1 - OTM_RISK_PARAMS.slPct), 10);
    expect(opt.tp1Premium).toBeCloseTo(0.27 * (1 + OTM_RISK_PARAMS.tp1Pct), 10);
    expect(opt.stopLossPremium).toBeGreaterThan(0);
    expect(Number.isFinite(opt.tp1Premium)).toBe(true);
    expect(opt.riskUnmanagedReason).toBeUndefined();

    // ── the provenance survives (TRA-2820 ask 3) ──────────────────────────────
    expect(opt.engineOriginSleeve).toBe('single_leg_otm');
    expect(opt.signalType).toBe('otm_mispricing');
    // The broker order id is the handle TRA-2820 had to recover from the fee
    // ledger by hand because nothing on the row could name it.
    expect(opt.signalId).toBe('engine-origin-order-140022786');
    expect(opt.signalId).not.toContain('tradier-import-');

    // ── and the BOOKKEEPING claim is deliberately untouched ───────────────────
    // The broker remains the authority on whether this row still exists; the
    // broker-missing sweep and `recordImportedFill` both key on this flag.
    expect(opt.importedFromTradier).toBe(true);
  });

  it('an RV-origin contract is re-typed to relative_value; a directional one is NOT re-typed', () => {
    recordEngineOpen('TSLA260911C00555000', 'single_leg_rv', 555);
    const rv = liveAccount();
    rv.reconcileTradierPositions([buildTslaImport({ premiumPaid: 0.6 })], 'live');
    expect(rv.getState().openOptions[0]!.signalType).toBe('relative_value');

    // `single_leg_directional` has NO member in the `SignalType` union. The
    // nearest-looking one would be a false label on a real-money row, so the
    // field keeps the coarse-but-true `tradier_import` and the precise answer
    // lives in `engineOriginSleeve`. Asserted so a later "tidy-up" that invents
    // a mapping has to argue with this test.
    const dir = liveAccount({ resolveLiveOpenSleeve: () => 'single_leg_directional' });
    dir.reconcileTradierPositions([buildTslaImport({ premiumPaid: 0.6 })], 'live');
    const dirOpt = dir.getState().openOptions[0]!;
    expect(dirOpt.signalType).toBe('tradier_import');
    expect(dirOpt.engineOriginSleeve).toBe('single_leg_directional');
    // …but its RISK block is still restored — the un-typed sleeve must not cost
    // the position its stop.
    expect(dirOpt.stopLossPremium).toBeGreaterThan(0);
    expect(dirOpt.riskUnmanagedReason).toBeUndefined();
  });

  it('a ledger row with no order id still restores provenance, without fabricating one', () => {
    recordEngineOpen('TSLA260911C00555000', 'single_leg_otm', null);
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;
    expect(opt.signalId).toBe('engine-origin-TSLA260911C00555000');
    expect(opt.engineOriginSleeve).toBe('single_leg_otm');
  });

  it('the DEMO book never consults the oracle — the ledger records live fills only', () => {
    // An OCC collision between a demo row and a live ledger entry would
    // otherwise silently rewrite the demo row's schedule and provenance.
    recordEngineOpen('TSLA260911C00555000', 'single_leg_otm');
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTslaImport()], 'demo');
    const opt = acct.getState().openOptions[0]!;
    expect(opt.engineOriginSleeve).toBeUndefined();
    expect(opt.signalType).toBe('tradier_import');
    expect(opt.signalId).toBe('tradier-import-TSLA260911C00555000');
    // Not asked ⇒ not stamped. `provenance_unresolved` on a demo row would be
    // noise in the one counter that has to stay readable.
    expect(opt.riskUnmanagedReason).not.toBe('provenance_unresolved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 case (b) — an unknown broker row fails LOUD, never quietly', () => {
  it('the zero stop is stamped UNCLASSIFIED, not stamped as a decision', () => {
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;

    // The schedule is unchanged — the sentinel IS the safe state, and guessing
    // a stop on a contract of unknown origin would be strictly worse. What
    // changed is that the row no longer claims to have been understood.
    expect(opt.stopLossPremium).toBe(0);
    expect(opt.tp1Premium).toBe(Number.POSITIVE_INFINITY);
    expect(opt.riskUnmanagedReason).toBe('provenance_unresolved');
    // The specific misreading TRA-2820 was filed under: `sub_floor_premium`
    // reads as a deliberate TRA-462 refusal, and 0.27 IS sub-floor, so the
    // wrong label is also a PLAUSIBLE one. That is what made it survive review.
    expect(opt.riskUnmanagedReason).not.toBe('sub_floor_premium');
  });

  it('it is countable from the no-auth health surface, and never "unexplained"', () => {
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(acct.liveUnmanagedRiskSummary()).toEqual({
      total: 1,
      byReason: { provenance_unresolved: 1 },
      unexplained: 0,
      // TRA-3909 — `null`, never 0: this account has no broker read to hand, so
      // "broker contracts we have no row for" is NOT MEASURED here. A 0 would be
      // an all-clear the summary has not earned.
      uncoveredBrokerContracts: null,
    });
  });

  it('auto_manage_off is NOT overwritten — a real decision outranks the admission', () => {
    // The user turning auto-manage off is a decision about every import,
    // whatever its origin. Relabelling that as "unclassified" would manufacture
    // an alert out of a setting.
    recordEngineOpen('SPY260515C00450000', 'single_leg_otm'); // healthy oracle
    const acct = liveAccount({ autoManageImportedTradierOptions: false });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(acct.getState().openOptions[0]!.riskUnmanagedReason).toBe('auto_manage_off');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 (TRA-2820 ask 2) — the underlying anchor is seeded or named', () => {
  it('backfills underlyingEntryPrice from a spot oracle at openedAt', () => {
    const asked: Array<[string, number]> = [];
    const acct = liveAccount({
      resolveUnderlyingEntrySpot: (symbol: string, atMs: number) => {
        asked.push([symbol, atMs]);
        return 331.69;
      },
    });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;

    expect(opt.underlyingEntryPrice).toBeCloseTo(331.69, 10);
    expect(opt.underlyingEntryUnknownReason).toBeUndefined();
    // Asked for the UNDERLYING at the ACQUISITION time — not the OCC symbol,
    // and not `now`. A resolver handed the wrong key returns a real-looking
    // price for the wrong instrument, which is worse than returning nothing.
    expect(asked).toEqual([['TSLA', TRADING_TIME]]);
    expect(acct.importProvenanceSummary().underlyingBackfilled).toBe(1);
  });

  it('with no oracle wired the 0 is NAMED rather than presented as a price', () => {
    const acct = liveAccount();
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;
    expect(opt.underlyingEntryPrice).toBe(0);
    expect(opt.underlyingEntryUnknownReason).toBe('no_spot_oracle');
    expect(acct.importProvenanceSummary().underlyingUnknown).toBe(1);
    expect(acct.importProvenanceSummary().underlyingBackfilled).toBe(0);
  });

  it.each([
    ['null', () => null],
    ['zero', () => 0],
    ['negative', () => -5],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['throws', () => { throw new Error('quote feed down'); }],
  ])('an oracle that answers %s is spot_unusable, and never crashes the adoption', (_label, resolver) => {
    const acct = liveAccount({ resolveUnderlyingEntrySpot: resolver });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    const opt = acct.getState().openOptions[0]!;
    // The row is still adopted — a blind spot oracle must never cost us the
    // position row, which is the failure this whole ticket chain is about.
    expect(opt.optionSymbol).toBe('TSLA260911C00555000');
    expect(opt.underlyingEntryPrice).toBe(0);
    expect(opt.underlyingEntryUnknownReason).toBe('spot_unusable');
  });

  it('a real anchor clears the stamp, so the field cannot go stale as a false alarm', () => {
    const acct = liveAccount({ resolveUnderlyingEntrySpot: () => 735.58 });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(acct.getState().openOptions[0]!.underlyingEntryUnknownReason).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — the witness that ships with the fix', () => {
  it('the census denominator separates "ran and was clean" from "never ran"', () => {
    const blind = liveAccount();
    // Nothing adopted. This is the reading a live grade against a FLAT book
    // gets, and it must not be confusable with a pass.
    expect(blind.importProvenanceSummary().adopted).toBe(0);

    recordEngineOpen('TSLA260911C00555000', 'single_leg_otm');
    const acct = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    acct.reconcileTradierPositions(
      [buildTslaImport(), buildTslaImport({ optionSymbol: 'AAPL260911C00250000', underlying: 'AAPL', strike: 250 })],
      'live',
    );

    expect(acct.importProvenanceSummary()).toMatchObject({
      adopted: 2,
      engineOrigin: 1, // the TSLA row, which the ledger knows
      // The AAPL row is FOREIGN, not unresolved — and the distinction is the
      // whole design. One `buy_to_open` for any contract makes the oracle
      // demonstrably able to answer, so its silence about AAPL is a real "no".
      // Ledger health is a property of the LEDGER, not of the symbol asked.
      foreign: 1,
      unresolved: 0,
      underlyingBackfilled: 2,
      underlyingUnknown: 0,
    });
  });

  it('MUTATION CHECK: the census counters are not hard-wired to their expected values', () => {
    // A counter observed only at its expected value has been shown to be quiet,
    // not to work. Move each input and require the counter to move with it.
    recordEngineOpen('TSLA260911C00555000', 'single_leg_otm');
    const engine = liveAccount();
    engine.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(engine.importProvenanceSummary()).toMatchObject({
      adopted: 1,
      engineOrigin: 1,
      foreign: 0,
      unresolved: 0,
      underlyingUnknown: 1,
    });

    clearLiveOptionsFeeSlippageLedger();
    recordEngineOpen('SPY260515C00450000', 'single_leg_otm'); // healthy, different symbol
    const foreign = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    foreign.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(foreign.importProvenanceSummary()).toMatchObject({
      adopted: 1,
      engineOrigin: 0,
      foreign: 1,
      unresolved: 0,
      underlyingUnknown: 0,
      underlyingBackfilled: 1,
    });

    clearLiveOptionsFeeSlippageLedger();
    const sick = liveAccount();
    sick.reconcileTradierPositions([buildTslaImport()], 'live');
    expect(sick.importProvenanceSummary()).toMatchObject({
      adopted: 1,
      engineOrigin: 0,
      foreign: 0,
      unresolved: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3553 (TRA-2820 ask 2, first half) — `entryDelta` on a re-typed engine row.
//
// The mint has nothing to compute an entry delta from, so it leaves the
// reconstructed position without one and every |delta|-weighted consumer — the
// stale-mark backstop's premium-move estimate, portfolio greeks, exposure —
// falls back to 0 on a LIVE row whose real exposure is not zero.
//
// But the journal ADOPT branch has, at that exact moment, just PROVED the
// contract has an engine-written OPEN row, and that row is the only surviving
// record of the delta. The fixture is TRA-2937's: model the restart honestly —
// the journal is process-level and survives, the in-memory book is per-instance
// and does not.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — entryDelta is recovered from the journal row being adopted', () => {
  const OCC = 'SPY260515C00450000';
  let tmpFile: string;
  let counter = 0;

  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-3553',
      symbol: 'SPY',
      type: 'relative_value',
      side: 'buy',
      entryPrice: 1.6,
      stopLoss: 1.2,
      takeProfit: 2.4,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
      optionSymbol: OCC,
      optionType: 'call',
      strike: 450,
      expiration: '2026-05-15',
      mark: 1.6,
      fairPrice: 2.0,
      mispricingPct: -0.2,
      zScore: -2.1,
      ivFitted: 0.25,
      ivUsed: 0.22,
      delta: 0.42,
      reason: 'cheap vs skew',
      ...overrides,
    };
  }

  const RV_SETUP = {
    ivRank: 18,
    trend: 'up' as const,
    sentiment: null,
    riskThrottleMultiplier: 1,
    riskThrottleDecided: 1,
    riskThrottleSizingPath: 'options_single_leg' as const,
  };

  function buildSpyImport(): TradierOpenOptionPosition {
    return {
      optionSymbol: OCC,
      underlying: 'SPY',
      optionType: 'call',
      strike: 450,
      expiration: '2026-05-15',
      contracts: 4,
      premiumPaid: 1.6,
      acquiredAt: TRADING_TIME,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra3553-journal-${process.pid}-${counter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  /** Engine opens the contract; the process restarts with an empty book. */
  async function engineOpenThenRestart(): Promise<PaperOptionsAccount> {
    const before = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    const pos = before.openOptionFromRvCandidate(
      buildRvSignal(), 'live', undefined, undefined, RV_SETUP,
    );
    expect(pos).not.toBeNull();
    await before.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('OPEN');
    // The precondition the recovery depends on — asserted, not assumed. If the
    // engine ever stops journalling a usable delta this test must fail HERE,
    // saying the source dried up, rather than below saying the copy is broken.
    expect(rows[0]!.entryDelta).toBeCloseTo(0.42, 10);

    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
    return acct;
  }

  it('the re-adopted position carries the ORIGINAL entry delta, not a fallback 0', async () => {
    const acct = await engineOpenThenRestart();

    acct.reconcileTradierPositions([buildSpyImport()], 'live');
    await acct.flushOptionTradeJournal();

    const row = acct.getStateForMode('live').openOptions[0]!;
    expect(row.entryDelta).toBeCloseTo(0.42, 10);
    expect(acct.importProvenanceSummary().entryDeltaRestored).toBe(1);
  });

  it('a MINTED import gets no fabricated delta — the journal 0 is an unknown, not a measurement', async () => {
    // No prior engine row, so the ADOPT branch never fires and the journal row
    // this import writes carries `entryDelta: 0` as an honest unknown. Copying
    // that back would launder the unknown into the position as a measurement
    // and make a real 0-delta row indistinguishable from an unmeasured one.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildSpyImport()], 'live');
    await acct.flushOptionTradeJournal();

    expect(acct.getStateForMode('live').openOptions[0]!.entryDelta).toBeUndefined();
    expect(acct.importProvenanceSummary().entryDeltaRestored).toBe(0);
  });

  it('repeated sweeps do not re-copy: the restore is idempotent', async () => {
    const acct = await engineOpenThenRestart();
    acct.reconcileTradierPositions([buildSpyImport()], 'live');
    await acct.flushOptionTradeJournal();
    acct.reconcileTradierPositions([buildSpyImport()], 'live');
    acct.reconcileTradierPositions([buildSpyImport()], 'live');
    await acct.flushOptionTradeJournal();

    expect(acct.getStateForMode('live').openOptions[0]!.entryDelta).toBeCloseTo(0.42, 10);
    expect(acct.importProvenanceSummary().entryDeltaRestored).toBe(1);
  });
});
