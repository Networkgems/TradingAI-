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
// ── A FILE delete cannot reach a DATABASE row (TRA-2513) ──────────────────────
//
// Everything above is about files, and for two years everything this account owned
// WAS a file. TRA-1052 moved `account-settings` into a SQLite table
// (`DATA_DIR/state.db`, one blob row keyed by the raw username), and nothing in
// this module — or anywhere else — ever deleted one. So `DELETE /api/account`,
// the route whose entire promise is "wipe my data", returned a green receipt while
// the row survived, carrying the saved BROKER CREDENTIALS (`liveApiKeyStocks`,
// `liveApiSecretCrypto`, the per-env options pairs — see
// `PERSISTED_CREDENTIAL_FIELDS`) and `GET /api/account/settings` serves that blob
// UNREDACTED.
//
// This is the SAME defect TRA-2520 fixed on the ADOPTION side, at the other call
// site. The two halves are not interchangeable and neither one covers the other:
//
//  • TRA-2520 / `retireOrphanedBook` runs at SIGNUP, so it only ever fires for a
//    name that is being re-registered. It ARCHIVES the row (credentials blanked)
//    before dropping it, because the admin-delete path it defends deliberately
//    retains data (TRA-142).
//  • This half runs at DELETE, on the one path where the user ASKED for
//    destruction. So it DESTROYS: no archive, no quarantined copy. And it fires
//    whether or not the name is ever reused — which is the case TRA-2520 can
//    never reach, and the one that matters for "did my credentials actually go?"
//
// The channel is verified the same way the directory is: by asking the STORE
// whether the row is servable afterwards, not by trusting the DELETE's own
// `changes` count. A row dropped and immediately re-created by a racing
// `saveSettings` reports `deleted: true` and is still a leak.
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
//
// The settings row goes LAST, after that re-sweep, for the same reason: it is the
// step whose verification is a single point-in-time read, so it should run at the
// point where anything that could still be writing has already been observed.

import { readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import { recordAccountTombstone, type TombstoneVia } from './deleted-accounts.js';
import { revokeResetTokensFor } from './auth.js';
import { forgetTwoFactorState } from './two-factor.js';
import {
  readSettingsRowForRetirement,
  deleteSettingsRow,
  clearSettingsCache,
} from './account-settings.js';
import {
  deleteIdentityRows,
  identityRowsDeleted as sumIdentityRowsDeleted,
  identityRowsRemaining as sumIdentityRowsRemaining,
} from './sqlite-identity.js';
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
   * TRA-2513 — a durable `account_settings` row existed under this username.
   *
   * `false` is ALSO the answer when the SQLite store is unavailable (TRA-1681
   * fail-soft), and that is honest rather than a hole: in that mode settings live
   * in `users/<name>/account-settings.json`, which the primary-directory delete
   * above already destroyed. There is no third state where a row exists and this
   * reads false.
   */
  settingsRowExisted: boolean;
  /** The row is verified GONE from the store by a fresh read, not by a `changes` count. */
  settingsRowRemoved: boolean;
  /**
   * How many credential fields held a non-blank value at the moment of the delete.
   * A COUNT, never the names and never the values — this number is the difference
   * between "your settings were removed" and "your saved broker keys were removed".
   */
  settingsCredentialFieldsCleared: number;
  /**
   * TRA-2535 — identity-keyed `state.db` rows that EXISTED for this username
   * across every table in `IDENTITY_TABLES` (today: `account_settings` and
   * `agent_spend`). The "did this run have teeth" number, in the same spirit as
   * `backupGenerationsWithData`.
   *
   * Usually 0 for `account_settings` specifically, because the block above has
   * already dropped it by the time this sweep runs — this number is dominated by
   * the tables that have no bespoke handling.
   */
  identityRowsDeleted: number;
  /**
   * Identity-keyed rows STILL present afterwards, summed across tables. The
   * verdict, and it must be 0 — without it, `identityRowsDeleted: 0` reads as
   * healthy on the day a DELETE silently stops matching.
   */
  identityRowsRemaining: number;
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
  settingsRowExisted: boolean;
  settingsRowRemoved: boolean;
  settingsCredentialFieldsCleared: number;
  identityRowsDeleted: number;
  identityRowsRemaining: number;
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
    settingsRowExisted: receipt.settingsRowExisted,
    settingsRowRemoved: receipt.settingsRowRemoved,
    settingsCredentialFieldsCleared: receipt.settingsCredentialFieldsCleared,
    identityRowsDeleted: receipt.identityRowsDeleted,
    identityRowsRemaining: receipt.identityRowsRemaining,
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

  // 5. TRA-2513 — the `account_settings` SQLite row. A directory delete cannot
  //    reach it, so every step above ran and left the saved broker credentials
  //    exactly where they were.
  //
  //    Probe FIRST: the credential count has to be read while the row still
  //    exists, and it is the number the user is told. Unlike TRA-2520's
  //    retirement there is no archive — this is the destroy path, and writing the
  //    blob to disk here would re-create the leak somewhere the wipe does not look.
  let settingsRowExisted = false;
  let settingsCredentialFieldsCleared = 0;
  let settingsRowRemoved = false;
  try {
    const row = readSettingsRowForRetirement(username);
    settingsRowExisted = row.found;
    settingsCredentialFieldsCleared = row.credentialFieldsCleared.length;
  } catch (err: unknown) {
    // A destroy that cannot see the channel is NOT a clean destroy — this pushes
    // an error and therefore fails `ok`, which is the opposite of the retirement
    // path's fail-soft. The asymmetry is deliberate: there, a db fault must not
    // 503 an innocent signup; here, the user asked for their credentials to be
    // gone and "I could not check" is not an answer we should return as green.
    errors.push(`settings-probe: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // Runs unconditionally, even when the probe said `found: false` — it also
    // drops the in-memory copy (`getSettings` serves that map directly), which is
    // a third live channel that no row check can see.
    deleteSettingsRow(username, { reason: 'deleted' });
  } catch (err: unknown) {
    errors.push(`settings-row: ${err instanceof Error ? err.message : String(err)}`);
    clearSettingsCache(username);
  }
  // The verdict asks the STORE, not the statement. This is the exact read a future
  // holder of the name would get from `loadSettings`, and it is the only thing that
  // discriminates "dropped" from "dropped and re-created by a racing write".
  try {
    settingsRowRemoved = !readSettingsRowForRetirement(username).found;
  } catch (err: unknown) {
    settingsRowRemoved = false;
    errors.push(`settings-verify: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!settingsRowRemoved) errors.push('settings-row: present after wipe');

  // 6. TRA-2535 — the REST of `state.db`. `account_settings` was never the only
  //    username-keyed row: `agent_spend` (agent-spend-store.ts) is keyed by the
  //    same recyclable name in a column called `user`, and no code path in this
  //    repo had ever deleted a row from EITHER table.
  //
  //    Two consequences, both closed here. A recycled name landing on the
  //    predecessor's running total arrives already at or over the daily LLM cap
  //    (measured live on bqb1: `userCapUsd` is env-overridden to $0.50, so the
  //    inherited quantum that fully halts a new account for the day is fifty
  //    cents, not the $10 in source). And independently of any recycle, a
  //    self-deleted user is told their data is gone while their per-user/day
  //    spend history stays in `state.db` indefinitely.
  //
  //    Runs LAST, after the tree is destroyed, so a crash-restart loop cannot
  //    lose the tombstone before the rows clear — the ordering constraint from
  //    step 5, unchanged. `account_settings` is deliberately NOT excluded: the
  //    delete is idempotent, and if step 5 threw this is a second attempt at it.
  let identityRowsDeleted = 0;
  let identityRowsRemaining = 0;
  try {
    const cleared = deleteIdentityRows(username);
    identityRowsDeleted = sumIdentityRowsDeleted(cleared);
    identityRowsRemaining = sumIdentityRowsRemaining(cleared);
    for (const r of cleared) {
      if (r.error) errors.push(`identity-rows:${r.table}: ${r.error}`);
      else if (r.rowsRemaining > 0) errors.push(`identity-rows:${r.table}: ${r.rowsRemaining} present after wipe`);
    }
  } catch (err: unknown) {
    // Unlike the retirement path this is NOT fail-soft: the user asked for
    // destruction and "I could not clear it" is not a green answer.
    errors.push(`identity-rows: ${err instanceof Error ? err.message : String(err)}`);
    // -1, not 0: the sweep did not complete, so the count is UNKNOWN. A 0 here
    // would be the exact "no-op reads as success" shape this field exists to
    // prevent, and NaN would serialise to `null` on the wire.
    identityRowsRemaining = -1;
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
    settingsRowExisted,
    settingsRowRemoved,
    settingsCredentialFieldsCleared,
    identityRowsDeleted,
    identityRowsRemaining,
    errors,
    ok: false,
  };
  receipt.ok =
    receipt.primaryDirRemoved &&
    receipt.backupGenerationsRemaining === 0 &&
    receipt.settingsRowRemoved &&
    // TRA-2535 — `=== 0` and not `<= 0`, so the -1 "sweep did not complete"
    // sentinel fails the verdict rather than passing it.
    receipt.identityRowsRemaining === 0 &&
    errors.length === 0;

  log[receipt.ok ? 'info' : 'error']('account-deletion: wipe complete', { ...receipt });
  return receipt;
}
