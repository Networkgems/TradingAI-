// TRA-1682 (parent TRA-1680 → TRA-1677) — the entry-greeks gate's admit/reject tally.
//
// What these tests are really defending: TRA-1677 shipped an entry gate whose admissible
// set was ALGEBRAICALLY EMPTY (a [0.30,0.40] short-premium delta band applied to a sleeve
// whose selector cannot emit |Δ| below 0.45). It rejected 100% of candidates for a week
// and NOBODY SAW IT — because a gate that rejects everything and a tape that offers
// nothing produce the same observable (no fills) when nothing counts the admit rate.
// These tests pin the counter that tells those two apart.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordEntryGreeksVerdict,
  hydrateEntryGreeksGateFromDisk,
  summarizeEntryGreeksGate,
  clearEntryGreeksLedger,
  entryGreeksLogPath,
} from './entry-greeks-ledger.js';

const DAY = '2026-07-10';
const OTHER_DAY = '2026-07-09';
const T = Date.parse('2026-07-10T14:30:00Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra1682-'));
  clearEntryGreeksLedger();
});
afterEach(() => {
  clearEntryGreeksLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordEntryGreeksVerdict — per-ET-day admit + reject-by-reason tally', () => {
  it('counts admits and rejects separately, keyed by reason', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'delta_theta_ratio_too_low', DAY, 'rv-long', T);

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.admitted).toBe(2);
    expect(s.rejectedByReason).toEqual({
      delta_out_of_band: 2,
      delta_theta_ratio_too_low: 1,
    });
    expect(s.rejectedTotal).toBe(3);
    expect(s.evaluated).toBe(5);
    expect(s.admitRate).toBe(0.4);
    expect(s.starving).toBe(false);
  });

  it('does not bleed across ET days (a stale day never colours the current read)', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(true, null, OTHER_DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);

    expect(summarizeEntryGreeksGate(DAY).admitted).toBe(0);
    expect(summarizeEntryGreeksGate(DAY).rejectedTotal).toBe(1);
    expect(summarizeEntryGreeksGate(OTHER_DAY).admitted).toBe(1);
    expect(summarizeEntryGreeksGate(OTHER_DAY).rejectedTotal).toBe(0);
  });

  it('an UNRECOGNIZED reject reason buckets under `unknown` rather than vanishing', () => {
    // An uncounted reject is the precise blindness this ledger exists to end, so a
    // future engine-side reason we do not know about must still show up in the total.
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(false, 'some_new_reason_from_a_later_engine', DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, null, DAY, 'rv-long', T); // reject with no reason at all

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.rejectedByReason).toEqual({ unknown: 2 });
    expect(s.rejectedTotal).toBe(2);
    expect(s.evaluated).toBe(2);
  });

  it('records with NO dataDir configured (unit/CLI) — in-memory counts still move', () => {
    // Never hydrated ⇒ dataDir null. Must not throw, must still count.
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    expect(summarizeEntryGreeksGate(DAY).rejectedTotal).toBe(1);
  });
});

describe('starving — the TRA-1677 signature (armed gate, empty admissible set)', () => {
  it('an ALL-REJECT session reads starving=true with admitRate 0 (suspect the GATE)', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    // Exactly the TRA-1677 shape: every RV long |Δ| ≥ 0.45 vs a [0.30,0.40] band ⇒ 100%
    // `delta_out_of_band`. This is the number that would have caught it in one read.
    for (let i = 0; i < 40; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.evaluated).toBe(40);
    expect(s.admitted).toBe(0);
    expect(s.admitRate).toBe(0);
    expect(s.starving).toBe(true);
  });

  it('a gate that evaluated NOTHING is NOT starving — admitRate is null, not 0', () => {
    // The distinction the whole ticket turns on: "no candidates reached the gate" and
    // "the gate refused every candidate" must NEVER read the same. A 0 here would
    // recreate the exact ambiguity that hid the impossible band for a week.
    hydrateEntryGreeksGateFromDisk(dir, T);
    const s = summarizeEntryGreeksGate(DAY);
    expect(s.evaluated).toBe(0);
    expect(s.admitRate).toBeNull();
    expect(s.starving).toBe(false);
  });

  it('one admit is enough to clear starving', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    for (let i = 0; i < 10; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    expect(summarizeEntryGreeksGate(DAY).starving).toBe(false);
  });
});

describe('TRA-3682 state — `starving: false` is TWO different worlds, and they must not render alike', () => {
  // The defect: on 2026-08-13 `single_leg_rv` published
  //   evaluated 0 · admitted 0 · rejectedTotal 0 · admitRate null · starving false
  // while its producer had been compile-time OFF since 2026-06-30 (TRA-1207). Every
  // field is individually correct; the COMPOSITE reads as "healthy, quiet day".
  // `state` is the field that has to say the difference out loud.

  it('UNFED: nothing reached the gate ⇒ no_candidates, NOT a clean bill of health', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    const s = summarizeEntryGreeksGate(DAY);
    // The exact live shape from the ticket, asserted as a unit.
    expect(s.evaluated).toBe(0);
    expect(s.starving).toBe(false);
    expect(s.admitRate).toBeNull();
    // ...and the field that stops that shape reading as OK.
    expect(s.state).toBe('no_candidates');
  });

  it('THE DISCRIMINATOR: unfed and all-reject BOTH differ, and differ from each other', () => {
    // Vacuity control. A `state` hardcoded to any single literal passes one of the
    // three assertions below and fails the other two, so this test cannot green on a
    // constant — which is the failure mode the flag it replaces actually had.
    hydrateEntryGreeksGateFromDisk(dir, T);
    expect(summarizeEntryGreeksGate(DAY).state).toBe('no_candidates');

    for (let i = 0; i < 40; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    const rejecting = summarizeEntryGreeksGate(DAY);
    expect(rejecting.state).toBe('starving');
    // Both worlds are now distinguishable by `state` alone...
    expect(rejecting.state).not.toBe('no_candidates');
    // ...where `admitted` alone still cannot tell them apart.
    expect(rejecting.admitted).toBe(0);
  });

  it('a working gate reads live_firing; an all-admit gate reads live_clean', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    expect(summarizeEntryGreeksGate(DAY).state).toBe('live_clean');

    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    expect(summarizeEntryGreeksGate(DAY).state).toBe('live_firing');
  });

  it('state is DERIVED, so it can never contradict the counters beside it', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    for (let i = 0; i < 3; i++) recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    for (let i = 0; i < 7; i++) recordEntryGreeksVerdict(false, 'theta_ratio_floor', DAY, 'rv-long', T);

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.state).toBe('live_firing');
    expect(s.evaluated).toBe(s.admitted + s.rejectedTotal);
    expect(s.state === 'no_candidates').toBe(s.evaluated === 0);
    expect(s.state === 'starving').toBe(s.starving);
  });

  it('survives the reboot: a hydrated all-reject day still reads starving, not no_candidates', () => {
    // `state` must be recomputed from the DURABLE counters, not from since-boot memory —
    // otherwise a restart silently downgrades a real starve ("suspect the gate") into
    // no_candidates ("suspect the producer"), pointing the next reader at the wrong layer.
    hydrateEntryGreeksGateFromDisk(dir, T);
    for (let i = 0; i < 5; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    expect(summarizeEntryGreeksGate(DAY).state).toBe('starving');

    clearEntryGreeksLedger(); // the reboot
    // Positive control on the reboot itself: with the ledger cleared and nothing
    // re-read, the state MUST collapse to no_candidates — so the post-hydrate
    // assertion below is carried by the disk, not by surviving memory.
    expect(summarizeEntryGreeksGate(DAY).state).toBe('no_candidates');

    hydrateEntryGreeksGateFromDisk(dir, T + 6 * 60 * 60 * 1000);
    expect(summarizeEntryGreeksGate(DAY).state).toBe('starving');
  });
});

describe('durability across the daily-close reboot', () => {
  it('rebuilds the ET day tally from disk (the post-close grade reads the RTH session)', () => {
    // bqb1 reboots at/after the close. An in-memory since-boot counter is already `{}`
    // by the time a post-close grading fire reads it — which is why TRA-1564 B1 had to
    // make the directional gate's rejects durable, and why these must be too.
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(true, null, DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    recordEntryGreeksVerdict(false, 'non_finite_greeks', DAY, 'rv-long', T);

    // ── reboot ──
    clearEntryGreeksLedger();
    expect(summarizeEntryGreeksGate(DAY).evaluated).toBe(0); // gone from memory…

    const h = hydrateEntryGreeksGateFromDisk(dir, T + 6 * 60 * 60 * 1000); // …post-close read
    expect(h.admitted).toBe(1);
    expect(h.rejects).toBe(2);
    expect(h.days).toBe(1);

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.admitted).toBe(1);
    expect(s.rejectedByReason).toEqual({ delta_out_of_band: 1, non_finite_greeks: 1 });
    expect(s.evaluated).toBe(3);
    expect(s.admitRate).toBe(0.3333);
  });

  it('an all-reject session survives the reboot still reading starving=true', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    for (let i = 0; i < 12; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    clearEntryGreeksLedger();
    hydrateEntryGreeksGateFromDisk(dir, T + 6 * 60 * 60 * 1000);

    const s = summarizeEntryGreeksGate(DAY);
    expect(s.starving).toBe(true);
    expect(s.admitRate).toBe(0);
    expect(s.rejectedByReason).toEqual({ delta_out_of_band: 12 });
  });

  it('drops records older than the retention window and COMPACTS the file', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    const stale = T - 5 * 24 * 60 * 60 * 1000; // > 3d retain
    recordEntryGreeksVerdict(true, null, '2026-07-05', 'rv-long', stale);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);

    const h = hydrateEntryGreeksGateFromDisk(dir, T);
    expect(h.admitted).toBe(0); // the 5-day-old admit aged out
    expect(h.rejects).toBe(1);
    expect(summarizeEntryGreeksGate('2026-07-05').evaluated).toBe(0);

    const lines = readFileSync(entryGreeksLogPath(dir), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // file really was rewritten, not just filtered on read
  });

  it('survives a torn/corrupt trailing line rather than throwing', () => {
    hydrateEntryGreeksGateFromDisk(dir, T);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', DAY, 'rv-long', T);
    // Simulate a half-flushed append at reboot.
    writeFileSync(entryGreeksLogPath(dir), readFileSync(entryGreeksLogPath(dir), 'utf8') + '{"ts":123,"etDa', 'utf8');

    const h = hydrateEntryGreeksGateFromDisk(dir, T);
    expect(h.rejects).toBe(1);
    expect(summarizeEntryGreeksGate(DAY).rejectedTotal).toBe(1);
  });

  it('a missing file hydrates to an empty tally (fresh boot)', () => {
    const h = hydrateEntryGreeksGateFromDisk(dir, T);
    expect(h).toEqual({ days: 0, admitted: 0, rejects: 0 });
    expect(summarizeEntryGreeksGate(DAY).evaluated).toBe(0);
  });
});
