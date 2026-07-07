// TRA-1436 (parent TRA-1434) — make the TRA-532 live-transition promotion gate
// ENVIRONMENT-AWARE so that Live + Tradier Environment = Sandbox (paper) is
// reachable without full strategy promotion.
//
// Problem: the gate fires on `liveCryptoOn` (mode==='live' && crypto auto-trading
// ON) and then demands every preset strategy be fully promoted (backtest + paper
// + sign-off). It is NOT environment-aware — it cannot tell Tradier Sandbox
// (simulated fills against real chains, ZERO real capital) from Production (real
// money). That makes the paper-validation path circular: Sandbox IS the Stage-2
// paper environment that generates the "monitored paper trades" the gate demands,
// yet the gate won't let a user reach Sandbox until those trades already exist.
//
// When ARMED, the gate keys off REAL-CAPITAL intent instead of merely `mode`:
//   • Crypto — Coinbase live has no sandbox, so live crypto auto-trading is
//     always real capital and stays gated exactly as before (TRA-1436 #2).
//   • Options — real capital ⇔ Tradier Environment = Production. Sandbox (paper)
//     risks zero real capital and is EXEMPT (TRA-1436 #1). Production stays
//     fail-closed (TRA-1436 #3).
//
// DEFAULT OFF ⇒ the legacy crypto-only trigger is preserved verbatim, so no
// existing behaviour or test changes until the board arms it (render.yaml env on
// bqb1). This is a LIVE-SAFETY boundary change — arming is board/CTO-gated. The
// change only ever LOOSENS the gate for zero-capital Sandbox, never for
// Production. Accepts 1/true/yes/on.

export const PROMOTION_GATE_ENV_AWARE_FLAG = 'PROMOTION_GATE_ENV_AWARE';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the environment-aware promotion gate is armed (1/true/yes/on).
 * Default OFF ⇒ the gate keeps its legacy crypto-only trigger (`liveCryptoOn`),
 * so Production stays fail-closed and no current behaviour changes.
 */
export function isPromotionGateEnvAwareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[PROMOTION_GATE_ENV_AWARE_FLAG]);
}
