// TRA-2421 — the wipe surface for self-serve account deletion.
//
// ⚠️ THE POINT OF THIS FILE is the FIRST test. The ticket's own acceptance recipe
// — "create a throwaway account → trade → delete → re-signup → assert empty" —
// PASSES against a `rm -rf users/<name>/` that does not actually delete anything,
// because a fixture younger than one 30-min backup rotation has no backup to be
// restored from. So the suite never trusts fixture age: it plants backup
// generations explicitly, asserts they exist BEFORE the wipe, and keeps a
// mutation control that proves the naive implementation still resurrects the book.
// Without that control every assertion here would pass against the bug.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type TradeStore = typeof import('./trade-store.js');
type AccountDeletion = typeof import('./account-deletion.js');
type DeletedAccounts = typeof import('./deleted-accounts.js');
type Auth = typeof import('./auth.js');
type TwoFactor = typeof import('./two-factor.js');

let DATA_DIR: string;
let tradeStore: TradeStore;
let accountDeletion: AccountDeletion;
let deletedAccounts: DeletedAccounts;
let auth: Auth;
let twoFactor: TwoFactor;

// `trade-store.ts` resolves DATA_DIR once at module load, so the env override has
// to be in place before the (dynamic) import. vitest gives each file a fresh
// module registry, so this picks up cleanly.
beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra2421-'));
  process.env['DATA_DIR'] = DATA_DIR;
  tradeStore = await import('./trade-store.js');
  accountDeletion = await import('./account-deletion.js');
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
/** The exact naming `rotateBackups` uses: ISO with `:` and `.` swapped for `-`. */
const stampAt = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const generationDir = (ms: number) => join(backupRoot(), stampAt(ms));

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf-8');
}

/**
 * `tryRestoreFromBackup` consults ONLY the newest generation, so any test that
 * measures a restore has to own the whole backup root — otherwise it silently
 * measures a generation some earlier test left behind and the assertion stops
 * meaning what it says.
 */
function clearBackups(): void {
  rmSync(backupRoot(), { recursive: true, force: true });
}

/** A book on disk: both trade stores (they have INDEPENDENT restore calls). */
function plantBook(username: string, marker: string): void {
  writeJson(join(userDir(username), 'trades-stocks.json'), { version: 1, marker });
  writeJson(join(userDir(username), 'trades-crypto.json'), { version: 1, marker });
  writeJson(join(userDir(username), 'watchlist.json'), { symbols: ['AAPL'] });
  writeJson(join(userDir(username), 'account-settings.json'), { mode: 'demo' });
  writeJson(join(userDir(username), 'anthropic-cred.json'), { key: 'sk-ant-api03-x' });
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

const T0 = Date.parse('2026-07-26T09:00:00.000Z');

describe('TRA-2421 — the wipe surface', () => {
  it('MUTATION CONTROL: a dir-only wipe looks complete and the book restores itself', async () => {
    const user = 'tra2421-naive';
    clearBackups();
    plantBook(user, 'naive-book');
    plantBackup(user, T0, 'naive-book');

    // The "obvious" fix, and the state the obvious acceptance test measures.
    rmSync(userDir(user), { recursive: true, force: true });
    expect(existsSync(userDir(user))).toBe(false); // ← reads EXACTLY like success

    // ...and then the very next read puts it all back.
    const stocks = await tradeStore.loadStocksTradeSnapshot(user);
    expect(markerOf(stocks)).toBe('naive-book');
    // Not just returned — WRITTEN BACK to disk, so the directory is live again.
    expect(existsSync(join(userDir(user), 'trades-stocks.json'))).toBe(true);
  });

  it('wipes the primary tree AND every backup generation, stocks and crypto', async () => {
    const user = 'tra2421-full';
    plantBook(user, 'full-book');
    const gens = [
      plantBackup(user, T0 - 90 * 60_000, 'full-book'),
      plantBackup(user, T0 - 60 * 60_000, 'full-book'),
      plantBackup(user, T0 - 30 * 60_000, 'full-book'),
    ];
    // §3 — assert the backup copies EXIST before the wipe. This is what makes the
    // test independent of how old the fixture is.
    for (const g of gens) expect(existsSync(join(g, 'users', user))).toBe(true);

    const receipt = await accountDeletion.wipeAccountData(user, { now: T0 });

    // `backupGenerationsPurged: 0` is also the healthy no-backups state, so the
    // teeth are asserted separately from the verdict.
    expect(receipt.backupGenerationsWithData).toBe(3);
    expect(receipt.backupGenerationsPurged).toBe(3);
    expect(receipt.backupGenerationsRemaining).toBe(0);
    expect(receipt.primaryDirExisted).toBe(true);
    expect(receipt.primaryDirRemoved).toBe(true);
    expect(receipt.primaryDirReappeared).toBe(false);
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);

    // Physically gone — asserted directly, so this does not merely re-measure the
    // tombstone guard tested below.
    expect(existsSync(userDir(user))).toBe(false);
    for (const g of gens) expect(existsSync(join(g, 'users', user))).toBe(false);
    // ...and the generation directories themselves survive: other users' copies
    // must not be collateral.
    for (const g of gens) expect(existsSync(g)).toBe(true);

    expect(await tradeStore.loadStocksTradeSnapshot(user)).toBeNull();
  });

  it('leaves every other account untouched', async () => {
    const victim = 'tra2421-victim';
    const bystander = 'tra2421-bystander';
    plantBook(victim, 'victim');
    plantBook(bystander, 'bystander');
    const gen = plantBackup(victim, T0 - 30 * 60_000, 'victim');
    plantBackup(bystander, T0 - 30 * 60_000, 'bystander');

    await accountDeletion.wipeAccountData(victim, { now: T0 });

    expect(existsSync(join(gen, 'users', victim))).toBe(false);
    expect(existsSync(join(gen, 'users', bystander))).toBe(true);
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(bystander))).toBe('bystander');
    expect(deletedAccounts.accountDeletedAt(bystander, DATA_DIR)).toBeNull();
  });

  it('reports residue instead of a clean 200 when a backup copy survives', async () => {
    const user = 'tra2421-residue';
    plantBook(user, 'residue');
    await accountDeletion.wipeAccountData(user, { now: T0 });

    // Simulate the purge having missed a generation (locked file, DATA_DIR rolled
    // back from an external snapshot) and re-run: `withData` proves it was seen,
    // and a run that could NOT clear it would surface as `remaining > 0`.
    plantBackup(user, T0 - 30 * 60_000, 'residue');
    const second = await accountDeletion.wipeAccountData(user, { now: T0 + 1000 });
    expect(second.backupGenerationsWithData).toBe(1);
    expect(second.backupGenerationsRemaining).toBe(0);
    expect(second.ok).toBe(true);
  });

  it('revokes the identity-keyed stores that live OUTSIDE users/<name>/', async () => {
    const user = 'tra2421-tokens';
    const other = 'tra2421-tokens-other';
    plantBook(user, 'tokens');
    const code = auth.generateResetToken(user);
    const otherCode = auth.generateResetToken(other);
    twoFactor.issueChallenge(user);
    expect(auth.validateResetToken(code, user)).toBe(user);

    const receipt = await accountDeletion.wipeAccountData(user, { now: T0 });

    expect(receipt.resetTokensRevoked).toBe(1);
    expect(receipt.twoFactorStateCleared).toBe(1);
    // The reset code is dead — it must not survive to be redeemed against
    // whoever registers this username next.
    expect(auth.validateResetToken(code, user)).toBeNull();
    expect(twoFactor.verifyChallenge(user, '000000')).toBe('no_challenge');
    // Scoped: another account's outstanding code is untouched.
    expect(auth.validateResetToken(otherCode, other)).toBe(other);
  });
});

describe('TRA-2421 — the tombstone restore guard', () => {
  it('refuses a backup generation older than the deletion', async () => {
    const user = 'tra2421-guard';
    clearBackups();
    plantBook(user, 'guard');
    await accountDeletion.wipeAccountData(user, { now: T0 });
    deletedAccounts.clearTombstoneCache();

    // A generation the purge did not reach, stamped BEFORE the delete.
    plantBackup(user, T0 - 30 * 60_000, 'guard');
    expect(await tradeStore.loadStocksTradeSnapshot(user)).toBeNull();
    // Refused, not consumed — the guard must not write the book back to disk.
    expect(existsSync(join(userDir(user), 'trades-stocks.json'))).toBe(false);
  });

  it('NEGATIVE CONTROL: still restores a generation written AFTER the deletion', async () => {
    // The name is free again, someone re-registered it, and their OWN backups must
    // remain restorable — otherwise this guard would quietly break disaster
    // recovery for every recycled name and read like a working fix.
    const user = 'tra2421-guard-after';
    clearBackups();
    plantBook(user, 'old-holder');
    await accountDeletion.wipeAccountData(user, { now: T0 });
    deletedAccounts.clearTombstoneCache();

    plantBackup(user, T0 + 30 * 60_000, 'new-holder');
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(user))).toBe('new-holder');
  });

  it('NEGATIVE CONTROL: a never-deleted name restores exactly as before', async () => {
    const user = 'tra2421-untombstoned';
    clearBackups();
    plantBackup(user, T0, 'untouched');
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBeNull();
    expect(markerOf(await tradeStore.loadStocksTradeSnapshot(user))).toBe('untouched');
  });

  it('fails closed on a backup directory whose stamp cannot be parsed', async () => {
    const user = 'tra2421-badstamp';
    clearBackups();
    plantBook(user, 'badstamp');
    await accountDeletion.wipeAccountData(user, { now: T0 });
    deletedAccounts.clearTombstoneCache();

    // `findLatestBackupDir` accepts anything starting `YYYY-MM-DDT`, which is
    // looser than the full stamp this guard parses. An unparseable name must be
    // refused, never treated as recent.
    const weird = join(backupRoot(), '2026-07-26Tgarbage');
    writeJson(join(weird, 'users', user, 'trades-stocks.json'), { version: 1, marker: 'badstamp' });
    expect(tradeStore.parseBackupGenerationStamp('2026-07-26Tgarbage')).toBeNull();
    expect(await tradeStore.loadStocksTradeSnapshot(user)).toBeNull();
    rmSync(weird, { recursive: true, force: true });
  });

  it('round-trips the exact stamp rotateBackups writes', () => {
    expect(tradeStore.parseBackupGenerationStamp(stampAt(T0))).toBe(T0);
    expect(tradeStore.parseBackupGenerationStamp('nonsense')).toBeNull();
    expect(tradeStore.parseBackupGenerationStamp('')).toBeNull();
  });
});

describe('TRA-2421 — the tombstone record', () => {
  it('is written before the files are removed and survives into backups', async () => {
    const user = 'tra2421-tombstone';
    plantBook(user, 'tombstone');
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBeNull();

    await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });
    deletedAccounts.clearTombstoneCache();

    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBe(T0);
    const onDisk = JSON.parse(
      readFileSync(join(DATA_DIR, deletedAccounts.DELETED_ACCOUNTS_FILENAME), 'utf-8'),
    ) as Array<{ username: string; via: string }>;
    expect(onDisk.some(t => t.username === user && t.via === 'self')).toBe(true);

    // `rotateBackups` must mirror the tombstone file, or a DATA_DIR restored from
    // a backup would come back with the user trees and WITHOUT the record that
    // they were deleted — silently re-arming the recycling bug.
    await tradeStore.rotateBackups();
    const gens = (await import('fs')).readdirSync(backupRoot()).filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
    const newest = join(backupRoot(), gens[gens.length - 1]);
    expect(existsSync(join(newest, deletedAccounts.DELETED_ACCOUNTS_FILENAME))).toBe(true);
  });

  it('takes the LATEST deletion when a name is destroyed more than once', async () => {
    const user = 'tra2421-twice';
    plantBook(user, 'first');
    await accountDeletion.wipeAccountData(user, { now: T0 });
    plantBook(user, 'second');
    await accountDeletion.wipeAccountData(user, { now: T0 + 3_600_000 });
    deletedAccounts.clearTombstoneCache();
    expect(deletedAccounts.accountDeletedAt(user, DATA_DIR)).toBe(T0 + 3_600_000);
  });

  it('treats a corrupt tombstone file as empty rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra2421-corrupt-'));
    writeFileSync(join(dir, deletedAccounts.DELETED_ACCOUNTS_FILENAME), '{not json', 'utf-8');
    expect(deletedAccounts.readTombstones(dir)).toEqual([]);
    expect(deletedAccounts.accountDeletedAt('anyone', dir)).toBeNull();
  });
});

describe('TRA-2421 — the refusal rules', () => {
  const isOperator = (u: string) => u === 'admin' || u.toLowerCase() === 'richard';

  it('refuses an operator book, by the SAME predicate that guards signup', () => {
    const r = accountDeletion.refuseSelfDelete({
      username: 'Richard', role: 'user', adminCount: 3, isOperatorBook: isOperator,
    });
    expect(r?.code).toBe('operator_book');
    expect(r?.status).toBe(403);
  });

  it('refuses the LAST admin, and only the last one', () => {
    const last = accountDeletion.refuseSelfDelete({
      username: 'ops', role: 'admin', adminCount: 1, isOperatorBook: () => false,
    });
    expect(last?.code).toBe('last_admin');
    expect(last?.status).toBe(409);

    // One of several admins is an ordinary account for this route's purposes.
    expect(accountDeletion.refuseSelfDelete({
      username: 'ops', role: 'admin', adminCount: 2, isOperatorBook: () => false,
    })).toBeNull();
  });

  it('lets an ordinary account through — the rule must not refuse everyone', () => {
    // Without this the gate would "pass" its other two tests while blocking the
    // whole feature.
    expect(accountDeletion.refuseSelfDelete({
      username: 'enock', role: 'user', adminCount: 2, isOperatorBook: isOperator,
    })).toBeNull();
  });
});

describe('TRA-2421 — the delete sequence', () => {
  function spyPorts() {
    const calls: string[] = [];
    const receipt = { ok: true } as Awaited<ReturnType<AccountDeletion['wipeAccountData']>>;
    return {
      calls,
      ports: {
        destroyContext: (_u: string) => { calls.push('destroyContext'); },
        deleteCredentialRow: async (_u: string) => { calls.push('deleteCredentialRow'); return true; },
        closeSockets: (_u: string) => { calls.push('closeSockets'); return 2; },
        wipe: async (_u: string) => { calls.push('wipe'); return receipt; },
      },
    };
  }

  it('stops engines and drops the credential row BEFORE touching the files', async () => {
    // The whole fix. Wiping before the token is dead lets a debounced persist or a
    // request on the still-valid token re-create the directory, and every other
    // test in this file would still pass.
    const { calls, ports } = spyPorts();
    const outcome = await accountDeletion.performSelfDelete('enock', ports);
    expect(calls).toEqual(['destroyContext', 'deleteCredentialRow', 'closeSockets', 'wipe']);
    expect(calls.indexOf('deleteCredentialRow')).toBeLessThan(calls.indexOf('wipe'));
    expect(outcome.ok).toBe(true);
  });

  it('does NOT wipe when the credential row was not removed', async () => {
    // Without step 2 the token stays live, so a wipe would only hand the restore
    // path a missing primary to heal from.
    const calls: string[] = [];
    const outcome = await accountDeletion.performSelfDelete('ghost', {
      destroyContext: () => { calls.push('destroyContext'); },
      deleteCredentialRow: async () => { calls.push('deleteCredentialRow'); return false; },
      closeSockets: () => { calls.push('closeSockets'); return 0; },
      wipe: async () => { calls.push('wipe'); return { ok: true } as never; },
    });
    expect(calls).toEqual(['destroyContext', 'deleteCredentialRow']);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('surfaces residue as its own outcome, not as success', async () => {
    const outcome = await accountDeletion.performSelfDelete('enock', {
      destroyContext: () => {},
      deleteCredentialRow: async () => true,
      closeSockets: () => 0,
      wipe: async () => ({ ok: false, errors: ['backup: EPERM'] } as never),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: 'residue' });
  });
});

describe('TRA-2421 — what the receipt is allowed to say on the wire', () => {
  // `receipt.errors[]` is labelled with ABSOLUTE DATA_DIR paths (`primary:/srv/
  // data/users/enock`, `backup:/srv/data/backups/<stamp>`). The residue branch
  // returns the receipt to the CALLER, so the failure path — the one nobody
  // exercises by hand — was handing a client the server's filesystem layout.
  // The operator's copy is unaffected: `log.error` gets the full receipt.

  /** A receipt shaped exactly as `wipeAccountData` builds a FAILING one. */
  function residueReceipt(): import('./account-deletion.js').AccountWipeReceipt {
    return {
      username: 'enock',
      deletedAt: T0,
      primaryDirExisted: true,
      primaryDirRemoved: false,
      primaryDirReappeared: true,
      backupGenerationsScanned: 24,
      backupGenerationsWithData: 3,
      backupGenerationsPurged: 2,
      backupGenerationsRemaining: 1,
      resetTokensRevoked: 1,
      twoFactorStateCleared: 0,
      settingsRowExisted: true,
      settingsRowRemoved: false,
      settingsCredentialFieldsCleared: 2,
      // TRA-2535 — a FAILING receipt, so these carry residue too: one row was
      // there and is still there.
      identityRowsDeleted: 1,
      identityRowsRemaining: 1,
      errors: [
        `primary:${userDir('enock')}: EPERM: operation not permitted`,
        `backup:${generationDir(T0)}: EBUSY: resource busy or locked`,
      ],
      ok: false,
    };
  }

  it('drops the error STRINGS and keeps the count', () => {
    const receipt = residueReceipt();
    const publicReceipt = accountDeletion.redactWipeReceipt(receipt);

    expect(publicReceipt.errorCount).toBe(2);
    expect(publicReceipt).not.toHaveProperty('errors');
    // The verdict and every count the user is entitled to survive intact —
    // redacting must not turn the residue report into a shrug.
    expect(publicReceipt.ok).toBe(false);
    expect(publicReceipt.backupGenerationsRemaining).toBe(1);
    expect(publicReceipt.backupGenerationsWithData).toBe(3);
    expect(publicReceipt.primaryDirReappeared).toBe(true);
    // TRA-2513 — the settings-row verdict is part of "some data could not be
    // removed", and the field it reports on is the saved BROKER CREDENTIALS. A
    // redactor that dropped it would turn the one residue the user most needs to
    // know about into silence.
    expect(publicReceipt.settingsRowExisted).toBe(true);
    expect(publicReceipt.settingsRowRemoved).toBe(false);
    expect(publicReceipt.settingsCredentialFieldsCleared).toBe(2);

    // The original is NOT mutated — the operator log reads it after this call.
    expect(receipt.errors).toHaveLength(2);
  });

  it('leaks no filesystem path anywhere in the serialised body', () => {
    const body = JSON.stringify(accountDeletion.redactWipeReceipt(residueReceipt()));
    expect(body).not.toContain(DATA_DIR);
    expect(body).not.toContain('EPERM');
    expect(body).not.toContain('primary:');
    expect(body).not.toContain('backup:');
  });

  it('DRIFT GUARD: the only free-text field on the wire is the caller own username', () => {
    // The redactor is a WHITELIST, so a new receipt field cannot leak by being
    // added upstream. What it cannot stop is someone adding a field to the
    // redactor itself. Any string value other than `username` is a new channel
    // for a path, a stack or an internal label, and has to be argued for here.
    const publicReceipt = accountDeletion.redactWipeReceipt(residueReceipt()) as unknown as Record<string, unknown>;
    const stringKeys = Object.keys(publicReceipt).filter(k => typeof publicReceipt[k] === 'string');
    expect(stringKeys).toEqual(['username']);
    // And nothing nested, which would slip past the check above.
    for (const [key, value] of Object.entries(publicReceipt)) {
      expect(typeof value, `field ${key}`).not.toBe('object');
    }
  });
});
