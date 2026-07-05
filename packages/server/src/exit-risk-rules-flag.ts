// TRA-1267 (TRA-1250) — master switch for the board-approved exit-side
// loss-control rules (TRA-1249 analysis, request_confirmation `d7175f7e`).
//
// Phase-1 is EXIT/entry-gate side only: the ATR chandelier trail + per-trade
// profit-lock (TRA-1268) and the book-level daily give-back cap / session stop
// (Rule 3, THIS issue). The pure decision logic lives in `@trading-app/engine`
// (`exit-rules.ts`); the wiring reads this ONE flag so the whole package can
// ship DARK and be tuned/reverted atomically. OFF by default — nothing changes
// live behaviour until the board flips `EXIT_RISK_RULES_ENABLED` at the
// TRA-1270 enable+deploy+verify gate (QuantTrader threshold-parity review).

export const EXIT_RISK_RULES_FLAG = 'EXIT_RISK_RULES_ENABLED';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the exit-side loss-control rules are enabled (accepts 1/true/yes/on).
 * Gates the book-level give-back cap (Rule 3) markBook/flatten wiring and its
 * entry-gate halt in both the equity and options entry chokepoints.
 */
export function isExitRiskRulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[EXIT_RISK_RULES_FLAG]);
}

// TRA-1269 (TRA-1250 Rule 1, live-equity path) — a SEPARATE sub-flag for the
// one path with real broker-execution risk: trailing a live Tradier equity stop
// by modifying its resting OCO stop leg. It is deliberately gated by BOTH the
// master switch AND its own flag so the board can enable the demo/options
// chandelier + book give-back cap (TRA-1267/1268) in production while the live
// stop-modify stays dark — and can flip only this one on for the small
// board-placed verification position without touching everything else. OFF
// unless `EXIT_RISK_RULES_ENABLED` AND `LIVE_EQUITY_STOP_MODIFY_ENABLED` are
// both truthy (1/true/yes/on).
export const LIVE_EQUITY_STOP_MODIFY_FLAG = 'LIVE_EQUITY_STOP_MODIFY_ENABLED';

/**
 * True iff the live-equity chandelier stop-modify path is enabled. Requires the
 * master exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isLiveEquityStopModifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[LIVE_EQUITY_STOP_MODIFY_FLAG]);
}

// TRA-1294 — take-profit-early (the PROFIT-side mirror of the give-back cap /
// chandelier loss-control). A SEPARATE sub-flag so the board can run the shipped
// exit-side loss rules (TRA-1267/1268) without auto-banking wins, and can enable
// early profit-taking independently once it's validated. Deliberately gated by
// BOTH the master switch AND its own flag: it auto-CLOSES positions, so it stays
// dark unless `EXIT_RISK_RULES_ENABLED` AND `TAKE_PROFIT_EARLY_ENABLED` are both
// truthy (1/true/yes/on).
export const TAKE_PROFIT_EARLY_FLAG = 'TAKE_PROFIT_EARLY_ENABLED';

/**
 * True iff take-profit-early is enabled. Requires the master exit-risk switch on
 * as well — the sub-flag alone does nothing.
 */
export function isTakeProfitEarlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[TAKE_PROFIT_EARLY_FLAG]);
}

// TRA-1295 — the "7%" leg of the 3-5-7 governor: the correlated-exposure cap. A
// SEPARATE sub-flag so the board can run the shipped loss-control rules
// (TRA-1267/1268) and independently arm the correlated-exposure admission gate
// once it's validated. Deliberately gated by BOTH the master switch AND its own
// flag: it can REJECT / scale down new entries, so it stays dark unless
// `EXIT_RISK_RULES_ENABLED` AND `CORRELATED_EXPOSURE_CAP_ENABLED` are both truthy
// (1/true/yes/on).
export const CORRELATED_EXPOSURE_CAP_FLAG = 'CORRELATED_EXPOSURE_CAP_ENABLED';

/**
 * True iff the correlated-exposure cap (Rule 5) is enabled. Requires the master
 * exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isCorrelatedExposureCapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[CORRELATED_EXPOSURE_CAP_FLAG]);
}

// TRA-1293 — PoP / delta entry gate + Delta/Theta ratio floor. A SEPARATE
// sub-flag so the board can run the shipped loss-control / take-profit rules and
// independently arm the Greeks entry gate once its thresholds are tuned.
// Deliberately gated by BOTH the master switch AND its own flag: it is a HARD
// entry filter that can REJECT new option opens, so it stays dark unless
// `EXIT_RISK_RULES_ENABLED` AND `ENTRY_GREEKS_GATE_ENABLED` are both truthy
// (1/true/yes/on).
export const ENTRY_GREEKS_GATE_FLAG = 'ENTRY_GREEKS_GATE_ENABLED';

/**
 * True iff the PoP / delta entry gate (TRA-1293) is enabled. Requires the master
 * exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isEntryGreeksGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[ENTRY_GREEKS_GATE_FLAG]);
}
