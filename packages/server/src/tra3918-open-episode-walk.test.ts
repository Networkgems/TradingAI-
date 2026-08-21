import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  lastRecordedOpenFill,
  lastRecordedOpenSleeve,
  recordedEngineOpenBasis,
  openEpisodeWindow,
  type LiveFillSide,
  type LiveFillSleeve,
} from './live-options-fee-slippage-ledger.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3918 — the fill-provenance walk must stop at the `sell_to_close` that
// FLATTENS the position. A closed episode never votes.
//
// ── The defect, in one ledger ───────────────────────────────────────────────
//   buy_to_open   XLF …C57.5  1     <- episode A opens
//   sell_to_close XLF …C57.5  1     <- episode A closes; we hold ZERO
//                                      (the desk later buys 1 of the same OCC)
//   lastRecordedOpenFill(…)  ->  the episode-A buy_to_open      ⇐ pre-fix
//   lastRecordedOpenFill(…)  ->  null                           ⇐ post-fix
//
// The oracle answered `engine` for any OCC this engine had EVER bought, because
// the backward walk looked for "the newest `buy_to_open` on this symbol" with no
// regard for whether that episode had since been closed. Downstream that becomes
// `adoptionAuthority: 'engine_origin'` on a contract the DESK bought (TRA-3916's
// decay), which re-blends the desk's basis into the engine's stop and spends the
// board's adoption authorization on the desk's money.
//
// ── Why this is a UNIT suite over the REAL ledger module ────────────────────
// Both live symbols on the 2026-08-20 book currently have an OPEN engine
// episode, so "newest buy_to_open" and "newest buy_to_open in the open episode"
// COINCIDE there. A live read of this fix is therefore VACUOUS — it cannot tell
// the repair from the defect. These cases write real rows into the real ledger
// module and drive the real default oracle (`ledgerOpenProvenance`), because a
// suite that only ever injects a test double grades the double.
//
// ── Negative control (AC4) ─────────────────────────────────────────────────
// This file is required to go RED against pre-fix sources. `pnpm exec vitest run
// src/tra3918-open-episode-walk.test.ts` with `live-options-fee-slippage-ledger.ts`
// and `options-account.ts` at `b12ddea` fails the `closed episode` cases naming
// the episode-A fill. A green with no demonstrated failing state is not a
// reading. Result recorded on the ticket.
// ─────────────────────────────────────────────────────────────────────────────

const XLF = 'XLF260918C00057500';
const TRADING_TIME = Date.parse('2026-08-20T14:00:00Z');

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
    /** Minutes after {@link TRADING_TIME}; defaults to monotonic append order. */
    atMin?: number;
  } = {},
): void {
  seq += 1;
  const at = TRADING_TIME + (opts.atMin ?? seq) * 60_000;
  recordLiveOptionFill({
    ts: at,
    etDay: '2026-08-20',
    sleeve: opts.sleeve ?? 'single_leg_otm',
    optionSymbol: opts.optionSymbol ?? XLF,
    side,
    contracts,
    filledPrice: opts.filledPrice ?? (side === 'buy_to_open' ? 0.85 : 0.82),
    orderId: opts.orderId ?? 900_000 + seq,
  });
}

describe('TRA-3918 — the open-episode walk', () => {
  beforeEach(() => {
    seq = 0;
    clearLiveOptionsFeeSlippageLedger();
  });
  afterEach(() => {
    clearLiveOptionsFeeSlippageLedger();
  });

  // ── AC1 / AC2 ─────────────────────────────────────────────────────────────
  describe('AC1+AC2 — a CLOSED episode never votes', () => {
    it('buy → close → (desk buys): the oracle answers null, not the episode-A fill', () => {
      record('buy_to_open', 1, { orderId: 140022786 }); // episode A opens
      record('sell_to_close', 1); //                        episode A closes; we hold ZERO
      // The desk's subsequent purchase leaves NO row here — the desk does not
      // trade through this engine, which is exactly why the ledger cannot see it
      // and exactly why the walk must not answer for it.

      expect(lastRecordedOpenFill(XLF)).toBeNull();
      expect(lastRecordedOpenSleeve(XLF)).toBeNull();

      const window = openEpisodeWindow(XLF);
      expect(window.status).toBe('flat');
      expect(window.fills).toEqual([]);
      expect(window.netContracts).toBe(0);
      expect(window.closes).toBe(1);
    });

    it('pins the PRE-FIX answer as the thing that must not come back', () => {
      record('buy_to_open', 1, { orderId: 140022786 });
      record('sell_to_close', 1);

      // The defect returned this record. Assert on the ORDER ID rather than on
      // `null` alone: `toBeNull()` above passes for a walk that is broken in
      // some new way too, and this names the specific wrong answer.
      const answered = lastRecordedOpenFill(XLF);
      expect(answered?.orderId).not.toBe(140022786);
      expect(answered).toBeNull();
    });

    it('a MULTI-contract episode closed in two partial sells still ends flat', () => {
      record('buy_to_open', 2);
      record('sell_to_close', 1); //  <- does NOT flatten; the episode is still open
      expect(openEpisodeWindow(XLF).status).toBe('open');
      expect(lastRecordedOpenFill(XLF)).not.toBeNull();

      record('sell_to_close', 1); //  <- THIS one flattens
      expect(openEpisodeWindow(XLF).status).toBe('flat');
      expect(lastRecordedOpenFill(XLF)).toBeNull();
    });

    it('a PARTIAL close does NOT silence the oracle (the fail-open direction)', () => {
      // The naive "stop at the first close walking backward" rule would return
      // null here, `ledgerOpenProvenance` would read that as `foreign`, and a
      // real-money contract the ENGINE placed and still holds would be handed
      // the import sentinel with nothing minding its stop — TRA-2820's incident.
      record('buy_to_open', 3, { orderId: 140028461 });
      record('sell_to_close', 1);

      const window = openEpisodeWindow(XLF);
      expect(window.status).toBe('open');
      expect(window.netContracts).toBe(2);
      expect(lastRecordedOpenFill(XLF)?.orderId).toBe(140028461);
      expect(lastRecordedOpenSleeve(XLF)).toBe('single_leg_otm');
    });
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  describe('AC3 — buy 1 → close 1 → buy 2 resolves to the SECOND episode', () => {
    it('answers with the re-open, not the first episode and not null', () => {
      record('buy_to_open', 1, { orderId: 111, sleeve: 'single_leg_otm', filledPrice: 0.85 });
      record('sell_to_close', 1);
      record('buy_to_open', 2, { orderId: 222, sleeve: 'single_leg_rv', filledPrice: 0.6 });

      const window = openEpisodeWindow(XLF);
      expect(window.status).toBe('open');
      expect(window.netContracts).toBe(2);
      expect(window.fills.map((f) => f.orderId)).toEqual([222]); // episode A is GONE

      expect(lastRecordedOpenFill(XLF)?.orderId).toBe(222);
      expect(lastRecordedOpenSleeve(XLF)).toBe('single_leg_rv');
    });

    it('several adds inside the open episode all survive; the newest wins the point answer', () => {
      record('buy_to_open', 1, { orderId: 111 });
      record('sell_to_close', 1);
      record('buy_to_open', 1, { orderId: 222 });
      record('buy_to_open', 1, { orderId: 333 });

      const window = openEpisodeWindow(XLF);
      expect(window.fills.map((f) => f.orderId)).toEqual([222, 333]); // oldest-first
      expect(window.netContracts).toBe(2);
      expect(lastRecordedOpenFill(XLF)?.orderId).toBe(333);
    });

    it('other OCC symbols do not leak across the boundary', () => {
      const bac = 'BAC260918C00050000';
      record('buy_to_open', 1, { optionSymbol: bac, orderId: 777 });
      record('buy_to_open', 1, { orderId: 111 });
      record('sell_to_close', 1);

      expect(lastRecordedOpenFill(XLF)).toBeNull();
      expect(lastRecordedOpenFill(bac)?.orderId).toBe(777); // untouched
    });
  });

  // ── Ordering ──────────────────────────────────────────────────────────────
  describe('rows are episode-ordered by `ts`, not by array position', () => {
    it('a history-imported open appended AFTER its own close is still placed first', () => {
      // `importMissingLiveOptionFills` appends reconstructed rows at the END of
      // the in-memory array even though they represent OLDER fills (TRA-2959).
      // A positional walk puts the recovered open after the close that closed it
      // and reads a flat contract as OPEN — the exact fail-open this ticket is
      // about, arriving by a different road.
      record('sell_to_close', 1, { atMin: 20 }); // recorded live at +20m
      record('buy_to_open', 1, { atMin: 5, orderId: 555 }); // recovered later, filled at +5m

      expect(openEpisodeWindow(XLF).status).toBe('flat');
      expect(lastRecordedOpenFill(XLF)).toBeNull();
    });
  });

  // ── The three "no" states are not the same "no" ───────────────────────────
  describe('the refusal states stay separate from the findings', () => {
    it('an UNMATCHED close is indeterminate, not flat and not foreign', () => {
      // 30-day retention aged the open out, or the history importer recovered
      // one leg of a round trip. Every episode boundary after this is unknowable.
      record('sell_to_close', 1);

      const window = openEpisodeWindow(XLF);
      expect(window.status).toBe('indeterminate');
      expect(window.reason).toBe('unmatched_close');
      expect(lastRecordedOpenFill(XLF)).toBeNull();
    });

    it('a close for MORE than is open is indeterminate', () => {
      record('buy_to_open', 1);
      record('sell_to_close', 2);

      expect(openEpisodeWindow(XLF).reason).toBe('unmatched_close');
    });

    it('an unusable `contracts` value refuses rather than netting NaN', () => {
      // `contracts` is not validated on hydrate, so a corrupt on-disk row does
      // reach the walk. `NaN` nets to `NaN`, which reads as a number until
      // something compares it (TRA-3486).
      record('buy_to_open', Number.NaN);

      const window = openEpisodeWindow(XLF);
      expect(window.status).toBe('indeterminate');
      expect(window.reason).toBe('unusable_quantity');
      expect(lastRecordedOpenFill(XLF)).toBeNull();
    });

    it('an OCC the ledger has never seen is `no_record`, distinct from `flat`', () => {
      record('buy_to_open', 1, { optionSymbol: 'BAC260918C00050000' });

      expect(openEpisodeWindow(XLF).status).toBe('no_record');
      expect(openEpisodeWindow(XLF).reason).toBeNull();
    });
  });

  // ── Scope item 2: the exposure oracle was ALREADY correct ─────────────────
  describe('scope audit — `recordedEngineOpenBasis` does not inherit the defect', () => {
    it('returns null across a closed episode (it already stopped at the close)', () => {
      record('buy_to_open', 1, { filledPrice: 0.85 });
      record('sell_to_close', 1);

      // TRA-3896 built this walk with an episode boundary from the start. Pinned
      // here so a future "unify the two walks" cleanup has to break a test to do
      // it: this one truncates on a PARTIAL close ON PURPOSE (its callers refuse
      // a quantity they cannot fully account for), which is the opposite of what
      // the provenance walk needs.
      expect(recordedEngineOpenBasis(XLF)).toBeNull();
    });

    it('a partial close truncates it to a REFUSAL, unlike the provenance walk', () => {
      record('buy_to_open', 3, { filledPrice: 0.85 });
      record('sell_to_close', 1);

      expect(recordedEngineOpenBasis(XLF)).toBeNull(); // basis: refuses
      expect(openEpisodeWindow(XLF).status).toBe('open'); // provenance: answers
    });

    it('resolves the SECOND episode after a re-open', () => {
      record('buy_to_open', 1, { filledPrice: 0.85 });
      record('sell_to_close', 1);
      record('buy_to_open', 2, { filledPrice: 0.6 });

      const basis = recordedEngineOpenBasis(XLF);
      expect(basis?.contracts).toBe(2);
      expect(basis?.premiumPaid).toBeCloseTo(0.6, 10);
      expect(basis?.stoppedAtClose).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The oracle in situ: what the reconcile stamps on the row.
//
// This is the half that matters on real money. `ledgerOpenProvenance` is the
// function that runs on bqb1; `installReconcileRiskThresholds` is what writes
// its verdict onto `adoptionAuthority`, and that field is what
// `splitEngineExposureContracts` (TRA-3913 rule 3) and `engineMayActOnAdoptedRow`
// (TRA-3829) both read. The unit cases above grade the walk; these grade the
// consequence.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3918 — the reconcile no longer adopts a closed episode as ours', () => {
  function buildImport(
    overrides: Partial<TradierOpenOptionPosition> = {},
  ): TradierOpenOptionPosition {
    return {
      optionSymbol: XLF,
      underlying: 'XLF',
      optionType: 'call',
      strike: 57.5,
      expiration: '2026-09-18',
      contracts: 1,
      // Above RV_MIN_MARK_FLOOR on purpose, so the sub-floor sentinel is not a
      // confounder: every difference below is the provenance verdict's doing.
      premiumPaid: 0.85,
      acquiredAt: TRADING_TIME,
      ...overrides,
    };
  }

  /** A live account on the REAL default provenance oracle — no test double. */
  function adoptedRow() {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    return acct.getState().openOptions[0]!;
  }

  beforeEach(() => {
    seq = 0;
    clearLiveOptionsFeeSlippageLedger();
  });
  afterEach(() => {
    clearLiveOptionsFeeSlippageLedger();
  });

  it('CLOSED episode ⇒ the desk contract is stamped `foreign`, NOT `engine_origin`', () => {
    record('buy_to_open', 1, { orderId: 140022786 });
    record('sell_to_close', 1);

    const row = adoptedRow();
    // Pre-fix this read `engine_origin` and `applyEngineOriginRiskThresholds`
    // armed an OTM stop off the DESK's premium — TRA-3916's decay, one layer
    // below the guard TRA-3909 put in front of it.
    expect(row.adoptionAuthority).toBe('foreign');
    expect(row.engineOriginSleeve).toBeUndefined();
    // And it is a FINDING, not a refusal: the ledger answered.
    expect(row.riskUnmanagedReason).not.toBe('provenance_unresolved');
  });

  it('OPEN episode ⇒ still `engine_origin` (the fix did not widen onto our own rows)', () => {
    record('buy_to_open', 1, { orderId: 140022786, sleeve: 'single_leg_otm' });

    const row = adoptedRow();
    expect(row.adoptionAuthority).toBe('engine_origin');
    expect(row.engineOriginSleeve).toBe('single_leg_otm');
  });

  it('RE-OPENED episode ⇒ `engine_origin` again, on the SECOND episode sleeve', () => {
    record('buy_to_open', 1, { orderId: 111, sleeve: 'single_leg_otm' });
    record('sell_to_close', 1);
    record('buy_to_open', 1, { orderId: 222, sleeve: 'single_leg_rv' });

    const row = adoptedRow();
    expect(row.adoptionAuthority).toBe('engine_origin');
    expect(row.engineOriginSleeve).toBe('single_leg_rv');
  });

  it('UNMATCHED close ⇒ `unresolved` + `provenance_unresolved`, never `foreign`', () => {
    record('sell_to_close', 1);

    const row = adoptedRow();
    // The distinction TRA-3553 exists to protect: "this is the desk's" and "the
    // ledger cannot tell me" produce the same zero stop and must not produce the
    // same label. A sick oracle WANTS an operator.
    expect(row.adoptionAuthority).toBe('unresolved');
    expect(row.riskUnmanagedReason).toBe('provenance_unresolved');
  });

  it('empty ledger ⇒ still `unresolved` (TRA-3553 unchanged)', () => {
    const row = adoptedRow();
    expect(row.adoptionAuthority).toBe('unresolved');
    expect(row.riskUnmanagedReason).toBe('provenance_unresolved');
  });
});
