import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import {
  boundExitContractsToEngineShare,
  splitEngineExposureContracts,
} from './option-exec-flag.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  recordReconcileTermination,
  reconcileTerminations,
  backfillReconcileTerminationsFromJournal,
  recordedEngineOpenBasis,
  engineNetOpenContracts,
  lastRecordedOpenFill,
  lastRecordedOpenSleeve,
  openEpisodeWindow,
  phantomOpenEpisodeCensus,
  summarizeLiveOptionsFeeSlippage,
  type LiveFillOrigin,
  type LiveFillSide,
  type LiveFillSleeve,
} from './live-options-fee-slippage-ledger.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3976 — A CLOSE THE FILL LEDGER NEVER SAW LEFT A PHANTOM OPEN EPISODE.
//
// ── The live event, real money ──────────────────────────────────────────────
//   SOFI260925C00019000   buy_to_open  1 @1.23  origin='fill'  oid=142828896
//                         2026-08-21T14:24:10.277Z, sleeve single_leg_otm
//   … closed AT THE BROKER, out of band. On 2026-08-24T13:34:55.545Z the
//   reconcile saw the OCC gone from /positions and dropped the local row
//   (journal 34f1ee99, exitReason 'broker_reconcile', brokerOrderId null).
//
// **No `sell_to_close` was ever written to the ledger** — there was no fill of
// ours to write. So the ledger held exactly one SOFI row, the open, and the
// episode walk went on reporting it OPEN, 1 contract, basis $123.00.
//
// Three oracles read that phantom, in three different directions:
//   READER    `recordedEngineOpenBasis`  → 1 contract  ⇒ the at-risk fold
//             credits the ENGINE with a contract it does not hold the moment
//             any SOFI row returns to the book (TRA-3913's defect, entering
//             through the OVER-count door that fix does not close).
//   PROVENANCE `ledgerOpenProvenance`    → engine/single_leg_otm ⇒ a returning
//             desk contract is stamped `adoptionAuthority: 'engine_origin'`.
//   WRITER    `engineNetOpenContracts`   → engineNetContracts 1 ⇒ the exit
//             bound PERMITS selling it. TRA-3926's over-sell, seeded.
//
// ── Why these cases are over the REAL ledger module ─────────────────────────
// Same reason as TRA-3918's suite: the defect is a property of the WALK over
// real rows, and a suite that injects a double grades the double. Every case
// below writes real rows and real markers into the real module and drives the
// real oracles, the real provenance path (`reconcileTradierPositions`) and the
// real drop site (`closeBrokerFlatPosition`).
//
// ── Negative control, and it is AC4 ─────────────────────────────────────────
// A "refuse everything" fix passes AC1–AC3 trivially and is the TRA-2820
// regression wearing a new name. `AC4` below pins the two shapes a marker must
// NOT silence: a genuine engine PARTIAL close (remainder still held), and an
// engine RE-ENTRY after a drop. Both must still answer.
// ─────────────────────────────────────────────────────────────────────────────

const SOFI = 'SOFI260925C00019000';
const BAC = 'BAC260925C00063000';
const OPEN_TIME = Date.parse('2026-08-21T14:24:10.277Z');
const DROP_TIME = Date.parse('2026-08-24T13:34:55.545Z');

let seq = 0;

/** Append one real row to the real ledger, the way a live fill does. */
function record(
  side: LiveFillSide,
  contracts: number,
  opts: {
    optionSymbol?: string;
    sleeve?: LiveFillSleeve;
    filledPrice?: number | null;
    orderId?: number | null;
    origin?: LiveFillOrigin;
    /** ms after {@link OPEN_TIME}; defaults to monotonic append order. */
    at?: number;
  } = {},
): void {
  seq += 1;
  const at = OPEN_TIME + (opts.at ?? seq * 60_000);
  recordLiveOptionFill({
    ts: at,
    etDay: '2026-08-21',
    sleeve: opts.sleeve ?? 'single_leg_otm',
    optionSymbol: opts.optionSymbol ?? SOFI,
    side,
    contracts,
    filledPrice: opts.filledPrice ?? (side === 'buy_to_open' ? 1.23 : 0.865),
    orderId: opts.orderId ?? 142_828_896 + seq,
    origin: opts.origin,
  });
}

/** The marker the reconcile writes as it drops the row. */
function markDropped(optionSymbol = SOFI, contracts = 1, at = DROP_TIME): boolean {
  return recordReconcileTermination({
    ts: at,
    etDay: '2026-08-24',
    optionSymbol,
    contractsDropped: contracts,
    positionId: 'opt-sofi-19c',
    source: 'broker_flat_reconcile',
  });
}

/** THE LIVE ROW, exactly: one `buy_to_open 1 @1.23`, no close, then the drop. */
function sofiPhantomShape(): void {
  record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
  markDropped();
}

beforeEach(() => {
  seq = 0;
  clearLiveOptionsFeeSlippageLedger();
});
afterEach(() => {
  clearLiveOptionsFeeSlippageLedger();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 AC3 — THIS row, exactly: the oracle must not answer `contracts: 1`', () => {
  it('PRE-FIX shape (no marker) reproduces the phantom — the control for every case below', () => {
    // Without the marker the ledger is in the state bqb1 was in on 2026-08-24.
    // Asserted rather than assumed: a fix graded only against its own fixture
    // cannot tell "the marker works" from "the shape never had the defect".
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });

    expect(openEpisodeWindow(SOFI).status).toBe('open');
    expect(recordedEngineOpenBasis(SOFI)?.contracts).toBe(1);
    expect(recordedEngineOpenBasis(SOFI)?.costBasisUsd).toBeCloseTo(123, 5);
    expect(engineNetOpenContracts(SOFI).engineNetContracts).toBe(1);
  });

  it('the READER refuses: `recordedEngineOpenBasis` returns null, not 1 contract at $123', () => {
    sofiPhantomShape();

    const basis = recordedEngineOpenBasis(SOFI);
    // Name the specific wrong answer, not just `null`: `toBeNull()` alone would
    // pass for a walk broken in some new way too.
    expect(basis?.contracts).not.toBe(1);
    expect(basis?.costBasisUsd).not.toBe(123);
    expect(basis).toBeNull();
  });

  it('the EPISODE is a REFUSAL, not a count and not `flat`', () => {
    sofiPhantomShape();

    const window = openEpisodeWindow(SOFI);
    expect(window.status).toBe('indeterminate');
    expect(window.reason).toBe('reconcile_terminal');
    expect(window.netContracts).toBe(0);
    expect(window.fills).toEqual([]);
    expect(window.terminations).toBe(1);
    // ⛔ NOT `flat`. `flat` is a FINDING ("we opened it and our own records
    // closed it out") and the write path is entitled to act on a finding. The
    // close is exactly the thing we have no record of.
    expect(window.status).not.toBe('flat');
  });

  it('the WRITER refuses: the exit bound stages 0, and does NOT go blind', () => {
    sofiPhantomShape();

    const row = {
      importedFromTradier: true,
      adoptionAuthority: 'engine_origin',
      tradierEnv: 'production',
    };
    const bound = boundExitContractsToEngineShare(
      row,
      1,
      1,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );

    expect(bound.exitContracts).toBe(0);
    expect(bound.refusedContracts).toBe(1);
    expect(bound.reason).toBe('reconcile_terminal');
    expect(bound.bounded).toBe(true);
    // ⛔ The whole point of the branch. `blind: true` is the PRE-FIX behaviour
    // and it submits `sell_to_close 1` against a position the broker already
    // reports gone.
    expect(bound.blind).toBe(false);
    // It is a FINDING about our own book, not "somebody look at the ledger":
    // the remedy is "find out who closed this at the broker".
    expect(bound.oracleRefused).toBe(false);
  });

  it('the pre-fix WRITER answer is pinned as the thing that must not come back', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    const unmarked = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      1,
      1,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );
    // Without the marker the engine would sell the phantom contract.
    expect(unmarked.exitContracts).toBe(1);

    markDropped();
    const marked = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      1,
      1,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );
    expect(marked.exitContracts).toBe(0);
  });

  it('the ATTRIBUTION fold routes the row to ADOPTED, not to the engine', () => {
    sofiPhantomShape();

    const split = splitEngineExposureContracts(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      1,
      () => recordedEngineOpenBasis(SOFI),
    );
    expect(split.engineContracts).toBe(0);
    expect(split.adoptedContracts).toBe(1);
    expect(split.oracleRefused).toBe(true);
    // The reader's refusal routes conservatively (over-states the desk's share
    // and moves no cap) — unchanged, and it is why the WRITER needed its own
    // branch rather than inheriting this one.
    expect(split.recordedPremiumPaid).toBeNull();
  });

  it('the POINT oracles stop answering too', () => {
    sofiPhantomShape();
    expect(lastRecordedOpenFill(SOFI)).toBeNull();
    expect(lastRecordedOpenSleeve(SOFI)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 AC4 — the negative controls: this is not "refuse everything"', () => {
  it('a GENUINE engine partial close still answers with the remainder', () => {
    // The exact regression TRA-3926 AC2 hit against the TRA-2820 suite: an
    // engine position we bought 3 of and sold 1 of. No marker is written — the
    // reconcile never dropped anything — and every oracle must still answer.
    record('buy_to_open', 3, { filledPrice: 1.23, orderId: 140028461, at: 0 });
    record('sell_to_close', 1, { at: 60_000 });

    const window = openEpisodeWindow(SOFI);
    expect(window.status).toBe('open');
    expect(window.netContracts).toBe(2);
    expect(window.terminations).toBe(0);

    const net = engineNetOpenContracts(SOFI);
    expect(net.status).toBe('open');
    expect(net.engineOpenContracts).toBe(3);
    expect(net.closedContracts).toBe(1);
    expect(net.engineNetContracts).toBe(2);

    const bound = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      2,
      2,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );
    expect(bound.exitContracts).toBe(2);
    expect(bound.refusedContracts).toBe(0);
  });

  it('an ENGINE RE-ENTRY after a drop opens a NEW episode the marker does not touch', () => {
    // The stranding shape, and the one that would make this fix worse than the
    // defect: an OCC we were dropped out of, that the engine then legitimately
    // re-bought. The re-entry writes its own `buy_to_open`, so the episode
    // re-opens and the engine keeps the ability to exit its own new position.
    sofiPhantomShape();
    expect(openEpisodeWindow(SOFI).reason).toBe('reconcile_terminal');

    record('buy_to_open', 2, {
      filledPrice: 0.9,
      orderId: 143000111,
      sleeve: 'single_leg_rv',
      at: DROP_TIME - OPEN_TIME + 3_600_000,
    });

    const window = openEpisodeWindow(SOFI);
    expect(window.status).toBe('open');
    expect(window.netContracts).toBe(2);
    expect(window.fills.map((f) => f.orderId)).toEqual([143000111]); // episode A is GONE
    expect(window.reason).toBeNull();

    expect(recordedEngineOpenBasis(SOFI)?.contracts).toBe(2);
    expect(recordedEngineOpenBasis(SOFI)?.stoppedAtTermination).toBe(true);
    expect(lastRecordedOpenSleeve(SOFI)).toBe('single_leg_rv');

    const bound = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      2,
      2,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );
    expect(bound.exitContracts).toBe(2);
    expect(bound.reason).toBe('engine_accounted');
  });

  it('a re-entry that is then closed CLEANLY ends `flat`, not stuck on the old refusal', () => {
    sofiPhantomShape();
    record('buy_to_open', 1, { at: DROP_TIME - OPEN_TIME + 3_600_000 });
    record('sell_to_close', 1, { at: DROP_TIME - OPEN_TIME + 7_200_000 });

    // The termination is history. Answering `reconcile_terminal` here would be
    // a refusal about an episode that ended for a different, known reason.
    expect(openEpisodeWindow(SOFI).status).toBe('flat');
    expect(openEpisodeWindow(SOFI).reason).toBeNull();
  });

  it('a marker on a symbol the ledger has already flattened does NOT downgrade the finding', () => {
    // Idempotence against the importer: once the history importer recovers the
    // broker-side close, the ledger accounts for the OCC honestly and the
    // marker must step out of the way. This is how the refusal self-heals.
    record('buy_to_open', 1, { at: 0 });
    record('sell_to_close', 1, { at: 60_000 });
    markDropped();

    const window = openEpisodeWindow(SOFI);
    expect(window.status).toBe('flat');
    expect(window.reason).toBeNull();
    expect(window.terminations).toBe(1); // still counted — the marker is not hidden
  });

  it('markers never leak across OCC symbols', () => {
    record('buy_to_open', 1, { optionSymbol: BAC, orderId: 777, at: 0 });
    sofiPhantomShape();

    expect(openEpisodeWindow(SOFI).reason).toBe('reconcile_terminal');
    expect(openEpisodeWindow(BAC).status).toBe('open');
    expect(engineNetOpenContracts(BAC).engineNetContracts).toBe(1);
  });

  it('the master-arm HAND-OVER carve-out still overrides (TRA-3829 ruling B is unchanged)', () => {
    // A human handing a specific broker row to the engine grants FULL
    // management, which necessarily includes selling contracts the engine never
    // bought. This branch is asked before any oracle and must stay that way.
    sofiPhantomShape();
    const bound = boundExitContractsToEngineShare(
      {
        importedFromTradier: true,
        adoptionAuthority: 'engine_origin',
        tradierEnv: 'production',
        // `grantedAt` is an ISO STRING — `hasEngineHandover` refuses a number.
        engineHandover: { grantedAt: new Date(DROP_TIME).toISOString(), grantedBy: 'admin' },
      },
      1,
      1,
      () => recordedEngineOpenBasis(SOFI),
      true,
      () => engineNetOpenContracts(SOFI),
    );
    expect(bound.reason).toBe('handed_over');
    expect(bound.exitContracts).toBe(1);
  });

  it('TRA-2820 is untouched: an OCC with NO ledger rows at all still goes BLIND', () => {
    // "The ledger holds nothing for this OCC" is an ABSENCE, and binding on an
    // absence is how the strict reading of TRA-3926 AC2 re-creates TRA-2820 —
    // 8 live contracts, $216 of real premium, unstopped for a session. The new
    // branch must not widen onto it.
    const bound = boundExitContractsToEngineShare(
      { importedFromTradier: true, adoptionAuthority: 'engine_origin', tradierEnv: 'production' },
      2,
      2,
      () => recordedEngineOpenBasis(SOFI),
      false,
      () => engineNetOpenContracts(SOFI),
    );
    expect(bound.blind).toBe(true);
    expect(bound.exitContracts).toBe(2);
    expect(bound.reason).toBe('oracle_silent');
  });

  it('a marker with NO opens behind it is still `no_record`, not a refusal', () => {
    // Retention aged the opens out, or no chokepoint ever recorded them. That
    // is `no_record`'s question and `recordedOpenFillCount` is still its
    // discriminator; converting it into a finding about a drop would be a guess.
    markDropped();
    expect(openEpisodeWindow(SOFI).status).toBe('no_record');
    expect(openEpisodeWindow(SOFI).reason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 AC1 — the marker is written by the RECONCILE, at drop time', () => {
  const AGED = DROP_TIME - 6 * 60 * 60 * 1000;

  function engineRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: 'opt-sofi-19c',
      symbol: 'SOFI',
      optionSymbol: SOFI,
      optionType: 'call',
      strike: 19,
      expiration: '2026-09-25',
      contracts: 1,
      contractsRemaining: 1,
      premiumPaid: 1.23,
      currentPremium: 0.865,
      tp1Premium: 2.46,
      tp1Hit: false,
      stopLossPremium: 0.615,
      peakPremium: 1.23,
      trailingActive: false,
      underlyingEntryPrice: 19.4,
      openedAt: AGED,
      signalId: 'sig-otm-1',
      signalType: 'otm_mispricing',
      mode: 'live',
      tradierEnv: 'production',
      ...overrides,
    } as OptionPosition;
  }

  function seed(rows: OptionPosition[]): PaperOptionsAccount {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    const debited = rows.reduce((s, r) => s + r.premiumPaid * r.contracts * 100, 0);
    acct.importSnapshot({
      openOptions: rows,
      closedOptions: [],
      optionsPnl: 0,
      optionsPnlByMode: { demo: 0, live: 0 },
      dailyCount: 1,
      currentDayKey: '2026-08-24',
      cash: 20_000 - debited,
      equity: 25_000,
    });
    return acct;
  }

  it('closing a broker-flat row the ledger reports OPEN writes exactly one marker', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    expect(openEpisodeWindow(SOFI).status).toBe('open');

    const acct = seed([engineRow()]);
    const closed = acct.closeBrokerFlatPosition('opt-sofi-19c', 'broker flat');
    expect(closed).not.toBeNull();

    const markers = reconcileTerminations();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.optionSymbol).toBe(SOFI);
    expect(markers[0]!.contractsDropped).toBe(1);
    expect(markers[0]!.positionId).toBe('opt-sofi-19c');
    expect(markers[0]!.source).toBe('broker_flat_reconcile');

    // And the phantom is gone, through the real drop path.
    expect(openEpisodeWindow(SOFI).reason).toBe('reconcile_terminal');
    expect(recordedEngineOpenBasis(SOFI)).toBeNull();
  });

  it('the marker is NOT a fill: `records[]`, `closes` and the slippage set are untouched', () => {
    // ⛔ The containment that makes this safe. A `sell_to_close` row here would
    // be a FABRICATED FILL — no price, no order id, no quote — and it would leak
    // into `detectOversoldEngineCloses`, into the history-coverage diff, and
    // into the fee reconcile's join.
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-sofi-19c', 'broker flat');

    const summary = summarizeLiveOptionsFeeSlippage();
    expect(summary.n).toBe(1);
    expect(summary.opens).toBe(1);
    expect(summary.closes).toBe(0);
    expect(summary.records.filter((r) => r.side === 'sell_to_close')).toHaveLength(0);
    // Published beside `records`, so a reader can still see it.
    expect(summary.reconcileTerminations).toHaveLength(1);
  });

  it('a broker-flat close on a symbol the ledger does NOT report open writes nothing', () => {
    // A marker for an episode the ledger has already closed is noise in a census
    // whose whole value is that its normal reading is zero.
    const acct = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-sofi-19c', 'broker flat');
    expect(reconcileTerminations()).toHaveLength(0);
  });

  it('the marker write is idempotent per (symbol, ts, positionId)', () => {
    record('buy_to_open', 1, { at: 0 });
    expect(markDropped()).toBe(true);
    expect(markDropped()).toBe(false);
    expect(reconcileTerminations()).toHaveLength(1);
  });

  it('does not restate cash or realized P&L — TRA-2801 break-even accounting is unchanged', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    const acct = seed([engineRow()]);
    const cashBefore = acct.getStateForMode('live').optionsCash;
    acct.closeBrokerFlatPosition('opt-sofi-19c', 'broker flat');
    // Refund exactly the premium the open debited; $0 realized.
    expect(acct.getStateForMode('live').optionsCash - cashBefore).toBeCloseTo(123, 5);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 AC2 — provenance: UNCLASSIFIED, not `foreign` and not ours', () => {
  function buildImport(
    overrides: Partial<TradierOpenOptionPosition> = {},
  ): TradierOpenOptionPosition {
    return {
      optionSymbol: SOFI,
      underlying: 'SOFI',
      optionType: 'call',
      strike: 19,
      expiration: '2026-09-25',
      contracts: 1,
      premiumPaid: 1.05,
      acquiredAt: DROP_TIME + 3_600_000,
      ...overrides,
    } as TradierOpenOptionPosition;
  }

  /** A live account on the REAL default provenance oracle — no test double. */
  function adoptedRow(): OptionPosition {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    return acct.getState().openOptions[0]!;
  }

  it('a SOFI row returning to the book is NOT stamped `engine_origin`', () => {
    sofiPhantomShape();

    const row = adoptedRow();
    // Pre-fix this read `engine_origin` off the phantom episode, and from there
    // the fold spends the engine's entry budget on the desk's premium and the
    // exit bound treats the row as ours to sell.
    expect(row.adoptionAuthority).not.toBe('engine_origin');
    expect(row.adoptionAuthority).toBe('unresolved');
    expect(row.riskUnmanagedReason).toBe('provenance_unresolved');
  });

  it('and NOT `foreign` either — we know our position left, not who owns what came back', () => {
    // The finding-shaped reading ("the broker went flat, so this is the desk's")
    // is the TRA-2820 direction: a contract we really did place, whose fill no
    // chokepoint recorded, would be handed the import sentinel with no stop.
    sofiPhantomShape();
    expect(adoptedRow().adoptionAuthority).not.toBe('foreign');
  });

  it('an UNMARKED open episode still stamps `engine_origin` (the fix did not widen)', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    const row = adoptedRow();
    expect(row.adoptionAuthority).toBe('engine_origin');
    expect(row.engineOriginSleeve).toBe('single_leg_otm');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 — the back-fill for drops that predate the marker', () => {
  /** The live journal row: 34f1ee99, SOFI, broker_reconcile, 13:34:55.545Z. */
  const journalRow = (overrides: Record<string, unknown> = {}) => ({
    id: '34f1ee99',
    mode: 'live',
    optionSymbol: SOFI,
    contracts: 1,
    closeTs: DROP_TIME,
    exitReason: 'broker_reconcile',
    ...overrides,
  });

  it('marks the SOFI phantom off OUR OWN journal row', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    expect(openEpisodeWindow(SOFI).status).toBe('open');

    const r = backfillReconcileTerminationsFromJournal([journalRow()]);
    expect(r).toEqual({
      candidates: 1,
      unaskable: 0,
      alreadyAccounted: 0,
      duplicates: 0,
      written: 1,
    });
    expect(openEpisodeWindow(SOFI).reason).toBe('reconcile_terminal');
    expect(recordedEngineOpenBasis(SOFI)).toBeNull();
    expect(engineNetOpenContracts(SOFI).engineNetContracts).toBe(0);
  });

  it('is idempotent across reruns', () => {
    record('buy_to_open', 1, { at: 0 });
    expect(backfillReconcileTerminationsFromJournal([journalRow()]).written).toBe(1);
    const second = backfillReconcileTerminationsFromJournal([journalRow()]);
    // The OCC is no longer reported open, so the second pass has nothing to do —
    // and even if it wrote, the (symbol, ts, positionId) dedupe would catch it.
    expect(second.written).toBe(0);
    expect(reconcileTerminations()).toHaveLength(1);
  });

  it('ignores every close that is not a live `broker_reconcile`', () => {
    record('buy_to_open', 1, { at: 0 });
    const r = backfillReconcileTerminationsFromJournal([
      journalRow({ exitReason: 'chandelier' }),
      journalRow({ exitReason: 'trail' }),
      journalRow({ mode: 'demo' }),
      journalRow({ exitReason: 'stop' }),
    ]);
    expect(r.candidates).toBe(0);
    expect(r.written).toBe(0);
    expect(openEpisodeWindow(SOFI).status).toBe('open'); // untouched
  });

  it('a row with no OCC or no closeTs is UNASKABLE, counted, and not guessed at', () => {
    record('buy_to_open', 1, { at: 0 });
    const r = backfillReconcileTerminationsFromJournal([
      journalRow({ optionSymbol: null }),
      journalRow({ closeTs: null }),
    ]);
    expect(r.candidates).toBe(2);
    expect(r.unaskable).toBe(2);
    expect(r.written).toBe(0);
    // A row we cannot key is not a row we have cleared.
    expect(openEpisodeWindow(SOFI).status).toBe('open');
  });

  it('a reconcile close whose OCC the ledger already accounts for is a no-op', () => {
    record('buy_to_open', 1, { at: 0 });
    record('sell_to_close', 1, { at: 60_000 });
    const r = backfillReconcileTerminationsFromJournal([journalRow()]);
    expect(r.alreadyAccounted).toBe(1);
    expect(r.written).toBe(0);
    expect(openEpisodeWindow(SOFI).status).toBe('flat'); // the FINDING survives
  });

  it('does not touch an OCC the engine has since re-entered', () => {
    // The drop is old; the ledger's open episode is a NEW one. Marking at the
    // old `closeTs` leaves the new episode intact because the walk clears the
    // termination at the next `buy_to_open` off zero.
    record('buy_to_open', 1, { at: 0 });
    record('buy_to_open', 2, {
      orderId: 143000111,
      at: DROP_TIME - OPEN_TIME + 3_600_000,
    });
    backfillReconcileTerminationsFromJournal([journalRow()]);

    const window = openEpisodeWindow(SOFI);
    expect(window.status).toBe('open');
    expect(window.fills.map((f) => f.orderId)).toEqual([143000111]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TRA-3976 AC5 — the census, published and counted', () => {
  it('names the phantom when the book does not hold what the ledger reports open', () => {
    // The live 2026-08-24 state: the ledger says SOFI is open, /api/state serves
    // BAC + RIG, and no marker exists because the drop predates this code.
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    record('buy_to_open', 1, { optionSymbol: BAC, orderId: 777, at: 60_000 });

    const census = phantomOpenEpisodeCensus([BAC]);
    expect(census.wired).toBe(true);
    expect(census.verdict).toBe('phantom');
    expect(census.ledgerOpenEpisodes).toBe(2);
    expect(census.phantomEpisodes).toBe(1);
    expect(census.phantomContracts).toBe(1);
    expect(census.rows?.map((r) => r.optionSymbol)).toEqual([SOFI]);
    expect(census.rows?.[0]!.engineOpenContracts).toBe(1);
  });

  it('reads CLEAN once the marker is written, and counts the remediated episode', () => {
    record('buy_to_open', 1, { filledPrice: 1.23, orderId: 142828896, at: 0 });
    record('buy_to_open', 1, { optionSymbol: BAC, orderId: 777, at: 60_000 });
    markDropped();

    const census = phantomOpenEpisodeCensus([BAC]);
    expect(census.verdict).toBe('clean');
    expect(census.phantomEpisodes).toBe(0);
    expect(census.ledgerOpenEpisodes).toBe(1); // BAC only
    expect(census.terminalMarkers).toBe(1);
    expect(census.terminatedEpisodes).toBe(1);
  });

  it('an UNWIRED provider is BLIND, never `clean`', () => {
    // ⛔ The direction that matters. Folding an unwired provider to `[]` would
    // grade every open episode a phantom; folding it to `clean` would let the
    // absence of the instrument read as the absence of the defect.
    record('buy_to_open', 1, { at: 0 });

    const census = phantomOpenEpisodeCensus(null);
    expect(census.wired).toBe(false);
    expect(census.verdict).toBe('blind');
    expect(census.rows).toBeNull();
    expect(census.phantomEpisodes).toBeNull();
    expect(census.phantomContracts).toBeNull();
    // The denominator is still readable — a blind census still says how much it
    // could not grade.
    expect(census.ledgerOpenEpisodes).toBe(1);
  });

  it('an EMPTY held set is a real held-nothing book and grades normally', () => {
    record('buy_to_open', 1, { at: 0 });
    const census = phantomOpenEpisodeCensus([]);
    expect(census.wired).toBe(true);
    expect(census.verdict).toBe('phantom');
    expect(census.heldSymbols).toBe(0);
  });

  it('an import-only open episode is reported with its contracts on the IMPORTED column', () => {
    record('buy_to_open', 1, { origin: 'history_import', orderId: null, sleeve: 'unattributed', at: 0 });
    const census = phantomOpenEpisodeCensus([]);
    expect(census.rows?.[0]!.engineOpenContracts).toBe(0);
    expect(census.rows?.[0]!.importedOpenContracts).toBe(1);
  });
});
