import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import type { RelativeValueScannerService, RelativeValueScanResult } from './relative-value-scanner.js';
import type { RelativeValueCandidate } from '@trading-app/engine';

// Inside an ET trading window: 10:00 AM ET on a Tuesday → 14:00 UTC during EDT.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function makeCandidate(overrides: Partial<RelativeValueCandidate> = {}): RelativeValueCandidate {
  return {
    optionSymbol: 'AAPL240705C00200000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    daysToExpiration: 31,
    mark: 1.20,
    bid: 1.18,
    ask: 1.22,
    spreadPct: 0.033,
    volume: 200,
    openInterest: 800,
    ivUsed: 0.22,
    ivFitted: 0.30,
    ivResidual: -0.08,
    zScore: -2.4,
    fairPrice: 1.55,
    mispricingPct: -0.226,
    delta: 0.18,
    classification: 'cheap',
    score: 5.6,
    reason: 'IV residual 2.40σ below fitted skew',
    ...overrides,
  };
}

class StubScanner implements RelativeValueScannerService {
  scan = vi.fn<(symbol: string) => Promise<RelativeValueScanResult>>();
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

describe('SignalEngine — relative-value scanner bridge', () => {
  it('runRelativeValueScan opens an RV position from a `cheap` candidate and records a signal', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    const opened = state.options.openOptions[0];
    expect(opened.optionSymbol).toBe('AAPL240705C00200000');
    expect(opened.signalType).toBe('relative_value');
    expect(opened.premiumPaid).toBe(1.20);

    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('relative_value');
    expect(state.signals[0].symbol).toBe('AAPL');
  });

  it('also opens RV positions on below-intrinsic no-arb violations (a long-only signal)', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'below_intrinsic', reason: 'mark below discounted intrinsic' })],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  it('skips when the scanner returns no cheap or below-intrinsic candidates', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'expensive', mispricingPct: 0.30, zScore: 2.6 })],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });

  it('refreshOptionMarks pulls live marks for open RV positions', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ mark: 1.20 })],
      reason: 'ok',
    });
    scanner.getOptionMark.mockResolvedValue(0.85);

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
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
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);

    vi.setSystemTime(TRADING_TIME + 10 * 60_000);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });
});
