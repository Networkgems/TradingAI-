import { describe, it, expect } from 'vitest';
import {
  LIVE_RATIFIED_CRYPTO_PRESETS,
  resolveStrategyPreset,
  resolveStrategySymbolUniverse,
} from './index.js';

/**
 * TRA-2393 / TRA-2609 — the eligibility properties of LIVE_RATIFIED_CRYPTO_PRESETS.
 *
 * These assertions carry over from (and generalize) the `TRA-2348 promotion
 * gate` block that `9a2ccba2` (TRA-4629, the crypto-engine removal) deleted
 * from packages/server/src/promotion-service.test.ts. Since that commit NO
 * runtime gate consults the list — so these are not tests of a live control.
 * They are the FORWARD GUARD: the moment crypto work resumes and an entry is
 * added or an existing preset is edited, an ineligible entry fails here, at the
 * diff, rather than surfacing as an unbounded live universe.
 *
 * Two rules are asserted, and they are genuinely DIFFERENT rules:
 *
 *   (a) the categorical rule (TRA-2386): `symbolFilter !== null` for every
 *       ratified id. ⊤ (`null`) is categorically ineligible — a ratification of
 *       the full catalog can never be discharged, because the catalog contains
 *       listings that do not exist yet (see the constant's docstring).
 *   (b) the resolved-universe property: for every ratified id AND every
 *       `enabledStrategies` entry, `resolveStrategySymbolUniverse` returns a
 *       non-null array with length > 0.
 *
 * Why both: a hypothetical `crypto_core_v2` with `symbolFilter: null` plus a
 * finite `strategyUniverse.dca` resolves FINITE for `dca` (index.ts: the
 * `wide === null` branch returns `perStrategy`), so it sails through (b) alone
 * while violating the categorical rule — (a) refuses the shape itself, so a
 * later `enabledStrategies` addition can never inherit ⊤ from the preset-wide
 * filter. Conversely (a) alone never runs the resolver, so it cannot see a
 * zero-length resolved universe — and a zero-length universe on a *ratified
 * live* preset is a preset that can never emit: a defect to surface, not a
 * state to ratify. Hence length > 0 in (b).
 */
describe('TRA-2393 — LIVE_RATIFIED_CRYPTO_PRESETS: every ratified universe is finite and enumerated', () => {
  it('every ratified preset id resolves to a real preset (the allowlist cannot rot into a typo)', () => {
    // Carried from the deleted TRA-2348 block: a typo'd id falls back to
    // `no_trade`, so the allowlist would still "contain" the entry while it
    // stands for nothing.
    for (const id of LIVE_RATIFIED_CRYPTO_PRESETS) {
      expect(resolveStrategyPreset(id).id).toBe(id);
    }
  });

  it('the un-ratified full-catalog roster is NOT on the list (named refusal, carried over)', () => {
    expect(LIVE_RATIFIED_CRYPTO_PRESETS).not.toContain('crypto_core');
  });

  it('(a) categorical rule — no ratified preset carries symbolFilter: null', () => {
    for (const id of LIVE_RATIFIED_CRYPTO_PRESETS) {
      const preset = resolveStrategyPreset(id);
      expect(
        preset.symbolFilter,
        `${id}: symbolFilter is null — that is the ⊤ universe, categorically ineligible for real-money ratification (TRA-2386)`,
      ).not.toBeNull();
    }
  });

  it('(b) resolved-universe property — every (ratified id, enabled strategy) resolves non-null and non-empty', () => {
    for (const id of LIVE_RATIFIED_CRYPTO_PRESETS) {
      const preset = resolveStrategyPreset(id);
      // A ratified live preset with no enabled strategies would make this
      // property vacuously true while the preset can never emit — same defect
      // class as a zero-length universe, so pin the denominator too.
      expect(preset.enabledStrategies.length, `${id}: a ratified live preset with no enabled strategies can never emit`).toBeGreaterThan(0);
      for (const strategy of preset.enabledStrategies) {
        const universe = resolveStrategySymbolUniverse(preset, strategy);
        expect(
          universe,
          `${id}/${strategy}: resolved universe is ⊤ (null) — an unbounded universe cannot be ratified`,
        ).not.toBeNull();
        expect(
          universe!.length,
          `${id}/${strategy}: resolved universe is empty — a ratified live preset that can never emit is a defect to surface, not a state to ratify`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
