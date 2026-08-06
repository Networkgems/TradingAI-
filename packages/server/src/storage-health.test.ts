/**
 * TRA-2599 — the storage split, graded on the WIRE.
 *
 * The unit half would be easy and nearly worthless here: the defect being fixed
 * is "an anonymous socket gets bytes it should not", so the gate is phrased in
 * bytes off a real socket, and the ungated key list is asserted for EXACT SET
 * EQUALITY rather than "does not contain the ten fields the ticket happened to
 * name".
 *
 * That distinction already caught something. TRA-2414's acceptance listed ten
 * gated fields plus `usage`, and omitted `settingsFile`, `tradesStocksFile` and
 * `tradesCryptoFile` — the three LEGACY `DATA_DIR/*.json` stamps, which publish
 * size and mtime exactly like the four `admin*File` entries it did name. A
 * denylist transcribed from the ticket would have gone green with three mtimes
 * still public. Exact-set-equality on the ALLOWLIST cannot miss a field,
 * including one added after this file was written.
 *
 * Every figure below is planted NON-DEFAULT and MUTUALLY DISTINCT, because a
 * fixture whose gated and ungated bodies agree proves nothing, and two getters
 * returning the same number cannot show they were wired to the wrong sources.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { DiskReading } from './observability/alerts.js';
import type { DataDirUsage } from './data-dir-usage.js';
import type { DiskWatermark } from './observability/disk-watermark.js';
import {
  registerStorageHealthRoutes,
  projectStorageLiveness,
  buildStorageDiagnostic,
  STORAGE_LIVENESS_KEYS,
  STORAGE_LIVENESS_DISK_KEYS,
  STORAGE_LIVENESS_DISK_MONITOR_KEYS,
  STORAGE_GATED_KEYS,
  STORAGE_GATED_DISK_KEYS,
  diskExhaustedAxis,
  STORAGE_LIVENESS_ROUTE,
  STORAGE_DETAIL_ROUTE,
  type StorageDiagnostic,
  type StorageHealthDeps,
} from './storage-health.js';

// ---------------------------------------------------------------------------
// Planted, non-default, mutually distinct fixture values.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'tra2599-admin';
const USER_TOKEN = 'tra2599-plain-user';

/**
 * Every planted number below is at least two digits and mutually distinct, and
 * none is a substring of the liveness body's own structural digits (`tra142`,
 * `ageSec: 30`). That is not fussiness — the first draft used
 * `backupsCount = 3`, and the raw-bytes scan below failed because "3" occurs
 * inside "30". A one-digit needle makes that scan either flaky or vacuous.
 *
 * `USER_COUNT !== USER_CONTEXT_COUNT` so a swapped pair of getters is visible;
 * `USERS_JSON.length` differs from both for the same reason.
 */
const USER_COUNT = 41;
const USER_CONTEXT_COUNT = 37;
/** Not the 10%/99% defaults that have shipped on this route. */
const MIN_FREE_PCT = 12.5;
/** 54 bytes — distinct from 41, 37 and 23. */
const USERS_JSON = '{"tra2599":"planted-users-json-body-0123456789abcdef"}';
const BACKUP_FILES = Array.from({ length: 23 }, (_, i) => `b${i}.json`);

/** freePct 42.5 > minFreePct 12.5 → `belowThreshold: false`, a real reading. */
const HEALTHY_DISK: DiskReading = {
  path: '/tra2599-planted-disk-path',
  totalBytes: 1_000_000_000,
  freeBytes: 425_000_000,
  freePct: 42.5,
  reservedBytes: 49_000_000,
  // TRA-2817 — inodes healthy too, so this fixture stays a clean pass on BOTH
  // axes. Distinct from every byte figure above so a field crossed with another
  // is visible rather than coincidentally equal.
  inodesTotal: 65_536,
  inodesFree: 40_000,
  inodeFreePct: 61.03515625,
};

const USAGE: DataDirUsage = {
  root: '/tra2599-planted-usage-root',
  scannedAt: '2026-07-30T09:00:00.000Z',
  durationMs: 17,
  totalBytes: 18_000_000,
  totalAllocatedBytes: 19_000_000,
  totalFiles: 4,
  entries: [],
  days: ['2026-07-29'],
  truncated: false,
  errors: [],
} as unknown as DataDirUsage;

let dataDir: string;
let server: Server;
let baseUrl: string;
let usageCalls: number;
let diskReading: DiskReading | null;

// TRA-3011 — the since-boot low-water mark, injectable so the RECOVERED branch
// can be driven without a filesystem that has actually run out of space.
const CLEAN_WATERMARK = {
  bootedAt: '2026-07-30T08:11:22.333Z',
  readings: 9,
  failedReadings: 0,
  lastReadingAt: '2026-07-30T09:59:30.000Z',
  lastBelowThreshold: false as boolean | null,
  lastExhausted: null,
  freePctMin: 42.5,
  freeBytesMinAt: 425_000_000,
  inodeFreePctMin: 61.2,
  inodesFreeMinAt: 40_100,
  belowThresholdSeen: false,
  belowReadings: 0,
  exhaustedSeen: null,
  firstBelowAt: null,
  lastBelowAt: null,
  minFreePctAtWorst: MIN_FREE_PCT,
} as const;
let watermark: DiskWatermark = { ...CLEAN_WATERMARK };

/**
 * Mirrors `index.ts`' real middleware contract: 401 for a missing/unknown Bearer
 * token, 403 for a token whose account is not an admin. The separate
 * "index.ts passes the REAL ones" check is the last test in this file.
 */
const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = header.slice(7);
  if (token !== ADMIN_TOKEN && token !== USER_TOKEN) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals['authUser'] = token;
  next();
};

const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals['authUser'] !== ADMIN_TOKEN) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

function deps(): StorageHealthDeps {
  return {
    requireAuth,
    requireAdmin,
    dataDir,
    dataDirEnv: () => '/tra2599-planted-data-dir-env',
    getUserCount: () => USER_COUNT,
    getUserContextCount: () => USER_CONTEXT_COUNT,
    diskMinFreePct: () => MIN_FREE_PCT,
    readDiskSpace: async () => diskReading,
    diskWatermark: () => watermark,
    dataDirUsage: async () => {
      usageCalls += 1;
      return USAGE;
    },
    observabilityMonitor: () => ({ runs: 9, lastRunAt: '2026-07-30T09:59:30.000Z' }),
    now: () => Date.parse('2026-07-30T10:00:00.000Z'),
    processStart: () => '2026-07-30T08:11:22.333Z',
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tra2599-'));
  writeFileSync(join(dataDir, 'users.json'), USERS_JSON);
  writeFileSync(join(dataDir, 'account-settings.json'), '{"legacy":"settings"}');
  writeFileSync(join(dataDir, 'trades-stocks.json'), '{"legacy":"stocks"}');
  writeFileSync(join(dataDir, 'trades-crypto.json'), '{"legacy":"crypto"}');
  writeFileSync(join(dataDir, '.tra-142-migrated'), '');
  mkdirSync(join(dataDir, 'backups'));
  for (const f of BACKUP_FILES) writeFileSync(join(dataDir, 'backups', f), '{}');
  const adminDir = join(dataDir, 'users', 'admin');
  mkdirSync(adminDir, { recursive: true });
  writeFileSync(join(adminDir, 'account-settings.json'), '{"admin":"settings"}');
  writeFileSync(join(adminDir, 'trades-stocks.json'), '{"admin":"stocks"}');
  writeFileSync(join(adminDir, 'trades-crypto.json'), '{"admin":"crypto"}');

  const app = express();
  registerStorageHealthRoutes(app, deps());
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  usageCalls = 0;
  diskReading = HEALTHY_DISK;
  watermark = { ...CLEAN_WATERMARK };
});

const get = (path: string, token?: string) =>
  fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

// ---------------------------------------------------------------------------
// AC1 — the gated route is gated.
// ---------------------------------------------------------------------------

describe('AC1 — the gated route', () => {
  it('401s an unauthenticated GET', async () => {
    const res = await get(STORAGE_DETAIL_ROUTE);
    expect(res.status).toBe(401);
  });

  it('401s a malformed / unknown Bearer token', async () => {
    const res = await get(STORAGE_DETAIL_ROUTE, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('403s a valid NON-admin token — requireAdmin is wired, not just requireAuth', async () => {
    const res = await get(STORAGE_DETAIL_ROUTE, USER_TOKEN);
    expect(res.status).toBe(403);
  });

  it('serves the full body to an admin token', async () => {
    const res = await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Every gated key PRESENT — the split narrowed the audience, it did not drop
    // a field. `toHaveProperty` on each, so the failure names the missing one.
    for (const k of STORAGE_GATED_KEYS) expect(body).toHaveProperty(k);
    for (const k of STORAGE_LIVENESS_KEYS) expect(body).toHaveProperty(k);
    for (const k of STORAGE_GATED_DISK_KEYS) {
      expect(body['disk']).toHaveProperty(k);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — the ungated route leaks nothing.
// ---------------------------------------------------------------------------

describe('AC2 — the ungated liveness route', () => {
  it('still answers 200 without any Authorization header', async () => {
    const res = await get(STORAGE_LIVENESS_ROUTE);
    expect(res.status).toBe(200);
  });

  it('publishes EXACTLY the pinned liveness keys — no more, no fewer', async () => {
    const body = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...STORAGE_LIVENESS_KEYS].sort());
    expect(Object.keys(body['disk'] as object).sort()).toEqual([...STORAGE_LIVENESS_DISK_KEYS].sort());
    expect(Object.keys((body['disk'] as Record<string, object>)['monitor']).sort()).toEqual(
      [...STORAGE_LIVENESS_DISK_MONITOR_KEYS].sort(),
    );
  });

  it('carries NONE of the gated keys, top level or nested in `disk`', async () => {
    const body = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as Record<string, unknown>;
    for (const k of STORAGE_GATED_KEYS) expect(body).not.toHaveProperty(k);
    for (const k of STORAGE_GATED_DISK_KEYS) expect(body['disk']).not.toHaveProperty(k);
  });

  it('leaks no planted value anywhere in the serialized bytes', async () => {
    // Substring search over the raw wire, not key inspection: catches a value
    // that escaped under some other key name.
    const text = await (await get(STORAGE_LIVENESS_ROUTE)).text();
    const needles = [
      dataDir,
      '/tra2599-planted-data-dir-env',
      '/tra2599-planted-disk-path',
      '/tra2599-planted-usage-root',
      String(USER_COUNT),
      String(USER_CONTEXT_COUNT),
      String(USERS_JSON.length),
      String(BACKUP_FILES.length),
      '2026-07-30T08:11:22.333Z',
      String(HEALTHY_DISK.totalBytes),
      String(HEALTHY_DISK.freeBytes),
      String(HEALTHY_DISK.reservedBytes),
      String(MIN_FREE_PCT),
    ];
    for (const needle of needles) {
      // A one-character needle would make this scan meaningless (or flaky) —
      // fail on the FIXTURE rather than let it pass vacuously.
      expect(needle.length, `needle "${needle}" is too short to be a real probe`).toBeGreaterThan(1);
      expect(text).not.toContain(needle);
    }
  });

  it('does not fire the DATA_DIR walk — an anonymous caller cannot make the box scan /data', async () => {
    await get(STORAGE_LIVENESS_ROUTE);
    expect(usageCalls).toBe(0);
    await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN);
    expect(usageCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — negative control. Same-thing-both-sides proves nothing.
// ---------------------------------------------------------------------------

describe('AC3 — negative control: non-default values survive the gate', () => {
  it('returns the planted values BY VALUE under an admin token', async () => {
    const body = (await (await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN)).json()) as Record<string, never>;
    expect(body['dataDir']).toBe(dataDir);
    expect(body['dataDirEnv']).toBe('/tra2599-planted-data-dir-env');
    // Distinct on purpose: equal values could not detect a swapped pair.
    expect(body['userCount']).toBe(USER_COUNT);
    expect(body['userContextCount']).toBe(USER_CONTEXT_COUNT);
    expect(body['backupsCount']).toBe(BACKUP_FILES.length);
    expect(body['processStart']).toBe('2026-07-30T08:11:22.333Z');
    // A real stat of a real file, not a fabricated number.
    expect((body['usersFile'] as { exists: boolean; size: number }).exists).toBe(true);
    expect((body['usersFile'] as { size: number }).size).toBe(USERS_JSON.length);
    expect((body['usersFile'] as { mtime?: string }).mtime).toBeTypeOf('string');
    const disk = body['disk'] as Record<string, unknown>;
    expect(disk['path']).toBe('/tra2599-planted-disk-path');
    expect(disk['totalBytes']).toBe(HEALTHY_DISK.totalBytes);
    expect(disk['freeBytes']).toBe(HEALTHY_DISK.freeBytes);
    expect(disk['reservedBytes']).toBe(HEALTHY_DISK.reservedBytes);
    expect(disk['freePct']).toBe(42.5);
    expect(disk['usedPct']).toBe(57.5);
    expect(disk['minFreePct']).toBe(MIN_FREE_PCT);
    expect((body['usage'] as { root: string }).root).toBe('/tra2599-planted-usage-root');
  });

  it('the two bodies are genuinely different — a fixture that agreed would prove nothing', async () => {
    const gated = await (await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN)).text();
    const open = await (await get(STORAGE_LIVENESS_ROUTE)).text();
    expect(gated).not.toBe(open);
    expect(gated.length).toBeGreaterThan(open.length * 3);
  });
});

// ---------------------------------------------------------------------------
// `disk` must have a reachable FAIL state on both routes.
// ---------------------------------------------------------------------------

describe('disk.readable — unmeasurable is not healthy', () => {
  it('reports belowThreshold NULL, never false, when statfs fails (ungated)', async () => {
    diskReading = null;
    const body = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as {
      disk: { readable: boolean; belowThreshold: boolean | null };
    };
    expect(body.disk.readable).toBe(false);
    // The whole point: `false` here would read as a healthy disk to
    // `if (!disk.belowThreshold)`. `null` cannot be mistaken for measured-and-fine.
    expect(body.disk.belowThreshold).toBeNull();
  });

  it('still leaks no path on the statfs-failure branch — the branch nobody tests', async () => {
    diskReading = null;
    const text = await (await get(STORAGE_LIVENESS_ROUTE)).text();
    expect(text).not.toContain(dataDir);
    const body = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as Record<string, unknown>;
    expect(Object.keys(body['disk'] as object).sort()).toEqual([...STORAGE_LIVENESS_DISK_KEYS].sort());
  });

  it('keeps both belowThreshold booleans reachable on a real reading', async () => {
    diskReading = HEALTHY_DISK;
    const ok = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as { disk: { belowThreshold: boolean } };
    expect(ok.disk.belowThreshold).toBe(false);
    // 4% free against a 12.5% floor.
    diskReading = { ...HEALTHY_DISK, freeBytes: 40_000_000, freePct: 4 };
    const low = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as { disk: { belowThreshold: boolean } };
    expect(low.disk.belowThreshold).toBe(true);
  });

  it('publishes monitor liveness even when statfs fails — it does not depend on statfs', async () => {
    diskReading = null;
    const body = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as {
      disk: { monitor: { stalled: boolean; ageSec: number } };
    };
    expect(body.disk.monitor.stalled).toBe(false);
    expect(body.disk.monitor.ageSec).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// The projection's direction of failure.
// ---------------------------------------------------------------------------

describe('projectStorageLiveness is an allowlist, not a denylist', () => {
  it('drops a field added to the diagnostic AFTER this test was written', async () => {
    const full = await buildStorageDiagnostic(deps(), { includeUsage: true });
    const withNewLeak = {
      ...full,
      // Stand-in for whatever someone adds next year.
      tra2599FutureSecret: '/data/users/alice/secrets.json',
    } as unknown as StorageDiagnostic;
    const projected = projectStorageLiveness(withNewLeak) as unknown as Record<string, unknown>;
    expect(projected).not.toHaveProperty('tra2599FutureSecret');
    expect(Object.keys(projected).sort()).toEqual([...STORAGE_LIVENESS_KEYS].sort());
  });

  it('the pinned lists partition the diagnostic — no key is unclassified', async () => {
    // If this fails, someone added a field and named it in NEITHER list, so the
    // "carries none of the gated keys" test above would silently stop covering it.
    const full = await buildStorageDiagnostic(deps(), { includeUsage: true });
    const classified = new Set<string>([...STORAGE_LIVENESS_KEYS, ...STORAGE_GATED_KEYS]);
    expect(Object.keys(full).filter((k) => !classified.has(k))).toEqual([]);
    const diskClassified = new Set<string>([
      ...STORAGE_LIVENESS_DISK_KEYS,
      ...STORAGE_GATED_DISK_KEYS,
    ]);
    expect(Object.keys(full.disk).filter((k) => !diskClassified.has(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The wiring this file cannot otherwise see.
// ---------------------------------------------------------------------------

describe('index.ts call site', () => {
  // The suite above mounts stand-in middleware, so it proves the REGISTRAR gates
  // the route — not that `index.ts` handed it the real `requireAuth`/
  // `requireAdmin`. TypeScript forces both deps to exist; it cannot stop someone
  // passing a permissive stub. This reads the call site.
  it('passes the real requireAuth and requireAdmin, and registers the route once', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('registerStorageHealthRoutes(app, {'));
    expect(call.slice(0, 400)).toContain('requireAuth,');
    expect(call.slice(0, 400)).toContain('requireAdmin,');
    // The inline route this replaced must be gone, or the old ungated handler
    // would still win on whichever registration express saw first.
    expect(src).not.toContain("app.get('/api/health/storage'");
    expect(src).not.toContain('app.get("/api/health/storage"');
  });

  it('leaves /api/health/version ungated — deploy-SHA verification depends on it', () => {
    const src = readFileSync(new URL('./observability/health-routes.ts', import.meta.url), 'utf8');
    expect(src).toContain("app.get('/api/health/version', (_req, res) => {");
  });
});

/**
 * TRA-2817 — the INODE axis.
 *
 * A filesystem has two exhaustible resources and `ENOSPC` is what both of them
 * raise. `/data` on bqb1 returned `ENOSPC` on every write from
 * 2026-07-30T23:40:19Z for five days — the EOD ledger stopped dead across 47
 * books — while this route served `freePct 37.566` and `belowThreshold: false`.
 * It was never out of bytes: 65524 of 65536 inodes were consumed, 39590 of them
 * by `backups/`. These fix the POLARITY, which is the only thing that was
 * wrong; every byte figure it published was correct and irrelevant.
 */
describe('TRA-2817 disk exhaustion axis', () => {
  const MIN = 10;

  it('names inodes when bytes are healthy — the exact reading that went unseen for five days', () => {
    // The live 2026-08-04 figures, rounded: 37.6% of bytes free, 0.018% of
    // inodes. A blocks-only grader calls this disk fine.
    expect(diskExhaustedAxis(37.566, 0.018, MIN)).toBe('inodes');
  });

  it('still names blocks when only bytes are exhausted', () => {
    expect(diskExhaustedAxis(2.5, 80, MIN)).toBe('blocks');
  });

  it('names both when both are exhausted', () => {
    expect(diskExhaustedAxis(2.5, 1, MIN)).toBe('blocks+inodes');
  });

  it('is null when neither is exhausted', () => {
    expect(diskExhaustedAxis(90, 90, MIN)).toBeNull();
  });

  it('does not manufacture an exhaustion from an UNMEASURED inode table', () => {
    // `files === 0` (tmpfs, NTFS, several network filesystems) reads as null,
    // not as zero free. A blocks-only filesystem must grade exactly as it did
    // before this axis existed — otherwise the fix is a permanent false alarm
    // on every host that is not ext4.
    expect(diskExhaustedAxis(90, null, MIN)).toBeNull();
    expect(diskExhaustedAxis(2.5, null, MIN)).toBe('blocks');
  });

  it('grades the boundary as free, not exhausted', () => {
    // Strictly below, matching the blocks term this was modelled on.
    expect(diskExhaustedAxis(MIN, MIN, MIN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TRA-3011 — the watermark. `/data` returned ENOSPC on every write from
// 2026-07-30T23:40Z to 2026-08-04T~21:20Z; the TRA-2817 backup prune freed the
// inodes and by 08-05 every field on this route read healthy again. The Render
// log tape (~7d retention) was the only surviving evidence of a SIX-DAY outage.
// These pin the field that makes it survivable on the served surface.
// ---------------------------------------------------------------------------

describe('TRA-3011 — the since-boot low-water mark', () => {
  /** bqb1 after the prune ran: clean now, inode-exhausted earlier this boot. */
  const RECOVERED: DiskWatermark = {
    ...CLEAN_WATERMARK,
    freePctMin: 37.566,
    freeBytesMinAt: 383_434_752,
    inodeFreePctMin: 0.018,
    inodesFreeMinAt: 12,
    belowThresholdSeen: true,
    belowReadings: 640,
    exhaustedSeen: 'inodes',
    firstBelowAt: '2026-07-30T23:40:19.000Z',
    lastBelowAt: '2026-08-04T21:20:35.000Z',
  };

  it('★ RECOVERED is distinguishable from NEVER-BROKEN on the ANONYMOUS route', () => {
    // The control comes first: the two states must be identical on every
    // pre-existing field, or the test is passing on something else.
    const forDiag = async (w: DiskWatermark) => {
      watermark = w;
      const res = await get(STORAGE_LIVENESS_ROUTE);
      return (await res.json()) as { disk: Record<string, unknown> };
    };
    return (async () => {
      const clean = await forDiag({ ...CLEAN_WATERMARK });
      const recovered = await forDiag(RECOVERED);
      expect(recovered.disk['readable']).toBe(clean.disk['readable']);
      expect(recovered.disk['belowThreshold']).toBe(clean.disk['belowThreshold']);
      expect(clean.disk['belowThreshold']).toBe(false); // both read healthy NOW
      // …and this is the one field that separates them.
      expect(clean.disk['belowThresholdSeen']).toBe(false);
      expect(recovered.disk['belowThresholdSeen']).toBe(true);
    })();
  });

  it('keeps the watermark NUMBERS gated — only the boolean escapes', async () => {
    watermark = RECOVERED;
    const anon = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as {
      disk: Record<string, unknown>;
    };
    expect(anon.disk).not.toHaveProperty('watermark');

    const admin = (await (await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN)).json()) as StorageDiagnostic;
    expect(admin.disk.watermark.inodeFreePctMin).toBe(0.018);
    expect(admin.disk.watermark.inodesFreeMinAt).toBe(12);
    expect(admin.disk.watermark.exhaustedSeen).toBe('inodes');
    expect(admin.disk.watermark.firstBelowAt).toBe('2026-07-30T23:40:19.000Z');
    expect(admin.disk.watermark.belowReadings).toBe(640);
  });

  it('publishes the watermark on the UNREADABLE branch too', async () => {
    // A statfs that fails NOW says nothing about what this box saw an hour ago.
    // The pre-TRA-2599 route answered the failure branch with a short object and
    // dropped the key that mattered; the same mistake here would erase the only
    // record of the outage at exactly the moment the disk is worst.
    diskReading = null;
    watermark = RECOVERED;
    const admin = (await (await get(STORAGE_DETAIL_ROUTE, ADMIN_TOKEN)).json()) as StorageDiagnostic;
    expect(admin.disk.readable).toBe(false);
    expect(admin.disk.belowThreshold).toBeNull(); // unknown, not fine
    expect(admin.disk.belowThresholdSeen).toBe(true);
    expect(admin.disk.watermark.inodeFreePctMin).toBe(0.018);

    const anon = (await (await get(STORAGE_LIVENESS_ROUTE)).json()) as {
      disk: Record<string, unknown>;
    };
    expect(anon.disk['belowThresholdSeen']).toBe(true);
  });
});
