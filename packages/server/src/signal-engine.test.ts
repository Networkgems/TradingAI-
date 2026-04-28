import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import type { OtmMispricingService, OtmMispricingScanResult } from './options-scanner.js';
import type { OtmMispricingCandidate } from '@trading-app/engine';

// Inside an ET trading window: 10:00 AM ET on a Tuesday → 14:00 UTC during EDT.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function makeCandidate(overrides: Partial<OtmMispricingCandidate> = {}): OtmMispricingCandidate {
  return {
    optionSymbol: 'AAPL240705C00200000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    daysToExpiration: 31,
    mark: 1.20,
    theo: 1.55,
    mispricingPct: -0.226,
    classification: 'cheap',
    bid: 1.18,
    ask: 1.22,
    spreadPct: 0.033,
    openInterest: 800,
    volume: 200,
    ivUsed: 0.30,
    delta: 0.18,
    ...overrides,
  };
}

class StubScanner implements OtmMispricingService {
  scan = vi.fn<(symbol: string) => Promise<OtmMispricingScanResult>>();
  getOptionMark = vi.fn<(symbol: string, expiration: string, optionSymbol: string) => Promise<number | null>>();
  diagnostics = vi.fn(() => ({
    configured: true,
    breakerOpen: false,
    breakerOpenedAtMs: null,
    cacheSize: 0,
    expirationsCacheSize: 0,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SignalEngine — OTM scanner bridge', () => {
  it('runOtmScan opens an OTM position from a `cheap` candidate and records a signal', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    // Call the private scan loop directly so the test doesn't have to drive
    // yahoo-feed or candle providers — those are exercised in their own suites.
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    const opened = state.options.openOptions[0];
    expect(opened.optionSymbol).toBe('AAPL240705C00200000');
    expect(opened.signalType).toBe('otm_mispricing');
    expect(opened.premiumPaid).toBe(1.20);

    // The signal feed surfaces the new OTM signal so /api/state and the EOD
    // report can render it alongside other strategies.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('otm_mispricing');
    expect(state.signals[0].symbol).toBe('AAPL');
  });

  it('skips when the scanner returns no cheap candidates', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'expensive', mispricingPct: 0.30 })],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });

  it('refreshOptionMarks pulls live marks and feeds them into the next checkExits', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ mark: 1.20 })],
      reason: 'ok',
    });
    scanner.getOptionMark.mockResolvedValue(0.85); // mark down ~30% — past −25% SL

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);

    const marks = await (engine as unknown as { refreshOptionMarks: () => Promise<Map<string, number>> }).refreshOptionMarks();
    expect(marks.get('AAPL240705C00200000')).toBe(0.85);
    expect(scanner.getOptionMark).toHaveBeenCalledWith('AAPL', '2024-07-05', 'AAPL240705C00200000');
  });

  it('dedups subsequent scans on the same OCC within the 1h dedup window', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);

    // Second scan 10 minutes later — the dedup map should still hold the OCC.
    vi.setSystemTime(TRADING_TIME + 10 * 60_000);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
    // Still exactly one signal in the feed, and still one position open.
    expect(engine.getState().signals).toHaveLength(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });
});
