// TRA-2421 — the durable record that an identity was deliberately destroyed.
//
// Every store in this app keys on the raw username string; there is no user id
// anywhere (`User` is `{username,email,passwordHash,role,…}`, tokens carry
// `{sub: username}`, and `userDataDir` is `join(DATA_DIR,'users',username)`).
// That makes a username a RECYCLABLE primary key: delete the credential row, sign
// up the same name again, and every keyed store hands the new account the old
// one's data. TRA-2406/TRA-2410 is exactly that, confirmed by hand on 2026-07-26.
//
// Wiping the files closes most of it. This module closes the channels a file
// delete CANNOT reach:
//
//  1. `DATA_DIR/backups/<ts>/users/<username>/` — 24 rotating generations. The
//     wipe purges them, but a purge can partially fail (a locked file, a rotation
//     racing the delete). `trade-store.ts` consults the tombstone and refuses to
//     restore from any generation stamped before `deletedAt`.
//  2. `DATA_DIR/option-trade-journal.jsonl` — shared, APPEND-ONLY, rows stamped
//     `account?: string`. Its rows are firm research data feeding board-graded
//     numbers, so they are neither purged nor anonymised (see the header of
//     `account-deletion.ts` for why both of those are worse than they look).
//     Instead `journalRowsForBook` scopes a recycled name to rows opened at or
//     after `deletedAt`.
//
// ⚠️ The epoch is the recorded DELETION time, NOT `User.createdAt`. `createdAt`
// is sitting right there and looks equivalent — it is not. This host has lost its
// root state twice (TRA-2136, TRA-2193/2195); if `users.json` were ever recreated,
// every account's `createdAt` would reset to *now* and epoch-scoping would drop
// EVERY historical row from EVERY book — silently blanking the operator calendar
// that TRA-1572/TRA-2407 exist to protect, in the one failure mode this repo keeps
// shipping (a pass state and a fail state that read identically). A tombstone
// applies only to a name someone actually deleted: a name that was never deleted
// has no entry, `accountDeletedAt` returns null, and every reader is byte-for-byte
// unaffected.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
// The LEAF resolver (`data-dir.ts`), not `trade-store.ts`'s re-export: this module
// is read BY `trade-store.ts` (the backup-restore guard), so importing it back
// would close a cycle that `scripts/check-cycles.mjs` refuses.
import { resolveDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'deleted-accounts' });

/** Root-level file name. Also mirrored into every backup (see `rotateBackups`). */
export const DELETED_ACCOUNTS_FILENAME = 'deleted-accounts.json';

/**
 * How the identity ended.
 *
 *  • `self`     — the user deleted their own account in Settings (TRA-2421).
 *  • `admin`    — `DELETE /api/admin/users/:username`. The files are deliberately
 *                 RETAINED (TRA-142), so the tombstone is the only thing standing
 *                 between the leftovers and the next holder of the name.
 *  • `recycled` — TRA-2410. Nobody recorded a deletion at all: a book was found
 *                 sitting under a username that the credential store says is FREE,
 *                 at the moment someone registered it. That is an orphan by
 *                 definition, and the epoch is when we found it, not when it died —
 *                 which is the honest value, and errs toward scoping MORE of the
 *                 predecessor's data out of the new account, never less.
 */
export type TombstoneVia = 'self' | 'admin' | 'recycled';

export interface AccountTombstone {
  /** The exact username string that was destroyed (case-sensitive, as stored). */
  username: string;
  /** ms-epoch the deletion was recorded. */
  deletedAt: number;
  /** How the account went away. */
  via: TombstoneVia;
}

function tombstoneFile(dataDir: string): string {
  return join(dataDir, DELETED_ACCOUNTS_FILENAME);
}

/**
 * Parsed tombstones, keyed by the resolved file path so a test pointing at a temp
 * DATA_DIR does not inherit the process's real one. Only this process writes the
 * file, so the cache is invalidated on write.
 */
const cache = new Map<string, AccountTombstone[]>();

/** Test seam — drop the parsed cache so a test can rewrite the file underneath. */
export function clearTombstoneCache(): void {
  cache.clear();
}

function isTombstone(v: unknown): v is AccountTombstone {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['username'] === 'string'
    && typeof r['deletedAt'] === 'number'
    && Number.isFinite(r['deletedAt']);
}

/**
 * Every recorded tombstone, oldest first. A missing file is the normal state on a
 * host where nobody has ever deleted an account and reads as `[]`.
 *
 * A CORRUPT file also reads as `[]`, which is the honest value — but it is a
 * fail-OPEN state for the two guards above, so it is logged at warn rather than
 * swallowed. It cannot be made fail-closed without bricking every book on the
 * host over one bad byte.
 */
export function readTombstones(dataDir: string = resolveDataDir()): AccountTombstone[] {
  const file = tombstoneFile(dataDir);
  const cached = cache.get(file);
  if (cached) return cached;
  let parsed: AccountTombstone[] = [];
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
      if (Array.isArray(raw)) {
        parsed = raw.filter(isTombstone);
        if (parsed.length !== raw.length) {
          log.warn('deleted-accounts: dropped malformed tombstone rows', {
            file,
            kept: parsed.length,
            dropped: raw.length - parsed.length,
          });
        }
      } else {
        log.warn('deleted-accounts: file is not an array — treating as empty', { file });
      }
    } catch (err: unknown) {
      log.warn('deleted-accounts: unreadable — treating as empty', {
        file,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache.set(file, parsed);
  return parsed;
}

/**
 * Append a tombstone and persist. Returns the recorded entry.
 *
 * Written BEFORE the files are removed, deliberately: if the wipe dies half way
 * through, the guards that read this file are already armed, so the leftovers
 * cannot be adopted by a re-signup. The reverse order would leave the exact
 * silent-adoption window this ticket exists to close.
 *
 * History is kept rather than replaced — a name deleted twice keeps both rows and
 * {@link accountDeletedAt} takes the LATEST, so the scope only ever tightens.
 */
export function recordAccountTombstone(
  username: string,
  opts: { deletedAt?: number; via?: TombstoneVia; dataDir?: string } = {},
): AccountTombstone {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const entry: AccountTombstone = {
    username,
    deletedAt: opts.deletedAt ?? Date.now(),
    via: opts.via ?? 'self',
  };
  const file = tombstoneFile(dataDir);
  const next = [...readTombstones(dataDir), entry];
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
  cache.set(file, next);
  log.info('deleted-accounts: tombstone recorded', { username, deletedAt: entry.deletedAt, via: entry.via });
  return entry;
}

/**
 * ms-epoch of the LATEST recorded deletion of `username`, or `null` when this name
 * has never been deleted.
 *
 * `null` is the answer for every ordinary book and means "apply no scoping at
 * all" — callers must not coerce it to 0 or to `Date.now()`. Matching is exact and
 * case-SENSITIVE, matching `users.ts`'s `===` uniqueness rule and the on-disk
 * directory name; the case-insensitive half of identity is enforced separately at
 * signup by `isReservedOperatorBookName` (TRA-2407).
 */
export function accountDeletedAt(
  username: string,
  dataDir: string = resolveDataDir(),
): number | null {
  let latest: number | null = null;
  for (const t of readTombstones(dataDir)) {
    if (t.username !== username) continue;
    if (latest === null || t.deletedAt > latest) latest = t.deletedAt;
  }
  return latest;
}
