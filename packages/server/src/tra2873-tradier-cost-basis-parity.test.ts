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

    // TRA-2889 FIXED — the engine-opened row is now restated to broker truth
    // too. It is still engine-opened (the fix corrects the basis; it does NOT
    // convert the row into an import).
    expect(engine.importedFromTradier).toBeUndefined();
    expect(engine.premiumPaid).toBeCloseTo(spy816.brokerCostPerShare, 6);
    expect(engine.premiumPaid).not.toBeCloseTo(spy816.scannerMark, 6);

    // BOTH corrections in the payload are now counted. The sweep can finally
    // report the gap it used to leave behind silently.
    expect(summary.updated).toBe(2);
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

    // Before any reconcile the book is still at the scanner mids — that is the
    // state the screenshots captured.
    expect(bookCostBasis(acct)).toBeCloseTo(441, 6);

    // TRA-2889 FIXED — a reconcile against the real broker book now closes the
    // gap exactly, to the cent.
    acct.reconcileTradierPositions(BOOK.map(buildBrokerPosition));
    expect(bookCostBasis(acct)).toBeCloseTo(464, 6);
    expect(brokerCostBasis - bookCostBasis(acct)).toBeCloseTo(0, 6);
  });

  it('understates the loss: unrealized P&L reads -$2.00 where broker cost basis gives -$25.00', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    openLiveBook(acct);

    // Marks are NOT the axis under test — holding them fixed at what TradingAI
    // itself was showing (screenshot: Allocation by Name sums to the $439.00
    // Book Premium tile) isolates the cost-basis error.
    const unrealizedAgainstBook = (): number => {
      const bySymbol = new Map(acct.getState().openOptions.map(o => [o.optionSymbol, o]));
      let total = 0;
      for (const o of BOOK) {
        const pos = bySymbol.get(o.optionSymbol)!;
        total += (o.currentMark - pos.premiumPaid) * pos.contractsRemaining * 100;
      }
      return total;
    };

    const bookPremium = BOOK.reduce((sum, o) => sum + o.currentMark * o.contracts * 100, 0);
    const unrealizedAtBrokerBasis = BOOK.reduce(
      (sum, o) => sum + (o.currentMark - o.brokerCostPerShare) * o.contracts * 100, 0,
    );

    // The "BOOK PREMIUM $439.00" tile — reproduced exactly.
    expect(bookPremium).toBeCloseTo(439, 6);
    // The "OPEN OPTS P&L (UNREALIZED) -$2.00" footer — reproduced exactly. This
    // is the screenshot state: pre-reconcile, costed at the scanner mids.
    expect(unrealizedAgainstBook()).toBeCloseTo(-2, 6);
    // Same marks, broker cost basis, 12.5x the loss.
    expect(unrealizedAtBrokerBasis).toBeCloseTo(-25, 6);
    // The understatement is exactly the missing cost basis.
    expect(unrealizedAgainstBook() - unrealizedAtBrokerBasis).toBeCloseTo(23, 6);

    // TRA-2889 FIXED — after a reconcile the book reports the real loss.
    acct.reconcileTradierPositions(BOOK.map(buildBrokerPosition));
    expect(unrealizedAgainstBook()).toBeCloseTo(-25, 6);
  });

  /**
   * TRA-2889 — the restatement must carry the risk schedule with it. These are
   * the guards the ticket flagged as most likely to be missed.
   */
  describe('TRA-2889 — restatement safety', () => {
    const aapl = BOOK[0];

    it('re-derives the stop off the corrected basis, not the stale mid', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      const opened = openLive(acct, aapl)!;
      const before = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      // Snapshot as PRIMITIVES — `getState()` hands back live position objects,
      // so holding the reference would see the restatement we are measuring.
      const stopBefore = before.stopLossPremium;
      const stopRatioBefore = before.stopLossPremium / before.premiumPaid;
      const tp1RatioBefore = before.tp1Premium / before.premiumPaid;
      expect(opened).not.toBeNull();

      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const after = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      expect(after.premiumPaid).toBeCloseTo(aapl.brokerCostPerShare, 6);
      // The schedule is preserved RELATIVE to the corrected basis — the stop
      // moved up with the basis instead of staying anchored to the old mid.
      expect(after.stopLossPremium / after.premiumPaid).toBeCloseTo(stopRatioBefore, 10);
      expect(after.tp1Premium / after.premiumPaid).toBeCloseTo(tp1RatioBefore, 10);
      expect(after.stopLossPremium).toBeGreaterThan(stopBefore);
    });

    it('does not let the broker payload drive quantity', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      const before = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      const contracts = before.contracts;
      const contractsRemaining = before.contractsRemaining;

      // Broker reports a DIFFERENT quantity — the partial-close bookkeeping
      // owns that field, not the reconcile.
      //
      // TRA-3890 — and the PRICE is not restated either. This test used to
      // assert the opposite (quantity kept, blended price written), which is
      // exactly what booked BAC at $1.41 against a $1.65 fill on 2026-08-20:
      // a 99-lot broker average is not the basis of this row's lot.
      const premiumBefore = before.premiumPaid;
      acct.reconcileTradierPositions([
        { ...buildBrokerPosition(aapl), contracts: 99 },
      ]);

      const after = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      expect(after.contracts).toBe(contracts);
      expect(after.contractsRemaining).toBe(contractsRemaining);
      expect(after.premiumPaid).toBe(premiumBefore);
      expect(acct.getEngineBasisRestatementCensus().skips.quantity_mismatch).toBe(1);
    });

    it('leaves an in-flight row alone — the exit poller books the real fill', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      const pos = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      const live = (acct as unknown as { openOptions: Map<string, typeof pos> }).openOptions.get(pos.id)!;
      live.pendingCloseOrderId = 12345;

      const summary = acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const after = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      expect(after.premiumPaid).toBeCloseTo(aapl.scannerMark, 6);
      expect(summary.updated).toBe(0);
    });

    it('is idempotent — a second reconcile is a no-op and is not re-counted', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);

      const first = acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);
      expect(first.updated).toBe(1);

      const second = acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);
      expect(second.updated).toBe(0);

      const after = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      expect(after.premiumPaid).toBeCloseTo(aapl.brokerCostPerShare, 6);
    });
  });

  /**
   * TRA-3010 — the instrument that makes gate A readable on the live box.
   *
   * The restatement is destructive in place and the live reconcile cadence is
   * 30s, so nothing outside the process can observe the pre-state. Worse, the
   * thresholds are RESCALED, so `stop / premiumPaid` reads the same constant
   * whether the restatement fired or was never wired at all. These tests pin the
   * two properties that make a later live read gradeable rather than vacuous:
   * the before/after pair is captured, and the DENOMINATOR is published so an
   * empty ledger cannot be mistaken for a verified one.
   */
  describe('TRA-3010 — engine-basis restatement census', () => {
    const aapl = BOOK[0];

    it('captures the pre-state that the in-place restatement destroys', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const census = acct.getEngineBasisRestatementCensus();
      expect(census.candidates).toBe(1);
      expect(census.restated).toBe(1);
      expect(census.restatements).toHaveLength(1);

      const rec = census.restatements[0]!;
      expect(rec.optionSymbol).toBe(aapl.optionSymbol);
      // The whole point: the scanner mark is unrecoverable from the row after
      // the fact, so it has to be here.
      expect(rec.premiumPaidBefore).toBeCloseTo(aapl.scannerMark, 6);
      expect(rec.premiumPaidAfter).toBeCloseTo(aapl.brokerCostPerShare, 6);
      expect(rec.premiumPaidBefore).not.toBeCloseTo(rec.premiumPaidAfter, 6);

      // Assertion 2 of the gate, to the cent, against broker truth.
      expect(rec.brokerCostBasisUsd).toBeCloseTo(
        aapl.brokerCostPerShare * aapl.contracts * 100,
        2,
      );

      // Assertion 3: rescaled, not recomputed — the ratios are invariant.
      expect(rec.stopRatioAfter).toBeCloseTo(rec.stopRatioBefore, 10);
      expect(rec.tp1RatioAfter).toBeCloseTo(rec.tp1RatioBefore, 10);
      // ...and the levels themselves DID move, which is what distinguishes a
      // carried schedule from an untouched one (equal ratios alone cannot).
      expect(rec.stopLossPremiumAfter).not.toBeCloseTo(rec.stopLossPremiumBefore, 6);
      expect(rec.tp1PremiumAfter).not.toBeCloseTo(rec.tp1PremiumBefore, 6);
    });

    it('BLIND, not PASS: no engine row means the branch never ran', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      // Exactly today's live book: a payload with nothing of ours in it.
      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const census = acct.getEngineBasisRestatementCensus();
      expect(census.candidates).toBe(0);
      expect(census.restated).toBe(0);
      expect(census.restatements).toHaveLength(0);
      // The denominator is what separates this from the case below. Both hand
      // back an empty `restatements`; only `candidates` says which one it is.
    });

    it('separates a NO-OP match from a real one — the vacuous-green trap', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      // Broker cost basis lands exactly on the scanner mark (no spread crossed).
      // The restatement correctly does nothing — but a reader that only checked
      // "premiumPaid == broker cost_basis" would score this as a PASS while the
      // corrected branch never executed a single line.
      acct.reconcileTradierPositions([
        { ...buildBrokerPosition(aapl), premiumPaid: aapl.scannerMark },
      ]);

      const census = acct.getEngineBasisRestatementCensus();
      expect(census.candidates).toBe(1);
      expect(census.restated).toBe(0);
      expect(census.skips.zero_delta).toBe(1);
      expect(census.restatements).toHaveLength(0);
    });

    it('TRA-3890: refuses to write a blended multi-lot broker average onto a smaller engine row', () => {
      // 2026-08-20, BAC260925C00063000: the engine filled 1 @ 1.65, a desk-side
      // add of 1 @ 1.17 made the broker's row 2 contracts / cost_basis 282,
      // and the restatement wrote 282/2/100 = 1.41 onto the engine's 1-lot row.
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      const before = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      const premiumBefore = before.premiumPaid;
      const stopBefore = before.stopLossPremium;
      const contractsBefore = before.contracts;

      const blended = (aapl.brokerCostPerShare * aapl.contracts + 1.17 * 1) / (aapl.contracts + 1);
      const summary = acct.reconcileTradierPositions([
        { ...buildBrokerPosition(aapl), contracts: aapl.contracts + 1, premiumPaid: blended },
      ]);

      const after = acct.getState().openOptions.find(o => o.optionSymbol === aapl.optionSymbol)!;
      expect(after.premiumPaid).toBe(premiumBefore);
      expect(after.stopLossPremium).toBe(stopBefore);
      expect(after.contracts).toBe(contractsBefore);
      expect(summary.updated).toBe(0);
      const census = acct.getEngineBasisRestatementCensus();
      expect(census.candidates).toBe(1);
      expect(census.restated).toBe(0);
      expect(census.skips.quantity_mismatch).toBe(1);
      expect(census.skips.zero_delta).toBe(0);
      // NEGATIVE CONTROL: same lot size ⇒ the restatement still runs.
      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);
      expect(acct.getEngineBasisRestatementCensus().restated).toBe(1);
    });
    it('counts a declined carve-out instead of dropping it silently', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      const opened = openLive(acct, aapl)!;
      // An in-flight row is owned by the close poller; the restatement must
      // stand aside — and must SAY it stood aside.
      opened.pendingCloseOrderId = 'ord-tra3010';
      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const census = acct.getEngineBasisRestatementCensus();
      expect(census.candidates).toBe(1);
      expect(census.restated).toBe(0);
      expect(census.skips.in_flight).toBe(1);
      expect(census.skips.zero_delta).toBe(0);
    });

    it('keeps `restated` monotonic while the record buffer stays bounded', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);

      // Walk the basis so every pass is a genuine restatement rather than a
      // zero-delta skip.
      const passes = 60;
      for (let i = 1; i <= passes; i += 1) {
        acct.reconcileTradierPositions([
          { ...buildBrokerPosition(aapl), premiumPaid: aapl.scannerMark + i * 0.01 },
        ]);
      }

      const census = acct.getEngineBasisRestatementCensus();
      expect(census.restated).toBe(passes);
      expect(census.retained).toBe(census.retentionCap);
      expect(census.restatements).toHaveLength(census.retentionCap);
      // Truncation must be visible: `restated` > `retained` is the signal that
      // the ledger no longer holds the whole tape.
      expect(census.restated).toBeGreaterThan(census.retained);
    });

    it('hands back copies — a reader cannot mutate the ledger', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
      openLive(acct, aapl);
      acct.reconcileTradierPositions([buildBrokerPosition(aapl)]);

      const first = acct.getEngineBasisRestatementCensus();
      first.restatements[0]!.premiumPaidBefore = 999;
      first.skips.zero_delta = 999;

      const second = acct.getEngineBasisRestatementCensus();
      expect(second.restatements[0]!.premiumPaidBefore).toBeCloseTo(aapl.scannerMark, 6);
      expect(second.skips.zero_delta).toBe(0);
    });
  });
});
