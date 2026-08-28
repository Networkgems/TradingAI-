import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  firmWideDemoFoldScope,
  stampFirmWideDemoFoldScope,
  FIRM_WIDE_DEMO_FOLD_KIND,
  FIRM_WIDE_DEMO_FOLD_CODE,
} from './demo-calendar-fold-provenance.js';

// TRA-4203 — the per-account DEMO calendar serves the firm-wide Desk fold
// (TRA-1572, scoped by TRA-2407) UNLABELLED, so it renders under the "My
// Account" heading indistinguishably from a cell the account actually traded.
// TRA-4199 measured 65% of July 2026's +$3,488.26 and 100% of August's
// -$228.09 to be that fold on live build 092d087775dc.
//
// ⚠️ THE INSTRUMENT REQUIREMENT, same shape as `demo-calendar-fill-scope.test.ts`.
// A predicate-only test here would pass in three states this ticket must be able
// to tell apart:
//
//   (a) the stamp is applied on the fold path            ← the fix
//   (b) the stamp is applied NOWHERE (someone dropped     ← silent regression:
//       the call site but kept the module)                  the cells go bare again
//   (c) the stamp is applied EVERYWHERE (the personal     ← the opposite defect:
//       cell path, or the Desk route)                        every cell says "not
//                                                            yours", which is a lie
//                                                            and trains the reader
//                                                            to ignore the badge
//
// (b) and (c) are properties of the CALL SITE, not of this module, and there is
// no route-level harness in this package. So the last describe block reads
// `index.ts` as text and pins the call site's position inside the fold branch.
// That is a weaker instrument than a route test and it is stated as such — but a
// test that cannot fail in the two directions that matter is not an instrument
// at all, which is this repo's recurring failure shape.

describe('firmWideDemoFoldScope — the stamp itself (TRA-4203)', () => {
  it('is the D badge, a peer of the B/R/E measure codes', () => {
    const s = firmWideDemoFoldScope(1602);
    expect(s.kind).toBe(FIRM_WIDE_DEMO_FOLD_KIND);
    expect(s.code).toBe(FIRM_WIDE_DEMO_FOLD_CODE);
    expect(s.code).toBe('D');
  });

  it('carries the trade count — the cheapest evidence that the cell is firm-wide', () => {
    // July 2026's folded cells sum 1,602 journal trades across every demo book.
    // A personal demo book with no file for the day did not close 1,602 trades.
    expect(firmWideDemoFoldScope(1602).tradeCount).toBe(1602);
    expect(firmWideDemoFoldScope(1602).detail).toContain('1602 trades');
    expect(firmWideDemoFoldScope(1).detail).toContain('1 trade across');
  });

  it('names the admin route serving the identical bytes, so the claim is checkable', () => {
    expect(firmWideDemoFoldScope(5).equivalentTo).toBe('/api/reports/desk/{date}');
    expect(firmWideDemoFoldScope(5).detail).toContain('/api/reports/desk/{date}');
  });

  it('says "not this account" in the detail, in words, not just in a code', () => {
    // The badge is one character; the hover text is where the reader who does
    // not know what `D` means finds out. If this sentence goes away the badge
    // is decoration.
    expect(firmWideDemoFoldScope(3).detail.toLowerCase()).toContain("not this account's money");
  });

  it('is deterministic — no clock, no env, so two stamps of one cell are equal', () => {
    // Load-bearing for the idempotency assertion below and for any future
    // response-cache: a timestamp here would make every re-read a new object.
    expect(firmWideDemoFoldScope(7)).toEqual(firmWideDemoFoldScope(7));
  });

  it('degrades a nonsense count to 0 rather than printing NaN in the UI', () => {
    expect(firmWideDemoFoldScope(Number.NaN).tradeCount).toBe(0);
    expect(firmWideDemoFoldScope(-4).tradeCount).toBe(0);
    expect(firmWideDemoFoldScope(3.7).tradeCount).toBe(3);
  });
});

describe('stampFirmWideDemoFoldScope — applying it to a cell (TRA-4203)', () => {
  const cell = () => ({
    date: '2026-07-02',
    combinedPnl: 1298.55,
    totalTrades: 47,
    trades: [{ symbol: 'NKE' }],
  });

  it('attaches cellScope and changes nothing else', () => {
    const before = cell();
    const after = stampFirmWideDemoFoldScope(before);
    expect(after.cellScope.kind).toBe(FIRM_WIDE_DEMO_FOLD_KIND);
    expect(after.cellScope.tradeCount).toBe(47);
    // ⛔ The ticket's DO-NOT: no change to the fold's arithmetic. A labelling fix
    // whose numbers move is unverifiable against the measurement that motivated it.
    const { cellScope: _drop, ...rest } = after;
    expect(rest).toEqual(before);
  });

  it('does NOT mutate the input cell', () => {
    // `demoJournalCalendarCells()` builds from the shared journal aggregation and
    // the same shape is served by the admin Desk route. An in-place write would
    // leak "not your money" onto the view where that label is false.
    const before = cell();
    stampFirmWideDemoFoldScope(before);
    expect('cellScope' in before).toBe(false);
  });

  it('is idempotent — a second stamp cannot contradict the first', () => {
    const once = stampFirmWideDemoFoldScope(cell());
    const twice = stampFirmWideDemoFoldScope(once);
    expect(twice).toEqual(once);
  });

  it('a cell with no totalTrades still stamps, with a count of 0', () => {
    const bare: { date: string; totalTrades?: number } = { date: '2026-08-03' };
    const s = stampFirmWideDemoFoldScope(bare);
    expect(s.cellScope.tradeCount).toBe(0);
  });
});

// ── The call site (see the header note on why this is read as text) ──────────

describe('the stamp is co-extensive with the fold — call-site pin (TRA-4203)', () => {
  const indexTs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
    'utf-8',
  );

  it('is imported, and invoked from exactly ONE place', () => {
    expect(indexTs).toContain("from './reports/demo-calendar-fold-provenance.js'");
    // Count INVOCATIONS, not mentions — the fold branch also names the function
    // in prose, and a mention is not a surface. More than one call means a
    // second surface is being labelled, which should be a deliberate edit to
    // this test rather than something that slips in.
    const calls = indexTs.match(/stampFirmWideDemoFoldScope\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it('the one call sits inside the shouldServeFirmWideDemoFold branch', () => {
    const gate = indexTs.indexOf('shouldServeFirmWideDemoFold(mode,');
    expect(gate).toBeGreaterThan(-1);
    const call = indexTs.indexOf('stampFirmWideDemoFoldScope(cell)');
    expect(call).toBeGreaterThan(gate);
    // The fold branch is a couple of dozen lines. A call site further away than
    // that is on some other path.
    expect(indexTs.slice(gate, call).split('\n').length).toBeLessThan(30);
  });

  it('the personal-report response is NOT stamped', () => {
    // The last `res.json` of `/api/reports/:date` serves the account's own file
    // through the audit stampers. If the scope stamp ever appears there, every
    // ordinary cell would claim to be someone else's money.
    const personal = indexTs.indexOf('await stampBrokerSourceAudit(ctx, mode, await stampStaleBalanceAnchorAudit(');
    expect(personal).toBeGreaterThan(-1);
    expect(
      indexTs.slice(personal, personal + 400).includes('stampFirmWideDemoFoldScope'),
    ).toBe(false);
  });

  it('the admin Desk route is NOT stamped', () => {
    // `/api/reports/desk/:date` is already titled "Desk" and admin-gated.
    // Badging it would train the reader to ignore the badge where it informs.
    const desk = indexTs.indexOf("app.get('/api/reports/desk/:date'");
    expect(desk).toBeGreaterThan(-1);
    const nextRoute = indexTs.indexOf("app.get('/api/reports/:date'", desk);
    expect(nextRoute).toBeGreaterThan(desk);
    expect(indexTs.slice(desk, nextRoute).includes('stampFirmWideDemoFoldScope')).toBe(false);
  });
});
