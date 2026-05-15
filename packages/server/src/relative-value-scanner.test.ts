import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';

class FakeClient {
  getExpirations = vi.fn<(s: string) => Promise<string[]>>();
  getChainSnapshot = vi.fn<(s: string, e: string) => Promise<OptionChainRow[]>>();
}

// Inside the 21–60 day expiration window (TRA-373) so pickExpiration always
// picks one. 2024-02-15 is 31 days from NOW_BASE — close to the default 35d
// target, well clear of the 21d / 60d edges.
const NOW_BASE = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15';

function row(strike: number, optionType: 'call' | 'put', iv: number): OptionChainRow {
  // Build a row whose bid/ask straddle a representative mark close to BS-fair.
  // The scanner only needs midIv populated to use it as the σ for fitting.
  const intrinsic = optionType === 'call' ? Math.max(0, 100 - strike) : Math.max(0, strike - 100);
  const timeValue = 0.30 * 0.5; // small time value scaled by iv-like factor
  const mark = Math.max(0.10, intrinsic + timeValue * (iv / 0.30));
  const half = mark * 0.02;
  return {
    optionSymbol: `TEST${strike}${optionType.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: Math.max(0.01, mark - half),
    ask: mark + half,
    last: mark,
    volume: 500,
    openInterest: 1000,
    midIv: iv,
  };
}

function makeService(overrides: Partial<{
  client: FakeClient;
  spot: number | null;
  now: number;
  fetchSpotImpl: (s: string) => Promise<number | null>;
}> = {}) {
  const client = overrides.client ?? new FakeClient();
  let now = overrides.now ?? NOW_BASE;
  const fetchSpot = overrides.fetchSpotImpl ?? (async () => overrides.spot ?? 100);
  const svc = new TradierRelativeValueScannerService({
    tradierApiToken: 'tok',
    tradierAccountId: 'A1',
    fetchSpot,
    clientFactory: () => client as unknown as TradierOptionsClient,
    now: () => now,
  });
  return { svc, client, advance: (ms: number) => { now += ms; } };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('TradierRelativeValueScannerService', () => {
  it('reports no_credentials when token/account missing', async () => {
    const svc = new TradierRelativeValueScannerService({ fetchSpot: async () => 100 });
    expect(svc.diagnostics().configured).toBe(false);
    const result = await svc.scan('AAPL');
    expect(result.reason).toBe('no_credentials');
    expect(result.candidates).toHaveLength(0);
  });

  it('returns relative-value candidates from a fitted-skew chain', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce([EXP]);
    // 6 fair calls + 1 outlier (high IV at strike 100) — enough rows to fit.
    client.getChainSnapshot.mockResolvedValueOnce([
      row(85, 'call', 0.30),
      row(90, 'call', 0.30),
      row(95, 'call', 0.30),
      row(100, 'call', 0.45),
      row(105, 'call', 0.30),
      row(110, 'call', 0.30),
      row(115, 'call', 0.30),
    ]);

    const result = await svc.scan('TEST');
    expect(result.reason).toBe('ok');
    expect(result.spot).toBe(100);
    expect(result.expiration).toBe(EXP);
    expect(result.candidates.length).toBe(7);
    const flagged = result.candidates.filter((c) => c.classification !== 'fair');
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('caches chain snapshot for 60s', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.30)]);

    await svc.scan('TEST');
    advance(30_000);
    await svc.scan('TEST');
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(1);

    advance(31_000);
    await svc.scan('TEST');
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(2);
  });

  it('opens breaker on fetch error and skips subsequent scans', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockRejectedValueOnce(new Error('429 too many requests'));
    const first = await svc.scan('TEST');
    expect(first.reason).toBe('fetch_error');
    expect(svc.diagnostics().breakerOpen).toBe(true);

    // Subsequent calls short-circuit until the breaker cools down.
    const second = await svc.scan('TEST');
    expect(second.reason).toBe('breaker_open');
  });

  it('reports no_spot when fetchSpot returns null', async () => {
    const { svc } = makeService({ fetchSpotImpl: async () => null });
    const result = await svc.scan('TEST');
    expect(result.reason).toBe('no_spot');
  });

  it('reports no_expirations when none are in the 21–60 day window (TRA-373)', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce(['2024-01-16']); // 1 day out — outside window
    const result = await svc.scan('TEST');
    expect(result.reason).toBe('no_expirations');
  });

  it('picks the expiration closest to the 35d target within the window (TRA-373)', async () => {
    // Anchor `now` at midnight UTC so listed-expiration dates (parsed as
    // YYYY-MM-DDT00:00:00Z) align cleanly with N-days-from-now arithmetic.
    const MIDNIGHT = Date.parse('2024-01-15T00:00:00Z');
    const { svc, client } = makeService({ now: MIDNIGHT });
    // Spec regression case from TRA-373: chain offers 15d / 30d / 45d / 90d.
    // 15d/90d are outside [21,60]; inside the window 30d (|30-35|=5) beats
    // 45d (|45-35|=10).
    client.getExpirations.mockResolvedValueOnce([
      '2024-01-30', // 15d — outside [21,60]
      '2024-02-14', // 30d — inside, 5d below target
      '2024-02-29', // 45d — inside, 10d above target
      '2024-04-14', // 90d — outside [21,60]
    ]);
    client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
    const result = await svc.scan('TEST');
    expect(result.expiration).toBe('2024-02-14');
    expect(client.getChainSnapshot).toHaveBeenCalledWith('TEST', '2024-02-14');
  });

  it('on equal target distance, picks the earlier expiration (TRA-373 tie-break)', async () => {
    const MIDNIGHT = Date.parse('2024-01-15T00:00:00Z');
    const { svc, client } = makeService({ now: MIDNIGHT });
    // Target = 2024-02-19. Both 2024-02-14 (5d before) and 2024-02-24
    // (5d after) are equidistant; spec prefers the earlier expiration.
    client.getExpirations.mockResolvedValueOnce(['2024-02-14', '2024-02-24']);
    client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
    const result = await svc.scan('TEST');
    expect(result.expiration).toBe('2024-02-14');
  });

  it('respects per-call dtePrefs overrides (TRA-373)', async () => {
    const MIDNIGHT = Date.parse('2024-01-15T00:00:00Z');
    const { svc, client } = makeService({ now: MIDNIGHT });
    // Override to [40,80] target 60. 30d outside, 50d/70d inside and
    // equidistant from target 60 → earlier (50d) wins.
    client.getExpirations.mockResolvedValueOnce([
      '2024-02-14', // 30d — outside the overridden 40-80 window
      '2024-03-05', // 50d — inside, 10d under target
      '2024-03-25', // 70d — inside, 10d over target → tie → earlier wins
    ]);
    client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
    const result = await svc.scan('TEST', undefined, { min: 40, max: 80, target: 60 });
    expect(result.expiration).toBe('2024-03-05');
  });

  it('getOptionMark serves the cached chain snapshot', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce([EXP]);
    client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
    await svc.scan('TEST');

    const mark = await svc.getOptionMark('TEST', EXP, 'TEST100CALL');
    expect(mark).toBeGreaterThan(0);
    // Cache hit — no extra Tradier call.
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(1);
  });
});
