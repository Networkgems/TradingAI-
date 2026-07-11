import { describe, it, expect } from 'vitest';
import {
  resolveMakerWalkConfig,
  DEFAULT_MAKER_WALK_FRACTIONS,
  DEFAULT_MAKER_STEP_WAIT_MS,
  DEFAULT_MAKER_MAX_CROSS_TICKS,
  MAKER_MAX_CROSS_TICKS_LIMIT,
  OPTION_TICK_SIZE,
} from './option-maker-config.js';

// TRA-1601 (A) — the configurable chase ladder resolver. Defaults must be the
// byte-for-byte TRA-374 behaviour; each knob validates independently and a
// malformed value falls back to that knob's default without poisoning the rest.

describe('resolveMakerWalkConfig', () => {
  it('resolves the TRA-374 defaults when nothing is set', () => {
    const cfg = resolveMakerWalkConfig({});
    expect(cfg.fractions).toEqual(DEFAULT_MAKER_WALK_FRACTIONS);
    expect(cfg.stepWaitMs).toBe(DEFAULT_MAKER_STEP_WAIT_MS);
    expect(cfg.maxCrossTicks).toBe(DEFAULT_MAKER_MAX_CROSS_TICKS);
    expect(cfg.tickSize).toBe(OPTION_TICK_SIZE);
  });

  it('parses a valid comma-separated walk ladder', () => {
    const cfg = resolveMakerWalkConfig({ OPTION_MAKER_WALK_STEPS: '0,0.5,1' });
    expect(cfg.fractions).toEqual([0, 0.5, 1]);
  });

  it('sorts ascending and dedupes an out-of-order override', () => {
    const cfg = resolveMakerWalkConfig({ OPTION_MAKER_WALK_STEPS: '1,0.5,0.5,0' });
    expect(cfg.fractions).toEqual([0, 0.5, 1]);
  });

  it('falls back to the default ladder on a non-numeric token', () => {
    const cfg = resolveMakerWalkConfig({ OPTION_MAKER_WALK_STEPS: '0,foo,1' });
    expect(cfg.fractions).toEqual(DEFAULT_MAKER_WALK_FRACTIONS);
  });

  it('falls back to the default ladder on an out-of-range fraction', () => {
    expect(resolveMakerWalkConfig({ OPTION_MAKER_WALK_STEPS: '0,1.5' }).fractions).toEqual(
      DEFAULT_MAKER_WALK_FRACTIONS,
    );
    expect(resolveMakerWalkConfig({ OPTION_MAKER_WALK_STEPS: '-0.1,1' }).fractions).toEqual(
      DEFAULT_MAKER_WALK_FRACTIONS,
    );
  });

  it('honours a valid step-wait override and rejects a non-positive / non-integer one', () => {
    expect(resolveMakerWalkConfig({ OPTION_MAKER_STEP_WAIT_MS: '5000' }).stepWaitMs).toBe(5000);
    expect(resolveMakerWalkConfig({ OPTION_MAKER_STEP_WAIT_MS: '0' }).stepWaitMs).toBe(
      DEFAULT_MAKER_STEP_WAIT_MS,
    );
    expect(resolveMakerWalkConfig({ OPTION_MAKER_STEP_WAIT_MS: '-1' }).stepWaitMs).toBe(
      DEFAULT_MAKER_STEP_WAIT_MS,
    );
    expect(resolveMakerWalkConfig({ OPTION_MAKER_STEP_WAIT_MS: '1.5' }).stepWaitMs).toBe(
      DEFAULT_MAKER_STEP_WAIT_MS,
    );
    expect(resolveMakerWalkConfig({ OPTION_MAKER_STEP_WAIT_MS: 'abc' }).stepWaitMs).toBe(
      DEFAULT_MAKER_STEP_WAIT_MS,
    );
  });

  it('honours a valid cross-ticks override, clamps to the safety cap, rejects bad values', () => {
    expect(resolveMakerWalkConfig({ OPTION_MAKER_MAX_CROSS_TICKS: '3' }).maxCrossTicks).toBe(3);
    expect(resolveMakerWalkConfig({ OPTION_MAKER_MAX_CROSS_TICKS: '0' }).maxCrossTicks).toBe(0);
    expect(
      resolveMakerWalkConfig({ OPTION_MAKER_MAX_CROSS_TICKS: '9999' }).maxCrossTicks,
    ).toBe(MAKER_MAX_CROSS_TICKS_LIMIT);
    expect(resolveMakerWalkConfig({ OPTION_MAKER_MAX_CROSS_TICKS: '-2' }).maxCrossTicks).toBe(
      DEFAULT_MAKER_MAX_CROSS_TICKS,
    );
    expect(resolveMakerWalkConfig({ OPTION_MAKER_MAX_CROSS_TICKS: '1.2' }).maxCrossTicks).toBe(
      DEFAULT_MAKER_MAX_CROSS_TICKS,
    );
  });

  it('resolves each knob independently — one bad value does not clobber the others', () => {
    const cfg = resolveMakerWalkConfig({
      OPTION_MAKER_WALK_STEPS: 'garbage',
      OPTION_MAKER_STEP_WAIT_MS: '4000',
      OPTION_MAKER_MAX_CROSS_TICKS: '2',
    });
    expect(cfg.fractions).toEqual(DEFAULT_MAKER_WALK_FRACTIONS); // bad → default
    expect(cfg.stepWaitMs).toBe(4000); // good → honoured
    expect(cfg.maxCrossTicks).toBe(2); // good → honoured
  });
});
