import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { computeDirectionalLean } from '@trading-app/shared';
import type { NameLeanInput } from './news-catalyst-lean.js';
import {
  setNewsCatalystLeanLedgerFileForTests,
  initNewsCatalystLeanLedger,
  recordCatalystLean,
  listCatalystLeans,
  leanBreakdown,
} from './news-catalyst-lean-ledger.js';

// A mid-RTH ET timestamp for a given day offset (days from 2026-06-16).
function etTs(dayOffset: number): number {
  return Date.UTC(2026, 5, 16 + dayOffset, 18, 0); // 18:00Z ~ 14:00 ET
}

function input(partial: Partial<NameLeanInput> = {}): NameLeanInput {
  return {
    symbol: 'AAPL',
    sentimentTilt: 'bullish',
    pcrContrarian: 'bullish',
    oiQuadrant: 'strong',
    oiPriceDirection: 'up',
    trendState: 'up',
    ivRank: null,
    ...partial,
  };
}

function leanOf(i: NameLeanInput) {
  return computeDirectionalLean({
    sentimentTilt: i.sentimentTilt,
    pcrContrarian: i.pcrContrarian,
    oiQuadrant: i.oiQuadrant,
    oiPriceDirection: i.oiPriceDirection,
    trendState: i.trendState,
    ivRank: i.ivRank,
  });
}

const TMP = join(tmpdir(), `news-catalyst-lean-test-${process.pid}.jsonl`);

describe('news-catalyst-lean-ledger (TRA-1632 — persist the D2 lean per name-day)', () => {
  beforeEach(async () => {
    rmSync(TMP, { force: true });
    setNewsCatalystLeanLedgerFileForTests(TMP);
    await initNewsCatalystLeanLedger();
  });
  afterEach(() => {
    setNewsCatalystLeanLedgerFileForTests(null);
    rmSync(TMP, { force: true });
  });

  it('persists the resolved verdict + directional + drivers at capture time', async () => {
    const i = input();
    const res = await recordCatalystLean(i, leanOf(i), etTs(0));
    expect(res.written).toBe(true);
    expect(res.record?.lean).toBe('CALL');
    expect(res.record?.directional).toBeGreaterThan(0);
    // The point-in-time drivers (PCR/OI cannot be reconstructed later) are captured.
    expect(res.record?.drivers).toMatchObject({
      sentimentTilt: 'bullish',
      pcrContrarian: 'bullish',
      oiQuadrant: 'strong',
      oiPriceDirection: 'up',
      trendState: 'up',
      ivRank: null,
    });
    expect(res.record?.id).toBe('AAPL:2026-06-16');
  });

  it('dedupes to one row per symbol per ET session (first review wins)', async () => {
    const i = input();
    await recordCatalystLean(i, leanOf(i), etTs(0));
    // A later review that day with a flipped read must NOT overwrite the captured lean.
    const flipped = input({ sentimentTilt: 'bearish', pcrContrarian: 'bearish', oiQuadrant: 'weak' });
    const dup = await recordCatalystLean(flipped, leanOf(flipped), etTs(0) + 3_600_000);
    expect(dup.written).toBe(false);
    expect(dup.reason).toBe('duplicate');
    const rows = await listCatalystLeans();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lean).toBe('CALL'); // the first (bullish) capture, not the flip
  });

  it('accrues a fresh row per new session and rolls up the verdict breakdown', async () => {
    const bull = input({ symbol: 'AAPL' });
    const bear = input({
      symbol: 'MSFT',
      sentimentTilt: 'bearish',
      pcrContrarian: 'bearish',
      oiQuadrant: 'weak',
      oiPriceDirection: 'down',
      trendState: 'down',
    });
    const flat = input({
      symbol: 'NVDA',
      sentimentTilt: 'neutral',
      pcrContrarian: null,
      oiQuadrant: null,
      oiPriceDirection: null,
      trendState: 'unknown',
    });
    await recordCatalystLean(bull, leanOf(bull), etTs(0));
    await recordCatalystLean(bear, leanOf(bear), etTs(1));
    await recordCatalystLean(flat, leanOf(flat), etTs(2));
    const rows = await listCatalystLeans();
    expect(rows).toHaveLength(3);
    const bd = leanBreakdown(rows);
    expect(bd.CALL).toBe(1);
    expect(bd.PUT).toBe(1);
    expect(bd['NO-TRADE']).toBe(1);
  });

  it('reloads persisted rows from disk (survives a boot)', async () => {
    const i = input();
    await recordCatalystLean(i, leanOf(i), etTs(0));
    // Simulate a restart: drop the in-memory cache and re-init from the file.
    setNewsCatalystLeanLedgerFileForTests(TMP);
    await initNewsCatalystLeanLedger();
    const rows = await listCatalystLeans();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('AAPL:2026-06-16');
    expect(rows[0]!.lean).toBe('CALL');
  });
});
