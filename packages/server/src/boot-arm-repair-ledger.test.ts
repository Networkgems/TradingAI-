// TRA-3810 — controls for the durable live-arm demotion-attempt record.
//
// The two that the acceptance criteria actually turn on:
//
//   POSITIVE CONTROL — drives a REAL repair through the REAL `applyLiveBrokerArm`
//   chokepoint (not a hand-built fixture row), then RESTARTS the ledger, and asserts the
//   event is still readable and the detector goes non-green. If this ever passes while
//   the ledger is broken, the ledger is not being exercised.
//
//   NEGATIVE CONTROL — a clean write path stays green, and the green is checked to NOT
//   come from an empty denominator: `observingSinceMs` must be non-null, i.e. the absence
//   is asserted over a measured window. The paired anti-control drops the marker and
//   asserts the SAME zero-attempt ledger no longer reads as a measured clean.
//
// Every case runs against a real temp DATA_DIR with real file IO, because the defect
// class this ticket is about (a counter that evaporates on restart) is only visible
// across a genuine hydrate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BOOT_ARM_REPAIR_LOG_FILENAME,
  bootArmRepairLogPath,
  clearBootArmRepairLedger,
  hydrateBootArmRepairLedgerFromDisk,
  recordBootArmObservationStart,
  recordBootArmRepair,
  summarizeBootArmRepairs,
} from './boot-arm-repair-ledger.js';
import { applyLiveBrokerArm, shouldBootArmLiveEquity } from './signal-engine.js';
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

/**
 * ARMED: the exact env shape `shouldBootArmLiveEquity` requires (operator pin +
 * `TRADIER_ENV=production` + resolvable prod creds, TRA-1411/TRA-1482).
 *
 * Every control below asserts eligibility explicitly before relying on it — an arm that
 * is not eligible makes `applyLiveBrokerArm` return `[]` unconditionally, which would
 * make the NEGATIVE control pass for the wrong reason (nothing to repair because nothing
 * is armed) and the POSITIVE control fail. That is the vacuity trap this ticket is about,
 * reproduced one level down in its own test file.
 */
function armEnv(): void {
  process.env.DATA_DIR = dir; // non-ephemeral: outside the bundle, and the var IS set
  process.env.LIVE_EQUITY_BOOT_USER = 'admin';
  process.env.TRADIER_ENV = 'production';
  process.env.TRADIER_API_TOKEN = 'tok-test';
  process.env.TRADIER_ACCOUNT_ID = 'acct-test';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra3810-'));
  armEnv();
  clearBootArmRepairLedger();
});

afterEach(() => {
  clearBootArmRepairLedger();
  for (const k of ARM_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

it('meta-control — the fixture env really does arm the live-broker arm', () => {
  // If this fails, every "nothing was repaired" assertion below is vacuous.
  expect(shouldBootArmLiveEquity(demotedSettings(), 'admin')).toBe(true);
});

/** Settings a demoting `{mode:'demo'}` PUT would produce for the pinned operator. */
function demotedSettings(): AccountSettings {
  return { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' } as AccountSettings;
}

/** The settings-PUT chokepoint, verbatim in structure to `index.ts`. */
function simulateDemotingSettingsWrite(now: number): string[] {
  const updated = demotedSettings();
  const armRepaired = applyLiveBrokerArm(updated, 'admin');
  if (armRepaired.length > 0) {
    recordBootArmRepair({
      origin: 'settings_write',
      username: 'admin',
      repaired: armRepaired,
      bodyFields: ['mode'],
      requestOrigin: {
        ip: '203.0.113.7',
        forwardedFor: '203.0.113.7',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        route: 'PUT /api/account/settings',
        referer: 'https://tradingai-bqb1.onrender.com/settings?tab=account',
      },
      now,
    });
  }
  return armRepaired;
}

describe('TRA-3810 positive control — a REAL repair, driven through the real arm, survives a restart', () => {
  it('records the attempt, and it is still readable after the ledger is torn down and re-hydrated', () => {
    const attemptAt = Date.parse('2026-08-16T18:42:20.569Z');
    const afterRestart = Date.parse('2026-08-17T02:00:00.000Z');

    hydrateBootArmRepairLedgerFromDisk(dir, attemptAt);
    recordBootArmObservationStart('2026-08-16T14:44:26.017Z', Date.parse('2026-08-16T14:44:26.017Z'));

    // Drive the REAL repair. This is the positive control's teeth: if
    // `applyLiveBrokerArm` stops repairing, there is nothing to record and the assertion
    // below fails — the control cannot pass against a dead chokepoint.
    const repaired = simulateDemotingSettingsWrite(attemptAt);
    expect(repaired).toContain('mode');

    const live = summarizeBootArmRepairs({ now: attemptAt, eligible: true });
    expect(live.state).toBe('attempts_recorded');
    expect(live.attempts).toBe(1);

    // ── THE RESTART. Everything in memory dies; only the file survives. ──
    clearBootArmRepairLedger();
    expect(summarizeBootArmRepairs({ eligible: true }).attempts).toBe(0); // memory is gone

    const h = hydrateBootArmRepairLedgerFromDisk(dir, afterRestart);
    expect(h.repairs).toBe(1);

    const after = summarizeBootArmRepairs({
      now: afterRestart,
      eligible: true,
      bootMs: afterRestart, // this process booted after the attempt
    });
    // ACCEPTANCE 1 — "a repair event observed before a restart is still readable after it".
    expect(after.state).toBe('attempts_recorded');
    expect(after.attempts).toBe(1);
    expect(after.events[0]!.survivedRestart).toBe(true);
    expect(after.events[0]!.at).toBe('2026-08-16T18:42:20.569Z');
    expect(after.events[0]!.origin).toBe('settings_write');
    expect(after.events[0]!.repaired).toContain('mode');
    expect(after.events[0]!.bodyFields).toEqual(['mode']);
    expect(after.durability.hydratedRepairs).toBe(1);
    expect(after.blindReasons).toEqual([]);
  });

  it('publishes coarse attribution and NEVER the raw IP or user-agent (the route is unauthenticated)', () => {
    const at = Date.parse('2026-08-16T18:42:20.569Z');
    hydrateBootArmRepairLedgerFromDisk(dir, at);
    simulateDemotingSettingsWrite(at);

    const s = summarizeBootArmRepairs({ now: at, eligible: true });
    const ro = s.events[0]!.requestOrigin!;
    expect(ro.route).toBe('PUT /api/account/settings');
    // Referer reduced to scheme+host: the `?tab=account` query is dropped.
    expect(ro.refererOrigin).toBe('https://tradingai-bqb1.onrender.com');
    expect(ro.userAgentFamily).toBe('browser:chrome');

    // The whole published payload must not carry the origin fields that only belong on
    // disk. Serialized, so a future field added anywhere in the tree is caught too.
    const wire = JSON.stringify(s);
    expect(wire).not.toContain('203.0.113.7');
    expect(wire).not.toContain('AppleWebKit');
    expect(wire).not.toContain('tab=account');

    // …and they ARE on disk, where reading them needs shell access.
    const onDisk = readFileSync(bootArmRepairLogPath(dir), 'utf8');
    expect(onDisk).toContain('203.0.113.7');
    expect(onDisk).toContain('AppleWebKit');
  });
});

describe('TRA-3810 negative control — a clean path stays green, and the green is NOT from an empty denominator', () => {
  it('no attempts + a measured observation window reads no_attempt_observed with a real window', () => {
    const bootAt = Date.parse('2026-06-01T00:00:00.000Z');
    const now = Date.parse('2026-08-17T00:00:00.000Z');

    hydrateBootArmRepairLedgerFromDisk(dir, bootAt);
    recordBootArmObservationStart('2026-06-01T00:00:00.000Z', bootAt);

    // A NON-demoting settings write on the same real chokepoint: already converged, so
    // `applyLiveBrokerArm` repairs nothing and nothing is recorded. This is the clean path.
    //
    // The arm must be ELIGIBLE for this to mean anything — on an ineligible service the
    // call returns [] whatever you hand it, and this control would pass against a dead
    // arm. Asserted, not assumed.
    const converged = { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' } as AccountSettings;
    expect(shouldBootArmLiveEquity(converged, 'admin')).toBe(true);
    applyLiveBrokerArm(converged, 'admin'); // first call converges the remaining fields
    const secondPass = applyLiveBrokerArm(converged, 'admin');
    expect(secondPass).toEqual([]); // genuinely clean — nothing to record

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.state).toBe('no_attempt_observed');
    expect(s.blindReasons).toEqual([]);
    // THE POINT: the green is backed by a measured window, not by an empty file.
    expect(s.observingSinceMs).toBe(bootAt);
    expect(s.observingDays).toBe(77);
    expect(s.observationBoots).toBe(1);
  });

  it('ANTI-CONTROL — the same zero-attempt ledger with NO marker cannot claim a measured window', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    // No `recordBootArmObservationStart` — i.e. nobody ever established when watching began.

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.state).toBe('no_attempt_observed');
    // The state is the same; the DENOMINATOR is what differs, and it is published as
    // null rather than smoothed into a clean-looking zero.
    expect(s.observingSinceMs).toBeNull();
    expect(s.observingDays).toBeNull();
    expect(s.observationBoots).toBe(0);
  });
});

describe('TRA-3810 the third state — an instrument that could not have seen anything is never a pass', () => {
  it('an ineligible arm is BLIND, not clean: applyLiveBrokerArm returns [] by construction', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmObservationStart('boot-1', now);

    const s = summarizeBootArmRepairs({ now, eligible: false });
    expect(s.state).toBe('instrument_blind');
    expect(s.blindReasons).toContain('arm_not_eligible');
  });

  it('UNKNOWN eligibility fails CLOSED — omitting it reads blind, never clean', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmObservationStart('boot-1', now);

    expect(summarizeBootArmRepairs({ now }).state).toBe('instrument_blind');
    expect(summarizeBootArmRepairs({ now, eligible: null }).blindReasons).toContain('arm_not_eligible');
  });

  it('an EPHEMERAL DATA_DIR is BLIND — the rows die on redeploy, which is the counter this replaces', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    delete process.env.DATA_DIR; // the in-bundle fallback: every IO call still SUCCEEDS
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmObservationStart('boot-1', now);

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.state).toBe('instrument_blind');
    expect(s.blindReasons).toContain('ephemeral_data_dir');
    expect(s.durability.ephemeral).toBe(true);
  });

  it('never hydrated is BLIND — a memory-only ledger is not a durable record', () => {
    clearBootArmRepairLedger();
    const s = summarizeBootArmRepairs({ eligible: true });
    expect(s.state).toBe('instrument_blind');
    expect(s.blindReasons).toContain('not_hydrated');
    expect(s.durability.dataDir).toBeNull();
  });

  it('a swallowed append is COUNTED and forces BLIND — it must never read as a clean zero', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    // Make the append fail: put a DIRECTORY where the log file goes.
    mkdirSync(bootArmRepairLogPath(dir), { recursive: true });

    recordBootArmObservationStart('boot-1', now);
    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.durability.appendErrors).toBeGreaterThan(0);
    expect(s.state).toBe('instrument_blind');
    expect(s.blindReasons).toContain('append_errors');
  });

  it('PRECEDENCE — a recorded attempt outranks blindness; a positive is never demoted to a plumbing complaint', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: ['mode'], now });
    mkdirSync(bootArmRepairLogPath(dir) + '.blocked', { recursive: true });

    // Blind for an unrelated reason (arm reported ineligible) AND holding an attempt.
    const s = summarizeBootArmRepairs({ now, eligible: false });
    expect(s.state).toBe('attempts_recorded');
    expect(s.attempts).toBe(1);
    // The blindness is still disclosed — it means the count is a LOWER BOUND.
    expect(s.blindReasons).toContain('arm_not_eligible');
  });
});

describe('TRA-3810 record hygiene', () => {
  it('a no-op convergence ([]) is not an event and cannot manufacture an alarm', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmObservationStart('boot-1', now);
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: [], now });
    recordBootArmRepair({ origin: 'boot', username: 'admin', repaired: [], now });

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.state).toBe('no_attempt_observed');
    expect(s.attempts).toBe(0);
  });

  it('a boot repair is deduped on its ranAt, so re-reading the latched outcome cannot double-count', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    for (let i = 0; i < 3; i += 1) {
      recordBootArmRepair({
        origin: 'boot',
        username: 'admin',
        repaired: ['mode'],
        dedupeKey: 'boot:2026-08-17T00:00:00.000Z',
        now,
      });
    }
    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.attempts).toBe(1);
    expect(s.attemptsByOrigin).toEqual({ settings_write: 0, boot: 1 });
    // …and only one line reached disk.
    const lines = readFileSync(bootArmRepairLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('boot and settings_write repairs are counted on SEPARATE axes, never pooled', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmRepair({ origin: 'boot', username: 'admin', repaired: ['mode'], now: now - 5000 });
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: ['mode'], now });

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.attemptsByOrigin).toEqual({ settings_write: 1, boot: 1 });
    expect(s.events[0]!.origin).toBe('settings_write'); // most recent first
    expect(s.lastAttemptAt).toBe(now);
  });

  it('a torn trailing line is skipped, not fatal, and does not lose the rows before it', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    const path = join(dir, BOOT_ARM_REPAIR_LOG_FILENAME);
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: ['mode'], now });
    writeFileSync(path, readFileSync(path, 'utf8') + '{"ts":1,"kind":"rep', 'utf8');

    clearBootArmRepairLedger();
    const h = hydrateBootArmRepairLedgerFromDisk(dir, now);
    expect(h.repairs).toBe(1);
    expect(summarizeBootArmRepairs({ now, eligible: true }).attempts).toBe(1);
  });

  it('a corrupt repair row with no repaired fields is DROPPED — an unattributable row cannot raise the alarm', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    writeFileSync(
      join(dir, BOOT_ARM_REPAIR_LOG_FILENAME),
      JSON.stringify({ ts: now, kind: 'repair', origin: 'settings_write', repaired: [] }) + '\n',
      'utf8',
    );
    const h = hydrateBootArmRepairLedgerFromDisk(dir, now);
    expect(h.repairs).toBe(0);
    expect(summarizeBootArmRepairs({ now, eligible: true }).state).toBe('no_attempt_observed');
  });

  it('rows outside the retention window are dropped AND compacted off disk', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    const ancient = now - 200 * 24 * 60 * 60 * 1000; // > 180d
    const recent = now - 5 * 24 * 60 * 60 * 1000;
    hydrateBootArmRepairLedgerFromDisk(dir, ancient);
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: ['mode'], now: ancient });
    recordBootArmRepair({ origin: 'settings_write', username: 'admin', repaired: ['mode'], now: recent });

    clearBootArmRepairLedger();
    const h = hydrateBootArmRepairLedgerFromDisk(dir, now);
    expect(h.repairs).toBe(1);
    expect(readFileSync(bootArmRepairLogPath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('distinct request origins are counted so a RECURRING rewriter is separable from one writer', () => {
    const now = Date.parse('2026-08-17T00:00:00.000Z');
    hydrateBootArmRepairLedgerFromDisk(dir, now);
    const mk = (ua: string, ts: number) =>
      recordBootArmRepair({
        origin: 'settings_write',
        username: 'admin',
        repaired: ['mode'],
        requestOrigin: {
          ip: '203.0.113.7',
          forwardedFor: null,
          userAgent: ua,
          route: 'PUT /api/account/settings',
          referer: 'https://tradingai-bqb1.onrender.com/settings',
        },
        now: ts,
      });
    mk('Mozilla/5.0 Chrome/126.0', now - 3000);
    mk('Mozilla/5.0 Chrome/127.0', now - 2000); // same family, same triple
    mk('curl/8.4.0', now - 1000); // a different writer entirely

    const s = summarizeBootArmRepairs({ now, eligible: true });
    expect(s.attempts).toBe(3);
    expect(s.distinctRequestOrigins).toBe(2);
  });
});
