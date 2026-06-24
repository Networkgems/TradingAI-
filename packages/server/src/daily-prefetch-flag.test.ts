import { describe, it, expect } from 'vitest';
import {
  isColdStartDailyPrefetchEnabled,
  resolveColdStartPrefetchPerMin,
  COLD_START_DAILY_PREFETCH_FLAG,
  COLD_START_DAILY_PREFETCH_PER_MIN_VAR,
  DEFAULT_PREFETCH_PER_MIN,
  MAX_PREFETCH_PER_MIN,
} from './daily-prefetch-flag.js';

describe('isColdStartDailyPrefetchEnabled', () => {
  it('is OFF by default (no env) so prod behaviour is unchanged', () => {
    expect(isColdStartDailyPrefetchEnabled({})).toBe(false);
  });

  it('accepts the usual truthy spellings and rejects everything else', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isColdStartDailyPrefetchEnabled({ [COLD_START_DAILY_PREFETCH_FLAG]: v })).toBe(true);
    }
    for (const v of ['0', 'false', 'off', '', 'maybe']) {
      expect(isColdStartDailyPrefetchEnabled({ [COLD_START_DAILY_PREFETCH_FLAG]: v })).toBe(false);
    }
  });
});

describe('resolveColdStartPrefetchPerMin', () => {
  it('defaults when unset or invalid', () => {
    expect(resolveColdStartPrefetchPerMin({})).toBe(DEFAULT_PREFETCH_PER_MIN);
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: 'abc' })).toBe(DEFAULT_PREFETCH_PER_MIN);
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: '0' })).toBe(DEFAULT_PREFETCH_PER_MIN);
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: '-5' })).toBe(DEFAULT_PREFETCH_PER_MIN);
  });

  it('honours a valid budget and floors fractional values', () => {
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: '32' })).toBe(32);
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: '24.9' })).toBe(24);
  });

  it('clamps to the meter-ceiling guardrail so a fat-finger env cannot burst', () => {
    expect(resolveColdStartPrefetchPerMin({ [COLD_START_DAILY_PREFETCH_PER_MIN_VAR]: '9999' })).toBe(MAX_PREFETCH_PER_MIN);
  });
});
