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
  // Board card ca66df94 on TRA-5207 (human answer, 2026-10-06T03:03:52Z) armed
  // the LIVE directional learning budget ($800 loss cap / $150 per-open / 40
  // opens / 40-session box) — both keys written to bqb1 by single-key PUTs and
  // applied by a same-SHA env-apply (TRA-5213). The two rows move together.
  ENABLE_OPTION_LIVE_DIRECTIONAL: '1',
  ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET: '1',
  // TRA-5222 — the three ca66df94 board cap numbers, written by the same
  // TRA-5213 five-PUT batch. MAX_LOSS and MAX_OPENS sit below their code
  // ceilings (1000/60), so their rows exist precisely to catch a raise;
  // PER_OPEN is AT its ceiling (150).
  LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '800',
  LIVE_LEARNING_BUDGET_PER_OPEN_USD: '150',
  LIVE_LEARNING_BUDGET_MAX_OPENS: '40',
  // TRA-5291 (board ruling a+, card d243464d, supersedes the TRA-5279 Q2 pin
  // at 400) — the fleet aggregate authorization A, restored to the ratified
  // $500 (stamp 5fc18af7); absence would resolve to the $750 code default,
  // which is WIDER than ratified and must mismatch.
  LIVE_OPTION_TEST_AGGREGATE_CAP_USD: '500',
  // ENABLE_ORDER_QUOTE_GUARD / ENABLE_OPTION_LIVE_RV_LONG absent: their intent
  // is `off` and their code default is off — absence MATCHES.
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

  // TRA-5222 (TRA-5188-watch finding) — the board cap NUMBERS are graded by
  // value, post-clamp, the way resolveLiveLearningCaps resolves them. The two
  // rows whose code ceiling sits ABOVE the board number must go red on a raise
  // the consumer would honour; a raise past the ceiling clamps and still
  // mismatches at the ceiling value; a wipe falls to the code default and
  // mismatches there.
  it('the ca66df94 cap numbers: a store raise the clamp honours is a named mismatch', () => {
    const raised = graded({
      ...RULED_PROD_ENV,
      LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '1000',
      LIVE_LEARNING_BUDGET_MAX_OPENS: '60',
    });
    expect(raised.ok).toBe(false);
    expect(raised.mismatches).toContain('LIVE_LEARNING_BUDGET_MAX_LOSS_USD');
    expect(raised.mismatches).toContain('LIVE_LEARNING_BUDGET_MAX_OPENS');
    expect(raised.levers.find((l) => l.key === 'LIVE_LEARNING_BUDGET_MAX_LOSS_USD')).toMatchObject({
      effective: '1000',
      intended: '800',
      matches: false,
    });
    // Past the ceiling: the consumer clamps 5000 -> 1000; the row grades the
    // clamped value real orders obey, not the stored string.
    const clamped = graded({ ...RULED_PROD_ENV, LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '5000' });
    expect(clamped.levers.find((l) => l.key === 'LIVE_LEARNING_BUDGET_MAX_LOSS_USD')).toMatchObject({
      effective: '1000',
      matches: false,
    });
    // A wipe falls to the code default (300) — a silent TIGHTENING is still a
    // posture the board did not rule; it must not grade clean.
    const { LIVE_LEARNING_BUDGET_MAX_LOSS_USD: _gone, ...wipedEnv } = RULED_PROD_ENV;
    const wiped = graded(wipedEnv);
    expect(wiped.levers.find((l) => l.key === 'LIVE_LEARNING_BUDGET_MAX_LOSS_USD')).toMatchObject({
      present: false,
      effective: '300',
      intended: '800',
      matches: false,
    });
  });

  it('TRA-5279/TRA-5291: the fleet aggregate cap A is graded — a wipe widens to the $750 default and mismatches', () => {
    // The lever TRA-5279 found resolving from nowhere any instrument graded,
    // ruled to the ratified 500 by board card d243464d (TRA-5291). A WIPE is
    // the loud direction: absence resolves to the $750 code default, WIDER
    // than the ratified 500.
    const { LIVE_OPTION_TEST_AGGREGATE_CAP_USD: _gone, ...wipedEnv } = RULED_PROD_ENV;
    const wiped = graded(wipedEnv);
    expect(wiped.ok).toBe(false);
    expect(wiped.levers.find((l) => l.key === 'LIVE_OPTION_TEST_AGGREGATE_CAP_USD')).toMatchObject({
      present: false,
      effective: '750',
      intended: '500',
      matches: false,
    });
    // A silent revert to the pre-ruling 400 is STILL a mismatch — tighter but
    // un-ruled: the row pins the posture in force, and moving it is a board
    // act (a card superseding d243464d), not a store write.
    const reverted = graded({ ...RULED_PROD_ENV, LIVE_OPTION_TEST_AGGREGATE_CAP_USD: '400' });
    expect(reverted.mismatches).toContain('LIVE_OPTION_TEST_AGGREGATE_CAP_USD');
    // Past the ceiling: the consumer clamps 2000 -> 750; the row grades the
    // clamped value the order site obeys, not the stored string.
    const clamped = graded({ ...RULED_PROD_ENV, LIVE_OPTION_TEST_AGGREGATE_CAP_USD: '2000' });
    expect(clamped.levers.find((l) => l.key === 'LIVE_OPTION_TEST_AGGREGATE_CAP_USD')).toMatchObject({
      effective: '750',
      matches: false,
    });
  });

  it('a lever intended OFF found ON is a mismatch (the TRA-4442 direction)', () => {
    // RV_LONG carries this case now: the directional lever's intent moved to
    // 'on' under card ca66df94 (TRA-5213) and has its own describe block below.
    const s = graded({ ...RULED_PROD_ENV, ENABLE_OPTION_LIVE_RV_LONG: 'true' });
    expect(s.ok).toBe(false);
    expect(s.mismatches).toEqual(['ENABLE_OPTION_LIVE_RV_LONG']);
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
    // Every overlay-backed lever goes blind together — TRA-5172 added the wheel
    // IV filter (its home is the same demo-flags overlay).
    expect(s.blindLevers).toEqual([ARM_FLAG, 'ENABLE_WHEEL_IV_ENTRY_FILTER']);
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
      // And a DISARM attempt on the ca66df94-armed pair (TRA-5213): an overlay
      // write must not be able to kill the live budget either.
      ENABLE_OPTION_LIVE_DIRECTIONAL: 'false',
      ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET: '0',
    };
    const s = summarizeEnvIntent(RULED_PROD_ENV, hostileOverlay);
    expect(s.ok).toBe(true);
    expect(s.mismatches).toEqual([]);
  });

  // ── TRA-5213: the ca66df94 live directional arm ────────────────────────────
  // Card ca66df94 on TRA-5207 is the "separate gated approval" the TRA-1490 row
  // always named; the authorisation is scoped to the learning budget, so the two
  // rows grade as a PAIR and either half moving alone is the event to catch.
  describe('the ca66df94 live directional arm (TRA-5213)', () => {
    const DIR = 'ENABLE_OPTION_LIVE_DIRECTIONAL';
    const BUDGET = 'ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET';

    it('armed-as-ruled reads ok: lever and budget both on', () => {
      const s = graded(RULED_PROD_ENV);
      expect(s.ok).toBe(true);
      for (const key of [DIR, BUDGET]) {
        expect(s.levers.find((l) => l.key === key), key).toMatchObject({
          intended: 'on',
          effective: 'on',
          present: true,
          matches: true,
        });
      }
    });

    it('THE KILL SWITCH: budget off while the directional lever is still on is a named mismatch', () => {
      const s = graded({ ...RULED_PROD_ENV, [BUDGET]: '0' });
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual([BUDGET]);
    });

    it('a WIPE of the budget key grades like the kill switch — absence is never a quiet pass', () => {
      const { [BUDGET]: _gone, ...wiped } = RULED_PROD_ENV;
      const s = graded(wiped);
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual([BUDGET]);
      expect(s.levers.find((l) => l.key === BUDGET)).toMatchObject({
        present: false,
        effective: 'off',
        intended: 'on',
        matches: false,
      });
    });

    it('the directional lever wiped while the budget stays armed is a named mismatch (the arm did not survive)', () => {
      const { [DIR]: _gone, ...wiped } = RULED_PROD_ENV;
      const s = graded(wiped);
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual([DIR]);
    });

    it('both rows state the ruling: the card and the disarm/expiry condition, not just the value', () => {
      for (const key of [DIR, BUDGET]) {
        const p = PRODUCTION_ENV_INTENT.find((l) => l.key === key)!.provenance;
        expect(p, key).toContain('ca66df94');
        // The runtime self-disarm (loss/open/session caps) is invisible in env,
        // so the provenance must point a reader at the budget's own disarm term.
        expect(p, key).toContain('disarm');
        expect(p, key).toContain('liveLearningBudget.disarmed');
        // TRA-5216 — the term's home route, by name. The rows shipped naming
        // /api/health/durability, which did not carry the block, and
        // `?.disarmed != null` against an absent block grades the permissive
        // "not disarmed" branch — so the predicate must also be stated
        // fail-closed: an absent/unreadable block is UNREAD, never a pass.
        expect(p, key).toContain('/api/health/cost-aware-gate');
        expect(p, key).toContain('UNREAD');
      }
    });

    it('acceptance guard (TRA-5213): OTM and RV_LONG stay intended off — dark by authorisation', () => {
      for (const key of ['ENABLE_OPTION_LIVE_OTM', 'ENABLE_OPTION_LIVE_RV_LONG']) {
        expect(PRODUCTION_ENV_INTENT.find((l) => l.key === key)!.intended, key).toBe('off');
      }
    });
  });

  // ── TRA-5172: the two IVR-gated flags ─────────────────────────────────────
  // Both consumers are a HARD FAIL on an unknown ivRank (expectancy gate `drop`,
  // wheel `passesRoutingGate` never routes), while the store reads depth 2 of 20
  // on 82/82 scans — so arming either today suppresses 100% of credit structures
  // with a drop rate that reads exactly like "the gate is working". The rows
  // make that precondition machine-readable on /api/health/durability instead
  // of living in a comment (the TRA-2206 warning was prose, and prose did not
  // stop it).
  describe('the IVR-gated flags are registered, intended off (TRA-5172 / TRA-5170 ruling)', () => {
    const EXPECT_FLAG = 'ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE';
    const WHEEL_FLAG = 'ENABLE_WHEEL_IV_ENTRY_FILTER';

    it('both rows grade matches:true on the ruled env — absent key, code default off', () => {
      const s = graded(RULED_PROD_ENV);
      expect(s.ok).toBe(true);
      for (const key of [EXPECT_FLAG, WHEEL_FLAG]) {
        expect(s.levers.find((l) => l.key === key), key).toMatchObject({
          intended: 'off',
          effective: 'off',
          present: false,
          matches: true,
        });
      }
      // The provenance a /api/health/durability reader sees names the ruling
      // and the measurable precondition, not just a ticket number.
      for (const key of [EXPECT_FLAG, WHEEL_FLAG]) {
        const p = PRODUCTION_ENV_INTENT.find((l) => l.key === key)!.provenance;
        expect(p).toContain('TRA-5170');
        expect(p).toContain('ivRankMeasured');
      }
    });

    it('the expectancy gate found armed is a named mismatch, for every raw its consumer accepts', () => {
      for (const raw of ['1', 'true', 'yes', 'on']) {
        const s = graded({ ...RULED_PROD_ENV, [EXPECT_FLAG]: raw });
        expect(s.ok).toBe(false);
        expect(s.mismatches).toEqual([EXPECT_FLAG]);
      }
    });

    it('the wheel IV filter is OVERLAY-backed: a daemon-free overlay arm is a named mismatch', () => {
      // Its home is demo-flags.json (the TRA-2028 board-arm path), so the arm
      // arrives through the overlay — exactly where this row must be reading.
      const s = summarizeEnvIntent(RULED_PROD_ENV, { ...RULED_PROD_ENV, [ARM_FLAG]: '1', [WHEEL_FLAG]: '1' });
      expect(s.ok).toBe(false);
      expect(s.mismatches).toEqual([WHEEL_FLAG]);
      expect(s.levers.find((l) => l.key === WHEEL_FLAG)).toMatchObject({
        effective: 'on',
        intended: 'off',
        matches: false,
        overlayBacked: true,
        overlayVisible: true,
      });
    });
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
