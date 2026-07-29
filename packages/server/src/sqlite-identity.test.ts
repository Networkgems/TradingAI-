// TRA-2535 — `agent_spend` was a SECOND username-keyed `state.db` table with the
// same lifecycle hole `account_settings` had, and the TRA-2513/2520 fix as scoped
// closed one of two.
//
// ── What this file is actually for ────────────────────────────────────────────
//
// Not the `agent_spend` delete. That is one name, and the recurring shape on this
// board is closing these ONE NAME AT A TIME — TRA-2488 added `/^qtverify/i`,
// TRA-2524 then found three more. The deliverable is the SET-EQUALITY test at the
// bottom: a third table added to `state.db` fails the suite until someone either
// registers it in `IDENTITY_TABLES` or allowlists it in `NON_IDENTITY_TABLES`
// with a reason. That converts "someone remembers" into a mechanical gate.
//
// ── The vacuity trap this file is built to avoid ──────────────────────────────
//
// TRA-2511 nearly produced a false green TWICE, both times by asserting against a
// value the fixture already had at its defaults (arm 2's `demoEquity` mark
// silently never applied; arm 1 asserted `equity === 25000` on a book already
// sitting at 25000). A working fix and a fix DELETED FROM SOURCE emitted
// byte-identical output.
//
// `perUser: []` and `spentUsd: 0` are the healthy steady state AND the
// broken-fix-with-no-teeth state, so three rules apply to everything below:
//
//  • PLANT A NON-DEFAULT MARK AND READ IT BACK BEFORE THE DELETE. Every test here
//    first asserts the planted spend is visible through the same accessor the cap
//    gate reads, with the in-memory bucket dropped so the read genuinely hits
//    SQLite.
//  • THE HARNESS MUST FAIL, NOT SKIP. `better-sqlite3` is fail-soft by design
//    (TRA-1681): a missing native module makes `getStateDb()` return null,
//    `deleteIdentityRows` return `[]`, and every assertion below trivially true.
//    `beforeAll` asserts the db OPENED.
//  • A TEST THAT PASSES WITH THE FIX REMOVED IS NOT A TEST. Each arm has a
//    NEGATIVE CONTROL that stubs out the `agent_spend` delete — via the real
//    `exclude` option, so the control exercises production code rather than a
//    mock — and asserts the row SURVIVES.
//
// ── Why a unit test and not a live probe ─────────────────────────────────────
//
// Planting an `agent_spend` row over HTTP requires a REAL PAID LLM CALL, and
// `companyCapUsd` on bqb1 reads $0.50 live (env-overridden well below the $100 in
// source). A single advisory run could exhaust the COMPANY-WIDE daily ceiling and
// halt the advisory layer for every user for the rest of the day. Demonstrating a
// spend guard by spending it is the wrong trade. `recordAgentSpend` is the honest
// seam: it is the same ledger writer the paid path calls, and costs nothing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

type Sqlite = typeof import('./sqlite.js');
type SqliteIdentity = typeof import('./sqlite-identity.js');
type AgentSpend = typeof import('./agent-spend-store.js');
type AccountSettings = typeof import('./account-settings.js');

let DATA_DIR: string;
let sqlite: Sqlite;
let identity: SqliteIdentity;
let spend: AgentSpend;
let settings: AccountSettings;

const T0 = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = '2026-07-29';
const USER = 'recycled-name';

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra2535-'));
  process.env['DATA_DIR'] = DATA_DIR;
  sqlite = await import('./sqlite.js');
  identity = await import('./sqlite-identity.js');
  spend = await import('./agent-spend-store.js');
  settings = await import('./account-settings.js');

  // HARNESS FAULT, NEVER A GREEN — see the header.
  const db = sqlite.__setStateDbForTests(DATA_DIR);
  expect(
    db,
    'better-sqlite3 did not open — deleteIdentityRows would return [] and every assertion here would be vacuous',
  ).not.toBeNull();
});

afterAll(() => {
  sqlite.__setStateDbForTests(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * The tables this harness cleans BETWEEN tests.
 *
 * ⚠️ Deliberately a hand-written literal and NOT `IDENTITY_TABLES`. Driving the
 * cleanup from the registry couples the instrument to the thing it measures: the
 * first version of this file did exactly that, and when the mutation run removed
 * the `agent_spend` arm, the truncation silently stopped too. Spend then bled
 * across tests and the negative controls went red for CROSS-TEST CONTAMINATION
 * rather than for the assertion they exist to make — a red for the wrong reason
 * is a red that stops meaning anything the day it turns green.
 *
 * If a table is added to `IDENTITY_TABLES` and not here, the set-equality gate at
 * the bottom still fires; the cost is only a dirtier fixture.
 */
const TABLES_TO_TRUNCATE = ['account_settings', 'agent_spend'] as const;

beforeEach(() => {
  spend.resetAgentSpendForTests();
  const db = sqlite.getStateDb();
  // Truncate rather than recreate: the tables are created lazily by their owning
  // stores, and recreating them here would put a second copy of the DDL in the
  // test, free to drift from the real one.
  for (const table of TABLES_TO_TRUNCATE) {
    try {
      db?.prepare(`DELETE FROM ${table}`).run();
    } catch {
      /* table not created yet in this process */
    }
  }
});

/** Force a fresh bucket so the next read HYDRATES FROM SQLITE rather than memory. */
function rehydrated(user: string) {
  spend.resetAgentSpendForTests();
  return spend.agentUserSpendStatus(user, T0);
}

/** The raw durable row, read without going through the store's own accessors. */
function rawSpendRows(user: string): number {
  const db = sqlite.getStateDb();
  const row = db?.prepare('SELECT COUNT(*) AS n FROM agent_spend WHERE user = ?').get(user) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

describe('TRA-2535 — agent_spend survives every delete path', () => {
  it('AC1: a planted spend row is visible through the cap accessor BEFORE the delete (the positive mark)', () => {
    spend.recordAgentSpend(USER, 5, T0);

    // The mark must survive a process restart to be the thing this ticket is
    // about, so the read is taken from a FRESH bucket — i.e. it came back out of
    // SQLite, not out of the map that just wrote it.
    const hydrated = rehydrated(USER);
    expect(hydrated.spentUsd, 'the planted mark did not persist — every assertion below would be vacuous').toBe(5);
    expect(hydrated.day).toBe(DAY);
    expect(rawSpendRows(USER)).toBe(1);
  });

  it('AC2: deleteIdentityRows clears the durable row, and a fresh bucket hydrates EMPTY', () => {
    spend.recordAgentSpend(USER, 5, T0);
    expect(rehydrated(USER).spentUsd).toBe(5); // mark verified first

    const results = identity.deleteIdentityRows(USER);

    const agentSpendArm = results.find((r) => r.table === 'agent_spend');
    expect(agentSpendArm, 'agent_spend was not attempted at all').toBeDefined();
    expect(agentSpendArm?.error).toBeNull();
    // TEETH: the row was really there. Without this, `rowsRemaining: 0` below is
    // also what a delete that silently stopped matching would report.
    expect(agentSpendArm?.rowsBefore).toBe(1);
    // VERDICT.
    expect(agentSpendArm?.rowsRemaining).toBe(0);

    expect(rawSpendRows(USER)).toBe(0);
    expect(rehydrated(USER).spentUsd).toBe(0);
    expect(spend.agentSpendAggregate(T0).perUser).toEqual([]);
  });

  it('AC3 NEGATIVE CONTROL: with the agent_spend arm stubbed out, the row SURVIVES', () => {
    spend.recordAgentSpend(USER, 5, T0);
    expect(rehydrated(USER).spentUsd).toBe(5);

    // `exclude` is the production path for "this table is handled elsewhere", so
    // the control is a real code path rather than a mock that could drift.
    const results = identity.deleteIdentityRows(USER, { exclude: ['agent_spend'] });

    expect(results.find((r) => r.table === 'agent_spend')).toBeUndefined();
    expect(rawSpendRows(USER), 'the row vanished with the arm excluded — AC2 is not measuring the delete').toBe(1);
    expect(rehydrated(USER).spentUsd).toBe(5);
  });

  it('AC4: the IN-MEMORY total is cleared too — no restart required', () => {
    spend.recordAgentSpend(USER, 5, T0);
    // NO `resetAgentSpendForTests()` anywhere in this test: the live bucket is the
    // thing under test. `bucket.perUser` is process-global and keyed by the same
    // raw username, so it carries the predecessor's total forward regardless of
    // SQLite — nothing in `destroyUserContext` clears it.
    expect(spend.agentUserSpendStatus(USER, T0).spentUsd).toBe(5);

    identity.deleteIdentityRows(USER);

    expect(spend.agentUserSpendStatus(USER, T0).spentUsd).toBe(0);
  });

  it('AC4 NEGATIVE CONTROL: with the arm excluded, the in-memory total survives', () => {
    spend.recordAgentSpend(USER, 5, T0);
    expect(spend.agentUserSpendStatus(USER, T0).spentUsd).toBe(5);

    identity.deleteIdentityRows(USER, { exclude: ['agent_spend'] });

    expect(spend.agentUserSpendStatus(USER, T0).spentUsd).toBe(5);
  });

  it('AC5 THE CONSEQUENCE: a recycled name no longer inherits an AT-CAP predecessor', () => {
    // The defect stated as the user sees it. Live on bqb1 `userCapUsd` reads $0.50
    // (env-overridden), so the inherited quantum that halts a fresh account for the
    // rest of the UTC day is fifty cents — this uses the source default of $10 and
    // plants above it, which is the same gate.
    const cap = spend.dailyUserCapUsd();
    spend.recordAgentSpend(USER, cap + 1, T0);
    expect(spend.isOverUserDailyCap(USER, T0), 'the predecessor is not actually at cap').toBe(true);

    // Restart the process, as a redeploy would: this is the step SQLite adds.
    spend.resetAgentSpendForTests();
    expect(
      spend.isOverUserDailyCap(USER, T0),
      'the at-cap state did not survive a restart — the durable mirror is not engaged',
    ).toBe(true);

    identity.deleteIdentityRows(USER);
    spend.resetAgentSpendForTests();

    expect(spend.isOverUserDailyCap(USER, T0)).toBe(false);
    expect(spend.agentUserSpendStatus(USER, T0).remainingUsd).toBe(cap);
  });

  it('AC5 NEGATIVE CONTROL: without the delete, the successor arrives already over cap', () => {
    const cap = spend.dailyUserCapUsd();
    spend.recordAgentSpend(USER, cap + 1, T0);

    identity.deleteIdentityRows(USER, { exclude: ['agent_spend'] });
    spend.resetAgentSpendForTests();

    expect(spend.isOverUserDailyCap(USER, T0)).toBe(true);
  });

  it('leaves OTHER identities untouched — the delete is keyed, not a truncate', () => {
    spend.recordAgentSpend(USER, 5, T0);
    spend.recordAgentSpend('bystander', 3, T0);

    identity.deleteIdentityRows(USER);
    spend.resetAgentSpendForTests();

    expect(spend.agentUserSpendStatus(USER, T0).spentUsd).toBe(0);
    expect(spend.agentUserSpendStatus('bystander', T0).spentUsd).toBe(3);
  });

  it('is a no-op that reports NO TEETH for an identity with nothing stored', () => {
    const results = identity.deleteIdentityRows('never-existed');
    const arm = results.find((r) => r.table === 'agent_spend');
    expect(arm?.rowsBefore).toBe(0);
    expect(arm?.rowsRemaining).toBe(0);
    expect(identity.identityRowsDeleted(results)).toBe(0);
  });
});

describe('TRA-2535 — every registered table is actually cleared', () => {
  /**
   * Plant one row for `username` in `table` using only the table's own schema.
   *
   * Generic on purpose. A hand-written INSERT per table would have to be updated
   * alongside the registry, which is the same "someone remembers" failure this
   * file exists to remove — and a forgotten one would silently plant nothing,
   * making that table's assertion vacuous.
   */
  function plantRow(table: string, column: string, username: string): void {
    const db = sqlite.getStateDb();
    if (!db) throw new Error('no db');
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
    expect(cols.length, `${table} does not exist — the owning store never ran`).toBeGreaterThan(0);
    const names = cols.map((c) => c.name);
    const values = cols.map((c) =>
      c.name === column ? username : /INT|REAL|NUM|DOUB|FLOA/i.test(c.type) ? 1 : 'tra2535-planted',
    );
    db.prepare(
      `INSERT OR REPLACE INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    ).run(...values);
  }

  function countIn(table: string, column: string, username: string): number {
    const db = sqlite.getStateDb();
    const row = db?.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(username) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  beforeAll(() => {
    // Both tables are created LAZILY by whichever store first touches them, so
    // force each one through its owning module rather than restating the DDL here.
    settings.readSettingsRowForRetirement('bootstrap');
    spend.recordAgentSpend('bootstrap', 1, T0);
  });

  // These two loop over the registry AT RUN TIME rather than generating one `it`
  // per entry, so a table added to `IDENTITY_TABLES` is covered without anyone
  // touching this file. Registering a table but not wiring its delete — or wiring
  // it against the wrong column — fails HERE rather than in six months.
  it('EVERY table in IDENTITY_TABLES: a planted row keyed on its own column is cleared', () => {
    expect(identity.IDENTITY_TABLES.length, 'the registry is empty — this gate measures nothing').toBeGreaterThan(0);

    for (const entry of identity.IDENTITY_TABLES) {
      const u = `sweep-${entry.table}`;
      plantRow(entry.table, entry.column, u);
      // POSITIVE MARK FIRST — a plant that silently did nothing would make the
      // post-delete zero below meaningless.
      expect(countIn(entry.table, entry.column, u), `planting into ${entry.table} did not take`).toBe(1);

      const results = identity.deleteIdentityRows(u);
      const arm = results.find((r) => r.table === entry.table);

      expect(arm, `${entry.table} was never attempted`).toBeDefined();
      expect(arm?.error, `${entry.table} delete threw`).toBeNull();
      expect(arm?.rowsBefore, `${entry.table} reported no teeth against a row that was there`).toBe(1);
      expect(arm?.rowsRemaining, `${entry.table} still holds the row`).toBe(0);
      expect(countIn(entry.table, entry.column, u)).toBe(0);
    }
  });

  it('EVERY table in IDENTITY_TABLES: NEGATIVE CONTROL — excluded, the planted row survives', () => {
    for (const entry of identity.IDENTITY_TABLES) {
      const u = `control-${entry.table}`;
      plantRow(entry.table, entry.column, u);
      identity.deleteIdentityRows(u, { exclude: [entry.table] });
      expect(
        countIn(entry.table, entry.column, u),
        `${entry.table} was cleared despite being excluded — its positive test above proves nothing`,
      ).toBe(1);
    }
  });
});

describe('TRA-2535 — the registry cannot silently fall behind the schema', () => {
  const SRC = dirname(fileURLToPath(import.meta.url));

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      // Tests are excluded: a fixture table created inside a suite is not a
      // production identity channel, and including them would make this gate fire
      // on scaffolding. Production DDL lives in the store modules.
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  /**
   * Assembled from parts so this file's own source does not match the pattern it
   * scans for — the scan skips `.test.ts`, and this keeps that belt-and-braces.
   */
  const DDL = new RegExp(['CREATE', '\\s+TABLE', '(?:\\s+IF\\s+NOT\\s+EXISTS)?', '\\s+([A-Za-z_][A-Za-z0-9_]*)'].join(''), 'gi');

  it('every table created in packages/server/src is registered or explicitly allowlisted', () => {
    const declared = new Set<string>();
    const where = new Map<string, string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(DDL)) {
        declared.add(m[1]!);
        if (!where.has(m[1]!)) where.set(m[1]!, file.slice(SRC.length + 1));
      }
    }

    // The scan itself must have teeth: if the regex or the walk breaks, `declared`
    // goes empty and set-equality passes against an empty set.
    expect(declared.size, 'the DDL scan found no tables at all — this gate is not measuring anything').toBeGreaterThan(0);
    expect(declared.has('agent_spend')).toBe(true);
    expect(declared.has('account_settings')).toBe(true);

    const registered = new Set([
      ...identity.IDENTITY_TABLES.map((t) => t.table),
      ...identity.NON_IDENTITY_TABLES.map((t) => t.table),
    ]);

    const unregistered = [...declared].filter((t) => !registered.has(t));
    expect(
      unregistered,
      `New \`state.db\` table(s) with no lifecycle decision: ${unregistered
        .map((t) => `${t} (${where.get(t)})`)
        .join(', ')}.\n` +
        'Every table here is keyed by something, and if that key is the recyclable username ' +
        'it inherits TRA-2513/2520/2535 verbatim: the row outlives DELETE /api/account and ' +
        'the next holder of the name reads it.\n' +
        'Add it to IDENTITY_TABLES (with its key column) in sqlite-identity.ts, or to ' +
        'NON_IDENTITY_TABLES with a written reason.',
    ).toEqual([]);

    // The reverse direction: a registered table that no longer exists means the
    // delete is silently matching nothing.
    const stale = [...registered].filter((t) => !declared.has(t));
    expect(stale, `Registered table(s) with no CREATE anywhere in src: ${stale.join(', ')}`).toEqual([]);
  });

  it('no identity table is registered without a key column', () => {
    for (const t of identity.IDENTITY_TABLES) {
      expect(t.column, `${t.table} has no key column`).toBeTruthy();
      expect(t.table).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(t.column).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('every allowlisted non-identity table carries a REASON', () => {
    // Empty today, and that is a measurement: at this SHA every table in state.db
    // is keyed by the recyclable username. The assertion is here so an entry added
    // later cannot be a bare name.
    for (const t of identity.NON_IDENTITY_TABLES) {
      expect(t.reason.trim().length, `${t.table} was allowlisted with no reason`).toBeGreaterThan(20);
    }
  });
});
