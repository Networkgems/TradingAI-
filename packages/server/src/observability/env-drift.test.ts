// TRA-2209 — declared-vs-running env drift check.
//
// THE TEST THIS FILE EXISTS FOR is `parses CRLF render.yaml and finds the
// planted divergence`. The first hand-rolled cut of this check silently reported
// ZERO DRIFT against a genuinely drifted box: render.yaml is CRLF, JS `.` does
// not match `\r`, so the `value:` capture failed on every line — 78 keys parsed,
// 0 values, empty "all clear" sections. It read EXACTLY like a healthy box.
//
// A drift checker that reads clean when its own parser is broken reproduces the
// precise failure this ticket exists to catch, so every fixture below is CRLF and
// the assertions cover the INPUT counts, not just the drift lists.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRenderYamlEnvVars,
  evaluateEnvDrift,
  classifyBool,
  loadRenderBlueprint,
} from './env-drift.js';
import { RENDER_RATIFIED_DEMO_DEFAULTS, RENDER_INFRA_DEFAULTS } from '../demo-flags.js';

/** Join fixture lines with CRLF — the real render.yaml's line ending. */
const crlf = (lines: string[]): string => lines.join('\r\n');
/** Same content, LF. Used to prove the two parse identically. */
const lf = (lines: string[]): string => lines.join('\n');

// A miniature blueprint carrying one of every case that matters. Values are
// deliberately distinctive strings so the "never leaks a value" test can search
// for them in the serialized report.
const FIXTURE_LINES = [
  'services:',
  '  - type: web',
  '    name: tradingai-bqb1',
  '    envVars:',
  '      - key: AUTH_SECRET',
  '        generateValue: true',
  '      - key: TRADIER_API_TOKEN',
  '        sync: false',
  '      - key: NODE_ENV',
  '        value: production',
  '      - key: DATA_DIR',
  '        value: /data',
  // planted divergence #1 — declared ON, running absent (the wipe signature)
  '      - key: EXIT_RISK_RULES_ENABLED',
  '        value: "1"',
  // planted divergence #2 — declared ON (as "true"), running explicitly "0"
  '      - key: ENABLE_REVERSAL_SHADOW',
  '        value: "true"',
  // planted divergence #3 — declared OFF, running ON
  '      - key: ENABLE_SOMETHING_RISKY',
  '        value: "0"',
  // planted divergence #4 — non-boolean literal, running differs
  '      - key: NODE_VERSION',
  '        value: 20.19.0',
  // NOT drift — declared ON, running ON but spelled differently
  '      - key: RV_EXIT_RETUNE_ENABLED',
  '        value: "true"',
  // NOT drift — supplied by the boot self-heal, absent from the store
  '      - key: ENABLE_CHURN_LOSS_BRAKE',
  '        value: "1"',
  '',
];

const RUNNING_ENV: NodeJS.ProcessEnv = {
  RENDER: 'true',
  NODE_ENV: 'production',
  DATA_DIR: '/data',
  // EXIT_RISK_RULES_ENABLED deliberately ABSENT
  ENABLE_REVERSAL_SHADOW: '0',
  ENABLE_SOMETHING_RISKY: '1',
  NODE_VERSION: '18.0.0',
  RV_EXIT_RETUNE_ENABLED: '1', // declared "true" — same intent, not drift
  ENABLE_CHURN_LOSS_BRAKE: '1', // present ONLY because the seed put it there
};

const SEEDED = { ENABLE_CHURN_LOSS_BRAKE: 'RENDER_RATIFIED_DEMO_DEFAULTS' };

const evaluate = (blueprint: string | null) =>
  evaluateEnvDrift({
    blueprint,
    runningEnv: RUNNING_ENV,
    seededKeys: SEEDED,
    now: () => 1_784_000_000_000,
  });

describe('TRA-2209 render.yaml parser — CRLF', () => {
  it('parses CRLF render.yaml and finds the planted divergence', () => {
    const report = evaluate(crlf(FIXTURE_LINES));

    // INPUT-side first. The original bug parsed 78 keys and 0 VALUES, so the key
    // count alone would have passed this test while the check was broken. The
    // value count is the number that separates broken from healthy.
    expect(report.declaredKeysParsed).toBe(10);
    expect(report.declaredValuesParsed).toBe(8);
    expect(report.declaredDashboardManaged).toBe(1); // TRADIER_API_TOKEN
    expect(report.declaredRenderManaged).toBe(1); // AUTH_SECRET
    expect(report.parserOk).toBe(true);

    // ...then the divergences themselves. `source` is the TRA-5222 AC1 layer
    // attribution: an absent key's only voice is the blueprint; a present one
    // resolves from the store.
    expect(report.declaredOnButOff).toEqual([
      { key: 'EXIT_RISK_RULES_ENABLED', declared: 'on', running: 'absent', source: 'blueprint' },
      { key: 'ENABLE_REVERSAL_SHADOW', declared: 'on', running: 'off', source: 'render_store' },
    ]);
    expect(report.declaredOffButOn).toEqual([
      { key: 'ENABLE_SOMETHING_RISKY', declared: 'off', running: 'on', source: 'render_store' },
    ]);
    expect(report.valueMismatch).toEqual([
      {
        key: 'NODE_VERSION',
        declared: 'set',
        running: 'set',
        source: 'render_store',
        // TRA-5222 AC4 — `set` vs `set` was unactionable; both values emit.
        declaredValue: '20.19.0',
        runningValue: '18.0.0',
      },
    ]);
    expect(report.driftCount).toBe(4);
    expect(report.ok).toBe(false);
    expect(report.reason).toContain('4 declared env key(s) diverge');
  });

  it('produces a byte-identical report for CRLF and LF input', () => {
    // The sharpest statement of the bug: line endings must be invisible to the
    // result. If a `\r` ever reaches a capture again, these two diverge.
    expect(evaluate(crlf(FIXTURE_LINES))).toEqual(evaluate(lf(FIXTURE_LINES)));
  });

  it('strips CR from captured values rather than carrying it into the compare', () => {
    // Direct assertion on the parser: a trailing `\r` in a captured value would
    // make `"1"\r` !== `"1"` and silently invent a mismatch (or, with a broken
    // end-anchor, capture nothing at all).
    const parsed = parseRenderYamlEnvVars(crlf(FIXTURE_LINES));
    for (const entry of parsed.declared) {
      expect(entry.value ?? '').not.toContain('\r');
    }
    expect(parsed.declared.find((d) => d.key === 'NODE_ENV')?.value).toBe('production');
    expect(parsed.declared.find((d) => d.key === 'EXIT_RISK_RULES_ENABLED')?.value).toBe('1');
  });
});

describe('TRA-2209 a broken parser must not read clean', () => {
  it('reports ok:false when keys parse but NO values do — the exact original bug', () => {
    // Simulate the failure mode directly: every `value:` line removed, so the
    // parser sees keys and no literals. Under the old shape this printed empty
    // "all clear" sections and read like a healthy box.
    const brokenLines = FIXTURE_LINES.filter((l) => !/^\s*value:/.test(l));
    const report = evaluate(crlf(brokenLines));

    expect(report.declaredKeysParsed).toBeGreaterThan(0);
    expect(report.declaredValuesParsed).toBe(0);
    expect(report.driftCount).toBe(0); // <- the seductive number
    expect(report.parserOk).toBe(false); // <- the number that tells the truth
    expect(report.ok).toBe(false);
    expect(report.reason).toContain('BROKEN parse');
  });

  it('reports ok:false when the parser matches nothing at all', () => {
    const report = evaluate('# a blueprint with no envVars block\r\nservices: []\r\n');
    expect(report.declaredKeysParsed).toBe(0);
    expect(report.declaredValuesParsed).toBe(0);
    expect(report.driftCount).toBe(0);
    expect(report.parserOk).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.reason).toContain('BROKEN');
  });

  it('reports ok:false when render.yaml cannot be read at all', () => {
    const report = evaluate(null);
    expect(report.blueprintFound).toBe(false);
    expect(report.parserOk).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.declaredKeysParsed).toBe(0);
    expect(report.reason).toContain('not found');
  });
});

describe('TRA-2209 self-healed keys are surfaced, not counted as drift', () => {
  it('excludes a seeded key from every drift bucket and names its source', () => {
    const report = evaluate(crlf(FIXTURE_LINES));
    const allDrift = [
      ...report.declaredOnButOff,
      ...report.declaredOffButOn,
      ...report.valueMismatch,
    ].map((e) => e.key);
    expect(allDrift).not.toContain('ENABLE_CHURN_LOSS_BRAKE');
    expect(report.selfHealed).toEqual([
      {
        key: 'ENABLE_CHURN_LOSS_BRAKE',
        source: 'RENDER_RATIFIED_DEMO_DEFAULTS',
        declared: true,
        // Exempt from the drift buckets, but still COMPARED (TRA-2224).
        matchesDeclared: true,
      },
    ]);
    expect(report.selfHealedMismatchCount).toBe(0);
    // Compared = literal-declared minus self-healed, so the two accounts reconcile.
    expect(report.comparedKeys).toBe(report.declaredValuesParsed - report.selfHealed.length);
  });

  it('flags the SAME key as drift when the boot seed did NOT supply it', () => {
    // The self-heal exemption must be earned by an actual boot seed, not by map
    // membership — otherwise a genuinely dark flag hides behind the exemption.
    const report = evaluateEnvDrift({
      blueprint: crlf(FIXTURE_LINES),
      runningEnv: { ...RUNNING_ENV, ENABLE_CHURN_LOSS_BRAKE: '' },
      seededKeys: {},
      now: () => 1_784_000_000_000,
    });
    expect(report.declaredOnButOff.map((e) => e.key)).toContain('ENABLE_CHURN_LOSS_BRAKE');
    expect(report.selfHealed).toEqual([]);
  });
});

describe('TRA-2209 comparison semantics', () => {
  it('treats "true" and "1" as the same intent', () => {
    const report = evaluate(crlf(FIXTURE_LINES));
    const keys = report.declaredOnButOff.map((e) => e.key);
    expect(keys).not.toContain('RV_EXIT_RETUNE_ENABLED'); // declared "true", running "1"
  });

  it('classifies boolean spellings case-insensitively and leaves others null', () => {
    expect(classifyBool('1')).toBe(true);
    expect(classifyBool(' TRUE ')).toBe(true);
    expect(classifyBool('On')).toBe(true);
    expect(classifyBool('0')).toBe(false);
    expect(classifyBool('False')).toBe(false);
    expect(classifyBool('')).toBe(false);
    expect(classifyBool('20.19.0')).toBeNull();
    expect(classifyBool('/data')).toBeNull();
  });

  it('skips sync:false and generateValue keys — they are legitimately absent', () => {
    const report = evaluate(crlf(FIXTURE_LINES));
    const allKeys = [
      ...report.declaredOnButOff,
      ...report.declaredOffButOn,
      ...report.valueMismatch,
    ].map((e) => e.key);
    expect(allKeys).not.toContain('TRADIER_API_TOKEN'); // sync: false
    expect(allKeys).not.toContain('AUTH_SECRET'); // generateValue: true
  });

  it('reports an absent non-boolean literal as a mismatch, not silence', () => {
    const report = evaluateEnvDrift({
      blueprint: crlf(FIXTURE_LINES),
      runningEnv: { ...RUNNING_ENV, NODE_VERSION: undefined },
      seededKeys: SEEDED,
      now: () => 1_784_000_000_000,
    });
    expect(report.valueMismatch).toContainEqual({
      key: 'NODE_VERSION',
      declared: 'set',
      running: 'absent',
      source: 'blueprint',
      declaredValue: '20.19.0',
    });
  });
});

describe('TRA-5222 AC4 — value emission rules (revising TRA-2163 no-values-ever)', () => {
  it('emits values ONLY on divergence entries, never for agreeing keys', () => {
    const serialized = JSON.stringify(evaluate(crlf(FIXTURE_LINES)));
    // Agreeing keys still emit no values — nothing to act on, nothing to show.
    for (const value of ['production', '/data']) {
      expect(serialized).not.toContain(value);
    }
    // A valueMismatch now carries BOTH sides (TRA-5222 AC4): `set` vs `set`
    // hid a 10x budget divergence (OPTIONS_IDEAS_MONTHLY_USD_CAP 5 vs 50).
    expect(serialized).toContain('20.19.0');
    expect(serialized).toContain('18.0.0');
    expect(serialized).toContain('EXIT_RISK_RULES_ENABLED');
    expect(serialized).toContain('NODE_VERSION');
  });

  it('never emits a dashboard-managed or render-managed value — they are never compared', () => {
    // The secrets live in these kinds (sync:false / generateValue). Structural:
    // only literal-declared keys reach any bucket, so no bucket can carry them.
    const report = evaluate(crlf(FIXTURE_LINES));
    const allKeys = [
      ...report.declaredOnButOff,
      ...report.declaredOffButOn,
      ...report.valueMismatch,
      ...report.overlayManaged,
    ].map((e) => e.key);
    expect(allKeys).not.toContain('TRADIER_API_TOKEN');
    expect(allKeys).not.toContain('AUTH_SECRET');
  });

  it('redacts values for a literal whose NAME matches the secret pattern', () => {
    // A credential declared as a blueprint literal is a mistake, but the
    // surface must not amplify it: the entry reports the divergence with
    // `valuesRedacted: true` and carries neither value.
    const report = evaluateEnvDrift({
      blueprint: crlf([
        'services:',
        '  - type: web',
        '    envVars:',
        '      - key: SOME_WEBHOOK_TOKEN',
        '        value: declared-hook-value',
        '',
      ]),
      runningEnv: { SOME_WEBHOOK_TOKEN: 'running-hook-value' },
      seededKeys: {},
      now: () => 1_784_000_000_000,
    });
    expect(report.valueMismatch).toEqual([
      {
        key: 'SOME_WEBHOOK_TOKEN',
        declared: 'set',
        running: 'set',
        source: 'render_store',
        valuesRedacted: true,
      },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('declared-hook-value');
    expect(serialized).not.toContain('running-hook-value');
  });
});

describe('TRA-5222 AC1 — the demo-flags.json overlay is a layer, not drift', () => {
  // The measured 2026-10-06 shape: render.yaml declares the steady state ON,
  // the TRA-5207 pre-bell runbook wrote "0" into demo-flags.json, the engine's
  // effective env resolves the overlay value. Before this ticket that read as
  // declaredOnButOff and burned the alarm; an UNAUTHORIZED flip then arrives
  // indistinguishable (`ok:false` either way — the wolf-crier).
  const OVERLAY_LINES = [
    'services:',
    '  - type: web',
    '    envVars:',
    '      - key: OTM_DELTA_FLOOR_ENABLED',
    '        value: "1"',
    '      - key: ENABLE_OPTION_COST_AWARE_GATE',
    '        value: "1"',
    '      - key: ENABLE_SMA200_DEMO_FORWARD_TEST',
    '        value: "1"',
    '',
  ];
  const base = {
    blueprint: crlf(OVERLAY_LINES),
    seededKeys: {},
    now: () => 1_784_000_000_000,
  };

  it('reports an overlay-authorized divergence as overlayManaged, driftCount 0, ok true', () => {
    const report = evaluateEnvDrift({
      ...base,
      // Effective env: overlay "0" wins over the store "1" for the floor key;
      // the cost-aware key is absent from the store entirely (boot seed skipped
      // because the file holds it), so the overlay is its only voice.
      runningEnv: {
        RENDER: 'true',
        OTM_DELTA_FLOOR_ENABLED: '0',
        ENABLE_OPTION_COST_AWARE_GATE: '0',
        ENABLE_SMA200_DEMO_FORWARD_TEST: '1',
      },
      overlay: { OTM_DELTA_FLOOR_ENABLED: '0', ENABLE_OPTION_COST_AWARE_GATE: '0' },
    });
    expect(report.declaredOnButOff).toEqual([]);
    expect(report.overlayManaged).toEqual([
      {
        key: 'ENABLE_OPTION_COST_AWARE_GATE',
        declared: 'on',
        running: 'off',
        source: 'overlay',
        agreesWithDeclared: false,
        declaredValue: '1',
        runningValue: '0',
      },
      {
        key: 'OTM_DELTA_FLOOR_ENABLED',
        declared: 'on',
        running: 'off',
        source: 'overlay',
        agreesWithDeclared: false,
        declaredValue: '1',
        runningValue: '0',
      },
    ]);
    // The whole point: an authorized, dated runbook action does not burn the alarm.
    expect(report.driftCount).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('still counts a running value that contradicts BOTH the blueprint AND the overlay', () => {
    // The overlay authorizes EXACTLY its recorded value — it is not a blanket
    // exemption for the key (that would re-open TRA-2224's hole one layer up).
    const report = evaluateEnvDrift({
      ...base,
      runningEnv: {
        RENDER: 'true',
        OTM_DELTA_FLOOR_ENABLED: '1', // matches blueprint — fine
        ENABLE_OPTION_COST_AWARE_GATE: '0', // matches overlay — fine
        ENABLE_SMA200_DEMO_FORWARD_TEST: '0', // contradicts blueprint "1", overlay says "1" too
      },
      overlay: {
        OTM_DELTA_FLOOR_ENABLED: '0', // stale overlay; running follows blueprint — overlayManaged, not drift
        ENABLE_OPTION_COST_AWARE_GATE: '0',
        ENABLE_SMA200_DEMO_FORWARD_TEST: '1', // running "0" contradicts this AND the blueprint
      },
    });
    expect(report.declaredOnButOff).toEqual([
      {
        key: 'ENABLE_SMA200_DEMO_FORWARD_TEST',
        declared: 'on',
        running: 'off',
        source: 'overlay',
      },
    ]);
    expect(report.driftCount).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.overlayManaged.map((e) => e.key)).toEqual([
      'ENABLE_OPTION_COST_AWARE_GATE',
      'OTM_DELTA_FLOOR_ENABLED',
    ]);
  });

  it('AC5 negative-control shape: one unauthorized flip moves driftCount 0 → 1 → 0', () => {
    // A green route that has never been shown to go red is not an alarm. This
    // is the pure-function half of the AC5 control; the live half runs the same
    // three reads against bqb1 (flip a non-money demo key in the store, pinned
    // redeploy, read, restore, read).
    const clean = {
      RENDER: 'true',
      OTM_DELTA_FLOOR_ENABLED: '0',
      ENABLE_OPTION_COST_AWARE_GATE: '0',
      ENABLE_SMA200_DEMO_FORWARD_TEST: '1',
    };
    const overlay = { OTM_DELTA_FLOOR_ENABLED: '0', ENABLE_OPTION_COST_AWARE_GATE: '0' };

    const before = evaluateEnvDrift({ ...base, runningEnv: clean, overlay });
    expect(before.driftCount).toBe(0);
    expect(before.ok).toBe(true);

    const flipped = evaluateEnvDrift({
      ...base,
      runningEnv: { ...clean, ENABLE_SMA200_DEMO_FORWARD_TEST: '0' },
      overlay,
    });
    expect(flipped.driftCount).toBe(1);
    expect(flipped.ok).toBe(false);
    expect(flipped.declaredOnButOff.map((e) => e.key)).toEqual([
      'ENABLE_SMA200_DEMO_FORWARD_TEST',
    ]);

    const restored = evaluateEnvDrift({ ...base, runningEnv: clean, overlay });
    expect(restored.driftCount).toBe(0);
    expect(restored.ok).toBe(true);
  });
});

describe('TRA-2209 against the real render.yaml', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const blueprint = readFileSync(join(repoRoot, 'render.yaml'), 'utf8');

  it('parses the blueprint identically whichever line ending the checkout has', () => {
    // DO NOT assert `blueprint` contains '\r\n' — that passes on Windows and
    // fails on Linux, for a reason that matters more than the assertion:
    //
    // render.yaml is stored in git as LF (`git cat-file blob HEAD:render.yaml`
    // has ZERO CR bytes). The CRLF that broke the first cut of this check is a
    // WORKTREE artifact of `core.autocrlf=true` on a Windows checkout. Linux CI
    // and Render therefore see LF and a naive `.`-based parser works there —
    // it fails ONLY on a hand-run from a Windows box, which is exactly the
    // operator this check exists to serve, and exactly the run CI cannot cover.
    //
    // So the portable, load-bearing property is INVARIANCE: same blueprint, same
    // report, whatever the checkout did to the line endings.
    const asLf = blueprint.replace(/\r\n/g, '\n');
    const asCrlf = asLf.replace(/\n/g, '\r\n');
    expect(parseRenderYamlEnvVars(asCrlf)).toEqual(parseRenderYamlEnvVars(asLf));
    expect(parseRenderYamlEnvVars(asCrlf).valuesParsed).toBeGreaterThan(0);
  });

  it('parses a plausible number of keys AND values off it', () => {
    const parsed = parseRenderYamlEnvVars(blueprint);
    // Floors, not exact pins — the blueprint gains keys over time and an exact
    // count would fail on every unrelated edit. A floor still catches the parse
    // collapsing, which is the failure that matters.
    expect(parsed.keysParsed).toBeGreaterThanOrEqual(70);
    expect(parsed.valuesParsed).toBeGreaterThanOrEqual(40);
    expect(parsed.dashboardManaged).toBeGreaterThanOrEqual(20);
    expect(parsed.keysParsed).toBe(
      parsed.valuesParsed + parsed.dashboardManaged + parsed.renderManaged,
    );
  });

  it('reads the four TRA-2198 outstanding flags as declared-ON literals', () => {
    // The verification the ticket names: these four are knowingly OFF on bqb1
    // pending a CEO ruling, so the check must be capable of seeing them declared.
    const parsed = parseRenderYamlEnvVars(blueprint);
    for (const key of [
      'EXIT_RISK_RULES_ENABLED',
      'BOOK_GIVEBACK_ARM_FLOOR_ENABLED',
      'ENABLE_REVERSAL_SHADOW',
      'ENABLE_CRYPTO_FANOUT_HARDENING',
    ]) {
      const entry = parsed.declared.find((d) => d.key === key);
      expect(entry, `${key} must be parsed out of render.yaml`).toBeDefined();
      expect(entry!.kind).toBe('literal');
      expect(classifyBool(entry!.value!)).toBe(true);
    }
  });

  it('reports those four as declaredOnButOff against an env that lacks them', () => {
    // End-to-end over the REAL blueprint: an env holding none of the four must
    // surface all four, and the report must still refuse to read ok.
    const report = evaluateEnvDrift({
      blueprint,
      runningEnv: { RENDER: 'true' },
      seededKeys: {},
      now: () => 1_784_000_000_000,
    });
    const off = report.declaredOnButOff.map((e) => e.key);
    for (const key of [
      'EXIT_RISK_RULES_ENABLED',
      'BOOK_GIVEBACK_ARM_FLOOR_ENABLED',
      'ENABLE_REVERSAL_SHADOW',
      'ENABLE_CRYPTO_FANOUT_HARDENING',
    ]) {
      expect(off, `${key} must be reported declared-ON-but-off`).toContain(key);
    }
    expect(report.parserOk).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('does NOT flag the self-healed keys the boot seed supplies', () => {
    // The other half of the ticket's acceptance criterion, run against the REAL
    // blueprint and the REAL self-heal maps rather than a fixture: reconstruct
    // the bqb1 boot — Render, none of these keys in the store, so the seed
    // supplies every one — and assert not one of them lands in a drift bucket.
    // Without the `selfHealed` exemption all ~12 would read as declaredOnButOff
    // and bury the four flags that actually need a ruling.
    const seededKeys = Object.fromEntries(
      Object.keys(RENDER_RATIFIED_DEMO_DEFAULTS).map((k) => [k, 'RENDER_RATIFIED_DEMO_DEFAULTS']),
    );
    const report = evaluateEnvDrift({
      blueprint,
      runningEnv: { RENDER: 'true', ...RENDER_RATIFIED_DEMO_DEFAULTS },
      seededKeys,
      now: () => 1_784_000_000_000,
    });
    const flagged = new Set(
      [...report.declaredOnButOff, ...report.declaredOffButOn, ...report.valueMismatch].map(
        (e) => e.key,
      ),
    );
    for (const key of [
      'ENABLE_OPTION_COST_AWARE_GATE',
      'ENABLE_CHURN_LOSS_BRAKE',
      'RV_EXIT_RETUNE_ENABLED',
      'RV_EXIT_RETUNE_CONFIRM_BARS',
      'RV_EXIT_FLIP_MIN_LOSS_PCT',
      'ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE',
    ]) {
      expect(flagged, `${key} is self-healed and must NOT read as drift`).not.toContain(key);
      expect(report.selfHealed.map((s) => s.key)).toContain(key);
    }
    // ...and the four outstanding ones are still visible in the same response,
    // which is the whole point: the exemption must not swallow real drift.
    expect(flagged).toContain('EXIT_RISK_RULES_ENABLED');
    expect(flagged).toContain('BOOK_GIVEBACK_ARM_FLOOR_ENABLED');
  });

  // ── TRA-2224 ────────────────────────────────────────────────────────────────
  // TRA-2224 found CHURN_SAME_SESSION_OPEN_CAP declared in render.yaml and absent
  // from the store, inert ONLY because the code default happened to equal the
  // declared "3". The same coincidence protects the self-heal maps, and there it
  // was not even OBSERVABLE: a seeded key was exempted from the drift buckets and
  // therefore never compared, so `selfHealed` reported it as a known, benign
  // fragility whatever value the process was actually running. Six of bqb1's ten
  // seeded keys are numeric tunables.
  it('flags a self-healed key whose RUNNING value contradicts render.yaml', () => {
    // Blueprint declares the cap at 2; the process is running 5. Pre-TRA-2224 this
    // was reported as a plain `selfHealed` entry and driftCount stayed 0.
    const lines = [
      'services:',
      '  - type: web',
      '    envVars:',
      '      - key: OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME',
      '        value: "2"',
      '',
    ];
    const report = evaluateEnvDrift({
      blueprint: crlf(lines),
      runningEnv: { RENDER: 'true', OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '5' },
      seededKeys: { OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: 'RENDER_RATIFIED_DEMO_DEFAULTS' },
      now: () => 1_784_000_000_000,
    });

    expect(report.parserOk).toBe(true);
    expect(report.selfHealed[0]!.matchesDeclared).toBe(false);
    expect(report.selfHealedMismatchCount).toBe(1);
    expect(report.driftCount).toBe(1);
    expect(report.ok).toBe(false);
    // driftCount must NOT be reconstructable from the three buckets alone.
    expect(report.declaredOnButOff).toEqual([]);
    expect(report.declaredOffButOn).toEqual([]);
    expect(report.valueMismatch).toEqual([]);
    // The reason has to point at the code map, not at an env upsert — the wrong
    // fix here is to write the store, which would not reconcile anything.
    expect(report.reason).toContain('self-healed');
    // NO VALUES, EVER still holds for the new field.
    expect(JSON.stringify(report)).not.toContain('5');
  });

  it('reports matchesDeclared:null when the blueprint declares no literal to compare', () => {
    // A seeded key that render.yaml carries as `sync: false` has NO declared value.
    // Answering `true` there would be a fabricated pass — the exact false-green the
    // whole module is built to refuse.
    const lines = [
      'services:',
      '  - type: web',
      '    envVars:',
      '      - key: SOME_DASHBOARD_KEY',
      '        sync: false',
      '      - key: NODE_ENV',
      '        value: production',
      '',
    ];
    const report = evaluateEnvDrift({
      blueprint: crlf(lines),
      runningEnv: { RENDER: 'true', NODE_ENV: 'production', SOME_DASHBOARD_KEY: 'x' },
      seededKeys: { SOME_DASHBOARD_KEY: 'RENDER_RATIFIED_DEMO_DEFAULTS' },
      now: () => 1_784_000_000_000,
    });
    expect(report.selfHealed[0]!.matchesDeclared).toBeNull();
    expect(report.selfHealedMismatchCount).toBe(0);
    expect(report.driftCount).toBe(0);
  });

  it('holds the self-heal maps to their own contract against the REAL render.yaml', () => {
    // Both maps document that seeding "makes the RUNNING gate match render.yaml
    // exactly". Nothing enforced that — it lived only in a docstring, and a
    // criterion that lives only in a docstring gets violated for a flag's whole
    // life. This is the enforcement: edit either side out of step and CI fails
    // here, at the commit, instead of on bqb1 weeks later.
    const blueprint = loadRenderBlueprint({});
    expect(blueprint).not.toBeNull();
    const declared = new Map(
      parseRenderYamlEnvVars(blueprint!)
        .declared.filter((d) => d.kind === 'literal' && d.value !== undefined)
        .map((d) => [d.key, d.value!] as const),
    );
    // Guard the count that separates: an empty/broken parse would make the loop
    // below vacuous and report a confident pass over zero comparisons.
    expect(declared.size).toBeGreaterThan(0);

    const maps: Array<[string, Readonly<Record<string, string>>]> = [
      ['RENDER_RATIFIED_DEMO_DEFAULTS', RENDER_RATIFIED_DEMO_DEFAULTS],
      ['RENDER_INFRA_DEFAULTS', RENDER_INFRA_DEFAULTS],
    ];
    let compared = 0;
    for (const [mapName, map] of maps) {
      const entries = Object.entries(map);
      expect(entries.length, `${mapName} is empty — this test would be vacuous`).toBeGreaterThan(0);
      for (const [key, seededValue] of entries) {
        const declaredValue = declared.get(key);
        expect(
          declaredValue,
          `${mapName}.${key} is seeded but render.yaml declares no literal for it — ` +
            `the map's admission rule requires a blueprint record`,
        ).toBeDefined();
        // Same intent test the route uses: "true" and "1" agree, numerics are exact.
        const report = evaluateEnvDrift({
          blueprint: crlf([
            'services:',
            '  - type: web',
            '    envVars:',
            `      - key: ${key}`,
            `        value: "${declaredValue}"`,
            '',
          ]),
          runningEnv: { RENDER: 'true', [key]: seededValue },
          seededKeys: { [key]: mapName },
          now: () => 1_784_000_000_000,
        });
        expect(
          report.selfHealed[0]!.matchesDeclared,
          `${mapName}.${key} seeds a value render.yaml does not declare — ` +
            `bqb1 would run a number the blueprint never authorised`,
        ).toBe(true);
        compared += 1;
      }
    }
    // Prove the loop actually ran; a silently-empty map set would pass otherwise.
    expect(compared).toBeGreaterThanOrEqual(
      Object.keys(RENDER_RATIFIED_DEMO_DEFAULTS).length + Object.keys(RENDER_INFRA_DEFAULTS).length,
    );
  });

  it('locates render.yaml from the module path without an override', () => {
    // The route depends on this walk-up finding the blueprint on Render; if it
    // silently failed, the surface would report `blueprintFound:false` forever.
    expect(loadRenderBlueprint({})).toContain('envVars:');
  });
});
