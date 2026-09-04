// TRA-4343 — a post-close redeploy must not render as a quiet session.
//
// The incident these lock: 2026-09-03 close 16:00 ET, postmarket slot missed at
// 18:40 ET, bqb1 restarted 21:11 ET onto `a22668a3`, review read at 21:59 ET.
// Three since-boot blocks all read 0. Every one of those zeros was VACUOUS.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  gradeSinceBootSessionCoverage,
  mostRecentClosedSession,
  RTH_SESSION_MINUTES,
} from './session-coverage.js';
import {
  clearEntrySiteCensusLedger,
  entrySiteCensusLogPath,
  hydrateEntrySiteCensusFromDisk,
  recordEntrySiteCensus,
  summarizeEntrySiteCensus,
} from './entry-site-census-ledger.js';
import {
  clearEntrySiteAssetClassCensus,
  gradeUnderlyingAssetClassHealth,
  recordEntrySiteAssetClassEvaluation,
  classifyUnderlyingAssetClass,
} from './underlying-asset-class.js';

// The 2026-09-03 incident instants, in UTC (ET is EDT, UTC-4).
const CLOSE_0903 = Date.parse('2026-09-03T20:00:00Z'); // 16:00 ET
const OPEN_0903 = Date.parse('2026-09-03T13:30:00Z'); // 09:30 ET
const BOOT_2111_ET = Date.parse('2026-09-04T01:11:00Z'); // 21:11 ET on 09-03
const REVIEW_2159_ET = Date.parse('2026-09-04T01:59:00Z'); // 21:59 ET on 09-03

describe('TRA-4343 session coverage — the boot_after_close disclosure', () => {
  it('names the session that just closed, not the calendar day of the read', () => {
    // 21:59 ET on 09-03 is 01:59Z on 09-04. A calendar-day reader lands on
    // 09-04 (a Friday that has not closed); the session being graded is 09-03.
    const s = mostRecentClosedSession(REVIEW_2159_ET);
    expect(s).not.toBeNull();
    expect(s?.date).toBe('2026-09-03');
    expect(s?.closeMs).toBe(CLOSE_0903);
    expect(s?.openMs).toBe(OPEN_0903);
  });

  it('THE INCIDENT: a 21:11 ET boot graded at 21:59 ET is boot_after_close and vacuous', () => {
    const c = gradeSinceBootSessionCoverage(new Date(BOOT_2111_ET).toISOString(), REVIEW_2159_ET);
    expect(c.status).toBe('boot_after_close');
    expect(c.zeroReading).toBe('vacuous');
    expect(c.coveredMinutes).toBe(0);
    expect(c.sessionDate).toBe('2026-09-03');
    expect(c.statement).toMatch(/VACUOUS/);
  });

  it('a process alive since before the open reads the zero as a real measurement', () => {
    const c = gradeSinceBootSessionCoverage(
      new Date(OPEN_0903 - 60 * 60 * 1000).toISOString(),
      REVIEW_2159_ET,
    );
    expect(c.status).toBe('covers_session');
    expect(c.zeroReading).toBe('measurement');
    expect(c.coveredMinutes).toBe(RTH_SESSION_MINUTES);
  });

  it('a mid-session boot is a LOWER BOUND, with the minutes it actually covered', () => {
    // 13:00 ET = 3h before the close.
    const c = gradeSinceBootSessionCoverage('2026-09-03T17:00:00Z', REVIEW_2159_ET);
    expect(c.status).toBe('partial_session');
    expect(c.zeroReading).toBe('lower_bound');
    expect(c.coveredMinutes).toBe(180);
  });

  it('a morning read grades the PREVIOUS session, so an overnight boot is still after its close', () => {
    // 10:00 ET Thu 09-03, booted 06:00 ET the same morning. The last CLOSED
    // session is Wed 09-02 and this process saw none of it.
    const c = gradeSinceBootSessionCoverage('2026-09-03T10:00:00Z', Date.parse('2026-09-03T14:00:00Z'));
    expect(c.sessionDate).toBe('2026-09-02');
    expect(c.status).toBe('boot_after_close');
    expect(c.zeroReading).toBe('vacuous');
  });

  it('walks back over a weekend to the Friday close', () => {
    // Sunday 2026-09-06 12:00 ET. Friday 09-04 is the last session.
    const s = mostRecentClosedSession(Date.parse('2026-09-06T16:00:00Z'));
    expect(s?.date).toBe('2026-09-04');
  });

  it('walks back over a holiday (Labor Day 2026-09-07) to the Friday close', () => {
    const s = mostRecentClosedSession(Date.parse('2026-09-07T22:00:00Z'));
    expect(s?.date).toBe('2026-09-04');
  });

  it('resolves the 16:00 ET close in EST as well as EDT (no hard-coded 20:00Z)', () => {
    // 2026-12-15 is EST (UTC-5) ⇒ the close is 21:00Z, not 20:00Z.
    const s = mostRecentClosedSession(Date.parse('2026-12-15T23:00:00Z'));
    expect(s?.date).toBe('2026-12-15');
    expect(s?.closeMs).toBe(Date.parse('2026-12-15T21:00:00Z'));
  });

  it('FAILS CLOSED: an absent or unparseable boot stamp is unknown/vacuous, never a measurement', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      const c = gradeSinceBootSessionCoverage(bad, REVIEW_2159_ET);
      expect(c.status).toBe('unknown');
      expect(c.zeroReading).toBe('vacuous');
      expect(c.coveredMinutes).toBeNull();
    }
  });
});

describe('TRA-4343 durable entry-site census — the twin that survives the redeploy', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4343-'));
    clearEntrySiteCensusLedger();
    clearEntrySiteAssetClassCensus();
  });

  afterEach(() => {
    clearEntrySiteCensusLedger();
    clearEntrySiteAssetClassCensus();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives the restart the since-boot counters do not', () => {
    hydrateEntrySiteCensusFromDisk(dir, CLOSE_0903);
    // A session's worth of evaluations, all refused (the datum the incident lost).
    for (let i = 0; i < 3; i += 1) {
      recordEntrySiteCensus('crypto_proxy_etf', 'static_list', true, 'admin', '2026-09-03', OPEN_0903 + i * 1000);
    }
    recordEntrySiteCensus('equity', 'static_list', false, 'admin', '2026-09-03', OPEN_0903 + 9000);
    expect(existsSync(entrySiteCensusLogPath(dir))).toBe(true);

    // ── the 21:11 ET redeploy: a brand-new process, in-memory counters gone ──
    clearEntrySiteCensusLedger();
    expect(summarizeEntrySiteCensus('2026-09-03').session).toBeNull();

    const h = hydrateEntrySiteCensusFromDisk(dir, REVIEW_2159_ET);
    expect(h).toEqual({ days: 1, evaluated: 4, refused: 3 });

    const s = summarizeEntrySiteCensus('2026-09-03');
    expect(s.wired).toBe(true);
    expect(s.session).toMatchObject({ etDay: '2026-09-03', evaluated: 4, refused: 3 });
    expect(s.session?.byClass).toEqual([
      { assetClass: 'crypto_proxy_etf', evaluated: 3, refused: 3 },
      { assetClass: 'equity', evaluated: 1, refused: 0 },
    ]);
    expect(s.session?.books).toEqual(['admin']);
  });

  it('⛔ an unwired ledger is NOT a durable zero', () => {
    // No hydrate ⇒ no DATA_DIR ⇒ nothing persisted.
    recordEntrySiteCensus('equity', 'static_list', false, 'admin', '2026-09-03', OPEN_0903);
    const s = summarizeEntrySiteCensus('2026-09-03');
    expect(s.wired).toBe(false);
    expect(s.statement).toMatch(/NOT WIRED/);
  });

  it('a wired ledger with no record for the session IS a measurement', () => {
    hydrateEntrySiteCensusFromDisk(dir, REVIEW_2159_ET);
    const s = summarizeEntrySiteCensus('2026-09-03');
    expect(s.wired).toBe(true);
    expect(s.session).toBeNull();
    expect(s.statement).toMatch(/IS a measurement/);
  });

  it('drops records past retention and compacts the file; a torn line does not abort the hydrate', () => {
    const path = entrySiteCensusLogPath(dir);
    const stale = REVIEW_2159_ET - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(path, [
      JSON.stringify({ ts: stale, etDay: '2026-08-05', assetClass: 'equity', source: 'static_list', refused: false }),
      JSON.stringify({ ts: OPEN_0903, etDay: '2026-09-03', assetClass: 'equity', source: 'static_list', refused: false }),
      '{"ts":  // torn',
    ].join('\n') + '\n', 'utf8');

    const h = hydrateEntrySiteCensusFromDisk(dir, REVIEW_2159_ET);
    expect(h).toEqual({ days: 1, evaluated: 1, refused: 0 });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(summarizeEntrySiteCensus('2026-08-05').session).toBeNull();
  });
});

describe('TRA-4343 wiring — the health surface publishes both halves', () => {
  beforeEach(() => {
    clearEntrySiteCensusLedger();
    clearEntrySiteAssetClassCensus();
  });
  afterEach(() => {
    clearEntrySiteCensusLedger();
    clearEntrySiteAssetClassCensus();
  });

  it('recording an evaluation writes BOTH counters — they cannot drift', () => {
    recordEntrySiteAssetClassEvaluation(
      classifyUnderlyingAssetClass('ETHA'), true, 'admin', OPEN_0903,
    );
    const h = gradeUnderlyingAssetClassHealth([], [], process.env, {
      bootedAt: new Date(OPEN_0903 - 3600_000).toISOString(),
      now: REVIEW_2159_ET,
    });
    expect(h.entrySite.evaluated).toBe(1);
    expect(h.entrySite.durable.session).toMatchObject({ etDay: '2026-09-03', evaluated: 1, refused: 1 });
  });

  it('the entry-site block carries the boot_after_close grade, and the reason line says so', () => {
    const h = gradeUnderlyingAssetClassHealth([], [], process.env, {
      bootedAt: new Date(BOOT_2111_ET).toISOString(),
      now: REVIEW_2159_ET,
    });
    expect(h.entrySite.evaluated).toBe(0);
    expect(h.entrySite.durability).toBe('ephemeral_since_boot');
    expect(h.entrySite.sessionCoverage.status).toBe('boot_after_close');
    expect(h.entrySite.sessionCoverage.zeroReading).toBe('vacuous');
    // The reason line is what a reader scans; the disclosure must be IN it.
    expect(h.reason).toMatch(/boot_after_close, a 0 reads vacuous/);
  });

  it('the durable twin is selected by the SESSION the coverage grade names', () => {
    recordEntrySiteAssetClassEvaluation(
      classifyUnderlyingAssetClass('AAPL'), false, 'admin', OPEN_0903,
    );
    const h = gradeUnderlyingAssetClassHealth([], [], process.env, {
      bootedAt: new Date(BOOT_2111_ET).toISOString(),
      now: REVIEW_2159_ET,
    });
    expect(h.entrySite.sessionCoverage.sessionDate).toBe('2026-09-03');
    expect(h.entrySite.durable.sessionDate).toBe('2026-09-03');
    // The coverage grade says the since-boot half is vacuous for 2026-09-03;
    // the durable twin is what a grader reads instead, and it is keyed to the
    // SAME day — the two can never answer about different sessions.
    expect(h.entrySite.sessionCoverage.zeroReading).toBe('vacuous');
    expect(h.entrySite.durable.session?.evaluated).toBe(1);
  });
});
