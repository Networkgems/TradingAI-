/**
 * TRA-2599 — `/api/health/storage`, split into an UNGATED liveness subset and an
 * ADMIN-GATED diagnostic.
 *
 * ## Why a split and not a gate-in-place
 *
 * TRA-2414 found the route answering `200` to an anonymous caller with
 * `dataDir`, `dataDirEnv`, `userCount` (28 at filing, 56 three days later),
 * `userContextCount`, four `*File` size/mtime pairs, `backupsCount`,
 * `processStart` and byte-level disk figures. All of that is gated material.
 *
 * But the route has three unauthenticated consumers, and a naive
 * `requireAuth, requireAdmin` bolted onto the existing path breaks all three —
 * two of them silently-wrong rather than loudly:
 *
 *  1. `scripts/tra2420-data-dir-attribution.mjs` threads no token and maps any
 *     non-200 to `EXIT.BLIND`. Gating in place turns the DATA_DIR
 *     growth-attribution instrument permanently BLIND. (Fixed in the same
 *     commit: it now sends an admin Bearer token and reads the gated route.)
 *  2. Deploy-carrier routines discriminate "did pin `3052972` land?" on the
 *     PRESENCE of the `usage` block. A `401` makes `usage` absent — so a gated
 *     route reads as UNDEPLOYED on a build that deployed perfectly, and the pass
 *     state and the fail state become byte-identical. Keeping
 *     `/api/health/storage` a live `200` keeps that discriminator honest, and
 *     `usage` now lands on the gated route where the carrier's token reaches it.
 *  3. `docs/runbook.md` curls it unauthenticated as the disk/persistence triage
 *     step. The liveness subset keeps that step working without a token.
 *
 * ## The shape of the guarantee
 *
 * The two routes serve ONE object built ONCE by `buildStorageDiagnostic`. The
 * ungated route publishes an ALLOWLIST PROJECTION of it — never a hand-built
 * second DTO. The direction of that failure matters: a field added to the
 * diagnostic later is gated by DEFAULT and has to be named in
 * `STORAGE_LIVENESS_KEYS` to escape. A hand-built parallel DTO fails the other
 * way — it silently drops a field the gated side still needs, which is the
 * TRA-2583 failure mode this route was explicitly told not to repeat.
 *
 * `STORAGE_LIVENESS_KEYS` is asserted for EXACT set equality in
 * `storage-health.test.ts`, so widening the ungated surface cannot happen
 * quietly either.
 *
 * ## `disk` has no pass state unless `readable` is published
 *
 * `readDiskSpace` returns `null` when `statfs` fails. The pre-split route
 * answered that with a short object — `{ path, error, minFreePct }` — carrying
 * no `belowThreshold` and no `monitor` at all. Two consequences, both bad:
 *
 *  - `disk.path` is a PATH, i.e. exactly the thing being gated, and it appeared
 *    ONLY on the failure branch. The leak survived on the branch nobody tests.
 *  - `JSON.stringify` drops the absent `belowThreshold`, so a caller writing
 *    `if (body.disk.belowThreshold)` reads a filesystem that could not be
 *    measured as a HEALTHY one. Unmeasurable and fine were byte-identical.
 *
 * So `disk` now has ONE shape on both branches: `readable` says whether the
 * reading happened, the byte fields are `null` when it did not, and
 * `belowThreshold` is `boolean | null` — `null`, never `false`, when unknown.
 * `monitor` is always present because monitor liveness does not depend on
 * `statfs`. This is additive for every existing gated reader: no key that
 * existed on the success branch changed type or went away.
 */

import type { Express, RequestHandler } from 'express';
import { existsSync } from 'fs';
import { stat, readdir } from 'fs/promises';
import { join } from 'path';
import type { DiskReading } from './observability/alerts.js';
import type { DataDirUsage } from './data-dir-usage.js';

/** `{ exists }` alone when the file is absent — never a fabricated zero size. */
export interface FileStamp {
  exists: boolean;
  size?: number;
  mtime?: string;
}

export interface StorageDiskBlock {
  /** Did `statfs` succeed? Every byte field below is `null` when false. */
  readable: boolean;
  /** `null` when unreadable. Present on BOTH branches pre-split — a path leak. */
  path: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  reservedBytes: number | null;
  freePct: number | null;
  usedPct: number | null;
  /** The threshold `disk-near-full` grades against. Always known. */
  minFreePct: number;
  /** `null` when unreadable — NOT `false`. See the module header. */
  belowThreshold: boolean | null;
  error: string | null;
  monitor: {
    runs: number;
    lastRunAt: string | null;
    ageSec: number | null;
    stalled: boolean;
  };
}

/**
 * The full diagnostic. The admin route serves this verbatim; the anonymous route
 * serves `projectStorageLiveness()` of it.
 */
export interface StorageDiagnostic {
  dataDir: string;
  dataDirEnv: string | null;
  dataDir_exists: boolean;
  disk: StorageDiskBlock;
  /** `null` on the ungated build path — the walk is not run for a projection. */
  usage: Record<string, unknown> | null;
  usersFile: FileStamp;
  settingsFile: FileStamp;
  tradesStocksFile: FileStamp;
  tradesCryptoFile: FileStamp;
  adminSettingsFile: FileStamp;
  adminTradesStocksFile: FileStamp;
  adminTradesCryptoFile: FileStamp;
  tra142Migrated: boolean;
  backupsDir_exists: boolean;
  backupsCount: number;
  userCount: number;
  userContextCount: number;
  processStart: string;
}

/**
 * The ONLY top-level keys an anonymous caller sees. Exact-set-asserted in the
 * test suite: adding a key here is a deliberate widening of a public surface and
 * has to be made twice.
 *
 * Every one is a BOOLEAN or a staleness age. No path, no count, no size, no
 * mtime, no timestamp that dates the process.
 */
export const STORAGE_LIVENESS_KEYS = [
  'dataDir_exists',
  'tra142Migrated',
  'backupsDir_exists',
  'disk',
] as const;

/** Ungated `disk` keys. `readable` is what gives the block a fail state. */
export const STORAGE_LIVENESS_DISK_KEYS = ['readable', 'belowThreshold', 'monitor'] as const;

/** Ungated `disk.monitor` keys. `runs` is a count, so it stays gated. */
export const STORAGE_LIVENESS_DISK_MONITOR_KEYS = ['stalled', 'ageSec'] as const;

/**
 * TRA-2414's leak inventory — asserted ABSENT from the anonymous response.
 *
 * The acceptance criteria named ten of these plus `usage`. It omitted
 * `settingsFile`, `tradesStocksFile` and `tradesCryptoFile` — the three LEGACY
 * `DATA_DIR/*.json` stamps, which carry size and mtime exactly like the four
 * `admin*File` entries it did name. A denylist copied from the ticket would have
 * passed while three mtimes stayed public, so this list is derived from the
 * payload instead: every `StorageDiagnostic` key that is not in
 * `STORAGE_LIVENESS_KEYS`.
 */
export const STORAGE_GATED_KEYS = [
  'dataDir',
  'dataDirEnv',
  'usage',
  'usersFile',
  'settingsFile',
  'tradesStocksFile',
  'tradesCryptoFile',
  'adminSettingsFile',
  'adminTradesStocksFile',
  'adminTradesCryptoFile',
  'backupsCount',
  'userCount',
  'userContextCount',
  'processStart',
] as const;

/** Gated `disk` keys — byte-level figures and the raw monitor run count. */
export const STORAGE_GATED_DISK_KEYS = [
  'path',
  'totalBytes',
  'freeBytes',
  'usedBytes',
  'reservedBytes',
  'freePct',
  'usedPct',
  'minFreePct',
  'error',
] as const;

export type StorageLivenessResponse = {
  dataDir_exists: boolean;
  tra142Migrated: boolean;
  backupsDir_exists: boolean;
  disk: {
    readable: boolean;
    belowThreshold: boolean | null;
    monitor: { stalled: boolean; ageSec: number | null };
  };
};

/**
 * Allowlist projection. Reads ONLY the keys named above off the full diagnostic,
 * so an unnamed field — including one added after this was written — cannot
 * reach an anonymous caller.
 */
export function projectStorageLiveness(full: StorageDiagnostic): StorageLivenessResponse {
  return {
    dataDir_exists: full.dataDir_exists,
    tra142Migrated: full.tra142Migrated,
    backupsDir_exists: full.backupsDir_exists,
    disk: {
      readable: full.disk.readable,
      belowThreshold: full.disk.belowThreshold,
      monitor: {
        stalled: full.disk.monitor.stalled,
        ageSec: full.disk.monitor.ageSec,
      },
    },
  };
}

export interface StorageHealthDeps {
  /** The real `index.ts` middleware. Wired at the single call site. */
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  dataDir: string;
  dataDirEnv: () => string | null;
  getUserCount: () => number;
  getUserContextCount: () => number;
  diskMinFreePct: () => number;
  readDiskSpace: (path: string) => Promise<DiskReading | null>;
  dataDirUsage: (root: string) => Promise<DataDirUsage>;
  /** Heartbeat of `runObservabilityMonitor`, which lives in `index.ts`. */
  observabilityMonitor: () => { runs: number; lastRunAt: string | null };
  now?: () => number;
  /** Process boot time. Gated — it dates the box. */
  processStart: () => string;
}

/** Ticks every 60s; past this it is a stalled loop, not a healthy one. */
const MONITOR_STALL_SEC = 180;

async function statFile(p: string): Promise<FileStamp> {
  try {
    const s = await stat(p);
    return { exists: true, size: s.size, mtime: s.mtime.toISOString() };
  } catch {
    return { exists: false };
  }
}

/**
 * Build the diagnostic once.
 *
 * `includeUsage: false` skips the DATA_DIR walk for the anonymous path — the
 * `usage` block is gated, so an unauthenticated request has no reason to fire a
 * filesystem walk over `/data`. It is safe against divergence because
 * `projectStorageLiveness` never reads `usage`, and the exact-key-set test pins
 * that. On the gated path the walk runs exactly as before.
 */
export async function buildStorageDiagnostic(
  deps: StorageHealthDeps,
  opts: { includeUsage: boolean },
): Promise<StorageDiagnostic> {
  const dataDir = deps.dataDir;
  const now = deps.now ?? Date.now;

  const usersFile = join(dataDir, 'users.json');
  const backupsDir = join(dataDir, 'backups');
  // TRA-142 — per-user files now live under DATA_DIR/users/<username>/. The
  // legacy DATA_DIR/account-settings.json etc. are migrated into the admin
  // namespace on first boot, so we report admin's path so QA sees the
  // post-migration location while the legacy fields show migration ran.
  const legacySettingsFile = join(dataDir, 'account-settings.json');
  const legacyTradesStocksFile = join(dataDir, 'trades-stocks.json');
  const legacyTradesCryptoFile = join(dataDir, 'trades-crypto.json');
  const adminDir = join(dataDir, 'users', 'admin');
  const adminSettingsFile = join(adminDir, 'account-settings.json');
  const adminTradesStocksFile = join(adminDir, 'trades-stocks.json');
  const adminTradesCryptoFile = join(adminDir, 'trades-crypto.json');
  const migrationMarker = join(dataDir, '.tra-142-migrated');

  let backupsCount = 0;
  try {
    backupsCount = (await readdir(backupsDir)).length;
  } catch {
    backupsCount = 0;
  }

  // TRA-2357 — free space on the volume backing DATA_DIR, plus the threshold the
  // `disk-near-full` alert grades against and the liveness of the loop that
  // grades it. Before this, the route reported file sizes but no headroom, so
  // "is the disk near full?" was unanswerable between alerts — and the one alert
  // we had (2026-07-25T20:33Z) turned out to be `16.3% free — below 99%`, a
  // healthy disk against a bad threshold.
  //
  // `readDiskSpace` is the PURE reader on purpose — calling `checkDiskSpace`
  // here would let any anonymous request fire a CRITICAL alert and burn the real
  // one's throttle window.
  const minFreePct = deps.diskMinFreePct();
  const reading = await deps.readDiskSpace(dataDir);
  const monitorState = deps.observabilityMonitor();
  const monitorAgeSec = monitorState.lastRunAt
    ? Math.round((now() - Date.parse(monitorState.lastRunAt)) / 1000)
    : null;
  const monitor = {
    runs: monitorState.runs,
    lastRunAt: monitorState.lastRunAt,
    ageSec: monitorAgeSec,
    stalled: monitorState.runs === 0 || (monitorAgeSec !== null && monitorAgeSec > MONITOR_STALL_SEC),
  };
  const disk: StorageDiskBlock = reading
    ? {
        readable: true,
        path: reading.path,
        totalBytes: reading.totalBytes,
        freeBytes: reading.freeBytes,
        // TRA-2420 — `usedBytes` is derived from `bavail`, so it counts the root
        // reserve as used. Publish the reserve so the residual can subtract
        // bytes that no writer owns instead of hunting for the writer that put
        // them there.
        usedBytes: reading.totalBytes - reading.freeBytes,
        reservedBytes: reading.reservedBytes,
        freePct: Number(reading.freePct.toFixed(3)),
        usedPct: Number((100 - reading.freePct).toFixed(3)),
        minFreePct,
        belowThreshold: reading.freePct < minFreePct,
        error: null,
        monitor,
      }
    : {
        readable: false,
        path: null,
        totalBytes: null,
        freeBytes: null,
        usedBytes: null,
        reservedBytes: null,
        freePct: null,
        usedPct: null,
        minFreePct,
        // Unknown, not fine. See the module header.
        belowThreshold: null,
        error: 'statfs failed',
        monitor,
      };

  let usage: Record<string, unknown> | null = null;
  if (opts.includeUsage) {
    // TRA-2420 — name the writer. TRA-2417 attributed `/data`'s ~11.6 MB per
    // trading day to the option-chain capture; the real 07-24 partition is 8.02
    // MB and the sentiment snapshots are 0.008, so ~3.6 MB/day had no owner. A
    // total minus one measured component is not an attribution. There is no
    // shell on bqb1, so the breakdown has to be published here.
    //
    // Read `createdBytesByDay` for growth and `modifiedBytesByDay` for activity
    // — they are different questions, and a per-session file rewritten in place
    // is enormous in the second and absent from the first.
    const measured = await deps.dataDirUsage(dataDir);
    const measuredBytes = measured.totalBytes;
    const allocatedBytes = measured.totalAllocatedBytes;
    const diskUsedBytes = disk.usedBytes;
    const reservedBytes = disk.reservedBytes;
    const attributableUsedBytes =
      diskUsedBytes === null || reservedBytes === null ? null : diskUsedBytes - reservedBytes;
    usage = {
      ...measured,
      // The residual, published rather than left as a subtraction someone does
      // in their head. Non-zero is expected and fine (anything on the volume
      // outside DATA_DIR); a LARGE non-zero means the breakdown below does not
      // account for the disk and must not be read as if it does.
      //
      // TRA-2420 — this subtraction was UNIT-MISMATCHED until 2026-07-30, and
      // the mismatch had no failing state. `measuredBytes` is APPARENT bytes (a
      // sum of `st_size`); `diskUsedBytes` is ALLOCATED blocks PLUS the root
      // reserve. On bqb1 those differ structurally by ~150 MB — ~100 MB of 4 KiB
      // block rounding across ~48k small files, plus ext4's ~49 MB 5% root
      // reserve — so the residual sat at 35% and `tra2420:attribute` returned
      // UNATTRIBUTED (exit 1) forever. There was NO value of the real disk that
      // could have produced a pass: the guard was reading a constant, not a
      // measurement. Compare like with like — allocated against allocated, with
      // the reserve removed because no writer owns it — and keep the apparent
      // figures as labelled contrast only.
      unaccounted: {
        diskUsedBytes,
        reservedBytes,
        /** `df` used, less the blocks reserved for root. The part a writer could own. */
        attributableUsedBytes,
        allocatedBytes,
        bytes:
          attributableUsedBytes === null || allocatedBytes === null
            ? null
            : attributableUsedBytes - allocatedBytes,
        pct:
          attributableUsedBytes === null || allocatedBytes === null || attributableUsedBytes === 0
            ? null
            : Number((((attributableUsedBytes - allocatedBytes) / attributableUsedBytes) * 100).toFixed(3)),
        // Contrast only. NOT the residual — subtracting apparent bytes from
        // allocated+reserved counts block rounding as an unowned writer.
        apparent: {
          measuredBytes,
          bytes: diskUsedBytes === null ? null : diskUsedBytes - measuredBytes,
          pct:
            diskUsedBytes === null || diskUsedBytes === 0
              ? null
              : Number((((diskUsedBytes - measuredBytes) / diskUsedBytes) * 100).toFixed(3)),
        },
      },
    };
  }

  return {
    dataDir,
    dataDirEnv: deps.dataDirEnv(),
    dataDir_exists: existsSync(dataDir),
    disk,
    usage,
    usersFile: await statFile(usersFile),
    settingsFile: await statFile(legacySettingsFile),
    tradesStocksFile: await statFile(legacyTradesStocksFile),
    tradesCryptoFile: await statFile(legacyTradesCryptoFile),
    adminSettingsFile: await statFile(adminSettingsFile),
    adminTradesStocksFile: await statFile(adminTradesStocksFile),
    adminTradesCryptoFile: await statFile(adminTradesCryptoFile),
    tra142Migrated: existsSync(migrationMarker),
    backupsDir_exists: existsSync(backupsDir),
    backupsCount,
    userCount: deps.getUserCount(),
    userContextCount: deps.getUserContextCount(),
    processStart: deps.processStart(),
  };
}

/** The gated route's path. Named so consumers and tests cannot drift from it. */
export const STORAGE_DETAIL_ROUTE = '/api/health/storage/detail';
/** The ungated liveness route's path. Unchanged from TRA-141 on purpose. */
export const STORAGE_LIVENESS_ROUTE = '/api/health/storage';

export function registerStorageHealthRoutes(app: Express, deps: StorageHealthDeps): void {
  // TRA-141 / TRA-2599 — storage liveness. Open, like the other health probes,
  // and now carrying ONLY booleans plus a staleness age: enough for the runbook
  // triage step and for `disk-near-full` follow-up, nothing that names a path,
  // a count, a size or an mtime.
  app.get(STORAGE_LIVENESS_ROUTE, async (_req, res) => {
    const full = await buildStorageDiagnostic(deps, { includeUsage: false });
    res.json(projectStorageLiveness(full));
  });

  // TRA-2599 — the diagnostic TRA-141 shipped, now admin-only. Serves the full
  // object verbatim, so nothing that used to be readable here was dropped in
  // the split; only the audience narrowed.
  app.get(STORAGE_DETAIL_ROUTE, deps.requireAuth, deps.requireAdmin, async (_req, res) => {
    const full = await buildStorageDiagnostic(deps, { includeUsage: true });
    res.json(full);
  });
}
