// Chains on production market data, greeks freshness, chain budget, multi-
// expiration OTM, and the stream → quote-cache overlay.
import { describe, it, expect, vi } from 'vitest';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';
import { findMispricedOtmContracts, parseGreeksUpdatedAt, blackScholesPrice } from '@trading-app/engine';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import {
  resolveChainMarketDataRoute,
  resolveOtmScanMaxExpirations,
  DEFAULT_SHARED_CHAIN_BUDGET_PER_MIN,
} from './tradier-chain-routing.js';
import { resolveOtmTheoFreshnessOpts } from './exit-risk-rules-flag.js';
import { mergeStreamTick } from './yahoo-feed.js';
import { streamFeedsQuotes } from './tradier-stream-status.js';

describe('resolveChainMarketDataRoute', () => {
  it('sandbox host with a market-data token reads PRODUCTION chains, budgeted', () => {
    const r = resolveChainMarketDataRoute({
      TRADIER_ENV: 'sandbox',
      TRADIER_SANDBOX_API_TOKEN: 'sbx',
      TRADIER_SANDBOX_ACCOUNT_ID: 'VA1',
      TRADIER_MARKET_DATA_TOKEN: 'prod-md',
    });
    expect(r.env).toBe('production');
    expect(r.apiToken).toBe('prod-md');
    expect(r.accountId).toBe('market-data-only');
    expect(r.source).toBe('market_data_token');
    expect(r.chainCallBudgetPerMin).toBe(DEFAULT_SHARED_CHAIN_BUDGET_PER_MIN);
  });

  it('never promotes the unprefixed TRADIER_API_TOKEN on a sandbox host', () => {
    const r = resolveChainMarketDataRoute({ TRADIER_ENV: 'sandbox', TRADIER_API_TOKEN: 'maybe-sandbox' });
    expect(r.env).toBe('sandbox');
    expect(r.source).toBe('tradier_env_sandbox');
    expect(r.chainCallBudgetPerMin).toBeNull();
  });

  it('honours the explicit opt-out', () => {
    const r = resolveChainMarketDataRoute({
      TRADIER_ENV: 'sandbox', TRADIER_MARKET_DATA_TOKEN: 'prod-md', TRADIER_CHAINS_ENV: 'sandbox',
    });
    expect(r.env).toBe('sandbox');
    expect(r.source).toBe('chains_env_opt_out');
  });

  it('production host is unchanged (no default budget)', () => {
    const r = resolveChainMarketDataRoute({ TRADIER_ENV: 'production', TRADIER_API_TOKEN: 'p', TRADIER_ACCOUNT_ID: 'A' });
    expect(r).toMatchObject({ env: 'production', apiToken: 'p', accountId: 'A', chainCallBudgetPerMin: null });
  });

  it('budget env: integer, none, garbage', () => {
    const base = { TRADIER_MARKET_DATA_TOKEN: 'x' };
    expect(resolveChainMarketDataRoute({ ...base, TRADIER_CHAIN_BUDGET_PER_MIN: '40' }).chainCallBudgetPerMin).toBe(40);
    expect(resolveChainMarketDataRoute({ ...base, TRADIER_CHAIN_BUDGET_PER_MIN: 'none' }).chainCallBudgetPerMin).toBeNull();
    expect(resolveChainMarketDataRoute({ ...base, TRADIER_CHAIN_BUDGET_PER_MIN: 'lots' }).chainCallBudgetPerMin)
      .toBe(DEFAULT_SHARED_CHAIN_BUDGET_PER_MIN);
  });

  it('OTM_SCAN_MAX_EXPIRATIONS clamps to 1..6, default 1', () => {
    expect(resolveOtmScanMaxExpirations({})).toBe(1);
    expect(resolveOtmScanMaxExpirations({ OTM_SCAN_MAX_EXPIRATIONS: '3' })).toBe(3);
    expect(resolveOtmScanMaxExpirations({ OTM_SCAN_MAX_EXPIRATIONS: '99' })).toBe(6);
    expect(resolveOtmScanMaxExpirations({ OTM_SCAN_MAX_EXPIRATIONS: '0' })).toBe(1);
  });
});

describe('parseGreeksUpdatedAt', () => {
  it('reads the naive stamp as US/Eastern across DST', () => {
    // EDT (UTC-4) in October, EST (UTC-5) in January.
    expect(parseGreeksUpdatedAt('2026-10-06 14:59:08')).toBe(Date.parse('2026-10-06T18:59:08Z'));
    expect(parseGreeksUpdatedAt('2026-01-06 14:59:08')).toBe(Date.parse('2026-01-06T19:59:08Z'));
  });
  it('UTC override and garbage', () => {
    expect(parseGreeksUpdatedAt('2026-10-06 14:59:08', 'UTC')).toBe(Date.parse('2026-10-06T14:59:08Z'));
    expect(parseGreeksUpdatedAt('yesterday')).toBeUndefined();
    expect(parseGreeksUpdatedAt(undefined)).toBeUndefined();
  });
});

describe('resolveOtmTheoFreshnessOpts', () => {
  it('defaults to a 90-minute greeks age ceiling, vendor source', () => {
    expect(resolveOtmTheoFreshnessOpts({})).toEqual({ maxGreeksAgeMs: 90 * 60_000 });
  });
  it('none = legacy, live source opt-in', () => {
    expect(resolveOtmTheoFreshnessOpts({ OTM_MAX_GREEKS_AGE_MIN: 'none', OTM_THEO_IV_SOURCE: 'live' }))
      .toEqual({ ivSource: 'live' });
  });
});

// ── OTM theo: stale vendor σ vs live σ ───────────────────────────────────────
const NOW = Date.parse('2026-10-06T18:00:00Z');
const EXP = '2026-11-13'; // ~38 DTE
const DTE = (Date.parse(`${EXP}T00:00:00Z`) - NOW) / 86_400_000;

/** A clean chain whose mids are BS-fair at `trueIv`, with a vendor σ of `vendorIv`. */
function chain(trueIv: number, vendorIv: number, greeksUpdatedMs?: number): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  for (let k = 102; k <= 120; k += 2) {
    const fair = blackScholesPrice({
      spot: 100, strike: k, timeToExpiryYears: Math.ceil(DTE) / 365, riskFreeRate: 0.045,
      volatility: trueIv, optionType: 'call', dividendYield: 0,
    });
    rows.push({
      optionSymbol: `X${k}C`, underlying: 'X', optionType: 'call', strike: k, expiration: EXP,
      bid: fair * 0.99, ask: fair * 1.01, openInterest: 1000, volume: 100,
      smvVol: vendorIv, midIv: vendorIv,
      ...(greeksUpdatedMs === undefined ? {} : { greeksUpdatedMs }),
    });
  }
  return rows;
}

describe('OTM theo greeks freshness', () => {
  it('legacy: an hour-stale vendor σ manufactures "cheap" rows', () => {
    // The market re-priced vol from 30 to 40 after ORATS last fitted at 30.
    const c = findMispricedOtmContracts(chain(0.40, 0.30, NOW - 2 * 3_600_000), 100, { now: NOW });
    expect(c.some((x) => x.classification === 'expensive')).toBe(true);
    expect(c.every((x) => x.ivSource === 'vendor_smv')).toBe(true);
  });

  it('with an age ceiling, stale greeks fall back to live σ and the false signal disappears', () => {
    const c = findMispricedOtmContracts(chain(0.40, 0.30, NOW - 2 * 3_600_000), 100, {
      now: NOW, maxGreeksAgeMs: 90 * 60_000,
    });
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.ivSource === 'live_smoothed')).toBe(true);
    expect(c.every((x) => x.classification === 'fair')).toBe(true);
    expect(c[0]!.greeksAgeMs).toBe(2 * 3_600_000);
  });

  it('fresh greeks are still used', () => {
    const c = findMispricedOtmContracts(chain(0.30, 0.30, NOW - 10 * 60_000), 100, {
      now: NOW, maxGreeksAgeMs: 90 * 60_000,
    });
    expect(c.every((x) => x.ivSource === 'vendor_smv')).toBe(true);
  });

  it('no stamp (sandbox) + ceiling ⇒ live σ, never "fresh by default"', () => {
    const c = findMispricedOtmContracts(chain(0.30, 0.30), 100, { now: NOW, maxGreeksAgeMs: 90 * 60_000 });
    expect(c.every((x) => x.ivSource === 'live_smoothed')).toBe(true);
  });
});

// ── scanner: chain budget + multi-expiration OTM ─────────────────────────────
class FakeClient {
  getExpirations = vi.fn<(s: string) => Promise<string[]>>();
  getChainSnapshot = vi.fn<(s: string, e: string) => Promise<OptionChainRow[]>>();
}
const T0 = Date.parse('2024-01-15T15:00:00Z');
function rowsFor(exp: string): OptionChainRow[] {
  return [105, 110, 115].map((k) => ({
    optionSymbol: `T${exp}${k}C`, underlying: 'T', optionType: 'call' as const, strike: k, expiration: exp,
    bid: 1.0, ask: 1.04, openInterest: 1000, volume: 10, midIv: 0.3,
  }));
}
function svcWith(extra: { chainCallBudgetPerMin?: number | null; otmMaxExpirations?: number }) {
  const client = new FakeClient();
  let now = T0;
  const svc = new TradierRelativeValueScannerService({
    tradierApiToken: 't', tradierAccountId: 'a', fetchSpot: async () => 100,
    clientFactory: () => client as unknown as TradierOptionsClient,
    now: () => now, ...extra,
  });
  return { svc, client, advance: (ms: number) => { now += ms; } };
}

describe('scanner chain budget', () => {
  it('suppresses calls over budget as quota_held, counts them, and recovers after a minute', async () => {
    const { svc, client, advance } = svcWith({ chainCallBudgetPerMin: 2 });
    client.getExpirations.mockResolvedValue(['2024-02-15']);
    client.getChainSnapshot.mockImplementation(async (_s, e) => rowsFor(e));
    expect((await svc.scanOtm('AAA')).reason).toBe('ok'); // 2 calls: expirations + chain
    const held = await svc.scanOtm('BBB');
    expect(held.reason).toBe('quota_held');
    expect(svc.diagnostics().chainBudget).toMatchObject({ limitPerMin: 2, deferred: 1, upstreamCalls: 2 });
    advance(61_000);
    expect((await svc.scanOtm('BBB')).reason).toBe('ok');
    expect(svc.diagnostics().breakerOpen).toBe(false);
  });
});

describe('scanOtm across several expirations', () => {
  it('prices the picked expiration plus the nearest others', async () => {
    const { svc, client } = svcWith({ otmMaxExpirations: 3 });
    client.getExpirations.mockResolvedValue(['2024-02-09', '2024-02-16', '2024-02-23', '2024-03-01']);
    client.getChainSnapshot.mockImplementation(async (_s, e) => rowsFor(e));
    const r = await svc.scanOtm('T');
    expect(r.reason).toBe('ok');
    expect(r.scannedExpirations).toHaveLength(3);
    expect(new Set(r.candidates.map((c) => c.expiration)).size).toBe(3);
  });

  it('default stays a single expiration', async () => {
    const { svc, client } = svcWith({});
    client.getExpirations.mockResolvedValue(['2024-02-09', '2024-02-16']);
    client.getChainSnapshot.mockImplementation(async (_s, e) => rowsFor(e));
    const r = await svc.scanOtm('T');
    expect(r.scannedExpirations).toHaveLength(1);
  });
});

// ── stream overlay ──────────────────────────────────────────────────────────
describe('mergeStreamTick', () => {
  const prev = { price: 100, volume: 5_000, change: 2, changePct: 2.0408, bid: 99.9, ask: 100.1, currency: 'USD' };
  it('a trade print moves price and re-derives change off the implied previous close', () => {
    const m = mergeStreamTick(prev, { last: 101, eventTime: 1 })!;
    expect(m.price).toBe(101);
    expect(m.change).toBeCloseTo(3); // prevClose 98
    expect(m.changePct).toBeCloseTo((3 / 98) * 100);
    expect(m.volume).toBe(5_000); // carried from REST
  });
  it('a quote tick prices at the new mid and updates the book', () => {
    const m = mergeStreamTick(prev, { bid: 100.4, ask: 100.6, eventTime: 1 })!;
    expect(m.price).toBeCloseTo(100.5);
    expect(m).toMatchObject({ bid: 100.4, ask: 100.6 });
  });
  it('an unusable tick returns null', () => {
    expect(mergeStreamTick({ price: 1, volume: 0, change: 0, changePct: 0 }, { eventTime: 1 })).toBeNull();
  });
  it('TRADIER_STREAM_FEEDS_QUOTES defaults on, 0 turns it off', () => {
    expect(streamFeedsQuotes({})).toBe(true);
    expect(streamFeedsQuotes({ TRADIER_STREAM_FEEDS_QUOTES: '0' })).toBe(false);
  });
});
