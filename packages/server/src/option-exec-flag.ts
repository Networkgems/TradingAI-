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
// TRA-1292 — defined-risk SHORT-PREMIUM scanner (credit spreads / iron condors).
//
// The desk is structurally LONG premium (every executing option path buys a
// contract → theta-negative). This flag turns on an OBSERVE-ONLY demo pass that,
// per tick, pulls the SAME warm selector chain the directional/IV-RV passes
// already fetched, computes realised vol from the underlying's daily closes,
// stamps the trailing-year IV-rank (TRA-1153), and runs the short-premium engine
// (`findShortPremiumStructures`) — assembling put/call credit spreads and iron
// condors gated on ivRank >= 50 + VRP-positive (IV/RV >= 1) + short-strike delta
// ~0.15–0.30. Results are recorded to an in-memory store surfaced read-only at
// `GET /api/health/short-premium`.
//
// OFF by default ⇒ zero cost/IO (the pass early-returns, store stays empty).
// When ON it NEVER routes into the paper book — no order is ever placed off these
// structures this iteration; demo routing / graduation is a SEPARATE board
// decision. Demo-first: the pass hard-gates on `mode === 'demo'`, so prod/live
// paths are byte-for-byte unchanged. Live promotion stays gated on TRA-382.
// --------------------------------------------------------------------------

export const OPTION_SHORT_PREMIUM_SCANNER_FLAG = 'ENABLE_OPTION_SHORT_PREMIUM_SCANNER';

/** True iff the observe-only defined-risk short-premium scanner flag is on. */
export function isOptionShortPremiumScannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_SHORT_PREMIUM_SCANNER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1977 (parent TRA-1976, rides TRA-1292's scanner) — route the short-premium
// scanner into the WHEEL paper primitive under a SHADOW/paper sub-flag.
//
// TRA-1966/1976 landed the write/settle primitives end-to-end
// (`openCashSecuredPut` → assignment → `openCoveredCall` → called-away /
// liquidation, with the TRA-1322 guards). This sub-flag turns on a DEMO-ONLY
// pass that feeds the SAME observe-only short-premium candidates (already gated
// on ivRank >= 50 + VRP-positive + short-strike |Δ| 0.15–0.30) into those
// primitives on the `WHEEL_QUALITY_UNIVERSE` names, and drives the put→stock→call
// cycle in the tick (hold-to-expiry settlement, assignment → covered call, the
// stock-stop / max-window liquidation guards).
//
// Layered ON TOP OF the scanner flag (mirrors the TRA-1203 IV-RV routing sub-flag
// pattern): it only takes effect when `isOptionShortPremiumScannerEnabled()` is
// ALSO true, so the observe-only ledger and the paper-routing path can never
// diverge, and turning the scanner off kills routing too. OFF by default ⇒ the
// short-premium pass stays exactly observe-only and prod/live paths are
// byte-for-byte unchanged. Paper-only by construction: every write opens
// `mode:'demo'` with no Tradier mirror — live `sell_to_open`/`buy_to_close`
// routing stays gate-sequenced behind TRA-1965 + real-chain gates TRA-1143, no
// live capital until cleared.
// --------------------------------------------------------------------------

export const OPTION_WHEEL_ROUTING_FLAG = 'ENABLE_OPTION_WHEEL_ROUTING';

/** True iff the short-premium scanner flag AND the wheel demo-routing sub-flag are both on. */
export function isOptionWheelRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionShortPremiumScannerEnabled(env) && flagOn(env[OPTION_WHEEL_ROUTING_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-2028 (parent TRA-1966, spec TRA-2026) — IV-PERCENTILE entry filter on the
// wheel loop, OBSERVE-ONLY behind an OFF flag.
//
// Premium selling is only positive-EV when the premium pays for the risk —
// selling when implied vol is CHEAP is systematically negative-EV. This gates
// CSP/CC `sell_to_open` on the underlying's IV PERCENTILE (fraction of the
// trailing window below today's IV): block < 30, prefer ≥ 50, size down in the
// 30–50 `marginal` band, and require the TRA-1968 catalyst check above 90 (rich
// IV is usually a ticking event, not a mispricing). Thresholds are wired as
// config (`WHEEL_IV_FILTER_*` env), not magic numbers.
//
// SHADOW-FIRST like {@link isPopCalibrationEnabled}: the filter's decision is
// EVALUATED and ledgered on every wheel idea (entered AND skipped) for the
// entered-vs-skipped-by-decile calibration the gate needs, but it does NOT
// suppress or resize any write until an operator sets the flag. OFF by default ⇒
// the wheel routing path is byte-for-byte the pre-TRA-2028 behaviour; the ledger
// still accrues so the forward book can prove the entered set beats the
// unfiltered set before the filter earns enforcement. Live promotion stays gated
// on TRA-382 regardless.
// --------------------------------------------------------------------------

export const WHEEL_IV_FILTER_FLAG = 'ENABLE_WHEEL_IV_ENTRY_FILTER';

/**
 * True iff the wheel IV-percentile entry filter is allowed to SUPPRESS/RESIZE
 * writes (accepts 1/true/yes/on). Default OFF ⇒ observe-only: the decision is
 * still recorded for calibration, but the wheel routes exactly as before.
 */
export function isWheelIvEntryFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[WHEEL_IV_FILTER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1203 (board: "try mispriced options for the rest of the week instead of
// relative value") — turn the TRA-1156 OBSERVE-ONLY IV-vs-RV scan into an
// EXECUTING demo paper-routing path.
//
// "Mispriced value" here is the volatility-risk-premium read the scanner already
// computes: fair value priced off the underlying's REALISED vol (what actually
// happened), independent of the peer/skew comparison the relative-value path
// uses. When ON, each demo tick's top BUY_PREMIUM candidate per symbol (IV cheap
// vs realised → premium underpriced → buy it) is opened on the demo paper book
// via the same `openOptionFromRvCandidate` single-leg path the directional/RV
// fills use, journal-tagged `entryArchetype:'iv-rv-buy-premium'` so the TRA-1200
// byArchetype rollup attributes it SEPARATELY from bare `single_leg_rv` — that
// per-archetype split is how the board reads "mispriced vs relative value".
//
// SELL_PREMIUM (IV rich) candidates are surfaced/logged but NOT routed: the demo
// single-leg book is long-only, so shorting premium would need a defined-risk
// spread (future work) — never a naked short.
//
// Layered ON TOP OF the scanner flag (mirrors the TRA-1028 sub-flag pattern): it
// only takes effect when `isOptionIvRvScannerEnabled()` is ALSO true, so the
// observe-only ledger and the routing path can never diverge, and turning the
// scanner off kills routing too. OFF by default ⇒ the IV-RV pass stays exactly
// observe-only and prod/live paths are byte-for-byte unchanged. Demo-only: the
// engine pass hard-gates on `mode === 'demo'`. Live-capital promotion stays
// gated on TRA-382 regardless of this flag.
// --------------------------------------------------------------------------

export const OPTION_IV_RV_ROUTING_FLAG = 'ENABLE_OPTION_IV_RV_ROUTING';

/** True iff the scanner flag AND the IV-RV demo-routing sub-flag are both on. */
export function isOptionIvRvRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionIvRvScannerEnabled(env) && flagOn(env[OPTION_IV_RV_ROUTING_FLAG]);
}

// Optional threshold overrides for the routing path so QuantTrader/the operator
// can loosen or tighten what counts as actionably-mispriced WITHOUT a code change
// (a calm tape can otherwise yield zero BUY_PREMIUM candidates at the strict
// 0.70 / 25% engine defaults, and the board wants observable fills this week).
// Both default to undefined ⇒ the engine's `IvRvScannerOptions` defaults stand.
export const OPTION_IV_RV_BUY_RATIO_VAR = 'OPTION_IV_RV_BUY_RATIO';
export const OPTION_IV_RV_MISPRICING_PCT_VAR = 'OPTION_IV_RV_MISPRICING_PCT';

export interface IvRvRoutingOverride {
  /** IV/RV ratio at or below which a contract is BUY_PREMIUM, or undefined for the engine default (0.70). */
  buyIvRvRatio: number | undefined;
  /** |mispricingPct| (as a fraction, e.g. 0.25) gate, or undefined for the engine default (0.25). */
  mispricingThresholdPct: number | undefined;
}

function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the optional IV-RV routing threshold overrides. Returns undefined
 * bounds when unset/invalid so the caller passes nothing to the engine and the
 * 0.70 / 0.25 defaults stand. A buy ratio ≥ 1 is rejected (a BUY_PREMIUM gate
 * must sit below parity or it would fire on rich premium) and falls back.
 */
export function resolveIvRvRoutingOverride(env: NodeJS.ProcessEnv = process.env): IvRvRoutingOverride {
  let buyIvRvRatio = parsePositiveFloat(env[OPTION_IV_RV_BUY_RATIO_VAR]);
  if (buyIvRvRatio !== undefined && buyIvRvRatio >= 1) buyIvRvRatio = undefined;
  const mispricingThresholdPct = parsePositiveFloat(env[OPTION_IV_RV_MISPRICING_PCT_VAR]);
  return { buyIvRvRatio, mispricingThresholdPct };
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

// --------------------------------------------------------------------------
// TRA-1205 (TRA-1202 follow-up) — auto-execute the TOP N ranked AI option
// ideas into the DEMO paper book without a manual "Paper entry" click.
//
// This is a SEPARATE path from TRA-1142's `ENABLE_OPTION_DEMO_AUTO_CONFIRM`
// (which rides the shared proposal rail and auto-confirms EVERY enterable idea
// through `shouldAutoConfirm`). This flag turns on a simpler, self-contained
// post-feed-refresh hook that picks only the TOP N (default 3) enterable ideas,
// dedups by (symbol + structure + expiry) so a re-run of the same cached feed
// can't double-enter, and opens each through the SAME direct
// `enterPaperOptionsIdea` path the manual click uses.
//
// OFF by default ⇒ the feed read is byte-for-byte unchanged. When ON it is
// hard-gated demo-only by the caller (`settings.mode === 'demo'`) AND again
// inside the runner, so live-capital is never touched; live promotion stays
// gated on TRA-382 regardless. Activity is surfaced read-only at
// `GET /api/health/options-ideas-auto-execute`.
// --------------------------------------------------------------------------

export const OPTION_IDEAS_AUTO_EXECUTE_FLAG = 'ENABLE_OPTION_IDEAS_AUTO_EXECUTE';
export const OPTION_IDEAS_AUTO_EXECUTE_TOP_N_VAR = 'OPTION_IDEAS_AUTO_EXECUTE_TOP_N';

/** Default count of top-ranked enterable ideas to auto-execute per refresh cycle. */
export const OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N = 3;
/** Hard ceiling so a fat-finger env can't fan out the whole feed into the book. */
const OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N = 25;

/** True iff the AI-Ideas demo auto-execute flag is on (accepts 1/true/yes/on). */
export function isOptionIdeasAutoExecuteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_IDEAS_AUTO_EXECUTE_FLAG]);
}

/**
 * Resolve the configured top-N (default {@link OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N}).
 * A non-finite, non-positive, or fractional value falls back to the default so a
 * malformed env can't silently disable (0) or over-fan-out the auto-executor;
 * the result is clamped to [1, {@link OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N}].
 */
export function resolveOptionIdeasAutoExecuteTopN(env: NodeJS.ProcessEnv = process.env): number {
  const n = parsePositiveInt(env[OPTION_IDEAS_AUTO_EXECUTE_TOP_N_VAR]);
  if (n === undefined) return OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N;
  return Math.min(n, OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N);
}

// --------------------------------------------------------------------------
// TRA-1491 (parent TRA-1479 "Demo to Live", family options-rv-long) — DARK
// live-capital gate on the RV (relative-value / reversion) single-leg LONG
// options order path.
//
// The RV scan (`runRelativeValueScan`) runs in BOTH demo and live: in live the
// paper-book open is immediately mirrored to a real Tradier `buy_to_open`
// (TRA-221). The board authorized BUILDING this live path via the TRA-1479
// checkbox interaction (accepted 2026-07-08 by `local-board`) but explicitly
// did NOT arm real capital — arming is a SEPARATE `request_board_approval`.
//
// This flag is that separation. It is a SECRET-ADJACENT live toggle (it
// authorizes real orders), so — unlike the demo flags — it is read ONLY from
// the process env (never from the `demo-flags.json` file override) and is NOT
// on the demo-flag allowlist. OFF by default ⇒ the entire live RV single-leg
// long entry (the live-book open AND its Tradier mirror) is inert: a live RV
// candidate opens nothing and places no order, so the shipped state carries
// zero real-capital risk. When an operator arms it on `tradingai-bqb1` (only
// after board approval + greeks-gate forward-sample sufficiency, TRA-1409 /
// TRA-1293), the live entry additionally inherits the SAME PoP/delta greeks
// gate the demo path forward-samples, so what gets armed is exactly what was
// validated. Demo behaviour is byte-for-byte unchanged regardless (the gate is
// live-mode only).
// --------------------------------------------------------------------------

export const OPTION_LIVE_RV_LONG_FLAG = 'ENABLE_OPTION_LIVE_RV_LONG';

/**
 * True iff the DARK live-capital RV single-leg long options order path is armed
 * (accepts 1/true/yes/on). Default OFF. Read from the process env only — this is
 * a live-order toggle, never sourced from the demo-flags file override.
 */
export function isOptionLiveRvLongEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_RV_LONG_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1490 (parent TRA-1479 "Demo to Live", family options-directional) — DARK
// live-capital gate on the deterministic DIRECTIONAL (near-ATM single-leg long
// call/put) options order path.
//
// Unlike the RV single-leg long path (TRA-1491), which already ran in BOTH demo
// and live, the directional "ignition" entry (`evaluateDemoDirectional`,
// TRA-1114) has always been caller-gated to `mode === 'demo'` and opens with no
// equity override → no Tradier mirror. There is no live directional order path
// to "flip on"; this flag is what BUILDS one (Phase 1 of the TRA-1490 gated
// promotion plan). The board authorized building the live path via the TRA-1479
// checkbox interaction (accepted 2026-07-08 by `local-board`) but explicitly did
// NOT arm real capital — arming is a SEPARATE `request_board_approval` gated on
// the option-chain capture window (TRA-382) + sandbox forward-validation
// (TRA-1436).
//
// Like the RV live flag, this is a SECRET-ADJACENT live toggle (it authorizes
// real orders), so it is read ONLY from the process env (never the
// `demo-flags.json` file override) and is NOT on the demo-flag allowlist. OFF by
// default ⇒ the directional pass NEVER runs in live (the caller gate is
// demo-OR-armed-live), no live position is created, and no Tradier order is
// placed — the shipped state carries zero real-capital risk. When an operator
// arms it on `tradingai-bqb1` (only after board approval), the live directional
// entry sizes off the real Tradier equity and mirrors the paper open to a real
// `buy_to_open` through the SAME audited smart-open broker seam the RV long path
// uses. Demo behaviour is byte-for-byte unchanged regardless (the live gate is
// live-mode only; the demo pass still keys off ENABLE_OPTION_DEMO_DIRECTIONAL).
// --------------------------------------------------------------------------

export const OPTION_LIVE_DIRECTIONAL_FLAG = 'ENABLE_OPTION_LIVE_DIRECTIONAL';

/**
 * True iff the DARK live-capital directional (call/put) single-leg options order
 * path is armed (accepts 1/true/yes/on). Default OFF. Read from the process env
 * only — this is a live-order toggle, never sourced from the demo-flags file
 * override.
 */
export function isOptionLiveDirectionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_DIRECTIONAL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1929 (parent TRA-1916) — DARK live-capital gate on the OTM
// (`single_leg_otm`) single-leg long options order path, PLUS a shared,
// self-expiring 2-day test WINDOW that governs BOTH the OTM and RV live sleeves
// for the board-authorized bounded real-money fee/slippage calibration test.
//
// The OTM scan (`runOtmScan`) runs in BOTH demo and live, but until now the live
// branch had NO real-money open — it only stamped a `liveSkipReason` and skipped
// (signal-engine `runOtmScan` ~5538). This flag is the arm for wiring the same
// audited broker mirror (`mirrorLiveOptionOpen`) the RV path uses. Like the RV /
// directional live flags it is SECRET-ADJACENT (it authorizes real orders), so it
// is read ONLY from the process env — never from the `demo-flags.json` file
// override — and is NOT on the demo-flag allowlist. OFF by default ⇒ the live OTM
// entry is inert (byte-for-byte the pre-TRA-1929 suppress-and-skip behaviour), so
// the shipped state carries zero real-capital risk.
//
// ── THE 2-DAY AUTO-DISABLE (must be CODE, not config trust) ──────────────────
// The board authorized a BOUNDED 2-day test. A boolean flag left armed is exactly
// the "missed manual disable leaves real money armed" failure mode, so the arm
// SELF-EXPIRES: `OPTION_LIVE_TEST_UNTIL=<epoch-ms>` is a hard window end. Past it,
// BOTH `ENABLE_OPTION_LIVE_OTM` and `ENABLE_OPTION_LIVE_RV_LONG` are treated as OFF
// regardless of their boolean value ({@link isOptionLiveOtmArmed} /
// {@link isOptionLiveRvLongArmed}). FAIL-CLOSED: an unset or malformed
// `OPTION_LIVE_TEST_UNTIL` reads as a CLOSED window ⇒ neither sleeve can arm. Prod
// today runs both sleeve flags OFF, so adding the window gate only ever tightens
// (a flag-OFF sleeve is unarmed regardless of the window).
// --------------------------------------------------------------------------

export const OPTION_LIVE_OTM_FLAG = 'ENABLE_OPTION_LIVE_OTM';

/**
 * True iff the DARK live-capital OTM single-leg long options order path flag is
 * set (accepts 1/true/yes/on). Default OFF. Read from the process env only — this
 * is a live-order toggle, never sourced from the demo-flags file override. NOTE:
 * this is the RAW boolean; the actual arm additionally requires the test window to
 * be open — use {@link isOptionLiveOtmArmed} at the order-decision sites.
 */
export function isOptionLiveOtmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_OTM_FLAG]);
}

export const OPTION_LIVE_TEST_UNTIL_VAR = 'OPTION_LIVE_TEST_UNTIL';

/**
 * The bounded-test hard cap on a single live entry's notional, in USD. The board
 * (TRA-1916) sized the test off the live Tradier Production account's ~$268.58
 * tradeable cash. The per-entry cap the guardrail enforces is
 * `min(available cash, LIVE_OPTION_TEST_NOTIONAL_CAP_USD)`.
 */
export const LIVE_OPTION_TEST_NOTIONAL_CAP_USD = 268.58;

/**
 * Parse `OPTION_LIVE_TEST_UNTIL` (the bounded-test window end, epoch-ms). Returns
 * the finite positive epoch, or `null` when unset / non-numeric / non-positive.
 * `null` is the FAIL-CLOSED sentinel — the caller treats a null window as CLOSED.
 */
export function parseOptionLiveTestUntil(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[OPTION_LIVE_TEST_UNTIL_VAR];
  if (typeof raw !== 'string') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * True iff the bounded live-options test window is currently OPEN: a valid
 * `OPTION_LIVE_TEST_UNTIL` in the future (`now <= until`). FAIL-CLOSED — an unset
 * or malformed window var, or a window whose end has passed, returns false so a
 * missed manual disable cannot leave real money armed.
 */
export function isOptionLiveTestWindowOpen(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  const until = parseOptionLiveTestUntil(env);
  if (until === null) return false; // fail-closed: unset/malformed ⇒ window CLOSED
  return now <= until;
}

/**
 * True iff the live RV single-leg long path is ACTUALLY armed for the bounded test:
 * the `ENABLE_OPTION_LIVE_RV_LONG` boolean is on AND the test window is open. This
 * is the value the order-decision sites must consult (not the raw flag) so the
 * 2-day auto-disable holds for RV too (TRA-1929).
 */
export function isOptionLiveRvLongArmed(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return isOptionLiveRvLongEnabled(env) && isOptionLiveTestWindowOpen(env, now);
}

/**
 * True iff the live OTM single-leg long path is ACTUALLY armed for the bounded
 * test: the `ENABLE_OPTION_LIVE_OTM` boolean is on AND the test window is open.
 * This is the value the OTM order-decision sites must consult (TRA-1929).
 */
export function isOptionLiveOtmArmed(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return isOptionLiveOtmEnabled(env) && isOptionLiveTestWindowOpen(env, now);
}

// --------------------------------------------------------------------------
// TRA-2048 (parent TRA-2044 "how to reduce slippage", board-funded fork) —
// promote the two already-built, shadow-only pre-trade gates from OBSERVE to
// ENFORCING on the LIVE options path, each behind its OWN secret-adjacent env
// flag so the flip to real rejection is an OPS action, not a code default.
//
//   • the COST-vs-edge gate (`option-cost-gate.ts` — commission + maker-adjusted
//     spread-cross + safety-margin admission bar). Today it enforces ONLY in demo
//     (`SignalEngine.costAwareGateReject` early-returns on `mode !== 'demo'`); this
//     flag adds a LIVE-mode enforcing branch that rejects a live candidate whose
//     modeled gross R can't clear its structure's cost bar BEFORE the open.
//   • the LIQUIDITY / SPREAD gate (`packages/engine/src/liquidity-gate.ts` —
//     `SPREAD_TOO_WIDE` / thin-book veto). Today it only SHADOW-records post-open
//     (`recordOptionLiquidityShadow`); this flag adds a pre-submit veto at the
//     single audited live-options broker seam (`mirrorLiveOptionOpen`).
//
// TIGHTENING-ONLY and TRA-1897-HOLD-safe: both flags can only ADD rejections
// (reject a bad-spread / over-cost order) — neither can loosen, upsize, or admit
// anything the current path wouldn't already admit. OFF by default ⇒ the live
// options path is byte-for-byte the pre-TRA-2048 shadow behaviour: no rejection,
// same fills. Like the sleeve-arm flags these are SECRET-ADJACENT live toggles
// (they change what real orders do), so they are read from the process env ONLY —
// never from the `demo-flags.json` file override — and are NOT on the demo-flag
// allowlist. Every ARMED evaluation (allowed AND blocked) is recorded durably to
// `live-enforce-gate-ledger.ts` and surfaced at `/api/health/live-enforce-gates`,
// so an armed-but-inert flip cannot read the same as an armed-and-biting one
// (the TRA-1486 / TRA-1682 lesson): `armed:true` with a positive `evaluated` and a
// `blocked` count is the direct proof the gate is firing.
// --------------------------------------------------------------------------

export const OPTION_COST_GATE_LIVE_ENFORCE_FLAG = 'ENABLE_OPTION_COST_GATE_LIVE_ENFORCE';
export const OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG = 'ENABLE_OPTION_LIQUIDITY_LIVE_ENFORCE';

/**
 * True iff the LIVE cost-vs-edge gate is armed to REJECT real option opens
 * (accepts 1/true/yes/on). Default OFF ⇒ live opens are never blocked by the cost
 * bar (the demo-only enforcement is unchanged). Read from the process env only —
 * this is a live-order toggle, never sourced from the demo-flags file override.
 */
export function isOptionCostGateLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_COST_GATE_LIVE_ENFORCE_FLAG]);
}

/**
 * True iff the LIVE liquidity/spread gate is armed to VETO real option opens on a
 * pathologically wide / dead book (accepts 1/true/yes/on). Default OFF ⇒ the
 * liquidity gate stays shadow-only on the live path (records, never blocks). Read
 * from the process env only — this is a live-order toggle, never sourced from the
 * demo-flags file override.
 */
export function isOptionLiquidityLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG]);
}
