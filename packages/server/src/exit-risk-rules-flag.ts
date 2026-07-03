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
