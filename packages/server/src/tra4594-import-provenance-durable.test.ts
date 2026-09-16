import { describe, it, expect, beforeEach } from 'vitest';
import {
  PaperOptionsAccount,
  countLiveImportedRows,
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
