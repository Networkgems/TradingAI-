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
// TRA-4417 (2026-09-08) — WIDENED FROM ONE KEY TO EVERY PER-ET-DAY KEY, because the
// archive was never the only hook with this defect; it was just the only one anybody
// had persisted. MEASURED on live bqb1:
//
//     12:30:20.021Z  morning brief dispatched  date=2026-09-08  users=67
//     12:56:17.645Z  EOD scheduler started            <- restart, 08:56 ET
//     12:57:18.080Z  morning brief dispatched  date=2026-09-08  users=67
//
// 67 users got the 2026-09-08 brief twice, 27 minutes apart. The catch-up windows
// (TRA-2064 / TRA-380 / TRA-849) are CORRECT and are deliberately left exactly as wide
// as they are — they exist because an exact-minute gate dropped an entire trading day
// on any restart or event-loop stall (TRA-1894 / TRA-1905 / TRA-1996), and TRA-1630
// accrued 0 news-catalyst rows across 5 armed sessions for precisely that reason. The
// defect is that a widened window was guarded by state that does not survive the very
// event the window exists to tolerate. Same shape as TRA-1926 (signal-card pile-up:
// in-memory debounce lost on restart, fixed with a durable per-day key).
//
// The one that actually matters is NOT the duplicate email. `lastMorningBriefDate`
// guards a report; `lastPremarketDate` guards `onPremarket`, which is a WRITER —
// `premarket-watchlist.ts` calls `engine.addSymbol()` + `engine.refresh()` and fans a
// full `scanStocksMarket()` out per user. Its window is `hour === 9 && minute < 30`,
// i.e. a restart anywhere in the 30 minutes before the bell rebuilds and re-seeds the
// watchlist a second time against a second full Yahoo pull. That has not been observed
// firing twice yet; the 09-08 brief is the proof the mechanism is live.
//
// This is the file-backed store the scheduler injects. It is kept separate from
// `scheduler.ts` so the scheduler stays fs-free and its unit tests can inject an
// in-memory store. State lives at `<DATA_DIR>/scheduler-state.json` alongside the other
// persistent book state, so it rides the same persistent disk that survives a redeploy.
// Verified on bqb1 2026-09-08: `/api/health/live-enforce-gates` reports
// `dataDir=/data, ephemeral=false`, so this file genuinely outlives a deploy there. On
// an EPHEMERAL DATA_DIR every write here still succeeds and every read-back still
// passes — and the state evaporates anyway (see `isEphemeralDataDir`). That is not a
// failure this module can detect, and it degrades to exactly the pre-TRA-4417
// behaviour rather than to something worse.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './trade-store.js';
import type { SchedulerDedupeKey, SchedulerDedupeStore } from './scheduler.js';

const log = logger.child({ module: 'scheduler-state' });

export const SCHEDULER_STATE_FILENAME = 'scheduler-state.json';

/**
 * Shape persisted to `<DATA_DIR>/scheduler-state.json`. Additive-only, and the
 * `lastArchiveDate` field name is FROZEN: bqb1's live disk already carries files
 * written by the TRA-1404 single-key store, and renaming the field would silently
 * discard that state on the deploy that lands this change (re-firing the very archive
 * TRA-1404 exists to suppress). Every key is optional; an unknown/absent key simply
 * loads as "has not fired", which is the safe direction — the hook fires.
 */
type SchedulerState = Partial<Record<SchedulerDedupeKey, string>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * TRA-1404, widened by TRA-4417 — file-backed `SchedulerDedupeStore`. Reads/writes a
 * single small JSON doc under `dataDir` (defaults to the resolved `DATA_DIR`).
 *
 * Both `load` and `save` are best-effort: a missing/corrupt file loads as "this hook
 * has not fired today" (the hook fires normally), and a write failure is logged but
 * never thrown — losing the persisted key only reverts to the old in-memory-only
 * behaviour. **Failing OPEN is deliberate here.** The opposite bias would let one bad
 * write wedge a hook shut for good, and a hook that silently never fires is the failure
 * mode TRA-1630 / TRA-2064 already cost us five sessions to find; a duplicate fire is
 * loud and bounded. That is also why a value which parses but is not an ISO date is
 * rejected rather than trusted: it could never equal `todayKey`, so it would suppress
 * that hook forever.
 *
 * Writes are whole-file, so they go through a temp file + `rename` (atomic on both
 * POSIX and Windows for a same-directory replace). The TRA-1404 store wrote in place,
 * where a crash mid-write leaves truncated JSON that loads as undefined. Under the old
 * single-key store that only cost a redundant archive; now one torn write would drop
 * the guards for every OTHER hook in the same file too.
 */
export function createFileSchedulerDedupeStore(
  dataDir: string = resolveDataDir(),
): SchedulerDedupeStore {
  const path = join(dataDir, SCHEDULER_STATE_FILENAME);
  const tmpPath = `${path}.tmp`;

  /**
   * Last state this process wrote or read. The whole-file write has to preserve the
   * keys it is not touching, and re-reading on every save would let one corrupt read
   * silently drop six live guards. This process is the sole writer of the file (the
   * service is explicitly not multi-instance safe — see `render.yaml`), so the cache
   * is authoritative once seeded.
   */
  let cache: SchedulerState | null = null;

  function readState(): SchedulerState {
    if (cache) return cache;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      // ENOENT on first boot / fresh disk — nothing has fired yet.
      cache = {};
      return cache;
    }
    try {
      const parsed = JSON.parse(raw) as SchedulerState | null;
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      log.warn('scheduler-state parse failed; ignoring persisted dedup keys', {
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
      cache = {};
    }
    return cache;
  }

  return {
    load(key: SchedulerDedupeKey): string | undefined {
      const value = readState()[key];
      return typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;
    },

    save(key: SchedulerDedupeKey, date: string): void {
      const next: SchedulerState = { ...readState(), [key]: date };
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
        renameSync(tmpPath, path);
        cache = next;
      } catch (err) {
        // Non-fatal: a failed persist just reverts this key to the old re-fire
        // behaviour. The cache is NOT advanced, so the on-disk file and this
        // process's view of it stay in agreement.
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          /* best-effort cleanup of a half-written temp file */
        }
        log.warn('scheduler-state persist failed', {
          path,
          key,
          date,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
