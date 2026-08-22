// TRA-3965 — the PREMIUM half of TRA-3964's skew, at the fold.
//
// `openPremiumAtRiskUsd` folds `premiumPaid`. An engine open books
// `premiumPaid = signal.mark` — the scanner's pre-trade NBBO mid — while the
// broker charges `avgFillPrice`. The difference is the ask-vs-mark spread the
// smart-open walk crossed, and until this ticket it reached four telemetry
// sinks and none of the places that gate money. The fold understated, which
// OVERSTATES `admissibleEntryUsd` and understates `Σ atRisk_j` against the
// board's `A` — both in the admitting direction, and invisible for the house
// reason: an understated at-risk reads as a book with more headroom, which is
// indistinguishable from a book that genuinely has it.
//
// ── ⚠ WHAT THE MEASUREMENT CHANGED ─────────────────────────────────────────
// The filing claimed the row keeps the mark "for the life of the position",
// because "nothing re-stamps it". That is FALSE on the deployed build.
// `restateEngineOpenedBasis` (TRA-2889/TRA-2873) moves an engine-opened live
// row's `premiumPaid` to the broker's `cost_basis / quantity / 100` on the
// reconcile sweep and rescales the stop schedule with it. bqb1's durable log
// (`GET /api/options/basis-restatements`), read 2026-08-22 against live SHA
// `8c96ed6d`:
//
//     SOFI260925C00019000   1.205 -> 1.23   source broker_reconcile   fill +23.1 s
//     BAC260925C00063000    1.51  -> 1.65   source broker_reconcile   fill +72.3 s
//
// and the gap across all three open live lots was $0.00 at grading time (SOFI
// 1.23 = its fill; RIG 0.32999999999999996 vs a 0.33 fill = 4e-17/contract;
// BAC operator-pinned). So the live exposure was NIL and the defect is a
// WINDOW — fill ack until the next matching reconcile — not a permanent
// understatement.
//
// It is still worth closing, for two reasons this suite pins:
//   • the scanner ticks INSIDE that window, so the skew is reachable by a
//     sizing decision (the engine-level graders in `signal-engine.test.ts`
//     drive a real fill through `runOtmScan` to prove it); and
//   • the re-stamp is skipped BY DESIGN and permanently on `quantity_mismatch`
//     (a desk add on the same OCC — the live BAC state on 2026-08-20),
//     `multi_leg`, `covered_write`, and whenever the broker read fails. On
//     those rows the window never closes.
//
// ── ⭐ WHY A SEPARATE COLUMN AND NOT A WRITE TO `premiumPaid` ───────────────
// `premiumPaid` has TWO CONSUMERS WITH OPPOSITE SENSITIVITIES: the stop engine
// READS it (`stopLossPremium` / `tp1Premium` / the trailing activation are all
// `premiumPaid × k`) and this fold SPENDS it. TRA-3958 measured what one write
// does to both — restating the live BAC row 1.41 → 1.17 fixed a breached stop
// AND moved `admin`'s `admissibleEntryUsd` by $24 with nothing on the route
// saying so. So the realized fill lands in `brokerEntryFill`, the fold adds the
// shortfall, and the stop engine never learns the field exists.
import { describe, it, expect } from 'vitest';
import {
  foldOpenPremiumAtRisk,
  unbookedEntryPremiumForRow,
  isOperatorBasisPinLive,
} from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

/** An engine-opened live row: mark $0.80 booked, one contract. */
function pos(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'p1',
    symbol: 'AAPL',
    optionSymbol: 'AAPL240705C00210000',
    optionType: 'call',
    strike: 210,
    expiration: '2024-07-05',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 0.80,
    currentPremium: 0.80,
    tp1Premium: 1.20,
    tp1Hit: false,
    stopLossPremium: 0.64,
    peakPremium: 0.80,
    trailingActive: false,
    trailingStopPremium: 0.704,
    underlyingEntryPrice: 195,
    openedAt: Date.parse('2026-08-22T14:00:00Z'),
    signalId: 'sig-1',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

/** The stamp `mirrorLiveOptionOpen` writes on the `filled` branch. */
function filledAt(premiumPaid: number, contracts = 1) {
  return { premiumPaid, contracts, at: Date.parse('2026-08-22T14:00:01Z'), orderId: 142828896 };
}

describe('unbookedEntryPremiumForRow (TRA-3965)', () => {
  it('AC2 — a fill ABOVE the mark yields the shortfall, per contract', () => {
    // $0.82 charged against $0.80 booked, one contract ⇒ $2.00.
    // Raw, unrounded: rounding to the cent belongs at the fold's output
    // boundary, where `usd` already does it — not in a per-row operand.
    expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.82) }), 1)).toBeCloseTo(2, 10);
    // It scales with the spread and the contract count, as the filing says.
    expect(
      unbookedEntryPremiumForRow(
        pos({ contracts: 3, contractsRemaining: 3, brokerEntryFill: filledAt(0.82, 3) }),
        3,
      ),
    ).toBeCloseTo(6, 10);
  });

  it('AC4 — a fill AT the mark is exactly $0, not a rounding smear', () => {
    expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.80) }), 1)).toBe(0);
  });

  it('⛔ a fill BELOW the mark is $0 — this column may only ever ADD', () => {
    // Booking price improvement here would LOWER `atRisk` and buy entry
    // admission: a fresh fail-open shipped inside the fix for the old one.
    // Correcting a basis DOWNWARD is `restateEngineOpenedBasis`'s job, and it
    // carries the stop schedule across when it does. This does neither.
    expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.70) }), 1)).toBe(0);
    expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.01) }), 1)).toBe(0);
  });

  it('⛔ bounded by OUR fill\'s contracts — a widened row cannot price the desk\'s at our slippage', () => {
    // The reconcile can widen an engine row onto the broker's whole lot. Our
    // own order filled 1; the row now holds 3. Uplifting all 3 would charge the
    // desk's two contracts our entry slippage — TRA-3913's defect wearing this
    // ticket's clothes.
    const widened = pos({ contracts: 3, contractsRemaining: 3, brokerEntryFill: filledAt(0.82, 1) });
    expect(unbookedEntryPremiumForRow(widened, 3)).toBeCloseTo(2, 10); // 1 contract, not 3
  });

  it('bounded by REMAINING too — a partial close cannot leave the uplift behind', () => {
    // We filled 3; TP1 took 2 off. Only 1 is still at risk.
    const drained = pos({ contracts: 3, contractsRemaining: 1, brokerEntryFill: filledAt(0.82, 3) });
    expect(unbookedEntryPremiumForRow(drained, 1)).toBeCloseTo(2, 10);
  });

  it('is $0 for every row with no stamp — the pre-TRA-3965 answer, which is the correct one', () => {
    // Demo rows, imported rows, and everything opened before this shipped. A
    // synthesized uplift for them would be an opinion, not a measurement.
    expect(unbookedEntryPremiumForRow(pos(), 1)).toBe(0);
    expect(unbookedEntryPremiumForRow(pos({ mode: 'demo' }), 1)).toBe(0);
    expect(
      unbookedEntryPremiumForRow(pos({ importedFromTradier: true, adoptionAuthority: 'foreign' }), 1),
    ).toBe(0);
  });

  it('refuses every unusable operand rather than minting a NaN', () => {
    // `!(x > 0)` rather than `x <= 0`: a NaN uplift reads as a number until
    // something compares it, and it would poison `usd` for the WHOLE book —
    // not one row (TRA-3486).
    for (const bad of [Number.NaN, Infinity, 0, -1]) {
      expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(bad) }), 1)).toBe(0);
      expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.82, bad) }), 1)).toBe(0);
      expect(unbookedEntryPremiumForRow(pos({ premiumPaid: bad, brokerEntryFill: filledAt(0.82) }), 1)).toBe(0);
      expect(unbookedEntryPremiumForRow(pos({ brokerEntryFill: filledAt(0.82) }), bad)).toBe(0);
    }
  });
});

describe('foldOpenPremiumAtRisk — the correction, in the figure the order path gates on (TRA-3965)', () => {
  it('AC2 — the fold no longer publishes an at-risk BELOW the cash the broker took', () => {
    const fold = foldOpenPremiumAtRisk([pos({ brokerEntryFill: filledAt(0.82) })]);
    // RED on `8c96ed6d`, which folds the mark and publishes $80.00 for a lot
    // the broker was paid $82.00 for.
    expect(fold.usd).toBeGreaterThanOrEqual(82);
    expect(fold.usd).toBe(82);
    // Readable, not folded away — the discipline `unpricedRows` and
    // `operatorPinnedUsd` already established on this fold.
    expect(fold.unbookedEntryPremiumUsd).toBe(2);
    expect(fold.unbookedEntryPremiumRows).toBe(1);
    expect(fold.unbookedEntryPremiumSuppressedUsd).toBe(0);
  });

  it('AC4 (negative control) — GREEN on a lot filled at the mark, so it is not always-red', () => {
    const fold = foldOpenPremiumAtRisk([pos({ brokerEntryFill: filledAt(0.80) })]);
    expect(fold.usd).toBeGreaterThanOrEqual(80);
    expect(fold.usd).toBe(80);
    expect(fold.unbookedEntryPremiumUsd).toBe(0);
    expect(fold.unbookedEntryPremiumRows).toBe(0);
  });

  it('AC4 (second control) — a book of unstamped rows is BYTE-IDENTICAL to the pre-fix fold', () => {
    // The whole change must be inert wherever there is no stamp. A build that
    // corrected unconditionally would move every book on the fleet.
    const before = foldOpenPremiumAtRisk([pos({ id: 'a' }), pos({ id: 'b', premiumPaid: 1.5 })]);
    expect(before.usd).toBe(80 + 150);
    expect(before.unbookedEntryPremiumUsd).toBe(0);
    expect(before.unbookedEntryPremiumSuppressedUsd).toBe(0);
  });

  it('the correction is TIGHTENING-ONLY across the whole input space', () => {
    // The property, stated once against the fold rather than the helper: for
    // any stamp, `usd` is ≥ what `8c96ed6d` published for the same row. No cap
    // can get looser than the pre-fix build on any input, which is what lets
    // this ship without re-grading every gate downstream of it.
    for (const fill of [0.01, 0.5, 0.79, 0.7999999, 0.80, 0.8000001, 0.81, 1.6, 12]) {
      const fold = foldOpenPremiumAtRisk([pos({ brokerEntryFill: filledAt(fill) })]);
      expect(fold.usd).toBeGreaterThanOrEqual(80);
      // To the CENT: `usd` rounds there, so a sub-cent uplift lands on 80.00.
      // The `>=` above is the load-bearing half — rounding a positive uplift can
      // never drop the total below the pre-fix figure, which was rounded too.
      expect(fold.usd).toBeCloseTo(Math.max(80, fill * 100), 2);
    }
  });

  it('the correction CLEARS once the reconcile re-stamps the basis — the two fixes compose', () => {
    // What `restateEngineOpenedBasis` leaves behind 23 s after the fill: the
    // row books broker truth and the schedule was rescaled with it. Both paths
    // land on $82 — neither double-counts the other.
    const restated = pos({
      premiumPaid: 0.82, stopLossPremium: 0.656, tp1Premium: 1.23,
      brokerEntryFill: filledAt(0.82),
    });
    const fold = foldOpenPremiumAtRisk([restated]);
    expect(fold.usd).toBe(82);
    expect(fold.unbookedEntryPremiumUsd).toBe(0);
  });
});

describe('AC3 — an operator pin and a desk-adopted basis are PROVABLY untouched (TRA-3965)', () => {
  /**
   * The live `BAC260925C00063000` row, as it stands on bqb1: an operator pinned
   * the basis at 1.17 (TRA-3958, CEO ruling on TRA-3895) and the engine's own
   * fill on that OCC was 1.65. This is the exact shape where a naive uplift
   * would re-open, from a second direction, the authorization the operator's
   * write already settled.
   */
  function pinnedBac(): OptionPosition {
    return pos({
      id: 'bac',
      symbol: 'BAC',
      optionSymbol: 'BAC260925C00063000',
      premiumPaid: 1.17,
      stopLossPremium: 0.8775,
      tp1Premium: 1.638,
      importedFromTradier: true,
      adoptionAuthority: 'foreign',
      tradierEnv: 'production',
      brokerEntryFill: filledAt(1.65),
      operatorBasisPin: {
        premiumPaid: 1.17,
        contracts: 1,
        at: '2026-08-22T15:33:38.958Z',
        provenance: 'TRA-3958, CEO ruling on TRA-3895 comment 7adbb4b1 (2026-08-22).',
      },
    });
  }

  it('⛔ a LIVE operator pin outranks the correction — the pinned basis is what is spent', () => {
    const row = pinnedBac();
    expect(isOperatorBasisPinLive(row)).toBe(true);

    const fold = foldOpenPremiumAtRisk([row]);
    // $117, the operator's figure — NOT $165, and not $117 + $48.
    expect(fold.usd).toBe(117);
    expect(fold.operatorPinnedUsd).toBe(117);
    expect(fold.operatorPinnedRows).toBe(1);
    expect(fold.unbookedEntryPremiumUsd).toBe(0);
    expect(fold.unbookedEntryPremiumRows).toBe(0);

    // ⭐ AND THE REFUSAL IS PUBLISHED. "Nothing to add" and "something to add,
    // and the pin refused it" are the identical `unbookedEntryPremiumUsd: 0`,
    // and only one of them is a fact about the book. Without this column the
    // pin would silently swallow a $48 correction — which is the shape of the
    // defect TRA-3958 itself was filed on.
    expect(fold.unbookedEntryPremiumSuppressedUsd).toBe(48);
  });

  it('a VOID pin does not suppress it — a pin whose row moved off the figure is not in force', () => {
    // `isOperatorBasisPinLive` is the shared predicate: the fold and the
    // reconcile must agree to the bit on what "pinned" means. Once the row has
    // moved off the pinned figure the dollars are the broker's again, and so is
    // the correction.
    const moved = { ...pinnedBac(), premiumPaid: 1.41 };
    expect(isOperatorBasisPinLive(moved)).toBe(false);
    const fold = foldOpenPremiumAtRisk([moved]);
    expect(fold.operatorPinnedUsd).toBe(0);
    expect(fold.unbookedEntryPremiumUsd).toBeCloseTo(24, 10); // (1.65 − 1.41) × 100
    expect(fold.unbookedEntryPremiumSuppressedUsd).toBe(0);
  });

  it('⛔ the DESK\'s share is untouched: the carve is taken from the row\'s own basis', () => {
    // A `foreign` row is wholly the desk's by provenance, and it carries no
    // stamp of ours — so both the uplift and the attribution are unchanged from
    // TRA-3913. (`usd - adoptedUsd`, the engine-attributable figure the board's
    // authorization is measured against, is what must not move here.)
    const fold = foldOpenPremiumAtRisk(
      [
        pos({ id: 'engine', brokerEntryFill: filledAt(0.82) }),
        pos({
          id: 'desk',
          optionSymbol: 'PLTR260821C00180000',
          premiumPaid: 1.435,
          contracts: 2,
          contractsRemaining: 2,
          importedFromTradier: true,
          adoptionAuthority: 'foreign',
          tradierEnv: 'production',
        }),
      ],
      /* armed */ false,
    );
    // The desk's $287 is attributed to the desk, to the cent, with our $2 of
    // slippage nowhere in it.
    expect(fold.adoptedUsd).toBeCloseTo(287, 2);
    expect(fold.adoptedRows).toBe(1);
    // Our slippage lands on OUR side of the split, which is the direction that
    // matters: the engine-attributable figure RISES by exactly the uplift.
    expect(fold.usd).toBeCloseTo(82 + 287, 2);
    expect(fold.usd - fold.adoptedUsd).toBeCloseTo(82, 2);
    expect(fold.unbookedEntryPremiumUsd).toBe(2);
  });

  it('⛔ stop levels are not a function of the correction — the row object is never written', () => {
    // The structural half of AC3. The fold is a READER; it takes no reference
    // to the row it could write through. Frozen input is the assertion: a build
    // that stamped the basis back onto `premiumPaid` (the "obvious" one-line
    // fix) throws here, and every stop on the row would have moved silently.
    const row = Object.freeze(pos({ brokerEntryFill: filledAt(0.82) })) as OptionPosition;
    expect(() => foldOpenPremiumAtRisk([row])).not.toThrow();
    expect(row.premiumPaid).toBe(0.80);
    expect(row.stopLossPremium).toBe(0.64);
    expect(row.tp1Premium).toBe(1.20);
    expect(row.trailingStopPremium).toBe(0.704);
    // And the levels still stand in their original ratio to the basis the stop
    // engine owns — 0.8× and 1.5× of the mark, untouched by a $2 risk change.
    expect(row.stopLossPremium / row.premiumPaid).toBeCloseTo(0.8, 10);
    expect(row.tp1Premium / row.premiumPaid).toBeCloseTo(1.5, 10);
  });
});
