import { describe, it, expect } from 'vitest';
import type { MakerFillEvent } from './option-maker-fill-ledger.js';
import { DEFAULT_MAKER_WALK_CONFIG, type MakerWalkConfig } from './option-maker-config.js';
import {
  buildMakerLadderRecommendation,
  DEFAULT_MIN_LADDER_SAMPLES,
  MIN_RECOMMENDED_STEP_WAIT_MS,
} from './maker-ladder-recommendation.js';

function fill(overrides: Partial<MakerFillEvent> = {}): MakerFillEvent {
  return {
    ts: 1_000,
    side: 'open',
    mode: 'live',
    symbol: 'AAPL240119C00150000',
    result: 'filled',
    walk: 0,
    realizedVsMidUsd: 0.01,
    timeToFillMs: 4_000,
    ...overrides,
  };
}

/** N fills at a given step with a per-step latency, so p90 latency is predictable. */
function fillsAtStep(n: number, walk: number, timeToFillMs: number): MakerFillEvent[] {
  return Array.from({ length: n }, () => fill({ walk, timeToFillMs }));
}

describe('buildMakerLadderRecommendation', () => {
  const config: MakerWalkConfig = DEFAULT_MAKER_WALK_CONFIG; // [0,0.25,0.5,0.75,1], 30s, 0 cross

  it('returns insufficient_data and a null recommendation below the sample floor', () => {
    const events = fillsAtStep(DEFAULT_MIN_LADDER_SAMPLES - 1, 0, 3_000);
    const rec = buildMakerLadderRecommendation(events, config);
    expect(rec.open.status).toBe('insufficient_data');
    expect(rec.open.recommendation).toBeNull();
    // The other side has zero events — also insufficient.
    expect(rec.close.status).toBe('insufficient_data');
    expect(rec.close.filledWithStep).toBe(0);
  });

  it('drops interior steps with negligible fill share but preserves opener and ask', () => {
    // 40 fills at step 0 (opener), 10 at step 4 (the ask). Interior steps 1,2,3 never fill.
    const events = [...fillsAtStep(40, 0, 3_000), ...fillsAtStep(10, 4, 20_000)];
    const rec = buildMakerLadderRecommendation(events, config);
    expect(rec.open.status).toBe('ok');
    const r = rec.open.recommendation!;
    // Opener (0) + ask (1.0) survive; 0.25/0.5/0.75 dropped as dead wait windows.
    expect(r.fractions).toEqual([0, 1.0]);
    expect(r.droppedInteriorSteps).toBe(3);
    expect(r.fractionsChanged).toBe(true);
  });

  it('keeps every interior step when each carries a material fill share', () => {
    const events = [
      ...fillsAtStep(20, 0, 3_000),
      ...fillsAtStep(20, 1, 6_000),
      ...fillsAtStep(20, 2, 9_000),
      ...fillsAtStep(20, 3, 12_000),
      ...fillsAtStep(20, 4, 15_000),
    ];
    const rec = buildMakerLadderRecommendation(events, config);
    const r = rec.open.recommendation!;
    expect(r.fractions).toEqual([0, 0.25, 0.5, 0.75, 1.0]);
    expect(r.droppedInteriorSteps).toBe(0);
    expect(r.fractionsChanged).toBe(false);
  });

  it('recommends a shorter stepWaitMs when fills land well inside the window', () => {
    // All fill at step 0 in 3s ⇒ per-step latency 3s ⇒ p90 ~3s, far below the 30s default.
    const events = fillsAtStep(50, 0, 3_000);
    const rec = buildMakerLadderRecommendation(events, config);
    const r = rec.open.recommendation!;
    expect(r.stepWaitMsChanged).toBe(true);
    expect(r.stepWaitMs).toBeLessThan(config.stepWaitMs);
    expect(r.stepWaitMs).toBeGreaterThanOrEqual(MIN_RECOMMENDED_STEP_WAIT_MS);
    expect(r.perStepLatencyP90Ms).toBeGreaterThan(0);
  });

  it('floors the recommended wait so a fast cohort cannot collapse the walk', () => {
    // Sub-floor per-step latency (10ms) must clamp up to the 2s floor.
    const events = fillsAtStep(50, 0, 10);
    const rec = buildMakerLadderRecommendation(events, config);
    expect(rec.open.recommendation!.stepWaitMs).toBe(MIN_RECOMMENDED_STEP_WAIT_MS);
  });

  it('keeps maxCrossTicks at 0 when no cross-tick fills were observed', () => {
    const events = fillsAtStep(50, 4, 20_000); // all at the ask, never past it
    const rec = buildMakerLadderRecommendation(events, config);
    const r = rec.open.recommendation!;
    expect(rec.open.crossTickFillsObserved).toBe(false);
    expect(r.maxCrossTicks).toBe(0);
    expect(r.maxCrossTicksChanged).toBe(false);
  });

  it('recommends maxCrossTicks when cross-tick fills are observed under a crossing config', () => {
    // Config already allows 2 cross ticks; steps 5 (ask+1) and 6 (ask+2) are cross-tick.
    const crossConfig: MakerWalkConfig = { ...config, maxCrossTicks: 2 };
    const events = [...fillsAtStep(40, 4, 20_000), ...fillsAtStep(20, 5, 25_000)];
    const rec = buildMakerLadderRecommendation(events, crossConfig);
    const r = rec.open.recommendation!;
    expect(rec.open.crossTickFillsObserved).toBe(true);
    // Deepest materially-filled cross-tick step is 5 = ask(4) + 1 tick.
    expect(r.maxCrossTicks).toBe(1);
  });

  it('the step histogram sums to filledWithStep and is auditable', () => {
    const events = [...fillsAtStep(30, 0, 3_000), ...fillsAtStep(10, 2, 9_000)];
    const rec = buildMakerLadderRecommendation(events, config);
    const totalFromHist = rec.open.stepHistogram.reduce((s, h) => s + h.fills, 0);
    expect(totalFromHist).toBe(rec.open.filledWithStep);
    expect(rec.open.filledWithStep).toBe(40);
    // Shares sum to 1 over measured fills.
    const shareSum = rec.open.stepHistogram.reduce((s, h) => s + h.shareOfFills, 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });

  it('ignores non-filled chases in the recommendation denominator but counts them in fillRate', () => {
    const events = [
      ...fillsAtStep(30, 0, 3_000),
      ...Array.from({ length: 10 }, () =>
        fill({ result: 'walk_exhausted', walk: undefined, realizedVsMidUsd: undefined, timeToFillMs: undefined }),
      ),
    ];
    const rec = buildMakerLadderRecommendation(events, config);
    expect(rec.open.chases).toBe(40);
    expect(rec.open.fills).toBe(30);
    expect(rec.open.filledWithStep).toBe(30);
    expect(rec.open.fillRate).toBeCloseTo(0.75, 6);
  });

  it('never mutates the passed config and echoes it as current', () => {
    const events = fillsAtStep(50, 0, 3_000);
    const snapshot = JSON.stringify(config);
    const rec = buildMakerLadderRecommendation(events, config);
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(rec.current.fractions).toEqual([...config.fractions]);
    expect(rec.current.stepWaitMs).toBe(config.stepWaitMs);
    expect(rec.current.maxCrossTicks).toBe(config.maxCrossTicks);
  });
});
