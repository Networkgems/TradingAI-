import { describe, it, expect } from 'vitest';
import { brokerRealizedIsSummable } from '@trading-app/shared';
import {
  equitySymbolsInvalidatedByCorporateActions,
  realizedPnlByCloseDate,
} from './tradier-reconcile.js';
import {
  buildBrokerRealizedCompanion,
  companionFiguresEqual,
} from './broker-realized-companion.js';
import { LIVE_TRADIER_TAPE } from './tra2864-live-tradier-tape.fixture.js';

// TRA-4979 — "`brokerRealized.equityIncluded` is false on every live calendar
// cell, so `equityPnl: 0` is ABSENT not measured".
//
// ── WHAT WAS MEASURED, AND WHY THESE ARE THE FIXTURES ───────────────────────
//
// Live bqb1, build `73ab002533bc`, 2026-10-01. All nine TRA-3100 dates serve
// `equityPnl: 0, equityIncluded: false` with `combinedPnl == optionsPnl`. The
// backfill pass at 20:20:10Z logged `equityIncluded:false`,
// `equityExcludedSymbols:[]`, `corporateActionsSeen:1`, and NO
// `corporate-action read failed` warning — so the branch is
// `caScope.withholdAllEquity`, not `caScope === null`.
//
// Reproducing the pass's own two Tradier reads directly gave the reason:
//
//   date=2026-06-12 type=adjustment qty=-7 description=" reverse split DREAMLAND LIMITED"
//   equity tickers on tape = [CIFR,GM,INTC,IREN,LASE,MIR,RDW,RKLB,TDIC]
//   token intersection = 0 candidates  =>  WITHHOLD ALL EQUITY
//
// **Tradier names the COMPANY, not the ticker.** `DREAMLAND LIMITED` IS `TDIC`,
// and that name is on TDIC's own fill rows — but the ticker token is nowhere in
// the action text, so the intersection is empty and the fail-closed global arm
// fires on every pass. CONTROL A pins that row verbatim, because the attributor's
// own docblock expects `"REVERSE SPLIT - TDIC"` and that is not the shape this
// broker serves. If someone later teaches the attributor company names, CONTROL A
// is the test that must be deliberately changed — not one that quietly starts
// passing for a new reason.
//
// ── THE DEFECT THIS FILE CLOSES ─────────────────────────────────────────────
//
// `equityIncluded: false` is PASS-level. It says equity was withheld; it does not
// say whether withholding COST anything on a given day. Those two states were
// byte-identical on the wire:
//
//   · withheld, and no stock closed that day  ⇒ the figure is EXACTLY RIGHT
//   · withheld, and stock DID close that day  ⇒ the figure is WRONG, by an
//     amount nothing on the row can state
//
// On the live book the ratio is 8:1 — eight of the nine TRA-3100 dates closed
// zero stock, and 2026-06-16 hid the $0.80 MIR round trip. `closeCount` cannot
// separate them: under `includeEquity: false` the matcher runs
// `instruments: ['option']`, so it counts OPTION closes only, and those nine
// dates read a perfectly healthy `closeCount: 1..5`.
//
// Telling them apart required reading the raw broker tape by hand. That is the
// thing that must not recur, so the suppression now ships a counter.

/** The nine dates TRA-3100 enumerates, in its order. */
const TRA3100_DATES = [
  '2026-06-11',
  '2026-06-12',
  '2026-06-15',
  '2026-06-16',
  '2026-06-25',
  '2026-07-01',
  '2026-07-08',
  '2026-07-31',
  '2026-08-03',
] as const;

/**
 * CONTROL A's subject: the corporate action the live account actually carries,
 * copied from a read-only `GET /accounts/{id}/history` on 2026-10-01. The
 * leading space in `description` is the broker's and is reproduced deliberately.
 */
const LIVE_CORPORATE_ACTION = {
  date: '2026-06-12',
  type: 'adjustment',
  description: ' reverse split DREAMLAND LIMITED',
  quantity: -7,
} as const;

const AT = '2026-10-01T20:20:10.367Z';

describe('TRA-4979 CONTROL A — the live corporate action is unattributable, so the global arm is correct-but-blind', () => {
  it('names the COMPANY not the ticker, so the ticker intersection is empty', () => {
    const scope = equitySymbolsInvalidatedByCorporateActions(
      [LIVE_CORPORATE_ACTION],
      LIVE_TRADIER_TAPE,
    );
    // TDIC IS on the tape — so this is not "the symbol is unknown to us".
    const tickers = new Set(
      LIVE_TRADIER_TAPE.filter(f => f.tradeType === 'equity').map(f => f.symbol.toUpperCase()),
    );
    expect(tickers.has('TDIC')).toBe(true);

    expect(scope.withholdAllEquity).toBe(true);
    expect([...scope.excludeSymbols]).toEqual([]);
    expect(scope.reasons.join(' ')).toContain('0 candidates');
  });

  it('TDIC closed NOTHING in the window, so the quarantine it deserves would cost $0.00', () => {
    // The fail-closed design is right; the attribution is what is broken. This
    // states the price of that distinction: a correctly-scoped TDIC-only
    // quarantine changes no realized figure at all, while the unattributable
    // global arm costs the 2026-06-16 cell its $0.80.
    const tdicCloses = LIVE_TRADIER_TAPE.filter(
      f => f.tradeType === 'equity' && f.symbol.toUpperCase() === 'TDIC' && f.amount > 0,
    );
    expect(tdicCloses).toEqual([]);

    const all = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: true });
    const tdicQuarantined = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, {
      includeEquity: true,
      excludeSymbols: new Set(['TDIC']),
    });
    for (const [date, pnl] of all.realizedByDate) {
      expect(tdicQuarantined.realizedByDate.get(date)).toBeCloseTo(pnl, 10);
    }
  });
});

describe('TRA-4979 — the suppressed-close counter', () => {
  it('is 0 everywhere when equity is INCLUDED — nothing was withheld, so nothing is owed', () => {
    const { equitySuppressedCloseCountByDate } = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, {
      includeEquity: true,
    });
    expect([...equitySuppressedCloseCountByDate.values()]).toEqual([]);
  });

  it('names the live withheld dates when equity is EXCLUDED, and leaves the equity-free ones at 0', () => {
    const { equitySuppressedCloseCountByDate: suppressed } = realizedPnlByCloseDate(
      LIVE_TRADIER_TAPE,
      { includeEquity: false },
    );
    // 2026-06-16 is the one TRA-3100 date that loses a stock close.
    expect(suppressed.get('2026-06-16')).toBe(1);
    // 2026-06-12 has a stock OPEN and no close, so the cell loses nothing. An
    // open-only day reading as suppressed would over-warn on eight cells.
    expect(suppressed.get('2026-06-12') ?? 0).toBe(0);
    // The other seven TRA-3100 dates carried no equity leg at all.
    for (const date of TRA3100_DATES) {
      if (date === '2026-06-16') continue;
      expect(suppressed.get(date) ?? 0).toBe(0);
    }
  });

  it('counts a per-symbol QUARANTINE as suppressed too, not just a whole-pass withhold', () => {
    // `excludeSymbols` drops the symbol whole, so its closes are just as absent
    // from the figure as they are under `includeEquity: false`. A counter that
    // only saw the global arm would read a clean 0 on a quarantined cell.
    const { equitySuppressedCloseCountByDate: suppressed } = realizedPnlByCloseDate(
      LIVE_TRADIER_TAPE,
      { includeEquity: true, excludeSymbols: new Set(['MIR']) },
    );
    expect(suppressed.get('2026-06-16')).toBe(1);
  });

  it('⭐ THE UNIVERSAL: across the whole live tape, count === 0 ⟺ the options-only figure is EXACT', () => {
    // The property the counter has to have, stated over every date rather than
    // the one date that motivated it. If this ever fails, the counter has stopped
    // predicting completeness and is decoration.
    const withEquity = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: true });
    const withheld = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: false });

    const dates = new Set([...withEquity.realizedByDate.keys(), ...withheld.realizedByDate.keys()]);
    expect(dates.size).toBeGreaterThan(1); // never vacuous

    let exact = 0;
    let differing = 0;
    for (const date of dates) {
      const all = withEquity.realizedByDate.get(date) ?? 0;
      const optionsOnly = withheld.realizedByDate.get(date) ?? 0;
      const suppressedHere = withheld.equitySuppressedCloseCountByDate.get(date) ?? 0;
      const figuresAgree = Math.abs(all - optionsOnly) < 0.005;
      expect(figuresAgree).toBe(suppressedHere === 0);
      if (suppressedHere === 0) exact += 1;
      else differing += 1;
    }
    // Both arms exercised — a universal that only ever saw one side is not one.
    expect(exact).toBeGreaterThan(0);
    expect(differing).toBeGreaterThan(0);
  });
});

describe('TRA-4979 — brokerRealizedIsSummable, the one implementation of the rule', () => {
  const companionFor = (date: string, includeEquity: boolean) => {
    const totals = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity });
    return buildBrokerRealizedCompanion({
      optionsPnl: totals.optionsRealizedByDate.get(date) ?? 0,
      equityPnl: totals.equityRealizedByDate.get(date) ?? 0,
      closeCount: totals.closeCountByDate.get(date) ?? 0,
      equityIncluded: includeEquity,
      equitySuppressedCloseCount: totals.equitySuppressedCloseCountByDate.get(date) ?? 0,
      reconstructedAt: AT,
    });
  };

  it('⭐ separates two companions that were BYTE-IDENTICAL on every pre-TRA-4979 field', () => {
    // This is the whole ticket in one assertion. 2026-06-11 (no stock closed) and
    // 2026-06-16 (an $0.80 stock close, suppressed) are both `equityPnl: 0`,
    // `equityIncluded: false`, non-zero `closeCount`. One figure is exactly right
    // and the other is wrong, and NOTHING on the old shape could say which.
    const exact = companionFor('2026-06-11', false);
    const incomplete = companionFor('2026-06-16', false);

    // The control: on the OLD fields these two are indistinguishable in kind.
    expect(exact.equityPnl).toBe(0);
    expect(incomplete.equityPnl).toBe(0);
    expect(exact.equityIncluded).toBe(false);
    expect(incomplete.equityIncluded).toBe(false);
    expect(exact.closeCount).toBeGreaterThan(0);
    expect(incomplete.closeCount).toBeGreaterThan(0);

    // The discriminator.
    expect(exact.equitySuppressedCloseCount).toBe(0);
    expect(incomplete.equitySuppressedCloseCount).toBe(1);
    expect(brokerRealizedIsSummable(exact)).toBe(true);
    expect(brokerRealizedIsSummable(incomplete)).toBe(false);
  });

  it('⛔ FAILS CLOSED on a pre-TRA-4979 row: absent count is UNKNOWN, never a clean 0', () => {
    // The ~100 rows already on disk carry no counter. They are precisely the rows
    // whose completeness nobody measured, so `undefined` must not read as "we
    // looked and it was clean" — the bug class this field exists to close.
    const legacy = {
      combinedPnl: -163.15,
      optionsPnl: -163.15,
      equityPnl: 0,
      closeCount: 2,
      equityIncluded: false,
      reconstructedAt: '2026-09-03T20:13:29.973Z',
    };
    expect(legacy).not.toHaveProperty('equitySuppressedCloseCount');
    expect(brokerRealizedIsSummable(legacy)).toBe(false);
  });

  it('a complete all-instrument companion is summable, and an absent companion is not', () => {
    expect(brokerRealizedIsSummable(companionFor('2026-06-16', true))).toBe(true);
    expect(brokerRealizedIsSummable(undefined)).toBe(false);
  });
});

describe('TRA-4979 — the counter has to be able to REACH the rows already on disk', () => {
  it('undefined vs 0 is a CHANGE, so the idempotency skip cannot pin a legacy row at UNKNOWN', () => {
    // If `companionFiguresEqual` ignored the new field, every existing row would
    // compare equal to its freshly-counted replacement, the write would be
    // skipped, and the discriminator would never arrive where it is needed — a
    // fix that ships and then cannot reach its own subject.
    const legacy = {
      combinedPnl: -163.15,
      optionsPnl: -163.15,
      equityPnl: 0,
      closeCount: 2,
      equityIncluded: false,
      reconstructedAt: '2026-09-03T20:13:29.973Z',
    };
    const counted = { ...legacy, equitySuppressedCloseCount: 0 };
    expect(companionFiguresEqual(legacy, counted)).toBe(false);

    // …and once it has arrived, a re-run is still a no-op. The one-time rewrite
    // must not become a per-pass churn.
    expect(companionFiguresEqual(counted, { ...counted, reconstructedAt: AT })).toBe(true);
  });

  it('a change in the counter ALONE is a change, even when every figure is identical', () => {
    const base = {
      combinedPnl: -163.15,
      optionsPnl: -163.15,
      equityPnl: 0,
      closeCount: 2,
      equityIncluded: false,
      equitySuppressedCloseCount: 0,
      reconstructedAt: AT,
    };
    expect(companionFiguresEqual(base, { ...base, equitySuppressedCloseCount: 1 })).toBe(false);
  });
});
