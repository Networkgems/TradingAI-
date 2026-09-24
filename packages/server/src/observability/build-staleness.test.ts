// TRA-4851 — boot staleness self-check, off the TRA-4849 boot-resurrect
// incident (a 42-day-old HEAD re-bound :4242 and read like quiet health).
//
// The controls that matter are the discriminating ones: the incident shape
// must read `stale`, a same-week boot must read `fresh`, and an unresolvable
// age must read `unknown` with a named reason — never fall into either verdict
// arm (the CLAUDE.md rule: absent evidence is its own named state).

import { describe, expect, it, beforeEach } from 'vitest';
import {
  computeBuildStaleness,
  parseThresholdDays,
  resolveBuildStaleness,
  resolveCommitTimeMs,
  resetBuildStalenessCacheForTest,
  DEFAULT_MAX_COMMIT_AGE_DAYS,
} from './build-staleness.js';

const DAY_MS = 86_400_000;
const BOOT = Date.parse('2026-09-24T01:34:00Z'); // the incident's boot instant

describe('computeBuildStaleness', () => {
  it('grades the TRA-4849 incident shape (42-day-old commit at boot) as stale', () => {
    const v = computeBuildStaleness({
      commitTimeMs: BOOT - 42 * DAY_MS,
      bootMs: BOOT,
      thresholdDays: 7,
      measuredAtMs: BOOT,
    });
    expect(v.state).toBe('stale');
    expect(v.ageDaysAtBoot).toBe(42);
    expect(v.reason).toBeNull();
  });

  it('grades a same-week commit as fresh', () => {
    const v = computeBuildStaleness({
      commitTimeMs: BOOT - 2 * DAY_MS,
      bootMs: BOOT,
      thresholdDays: 7,
      measuredAtMs: BOOT,
    });
    expect(v.state).toBe('fresh');
    expect(v.ageDaysAtBoot).toBe(2);
  });

  it('sits exactly on the threshold on the fresh side (> not >=)', () => {
    const v = computeBuildStaleness({
      commitTimeMs: BOOT - 7 * DAY_MS,
      bootMs: BOOT,
      thresholdDays: 7,
      measuredAtMs: BOOT,
    });
    expect(v.state).toBe('fresh');
  });

  it('an unresolvable commit time is unknown with a named reason, not fresh', () => {
    const v = computeBuildStaleness({
      commitTimeMs: null,
      bootMs: BOOT,
      thresholdDays: 7,
      unknownReason: 'no_commit',
      measuredAtMs: BOOT,
    });
    expect(v.state).toBe('unknown');
    expect(v.reason).toBe('no_commit');
    expect(v.ageDaysAtBoot).toBeNull();
  });

  it('a clock-skewed future commit clamps to age 0 and reads fresh', () => {
    const v = computeBuildStaleness({
      commitTimeMs: BOOT + DAY_MS,
      bootMs: BOOT,
      thresholdDays: 7,
      measuredAtMs: BOOT,
    });
    expect(v.state).toBe('fresh');
    expect(v.ageDaysAtBoot).toBe(0);
  });
});

describe('parseThresholdDays', () => {
  it('accepts a positive override', () => {
    expect(parseThresholdDays('14')).toBe(14);
  });
  it.each(['garbage', 'NaN', '0', '-3', '', undefined])(
    'rejects %j into the default, never into the permissive arm',
    (raw) => {
      expect(parseThresholdDays(raw as string | undefined)).toBe(DEFAULT_MAX_COMMIT_AGE_DAYS);
    },
  );
});

describe('resolveCommitTimeMs (against this repo, real git)', () => {
  it('resolves a real commit to a plausible epoch', () => {
    // HEAD of the checkout the tests run in — must resolve and be in the past.
    const ms = resolveCommitTimeMs('HEAD');
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    expect(ms!).toBeLessThanOrEqual(Date.now() + DAY_MS);
  });

  it('returns null for a sha git does not know', () => {
    expect(resolveCommitTimeMs('0'.repeat(40))).toBeNull();
  });
});

describe('resolveBuildStaleness (cached runtime resolver)', () => {
  beforeEach(() => resetBuildStalenessCacheForTest());

  it('null commit reads unknown/no_commit', () => {
    const v = resolveBuildStaleness({ commit: null, bootMs: Date.now(), env: {} });
    expect(v.state).toBe('unknown');
    expect(v.reason).toBe('no_commit');
  });

  it('caches the first verdict for the life of the process', () => {
    const a = resolveBuildStaleness({ commit: null, bootMs: Date.now(), env: {} });
    // Different inputs on the second call must NOT produce a different verdict —
    // the commit is immutable for the process, so the cache answers.
    const b = resolveBuildStaleness({ commit: 'HEAD', bootMs: Date.now(), env: {} });
    expect(b).toBe(a);
  });
});
