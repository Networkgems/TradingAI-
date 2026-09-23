// TRA-4783 — `arm.costBar.edge.freshness` timed the RECOMPUTE only: on
// 2026-09-22 it read `dirty: false, lastError: null, ageMs 26943` while the
// cells' own tape windows were 20–76 days old, so the margin was structurally
// unable to move and the sanctioned degradation check said healthy. These tests
// grade the discriminator BOTH ways (the ticket's own acceptance): the same
// fold must read stale against the frozen live shape AND not-stale against a
// recent fixture — a field that only ever reads one value has not been shown
// to discriminate.

import { describe, expect, it } from 'vitest';
import {
  summarizeTapeInputStaleness,
  TAPE_INPUT_STALE_THRESHOLD_DAYS,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';

const DAY = 86_400_000;
/** 2026-09-22T19:55Z — the instant of the live measurement in the ticket. */
const NOW = Date.parse('2026-09-22T19:55:00Z');

/** Minimal cell for the fold — only `provenance` is consulted. */
function cell(toTs: number | null): Pick<TapeExpectancyCell, 'provenance'> {
  return {
    provenance: {
      byMode: {},
      byAccountClass: { desk: 0, unattributed: 0 },
      fromTs: toTs,
      toTs,
    },
  };
}

/** The eight live per-cell ages measured on 2026-09-22 (TRA-4783's table). */
const LIVE_AGES_DAYS = [47.3, 74.2, 50.3, 49.1, 76.1, 54.1, 20.0, 40.1];
const liveFixture = LIVE_AGES_DAYS.map((d) => cell(NOW - d * DAY));

describe('summarizeTapeInputStaleness (TRA-4783)', () => {
  it('POSITIVE control — the frozen live shape reads stale, with the oldest window named', () => {
    const s = summarizeTapeInputStaleness(liveFixture, NOW);
    expect(s.inputStale).toBe(true);
    expect(s.inputTapeAgeDaysMax).toBe(76.1);
    expect(s.inputTapeToIsoOldest).toBe(new Date(NOW - 76.1 * DAY).toISOString());
    expect(s.inputCellsMeasured).toBe(8);
    expect(s.inputCellsUnmeasured).toBe(0);
    expect(s.inputStaleThresholdDays).toBe(TAPE_INPUT_STALE_THRESHOLD_DAYS);
  });

  it('NEGATIVE control — a recently-accruing tape reads false, not merely un-flagged', () => {
    const recent = [0.1, 0.4, 1.2, 2.0, 3.5].map((d) => cell(NOW - d * DAY));
    const s = summarizeTapeInputStaleness(recent, NOW);
    expect(s.inputStale).toBe(false); // a real false — every cell measured and fresh
    expect(s.inputTapeAgeDaysMax).toBe(3.5);
    expect(s.inputCellsMeasured).toBe(5);
  });

  it('discriminates on the CLOCK alone — the same cells flip false → true as they age', () => {
    const cells = [cell(NOW - 2 * DAY), cell(NOW - 5 * DAY)];
    expect(summarizeTapeInputStaleness(cells, NOW).inputStale).toBe(false);
    expect(summarizeTapeInputStaleness(cells, NOW + 30 * DAY).inputStale).toBe(true);
  });

  it('the live shape trips at ANY threshold under its newest cell (20.0d), per the ticket', () => {
    for (const bar of [7, 10, 14, 19]) {
      expect(summarizeTapeInputStaleness(liveFixture, NOW, bar).inputStale).toBe(true);
    }
  });

  it('compares on the RAW age, not the rounded one', () => {
    const bar = TAPE_INPUT_STALE_THRESHOLD_DAYS;
    const justOver = [cell(NOW - (bar * DAY + 60_000))];
    const justUnder = [cell(NOW - (bar * DAY - 60_000))];
    // Both display as the bar itself after 1-decimal rounding…
    expect(summarizeTapeInputStaleness(justOver, NOW).inputTapeAgeDaysMax).toBe(bar);
    expect(summarizeTapeInputStaleness(justUnder, NOW).inputTapeAgeDaysMax).toBe(bar);
    // …but the verdict is decided on the raw milliseconds.
    expect(summarizeTapeInputStaleness(justOver, NOW).inputStale).toBe(true);
    expect(summarizeTapeInputStaleness(justUnder, NOW).inputStale).toBe(false);
  });

  it('no cells at all ⇒ null / null / null — never a coerced false', () => {
    const s = summarizeTapeInputStaleness([], NOW);
    expect(s.inputStale).toBeNull();
    expect(s.inputTapeAgeDaysMax).toBeNull();
    expect(s.inputTapeToIsoOldest).toBeNull();
    expect(s.inputStaleThresholdDays).toBe(TAPE_INPUT_STALE_THRESHOLD_DAYS);
  });

  it('no cell carries a finite toTs ⇒ null, with the unmeasured cells counted', () => {
    const s = summarizeTapeInputStaleness([cell(null), cell(null)], NOW);
    expect(s.inputStale).toBeNull();
    expect(s.inputCellsMeasured).toBe(0);
    expect(s.inputCellsUnmeasured).toBe(2);
  });

  it('fresh measured cells + one unmeasurable cell ⇒ null, NOT false — unknown never attests healthy', () => {
    const s = summarizeTapeInputStaleness([cell(NOW - 1 * DAY), cell(null)], NOW);
    expect(s.inputStale).toBeNull();
    expect(s.inputTapeAgeDaysMax).toBe(1); // the measured part is still published
    expect(s.inputCellsUnmeasured).toBe(1);
  });

  it('a stale measured cell trips true even beside unmeasurable ones', () => {
    const s = summarizeTapeInputStaleness([cell(NOW - 40 * DAY), cell(null)], NOW);
    expect(s.inputStale).toBe(true);
  });

  it('the shipped default threshold sits in the 7–14 day band the ticket pre-registered', () => {
    expect(TAPE_INPUT_STALE_THRESHOLD_DAYS).toBeGreaterThanOrEqual(7);
    expect(TAPE_INPUT_STALE_THRESHOLD_DAYS).toBeLessThanOrEqual(14);
  });
});
