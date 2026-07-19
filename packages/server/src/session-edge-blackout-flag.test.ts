import { describe, it, expect } from 'vitest';
import {
  isSessionEdgeBlackoutEnabled,
  resolveSessionEdgeBlackoutMinutes,
  sessionEdgeAt,
  sessionEdgeBlackoutVerdict,
  SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES,
} from './session-edge-blackout-flag.js';

// TRA-2049 (parent TRA-2044) — the edge-of-session entry blackout.
//
// All timestamps are built for a SUMMER weekday (Mon 2026-07-20, EDT = UTC-4), so
// ET clock time = UTC hour - 4. Sat 2026-07-18 anchors the weekend cases. The
// helpers under test share `getEasternUtcOffset`, so the mapping is self-consistent.
const ARMED = { ENABLE_SESSION_EDGE_BLACKOUT: '1' } as const;

/** ET wall-clock (Mon 2026-07-20) → epoch ms. EDT ⇒ UTC = ET + 4h. */
function etMon(hour: number, minute: number): number {
  return Date.UTC(2026, 6, 20, hour + 4, minute);
}
/** ET wall-clock on Sat 2026-07-18 (weekend) → epoch ms. */
function etSat(hour: number, minute: number): number {
  return Date.UTC(2026, 6, 18, hour + 4, minute);
}

describe('isSessionEdgeBlackoutEnabled', () => {
  it('is STANDALONE — off by default, accepts truthy spellings', () => {
    expect(isSessionEdgeBlackoutEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isSessionEdgeBlackoutEnabled({ ENABLE_SESSION_EDGE_BLACKOUT: v })).toBe(true);
    }
    expect(isSessionEdgeBlackoutEnabled({ ENABLE_SESSION_EDGE_BLACKOUT: 'off' })).toBe(false);
    expect(isSessionEdgeBlackoutEnabled({ ENABLE_SESSION_EDGE_BLACKOUT: '0' })).toBe(false);
  });
});

describe('resolveSessionEdgeBlackoutMinutes', () => {
  it('defaults both edges to 3 when unset', () => {
    expect(resolveSessionEdgeBlackoutMinutes({})).toEqual({ openMinutes: 3, closeMinutes: 3 });
    expect(SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES).toBe(3);
  });

  it('honours valid integer overrides independently, floors a fractional one', () => {
    expect(
      resolveSessionEdgeBlackoutMinutes({
        SESSION_EDGE_BLACKOUT_OPEN_MINUTES: '5',
        SESSION_EDGE_BLACKOUT_CLOSE_MINUTES: '10',
      }),
    ).toEqual({ openMinutes: 5, closeMinutes: 10 });
    expect(
      resolveSessionEdgeBlackoutMinutes({ SESSION_EDGE_BLACKOUT_OPEN_MINUTES: '4.9' }).openMinutes,
    ).toBe(4);
  });

  it('honours an explicit 0 as "disable this edge"', () => {
    expect(
      resolveSessionEdgeBlackoutMinutes({
        SESSION_EDGE_BLACKOUT_OPEN_MINUTES: '0',
        SESSION_EDGE_BLACKOUT_CLOSE_MINUTES: '0',
      }),
    ).toEqual({ openMinutes: 0, closeMinutes: 0 });
  });

  it('falls back to the default on malformed / negative values (never silently 0-disables)', () => {
    for (const bad of ['', 'abc', '-2', '-0.5']) {
      expect(
        resolveSessionEdgeBlackoutMinutes({ SESSION_EDGE_BLACKOUT_OPEN_MINUTES: bad }).openMinutes,
      ).toBe(SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES);
    }
  });
});

describe('sessionEdgeAt (pure geometry, default 3-min edges)', () => {
  it('flags the OPEN edge: the 9:30 bell through 9:32, releasing at 9:33', () => {
    expect(sessionEdgeAt(etMon(9, 30), 3, 3)).toBe('open'); // sinceOpen 0
    expect(sessionEdgeAt(etMon(9, 32), 3, 3)).toBe('open'); // sinceOpen 2
    expect(sessionEdgeAt(etMon(9, 33), 3, 3)).toBe(null); // sinceOpen 3 → interior
  });

  it('flags the CLOSE edge: the last 3 minutes up to 16:00, clear at 15:56', () => {
    expect(sessionEdgeAt(etMon(15, 56), 3, 3)).toBe(null); // toClose 4
    expect(sessionEdgeAt(etMon(15, 57), 3, 3)).toBe('close'); // toClose 3
    expect(sessionEdgeAt(etMon(15, 59), 3, 3)).toBe('close'); // toClose 1
  });

  it('returns null in the interior', () => {
    expect(sessionEdgeAt(etMon(12, 0), 3, 3)).toBe(null);
  });

  it('never fires outside regular hours (pre-open / post-close / weekend)', () => {
    expect(sessionEdgeAt(etMon(9, 29), 3, 3)).toBe(null); // pre-open
    expect(sessionEdgeAt(etMon(16, 0), 3, 3)).toBe(null); // at close (RTH ended)
    expect(sessionEdgeAt(etMon(8, 0), 3, 3)).toBe(null); // premarket
    expect(sessionEdgeAt(etSat(12, 0), 3, 3)).toBe(null); // weekend
  });

  it('a 0-width edge disables just that edge', () => {
    expect(sessionEdgeAt(etMon(9, 30), 0, 3)).toBe(null); // open edge off
    expect(sessionEdgeAt(etMon(15, 59), 3, 0)).toBe(null); // close edge off
    expect(sessionEdgeAt(etMon(15, 59), 3, 3)).toBe('close'); // both on → still fires
  });

  it('widens with a larger configured edge', () => {
    expect(sessionEdgeAt(etMon(9, 34), 3, 3)).toBe(null); // interior at 3 min
    expect(sessionEdgeAt(etMon(9, 34), 10, 3)).toBe('open'); // inside a 10-min open edge
  });
});

describe('sessionEdgeBlackoutVerdict', () => {
  it('is a byte-for-byte no-op when disarmed, even inside an edge', () => {
    const v = sessionEdgeBlackoutVerdict(etMon(9, 30), {});
    expect(v.blocked).toBe(false);
    expect(v.enabled).toBe(false);
    expect(v.edge).toBe(null); // never even computes an edge while disarmed
  });

  it('blocks a NEW entry inside the open edge when armed', () => {
    const v = sessionEdgeBlackoutVerdict(etMon(9, 31), ARMED);
    expect(v).toMatchObject({ blocked: true, edge: 'open', enabled: true, openMinutes: 3, closeMinutes: 3 });
  });

  it('blocks a NEW entry inside the close edge when armed', () => {
    expect(sessionEdgeBlackoutVerdict(etMon(15, 58), ARMED).blocked).toBe(true);
    expect(sessionEdgeBlackoutVerdict(etMon(15, 58), ARMED).edge).toBe('close');
  });

  it('permits an interior entry, and any entry outside RTH, when armed', () => {
    expect(sessionEdgeBlackoutVerdict(etMon(12, 0), ARMED).blocked).toBe(false);
    expect(sessionEdgeBlackoutVerdict(etMon(9, 29), ARMED).blocked).toBe(false);
    expect(sessionEdgeBlackoutVerdict(etSat(12, 0), ARMED).blocked).toBe(false);
  });

  it('respects per-edge width overrides', () => {
    const env = { ...ARMED, SESSION_EDGE_BLACKOUT_OPEN_MINUTES: '0', SESSION_EDGE_BLACKOUT_CLOSE_MINUTES: '5' };
    expect(sessionEdgeBlackoutVerdict(etMon(9, 30), env).blocked).toBe(false); // open edge disabled
    expect(sessionEdgeBlackoutVerdict(etMon(15, 56), env).blocked).toBe(true); // toClose 4 ≤ 5
    expect(sessionEdgeBlackoutVerdict(etMon(15, 56), env).edge).toBe('close');
  });
});
