// TRA-4474 — the intent manifest must disagree with a wiped env, and must not
// manufacture a verdict on a box that cannot prove it is production.
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ENV_INTENT, summarizeEnvIntent } from './env-intent.js';

/** The armed-as-ruled production env: every graded lever at its intended value. */
const ARMED_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DURABILITY_POLICY: 'refuse',
  ENABLE_OPTION_LIVE_OTM: '1',
  // ENABLE_ORDER_QUOTE_GUARD / ENABLE_OPTION_LIVE_RV_LONG / _DIRECTIONAL absent:
  // their intent is `off` and their code default is off — absence MATCHES.
};

describe('summarizeEnvIntent (TRA-4474)', () => {
  it('reads ok on the armed-as-ruled production env', () => {
    const s = summarizeEnvIntent(ARMED_PROD_ENV);
    expect(s.applies).toBe(true);
    expect(s.mismatches).toEqual([]);
    expect(s.ok).toBe(true);
    // Absence with a passing default is visible as present:false, not hidden.
    const oqg = s.levers.find((l) => l.key === 'ENABLE_ORDER_QUOTE_GUARD');
    expect(oqg).toMatchObject({ present: false, raw: null, effective: 'off', matches: true });
  });

  it('THE INCIDENT: DURABILITY_POLICY wiped from the env reads as a named mismatch, never ok', () => {
    const { DURABILITY_POLICY: _gone, ...wiped } = ARMED_PROD_ENV;
    const s = summarizeEnvIntent(wiped);
    expect(s.ok).toBe(false);
    expect(s.mismatches).toContain('DURABILITY_POLICY');
    const lever = s.levers.find((l) => l.key === 'DURABILITY_POLICY');
    // The effective value the wiped box actually runs — beside the intended one.
    expect(lever).toMatchObject({ present: false, effective: 'observe', intended: 'refuse', matches: false });
  });

  it('a lever intended OFF found ON is a mismatch (the TRA-4442 direction)', () => {
    const s = summarizeEnvIntent({ ...ARMED_PROD_ENV, ENABLE_OPTION_LIVE_DIRECTIONAL: 'true' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_DIRECTIONAL']);
  });

  it('the standing OTM arm wiped is a mismatch too (a wipe silently disarming a ruled-on sleeve)', () => {
    const { ENABLE_OPTION_LIVE_OTM: _gone, ...wiped } = ARMED_PROD_ENV;
    const s = summarizeEnvIntent(wiped);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_OTM']);
  });

  it('matches via the resolver, not string equality', () => {
    const s = summarizeEnvIntent({ ...ARMED_PROD_ENV, DURABILITY_POLICY: '  Refuse ' });
    expect(s.ok).toBe(true);
  });

  it('off-production nothing is graded: ok and every matches are null, never true', () => {
    const s = summarizeEnvIntent({ DURABILITY_POLICY: 'observe' });
    expect(s.applies).toBe(false);
    expect(s.ok).toBeNull();
    expect(s.levers.every((l) => l.matches === null)).toBe(true);
    expect(s.mismatches).toEqual([]);
  });

  it('every manifest row has a non-empty intended value and provenance', () => {
    for (const lever of PRODUCTION_ENV_INTENT) {
      expect(lever.intended.length).toBeGreaterThan(0);
      expect(lever.provenance.length).toBeGreaterThan(0);
    }
  });
});
