import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveResearchReport,
  listResearchReports,
  getResearchReport,
  seedSampleResearchReportIfEmpty,
  ResearchValidationError,
  __resetResearchStoreForTests,
} from './research-store.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'research-store-test-'));
  __resetResearchStoreForTests(join(tmpRoot, 'research-reports.json'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetResearchStoreForTests(null);
});

describe('research-store', () => {
  it('saves a report with generated id and timestamp, then lists it', async () => {
    const saved = await saveResearchReport({
      kind: 'premarket',
      title: 'Pre-Market Review 2026-05-02',
      bodyMarkdown: '## Today\nWatch AMD.',
    });
    expect(saved.id).toMatch(/[0-9a-f-]{36}/);
    expect(saved.publishedAt).toBeTruthy();
    expect(saved.source).toBe('QuantTrader');

    const list = await listResearchReports();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Pre-Market Review 2026-05-02');
  });

  it('returns reports newest-first', async () => {
    await saveResearchReport({
      kind: 'premarket',
      title: 'older',
      bodyMarkdown: 'x',
      publishedAt: '2026-05-01T08:00:00Z',
    });
    await saveResearchReport({
      kind: 'postmarket',
      title: 'newer',
      bodyMarkdown: 'y',
      publishedAt: '2026-05-02T20:00:00Z',
    });
    const list = await listResearchReports();
    expect(list.map(r => r.title)).toEqual(['newer', 'older']);
  });

  it('upserts when an id is reused', async () => {
    const first = await saveResearchReport({
      id: 'fixed',
      kind: 'premarket',
      title: 'v1',
      bodyMarkdown: 'a',
    });
    expect(first.id).toBe('fixed');
    await saveResearchReport({
      id: 'fixed',
      kind: 'premarket',
      title: 'v2',
      bodyMarkdown: 'b',
    });
    const list = await listResearchReports();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('v2');
    expect(list[0].bodyMarkdown).toBe('b');
  });

  it('persists between cache resets (round-trips through disk)', async () => {
    await saveResearchReport({
      kind: 'weekly_review',
      title: 'Weekly',
      bodyMarkdown: 'recap',
    });
    __resetResearchStoreForTests(join(tmpRoot, 'research-reports.json'));
    const list = await listResearchReports();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Weekly');
  });

  it('rejects invalid kind, missing title, or missing body', async () => {
    await expect(saveResearchReport({ kind: 'bogus', title: 't', bodyMarkdown: 'b' }))
      .rejects.toBeInstanceOf(ResearchValidationError);
    await expect(saveResearchReport({ kind: 'premarket', title: '', bodyMarkdown: 'b' }))
      .rejects.toBeInstanceOf(ResearchValidationError);
    await expect(saveResearchReport({ kind: 'premarket', title: 't', bodyMarkdown: '' }))
      .rejects.toBeInstanceOf(ResearchValidationError);
    await expect(saveResearchReport(null))
      .rejects.toBeInstanceOf(ResearchValidationError);
  });

  it('looks up a report by id', async () => {
    const saved = await saveResearchReport({
      kind: 'premarket',
      title: 'Hello',
      bodyMarkdown: 'world',
    });
    const found = await getResearchReport(saved.id);
    expect(found?.title).toBe('Hello');
    const missing = await getResearchReport('nope');
    expect(missing).toBeUndefined();
  });

  it('seedSampleResearchReportIfEmpty seeds once, then no-ops', async () => {
    const first = await seedSampleResearchReportIfEmpty();
    expect(first?.id).toBe('sample-premarket');
    expect(first?.source).toBe('QuantTrader');

    const list1 = await listResearchReports();
    expect(list1).toHaveLength(1);

    const second = await seedSampleResearchReportIfEmpty();
    expect(second).toBeNull();
    const list2 = await listResearchReports();
    expect(list2).toHaveLength(1);
  });

  it('seed is skipped when SEED_SAMPLE_RESEARCH=0', async () => {
    const prev = process.env['SEED_SAMPLE_RESEARCH'];
    process.env['SEED_SAMPLE_RESEARCH'] = '0';
    try {
      const result = await seedSampleResearchReportIfEmpty();
      expect(result).toBeNull();
      const list = await listResearchReports();
      expect(list).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env['SEED_SAMPLE_RESEARCH'];
      else process.env['SEED_SAMPLE_RESEARCH'] = prev;
    }
  });

  it('seed does not overwrite existing reports', async () => {
    await saveResearchReport({
      kind: 'postmarket',
      title: 'Real report',
      bodyMarkdown: 'real',
    });
    const result = await seedSampleResearchReportIfEmpty();
    expect(result).toBeNull();
    const list = await listResearchReports();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Real report');
  });
});
