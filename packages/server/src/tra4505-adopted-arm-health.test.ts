// TRA-4505 (parent TRA-4206, off TRA-3829) — the engine-act-on-adopted-rows arm
// on a health route.
//
// The counters are the point (AC4): both were 0 on every live measurement so
// far, so a census that only ever saw zeros could be returning a constant. The
// non-zero arms below are what separate "counted and found none" from "never
// counted" — and the classification is graded against the SHIPPED predicates,
// so a widening or narrowing of `engineMayActOnAdoptedRow`'s allow-list moves
// these counts rather than silently diverging from them.

import { describe, it, expect } from 'vitest';
import {
  summarizeEngineActionOnAdoptedRows,
  type AdoptedHandoverCensusRow,
} from './tra4505-adopted-arm-health.js';
import { ENGINE_ACT_ON_ADOPTED_FLAG } from './option-exec-flag.js';

const GRANT = { grantedAt: '2026-09-01T14:00:00.000Z', grantedBy: 'admin' };

describe('TRA-4505 — summarizeEngineActionOnAdoptedRows', () => {
  it('resolves armed / source / handoverSurface from an env-set value (AC3)', () => {
    const s = summarizeEngineActionOnAdoptedRows(null, { [ENGINE_ACT_ON_ADOPTED_FLAG]: 'true' });
    expect(s.envVar).toBe(ENGINE_ACT_ON_ADOPTED_FLAG);
    expect(s.armed).toBe(true);
    expect(s.source).toBe('env');
    expect(s.rawEnvValue).toBe('true');
    expect(s.compiledDefault).toBe(false);
    expect(s.handoverSurface).toBe('live');
  });

  it('an ABSENT key reads compiled_default / disarmed, and the default is the non-acting one', () => {
    const s = summarizeEngineActionOnAdoptedRows(null, {});
    expect(s.armed).toBe(false);
    expect(s.source).toBe('compiled_default');
    expect(s.rawEnvValue).toBeNull();
    expect(s.handoverSurface).toBe('disarmed');
  });

  it('a present-but-non-truthy value is a WRITTEN disarm, not the compiled default (AC3)', () => {
    // 'ture' is the misspelling case the flag's own docblock names: `flagOn`
    // refuses it, but the byte was set by somebody, and the two facts must not
    // collapse into one reading.
    const s = summarizeEngineActionOnAdoptedRows(null, { [ENGINE_ACT_ON_ADOPTED_FLAG]: 'ture' });
    expect(s.armed).toBe(false);
    expect(s.source).toBe('env');
    expect(s.rawEnvValue).toBe('ture');
    expect(s.handoverSurface).toBe('disarmed');
  });

  it('an unwired provider serves rows: null — "cannot say", never an empty census', () => {
    expect(summarizeEngineActionOnAdoptedRows(null, {}).rows).toBeNull();
  });

  it('a wired provider with no open rows serves ZEROS, distinct from null', () => {
    expect(summarizeEngineActionOnAdoptedRows([], {}).rows).toEqual({
      importedRows: 0,
      exemptRows: 0,
      grantedRows: 0,
      adoptedRowsAwaitingHandover: 0,
    });
  });

  it('counts NON-ZERO grantedRows and adoptedRowsAwaitingHandover (AC4)', () => {
    const rows: AdoptedHandoverCensusRow[] = [
      // Engine-opened (not imported) — outside the census denominator entirely.
      { importedFromTradier: false },
      {},
      // Allow-listed imports: sandbox, engine_origin, and the board-exempted
      // desk_add (TRA-3909, interaction `d4f622fb`) — exempt, never "awaiting".
      { importedFromTradier: true, tradierEnv: 'sandbox', adoptionAuthority: 'foreign' },
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'engine_origin' },
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'desk_add' },
      // Guarded + granted: a legible human hand-over.
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign', engineHandover: GRANT },
      // Guarded, no grant: foreign, unresolved, and ABSENT authority (an older
      // build's adopted row) — all three are the population ruling B refuses.
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign' },
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'unresolved' },
      { importedFromTradier: true, tradierEnv: 'production' },
      // A malformed grant reads as ABSENT, exactly as the predicate reads it:
      // `{grantedBy: ''}` and an unparseable `grantedAt` are not hand-overs.
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign', engineHandover: { grantedAt: GRANT.grantedAt, grantedBy: '' } },
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign', engineHandover: { grantedAt: 'soon', grantedBy: 'admin' } },
    ];
    const s = summarizeEngineActionOnAdoptedRows(rows, { [ENGINE_ACT_ON_ADOPTED_FLAG]: 'true' });
    expect(s.rows).toEqual({
      importedRows: 9,
      exemptRows: 3,
      grantedRows: 1,
      adoptedRowsAwaitingHandover: 5,
    });
  });

  it('the census is INDEPENDENT of the arm — counting must not consult the value it sits beside', () => {
    // The awaiting population is what ruling B refuses ARM OR NO ARM; if the
    // census read differently under `armed: true` the block would grade itself.
    const rows: AdoptedHandoverCensusRow[] = [
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign' },
      { importedFromTradier: true, tradierEnv: 'production', adoptionAuthority: 'foreign', engineHandover: GRANT },
    ];
    const off = summarizeEngineActionOnAdoptedRows(rows, {});
    const on = summarizeEngineActionOnAdoptedRows(rows, { [ENGINE_ACT_ON_ADOPTED_FLAG]: 'true' });
    expect(off.rows).toEqual(on.rows);
    expect(off.rows).toEqual({
      importedRows: 2,
      exemptRows: 0,
      grantedRows: 1,
      adoptedRowsAwaitingHandover: 1,
    });
  });
});
