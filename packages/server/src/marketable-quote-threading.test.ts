import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';
import type { OtmMispricingSignal } from '@trading-app/shared';
import {
  marketableQuoteCoverageSnapshot,
  recordMarketableQuoteResolution,
  markMarketableQuoteSeamWired,
  resetMarketableQuoteCoverage,
} from './marketable-quote-coverage.js';

// TRA-3502 (carrier from TRA-3499; TRA-2242 Task 1) — the two-sided quote is threaded
// into the marketable mark, and the fallback counter that says how much the modeled
// h=0.134 still matters.
//
// Acceptance #1 asks for a MUTATION that turns a test red, not a green alone. The three
// `MUTATION GUARD` tests below are the ones that carry it; each names the exact source
// edit it dies under. Run log is on the ticket.

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const OCC = 'AAPL240705C00200000';

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-1',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

/** Demo OTM long call, 6 contracts @ premiumPaid 1.0, marked to `mark`. Flag ARMED. */
function openAndMark(
  mark: number,
  config: ConstructorParameters<typeof PaperOptionsAccount>[0] = {},
): { acct: PaperOptionsAccount; id: string } {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5, ...config });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  acct.checkExits(new Map(), new Map([[pos!.optionSymbol!, mark]]), 'demo');
  expect(acct.getState().openOptions[0].currentPremium).toBeCloseTo(mark, 6);
  return { acct, id: pos!.id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  resetMarketableQuoteCoverage();
});

afterEach(() => {
  vi.useRealTimers();
  resetMarketableQuoteCoverage();
});

// ─────────────────────────────────────────────────────────────────────────────
// The scanner capability: a one-sided book must not read like an absent row.
// ─────────────────────────────────────────────────────────────────────────────

class FakeClient {
  getExpirations = vi.fn<(s: string) => Promise<string[]>>();
  getChainSnapshot = vi.fn<(s: string, e: string) => Promise<OptionChainRow[]>>();
}

const EXP = '2024-02-15';

function chainRow(over: Partial<OptionChainRow> = {}): OptionChainRow {
  return {
    optionSymbol: 'TESTC',
    underlying: 'TEST',
    optionType: 'call',
    strike: 100,
    expiration: EXP,
    bid: 1.0,
    ask: 1.2,
    last: 1.1,
    volume: 100,
    openInterest: 100,
    midIv: 0.3,
    ...over,
  } as OptionChainRow;
}

function makeScanner(client: FakeClient, opts: { configured?: boolean } = {}) {
  return new TradierRelativeValueScannerService({
    ...(opts.configured === false ? {} : { tradierApiToken: 'tok', tradierAccountId: 'A1' }),
    fetchSpot: async () => 100,
    clientFactory: () => client as unknown as TradierOptionsClient,
    now: () => Date.parse('2024-01-15T15:00:00Z'),
  });
}

describe('getOptionQuoteDetail — the reason survives the lookup (TRA-3502)', () => {
  it('returns `quoted` with the two-sided book', async () => {
    const client = new FakeClient();
    client.getChainSnapshot.mockResolvedValue([chainRow()]);
    const svc = makeScanner(client);
    await expect(svc.getOptionQuoteDetail('TEST', EXP, 'TESTC')).resolves.toEqual({
      status: 'quoted', bid: 1.0, ask: 1.2,
    });
  });

  /**
   * MUTATION GUARD. The whole ticket is "UNKNOWN ≠ OFF": `getOptionQuote` collapses a
   * one-sided book, an absent row and an open breaker into ONE `null`, which is why a
   * counter built on it could not say WHY it fell back. Collapse any two of the three
   * branches in `getOptionQuoteDetail` — e.g. return `{status:'absent'}` for the
   * half-empty book — and this dies.
   */
  it('distinguishes a ONE-SIDED book from an ABSENT row from an OPEN breaker', async () => {
    const client = new FakeClient();
    client.getChainSnapshot.mockResolvedValue([chainRow({ bid: 0, ask: 1.2 })]);
    const svc = makeScanner(client);

    // (a) row present, bid missing → one_sided, WITH the side that WAS there echoed.
    await expect(svc.getOptionQuoteDetail('TEST', EXP, 'TESTC')).resolves.toEqual({
      status: 'one_sided', bid: 0, ask: 1.2,
    });

    // (b) no row for that contract → absent. Different shape, not a second null.
    await expect(svc.getOptionQuoteDetail('TEST', EXP, 'NOT_IN_CHAIN')).resolves.toEqual({
      status: 'absent',
    });

    // (c) the fetch throws → the breaker trips and reports itself. An outage is not
    //     an empty book; conflating them would send the fix in the wrong direction.
    const boom = new FakeClient();
    boom.getChainSnapshot.mockRejectedValue(new Error('tradier 503'));
    const svc2 = makeScanner(boom);
    await expect(svc2.getOptionQuoteDetail('TEST', EXP, 'TESTC')).resolves.toEqual({
      status: 'breaker_open',
    });

    // (d) unconfigured scanner → no_client, distinct from a tripped breaker.
    const svc3 = makeScanner(new FakeClient(), { configured: false });
    await expect(svc3.getOptionQuoteDetail('TEST', EXP, 'TESTC')).resolves.toEqual({
      status: 'no_client',
    });
  });

  it('getOptionQuote stays a strict projection — every non-`quoted` status is null', async () => {
    const client = new FakeClient();
    client.getChainSnapshot.mockResolvedValue([chainRow({ bid: 1.5, ask: 1.2 })]); // crossed
    const svc = makeScanner(client);
    // A crossed book is unusable for a maker chase exactly as before TRA-3502…
    await expect(svc.getOptionQuote('TEST', EXP, 'TESTC')).resolves.toBeNull();
    // …but the detail form still says it was a BOOK, not a missing row.
    await expect(svc.getOptionQuoteDetail('TEST', EXP, 'TESTC')).resolves.toMatchObject({
      status: 'one_sided',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mark path: the quote supersedes the modeled h.
// ─────────────────────────────────────────────────────────────────────────────

describe('marketable mark takes the live two-sided quote (TRA-3502 Task 1)', () => {
  /**
   * MUTATION GUARD for acceptance #1. Delete the `quote:` argument from the
   * `marketableUnrealizedUsd` call in `options-account.ts::marketableUnrealizedPnlForMode`
   * and this drops back to the modeled 1.20·(1−0.134) = 1.0392 → $23.52, RED here.
   */
  it('values the open book at the OWN QUOTE bid, not at mid·(1−h)', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false } }); // h defaults 0.134
    // Modeled: 1.20·(1−0.134) = 1.0392 → (1.0392 − 1.0)·6·100 = $23.52.
    expect(acct.getStateForMode('demo').openOptionsRealizablePnl).toBeCloseTo(23.52, 4);

    // Now the tick serves a real book whose mid IS 1.20 but whose bid is 1.13.
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    // Own quote: the bid, exactly. (1.13 − 1.0)·6·100 = $78.
    expect(acct.getStateForMode('demo').openOptionsRealizablePnl).toBeCloseTo(78, 6);
  });

  /**
   * MUTATION GUARD. In `demoExitFillPrice`, replace `this.liveQuoteFor(opt)` with
   * `null` (or drop the `priceIsQuoteMid` branch) and the close books at the modeled
   * 1.0392 instead of the quoted 1.13 — RED.
   */
  it('fills a demo close at the quoted BID when the reference price is the quote mid', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: true }, demoFeePerContract: 0 });
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    const closed = acct.closeOption(id);
    expect(closed).not.toBeNull();
    // Exit at the BID: 1.13, not the modeled 1.20·(1−0.134)=1.0392.
    expect(acct.getState().closedOptions.at(-1)!.currentPremium).toBeCloseTo(1.13, 6);
  });

  it('falls back to the modeled h when this tick served NO quote', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: true }, demoFeePerContract: 0 });
    acct.refreshOptionQuotes(new Map()); // the empty map is a real input, not a no-op
    acct.closeOption(id);
    expect(acct.getState().closedOptions.at(-1)!.currentPremium).toBeCloseTo(1.2 * (1 - 0.134), 6);
  });

  it('drops a stale quote wholesale — a later empty refresh must not leave one standing', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: true }, demoFeePerContract: 0 });
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    acct.refreshOptionQuotes(new Map());
    acct.closeOption(id);
    expect(acct.getState().closedOptions.at(-1)!.currentPremium).toBeCloseTo(1.2 * (1 - 0.134), 6);
  });

  it('refuses a CROSSED book — it is unusable, so the model still owns that mark', () => {
    const { acct, id } = openAndMark(1.2, { marketableOpenMtm: { enabled: true }, demoFeePerContract: 0 });
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.30, ask: 1.10 }]]));
    acct.closeOption(id);
    expect(acct.getState().closedOptions.at(-1)!.currentPremium).toBeCloseTo(1.2 * (1 - 0.134), 6);
  });

  /**
   * The reason `demoExitFillPrice` has TWO quote branches. A stop fires at a LEVEL,
   * not at the current mid, and substituting the raw bid there would re-decide what
   * price a stop fills at rather than sharpen the haircut applied to it.
   */
  it('applies the quote-MEASURED half-spread (not the raw bid) when the price is a trigger level', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      marketableOpenMtm: { enabled: true },
      demoFeePerContract: 0,
    });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo', undefined, 200);
    expect(pos).not.toBeNull();
    const stop = acct.getState().openOptions[0].stopLossPremium;
    expect(stop).toBeGreaterThan(0);

    // Book: bid 1.13 / ask 1.27 ⇒ mid 1.20, measured long half-spread (1.20−1.13)/1.20.
    const measured = (1.2 - 1.13) / 1.2;
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    // Mark gaps below the stop ⇒ the SL site passes `stopLossPremium`, NOT the mark.
    acct.checkExits(new Map(), new Map([[OCC, stop * 0.5]]), 'demo');

    const closed = acct.getState().closedOptions.at(-1);
    expect(closed).toBeDefined();
    // The trigger level haircut by the MEASURED fraction — not the raw 1.13 bid (which
    // is ABOVE the stop and would book a better fill than the stop it exited on), and
    // not the modeled 0.134.
    expect(closed!.currentPremium).toBeCloseTo(stop * (1 - measured), 6);
    expect(closed!.currentPremium).not.toBeCloseTo(1.13, 4);
    expect(closed!.currentPremium).not.toBeCloseTo(stop * (1 - 0.134), 6);
  });

  it('leaves the LIVE book untouched — the marketable path is demo-only by construction', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      marketableOpenMtm: { enabled: true },
      demoFeePerContract: 0,
    });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', undefined, 200);
    expect(pos).not.toBeNull();
    acct.checkExits(new Map(), new Map([[OCC, 1.2]]), 'live');
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    acct.closeOption(pos!.id);
    // Live closes at the mark, full stop: Tradier already charges the real spread.
    expect(acct.getState().closedOptions.at(-1)!.currentPremium).toBeCloseTo(1.2, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The counter, and its positive control.
// ─────────────────────────────────────────────────────────────────────────────

describe('marketable quote-coverage ledger — the positive control (TRA-3502 acceptance #2)', () => {
  /**
   * MUTATION GUARD, and the reason the `wired` flag exists at all. Drop the `UNWIRED`
   * branch from `foldSeam` in `marketable-quote-coverage.ts` — i.e. derive the state
   * from `observations` alone, `observations === 0 ? 'WIRED_NO_OBSERVATIONS' : 'LIVE'`
   * — and a seam that never ran becomes indistinguishable from one that ran with
   * nothing to resolve. Verified RED (2 failures, `expected 'WIRED_NO_OBSERVATIONS' to
   * be 'UNWIRED'`); run log on TRA-3502.
   *
   * NOT covered here: that `signal-engine.ts::refreshOptionMarks` actually CALLS
   * `markMarketableQuoteSeamWired`, and calls it ABOVE its two early returns. That is a
   * call-site placement fact, not a behavioural one, and asserting it would need a
   * whole `SignalEngine`; it is verified by reading the seam. Said plainly rather than
   * implied, because "the guard exists" and "the guard is wired" is the exact pair this
   * ticket family keeps finding collapsed.
   */
  it('UNWIRED, WIRED_NO_OBSERVATIONS and LIVE are three different renders', () => {
    // (1) Virgin process: nothing has ever recorded.
    let snap = marketableQuoteCoverageSnapshot();
    expect(snap.resolution.instrumentState).toBe('UNWIRED');
    expect(snap.resolution.observations).toBe(0);
    // An unmeasured rate is null, NEVER 0 — a zero here would read as "no fallbacks".
    expect(snap.resolution.fallbackRate).toBeNull();

    // (2) The seam ran but had nothing to resolve. Same all-zero counts, different state.
    markMarketableQuoteSeamWired('resolution');
    snap = marketableQuoteCoverageSnapshot();
    expect(snap.resolution.instrumentState).toBe('WIRED_NO_OBSERVATIONS');
    expect(snap.resolution.observations).toBe(0);
    expect(snap.resolution.fallbackRate).toBeNull();

    // (3) A real resolution lands.
    recordMarketableQuoteResolution({ seam: 'resolution', outcome: 'served', mode: 'demo', now: 1 });
    snap = marketableQuoteCoverageSnapshot();
    expect(snap.resolution.instrumentState).toBe('LIVE');
    expect(snap.resolution.observations).toBe(1);
    expect(snap.resolution.fallbackRate).toBe(0); // NOW a zero is a measurement.
  });

  it('splits the fallback by reason — one_sided, absent and breaker_open never merge', () => {
    for (const outcome of ['one_sided', 'absent', 'breaker_open', 'error', 'no_client', 'no_capability'] as const) {
      recordMarketableQuoteResolution({ seam: 'resolution', outcome, mode: 'demo', now: 1 });
    }
    recordMarketableQuoteResolution({ seam: 'resolution', outcome: 'served', mode: 'demo', now: 2 });
    const { resolution } = marketableQuoteCoverageSnapshot();
    expect(resolution.served).toBe(1);
    expect(resolution.fallback).toMatchObject({
      one_sided: 1, absent: 1, breaker_open: 1, error: 1, no_client: 1, no_capability: 1, total: 6,
    });
    expect(resolution.observations).toBe(7);
    expect(resolution.fallbackRate).toBeCloseTo(6 / 7, 12);
  });

  it('keeps the two seams separate — a DARK application seam cannot mask a live resolution one', () => {
    markMarketableQuoteSeamWired('resolution');
    recordMarketableQuoteResolution({ seam: 'resolution', outcome: 'one_sided', mode: 'demo', now: 1 });
    const snap = marketableQuoteCoverageSnapshot();
    expect(snap.resolution.instrumentState).toBe('LIVE');
    expect(snap.resolution.fallbackRate).toBe(1);
    // The flag is DARK, so nothing applied a marketable mark. That is a STRUCTURAL zero
    // and must not read as "no fallbacks were needed".
    expect(snap.application.instrumentState).toBe('UNWIRED');
    expect(snap.application.fallbackRate).toBeNull();
  });

  it('is written by the real account mark path, not only by the test', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false } });
    acct.refreshOptionQuotes(new Map([[OCC, { bid: 1.13, ask: 1.27 }]]));
    acct.getStateForMode('demo'); // the flag-independent realizable read
    const { application } = marketableQuoteCoverageSnapshot();
    expect(application.instrumentState).toBe('LIVE');
    expect(application.served).toBeGreaterThan(0);
    expect(application.byMode.demo.served).toBeGreaterThan(0);
  });

  it('records the fallback REASON the application seam can actually observe', () => {
    const { acct } = openAndMark(1.2, { marketableOpenMtm: { enabled: false } });
    acct.refreshOptionQuotes(new Map());
    acct.getStateForMode('demo');
    const { application } = marketableQuoteCoverageSnapshot();
    // `unquoted_at_mark`, NOT `absent`: this seam cannot see whether the book was
    // one-sided or the row missing, and claiming either would fabricate a diagnosis.
    expect(application.fallback.unquoted_at_mark).toBeGreaterThan(0);
    expect(application.fallback.absent).toBe(0);
  });
});
