/**
 * TRA-3713 — unit controls for the BACKWARD cron evaluator.
 *
 * `check:slot-loss --selftest` grades the DETECTOR against whole routine rows. This
 * grades the PRIMITIVE underneath it, where the timezone and DST answers live and where
 * a wrong answer is a plausible-looking number rather than a crash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCron, previousSlotAtOrBefore, nextSlotAtOrAfter, attributeSlot, wallToUtc, partsIn } from './cron-slot.mjs';

const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);

test('the pre-registered LATE row: an annual one-shot resolves to its 2026 slot, not its 2027 nextRunAt', () => {
  const r = previousSlotAtOrBefore('50 17 13 8 *', 'America/New_York', at('2026-08-14T00:21:25.309Z'));
  assert.ok(r.ok);
  assert.equal(iso(r.slotMs), '2026-08-13T21:50:00.000Z');
  assert.equal(at('2026-08-14T00:21:25.309Z') - r.slotMs, 9085309); // 2h31m25.309s — the measured lateness
});

test('the pre-registered ON-TIME row resolves to the same-minute slot', () => {
  const r = previousSlotAtOrBefore('30 16 * * 1-5', 'America/New_York', at('2026-08-13T20:30:18.251Z'));
  assert.ok(r.ok);
  assert.equal(iso(r.slotMs), '2026-08-13T20:30:00.000Z');
});

test('the timezone is read, not assumed — the SAME cron and fire differ by 4h between ET and UTC', () => {
  const et = previousSlotAtOrBefore('50 17 13 8 *', 'America/New_York', at('2026-08-14T00:21:25.309Z'));
  const utc = previousSlotAtOrBefore('50 17 13 8 *', 'UTC', at('2026-08-14T00:21:25.309Z'));
  assert.equal(iso(et.slotMs), '2026-08-13T21:50:00.000Z');
  assert.equal(iso(utc.slotMs), '2026-08-13T17:50:00.000Z');
  assert.notEqual(et.slotMs, utc.slotMs);
});

test('a missing timezone is refused, never silently graded as UTC', () => {
  const r = previousSlotAtOrBefore('30 16 * * 1-5', null, at('2026-08-13T20:30:18.251Z'));
  assert.equal(r.ok, false);
  assert.match(r.error, /timezone/i);
});

test('DST GAP — 02:00 on 2026-03-08 does not exist in New York and is never invented', () => {
  const w = wallToUtc('America/New_York', 2026, 3, 8, 2, 0);
  assert.equal(w.ok, false);
  assert.match(w.error, /does not exist/);
  // A daily 02:00 cron therefore skips that day entirely rather than firing a phantom slot.
  const r = previousSlotAtOrBefore('0 2 * * *', 'America/New_York', at('2026-03-08T12:00:00Z'));
  assert.ok(r.ok);
  assert.equal(iso(r.slotMs), '2026-03-07T07:00:00.000Z');
});

test('DST FALL-BACK — an ambiguous 01:00 on 2026-11-01 resolves to the FIRST occurrence, deterministically', () => {
  const r = previousSlotAtOrBefore('0 1 * * *', 'America/New_York', at('2026-11-01T09:00:00Z'));
  assert.ok(r.ok);
  assert.equal(iso(r.slotMs), '2026-11-01T05:00:00.000Z'); // 01:00 EDT, not 01:00 EST (06:00Z)
});

test('midnight is hour 0, never hour 24 — a 24 would push every derivation back a full day', () => {
  assert.equal(partsIn('UTC', at('2026-08-14T00:21:00Z')).h, 0);
});

test('unsupported cron forms are REFUSED rather than mis-parsed', () => {
  assert.equal(parseCron('0 12 * * MON').ok, false);
  assert.equal(parseCron('@daily').ok, false);
  assert.equal(parseCron('0 12 * *').ok, false);
  assert.equal(parseCron('99 12 * * *').ok, false);
  // dom AND dow both restricted: Vixie ORs, others AND, and the row does not say which.
  assert.equal(parseCron('0 12 13 * 1').ok, false);
});

test('step and list forms parse', () => {
  const r = previousSlotAtOrBefore('*/15 * * * *', 'UTC', at('2026-08-14T00:21:19.151Z'));
  assert.equal(iso(r.slotMs), '2026-08-14T00:15:00.000Z');
  const r2 = previousSlotAtOrBefore('0 13,22 * * *', 'UTC', at('2026-08-14T00:21:25.840Z'));
  assert.equal(iso(r2.slotMs), '2026-08-13T22:00:00.000Z');
});

test('the forward solve finds the slot a fire precedes', () => {
  const r = nextSlotAtOrAfter('45 21 14 8 *', 'America/New_York', at('2026-08-14T01:20:56.442Z'));
  assert.ok(r.ok);
  assert.equal(iso(r.slotMs), '2026-08-15T01:45:00.000Z');
});

// ── attributeSlot: WHICH slot a fire belongs to ──────────────────────────────

test('ATTRIBUTION — a weekly replay nearer to the NEXT slot is still LATE off the one it missed', () => {
  // 81928e50, measured: `30 16 * * 5` ET, fired Tue 2026-08-11T13:30:39Z.
  // prev = Fri 08-07 20:30Z (3d17h back); next = Fri 08-14 20:30Z (3d7h ahead).
  // NEAREST would say "early". `nextRunAt` still points AT 08-14, so it was never consumed.
  const r = attributeSlot('30 16 * * 5', 'America/New_York', at('2026-08-11T13:30:39.298Z'), {
    notBeforeMs: at('2026-06-19T13:08:02.561Z'),
    nextRunAtMs: at('2026-08-14T20:30:00.000Z'),
  });
  assert.ok(r.ok);
  assert.equal(r.direction, 'late');
  assert.equal(iso(r.slotMs), '2026-08-07T20:30:00.000Z');
});

test('ATTRIBUTION — a future slot counts only once nextRunAt has moved BEYOND it', () => {
  const r = attributeSlot('30 16 * * 5', 'America/New_York', at('2026-08-14T18:00:00.000Z'), {
    notBeforeMs: at('2026-08-10T00:00:00.000Z'),
    nextRunAtMs: at('2026-08-21T20:30:00.000Z'),
  });
  assert.ok(r.ok);
  assert.equal(r.direction, 'early');
  assert.equal(iso(r.slotMs), '2026-08-14T20:30:00.000Z');
});

test('CREATION FLOOR — a slot predating the routine is inadmissible, and with no admissible slot the fire is UNATTRIBUTABLE', () => {
  // d038b618, measured: fired while its ONLY slot was still armed, created after the previous one.
  const r = attributeSlot('45 21 14 8 *', 'America/New_York', at('2026-08-14T01:20:56.442Z'), {
    notBeforeMs: at('2026-08-13T11:06:05.512Z'),
    nextRunAtMs: at('2026-08-15T01:45:00.000Z'),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /PREDATES the routine's own creation/);
  assert.match(r.error, /still ARMED/);
});

test('CREATION FLOOR NEGATIVE — the same fire with an earlier creation DOES attribute to the past slot', () => {
  const r = attributeSlot('40 21 * * 1', 'America/New_York', at('2026-08-14T01:40:09.111Z'), {
    notBeforeMs: at('2026-07-01T00:00:00.000Z'),
    nextRunAtMs: at('2026-08-18T01:40:00.000Z'),
  });
  assert.ok(r.ok);
  assert.equal(r.direction, 'late');
  assert.equal(iso(r.slotMs), '2026-08-11T01:40:00.000Z');
});

test('TOLERANCE — a fire 2s ahead of its slot is that slot, not a full cadence of lateness off the previous one', () => {
  const r = attributeSlot('30 16 * * 1-5', 'America/New_York', at('2026-08-13T20:29:58.000Z'), {
    notBeforeMs: at('2026-08-01T00:00:00.000Z'),
    earlyToleranceMs: 300_000,
  });
  assert.ok(r.ok);
  assert.equal(r.direction, 'early');
  assert.equal(iso(r.slotMs), '2026-08-13T20:30:00.000Z');
  assert.equal(r.deltaMs, 2000);
});
