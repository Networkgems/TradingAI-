// TRA-1052 (TRA-1045 R1) — durability of the SQLite-backed hot-state stores.
// Proves the acceptance criteria at the store level:
//   • committed agent-spend ledger survives a (simulated) restart so the daily
//     cap is not reset by a redeploy mid-day;
//   • account settings survive a restart via SQLite;
//   • the one-time JSON importer runs on first boot and is idempotent.
//
// A "restart" is simulated by closing + reopening the SAME on-disk state.db
// (the persistent in-memory caches are cleared first), exactly the state a fresh
// process sees: empty memory, populated disk.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@trading-app/shared';

// account-settings captures DATA_DIR at module load → set it BEFORE importing.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'state-persistence-'));
process.env.DATA_DIR = TMP_ROOT;

type SqliteModule = typeof import('./sqlite.js');
type SpendModule = typeof import('./agent-spend-store.js');
type SettingsModule = typeof import('./account-settings.js');

let sqlite: SqliteModule;
let spend: SpendModule;
let settings: SettingsModule;

beforeAll(async () => {
  sqlite = await import('./sqlite.js');
  spend = await import('./agent-spend-store.js');
  settings = await import('./account-settings.js');
  // Arm the durable store against the temp dir (the persistent disk stand-in).
  sqlite.__setStateDbForTests(TMP_ROOT);
});

afterAll(() => {
  sqlite.__setStateDbForTests(null);
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Simulate a process restart: clear in-memory state, reopen the same db file. */
function simulateRestart(usernames: string[] = []): void {
  spend.resetAgentSpendForTests();
  for (const u of usernames) settings.clearSettingsCache(u);
  sqlite.__setStateDbForTests(TMP_ROOT);
}

const DAY1 = Date.parse('2026-06-23T15:00:00Z');

describe('agent-spend committed ledger durability (acceptance: cap not reset by redeploy)', () => {
  it('survives a restart so the per-user daily total is preserved', () => {
    spend.recordAgentSpend('alice', 6, DAY1);
    expect(spend.agentUserSpendStatus('alice', DAY1).spentUsd).toBeCloseTo(6, 4);

    simulateRestart();

    // Fresh in-memory bucket rehydrates the committed total from SQLite.
    const status = spend.agentUserSpendStatus('alice', DAY1);
    expect(status.spentUsd).toBeCloseTo(6, 4);
    expect(spend.isOverUserDailyCap('alice', DAY1)).toBe(false);

    // And the cap still trips after the restart once more spend accrues.
    spend.recordAgentSpend('alice', 5, DAY1); // → $11 > $10 cap
    expect(spend.isOverUserDailyCap('alice', DAY1)).toBe(true);
  });

  it('persists only COMMITTED spend, not in-flight reservations (R2 reserved map is ephemeral)', () => {
    // An un-committed reservation is in-memory only: a restart (which in reality
    // also kills the awaiting caller, so commit/release never fire) forgets it.
    const res = spend.tryReserveAgentSpend('bob', DAY1);
    expect(res).not.toBeNull();
    simulateRestart();
    expect(spend.agentUserSpendStatus('bob', DAY1).spentUsd).toBeCloseTo(0, 4);

    // A reservation reconciled to a real cost (commit) DOES survive a later restart.
    const res2 = spend.tryReserveAgentSpend('bob', DAY1);
    if (res2) spend.commitReservation(res2, 4, DAY1);
    expect(spend.agentUserSpendStatus('bob', DAY1).spentUsd).toBeCloseTo(4, 4);
    simulateRestart();
    expect(spend.agentUserSpendStatus('bob', DAY1).spentUsd).toBeCloseTo(4, 4);
  });
});

describe('account-settings durability via SQLite', () => {
  it('survives a restart', async () => {
    const custom: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS, riskPerTradeDemoStocks: 0.042 };
    await settings.saveSettings('carol', custom);

    simulateRestart(['carol']);

    const loaded = await settings.loadSettings('carol');
    expect(loaded.riskPerTradeDemoStocks).toBeCloseTo(0.042, 6);
  });
});

describe('one-time JSON importer (idempotent)', () => {
  it('imports a legacy per-user JSON file on first boot, then reads from SQLite', async () => {
    const user = 'dave';
    const userDir = join(TMP_ROOT, 'users', user);
    mkdirSync(userDir, { recursive: true });
    const legacy: Partial<AccountSettings> = { riskPerTradeDemoStocks: 0.137 };
    writeFileSync(join(userDir, 'account-settings.json'), JSON.stringify(legacy), 'utf-8');

    // First load with no db row → imports the JSON file.
    settings.clearSettingsCache(user);
    const first = await settings.loadSettings(user);
    expect(first.riskPerTradeDemoStocks).toBeCloseTo(0.137, 6);

    // Remove the JSON file: a second load (after restart) must still succeed from
    // the db — proving the import persisted and is not re-done from the file.
    rmSync(join(userDir, 'account-settings.json'), { force: true });
    simulateRestart([user]);
    const second = await settings.loadSettings(user);
    expect(second.riskPerTradeDemoStocks).toBeCloseTo(0.137, 6);
  });
});
