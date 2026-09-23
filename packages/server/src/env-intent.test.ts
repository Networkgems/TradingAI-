// TRA-4474 — the intent manifest must disagree with a wiped env, and must not
// manufacture a verdict on a box that cannot prove it is production.
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ENV_INTENT, summarizeEnvIntent } from './env-intent.js';

/** The posture-as-ruled production env: every graded lever at its intended value. */
const RULED_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DURABILITY_POLICY: 'refuse',
  // TRA-4801 — intent of record is `production` (TRA-2163, AGENTS.md). Note the
  // LIVE box reads `sandbox` as of 2026-09-21, so this fixture is the ruled
  // posture, not the current one; that divergence is the finding, not a bug here.
  TRADIER_ENV: 'production',
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

  // ── TRA-4801: TRADIER_ENV ────────────────────────────────────────────────
  it('THE FLIP: TRADIER_ENV=sandbox on the money host is a named mismatch', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, TRADIER_ENV: 'sandbox' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toContain('TRADIER_ENV');
    expect(s.levers.find((l) => l.key === 'TRADIER_ENV')).toMatchObject({
      intended: 'production',
      effective: 'sandbox',
      present: true,
      matches: false,
    });
  });

  it('an ABSENT TRADIER_ENV resolves sandbox like the credential router, and mismatches', () => {
    const { TRADIER_ENV: _gone, ...noKey } = RULED_PROD_ENV;
    const s = summarizeEnvIntent(noKey);
    expect(s.mismatches).toContain('TRADIER_ENV');
    // index.ts: `(process.env['TRADIER_ENV'] as ...) ?? 'sandbox'` — absence
    // silently routes SANDBOX credentials, which is the whole hazard.
    expect(s.levers.find((l) => l.key === 'TRADIER_ENV')).toMatchObject({
      present: false,
      raw: null,
      effective: 'sandbox',
    });
  });

  it('a PADDED ` production ` is `unrecognized`, not a quiet sandbox — two live readers disagree on it', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, TRADIER_ENV: ' production ' });
    // The credential router (`=== 'production'`, no trim) hands out SANDBOX creds,
    // while /api/health/live-equity (`.trim() === 'production'`) reports production.
    // Collapsing this into 'sandbox' would hide that disagreement.
    expect(s.levers.find((l) => l.key === 'TRADIER_ENV')?.effective).toBe('unrecognized');
    expect(s.mismatches).toContain('TRADIER_ENV');
  });

  it('THE TRA-2163 LEAK STAYS CLOSED: a token in TRADIER_ENV is never echoed in `raw`', () => {
    // `/api/health/durability` is an OPEN route and publishes this summary, so
    // `raw` reaches the public internet. TRA-2163 was a P0 in which this exact
    // var held the 28-char production Tradier token.
    const token = 'kT9xQ2vR7nB4mW8cL1pZ6yH3sD5fG0jA';
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, TRADIER_ENV: token });
    const lever = s.levers.find((l) => l.key === 'TRADIER_ENV');
    expect(lever?.raw).not.toBe(token);
    expect(lever?.raw).toBe('<redacted:unrecognized-value>');
    expect(JSON.stringify(s)).not.toContain(token);
    // Redaction must not cost the present/absent distinction.
    expect(lever?.present).toBe(true);
    expect(lever?.effective).toBe('unrecognized');
    expect(s.mismatches).toContain('TRADIER_ENV');
  });

  it('a recognized label still publishes verbatim — redaction is not blanket suppression', () => {
    const s = summarizeEnvIntent(RULED_PROD_ENV);
    expect(s.levers.find((l) => l.key === 'TRADIER_ENV')).toMatchObject({
      raw: 'production',
      effective: 'production',
      matches: true,
    });
  });

  it('every secret-capable lever declares a redact filter', () => {
    // Cheap standing guard: if someone adds another credential-ish key to the
    // manifest, this fails until they think about the open route.
    const SECRET_ISH = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|TRADIER_ENV/i;
    for (const lever of PRODUCTION_ENV_INTENT) {
      if (SECRET_ISH.test(lever.key)) {
        expect(lever.redact, `${lever.key} is secret-capable and must declare redact`).toBeTypeOf('function');
      }
    }
  });

  it('every manifest row has a non-empty intended value and provenance', () => {
    for (const lever of PRODUCTION_ENV_INTENT) {
      expect(lever.intended.length).toBeGreaterThan(0);
      expect(lever.provenance.length).toBeGreaterThan(0);
    }
  });
});
