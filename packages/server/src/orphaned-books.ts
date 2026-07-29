// TRA-2410 — a username is a recyclable primary key, so registering a name is an
// ADOPTION, not a provisioning.
//
// The signup route's own comment promises the new account "fresh equity, empty
// trade history, default settings" (`index.ts`, TRA-142). It has never been true
// for a recycled name. `createUserContext` does `if (!existsSync(dataDir)) mkdir`
// — it adopts an existing directory and never wipes — and every per-user store is
// keyed by the raw username string, so `loadStocksTradeSnapshot` then rehydrates
// the PREVIOUS holder's open positions, closed trades and equity baseline into a
// book its new owner never traded. The reporter of TRA-2406 hit exactly this:
// `enock` re-registered and opened onto POSITIONS 6 / OPTIONS 1.
//
// TRA-2421 fixed the DELETION side for the one path that asks to destroy data
// (self-serve delete → `wipeAccountData`). This module fixes the ADOPTION side,
// which is the half that has to hold for every OTHER way a name comes free:
//
//  • `DELETE /api/admin/users/:username` splices the credential row out and
//    deliberately leaves the book on disk (TRA-142: "so an admin can restore
//    them"). Nothing destructive ever runs.
//  • An operator `rm`-ing a row out of `users.json`, or a `users.json` restored
//    from a generation older than the accounts in it (this host has lost its root
//    state twice — TRA-2136, TRA-2193/2195).
//  • Every book orphaned BEFORE TRA-2421 shipped, which has no tombstone at all.
//
// ── Retire, do not destroy ────────────────────────────────────────────────────
//
// This module DELETES NOTHING. The orphaned tree is MOVED to
// `DATA_DIR/orphaned-books/<username>@<stamp>/`, so TRA-142's restore intent is
// preserved (the data is still on disk, and now carries the date its identity
// ended) while the live key `users/<username>/` is free for a genuinely fresh
// book. Destroying data belongs only on the path where the user asked for it.
//
// ── A directory delete is NOT the channel that bites ──────────────────────────
//
// Moving the primary tree aside is the easy half and it is NOT sufficient — a
// guard that stops there PASSES the obvious acceptance test and still hands over
// the book:
//
//  1. `tryRestoreFromBackup` (`trade-store.ts`) heals a MISSING primary from
//     `backups/<ts>/users/<username>/` — 24 generations, ~12h. Move the tree and
//     the very next read puts it back. So an orphan is detected from the BACKUP
//     GENERATIONS TOO, not just from `users/<name>/`: a name with no live
//     directory but a backup copy is still a recycling hazard, and it is the one
//     an operator's manual `rm -rf` leaves behind.
//  2. `option-trade-journal.jsonl` is shared, append-only and outside the
//     per-user tree entirely (`account`-stamped rows), so no file move touches it.
//  3. `reset-tokens.json` — an outstanding password-reset code for the old holder
//     is a live route onto whoever holds the name next.
//
// (1) and (2) are closed by the TOMBSTONE, not by the move: `tryRestoreFromBackup`
// refuses any generation stamped before the epoch, and `journalRowsForBook` scopes
// a recycled name to rows opened at or after it. That is why the tombstone is
// recorded FIRST and why the epoch is the moment the orphan was FOUND — dying
// half way through leaves the guards armed against the leftovers, which is the
// failure direction that can only produce a red.

import { rename, cp, rm, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import { recordAccountTombstone, accountDeletedAt } from './deleted-accounts.js';
import { revokeResetTokensFor } from './auth.js';
import { forgetTwoFactorState } from './two-factor.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'orphaned-books' });

/**
 * Where retired books go. At the DATA_DIR ROOT, deliberately NOT under `users/`:
 * `rotateBackups` mirrors every directory it finds in `users/`, so parking an
 * orphan there would keep re-backing up a dead book forever AND keep feeding the
 * restore path a copy under the live key.
 */
export const ORPHANED_BOOKS_DIRNAME = 'orphaned-books';

/**
 * What a retirement actually did.
 *
 * Shaped so a NO-OP and a SUCCESS cannot be confused: `orphanFound: false` is the
 * overwhelmingly common answer (every genuinely new username) and means no guard
 * was needed, while `orphanFound: true, ok: true` means one was needed and held.
 * A caller that only checked `ok` would read both as fine — which is why the
 * signup route logs on `orphanFound` and refuses on `!ok`.
 */
export interface OrphanRetirementReceipt {
  username: string;
  /** A book was found under a username the credential store says is free. */
  orphanFound: boolean;
  /** `users/<name>/` existed. */
  primaryDirExisted: boolean;
  /**
   * How many backup generations hold a copy of this book. Non-zero with
   * `primaryDirExisted: false` is the manual-`rm` case — the directory looks
   * clean and the next read restores it.
   */
  backupGenerationsWithData: number;
  /** ms-epoch written to the tombstone, or null when there was no orphan. */
  retiredAt: number | null;
  /** Path under DATA_DIR the primary tree was moved to, relative — never absolute. */
  quarantinedTo: string | null;
  resetTokensRevoked: number;
  twoFactorStateCleared: number;
  /** Operator-only strings; may name absolute paths. Never put these on the wire. */
  errors: string[];
  /**
   * The verdict the caller gates on: the live key is clear and the guards are
   * armed. False ⇒ REFUSE the registration; handing out a book we could not
   * retire is the bug this module exists to prevent.
   */
  ok: boolean;
}

function userDirIn(root: string, username: string): string {
  return join(root, 'users', username);
}

/** Timestamped backup generations. Missing backup root ⇒ `[]`. */
async function backupGenerations(dataDir: string): Promise<string[]> {
  const backupRoot = join(dataDir, 'backups');
  if (!existsSync(backupRoot)) return [];
  try {
    return (await readdir(backupRoot))
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .map((n) => join(backupRoot, n));
  } catch (err: unknown) {
    // Fails CLOSED for detection purposes is not possible here without bricking
    // signup on an unreadable backup root, so this reports 0 and says so loudly.
    // The primary-dir check and the tombstone are unaffected.
    log.warn('orphaned-books: cannot list backups', {
      backupRoot,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function generationHasUser(generation: string, username: string): Promise<boolean> {
  const dir = userDirIn(generation, username);
  if (!existsSync(dir)) return false;
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    // Exists but cannot be stat'ed — not provably clean, so treat it as data.
    return true;
  }
}

/** `2026-07-29T01-23-45-678Z`, the same stamp shape `rotateBackups` writes. */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/**
 * TRA-2410 — make `username` safe to hand to a NEW account.
 *
 * Call this BEFORE `createUser`, on every path that mints a credential row for a
 * name the store says is free. Ordering is load-bearing in the same way it is for
 * the delete sequence: run it after `createUser` and a request arriving on the
 * brand-new token can build the context — and adopt the book — in the window
 * between the two.
 *
 * Idempotent and cheap: for a name nobody has ever used it stats one directory,
 * lists the backup root, and returns `orphanFound: false` having written nothing.
 * It must stay that way — a tombstone recorded for an innocent name would scope
 * that account's own journal rows out of its own calendar.
 */
export async function retireOrphanedBook(
  username: string,
  opts: { dataDir?: string; now?: number } = {},
): Promise<OrphanRetirementReceipt> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const errors: string[] = [];
  const primaryDir = userDirIn(dataDir, username);
  const primaryDirExisted = existsSync(primaryDir);

  let backupGenerationsWithData = 0;
  for (const generation of await backupGenerations(dataDir)) {
    if (await generationHasUser(generation, username)) backupGenerationsWithData += 1;
  }

  const receipt: OrphanRetirementReceipt = {
    username,
    orphanFound: primaryDirExisted || backupGenerationsWithData > 0,
    primaryDirExisted,
    backupGenerationsWithData,
    retiredAt: null,
    quarantinedTo: null,
    resetTokensRevoked: 0,
    twoFactorStateCleared: 0,
    errors,
    ok: true,
  };

  if (!receipt.orphanFound) return receipt;

  // 1. Tombstone FIRST — this is what closes the backup-restore and journal
  //    channels, and it must survive a crash in step 2.
  //
  //    A failure here STOPS the retirement. Moving the tree aside with the guards
  //    unarmed is strictly worse than doing nothing: the primary would be missing,
  //    `tryRestoreFromBackup` would heal it from the newest generation, and the new
  //    account would receive the predecessor's book with the audit trail deleted.
  const retiredAt = opts.now ?? Date.now();
  try {
    recordAccountTombstone(username, { deletedAt: retiredAt, via: 'recycled', dataDir });
    receipt.retiredAt = retiredAt;
  } catch (err: unknown) {
    errors.push(`tombstone: ${err instanceof Error ? err.message : String(err)}`);
    receipt.ok = false;
    log.error('orphaned-books: refusing to retire without a tombstone', { ...receipt });
    return receipt;
  }

  // 2. Move the live key aside. Nothing is deleted; the tree keeps its contents
  //    under `orphaned-books/` where no reader is keyed to find it.
  if (primaryDirExisted) {
    const target = join(dataDir, ORPHANED_BOOKS_DIRNAME, `${username}@${stampOf(retiredAt)}`);
    try {
      await rename(primaryDir, target);
      receipt.quarantinedTo = join(ORPHANED_BOOKS_DIRNAME, `${username}@${stampOf(retiredAt)}`);
    } catch (err: unknown) {
      // A rename can fail across a device boundary (a bind-mounted DATA_DIR) —
      // copy-then-remove is the same outcome, just not atomic.
      try {
        await cp(primaryDir, target, { recursive: true });
        await rm(primaryDir, { recursive: true, force: true });
        receipt.quarantinedTo = join(ORPHANED_BOOKS_DIRNAME, `${username}@${stampOf(retiredAt)}`);
      } catch (fallbackErr: unknown) {
        errors.push(
          `quarantine:${primaryDir}->${target}: ${err instanceof Error ? err.message : String(err)} / ` +
          `${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
    }
  }

  // 3. Identity-keyed credential paths outside the per-user tree.
  try {
    receipt.resetTokensRevoked = revokeResetTokensFor(username);
  } catch (err: unknown) {
    errors.push(`reset-tokens: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    receipt.twoFactorStateCleared = forgetTwoFactorState(username);
  } catch (err: unknown) {
    errors.push(`two-factor: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The verdict measures the WORLD, not the steps: the live key must be clear on
  // disk, and the epoch must come back through `accountDeletedAt` — the same
  // accessor `tryRestoreFromBackup` and `journalRowsForBook` read. Asserting the
  // return value of `recordAccountTombstone` instead would only re-check the object
  // we just built.
  const liveKeyClear = !existsSync(primaryDir);
  const epochArmed = accountDeletedAt(username, dataDir) === retiredAt;
  if (!epochArmed) errors.push('tombstone: epoch not readable back after write');
  receipt.ok = liveKeyClear && epochArmed && errors.length === 0;

  log[receipt.ok ? 'info' : 'error']('orphaned-books: retirement complete', { ...receipt });
  return receipt;
}
