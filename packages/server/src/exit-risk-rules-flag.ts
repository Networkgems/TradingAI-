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
