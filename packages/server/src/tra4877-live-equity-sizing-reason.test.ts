/**
 * TRA-4877 — acceptance for "WHICH zero did the live-equity sizer return".
 *
 * Two jobs, and the first one is the important one:
 *
 *  1. **The refactor moved no share count.** `explainLiveEquitySizing` is the
 *     old `sizeLiveEquityFromStop` body with reason stamps added, so a parity
 *     control re-implements the PRE-change arithmetic verbatim and asserts
 *     agreement over a 2,000-point matrix. That control is itself graded: the
 *     same matrix run against three deliberately perturbed legacy variants must
 *     DISAGREE, because a parity check that cannot fail is not a parity check.
 *
 *  2. **The six zeros are six distinguishable refusals.** Every reason is
 *     reachable, no two share an operator string, and the capital-size one
 *     (`priced_out_at_book`) no longer buckets with a dead quote feed on the
 *     redacted health probe.
 *
 * Every assertion that matters is paired with its failing direction — the
 * recurring defect this ticket is an instance of is a green that cannot go red.
 */

import { describe, it, expect } from 'vitest';
import type { TradierAccountBalance } from '@trading-app/engine';
import {
  OPTIONS_PER_TICKET_DOLLAR_FLOOR,
  OPTIONS_POSITION_CAP_RATIO,
  perPositionCap,
} from '@trading-app/shared';
import {
  explainLiveEquitySizing,
  describeLiveEquitySizingZero,
  perPositionCapSource,
  capSourceLabelsMismatch,
  aggregateLiveEquitySizingZeroViews,
  emptyLiveEquitySizingZeroCounts,
  LiveEquitySizingLedger,
  LIVE_EQUITY_SIZING_ZERO_REASONS,
  type LiveEquitySizingArgs,
  type LiveEquitySizingZeroReason,
} from './live-equity-sizing-reason.js';
import { categorizeLiveSkipReason, LIVE_SKIP_CATEGORIES, sizeLiveEquityFromStop } from './signal-engine.js';

function balance(over: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
  return {
    totalEquity: 427.94,
    totalCash: 427.94,
    optionBuyingPower: 427.94,
    stockBuyingPower: 427.94,
    longMarketValue: 0,
    ...over,
  } as TradierAccountBalance;
}

/**
 * The live book from the TRA-4874 measurement: bqb1 `/api/state`, engineMode
 * live, production creds, account tail ***0154, 2026-09-24T20:45–20:49Z.
 * `totalCash $427.94` + `longMarketValue $0.00` ⇒ `baseEquity $427.94` ⇒
 * `cap = max($150, 15% × 427.94 = $64.19) = $150.00`.
 */
const LIVE_BOOK_USD = 427.94;

function args(over: Partial<LiveEquitySizingArgs> = {}): LiveEquitySizingArgs {
  return {
    balance: balance(),
    managedAccountRatio: 1,
    riskPerTrade: 0.01,
    entryPrice: 100,
    stopPrice: 98,
    currentPrice: 100,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PARITY — the arithmetic did not move
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pre-TRA-4877 `sizeLiveEquityFromStop` body, transcribed verbatim from
 * `a9a83a9a:packages/server/src/signal-engine.ts`. `perturb` exists ONLY so the
 * parity matrix below can be shown to detect a moved bound; the default
 * (`none`) is the shipped-before arithmetic.
 */
type LegacyPerturbation =
  | 'none'
  /** TRA-499 off-by-one: admit a ticket whose 1-share cost EQUALS the cap. */
  | 'cap_strictly_greater'
  /** Drop the multi-share trim back to `floor(cap / price)`. */
  | 'no_cap_trim'
  /** Ignore the TRA-389/1001/1301 regime position-size scalar. */
  | 'skip_multiplier'
  /** Never lift a rounded-to-zero qty to the LIVE 1-share floor. */
  | 'no_one_share_floor'
  /** Drop the TRA-711 funds check guarding the 1-share floor. */
  | 'no_affordable_floor'
  /** Drop the TRA-711 final available-funds ceiling. */
  | 'drop_final_funds_cap'
  /** Drop BOTH TRA-711 funds guards — the only combination that moves a number. */
  | 'no_funds_guards_at_all';

function legacySize(a: LiveEquitySizingArgs, perturb: LegacyPerturbation = 'none'): number {
  const { balance: bal, managedAccountRatio, riskPerTrade, entryPrice, stopPrice, currentPrice } = a;
  const dist = Math.abs(entryPrice - stopPrice);
  if (dist <= 0 || currentPrice <= 0) return 0;
  const lmv = bal.longMarketValue ?? 0;
  const baseEquity = (bal.totalCash ?? 0) + lmv;
  if (baseEquity <= 0) return 0;
  const managedEquity = baseEquity * managedAccountRatio;
  const maxRisk = managedEquity * riskPerTrade;
  if (maxRisk <= 0) return 0;
  const riskQty = Math.floor(maxRisk / dist);
  const equityCap = Math.floor(managedEquity / currentPrice);
  let qty = Math.min(riskQty, equityCap);
  const sbp = bal.stockBuyingPower;
  if (typeof sbp === 'number' && sbp > 0) {
    qty = Math.min(qty, Math.floor(sbp / currentPrice));
  }
  const mult = a.sizeMultiplier;
  if (perturb !== 'skip_multiplier' && typeof mult === 'number' && Number.isFinite(mult) && mult > 0 && mult < 1) {
    qty = Math.floor(qty * mult);
  }
  const affordableShares =
    typeof sbp === 'number' && Number.isFinite(sbp) && sbp > 0
      ? Math.floor(sbp / currentPrice)
      : Number.POSITIVE_INFINITY;
  const cap = perPositionCap(baseEquity);
  // TRA-499 strict-less-than admission. `cap_strictly_greater` is the classic
  // off-by-one that would admit a 100%-of-cap single fill.
  if (perturb === 'cap_strictly_greater' ? currentPrice > cap : currentPrice >= cap) return 0;
  const dropFloorGuard = perturb === 'no_affordable_floor' || perturb === 'no_funds_guards_at_all';
  const dropFinalCap = perturb === 'drop_final_funds_cap' || perturb === 'no_funds_guards_at_all';
  if (qty <= 0) {
    if (!dropFloorGuard && affordableShares < 1) return 0;
    if (perturb === 'no_one_share_floor') return 0;
    qty = 1;
  }
  if (perturb !== 'no_cap_trim' && qty > 0 && qty * currentPrice > cap) {
    qty = Math.floor(cap / currentPrice);
  }
  if (!dropFinalCap && Number.isFinite(affordableShares)) {
    qty = Math.min(qty, affordableShares);
  }
  return qty > 0 ? qty : 0;
}

/** The matrix both the control and its negative controls run over. */
function parityMatrix(): LiveEquitySizingArgs[] {
  const out: LiveEquitySizingArgs[] = [];
  const equities = [0, 1, 50, 427.94, 550, 999.99, 1000, 1667, 5000, 42_000];
  const prices = [0.5, 9.99, 40, 64.19, 149.99, 150, 150.01, 224.58, 335.92, 1181.89];
  const sbps: (number | null)[] = [null, 0, 26, 427.94, 10_000];
  const dists = [0, 0.01, 2, 25];
  for (const eq of equities) {
    for (const price of prices) {
      for (const sbp of sbps) {
        for (const dist of dists) {
          out.push({
            balance: balance({ totalCash: eq, totalEquity: eq, stockBuyingPower: sbp, longMarketValue: 0 }),
            managedAccountRatio: 1,
            riskPerTrade: 0.01,
            entryPrice: 100,
            stopPrice: 100 - dist,
            currentPrice: price,
            sizeMultiplier: dist === 2 ? 0.5 : undefined,
          });
        }
      }
    }
  }
  return out;
}

describe('TRA-4877 parity — explainLiveEquitySizing returns the pre-change share count', () => {
  const matrix = parityMatrix();

  it('matrix is large enough to be a control at all', () => {
    expect(matrix.length).toBeGreaterThanOrEqual(2000);
  });

  it('agrees with the pre-TRA-4877 body on EVERY point, and so does the public wrapper', () => {
    const disagreements: string[] = [];
    for (const a of matrix) {
      const want = legacySize(a);
      const got = explainLiveEquitySizing(a).qty;
      const viaWrapper = sizeLiveEquityFromStop(a);
      if (got !== want || viaWrapper !== want) {
        disagreements.push(
          `equity=${a.balance.totalCash} price=${a.currentPrice} sbp=${a.balance.stockBuyingPower} `
          + `dist=${a.entryPrice - a.stopPrice} mult=${a.sizeMultiplier} → legacy ${want}, new ${got}, wrapper ${viaWrapper}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  // The failing direction. If the matrix cannot catch a moved bound it is not
  // evidence of anything — this is the whole "a green that cannot go red" shape.
  it.each([
    ['cap_strictly_greater'],
    ['no_cap_trim'],
    ['skip_multiplier'],
    ['no_one_share_floor'],
  ] as const)('DETECTS a perturbed bound: %s', perturb => {
    const diffs = matrix.filter(a => legacySize(a, perturb) !== explainLiveEquitySizing(a).qty);
    expect(diffs.length).toBeGreaterThan(0);
  });

  /**
   * Measured while building the control above, and worth pinning rather than
   * deleting: the TRA-711 funds check guarding the 1-share floor and the TRA-711
   * final available-funds ceiling are **each individually unobservable in the
   * share count**. Removing either alone changes nothing on any of the 2,000
   * points, because the other one catches the same case:
   *
   *   • drop the guard ⇒ qty lifts to 1, then `min(1, 0)` re-zeroes it;
   *   • drop the ceiling ⇒ the guard already returned 0 before reaching it.
   *
   * They are defence in depth, not redundancy to "clean up" — and the only
   * reason the distinction is now visible at all is that this ticket attributes
   * the zero. Removing BOTH does move the number, which is what pins them: a
   * future edit that takes out one is safe, and one that takes out both is not.
   */
  it('the two TRA-711 funds guards are individually unobservable but jointly load-bearing', () => {
    for (const solo of ['no_affordable_floor', 'drop_final_funds_cap'] as const) {
      const diffs = matrix.filter(a => legacySize(a, solo) !== explainLiveEquitySizing(a).qty);
      expect(diffs.length, `${solo} alone must not move any share count`).toBe(0);
    }
    // Remove BOTH and the number does move — which is what pins them. An edit
    // that drops one is safe; one that drops both ships an order the broker
    // cannot fill, which is the TRA-711 screenshot.
    const jointDiffs = matrix.filter(
      a => legacySize(a, 'no_funds_guards_at_all') !== explainLiveEquitySizing(a).qty,
    );
    expect(jointDiffs.length).toBeGreaterThan(0);

    const screenshot = args({
      balance: balance({ totalCash: 1000, totalEquity: 1000, longMarketValue: 0, stockBuyingPower: 26 }),
      currentPrice: 129,
      riskPerTrade: 0.0001,
    });
    expect(explainLiveEquitySizing(screenshot).qty).toBe(0);
    expect(explainLiveEquitySizing(screenshot).zeroReason).toBe('available_funds_below_one_share');
    expect(legacySize(screenshot, 'no_affordable_floor')).toBe(0);
    expect(legacySize(screenshot, 'drop_final_funds_cap')).toBe(0);
    expect(legacySize(screenshot, 'no_funds_guards_at_all')).toBe(1);
  });

  it('exactly one of {qty > 0, zeroReason} is set on every matrix point', () => {
    for (const a of matrix) {
      const d = explainLiveEquitySizing(a);
      expect(d.qty > 0).toBe(d.zeroReason === null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SIX ZEROS ARE SIX DIFFERENT ANSWERS
// ─────────────────────────────────────────────────────────────────────────────

/** One reachable fixture per reason. Keyed so the `each` names read as the finding. */
const ZERO_FIXTURES: Record<LiveEquitySizingZeroReason, LiveEquitySizingArgs> = {
  stop_distance_nonpositive: args({ entryPrice: 100, stopPrice: 100 }),
  price_nonpositive: args({ currentPrice: 0 }),
  equity_nonpositive: args({
    balance: balance({ totalCash: 0, totalEquity: 0, longMarketValue: 0, stockBuyingPower: 0 }),
    currentPrice: 40,
  }),
  risk_budget_nonpositive: args({ riskPerTrade: 0, currentPrice: 40 }),
  // The measured live case: $427.94 book, AAPL at $335.92 ⇒ cap $150 ⇒ refused.
  priced_out_at_book: args({ currentPrice: 335.92 }),
  // $26 available funds against a $129 share — the TRA-711 screenshot. Price is
  // under the $150 cap, so the cap does NOT pre-empt this reason.
  available_funds_below_one_share: args({
    balance: balance({ totalCash: 1000, totalEquity: 1000, longMarketValue: 0, stockBuyingPower: 26 }),
    currentPrice: 129,
    riskPerTrade: 0.0001,
  }),
};

describe('TRA-4877 — every zero names itself', () => {
  it('all six reasons in the vocabulary are reachable', () => {
    const reached = new Set<string>();
    for (const [, a] of Object.entries(ZERO_FIXTURES)) {
      const d = explainLiveEquitySizing(a);
      expect(d.qty).toBe(0);
      if (d.zeroReason) reached.add(d.zeroReason);
    }
    expect([...reached].sort()).toEqual([...LIVE_EQUITY_SIZING_ZERO_REASONS].sort());
  });

  it.each(Object.entries(ZERO_FIXTURES))('fixture %s produces exactly that reason', (reason, a) => {
    expect(explainLiveEquitySizing(a).zeroReason).toBe(reason);
  });

  it('no two reasons share an operator string — the defect was that ALL of them did', () => {
    const strings = Object.values(ZERO_FIXTURES).map(a =>
      describeLiveEquitySizingZero(explainLiveEquitySizing(a)),
    );
    expect(new Set(strings).size).toBe(strings.length);
    // The failing direction, spelled out: the string the engine emitted before
    // this ticket was identical for all six, so a set of it collapses to 1.
    const legacyStrings = Object.values(ZERO_FIXTURES).map(
      () => 'Tradier sizing yielded qty=0 (cash=427.94 stockBP=427.94)',
    );
    expect(new Set(legacyStrings).size).toBe(1);
  });

  it('the priced-out string names the cap, the book, the cap source and the remedy', () => {
    const d = explainLiveEquitySizing(ZERO_FIXTURES.priced_out_at_book);
    const s = describeLiveEquitySizingZero(d);
    expect(s).toContain('[priced_out_at_book]');
    expect(s).toContain('$335.92');
    expect(s).toContain('$150.00');
    expect(s).toContain('$427.94');
    expect(s).toContain('floor_150');
    expect(s).toContain('TRA-499');
    // The remedy threshold: 15% × E >= $150 ⇔ E >= $1,000.
    expect(s).toContain('$1000.00');
  });

  it('a dead quote is NOT reported as a book bound, and an empty book is NOT reported as a feed gap', () => {
    expect(describeLiveEquitySizingZero(explainLiveEquitySizing(ZERO_FIXTURES.price_nonpositive)))
      .toContain('FEED gap');
    expect(describeLiveEquitySizingZero(explainLiveEquitySizing(ZERO_FIXTURES.price_nonpositive)))
      .not.toContain('per-position cap');
    expect(describeLiveEquitySizingZero(explainLiveEquitySizing(ZERO_FIXTURES.equity_nonpositive)))
      .not.toContain('FEED gap');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE MEASURED CENSUS, AND THE BOUND THAT DID NOT MOVE
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4877 — the TRA-4874 census reproduces, and the cap is untouched', () => {
  it('reproduces the live cap: $427.94 book ⇒ $150.00 cap from the dollar FLOOR, not 15%', () => {
    const d = explainLiveEquitySizing(args({ currentPrice: 40 }));
    expect(d.baseEquity).toBeCloseTo(LIVE_BOOK_USD, 2);
    expect(d.cap).toBeCloseTo(150, 2);
    expect(d.capSource).toBe('floor_150');
    // 15% × 427.94 = 64.19, which is BELOW the floor — so the floor is being
    // generous here, not strict. Loosening the floor would price out MORE names.
    expect(LIVE_BOOK_USD * OPTIONS_POSITION_CAP_RATIO).toBeCloseTo(64.19, 2);
  });

  it('every one of the 25 named census tickers still sizes to 0 at the live book', () => {
    // The prices the census recorded at 2026-09-24T20:47Z.
    const censusPrices = [
      335.92, 497.93, 224.58, 342.36, 249.38, 777.59, 377.94, 629.26, 350.36, 767.18,
      741.10, 281.66, 512.68, 161.61, 199.21, 1181.89, 805.25, 905.92, 566.08, 367.98,
      375.01, 450.31, 474.25, 511.38, 548.78,
    ];
    for (const p of censusPrices) {
      const d = explainLiveEquitySizing(args({ currentPrice: p }));
      expect(d.qty).toBe(0);
      expect(d.zeroReason).toBe('priced_out_at_book');
    }
    // …and the complement holds: below the cap the path is open, so this is a
    // price bound and not a blanket "live equities are off".
    const cheap = explainLiveEquitySizing(args({ currentPrice: 40 }));
    expect(cheap.qty).toBeGreaterThan(0);
    expect(cheap.zeroReason).toBeNull();
  });

  it('the TRA-499 strict-less-than boundary is EXACTLY where it was', () => {
    expect(explainLiveEquitySizing(args({ currentPrice: 149.99 })).qty).toBeGreaterThan(0);
    expect(explainLiveEquitySizing(args({ currentPrice: 150 })).zeroReason).toBe('priced_out_at_book');
    expect(explainLiveEquitySizing(args({ currentPrice: 150.01 })).zeroReason).toBe('priced_out_at_book');
  });

  it('capSource switches to pct_15 only ABOVE a $1,000 book; the tie reports the floor', () => {
    expect(perPositionCapSource(999.99)).toBe('floor_150');
    expect(perPositionCapSource(1000)).toBe('floor_150');
    expect(perPositionCapSource(1000.01)).toBe('pct_15');
    const big = explainLiveEquitySizing(args({
      balance: balance({ totalCash: 5000, totalEquity: 5000, longMarketValue: 0, stockBuyingPower: 5000 }),
      currentPrice: 335.92,
    }));
    expect(big.capSource).toBe('pct_15');
    expect(big.cap).toBeCloseTo(750, 2);
    expect(big.qty).toBeGreaterThan(0);
  });

  it('the capSource LABELS still describe the live board constants', () => {
    expect(capSourceLabelsMismatch()).toBeNull();
    // Stated explicitly so a board change to either number trips here with the
    // reason, rather than mislabelling `capSource` forever.
    expect(OPTIONS_PER_TICKET_DOLLAR_FLOOR).toBe(150);
    expect(OPTIONS_POSITION_CAP_RATIO).toBe(0.15);
  });

  it('affordableShares is null — not 0 — when the broker surfaced no buying-power bucket', () => {
    const unknown = explainLiveEquitySizing(args({
      balance: balance({ stockBuyingPower: null }),
      currentPrice: 40,
    }));
    expect(unknown.affordableShares).toBeNull();
    const measured = explainLiveEquitySizing(args({
      balance: balance({ totalCash: 1000, totalEquity: 1000, stockBuyingPower: 26, longMarketValue: 0 }),
      currentPrice: 129,
    }));
    expect(measured.affordableShares).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE REDACTED PROBE SPLITS THE CAP OUT OF `other`
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4877 — categorizeLiveSkipReason separates the capital-size refusal', () => {
  it('a priced-out reason buckets as sizing_priced_out_at_book, NOT other and NOT broker_reject', () => {
    const raw = `${describeLiveEquitySizingZero(explainLiveEquitySizing(ZERO_FIXTURES.priced_out_at_book))} (cash=427.94 stockBP=427.94)`;
    expect(categorizeLiveSkipReason(raw)).toBe('sizing_priced_out_at_book');
    expect(categorizeLiveSkipReason(raw)).not.toBe('other');
    expect(categorizeLiveSkipReason(raw)).not.toBe('broker_reject');
  });

  it('the other five sizing zeros bucket as sizing_zero_not_cap — a DIFFERENT bucket from the cap', () => {
    for (const key of LIVE_EQUITY_SIZING_ZERO_REASONS) {
      if (key === 'priced_out_at_book') continue;
      const raw = describeLiveEquitySizingZero(explainLiveEquitySizing(ZERO_FIXTURES[key]));
      expect(categorizeLiveSkipReason(raw)).toBe('sizing_zero_not_cap');
    }
  });

  it('the PRE-change string lands in sizing_zero_not_cap, so historical rows still leave `other`', () => {
    const legacy = 'Tradier sizing yielded qty=0 (cash=427.94 stockBP=427.94)';
    expect(categorizeLiveSkipReason(legacy)).toBe('sizing_zero_not_cap');
    // This is the bucket it used to land in, and why the census had to be
    // re-derived from source: `other` also holds genuinely unknown reasons.
    expect(categorizeLiveSkipReason('something nobody has ever seen')).toBe('other');
  });

  it('both new categories are in the runtime array, so the zero-init breakdown carries them', () => {
    expect(LIVE_SKIP_CATEGORIES).toContain('sizing_priced_out_at_book');
    expect(LIVE_SKIP_CATEGORIES).toContain('sizing_zero_not_cap');
  });

  it('an actual broker reject still buckets as broker_reject — the new matches did not shadow it', () => {
    expect(categorizeLiveSkipReason('Tradier rejected the entry leg')).toBe('broker_reject');
    expect(categorizeLiveSkipReason('order cancelled by the broker')).toBe('broker_reject');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE FOLD, AND ITS PROVENANCE CELL
// ─────────────────────────────────────────────────────────────────────────────

const T1 = Date.parse('2026-09-24T20:47:00Z'); // 16:47 ET, 2026-09-24
const T2 = Date.parse('2026-09-25T14:00:00Z'); // 10:00 ET, 2026-09-25

describe('TRA-4877 — the per-ET-day fold outside the signal ring', () => {
  it('a fold that was never called reads never_recorded, NOT a clean zero', () => {
    const view = new LiveEquitySizingLedger(T1).snapshot();
    expect(view.wiring).toBe('never_recorded');
    expect(view.decisionsSinceBoot).toBe(0);
    expect(view.zerosSinceBootByReason.priced_out_at_book).toBe(0);
    expect(view.lastZeroReason).toBeNull();
    // The discriminator: a MEASURED zero-priced-out day has the same count and a
    // different verdict. Without `wiring` these two reads are identical.
    const measured = new LiveEquitySizingLedger(T1);
    measured.record(explainLiveEquitySizing(args({ currentPrice: 40 })), T1);
    const m = measured.snapshot();
    expect(m.zerosSinceBootByReason.priced_out_at_book).toBe(0);
    expect(m.wiring).toBe('recorded_no_zeros');
    expect(m.wiring).not.toBe(view.wiring);
  });

  it('counts zeros by reason per ET day and keeps a since-boot roll beside them', () => {
    const l = new LiveEquitySizingLedger(T1);
    l.record(explainLiveEquitySizing(args({ currentPrice: 335.92 })), T1);
    l.record(explainLiveEquitySizing(args({ currentPrice: 497.93 })), T1);
    l.record(explainLiveEquitySizing(args({ currentPrice: 40 })), T1);
    l.record(explainLiveEquitySizing(args({ currentPrice: 0 })), T2);
    const v = l.snapshot();
    expect(v.wiring).toBe('recorded_with_zeros');
    expect(v.decisionsSinceBoot).toBe(4);
    expect(v.sizedSinceBoot).toBe(1);
    expect(v.zerosSinceBootByReason.priced_out_at_book).toBe(2);
    expect(v.zerosSinceBootByReason.price_nonpositive).toBe(1);
    expect(v.lastZeroReason).toBe('price_nonpositive');
    // Newest ET day first.
    expect(v.days.map(d => d.etDay)).toEqual(['2026-09-25', '2026-09-24']);
    const d24 = v.days.find(d => d.etDay === '2026-09-24')!;
    expect(d24.decisions).toBe(3);
    expect(d24.sized).toBe(1);
    expect(d24.zerosByReason.priced_out_at_book).toBe(2);
    expect(v.days.find(d => d.etDay === '2026-09-25')!.zerosByReason.price_nonpositive).toBe(1);
  });

  it('the day cap evicts days but NOT the since-boot roll, and the eviction is counted', () => {
    const l = new LiveEquitySizingLedger(T1, 2);
    const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
    for (const d of days) {
      l.record(explainLiveEquitySizing(args({ currentPrice: 335.92 })), Date.parse(`${d}T18:00:00Z`));
    }
    const v = l.snapshot();
    expect(v.days.map(x => x.etDay)).toEqual(['2026-09-24', '2026-09-23']);
    expect(v.etDaysDropped).toBe(2);
    // The number the surface exists to publish survived the eviction — this is
    // the ring-eviction failure the ticket's parent (TRA-4936) measured.
    expect(v.zerosSinceBootByReason.priced_out_at_book).toBe(4);
    expect(v.decisionsSinceBoot).toBe(4);
  });

  it('countsSince is published, so a since-boot count cannot be read as all-time', () => {
    expect(new LiveEquitySizingLedger(T1).snapshot().countsSince).toBe('2026-09-24T20:47:00.000Z');
  });

  it('capLabelMismatch is null today and is a property of the SURFACE, not the sizer', () => {
    expect(new LiveEquitySizingLedger(T1).snapshot().capLabelMismatch).toBeNull();
  });
});

describe('TRA-4877 — the fleet fold', () => {
  it('no engines reads never_recorded with engineCount 0, never a clean recorded_no_zeros', () => {
    const f = aggregateLiveEquitySizingZeroViews([]);
    expect(f.wiring).toBe('never_recorded');
    expect(f.engineCount).toBe(0);
    expect(f.decisionsSinceBoot).toBe(0);
  });

  it('one measuring engine outranks any number of silent ones', () => {
    const silent = new LiveEquitySizingLedger(T1).snapshot();
    const loud = new LiveEquitySizingLedger(T1);
    loud.record(explainLiveEquitySizing(args({ currentPrice: 335.92 })), T1);
    const f = aggregateLiveEquitySizingZeroViews([silent, silent, loud.snapshot()]);
    expect(f.wiring).toBe('recorded_with_zeros');
    expect(f.engineCount).toBe(3);
    expect(f.enginesNeverRecorded).toBe(2);
    expect(f.decisionsSinceBoot).toBe(1);
    expect(f.zerosSinceBootByReason.priced_out_at_book).toBe(1);
    expect(f.lastDecisionEtDay).toBe('2026-09-24');
  });

  it('sums per reason across engines and keeps the newest decision day', () => {
    const a1 = new LiveEquitySizingLedger(T1);
    a1.record(explainLiveEquitySizing(args({ currentPrice: 335.92 })), T1);
    a1.record(explainLiveEquitySizing(args({ currentPrice: 40 })), T1);
    const a2 = new LiveEquitySizingLedger(T1);
    a2.record(explainLiveEquitySizing(args({ currentPrice: 497.93 })), T2);
    const f = aggregateLiveEquitySizingZeroViews([a1.snapshot(), a2.snapshot()]);
    expect(f.decisionsSinceBoot).toBe(3);
    expect(f.sizedSinceBoot).toBe(1);
    expect(f.zerosSinceBootByReason.priced_out_at_book).toBe(2);
    expect(f.lastDecisionEtDay).toBe('2026-09-25');
    expect(f.enginesNeverRecorded).toBe(0);
  });

  it('emptyLiveEquitySizingZeroCounts carries every reason key, so no bucket is absent-vs-zero', () => {
    const counts = emptyLiveEquitySizingZeroCounts();
    expect(Object.keys(counts).sort()).toEqual([...LIVE_EQUITY_SIZING_ZERO_REASONS].sort());
    for (const r of LIVE_EQUITY_SIZING_ZERO_REASONS) expect(counts[r]).toBe(0);
  });
});
