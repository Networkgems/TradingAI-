import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradierOtmMispricingService } from './options-scanner.js';
import type { OptionChainRow } from '@trading-app/engine';
import type { TradierOptionsClient } from '@trading-app/engine';

class FakeClient {
  getExpirations = vi.fn<(s: string) => Promise<string[]>>();
  getChainSnapshot = vi.fn<(s: string, e: string) => Promise<OptionChainRow[]>>();
}

const NOW_BASE = Date.parse('2024-01-15T15:00:00Z');

function row(strike: number, optionType: 'call' | 'put', mark: number, smvVol = 0.30): OptionChainRow {
  const half = mark * 0.02;
  return {
    optionSymbol: `TEST${strike}${optionType.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: '2024-02-15',
    bid: mark - half,
    ask: mark + half,
    last: mark,
    volume: 500,
    openInterest: 1000,
    midIv: smvVol,
    smvVol,
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
  const svc = new TradierOtmMispricingService({
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

describe('TradierOtmMispricingService', () => {
  it('reports no_credentials when token/account missing', async () => {
    const svc = new TradierOtmMispricingService({ fetchSpot: async () => 100 });
    expect(svc.diagnostics().configured).toBe(false);
    const result = await svc.scan('AAPL');
    expect(result.reason).toBe('no_credentials');
    expect(result.candidates).toHaveLength(0);
  });

  it('returns mispriced OTM candidates for a real chain', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce(['2024-02-15', '2024-03-15']);
    client.getChainSnapshot.mockResolvedValueOnce([
      row(95,  'put',  0.30 * 0.7),  // cheap put — but the helper uses fixed smvVol so we drive
      row(105, 'call', 1.40),         // strike will need to be > spot=100 and mispricingPct >= threshold
      row(110, 'call', 5.00),         // way over fair → expensive
      row(115, 'call', 0.10),         // way under fair → cheap
    ]);

    const result = await svc.scan('TEST');
    expect(result.reason).toBe('ok');
    expect(result.spot).toBe(100);
    expect(result.expiration).toBe('2024-02-15');
    expect(result.candidates.length).toBeGreaterThan(0);

    const expensive = result.candidates.find(c => c.strike === 110);
    const cheap = result.candidates.find(c => c.strike === 115);
    expect(expensive?.classification).toBe('expensive');
    expect(cheap?.classification).toBe('cheap');
  });

  it('caches chain snapshot for 60s', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockResolvedValue(['2024-02-15']);
    client.getChainSnapshot.mockResolvedValue([row(110, 'call', 1.4)]);

    await svc.scan('TEST');
    advance(30_000);
    await svc.scan('TEST');
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(1);

    advance(31_000); // total 61s — cache expired
    await svc.scan('TEST');
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(2);
  });

  it('opens breaker on fetch error and skips subsequent calls', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockRejectedValueOnce(new Error('429 rate limited'));

    const r1 = await svc.scan('TEST');
    expect(r1.reason).toBe('fetch_error');
    expect(svc.diagnostics().breakerOpen).toBe(true);

    // Subsequent call short-circuits without hitting Tradier.
    client.getExpirations.mockResolvedValue(['2024-02-15']);
    const r2 = await svc.scan('TEST');
    expect(r2.reason).toBe('breaker_open');
    expect(client.getExpirations).toHaveBeenCalledTimes(1); // only the original failed call

    // After cooldown the breaker resets.
    advance(60 * 60_000 + 1);
    client.getChainSnapshot.mockResolvedValue([]);
    const r3 = await svc.scan('TEST');
    expect(r3.reason).toBe('no_chain');
    expect(svc.diagnostics().breakerOpen).toBe(false);
  });

  it('reports no_spot when fetchSpot returns null', async () => {
    const { svc } = makeService({ fetchSpotImpl: async () => null });
    const result = await svc.scan('TEST');
    expect(result.reason).toBe('no_spot');
    expect(result.spot).toBeNull();
  });

  it('reports no_expirations when no expiry is in the 14-35d window', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce(['2024-01-16']); // 1 day out — too close
    const result = await svc.scan('TEST');
    expect(result.reason).toBe('no_expirations');
  });

  it('caches expirations for 6h to avoid redundant calls', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockResolvedValue(['2024-02-15']);
    client.getChainSnapshot.mockResolvedValue([]);

    await svc.scan('TEST');
    advance(5 * 60 * 60_000);
    await svc.scan('TEST');
    expect(client.getExpirations).toHaveBeenCalledTimes(1);

    advance(2 * 60 * 60_000); // total 7h — expirations cache expired
    await svc.scan('TEST');
    expect(client.getExpirations).toHaveBeenCalledTimes(2);
  });

  it('passes through scanner options to findMispricedOtmContracts', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValueOnce(['2024-02-15']);
    client.getChainSnapshot.mockResolvedValueOnce([row(110, 'call', 1.4)]);

    // Tight threshold should still classify; sanity check that we don't error.
    const result = await svc.scan('TEST', { mispricingThresholdPct: 0.5 });
    expect(result.reason).toBe('ok');
  });
});
