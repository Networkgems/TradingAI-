// TRA-1404 (parent TRA-1403 → TRA-1398) — durable scheduler dedup state.
//
// The 21:00 ET archive tick (`MarketScheduler.onArchive` → `runDailyCloseForAllUsers`)
// is deduped per ET day by an in-memory `lastArchiveDate`. A Render redeploy AFTER
// 21:00 ET resets that key to `''`, so the fresh process re-fires the full daily
// close for a day it already archived. The TRA-1403 write-layer guard
// (`wouldClobberSettledReport`) already prevents that re-fire from zeroing a settled
// calendar cell, so this is defense-in-depth: persisting the key across restarts
// skips the redundant close work entirely, leaving `catchUpMissedEodReports` (writes
// only MISSING days) as the sole post-archive writer.
//
// This is the file-backed `ArchiveDateStore` the scheduler injects. It is kept
// separate from `scheduler.ts` so the scheduler stays fs-free and its unit tests
// can inject an in-memory store. State lives at `<DATA_DIR>/scheduler-state.json`
// alongside the other persistent book state, so it rides the same persistent disk
// that survives a redeploy.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './trade-store.js';
import type { ArchiveDateStore } from './scheduler.js';

const log = logger.child({ module: 'scheduler-state' });

export const SCHEDULER_STATE_FILENAME = 'scheduler-state.json';

/** Shape persisted to `<DATA_DIR>/scheduler-state.json`. Additive-only. */
interface SchedulerState {
  /** Last ET date (`YYYY-MM-DD`) the 21:00 archive fired. */
  lastArchiveDate?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * TRA-1404 — file-backed `ArchiveDateStore`. Reads/writes a single small JSON
 * doc under `dataDir` (defaults to the resolved `DATA_DIR`). Both `load` and
 * `save` are best-effort: a missing/corrupt file loads as "no prior archive"
 * (the day archives normally), and a write failure is logged but never thrown —
 * losing the persisted key only reverts to the old (harmless, TRA-1403-guarded)
 * re-fire behavior.
 */
export function createFileArchiveDateStore(dataDir: string = resolveDataDir()): ArchiveDateStore {
  const path = join(dataDir, SCHEDULER_STATE_FILENAME);

  return {
    load(): string | undefined {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        // ENOENT on first boot / fresh disk — no prior archive to restore.
        return undefined;
      }
      try {
        const parsed = JSON.parse(raw) as SchedulerState;
        const value = parsed?.lastArchiveDate;
        // Guard against a truncated/garbage write leaking a non-date string into
        // the dedup key (which would then never match `todayKey` and silently
        // suppress the archive forever). Only an isoDate is trusted.
        return typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;
      } catch (err) {
        log.warn('scheduler-state parse failed; ignoring persisted archive date', {
          path,
          reason: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },

    save(date: string): void {
      try {
        mkdirSync(dataDir, { recursive: true });
        const state: SchedulerState = { lastArchiveDate: date };
        writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      } catch (err) {
        // Non-fatal: a failed persist just reverts to the old re-fire behavior,
        // which TRA-1403 already renders harmless.
        log.warn('scheduler-state persist failed', {
          path,
          date,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
