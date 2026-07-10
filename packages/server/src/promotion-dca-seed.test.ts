import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import {
  __resetPromotionStoreForTests,
  getStrategyRecord,
  registerAccumulationBacktestVerdict,
} from './promotion-store.js';
import { evaluateAccumulationBacktestGate } from '@trading-app/shared';
import { buildPublicPromotionProbe } from './promotion-service.js';
import {
  seedDcaAccumulationBacktest,
  TRA1579_DCA_BTC_ACCUMULATION_BACKTEST,
  TRA1579_DCA_REPORT_ID,
} from './promotion-dca-seed.js';

// TRA-1579 — the boot seed must put a REAL Stage-1 accumulation-backtest verdict
// on the `dca` strategy (not `missing`), the gate must re-derive its FAIL verdict
// from the seeded metrics, and the seed must never clobber a later admin
// registration.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promo-dca-seed-'));
  __resetPromotionStoreForTests(join(dir, 'promotion-gate.json'));
});

afterEach(() => {
  __resetPromotionStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('seedDcaAccumulationBacktest — TRA-1579', () => {
  it('registers the harness-computed BTC accumulation-backtest on the dca record', async () => {
    await seedDcaAccumulationBacktest();
    const rec = await getStrategyRecord('dca');
    expect(rec?.backtest?.accumulationBacktest).toEqual(TRA1579_DCA_BTC_ACCUMULATION_BACKTEST);
    expect(rec?.backtest?.reportId).toBe(TRA1579_DCA_REPORT_ID);
    // Accumulate class carries no close-based timing metrics.
    expect(rec?.backtest?.metrics).toBeNull();
  });

  it('the seeded metrics FAIL the gate\'s own re-evaluation (honest, not a hand-entered pass)', async () => {
    const verdict = evaluateAccumulationBacktestGate(TRA1579_DCA_BTC_ACCUMULATION_BACKTEST);
    expect(verdict.state).toBe('fail');
    await seedDcaAccumulationBacktest();
    // Stage 1 must now surface as `fail` (no longer `missing`) on the gate status.
    const status = await buildPublicPromotionProbe('dca');
    expect(status.strategyClass).toBe('accumulate');
    expect(status.backtest.state).toBe('fail');
    expect(status.canGoLive).toBe(false);
  });

  it('is idempotent and never clobbers a later admin registration', async () => {
    await seedDcaAccumulationBacktest();
    // A fresh admin run registers stronger (passing) metrics via the real route.
    await registerAccumulationBacktestVerdict({
      strategyId: 'dca',
      metrics: { ...TRA1579_DCA_BTC_ACCUMULATION_BACKTEST, valueInvestedMaxDrawdown: 0.2, feeAdjustedValueRatio: 1.1, oosReturn: 0.3 },
      reportId: 'admin-fresh-run',
      registeredBy: 'QuantTrader',
    });
    // Re-running the boot seed must leave the admin registration in place.
    await seedDcaAccumulationBacktest();
    const rec = await getStrategyRecord('dca');
    expect(rec?.backtest?.reportId).toBe('admin-fresh-run');
    expect(rec?.backtest?.accumulationBacktest?.feeAdjustedValueRatio).toBe(1.1);
  });
});
