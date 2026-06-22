import { describe, expect, it, vi } from 'vitest';

import {
  runAnalystPremarketTick,
  runAnalystPostmarketTick,
  DEFAULT_ANALYST_TUNABLES,
  PRODUCTION_OPTION_STRUCTURES,
} from './analyst-scheduler.js';
import { RV_CRYPTO_MAJORS_BASE_CONFIG } from './backtest-executor.js';

function numberAtPath(cfg: Record<string, unknown>, path: string): number | null {
  let node: unknown = cfg;
  for (const seg of path.split('.')) {
    if (node == null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === 'number' && Number.isFinite(node) ? node : null;
}

describe('analyst-scheduler flag gate', () => {
  it('pre-market tick no-ops with the flag OFF and builds NO deps (zero cost)', async () => {
    const buildPremarketDeps = vi.fn();
    const outcome = await runAnalystPremarketTick(1, {}, { buildPremarketDeps });
    expect(outcome).toEqual({ ran: false, reason: 'disabled' });
    expect(buildPremarketDeps).not.toHaveBeenCalled();
  });

  it('post-market tick no-ops with the flag OFF and builds NO deps (zero cost)', async () => {
    const buildPostmarketDeps = vi.fn();
    const outcome = await runAnalystPostmarketTick(1, {}, { buildPostmarketDeps });
    expect(outcome).toEqual({ ran: false, reason: 'disabled' });
    expect(buildPostmarketDeps).not.toHaveBeenCalled();
  });

  it('with the flag ON but no deps available, runs nothing and reports no-deps', async () => {
    const env = { ENABLE_ANALYST_AGENT: '1' };
    const pre = await runAnalystPremarketTick(1, env, { buildPremarketDeps: async () => null });
    const post = await runAnalystPostmarketTick(1, env, { buildPostmarketDeps: async () => null });
    expect(pre).toEqual({ ran: false, reason: 'no-deps' });
    expect(post).toEqual({ ran: false, reason: 'no-deps' });
  });

  // TRA-1006 — vocabulary-drift guard (requested at QuantTrader sign-off). Catches
  // a tunable keyed to a setup-type that production never emits (which would
  // silently degrade that setup to the R3 no-op), and a path that doesn't resolve
  // in the base config (which the pipeline would reject at apply time).
  it('every default tunable key is a real production structure and resolves to a finite config leaf', () => {
    expect(DEFAULT_ANALYST_TUNABLES.length).toBeGreaterThan(0);
    const vocab = new Set<string>(PRODUCTION_OPTION_STRUCTURES);
    for (const t of DEFAULT_ANALYST_TUNABLES) {
      expect(vocab.has(t.key), `tunable key "${t.key}" not in production structure vocabulary`).toBe(true);
      expect(
        numberAtPath(RV_CRYPTO_MAJORS_BASE_CONFIG as Record<string, unknown>, t.path),
        `tunable path "${t.path}" does not resolve to a finite number`,
      ).not.toBeNull();
    }
  });

  it('covers every production option structure (no setup silently falls through to R3)', () => {
    const keyed = new Set(DEFAULT_ANALYST_TUNABLES.map((t) => t.key));
    for (const structure of PRODUCTION_OPTION_STRUCTURES) {
      expect(keyed.has(structure), `production structure "${structure}" has no tunable`).toBe(true);
    }
  });
});
