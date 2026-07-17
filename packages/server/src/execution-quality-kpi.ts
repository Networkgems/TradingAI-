// TRA-1981 (parent TRA-1967 item 2) — server-side builder for the realized-vs-
// modeled slippage KPI. Folds the THREE existing per-fill cost signals into the
// pure `computeExecutionQualityKpi` core (packages/shared/src/execution-quality.ts):
//
//   • OPTIONS  — the durable fee/slippage ledger (live-options-fee-slippage-ledger.ts).
//                Reuses the ledger's realized fill-vs-mid figure (TRA-1967 item 2 says
//                "reuse the option ledger's realized figure") and pairs it against the
//                modeled half-spread the cost model expects an aggressive fill to pay.
//   • EQUITY   — positions carrying the TRA-536 entry-slippage stamp (realizedSlippage
//   • CRYPTO     = |fill − intended| × qty; modeledSlippage = per-fill bps budget),
//                stamped together at open by paper-account.ts / crypto-account.ts.
//
// PURE AGGREGATION of already-persisted data — no new writes into any hot fill path,
// so there is zero behavior change. Unmeasured legs stay `null`, never `0` (TRA-1707):
// the pure core drops them from every mean/ratio rather than reading a false zero.

import type { Position } from '@trading-app/shared';
import {
  computeExecutionQualityKpi,
  type ExecutionAssetClass,
  type ExecutionSlippageFill,
  type ExecutionQualityKpi,
} from '@trading-app/shared';
import {
  summarizeLiveOptionsFeeSlippage,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';

/**
 * Standard US listed-option contract multiplier. The fee/slippage ledger stores
 * per-contract prices; scaling by contracts × 100 converts the per-contract slippage
 * to the account-USD figure the equity/crypto legs are already denominated in, so the
 * blended overall roll-up is apples-to-apples.
 */
const OPTION_CONTRACT_MULTIPLIER = 100;

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * One realized-vs-modeled fill per recorded live option fill.
 *
 * REALIZED (reuses the ledger's figure) = the fill's drift from the midpoint, signed
 * into the direction of cost by side: a `buy_to_open` that fills above mid PAID UP
 * (+cost); a `sell_to_close` that fills below mid GAVE UP edge (+cost). This is the
 * ledger's `slippageVsMid` with the sign resolved against `side`.
 *
 * MODELED = the half-spread the cost model expects an aggressive fill to cross,
 * `|ask − mid|`. Filling exactly at the touch ⇒ decay ≈ 1×; price improvement ⇒ < 1×;
 * paying through the ask ⇒ > 1×.
 *
 * Any leg whose inputs are missing (a one-sided quote with no ask, a market exit with
 * no mid, a broker that omitted the fill) stays `null` (TRA-1707) — that fill drops
 * out of the ratio rather than reading as a measured zero.
 */
export function optionExecutionFills(
  records: readonly LiveOptionFillRecord[],
): ExecutionSlippageFill[] {
  return records.map((rec) => {
    const filled = finiteOrNull(rec.filledPrice);
    const mid = finiteOrNull(rec.midAtSubmit);
    const ask = finiteOrNull(rec.askAtSubmit);
    const scale = rec.contracts * OPTION_CONTRACT_MULTIPLIER;

    let realizedUsd: number | null = null;
    if (filled !== null && mid !== null) {
      const vsMid = filled - mid; // ledger's slippageVsMid (per contract)
      const signedIntoCost = rec.side === 'buy_to_open' ? vsMid : -vsMid;
      realizedUsd = signedIntoCost * scale;
    }
    const modeledUsd = ask !== null && mid !== null ? Math.abs(ask - mid) * scale : null;

    return {
      assetClass: 'options',
      symbol: rec.optionSymbol,
      ts: rec.ts,
      realizedUsd,
      modeledUsd,
    };
  });
}

/**
 * One realized-vs-modeled fill per position carrying the TRA-536 entry-slippage
 * stamp. `realizedSlippage` and `modeledSlippage` are stamped together at open on the
 * equity + crypto paper fill paths, so a position either has both or neither; one that
 * has neither (e.g. a live-mirror open that never stamped, or a pre-TRA-536 snapshot)
 * contributes a fully-unmeasured sample — it still counts in `fills` (the fill
 * happened) but adds nothing to the decay ratio (TRA-1707).
 */
export function positionExecutionFills(
  positions: readonly Position[],
  assetClass: Extract<ExecutionAssetClass, 'equity' | 'crypto'>,
): ExecutionSlippageFill[] {
  return positions.map((p) => ({
    assetClass,
    symbol: p.symbol,
    ts: p.openedAt,
    realizedUsd: finiteOrNull(p.realizedSlippage),
    modeledUsd: finiteOrNull(p.modeledSlippage),
  }));
}

/** Sources folded into the KPI. Any omitted source contributes no fills. */
export interface ExecutionQualityKpiSources {
  /** Equity positions carrying the TRA-536 stamp (typically live/session open + day-closed). */
  equityPositions?: readonly Position[];
  /** Crypto positions carrying the TRA-536 stamp. */
  cryptoPositions?: readonly Position[];
  /**
   * Live option fill records. Defaults to the durable fee/slippage ledger's current
   * records; pass an explicit set for tests or a windowed read.
   */
  optionRecords?: readonly LiveOptionFillRecord[];
}

/**
 * Build the per-asset-class realized-vs-modeled KPI. Options come from the DURABLE
 * fee/slippage ledger (firm-wide, survives restart); equity/crypto come from the
 * caller's live/session positions carrying the TRA-536 stamp (session-scoped — the
 * honest limit of a v1 that does not add a new per-fill write into the hot paths).
 * Pure fold; safe to call on every read.
 */
export function buildExecutionQualityKpi(sources: ExecutionQualityKpiSources = {}): ExecutionQualityKpi {
  const optionRecords = sources.optionRecords ?? summarizeLiveOptionsFeeSlippage().records;
  const fills: ExecutionSlippageFill[] = [
    ...positionExecutionFills(sources.equityPositions ?? [], 'equity'),
    ...positionExecutionFills(sources.cryptoPositions ?? [], 'crypto'),
    ...optionExecutionFills(optionRecords),
  ];
  return computeExecutionQualityKpi(fills);
}
