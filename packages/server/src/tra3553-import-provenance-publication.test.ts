import { describe, it, expect, beforeEach } from 'vitest';
import { PaperOptionsAccount, foldImportProvenanceCensuses, type ImportProvenanceCensus } from './options-account.js';
import { SignalEngine } from './signal-engine.js';
import { clearLiveOptionsFeeSlippageLedger, recordLiveOptionFill } from './live-options-fee-slippage-ledger.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3553 — PUBLICATION of the import-provenance witness.
//
// ## What this file is about, and why it is separate from the fix's own suite
//
// `tra3553-import-provenance.test.ts` grades the FIX: that the import path keeps
// the risk block, the provenance and the underlying anchor. Those 25 tests pass,
// the code they cover shipped as `4cac8b70`, and it has been serving on bqb1
// since 2026-08-13.
//
// None of that made the fix OBSERVABLE. `importProvenanceSummary()` — the census
// the fix's own commit message calls "the witness", written specifically because
// "the fix is otherwise unobservable in the state it most needs to be observed
// in" — had **no production caller for 19 days**. Its only callers were the
// tests that assert on it. So `/api/health/options-live` published 52 fields and
// not one of them was this one, and TRA-3553's definition of done — *"verify by
// field presence on the live health route, not by the push"* — was unsatisfiable
// against code that was live the entire time.
//
// A witness reachable only from its own test suite is not a witness. That is the
// defect these tests hold closed, and it has a specific shape: the failure was
// never in the census's arithmetic (which was right), it was in the WIRING, and
// a suite that only ever calls the census directly cannot see wiring at all.
//
// ## The two ways this wiring can be wrong while looking right
//
// Both produce `adopted: 0`, and `adopted: 0` is the reading the flat live book
// produces on an ordinary day, so neither is visible from the published numbers:
//
//   1. the fold reads the ACTIVE env bucket only — TRA-383's hazard, below; or
//   2. the fold is wired to nothing at all.
//
// Every test here therefore moves a counter OFF zero first and asserts it
// arrived, rather than asserting an expected zero that a disconnected fold would
// also produce.
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildImport(overrides: Partial<TradierOpenOptionPosition> = {}): TradierOpenOptionPosition {
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

/** A real `buy_to_open` in the real ledger — the engine-origin proof. */
function recordEngineOpen(optionSymbol: string): void {
  recordLiveOptionFill({
    ts: TRADING_TIME,
    etDay: '2026-08-04',
    sleeve: 'single_leg_otm',
    optionSymbol,
    side: 'buy_to_open',
    contracts: 4,
    filledPrice: 0.27,
    orderId: 140022786,
  });
}

/**
 * The ACTIVE env bucket is pinned explicitly on every engine here rather than
 * inherited from `DEFAULT_ACCOUNT_SETTINGS`.
 *
 * It has to be. The default is `liveTradierEnvOptions: 'sandbox'`, so a test
 * that means "reconcile into the bucket the engine is NOT pointed at" and simply
 * writes `'sandbox'` is in fact reconciling into the ACTIVE one — and passes
 * identically against a single-bucket fold, which is the bug. That is not a
 * hypothetical: the first draft of this file did exactly that, and the
 * single-bucket negative control below waved it through. Pinning the active env
 * makes each test's direction a stated fact instead of an assumption about a
 * default that can be changed elsewhere.
 */
function newEngine(activeEnv: 'sandbox' | 'production'): SignalEngine {
  return new SignalEngine({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'live' as const,
    liveTradierEnvOptions: activeEnv,
  });
}

function census(overrides: Partial<ImportProvenanceCensus> = {}): ImportProvenanceCensus {
  return {
    adopted: 0,
    engineOrigin: 0,
    foreign: 0,
    unresolved: 0,
    underlyingBackfilled: 0,
    underlyingUnknown: 0,
    entryDeltaRestored: 0,
    ...overrides,
  };
}

beforeEach(() => {
  clearLiveOptionsFeeSlippageLedger();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — `blind` separates "never measured" from "measured clean"', () => {
  it('an all-zero fleet is BLIND, not clean', () => {
    // The reading the flat live book produces on an ordinary day. Every count is
    // zero and every `every(...)` over the imported cohort is vacuously true;
    // the ticket's own words are "VACUOUS, not passing". `blind` is the only
    // field that says so.
    expect(foldImportProvenanceCensuses([census(), census()])).toMatchObject({
      adopted: 0,
      blind: true,
    });
  });

  it('an EMPTY fleet is BLIND — no books is the unmeasured state, not a pass', () => {
    expect(foldImportProvenanceCensuses([]).blind).toBe(true);
  });

  it('one adoption anywhere in the fleet clears BLIND', () => {
    // Controlled against the case above on ONE variable: a single adopted row in
    // the second book. If `blind` did not move here it would be a constant, and
    // a constant cannot discriminate anything.
    expect(foldImportProvenanceCensuses([census(), census({ adopted: 1 })]).blind).toBe(false);
  });

  it('BLIND keys on `adopted` ALONE — a fleet that adopted nothing but has other counts is still blind', () => {
    // Guards the cheap wrong implementation: `blind = every count is 0`. Only
    // the denominator can answer "did the branch run", and a non-zero secondary
    // counter beside `adopted: 0` is an INCONSISTENT census, which must not be
    // allowed to read as a measurement.
    expect(foldImportProvenanceCensuses([census({ unresolved: 3, foreign: 2 })]).blind).toBe(true);
  });

  it('MUTATION: every field is summed, and each one independently', () => {
    // A fold that dropped a field, or that aliased two of them, would still pass
    // a spot check on `adopted`. Each counter is given a DISTINCT value so a
    // copy-paste error between two lines cannot land on the right answer.
    expect(
      foldImportProvenanceCensuses([
        census({
          adopted: 1,
          engineOrigin: 2,
          foreign: 3,
          unresolved: 4,
          underlyingBackfilled: 5,
          underlyingUnknown: 6,
          entryDeltaRestored: 7,
        }),
        census({
          adopted: 10,
          engineOrigin: 20,
          foreign: 30,
          unresolved: 40,
          underlyingBackfilled: 50,
          underlyingUnknown: 60,
          entryDeltaRestored: 70,
        }),
      ]),
    ).toEqual({
      adopted: 11,
      engineOrigin: 22,
      foreign: 33,
      unresolved: 44,
      underlyingBackfilled: 55,
      underlyingUnknown: 66,
      entryDeltaRestored: 77,
      blind: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — the engine fold spans BOTH env buckets (TRA-383)', () => {
  it('counts an adoption made against the NON-active env bucket', () => {
    // ── The hazard, in one test ──────────────────────────────────────────────
    // Imported rows land in whichever bucket the user synced against
    // (`reconcileTradierPositions(env, …)`). TRA-383 already paid for this once:
    // reading only `this.optionsAccount` missed imports held in the other bucket
    // and left their marks stuck at `—` forever.
    //
    // Here it is worse than a display bug. `adopted` is the BLINDNESS
    // DISCRIMINATOR, so an active-bucket-only fold over imports that landed in
    // the other bucket publishes `adopted: 0, blind: true` — a fleet that
    // adopted rows reporting that it never looked. The ONE state this whole
    // census exists to make impossible is the one it would report.
    // Engine pointed at SANDBOX; the import lands in PRODUCTION.
    const engine = newEngine('sandbox');
    recordEngineOpen('TSLA260911C00555000');

    engine.reconcileTradierPositions('production', [buildImport()], 'live');

    expect(engine.getImportProvenanceCensus().adopted).toBe(1);
  });

  it('counts an adoption in the OTHER non-active bucket too', () => {
    // The mirror direction, with the active env flipped: engine pointed at
    // PRODUCTION, import lands in SANDBOX. Without this, the test above could be
    // passing because the fold reads `production` unconditionally rather than
    // because it reads both — one hardcoded bucket satisfies any single
    // direction. Only the pair pins "both".
    const engine = newEngine('production');
    recordEngineOpen('TSLA260911C00555000');

    engine.reconcileTradierPositions('sandbox', [buildImport()], 'live');

    expect(engine.getImportProvenanceCensus().adopted).toBe(1);
  });

  it('SUMS the two buckets rather than reporting the larger', () => {
    // A fold that returned `max` — or that read one bucket and happened to pick
    // the populated one — passes both directions above. The sum is the only
    // assertion that separates "reads both" from "reads a lucky one".
    const engine = newEngine('sandbox');
    recordEngineOpen('TSLA260911C00555000');
    recordEngineOpen('SPY260515C00450000');

    engine.reconcileTradierPositions('sandbox', [buildImport()], 'live');
    engine.reconcileTradierPositions(
      'production',
      [buildImport({ optionSymbol: 'SPY260515C00450000', underlying: 'SPY', strike: 450, expiration: '2026-05-15' })],
      'live',
    );

    expect(engine.getImportProvenanceCensus().adopted).toBe(2);
  });

  it('a fresh engine reports zero — so the counts above are the reconcile, not a constant', () => {
    // The negative control for the group above. Without it, a fold hardcoded to
    // return `adopted: 1` would pass three of these, and this suite would be
    // asserting that a number exists rather than that it MEANS anything.
    expect(newEngine('sandbox').getImportProvenanceCensus().adopted).toBe(0);
  });

  it('the engine-origin verdict survives the fold and is countable', () => {
    // The census is not only a denominator. `engineOrigin` is the count that
    // says ask 3 held — a contract the engine placed was re-adopted WITHOUT its
    // provenance being clobbered — and it has to survive the two-bucket sum to
    // be readable on the route.
    const engine = newEngine('sandbox');
    recordEngineOpen('TSLA260911C00555000');
    engine.reconcileTradierPositions('production', [buildImport()], 'live');

    const fold = engine.getImportProvenanceCensus();
    expect(fold.adopted).toBe(1);
    expect(fold.engineOrigin).toBe(1);
    expect(fold.unresolved).toBe(0);
  });

  it('an UNRESOLVED verdict is countable through the fold — a sick oracle is not silence', () => {
    // Controlled against the test above on one variable: the ledger is empty, so
    // the oracle cannot answer. Ask 1's whole point is that this is a THIRD kind
    // of thing — an admission, not a decision — and it stays countable fleet-wide
    // rather than being folded away into the `foreign` bucket.
    const engine = newEngine('sandbox');
    engine.reconcileTradierPositions('production', [buildImport()], 'live');

    const fold = engine.getImportProvenanceCensus();
    expect(fold.adopted).toBe(1);
    expect(fold.unresolved).toBe(1);
    expect(fold.engineOrigin).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3553 — the account-level census still backs the fold', () => {
  it('the per-account summary is what the fold sums, and it is a COPY', () => {
    // The fold's inputs must not be live handles into account state: a caller
    // mutating the returned object (or the fold accumulating into it) would
    // corrupt the account's own since-boot counters and there would be no way to
    // tell from the published numbers.
    const account = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    recordEngineOpen('TSLA260911C00555000');
    account.reconcileTradierPositions([buildImport()], 'live');

    const first = account.importProvenanceSummary();
    expect(first.adopted).toBe(1);
    first.adopted = 999;
    expect(account.importProvenanceSummary().adopted).toBe(1);
  });
});
