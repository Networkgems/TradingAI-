// TRA-1008 — the file-backed demo-flag override. The contract: a non-admin
// operator can flip a non-secret DEMO toggle (e.g. ENABLE_AUTONOMOUS_DEMO_LOOP)
// by writing `<DATA_DIR>/demo-flags.json`, WITHOUT reaching the SYSTEM-owned PM2
// daemon. Guardrails that matter: an absent/malformed file is a no-op (never
// crashes the loop), only allowlisted keys are honored (a secret in the file is
// ignored), and the file value wins over the base env.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadDemoFlagFile,
  resolveDemoFlagEnv,
  writeDemoFlagFile,
  renderRatifiedDemoDefaults,
  DEMO_FLAGS_FILENAME,
} from './demo-flags.js';
import { isAutonomousDemoLoopEnabled } from './autonomous-demo-loop.js';
import { resolveDirectionalQualityThresholds } from './ignition-quality-gate.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra1008-demoflags-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFlags(obj: unknown): void {
  writeFileSync(join(dir, DEMO_FLAGS_FILENAME), JSON.stringify(obj), 'utf8');
}

describe('loadDemoFlagFile', () => {
  it('returns {} when the file is absent (the default zero-override path)', () => {
    expect(loadDemoFlagFile(dir)).toEqual({});
  });

  it('returns {} for malformed JSON rather than throwing', () => {
    writeFileSync(join(dir, DEMO_FLAGS_FILENAME), '{ not json', 'utf8');
    expect(loadDemoFlagFile(dir)).toEqual({});
  });

  it('returns {} for non-object JSON (array / scalar)', () => {
    writeFlags(['ENABLE_AUTONOMOUS_DEMO_LOOP']);
    expect(loadDemoFlagFile(dir)).toEqual({});
  });

  it('reads allowlisted keys and coerces values to strings', () => {
    writeFlags({ ENABLE_AUTONOMOUS_DEMO_LOOP: 1, AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: '30000' });
    expect(loadDemoFlagFile(dir)).toEqual({
      ENABLE_AUTONOMOUS_DEMO_LOOP: '1',
      AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: '30000',
    });
  });

  it('ignores non-allowlisted keys (a secret in the file is never honored)', () => {
    writeFlags({ ENABLE_AUTONOMOUS_DEMO_LOOP: 'true', ADMIN_PASSWORD: 'leak', TRADIER_ENV: 'production' });
    expect(loadDemoFlagFile(dir)).toEqual({ ENABLE_AUTONOMOUS_DEMO_LOOP: 'true' });
  });

  it('honors the TRA-1294 take-profit-early demo flag (the demo-only arm lever)', () => {
    writeFlags({ TAKE_PROFIT_EARLY_ENABLED: 'true' });
    expect(loadDemoFlagFile(dir)).toEqual({ TAKE_PROFIT_EARLY_ENABLED: 'true' });
  });

  it('honors the TRA-1408 churn/loss-brake demo flags (arm lever + tunable cap)', () => {
    writeFlags({ ENABLE_CHURN_LOSS_BRAKE: 'true', CHURN_SAME_SESSION_OPEN_CAP: 5 });
    expect(loadDemoFlagFile(dir)).toEqual({
      ENABLE_CHURN_LOSS_BRAKE: 'true',
      CHURN_SAME_SESSION_OPEN_CAP: '5',
    });
  });

  it('honors the TRA-1476 directional quality-gate demo flags (arm lever + tunable floors/cap)', () => {
    writeFlags({
      ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: 1,
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: 10,
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '300000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: 2,
    });
    expect(loadDemoFlagFile(dir)).toEqual({
      ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '1',
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '10',
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '300000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '2',
    });
  });
});

describe('writeDemoFlagFile (TRA-1481 — arm a demo flag on a shell-less running service)', () => {
  it('creates the file and sets an allowlisted arm flag (round-trips through loadDemoFlagFile)', () => {
    const r = writeDemoFlagFile(dir, { ENABLE_CHURN_LOSS_BRAKE: '1', CHURN_SAME_SESSION_OPEN_CAP: 3 });
    expect(r.applied.sort()).toEqual(['CHURN_SAME_SESSION_OPEN_CAP', 'ENABLE_CHURN_LOSS_BRAKE']);
    expect(r.rejected).toEqual([]);
    expect(loadDemoFlagFile(dir)).toEqual({
      ENABLE_CHURN_LOSS_BRAKE: '1',
      CHURN_SAME_SESSION_OPEN_CAP: '3',
    });
  });

  it('read-merge-write: preserves keys the caller does not mention', () => {
    writeDemoFlagFile(dir, { ENABLE_AUTONOMOUS_DEMO_LOOP: '1' });
    writeDemoFlagFile(dir, { ENABLE_CHURN_LOSS_BRAKE: '1' });
    expect(loadDemoFlagFile(dir)).toEqual({
      ENABLE_AUTONOMOUS_DEMO_LOOP: '1',
      ENABLE_CHURN_LOSS_BRAKE: '1',
    });
  });

  it('a null value REMOVES a key (revert to env/default)', () => {
    writeDemoFlagFile(dir, { ENABLE_CHURN_LOSS_BRAKE: '1', ENABLE_AUTONOMOUS_DEMO_LOOP: '1' });
    const r = writeDemoFlagFile(dir, { ENABLE_CHURN_LOSS_BRAKE: null });
    expect(r.removed).toEqual(['ENABLE_CHURN_LOSS_BRAKE']);
    expect(loadDemoFlagFile(dir)).toEqual({ ENABLE_AUTONOMOUS_DEMO_LOOP: '1' });
  });

  it('REJECTS non-allowlisted keys (a secret / live setting is never written)', () => {
    const r = writeDemoFlagFile(dir, {
      ENABLE_CHURN_LOSS_BRAKE: '1',
      ADMIN_PASSWORD: 'leak',
      TRADIER_ENV: 'production',
    });
    expect(r.applied).toEqual(['ENABLE_CHURN_LOSS_BRAKE']);
    expect(r.rejected.sort()).toEqual(['ADMIN_PASSWORD', 'TRADIER_ENV']);
    // The file only ever contains the allowlisted key.
    expect(loadDemoFlagFile(dir)).toEqual({ ENABLE_CHURN_LOSS_BRAKE: '1' });
  });

  it('end-to-end: a write arms the flag through resolveDemoFlagEnv with no env var set', () => {
    const base = {} as NodeJS.ProcessEnv;
    expect(resolveDemoFlagEnv(dir, base)['ENABLE_CHURN_LOSS_BRAKE']).toBeUndefined();
    writeDemoFlagFile(dir, { ENABLE_CHURN_LOSS_BRAKE: '1' });
    expect(resolveDemoFlagEnv(dir, base)['ENABLE_CHURN_LOSS_BRAKE']).toBe('1');
  });
});

describe('renderRatifiedDemoDefaults (TRA-1481 — self-heal the Render blueprint env-sync gap)', () => {
  it('is a NO-OP off Render (self-host / local — no RENDER env)', () => {
    expect(renderRatifiedDemoDefaults(dir, {} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('seeds the board-ratified brakes on Render when set by neither env nor file', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    expect(renderRatifiedDemoDefaults(dir, env)).toEqual({
      ENABLE_CHURN_LOSS_BRAKE: '1',
      // TRA-1493 — the demo directional quality gate + its ratified thresholds
      // self-heal the same env-sync gap (dark on the e32727a autoDeploy).
      ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '1',
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '10',
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '300000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '2',
      // TRA-1409 / TRA-1480 — the RV exit re-tune + v2 winner-protect gate
      // (board approved on TRA-1597 checkbox `a1acc1a3`); self-heal the same gap.
      RV_EXIT_RETUNE_ENABLED: '1',
      RV_EXIT_RETUNE_CONFIRM_BARS: '2',
      RV_EXIT_FLIP_MIN_LOSS_PCT: '-0.20',
    });
  });

  it('does NOT override an explicit env value (a synced blueprint / dashboard value wins)', () => {
    const env = {
      RENDER: 'true',
      ENABLE_CHURN_LOSS_BRAKE: '0',
      ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '0',
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '5',
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '250000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '3',
      RV_EXIT_RETUNE_ENABLED: '0',
      RV_EXIT_RETUNE_CONFIRM_BARS: '3',
      RV_EXIT_FLIP_MIN_LOSS_PCT: '0',
    } as NodeJS.ProcessEnv;
    expect(renderRatifiedDemoDefaults(dir, env)).toEqual({});
  });

  it('TRA-1493 — reconciles the per-name cap to the ratified max-2 when the code default (3) is dark', () => {
    // The bug: on the e32727a autoDeploy the gate flag + cap never synced, so the
    // running gate showed maxOpensPerName:3 (code default). The seed re-delivers
    // render.yaml's ratified 2 so the TRA-1492 accept criteria (max-2/name/ET-day)
    // are met and the arm survives every redeploy.
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    Object.assign(env, renderRatifiedDemoDefaults(dir, env));
    expect(resolveDirectionalQualityThresholds(resolveDemoFlagEnv(dir, env)).maxOpensPerName).toBe(2);
  });

  it('does NOT override a demo-flags.json value — a board disarm via /api/admin/demo-flags is preserved', () => {
    // The board POSTs a deliberate `=0` disarm; the file layers over env, so the
    // seed must not re-arm it on the next boot.
    writeDemoFlagFile(dir, {
      ENABLE_CHURN_LOSS_BRAKE: '0',
      ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '0',
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '5',
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '250000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '3',
      RV_EXIT_RETUNE_ENABLED: '0',
      RV_EXIT_RETUNE_CONFIRM_BARS: '3',
      RV_EXIT_FLIP_MIN_LOSS_PCT: '0',
    });
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    expect(renderRatifiedDemoDefaults(dir, env)).toEqual({});
  });

  it('end-to-end: seeding the boot env arms the brake through the same overlay the engine reads', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    // Before the seed, the flag is dark on the running process (the bqb1 bug).
    expect(resolveDemoFlagEnv(dir, env)['ENABLE_CHURN_LOSS_BRAKE']).toBeUndefined();
    Object.assign(env, renderRatifiedDemoDefaults(dir, env)); // boot applies to process.env
    expect(resolveDemoFlagEnv(dir, env)['ENABLE_CHURN_LOSS_BRAKE']).toBe('1');
  });
});

describe('resolveDemoFlagEnv', () => {
  it('returns the base env unchanged when no file overrides exist', () => {
    const base = { FOO: 'bar' } as NodeJS.ProcessEnv;
    expect(resolveDemoFlagEnv(dir, base)).toBe(base);
  });

  it('layers the file over the base env (file wins)', () => {
    writeFlags({ ENABLE_AUTONOMOUS_DEMO_LOOP: '1' });
    const base = { ENABLE_AUTONOMOUS_DEMO_LOOP: '0', FOO: 'bar' } as NodeJS.ProcessEnv;
    const eff = resolveDemoFlagEnv(dir, base);
    expect(eff['ENABLE_AUTONOMOUS_DEMO_LOOP']).toBe('1');
    expect(eff['FOO']).toBe('bar');
    expect(base['ENABLE_AUTONOMOUS_DEMO_LOOP']).toBe('0'); // base not mutated
  });

  it('end-to-end: a file flip enables the loop gate without any env var set', () => {
    const base = {} as NodeJS.ProcessEnv;
    expect(isAutonomousDemoLoopEnabled(resolveDemoFlagEnv(dir, base))).toBe(false);
    writeFlags({ ENABLE_AUTONOMOUS_DEMO_LOOP: '1' });
    expect(isAutonomousDemoLoopEnabled(resolveDemoFlagEnv(dir, base))).toBe(true);
  });
});
