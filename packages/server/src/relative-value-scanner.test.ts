import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TradierRelativeValueScannerService,
  REFUSAL_4XX_COOLDOWN_MS,
  canonicalizeRefusalReason,
  isQuotaViolationReason,
  parseQuotaExpiresMs,
  MAX_QUOTA_HOLD_MS,
} from './relative-value-scanner.js';
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
  // `reason` mirrors the real engine client's `{ ok: false; httpStatus; reason: string | null }`
  // (TRA-4865). Optional here so the pre-TRA-4865 shape — a refusal with no body
  // at all — stays expressible; that is a distinct case the suite asserts.
  fetchExpirations = vi.fn<(s: string) => Promise<
    { ok: true; httpStatus: number; value: string[] }
    | { ok: false; httpStatus: number; reason?: string | null }
  >>();
  fetchChainSnapshot = vi.fn<(s: string, e: string) => Promise<
    { ok: true; httpStatus: number; value: OptionChainRow[] }
    | { ok: false; httpStatus: number; reason?: string | null }
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
    // `lastReason` is `(not captured)` here, not a real cause: this fixture is
    // the pre-TRA-4865 client shape, which offers no body at all. An uncaptured
    // cause must never read as a measured one.
    expect(diag.upstreamRefusals).toEqual({
      byStatus: { '429': 1 },
      lastAtMs: NOW_BASE,
      lastStatus: 429,
      lastReason: '(not captured)',
    });
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
        reportedByEndpoint: { expirations: 1, chain: 0 },
        evicted: 0,
      },
      // TRA-4865 — this mock answers `ok:false` with no `reason` at all, which
      // is the pre-TRA-4865 client shape. It buckets as `(not captured)` and
      // must NEVER fold into a populated reason bucket: a refusal whose cause we
      // did not see is not evidence about any cause we did.
      byReason: { '400 (not captured)': 1 },
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
      reportedByEndpoint: { expirations: 2, chain: 1 },
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

  // TRA-4865 (third pass). Measured on live `66a8a1ab` 2026-09-25 16:35Z:
  // `sinceBoot.byEndpoint` read `{expirations: 445, chain: 307}` while the
  // `refusalsByKey` it shipped beside carried 300 chain rows and ZERO
  // expirations rows. The truncation was the head of ONE lexical sort across
  // both endpoints, and `chain|` sorts before `expirations|` — so the published
  // sample was partitioned on exactly the axis this issue was opened to decide
  // ("which endpoint dominates"), and answered "chain, unanimously" about a
  // population that is 59% expirations. A lexical head reads like a sample.
  it('the since-boot census cannot partition its sample by endpoint — the live 300-chain/0-expirations truncation', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    // 200 chain-refusing symbols and 200 expirations-refusing ones: 400 keys
    // against a 300 cap, so the truncation MUST bite, with both endpoints
    // over the 150 per-endpoint floor. Under the old lexical head this yields
    // 300 chain / 0 expirations.
    const badExp = new Set<string>();
    const badChain = new Set<string>();
    for (let i = 0; i < 200; i++) {
      badExp.add(`ZEXP${i}`); // sorts AFTER `chain|` under the old scheme
      badChain.add(`ACHN${i}`);
    }
    client.fetchExpirations.mockImplementation(async (s) =>
      badExp.has(s) ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      badChain.has(s) ? { ok: false, httpStatus: 400 } : okChain);

    for (const s of [...badChain, ...badExp]) {
      expect((await svc.scanOtm(s)).reason).toBe('fetch_error');
      advance(1_000);
    }

    const sb = svc.diagnostics().refusalCooldown!.sinceBoot!;
    // The full-population counts are unaffected by any reporting cap.
    expect(sb.distinctKeys).toBe(400);
    expect(sb.byEndpoint).toEqual({ expirations: 200, chain: 200 });
    expect(sb.keysTruncated).toBe(true);
    expect(sb.evicted).toBe(0);

    // The REPORTED sample is the assertion that matters: 300 keys, and both
    // endpoints present. This is the line that fails under a lexical head.
    const reported = Object.keys(sb.refusalsByKey);
    expect(reported.length).toBe(300);
    const reportedChain = reported.filter((k) => k.startsWith('chain|')).length;
    const reportedExp = reported.length - reportedChain;
    expect(reportedChain).toBe(150);
    expect(reportedExp).toBe(150);
    // …and `reportedByEndpoint` says so out loud, so a reader comparing it to
    // `byEndpoint` can see the sample is a sample and not the population.
    expect(sb.reportedByEndpoint).toEqual({ expirations: 150, chain: 150 });
  });

  it('the per-endpoint floor is a floor, not a quota — one endpoint spends the other unspent budget', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    // 310 expirations refusals and 2 chain refusals. The chain side cannot use
    // its 150, so the expirations side must report 298 — not be clamped to 150,
    // which would throw away 148 rows the cap had room for.
    const badExp = new Set<string>();
    for (let i = 0; i < 310; i++) badExp.add(`E${String(i).padStart(4, '0')}`);
    const badChain = new Set(['CH1', 'CH2']);
    client.fetchExpirations.mockImplementation(async (s) =>
      badExp.has(s) ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      badChain.has(s) ? { ok: false, httpStatus: 400 } : okChain);

    for (const s of [...badExp, ...badChain]) {
      expect((await svc.scanOtm(s)).reason).toBe('fetch_error');
      advance(1_000);
    }

    const sb = svc.diagnostics().refusalCooldown!.sinceBoot!;
    expect(sb.byEndpoint).toEqual({ expirations: 310, chain: 2 });
    expect(sb.reportedByEndpoint).toEqual({ expirations: 298, chain: 2 });
    expect(Object.keys(sb.refusalsByKey).length).toBe(300);
    expect(sb.keysTruncated).toBe(true);
  });

  it('the reported sample is ranked by REFUSAL COUNT, so the darkest keys survive truncation', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    // 400 expirations-refusing symbols; `E0399` is asked (and refused) twice,
    // every other key once. Under a lexical head `E0399` falls off the end.
    const badExp = new Set<string>();
    for (let i = 0; i < 400; i++) badExp.add(`E${String(i).padStart(4, '0')}`);
    client.fetchExpirations.mockImplementation(async (s) =>
      badExp.has(s) ? { ok: false, httpStatus: 400 } : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    for (const s of badExp) {
      expect((await svc.scanOtm(s)).reason).toBe('fetch_error');
      advance(1_000);
    }
    advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    expect((await svc.scanOtm('E0399')).reason).toBe('fetch_error');

    const sb = svc.diagnostics().refusalCooldown!.sinceBoot!;
    expect(sb.distinctKeys).toBe(400);
    expect(sb.refusals).toBe(401);
    // The twice-refused key is the one the census exists to surface.
    expect(sb.refusalsByKey['expirations|E0399']).toBe(2);
  });

  // TRA-4865 (third pass). `refuse()` only ever saw an HTTP status: the vendor's
  // fault body was dropped at `getJsonChecked`. So live `66a8a1ab` reported
  // 3,340 × "HTTP 400" with nothing anywhere in the stack able to separate a
  // throttle from an entitlement gap from a bad parameter.
  it('the refusal reason histogram carries the VENDOR body, and never folds an unseen cause into a seen one', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    client.fetchExpirations.mockImplementation(async (s) => {
      if (s === 'THROTTLED')
        return { ok: false, httpStatus: 400, reason: 'Rate limit exceeded for this endpoint' };
      if (s === 'NOTFOUND')
        return { ok: false, httpStatus: 400, reason: 'symbol not found' };
      if (s === 'SILENT') return { ok: false, httpStatus: 400, reason: null };
      if (s === 'LEGACY') return { ok: false, httpStatus: 400 }; // pre-TRA-4865 shape
      return okExp;
    });
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    for (const s of ['THROTTLED', 'NOTFOUND', 'SILENT', 'LEGACY', 'THROTTLED']) {
      expect((await svc.scanOtm(s)).reason).toBe('fetch_error');
      advance(REFUSAL_4XX_COOLDOWN_MS + 1);
    }

    const byReason = svc.diagnostics().refusalCooldown!.byReason!;
    expect(byReason).toEqual({
      '400 Rate limit exceeded for this endpoint': 2,
      '400 symbol not found': 1,
      // An empty body and an uncaptured body are DIFFERENT facts and must not
      // share a bucket — nor may either join a real reason.
      '400 (no body)': 1,
      '400 (not captured)': 1,
    });
    // The status is always part of the bucket, so a vendor that reuses the same
    // sentence under a different status splits rather than silently merges.
    expect(Object.keys(byReason).every((k) => k.startsWith('400 '))).toBe(true);
  });

  // TRA-4865 (fourth pass) — the live defect. On `faae9388` Tradier answered
  // `400 Quota Violation: Expires <epoch-ms>`, where the epoch is the quota's
  // next MINUTE boundary — so every refused minute minted a fresh bucket. 61 of
  // 65 buckets were the same reason at 61 different minutes, the 64-bucket
  // budget was gone 25h into an 89h boot, and 6,953 refusals (54% of the
  // population, and every refusal of the last two days) fell into `(other)`.
  it('a vendor reason stamped per-occurrence collapses to ONE bucket instead of exhausting the budget', async () => {
    const client = new CheckedFakeClient();
    const { svc, advance } = makeService({ client });
    // 80 symbols > MAX_REFUSAL_REASONS_TRACKED (64), each refused once under its
    // own quota-reset epoch — exactly the live shape.
    const syms = Array.from({ length: 80 }, (_, i) => `Q${String(i).padStart(3, '0')}`);
    let epoch = 1790602260000;
    client.fetchExpirations.mockImplementation(async (s) =>
      syms.includes(s)
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${(epoch += 60_000)}` }
        : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    for (const s of syms) {
      // TRA-5005 — `quota_held`, not `fetch_error`: this reason is now classified
      // as the account-level condition it always was. The 91s step is also
      // TRA-5005's doing — these 80 refusals are 80 UPSTREAM responses, and the
      // account-scoped gate now suppresses everything inside a hold, so reaching
      // upstream 80 times requires clearing the hold 80 times. That is the fix
      // working, and it is why this fixture had to say so explicitly: with the
      // old 1s step, symbols 2..80 never reach the vendor and `byReason` would
      // read 1, which would look like the canonicaliser regressing.
      expect((await svc.scanOtm(s)).reason).toBe('quota_held');
      advance(MAX_QUOTA_HOLD_MS + 1_000);
    }

    const diags = svc.diagnostics();
    const byReason = diags.refusalCooldown!.byReason!;
    // The whole population in one bucket: the reset epoch is not a taxonomy.
    expect(byReason).toEqual({ '400 Quota Violation: Expires <n>': 80 });
    // The budget was never spent, so nothing was lost to the overflow bucket.
    expect(byReason['400 (other)']).toBeUndefined();
    expect(Object.keys(byReason).length).toBe(1);
    // ...and the newest cause is still readable VERBATIM, with its real epoch,
    // datable against `lastAtMs`. This is the field that stayed two days stale.
    expect(diags.upstreamRefusals!.lastReason).toBe(`Quota Violation: Expires ${epoch}`);
    expect(diags.upstreamRefusals!.lastStatus).toBe(400);
  });

  it('canonicalising a reason keeps short numbers and the two unseen-cause sentinels byte-exact', async () => {
    // >=5 digits only: a status, a strike count or a short error code is
    // taxonomy and must survive, or distinct vendor faults would silently merge.
    expect(canonicalizeRefusalReason('504 Gateway Timeout')).toBe('504 Gateway Timeout');
    expect(canonicalizeRefusalReason('errorcode 1234 flow')).toBe('errorcode 1234 flow');
    expect(canonicalizeRefusalReason('Expires 1790602260000')).toBe('Expires <n>');
    expect(canonicalizeRefusalReason('req 9f3a12345 of acct 00012345')).toBe('req 9f3a<n> of acct <n>');
    // The sentinels are never passed through the canonicaliser at all (the
    // histogram test above asserts that); they carry no digits, so this pins
    // that a future caller change cannot corrupt them either.
    expect(canonicalizeRefusalReason('(not captured)')).toBe('(not captured)');
    expect(canonicalizeRefusalReason('(no body)')).toBe('(no body)');
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

// ── TRA-5005 ───────────────────────────────────────────────────────────────
//
// Tradier's 400 `Quota Violation` is an ACCOUNT-level per-minute rate limit, but
// `refuse()` routed every non-429 4xx to the PER-KEY 10-minute cooldown. So a
// global condition blacked out whichever (endpoint, symbol, date) happened to be
// in flight when the account's minute ran out — wrong subject, wrong duration
// (10 min vs the <60s the vendor's own `Expires` states), wrong class.
//
// Measured on live `faae9388`: 100% of classified 400s were `Quota Violation`
// (5,923 of 5,923), `suppressed` = 907,095 local re-throws = 55.6% of all
// 1,632,370 option cache misses, and `scan:fetch_error` was 20.8% of 13,900
// otm/desk/live evaluations on 2026-09-24.
//
// Corroborating evidence that the CLASS was the defect: the sibling quotes/bars
// path in `yahoo-feed.ts` already treats this exact body as vendor-wide —
// `shouldTripTradierBreaker` returns true on `/quota/i`. The options path was
// the outlier. It does NOT get the breaker here, though: the breaker opens the
// whole scanner, which would trade 55.6% silent misses for 100% darkness.
describe('a Quota Violation 400 is an ACCOUNT-level hold, not a per-key blackout (TRA-5005)', () => {
  const okExp = { ok: true as const, httpStatus: 200, value: [EXP] };
  const okChain = { ok: true as const, httpStatus: 200, value: [row(100, 'call', 0.3)] };

  /** A service plus a clock the fixture can read, so `Expires` can be dated relative to now. */
  function makeQuotaService(client: CheckedFakeClient) {
    const { svc, advance } = makeService({ client });
    let t = NOW_BASE;
    return {
      svc,
      now: () => t,
      step: (ms: number) => { t += ms; advance(ms); },
    };
  }

  it('parses the vendor own reset epoch, and answers UNKNOWN rather than guessing', () => {
    expect(isQuotaViolationReason('Quota Violation: Expires 1790602260000')).toBe(true);
    expect(isQuotaViolationReason('quota   violation')).toBe(true); // vendor casing/spacing is not ours
    expect(isQuotaViolationReason('Invalid parameter, ^TNX: symbol not found.')).toBe(false);
    expect(isQuotaViolationReason(null)).toBe(false);
    expect(isQuotaViolationReason(undefined)).toBe(false);

    // epoch-MILLIS, the measured shape.
    expect(parseQuotaExpiresMs('Quota Violation: Expires 1790602260000')).toBe(1790602260000);
    expect(parseQuotaExpiresMs('Quota Violation: Expires: 1790602260000')).toBe(1790602260000);
    // epoch-SECONDS is scaled, not read as a 1970 instant. Mistaking 10 digits
    // for millis puts `Expires` 56 years in the past, the hold releases
    // immediately, and the hammering this fixes comes back SILENTLY.
    expect(parseQuotaExpiresMs('Quota Violation: Expires 1790602260')).toBe(1790602260000);
    // No readable datum ⇒ `null` (UNKNOWN), never 0. A 0 reads as "already
    // expired", which is the same silent no-hold failure (TRA-3802).
    expect(parseQuotaExpiresMs('Quota Violation')).toBeNull();
    expect(parseQuotaExpiresMs('Quota Violation: Expires soon')).toBeNull();
    expect(parseQuotaExpiresMs('Quota Violation: Expires 0')).toBeNull();
    expect(parseQuotaExpiresMs(null)).toBeNull();
  });

  // AC1 — one global gate, released at its own `Expires`, and NO key marked dark.
  it('holds ONE global gate until its own Expires and marks no individual key dark', async () => {
    const client = new CheckedFakeClient();
    const { svc, now, step } = makeQuotaService(client);
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${now() + 30_000}` }
        : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);
    const callsFor = (s: string) => client.fetchExpirations.mock.calls.filter(([x]) => x === s).length;

    const first = await svc.scanOtm('AAPL');
    // The reason is the CAUSE now, not a flattened `fetch_error` (AC3's mechanism:
    // `signal-engine.ts` keys the census `scan:${reason}`, so this string IS the
    // census bucket — `scan:quota_held` instead of `scan:fetch_error`).
    expect(first.reason).toBe('quota_held');

    let d = svc.diagnostics();
    // The gate: ONE instant, the vendor's own, not `now + REFUSAL_4XX_COOLDOWN_MS`.
    expect(d.quotaHold!.blockedUntilMs).toBe(NOW_BASE + 30_000);
    expect(d.quotaHold!.heldMsRemaining).toBe(30_000);
    expect(d.quotaHold!.expiresHonoured).toBe(1);
    expect(d.quotaHold!.holdsArmed).toBe(1);
    expect(d.quotaHold!.upstreamRefusals).toBe(1);
    expect(d.quotaHold!.suppressed).toBe(0); // an upstream refusal is not a suppression
    // ...and NOTHING is per-key dark. This is the defect, inverted: `AAPL` was the
    // key in flight when the ACCOUNT ran out of minute, and it takes no blackout.
    expect(d.refusalCooldown!.cooling).toBe(0);
    expect(d.refusalCooldown!.keys).toEqual([]);
    expect(d.refusalCooldown!.sinceBoot!.distinctKeys).toBe(0);
    expect(d.refusalCooldown!.suppressed).toBe(0);

    // One gate, not N: an innocent symbol is held too, with zero upstream calls.
    // (That is the honest cost of a global condition — and it is why the hold has
    // to be SHORT and vendor-dated rather than a 10-minute per-key cooldown.)
    const spy = await svc.scanOtm('SPY');
    expect(spy.reason).toBe('quota_held');
    expect(spy.errorMessage).toMatch(/account quota hold until/);
    expect(callsFor('SPY')).toBe(0);
    d = svc.diagnostics();
    expect(d.quotaHold!.suppressed).toBe(1);
    expect(d.quotaHold!.suppressedByEndpoint).toEqual({ expirations: 1, chain: 0 });
    // The suppression is booked to the quota gate, never to the per-key counter.
    expect(d.refusalCooldown!.suppressed).toBe(0);
    // A suppressed call is OURS, so it is not an upstream response.
    expect(d.upstreamRefusals!.byStatus).toEqual({ '400': 1 });

    // Still held one ms before `Expires`...
    step(29_999);
    expect((await svc.scanOtm('SPY')).reason).toBe('quota_held');
    expect(svc.diagnostics().quotaHold!.suppressed).toBe(2);

    // ...and open one ms after it. Released at the VENDOR's instant.
    step(2);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
    d = svc.diagnostics();
    expect(d.quotaHold!.blockedUntilMs).toBeNull();
    expect(d.quotaHold!.heldMsRemaining).toBeNull();
    expect(d.quotaHold!.holdsReleased).toBe(1);

    // And the proof `AAPL` was never marked dark: it is re-asked UPSTREAM the
    // very next cycle. Under the old routing it would have been silent for 10
    // minutes over a condition that had nothing to do with it.
    expect(callsFor('AAPL')).toBe(1);
    expect((await svc.scanOtm('AAPL')).reason).toBe('quota_held');
    expect(callsFor('AAPL')).toBe(2);
  });

  // AC2 — the control. These two cases differ in ONE respect: the vendor's reason
  // string. Everything else — status, endpoint, symbol, clock — is identical.
  // Mutating the discriminator moves the refusal between the two mechanisms, so
  // either assertion block goes red if the fork is removed.
  it('a genuinely per-key 4xx still gets the per-key cooldown — the reason string is the whole discriminator', async () => {
    const perKey = new CheckedFakeClient();
    const a = makeQuotaService(perKey);
    perKey.fetchExpirations.mockImplementation(async (s) =>
      s === 'BADSYM'
        ? { ok: false, httpStatus: 400, reason: 'Invalid parameter, BADSYM: symbol not found.' }
        : okExp);
    perKey.fetchChainSnapshot.mockResolvedValue(okChain);

    expect((await a.svc.scanOtm('BADSYM')).reason).toBe('fetch_error');
    let d = a.svc.diagnostics();
    // PER-KEY: the key is cooled, the census names it, the gate never arms.
    expect(d.refusalCooldown!.cooling).toBe(1);
    expect(d.refusalCooldown!.keys).toEqual(['expirations|BADSYM']);
    expect(d.refusalCooldown!.sinceBoot!.distinctKeys).toBe(1);
    expect(d.quotaHold!.upstreamRefusals).toBe(0);
    expect(d.quotaHold!.blockedUntilMs).toBeNull();
    expect(d.quotaHold!.holdsArmed).toBe(0);
    // ...and a per-key cooldown is exactly that: every other symbol is fine.
    expect((await a.svc.scanOtm('SPY')).reason).toBe('ok');
    // The per-key cooldown is still 10 minutes — this population is the one the
    // TRA-4664 premise was RIGHT about, and TRA-5005 does not touch it.
    a.step(REFUSAL_4XX_COOLDOWN_MS - 1_000);
    expect((await a.svc.scanOtm('BADSYM')).reason).toBe('fetch_error');
    expect(a.svc.diagnostics().refusalCooldown!.suppressed).toBe(1);

    // Now mutate ONLY the reason string.
    const quota = new CheckedFakeClient();
    const b = makeQuotaService(quota);
    quota.fetchExpirations.mockImplementation(async (s) =>
      s === 'BADSYM'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${b.now() + 30_000}` }
        : okExp);
    quota.fetchChainSnapshot.mockResolvedValue(okChain);

    expect((await b.svc.scanOtm('BADSYM')).reason).toBe('quota_held');
    d = b.svc.diagnostics();
    // ACCOUNT-SCOPED: nothing per-key, one global gate, and the innocent symbol
    // is held too — the exact inversion of the block above.
    expect(d.refusalCooldown!.cooling).toBe(0);
    expect(d.refusalCooldown!.keys).toEqual([]);
    expect(d.refusalCooldown!.sinceBoot!.distinctKeys).toBe(0);
    expect(d.quotaHold!.upstreamRefusals).toBe(1);
    expect(d.quotaHold!.holdsArmed).toBe(1);
    expect((await b.svc.scanOtm('SPY')).reason).toBe('quota_held');
  });

  // Defect #2 — wrong duration. We held keys dark ~10x longer than the vendor
  // asked, while holding the datum that said so.
  it('releases at Expires, which is far sooner than the cooldown it replaced', async () => {
    const client = new CheckedFakeClient();
    const { svc, now, step } = makeQuotaService(client);
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${now() + 30_000}` }
        : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    await svc.scanOtm('AAPL');
    const hold = svc.diagnostics().quotaHold!.heldMsRemaining!;
    expect(hold).toBe(30_000);
    // The number that matters: the vendor's minute, not our ten.
    expect(hold).toBeLessThan(REFUSAL_4XX_COOLDOWN_MS / 10);

    // 60s later — a full minute, still four-fifths short of the old cooldown —
    // the scanner is fully live again.
    step(60_000);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
    expect(svc.diagnostics().quotaHold!.longestHoldMs).toBe(30_000);
  });

  // An unreadable/implausible `Expires` must fail SHORT and say so. Over-holding
  // is the defect being fixed, so the fallback is the vendor's own bucket width.
  it('an unreadable, stale or absurd Expires falls back to the minute boundary and is counted separately', async () => {
    // (a) no `Expires` at all.
    const noExp = new CheckedFakeClient();
    const a = makeQuotaService(noExp);
    noExp.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL' ? { ok: false, httpStatus: 400, reason: 'Quota Violation' } : okExp);
    noExp.fetchChainSnapshot.mockResolvedValue(okChain);
    expect((await a.svc.scanOtm('AAPL')).reason).toBe('quota_held');
    let q = a.svc.diagnostics().quotaHold!;
    expect(q.expiresUnreadable).toBe(1);
    expect(q.expiresHonoured).toBe(0);
    // UNKNOWN stays `null`. A `0` here would be a fabricated 1970 epoch, and a
    // reader cannot tell a fabricated datum from a measured one.
    expect(q.lastExpiresAtMs).toBeNull();
    // Next minute boundary: NOW_BASE is 15:00:00.000Z exactly, so +60s.
    expect(q.blockedUntilMs).toBe(NOW_BASE + 60_000);
    expect(q.heldMsRemaining!).toBeGreaterThan(0);
    expect(q.heldMsRemaining!).toBeLessThanOrEqual(60_000);

    // (b) `Expires` three days out — a clamp, disclosed, never a three-day blackout.
    const far = new CheckedFakeClient();
    const b = makeQuotaService(far);
    far.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${NOW_BASE + 3 * 86_400_000}` }
        : okExp);
    far.fetchChainSnapshot.mockResolvedValue(okChain);
    await b.svc.scanOtm('AAPL');
    q = b.svc.diagnostics().quotaHold!;
    expect(q.expiresClamped).toBe(1);
    expect(q.heldMsRemaining).toBe(MAX_QUOTA_HOLD_MS);
    expect(q.maxHoldMs).toBe(MAX_QUOTA_HOLD_MS); // the clamp is published, not implied
    // The vendor's datum is still reported verbatim beside the clamped hold, so a
    // reader can see WHICH of the two the hold came from.
    expect(q.lastExpiresAtMs).toBe(NOW_BASE + 3 * 86_400_000);

    // (c) `Expires` already past (clock skew / a stale body). Must still hold —
    // a zero-length hold is the hammer loop, 1,079,861 requests in 4.9h.
    const past = new CheckedFakeClient();
    const c = makeQuotaService(past);
    past.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${NOW_BASE - 5_000}` }
        : okExp);
    past.fetchChainSnapshot.mockResolvedValue(okChain);
    await c.svc.scanOtm('AAPL');
    q = c.svc.diagnostics().quotaHold!;
    expect(q.expiresStale).toBe(1);
    expect(q.heldMsRemaining!).toBeGreaterThan(0);
    expect((await c.svc.scanOtm('SPY')).reason).toBe('quota_held');
  });

  // A SECOND quota refusal can only reach us from a call that was already in
  // flight when the gate armed — once it is held, nothing new gets out. (That
  // asymmetry is itself worth pinning: it is why `holdsExtended` is rare and why
  // a serial fixture cannot produce one.) The scanner is async and the sleeves
  // scan concurrently, so this is a real arrival, not a contrived one.
  it('a concurrent refusal extends a held gate by a later Expires and never shortens it', async () => {
    const defer = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

    /**
     * Park both scans INSIDE their upstream call — i.e. both past the gate check,
     * which was open for both — then land their refusals in a chosen order.
     * Returns the gate after both have landed.
     */
    async function raceTwoRefusals(firstMs: number, secondMs: number) {
      const client = new CheckedFakeClient();
      const { svc } = makeQuotaService(client);
      const a = defer();
      const b = defer();
      client.fetchExpirations.mockImplementation(async (s) => {
        if (s === 'AAA') { await a.promise; return { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${NOW_BASE + firstMs}` }; }
        if (s === 'BBB') { await b.promise; return { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${NOW_BASE + secondMs}` }; }
        return okExp;
      });
      client.fetchChainSnapshot.mockResolvedValue(okChain);

      const both = Promise.all([svc.scanOtm('AAA'), svc.scanOtm('BBB')]);
      await tick(); // both now parked in the mock, both having seen an OPEN gate
      a.resolve();
      await tick();
      b.resolve();
      const results = await both;
      expect(results.map((r) => r.reason)).toEqual(['quota_held', 'quota_held']);
      return svc.diagnostics().quotaHold!;
    }

    // A FARTHER instant arrives second: the gate moves out, booked as an extension.
    let q = await raceTwoRefusals(40_000, 70_000);
    expect(q.blockedUntilMs).toBe(NOW_BASE + 70_000);
    expect(q.upstreamRefusals).toBe(2);
    expect(q.holdsArmed).toBe(1);    // an extension is not a second arm
    expect(q.holdsExtended).toBe(1);
    expect(q.longestHoldMs).toBe(70_000);

    // A NEARER instant arrives second (a stale body overtaking a fresh one). The
    // gate must NOT move in: releasing early re-opens the hammer loop this fixes.
    q = await raceTwoRefusals(70_000, 20_000);
    expect(q.blockedUntilMs).toBe(NOW_BASE + 70_000);
    expect(q.upstreamRefusals).toBe(2);
    expect(q.holdsArmed).toBe(1);
    expect(q.holdsExtended).toBe(0);
    expect(q.longestHoldMs).toBe(70_000);
  });

  // The explicit instruction on the filing: do NOT route this to the breaker.
  it('does NOT open the breaker — a sub-minute quota reset must not black out the whole scanner', async () => {
    const client = new CheckedFakeClient();
    const { svc, now, step } = makeQuotaService(client);
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${now() + 30_000}` }
        : okExp);
    client.fetchChainSnapshot.mockResolvedValue(okChain);

    await svc.scanOtm('AAPL');
    expect(svc.diagnostics().breakerOpen).toBe(false);
    // Had this tripped the breaker, recovery would be on the breaker's clock
    // (90s / 5min) and `breaker_open` would be the reason — 100% darkness in
    // place of 55.6% silent misses. It recovers on the vendor's clock instead.
    step(30_001);
    expect(svc.diagnostics().breakerOpen).toBe(false);
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
  });

  it('a warm cache still serves while the gate is held — the gate stops NEW calls, it does not invalidate data', async () => {
    const client = new CheckedFakeClient();
    const { svc, now } = makeQuotaService(client);
    client.fetchExpirations.mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${now() + 30_000}` }
        : okChain);

    // Warm SPY's chain first.
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
    const warmCalls = client.fetchChainSnapshot.mock.calls.length;

    // Arm the gate on AAPL's chain fetch.
    expect((await svc.scanOtm('AAPL')).reason).toBe('quota_held');
    expect(svc.diagnostics().quotaHold!.suppressedByEndpoint.chain).toBe(0); // upstream, not suppressed

    // SPY still answers `ok` off the warm chain, inside the hold, with no new call.
    expect((await svc.scanOtm('SPY')).reason).toBe('ok');
    expect(client.fetchChainSnapshot.mock.calls.length).toBe(warmCalls + 1); // +1 = AAPL's refusal only
  });

  it('every suppressed call is attributable: the endpoint split sums to the total (TRA-3800)', async () => {
    const client = new CheckedFakeClient();
    const { svc, now } = makeQuotaService(client);
    client.fetchExpirations.mockResolvedValue(okExp);
    client.fetchChainSnapshot.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${now() + 30_000}` }
        : okChain);

    await svc.scanOtm('AAPL'); // upstream chain refusal arms the gate
    await svc.scanOtm('SPY');  // SPY expirations are cold ⇒ suppressed at `expirations`
    await svc.scanOtm('COLD'); // likewise
    const q = svc.diagnostics().quotaHold!;
    expect(q.suppressed).toBe(q.suppressedByEndpoint.expirations + q.suppressedByEndpoint.chain);
    expect(q.suppressed).toBe(2);
    expect(q.suppressedByEndpoint).toEqual({ expirations: 2, chain: 0 });
    // The arming refusal is in `upstreamRefusals`, the suppressions are not —
    // the two sides of the wire never share a counter.
    expect(q.upstreamRefusals).toBe(1);
    // And the fate of every refusal is accounted for exactly once.
    expect(q.expiresHonoured + q.expiresUnreadable + q.expiresStale + q.expiresClamped)
      .toBe(q.upstreamRefusals);
  });
});

// TRA-5006 — the expirations cache was pinned 256/256 on live `faae9388` with
// 282,047 capacity evictions in 89.1h (52.7/min), driving 135.6 real upstream
// attempts/min into a ~120/min vendor quota. Two things were wrong and only one
// of them was the number: `capacityEvictions` can say the cap is too SMALL but
// never what size would be big enough, and `size == max` reads IDENTICALLY on a
// cache whose working set fits exactly and one that is thrashing. These tests
// pin the demand instrument that answers the sizing question, and the raised cap
// whose first live read has to confirm it.
describe('cache demand is measured, not argued (TRA-5006)', () => {
  const okExp = { ok: true as const, httpStatus: 200, value: [EXP] };
  const okChain = { ok: true as const, httpStatus: 200, value: [row(100, 'call', 0.3)] };

  it('liveDemandPeak is the smallest cap that would have produced zero live evictions', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

    // 300 distinct symbols inside one chain TTL. The chain cap is 256, so the
    // chain cache MUST evict live — and its demand must report the 300 that
    // would have held. This is the discriminator: `cacheSize` saturates at 256
    // and tells you nothing about 300.
    for (let i = 0; i < 300; i++) await svc.getSelectorChain(`SYM${i}`);

    const diag = svc.diagnostics();
    const chain = diag.chainCacheDemand!;
    expect(chain.truncated).toBe(false);
    expect(chain.liveDemandPeak).toBe(300);
    expect(chain.maxEntries).toBe(diag.chainCacheMaxEntries);
    expect(chain.capBinds).toBe(true);
    // …and the cap genuinely bit, so both surfaces agree on the fact while only
    // one of them carries the size that would fix it.
    expect(diag.chainCache!.capacityEvictions).toBeGreaterThan(0);
    expect(diag.cacheSize).toBe(diag.chainCacheMaxEntries);

    // Same 300 keys through the expirations cache, whose raised cap holds them:
    // demand is identical, `capBinds` is false, and NO entry was evicted live.
    const exp = diag.expirationsCacheDemand!;
    expect(exp.liveDemandPeak).toBe(300);
    expect(exp.capBinds).toBe(false);
    expect(diag.expirationsCache!.capacityEvictions).toBe(0);
  });

  it('the raised expirations cap holds a keyspace the shipped 256 could not', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

    // 449 = the live `refusalCooldown.sinceBoot` census of distinct refused
    // `expirations|SYM` keys, which is a LOWER bound on the live keyspace. The
    // shipped cap was 256; dropping back below this re-arms the thrash.
    for (let i = 0; i < 449; i++) await svc.getSelectorChain(`SYM${i}`);

    const diag = svc.diagnostics();
    expect(diag.expirationsCacheMaxEntries).toBeGreaterThanOrEqual(449);
    expect(diag.expirationsCacheSize).toBe(449);
    expect(diag.expirationsCache!.capacityEvictions).toBe(0);
    expect(diag.expirationsCacheDemand!.capBinds).toBe(false);
  });

  it('demand is swept at the cache TTL, so it reports CONCURRENT keys and not a boot total', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

    await svc.getSelectorChain('AAA');
    await svc.getSelectorChain('BBB');
    expect(svc.diagnostics().chainCacheDemand!.liveDemand).toBe(2);

    // Past the 60s chain TTL, AAA/BBB are no longer concurrent with CCC: a cache
    // sized for this workload needs 1 slot, not 3. The since-boot distinct count
    // still says 3 — the two numbers answer different questions and the sizing
    // one is `liveDemandPeak`.
    advance(61_000);
    await svc.getSelectorChain('CCC');
    const chain = svc.diagnostics().chainCacheDemand!;
    expect(chain.liveDemand).toBe(1);
    expect(chain.liveDemandPeak).toBe(2);
    expect(chain.distinctKeys).toBe(3);

    // The expirations TTL is 6h, so nothing expired there: all three are still
    // concurrent on that cache. Same reads, different windows, different answers.
    expect(svc.diagnostics().expirationsCacheDemand!.liveDemand).toBe(3);
  });

  it('a key suppressed before the wire still counts as demand', async () => {
    const client = new CheckedFakeClient();
    const { svc } = makeService({ client });
    client.fetchChainSnapshot.mockResolvedValue(okChain);
    client.fetchExpirations.mockImplementation(async (s) =>
      s === 'AAPL'
        ? { ok: false, httpStatus: 400, reason: `Quota Violation: Expires ${NOW_BASE + 30_000}` }
        : okExp);

    await svc.scanOtm('AAPL'); // upstream quota refusal arms the account-level hold
    await svc.scanOtm('SPY');  // suppressed at `expirations`, no upstream call
    await svc.scanOtm('COLD'); // likewise

    const diag = svc.diagnostics();
    expect(diag.quotaHold!.suppressedByEndpoint.expirations).toBe(2);
    // All three symbols are part of the keyspace the cache has to cover. Scoping
    // demand to calls that reached the vendor would shrink the measurement by
    // exactly the population a quota storm creates — understating the cap in the
    // one regime where an undersized cap is what caused the storm.
    const exp = diag.expirationsCacheDemand!;
    expect(exp.liveDemand).toBe(3);
    expect(exp.distinctKeys).toBe(3);
  });

  it('reading the census does not change what the next read sees', async () => {
    const { svc, client, advance } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

    await svc.getSelectorChain('AAA');
    advance(61_000);
    // AAA is past the chain TTL. A census that SWEPT would drop it here and the
    // second read would differ — the TRA-4664 third-pass rule: a read that moves
    // the thing it measures is not an instrument.
    const first = svc.diagnostics().chainCacheDemand!;
    const second = svc.diagnostics().chainCacheDemand!;
    expect(first).toEqual(second);
    expect(first.liveDemand).toBe(0);
    expect(first.distinctKeys).toBe(1);
  });

  it('truncated is the discriminator: a clamped census never reads as a measurement', async () => {
    const { svc, client } = makeService();
    client.getExpirations.mockResolvedValue([EXP]);
    client.getChainSnapshot.mockResolvedValue([row(100, 'call', 0.3)]);

    // Push the expirations demand shadow past its OWN 8192 cap. Beyond it every
    // number on the row is a lower bound, so the flag is what a reader has to
    // check first — a clamp that does not say so is the bug this field retires.
    for (let i = 0; i < 8_300; i++) await svc.getSelectorChain(`SYM${i}`);

    const exp = svc.diagnostics().expirationsCacheDemand!;
    expect(exp.truncated).toBe(true);
    expect(exp.liveDemandPeak).toBe(8_192);
    expect(exp.distinctKeys).toBe(8_192);
    // The real demand was 8,300 > 2,048, so the cap DOES bind — and that is only
    // visible because the shadow is capped WELL ABOVE the cache. A shadow clamped
    // to the cache's own size could never report the one fact it exists for.
    expect(exp.capBinds).toBe(true);
  }, 20_000);
});
