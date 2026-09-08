/**
 * TRA-4357 — the OTM sleeve rejected 100% of its universe on `scan:no_spot`
 * while the directional path, over the SAME names in the SAME cycle, reported
 * an ordinary-looking ledger. The filing read that as "one path prices these
 * names, the other cannot" and asked for the condition separating the two spot
 * sources.
 *
 * There is no such condition. Both paths resolve spot through ONE function —
 * `resolveSelectorChain` → the injected `fetchSpot` — and on the measured tape
 * NEITHER path priced anything. Two artifacts made it look asymmetric:
 *
 *   1. LABEL COLLAPSE. `getSelectorChain` returns a bare `null` for six
 *      distinct failures; the directional call site stamped all six `no_chain`.
 *      `scanOtm` keeps the discriminated reason and reports `scan:no_spot`.
 *      Same event, two names.
 *   2. GATE ORDER. The directional path's trend gates fire BEFORE the chain
 *      fetch, so most of its universe never reaches the spot call at all and
 *      the shared failure is only visible on the remainder.
 *
 * The starve itself is a quota amplification: `fetchSpot` demanded a quote no
 * older than 15s — TIGHTER than the quote cache's own TTL — once per symbol per
 * sweep across ~64 engines sharing the process, which trips the Tradier quota
 * breaker and takes every name dark.
 *
 * These tests fail on the pre-fix behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TradierRelativeValueScannerService,
  CHAIN_CACHE_TTL_MS,
} from './relative-value-scanner.js';
import { partitionCachedQuotes } from './yahoo-feed.js';
import { beginRvScan, UNATTRIBUTED_GATE } from './rv-scan-telemetry.js';
import { isBlindScan } from './rv-scan-census-ledger.js';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';

const NOW_BASE = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15';

function row(strike: number, optionType: 'call' | 'put'): OptionChainRow {
  const intrinsic = optionType === 'call' ? Math.max(0, 100 - strike) : Math.max(0, strike - 100);
  const mark = Math.max(0.5, intrinsic + 1);
  return {
    optionSymbol: `T${strike}${optionType[0]!.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: mark * 0.98,
    ask: mark * 1.02,
    last: mark,
    volume: 500,
    openInterest: 1000,
    midIv: 0.3,
  };
}

const CHAIN: OptionChainRow[] = [
  row(95, 'put'), row(100, 'call'), row(105, 'call'), row(110, 'call'),
];

function makeScanner(fetchSpot: (s: string) => Promise<number | null>) {
  const client = {
    getExpirations: vi.fn(async () => [EXP]),
    getChainSnapshot: vi.fn(async () => CHAIN),
  };
  const svc = new TradierRelativeValueScannerService({
    tradierApiToken: 'tok',
    tradierAccountId: 'acct',
    tradierEnv: 'production',
    fetchSpot,
    now: () => NOW_BASE,
    clientFactory: () => client as unknown as TradierOptionsClient,
  });
  return { svc, client };
}

describe('TRA-4357 AC1 — both paths share ONE spot source', () => {
  it('reports the SAME discriminated reason to the OTM and directional resolvers', async () => {
    // fetchSpot yields nothing — the measured bqb1 condition (both quote
    // breakers open on quota / 429).
    const { svc } = makeScanner(async () => null);

    const otm = await svc.scanOtm('TEST');
    const directional = await svc.getSelectorChainDetailed('TEST');

    expect(otm.reason).toBe('no_spot');
    // THE REGRESSION. Pre-fix the directional caller saw only `null` here and
    // stamped `no_chain`, manufacturing the asymmetry the ticket was filed on.
    expect(directional.reason).toBe('no_spot');
    expect(directional.reason).toBe(otm.reason);
    expect(directional.snapshot).toBeNull();
  });

  it('does not spend a chain fetch when spot is the thing that failed', async () => {
    const { svc, client } = makeScanner(async () => null);
    await svc.getSelectorChainDetailed('TEST');
    // `no_spot` is genuinely upstream of the chain — proving `no_chain` was
    // never an accurate label for it.
    expect(client.getChainSnapshot).not.toHaveBeenCalled();
  });

  it('reserves `no_chain` for a resolver that actually returned an empty chain', async () => {
    const client = {
      getExpirations: vi.fn(async () => [EXP]),
      getChainSnapshot: vi.fn(async () => [] as OptionChainRow[]),
    };
    const svc = new TradierRelativeValueScannerService({
      tradierApiToken: 'tok',
      tradierAccountId: 'acct',
      tradierEnv: 'production',
      fetchSpot: async () => 100,
      now: () => NOW_BASE,
      clientFactory: () => client as unknown as TradierOptionsClient,
    });
    expect((await svc.getSelectorChainDetailed('TEST')).reason).toBe('no_chain');
  });
});

describe('TRA-4357 AC2 — a universe the directional path can price is not rejected wholesale', () => {
  it('does not reject all N names on `scan:no_spot` when spot resolves', async () => {
    const universe = Array.from({ length: 25 }, (_, i) => `SYM${i}`);
    const { svc } = makeScanner(async () => 100);

    const reasons: string[] = [];
    for (const sym of universe) {
      // The directional path's own precondition: it resolves spot for this name.
      const directional = await svc.getSelectorChainDetailed(sym);
      expect(directional.snapshot?.spot).toBe(100);
      reasons.push((await svc.scanOtm(sym)).reason ?? 'ok');
    }

    const noSpot = reasons.filter((r) => r === 'no_spot').length;
    // The AC2 assertion, stated exactly as the ticket asks: N names the
    // directional path priced must not all fail the OTM path on no_spot.
    expect(noSpot).toBe(0);
    expect(noSpot).toBeLessThan(universe.length);
  });
});

describe('TRA-4357 AC2 root cause — the spot freshness bound must not be tighter than the chain it is compared against', () => {
  const quote = { price: 100, volume: 1, change: 0, changePct: 0 };

  it('serves a 30s-old cached quote WITHOUT an upstream call at the chain-cache bound', () => {
    const now = NOW_BASE;
    const cache = new Map([['AAPL', { quote, storedAt: now - 30_000 }]]);

    const { fresh, stale } = partitionCachedQuotes({
      symbols: ['AAPL'], cache, ttlMs: CHAIN_CACHE_TTL_MS, now,
    });

    expect(fresh.get('AAPL')?.price).toBe(100);
    expect(stale).toEqual([]);
  });

  it('FAILS THE SAME READ at the old hardcoded 15s bound — this is the amplification', () => {
    const now = NOW_BASE;
    const cache = new Map([['AAPL', { quote, storedAt: now - 30_000 }]]);

    const { fresh, stale } = partitionCachedQuotes({
      symbols: ['AAPL'], cache, ttlMs: 15_000, now,
    });

    // Every one of these misses re-fires the upstream batch, once per symbol
    // per sweep, across ~64 engines — which is what trips the quota breaker.
    expect(fresh.size).toBe(0);
    expect(stale).toEqual(['AAPL']);
  });

  it('pins the bound to the chain TTL so the two cannot drift apart again', () => {
    expect(CHAIN_CACHE_TTL_MS).toBe(60_000);
    // The scanner compares spot against a chain up to CHAIN_CACHE_TTL_MS old,
    // so a spot bound below that buys no accuracy it can use.
    expect(CHAIN_CACHE_TTL_MS).toBeGreaterThanOrEqual(20_000);
  });
});

describe('TRA-4357 AC2 wiring — the scanner spot fetch is bound to the named constant', () => {
  it('wires `fetchSpot` to CHAIN_CACHE_TTL_MS rather than a hardcoded literal', async () => {
    // A source-level guard, deliberately: the only alternative is booting
    // `index.ts` (which opens sockets and a broker client) to observe one
    // argument. The failure this pins is a WIRING regression — someone
    // re-hardcoding the bound — and that is visible in the source or nowhere.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    const call = /fetchQuotes\(\[symbol\],\s*\{\s*maxStaleMs:\s*([A-Za-z0-9_]+)\s*\}\)/.exec(src);
    expect(call, 'the scanner fetchSpot -> fetchQuotes call site moved').not.toBeNull();
    expect(call![1]).toBe('CHAIN_CACHE_TTL_MS');
  });
});

describe('TRA-4357 AC4 — the census can tell a BLIND cycle from a strategy decline', () => {
  const pass = (evaluated: number, passed: number, gates: Record<string, number>) => ({
    candidatesEvaluated: evaluated, candidatesPassed: passed, rejectionsByGate: gates,
  });

  it('counts a pass that lost its whole universe to ONE gate', () => {
    expect(isBlindScan(pass(531, 0, { 'scan:no_spot': 531 }))).toBe(true);
  });

  it('does NOT count a mixed ledger, however dominant the top gate', () => {
    // The 2026-09-04 343-name cycle: 54% one gate, but the strategy DID rule.
    expect(isBlindScan(pass(343, 0, {
      no_candidates: 76, 'scan:no_spot': 186, 'scan:no_expirations': 30,
      contract_floor_delta: 23, recent_duplicate: 19, 'scan:no_chain': 7,
      no_in_band_strike: 1, entry_window_closed: 1,
    }))).toBe(false);
  });

  it('is gate-agnostic — a saturating gate that is not `scan:no_spot` still counts', () => {
    // The whole point: this must catch the NEXT gate that saturates.
    expect(isBlindScan(pass(200, 0, { entry_window_closed: 200 }))).toBe(true);
  });

  it('does not count an EMPTY pass — that is `ran_unfed`, a different reading', () => {
    expect(isBlindScan(pass(0, 0, {}))).toBe(false);
  });

  it('does not count a pass where anything cleared', () => {
    expect(isBlindScan(pass(100, 1, { 'scan:no_spot': 99 }))).toBe(false);
  });

  it('separates two days that carry the SAME dominant gate — the AC4 requirement', () => {
    // Both days sum to `scan:no_spot` on top. Only `blindScans` tells them apart.
    const blindDay = [pass(100, 0, { 'scan:no_spot': 100 }), pass(100, 0, { 'scan:no_spot': 100 })];
    const decliningDay = [
      pass(100, 0, { 'scan:no_spot': 60, no_candidates: 25, contract_floor_delta: 15 }),
      pass(100, 0, { 'scan:no_spot': 60, no_candidates: 25, contract_floor_delta: 15 }),
    ];

    const topGate = (day: typeof blindDay) => {
      const summed: Record<string, number> = {};
      for (const p of day) for (const [g, n] of Object.entries(p.rejectionsByGate)) {
        summed[g] = (summed[g] ?? 0) + n;
      }
      return Object.entries(summed).sort((a, b) => b[1] - a[1])[0]![0];
    };

    // Indistinguishable on the pre-TRA-4357 payload...
    expect(topGate(blindDay)).toBe(topGate(decliningDay));
    // ...and separated by the new counter.
    expect(blindDay.filter(isBlindScan).length).toBe(2);
    expect(decliningDay.filter(isBlindScan).length).toBe(0);
  });
});

describe('TRA-4357 AC3 — the rejection ledger reconciles or names its residual', () => {
  it('reconciles exactly when every drop is tagged', () => {
    const run = beginRvScan('otm', 10, () => NOW_BASE);
    for (let i = 0; i < 10; i++) run.enterSymbol();
    for (let i = 0; i < 7; i++) run.reject('scan:no_spot');
    for (let i = 0; i < 3; i++) run.reject('no_candidates');
    const rec = run.finish();

    const summed = Object.values(rec.rejectionsByGate).reduce((a, b) => a + b, 0);
    expect(summed + rec.candidatesPassed).toBe(rec.candidatesEvaluated);
    expect(rec.bucketsBalance).toBe(true);
    expect(rec.rejectionsByGate[UNATTRIBUTED_GATE]).toBeUndefined();
  });

  it('emits the residual under an explicit `unattributed` key rather than losing it', () => {
    // The 2026-09-04 shape: 343 evaluated, 0 passed, gates summing to 276.
    const run = beginRvScan('otm', 343, () => NOW_BASE);
    for (let i = 0; i < 343; i++) run.enterSymbol();
    for (let i = 0; i < 276; i++) run.reject('scan:no_spot');
    const rec = run.finish();

    expect(rec.rejectionsByGate[UNATTRIBUTED_GATE]).toBe(67);
    const summed = Object.values(rec.rejectionsByGate).reduce((a, b) => a + b, 0);
    expect(summed + rec.candidatesPassed).toBe(rec.candidatesEvaluated);
  });
});
