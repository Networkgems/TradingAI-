import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NewsItem } from '@trading-app/shared';
import {
  sessionCatalystPicks,
  resetCatalystSweepGateForTests,
  catalystSweepGateSnapshot,
  CATALYST_SWEEP_MAX_ATTEMPTS,
  CATALYST_SWEEP_RETRY_BACKOFF_MS,
  type CatalystMetrics,
} from './news-catalyst-source.js';
import {
  summarizeCatalystRuns,
  recordCatalystRun,
  setNewsCatalystRunLedgerFileForTests,
} from './news-catalyst-run-ledger.js';
import { setNewsCatalystLedgerFileForTests } from './news-catalyst-ledger.js';

// TRA-4682 (parent TRA-4680) — the premarket hook builds the smart watchlist
// once PER ACCOUNT, and each of those used to run a full 25-query news sweep:
// `runCount` 2521 over 43 sessions = 58.6 runs/session on bqb1. After the first
// sweep the Yahoo 429 breaker opened and every later sweep short-circuited to
// `fetch_degraded q=0/25` at 1.7s intervals, which is what flagged 34/43
// sessions degraded. These tests pin the gate that makes it one sweep.

let dir: string;
const FLAG = 'ENABLE_NEWS_CATALYST_WATCHLIST';
let priorFlag: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nc-gate-'));
  setNewsCatalystRunLedgerFileForTests(join(dir, 'runs.jsonl'));
  setNewsCatalystLedgerFileForTests(join(dir, 'signals.jsonl'));
  resetCatalystSweepGateForTests();
  priorFlag = process.env[FLAG];
  process.env[FLAG] = '1';
});

afterEach(() => {
  setNewsCatalystRunLedgerFileForTests(null);
  setNewsCatalystLedgerFileForTests(null);
  resetCatalystSweepGateForTests();
  if (priorFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = priorFlag;
  rmSync(dir, { recursive: true, force: true });
});

// 13:00Z on 2026-09-17 = 09:00 ET, the premarket hook's slot.
const NOW = Date.UTC(2026, 8, 17, 13, 0);
const HEALTHY: CatalystMetrics = { price: 100, avgDollarVol: 5_000_000, rvolZ: 2, gapPct: 4 };

const headline = (title: string): NewsItem => ({
  title,
  url: `https://example.invalid/${encodeURIComponent(title)}`,
  source: 'Wire',
  publishedAt: new Date(NOW - 20 * 60_000).toISOString(),
});

function makeDeps(opts: { healthy: boolean; at: number; hidden?: string[] }) {
  const calls = { news: 0 };
  return {
    calls,
    deps: {
      fetchNews: async () => {
        calls.news += 1;
        return opts.healthy
          ? {
              // Two bullish NVDA headlines — enough to clear the neutral-tilt
              // gate, so NVDA is actually CHOSEN and the hidden-list test bites.
              items: [
                headline('NVDA beats estimates, raises guidance; analysts upgrade to buy'),
                headline('NVDA shares rally to record high on strong growth'),
              ],
              queriesAttempted: 25,
              queriesSucceeded: 25,
            }
          : { items: [], queriesAttempted: 25, queriesSucceeded: 0 };
      },
      fetchMetrics: async () => HEALTHY,
      earningsInDays: () => null,
      now: opts.at,
      hidden: new Set(opts.hidden ?? []),
    },
  };
}

describe('sessionCatalystPicks — one vendor sweep per session (TRA-4682)', () => {
  it('59 accounts in one premarket loop = ONE sweep and ONE run row', async () => {
    let sweeps = 0;
    const results: string[][] = [];
    for (let i = 0; i < 59; i++) {
      const { deps, calls } = makeDeps({ healthy: true, at: NOW + i * 1_700 });
      results.push(await sessionCatalystPicks(deps));
      sweeps += calls.news;
    }
    expect(sweeps).toBe(1);
    const s = await summarizeCatalystRuns();
    expect(s.runCount).toBe(1);
    expect(s.runsBySession).toEqual([
      expect.objectContaining({ session: '2026-09-17', runs: 1, healthyRuns: 1, degradedRuns: 0 }),
    ]);
    // Every account still gets the session's picks.
    expect(results[0].length).toBeGreaterThan(0);
    for (const r of results) expect(r).toEqual(results[0]);
    expect(catalystSweepGateSnapshot()).toMatchObject({ attempts: 1, healthy: true, servedFromCache: 58 });
  });

  it("re-selects per account from the cached pool, honouring that account's hidden list", async () => {
    const first = await sessionCatalystPicks(makeDeps({ healthy: true, at: NOW }).deps);
    expect(first).toContain('NVDA');
    const second = makeDeps({ healthy: true, at: NOW + 2_000, hidden: ['NVDA'] });
    const picks = await sessionCatalystPicks(second.deps);
    expect(second.calls.news).toBe(0);
    expect(picks).not.toContain('NVDA');
  });

  it('a failed sweep is not retried inside the backoff window (the 1.7s storm)', async () => {
    let sweeps = 0;
    for (let i = 0; i < 20; i++) {
      const { deps, calls } = makeDeps({ healthy: false, at: NOW + i * 1_700 });
      expect(await sessionCatalystPicks(deps)).toEqual([]);
      sweeps += calls.news;
    }
    expect(sweeps).toBe(1);
    expect((await summarizeCatalystRuns()).runCount).toBe(1);
    expect(catalystSweepGateSnapshot()).toMatchObject({ attempts: 1, healthy: false, skipped: 19 });
  });

  it('retries after the backoff, and a success ends the session sweep', async () => {
    await sessionCatalystPicks(makeDeps({ healthy: false, at: NOW }).deps);
    const retry = makeDeps({ healthy: true, at: NOW + CATALYST_SWEEP_RETRY_BACKOFF_MS });
    expect((await sessionCatalystPicks(retry.deps)).length).toBeGreaterThan(0);
    expect(retry.calls.news).toBe(1);
    const after = makeDeps({ healthy: true, at: NOW + 2 * CATALYST_SWEEP_RETRY_BACKOFF_MS });
    await sessionCatalystPicks(after.deps);
    expect(after.calls.news).toBe(0);
    const s = await summarizeCatalystRuns();
    expect(s.runCount).toBe(2);
    // Still flagged by the any-run rule, but NOT a no-healthy-run session.
    expect(s.sessionsDegraded).toBe(1);
    expect(s.sessionsNoHealthyRun).toBe(0);
  });

  it(`caps a dead feed at ${CATALYST_SWEEP_MAX_ATTEMPTS} sweeps per session`, async () => {
    let sweeps = 0;
    for (let i = 0; i < 10; i++) {
      const { deps, calls } = makeDeps({ healthy: false, at: NOW + i * CATALYST_SWEEP_RETRY_BACKOFF_MS });
      await sessionCatalystPicks(deps);
      sweeps += calls.news;
    }
    expect(sweeps).toBe(CATALYST_SWEEP_MAX_ATTEMPTS);
    const s = await summarizeCatalystRuns();
    expect(s.sessionsNoHealthyRun).toBe(1);
    expect(s.noHealthyRunSessions).toEqual(['2026-09-17']);
  });

  it('a new ET session gets a fresh sweep', async () => {
    await sessionCatalystPicks(makeDeps({ healthy: true, at: NOW }).deps);
    const nextDay = makeDeps({ healthy: true, at: NOW + 24 * 3_600_000 });
    await sessionCatalystPicks(nextDay.deps);
    expect(nextDay.calls.news).toBe(1);
  });

  it('concurrent callers share one in-flight sweep', async () => {
    const a = makeDeps({ healthy: true, at: NOW });
    const b = makeDeps({ healthy: true, at: NOW });
    const [pa, pb] = await Promise.all([sessionCatalystPicks(a.deps), sessionCatalystPicks(b.deps)]);
    expect(a.calls.news + b.calls.news).toBe(1);
    expect(pb).toEqual(pa);
  });
});

// TRA-4901 — a midday sweep must not be masked by (or exhaust) the premarket
// window's cache/budget, and vice versa. Before this fix `sessionCatalystPicks`
// cached on the bare ET session, so a second call anywhere later in the day
// (any window) always served the 9am pool with ZERO vendor calls — "midday
// news" never actually re-hit the vendor.
describe('sessionCatalystPicks — per-window cache (TRA-4901)', () => {
  it("a midday call forces a FRESH sweep instead of reusing the premarket window's pool", async () => {
    const premarket = makeDeps({ healthy: true, at: NOW });
    await sessionCatalystPicks(premarket.deps, 'premarket');
    expect(premarket.calls.news).toBe(1);

    // Same ET session, ~3 hours later — the midday slot. Under the old bare
    // session key this would be `servedFromCache` with zero vendor calls.
    const midday = makeDeps({ healthy: true, at: NOW + 3 * 3_600_000 });
    const picks = await sessionCatalystPicks(midday.deps, 'midday');
    expect(midday.calls.news).toBe(1);
    expect(picks.length).toBeGreaterThan(0);
  });

  it('premarket and midday windows have independent attempt budgets', async () => {
    // Exhaust the premarket window's budget on a dead feed.
    for (let i = 0; i < CATALYST_SWEEP_MAX_ATTEMPTS; i++) {
      const { deps } = makeDeps({ healthy: false, at: NOW + i * CATALYST_SWEEP_RETRY_BACKOFF_MS });
      await sessionCatalystPicks(deps, 'premarket');
    }
    expect(catalystSweepGateSnapshot('premarket')).toMatchObject({ attempts: CATALYST_SWEEP_MAX_ATTEMPTS });

    // The midday window, on the SAME ET day, still gets its own first attempt.
    const midday = makeDeps({ healthy: true, at: NOW + 4 * 3_600_000 });
    const picks = await sessionCatalystPicks(midday.deps, 'midday');
    expect(midday.calls.news).toBe(1);
    expect(picks.length).toBeGreaterThan(0);
    expect(catalystSweepGateSnapshot('midday')).toMatchObject({ attempts: 1, healthy: true });
  });

  it("omitting the window argument defaults to 'premarket' (back-compat)", async () => {
    const { deps, calls } = makeDeps({ healthy: true, at: NOW });
    await sessionCatalystPicks(deps);
    expect(calls.news).toBe(1);
    expect(catalystSweepGateSnapshot('premarket')).toMatchObject({ attempts: 1, healthy: true });
    expect(catalystSweepGateSnapshot('midday')).toMatchObject({ attempts: 0, healthy: false });
  });
});

describe('row-basis degraded metric (TRA-4682)', () => {
  const run = (at: number, healthy: boolean) =>
    recordCatalystRun({
      at,
      outcome: healthy ? 'picks_built' : 'fetch_degraded',
      headlineCount: healthy ? 30 : null,
      candidateCount: healthy ? 20 : null,
      chosenCount: healthy ? 2 : null,
      queriesAttempted: 25,
      queriesSucceeded: healthy ? 25 : 0,
      quotesAttempted: healthy ? 20 : null,
      quotesOk: healthy ? 20 : null,
    });

  it('the 2026-09-17 shape: healthy first, storm after — degraded by any-run, NOT data loss', async () => {
    const t0 = Date.UTC(2026, 8, 17, 13, 0, 7);
    await run(t0, true);
    for (let i = 0; i < 20; i++) await run(t0 + 136_000 + i * 1_700, false);
    // A session with no healthy run at all.
    await run(Date.UTC(2026, 8, 9, 13, 0), false);

    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(2);
    expect(s.sessionsDegraded).toBe(2);
    expect(s.sessionsNoHealthyRun).toBe(1);
    expect(s.noHealthyRunSessions).toEqual(['2026-09-09']);
    expect(s.sessionsNoHealthyRun).toBeLessThanOrEqual(s.sessionsDegraded);
    const d17 = s.runsBySession.find((r) => r.session === '2026-09-17');
    expect(d17).toMatchObject({ runs: 21, healthyRuns: 1, degradedRuns: 20, firstHealthyAt: t0, firstAt: t0 });
    // Full-ledger counts, not the 20-row tail.
    expect(s.recentRuns.length).toBe(20);
    expect(s.runsBySession.reduce((n, r) => n + r.runs, 0)).toBe(s.runCount);
  });
});
