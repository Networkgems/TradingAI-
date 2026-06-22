import { describe, expect, it, vi } from 'vitest';

import {
  runAnalystPremarketTick,
  runAnalystPostmarketTick,
  DEFAULT_ANALYST_TUNABLES,
} from './analyst-scheduler.js';

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

  it('default tunables map to numeric leaves of the RV base config', () => {
    expect(DEFAULT_ANALYST_TUNABLES.length).toBeGreaterThan(0);
    for (const t of DEFAULT_ANALYST_TUNABLES) {
      expect(t.path.startsWith('RV_CRYPTO_MAJORS.')).toBe(true);
      // Tighten is risk-reducing (mul < 1) per the tighten-biased invariant.
      expect(t.tighten.op).toBe('mul');
      expect(t.tighten.value).toBeLessThan(1);
    }
  });
});
