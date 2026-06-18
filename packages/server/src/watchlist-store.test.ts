// TRA-950 (Part B) — the review-block → watchlist merge. The pure
// `mergeReviewLeaders` is tested directly (de-dup, cap, hidden, base-skip,
// stale-expiry); the disk-backed `seedReviewLeaders` round-trip is tested
// against an isolated temp DATA_DIR.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ReviewBlock } from '@trading-app/shared';

// watchlist-store reads DATA_DIR once at module load — set it before import.
type Store = typeof import('./watchlist-store.js');
let store: Store;

beforeAll(async () => {
  process.env['DATA_DIR'] = mkdtempSync(join(tmpdir(), 'watchlist-store-'));
  store = await import('./watchlist-store.js');
});

// WATCHLIST base contains NVDA/AAPL; PLTR/SOFI/BABA are NOT in the base list.
const BASE = ['AAPL', 'NVDA', 'MSFT'] as const;

describe('mergeReviewLeaders (pure)', () => {
  it('adds non-base leaders, tags them review-sourced, de-duped + uppercased', () => {
    const r = store.mergeReviewLeaders(
      { added: [], hidden: [], reviewSourced: [] },
      ['pltr', 'PLTR', 'sofi'],
      BASE,
    );
    expect(r.added).toEqual(['PLTR', 'SOFI']);
    expect(r.reviewSourced).toEqual(['PLTR', 'SOFI']);
  });

  it('skips base-list symbols (already in the watchlist) — not added, not tagged', () => {
    const r = store.mergeReviewLeaders(
      { added: [], hidden: [], reviewSourced: [] },
      ['NVDA', 'PLTR'],
      BASE,
    );
    expect(r.added).toEqual(['PLTR']);
    expect(r.reviewSourced).toEqual(['PLTR']);
  });

  it('respects hidden — a user-removed symbol is not resurrected', () => {
    const r = store.mergeReviewLeaders(
      { added: [], hidden: ['PLTR'], reviewSourced: [] },
      ['PLTR', 'SOFI'],
      BASE,
    );
    expect(r.added).toEqual(['SOFI']);
    expect(r.reviewSourced).toEqual(['SOFI']);
  });

  it('caps the number of review-sourced symbols', () => {
    const r = store.mergeReviewLeaders(
      { added: [], hidden: [], reviewSourced: [] },
      ['PLTR', 'SOFI', 'BABA'],
      BASE,
      2,
    );
    expect(r.reviewSourced).toHaveLength(2);
    expect(r.added).toEqual(['PLTR', 'SOFI']);
  });

  it('expires stale review leaders but keeps manual adds', () => {
    const r = store.mergeReviewLeaders(
      // SOFI + PLTR were review-sourced; BABA was a manual add (not tagged).
      { added: ['BABA', 'PLTR', 'SOFI'], hidden: [], reviewSourced: ['PLTR', 'SOFI'] },
      ['PLTR'], // latest review only features PLTR
      BASE,
    );
    expect(r.added).toContain('BABA'); // manual add survives
    expect(r.added).toContain('PLTR'); // still featured
    expect(r.added).not.toContain('SOFI'); // stale review leader expired
    expect(r.reviewSourced).toEqual(['PLTR']);
  });

  it('does not mutate its inputs', () => {
    const current = { added: ['BABA'], hidden: [], reviewSourced: [] };
    store.mergeReviewLeaders(current, ['PLTR'], BASE);
    expect(current.added).toEqual(['BABA']);
  });
});

describe('seedReviewLeaders (disk round-trip)', () => {
  const USER = 'tra950-user';

  function block(over: Partial<ReviewBlock> = {}): ReviewBlock {
    return {
      leaders: ['PLTR', 'SOFI'],
      invalidationLevels: { PLTR: 20.5 },
      gapRisk: false,
      regimeLabel: 'green',
      ...over,
    };
  }

  it('seeds leaders into the watchlist, tags provenance + invalidation, and surfaces them', async () => {
    await store.initWatchlistStore(USER);
    const { reviewSourced } = await store.seedReviewLeaders(USER, block());
    expect(reviewSourced).toEqual(['PLTR', 'SOFI']);

    const all = store.getStocksWatchlistData(USER).all;
    expect(all).toContain('PLTR');
    expect(all).toContain('SOFI');

    const meta = store.getReviewWatchlistMeta(USER);
    expect(meta.reviewSourced).toEqual(['PLTR', 'SOFI']);
    expect(meta.invalidationLevels).toEqual({ PLTR: 20.5 });
  });

  it('re-seeding a newer block expires the previous review leaders', async () => {
    await store.seedReviewLeaders(USER, block({ leaders: ['PLTR'], invalidationLevels: {} }));
    const all = store.getStocksWatchlistData(USER).all;
    expect(all).toContain('PLTR');
    expect(all).not.toContain('SOFI');
    expect(store.getReviewWatchlistMeta(USER).reviewSourced).toEqual(['PLTR']);
  });

  it('persists across a cache reload (cold boot reads the tag back)', async () => {
    store.clearWatchlistCache(USER);
    await store.initWatchlistStore(USER);
    expect(store.getReviewWatchlistMeta(USER).reviewSourced).toEqual(['PLTR']);
  });
});
