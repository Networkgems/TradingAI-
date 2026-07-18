import { RiskManager } from '@trading-app/engine';
import { MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';

/**
 * TRA-2034 — fidelity lever L2 (CTO review TRA-2031).
 *
 * Single risk→quantity sizer shared by the live/paper account layer
 * (`paper-account.ts`, `crypto-account.ts`, `crypto-live-account.ts`) so demo
 * and live size positions from the SAME engine code the backtest runner uses
 * (`packages/backtest/src/runner.ts:176,430` → `RiskManager.sizeFromStop`).
 *
 * Before this, each account carried its own `floor(maxRisk / stopDistance)`
 * (or `round(..., 6dp)` for crypto) with NO notional cap — so the TRA-178
 * notional cap that SHAPES backtest returns (a tight ATR/BB stop otherwise
 * sizes into un-authorised leverage) never ran on the demo/live book. That was
 * the single largest remaining backtest↔live sizing divergence after cost
 * (L1, TRA-2033). This routes all three accounts through one `RiskManager`
 * call so they match the runner bar-for-bar on `(equity, risk%, stopDistance,
 * entryPrice)`.
 *
 * Parity mechanics — the runner constructs `new RiskManager(account, {
 * fractionalQuantity })` with default options, so `managedEquity =
 * totalEquity × MANAGED_ACCOUNT_RATIO`. The account layer keeps a per-user
 * `managedAccountRatio` / `riskPerTrade` (TRA-232) that can differ from the
 * global constants, so we feed the RiskManager a `totalEquity` back-scaled by
 * `MANAGED_ACCOUNT_RATIO` such that `RiskManager.managedEquity()` reproduces
 * the account's own `managedEquity()` exactly, and pass the account's
 * `riskPerTrade` as the per-call `riskPct` override. With the default settings
 * (ratio 0.5, risk 1%) this is byte-identical to the runner's construction.
 *
 * A fresh RiskManager is built per call (sizing fires once per signal open —
 * negligible cost). The drawdown brake is therefore inert here (peak == current
 * at construction), which preserves today's demo behaviour: the accounts never
 * halved size in a drawdown. Wiring a long-lived, equity-tracking RiskManager
 * so the brake compounds live is a follow-up, gated behind live posture
 * (TRA-382); it is NOT part of this fidelity pass.
 */
export interface AccountSizingInputs {
  /** The account's own managed equity slice (equity × managedAccountRatio). */
  managedEquity: number;
  /** The account's per-trade risk fraction (e.g. 0.01 for 1%). */
  riskPerTrade: number;
  /** Whole-share floor when false (stocks); 8dp truncation when true (crypto). */
  fractionalQuantity: boolean;
}

/**
 * Size a position from a protective-stop distance via the engine RiskManager,
 * reproducing the account's `managedEquity × riskPerTrade` budget and layering
 * the TRA-178 notional cap on top. Extra live-only guards (cash availability,
 * min-notional, per-symbol notional caps) layer ON TOP of this at the call
 * sites — they are not folded in here.
 */
export function sizeFromStopViaRiskManager(
  entryPrice: number,
  stopPrice: number,
  inputs: AccountSizingInputs,
): number {
  // Back-scale so RiskManager.managedEquity() === inputs.managedEquity. The
  // synthetic AccountState only needs totalEquity for sizing; the other fields
  // are unused by RiskManager.sizeFromStop.
  const totalEquity = inputs.managedEquity / MANAGED_ACCOUNT_RATIO;
  const risk = new RiskManager(
    { totalEquity, availableCash: totalEquity, openPositions: [], dailyPnl: 0 },
    { fractionalQuantity: inputs.fractionalQuantity },
  );
  return risk.sizeFromStop(entryPrice, stopPrice, { riskPct: inputs.riskPerTrade });
}
