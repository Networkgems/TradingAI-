// TRA-2421 — destroy one account's data, for real.
//
// The board asked for a self-serve "wipe data and delete account" in Settings.
// The obvious implementation — `rm -rf DATA_DIR/users/<username>/` — is wrong in a
// way that PASSES the obvious acceptance test:
//
//   `loadStocks/CryptoTradeSnapshot` fall back to `tryRestoreFromBackup()` on a
//   MISSING primary file (`trade-store.ts:270-282`). Backups mirror the per-user
//   layout at `DATA_DIR/backups/<ts>/users/<username>/`, rotate every 30 min and
//   keep 24 generations — ~12 h of restorable copies. So: wipe the directory, and
//   the next read restores the whole book and writes it back to disk. The route
//   returned 200, the directory really was gone, and the data is back. The only
//   trace is a `log.warn`.
//
// ⇒ a fixture YOUNGER than one 30-min rotation has no backup, so the incomplete
// wipe passes. `account-deletion.test.ts` therefore plants backup generations
// explicitly and asserts they exist BEFORE the wipe, rather than trusting the age
// of a throwaway account.
//
// ── What is NOT wiped, and why ────────────────────────────────────────────────
//
// `DATA_DIR/option-trade-journal.jsonl` is shared, append-only, and stamps rows
// with `account?: string` (TRA-1475). It is outside the per-user tree, so no
// directory wipe touches it. The ticket offered two options; both are worse than
// they look, so this module does NEITHER and tombstones the identity instead
// (see `deleted-accounts.ts`):
//
//  • PURGE the rows — the journal is the firm's demo option ledger and feeds
//    board-graded numbers (TRA-2300 `quotedH`, TRA-2310 `maxSpreadCrossR`,
//    TRA-2347, TRA-2242). Deleting rows silently shrinks a pinned `n` and breaks
//    the append-only integrity census (TRA-1681).
//  • ANONYMISE `account` — strictly worse. A row with no `account` is
//    indistinguishable from a pre-TRA-1475 row, and those are KEPT by the desk
//    filter while being DROPPED by the per-book fold. Blanking the field would
//    therefore INJECT a deleted book's rows into the firm-wide desk numbers: a
//    privacy fix that corrupts the board's P&L.
//
// ── Ordering is load-bearing ──────────────────────────────────────────────────
//
// The caller must stop the engines (`destroyUserContext`) and remove the
// credential row (`deleteUser`) BEFORE calling this. Otherwise a debounced
// persist timer (`scheduleStocksPersist`) or a request arriving on the still-valid
// token re-creates `users/<username>/` moments after the wipe.
//
// Within the wipe, the primary directory goes first and the backups second: a
// `rotateBackups()` firing mid-wipe copies per-file with `if (!existsSync(src))
// continue`, so once the primary is gone a racing rotation has nothing to copy.
// The window is small, not zero — hence `resweep`, which re-runs both deletes
// after the fact and REPORTS what it found rather than quietly cleaning up.

import { readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import { recordAccountTombstone, type TombstoneVia } from './deleted-accounts.js';
import { revokeResetTokensFor } from './auth.js';
import { forgetTwoFactorState } from './two-factor.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'account-deletion' });

/**
 * What a wipe actually did — designed so a BROKEN wipe cannot read like a healthy
 * one.
 *
 * `backupGenerationsPurged: 0` is ALSO the healthy steady state for an account
 * young enough to have never been backed up (the TRA-2417 `filesCompacted: 0`
 * shape). So the receipt reports three separate numbers:
 *
 *  • `backupGenerationsScanned`  — how many generations exist at all.
 *  • `backupGenerationsWithData` — how many CONTAINED this user before the wipe.
 *    This is the one that says whether the run had any teeth; `0` here means the
 *    backup channel was never exercised, not that it was cleared.
 *  • `backupGenerationsRemaining` — how many still contain the user AFTER the
 *    re-sweep. This is the verdict, and it must be `0`.
 */
export interface AccountWipeReceipt {
  username: string;
  /** ms-epoch recorded on the tombstone; the identity epoch every guard reads. */
  deletedAt: number;
  primaryDirExisted: boolean;
  primaryDirRemoved: boolean;
  /**
   * True when `users/<username>/` came BACK between the first delete and the
   * re-sweep — i.e. a late persist or a request on the dead token recreated it.
   * Always false on a healthy wipe; a `true` here means the caller's ordering is
   * wrong, not that the wipe failed.
   */
  primaryDirReappeared: boolean;
  backupGenerationsScanned: number;
  backupGenerationsWithData: number;
  backupGenerationsPurged: number;
  backupGenerationsRemaining: number;
  resetTokensRevoked: number;
  twoFactorStateCleared: number;
  /**
   * Non-fatal failures (permission, locked file). Non-empty ⇒ `ok` is false.
   *
   * ⚠️ These strings are labelled with ABSOLUTE `DATA_DIR` paths (`primary:…`,
   * `backup:…`) and are for the operator log ONLY. Never put this array on the
   * wire — send `redactWipeReceipt()` instead.
   */
  errors: string[];
  /** The single verdict: nothing restorable is left anywhere. */
  ok: boolean;
}

/**
 * The receipt as the CLIENT is allowed to see it — counts and verdicts, no
 * server-side strings.
 *
 * This is a WHITELIST, and deliberately so. The tempting form is
 * `{ ...receipt, errors: undefined }`, but that ships every field the receipt
 * grows later, and the next one to carry a path would leak on the day it is
 * added with nothing here to notice. Listing the safe fields means a new field
 * is invisible to the client until someone decides it is safe.
 *
 * `errorCount` is kept because the user is being told "some data could not be
 * removed" and a number is the difference between a report and a shrug; the
 * strings behind it stay in `log.error`, which is where an operator reads them.
 */
export interface PublicAccountWipeReceipt {
  username: string;
  deletedAt: number;
  primaryDirExisted: boolean;
  primaryDirRemoved: boolean;
  primaryDirReappeared: boolean;
  backupGenerationsScanned: number;
  backupGenerationsWithData: number;
  backupGenerationsPurged: number;
  backupGenerationsRemaining: number;
  resetTokensRevoked: number;
  twoFactorStateCleared: number;
  errorCount: number;
  ok: boolean;
}

/** Strip the operator-only strings out of a wipe receipt before it goes on the wire. */
export function redactWipeReceipt(receipt: AccountWipeReceipt): PublicAccountWipeReceipt {
  return {
    username: receipt.username,
    deletedAt: receipt.deletedAt,
    primaryDirExisted: receipt.primaryDirExisted,
    primaryDirRemoved: receipt.primaryDirRemoved,
    primaryDirReappeared: receipt.primaryDirReappeared,
    backupGenerationsScanned: receipt.backupGenerationsScanned,
    backupGenerationsWithData: receipt.backupGenerationsWithData,
    backupGenerationsPurged: receipt.backupGenerationsPurged,
    backupGenerationsRemaining: receipt.backupGenerationsRemaining,
    resetTokensRevoked: receipt.resetTokensRevoked,
    twoFactorStateCleared: receipt.twoFactorStateCleared,
    errorCount: receipt.errors.length,
    ok: receipt.ok,
  };
}

// ── The two decisions the route makes, lifted out so they are testable ────────
//
// `packages/server` has no route-level test harness (see the note in
// `reports/demo-calendar-fill-scope.ts`). Left inline in `index.ts`, the refusal
// rules and — more importantly — the ORDER of the delete steps would be asserted
// by nothing at all, and the order is the entire fix: reverse any two of them and
// the book comes back while every other test in this file still passes.

/** Why a self-delete was refused, or `null` when it may proceed. */
export type SelfDeleteRefusal =
  | { code: 'operator_book'; status: 403; message: string }
  | { code: 'last_admin'; status: 409; message: string };

/**
 * TRA-2421 — may this account delete ITSELF?
 *
 * `isOperatorBook` is passed in rather than imported so this stays a pure
 * decision, but the route MUST pass `isReservedOperatorBookName` — the same
 * predicate that guards signup (TRA-2407). A name that may not be registered must
 * not be self-destructible either, and two copies of that list would drift.
 */
export function refuseSelfDelete(args: {
  username: string;
  role: 'admin' | 'user';
  adminCount: number;
  isOperatorBook: (username: string) => boolean;
}): SelfDeleteRefusal | null {
  if (args.isOperatorBook(args.username)) {
    return {
      code: 'operator_book',
      status: 403,
      message: 'Operator accounts cannot be deleted from Settings. Contact an administrator.',
    };
  }
  // Checked on the LAST admin only. An admin who is not the last one is an
  // ordinary user as far as this route is concerned.
  if (args.role === 'admin' && args.adminCount <= 1) {
    return {
      code: 'last_admin',
      status: 409,
      message: 'This is the last administrator account. Promote another admin first.',
    };
  }
  return null;
}

/** The side effects the delete sequence needs, injected so the order is assertable. */
export interface SelfDeletePorts {
  /** Stop engines + clear debounced persist timers (`destroyUserContext`). */
  destroyContext: (username: string) => void;
  /** Remove the credential row (`deleteUser`). False ⇒ the user was already gone. */
  deleteCredentialRow: (username: string) => Promise<boolean>;
  /** Hang up live websockets. */
  closeSockets: (username: string) => number;
  /** Destroy the files (`wipeAccountData`). */
  wipe: (username: string) => Promise<AccountWipeReceipt>;
}

export type SelfDeleteOutcome =
  | { ok: true; receipt: AccountWipeReceipt; socketsClosed: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'residue'; receipt: AccountWipeReceipt; socketsClosed: number };

/**
 * TRA-2421 — run the delete in the ONE order that actually destroys the account.
 *
 *   1. `destroyContext` — a pending `scheduleStocksPersist` would otherwise
 *      rewrite `trades-stocks.json` seconds after the wipe.
 *   2. `deleteCredentialRow` — this is what makes `requireAuth` start refusing
 *      the caller's still-valid token, so no in-flight request can rebuild the
 *      context underneath the wipe. It must land BEFORE the files go.
 *   3. `closeSockets` — the WS is a second door to `ensureUserContext`.
 *   4. `wipe` — only now, with nothing left that can recreate the directory.
 *
 * A `deleteCredentialRow` that returns false stops the sequence: without step 2
 * the token stays live, so wiping anyway would just hand the restore path a
 * missing primary to heal from.
 */
export async function performSelfDelete(
  username: string,
  ports: SelfDeletePorts,
): Promise<SelfDeleteOutcome> {
  ports.destroyContext(username);
  const removed = await ports.deleteCredentialRow(username);
  if (!removed) return { ok: false, reason: 'not_found' };
  const socketsClosed = ports.closeSockets(username);
  const receipt = await ports.wipe(username);
  return receipt.ok
    ? { ok: true, receipt, socketsClosed }
    : { ok: false, reason: 'residue', receipt, socketsClosed };
}

function userDirIn(root: string, username: string): string {
  return join(root, 'users', username);
}

/** Timestamped backup generations, oldest first. Missing backup root ⇒ `[]`. */
async function backupGenerations(dataDir: string): Promise<string[]> {
  const backupRoot = join(dataDir, 'backups');
  if (!existsSync(backupRoot)) return [];
  try {
    return (await readdir(backupRoot))
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort()
      .map((n) => join(backupRoot, n));
  } catch (err: unknown) {
    log.warn('account-deletion: cannot list backups', {
      backupRoot,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Does this generation hold anything for `username`? */
async function generationHasUser(generation: string, username: string): Promise<boolean> {
  const dir = userDirIn(generation, username);
  if (!existsSync(dir)) return false;
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    // A path that exists but cannot be stat'ed is not provably clean.
    return true;
  }
}

/**
 * Remove one account's persisted state everywhere it can be reached by a file
 * delete, record the tombstone, and revoke the identity-keyed credential paths
 * that live OUTSIDE `users/<username>/`.
 *
 * The tombstone is written FIRST. If this function dies half way through, the
 * restore guard and the journal scope are already armed against the leftovers,
 * which is the failure direction that can only make a red.
 */
export async function wipeAccountData(
  username: string,
  opts: { dataDir?: string; now?: number; via?: TombstoneVia } = {},
): Promise<AccountWipeReceipt> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const errors: string[] = [];

  const tombstone = recordAccountTombstone(username, {
    deletedAt: opts.now,
    via: opts.via ?? 'self',
    dataDir,
  });

  const primaryDir = userDirIn(dataDir, username);
  const primaryDirExisted = existsSync(primaryDir);

  const removeDir = async (dir: string, label: string): Promise<boolean> => {
    try {
      await rm(dir, { recursive: true, force: true });
      return !existsSync(dir);
    } catch (err: unknown) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  // 1. Primary first — see the ordering note in the module header.
  await removeDir(primaryDir, `primary:${primaryDir}`);

  // 2. Every backup generation, not just the latest. `tryRestoreFromBackup` only
  //    ever reads the newest one, but the newest one is a moving target: prune
  //    keeps 24, and leaving generation N-1 behind means the book returns the
  //    moment the current newest is rotated out.
  const generations = await backupGenerations(dataDir);
  let withData = 0;
  let purged = 0;
  for (const generation of generations) {
    if (!(await generationHasUser(generation, username))) continue;
    withData += 1;
    if (await removeDir(userDirIn(generation, username), `backup:${generation}`)) purged += 1;
  }

  // 3. Re-sweep. `rotateBackups()` runs on a 30-min timer and a debounced persist
  //    can land late, so both deletes are re-run and anything found is REPORTED —
  //    a silent second cleanup would hide a caller-ordering bug forever.
  const primaryDirReappeared = existsSync(primaryDir);
  if (primaryDirReappeared) {
    log.warn('account-deletion: primary dir reappeared mid-wipe — re-removing', { username, primaryDir });
    await removeDir(primaryDir, `primary-resweep:${primaryDir}`);
  }
  let remaining = 0;
  for (const generation of await backupGenerations(dataDir)) {
    if (!(await generationHasUser(generation, username))) continue;
    if (await removeDir(userDirIn(generation, username), `backup-resweep:${generation}`)) {
      purged += 1;
      continue;
    }
    remaining += 1;
  }

  // 4. Identity-keyed credential paths outside the per-user tree. An outstanding
  //    password-reset code for a deleted name is a live route onto whatever
  //    account next holds that name.
  let resetTokensRevoked = 0;
  let twoFactorStateCleared = 0;
  try {
    resetTokensRevoked = revokeResetTokensFor(username);
  } catch (err: unknown) {
    errors.push(`reset-tokens: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    twoFactorStateCleared = forgetTwoFactorState(username);
  } catch (err: unknown) {
    errors.push(`two-factor: ${err instanceof Error ? err.message : String(err)}`);
  }

  const receipt: AccountWipeReceipt = {
    username,
    deletedAt: tombstone.deletedAt,
    primaryDirExisted,
    primaryDirRemoved: !existsSync(primaryDir),
    primaryDirReappeared,
    backupGenerationsScanned: generations.length,
    backupGenerationsWithData: withData,
    backupGenerationsPurged: purged,
    backupGenerationsRemaining: remaining,
    resetTokensRevoked,
    twoFactorStateCleared,
    errors,
    ok: false,
  };
  receipt.ok = receipt.primaryDirRemoved && receipt.backupGenerationsRemaining === 0 && errors.length === 0;

  log[receipt.ok ? 'info' : 'error']('account-deletion: wipe complete', { ...receipt });
  return receipt;
}
