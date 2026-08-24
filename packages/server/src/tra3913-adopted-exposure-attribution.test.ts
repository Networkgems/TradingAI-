// TRA-3913 — ADOPTED DESK CONTRACTS ON AN `engine_origin` ROW.
//
// ── The measurement this file is written against ────────────────────────────
// bqb1 `020100dc56aa`, pid 73, `startedAt 2026-08-21T00:10:46.728Z`, read
// 00:19:40Z. `admin` folds `openPremiumAtRiskUsd $358.00` over 2 open LIVE rows.
// The engine's own fill tape carries $273.00 since the book was last flat:
//
//     BAC260925C00063000   1 @ 1.65                        = $165.00
//     XLF260925C00057500   1 @ 1.08  oid 142603071         = $108.00
//                                                     Σ    = $273.00
//
// The $85.00 gap is fully attributed:
//
//     XLF260925C00057500 (4128b85b)  contracts 2  premiumPaid 0.965 -> $193.00
//       (1.08 + 0.85) / 2 = 0.965 EXACTLY  =>  contract #2 is the DESK's, $0.85
//
// The row carries `importedFromTradier: true`, `adoptionAuthority:
// 'engine_origin'`, `signalId: 'engine-origin-order-142603071'` — the
// pre-TRA-3896 reconcile took the BROKER's lot of 2 and its BLENDED premium onto
// the engine's own row.
//
// ── Why this was not cosmetic ───────────────────────────────────────────────
// `engineMayActOnAdoptedRow` returns TRUE for `engine_origin` — correctly, we
// placed it and must be able to exit it — and TRA-3829's fold read that `true`
// as "this is the engine's money". So `adoptedUsd` read $0.00 on a row holding
// $85.00 of the desk's premium. Until TRA-3911 nothing consumed that number. As
// of `404e8e5bd919` the order path gates on
// `admissible_i = max(0, min(cap_i − atRisk_i, A − Σ_j atRisk_j))` and
// `Σ_j atRisk_j` IS this fold, so the desk's $85.00 crowds out engine entries
// dollar-for-dollar out of the board's $500 authorization (v0nni $193.67 →
// $142.00 on that fleet). It errs SAFE — the fleet under-admits, never over —
// but it spends an authorization the desk was never granted.
//
// ── The discriminating test ─────────────────────────────────────────────────
// AC3 (the live row) and AC4 (the negative control) are the pair, and NEITHER is
// worth anything alone. A predicate that is just `importedFromTradier` wearing a
// new name passes AC3 and fails AC4; the pre-TRA-3913 fold passes AC4 and fails
// AC3. Every AC3 assertion in here is therefore written beside its AC4 twin on
// the SAME symbol and the SAME lot size, differing only in what the engine's own
// fill tape accounts for.
import { describe, it, expect, beforeEach } from 'vitest';
import { foldOpenPremiumAtRisk } from './options-account.js';
import { splitEngineExposureContracts } from './option-exec-flag.js';
import type { OptionPosition } from '@trading-app/shared';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  recordedEngineOpenBasis,
} from './live-options-fee-slippage-ledger.js';
import type { RecordedEngineOpenBasis } from './live-options-fee-slippage-ledger.js';

/** The live XLF row as bqb1 actually holds it, unless overridden. */
function xlfRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: '4128b85b',
    symbol: 'XLF',
    optionSymbol: 'XLF260925C00057500',
    optionType: 'call',
    strike: 57.5,
    expiration: '2026-09-25',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.965, // the BROKER's blend of (1.08 engine + 0.85 desk)
    currentPremium: 0.965,
    tp1Premium: 1.206,
    tp1Hit: false,
    stopLossPremium: 0.724,
    peakPremium: 0.965,
    trailingActive: false,
    trailingStopPremium: 0.849,
    underlyingEntryPrice: 57.1,
    openedAt: Date.parse('2026-08-20T18:02:11Z'),
    signalId: 'engine-origin-order-142603071',
    signalType: 'otm_mispricing',
    mode: 'live',
    importedFromTradier: true,
    adoptionAuthority: 'engine_origin',
    tradierEnv: 'production',
    ...overrides,
  } as OptionPosition;
}

/**
 * An oracle answer, shaped exactly as `recordedEngineOpenBasis` returns one.
 *
 * The engine-placed fields DEFAULT to the episode-wide ones, which is the shape
 * of a ledger holding nothing but our own fills — every case written before the
 * 2026-08-21 regression means exactly that and keeps meaning it. A case that
 * wants the import shape says so explicitly (`importedContracts`), which is the
 * only way to write down the state that actually broke the live book.
 */
function recorded(overrides: Partial<RecordedEngineOpenBasis> = {}): RecordedEngineOpenBasis {
  const contracts = overrides.contracts ?? 1;
  const premiumPaid = overrides.premiumPaid ?? 1.08;
  return {
    contracts,
    premiumPaid,
    costBasisUsd: premiumPaid * contracts * 100,
    fills: 1,
    orderIds: [142603071],
    unpricedFills: 0,
    stoppedAtClose: false,
    // TRA-3976 — no reconcile terminal marker on this OCC, which is what every
    // case written before that ticket means and keeps meaning.
    stoppedAtTermination: false,
    lastTs: Date.parse('2026-08-20T18:02:11Z'),
    enginePlacedContracts: contracts,
    enginePlacedPremiumPaid: premiumPaid,
    enginePlacedUnpricedFills: overrides.unpricedFills ?? 0,
    importedContracts: 0,
    ...overrides,
  };
}

/** A ledger that answers for exactly the symbols given, and `null` for the rest. */
function ledger(bySymbol: Record<string, RecordedEngineOpenBasis>) {
  return (optionSymbol: string): RecordedEngineOpenBasis | null =>
    bySymbol[optionSymbol] ?? null;
}

describe('TRA-3913 — AC1/AC3: the un-accounted-for contracts of an `engine_origin` row', () => {
  it('splits the live XLF row $108.00 engine / $85.00 adopted, leaving `usd` at $193.00', () => {
    const fold = foldOpenPremiumAtRisk(
      [xlfRow()],
      /* armed */ false,
      ledger({ XLF260925C00057500: recorded({ contracts: 1, premiumPaid: 1.08 }) }),
    );

    // AC1 — `usd` is UNCHANGED. The adopted share is CARVED OUT of the row, never
    // subtracted from it, so no cap gets looser by a cent.
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.rows).toBe(1);
    expect(fold.unpricedRows).toBe(0);

    // AC3 — the exact numbers off the live tape.
    expect(fold.adoptedUsd).toBeCloseTo(85.0, 2);
    expect(fold.adoptedRows).toBe(1);

    // The engine-attributable figure, which is what a cap actually wants, and
    // which must land on the engine's OWN fill price rather than the blend.
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(108.0, 2);

    // ⚠ THE ANTI-BLEND ASSERTION. Pricing 1 of 2 contracts at the row's blended
    // 0.965 gives $96.50 — a plausible-looking number that is wrong for BOTH
    // parties at once and is what a naive per-contract split produces. If this
    // ever reads 96.5 the fold has gone back to the broker's average.
    expect(fold.adoptedUsd).not.toBeCloseTo(96.5, 2);

    // It is a FINDING, not a refusal: the oracle answered.
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('reproduces the whole `admin` book: $358.00 total, $273.00 engine, $85.00 desk', () => {
    const bac = xlfRow({
      id: 'bac-1',
      symbol: 'BAC',
      optionSymbol: 'BAC260925C00063000',
      strike: 63,
      contracts: 1,
      contractsRemaining: 1,
      premiumPaid: 1.65,
      currentPremium: 1.65,
      signalId: 'engine-origin-order-142602918',
    });

    const fold = foldOpenPremiumAtRisk(
      [bac, xlfRow()],
      /* armed */ false,
      ledger({
        BAC260925C00063000: recorded({ contracts: 1, premiumPaid: 1.65, orderIds: [142602918] }),
        XLF260925C00057500: recorded({ contracts: 1, premiumPaid: 1.08 }),
      }),
    );

    // The figure the order path gates on — unchanged, to the cent.
    expect(fold.usd).toBeCloseTo(358.0, 2);
    expect(fold.rows).toBe(2);
    // The engine's own fill tape since the book was last flat.
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(273.0, 2);
    expect(fold.adoptedUsd).toBeCloseTo(85.0, 2);
    // ONE row carries desk money. BAC is wholly ours and must not be counted.
    expect(fold.adoptedRows).toBe(1);
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('carries the split in the direction TRA-3890 measured too: a desk add BELOW our fill', () => {
    // TRA-3890's other direction — a desk-side add of 1 BAC at $1.17 blended the
    // engine's $1.65 fill down to a booked $1.41. The engine's share must still
    // price at 1.65, not at the blend, or the desk's cheaper contract silently
    // credits itself against the engine's more expensive one.
    const blended = xlfRow({
      id: 'bac-blended',
      symbol: 'BAC',
      optionSymbol: 'BAC260925C00063000',
      strike: 63,
      contracts: 2,
      contractsRemaining: 2,
      premiumPaid: 1.41, // (1.65 + 1.17) / 2
      currentPremium: 1.41,
    });
    const fold = foldOpenPremiumAtRisk(
      [blended],
      /* armed */ false,
      ledger({ BAC260925C00063000: recorded({ contracts: 1, premiumPaid: 1.65 }) }),
    );
    expect(fold.usd).toBeCloseTo(282.0, 2);
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(165.0, 2); // ours, at OUR price
    expect(fold.adoptedUsd).toBeCloseTo(117.0, 2); // the desk's, at THEIRS
  });
});

describe('TRA-3913 — AC4: the negative control', () => {
  it('a genuine engine top-up covering the whole lot attributes $0 adopted', () => {
    // The SAME symbol, the SAME lot of 2, the SAME `importedFromTradier: true` —
    // the only difference is that the engine's own tape accounts for both
    // contracts. A predicate that is just "imported" wearing a new name reports
    // desk money here, and that is the whole point of this control.
    const fold = foldOpenPremiumAtRisk(
      [xlfRow()],
      /* armed */ false,
      ledger({
        XLF260925C00057500: recorded({
          contracts: 2,
          premiumPaid: 0.965,
          fills: 2,
          orderIds: [142603071, 142603099],
        }),
      }),
    );
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedUsd).toBe(0);
    expect(fold.adoptedRows).toBe(0);
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('a partial-fill top-up that OVERSHOOTS the row still attributes $0, never negative', () => {
    // The oracle's episode window and the row's `contractsRemaining` move
    // independently — a partial CLOSE shrinks the row while the tape still
    // remembers the whole entry. Claiming `min(recorded, remaining)` is what
    // stops the surplus minting negative desk premium.
    const fold = foldOpenPremiumAtRisk(
      [xlfRow({ contractsRemaining: 1 })],
      /* armed */ false,
      ledger({ XLF260925C00057500: recorded({ contracts: 3, premiumPaid: 0.90 }) }),
    );
    expect(fold.usd).toBeCloseTo(96.5, 2);
    expect(fold.adoptedUsd).toBe(0);
    expect(fold.adoptedRows).toBe(0);
  });

  it('an ENGINE-OPENED row is never asked, so a dark ledger cannot strip the paper book', () => {
    // The load-bearing early-out. The fill ledger is LIVE-only, so consulting it
    // for a demo/paper row returns `null` for every one of them — and `null`
    // means ADOPTED (AC2). Without this branch an empty ledger would attribute
    // the ENTIRE book to the desk.
    const engineOpened = xlfRow({
      importedFromTradier: false,
      adoptionAuthority: undefined,
      mode: 'demo',
    });
    const fold = foldOpenPremiumAtRisk([engineOpened], /* armed */ false, () => null);
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedUsd).toBe(0);
    expect(fold.adoptedRows).toBe(0);
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('a SANDBOX import is not asked either — the live ledger cannot answer for it', () => {
    const fold = foldOpenPremiumAtRisk(
      [xlfRow({ tradierEnv: 'sandbox', adoptionAuthority: 'foreign' })],
      /* armed */ false,
      () => null,
    );
    expect(fold.adoptedUsd).toBe(0);
    expect(fold.adoptedRows).toBe(0);
  });
});

describe('TRA-3913 — AC2: `null` from the oracle is NOT permission', () => {
  it('an `engine_origin` row the ledger cannot speak to is wholly ADOPTED, and says so', () => {
    // This is the conservative direction and TRA-3896's own posture: a fail-OPEN
    // reading of exactly this `null` is what put a foreign contract on an engine
    // row to begin with. `null` is "cannot answer", never "bought nothing" and
    // never "it is ours".
    const fold = foldOpenPremiumAtRisk([xlfRow()], /* armed */ false, () => null);
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedRows).toBe(1);
    // …and it is flagged as a REFUSAL, not a finding. Both produce the identical
    // `adoptedUsd`, and only one of them is a fact about the book.
    expect(fold.attributionBlindRows).toBe(1);
  });

  it('an UNPRICEABLE fill in the episode refuses too — a partial average is not an answer', () => {
    const fold = foldOpenPremiumAtRisk(
      [xlfRow()],
      /* armed */ false,
      ledger({
        XLF260925C00057500: recorded({ contracts: 1, premiumPaid: 1.08, unpricedFills: 1, fills: 2 }),
      }),
    );
    expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
    expect(fold.attributionBlindRows).toBe(1);
  });

  it('a row with no OCC symbol is unaskable, and unaskable routes to ADOPTED', () => {
    const fold = foldOpenPremiumAtRisk(
      [xlfRow({ optionSymbol: undefined as unknown as string })],
      /* armed */ false,
      ledger({ XLF260925C00057500: recorded() }),
    );
    expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
    expect(fold.attributionBlindRows).toBe(1);
  });

  it('a NaN contract count from the oracle refuses rather than landing in the ACCEPTED branch', () => {
    // TRA-3486's shape: `x <= 0` does not refuse NaN but `!(x > 0)` does, and a
    // NaN contract count reads as a number until something compares it.
    const fold = foldOpenPremiumAtRisk(
      [xlfRow()],
      /* armed */ false,
      ledger({ XLF260925C00057500: recorded({ contracts: Number.NaN }) }),
    );
    expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
    expect(fold.attributionBlindRows).toBe(1);
  });
});

describe('TRA-3913 — the split is decoupled from the ACTION arm', () => {
  it('arming the exit path does not reclassify the desk`s premium as engine spend', () => {
    const args = [xlfRow()] as const;
    const oracle = ledger({ XLF260925C00057500: recorded({ contracts: 1, premiumPaid: 1.08 }) });
    const disarmed = foldOpenPremiumAtRisk([...args], /* armed */ false, oracle);
    const armed = foldOpenPremiumAtRisk([...args], /* armed */ true, oracle);
    // `ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS` answers "may the engine EXIT
    // the desk's position". It says nothing about who bought it, and after
    // TRA-3911 letting it move this number would hand the desk the board's entry
    // authorization to spend.
    expect(armed).toEqual(disarmed);
    expect(armed.adoptedUsd).toBeCloseTo(85.0, 2);
  });

  it('a `foreign` row stays wholly the desk`s whether the engine may exit it or not', () => {
    const foreign = xlfRow({ adoptionAuthority: 'foreign', signalId: 'tradier-import' });
    for (const armed of [false, true]) {
      const fold = foldOpenPremiumAtRisk([foreign], armed, ledger({}));
      expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
      expect(fold.adoptedRows).toBe(1);
      // NOT blind: the authority answered, so the oracle was never consulted.
      // This is the column that separates "the desk owns it" from "we cannot
      // vouch for anything", and they must never be the same reading.
      expect(fold.attributionBlindRows).toBe(0);
    }
  });
});

describe('TRA-3913 — `splitEngineExposureContracts` is total over its input space', () => {
  const cases: Array<[string, Parameters<typeof splitEngineExposureContracts>[0], number,
    RecordedEngineOpenBasis | null, { engine: number; adopted: number; reason: string }]> = [
    ['engine-opened', { importedFromTradier: false }, 2, null,
      { engine: 2, adopted: 0, reason: 'not_imported' }],
    ['imported flag ABSENT (older build)', {}, 2, null,
      { engine: 2, adopted: 0, reason: 'not_imported' }],
    ['sandbox import', { importedFromTradier: true, tradierEnv: 'sandbox' }, 2, null,
      { engine: 2, adopted: 0, reason: 'sandbox_import' }],
    ['authority ABSENT on a production import',
      { importedFromTradier: true, tradierEnv: 'production' }, 2, recorded(),
      { engine: 0, adopted: 2, reason: 'foreign_authority' }],
    ['authority `unresolved`',
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'unresolved' }, 2,
      recorded(), { engine: 0, adopted: 2, reason: 'foreign_authority' }],
    ['tradierEnv ABSENT is GUARDED, not exempted',
      { importedFromTradier: true, adoptionAuthority: 'engine_origin' }, 2, null,
      { engine: 0, adopted: 2, reason: 'oracle_silent' }],
    ['engine_origin, fully accounted',
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'engine_origin' },
      2, recorded({ contracts: 2 }), { engine: 2, adopted: 0, reason: 'engine_accounted' }],
    ['engine_origin, partly accounted — the live row',
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'engine_origin' },
      2, recorded({ contracts: 1 }), { engine: 1, adopted: 1, reason: 'engine_partial' }],
  ];

  for (const [name, row, remaining, answer, want] of cases) {
    it(`${name} ⇒ ${want.reason}`, () => {
      const got = splitEngineExposureContracts(row, remaining, () => answer);
      expect(got.engineContracts).toBe(want.engine);
      expect(got.adoptedContracts).toBe(want.adopted);
      expect(got.reason).toBe(want.reason);
      // The two shares always sum back to the row. If they ever do not, `usd`
      // and the split have started telling different stories about one position.
      expect(got.engineContracts + got.adoptedContracts).toBe(remaining);
    });
  }

  it('a non-finite `remaining` collapses to zero rather than propagating NaN', () => {
    const got = splitEngineExposureContracts(
      { importedFromTradier: false }, Number.NaN, () => null,
    );
    expect(got.engineContracts).toBe(0);
    expect(got.adoptedContracts).toBe(0);
  });

  it('the oracle is NOT consulted on the two early-out branches', () => {
    // Lazy on purpose: rule 1 must not even be ABLE to read an answer it would
    // have to discard, because the answer for a paper row is a `null` that means
    // ADOPTED everywhere else in this function.
    let asked = 0;
    const lookup = () => { asked += 1; return null; };
    splitEngineExposureContracts({ importedFromTradier: false }, 1, lookup);
    splitEngineExposureContracts({ importedFromTradier: true, tradierEnv: 'sandbox' }, 1, lookup);
    splitEngineExposureContracts(
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign' },
      1, lookup,
    );
    expect(asked).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE 2026-08-21 REGRESSION — THE FIX WAS CORRECT AND THE DATA MOVED UNDER IT.
//
// `1f1264df` graded 12/12 PASS on live bytes at 03:07Z with the XLF row split
// $108.00 engine / $85.00 desk. At 13:26Z the SAME build on the SAME pid (73,
// uptime 37,409s — no deploy, no restart, no code change) served:
//
//     admin  openPremiumAtRiskUsd 358.00  adoptedPremiumAtRiskUsd 0.00
//            adoptedOpenRows 0  adoptedAttributionBlindRows 0
//
// i.e. exactly the pre-fix reading. Overnight the TRA-2959 reconcile had
// imported the two contracts NO chokepoint of ours recorded — the desk's — and
// `/api/health/live-options-fee-slippage` `records[]` then held FOUR rows for
// the two open OCCs:
//
//   XLF260925C00057500  1 @ 1.08  oid 142603071  origin 'fill'            OURS
//   XLF260925C00057500  1 @ 0.85  oid null       origin 'history_import'  DESK'S
//   BAC260925C00063000  1 @ 1.65  oid 142603649  origin 'fill'            OURS
//   BAC260925C00063000  1 @ 1.17  oid null       origin 'history_import'  DESK'S
//
// `recordedEngineOpenBasis` counted all of them, answered `contracts: 2` for
// XLF, and the split handed the engine a contract it did not buy.
//
// ⭐ THE LESSON THIS SUITE ENCODES: an oracle that INGESTS the broker's record
// of somebody else's trade cannot answer a PROVENANCE question. The importer is
// a legitimate feature (TRA-2959: 7 of 11 filled orders never reached the
// ledger) — it just does not produce evidence about who placed the order, and
// nothing in the ledger's shape said so until it silently un-fixed a graded
// ticket on real money.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3913 regression — a `history_import` row is not evidence that WE bought it', () => {
  const XLF = 'XLF260925C00057500';
  const BAC = 'BAC260925C00063000';
  const FILL_TS = 1_787_232_930_535; // the engine's real XLF fill, 2026-08-20
  const IMPORT_TS = 1_787_245_200_000; // 17:00Z-stamped, i.e. AFTER ours

  beforeEach(() => {
    // Module-global store — a leaked row from another test would make this
    // oracle look healthy and grade the wrong branch.
    clearLiveOptionsFeeSlippageLedger();
  });

  /** The live tape, replayed exactly: ours first, the importer's appended after. */
  function replayLiveTape(): void {
    recordLiveOptionFill({
      ts: FILL_TS, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: 1.08, orderId: 142603071, origin: 'fill',
    });
    recordLiveOptionFill({
      ts: IMPORT_TS, etDay: '2026-08-20', sleeve: 'unattributed', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: 0.85, orderId: null, origin: 'history_import',
    });
  }

  it('CONTROL — the wide count IS 2, which is what un-fixed the live book', () => {
    replayLiveTape();
    const basis = recordedEngineOpenBasis(XLF, null)!;
    // This is not a bug in `contracts`: two contracts of this OCC really are
    // open at the broker, and a RISK reader wants that. The defect was reading
    // it as an answer to "did WE buy them".
    expect(basis.contracts).toBe(2);
    expect(basis.premiumPaid).toBeCloseTo(0.965, 10); // the broker's blend, to the cent
  });

  it('scopes the engine share to the rows we PLACED: 1 @ 1.08, with 1 imported', () => {
    replayLiveTape();
    const basis = recordedEngineOpenBasis(XLF, null)!;
    expect(basis.enginePlacedContracts).toBe(1);
    expect(basis.enginePlacedPremiumPaid).toBeCloseTo(1.08, 10);
    expect(basis.enginePlacedUnpricedFills).toBe(0);
    expect(basis.importedContracts).toBe(1);
    // The two scopes account for the same episode and nothing falls between them.
    expect(basis.enginePlacedContracts + basis.importedContracts).toBe(basis.contracts);
  });

  it('restores the live reading end-to-end: $193.00 total, $108.00 ours, $85.00 desk', () => {
    replayLiveTape();
    // The REAL oracle, not an injected fake — this is the whole point of the
    // case. The fold's default argument IS `recordedEngineOpenBasis`, so this
    // exercises the exact path bqb1 runs.
    const fold = foldOpenPremiumAtRisk([xlfRow()]);
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedUsd).toBeCloseTo(85.0, 2);
    expect(fold.adoptedRows).toBe(1);
    // A FINDING, not a refusal: the engine's own fill answered for 1 of 2.
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('the whole `admin` book comes back to $358.00 = $273.00 engine + $85.00 desk', () => {
    replayLiveTape();
    // BAC as bqb1 holds it: an ENGINE-OPENED 1-lot row (not imported), so rule 1
    // returns wholly-engine and the desk's BAC contract is drift, not this row's.
    recordLiveOptionFill({
      ts: FILL_TS + 53_038, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: BAC,
      side: 'buy_to_open', contracts: 1, filledPrice: 1.65, orderId: 142603649, origin: 'fill',
    });
    recordLiveOptionFill({
      ts: IMPORT_TS, etDay: '2026-08-20', sleeve: 'unattributed', optionSymbol: BAC,
      side: 'buy_to_open', contracts: 1, filledPrice: 1.17, orderId: null, origin: 'history_import',
    });
    const bac = xlfRow({
      id: 'bac-1', symbol: 'BAC', optionSymbol: BAC, strike: 63,
      contracts: 1, contractsRemaining: 1, premiumPaid: 1.65, currentPremium: 1.65,
      importedFromTradier: false, adoptionAuthority: undefined,
      signalId: 'engine-origin-order-142602918',
    });

    const fold = foldOpenPremiumAtRisk([bac, xlfRow()]);
    expect(fold.usd).toBeCloseTo(358.0, 2); // the gated figure — untouched
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(273.0, 2);
    expect(fold.adoptedUsd).toBeCloseTo(85.0, 2);
    expect(fold.adoptedRows).toBe(1);
  });

  it('an episode of NOTHING BUT imports is a REFUSAL, not a finding', () => {
    // The ledger can say the contracts exist; it cannot say they are ours. Not
    // pedantry — 30-day retention or a lost DATA_DIR leaves exactly this state
    // on a row the engine really did open, so publishing it as a measurement of
    // desk money would be a fabrication in the other direction.
    recordLiveOptionFill({
      ts: IMPORT_TS, etDay: '2026-08-20', sleeve: 'unattributed', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 2, filledPrice: 0.965, orderId: null,
      origin: 'history_import',
    });
    const basis = recordedEngineOpenBasis(XLF, null)!;
    expect(basis.enginePlacedContracts).toBe(0);
    expect(basis.importedContracts).toBe(2);

    const split = splitEngineExposureContracts(
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'engine_origin' },
      2,
      () => basis,
    );
    expect(split.reason).toBe('oracle_import_only');
    expect(split.oracleRefused).toBe(true);
    expect(split.adoptedContracts).toBe(2);

    const fold = foldOpenPremiumAtRisk([xlfRow()]);
    expect(fold.usd).toBeCloseTo(193.0, 2); // still no cap moves
    expect(fold.adoptedUsd).toBeCloseTo(193.0, 2);
    // ⭐ AND IT SAYS SO. A conservative attribution published as a measurement is
    // the failure this column exists to prevent: "$193.00 of desk money" and "we
    // cannot vouch for $193.00" are the same dollars, and only one of them is a
    // fact about the book.
    expect(fold.attributionBlindRows).toBe(1);
  });

  it('AC4 SURVIVES — a genuine engine top-up covering the lot still attributes $0', () => {
    // The negative control, re-run against the REAL ledger. Two engine-placed
    // fills, no import: a predicate that had become "any import row anywhere
    // poisons the row" would report desk money here.
    recordLiveOptionFill({
      ts: FILL_TS, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: 1.08, orderId: 142603071, origin: 'fill',
    });
    recordLiveOptionFill({
      ts: FILL_TS + 900, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: 0.85, orderId: 142603099, origin: 'fill',
    });
    const fold = foldOpenPremiumAtRisk([xlfRow()]);
    expect(fold.usd).toBeCloseTo(193.0, 2);
    expect(fold.adoptedUsd).toBe(0);
    expect(fold.adoptedRows).toBe(0);
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('an UNPRICED import does not spoil an answer about contracts we DID place', () => {
    // Scoping the refusal matters as much as scoping the count: refusing on the
    // episode-wide `unpricedFills` would hand the desk a whole engine row every
    // time the importer recovered one unpriced broker leg.
    recordLiveOptionFill({
      ts: FILL_TS, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: 1.08, orderId: 142603071, origin: 'fill',
    });
    recordLiveOptionFill({
      ts: IMPORT_TS, etDay: '2026-08-20', sleeve: 'unattributed', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 1, filledPrice: null, orderId: null,
      origin: 'history_import',
    });
    const basis = recordedEngineOpenBasis(XLF, null)!;
    expect(basis.unpricedFills).toBe(1); // episode-wide: yes
    expect(basis.enginePlacedUnpricedFills).toBe(0); // about OUR fills: no

    const fold = foldOpenPremiumAtRisk([xlfRow()]);
    expect(fold.adoptedUsd).toBeCloseTo(85.0, 2);
    expect(fold.attributionBlindRows).toBe(0);
  });

  it('a pre-TRA-2959 row with NO origin on disk still counts as ours', () => {
    // `recordLiveOptionFill` defaults a missing origin to 'fill' because every
    // row written before the importer existed was one of ours. The predicate is
    // `!== 'history_import'` for that reason: only the thing that demonstrably
    // writes somebody else's trade is excluded, and an unrecognised tag lands on
    // the side that fails closed for the PROVENANCE readers (TRA-2820).
    recordLiveOptionFill({
      ts: FILL_TS, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: XLF,
      side: 'buy_to_open', contracts: 2, filledPrice: 0.965, orderId: 142603071,
    });
    const basis = recordedEngineOpenBasis(XLF, null)!;
    expect(basis.enginePlacedContracts).toBe(2);
    expect(basis.importedContracts).toBe(0);
  });
});
