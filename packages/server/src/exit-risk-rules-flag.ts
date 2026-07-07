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
// chandelier loss-control). A STANDALONE flag, deliberately NOT gated under the
// `EXIT_RISK_RULES_ENABLED` master. The board approved arming take-profit-early
// on the DEMO book only (interaction `73ef18b0`, parent TRA-1290). bqb1 is the
// SINGLE production instance (it also owns the live Tradier creds), so flipping
// the process-wide master there would enable the loss-side rules (TRA-1267/1268)
// on the LIVE options path too — that is NOT demo-only and is a separate
// TRA-1270 decision. Decoupling lets the demo rollout arm the profit mirror with
// zero live-path change. The caller additionally scopes the attach to
// `mode === 'demo'` and reads the flag through the `<DATA_DIR>/demo-flags.json`
// override (see DEMO_FLAG_ALLOWLIST), matching the scale-out-ladder / sma200
// forward-test observe-only rollout pattern. OFF by default (1/true/yes/on).
export const TAKE_PROFIT_EARLY_FLAG = 'TAKE_PROFIT_EARLY_ENABLED';

/** True iff take-profit-early is enabled (standalone; accepts 1/true/yes/on). */
export function isTakeProfitEarlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[TAKE_PROFIT_EARLY_FLAG]);
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

// TRA-1407 (parent TRA-1406 "less noise, more quality") — a minimum |delta| floor
// on the single_leg_otm opener. The demo journal showed the OTM sleeve bleeds
// entirely in low delta (Δ<0.15 avgR −0.075, −$6.2k) while Δ≥0.45 makes avgR
// +0.55 — a floor flips the sleeve from ≈−$7.1k to +$7.9k by dropping the
// lottery-ticket tail. A STANDALONE flag (NOT under the EXIT_RISK_RULES master):
// the signal-engine consults it ONLY on the `mode === 'demo'` OTM branch, so it
// is structurally incapable of altering a live option open, matching the
// containment TAKE_PROFIT_EARLY_ENABLED / ENTRY_GREEKS_GATE use. This partially
// walks back the TRA-1207 far-OTM thesis toward near-money, so it ships OFF by
// default and the board flips it via demo-flags.json after QuantTrader's
// forward-validation. OFF by default (1/true/yes/on).
export const OTM_DELTA_FLOOR_FLAG = 'OTM_DELTA_FLOOR_ENABLED';
/** Numeric override of the floor (default 0.40, the QuantTrader recommendation). */
export const OTM_DELTA_FLOOR_VALUE = 'OTM_DELTA_FLOOR';
export const OTM_DELTA_FLOOR_DEFAULT = 0.4;

/** True iff the OTM delta floor is enabled (standalone; accepts 1/true/yes/on). */
export function isOtmDeltaFloorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_DELTA_FLOOR_FLAG]);
}

/**
 * Resolve the effective |delta| floor. Reads the optional numeric `OTM_DELTA_FLOOR`
 * override, falling back to {@link OTM_DELTA_FLOOR_DEFAULT}. A malformed or
 * out-of-range value (≤0 or ≥1 — a delta is a probability-like [0,1] magnitude)
 * falls back to the default rather than silently disabling the gate.
 */
export function resolveOtmDeltaFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OTM_DELTA_FLOOR_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
  }
  return OTM_DELTA_FLOOR_DEFAULT;
}

// TRA-1409 (parent TRA-1406 "less noise, more quality") — the RV single_leg exit
// re-tune: require a CONFIRMED N-bar Supertrend flip before the structural
// `supertrend_flip` exit fires (QuantTrader variant (a), N=2 — decision
// TRA-1415). The 07-06 demo journal showed the single-bar supertrend_flip is the
// scratch driver (202 exits, 97% scratch, +$318) vs the ma20_close_through winner
// exit (80 exits, +$2,453); requiring 2 consecutive flipped bars drops whipsaws
// so winners survive to the MA20 cross. A STANDALONE flag (NOT under the
// EXIT_RISK_RULES master): the signal-engine consults it ONLY on the
// `mode === 'demo'` RV branch, so it is structurally incapable of altering a live
// option exit — matching the OTM_DELTA_FLOOR / TAKE_PROFIT_EARLY containment. It
// only ever makes the STRUCTURAL flip fire LESS, never suppresses/loosens/delays
// a risk-side exit (chandelier / give-back / hard SL run in their own block and
// keep precedence). OFF by default; the board flips it via demo-flags.json after
// QuantTrader's forward-validation (no PM2/admin). Accepts 1/true/yes/on.
export const RV_EXIT_RETUNE_FLAG = 'RV_EXIT_RETUNE_ENABLED';
/** Numeric override of the confirm-bars count (default 2, the QuantTrader pick). */
export const RV_EXIT_RETUNE_CONFIRM_BARS_VALUE = 'RV_EXIT_RETUNE_CONFIRM_BARS';
export const RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT = 2;

/** True iff the RV exit re-tune is enabled (standalone; accepts 1/true/yes/on). */
export function isRvExitRetuneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[RV_EXIT_RETUNE_FLAG]);
}

/**
 * Resolve the effective RV Supertrend-flip confirm-bars count. Reads the optional
 * integer `RV_EXIT_RETUNE_CONFIRM_BARS` override (clamped to a sane [1,10]),
 * falling back to {@link RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT}. A malformed or
 * out-of-range value falls back to the default rather than silently disabling the
 * confirmation.
 */
export function resolveRvExitConfirmBars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RV_EXIT_RETUNE_CONFIRM_BARS_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) return parsed;
  }
  return RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT;
}
