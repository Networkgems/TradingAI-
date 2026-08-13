// TRA-3386 (impl of TRA-2691) — the adoption-route receipt must ECHO the identity
// sweep, not allow-list around it.
//
// ── The defect ────────────────────────────────────────────────────────────────
//
// `retireOrphanedBook` computes `identityRowsDeleted` / `identityRowsRemaining`
// (`orphaned-books.ts`, TRA-2535) and makes the second one a term of `receipt.ok`.
// `POST /api/admin/users` then re-shaped the receipt through an INLINE LITERAL
// that named six fields and not those two — so the recycle-path class verdict was
// computed and discarded at the wire. Same class as `9d1c41e`/TRA-2583: an
// allow-list fails OPEN and fails SILENTLY, because a field nobody forwarded is
// byte-identical on the wire to a field that was never computed.
//
// ── Two kinds of test live here and they are NOT interchangeable ──────────────
//
// The SHAPE block below would pass the day `shapeRetiredOrphanReceipt` was added
// and left uncalled — a shaper nobody spreads shapes correctly. The WIRING block
// is the one that fails on `57db2d5`, the head this was written against: it is
// the only part that can tell a routed shaper from an unrouted one, and an
// unrouted shaper is the same bug in a new place.
//
// ── The vacuity trap ──────────────────────────────────────────────────────────
//
// ⚠️ `identityRowsRemaining` ON THIS ROUTE IS A CONSTANT COLUMN. `receipt.ok`
// requires it `=== 0` and the route 503s on `!ok`, so the 201 carrying this
// object is unreachable with any other value — the `-1` UNKNOWN sentinel
// included. A green `identityRowsRemaining: 0` therefore proves NOTHING, and the
// parent ruling explicitly declined it as standalone evidence. The only
// discriminating field is `identityRowsDeleted`, so the positive test below
// plants a REAL `agent_spend` row, reads it back BEFORE the retirement, and
// asserts the wire number is NON-ZERO. The zero-teeth control next to it proves
// that number moves, i.e. that it is a measurement and not another constant.
//
// THE HARNESS MUST FAIL, NOT SKIP: `better-sqlite3` is fail-soft (TRA-1681), and
// without a db `deleteIdentityRows` returns `[]`, every count is 0, and the
// non-zero assertion below would be the only thing standing between this file and
// a vacuous green. `beforeAll` asserts the db OPENED.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

type Sqlite = typeof import('./sqlite.js');
type OrphanedBooks = typeof import('./orphaned-books.js');
type DeletedAccounts = typeof import('./deleted-accounts.js');
type AgentSpend = typeof import('./agent-spend-store.js');
type AccountDeletion = typeof import('./account-deletion.js');
type Auth = typeof import('./auth.js');
type TwoFactor = typeof import('./two-factor.js');

let DATA_DIR: string;
let sqlite: Sqlite;
let orphanedBooks: OrphanedBooks;
let deletedAccounts: DeletedAccounts;
let spend: AgentSpend;
let accountDeletion: AccountDeletion;
let auth: Auth;
let twoFactor: TwoFactor;

const T0 = Date.parse('2026-08-13T09:00:00.000Z');

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra3386-'));
  process.env['DATA_DIR'] = DATA_DIR;
  sqlite = await import('./sqlite.js');
  orphanedBooks = await import('./orphaned-books.js');
  deletedAccounts = await import('./deleted-accounts.js');
  spend = await import('./agent-spend-store.js');
  accountDeletion = await import('./account-deletion.js');
  auth = await import('./auth.js');
  twoFactor = await import('./two-factor.js');
  auth.initResetTokenStore(DATA_DIR);
  twoFactor.initTwoFactorStore(DATA_DIR);

  const db = sqlite.__setStateDbForTests(DATA_DIR);
  expect(
    db,
    'better-sqlite3 did not open — deleteIdentityRows would return [] and identityRowsDeleted would be a vacuous 0',
  ).not.toBeNull();
});

afterAll(() => {
  sqlite.__setStateDbForTests(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  deletedAccounts.clearTombstoneCache();
  spend.resetAgentSpendForTests();
});

const userDir = (u: string) => join(DATA_DIR, 'users', u);

function plantBook(username: string, marker: string): void {
  const file = join(userDir(username), 'trades-stocks.json');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, marker }), 'utf-8');
}

/** The raw durable row, read without going through the store's own accessors. */
function rawSpendRows(user: string): number {
  const row = sqlite.getStateDb()?.prepare('SELECT COUNT(*) AS n FROM agent_spend WHERE user = ?').get(user) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** Exactly the keys `POST /api/admin/users` may put under `retiredOrphanedBook`. */
const WIRE_KEYS = [
  'quarantinedTo',
  'retiredAt',
  'settingsRowFound',
  'settingsRowRetired',
  'settingsCredentialFieldsCleared',
  'settingsQuarantinedTo',
  'identityRowsDeleted',
  'identityRowsRemaining',
] as const;

describe('TRA-3386 — the shaped receipt (AC1: both fields reach the wire)', () => {
  it('AC2: a retirement WITH TEETH puts a NON-ZERO identityRowsDeleted on the wire', async () => {
    const user = 'tra3386-recycled';
    // TEETH. An `agent_spend` row only exists because that identity spent money,
    // and inheriting it lands the NEW holder of this name at or over the daily LLM
    // cap for the rest of the UTC day — the consequence TRA-2535 closed.
    spend.recordAgentSpend(user, 7, T0);
    // POSITIVE MARK FIRST: without this, the non-zero below could be a plant that
    // silently never took, and a 0 would read as "the disk was already clean".
    expect(rawSpendRows(user), 'the planted spend row did not persist — AC2 would be vacuous').toBe(1);
    plantBook(user, 'predecessor');

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });

    // The route 503s on `!ok` (`index.ts`), so this is the ONLY state in which the
    // 201 under test is reachable at all. Asserting it here is what makes the
    // numbers below the ones an admin actually receives.
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok, 'a !ok receipt never reaches the 201 — this arm would be measuring an unreachable response').toBe(true);
    expect(receipt.orphanFound).toBe(true);

    const wire = orphanedBooks.shapeRetiredOrphanReceipt(receipt);

    // ── AC2, the whole point of this file ──────────────────────────────────────
    expect(wire.identityRowsDeleted, 'the identity sweep reported no teeth against a row that was there').toBe(1);
    // The constant column. Asserted for completeness, NOT as evidence — see header.
    expect(wire.identityRowsRemaining).toBe(0);

    // …and the durable row is really gone, so the number is not just bookkeeping.
    expect(rawSpendRows(user)).toBe(0);
  });

  it('AC2 CONTROL: identityRowsDeleted is a MEASUREMENT — zero teeth reports 0', async () => {
    // The discriminator. If this arm also read 1, the assertion above would be
    // measuring a constant, which is exactly the trap the parent ruling named
    // (`backupGenerationsPurged:0`, `filesCompacted:0`).
    const user = 'tra3386-tree-only';
    plantBook(user, 'predecessor');
    expect(rawSpendRows(user), 'this control must have NO identity row').toBe(0);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.orphanFound, 'the tree alone must still trip the guard').toBe(true);
    expect(receipt.ok).toBe(true);

    const wire = orphanedBooks.shapeRetiredOrphanReceipt(receipt);
    expect(wire.identityRowsDeleted).toBe(0);
    expect(wire.identityRowsRemaining).toBe(0);
  });

  it('is ADDITIVE — every key the response carried before TRA-3386 still carries its receipt value', async () => {
    // "Do not remove or rename existing keys — other graders read this response."
    const user = 'tra3386-additive';
    plantBook(user, 'predecessor');
    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    const wire = orphanedBooks.shapeRetiredOrphanReceipt(receipt);

    expect(wire.quarantinedTo).toBe(receipt.quarantinedTo);
    expect(wire.quarantinedTo).not.toBeNull(); // the tree really moved
    expect(wire.retiredAt).toBe(T0);
    expect(wire.settingsRowFound).toBe(receipt.settingsRowFound);
    expect(wire.settingsRowRetired).toBe(receipt.settingsRowRetired);
    expect(wire.settingsCredentialFieldsCleared).toBe(receipt.settingsCredentialFieldsCleared);
    expect(wire.settingsQuarantinedTo).toBe(receipt.settingsQuarantinedTo);
  });

  it('the key set is a DECISION, not a default — a new receipt field cannot drift in or out silently', async () => {
    // This is the assertion that kills the CLASS. TRA-2691 happened because the
    // wire shape and the receipt shape were maintained in two places with nothing
    // comparing them. A field added to `OrphanRetirementReceipt` now fails here
    // until someone forwards it or records why it stays operator-only.
    const receipt = await orphanedBooks.retireOrphanedBook('tra3386-keys', { dataDir: DATA_DIR, now: T0 });
    const wire = orphanedBooks.shapeRetiredOrphanReceipt(receipt);
    expect(Object.keys(wire).sort()).toEqual([...WIRE_KEYS].sort());

    const operatorOnly = Object.keys(receipt).filter((k) => !(WIRE_KEYS as readonly string[]).includes(k));
    // `username` is the request the admin just made; `errors` may name ABSOLUTE
    // paths (`quarantine:/data/users/...`); `ok`/`orphanFound`/the disk counts are
    // the route's own control flow. Listed so adding a receipt field lands here.
    expect(operatorOnly.sort()).toEqual(
      ['backupGenerationsWithData', 'errors', 'ok', 'orphanFound', 'primaryDirExisted', 'resetTokensRevoked', 'twoFactorStateCleared', 'username'].sort(),
    );
  });

  it('leaks no operator-only string — no absolute path reaches the wire', async () => {
    const user = 'tra3386-noleak';
    plantBook(user, 'predecessor');
    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    const wire = orphanedBooks.shapeRetiredOrphanReceipt(receipt);

    expect(wire).not.toHaveProperty('errors');
    expect(wire).not.toHaveProperty('username');
    for (const [key, value] of Object.entries(wire)) {
      if (typeof value === 'string') expect(value, `${key} leaked DATA_DIR`).not.toContain(DATA_DIR);
    }
  });

  it('agrees with the self-delete receipt on the two identity fields (the drift TRA-2691 measured)', async () => {
    // `redactWipeReceipt` (`account-deletion.ts`) already echoed both. The whole
    // ticket is that the two sibling receipts named the same computed numbers
    // differently — one forwarded them, one dropped them. Pinning the names here
    // is what stops the pair drifting apart again.
    const wipeKeys = Object.keys(
      accountDeletion.redactWipeReceipt({
        username: 'x', deletedAt: T0, primaryDirExisted: false, primaryDirRemoved: false,
        primaryDirReappeared: false, backupGenerationsScanned: 0, backupGenerationsWithData: 0,
        backupGenerationsPurged: 0, backupGenerationsRemaining: 0, resetTokensRevoked: 0,
        twoFactorStateCleared: 0, settingsRowExisted: false, settingsRowRemoved: false,
        settingsCredentialFieldsCleared: 0, identityRowsDeleted: 0, identityRowsRemaining: 0,
        errors: [], ok: true,
      } as Parameters<typeof accountDeletion.redactWipeReceipt>[0]),
    );
    for (const field of ['identityRowsDeleted', 'identityRowsRemaining']) {
      expect(wipeKeys, `the self-delete receipt no longer echoes ${field}`).toContain(field);
      expect(WIRE_KEYS as readonly string[], `the adoption receipt no longer echoes ${field}`).toContain(field);
    }
  });
});

describe('TRA-3386 — the WIRING (this block fails on 57db2d5)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  /**
   * Slice one route handler out of `index.ts`. Routes are declared at column 0, so
   * the next `\napp.` terminates the body; the needle carries its closing quote,
   * which keeps `'/api/admin/users'` from matching `'/api/admin/users/:username'`.
   * (Same helper as `identity-write-guard.test.ts`.)
   */
  const routeBody = (needle: string): string => {
    const start = src.indexOf(needle);
    expect(start, `route not found in index.ts: ${needle}`).toBeGreaterThan(-1);
    const rest = src.slice(start + needle.length);
    const end = rest.indexOf('\napp.');
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('POST /api/admin/users SPREADS the shipped shaper into the 201', () => {
    const body = routeBody("app.post('/api/admin/users'");
    expect(body).toContain('retiredOrphanedBook: shapeRetiredOrphanReceipt(retiredOrphan)');
    expect(src).toMatch(/import \{[^}]*shapeRetiredOrphanReceipt[^}]*\} from '\.\/orphaned-books\.js'/);
  });

  it('…and does NOT re-shape the receipt inline — the literal IS the defect', () => {
    // A second copy of the key list anywhere on this route re-opens TRA-2691: the
    // two lists drift and the drift is invisible because both spellings look
    // correct in review. These patterns match an inline re-shape and nothing else
    // (the surrounding prose names the fields without a `: retiredOrphan.` tail).
    const body = routeBody("app.post('/api/admin/users'");
    for (const field of WIRE_KEYS) {
      expect(body, `${field} is re-shaped inline on the route`).not.toMatch(
        new RegExp(`${field}:\\s*retiredOrphan[.?]`),
      );
    }
  });

  it('the receipt is still gated — a !ok retirement 503s instead of reaching the 201', () => {
    // Load-bearing for the header's constant-column claim, and the thing the
    // parent forbade "fixing": refusing the registration when identity rows could
    // not be cleared is the behaviour the module exists for.
    const body = routeBody("app.post('/api/admin/users'");
    expect(body).toMatch(/if \(!retiredOrphan\.ok\)[\s\S]{0,400}?res\.status\(503\)/);
    expect(body).toMatch(/res\.status\(503\)[\s\S]{0,120}?return;/);
  });
});
