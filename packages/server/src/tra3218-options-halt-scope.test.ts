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
  const state = (over: Partial<OptionsBreakerPersistedState> = {}): OptionsBreakerPersistedState => ({
    day: '2026-08-11',
    cumulativeR: -2.1,
    dailyPnl: -420,
    closes: 3,
    sleeveEquityBaseline: 468.58,
    halted: true,
    haltReason: 'Options sleeve cumulative -2.10R ≤ −2R — sleeve halted for the day',
    haltAt: 1_784_000_000_000,
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
    hydrateOptionsBreakerLedgerFromDisk(dir);
    recordOptionsBreakerState('live', 'engine-1', state(), 1_784_000_100_000);

    // "Reboot": clear memory, hydrate from disk.
    hydrateOptionsBreakerLedgerFromDisk(dir);
    const restored = getOptionsBreakerRestoreState('live', 'engine-1', '2026-08-11');
    expect(restored).not.toBeNull();
    expect(restored!.halted).toBe(true);
    expect(restored!.haltAt).toBe(1_784_000_000_000);
    expect(restored!.cumulativeR).toBeCloseTo(-2.1, 5);
    // Split per book: the other mode/engine has nothing.
    expect(getOptionsBreakerRestoreState('demo', 'engine-1', '2026-08-11')).toBeNull();
    expect(getOptionsBreakerRestoreState('live', 'engine-2', '2026-08-11')).toBeNull();
  });

  it('a pristine day writes nothing; repeated identical states append once', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir);
    recordOptionsBreakerState('live', 'engine-1', state({ closes: 0, halted: false, haltsToday: 0 }));
    expect(summarizeOptionsBreakerLedger().sessionsObserved).toBe(0);

    recordOptionsBreakerState('live', 'engine-1', state(), 1_784_000_100_000);
    recordOptionsBreakerState('live', 'engine-1', state(), 1_784_000_200_000); // same sig — folded, not re-appended
    const raw = readFileSync(join(dir, 'options-breaker.jsonl'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
  });

  it('summarize counts halted sessions and releases across the retained window', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir);
    recordOptionsBreakerState('live', 'engine-1', state(), 1_784_000_100_000);
    recordOptionsBreakerState('demo', 'engine-2', state({ halted: false, haltsToday: 0, releasesToday: 2, cumulativeR: -0.4 }), 1_784_000_200_000);
    const s = summarizeOptionsBreakerLedger();
    expect(s.sessionsObserved).toBe(2);
    expect(s.haltedSessions).toBe(1);
    expect(s.releasesTotal).toBe(2);
    expect(s.sessions[0]!.sessionDate).toBe('2026-08-11');
  });

  it('a torn trailing line is skipped, not fatal', () => {
    hydrateOptionsBreakerLedgerFromDisk(dir);
    recordOptionsBreakerState('live', 'engine-1', state(), 1_784_000_100_000);
    const path = join(dir, 'options-breaker.jsonl');
    const raw = readFileSync(path, 'utf8');
    // Simulate a crash mid-append.
    writeFileSync(path, raw + '{"day":"2026-08-11","mode":"li', 'utf8');
    const h = hydrateOptionsBreakerLedgerFromDisk(dir);
    expect(h.records).toBe(1);
  });
});
