// TRA-2410 — registering a recycled username must not adopt the previous holder's book.
//
// ⚠️ THE POINT OF THIS FILE is the first test in it. The ticket's acceptance recipe
// — "create U, open a position, delete U, re-create U, assert the new book is
// empty" — PASSES against a guard that only clears `users/<name>/`, because the
// assertion is made in the seconds before anything reads the book. The read is
// what restores it: `tryRestoreFromBackup` heals a MISSING primary from
// `backups/<ts>/users/<name>/`. So every test here plants a backup generation
// explicitly and asserts it exists BEFORE the retirement, and the mutation control
// proves the naive guard still hands over the book.
//
// The second thing this file is for: an orphan with NO primary directory at all
// (an operator's manual `rm -rf`). It is invisible to a `users/<name>/` check and
// is the single most likely way a book comes free on this host.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type TradeStore = typeof import('./trade-store.js');
type OrphanedBooks = typeof import('./orphaned-books.js');
type DeletedAccounts = typeof import('./deleted-accounts.js');
type Auth = typeof import('./auth.js');
type TwoFactor = typeof import('./two-factor.js');

let DATA_DIR: string;
let tradeStore: TradeStore;
let orphanedBooks: OrphanedBooks;
let deletedAccounts: DeletedAccounts;
let auth: Auth;
let twoFactor: TwoFactor;

// `trade-store.ts` resolves DATA_DIR once at module load, so the env override has
// to be in place before the (dynamic) import.
beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra2410-'));
  process.env['DATA_DIR'] = DATA_DIR;
  tradeStore = await import('./trade-store.js');
  orphanedBooks = await import('./orphaned-books.js');
  deletedAccounts = await import('./deleted-accounts.js');
  auth = await import('./auth.js');
  twoFactor = await import('./two-factor.js');
  auth.initResetTokenStore(DATA_DIR);
  twoFactor.initTwoFactorStore(DATA_DIR);
});

beforeEach(() => {
  deletedAccounts.clearTombstoneCache();
});

const userDir = (u: string) => join(DATA_DIR, 'users', u);
const backupRoot = () => join(DATA_DIR, 'backups');
const orphanRoot = () => join(DATA_DIR, orphanedBooks.ORPHANED_BOOKS_DIRNAME);
/** The exact naming `rotateBackups` uses. */
const stampAt = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const generationDir = (ms: number) => join(backupRoot(), stampAt(ms));

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf-8');
}

/**
 * `tryRestoreFromBackup` consults ONLY the newest generation, so a test that
 * measures a restore has to own the whole backup root or it silently measures
 * whatever an earlier test left behind.
 */
function clearBackups(): void {
  rmSync(backupRoot(), { recursive: true, force: true });
}

/** A book on disk — every per-user store, so the move is measured across all of them. */
function plantBook(username: string, marker: string): void {
  writeJson(join(userDir(username), 'trades-stocks.json'), { version: 1, marker });
  writeJson(join(userDir(username), 'trades-crypto.json'), { version: 1, marker });
  writeJson(join(userDir(username), 'watchlist.json'), { symbols: ['AAPL'] });
  writeJson(join(userDir(username), 'account-settings.json'), { mode: 'demo' });
  writeJson(join(userDir(username), 'reports', 'demo', 'latest.json'), { date: '2026-07-01' });
  writeJson(join(userDir(username), 'crypto', 'equity-state.json'), { equity: 25000 });
}

/** One backup generation holding that book, exactly as `rotateBackups` mirrors it. */
function plantBackup(username: string, atMs: number, marker: string): string {
  const dir = join(generationDir(atMs), 'users', username);
  writeJson(join(dir, 'trades-stocks.json'), { version: 1, marker });
  writeJson(join(dir, 'trades-crypto.json'), { version: 1, marker });
  return generationDir(atMs);
}

const markerOf = (snap: unknown): string | undefined =>
  (snap as { marker?: string } | null)?.marker;

const T0 = Date.parse('2026-07-29T09:00:00.000Z');

describe('TRA-2410 — the recycled-username adoption hazard', () => {
  it('MUTATION CONTROL: clearing users/<name>/ reads clean and the book restores itself', async () => {
    // This is the guard a reasonable person writes, and the state the ticket's own
    // acceptance recipe measures. Every assertion below it would pass against this.
    const user = 'tra2410-naive';
    clearBackups();
    plantBook(user, 'predecessor');
    plantBackup(user, T0 - 30 * 60_000, 'predecessor');

    rmSync(userDir(user), { recursive: true, force: true });
    expect(existsSync(userDir(user))).toBe(false); // ← reads EXACTLY like a clean book

    // ...and the very first read of the "new" account hands over the old positions.
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(user))).toBe('predecessor');
    expect(markerOf(await tradeStore.loadCryptoTradeSnapshot(user))).toBe('predecessor');
    // Not merely returned — WRITTEN BACK, so the directory is live again.
    expect(existsSync(join(userDir(user), 'trades-stocks.json'))).toBe(true);
    rmSync(userDir(user), { recursive: true, force: true });
  });

  it('AC1 + AC2: retirement clears the live key AND the backup channel', async () => {
    const user = 'tra2410-recycled';
    clearBackups();
    plantBook(user, 'predecessor');
    const gen = plantBackup(user, T0 - 30 * 60_000, 'predecessor');
    // AC2 — assert the restorable copy EXISTS first, so this test does not depend
    // on the fixture being younger than one 30-minute rotation.
    expect(existsSync(join(gen, 'users', user))).toBe(true);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.orphanFound).toBe(true);
    expect(receipt.primaryDirExisted).toBe(true);
    expect(receipt.backupGenerationsWithData).toBe(1);
    expect(receipt.retiredAt).toBe(T0);
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);

    // The new account's book: empty from BOTH stores, and the refused restore must
    // not have written anything back to the live key.
    expect(await tradeStore.loadStocksTradeSnapshot(user)).toBeNull();
    expect(await tradeStore.loadCryptoTradeSnapshot(user)).toBeNull();
    expect(existsSync(join(userDir(user), 'trades-stocks.json'))).toBe(false);
  });

  it('finds the orphan that has NO primary directory — a manual rm leaves only backups', async () => {
    // The case a `users/<name>/` existence check misses entirely, and the one an
    // operator produces by hand. `orphanFound` has to come from the generations.
    const user = 'tra2410-backup-only';
    clearBackups();
    plantBackup(user, T0 - 30 * 60_000, 'predecessor');
    expect(existsSync(userDir(user))).toBe(false);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.primaryDirExisted).toBe(false);
    expect(receipt.backupGenerationsWithData).toBe(1);
    expect(receipt.orphanFound).toBe(true);
    expect(receipt.ok).toBe(true);

    expect(await tradeStore.loadStocksTradeSnapshot(user)).toBeNull();
  });

  it('DESTROYS NOTHING — the retired book is intact under orphaned-books/', async () => {
    // TRA-142 retention. A guard that deleted the tree would pass every assertion
    // above while making the admin restore impossible.
    const user = 'tra2410-retained';
    clearBackups();
    plantBook(user, 'predecessor');

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.quarantinedTo).toBe(join(orphanedBooks.ORPHANED_BOOKS_DIRNAME, `${user}@${stampAt(T0)}`));

    const parked = join(DATA_DIR, receipt.quarantinedTo as string);
    expect(existsSync(parked)).toBe(true);
    expect(JSON.parse(readFileSync(join(parked, 'trades-stocks.json'), 'utf-8')))
      .toMatchObject({ marker: 'predecessor' });
    // The whole subtree moved, not just the two files the trade store reads.
    expect(existsSync(join(parked, 'watchlist.json'))).toBe(true);
    expect(existsSync(join(parked, 'account-settings.json'))).toBe(true);
    expect(existsSync(join(parked, 'reports', 'demo', 'latest.json'))).toBe(true);
    expect(existsSync(join(parked, 'crypto', 'equity-state.json'))).toBe(true);
    // The quarantine root is NOT under users/ — `rotateBackups` mirrors every
    // directory it finds there, which would re-copy a dead book forever and keep
    // feeding the restore path a copy under the live key.
    expect(existsSync(join(DATA_DIR, 'users', orphanedBooks.ORPHANED_BOOKS_DIRNAME))).toBe(false);
    expect(readdirSync(orphanRoot()).length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a never-used name is left byte-for-byte alone', async () => {
    // The overwhelmingly common path. A tombstone recorded here would scope this
    // account's OWN option-journal rows out of its OWN calendar, and would break
    // its own disaster recovery — a "fix" that reads as working right up until
    // someone needs a restore.
    const user = 'tra2410-brand-new';
    clearBackups();
    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.orphanFound).toBe(false);
    expect(receipt.retiredAt).toBeNull();
    expect(receipt.quarantinedTo).toBeNull();
    expect(receipt.ok).toBe(true);
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBeNull();

    // ...and its own backups still restore, exactly as before this change.
    plantBackup(user, T0, 'their-own-book');
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(user))).toBe('their-own-book');
    rmSync(userDir(user), { recursive: true, force: true });
  });

  it("NEGATIVE CONTROL: the new holder's own backups restore after the epoch", async () => {
    // Without this, the guard would silently break disaster recovery for every
    // recycled name and still pass every test above it.
    const user = 'tra2410-new-holder';
    clearBackups();
    plantBook(user, 'predecessor');
    await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    deletedAccounts.clearTombstoneCache();

    plantBackup(user, T0 + 30 * 60_000, 'new-holder');
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(user))).toBe('new-holder');
    rmSync(userDir(user), { recursive: true, force: true });
  });

  it('leaves every other account untouched', async () => {
    const recycled = 'tra2410-target';
    const bystander = 'tra2410-bystander';
    clearBackups();
    plantBook(recycled, 'target');
    plantBook(bystander, 'bystander');
    plantBackup(bystander, T0 - 30 * 60_000, 'bystander');

    await orphanedBooks.retireOrphanedBook(recycled, { dataDir: DATA_DIR, now: T0 });

    expect(existsSync(userDir(bystander))).toBe(true);
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(bystander))).toBe('bystander');
    expect(deletedAccounts.accountDeletedAt(bystander, DATA_DIR)).toBeNull();
  });

  it('revokes an outstanding reset code for the retired identity, and only that one', async () => {
    const user = 'tra2410-tokens';
    const other = 'tra2410-tokens-other';
    clearBackups();
    plantBook(user, 'tokens');
    const code = auth.generateResetToken(user);
    const otherCode = auth.generateResetToken(other);
    twoFactor.issueChallenge(user);
    expect(auth.validateResetToken(code)).toBe(user);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });

    expect(receipt.resetTokensRevoked).toBe(1);
    expect(receipt.twoFactorStateCleared).toBe(1);
    // The predecessor's reset link must not redeem against the new holder.
    expect(auth.validateResetToken(code)).toBeNull();
    expect(auth.validateResetToken(otherCode)).toBe(other);
  });

  it('is idempotent, and a second retirement only tightens the epoch', async () => {
    const user = 'tra2410-twice';
    clearBackups();
    plantBook(user, 'first');

    const first = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(first.orphanFound).toBe(true);

    // Nothing left to retire — the second call must be a clean no-op, not a second
    // tombstone for a name that is now legitimately held.
    const second = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 + 60_000 });
    expect(second.orphanFound).toBe(false);
    expect(second.retiredAt).toBeNull();
    expect(second.ok).toBe(true);
    deletedAccounts.clearTombstoneCache();
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBe(T0);

    // But a book that comes back (the name recycled a second time) tombstones again.
    plantBook(user, 'second');
    const third = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 + 3_600_000 });
    expect(third.orphanFound).toBe(true);
    deletedAccounts.clearTombstoneCache();
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBe(T0 + 3_600_000);
  });

  it('records the epoch as `recycled`, distinguishable from a deliberate deletion', async () => {
    const user = 'tra2410-via';
    clearBackups();
    plantBook(user, 'via');
    await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    deletedAccounts.clearTombstoneCache();

    const rows = deletedAccounts.readTombstones(DATA_DIR).filter(t => t.username === user);
    expect(rows).toHaveLength(1);
    // `recycled` says nobody recorded a deletion — the book was found orphaned. An
    // operator reading this file needs to tell that apart from `self`/`admin`.
    expect(rows[0]?.via).toBe('recycled');
  });
});
