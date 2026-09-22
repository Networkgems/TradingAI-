import { describe, it, expect, beforeEach } from 'vitest';
import {
  PaperOptionsAccount,
  countLiveImportedRows,
  countLiveImportedRowsByEnv,
  foldImportProvenanceCensuses,
  type ImportProvenanceCensus,
} from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
} from './live-options-fee-slippage-ledger.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4594 — `importProvenance.blind` is a PERISHABLE witness, and the zero it
// publishes is ambiguous in the one direction nobody was watching.
//
// TRA-3553 built `blind` to stop a reader grading an all-zero vector as a pass
// over a FLAT book — a false POSITIVE. It is correct about that. What it cannot
// say is the mirror case, a false NEGATIVE with byte-identical output:
//
//   `importProvenanceCensus` is a private in-memory field, zero-initialised at
//   construction, incremented at exactly ONE site — the mint branch of
//   `reconcileTradierPositions`, just before `openOptions.set(...)`. But
//   `importSnapshot` repopulates `openOptions` at boot, so after a restart that
//   same contract is `existing` on every later reconcile and the mint site is
//   unreachable for it, permanently.
//
// So `{adopted: 0, blind: true}` is ALSO what the fleet publishes while holding
// a real adopted real-money row that a deploy train forgot. This is not a
// hypothetical: the same loop already carries TRA-3078's comment saying so for
// the journal binding — "bqb1 reboots several times a day, so 'the fix worked'
// and 'the fix is gone' were separated by hours."
//
// It matters because TRA-4594's gate is a MULTI-DAY monitor, and any window
// wide enough to catch a real adoption is also wide enough to span the reboot
// that erases it. A gate keyed on `adopted > 0` can never go green.
//
// The remedy is read-side only: no write path, no reconcile behaviour, no order
// path changes. A DURABLE denominator (`liveImportedRows`, folded from persisted
// rows) plus `blindReason` to say which zero is on screen.
// ─────────────────────────────────────────────────────────────────────────────

const OCC = 'TSLA260911C00555000';

function liveAccount(config: Record<string, unknown> = {}): PaperOptionsAccount {
  return new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    ...config,
  });
}

function buildTslaImport(
  over: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'TSLA',
    optionType: 'call',
    strike: 555,
    expiration: '2026-09-11',
    contracts: 1,
    premiumPaid: 3.4,
    acquiredAt: Date.parse('2026-09-10T14:31:00Z'),
    ...over,
  } as TradierOpenOptionPosition;
}

function recordEngineOpen(optionSymbol: string, sleeve: string): void {
  recordLiveOptionFill({
    optionSymbol,
    side: 'buy_to_open',
    sleeve,
    contracts: 1,
    price: 3.4,
    at: Date.parse('2026-09-10T14:31:00Z'),
  } as never);
}

/** The restart: serialize the book, drop the process, load it back up. */
function restart(acct: PaperOptionsAccount): PaperOptionsAccount {
  const snap = acct.exportSnapshot();
  const next = liveAccount();
  next.importSnapshot(JSON.parse(JSON.stringify(snap)));
  return next;
}

beforeEach(() => {
  clearLiveOptionsFeeSlippageLedger();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4594 — the since-boot census does not survive a restart', () => {
  it('REPRODUCES THE FALSE NEGATIVE: a real adopted row is still open, and the census reads zero', () => {
    recordEngineOpen(OCC, 'single_leg_otm');
    const before = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    before.reconcileTradierPositions([buildTslaImport()], 'live');

    // Boot 1: the import path ran on this contract and the witness saw it.
    expect(before.importProvenanceSummary()).toMatchObject({ adopted: 1, engineOrigin: 1 });
    expect(before.liveImportedRowCount()).toBe(1);

    const after = restart(before);

    // The ROW survived — this is real inventory, still open, still real money.
    const rows = after.getState().openOptions.filter(o => o.importedFromTradier === true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.optionSymbol).toBe(OCC);

    // ...and the reconcile keeps seeing the same contract from the broker, which
    // is exactly what happens on bqb1 every tick after a reboot.
    after.reconcileTradierPositions([buildTslaImport()], 'live');
    after.reconcileTradierPositions([buildTslaImport()], 'live');

    // THE DEFECT: byte-identical to "the import branch never ran".
    expect(after.importProvenanceSummary().adopted).toBe(0);
    expect(foldImportProvenanceCensuses([after.importProvenanceSummary()]).blind).toBe(true);

    // THE REMEDY: the durable denominator still sees the row.
    expect(after.liveImportedRowCount()).toBe(1);
  });

  it('names WHICH zero: a forgotten witness and a flat book are told apart', () => {
    const zero: ImportProvenanceCensus = {
      adopted: 0,
      engineOrigin: 0,
      foreign: 0,
      unresolved: 0,
      underlyingBackfilled: 0,
      underlyingUnknown: 0,
      entryDeltaRestored: 0,
    };

    // Flat book: nothing to measure. Re-arming and waiting is correct here.
    expect(foldImportProvenanceCensuses([zero], 0)).toMatchObject({
      blind: true,
      liveImportedRows: 0,
      blindReason: 'no_imported_rows',
    });

    // Rows ARE open and the counter cannot see them. Grading the rows directly
    // is correct here; waiting for `adopted` never terminates.
    expect(foldImportProvenanceCensuses([zero], 2)).toMatchObject({
      blind: true,
      liveImportedRows: 2,
      blindReason: 'witness_lost_at_restart',
    });
  });

  it('an unmeasured fleet must NOT publish the flat-book reason', () => {
    // The `summarizeLiveUnmanagedRisk` convention: absent evidence defaults to
    // NOT MEASURED, never to the all-clear. A `0` default here would let a
    // caller with no book in hand publish `no_imported_rows`, which is the same
    // class of false all-clear TRA-3553 was filed against.
    const fold = foldImportProvenanceCensuses([]);
    expect(fold.liveImportedRows).toBeNull();
    expect(fold.blindReason).toBe('unmeasured');
    expect(fold.blindReason).not.toBe('no_imported_rows');
  });

  it('a measured adoption is not blind and carries no reason', () => {
    recordEngineOpen(OCC, 'single_leg_otm');
    const acct = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');

    const fold = foldImportProvenanceCensuses(
      [acct.importProvenanceSummary()],
      acct.liveImportedRowCount(),
    );
    expect(fold).toMatchObject({ adopted: 1, blind: false, blindReason: null, liveImportedRows: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4594 — countLiveImportedRows counts the right cohort', () => {
  it('counts the ENGINE-ORIGIN re-type, which is the cohort ask 3 is about', () => {
    // `restoreImportProvenance` rewrites `signalType` off `tradier_import` for
    // an engine-origin row. Keying the denominator on that field would drop
    // exactly the rows TRA-2820 ask 3 exists to protect, so it keys on
    // `importedFromTradier`, which is deliberately never cleared.
    recordEngineOpen(OCC, 'single_leg_otm');
    const acct = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');

    const row = acct.getState().openOptions[0]!;
    expect(row.signalType).not.toBe('tradier_import'); // re-typed...
    expect(row.importedFromTradier).toBe(true); // ...but still an import
    expect(acct.liveImportedRowCount()).toBe(1);
  });

  it('excludes demo rows and closed rows', () => {
    const open = { optionSymbol: OCC, mode: 'live', importedFromTradier: true };
    expect(countLiveImportedRows([open] as never)).toBe(1);
    expect(countLiveImportedRows([{ ...open, mode: 'demo' }] as never)).toBe(0);
    expect(countLiveImportedRows([{ ...open, closedAt: 1 }] as never)).toBe(0);
    // A row with no mode defaults to demo, not live — the house convention.
    expect(countLiveImportedRows([{ optionSymbol: OCC, importedFromTradier: true }] as never)).toBe(0);
    // An engine-placed live row that never came through the import path.
    expect(countLiveImportedRows([{ ...open, importedFromTradier: false }] as never)).toBe(0);
  });

  it('MUTATION CHECK: the count tracks its input rather than sitting at a constant', () => {
    const row = (occ: string) => ({ optionSymbol: occ, mode: 'live', importedFromTradier: true });
    expect(countLiveImportedRows([] as never)).toBe(0);
    expect(countLiveImportedRows([row('A')] as never)).toBe(1);
    expect(countLiveImportedRows([row('A'), row('B')] as never)).toBe(2);
    expect(countLiveImportedRows([row('A'), row('B'), row('C')] as never)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4594 (2026-09-22) — THE MIRROR DEFECT, found while grading this row's own
// Definition of Done against the live fleet.
//
// DoD 1 as filed reads: "`importProvenance.blind` reads `false` on bqb1 -- i.e.
// at least one real live adoption has gone through the reconcile." The `i.e.` is
// the bug. `blind` is `adopted === 0`, the mint increments `adopted`
// UNCONDITIONALLY, and the reconcile call site passes the mode `'live'` as a
// literal for every Tradier import — sandbox included. That is deliberate and
// argued in place (deriving mode from env would relocate sandbox imports into
// the demo book) and `tra3112-tradier-client-scope.test.ts` grades it: a sandbox
// import lands `mode: 'live'` with `tradierEnv: 'sandbox'`.
//
// `countLiveImportedRows` keys on `mode` alone. So BOTH discriminators this
// ticket shipped — `blind: false` and `liveImportedRows > 0` — move together on
// a SANDBOX adoption, over zero real-money inventory. The row filed to stop a
// vacuous zero being graded green specified an AC that a sandbox row satisfies.
//
// Reachable on the live fleet, not hypothetical. Measured on bqb1
// 2026-09-22T20:13Z, build `9472ced3`: `serviceTradierEnv: "sandbox"`,
// `brokerPositionDrift.sandboxLiveContexts: 1`, and that context (`Richard`)
// reads `runtimeMode: "live"`, `clientPresent: true`, `optionsRouted: true`.
// One adoption in that book flips the fleet vector non-blind.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4594 — `blind: false` is not "real money was measured"', () => {
  const zero: ImportProvenanceCensus = {
    adopted: 0,
    engineOrigin: 0,
    foreign: 0,
    unresolved: 0,
    underlyingBackfilled: 0,
    underlyingUnknown: 0,
    entryDeltaRestored: 0,
  };

  it('REPRODUCES THE FALSE NON-BLIND: a sandbox adoption satisfies both of DoD 1\'s discriminators', () => {
    const sandboxAcct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      resolveUnderlyingEntrySpot: () => 331.69,
    });
    // The mode literal the real call site passes, for sandbox bytes.
    sandboxAcct.reconcileTradierPositions([buildTslaImport()], 'live');

    const row = sandboxAcct.getState().openOptions[0]!;
    expect(row.mode).toBe('live'); // ...on a SANDBOX client
    expect(row.tradierEnv).toBe('sandbox');

    // Both fields TRA-4594 shipped as the gate flip together:
    const census = sandboxAcct.importProvenanceSummary();
    expect(census.adopted).toBe(1);
    expect(sandboxAcct.liveImportedRowCount()).toBe(1);

    const fold = foldImportProvenanceCensuses(
      [census],
      sandboxAcct.liveImportedRowCount(),
      sandboxAcct.liveImportedRowCountByEnv().production,
    );
    expect(fold.blind).toBe(false); // ← DoD 1 satisfied...
    expect(fold.liveImportedRows).toBe(1); // ← ...and its durable companion too

    // ...and the new field is what refuses the grade. THIS is the assertion a
    // real-money verdict must key on.
    expect(fold.liveProductionImportedRows).toBe(0);
    expect(fold.productionWitness).toBe('no_production_rows');
    expect(fold.productionWitness).not.toBe('gradeable');
  });

  it('a PRODUCTION adoption is gradeable, so the guard is not simply always-refuse', () => {
    recordEngineOpen(OCC, 'single_leg_otm');
    const acct = liveAccount({ resolveUnderlyingEntrySpot: () => 331.69 });
    acct.reconcileTradierPositions([buildTslaImport()], 'live');

    const byEnv = acct.liveImportedRowCountByEnv();
    expect(byEnv).toMatchObject({ total: 1, production: 1, sandbox: 0, envUnknown: 0 });

    const fold = foldImportProvenanceCensuses(
      [acct.importProvenanceSummary()],
      byEnv.total,
      byEnv.production,
    );
    expect(fold).toMatchObject({
      blind: false,
      liveProductionImportedRows: 1,
      productionWitness: 'gradeable',
    });
  });

  it('an unmeasured production count is NEVER gradeable, and never `no_production_rows` either', () => {
    // Same convention as `liveImportedRows` above: absent evidence is NOT
    // MEASURED, not an all-clear and not a refusal-with-a-reason. A `0` default
    // would let a caller holding no book publish a real-money verdict.
    const fold = foldImportProvenanceCensuses([zero], 0);
    expect(fold.liveProductionImportedRows).toBeNull();
    expect(fold.productionWitness).toBe('unmeasured');
    expect(fold.productionWitness).not.toBe('gradeable');
    expect(fold.productionWitness).not.toBe('no_production_rows');
  });

  it('`sandbox_rows_only` separates the third zero, and does NOT delete `witness_lost_at_restart`', () => {
    // Rows open, none of them production ⇒ nothing worth grading was forgotten.
    expect(foldImportProvenanceCensuses([zero], 2, 0)).toMatchObject({
      blind: true,
      liveImportedRows: 2,
      blindReason: 'sandbox_rows_only',
      productionWitness: 'no_production_rows',
    });

    // A production row IS the one the census forgot ⇒ unchanged: grade the rows.
    expect(foldImportProvenanceCensuses([zero], 2, 2)).toMatchObject({
      blindReason: 'witness_lost_at_restart',
      productionWitness: 'gradeable',
    });

    // The env count NOT supplied ⇒ the rows were still measured, so the true and
    // actionable reading survives for the legacy 2-arg caller. The env question
    // is answered by `productionWitness`, not by degrading this field.
    expect(foldImportProvenanceCensuses([zero], 2)).toMatchObject({
      blindReason: 'witness_lost_at_restart',
      productionWitness: 'unmeasured',
    });
  });

  it('an ABSENT `tradierEnv` is not production: the legacy bucket must not reopen the defect', () => {
    // `tradierEnv` is stamped conditionally at every open site and its own
    // declaration defines absent as "legacy sandbox bucket". Folding absent into
    // `production` would restore the false non-blind through the legacy path;
    // calling it `sandbox` would assert a provenance the row never made.
    const open = { optionSymbol: OCC, mode: 'live', importedFromTradier: true };
    expect(countLiveImportedRowsByEnv([open] as never)).toMatchObject({
      total: 1,
      production: 0,
      sandbox: 0,
      envUnknown: 1,
    });
    expect(countLiveImportedRowsByEnv([{ ...open, tradierEnv: 'production' }] as never))
      .toMatchObject({ total: 1, production: 1, sandbox: 0, envUnknown: 0 });
    expect(countLiveImportedRowsByEnv([{ ...open, tradierEnv: 'sandbox' }] as never))
      .toMatchObject({ total: 1, production: 0, sandbox: 1, envUnknown: 0 });
  });

  it('MUTATION CHECK: the production count tracks its input, and the total still agrees', () => {
    const prod = (occ: string) => ({
      optionSymbol: occ,
      mode: 'live',
      importedFromTradier: true,
      tradierEnv: 'production',
    });
    const sbx = (occ: string) => ({ ...prod(occ), tradierEnv: 'sandbox' });

    expect(countLiveImportedRowsByEnv([] as never).production).toBe(0);
    expect(countLiveImportedRowsByEnv([prod('A')] as never).production).toBe(1);
    expect(countLiveImportedRowsByEnv([prod('A'), prod('B')] as never).production).toBe(2);

    const mixed = countLiveImportedRowsByEnv([prod('A'), sbx('B'), sbx('C')] as never);
    expect(mixed).toMatchObject({ total: 3, production: 1, sandbox: 2, envUnknown: 0 });
    // The split is a partition of the old total, so the shipped field is intact.
    expect(mixed.production + mixed.sandbox + mixed.envUnknown).toBe(mixed.total);
    expect(countLiveImportedRows([prod('A'), sbx('B'), sbx('C')] as never)).toBe(mixed.total);
  });
});
