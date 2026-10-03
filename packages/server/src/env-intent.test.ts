// TRA-4474 — the intent manifest must disagree with a wiped env, and must not
// manufacture a verdict on a box that cannot prove it is production.
import { describe, expect, it } from 'vitest';

import { PRODUCTION_ENV_INTENT, summarizeEnvIntent } from './env-intent.js';
import { DEMO_FLAG_ALLOWLIST } from './demo-flags.js'; // TRA-5014

/** The posture-as-ruled production env: every graded lever at its intended value. */
const RULED_PROD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DURABILITY_POLICY: 'refuse',
  // Card 6b82a9e7 on TRA-3401 (human board answer, 2026-09-24T01:57Z): TRADIER_ENV
  // production RATIFIED (TRA-1655 G2), the OTM sleeve RE-ARMED per TRA-4750 item 5,
  // and the TRA-4814 telemetry rider armed in the same change.
  TRADIER_ENV: 'production',
  // TRA-4885 default B executed by TRA-4988 (2026-10-03): the OTM sleeve is STOOD
  // DOWN again — card f8cd3843 expired unanswered, bands dark first, caps restored
  // to the ratified 300/500 as hygiene. Intent is `off`; a stored `false` mirrors
  // the bqb1 write (absence would match too — the flag defaults off).
  ENABLE_OPTION_LIVE_OTM: 'false',
  ENABLE_OPTION_MAKER_TELEMETRY: 'true',
  // ENABLE_ORDER_QUOTE_GUARD / ENABLE_OPTION_LIVE_RV_LONG / _DIRECTIONAL absent:
  // their intent is `off` and their code default is off — absence MATCHES.
};

/** TRA-5014 — the overlay-backed lever's key. Armed via DATA_DIR/demo-flags.json. */
const ARM_FLAG = 'ENABLE_DIRECTIONAL_EXPLORATION_ALLOWANCE';

/**
 * TRA-5014 — grade the FULL manifest, which now contains an overlay-backed
 * lever, the way the live route grades it.
 *
 * The fixture mirrors bqb1 exactly rather than conveniently: the arm key is
 * ABSENT from the base env and PRESENT in the overlay layered over it, because
 * that flag has no `render.yaml` seed and no service env var — the overlay is
 * its only home. Putting it in the base env instead would make every case below
 * pass for the wrong reason and would stop testing the thing that broke.
 *
 * Cases that want the DISARMED or BLIND shapes call `summarizeEnvIntent`
 * directly, which is the point of keeping the overlay an explicit argument.
 */
const graded = (env: NodeJS.ProcessEnv) => summarizeEnvIntent(env, { ...env, [ARM_FLAG]: '1' });

describe('summarizeEnvIntent (TRA-4474)', () => {
  it('reads ok on the posture-as-ruled production env', () => {
    const s = graded(RULED_PROD_ENV);
    expect(s.applies).toBe(true);
    expect(s.mismatches).toEqual([]);
    expect(s.ok).toBe(true);
    // Absence with a passing default is visible as present:false, not hidden.
    const oqg = s.levers.find((l) => l.key === 'ENABLE_ORDER_QUOTE_GUARD');
    expect(oqg).toMatchObject({ present: false, raw: null, effective: 'off', matches: true });
  });

  it('THE INCIDENT: DURABILITY_POLICY wiped from the env reads as a named mismatch, never ok', () => {
    const { DURABILITY_POLICY: _gone, ...wiped } = RULED_PROD_ENV;
    const s = graded(wiped);
    expect(s.ok).toBe(false);
    expect(s.mismatches).toContain('DURABILITY_POLICY');
    const lever = s.levers.find((l) => l.key === 'DURABILITY_POLICY');
    // The effective value the wiped box actually runs — beside the intended one.
    expect(lever).toMatchObject({ present: false, effective: 'observe', intended: 'refuse', matches: false });
  });

  it('a lever intended OFF found ON is a mismatch (the TRA-4442 direction)', () => {
    const s = graded({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_DIRECTIONAL: 'true' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_DIRECTIONAL']);
  });

  // This assertion has now run THREE ways. Until 2026-09-22 it graded a wipe of
  // the TRA-2877 standing arm; TRA-4750 stood the sleeve down and it graded a
  // silent RE-ARM; card 6b82a9e7 on TRA-3401 (2026-09-24) executed the TRA-4750
  // item 5 re-arm and it graded a silent DISARM; TRA-4885's default B (executed
  // by TRA-4988, 2026-10-03) stood the sleeve down again, so the hazard inverted
  // once more: the event to catch is the stood-down sleeve being found silently
  // RE-ARMED on the money host.
  it('THE STAND-DOWN: the stood-down OTM sleeve found ARMED on the money host is a named mismatch', () => {
    for (const raw of ['1', 'true', 'yes', 'on']) {
      const s = graded({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_OTM: raw });
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_OTM']);
      expect(s.levers.find((l) => l.key === 'ENABLE_OPTION_LIVE_OTM')).toMatchObject({
        present: true,
        effective: 'on',
        intended: 'off',
        matches: false,
      });
    }
  });

  it('the stood-down sleeve reads ok on a stored false AND on a wipe (the flag defaults off)', () => {
    const stored = graded(RULED_PROD_ENV);
    expect(stored.mismatches).toEqual([]);
    expect(stored.ok).toBe(true);
    // A wipe reads dark too — matching, with present:false keeping the wipe
    // distinguishable from a stored `false`.
    const { ENABLE_OPTION_LIVE_OTM: _gone, ...wiped } = RULED_PROD_ENV;
    const s = graded(wiped);
    expect(s.ok).toBe(true);
    expect(s.levers.find((l) => l.key === 'ENABLE_OPTION_LIVE_OTM')).toMatchObject({
      present: false,
      effective: 'off',
      intended: 'off',
      matches: true,
    });
  });

  // TRA-4814 rider: a re-opened sleeve may not run untelemetered.
  it('THE RIDER: maker telemetry found OFF beside the armed sleeve is a named mismatch', () => {
    const { ENABLE_OPTION_MAKER_TELEMETRY: _gone, ...wiped } = RULED_PROD_ENV;
    const s = graded(wiped);
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
    const s = graded({ ...RULED_PROD_ENV, DURABILITY_POLICY: '  Refuse ' });
    expect(s.ok).toBe(true);
  });

  it('off-production nothing is graded: ok and every matches are null, never true', () => {
    const s = graded({ DURABILITY_POLICY: 'observe' });
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
    const s = graded({ ...RULED_PROD_ENV, TRADIER_ENV: 'sandbox' });
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
    const s = graded(noKey);
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
    const s = graded({ ...RULED_PROD_ENV, TRADIER_ENV: ' production ' });
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
    const s = graded({ ...RULED_PROD_ENV, TRADIER_ENV: token });
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
    const s = graded(RULED_PROD_ENV);
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

// ── TRA-5014: the overlay-backed lever ──────────────────────────────────────
// The paper directional sleeve went dark for SEVEN consecutive ET sessions
// (2026-09-23..2026-10-01) because this flag was disarmed by an unattributed
// write, and `check:env-intent` graded MATCH / exit 0 on every one of those
// days: the flag has no `render.yaml` seed, it is armed through the demo-flags
// overlay rather than the service env list, and it was absent from the manifest.
describe('overlay-backed levers (TRA-5014)', () => {
  const armed = { ...RULED_PROD_ENV, [ARM_FLAG]: '1' };

  it('THE DROUGHT: the arm found disarmed is a named mismatch, not a quiet default', () => {
    // The overlay exists and simply does not carry the key — the 09-22/23 state.
    const s = summarizeEnvIntent(RULED_PROD_ENV, { ...RULED_PROD_ENV });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual([ARM_FLAG]);
    expect(s.blindLevers).toEqual([]);
    expect(s.levers.find((l) => l.key === ARM_FLAG)).toMatchObject({
      intended: 'on',
      effective: 'off',
      present: false,
      matches: false,
      overlayBacked: true,
      overlayVisible: true,
    });
  });

  it('reads ok when the OVERLAY alone carries the arm — the base env never holds this key', () => {
    const s = graded(RULED_PROD_ENV);
    expect(s.ok).toBe(true);
    expect(s.mismatches).toEqual([]);
    expect(s.blindLevers).toEqual([]);
    const lever = s.levers.find((l) => l.key === ARM_FLAG);
    // `present: true` is read off the OVERLAY, which is where the consumer reads.
    expect(lever).toMatchObject({ effective: 'on', raw: '1', present: true, matches: true });
    // The control that matters: the base env is genuinely innocent of the key,
    // so this is not passing because the fixture smuggled it in.
    expect(RULED_PROD_ENV[ARM_FLAG]).toBeUndefined();
  });

  it('BLIND, not DISARMED: no overlay supplied is ungraded and blocks ok, and never reports a mismatch', () => {
    // A caller that forgets the overlay must not be told the sleeve is dark.
    // Grading it against the base env would publish the code default `off` as if
    // it were a measurement — and `off` is the permissive-looking answer here,
    // because it reads as a tidy stand-down rather than a missing instrument.
    const s = summarizeEnvIntent(armed);
    expect(s.ok).toBe(false);
    expect(s.blindLevers).toEqual([ARM_FLAG]);
    expect(s.mismatches).toEqual([]);
    expect(s.levers.find((l) => l.key === ARM_FLAG)).toMatchObject({
      matches: null,
      overlayBacked: true,
      overlayVisible: false,
    });
  });

  it('accepts every truthy raw the shipped consumer accepts, and nothing else', () => {
    for (const raw of ['1', 'true', 'yes', 'on', ' ON ']) {
      expect(summarizeEnvIntent(RULED_PROD_ENV, { ...RULED_PROD_ENV, [ARM_FLAG]: raw }).ok).toBe(true);
    }
    for (const raw of ['0', 'false', 'off', '', 'maybe']) {
      const s = summarizeEnvIntent(RULED_PROD_ENV, { ...RULED_PROD_ENV, [ARM_FLAG]: raw });
      expect(s.mismatches, `raw ${JSON.stringify(raw)} must not arm`).toEqual([ARM_FLAG]);
    }
  });

  it('the overlay CANNOT move an env-backed lever — inert by construction', () => {
    // The overlay is attacker-shaped here: it carries a disarm for every
    // env-backed lever at once. None may move, because an env-backed lever
    // resolves from the base env and never consults the overlay.
    const hostileOverlay: NodeJS.ProcessEnv = {
      ...RULED_PROD_ENV,
      [ARM_FLAG]: '1',
      DURABILITY_POLICY: 'observe',
      TRADIER_ENV: 'sandbox',
      // A re-ARM attempt now that the sleeve is stood down (TRA-4988) — the
      // overlay must be as inert for a loosening as it was for a disarm.
      ENABLE_OPTION_LIVE_OTM: 'true',
      ENABLE_OPTION_MAKER_TELEMETRY: 'false',
      ENABLE_OPTION_LIVE_DIRECTIONAL: 'true',
    };
    const s = summarizeEnvIntent(RULED_PROD_ENV, hostileOverlay);
    expect(s.ok).toBe(true);
    expect(s.mismatches).toEqual([]);
  });

  it('no manifest lever is writable through the demo-flags overlay allowlist', () => {
    // The standing guard behind the test above. `demo-flags.json` is the only
    // writable switch a NON-ADMIN agent has on this host, so a manifest lever
    // appearing on that allowlist would hand an unprivileged write a lever this
    // file exists to protect — and for the real-money option rows that is a
    // capital path. Measured 2026-10-02: the two sets share zero keys.
    const overlayWritable = new Set<string>(DEMO_FLAG_ALLOWLIST);
    const envBacked = PRODUCTION_ENV_INTENT.filter((l) => l.overlayBacked !== true).map((l) => l.key);
    expect(envBacked.filter((k) => overlayWritable.has(k))).toEqual([]);
    // And the converse: an overlay-backed row MUST be on the allowlist, or the
    // arm it claims to grade can never actually be written through the overlay
    // (`loadDemoFlagFile` copies allowlisted keys only — an unlisted key is
    // silently dropped, so the row would grade a flag nobody can set).
    for (const l of PRODUCTION_ENV_INTENT.filter((x) => x.overlayBacked === true)) {
      expect(overlayWritable.has(l.key), `${l.key} is overlay-backed but not on DEMO_FLAG_ALLOWLIST`).toBe(true);
    }
  });
});
