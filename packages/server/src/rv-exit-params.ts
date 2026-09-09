// TRA-4436 (parent TRA-4053) — the per-mode RV exit re-tune parameter set,
// extracted VERBATIM from the inline ternary in `signal-engine.ts` so the demo
// and live branches can be graded by a test against the SHIPPED construction
// (not a hand-built copy of it) and so the health readout publishes the same
// expression the engine consults.
//
// The defect this extraction carries the fix for: the demo branch set
// `supertrendFlipConfirmBars` + `supertrendFlipMinLossPctToExit` but omitted
// `ma20ConfirmBars`, so `evaluateExit` fell back to `?? 1` and a SINGLE bar's
// close-through fired `ma20_close_through` with no confirmation and no minimum
// hold — 32 of 77 directional ma20 exits closed in <1 min, 23 of them at
// exactly R=0 (round-trips through the same quote). The live branch (TRA-2949)
// has always set it; the guard was never backported, and 100% of evidence
// accrual is demo. Demo now resolves BOTH confirm-bars gates from the same
// `RV_EXIT_RETUNE_CONFIRM_BARS` source (ratified pin "2", code default 2),
// mirroring the live design where one constant feeds both gates.
import { DEFAULT_EXIT_PARAMS } from '@trading-app/engine';
import type { ExitParams } from '@trading-app/engine';
import {
  isRvExitRetuneEnabled,
  resolveRvExitConfirmBars,
  resolveRvExitFlipMinLossPct,
  isRvExitRetuneLiveEnabled,
  RV_EXIT_RETUNE_LIVE_CONFIRM_BARS,
  RV_EXIT_RETUNE_LIVE_FLIP_MIN_LOSS_PCT,
  resolveSwingTimeStopTradingDays,
  OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT,
} from './exit-risk-rules-flag.js';

/**
 * Build the mode-appropriate RV exit re-tune params, or `undefined` for the
 * legacy fall-through (the options account then uses `DEFAULT_EXIT_PARAMS`).
 *
 * `env` must be the mode-appropriate view: `process.env` for live (live
 * containment — a demo-flags.json write must never arm live behaviour, so the
 * caller passes the raw process env exactly as the inline code read it) and
 * the `resolveDemoFlagEnv()` overlay for demo.
 */
export function buildRvExitParams(
  mode: 'demo' | 'live',
  env: NodeJS.ProcessEnv,
  swingTimeStopTradingDays: number,
): ExitParams | undefined {
  return mode === 'demo' && isRvExitRetuneEnabled(env)
    ? {
        ...DEFAULT_EXIT_PARAMS,
        supertrendFlipConfirmBars: resolveRvExitConfirmBars(env),
        supertrendFlipMinLossPctToExit: resolveRvExitFlipMinLossPct(env),
        // TRA-4436 — the ma20_close_through confirm-bars gate, present on the
        // live branch below since TRA-2949 and missing here ever since. Same
        // value source as the flip gate (ratified RV_EXIT_RETUNE_CONFIRM_BARS,
        // default 2), as live shares one constant across both gates.
        ma20ConfirmBars: resolveRvExitConfirmBars(env),
        timeStopTradingDays: swingTimeStopTradingDays,
      }
    : // TRA-2949 — LIVE port of the exit re-tune: confirmed 2-bar flip +
      // winner-protect gate (a flip only closes a position down ≥20%) + the
      // same confirm-bars gate on ma20_close_through. Spec-fixed values, no
      // env tuning; armed by RV_EXIT_RETUNE_LIVE_ENABLED via process.env
      // only (never demo-flags.json). OFF → legacy live single-bar flip.
      mode === 'live' && isRvExitRetuneLiveEnabled(env)
      ? {
          ...DEFAULT_EXIT_PARAMS,
          supertrendFlipConfirmBars: RV_EXIT_RETUNE_LIVE_CONFIRM_BARS,
          supertrendFlipMinLossPctToExit: RV_EXIT_RETUNE_LIVE_FLIP_MIN_LOSS_PCT,
          ma20ConfirmBars: RV_EXIT_RETUNE_LIVE_CONFIRM_BARS,
          timeStopTradingDays: swingTimeStopTradingDays,
        }
      : swingTimeStopTradingDays !== OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT
        ? { ...DEFAULT_EXIT_PARAMS, timeStopTradingDays: swingTimeStopTradingDays }
        : undefined;
}

/**
 * TRA-4436 (secondary ask) — the demo book's EFFECTIVE `ma20ConfirmBars`, for
 * the `/api/health/option-swing-exits` readout. Derived from the same
 * {@link buildRvExitParams} the engine calls (never a parallel literal), with
 * the same `?? 1` fallback `evaluateExit` applies when the key is absent — so
 * the published number cannot drift from the decision site. Before this fix
 * the route published the live path's `confirmBars: 2` and NOTHING for demo:
 * the demo book running at 1 was unreadable from any surface.
 */
export function demoEffectiveMa20ConfirmBars(env: NodeJS.ProcessEnv): number {
  return (
    buildRvExitParams('demo', env, resolveSwingTimeStopTradingDays(env))?.ma20ConfirmBars ?? 1
  );
}
