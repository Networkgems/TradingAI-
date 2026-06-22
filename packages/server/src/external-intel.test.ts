// TRA-999 — external-intel connector + extraction → hypothesis-queue tests.
//
// Fully deterministic: a stubbed source feed + a stubbed LLM extractor, no live
// network / no live LLM. Pins the contract: normalized items ingest (dedup by
// (sourceKey,itemId)), guardrails REJECT (never clamp) out-of-allow-list / out-
// of-bound candidates, survivors enqueue as source:'external' through
// runHypothesis, the attribution log is written, and the same item+promptVersion
// is idempotent across cycles.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { BacktestGateMetrics } from '@trading-app/shared';
import {
  setHypothesisQueueFileForTests,
  listPromotionItems,
  hypothesisId,
  type BacktestExecutor,
  type ConfigSnapshot,
} from './hypothesis-pipeline.js';
import {
  runExternalIntelCycle,
  validateCandidate,
  normalizeTickers,
  isIngested,
  listAttributionFor,
  listAllAttribution,
  setExternalIntelIngestFileForTests,
  setExternalIntelAttributionFileForTests,
  DEFAULT_TUNABLE_PARAMS,
  INTEL_PROMPT_VERSION,
  type ExternalIntelDeps,
  type IntelHypothesisCandidate,
  type IntelSource,
  type RawIntelItem,
} from './external-intel.js';

// Base config carries the allow-listed leaves so applyHypothesis resolves them.
function baseConfig(): ConfigSnapshot {
  return {
    RV_CRYPTO_MAJORS: {
      riskPerTradePct: 0.0075,
      bbPeriod: 20,
      bbMultiplier: 2,
      rsiOversold: 25,
      rsiOverbought: 75,
      atrStopMultiplier: 1.5,
    },
  };
}

const PASS_METRICS: BacktestGateMetrics = {
  sharpe: 1.4,
  expectancy: 0.22,
  profitFactor: 1.6,
  maxDrawdown: 0.12,
  tradeCount: 180,
};

function fixedExecutor(m: BacktestGateMetrics = PASS_METRICS): BacktestExecutor {
  return async () => m;
}

function item(over: Partial<RawIntelItem> = {}): RawIntelItem {
  return {
    sourceKey: 'reddit:r/options',
    itemId: 'abc123',
    url: 'https://www.reddit.com/r/options/abc123',
    author: 'u/quant',
    capturedAt: 1_700_000_000_000,
    title: 'RSI 25 too tight on majors',
    text: 'I think the oversold gate should be looser.',
    tickers: ['BTC'],
    ...over,
  };
}

/** A source that returns a fixed batch and counts its fetches. */
function stubSource(sourceKey: string, batches: RawIntelItem[][]): IntelSource & { fetches: number } {
  let i = 0;
  return {
    sourceKey,
    fetches: 0,
    async fetch() {
      this.fetches += 1;
      return batches[Math.min(i++, batches.length - 1)] ?? [];
    },
  };
}

/** Extractor that maps each item to a fixed candidate list keyed by itemId. */
function stubExtractor(byItemId: Record<string, IntelHypothesisCandidate[]>) {
  return async (it: RawIntelItem) => byItemId[it.itemId] ?? [];
}

const GOOD: IntelHypothesisCandidate = {
  targetPath: 'RV_CRYPTO_MAJORS.rsiOversold',
  op: 'set',
  value: 30,
  rationale: 'loosen oversold gate per r/options chatter',
};

function deps(over: Partial<ExternalIntelDeps> = {}): ExternalIntelDeps {
  return {
    sources: [stubSource('reddit:r/options', [[item()]])],
    extractor: stubExtractor({ abc123: [GOOD] }),
    pipeline: { baseConfig: baseConfig(), runBacktest: fixedExecutor() },
    ...over,
  };
}

let ingestFile: string;
let attrFile: string;
let queueFile: string;
let seq = 0;
beforeEach(() => {
  seq += 1;
  ingestFile = join(tmpdir(), `ei-ingest-${process.pid}-${seq}.jsonl`);
  attrFile = join(tmpdir(), `ei-attr-${process.pid}-${seq}.jsonl`);
  queueFile = join(tmpdir(), `ei-queue-${process.pid}-${seq}.jsonl`);
  setExternalIntelIngestFileForTests(ingestFile);
  setExternalIntelAttributionFileForTests(attrFile);
  setHypothesisQueueFileForTests(queueFile);
  process.env['ENABLE_EXTERNAL_INTEL'] = '1';
});
afterEach(async () => {
  delete process.env['ENABLE_EXTERNAL_INTEL'];
  setExternalIntelIngestFileForTests(null);
  setExternalIntelAttributionFileForTests(null);
  setHypothesisQueueFileForTests(null);
  for (const f of [ingestFile, attrFile, queueFile]) {
    if (existsSync(f)) await rm(f, { force: true });
  }
});

describe('kill switch', () => {
  it('no-ops when ENABLE_EXTERNAL_INTEL is unset', async () => {
    delete process.env['ENABLE_EXTERNAL_INTEL'];
    const res = await runExternalIntelCycle(deps(), 1_700_000_100_000);
    expect(res.enabled).toBe(false);
    expect(res.ingested).toBe(0);
    expect(existsSync(ingestFile)).toBe(false);
  });
});

describe('normalizeTickers', () => {
  it('upper-cases, strips $, drops blanks/invalid, dedupes', () => {
    expect(normalizeTickers(['$btc', 'ETH', ' eth ', '', null, 'toolongticker', 'A1'])).toEqual(['BTC', 'ETH']);
  });
});

describe('guardrails (validateCandidate)', () => {
  it('accepts an allow-listed, in-bound set', () => {
    const v = validateCandidate(GOOD);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.target).toEqual({ kind: 'gate', path: 'RV_CRYPTO_MAJORS.rsiOversold' });
      expect(v.proposedDelta).toEqual({ op: 'set', value: 30 });
    }
  });

  it('rejects a path off the allow-list', () => {
    const v = validateCandidate({ ...GOOD, targetPath: 'SECRET.liveCapital' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/allow-list/);
  });

  it('rejects an out-of-bound set instead of clamping', () => {
    const v = validateCandidate({ ...GOOD, value: 999 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/outside/);
  });

  it('rejects an over-magnitude add', () => {
    const v = validateCandidate({ targetPath: 'RV_CRYPTO_MAJORS.rsiOversold', op: 'add', value: 50, rationale: 'x' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/max/);
  });

  it('rejects a non-finite value and an empty rationale', () => {
    expect(validateCandidate({ ...GOOD, value: NaN }).ok).toBe(false);
    expect(validateCandidate({ ...GOOD, rationale: '   ' }).ok).toBe(false);
  });

  it('every default allow-list entry round-trips its own kind', () => {
    for (const p of DEFAULT_TUNABLE_PARAMS) {
      const mid = (p.set[0] + p.set[1]) / 2;
      const v = validateCandidate({ targetPath: p.path, op: 'set', value: mid, rationale: 'mid' });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.target.kind).toBe(p.kind);
    }
  });
});

describe('runExternalIntelCycle', () => {
  it('ingests, enqueues a source:external hypothesis, and writes attribution', async () => {
    const res = await runExternalIntelCycle(deps(), 1_700_000_100_000);
    expect(res.enabled).toBe(true);
    expect(res.fetched).toBe(1);
    expect(res.ingested).toBe(1);
    expect(res.candidates).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.enqueued).toHaveLength(1);
    expect(res.attributed).toBe(1);

    // The enqueued hypothesis carries source:'external'.
    const expectedId = hypothesisId({
      target: { kind: 'gate', path: 'RV_CRYPTO_MAJORS.rsiOversold' },
      proposedDelta: { op: 'set', value: 30 },
      source: 'external',
    });
    expect(res.enqueued[0]).toBe(expectedId);
    const items = await listPromotionItems();
    expect(items).toHaveLength(1);
    expect(items[0].hypothesis.source).toBe('external');
    expect(items[0].status).toBe('pending_ratification');

    // Attribution row ties the hypothesis back to the source/item.
    const attr = await listAttributionFor(expectedId);
    expect(attr).toHaveLength(1);
    expect(attr[0]).toMatchObject({
      sourceKey: 'reddit:r/options',
      itemId: 'abc123',
      url: 'https://www.reddit.com/r/options/abc123',
      promptVersion: INTEL_PROMPT_VERSION,
    });
    expect(await isIngested('reddit:r/options', 'abc123')).toBe(true);
  });

  it('rejects guardrail-violating candidates without enqueuing them', async () => {
    const bad: IntelHypothesisCandidate = { targetPath: 'NOPE.path', op: 'set', value: 1, rationale: 'x' };
    const res = await runExternalIntelCycle(
      deps({ extractor: stubExtractor({ abc123: [GOOD, bad] }) }),
      1_700_000_100_000,
    );
    expect(res.candidates).toBe(2);
    expect(res.rejected).toBe(1);
    expect(res.enqueued).toHaveLength(1);
    expect((await listPromotionItems())).toHaveLength(1);
  });

  it('is idempotent: same item across cycles enqueues once (dedup at ingest)', async () => {
    const src = stubSource('reddit:r/options', [[item()], [item()]]);
    const d = deps({ sources: [src] });
    const first = await runExternalIntelCycle(d, 1_700_000_100_000);
    const second = await runExternalIntelCycle(d, 1_700_000_200_000);

    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.enqueued).toHaveLength(0);
    expect(await listAllAttribution()).toHaveLength(1);
    expect((await listPromotionItems())).toHaveLength(1);
  });

  it('two different items proposing the SAME delta dedupe to one hypothesis, two attributions', async () => {
    const a = item({ itemId: 'a1', sourceKey: 'reddit:r/options' });
    const b = item({ itemId: 'b2', sourceKey: 'reddit:r/thetagang', url: 'https://www.reddit.com/r/thetagang/b2' });
    const res = await runExternalIntelCycle(
      deps({
        sources: [stubSource('reddit:r/options', [[a]]), stubSource('reddit:r/thetagang', [[b]])],
        extractor: stubExtractor({ a1: [GOOD], b2: [GOOD] }),
      }),
      1_700_000_100_000,
    );
    expect(res.ingested).toBe(2);
    expect(res.enqueued).toHaveLength(1); // one hypothesis id (provenance dropped)
    expect(res.attributed).toBe(2); // but both sources recorded
    expect((await listPromotionItems())).toHaveLength(1);
    const attr = await listAttributionFor(res.enqueued[0]);
    expect(attr.map(r => r.sourceKey).sort()).toEqual(['reddit:r/options', 'reddit:r/thetagang']);
  });

  it('a source that throws is skipped; other sources still process', async () => {
    const bad: IntelSource = { sourceKey: 'reddit:r/broken', async fetch() { throw new Error('429'); } };
    const res = await runExternalIntelCycle(
      deps({ sources: [bad, stubSource('reddit:r/options', [[item()]])] }),
      1_700_000_100_000,
    );
    expect(res.ingested).toBe(1);
    expect(res.enqueued).toHaveLength(1);
  });

  it('persists ingest + attribution to disk as JSONL', async () => {
    await runExternalIntelCycle(deps(), 1_700_000_100_000);
    const ingest = (await readFile(ingestFile, 'utf-8')).trim().split('\n');
    expect(ingest).toHaveLength(1);
    expect(JSON.parse(ingest[0])).toMatchObject({ kind: 'ingest', item: { itemId: 'abc123' } });
    const attr = (await readFile(attrFile, 'utf-8')).trim().split('\n');
    expect(attr).toHaveLength(1);
    expect(JSON.parse(attr[0])).toMatchObject({ kind: 'attribution', rec: { itemId: 'abc123' } });
  });
});
