import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planSidecarReclaim,
  reclaimSidecarsInDir,
  reclaimReportSidecars,
  reportSidecarMaxUnlinks,
  bookReportRoots,
} from './report-sidecar-reclaim.js';

// TRA-3064 — reclaim of the write-only `<date>.md` report sidecars.
//
// This is a DELETE path over user-visible artifacts, so the tests that matter
// are the ones that prove what it does NOT delete.

describe('planSidecarReclaim', () => {
  it('removes a .md that has a .json sibling', () => {
    const plan = planSidecarReclaim(['2026-08-06.json', '2026-08-06.md']);
    expect(plan.remove).toEqual(['2026-08-06.md']);
    expect(plan.orphans).toEqual([]);
  });

  it('KEEPS a .md with no .json sibling — its bytes exist nowhere else', () => {
    const plan = planSidecarReclaim(['2026-08-06.json', '2026-08-05.md']);
    expect(plan.remove).toEqual([]);
    expect(plan.orphans).toEqual(['2026-08-05.md']);
  });

  it('never proposes a .json for removal, whatever else is present', () => {
    const plan = planSidecarReclaim(['2026-08-06.json', '2026-08-06.md', 'latest.json']);
    expect(plan.remove.every((n) => n.endsWith('.md'))).toBe(true);
    expect(plan.remove).not.toContain('2026-08-06.json');
    expect(plan.remove).not.toContain('latest.json');
  });

  it('treats latest.md by the same rule as a dated cell', () => {
    expect(planSidecarReclaim(['latest.json', 'latest.md']).remove).toEqual(['latest.md']);
    // ...and keeps it when the JSON is absent.
    expect(planSidecarReclaim(['latest.md']).orphans).toEqual(['latest.md']);
  });

  it('ignores files that are neither .md nor .json', () => {
    const plan = planSidecarReclaim(['daily-snapshots.json', 'tape', 'notes.txt', 'x.md']);
    expect(plan.remove).toEqual([]);
    expect(plan.orphans).toEqual(['x.md']);
  });

  it('does not match a .md against a .json with a different stem', () => {
    // `2026-08-06.md` vs `2026-08-06.report.json` — the stems differ, so the
    // markdown is NOT recoverable and must survive.
    const plan = planSidecarReclaim(['2026-08-06.report.json', '2026-08-06.md']);
    expect(plan.remove).toEqual([]);
    expect(plan.orphans).toEqual(['2026-08-06.md']);
  });

  it('is deterministic regardless of readdir order', () => {
    const a = planSidecarReclaim(['b.json', 'b.md', 'a.json', 'a.md']);
    const b = planSidecarReclaim(['a.md', 'b.md', 'a.json', 'b.json']);
    expect(a).toEqual(b);
    expect(a.remove).toEqual(['a.md', 'b.md']);
  });

  it('handles an empty listing', () => {
    expect(planSidecarReclaim([])).toEqual({ remove: [], orphans: [] });
  });
});

describe('reclaimSidecarsInDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tra3064-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the duplicate and leaves the JSON intact', async () => {
    await writeFile(join(dir, '2026-08-06.json'), '{"markdown":"# hi"}', 'utf-8');
    await writeFile(join(dir, '2026-08-06.md'), '# hi', 'utf-8');

    const r = await reclaimSidecarsInDir(dir, { left: 100 });

    expect(r.removed).toBe(1);
    expect(await readdir(dir)).toEqual(['2026-08-06.json']);
    // The bytes are still on disk, inside the field they were copied from —
    // which is the property that makes this delete reversible.
    const json = JSON.parse(await readFile(join(dir, '2026-08-06.json'), 'utf-8'));
    expect(json.markdown).toBe('# hi');
  });

  it('keeps an orphan and names its path', async () => {
    await writeFile(join(dir, 'hand-salvaged.md'), 'irreplaceable', 'utf-8');

    const r = await reclaimSidecarsInDir(dir, { left: 100 });

    expect(r.removed).toBe(0);
    expect(r.orphansKept).toBe(1);
    expect(r.orphanPaths).toEqual([join(dir, 'hand-salvaged.md')]);
    expect(await readFile(join(dir, 'hand-salvaged.md'), 'utf-8')).toBe('irreplaceable');
  });

  it('is idempotent — a second sweep removes nothing and does not fail', async () => {
    await writeFile(join(dir, 'a.json'), '{}', 'utf-8');
    await writeFile(join(dir, 'a.md'), 'x', 'utf-8');

    expect((await reclaimSidecarsInDir(dir, { left: 100 })).removed).toBe(1);
    const second = await reclaimSidecarsInDir(dir, { left: 100 });
    expect(second.removed).toBe(0);
    expect(second.errors).toBe(0);
  });

  it('no-ops on a missing directory rather than throwing', async () => {
    const r = await reclaimSidecarsInDir(join(dir, 'does-not-exist'), { left: 100 });
    expect(r).toMatchObject({ removed: 0, errors: 0, budgetExhausted: false });
  });

  it('stops at the shared budget and reports the sweep as PARTIAL', async () => {
    for (const n of ['a', 'b', 'c']) {
      await writeFile(join(dir, `${n}.json`), '{}', 'utf-8');
      await writeFile(join(dir, `${n}.md`), 'x', 'utf-8');
    }

    const r = await reclaimSidecarsInDir(dir, { left: 2 });

    expect(r.removed).toBe(2);
    expect(r.budgetExhausted).toBe(true);
    // A partial reclaim must not be reported as a complete one.
    expect((await readdir(dir)).filter((n) => n.endsWith('.md')).length).toBe(1);
  });
});

describe('reclaimReportSidecars', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tra3064-tree-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function cell(dir: string, stem: string, withMd: boolean): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${stem}.json`), '{"markdown":"x"}', 'utf-8');
    if (withMd) await writeFile(join(dir, `${stem}.md`), 'x', 'utf-8');
  }

  it('sweeps the root and its mode subdirectories', async () => {
    const reports = join(root, 'reports');
    await cell(reports, '2026-05-01', true); // legacy pre-TRA-244 layout
    await cell(join(reports, 'demo'), '2026-08-06', true);
    await cell(join(reports, 'live'), '2026-08-06', true);
    await cell(join(reports, 'sandbox'), 'latest', true);

    const r = await reclaimReportSidecars([reports]);

    expect(r.removed).toBe(4);
    expect(r.orphansKept).toBe(0);
    for (const d of [reports, join(reports, 'demo'), join(reports, 'live'), join(reports, 'sandbox')]) {
      expect((await readdir(d)).filter((n) => n.endsWith('.md'))).toEqual([]);
    }
  });

  it('does NOT descend past the mode directories', async () => {
    // `<mode>/tape/` is a nested artifact directory. A delete path should visit
    // a listed set of places, not everything below a root.
    const reports = join(root, 'reports');
    const tape = join(reports, 'demo', 'tape');
    await cell(tape, '2026-08-06', true);

    const r = await reclaimReportSidecars([reports]);

    expect(r.removed).toBe(0);
    expect(await readdir(tape)).toContain('2026-08-06.md');
  });

  it('shares one budget across every root, not one per directory', async () => {
    const a = join(root, 'u1', 'reports', 'demo');
    const b = join(root, 'u2', 'reports', 'demo');
    await cell(a, 'x', true);
    await cell(b, 'y', true);

    const r = await reclaimReportSidecars([join(root, 'u1', 'reports'), join(root, 'u2', 'reports')], 1);

    expect(r.removed).toBe(1);
    expect(r.budgetExhausted).toBe(true);
  });

  it('handles both report roots for a book, including absent ones', async () => {
    const reports = join(root, 'reports');
    const crypto = join(root, 'crypto-reports');
    await cell(join(reports, 'demo'), '2026-08-06', true);
    await cell(join(crypto, 'demo'), '2026-08-06', true);

    // A third root that was never created — a book with no reports yet.
    const r = await reclaimReportSidecars([reports, crypto, join(root, 'nope')]);

    expect(r.removed).toBe(2);
    expect(r.errors).toBe(0);
  });

  it('leaves a book whose sidecars are already gone completely untouched', async () => {
    const reports = join(root, 'reports');
    await cell(join(reports, 'demo'), '2026-08-06', false);

    const before = await readdir(join(reports, 'demo'));
    const r = await reclaimReportSidecars([reports]);

    expect(r.removed).toBe(0);
    expect(await readdir(join(reports, 'demo'))).toEqual(before);
  });
});

describe('bookReportRoots', () => {
  let users: string;

  beforeEach(async () => {
    users = await mkdtemp(join(tmpdir(), 'tra3064-users-'));
  });
  afterEach(async () => {
    await rm(users, { recursive: true, force: true });
  });

  it('yields both report roots for every book DIRECTORY, registry or not', async () => {
    // The defect this test exists for: the first cut built roots from
    // `getAllUsers()` and under-reclaimed by more than half, because bqb1's
    // `users/` holds ~251 book trees against 62 registered accounts. The inodes
    // belong to the directory, so the enumeration has to.
    for (const name of ['alice', 'departed-2025', 'never-registered']) {
      await mkdir(join(users, name), { recursive: true });
    }

    const roots = await bookReportRoots(users);

    expect(roots).toHaveLength(6);
    for (const name of ['alice', 'departed-2025', 'never-registered']) {
      expect(roots).toContain(join(users, name, 'reports'));
      expect(roots).toContain(join(users, name, 'crypto-reports'));
    }
  });

  it('reclaims from a book with no registry entry — the whole point', async () => {
    const dir = join(users, 'departed', 'reports', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-08-06.json'), '{"markdown":"x"}', 'utf-8');
    await writeFile(join(dir, '2026-08-06.md'), 'x', 'utf-8');

    const r = await reclaimReportSidecars(await bookReportRoots(users));

    expect(r.removed).toBe(1);
    expect(await readdir(dir)).toEqual(['2026-08-06.json']);
  });

  it('skips loose files at the users/ root and returns [] for a missing root', async () => {
    await writeFile(join(users, 'users.json'), '[]', 'utf-8');
    expect(await bookReportRoots(users)).toEqual([]);
    expect(await bookReportRoots(join(users, 'nope'))).toEqual([]);
  });
});

describe('reportSidecarMaxUnlinks', () => {
  const KEY = 'REPORT_SIDECAR_MAX_UNLINKS';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('defaults well above the 3,822 sidecars measured on bqb1', () => {
    delete process.env[KEY];
    expect(reportSidecarMaxUnlinks()).toBe(20_000);
    expect(reportSidecarMaxUnlinks()).toBeGreaterThan(3_822);
  });

  it('is env-tunable during an incident', () => {
    process.env[KEY] = '50';
    expect(reportSidecarMaxUnlinks()).toBe(50);
  });

  it('falls back to the default on junk rather than disabling the guard', () => {
    for (const junk of ['', 'abc', '0', '-5']) {
      process.env[KEY] = junk;
      expect(reportSidecarMaxUnlinks()).toBe(20_000);
    }
  });
});

describe('the write sites no longer emit a sidecar (TRA-3064)', () => {
  // The reclaim only holds if nothing re-creates what it released. Asserted
  // against the source because the alternative is booting the whole server.
  it('has no `.md` writeFile left in the report write paths', async () => {
    const src = new URL('../index.ts', import.meta.url);
    const text = await readFile(src, 'utf-8');
    // `writeFile(... .md ...)` in any form — dated cell or `latest.md`.
    const writes = text.match(/writeFile\([^)]*\.md['"`][^)]*\)/g) ?? [];
    expect(writes).toEqual([]);
  });

  it('has no `.md` writeFile left in the options P&L rewrite path', async () => {
    const src = new URL('../options-daily-pnl-source.ts', import.meta.url);
    const text = await readFile(src, 'utf-8');
    const writes = text.match(/writeFile\([^)]*\.md['"`][^)]*\)/g) ?? [];
    expect(writes).toEqual([]);
  });
});
