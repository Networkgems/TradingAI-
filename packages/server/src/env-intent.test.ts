// TRA-4474 — the intent manifest must disagree with a wiped env, and must not
// manufacture a verdict on a box that cannot prove it is production.
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ENV_INTENT, summarizeEnvIntent } from './env-intent.js';

/** The posture-as-ruled production env: every graded lever at its intended value. */
const RULED_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DURABILITY_POLICY: 'refuse',
  // Card 6b82a9e7 on TRA-3401 (human board answer, 2026-09-24T01:57Z): TRADIER_ENV
  // production RATIFIED (TRA-1655 G2), the OTM sleeve RE-ARMED per TRA-4750 item 5,
  // and the TRA-4814 telemetry rider armed in the same change.
  TRADIER_ENV: 'production',
  ENABLE_OPTION_LIVE_OTM: 'true',
  ENABLE_OPTION_MAKER_TELEMETRY: 'true',
  // ENABLE_ORDER_QUOTE_GUARD / ENABLE_OPTION_LIVE_RV_LONG / _DIRECTIONAL absent:
  // their intent is `off` and their code default is off — absence MATCHES.
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

  // This assertion has now run BOTH ways. Until 2026-09-22 it graded a wipe of
  // the TRA-2877 standing arm; TRA-4750 stood the sleeve down and it graded a
  // silent RE-ARM; card 6b82a9e7 on TRA-3401 (2026-09-24) executed the TRA-4750
  // item 5 board sign-off, so the hazard inverted back: the event to catch is
  // the board-armed sleeve being found silently DISARMED on the money host.
  it('THE RE-ARM: the board-armed OTM sleeve found DARK on the money host is a named mismatch', () => {
    for (const env of [{ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_OTM: 'false' }] as NodeJS.ProcessEnv[]) {
      const s = summarizeEnvIntent(env);
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_OTM']);
      expect(s.levers.find((l) => l.key === 'ENABLE_OPTION_LIVE_OTM')).toMatchObject({
        present: true,
        effective: 'off',
        intended: 'on',
        matches: false,
      });
    }
    // A WIPE reads dark too (the flag defaults off) — same named mismatch, with
    // present:false keeping the wipe distinguishable from a stored `false`.
    const { ENABLE_OPTION_LIVE_OTM: _gone, ...wiped } = RULED_PROD_ENV;
    const s = summarizeEnvIntent(wiped);
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_OTM']);
    expect(s.levers.find((l) => l.key === 'ENABLE_OPTION_LIVE_OTM')).toMatchObject({
      present: false,
      effective: 'off',
      matches: false,
    });
  });

  it('the re-armed sleeve reads ok on every truthy raw the shipped flag accepts', () => {
    for (const raw of ['1', 'true', 'yes', 'on']) {
      const s = summarizeEnvIntent({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_OTM: raw });
      expect(s.mismatches).toEqual([]);
      expect(s.ok).toBe(true);
    }
  });

  // TRA-4814 rider: a re-opened sleeve may not run untelemetered.
  it('THE RIDER: maker telemetry found OFF beside the armed sleeve is a named mismatch', () => {
    const { ENABLE_OPTION_MAKER_TELEMETRY: _gone, ...wiped } = RULED_PROD_ENV;
    const s = summarizeEnvIntent(wiped);
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_MAKER_TELEMETRY']);
    expect(s.levers.find((l) => l.key === 'ENABLE_OPTION_MAKER_TELEMETRY')).toMatchObject({
      present: false,
      effective: 'off',
      intended: 'on',
      matches: false,
    });
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

  // ── TRADIER_ENV ──────────────────────────────────────────────────────────
  // Third inversion of this row: 'production' (TRA-2163) → 'sandbox' (TRA-4801,
  // under the stand-down) → 'production' again (card 6b82a9e7 ratification,
  // 2026-09-24). With a live sleeve armed, the hazard is a silent re-point to
  // sandbox: real entries would route to the sandbox broker.
  it('THE RE-POINT: TRADIER_ENV=sandbox beside the armed live sleeve is a named mismatch', () => {
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

  it('an ABSENT TRADIER_ENV resolves sandbox like the credential router — a MISMATCH under the ratified intent', () => {
    const { TRADIER_ENV: _gone, ...noKey } = RULED_PROD_ENV;
    const s = summarizeEnvIntent(noKey);
    expect(s.mismatches).toContain('TRADIER_ENV');
    // index.ts: `(process.env['TRADIER_ENV'] as ...) ?? 'sandbox'` — absence
    // routes SANDBOX credentials under an armed sleeve. The present:false bit
    // keeps a wipe distinguishable from a stored label.
    expect(s.levers.find((l) => l.key === 'TRADIER_ENV')).toMatchObject({
      present: false,
      raw: null,
      effective: 'sandbox',
      matches: false,
    });
  });

  it('a PADDED ` production ` is `unrecognized`, not a quiet production — two live readers disagree on it', () => {
    const s = summarizeEnvIntent({ ...RULED_PROD_ENV, TRADIER_ENV: ' production ' });
    // The credential router (`=== 'production'`, no trim) hands out SANDBOX creds,
    // while /api/health/live-equity (`.trim() === 'production'`) reports production.
    // Collapsing this into either label would hide that disagreement.
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
