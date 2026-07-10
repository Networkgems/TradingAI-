import type { AccumulationBacktestGateMetrics } from '@trading-app/shared';
import { getStrategyRecord, registerAccumulationBacktestVerdict } from './promotion-store.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'promotion-dca-seed' });

// TRA-1579 — seed the crypto-DCA (`dca`) Stage-1 accumulation-backtest verdict
// into the promotion gate at boot, so `GET /api/promotion/status` carries a REAL
// pass/fail Stage-1 verdict for the only shortlisted live strategy (parent
// TRA-1575) instead of sitting `missing`. Mirrors the TRA-801 boot seed of
// `supertrend_confluence`, but registers the accumulate-class Stage-1 leg
// (TRA-1465) rather than an empty record.
//
// Anti-gaming (TRA-527 §3): these nine numbers are NOT hand-entered — they are
// the deterministic output of `run-tra1579-dca-gate.ts`, which drives the TRA-695
// periodic-contribution accumulation simulator (EMA-200 trend-gated, tiered cost
// model on every fill, next-bar-open fills) over the held-out OOS window on the
// pinned real Coinbase 4H cache, and are regenerated + range-locked by
// `run-tra1579-dca-gate.test.ts`. The gate itself RE-DERIVES pass/fail from these
// figures via `evaluateAccumulationBacktestGate` (a `pass` is never trusted off
// the wire), so a tampered seed cannot mint a Stage-1 pass. On the current
// dataset the verdict is FAIL — the honest input to the go-live decision.
//
// Provenance:
//   symbol            BTC-USD (the TRA-1575 pilot core; SOL is context-only)
//   dataset           coinbase-exchange 4H on-disk cache (TRA-405/695 dataset)
//   OOS window        2025-01-01 → 2026-06-03 (518d; ≥ minOosDays 180)
//   primary cadence   weekly (the pilot's ~$50/weekly add)
//   report artifact   packages/backtest/reports/tra1579-dca-gate.json
export const TRA1579_DCA_BTC_ACCUMULATION_BACKTEST: AccumulationBacktestGateMetrics = {
  oosDays: 518,
  deploymentRatio: 0.6216216216216216,
  valueInvestedMaxDrawdown: 0.5107997188913338,
  lumpSumMaxDrawdown: 0.4995733410650238,
  oosReturn: -0.3018070639569681,
  lumpSumReturn: -0.2981863945541492,
  cadenceVariantsTested: 3,
  cadenceVariantsConsistent: 3,
  feeAdjustedValueRatio: 0.6981929360430319,
};

export const TRA1579_DCA_REPORT_ID = 'TRA-1579-dca-btc-oos-2025-01-01';

/**
 * Register the TRA-1579 DCA Stage-1 accumulation-backtest verdict, idempotently.
 * Skips if the `dca` strategy already has an accumulation-backtest on record — so
 * a later admin registration via `POST /api/promotion/accumulation-backtest`
 * (a fresh harness run) wins and is never clobbered by this boot seed. Registering
 * flips NO live flag: Stage-3 board sign-off still gates the live transition
 * (TRA-532), and the verdict here is FAIL regardless.
 */
export async function seedDcaAccumulationBacktest(): Promise<void> {
  const existing = await getStrategyRecord('dca');
  if (existing?.backtest?.accumulationBacktest) {
    log.info('TRA-1579 dca accumulation-backtest already registered — leaving in place', {
      reportId: existing.backtest.reportId,
    });
    return;
  }
  await registerAccumulationBacktestVerdict({
    strategyId: 'dca',
    metrics: TRA1579_DCA_BTC_ACCUMULATION_BACKTEST,
    reportId: TRA1579_DCA_REPORT_ID,
    registeredBy: 'TRA-1579-harness',
  });
  log.info('TRA-1579 seeded dca accumulation-backtest Stage-1 verdict', { reportId: TRA1579_DCA_REPORT_ID });
}
