// TRA-4861 — controls for the ATTRIBUTED demotion row.
//
// ── The defect these controls pin ────────────────────────────────────────────
// `applyLiveBrokerArm` enforces the operator pin only while `shouldBootArmLiveEquity`
// is true. When it is false the function returns `[]` — which means the demoted write
// persists unopposed AND no ledger row can be written, because `recordBootArmRepair` is
// reachable only from a non-empty repair set. "A demotion can reach disk" and "the ledger
// can see it" were therefore MUTUALLY EXCLUSIVE by construction, and the boot-arm event
// that eventually surfaces (`origin: 'boot'`) records no actor.
//
// Measured on bqb1 2026-09-23: three writes under one traceId (01:13:46Z → 01:15:42Z)
// left `mode:'demo'` + `liveTradierEnvOptions:'sandbox'` on disk, `attemptsByOrigin`
// never moved off `{settings_write: 9}`, the demotion survived five boots, and the sixth
// repaired it 15h26m later with no actor on record.
//
// ── The two controls that actually matter ────────────────────────────────────
//   POSITIVE — drives a demoting write through the REAL resolver at the REAL ineligible
//   branch, RESTARTS the ledger, and asserts the actor is still readable afterwards. A
//   row that does not survive a hydrate is worthless here: the process that repairs is
//   never the process that demoted.
//
//   COMPACTION — the hydrate rewrites the file down to the rows `parseRow` accepts, so an
//   unrecognised `kind` is DELETED from disk rather than ignored. This control fails
//   loudly if the new kind is ever dropped from that allow-list, which is the one
//   regression that would make the whole instrument silently evaporate at the first
//   restart while every other test still passed.
//
// Plus a publication-neutrality control, because TRA-4861 is explicitly forbidden from
// changing what `/api/health/options-live` publishes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bootArmRepairLogPath,
  clearBootArmRepairLedger,
  hydrateBootArmRepairLedgerFromDisk,
  lastPinnedOperatorDemotionWhileIneligible,
  recordBootArmObservationStart,
  recordPinnedOperatorDemotionWhileIneligible,
  summarizeBootArmRepairs,
} from './boot-arm-repair-ledger.js';
import {
  applyLiveBrokerArm,
  resolvePinnedOperatorDemotionWhileIneligible,
  shouldBootArmLiveEquity,
} from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@trading-app/shared';

let dir: string;
const savedEnv = { ...process.env };
const ARM_ENV_KEYS = [
  'DATA_DIR',
  'LIVE_EQUITY_BOOT_USER',
  'TRADIER_ENV',
  'TRADIER_API_TOKEN',
  'TRADIER_ACCOUNT_ID',
];

/** The env shape `shouldBootArmLiveEquity` requires — the arm ENFORCING. */
function armEnv(): void {
  process.env.DATA_DIR = dir;
  process.env.LIVE_EQUITY_BOOT_USER = 'admin';
  process.env.TRADIER_ENV = 'production';
  process.env.TRADIER_API_TOKEN = 'tok-test';
  process.env.TRADIER_ACCOUNT_ID = 'acct-test';
}

/**
 * The incident's env: operator still pinned, prod creds still present, but the SERVICE
 * env var is not `production` — so the arm is dormant and enforces nothing. This is the
 * single flip that opened the 2026-09-23 window, and it is mutable from the Render
 * dashboard with no trace in this repo.
 */
function ineligibleByServiceEnv(): void {
  armEnv();
  process.env.TRADIER_ENV = 'sandbox';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra4861-'));
  armEnv();
  clearBootArmRepairLedger();
  hydrateBootArmRepairLedgerFromDisk(dir);
});

afterEach(() => {
  clearBootArmRepairLedger();
  for (const k of ARM_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** What a demoting `{mode:'demo', liveTradierEnvOptions:'sandbox'}` PUT produces. */
function demotedSettings(): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'demo',
    liveTradierEnvOptions: 'sandbox',
  } as AccountSettings;
}

/**
 * The settings-PUT chokepoint's INELIGIBLE branch, structurally verbatim to `index.ts`.
 * Deliberately calls the real `applyLiveBrokerArm` first, so the test would break if that
 * function ever started repairing here — which is the behaviour change that would make
 * this whole instrument redundant, and must not pass silently either way.
 */
function simulateWriteAtChokepoint(
  settings: AccountSettings,
  username: string,
  now: number,
  bodyFields: string[] = ['mode', 'liveTradierEnvOptions'],
): { repaired: string[]; recorded: boolean } {
  const repaired = applyLiveBrokerArm(settings, username);
  if (repaired.length > 0) return { repaired, recorded: false };
  const demotion = resolvePinnedOperatorDemotionWhileIneligible(settings, username);
  if (!demotion) return { repaired, recorded: false };
  recordPinnedOperatorDemotionWhileIneligible({
    username,
    demoted: demotion.demoted,
    ineligibleBecause: demotion.ineligibleBecause,
    bodyFields,
    requestOrigin: {
      ip: '203.0.113.7',
      forwardedFor: null,
      userAgent: 'Mozilla/5.0 Chrome/999',
      route: 'PUT /api/account/settings',
      referer: 'https://example.invalid/settings',
    },
    now,
  });
  return { repaired, recorded: true };
}

describe('meta-controls — neither fixture env is vacuous', () => {
  it('the ARMED env really does make the arm eligible', () => {
    // If this fails, "the eligible path records nothing new" below is vacuous.
    expect(shouldBootArmLiveEquity(demotedSettings(), 'admin')).toBe(true);
  });

  it('the INELIGIBLE env really does disarm it, and disarms it for the stated reason', () => {
    ineligibleByServiceEnv();
    expect(shouldBootArmLiveEquity(demotedSettings(), 'admin')).toBe(false);
    // Pin the REASON, not just the boolean. Three different inputs can produce `false`
    // and they have three different owners; a control that accepts any of them would
    // pass even if the fixture had accidentally cleared the creds instead.
    expect(resolvePinnedOperatorDemotionWhileIneligible(demotedSettings(), 'admin'))
      .toMatchObject({ ineligibleBecause: 'service_env_not_production' });
  });

  it('reproduces the incident: while ineligible, a demoting write is NOT re-converged', () => {
    ineligibleByServiceEnv();
    const settings = demotedSettings();
    expect(applyLiveBrokerArm(settings, 'admin')).toEqual([]);
    // The values that reach disk. This is the whole defect in two assertions.
    expect(settings.mode).toBe('demo');
    expect(settings.liveTradierEnvOptions).toBe('sandbox');
  });
});

describe('POSITIVE CONTROL — the actor survives a restart', () => {
  it('records the write while ineligible and reads it back after a hydrate', () => {
    ineligibleByServiceEnv();
    const writeAt = Date.parse('2026-09-23T01:15:42.289Z');
    const out = simulateWriteAtChokepoint(demotedSettings(), 'admin', writeAt);
    expect(out.repaired).toEqual([]); // nothing opposed it — the incident's condition
    expect(out.recorded).toBe(true);

    // RESTART. Everything before this point is in-process state that the old instrument
    // also had; only what comes back after the hydrate is new capability.
    clearBootArmRepairLedger();
    hydrateBootArmRepairLedgerFromDisk(dir);

    const attributed = lastPinnedOperatorDemotionWhileIneligible(
      Date.parse('2026-09-23T16:42:05.239Z'), // the boot that repaired it, 15h26m later
    );
    expect(attributed).not.toBeNull();
    expect(attributed?.username).toBe('admin');
    expect(attributed?.at).toBe('2026-09-23T01:15:42.289Z');
    // The pair the boot-arm repaired — moving TOGETHER is the fingerprint that separates
    // this class from the nine `settings_write` events, which moved `mode` alone.
    expect(attributed?.demoted).toEqual(expect.arrayContaining(['mode', 'liveTradierEnvOptions']));
    expect(attributed?.ineligibleBecause).toBe('service_env_not_production');
    expect(attributed?.requestOrigin?.route).toBe('PUT /api/account/settings');
    expect(attributed?.bodyFields).toEqual(['mode', 'liveTradierEnvOptions']);
  });

  it('returns the most recent write at or before the repair instant, not the first', () => {
    ineligibleByServiceEnv();
    // The incident was a BURST of three writes under one traceId. The repair is caused by
    // the last one — the state it left on disk — so returning the earliest would name a
    // real write that is nonetheless the wrong one.
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:13:46.897Z'));
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:37.142Z'));
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:42.289Z'));

    clearBootArmRepairLedger();
    hydrateBootArmRepairLedgerFromDisk(dir);

    expect(lastPinnedOperatorDemotionWhileIneligible(Date.parse('2026-09-23T16:42:05.239Z'))?.at)
      .toBe('2026-09-23T01:15:42.289Z');
    // A boot BEFORE the burst must not be handed an actor from the future.
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.parse('2026-09-23T01:00:00.000Z')))
      .toBeNull();
  });

  it('a boot with no attributed write on record reads null, never a fabricated actor', () => {
    // The pre-ticket state, and the state after a row ages past retention. `null` must be
    // readable as "nothing on record" — the caller labels it `no_attributed_write_on_record`
    // rather than letting silence become an attribution.
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())).toBeNull();
  });
});

describe('COMPACTION CONTROL — the row is not deleted at the next boot', () => {
  it('survives the hydrate rewrite that compacts the ledger file', () => {
    ineligibleByServiceEnv();
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:42.289Z'));
    // Force a compaction by giving the hydrate a row it will drop (a torn line), so the
    // `kept.length < nonEmptyLines` branch actually runs. Without that the file is left
    // untouched and this control would pass without exercising the rewrite at all.
    const path = bootArmRepairLogPath(dir);
    appendFileSync(path, '{not json\n', 'utf8');

    clearBootArmRepairLedger();
    hydrateBootArmRepairLedgerFromDisk(dir);

    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).toContain('demotion_while_ineligible');
    expect(onDisk).not.toContain('{not json');
    // And still readable through the accessor, not merely present as text.
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())?.username).toBe('admin');
  });
});

describe('PUBLICATION NEUTRALITY — no byte of the health rollup moves', () => {
  it('attribution rows change no published counter', () => {
    ineligibleByServiceEnv();
    recordBootArmObservationStart('2026-09-23T00:00:00.000Z');
    const before = summarizeBootArmRepairs({ eligible: false, bootMs: Date.now() });

    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:42.289Z'));
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:43.000Z'));

    const after = summarizeBootArmRepairs({ eligible: false, bootMs: Date.now() });
    // TRA-4861 is explicitly forbidden from publishing anything new here, and
    // `scripts/check-boot-arm-repairs` is out of scope — so `attempts` moving would
    // re-baseline a detector this ticket does not own.
    expect(after.attempts).toBe(before.attempts);
    expect(after.attemptsByOrigin).toEqual(before.attemptsByOrigin);
    expect(after.events).toEqual(before.events);
    expect(after.lastAttemptAt).toBe(before.lastAttemptAt);
    expect(after.distinctRequestOrigins).toBe(before.distinctRequestOrigins);
    expect(after.observationBoots).toBe(before.observationBoots);
  });

  it('the hydrated durability counts stay on repairs+markers only', () => {
    ineligibleByServiceEnv();
    recordBootArmObservationStart('2026-09-23T00:00:00.000Z');
    simulateWriteAtChokepoint(demotedSettings(), 'admin', Date.parse('2026-09-23T01:15:42.289Z'));

    clearBootArmRepairLedger();
    const h = hydrateBootArmRepairLedgerFromDisk(dir);
    expect(h.repairs).toBe(0); // it is not a repair, and must never be counted as one
    expect(h.records).toBe(1); // the observation marker only
    // The documented consequence: the file holds MORE lines than `records` reports.
    const lines = readFileSync(bootArmRepairLogPath(dir), 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBe(2);
  });
});

describe('SCOPE CONTROLS — the recorder does not fire where it should not', () => {
  it('records nothing while the arm is ELIGIBLE (the existing chokepoint owns that)', () => {
    armEnv();
    const settings = demotedSettings();
    const out = simulateWriteAtChokepoint(settings, 'admin', Date.now());
    // The real repair happened, so this branch must not double-count the same attempt.
    expect(out.repaired.length).toBeGreaterThan(0);
    expect(out.recorded).toBe(false);
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())).toBeNull();
  });

  it('records nothing for a user who is not the pinned operator', () => {
    ineligibleByServiceEnv();
    const out = simulateWriteAtChokepoint(demotedSettings(), 'someone-else', Date.now());
    expect(out.recorded).toBe(false);
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())).toBeNull();
  });

  it('records nothing for a CLEAN write while ineligible', () => {
    ineligibleByServiceEnv();
    const clean = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierEnvOptions: 'production',
      liveTradeEquitiesTradier: true,
    } as AccountSettings;
    const out = simulateWriteAtChokepoint(clean, 'admin', Date.now());
    expect(out.recorded).toBe(false);
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())).toBeNull();
  });

  it('still attributes under the kill-switch, and names it as the reason', () => {
    // `LIVE_EQUITY_BOOT_USER=""` is the DOCUMENTED de-escalation lever, so this must not
    // clamp — but a real-money demotion still gets recorded, tagged with the reason, so a
    // reader can tell deliberate stand-down from env drift instead of seeing silence for
    // both. Recording is not opposing.
    armEnv();
    process.env.LIVE_EQUITY_BOOT_USER = '';
    expect(shouldBootArmLiveEquity(demotedSettings(), 'admin')).toBe(false);
    const settings = demotedSettings();
    const out = simulateWriteAtChokepoint(settings, 'admin', Date.now());
    expect(out.repaired).toEqual([]); // NOT clamped — the kill-switch still wins
    expect(settings.mode).toBe('demo');
    expect(out.recorded).toBe(true);
    expect(lastPinnedOperatorDemotionWhileIneligible(Date.now())?.ineligibleBecause)
      .toBe('operator_unpinned');
  });
});
