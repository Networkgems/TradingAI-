// TRA-3218 (parent TRA-2760) — the options-sleeve halt scope + durable breaker
// ledger.
//
// The defect: the option entry gates consulted the EQUITY book's session-stop
// governor, whose arm (+0.5R of book equity ≈ $2.30 on the $468 live sleeve) is
// inside the noise at that size — one red option trade after a trivial green
// tick ended the sleeve's day, book-wide. The fix ships DARK behind
// `OPTIONS_HALT_SCOPE=sleeve`; these pin the flag's fail-closed resolution, the
// gate wiring (source-level, matching the tra2331 house pattern — line numbers
// shift, symbols don't), and the ledger round trip that makes the sleeve halt
// survive a reboot in both directions.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  resolveOptionsHaltScope,
  isOptionsSleeveHaltScope,
  OPTIONS_HALT_SCOPE_VAR,
} from './exit-risk-rules-flag.js';
import {
  clearOptionsBreakerLedger,
  hydrateOptionsBreakerLedgerFromDisk,
  recordOptionsBreakerState,
  getOptionsBreakerRestoreState,
  summarizeOptionsBreakerLedger,
} from './options-breaker-ledger.js';
import type { OptionsBreakerPersistedState } from '@trading-app/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8');

describe('TRA-3218 — OPTIONS_HALT_SCOPE resolution fails closed to book', () => {
  it('defaults to book with the var unset or blank', () => {
    expect(resolveOptionsHaltScope({})).toEqual({ scope: 'book', source: 'default' });
    expect(resolveOptionsHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: '  ' })).toEqual({
      scope: 'book',
      source: 'default',
    });
  });

  it('only the exact token `sleeve` decouples (case/space-insensitive)', () => {
    expect(resolveOptionsHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: 'sleeve' }).scope).toBe('sleeve');
    expect(resolveOptionsHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: ' SLEEVE ' }).scope).toBe('sleeve');
    expect(isOptionsSleeveHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: 'sleeve' })).toBe(true);
  });

  it('an explicit `book` is env-sourced legacy, and a typo is env_invalid + book — never a silent widen', () => {
    expect(resolveOptionsHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: 'book' })).toEqual({
      scope: 'book',
      source: 'env',
    });
    // The typo class that must FAIL CLOSED: a halted book keeps gating options.
    for (const typo of ['sleve', 'sleeves', 'true', '1', 'engine']) {
      expect(resolveOptionsHaltScope({ [OPTIONS_HALT_SCOPE_VAR]: typo })).toEqual({
        scope: 'book',
        source: 'env_invalid',
      });
    }
  });
});

describe('TRA-3218 — gate wiring (source-level)', () => {
  it('BOTH option scans consult the scope inside their book-halt gate, and return only under book scope', () => {
    // The two option entry chokepoints (`runRelativeValueScan`, `runOtmScan`)
    // each carry one scope-consulting book-halt block.
    const blocks = [...ENGINE_SRC.matchAll(/isOptionsSleeveHaltScope\(bookHaltEnv\)/g)];
    expect(blocks).toHaveLength(2);

    for (const m of blocks) {
      const at = m.index ?? 0;
      // Look back over the enclosing gate block: it must be conditioned on the
      // equity governor's book halt AND the master rules flag.
      const back = ENGINE_SRC.slice(Math.max(0, at - 600), at);
      expect(back).toMatch(/isExitRiskRulesEnabled\(bookHaltEnv\)/);
      expect(back).toMatch(/this\.riskGovernor\.isBookHalted\(\)/);
      // Look forward: the tally is bumped at BOTH scope values (the
      // counterfactual counter), and the early return is guarded on NOT sleeve.
      const fwd = ENGINE_SRC.slice(at, at + 400);
      expect(fwd).toMatch(/noteOptionScanBookHalt\(sleeveScoped\)/);
      expect(fwd).toMatch(/if \(!sleeveScoped\) return/);
    }
  });

  it('every optionsBreaker.recordClose is followed by a durable ledger write', () => {
    const sites = [...ENGINE_SRC.matchAll(/this\.optionsBreaker\.recordClose\(/g)].map(
      (m) => m.index ?? 0,
    );
    expect(sites.length).toBeGreaterThan(0);
    for (const at of sites) {
      const fwd = ENGINE_SRC.slice(at, at + 500);
      expect(fwd).toMatch(/recordOptionsBreakerState\(this\.mode, this\.feedContextKey/);
    }
  });
});

describe('TRA-3218 — options-breaker ledger round trip', () => {
  // TRA-3488 — every hydrate below passes an EXPLICIT `now`.
  //
  // `hydrateOptionsBreakerLedgerFromDisk` drops rows older than a 30-day
  // retention window measured against the clock it is handed, and it defaults
  // that clock to `Date.now()`. These fixtures pinned literal timestamps and
  // took the default, so the rows aged out of their own window on a schedule:
  // the round trip and torn-line cases went red at 2026-08-13T03:35:00.000Z —
  // exactly RECORD_AT + 30d — with no code change behind it. Bumping the
  // literals forward would only reset that fuse.
  //
  // Anchoring `now` to the fixtures' own basis makes the window a property of
  // the fixture rather than of the calendar, so these cannot rot again. The
  // retention rule itself is asserted deliberately further down instead of
  // being discovered by a failing round trip.
  const SESSION_DAY = '2026-08-11';
  const HALT_AT = 1_784_000_000_000;
  /** When the row is written. */
  const RECORD_AT = HALT_AT + 100_000;
  /** The "reboot" — a minute after the write, deep inside retention. */
  const HYDRATE_AT = RECORD_AT + 60_000;
  const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

  const state = (over: Partial<OptionsBreakerPersistedState> = {}): OptionsBreakerPersistedState => ({
    day: SESSION_DAY,
    cumulativeR: -2.1,
    dailyPnl: -420,
    closes: 3,
    sleeveEquityBaseline: 468.58,
    halted: true,
    haltReason: 'Options sleeve cumulative -2.10R ≤ −2R — sleeve halted for the day',
    haltAt: HALT_AT,
    haltsToday: 1,
    releasesToday: 0,
    reTripFloorR: null,
    reTripFloorPnl: null,
    ...over,
  });

  let dir: string;
  beforeEach(() => {
    clearOptionsBreakerLedger();
    dir = mkdtempSync(join(tmpdir(), 'tra3218-ledger-'));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('record → hydrate → restore returns the persisted state for the same book/day', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);

    // "Reboot": clear memory, hydrate from disk.
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    const restored = getOptionsBreakerRestoreState('live', 'engine-1', SESSION_DAY);
    expect(restored).not.toBeNull();
    expect(restored!.halted).toBe(true);
    expect(restored!.haltAt).toBe(HALT_AT);
    expect(restored!.cumulativeR).toBeCloseTo(-2.1, 5);
    // Split per book: the other mode/engine has nothing.
    expect(getOptionsBreakerRestoreState('demo', 'engine-1', SESSION_DAY)).toBeNull();
    expect(getOptionsBreakerRestoreState('live', 'engine-2', SESSION_DAY)).toBeNull();
  });

  it('a pristine day writes nothing; repeated identical states append once', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    recordOptionsBreakerState('live', 'engine-1', state({ closes: 0, halted: false, haltsToday: 0 }), RECORD_AT);
    expect(summarizeOptionsBreakerLedger().sessionsObserved).toBe(0);

    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT + 100_000); // same sig — folded, not re-appended
    const raw = readFileSync(join(dir, 'options-breaker.jsonl'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
  });

  it('summarize counts halted sessions and releases across the retained window', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);
    recordOptionsBreakerState('demo', 'engine-2', state({ halted: false, haltsToday: 0, releasesToday: 2, cumulativeR: -0.4 }), RECORD_AT + 100_000);
    const s = summarizeOptionsBreakerLedger();
    expect(s.sessionsObserved).toBe(2);
    expect(s.haltedSessions).toBe(1);
    expect(s.releasesTotal).toBe(2);
    expect(s.sessions[0]!.sessionDate).toBe(SESSION_DAY);
  });

  it('a torn trailing line is skipped, not fatal', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);
    const path = join(dir, 'options-breaker.jsonl');
    const raw = readFileSync(path, 'utf8');
    // Simulate a crash mid-append.
    writeFileSync(path, raw + `{"day":"${SESSION_DAY}","mode":"li`, 'utf8');
    const h = hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    expect(h.records).toBe(1);
  });

  // TRA-3488 — the retention cutoff, asserted on purpose. This is the rule that
  // silently ate the two cases above; pinning both sides of the boundary means a
  // future change to RETAIN_MS shows up HERE, as a named failure, rather than as
  // an unrelated round trip mysteriously returning null.
  it('the 30-day retention cutoff drops an aged row and keeps one just inside it', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir, HYDRATE_AT);
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);

    // One second the far side of the window: dropped, and compacted off disk.
    const aged = hydrateOptionsBreakerLedgerFromDisk(dir, RECORD_AT + RETAIN_MS + 1_000);
    expect(aged.records).toBe(0);
    expect(getOptionsBreakerRestoreState('live', 'engine-1', SESSION_DAY)).toBeNull();

    // Re-write it and read from just inside the window: retained.
    recordOptionsBreakerState('live', 'engine-1', state(), RECORD_AT);
    const fresh = hydrateOptionsBreakerLedgerFromDisk(dir, RECORD_AT + RETAIN_MS - 1_000);
    expect(fresh.records).toBe(1);
    expect(getOptionsBreakerRestoreState('live', 'engine-1', SESSION_DAY)).not.toBeNull();
  });

  // TRA-3488 — the production claim the unit red was mistaken for. The boot seed
  // (`seedOptionsBreakerFromLedger`) only ever asks for TODAY's ET day, so the
  // row it reads is at most one session old against a 30-day window. Retention
  // cannot be what un-halts a rebooted book, no matter how far the clock runs.
  it('a same-day halt survives a restart regardless of how far the wall clock has advanced', () => {
    for (const yearsOut of [0, 1, 5]) {
      clearOptionsBreakerLedger();
      const bootAt = RECORD_AT + yearsOut * 365 * 24 * 60 * 60 * 1000;
      // The halt is latched during the session, minutes before the restart.
      hydrateOptionsBreakerLedgerFromDisk(dir, bootAt);
      recordOptionsBreakerState('live', 'engine-1', state(), bootAt);

      // Restart, then re-hydrate 10 minutes later — the same-day read the seed does.
      const h = hydrateOptionsBreakerLedgerFromDisk(dir, bootAt + 600_000);
      expect(h.records).toBeGreaterThanOrEqual(1);
      const restored = getOptionsBreakerRestoreState('live', 'engine-1', SESSION_DAY);
      expect(restored, `halt lost at +${yearsOut}y`).not.toBeNull();
      expect(restored!.halted).toBe(true);
      rmSync(join(dir, 'options-breaker.jsonl'), { force: true });
    }
  });
});
