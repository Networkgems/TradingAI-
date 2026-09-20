import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchStockTwitsStream,
  fetchStockTwitsUserStream,
  describeCuratedLane,
  getCuratedStockTwitsAccounts,
  DEFAULT_CURATED_STOCKTWITS_ACCOUNTS,
  isStockTwitsBreakerOpen,
  resetStockTwitsBreaker,
  tripStockTwitsBreaker,
  resetStockTwitsProxy,
  describeStockTwitsEgress,
  probeStockTwits,
  stockTwitsBreakerOpenUntil,
} from './stocktwits-feed.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

const STREAM_FIXTURE = {
  messages: [
    { id: 1, created_at: '2026-06-06T15:59:00Z', entities: { sentiment: { basic: 'Bullish' } } },
    { id: 2, created_at: '2026-06-06T15:58:00Z', entities: { sentiment: { basic: 'Bearish' } } },
    { id: 3, created_at: '2026-06-06T15:57:00Z', entities: { sentiment: null } },
    { id: 4, created_at: '2026-06-06T15:56:00Z' }, // no entities at all
    { created_at: '2026-06-06T15:55:00Z', entities: { sentiment: { basic: 'Bullish' } } }, // no id → dropped
  ],
};

describe('fetchStockTwitsStream', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  it('normalizes the stream and maps the Bullish/Bearish tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(STREAM_FIXTURE)));
    const out = await fetchStockTwitsStream('aapl');
    expect(out).not.toBeNull();
    // The 5th raw message has no id → dropped; the other 4 survive.
    expect(out!).toHaveLength(4);
    expect(out![0]).toEqual({ id: 1, createdAt: '2026-06-06T15:59:00Z', sentiment: 'Bullish' });
    expect(out![1].sentiment).toBe('Bearish');
    expect(out![2].sentiment).toBeNull();
    expect(out![3].sentiment).toBeNull();
  });

  it('uppercases the symbol in the request URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('nvda');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/symbol/NVDA.json'),
      // TRA-1330 — browser-like header fingerprint to clear Cloudflare on datacenter egress.
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('returns null and trips the breaker on a 429', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } })));
    const out = await fetchStockTwitsStream('AAPL');
    expect(out).toBeNull();
    expect(isStockTwitsBreakerOpen()).toBe(true);
  });

  it('skips the network call entirely while the breaker is open', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    const fetchMock = vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL'); // trips breaker
    const callsAfterTrip = fetchMock.mock.calls.length;
    const out = await fetchStockTwitsStream('AAPL'); // should short-circuit
    expect(out).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterTrip);
  });

  it('returns null (not throw) on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })));
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
  });

  it('does NOT attach an access_token when the env is unset (TRA-1963)', async () => {
    const prev = process.env.STOCKTWITS_ACCESS_TOKEN;
    delete process.env.STOCKTWITS_ACCESS_TOKEN;
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('access_token'),
      expect.anything(),
    );
    if (prev !== undefined) process.env.STOCKTWITS_ACCESS_TOKEN = prev;
  });

  it('attaches the OAuth access_token as a query param when the env is set (TRA-1963)', async () => {
    const prev = process.env.STOCKTWITS_ACCESS_TOKEN;
    process.env.STOCKTWITS_ACCESS_TOKEN = 'secret tok/en';
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL');
    // URL-encoded, appended with the correct separator on a path that had no query.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/symbol/AAPL.json?access_token=secret%20tok%2Fen'),
      expect.anything(),
    );
    if (prev === undefined) delete process.env.STOCKTWITS_ACCESS_TOKEN;
    else process.env.STOCKTWITS_ACCESS_TOKEN = prev;
  });

  it('does NOT attach a proxy dispatcher when STOCKTWITS_PROXY_URL is unset (TRA-1969)', async () => {
    const prev = process.env.STOCKTWITS_PROXY_URL;
    delete process.env.STOCKTWITS_PROXY_URL;
    resetStockTwitsProxy();
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL');
    // Inert: the init is headers-only, byte-for-byte identical to pre-TRA-1969.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ dispatcher: expect.anything() }),
    );
    resetStockTwitsProxy();
    if (prev !== undefined) process.env.STOCKTWITS_PROXY_URL = prev;
  });

  it('routes through a proxy dispatcher when STOCKTWITS_PROXY_URL is set (TRA-1969)', async () => {
    const prev = process.env.STOCKTWITS_PROXY_URL;
    process.env.STOCKTWITS_PROXY_URL = 'http://user:pass@static.example.com:9293';
    resetStockTwitsProxy();
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL');
    // A dispatcher (undici ProxyAgent) is attached so Cloudflare sees the clean egress IP.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
    resetStockTwitsProxy();
    if (prev === undefined) delete process.env.STOCKTWITS_PROXY_URL;
    else process.env.STOCKTWITS_PROXY_URL = prev;
  });

  it('returns null (not throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
  });

  it('tolerates a body without a messages array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ symbol: { id: 1 } })));
    expect(await fetchStockTwitsStream('AAPL')).toEqual([]);
  });
});

const USER_STREAM_FIXTURE = {
  messages: [
    {
      id: 10,
      created_at: '2026-06-06T15:59:00Z',
      entities: { sentiment: { basic: 'Bullish' } },
      symbols: [{ symbol: 'AAPL' }, { symbol: 'tsla' }, { symbol: 'AAPL' }],
    },
    {
      id: 11,
      created_at: '2026-06-06T15:58:00Z',
      entities: { sentiment: null },
      symbols: [{ symbol: 'NVDA' }, { title: 'no symbol field' }, null],
    },
    {
      id: 12,
      created_at: '2026-06-06T15:57:00Z',
      // no symbols entity at all → empty list
    },
  ],
};

describe('fetchStockTwitsUserStream (TRA-603)', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  it('normalizes curated messages, flags curated, and parses the symbols entity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(USER_STREAM_FIXTURE)));
    const out = await fetchStockTwitsUserStream('ivanhoff');
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(3);
    expect(out![0]).toEqual({
      id: 10,
      createdAt: '2026-06-06T15:59:00Z',
      sentiment: 'Bullish',
      curated: true,
      symbols: ['AAPL', 'TSLA'], // uppercased + deduped
    });
    expect(out![1].symbols).toEqual(['NVDA']); // drops the symbol-less / null entries
    expect(out![2].symbols).toEqual([]); // no symbols entity
    expect(out!.every(m => m.curated === true)).toBe(true);
  });

  it('hits the user endpoint and reuses the rate-limit breaker', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(USER_STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsUserStream('howardlindzon');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/user/howardlindzon.json'),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('returns null and trips the shared breaker on a 429', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } })));
    expect(await fetchStockTwitsUserStream('Stocktwits')).toBeNull();
    expect(isStockTwitsBreakerOpen()).toBe(true);
    // breaker is shared with the symbol stream — the next symbol fetch short-circuits
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (not throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchStockTwitsUserStream('JFDI')).toBeNull();
  });
});

describe('probeStockTwits (TRA-1330)', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  it('sends the browser header fingerprint and reports ok + message count on 200', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    const out = await probeStockTwits('aapl');
    expect(out).toEqual({
      ok: true, status: 200, messageCount: 5, reason: null,
      breakerOpen: false, breakerOpenUntil: null, breakerOpenForMs: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/symbol/AAPL.json'),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('surfaces the raw HTTP status on a Cloudflare block (403) without tripping the breaker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 403 })));
    const out = await probeStockTwits('AAPL');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
    expect(out.reason).toContain('403');
    expect(isStockTwitsBreakerOpen()).toBe(false); // a probe must not stall the real recorder
  });

  it('reports breakerOpen without hitting the network when the breaker is open', async () => {
    const until = Date.parse('2099-01-01T00:00:00Z');
    tripStockTwitsBreaker(until);
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    const out = await probeStockTwits('AAPL');
    expect(out).toMatchObject({
      ok: false, status: null, messageCount: null,
      breakerOpen: true, breakerOpenUntil: '2099-01-01T00:00:00.000Z',
      reason: 'rate-limit breaker open',
    });
    expect(out.breakerOpenForMs).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // TRA-2519 — `breakerOpen: true` alone cannot separate a routine 5-minute
  // cooldown from a breaker stuck open, which is precisely how the 07-27/07-28
  // zero-days got read as "latched open" when the breaker was cycling normally.
  // The probe must publish the deadline so the two are distinguishable.
  it('publishes the reset deadline so a short cooldown is distinguishable from a stuck breaker', async () => {
    const soon = Date.now() + 5 * 60_000;
    tripStockTwitsBreaker(soon);
    const out = await probeStockTwits('AAPL');
    expect(out.breakerOpen).toBe(true);
    expect(out.breakerOpenUntil).toBe(new Date(soon).toISOString());
    expect(out.breakerOpenForMs).toBeLessThanOrEqual(5 * 60_000);
    expect(out.breakerOpenForMs).toBeGreaterThan(4 * 60_000);
  });

  it('reports a closed breaker as null deadline, not a stale timestamp', async () => {
    tripStockTwitsBreaker(Date.now() - 1_000); // already lapsed
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(STREAM_FIXTURE)));
    const out = await probeStockTwits('AAPL');
    expect(out.breakerOpen).toBe(false);
    expect(out.breakerOpenUntil).toBeNull();
    expect(out.breakerOpenForMs).toBeNull();
  });
});

/**
 * TRA-2519 — the breaker cooldown must stay bounded.
 *
 * `X-RateLimit-Reset` is epoch SECONDS and we multiply by 1000. A value already
 * in milliseconds would put the deadline ~57,000 years out and latch the breaker
 * for the whole process lifetime — and `breakerOpen: true` looks identical at 5
 * minutes and at 5 millennia, so nothing would ever surface it. StockTwits' own
 * window is hourly, so a 1h clamp costs at most one extra 429.
 */
describe('rate-limit breaker cooldown bounds (TRA-2519)', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  const rateLimited = (headers: Record<string, string>) =>
    vi.fn(async () => new Response('{}', { status: 429, headers }));

  it('honours a sane epoch-seconds reset header', async () => {
    const resetSec = Math.floor((Date.now() + 10 * 60_000) / 1000);
    vi.stubGlobal('fetch', rateLimited({ 'x-ratelimit-reset': String(resetSec) }));
    await fetchStockTwitsStream('AAPL');
    const until = stockTwitsBreakerOpenUntil()!;
    expect(until).toBe(resetSec * 1000);
  });

  it('clamps a millisecond-valued reset header to the default cooldown', async () => {
    const msValued = Date.now() + 10 * 60_000; // epoch MILLIS in a seconds field
    vi.stubGlobal('fetch', rateLimited({ 'x-ratelimit-reset': String(msValued) }));
    await fetchStockTwitsStream('AAPL');
    const openFor = stockTwitsBreakerOpenUntil()! - Date.now();
    expect(openFor).toBeGreaterThan(4 * 60_000);
    expect(openFor).toBeLessThanOrEqual(5 * 60_000); // NOT the year 58,543
  });

  it('falls back to the default cooldown when the reset header is in the past', async () => {
    const past = Math.floor((Date.now() - 60_000) / 1000);
    vi.stubGlobal('fetch', rateLimited({ 'x-ratelimit-reset': String(past) }));
    await fetchStockTwitsStream('AAPL');
    // A past deadline would leave the breaker effectively closed and let the
    // caller hammer straight back into the throttle.
    expect(isStockTwitsBreakerOpen()).toBe(true);
    expect(stockTwitsBreakerOpenUntil()! - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it('uses the default cooldown when no reset header arrives (the bqb1 case)', async () => {
    vi.stubGlobal('fetch', rateLimited({}));
    await fetchStockTwitsStream('AAPL');
    const openFor = stockTwitsBreakerOpenUntil()! - Date.now();
    expect(openFor).toBeGreaterThan(4 * 60_000);
    expect(openFor).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe('getCuratedStockTwitsAccounts (TRA-603, retired TRA-4739)', () => {
  // TRA-4739 — the lane is retired by board decision. The assertion that matters
  // is that NOTHING is polled by default: the whole point of the decision is the
  // nine HTTP fetches per sweep going away, so a default that still named even
  // one account would be a silent no-change. Asserting `[]` rather than
  // `not.toEqual(DEFAULT_...)` is deliberate — the latter would also pass on a
  // list that was merely reordered or trimmed to eight.
  it('defaults to EMPTY — the curated lane is retired, nobody is polled', () => {
    expect(getCuratedStockTwitsAccounts({})).toEqual([]);
  });

  it('still exports the seed list for documentation / resurrection', () => {
    // Retiring the lane must not delete the record of what it used to poll.
    expect(DEFAULT_CURATED_STOCKTWITS_ACCOUNTS.length).toBe(9);
    expect(DEFAULT_CURATED_STOCKTWITS_ACCOUNTS).toContain('howardlindzon');
  });

  it('parses a comma-separated env override, trimming blanks', () => {
    const env = { CURATED_STOCKTWITS_ACCOUNTS: ' alpha , beta ,, gamma ' } as NodeJS.ProcessEnv;
    expect(getCuratedStockTwitsAccounts(env)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('a blank env is retired, not a fallback to the old nine', () => {
    const env = { CURATED_STOCKTWITS_ACCOUNTS: '   ' } as NodeJS.ProcessEnv;
    expect(getCuratedStockTwitsAccounts(env)).toEqual([]);
  });
});

describe('describeCuratedLane (TRA-4739)', () => {
  // The discriminator this exists for: `curatedCount: 0` in a recorded row reads
  // identically whether nine accounts were polled and said nothing attributable
  // (the 20 dry days before the retirement) or nobody was polled at all (every
  // day after it). Without a status value beside the count, a re-grade spanning
  // 2026-09-20 cannot tell which population it is looking at.
  it('reports `retired` with zero accounts by default', () => {
    expect(describeCuratedLane({})).toEqual({ status: 'retired', accounts: 0 });
  });

  it('reports `enabled_by_env` and the count when resurrected', () => {
    const env = { CURATED_STOCKTWITS_ACCOUNTS: 'alpha,beta' } as NodeJS.ProcessEnv;
    expect(describeCuratedLane(env)).toEqual({ status: 'enabled_by_env', accounts: 2 });
  });

  it('distinguishes the two states — they must not share a value', () => {
    const on = describeCuratedLane({ CURATED_STOCKTWITS_ACCOUNTS: 'alpha' } as NodeJS.ProcessEnv);
    expect(on.status).not.toBe(describeCuratedLane({}).status);
  });
});

// ── TRA-1969 — is the clean-egress proxy ACTUALLY in the request path? ────────
//
// The board approved money (micro-VM tier, ~$5-7/mo) for a leg whose entire
// value proposition is "the egress IP changed". A proxy that is configured but
// NOT in the path produces exactly the same feed behaviour as a working one —
// same 200s, same 429s, same Cloudflare verdicts — so "we set the secret and it
// still works" is unfalsifiable without this. The `proxy-bypassed` control below
// is the one that earns this suite its keep.
describe('describeStockTwitsEgress (TRA-1969)', () => {
  const ECHO = 'https://api.ipify.org?format=json';

  /** Echo server that answers with a different IP depending on the dispatcher. */
  function echoMock(direct: string | null, proxied: string | null) {
    return vi.fn(async (url: unknown, init?: { dispatcher?: unknown }) => {
      if (String(url) !== ECHO) return jsonResponse({});
      const ip = init?.dispatcher ? proxied : direct;
      if (ip === null) throw new Error('egress echo unreachable');
      return jsonResponse({ ip });
    });
  }

  beforeEach(() => resetStockTwitsProxy());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsProxy(); });

  it('reports no-proxy, and still records the host egress IP, when unset', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', 'unused'));
    const d = await describeStockTwitsEgress({} as NodeJS.ProcessEnv);
    expect(d.proxyConfigured).toBe(false);
    expect(d.verdict).toBe('no-proxy');
    // Recorded even with no proxy: a future Cloudflare block can then be
    // attributed to a named IP instead of guessed at.
    expect(d.directEgressIp).toBe('35.1.1.1');
    expect(d.proxyEgressIp).toBeNull();
  });

  it('reports proxy-in-path when the egress IP genuinely changes', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', '203.0.113.7'));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'http://user:pass@vm.example.com:3128',
    } as NodeJS.ProcessEnv);
    expect(d.verdict).toBe('proxy-in-path');
    expect(d.directEgressIp).toBe('35.1.1.1');
    expect(d.proxyEgressIp).toBe('203.0.113.7');
    expect(d.reason).toBeNull();
  });

  // ⛔ THE CONTROL THAT MATTERS. Without it the whole descriptor is decoration.
  it('reports proxy-bypassed when the secret is set but egress is UNCHANGED', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', '35.1.1.1'));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'http://user:pass@vm.example.com:3128',
    } as NodeJS.ProcessEnv);
    expect(d.proxyConfigured).toBe(true);
    expect(d.verdict).toBe('proxy-bypassed');
    expect(d.reason).toContain('egress is UNCHANGED');
  });

  it('NEVER leaks the proxy credentials — host:port only', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', '203.0.113.7'));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'http://s3cr3tuser:s3cr3tpass@vm.example.com:3128',
    } as NodeJS.ProcessEnv);
    expect(d.proxyHost).toBe('vm.example.com:3128');
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('s3cr3tpass');
    expect(serialized).not.toContain('s3cr3tuser');
  });

  // A malformed secret used to THROW out of `new ProxyAgent()` on every call,
  // i.e. a typo in a hand-set host env took the whole feed down. It now degrades
  // to direct egress — and the descriptor is what stops that degradation from
  // being silent: same IP both ways => `proxy-bypassed`, with a null host.
  it('does not throw on an unparseable proxy URL, and reports it as bypassed', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', '203.0.113.7'));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'not a url with s3cr3tpass in it',
    } as NodeJS.ProcessEnv);
    expect(d.proxyConfigured).toBe(true);
    expect(d.proxyHost).toBeNull();
    expect(d.verdict).toBe('proxy-bypassed');
    expect(JSON.stringify(d)).not.toContain('s3cr3tpass');
  });

  it('keeps the FEED alive when the proxy URL is malformed (degrade, never crash)', async () => {
    const prev = process.env.STOCKTWITS_PROXY_URL;
    process.env.STOCKTWITS_PROXY_URL = '::: not a url :::';
    resetStockTwitsProxy();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(STREAM_FIXTURE)));
    // Before the fix this rejected with `TypeError: Invalid URL` and the feed
    // was dead for as long as the bad secret was set.
    await expect(fetchStockTwitsStream('AAPL')).resolves.not.toBeNull();
    resetStockTwitsProxy();
    if (prev === undefined) delete process.env.STOCKTWITS_PROXY_URL;
    else process.env.STOCKTWITS_PROXY_URL = prev;
  });

  it('fails to UNKNOWN, never to a verdict, when the proxied lookup dies', async () => {
    // A dead micro-VM. This must not read as `no-proxy` (which would look like a
    // clean unconfigured state) nor as `proxy-in-path` (which would bless it).
    vi.stubGlobal('fetch', echoMock('35.1.1.1', null));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'http://user:pass@vm.example.com:3128',
    } as NodeJS.ProcessEnv);
    expect(d.verdict).toBe('unknown');
    expect(d.proxyEgressIp).toBeNull();
    expect(d.reason).toContain('the proxy may be down');
  });

  it('fails to UNKNOWN when there is no baseline to compare against', async () => {
    vi.stubGlobal('fetch', echoMock(null, '203.0.113.7'));
    const d = await describeStockTwitsEgress({
      STOCKTWITS_PROXY_URL: 'http://user:pass@vm.example.com:3128',
    } as NodeJS.ProcessEnv);
    expect(d.verdict).toBe('unknown');
    expect(d.reason).toContain('nothing to compare against');
  });

  it('reports whether the OAuth token (leg A) is set, without revealing it', async () => {
    vi.stubGlobal('fetch', echoMock('35.1.1.1', 'unused'));
    const withTok = await describeStockTwitsEgress({
      STOCKTWITS_ACCESS_TOKEN: 't0ps3cr3ttoken',
    } as NodeJS.ProcessEnv);
    expect(withTok.tokenConfigured).toBe(true);
    expect(JSON.stringify(withTok)).not.toContain('t0ps3cr3ttoken');
    const without = await describeStockTwitsEgress({} as NodeJS.ProcessEnv);
    expect(without.tokenConfigured).toBe(false);
  });
});
