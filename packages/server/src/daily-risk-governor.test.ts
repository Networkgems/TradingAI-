import { describe, it, expect } from 'vitest';
import { DailyRiskGovernor } from './signal-engine.js';
import { etDateString } from './scheduler.js';

// TRA-407 (C3) — the daily risk governor must roll its "trading day" on the
// ET calendar date, not the UTC date. These tests pin the day-boundary
// behaviour so a halt set in the ET evening survives UTC-midnight.

describe('etDateString — TRA-407 ET-correct calendar date', () => {
  it('returns the ET date, not the UTC date, inside the UTC-midnight→ET-midnight window', () => {
    // 01:00 UTC on 2026-05-18 is 21:00 EDT on 2026-05-17. The UTC date has
    // already rolled to the 18th; the ET date is still the 17th — exactly the
    // window where a UTC-date governor reset the trading day too early.
    const instant = new Date('2026-05-18T01:00:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-05-18'); // the buggy UTC value
    expect(etDateString(instant)).toBe('2026-05-17'); // the ET-correct value
  });

  it('rolls the ET date only at ET-midnight (04:00 UTC during EDT)', () => {
    expect(etDateString(new Date('2026-05-18T03:59:00Z'))).toBe('2026-05-17'); // 23:59 ET 05-17
    expect(etDateString(new Date('2026-05-18T04:00:00Z'))).toBe('2026-05-18'); // 00:00 ET 05-18
  });
});

describe('DailyRiskGovernor — TRA-407 (C3) day boundary', () => {
  it('does not drop a halt at UTC-midnight while the ET trading day is still in progress', () => {
    // Start in the ET evening: 21:00 ET on 2026-05-17 = 01:00 UTC on 05-18.
    let now = new Date('2026-05-18T01:00:00Z');
    const gov = new DailyRiskGovernor(() => now);

    // Three consecutive losses trip the loss-streak halt.
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    expect(gov.isHalted()).toBe(true);

    // Advance past UTC-midnight but stay on the same ET day (23:30 ET 05-17).
    // A UTC-date governor would see "2026-05-18" here, reset, and re-enable
    // new entries hours before the ET trading day actually ended.
    now = new Date('2026-05-18T03:30:00Z');
    expect(gov.isHalted()).toBe(true);

    // Crossing ET-midnight (00:30 ET 05-18 = 04:30 UTC) resets the new day.
    now = new Date('2026-05-18T04:30:00Z');
    expect(gov.isHalted()).toBe(false);
    expect(gov.getHaltReason()).toBeNull();
  });

  it('resets the loss streak on the new ET trading day, not at UTC-midnight', () => {
    let now = new Date('2026-05-18T03:00:00Z'); // 23:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.recordTrade(-50, 10_000);
    gov.recordTrade(-50, 10_000);
    expect(gov.isHalted()).toBe(false); // 2 losses — under the 3-streak cap

    // New ET trading day: 01:00 ET on 05-18. The streak must reset here, so
    // the next loss is #1 of the new day — not #3 of a streak carried over.
    now = new Date('2026-05-18T05:00:00Z');
    gov.recordTrade(-50, 10_000);
    expect(gov.isHalted()).toBe(false);
  });

  it('keeps a same-ET-day halt across a UTC date change with no clock injection drift', () => {
    let now = new Date('2026-05-18T02:00:00Z'); // 22:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    // isHalted() also runs the day-roll check — confirm it does not reset
    // while the ET day is unchanged even though the UTC date already moved.
    now = new Date('2026-05-18T03:45:00Z'); // 23:45 ET 05-17
    expect(gov.isHalted()).toBe(true);
  });
});

// TRA-526 — global kill switch: the deterministic master override. Unlike the
// automatic daily circuit-breakers, it is operator-engaged and must NOT clear
// on the ET day roll — a safety stop that silently lifts overnight is worse
// than no stop at all.
describe('DailyRiskGovernor — TRA-526 global kill switch', () => {
  it('halts immediately on a clean slate when engaged, with the supplied reason', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    expect(gov.isHalted()).toBe(false);
    gov.engageKillSwitch('Manual halt — volatile open');
    expect(gov.isKillSwitchEngaged()).toBe(true);
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toBe('Manual halt — volatile open');
  });

  it('falls back to a default reason when none is supplied', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.engageKillSwitch();
    expect(gov.getHaltReason()).toMatch(/kill switch/i);
  });

  it('overrides the daily counters — engaging and then releasing reveals the underlying state', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.engageKillSwitch('stop everything');
    expect(gov.isHalted()).toBe(true);
    gov.releaseKillSwitch();
    // No daily halt was tripped, so releasing the switch returns to running.
    expect(gov.isHalted()).toBe(false);
    expect(gov.getHaltReason()).toBeNull();
  });

  it('does NOT clear on the ET day roll (persists overnight until released)', () => {
    let now = new Date('2026-05-18T01:00:00Z'); // 21:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.engageKillSwitch('halt over the weekend');
    expect(gov.isHalted()).toBe(true);
    // Cross ET-midnight into the next trading day — daily counters would reset
    // here, but the kill switch must remain engaged.
    now = new Date('2026-05-18T05:00:00Z'); // 01:00 ET 05-18
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toBe('halt over the weekend');
  });

  it('takes precedence over an underlying daily halt in getHaltReason', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000); // daily loss-streak halt
    expect(gov.getHaltReason()).toMatch(/consecutive losses/i);
    gov.engageKillSwitch('operator override');
    expect(gov.getHaltReason()).toBe('operator override');
    // Releasing the kill switch reveals the still-active daily halt.
    gov.releaseKillSwitch();
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/consecutive losses/i);
  });
});
