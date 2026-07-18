import {
  DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG,
  evaluateShadowExpectancyGuard,
  type ShadowExpectancyGuardConfig,
  type ShadowExpectancyGuardVerdict,
  type ShadowExpectancySample,
} from '@trading-app/shared';
import type { ShadowSignalRecord } from './shadow-signal-ledger.js';
import { etDateKey } from './options-chain-recorder.js';

// TRA-2036 — server flag layer + ledger→sample fold for the shadow-expectancy
// promotion guard.
//
// The pure guard lives in `@trading-app/shared` (`evaluateShadowExpectancyGuard`);
// this module is the seam that (a) reads the two kill switches, (b) folds a
// resolved shadow ledger into the guard's cost-netted sample, and (c) builds the
// config. STAGED enforcement, flag-OFF by default:
//
//   • ENABLE_SHADOW_EXPECTANCY_GUARD          — master. When OFF the guard is not
//     wired into any promotion path at all (the promotion gate is byte-for-byte
//     unchanged). When ON it is wired in OBSERVE-ONLY unless the enforce flag is
//     also set — so we first measure how many current candidates it would block.
//   • ENABLE_SHADOW_EXPECTANCY_GUARD_ENFORCE  — flips OBSERVE → ENFORCE (a
//     would-block becomes a real promotion `blockedReason`). Meaningless unless
//     the master flag is also on.
//
// NOTHING here touches live capital — it gates PROMOTION, and live stays OFF
// pending TRA-382. With both flags at their default (unset) this is inert.

export const SHADOW_EXPECTANCY_GUARD_FLAG = 'ENABLE_SHADOW_EXPECTANCY_GUARD';
export const SHADOW_EXPECTANCY_GUARD_ENFORCE_FLAG = 'ENABLE_SHADOW_EXPECTANCY_GUARD_ENFORCE';

function truthy(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Master switch — is the guard wired into the promotion gate at all? Default OFF. */
export function isShadowExpectancyGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env[SHADOW_EXPECTANCY_GUARD_FLAG]);
}

/**
 * Enforce switch — does a would-block actually block promotion? Default OFF
 * (observe-only). Only meaningful when the master flag is on.
 */
export function isShadowExpectancyGuardEnforcing(env: NodeJS.ProcessEnv = process.env): boolean {
  return isShadowExpectancyGuardEnabled(env) && truthy(env[SHADOW_EXPECTANCY_GUARD_ENFORCE_FLAG]);
}

/** Build the guard config from env (defaults + the enforce flag). */
export function buildShadowExpectancyGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShadowExpectancyGuardConfig {
  return { ...DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG, enforce: isShadowExpectancyGuardEnforcing(env) };
}

/**
 * Fold a Supertrend shadow ledger into the guard's cost-netted sample. Only
 * RESOLVED rows carrying a finite `realizedR` contribute; OPEN rows have no
 * outcome yet. Each signal is clustered by its ET trading day (`etDateKey`) —
 * the trading episode — so same-day/correlated signals collapse in the effective
 * sample size and the block bootstrap.
 *
 * NOTE on the cost model: the guard's `netR` contract is R **net of the shared
 * TRA-2033 cost model**. The Supertrend shadow ledger measures `realizedR` on
 * the underlying and carries no per-signal cost leg (equity Supertrend has no
 * tiered cost model — that model is crypto-specific), so the underlying R is
 * used directly here. A crypto candidate would feed cost-netted R from the
 * TRA-2033 model at this fold instead. Observe-only either way while the flag holds.
 */
export function shadowLedgerToExpectancySample(
  rows: readonly ShadowSignalRecord[],
): ShadowExpectancySample[] {
  const out: ShadowExpectancySample[] = [];
  for (const r of rows) {
    if (r.outcome === 'OPEN') continue;
    if (typeof r.realizedR !== 'number' || !Number.isFinite(r.realizedR)) continue;
    out.push({ netR: r.realizedR, clusterKey: etDateKey(r.ts) });
  }
  return out;
}

/** Evaluate the guard over a Supertrend shadow ledger with the env-resolved config. */
export function shadowExpectancyGuardFromLedger(
  rows: readonly ShadowSignalRecord[],
  env: NodeJS.ProcessEnv = process.env,
): ShadowExpectancyGuardVerdict {
  return evaluateShadowExpectancyGuard(shadowLedgerToExpectancySample(rows), buildShadowExpectancyGuardConfig(env));
}
