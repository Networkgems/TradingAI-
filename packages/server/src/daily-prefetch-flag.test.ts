import { describe, it, expect } from 'vitest';
import {
  isColdStartDailyPrefetchEnabled,
  resolveColdStartPrefetchPerMin,
  resolveColdStartPrefetchBootDelayMs,
  COLD_START_DAILY_PREFETCH_FLAG,
  COLD_START_DAILY_PREFETCH_PER_MIN_VAR,
  COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR,
  DEFAULT_PREFETCH_PER_MIN,
  MAX_PREFETCH_PER_MIN,
  DEFAULT_PREFETCH_BOOT_DELAY_MS,
  MAX_PREFETCH_BOOT_DELAY_MS,
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

describe('resolveColdStartPrefetchBootDelayMs (TRA-1391)', () => {
  it('defaults (past bootGrace) when unset, empty, or invalid', () => {
    expect(resolveColdStartPrefetchBootDelayMs({})).toBe(DEFAULT_PREFETCH_BOOT_DELAY_MS);
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '' })).toBe(DEFAULT_PREFETCH_BOOT_DELAY_MS);
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '  ' })).toBe(DEFAULT_PREFETCH_BOOT_DELAY_MS);
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: 'abc' })).toBe(DEFAULT_PREFETCH_BOOT_DELAY_MS);
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '-1' })).toBe(DEFAULT_PREFETCH_BOOT_DELAY_MS);
  });

  it('is comfortably past the 120s watchdog bootGrace window by default', () => {
    expect(DEFAULT_PREFETCH_BOOT_DELAY_MS).toBeGreaterThan(120_000);
  });

  it('honours 0 as an explicit opt-out (fire-immediately, pre-TRA-1391 behaviour)', () => {
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '0' })).toBe(0);
  });

  it('honours a valid delay and floors fractional values', () => {
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '90000' })).toBe(90_000);
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '90000.9' })).toBe(90_000);
  });

  it('clamps to the ceiling so the warmer cannot be deferred effectively forever', () => {
    expect(resolveColdStartPrefetchBootDelayMs({ [COLD_START_DAILY_PREFETCH_BOOT_DELAY_MS_VAR]: '99999999' })).toBe(MAX_PREFETCH_BOOT_DELAY_MS);
  });
});
