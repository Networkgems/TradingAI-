/**
 * TRA-2873 — Gain/Loss doesn't match between TradingAI and the Tradier LIVE
 * production account.
 *
 * The board posted two screenshots taken at the same instant against live
 * account 6YB80154. The same three contracts price out differently on the two
 * surfaces:
 *
 *   contract                    TradingAI paid   Tradier cost_basis   gap
 *   AAPL 2026-09-04 280 P  x4   0.9950 ($398)    1.0400 ($416)        $18
 *   SPY  2026-09-04 816 C  x4   0.0750 ($ 30)    0.0800 ($ 32)        $ 2
 *   SPY  2026-09-04 820 C  x2   0.0650 ($ 13)    0.0800 ($ 16)        $ 3
 *                               ---------------  -------------------  -----
 *                               $441             $464                 $23
 *
 * (TradingAI's per-share numbers above are recovered exactly from the
 * screenshot: P&L $ / contracts / 100 gives the mark−paid spread, and the
 * displayed P&L % pins the denominator. All three land on a half-cent — they
 * are NBBO MIDs, i.e. the scanner's pre-trade quote, not a broker fill.)
 *
 * ROOT CAUSE (`options-account.ts`, the `for (const incoming of positions)`
 * merge loop in `reconcileTradierPositions`):
 *
 *     if (existing) {
 *       if (!existing.importedFromTradier) {
 *         // Engine-opened position covers this OCC symbol — skip so we
 *         // don't conflict with the engine's own bookkeeping.
 *         continue;                     // <-- TRA-2873
 *       }
 *       ...
 *       existing.premiumPaid = incoming.premiumPaid;   // broker truth
 *
 * `TradierOpenOptionPosition.premiumPaid` is already derived from the broker's
 * authoritative `cost_basis` (`options-client.ts`: `cost_basis / quantity /
 * 100`). An IMPORTED row is restated to it; an ENGINE-OPENED row is skipped and
 * keeps `premiumPaid = signal.mark` forever — see `openOptionFromCandidate`:
 *
 *     const premiumPaid = mode === 'demo' ? rawMark * (1 + demoSlippagePct) : rawMark;
 *     // "in live premiumPaid == rawMark ... the realised broker slippage
 *     //  reconciles via the mirror"
 *
 * The mirror reconciles the JOURNAL. It never reconciles the POSITION, and the
 * position is what the Options panel and every P&L tile read. So a live
 * engine-opened book is permanently costed at the pre-trade mid.
 *
 * All three rows in the screenshot are `OTM Mispricing` (engine-opened — none
 * carry the `(Tradier)` badge), so all three take the `continue`.
 *
 * WHAT THIS FILE DOES: it pins the CURRENT (defective) behaviour so the gap is
 * a number in CI rather than a screenshot, and it isolates the discriminator —
 * ONE payload, ONE field, TWO rows, only one of which gets restated. When
 * TRA-2873 is fixed, the assertions marked `TRA-2873 FIX FLIPS THIS` invert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// 10:00 ET on Tuesday 2026-08-04 (EDT, UTC-4) — inside the trading window, and
// ~31 DTE against the Sep 4 expiry so the entry DTE guard passes.
const TRADING_TIME = Date.parse('2026-08-04T14:00:00Z');

/** The three live contracts from the TRA-2873 screenshots. */
const BOOK = [
  {
    label: 'AAPL 2026-09-04 $280 P',
    optionSymbol: 'AAPL260904P00280000',
    underlying: 'AAPL',
    optionType: 'put' as const,
    strike: 280,
    contracts: 4,
    /** What the scanner saw (NBBO mid) — what TradingAI booked. */
    scannerMark: 0.995,
    /** Tradier `cost_basis / qty / 100` — what actually left the account. */
    brokerCostPerShare: 1.04,
    /** TradingAI's current mark from the screenshot (Allocation by Name). */
    currentMark: 0.965,
    /** Underlying spot off the Tradier screenshot. */
    spot: 333.43,
  },
  {
    label: 'SPY 2026-09-04 $816 C',
    optionSymbol: 'SPY260904C00816000',
    underlying: 'SPY',
    optionType: 'call' as const,
    strike: 816,
    contracts: 4,
    scannerMark: 0.075,
    brokerCostPerShare: 0.08,
    currentMark: 0.095,
    spot: 741.69,
  },
  {
    label: 'SPY 2026-09-04 $820 C',
    optionSymbol: 'SPY260904C00820000',
    underlying: 'SPY',
    optionType: 'call' as const,
    strike: 820,
    contracts: 2,
    scannerMark: 0.065,
    brokerCostPerShare: 0.08,
    currentMark: 0.075,
    spot: 741.69,
  },
];

/**
 * `openOptionFromCandidate(signal, mode, equityOverride, underlyingSpot,
 * journalSetup, boundedLiveContracts, sizeMultiplier)` — `boundedLiveContracts`
 * is the SIXTH parameter. Pinning the exact contract count matters here: the
 * screenshot's 4/4/2 split is what makes the $23 decompose per-position.
 */
function openLive(acct: PaperOptionsAccount, o: (typeof BOOK)[number]) {
  return acct.openOptionFromCandidate(
    buildSignal(o), 'live', 50_000, o.spot, undefined, o.contracts,
  );
}

function buildSignal(o: (typeof BOOK)[number]): OtmMispricingSignal {
  return {
    id: `sig-${o.optionSymbol}`,
    symbol: o.underlying,
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: o.scannerMark,
    stopLoss: o.scannerMark * 0.8,
    takeProfit: o.scannerMark * 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: o.optionSymbol,
    optionType: o.optionType,
    strike: o.strike,
    expiration: '2026-09-04',
    mark: o.scannerMark,
    theo: o.scannerMark * 1.3,
    mispricingPct: -0.23,
    delta: o.optionType === 'put' ? -0.5 : 0.5,
  };
}

/** The `/positions` row Tradier would return for `o`, costed at broker truth. */
function buildBrokerPosition(o: (typeof BOOK)[number]): TradierOpenOptionPosition {
  return {
    optionSymbol: o.optionSymbol,
    underlying: o.underlying,
    optionType: o.optionType,
    strike: o.strike,
    expiration: '2026-09-04',
    contracts: o.contracts,
    // `options-client.ts` already divides `cost_basis` by qty × 100 for us.
    premiumPaid: o.brokerCostPerShare,
    acquiredAt: TRADING_TIME,
  };
}

/** Σ premiumPaid × contractsRemaining × 100 over the live book. */
function bookCostBasis(acct: PaperOptionsAccount): number {
  return acct
    .getState()
    .openOptions.reduce((sum, o) => sum + o.premiumPaid * o.contractsRemaining * 100, 0);
}

function openLiveBook(acct: PaperOptionsAccount) {
  for (const o of BOOK) {
    const pos = openLive(acct, o);
    // Guard the fixture itself: a null here means an entry gate rejected the
    // candidate and the rest of this file would assert on an empty book.
    expect(pos, `${o.label} failed to open`).not.toBeNull();
    expect(pos!.contracts).toBe(o.contracts);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-2873 — live cost basis diverges from Tradier `cost_basis`', () => {
  it('books a LIVE engine-opened position at the scanner mark, not the broker fill', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const aapl = BOOK[0];

    const pos = openLive(acct, aapl);

    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(4);
    // This is the origin of the whole ticket: live cost basis IS the pre-trade
    // quote. Nothing downstream ever replaces it with what the account paid.
    expect(pos!.premiumPaid).toBeCloseTo(aapl.scannerMark, 6);
    expect(pos!.premiumPaid).not.toBeCloseTo(aapl.brokerCostPerShare, 6);
    expect(pos!.importedFromTradier).toBeUndefined();
  });

  it('DISCRIMINATOR: one reconcile payload restates an imported row and skips an engine-opened row', () => {
    const spy816 = BOOK[1];
    const spy820 = BOOK[2];

    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });

    // Row A — engine-opened (OTM Mispricing), costed at the scanner mid.
    const engineRow = openLive(acct, spy816);
    expect(engineRow).not.toBeNull();

    // Row B — adopted from Tradier at a stale basis, so the SAME payload below
    // carries a genuine correction for it too.
    acct.reconcileTradierPositions([
      { ...buildBrokerPosition(spy820), premiumPaid: 0.065 },
    ]);

    // ONE payload. BOTH rows are wrong by the same kind of error, and both
    // corrections are present in it.
    const summary = acct.reconcileTradierPositions([
      buildBrokerPosition(spy816),
      buildBrokerPosition(spy820),
    ]);

    const bySymbol = new Map(acct.getState().openOptions.map(o => [o.optionSymbol, o]));
    const imported = bySymbol.get(spy820.optionSymbol)!;
    const engine = bySymbol.get(spy816.optionSymbol)!;

    // The imported row IS restated to broker truth — the mechanism works.
    expect(imported.importedFromTradier).toBe(true);
    expect(imported.premiumPaid).toBeCloseTo(spy820.brokerCostPerShare, 6);

    // TRA-2873 FIX FLIPS THIS — the engine-opened row is skipped by
    // `if (!existing.importedFromTradier) continue;` and keeps the mid.
    expect(engine.importedFromTradier).toBeUndefined();
    expect(engine.premiumPaid).toBeCloseTo(spy816.scannerMark, 6);
    expect(engine.premiumPaid).not.toBeCloseTo(spy816.brokerCostPerShare, 6);

    // Only the imported row is counted as updated; the engine row is invisible
    // to the summary, so a reconcile that fixed NOTHING for it still reads
    // "updated: 1" — the sweep cannot report the gap it is leaving behind.
    expect(summary.updated).toBe(1);
    expect(summary.total).toBe(2);
  });

  it('reproduces the screenshot: $23.00 of cost basis is missing across the 3-position book', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openLiveBook(acct);

    const brokerCostBasis = BOOK.reduce(
      (sum, o) => sum + o.brokerCostPerShare * o.contracts * 100, 0,
    );
    // Tradier's own "COST BASIS $464.00" portfolio tile.
    expect(brokerCostBasis).toBeCloseTo(464, 6);

    // TRA-2873 FIX FLIPS THIS — after the fix `bookCostBasis` must equal 464.
    expect(bookCostBasis(acct)).toBeCloseTo(441, 6);

    // A reconcile against the real broker book does NOT close the gap.
    acct.reconcileTradierPositions(BOOK.map(buildBrokerPosition));
    expect(bookCostBasis(acct)).toBeCloseTo(441, 6);
    expect(brokerCostBasis - bookCostBasis(acct)).toBeCloseTo(23, 6);
  });

  it('understates the loss: unrealized P&L reads -$2.00 where broker cost basis gives -$25.00', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openLiveBook(acct);
    acct.reconcileTradierPositions(BOOK.map(buildBrokerPosition));

    // Apply the marks TradingAI itself was showing (screenshot: Allocation by
    // Name sums to the $439.00 Book Premium tile). Marks are NOT the axis under
    // test here — holding them fixed isolates the cost-basis error.
    const bySymbol = new Map(acct.getState().openOptions.map(o => [o.optionSymbol, o]));
    let bookPremium = 0;
    let unrealizedAtScannerBasis = 0;
    let unrealizedAtBrokerBasis = 0;
    for (const o of BOOK) {
      const pos = bySymbol.get(o.optionSymbol)!;
      const qty = pos.contractsRemaining;
      bookPremium += o.currentMark * qty * 100;
      unrealizedAtScannerBasis += (o.currentMark - pos.premiumPaid) * qty * 100;
      unrealizedAtBrokerBasis += (o.currentMark - o.brokerCostPerShare) * qty * 100;
    }

    // The "BOOK PREMIUM $439.00" tile — reproduced exactly.
    expect(bookPremium).toBeCloseTo(439, 6);
    // The "OPEN OPTS P&L (UNREALIZED) -$2.00" footer — reproduced exactly.
    expect(unrealizedAtScannerBasis).toBeCloseTo(-2, 6);
    // TRA-2873 FIX FLIPS THIS — same marks, broker cost basis, 12.5x the loss.
    expect(unrealizedAtBrokerBasis).toBeCloseTo(-25, 6);
    // The understatement is exactly the missing cost basis.
    expect(unrealizedAtScannerBasis - unrealizedAtBrokerBasis).toBeCloseTo(23, 6);
  });
});
