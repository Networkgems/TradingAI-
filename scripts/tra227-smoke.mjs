// TRA-227 ad-hoc smoke. Exercises the boot-seed + merge logic against a fresh
// DATA_DIR so we have a verifiable artifact that the News tab gets a research
// card when the store is empty. Not part of the test suite — used as a one-shot
// liveness probe.
//
// Usage: node --import tsx/esm scripts/tra227-smoke.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tra227-smoke-'));
process.env['DATA_DIR'] = tmp;
delete process.env['SEED_SAMPLE_RESEARCH'];

const {
  seedSampleResearchReportIfEmpty,
  listResearchReports,
  __resetResearchStoreForTests,
} = await import('../packages/server/src/research-store.ts');

__resetResearchStoreForTests();

const seed = await seedSampleResearchReportIfEmpty();
const all = await listResearchReports();

const RESEARCH_PIN_WINDOW_MS = 24 * 60 * 60 * 1000;

function researchToNewsItem(r) {
  return {
    id: r.id,
    title: r.title,
    url: `/research/${r.id}`,
    source: r.source,
    publishedAt: r.publishedAt,
    kind: r.kind,
    bodyMarkdown: r.bodyMarkdown,
  };
}

function mergeResearchAndNews(yahoo, reports) {
  if (reports.length === 0) return yahoo;
  const now = Date.now();
  const pinned = [];
  const rest = [...yahoo];
  for (const r of reports) {
    const item = researchToNewsItem(r);
    const ts = Date.parse(r.publishedAt);
    if (Number.isFinite(ts) && now - ts <= RESEARCH_PIN_WINDOW_MS) pinned.push(item);
    else rest.push(item);
  }
  pinned.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  rest.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return [...pinned, ...rest];
}

const fakeYahoo = [
  {
    id: 'yahoo-1',
    title: 'Fed minutes: officials see gradual cut path',
    url: 'https://example.com/1',
    source: 'Yahoo Finance',
    publishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'yahoo-2',
    title: 'AMD MI400 ramp commentary lifts semis',
    url: 'https://example.com/2',
    source: 'Yahoo Finance',
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
];

const merged = mergeResearchAndNews(fakeYahoo, all);

console.log('=== TRA-227 SMOKE ===');
console.log('tmp DATA_DIR:', tmp);
console.log('seed:', seed && { id: seed.id, kind: seed.kind, source: seed.source, publishedAt: seed.publishedAt, titleStart: seed.title.slice(0, 40), tickers: seed.tickers });
console.log('store reports count:', all.length);
console.log('merged news count:', merged.length, '(yahoo=2 + research=1 expected = 3)');
console.log('merged[0] (should be Research, source=QuantTrader, kind=premarket):');
console.log(JSON.stringify({ id: merged[0].id, source: merged[0].source, kind: merged[0].kind, hasMarkdown: !!merged[0].bodyMarkdown, url: merged[0].url }, null, 2));
console.log('merged[1] source (should be Yahoo Finance):', merged[1].source);
console.log('merged[2] source (should be Yahoo Finance):', merged[2].source);

const ok =
  merged.length === 3 &&
  merged[0].source === 'QuantTrader' &&
  merged[0].kind === 'premarket' &&
  !!merged[0].bodyMarkdown &&
  merged[1].source === 'Yahoo Finance' &&
  merged[2].source === 'Yahoo Finance';

rmSync(tmp, { recursive: true, force: true });

if (!ok) {
  console.error('FAIL: merged shape does not match expectations');
  process.exit(1);
}
console.log('PASS — research card pinned to top of /api/news payload');
