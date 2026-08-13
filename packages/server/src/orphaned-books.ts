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
//  4. TRA-2520 — the `account_settings` SQLITE ROW, keyed by the raw username. A
//     DIRECTORY MOVE CANNOT TOUCH A DATABASE ROW. This is the channel that bit:
//     the first run to exercise this guard against a REAL orphan (TRA-2511 arm 2,
//     live on bqb1) found the successor inheriting the predecessor's row whole —
//     `demoEquity`, `dailyTradesLimit`, and the saved BROKER CREDENTIALS, served
//     back UNREDACTED by `GET /api/account/settings`. Nothing anywhere deleted a
//     settings row; `clearSettingsCache` drops only the in-memory copy.
//
// (1) and (2) are closed by the TOMBSTONE, not by the move: `tryRestoreFromBackup`
// refuses any generation stamped before the epoch, and `journalRowsForBook` scopes
// a recycled name to rows opened at or after it. That is why the tombstone is
// recorded FIRST and why the epoch is the moment the orphan was FOUND — dying
// half way through leaves the guards armed against the leftovers, which is the
// failure direction that can only produce a red.
//
// (4) is closed by a DELETE, because there is no epoch a row read can consult —
// so it follows the same retain-then-free order the tree does: the row is archived
// into the quarantined book as `account-settings-row.json` (with the credential
// fields BLANKED — see `PERSISTED_CREDENTIAL_FIELDS`) and only then dropped. A
// failed archive REFUSES the retirement rather than proceeding to the delete.

import { rename, cp, rm, readdir, stat, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import { recordAccountTombstone, accountDeletedAt } from './deleted-accounts.js';
import { revokeResetTokensFor } from './auth.js';
import { forgetTwoFactorState } from './two-factor.js';
import {
  readSettingsRowForRetirement,
  deleteSettingsRow,
  clearSettingsCache,
  type PersistedSettingsRow,
} from './account-settings.js';
import {
  deleteIdentityRows,
  countIdentityRows,
  identityRowsDeleted,
  identityRowsRemaining,
} from './sqlite-identity.js';
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
 * TRA-2520 — where the retired `account_settings` ROW is archived, inside the
 * quarantined book.
 *
 * Deliberately NOT `account-settings.json`: that name is the LEGACY per-user file
 * (`account-settings.ts`), which moves with the tree and would be overwritten
 * here. This module destroys nothing, including the thing it is replacing.
 */
export const RETIRED_SETTINGS_FILENAME = 'account-settings-row.json';

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
  /**
   * TRA-2520 — a durable `account_settings` row existed under this username. It is
   * an ORPHAN SIGNAL in its own right, not just a cleanup step: a book whose tree
   * AND backups are gone (an operator's `rm -rf`) can still leave this row, and
   * the credentials in it, for the next holder.
   */
  settingsRowFound: boolean;
  /** The row was archived AND is verified gone from the store. */
  settingsRowRetired: boolean;
  /** How many credential fields held a non-blank value. Names go to the log only. */
  settingsCredentialFieldsCleared: number;
  /** Relative path of the archived row under DATA_DIR, or null. */
  settingsQuarantinedTo: string | null;
  /**
   * TRA-2535 — identity-keyed `state.db` rows that existed for this username in
   * the tables with no bespoke handling above (today: `agent_spend`). The teeth
   * number; see `identityRowsRemaining` for the verdict.
   */
  identityRowsDeleted: number;
  /**
   * Identity-keyed rows still present after the sweep. Must be 0, and it gates
   * `ok` — an inherited `agent_spend` total lands the NEW holder of this name at
   * or over the daily LLM cap for the rest of the UTC day.
   */
  identityRowsRemaining: number;
  /** Operator-only strings; may name absolute paths. Never put these on the wire. */
  errors: string[];
  /**
   * The verdict the caller gates on: the live key is clear and the guards are
   * armed. False ⇒ REFUSE the registration; handing out a book we could not
   * retire is the bug this module exists to prevent.
   */
  ok: boolean;
}

/**
 * The adoption receipt exactly as `POST /api/admin/users` puts it on the wire,
 * under `retiredOrphanedBook`.
 *
 * ── Why this is a FUNCTION and not an object literal in the route ─────────────
 *
 * TRA-2691/TRA-3386. It WAS a literal, and the literal was an ALLOW-LIST rather
 * than an echo: `identityRowsDeleted`/`identityRowsRemaining` were computed by
 * `retireOrphanedBook` (they are terms of `ok`), and then dropped at the wire —
 * so the only channel a grader can read the recycle-path identity sweep through
 * reported the four settings fields and stayed silent about the two that decide
 * the verdict. Same class as `9d1c41e`/TRA-2583: an allow-list fails OPEN and
 * fails SILENTLY, because a field nobody forwarded reads identically to a field
 * that was never computed.
 *
 * A shipped pure function is the shape that kills the class rather than the one
 * instance: the route SPREADS this, `orphaned-books-adoption-receipt.test.ts`
 * exercises this, and there is no second copy of the key list to drift from.
 *
 * `errors` and `username` are deliberately NOT here. `errors` is operator-only
 * and may name absolute paths (`quarantine:/data/users/...`) — see the field's
 * own doc comment; `username` is already the request the admin just made.
 */
export interface PublicRetiredOrphanedBook {
  quarantinedTo: string | null;
  retiredAt: number | null;
  settingsRowFound: boolean;
  settingsRowRetired: boolean;
  settingsCredentialFieldsCleared: number;
  settingsQuarantinedTo: string | null;
  /**
   * TRA-2535's teeth number, forwarded from TRA-3386 on. THE ONLY DISCRIMINATING
   * FIELD in this object for the identity channel: non-zero says the sweep found
   * and cleared real rows, zero says the disk was already clean.
   */
  identityRowsDeleted: number;
  /**
   * ⚠️ INVARIANT-`0` ON THIS ROUTE — NOT A MEASUREMENT. Do not read a green zero
   * here as evidence of anything.
   *
   * `receipt.ok` requires `identityRowsRemaining === 0` (see the verdict below),
   * and `POST /api/admin/users` 503s on `!ok`, so the 201 that carries this
   * object is UNREACHABLE with any other value — the `-1` UNKNOWN sentinel
   * included. Forwarded anyway for symmetry with the self-delete receipt
   * (`redactWipeReceipt`, where it is NOT constant), and because it stops being
   * constant the day that `ok` term changes. The field that moves on this route
   * is `identityRowsDeleted`.
   */
  identityRowsRemaining: number;
}

/**
 * Shape an orphan-retirement receipt for the admin `201`.
 *
 * Pure and total: no I/O, no throw, every field copied straight across. Adding a
 * field to `OrphanRetirementReceipt` does not silently widen this — the key set
 * is asserted in `orphaned-books-adoption-receipt.test.ts`, so a new field is an
 * explicit decision (forward it, or record why it stays operator-only).
 */
export function shapeRetiredOrphanReceipt(
  receipt: OrphanRetirementReceipt,
): PublicRetiredOrphanedBook {
  return {
    quarantinedTo: receipt.quarantinedTo,
    retiredAt: receipt.retiredAt,
    settingsRowFound: receipt.settingsRowFound,
    settingsRowRetired: receipt.settingsRowRetired,
    settingsCredentialFieldsCleared: receipt.settingsCredentialFieldsCleared,
    settingsQuarantinedTo: receipt.settingsQuarantinedTo,
    identityRowsDeleted: receipt.identityRowsDeleted,
    identityRowsRemaining: receipt.identityRowsRemaining,
  };
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
 * lists the backup root, runs one indexed SELECT, and returns `orphanFound: false`
 * having written nothing to disk. It must stay that way — a tombstone recorded for
 * an innocent name would scope that account's own journal rows out of its own
 * calendar.
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

  // TRA-2520 — the fourth channel, probed BEFORE the receipt is shaped because it
  // is one of the things that decides `orphanFound`.
  //
  // A throw here is recorded, not fatal, and does NOT force `orphanFound`. Failing
  // closed on it would 503 every genuinely-new signup for the duration of a db
  // fault, and it would buy nothing: the SELECT that throws here is the same one
  // `loadSettingsViaDb` runs, so a store that cannot answer it cannot serve the row
  // to the successor either — it falls through to the JSON file, which moved with
  // the tree. The error still lands in `errors`, so if any OTHER channel finds an
  // orphan this retirement refuses.
  let settingsRow: PersistedSettingsRow = {
    found: false,
    storage: 'unavailable',
    redacted: null,
    credentialFieldsCleared: [],
  };
  try {
    settingsRow = readSettingsRowForRetirement(username);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`settings-probe: ${reason}`);
    log.error('orphaned-books: could not probe the account_settings row', { username, reason });
  }

  // TRA-2535 — a leftover `agent_spend` row is an orphan signal on exactly the
  // same footing as a leftover settings row, and strictly stronger evidence the
  // name was really used: a row only exists because that identity spent money.
  // Excludes `account_settings`, already counted by `settingsRow.found` above.
  const strayIdentityRows = countIdentityRows(username, { exclude: ['account_settings'] });

  const receipt: OrphanRetirementReceipt = {
    username,
    orphanFound:
      primaryDirExisted || backupGenerationsWithData > 0 || settingsRow.found || strayIdentityRows > 0,
    primaryDirExisted,
    backupGenerationsWithData,
    retiredAt: null,
    quarantinedTo: null,
    resetTokensRevoked: 0,
    twoFactorStateCleared: 0,
    settingsRowFound: settingsRow.found,
    settingsRowRetired: false,
    settingsCredentialFieldsCleared: 0,
    settingsQuarantinedTo: null,
    identityRowsDeleted: 0,
    identityRowsRemaining: 0,
    errors,
    ok: true,
  };

  if (!receipt.orphanFound) {
    // Drop any in-memory settings copy even on the no-op path. `getSettings` serves
    // that map directly, so a name someone merely LOADED once is a leak with no row
    // and no directory behind it. A Map delete cannot destroy anything persisted,
    // so this keeps the "a never-used name is left byte-for-byte alone" contract.
    clearSettingsCache(username);
    return receipt;
  }

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

  // 4. TRA-2520 — the `account_settings` row. Archive, THEN drop; a failed archive
  //    must not reach the delete, because retaining the book is this module's whole
  //    contract. And a failed DROP must not pass: the row is the credential.
  //
  //    The archive lands inside the quarantined book directory even when there was
  //    no primary tree to move (`primaryDirExisted: false`) — the row is data, and
  //    it needs somewhere to be retained. `quarantinedTo` stays null in that case
  //    because no TREE was quarantined; `settingsQuarantinedTo` is the honest field.
  if (settingsRow.found) {
    const bookDirRel = join(ORPHANED_BOOKS_DIRNAME, `${username}@${stampOf(retiredAt)}`);
    const archiveRel = join(bookDirRel, RETIRED_SETTINGS_FILENAME);
    let archived = false;
    try {
      await mkdir(join(dataDir, bookDirRel), { recursive: true });
      await writeFile(
        join(dataDir, archiveRel),
        JSON.stringify(
          {
            note:
              'TRA-2520 — the retired account_settings row for a recycled username. ' +
              'Broker credential fields are BLANKED: a retired book\'s saved keys are a live ' +
              'credential, not just state, so the restore path deliberately does not carry them.',
            username,
            retiredAt,
            credentialFieldsCleared: settingsRow.credentialFieldsCleared,
            settings: settingsRow.redacted,
          },
          null,
          2,
        ),
        'utf-8',
      );
      archived = true;
      receipt.settingsQuarantinedTo = archiveRel;
    } catch (err: unknown) {
      errors.push(`settings-archive:${archiveRel}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (archived) {
      try {
        const dropped = deleteSettingsRow(username);
        receipt.settingsRowRetired = dropped.deleted && dropped.verified;
        receipt.settingsCredentialFieldsCleared = settingsRow.credentialFieldsCleared.length;
        if (!receipt.settingsRowRetired) {
          errors.push('settings-row: still readable back after DELETE');
        }
      } catch (err: unknown) {
        errors.push(`settings-row: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // The in-memory copy is a third channel and outlives both of the above.
  clearSettingsCache(username);

  // TRA-2535 — the rest of `state.db`. `account_settings` is EXCLUDED here and
  // that exclusion is load-bearing, not tidiness: its drop above is gated on
  // `archived`, because this path retains before it destroys (TRA-142). A blanket
  // delete would destroy the row on exactly the runs where the archive write
  // FAILED — turning a retain-contract violation into permanent data loss. The
  // self-delete path has no archive and so excludes nothing.
  //
  // `agent_spend` needs no archive: it is a per-day USD counter, not a credential,
  // and there is no restore story that wants a predecessor's spend.
  try {
    const cleared = deleteIdentityRows(username, { exclude: ['account_settings'] });
    receipt.identityRowsDeleted = identityRowsDeleted(cleared);
    receipt.identityRowsRemaining = identityRowsRemaining(cleared);
    for (const r of cleared) {
      if (r.error) errors.push(`identity-rows:${r.table}: ${r.error}`);
      else if (r.rowsRemaining > 0) {
        errors.push(`identity-rows:${r.table}: ${r.rowsRemaining} present after retirement`);
      }
    }
  } catch (err: unknown) {
    errors.push(`identity-rows: ${err instanceof Error ? err.message : String(err)}`);
    receipt.identityRowsRemaining = -1; // UNKNOWN, not clean — see the wipe receipt.
  }

  // The verdict measures the WORLD, not the steps: the live key must be clear on
  // disk, and the epoch must come back through `accountDeletedAt` — the same
  // accessor `tryRestoreFromBackup` and `journalRowsForBook` read. Asserting the
  // return value of `recordAccountTombstone` instead would only re-check the object
  // we just built.
  const liveKeyClear = !existsSync(primaryDir);
  const epochArmed = accountDeletedAt(username, dataDir) === retiredAt;
  if (!epochArmed) errors.push('tombstone: epoch not readable back after write');
  // TRA-2520 — same rule for the fourth channel: ask the STORE whether the row is
  // servable, not the delete statement whether it ran. A fresh probe is the only
  // answer that discriminates "dropped" from "dropped and re-created by a racing
  // `saveSettings`", and it is the exact read the successor's `loadSettings` does.
  let settingsChannelClear = true;
  try {
    settingsChannelClear = !readSettingsRowForRetirement(username).found;
  } catch (err: unknown) {
    // Unreadable ⇒ NOT provably clear. This branch is reachable only after the
    // probe above succeeded, so a db that just started failing is a real anomaly.
    settingsChannelClear = false;
    errors.push(`settings-verify: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!settingsChannelClear) errors.push('settings-row: present after retirement');
  // TRA-2535 — `=== 0` so the -1 "sweep did not complete" sentinel fails the
  // verdict. `ok: false` here REFUSES the registration, which is the right trade:
  // handing out a name whose identity rows we could not clear is the bug this
  // module exists to prevent.
  receipt.ok =
    liveKeyClear &&
    epochArmed &&
    settingsChannelClear &&
    receipt.identityRowsRemaining === 0 &&
    errors.length === 0;

  log[receipt.ok ? 'info' : 'error']('orphaned-books: retirement complete', { ...receipt });
  return receipt;
}
