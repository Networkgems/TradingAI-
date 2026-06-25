// TRA-1157 — proves the agent activity window: the multi-agent advisory layer is
// only allowed to fire 15 min after the equity open until 15 min before the close,
// on weekdays, so the Anthropic bill is not spent overnight or on weekends.
import { describe, it, expect } from 'vitest';
import { isAgentTradingWindowOpen } from './index.js';

// June is EDT (UTC-4), so ET hh:mm => UTC hh:mm + 4.
// 2026-06-25 is a Thursday; 2026-06-27 is a Saturday; 2026-06-28 is a Sunday.
const etThu = (h: number, m: number) => Date.UTC(2026, 5, 25, h + 4, m);
const etSat = (h: number, m: number) => Date.UTC(2026, 5, 27, h + 4, m);

describe('isAgentTradingWindowOpen (15-min buffer)', () => {
  it('is closed before 9:45 ET (open + 15)', () => {
    expect(isAgentTradingWindowOpen(etThu(9, 30))).toBe(false); // the open itself
    expect(isAgentTradingWindowOpen(etThu(9, 44))).toBe(false);
  });

  it('opens at 9:45 ET and stays open mid-session', () => {
    expect(isAgentTradingWindowOpen(etThu(9, 45))).toBe(true);
    expect(isAgentTradingWindowOpen(etThu(12, 0))).toBe(true);
  });

  it('closes at 3:45 ET (close - 15), staying off through the bell', () => {
    expect(isAgentTradingWindowOpen(etThu(15, 44))).toBe(true);
    expect(isAgentTradingWindowOpen(etThu(15, 45))).toBe(false);
    expect(isAgentTradingWindowOpen(etThu(16, 0))).toBe(false); // the close
  });

  it('is closed overnight', () => {
    expect(isAgentTradingWindowOpen(etThu(3, 0))).toBe(false);
    expect(isAgentTradingWindowOpen(etThu(20, 0))).toBe(false);
  });

  it('is closed all day on weekends', () => {
    expect(isAgentTradingWindowOpen(etSat(12, 0))).toBe(false);
  });

  it('honours a custom buffer (e.g. 0 == raw session edges)', () => {
    expect(isAgentTradingWindowOpen(etThu(9, 30), 0)).toBe(true);
    expect(isAgentTradingWindowOpen(etThu(15, 59), 0)).toBe(true);
    expect(isAgentTradingWindowOpen(etThu(16, 0), 0)).toBe(false);
  });
});
