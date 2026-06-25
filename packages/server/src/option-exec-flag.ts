// TRA-1023 (TRA-1022 audit) — options EXECUTION feature flag.
//
// This is a SEPARATE flag from `ENABLE_OPTION_SHADOW_SELECTOR` (the research
// ledger in `option-shadow-ledger.ts`). The shadow flag governs the observe-only
// Phase-A ledger; THIS flag governs whether the disciplined selection-quality /
// breaker logic is allowed to influence the EXECUTING options path:
//
//   • enforce the options-sleeve risk breaker on the option-open gate
//     (work-item 5 — recording is always on; enforcement is gated here), and
//   • (follow-ups TRA-1024 / TRA-1025) gate the executing RV long path on
//     IVR ≤ 25 + a TRA-734 technical trigger, route mid/high-IVR cheap legs to a
//     defined-risk spread, and swap the flat stop/target for structure-aware exits.
//
// OFF by default. Per the TRA-1023 acceptance criteria nothing here may change
// executing behaviour until QuantTrader signs off on the shadow-vs-live
// comparison, and live promotion stays gated on TRA-382 regardless of this flag.
// Conflating it with the shadow flag would either turn execution on whenever the
// research ledger is accruing or silence the ledger whenever execution is gated —
// both wrong, hence the distinct env var.

export const OPTION_EXEC_FLAG = 'ENABLE_OPTION_EXEC_SELECTOR';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the options execution-quality flag is enabled (accepts 1/true/yes/on). */
export function isOptionExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_EXEC_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1114 — demo-only deterministic directional call/put entry.
//
// Board escalation (3rd time: TRA-1021 → TRA-1113). The board keeps reporting
// that calls/puts never fire in the DEMO paper book, yet prior tickets were
// closed on "config is live". Root cause (verified TRA-1114): the only enabled
// idea source on the EXECUTING single-leg path is the legacy RV anomaly scanner,
// which surfaces nothing on calm days (long-known, TRA-592); and the
// deterministic shadow / Phase-B spread selector stands DOWN whenever the
// trailing-year IV-rank store is thin (`ivRank === null` → stand_down), which it
// is on a fresh demo. Phase-B paper execution is on but has nothing to execute.
//
// This flag turns on a DEMO-ONLY path that builds a near-ATM, trend-aligned
// single-leg long call (uptrend) / put (downtrend) directly from the live
// selector chain and opens it in the paper book via
// `PaperOptionsAccount.openOptionFromRvCandidate(…, 'demo')`. It is:
//   • demo/paper only  — the caller hard-gates on `mode === 'demo'`; the open is
//     `mode:'demo'` with no equity override → no Tradier mirror, no live capital;
//   • OFF by default   — prod and live paths are byte-for-byte unchanged unset;
//   • an idea source   — it only produces entries; the account's existing
//     trading-window / dedup / daily-cap / sizing gates still bound it.
// Its sole purpose is to give the board the OBSERVABLE evidence the prior
// config-only closes never produced. Live-capital promotion stays gated on
// TRA-382 regardless; this path can never touch the live book.
// --------------------------------------------------------------------------

export const OPTION_DEMO_DIRECTIONAL_FLAG = 'ENABLE_OPTION_DEMO_DIRECTIONAL';

/** True iff the demo-only deterministic directional-entry flag is on. */
export function isOptionDemoDirectionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_DEMO_DIRECTIONAL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1156 (TRA-1155 follow-up) — IV-vs-realised-vol mispricing scanner wiring.
//
// TRA-1155 landed the PURE engine (`findIvRvMispricings` +
// `realizedVolFromDailyCloses`) — the volatility-risk-premium read the existing
// own-IV / skew scanners miss — but nothing calls it. This flag turns on an
// OBSERVE-ONLY demo pass that, per tick, pulls the SAME warm selector chain the
// directional/shadow passes already fetched, computes realised vol from the
// underlying's already-loaded daily closes, runs the engine, and records the
// candidates to an in-memory store surfaced read-only at
// `GET /api/health/iv-rv`.
//
// OFF by default ⇒ zero cost/IO (the engine pass early-returns and the store
// stays empty). When ON it NEVER routes into the paper book — no order is ever
// placed off these candidates this iteration; routing waits on QuantTrader's
// threshold sign-off (parent TRA-1155). Demo-first: the engine pass hard-gates
// on `mode === 'demo'`, so prod/live paths are byte-for-byte unchanged.
// --------------------------------------------------------------------------

export const OPTION_IV_RV_SCANNER_FLAG = 'ENABLE_OPTION_IV_RV_SCANNER';

/** True iff the observe-only IV-vs-RV mispricing scanner flag is on. */
export function isOptionIvRvScannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_IV_RV_SCANNER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1028 — net-new options swing-entry enhancements (TRA-1026 follow-up).
//
// Each lands AFTER TRA-1024/1025 (IV-aware + structure-exit-aware exec path) and
// is OFF by default with its OWN sub-flag, layered ON TOP OF the exec flag: a
// sub-flag only takes effect when `isOptionExecEnabled()` is also true, so the
// default prod path and the baseline exec path are both unchanged until
// QuantTrader signs off on the shadow/paper before-after readout. Live-capital
// promotion stays gated on TRA-382 regardless.
// --------------------------------------------------------------------------

/**
 * Item 1 — EMA-pullback (Trend-Pullback) entry archetype. When on, the bare RV
 * long additionally requires an `emaPullbackTrigger` confirmation on the trend
 * side before opening (uptrend above the 21 EMA + pullback to the 9 EMA +
 * bullish reversal candle, mirror inverse for puts).
 */
export const OPTION_EMA_PULLBACK_FLAG = 'ENABLE_OPTION_EMA_PULLBACK';

/** True iff the exec flag AND the EMA-pullback sub-flag are both on. */
export function isOptionEmaPullbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionExecEnabled(env) && flagOn(env[OPTION_EMA_PULLBACK_FLAG]);
}

/**
 * Item 2 — volume-confirmed breakout. When on, the high-IVR spread-routing
 * breakout signal requires `volumeConfirmedBreakout` (close beyond the Donchian
 * channel on above-average volume) instead of the bare volume-blind Donchian
 * close, tightening what counts as a high-conviction breakout on the exec path.
 */
export const OPTION_VOLUME_BREAKOUT_FLAG = 'ENABLE_OPTION_VOLUME_BREAKOUT';

/** True iff the exec flag AND the volume-breakout sub-flag are both on. */
export function isOptionVolumeBreakoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionExecEnabled(env) && flagOn(env[OPTION_VOLUME_BREAKOUT_FLAG]);
}

/**
 * Item 3 — DTE-window tunable for new directional RV long entries. The playbook
 * recommends 45–90 DTE for pullback swings (vs the current executing 30–45);
 * this exposes the window as env overrides so QuantTrader can widen it and read
 * the theta/leverage trade-off in the ledger WITHOUT a hard code change. Both
 * default to `undefined` (i.e. the engine's 30/45 `RV_LONG_DTE_ENTRY_*`), so
 * absent overrides preserve current behaviour exactly. A non-finite, non-positive
 * value, or an inverted min>max pair, is ignored (falls back to the default) so
 * a fat-finger env can't silently stand the scanner down.
 */
export const OPTION_RV_LONG_DTE_MIN_VAR = 'OPTION_RV_LONG_DTE_ENTRY_MIN';
export const OPTION_RV_LONG_DTE_MAX_VAR = 'OPTION_RV_LONG_DTE_ENTRY_MAX';

export interface RvLongDteOverride {
  /** Lower DTE bound override, or undefined to use the engine default (30). */
  min: number | undefined;
  /** Upper DTE bound override, or undefined to use the engine default (45). */
  max: number | undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the optional RV-long DTE entry-window overrides. Returns `undefined`
 * bounds when unset/invalid so the caller passes nothing to the engine selector
 * and the 30/45 defaults stand. An inverted pair (min > max) is rejected as a
 * unit — both fall back — so the window never inverts.
 */
export function resolveRvLongDteOverride(env: NodeJS.ProcessEnv = process.env): RvLongDteOverride {
  let min = parsePositiveInt(env[OPTION_RV_LONG_DTE_MIN_VAR]);
  let max = parsePositiveInt(env[OPTION_RV_LONG_DTE_MAX_VAR]);
  if (min !== undefined && max !== undefined && min > max) {
    min = undefined;
    max = undefined;
  }
  return { min, max };
}

// --------------------------------------------------------------------------
// TRA-1057 (TRA-1047 sign-off) — RV scanner today-volume liquidity floor.
//
// The T2/T3 sweep on the recorded Tradier chains (TRA-1049 data) found a
// minDailyVolume floor of 25 flips the 25-day book P&L −163 → +99 and halves
// maxDD 1.77% → 0.95%. This exposes the floor as an env override so QuantTrader
// can enable it on the executing RV long path (behind `isOptionExecEnabled()`)
// after a longer forward window WITHOUT a code change. DEFAULT 0 = OFF, so the
// scanner rejects nothing on volume and prod behaviour is unchanged until set.
// A non-finite / non-positive value falls back to 0 (off). Live-capital
// promotion stays gated on TRA-382 regardless.
// --------------------------------------------------------------------------

export const OPTION_RV_MIN_DAILY_VOLUME_VAR = 'OPTION_RV_MIN_DAILY_VOLUME';

/**
 * Resolve the RV scanner's today-volume floor for the executing long path.
 * Returns 0 (off) when unset/invalid so the scanner's volume gate is a no-op
 * and prod behaviour is unchanged; returns the positive floor (e.g. 25) when
 * QuantTrader sets the env var. The caller only wires this in when
 * `isOptionExecEnabled()` is true.
 */
export function resolveRvMinDailyVolume(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env[OPTION_RV_MIN_DAILY_VOLUME_VAR]) ?? 0;
}

// --------------------------------------------------------------------------
// TRA-1140 (TRA-1139 board-approved unification) — route an accepted AI Idea
// onto the SHARED proposal/execution rail (proposal-store + approve/reject +
// caps + kill-switch) as a typed `options` proposal, instead of the bespoke
// `POST …/paper-enter` direct open path.
//
// OFF by default. When OFF, `POST /api/options/ideas/:id/paper-enter` opens the
// idea directly on the paper book exactly as before (byte-for-byte unchanged).
// When ON, the same click instead queues a `kind:'options'` TradeProposal and
// confirms it through the engine's shared execution gate, so both the Proposals
// and AI-Ideas engines share ONE review/execution rail. Paper-only by
// construction on BOTH branches (the open path is `mode:'demo'`); live-capital
// wiring stays gated on TRA-382 regardless of this flag.
//
// NOTE: routing through the shared gate means the SAME kill-switches that gate
// equity proposals now gate an AI-idea entry on this path — the env kill
// (TRADING_AGENTS_LLM_DISABLED), the per-user Trading-Agents banner toggle, the
// risk circuit-breaker halt, the demo auto-trade toggle, and the demo daily
// caps. A blocked confirm leaves the proposal pending and returns the gate's
// verbatim reason (orders are never silently dropped).
// --------------------------------------------------------------------------

export const OPTIONS_PROPOSAL_RAIL_FLAG = 'ENABLE_OPTIONS_PROPOSAL_RAIL';

/** True iff the AI-Ideas → shared-proposal-rail flag is enabled (1/true/yes/on). */
export function isOptionsProposalRailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTIONS_PROPOSAL_RAIL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1142 (TRA-1139 board-approved direction; rides TRA-1140's rail) — demo
// AUTO-CONFIRM for accepted AI-Ideas options.
//
// TRA-1140 gave AI Ideas a MANUAL shared-rail entry (the click IS the approval).
// This flag adds the SAME demo auto-confirm path Proposals already have: when ON
// and the shared rail is ON, each surfaced+enterable idea is run through
// `shouldAutoConfirm` with options-appropriate gates (demo/paper only,
// defined-risk only, POP floor, single-lot max-loss cap, kill-switch clear,
// demo auto-trade ON) and — only if it passes — entered through the shared
// proposal queue WITHOUT a click, so the paper book starts accruing real
// auto-trade evidence for the scorecard (TRA-1141).
//
// Layered ON TOP OF the rail flag: it only takes effect when
// `isOptionsProposalRailEnabled()` is also true, so auto-confirm can never
// diverge from the manual rail path. OFF by default ⇒ no idea is ever entered
// without a click unless an operator sets BOTH env vars. Paper-only by
// construction (the entry path is `mode:'demo'`); live options auto-confirm is a
// hard NO inside `shouldAutoConfirm` regardless. Forward-test sign-off / enable
// decision is QuantTrader's, gated on accrued evidence.
// --------------------------------------------------------------------------

export const OPTION_DEMO_AUTO_CONFIRM_FLAG = 'ENABLE_OPTION_DEMO_AUTO_CONFIRM';

/** True iff the shared rail AND the demo options auto-confirm sub-flag are both on. */
export function isOptionDemoAutoConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionsProposalRailEnabled(env) && flagOn(env[OPTION_DEMO_AUTO_CONFIRM_FLAG]);
}
