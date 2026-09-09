// TRA-4436 (parent TRA-4053) — the demo exit-params branch omitted
// `ma20ConfirmBars` (the live branch has set it since TRA-2949), so a single
// bar's close-through fired `ma20_close_through` with no confirmation and no
// minimum hold: 32 of 77 directional ma20 exits closed in <1 min, 23 of them
// at exactly R=0. These tests grade the SHIPPED construction
// (`buildRvExitParams`) through the SHIPPED evaluator (`evaluateExit`) — never
// a hand-built params literal, which would only agree with itself.
import { describe, it, expect } from 'vitest';
import { evaluateExit } from '@trading-app/engine';
import type { ExitState } from '@trading-app/engine';
import { buildRvExitParams, demoEffectiveMa20ConfirmBars } from './rv-exit-params.js';
import {
  OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT,
  RV_EXIT_RETUNE_LIVE_CONFIRM_BARS,
} from './exit-risk-rules-flag.js';

// The bqb1 demo arm as ratified (demo-flags.ts RENDER_RATIFIED_DEMO_DEFAULTS /
// render.yaml): retune on, confirm bars pinned to 2.
const DEMO_ARMED = { RV_EXIT_RETUNE_ENABLED: '1', RV_EXIT_RETUNE_CONFIRM_BARS: '2' };
const DAYS = OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT;

// Underlying through MA20 against a long; trend still green, premium flat and
// follow-through recorded, so ONLY the ma20 exit can trigger (mirrors the
// TRA-2949 engine-side confirm-bars suite).
const ma20Through: ExitState = {
  side: 'buy',
  supertrendDirection: 'green',
  underlyingClose: 99,
  ma20: 100,
  entryPremium: 2,
  currentPremium: 2,
  barsHeld: 1,
  hadFollowThrough: true,
};

describe('buildRvExitParams — TRA-4436 demo ma20 confirm-bars backport', () => {
  it('the armed demo branch sets ma20ConfirmBars (=2, the live parity value)', () => {
    const params = buildRvExitParams('demo', DEMO_ARMED, DAYS);
    expect(params?.ma20ConfirmBars).toBe(2);
    expect(params?.ma20ConfirmBars).toBe(RV_EXIT_RETUNE_LIVE_CONFIRM_BARS);
  });

  it('the shipped demo params HOLD a single-bar close-through (the 23-of-32 R=0 mode)', () => {
    const params = buildRvExitParams('demo', DEMO_ARMED, DAYS);
    expect(
      evaluateExit({ ...ma20Through, recentMa20Through: [false, true] }, params),
    ).toBeNull();
  });

  it('the shipped demo params hold conservatively when no through-history exists yet (a fresh entry)', () => {
    const params = buildRvExitParams('demo', DEMO_ARMED, DAYS);
    expect(evaluateExit(ma20Through, params)).toBeNull();
  });

  it('a 2-bar persistent close-through still exits — the gate delays, it does not kill', () => {
    const params = buildRvExitParams('demo', DEMO_ARMED, DAYS);
    expect(evaluateExit({ ...ma20Through, recentMa20Through: [true, true] }, params)).toBe(
      'ma20_close_through',
    );
  });

  it('control (the pre-fix defect is visible): the same params WITHOUT ma20ConfirmBars fire on one bar', () => {
    const params = buildRvExitParams('demo', DEMO_ARMED, DAYS);
    expect(
      evaluateExit(
        { ...ma20Through, recentMa20Through: [false, true] },
        { ...params!, ma20ConfirmBars: undefined },
      ),
    ).toBe('ma20_close_through');
  });

  it('RV_EXIT_RETUNE_CONFIRM_BARS drives BOTH demo confirm gates (one value source, as live)', () => {
    const params = buildRvExitParams(
      'demo',
      { RV_EXIT_RETUNE_ENABLED: '1', RV_EXIT_RETUNE_CONFIRM_BARS: '3' },
      DAYS,
    );
    expect(params?.supertrendFlipConfirmBars).toBe(3);
    expect(params?.ma20ConfirmBars).toBe(3);
  });

  it('retune off → undefined (legacy DEFAULT_EXIT_PARAMS fall-through, unchanged by this fix)', () => {
    expect(buildRvExitParams('demo', {}, DAYS)).toBeUndefined();
  });

  it('live branch parity is untouched: spec-fixed 2 on both gates when armed, undefined when dark', () => {
    const live = buildRvExitParams('live', { RV_EXIT_RETUNE_LIVE_ENABLED: '1' }, DAYS);
    expect(live?.ma20ConfirmBars).toBe(RV_EXIT_RETUNE_LIVE_CONFIRM_BARS);
    expect(live?.supertrendFlipConfirmBars).toBe(RV_EXIT_RETUNE_LIVE_CONFIRM_BARS);
    expect(buildRvExitParams('live', {}, DAYS)).toBeUndefined();
  });

  it('a live env cannot be armed by the demo flag, nor demo by the live flag', () => {
    expect(buildRvExitParams('live', { RV_EXIT_RETUNE_ENABLED: '1' }, DAYS)).toBeUndefined();
    expect(buildRvExitParams('demo', { RV_EXIT_RETUNE_LIVE_ENABLED: '1' }, DAYS)).toBeUndefined();
  });
});

describe('demoEffectiveMa20ConfirmBars — the option-swing-exits readout (TRA-4436 secondary ask)', () => {
  it('publishes 2 for the ratified demo arm — the guarded state', () => {
    expect(demoEffectiveMa20ConfirmBars(DEMO_ARMED)).toBe(2);
  });
  it('publishes 1 when the retune is off — the readable defect state, distinct from the pass state', () => {
    expect(demoEffectiveMa20ConfirmBars({})).toBe(1);
  });
});
