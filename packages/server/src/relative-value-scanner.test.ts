import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradierRelativeValueScannerService, REFUSAL_4XX_COOLDOWN_MS } from './relative-value-scanner.js';
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
  // Extrinsic value is scaled so even OTM rows clear the recalibrated $0.40
  // `minMark` floor (TRA-461) — this fixture exercises scanner plumbing
  // (caching, breaker, expiration pick, skew fit), not the selection filter.
  const intrinsic = optionType === 'call' ? Math.max(0, 100 - strike) : Math.max(0, strike - 100);
  const extrinsic = 1.0 * (iv / 0.30); // representative time value, scaled by IV
  const mark = Math.max(0.50, intrinsic + extrinsic);
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

  describe('breaker cooldowns (TRA-417)', () => {
    it('429-shaped error auto-closes after ~90s and lets the next scan proceed', async () => {
      const { svc, client, advance } = makeService();
      client.getExpirations.mockRejectedValueOnce(new Error('429 too many requests'));
      await svc.scan('TEST');
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(89_000);
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(2_000); // crosses the 90s cooldown
      expect(svc.diagnostics().breakerOpen).toBe(false);

      client.getExpirations.mockResolvedValueOnce([EXP]);
      client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
      const result = await svc.scan('TEST');
      expect(result.reason).toBe('ok');
    });

    it('non-429 upstream error uses the ~5min cooldown, not the 90s one', async () => {
      const { svc, client, advance } = makeService();
      client.getExpirations.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      await svc.scan('TEST');
      expect(svc.diagnostics().breakerOpen).toBe(true);

      // Past the 90s 429 cooldown but well within the 5min upstream cooldown.
      advance(2 * 60_000);
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(4 * 60_000); // total 6min — past 5min cooldown
      expect(svc.diagnostics().breakerOpen).toBe(false);
    });

    it('repeated 429s within the backoff window exponentially extend the cooldown', async () => {
      const { svc, client, advance } = makeService();
      client.getExpirations.mockResolvedValue([EXP]); // expirations always succeed; chain is what 429s
      client.getChainSnapshot.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      await svc.scan('TEST');
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(91_000); // first 90s cooldown elapses
      expect(svc.diagnostics().breakerOpen).toBe(false);

      // Second 429 inside the 5min backoff window → cooldown doubles to ~180s.
      client.getChainSnapshot.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      await svc.scan('TEST');
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(120_000); // 120s into the 180s second cooldown — still open
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(61_000); // total 181s after second trip — closed
      expect(svc.diagnostics().breakerOpen).toBe(false);
    });

    it('a successful upstream call resets the consecutive-429 backoff counter', async () => {
      const { svc, client, advance } = makeService();
      client.getExpirations.mockResolvedValue([EXP]);

      // Trip 1: 429 on the chain.
      client.getChainSnapshot.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      await svc.scan('TEST');
      advance(91_000); // first 90s cooldown done

      // Successful intermediate scan resets the counter.
      client.getChainSnapshot.mockResolvedValueOnce([row(100, 'call', 0.30)]);
      const ok = await svc.scan('TEST');
      expect(ok.reason).toBe('ok');

      // Past the 60s chain cache TTL so the next scan hits the client again.
      advance(61_000);

      // Trip 2: another 429 — should get the BASE 90s cooldown, not the
      // backed-off 180s, because the success reset the counter.
      client.getChainSnapshot.mockRejectedValueOnce(new Error('429 Too Many Requests'));
      await svc.scan('TEST');
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(89_000);
      expect(svc.diagnostics().breakerOpen).toBe(true);

      advance(2_000); // crosses 90s
      expect(svc.diagnostics().breakerOpen).toBe(false);
    });

    it('diagnostics.breakerOpenedAtMs reflects the most recent trip', async () => {
      const { svc, client, advance } = makeService();
      const t0 = svc.diagnostics().breakerOpenedAtMs;
      expect(t0).toBeNull();

      advance(1_000);
      client.getExpirations.mockRejectedValueOnce(new Error('429 too many requests'));
      await svc.scan('TEST');
      const t1 = svc.diagnostics().breakerOpenedAtMs;
      expect(t1).toBe(NOW_BASE + 1_000);
    });
  });

  // TRA-943 (TRA-908 Phase A) — the per-tick option-shadow pass fans
  // `getSelectorChain` across the full active-symbol roster, and the in-window
  // expiration rotates over days. Before the fix both caches were write-only
  // (stale entries never deleted, only overwritten on a same-key refetch), so
  // the retained working set grew without bound — the leading footprint driver
  // behind the TRA-937 OOM. These tests pin the bound so a regression trips CI,
  // not prod.
  describe('bounded cache working set (TRA-943)', () => {
    it('caps the chain + expirations caches no matter how many distinct symbols are scanned', async () => {
      const { svc, client } = makeService();
      client.getExpirations.mockResolvedValue([EXP]);
      client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3), row(105, 'call', 0.3)]);

      const { chainCacheMaxEntries, expirationsCacheMaxEntries } = svc.diagnostics();
      // Scan far more distinct symbols than either cap. With the old write-only
      // caches `cacheSize` would equal the symbol count; with the bound it stays
      // pinned at the cap (time does not advance here, so every entry is fresh
      // and it is the size cap — oldest-first eviction — that holds the line).
      const symbols = chainCacheMaxEntries * 3;
      for (let i = 0; i < symbols; i++) {
        await svc.getSelectorChain(`SYM${i}`);
      }

      const diag = svc.diagnostics();
      expect(diag.cacheSize).toBeLessThanOrEqual(chainCacheMaxEntries);
      expect(diag.expirationsCacheSize).toBeLessThanOrEqual(expirationsCacheMaxEntries);
      // Sanity: we genuinely pushed past the cap, so the assertion has teeth.
      expect(symbols).toBeGreaterThan(chainCacheMaxEntries);
    });

    it('sweeps TTL-expired chain snapshots on the next write instead of retaining them', async () => {
      const { svc, client, advance } = makeService();
      client.getExpirations.mockResolvedValue([EXP]);
      client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

      await svc.getSelectorChain('AAA');
      await svc.getSelectorChain('BBB');
      expect(svc.diagnostics().cacheSize).toBe(2);

      // Age both chain entries past the 60s chain TTL, then write a third. The
      // stale AAA/BBB snapshots are evicted on that write, so only CCC remains.
      advance(61_000);
      await svc.getSelectorChain('CCC');
      expect(svc.diagnostics().cacheSize).toBe(1);
    });
  });
});

// TRA-161 — `scanOtm` used to flatten EVERY failure of the snapshot path into a
// single `reason: 'unavailable'`, because `getSelectorChain` returns a bare
// `null` for all of them. That is enough for the in-process signal-engine
// caller (it only asks "did I get rows?"), but it makes an empty scan
// undiagnosable for a human: a missing credential, an open breaker and a symbol
// with no listed chain are the same string. The desktop panel (this ticket)
// has to tell the operator WHICH one happened.
//
// These tests pin the discrimination itself — one reason per precondition, each
// asserting it is NOT the legacy catch-all — plus the invariant that matters
// for safety: `getSelectorChain` still returns `null` in exactly the same
// cases, so the shadow option selector in `signal-engine` is untouched by the
// split.
describe('TradierRelativeValueScannerService.scanOtm — discriminated reasons (TRA-161)', () => {
  function otmRows(): OptionChainRow[] {
    // Spot is 100 in `makeService`, so calls above it are the OTM side.
    return [row(105, 'call', 0.30), row(110, 'call', 0.30), row(115, 'call', 0.30)];
  }

  it('returns candidates with reason ok on a healthy chain', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue(otmRows());

    const result = await svc.scanOtm('TEST');
    expect(result.reason).toBe('ok');
    expect(result.spot).toBe(100);
    expect(result.expiration).toBe(EXP);
    expect(result.candidates.length).toBeGreaterThan(0);
    // Ranked by |mispricingPct| descending — the panel slices a top-N off this.
    const mags = result.candidates.map((c) => Math.abs(c.mispricingPct));
    expect([...mags].sort((a, b) => b - a)).toEqual(mags);
  });

  it('reports no_credentials — not unavailable — when the client is absent', async () => {
    const svc = new TradierRelativeValueScannerService({ fetchSpot: async () => 100 });
    const result = await svc.scanOtm('TEST');
    expect(result.reason).toBe('no_credentials');
    expect(result.reason).not.toBe('unavailable');
    expect(result.candidates).toHaveLength(0);
    // Unchanged contract for the in-process caller.
    expect(await svc.getSelectorChain('TEST')).toBeNull();
  });

  it('reports no_spot — not unavailable — when the quote feed has no price', async () => {
    // NB: `makeService({ spot: null })` does NOT work — the helper's
    // `overrides.spot ?? 100` collapses an explicit null back to 100, so a
    // "no spot" fixture built that way silently scans a healthy chain and the
    // test passes for the wrong reason. Drive the seam directly.
    const { svc, client } = makeService({ fetchSpotImpl: async () => null });
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue(otmRows());

    const result = await svc.scanOtm('TEST');
    expect(result.reason).toBe('no_spot');
    expect(result.candidates).toHaveLength(0);
    expect(await svc.getSelectorChain('TEST')).toBeNull();
  });

  it('reports no_expirations — not unavailable — when nothing lists in the DTE window', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([]);

    const result = await svc.scanOtm('TEST');
    expect(result.reason).toBe('no_expirations');
    expect(result.candidates).toHaveLength(0);
    expect(await svc.getSelectorChain('TEST')).toBeNull();
  });

  it('reports no_chain — not unavailable — when the expiration returns zero rows', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([]);

    const result = await svc.scanOtm('TEST');
    expect(result.reason).toBe('no_chain');
    expect(result.candidates).toHaveLength(0);
    expect(await svc.getSelectorChain('TEST')).toBeNull();
  });

  it('reports fetch_error with the upstream message, then breaker_open on the retry', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockRejectedValue(new Error('tradier exploded'));

    const first = await svc.scanOtm('TEST');
    expect(first.reason).toBe('fetch_error');
    expect(first.errorMessage).toContain('tradier exploded');

    // That failure tripped the breaker, so the very next scan short-circuits —
    // and must say so, rather than repeating the upstream error it did not make.
    expect(svc.diagnostics().breakerOpen).toBe(true);
    const second = await svc.scanOtm('TEST');
    expect(second.reason).toBe('breaker_open');
    expect(second.candidates).toHaveLength(0);
    expect(await svc.getSelectorChain('TEST')).toBeNull();
  });

  it('never emits the legacy unavailable catch-all from any precondition', async () => {
    // The regression guard: if a new early-return is added to the resolver and
    // left un-named, this is what catches it.
    const cases: Array<() => Promise<{ reason?: string }>> = [
      async () => {
        const svc = new TradierRelativeValueScannerService({ fetchSpot: async () => 100 });
        return svc.scanOtm('TEST');
      },
      async () => {
        const { svc, client } = makeService({ fetchSpotImpl: async () => null });
        client.getExpirations.mockResolvedValue([EXP]);
        client.getChainSnapshot.mockResolvedValue(otmRows());
        return svc.scanOtm('TEST');
      },
      async () => {
        const { svc, client } = makeService();
        client.getExpirations.mockResolvedValue([]);
        return svc.scanOtm('TEST');
      },
      async () => {
        const { svc, client } = makeService();
        client.getExpirations.mockResolvedValue([EXP]);
        client.getChainSnapshot.mockResolvedValue([]);
        return svc.scanOtm('TEST');
      },
    ];
    for (const run of cases) {
      const result = await run();
      expect(result.reason).not.toBe('unavailable');
      expect(result.reason).toBeTruthy();
    }
  });
});

// TRA-4413 item 4 — the cross-expiration term-structure scan transport. The
// FOLD's behaviour (buckets, √T fit, z-scores, calendar control) is covered by
// the engine's own suite; these tests pin the scanner-side plumbing — reason
// discrimination, expiration selection/capping, the provided-spot fast path,
// and breaker integration.
describe('scanTermStructure (TRA-4413 item 4)', () => {
  // Three in-window expirations for NOW_BASE (21–60d window: 2024-02-05..2024-03-15).
  const T_EXPS = ['2024-02-09', '2024-02-23', '2024-03-08'];

  function rowAt(exp: string, strike: number, iv: number): OptionChainRow {
    const base = row(strike, 'call', iv);
    return { ...base, expiration: exp, optionSymbol: `TEST${exp}${strike}C` };
  }

  it('reports no_credentials without a client', async () => {
    const svc = new TradierRelativeValueScannerService({ fetchSpot: async () => 100 });
    const result = await svc.scanTermStructure('TEST');
    expect(result.reason).toBe('no_credentials');
    expect(result.report).toBeNull();
  });

  it('refuses with no_expirations when fewer than 2 expirations are in window', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]); // exactly one in window
    const result = await svc.scanTermStructure('TEST');
    expect(result.reason).toBe('no_expirations');
    expect(result.expirations).toHaveLength(0);
    expect(client.getChainSnapshot).not.toHaveBeenCalled();
  });

  it('fetches one chain per in-window expiration and returns a report', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue(T_EXPS);
    client.getChainSnapshot.mockImplementation(async (_s, e) => [
      rowAt(e, 95, 0.32),
      rowAt(e, 100, 0.30),
      rowAt(e, 105, 0.28),
    ]);
    const result = await svc.scanTermStructure('TEST');
    expect(result.reason).toBe('ok');
    expect(result.expirations).toEqual(T_EXPS); // ascending, all three
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(3);
    expect(result.report).not.toBeNull();
    expect(result.report!.rowsIn).toBe(9);
  });

  it('uses a caller-provided spot without a second fetchSpot call', async () => {
    const fetchSpotImpl = vi.fn(async () => 100);
    const { svc, client } = makeService({ fetchSpotImpl });
    client.getExpirations.mockResolvedValue(T_EXPS);
    client.getChainSnapshot.mockResolvedValue([rowAt(T_EXPS[0]!, 100, 0.30)]);
    const result = await svc.scanTermStructure('TEST', {}, { spot: 101.5 });
    expect(result.reason).toBe('ok');
    expect(result.spot).toBe(101.5);
    expect(fetchSpotImpl).not.toHaveBeenCalled();
  });

  it('caps the fetch at MAX_TERM_EXPIRATIONS, keeping the first and last', async () => {
    const { svc, client } = makeService();
    // Six in-window expirations (weekly cadence).
    const six = ['2024-02-09', '2024-02-16', '2024-02-23', '2024-03-01', '2024-03-08', '2024-03-15'];
    client.getExpirations.mockResolvedValue(six);
    client.getChainSnapshot.mockImplementation(async (_s, e) => [rowAt(e, 100, 0.30)]);
    const result = await svc.scanTermStructure('TEST');
    expect(result.reason).toBe('ok');
    expect(result.expirations).toHaveLength(4);
    expect(result.expirations[0]).toBe(six[0]); // span preserved: first…
    expect(result.expirations[3]).toBe(six[5]); // …and last always kept
    expect(client.getChainSnapshot).toHaveBeenCalledTimes(4);
  });

  it('trips the breaker on a chain fetch error and reports fetch_error', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue(T_EXPS);
    client.getChainSnapshot.mockRejectedValue(new Error('boom'));
    const result = await svc.scanTermStructure('TEST');
    expect(result.reason).toBe('fetch_error');
    expect(svc.diagnostics().breakerOpen).toBe(true);
    const second = await svc.scanTermStructure('TEST');
    expect(second.reason).toBe('breaker_open');
  });
});

// TRA-4664 — `/api/options/otm-mispricing` read `no_expirations` / `no_chain`
// episodically in RTH with `breakerOpen: false`. Root cause: the client's
// collapsed `getExpirations`/`getChainSnapshot` turn a Tradier 429 into `[]`,
// which the scanner reported as a domain outcome AND CACHED (6h for
// expirations). These tests drive the status-preserving `fetch*` path.
class CheckedFakeClient extends FakeClient {
  fetchExpirations = vi.fn<(s: string) => Promise<
    { ok: true; httpStatus: number; value: string[] } | { ok: false; httpStatus: number }
  >>();
  fetchChainSnapshot = vi.fn<(s: string, e: string) => Promise<
    { ok: true; httpStatus: number; value: OptionChainRow[] } | { ok: false; httpStatus: number }
  >>();
}

describe('Tradier HTTP refusals are not listings (TRA-4664)', () => {
  const okExp = { ok: true as const, httpStatus: 200, value: [EXP] };
  const okChain = { ok: true as const, httpStatus: 200, value: [row(100, 'call', 0.3)] };

  it('a 429 on expirations is fetch_error + breaker, and is NOT cached as an empty listing', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockResolvedValueOnce({ ok: false, httpStatus: 429 }).mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    const first = await svc.scanOtm('SPY');
    expect(first.reason).toBe('fetch_error');
    expect(first.errorMessage).toMatch(/HTTP 429/);
    const diag = svc.diagnostics();
    expect(diag.breakerOpen).toBe(true);
    expect(diag.upstreamRefusals).toEqual({ byStatus: { '429': 1 }, lastAtMs: NOW_BASE, lastStatus: 429 });
    // Nothing cached: pre-fix this entry was `[]` for SIX HOURS.
    expect(diag.expirationsCacheSize).toBe(0);

    // Past the 90s rate-limit cooldown the SAME symbol recovers — only possible
    // because the refusal was never written to the expirations cache.
    advance(91_000);
    const second = await svc.scanOtm('SPY');
    expect(second.reason).toBe('ok');
    expect(client.fetchExpirations).toHaveBeenCalledTimes(2);
    // The collapsed readers are never consulted when the checked ones exist.
    expect(client.getExpirations).not.toHaveBeenCalled();
    expect(client.getChainSnapshot).not.toHaveBeenCalled();
  });

  it('a 5xx on the chain is fetch_error + breaker and is not cached as no_chain', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockResolvedValueOnce({ ok: false, httpStatus: 502 }).mockResolvedValue(okChain);

    const first = await svc.scanOtm('SPY');
    expect(first.reason).toBe('fetch_error');
    expect(svc.diagnostics().breakerOpen).toBe(true);
    expect(svc.diagnostics().cacheSize).toBe(0);
    advance(5 * 60_000 + 1);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
  });

  it('a non-429 4xx refuses THIS request only — the breaker stays closed for every other symbol', async () => {
    const client = new CheckedFakeClient();
    const { svc } = makeService({ client });
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'BAD!' ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    expect(svc.diagnostics().breakerOpen).toBe(false);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
  });

  it('a 400-refused key is not re-asked upstream during its cooldown, and every suppressed retry is counted (TRA-4664 second pass)', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'BAD!' ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);
    const upstreamCalls = () => client.fetchExpirations.mock.calls.filter(([s]) => s === 'BAD!').length;

    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    expect(upstreamCalls()).toBe(1);

    // Without the cooldown, bqb1 re-fired this exact refusal every cycle —
    // 1,079,861 HTTP 400s in 4.9h of RTH (~61 rps) on 2026-09-23. The same
    // three retries now cost zero upstream calls and still read fetch_error,
    // never no_expirations.
    for (let i = 1; i <= 3; i++) {
      advance(20_000);
      const r = await svc.scanOtm('BAD!');
      expect(r.reason).toBe('fetch_error');
      expect(r.errorMessage).toMatch(/HTTP 400/);
    }
    expect(upstreamCalls()).toBe(1);
    const d = svc.diagnostics();
    expect(d.upstreamRefusals!.byStatus).toEqual({ '400': 1 }); // upstream responses only
    expect(d.refusalCooldown).toEqual({
      size: 1,
      suppressed: 3,
      cooling: 1,
      byEndpoint: { expirations: 1, chain: 0 },
      keys: ['expirations|BAD!'],
      keysTruncated: false,
      // TRA-4865 — the suppressed retries are NOT refusals: one upstream 400
      // happened, so the session census reads one key refused once.
      sinceBoot: {
        distinctKeys: 1,
        byEndpoint: { expirations: 1, chain: 0 },
        refusals: 1,
        refusalsByKey: { 'expirations|BAD!': 1 },
        keysTruncated: false,
        evicted: 0,
      },
    });

    // The cooldown is per-key: other symbols are untouched.
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');

    // Past the cooldown the key is re-asked for real.
    advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    expect(upstreamCalls()).toBe(2);
    expect(svc.diagnostics().upstreamRefusals!.byStatus).toEqual({ '400': 2 });
  });

  it('a 400 on the chain cools the symbol|expiration key only — breaker closed, other symbols scan', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      s === 'BAD!' ? { ok: false, httpStatus: 400 } : okChain);

    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    advance(20_000);
    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    expect(client.fetchChainSnapshot.mock.calls.filter(([s]) => s === 'BAD!').length).toBe(1);
    expect(svc.diagnostics().refusalCooldown!.suppressed).toBe(1);
    expect(svc.diagnostics().breakerOpen).toBe(false);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
  });

  // TRA-4664 (third pass). On 2026-09-24 the live route answered `fetch_error`
  // in ~100ms for NVDA/AMZN/META/NFLX/AMD/IWM/COIN with zero upstream calls —
  // the cooldown working exactly as designed, and indistinguishable on every
  // health surface from a symbol that is simply fine. `size: 110` said how many
  // and nothing said which. These two tests are the discriminator.
  it('the cooldown census NAMES the cooling keys, per endpoint, with the symbol and expiration', async () => {
    const client = new CheckedFakeClient();
    const { svc } = makeService({ client });
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'NOEXP' ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      s === 'NOCHAIN' ? { ok: false, httpStatus: 400 } : okChain);

    expect((await svc.scanOtm('NOEXP')).reason).toBe('fetch_error');
    expect((await svc.scanOtm('NOCHAIN')).reason).toBe('fetch_error');
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');

    const cd = svc.diagnostics().refusalCooldown!;
    expect(cd.cooling).toBe(2);
    expect(cd.byEndpoint).toEqual({ expirations: 1, chain: 1 });
    expect(cd.keys).toEqual([`chain|NOCHAIN,${EXP}`, 'expirations|NOEXP']);
    expect(cd.keysTruncated).toBe(false);
    // A symbol that scans is never named.
    expect(cd.keys!.some(k => k.includes('SPY'))).toBe(false);
  });

  it('an expired-but-unswept entry drops out of the census, and READING the census does not sweep it', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'BAD!' ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
    expect(svc.diagnostics().refusalCooldown!.cooling).toBe(1);

    advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    const after = svc.diagnostics().refusalCooldown!;
    // `cooling` is the honest number: the key is no longer being suppressed.
    expect(after.cooling).toBe(0);
    expect(after.keys).toEqual([]);
    expect(after.byEndpoint).toEqual({ expirations: 0, chain: 0 });
    // …and `size` still counts the un-swept map entry. The census is a READ:
    // it must not mutate what the next read (or the next scan) sees, or the
    // second pass's `size` grade would move underneath itself.
    expect(after.size).toBe(1);
    expect(svc.diagnostics().refusalCooldown!.size).toBe(1);
  });

  // TRA-4865. The third pass's census is a TEN-MINUTE WINDOW. On live `d26f58b9`
  // (one boot, counters monotone) `size` read 110 at 17:0xZ and 8 / 8 / 3 / 24
  // over the next four minutes, while that ET day's retained scan census had
  // 2,888 of 13,900 live-desk OTM evaluations dying on a refusal re-throw. So a
  // one-shot read of the window can report ~nothing on a box that is 20% dark.
  // These two tests are the discriminator between the window and the session.
  it('keys swept out of the WINDOW census stay in the SINCE-BOOT census — the live 110 → 3 collapse', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    const badExp = new Set(['NOEXP', 'LATER']);
    client.fetchExpirations.mockImplementation(async (s) =>
      badExp.has(s) ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      s === 'NOCHAIN' ? { ok: false, httpStatus: 400 } : okChain);

    expect((await svc.scanOtm('NOEXP')).reason).toBe('fetch_error');
    expect((await svc.scanOtm('NOCHAIN')).reason).toBe('fetch_error');
    expect(svc.diagnostics().refusalCooldown!.size).toBe(2);

    // Past the cooldown, then a THIRD refusal — whose `putBounded` insert sweeps
    // every expired entry, so the window census loses the first two outright.
    // This is the live collapse: `size` 110 @17:0xZ → 3 @17:33Z on one boot.
    advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    expect((await svc.scanOtm('LATER')).reason).toBe('fetch_error');

    const cd = svc.diagnostics().refusalCooldown!;
    expect(cd.size).toBe(1);
    expect(cd.cooling).toBe(1);
    expect(cd.keys).toEqual(['expirations|LATER']);
    expect(cd.byEndpoint).toEqual({ expirations: 1, chain: 0 });
    // …and the session census still NAMES all three, split by endpoint — which
    // is the fork this issue turns on (a refused SYMBOL vs a refused EXPIRATION).
    expect(cd.sinceBoot).toEqual({
      distinctKeys: 3,
      byEndpoint: { expirations: 2, chain: 1 },
      refusals: 3,
      refusalsByKey: {
        [`chain|NOCHAIN,${EXP}`]: 1,
        'expirations|LATER': 1,
        'expirations|NOEXP': 1,
      },
      keysTruncated: false,
      evicted: 0,
    });
  });

  it('the since-boot census counts RE-ARMS, so a permanently dark key is distinguishable from a one-off refusal', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    let badCalls = 0;
    client.fetchExpirations.mockImplementation(async (s) => {
      if (s !== 'BAD!') return okExp;
      badCalls += 1;
      // Refused the first three times it is actually asked, fine afterwards —
      // a transient refusal, which must not read like a dark name.
      return badCalls <= 3 ? { ok: false, httpStatus: 400 } : okExp;
    });
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    for (let i = 0; i < 3; i++) {
      expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
      // Suppressed retries inside the window add to `suppressed`, never here.
      advance(20_000);
      expect((await svc.scanOtm('BAD!')).reason).toBe('fetch_error');
      advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    }
    expect(badCalls).toBe(3);
    const cd = svc.diagnostics().refusalCooldown!;
    expect(cd.suppressed).toBe(3);
    expect(cd.sinceBoot!.distinctKeys).toBe(1);
    expect(cd.sinceBoot!.refusals).toBe(3);
    expect(cd.sinceBoot!.refusalsByKey).toEqual({ 'expirations|BAD!': 3 });

    // The key recovers upstream. The census is a HISTORY, so it keeps naming it
    // — and `cooling: 0` beside `distinctKeys: 1` is what says "was dark, is
    // not now", a reading neither census can give on its own.
    expect((await svc.scanOtm('BAD!')).reason).toBe('ok');
    const rec = svc.diagnostics().refusalCooldown!;
    expect(rec.cooling).toBe(0);
    expect(rec.sinceBoot!.refusals).toBe(3);
    expect(rec.sinceBoot!.evicted).toBe(0);
  });

  it('a genuine 200 empty listing is still no_expirations (the domain outcome is preserved)', async () => {
    const client = new CheckedFakeClient();
    const { svc } = makeService({ client });
    client.fetchExpirations.mockResolvedValue({ ok: true, httpStatus: 200, value: [] });
    const r = await svc.scanOtm('NOPT');
    expect(r.reason).toBe('no_expirations');
    expect(svc.diagnostics().breakerOpen).toBe(false);
    expect(svc.diagnostics().upstreamRefusals?.byStatus).toEqual({});
  });

  it('counts hits, misses and LIVE capacity evictions — a thrashing cache is distinguishable from a full healthy one', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);
    const cap = svc.diagnostics().chainCacheMaxEntries;

    // Healthy: `cap` symbols, each read twice inside the TTL. Full, zero evictions.
    for (let i = 0; i < cap; i++) await svc.getSelectorChain(`S${i}`);
    for (let i = 0; i < cap; i++) await svc.getSelectorChain(`S${i}`);
    let d = svc.diagnostics();
    expect(d.cacheSize).toBe(cap);
    expect(d.chainCache).toEqual({ hits: cap, misses: cap, capacityEvictions: 0 });

    // Thrash: one more than the cap, round-robin. Every read evicts the entry
    // the NEXT read wants — hits stay flat, live evictions climb.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i <= cap; i++) await svc.getSelectorChain(`T${i}`);
    }
    d = svc.diagnostics();
    expect(d.cacheSize).toBe(cap); // reads identically to the healthy case…
    expect(d.chainCache!.hits).toBe(cap); // …but not one extra hit
    expect(d.chainCache!.capacityEvictions).toBeGreaterThan(cap);

    // TTL expiry is not a capacity eviction.
    const before = svc.diagnostics().chainCache!.capacityEvictions;
    advance(61_000);
    await svc.getSelectorChain('FRESH');
    expect(svc.diagnostics().chainCache!.capacityEvictions).toBe(before);
    expect(svc.diagnostics().cacheSize).toBe(1);
  });
});
