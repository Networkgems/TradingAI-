// TRA-1008 — the file-backed demo-flag override. The contract: a non-admin
// operator can flip a non-secret DEMO toggle (e.g. ENABLE_AUTONOMOUS_DEMO_LOOP)
// by writing `<DATA_DIR>/demo-flags.json`, WITHOUT reaching the SYSTEM-owned PM2
// daemon. Guardrails that matter: an absent/malformed file is a no-op (never
// crashes the loop), only allowlisted keys are honored (a secret in the file is
// ignored), and the file value wins over the base env.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDemoFlagFile,
  resolveDemoFlagEnv,
  writeDemoFlagFile,
  renderRatifiedDemoDefaults,
  renderInfraDefaults,
  RENDER_RATIFIED_DEMO_DEFAULTS,
  RENDER_INFRA_DEFAULTS,
  DEMO_FLAGS_FILENAME,
} from './demo-flags.js';
import { classifyBool, parseRenderYamlEnvVars } from './observability/env-drift.js';
import { isAutonomousDemoLoopEnabled } from './autonomous-demo-loop.js';
import { resolveDirectionalQualityThresholds } from './ignition-quality-gate.js';
import { isOptionCostAwareGateEnabled } from './option-cost-gate.js';

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

  // TRA-1682 — the entry-greeks gate was the ONLY option-entry gate with no daemon-free
  // lever. TRA-1677 then found it algebraically impossible (short-premium band
  // [0.30,0.40] vs a 0.45 selector floor — empty intersection, 100% reject), and there
  // was no way to disarm it short of a Render env change that was itself behind a deploy
  // pin: the failure and its remedy were locked behind the same door. It is non-secret and
  // demo-only (the engine consults it solely on the `mode === 'demo'` branch), so it meets
  // the same bar as the take-profit-early / OTM-floor / delta-ceiling levers above.
  it('honors the TRA-1682 entry-greeks-gate demo flag (the arm/DISARM lever the impossible gate lacked)', () => {
    // Both the gate and its EXIT_RISK_RULES master must be file-flippable, or the lever
    // is only half there — `isEntryGreeksGateEnabled` requires the master too.
    writeFlags({ ENTRY_GREEKS_GATE_ENABLED: 1, EXIT_RISK_RULES_ENABLED: 'true' });
    expect(loadDemoFlagFile(dir)).toEqual({
      ENTRY_GREEKS_GATE_ENABLED: '1',
      EXIT_RISK_RULES_ENABLED: 'true',
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
      // TRA-1632 — the news-catalyst SHADOW flag self-heals the same env-sync gap
      // (observe-only: D1 adds watchlist names, D2 annotates the report + logs a
      // shadow lean; no order, no size, no exit). render.yaml ratifies `=1`.
      ENABLE_NEWS_CATALYST_WATCHLIST: '1',
      // TRA-1602 — the per-candidate cost-aware fire bar on the demo RV / OTM /
      // directional opens (board arm `427b57ee`, QT-signed TRA-1603); self-heals the
      // same env-sync gap. Demo-only + pure risk-reducing (it only ever opens LESS).
      ENABLE_OPTION_COST_AWARE_GATE: '1',
      // TRA-1662 — the observe-only SHADOW maker-chase measurement. Self-heals the
      // same env-sync gap. No order routing, no capital: it re-polls quotes for
      // contracts the demo book already opened and records what a maker chase
      // would have recovered.
      ENABLE_OPTION_MAKER_SHADOW: '1',
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
      ENABLE_NEWS_CATALYST_WATCHLIST: '0',
      ENABLE_OPTION_COST_AWARE_GATE: '0',
      ENABLE_OPTION_MAKER_SHADOW: '0',
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
      // TRA-1602 — the cost-aware fire bar IS allowlisted (the engine reads it
      // through the demo-flags overlay), so the board's daemon-free `=0` disarm goes
      // in the file and must survive the boot seed.
      ENABLE_OPTION_COST_AWARE_GATE: '0',
      // TRA-1662 — the shadow maker-chase measurement is likewise allowlisted, so its
      // daemon-free `=0` disarm also lives in the file and must survive the seed.
      ENABLE_OPTION_MAKER_SHADOW: '0',
    });
    // TRA-1632 — the news-catalyst flag is NOT on the demo-flags.json allowlist
    // (isNewsCatalystEnabled reads raw process.env, so the file never reaches it);
    // its disarm path is an explicit env `=0` / cleared value, so set it here to
    // keep this file-disarm case an exact no-op.
    const env = { RENDER: 'true', ENABLE_NEWS_CATALYST_WATCHLIST: '0' } as NodeJS.ProcessEnv;
    expect(renderRatifiedDemoDefaults(dir, env)).toEqual({});
  });

  it('end-to-end: seeding the boot env arms the brake through the same overlay the engine reads', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    // Before the seed, the flag is dark on the running process (the bqb1 bug).
    expect(resolveDemoFlagEnv(dir, env)['ENABLE_CHURN_LOSS_BRAKE']).toBeUndefined();
    Object.assign(env, renderRatifiedDemoDefaults(dir, env)); // boot applies to process.env
    expect(resolveDemoFlagEnv(dir, env)['ENABLE_CHURN_LOSS_BRAKE']).toBe('1');
  });

  it('TRA-1602 — the boot seed ARMS the cost-aware fire bar through the engine overlay, and a file `=0` disarms it', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    // Dark before the seed — the render.yaml `=1` never reached the process (TRA-1289).
    expect(isOptionCostAwareGateEnabled(resolveDemoFlagEnv(dir, env))).toBe(false);

    Object.assign(env, renderRatifiedDemoDefaults(dir, env)); // boot applies to process.env
    expect(isOptionCostAwareGateEnabled(resolveDemoFlagEnv(dir, env))).toBe(true);

    // The board's daemon-free disarm: the file layers OVER the seeded env and wins.
    writeFlags({ ENABLE_OPTION_COST_AWARE_GATE: '0' });
    expect(isOptionCostAwareGateEnabled(resolveDemoFlagEnv(dir, env))).toBe(false);
  });
});

describe('renderInfraDefaults (TRA-1515 — durable-bake the crypto-tick concurrency cap across an env reset)', () => {
  it('is a NO-OP off Render (self-host / local — no RENDER env)', () => {
    expect(renderInfraDefaults({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('seeds CRYPTO_TICK_MAX_CONCURRENT=4 on Render when the API env was wiped (key unset)', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    expect(renderInfraDefaults(env)).toEqual({ CRYPTO_TICK_MAX_CONCURRENT: '4' });
  });

  it('does NOT override the API-set value on Render (a redeploy-durable arm wins)', () => {
    const env = { RENDER: 'true', CRYPTO_TICK_MAX_CONCURRENT: '4' } as NodeJS.ProcessEnv;
    expect(renderInfraDefaults(env)).toEqual({});
  });

  it('does NOT override a deliberate `0` disarm (a non-empty explicit value wins)', () => {
    const env = { RENDER: 'true', CRYPTO_TICK_MAX_CONCURRENT: '0' } as NodeJS.ProcessEnv;
    expect(renderInfraDefaults(env)).toEqual({});
  });

  it('re-seeds when the value is present-but-blank (whitespace ≡ unset, same as the demo seed)', () => {
    const env = { RENDER: 'true', CRYPTO_TICK_MAX_CONCURRENT: '  ' } as NodeJS.ProcessEnv;
    expect(renderInfraDefaults(env)).toEqual({ CRYPTO_TICK_MAX_CONCURRENT: '4' });
  });

  it('end-to-end: the seed lands the crypto-tick cap in the boot env for the lazy engine read', () => {
    const env = { RENDER: 'true' } as NodeJS.ProcessEnv;
    // Before the seed, K is dark on the running process (the env-reset tail).
    expect(env.CRYPTO_TICK_MAX_CONCURRENT).toBeUndefined();
    Object.assign(env, renderInfraDefaults(env)); // boot applies to process.env
    // crypto-engine resolves K lazily on first tick — AFTER this boot seed — so
    // it now reads 4 rather than the pre-seed code default 0.
    expect(env.CRYPTO_TICK_MAX_CONCURRENT).toBe('4');
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

// TRA-2222 — the self-heal maps' STRICT admission criterion (1), "board-ratified `=1`
// in render.yaml", enforced instead of asserted.
//
// ENABLE_OPTION_MAKER_SHADOW sat in RENDER_RATIFIED_DEMO_DEFAULTS with ZERO
// render.yaml record for its whole life. Nothing caught it: the docstring states the
// criterion but only prose held it, and the TRA-2209 drift route can only report
// `selfHealed[].declared:false` AFTER a deploy reaches bqb1 and someone reads the
// route. A self-heal entry with no blueprint record is an arm with no declared source
// of truth — render.yaml is the artifact you read to answer "what is this box supposed
// to be running", so anything the boot seeds must appear in it.
//
// Deliberately keyed off the MAPS, not a literal list of flag names: a hard-coded list
// self-disarms the moment someone renames or adds a flag, which is the exact failure
// mode this is meant to survive.
describe('TRA-2222 every self-healed key is declared in render.yaml', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const declared = parseRenderYamlEnvVars(readFileSync(join(repoRoot, 'render.yaml'), 'utf8'));
  const byKey = new Map(declared.declared.map((d) => [d.key, d]));

  // Guard the count that separates: if the parse collapses, EVERY key below reads
  // "undeclared" and the suite fails loudly — but if it collapsed the OTHER way this
  // whole describe would be vacuously green, so pin that the parser found values.
  it('parsed the blueprint at all (else every assertion below is vacuous)', () => {
    expect(declared.keysParsed).toBeGreaterThan(0);
    expect(declared.valuesParsed).toBeGreaterThan(0);
  });

  // The negative control. Everything below asserts membership in `byKey`; this proves
  // non-membership is reachable, i.e. that the assertions can actually fail.
  it('reports a key that is genuinely absent from render.yaml as undeclared', () => {
    expect(byKey.has('ENABLE_A_FLAG_THAT_IS_NOT_IN_THE_BLUEPRINT')).toBe(false);
  });

  for (const [mapName, map] of [
    ['RENDER_RATIFIED_DEMO_DEFAULTS', RENDER_RATIFIED_DEMO_DEFAULTS],
    ['RENDER_INFRA_DEFAULTS', RENDER_INFRA_DEFAULTS],
  ] as const) {
    for (const [key, seeded] of Object.entries(map)) {
      it(`${mapName}.${key} is declared in render.yaml, with the same value`, () => {
        const entry = byKey.get(key);
        expect(
          entry,
          `${key} is seeded into the boot env by ${mapName} but appears NOWHERE in ` +
            `render.yaml. Either declare it there (criterion 1) or drop it from the map ` +
            `and arm it with a single-key Render upsert.`,
        ).toBeDefined();
        expect(entry!.kind, `${key} must be a literal \`value:\`, not a dashboard/render ref`).toBe(
          'literal',
        );

        // Compare INTENT for boolean-shaped values ("true" and "1" both mean armed),
        // exact for the numeric tunables. A blueprint declaring `=0` under a seed of
        // `=1` is worse than no declaration: the record would contradict the runtime.
        const seededBool = classifyBool(seeded);
        if (seededBool !== null) {
          expect(classifyBool(entry!.value!), `${key} declared/seeded disagree`).toBe(seededBool);
        } else {
          expect(entry!.value, `${key} declared/seeded disagree`).toBe(seeded);
        }
      });
    }
  }
});
