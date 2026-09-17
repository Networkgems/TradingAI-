// TRA-4628 — the OTM candidate-admission tape: append-only rows for admitted
// AND refused scanner candidates, pass-level quote-independent sampling, and
// the boot hydrate/compaction that makes 20+ sessions survivable on bqb1.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OtmAdmissionDecision } from '@trading-app/engine';
import {
  beginOtmAdmissionPass,
  clearOtmAdmissionTape,
  hydrateOtmAdmissionTapeFromDisk,
  otmAdmissionTapePath,
  readOtmAdmissionTapeRows,
  recordOtmAdmissionOrdered,
  recordOtmAdmissionRanked,
  summarizeOtmAdmissionTape,
} from './otm-admission-tape.js';

const NOW = Date.parse('2026-09-16T15:00:00Z'); // 11:00 ET, a Wednesday RTH session

function decision(overrides: Partial<OtmAdmissionDecision> = {}): OtmAdmissionDecision {
  return {
    occSymbol: 'RIG261016C00005000',
    underlying: 'RIG',
    right: 'call',
    strike: 5,
    expiry: '2026-10-16',
    bid: 0.1,
    ask: 0.12,
    mark: 0.11,
    spreadPct: 0.02 / 0.11,
    openInterest: 500,
    admitted: true,
    bindingReason: 'none',
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra4628-'));
  hydrateOtmAdmissionTapeFromDisk(dir, NOW);
});

afterEach(() => {
  clearOtmAdmissionTape();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-4628 — pass recording', () => {
  it('commits admitted AND refused rows to disk with accountClass and bindingReason', () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    expect(pass).not.toBeNull();
    pass!.onAdmission(decision());
    pass!.onAdmission(
      decision({ occSymbol: 'RIG261016C00009000', mark: 0.03, admitted: false, bindingReason: 'min_mark' }),
    );
    pass!.commit();

    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    const rows = raw.map((l) => JSON.parse(l));
    expect(rows[0].kind).toBe('candidate');
    expect(rows[0].accountClass).toBe('desk');
    expect(rows[0].admitted).toBe(true);
    expect(rows[1].bindingReason).toBe('min_mark');
    expect(rows[1].admitted).toBe(false);
    // No username on disk — the class is stored, never the book string.
    expect(raw[0]).not.toContain('deskbook');

    const summary = summarizeOtmAdmissionTape();
    const desk = summary.byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.candidateRows).toBe(2);
    expect(desk?.admitted).toBe(1);
    expect(desk?.sessionsWithAdmissions).toBe(1);
    expect(summary.deskSessionsWithAdmissions).toBe(1);
  });

  it('throttles a second pass for the same symbol×book, but not a different symbol', () => {
    const p1 = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    p1!.onAdmission(decision());
    p1!.commit();

    expect(
      beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW + 60_000 }),
    ).toBeNull();
    expect(
      beginOtmAdmissionPass({ symbol: 'XLF', book: 'deskbook', mode: 'live', now: NOW + 60_000 }),
    ).not.toBeNull();
    expect(summarizeOtmAdmissionTape().counters.throttledPasses).toBe(1);
  });

  it('an abandoned pass (no commit) does not consume the throttle slot', () => {
    beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    // no commit — breaker / no-chain shape
    expect(
      beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW + 1000 }),
    ).not.toBeNull();
  });

  it('drops an oversized pass WHOLE — no partial truncation reaches disk', () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    for (let i = 0; i < 450; i += 1) {
      pass!.onAdmission(decision({ occSymbol: `RIG${i}`, strike: i }));
    }
    pass!.commit();
    expect(() => readFileSync(otmAdmissionTapePath(dir), 'utf8')).toThrow(); // nothing written
    expect(summarizeOtmAdmissionTape().counters.oversizedPassesDropped).toBe(1);
  });

  it('classifies a null book as unattributed, never desk', () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: null, mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    const summary = summarizeOtmAdmissionTape();
    expect(summary.byClass.map((c) => c.accountClass)).toEqual(['unattributed']);
    expect(summary.deskSessionsWithAdmissions).toBe(0);
  });
});

describe('TRA-4628 — ranked/ordered links', () => {
  it('records links unthrottled and tallies them per class', () => {
    recordOtmAdmissionRanked({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW }, 'RIG261016C00005000');
    recordOtmAdmissionOrdered({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW + 1 }, 'RIG261016C00005000');
    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw.map((l) => JSON.parse(l).kind)).toEqual(['ranked', 'ordered']);
    const desk = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.ranked).toBe(1);
    expect(desk?.ordered).toBe(1);
  });
});

describe('TRA-4628 — hydrate / retention / export', () => {
  it('rebuilds aggregates from disk and drops rows older than retention', () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    // A stale row from far outside the retention window, appended by hand.
    const stale = { ...JSON.parse(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim()), ts: NOW - 90 * 24 * 60 * 60 * 1000, etDay: '2026-06-01' };
    writeFileSync(
      otmAdmissionTapePath(dir),
      JSON.stringify(stale) + '\n' + readFileSync(otmAdmissionTapePath(dir), 'utf8'),
      'utf8',
    );

    const h = hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    expect(h.records).toBe(1); // stale line compacted away
    expect(h.days).toBe(1);
    const desk = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.candidateRows).toBe(1);
    // The compaction rewrote the file to the kept line only.
    expect(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('skips a torn trailing line rather than aborting the hydrate', () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    writeFileSync(
      otmAdmissionTapePath(dir),
      readFileSync(otmAdmissionTapePath(dir), 'utf8') + '{"kind":"candidate","ts":17',
      'utf8',
    );
    const h = hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    expect(h.records).toBe(1);
  });

  it('streams rows back filtered by day and class, and reports truncation', async () => {
    const pass = beginOtmAdmissionPass({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.onAdmission(decision({ occSymbol: 'RIG2', admitted: false, bindingReason: 'max_spread_pct' }));
    pass!.commit();

    const all = await readOtmAdmissionTapeRows({});
    expect(all.rows).toHaveLength(2);
    expect(all.truncated).toBe(false);

    const wrongDay = await readOtmAdmissionTapeRows({ etDay: '2020-01-01' });
    expect(wrongDay.rows).toHaveLength(0);

    const capped = await readOtmAdmissionTapeRows({ limit: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const fixtureOnly = await readOtmAdmissionTapeRows({ accountClass: 'fixture' });
    expect(fixtureOnly.rows).toHaveLength(0);
  });
});
