// TRA-4474 — the intent manifest must disagree with a wiped env, and must not
// manufacture a verdict on a box that cannot prove it is production.
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ENV_INTENT, summarizeEnvIntent } from './env-intent.js';

/** The posture-as-ruled production env: every graded lever at its intended value. */
const RULED_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DURABILITY_POLICY: 'refuse',
  // ENABLE_ORDER_QUOTE_GUARD / ENABLE_OPTION_LIVE_RV_LONG / _DIRECTIONAL absent:
  // their intent is `off` and their code default is off — absence MATCHES.
  // ENABLE_OPTION_LIVE_OTM joined them on 2026-09-22: TRA-4750 stood the sleeve
  // down and TRA-4785 pulled the lever on bqb1 (the live env holds the explicit
  // `false`; absence would resolve off too, and both MATCH).
};

describe('summarizeEnvIntent (TRA-4474)', () => {
  it('reads ok on the posture-as-ruled production env', () => {
    const s = summarizeEnvIntent(RULED_PROD_ENV);
    expect(s.applies).toBe(true);
    expect(s.mismatches).toEqual([]);
    expect(s.ok).toBe(true);
    // Absence with a passing default is visible as present:false, not hidden.
    const oqg = s.levers.find((l) => l.key === 'ENABLE_ORDER_QUOTE_GUARD');
    expect(oqg).toMatchObject({ present: false, raw: null, effective: 'off', matches: true });
  });

  it('THE INCIDENT: DURABILITY_POLICY wiped from the env reads as a named mismatch, never ok', () => {
    const { DURABILITY_POLICY: _gone, ...wiped } = RULED_PROD_ENV;
    const s = summarizeEnvIntent(wiped);
    expect(s.ok).toBe(false);
    expect(s.mismatches).toContain('DURABILITY_POLICY');
    const lever = s.levers.find((l) => l.key === 'DURABILITY_POLICY');
    // The effective value the wiped box actually runs — beside the intended one.
    expect(lever).toMatchObject({ present: false, effective: 'observe', intended: 'refuse', matches: false });
  });

  it('a lever intended OFF found ON is a mismatch (the TRA-4442 direction)', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_DIRECTIONAL: 'true' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_DIRECTIONAL']);
  });

  // TRA-4785. This assertion USED to run the other way — it graded a WIPE of the
  // TRA-2877 standing arm as the mismatch. TRA-4750 stood `single_leg_otm` down,
  // so the hazard inverted with it: the event to catch is now the sleeve being
  // RE-ARMED on the money host without the board sign-off TRA-4750 item 5
  // requires. Until 2026-09-22 nothing anywhere could see that — the sleeve was
  // held dark only by cost-bar arithmetic, and "stood down" read identically to
  // "armed but out-priced" on every surface we had.
  it('THE STAND-DOWN: the OTM sleeve found ARMED on the money host is a named mismatch', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_OTM: 'true' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_OTM']);
    const lever = s.levers.find((l) => l.key === 'ENABLE_OPTION_LIVE_OTM');
    expect(lever).toMatchObject({ present: true, effective: 'on', intended: 'off', matches: false });
  });

  it('the stood-down sleeve reads ok whether the env says `false` or the key is gone', () => {
    for (const raw of ['false', '0', 'off', 'no']) {
      const s = summarizeEnvIntent({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_OTM: raw });
      expect(s.mismatches).toEqual([]);
      expect(s.ok).toBe(true);
    }
    // bqb1 holds the explicit `false`; absence resolves off by the code default.
    expect(summarizeEnvIntent(RULED_PROD_ENV).ok).toBe(true);
  });

  it('matches via the resolver, not string equality', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, DURABILITY_POLICY: '  Refuse ' });
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
