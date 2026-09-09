import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileSchedulerDedupeStore, SCHEDULER_STATE_FILENAME } from './scheduler-state.js';

/**
 * TRA-1404 / TRA-4417 — the file-backed `SchedulerDedupeStore` must survive a process
 * restart: `save(key, date)` then a FRESH store's `load(key)` (a new process against
 * the same DATA_DIR) returns the same date. Corrupt / missing / non-date state loads as
 * "this hook has not fired today" so the hook fires normally instead of being wedged
 * shut.
 */
describe('scheduler-state — file-backed SchedulerDedupeStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scheduler-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips lastArchiveDate across a simulated restart', () => {
    // First process: archive fires, persists the key.
    createFileSchedulerDedupeStore(dir).save('lastArchiveDate', '2026-05-15');
    // Fresh process (new store instance) against the same DATA_DIR restores it.
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBe('2026-05-15');
  });

  it('load() returns undefined when no state file exists yet (first boot)', () => {
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBeUndefined();
  });

  it('creates DATA_DIR on save when it does not exist', () => {
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    createFileSchedulerDedupeStore(nested).save('lastArchiveDate', '2026-05-15');
    expect(createFileSchedulerDedupeStore(nested).load('lastArchiveDate')).toBe('2026-05-15');
  });

  it('overwrites a prior date on the next archive', () => {
    const store = createFileSchedulerDedupeStore(dir);
    store.save('lastArchiveDate', '2026-05-14');
    store.save('lastArchiveDate', '2026-05-15');
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBe('2026-05-15');
  });

  it('ignores a corrupt state file (loads as not-yet-fired)', () => {
    writeFileSync(join(dir, SCHEDULER_STATE_FILENAME), '{ not valid json', 'utf-8');
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBeUndefined();
  });

  it('rejects a non-date value so a garbage write cannot wedge a hook shut', () => {
    // A truncated/garbage value that is valid JSON but not an ISO date must not
    // become the dedup key — otherwise it would never match `todayKey` and would
    // silently suppress every future fire.
    writeFileSync(
      join(dir, SCHEDULER_STATE_FILENAME),
      JSON.stringify({ lastArchiveDate: 'not-a-date' }),
      'utf-8',
    );
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBeUndefined();
  });

  // ── TRA-4417: several keys now share one file ────────────────────────────────

  it('keeps every key independent across a restart', () => {
    const store = createFileSchedulerDedupeStore(dir);
    store.save('lastPremarketDate', '2026-09-08');
    store.save('lastMorningBriefDate', '2026-09-08');
    store.save('lastChainRecordDate', '2026-09-05');

    const reboot = createFileSchedulerDedupeStore(dir);
    expect(reboot.load('lastPremarketDate')).toBe('2026-09-08');
    expect(reboot.load('lastMorningBriefDate')).toBe('2026-09-08');
    expect(reboot.load('lastChainRecordDate')).toBe('2026-09-05');
    expect(reboot.load('lastArchiveDate')).toBeUndefined();
  });

  it('a save for one key does NOT clobber the others', () => {
    // The write is whole-file, so this is the failure mode that would quietly undo
    // TRA-1404 the moment TRA-4417 added a second key: the 09:00 pre-market save
    // dropping last night's archive key, re-firing the daily close on the next boot.
    createFileSchedulerDedupeStore(dir).save('lastArchiveDate', '2026-09-07');
    createFileSchedulerDedupeStore(dir).save('lastPremarketDate', '2026-09-08');

    const reboot = createFileSchedulerDedupeStore(dir);
    expect(reboot.load('lastArchiveDate')).toBe('2026-09-07');
    expect(reboot.load('lastPremarketDate')).toBe('2026-09-08');
  });

  it('reads state written by the TRA-1404 single-key store (live-disk compatibility)', () => {
    // bqb1's /data already carries files in exactly this shape. If the field name had
    // drifted, the deploy landing TRA-4417 would silently discard the archive key and
    // re-fire the daily close — the bug TRA-1404 exists to prevent.
    writeFileSync(
      join(dir, SCHEDULER_STATE_FILENAME),
      `${JSON.stringify({ lastArchiveDate: '2026-09-07' }, null, 2)}\n`,
      'utf-8',
    );
    const store = createFileSchedulerDedupeStore(dir);
    expect(store.load('lastArchiveDate')).toBe('2026-09-07');
    // …and a later write preserves the pre-existing key rather than dropping it.
    store.save('lastMorningBriefDate', '2026-09-08');
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBe('2026-09-07');
  });

  it('leaves no .tmp file behind after a successful save', () => {
    // Writes go through a temp file + rename so a crash mid-write cannot leave
    // truncated JSON that drops the guards for every other hook in the same file.
    const store = createFileSchedulerDedupeStore(dir);
    store.save('lastArchiveDate', '2026-09-07');
    expect(() =>
      readFileSync(join(dir, `${SCHEDULER_STATE_FILENAME}.tmp`), 'utf-8'),
    ).toThrow();
    expect(createFileSchedulerDedupeStore(dir).load('lastArchiveDate')).toBe('2026-09-07');
  });

  it('does not throw when the state path is unwritable (best-effort save)', () => {
    // Point the store at a path whose "directory" is an existing FILE, so mkdir/write
    // fail. A persist failure must degrade to in-memory-only dedup, never take the
    // scheduler tick down.
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf-8');
    const store = createFileSchedulerDedupeStore(asFile);
    expect(() => store.save('lastArchiveDate', '2026-09-07')).not.toThrow();
    expect(store.load('lastArchiveDate')).toBeUndefined();
  });
});
