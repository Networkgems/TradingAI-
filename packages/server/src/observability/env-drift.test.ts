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
import { RENDER_RATIFIED_DEMO_DEFAULTS } from '../demo-flags.js';

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

    // ...then the divergences themselves.
    expect(report.declaredOnButOff).toEqual([
      { key: 'EXIT_RISK_RULES_ENABLED', declared: 'on', running: 'absent' },
      { key: 'ENABLE_REVERSAL_SHADOW', declared: 'on', running: 'off' },
    ]);
    expect(report.declaredOffButOn).toEqual([
      { key: 'ENABLE_SOMETHING_RISKY', declared: 'off', running: 'on' },
    ]);
    expect(report.valueMismatch).toEqual([
      { key: 'NODE_VERSION', declared: 'set', running: 'set' },
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
      },
    ]);
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
    });
  });
});

describe('TRA-2209 the surface never leaks a value', () => {
  it('serializes without any declared or running env value', () => {
    const serialized = JSON.stringify(evaluate(crlf(FIXTURE_LINES)));
    // Every distinctive value present on either side of the comparison. These
    // keys share a store with TRADIER_API_TOKEN / AUTH_SECRET (TRA-2163), and the
    // route is NO-AUTH, so not one of them may appear in the payload.
    for (const value of ['production', '/data', '20.19.0', '18.0.0']) {
      expect(serialized).not.toContain(value);
    }
    // ...while the KEY names, which are what an operator needs, are all present.
    expect(serialized).toContain('EXIT_RISK_RULES_ENABLED');
    expect(serialized).toContain('NODE_VERSION');
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

  it('locates render.yaml from the module path without an override', () => {
    // The route depends on this walk-up finding the blueprint on Render; if it
    // silently failed, the surface would report `blueprintFound:false` forever.
    expect(loadRenderBlueprint({})).toContain('envVars:');
  });
});
