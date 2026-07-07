import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileArchiveDateStore, SCHEDULER_STATE_FILENAME } from './scheduler-state.js';

/**
 * TRA-1404 — the file-backed `ArchiveDateStore` must survive a process restart:
 * `save(date)` then a FRESH store's `load()` (a new process against the same
 * DATA_DIR) returns the same date. Corrupt / missing / non-date state loads as
 * "no prior archive" so the day archives normally instead of being wedged.
 */
describe('scheduler-state — TRA-1404 file-backed ArchiveDateStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scheduler-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips lastArchiveDate across a simulated restart', () => {
    // First process: archive fires, persists the key.
    createFileArchiveDateStore(dir).save('2026-05-15');
    // Fresh process (new store instance) against the same DATA_DIR restores it.
    expect(createFileArchiveDateStore(dir).load()).toBe('2026-05-15');
  });

  it('load() returns undefined when no state file exists yet (first boot)', () => {
    expect(createFileArchiveDateStore(dir).load()).toBeUndefined();
  });

  it('creates DATA_DIR on save when it does not exist', () => {
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    createFileArchiveDateStore(nested).save('2026-05-15');
    expect(createFileArchiveDateStore(nested).load()).toBe('2026-05-15');
  });

  it('overwrites a prior date on the next archive', () => {
    const store = createFileArchiveDateStore(dir);
    store.save('2026-05-14');
    store.save('2026-05-15');
    expect(createFileArchiveDateStore(dir).load()).toBe('2026-05-15');
  });

  it('ignores a corrupt state file (loads as no-prior-archive)', () => {
    writeFileSync(join(dir, SCHEDULER_STATE_FILENAME), '{ not valid json', 'utf-8');
    expect(createFileArchiveDateStore(dir).load()).toBeUndefined();
  });

  it('rejects a non-date lastArchiveDate so a garbage write cannot wedge the archive', () => {
    // A truncated/garbage value that is valid JSON but not an ISO date must not
    // become the dedup key — otherwise it would never match `todayKey` and would
    // silently suppress every future archive.
    writeFileSync(
      join(dir, SCHEDULER_STATE_FILENAME),
      JSON.stringify({ lastArchiveDate: 'not-a-date' }),
      'utf-8',
    );
    expect(createFileArchiveDateStore(dir).load()).toBeUndefined();
  });
});
