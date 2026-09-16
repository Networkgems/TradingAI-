// TRA-4502 (parent TRA-4284) — the WIRING control.
//
// `hidden-book-exposure.test.ts` pins the fold. This pins the thing the fold
// cannot: that a dashboard frame built for a book the engine is not routing to
// actually CARRIES the other book's exposure, and that a default frame does
// not. The measured defect was never a bad number — it was a true frame with
// nothing on it about the money book, so "the field is on the frame" is the
// acceptance, not an implementation detail.
import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS, hiddenBookNeedsBanner } from '@trading-app/shared';
import type { TradierEnv } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';

/** A single long call, seeded straight onto the options book (TRA-231's pattern). */
type SeedOption = {
  id: string; symbol: string; optionType: 'call'; contracts: number; contractsRemaining: number;
  premiumPaid: number; currentPremium: number; tp1Premium: number; tp1Hit: boolean;
  stopLossPremium: number; peakPremium: number; trailingActive: boolean; trailingStopPremium: number;
  underlyingEntryPrice: number; openedAt: number; signalId: string; signalType: 'relative_value';
  mode: 'demo' | 'live';
};

function seed(engine: SignalEngine, row: SeedOption): void {
  const accounts = (engine as unknown as {
    optionsAccounts: Record<TradierEnv, unknown>;
  }).optionsAccounts;
  (accounts.sandbox as { openOptions: Map<string, SeedOption> }).openOptions.set(row.id, row);
}

/** Mark 0.70 against a 0.75 stop — through it, which is the breach predicate. */
const BREACHED_LIVE_ROW: SeedOption = {
  id: 'live-breached-1', symbol: 'XLF', optionType: 'call', contracts: 1, contractsRemaining: 1,
  premiumPaid: 1.08, currentPremium: 0.70, tp1Premium: 1.35, tp1Hit: false, stopLossPremium: 0.75,
  peakPremium: 1.2, trailingActive: false, trailingStopPremium: 0.9, underlyingEntryPrice: 57.5,
  openedAt: Date.now(), signalId: 'sig-live', signalType: 'relative_value', mode: 'live',
};

function liveEngine(): SignalEngine {
  return new SignalEngine({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'live',
    liveTradierEnvOptions: 'sandbox',
  });
}

describe('TRA-4502 — /api/state carries the hidden book while a view override is set', () => {
  it('the DEMO frame of a LIVE-routing engine carries the live book\'s exposure', () => {
    const engine = liveEngine();
    seed(engine, BREACHED_LIVE_ROW);

    // This is `dashboardEngineState()` for the bqb1 `admin` account as found on
    // 2026-09-01: `mode: "live"`, `viewMode: "demo"`.
    const frame = engine.getState('demo');

    // The frame itself is still the demo book — the override is NOT being
    // undone, which is acceptance 4.
    expect(frame.bookView).toBe('demo');
    expect(frame.engineMode).toBe('live');
    expect(frame.options.openOptions).toEqual([]);

    // ...and it now says what it is hiding, which is acceptance 1.
    const hidden = frame.hiddenBookExposure;
    expect(hidden).toBeDefined();
    expect(hidden!.book).toBe('live');
    expect(hidden!.shownBook).toBe('demo');
    expect(hidden!.openOptionRows).toBe(1);
    expect(hidden!.openPremiumUsd).toBe(108);
    expect(hidden!.unpricedRows).toBe(0);

    // The census is the live one (TRA-3822 + TRA-3839), present and not a
    // stand-in zero.
    expect(hidden!.stopsUnavailableReason).toBeNull();
    expect(hidden!.stops).not.toBeNull();
    expect(hidden!.stops!.breached).toBe(1);
    expect(hidden!.stops!.breached).toBe(
      hidden!.stops!.actionable + hidden!.stops!.inFlight + hidden!.stops!.inert,
    );

    // Acceptance 2: this reading is a banner, and the threshold is the shared
    // one — the dashboard cannot decide differently.
    expect(hiddenBookNeedsBanner(hidden!)).toBe(true);
  });

  it('a frame that follows the engine carries NO hidden-book field at all', () => {
    const engine = liveEngine();
    seed(engine, BREACHED_LIVE_ROW);
    // No override: the live book is what is being rendered, so nothing is
    // hidden. Absent, not a row of zeroes — a zeroed payload on every default
    // frame would train an operator to ignore the one that matters.
    expect(engine.getState('live').hiddenBookExposure).toBeUndefined();
    expect(engine.getState().hiddenBookExposure).toBeUndefined();
  });

  it('a DEMO-routing engine viewing LIVE reports the hidden demo book with no census', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradierEnvOptions: 'sandbox',
    });
    seed(engine, { ...BREACHED_LIVE_ROW, id: 'demo-1', mode: 'demo' });

    const hidden = engine.getState('live').hiddenBookExposure;
    expect(hidden).toBeDefined();
    expect(hidden!.book).toBe('demo');
    expect(hidden!.openOptionRows).toBe(1);
    // No real money in a paper book: the census is ABSENT WITH A REASON rather
    // than a clean zero, and it never reaches the banner.
    expect(hidden!.stops).toBeNull();
    expect(hidden!.stopsUnavailableReason).toBe('hidden_book_is_demo');
    expect(hiddenBookNeedsBanner(hidden!)).toBe(false);
  });

  it('a flat hidden live book publishes a zero count and does not banner', () => {
    const engine = liveEngine();
    const hidden = engine.getState('demo').hiddenBookExposure;
    expect(hidden).toBeDefined();
    expect(hidden!.openOptionRows).toBe(0);
    expect(hidden!.stops!.breached).toBe(0);
    expect(hiddenBookNeedsBanner(hidden!)).toBe(false);
  });
});
