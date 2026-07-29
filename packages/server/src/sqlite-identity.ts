// TRA-2535 — the registry of IDENTITY-KEYED tables in `state.db`, and the one
// helper that clears them.
//
// ── Why this file exists at all ───────────────────────────────────────────────
//
// TRA-2513 / TRA-2520 fixed `account_settings`: a SQLite row keyed by the RAW,
// RECYCLABLE username, living outside `users/<username>/`, that no delete path
// could reach — because a directory wipe and a directory move cannot touch a
// database row. Both halves landed as an inline `DELETE FROM account_settings`
// at their own call site.
//
// `account_settings` was not the only one. Measured whole-repo at the then-live
// SHA `9e1b1123`:
//
//   git grep -n "CREATE TABLE"   ->  account-settings.ts:29   account_settings
//                                    agent-spend-store.ts:48  agent_spend
//                                    ... and nothing else, repo-wide.
//   git grep -rn "DELETE FROM"   ->  zero hits, INCLUDING test files.
//
// So `state.db` had exactly two tables, BOTH keyed by the recyclable username,
// and no row in it had ever been deleted by any code path in this repo — there
// was not even a test asserting a delete that was never wired up. TRA-2520's
// "nothing anywhere deletes a settings row" generalised: nothing anywhere
// deleted ANY row.
//
// ── Why a registry rather than a third inline DELETE ──────────────────────────
//
// The recurring shape on this board is closing these ONE NAME AT A TIME
// (TRA-2488 added `/^qtverify/i`; TRA-2524 then found three more). A second
// inline `DELETE FROM agent_spend` fixes today and sets up the next one: a THIRD
// table added to `state.db` in six months inherits the bug silently, because the
// list of identity-keyed tables would live only in whoever last read the code.
//
// `sqlite-identity.test.ts` asserts set-equality between the tables reachable by
// a `CREATE TABLE` in `packages/server/src` and {IDENTITY_TABLES} ∪
// {NON_IDENTITY_TABLES}. A new table therefore forces an EXPLICIT decision —
// register it, or allowlist it with a written reason — instead of relying on
// someone remembering. That gate is the actual deliverable here; the
// `agent_spend` delete below is just the instance that motivated it.
import { getStateDb } from './sqlite.js';
import { forgetAgentSpendForUser } from './agent-spend-store.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'sqlite-identity' });

/** A `state.db` table whose rows are keyed by a recyclable account identity. */
export interface IdentityTable {
  /** Table name exactly as it appears in its `CREATE TABLE`. */
  table: string;
  /** The column holding the raw username. NOT always `username` — see `agent_spend`. */
  column: string;
  /**
   * Drop this table's IN-MEMORY mirror of the same key, if it has one.
   *
   * Load-bearing, not a nicety: both of these tables are write-through caches of
   * a process-global map keyed by the SAME username string. Clearing only the row
   * leaves the map serving the predecessor's value for the rest of the process
   * lifetime, which is the identical defect one layer up.
   */
  forgetInMemory?: (username: string) => void;
}

/**
 * Every `state.db` table keyed by a recyclable account identity.
 *
 * Adding an entry here is what wires a table into `deleteIdentityRows`, and so
 * into BOTH delete paths (`wipeAccountData` at self-delete, `retireOrphanedBook`
 * at adoption/recycle) at once.
 */
export const IDENTITY_TABLES: ReadonlyArray<IdentityTable> = [
  // TRA-2513 / TRA-2520. `column: 'username'`.
  //
  // No `forgetInMemory` hook by design: `account-settings.ts` owns a `cache` map
  // AND an archive-before-destroy contract that differs per call site (the
  // adoption path quarantines the blob first; the self-delete path must not).
  // Both call sites already invoke `clearSettingsCache` on their own schedule, and
  // routing it through here as well would fire it at the wrong point in that
  // sequence. Registered here so the set-equality gate sees it; the DELETE is
  // idempotent with whichever of the two ran first.
  { table: 'account_settings', column: 'username' },
  // TRA-2535. NOTE the column is `user`, not `username` — assuming a uniform
  // column name is exactly how this table would get a no-op DELETE that reports
  // success. The value is the username verbatim: `userKey()` only trims and
  // substitutes 'anonymous' for empty, and the caller passes the owning user
  // straight through (`tryReserveAgentSpend(opts.user, now)`).
  { table: 'agent_spend', column: 'user', forgetInMemory: forgetAgentSpendForUser },
];

/**
 * Tables in `state.db` that are deliberately NOT identity-keyed.
 *
 * Empty today, and that is a MEASUREMENT rather than an oversight: at the SHA
 * this was written, every table in `state.db` was keyed by the recyclable
 * username. It exists so the set-equality gate has a documented escape hatch —
 * a genuinely non-identity table (say a schema-version row) is allowlisted here
 * WITH A REASON rather than by weakening the assertion.
 */
export const NON_IDENTITY_TABLES: ReadonlyArray<{ table: string; reason: string }> = [];

/** What clearing one table's rows for one identity actually did. */
export interface IdentityRowDeletion {
  table: string;
  /**
   * Rows present for this identity BEFORE the delete — did this run have any
   * teeth? `AccountWipeReceipt` already separates `backupGenerationsWithData`
   * (teeth) from `backupGenerationsRemaining` (verdict) precisely so a no-op
   * cannot read like a success; identity rows get the same two numbers, or
   * `rowsRemaining: 0` reads as healthy on the day the DELETE silently stops
   * matching (a renamed column, a changed key).
   */
  rowsBefore: number;
  /**
   * Rows STILL present after the delete — the verdict, and it must be 0.
   *
   * Read with a fresh SELECT rather than the DELETE's own `changes` count,
   * because the failure being closed is "the row is still servable", which is a
   * question about the STORE and not about the statement just run. A row dropped
   * and immediately re-created by a racing write reports a healthy `changes` and
   * is still a leak.
   */
  rowsRemaining: number;
  /** Non-null when this table's delete threw; the table is then NOT provably clear. */
  error: string | null;
}

/** Identifiers are interpolated into SQL, so they may only ever be literals from this file. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Clear every identity-keyed row for `username` from `state.db`.
 *
 * Call this AFTER the directory has been retired/destroyed, so a crash-restart
 * loop cannot lose the tombstone before the rows clear — the ordering constraint
 * TRA-2513 identified applies unchanged.
 *
 * Returns one entry per table attempted. When the durable store is unavailable
 * (TRA-1681 fail-soft) this returns an EMPTY array, which is honest: with no db
 * there are no rows, and reporting fabricated zeroes for tables that do not
 * exist would be a worse answer than reporting nothing.
 *
 * `exclude` skips tables whose delete a caller owns on its own schedule — see
 * `retireOrphanedBook`, where dropping `account_settings` is gated on the
 * archive having been written first (TRA-142 retain-before-destroy).
 */
export function deleteIdentityRows(
  username: string,
  opts: { exclude?: ReadonlyArray<string> } = {},
): IdentityRowDeletion[] {
  const db = getStateDb();
  if (!db) return [];
  const exclude = new Set(opts.exclude ?? []);
  const results: IdentityRowDeletion[] = [];

  for (const entry of IDENTITY_TABLES) {
    if (exclude.has(entry.table)) continue;
    if (!SAFE_IDENTIFIER.test(entry.table) || !SAFE_IDENTIFIER.test(entry.column)) {
      // Unreachable from the const list above; this is here so it stays that way.
      results.push({
        table: entry.table,
        rowsBefore: 0,
        rowsRemaining: 0,
        error: `unsafe identifier in IDENTITY_TABLES: ${entry.table}.${entry.column}`,
      });
      continue;
    }
    const count = (): number => {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ${entry.column} = ?`)
        .get(username) as { n: number } | undefined;
      return row?.n ?? 0;
    };
    let rowsBefore = 0;
    try {
      // A table is created lazily by whichever store owns it, so it may genuinely
      // not exist yet in a process that never touched that store. That is a clean
      // "no rows", not a failure — hence the probe is inside the same try.
      rowsBefore = count();
      db.prepare(`DELETE FROM ${entry.table} WHERE ${entry.column} = ?`).run(username);
      const rowsRemaining = count();
      results.push({ table: entry.table, rowsBefore, rowsRemaining, error: null });
      if (rowsBefore > 0) {
        log.info('identity rows cleared', { table: entry.table, username, rowsBefore, rowsRemaining });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) {
        // The owning store has not run in this process. Nothing to clear, and
        // nothing is being hidden: a table that does not exist holds no rows.
        results.push({ table: entry.table, rowsBefore: 0, rowsRemaining: 0, error: null });
        continue;
      }
      // NOT provably clear. `rowsRemaining` is left at the pre-delete count rather
      // than 0 so a failed delete can never be summed into a healthy verdict.
      results.push({ table: entry.table, rowsBefore, rowsRemaining: rowsBefore, error: message });
      log.error('identity row delete FAILED — rows may still be servable', {
        table: entry.table,
        username,
        reason: message,
      });
    }
    try {
      entry.forgetInMemory?.(username);
    } catch (err: unknown) {
      log.warn('identity in-memory forget failed', {
        table: entry.table,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Count identity-keyed rows for `username` WITHOUT mutating anything.
 *
 * `retireOrphanedBook` treats a surviving `account_settings` row as an ORPHAN
 * SIGNAL in its own right — a book whose tree and backups were removed by hand
 * still leaves the row for the next holder. An `agent_spend` row is the same
 * signal by the same argument, and strictly stronger evidence that the name was
 * genuinely used: a row only exists because that identity spent real money.
 *
 * Throws are swallowed to 0 per table. This feeds a DETECTION predicate at
 * signup, and a db hiccup must not 503 an innocent registration; the delete path
 * is where an unreadable store is treated as a failure.
 */
export function countIdentityRows(username: string, opts: { exclude?: ReadonlyArray<string> } = {}): number {
  const db = getStateDb();
  if (!db) return 0;
  const exclude = new Set(opts.exclude ?? []);
  let total = 0;
  for (const entry of IDENTITY_TABLES) {
    if (exclude.has(entry.table)) continue;
    if (!SAFE_IDENTIFIER.test(entry.table) || !SAFE_IDENTIFIER.test(entry.column)) continue;
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ${entry.column} = ?`)
        .get(username) as { n: number } | undefined;
      total += row?.n ?? 0;
    } catch {
      // Missing table / unreadable store ⇒ contributes no signal.
    }
  }
  return total;
}

/** Rows that were actually there before the delete — the "did this have teeth" number. */
export function identityRowsDeleted(results: ReadonlyArray<IdentityRowDeletion>): number {
  return results.reduce((n, r) => n + r.rowsBefore, 0);
}

/** Rows still present afterwards — the verdict, and it must be 0. */
export function identityRowsRemaining(results: ReadonlyArray<IdentityRowDeletion>): number {
  return results.reduce((n, r) => n + r.rowsRemaining, 0);
}
