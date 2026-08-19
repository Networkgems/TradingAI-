// TRA-3848 — arms for the stock EOD report's market-day gate.
//
// Read as PAIRS, per the ticket's acceptance 3. A gate that refuses everything is
// exactly as useless as no gate, and a refusal arm on its own cannot tell the two
// apart. Every "refused" assertion below is followed by the adjacent session
// writing over the same inputs.
//
// These grade against the REAL `isMarketDayIso` and the REAL holiday table on
// purpose — an injected fake calendar would pass whether or not the deployed
// predicate agrees with it, and writer/reader calendar drift IS the defect class
// (TRA-3267, TRA-3844, TRA-3847).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideEodReportWrite } from './eod-write-gate.js';
import { isMarketDayIso, missedTradingDays } from '../scheduler.js';

/** Noon ET on the given ET date, expressed as the UTC instant. EDT = UTC-4. */
const noonEtOn = (iso: string) => new Date(`${iso}T16:00:00Z`);

describe('TRA-3848 decideEodReportWrite — non-session dates are refused', () => {
  it('refuses a SATURDAY and writes the FRIDAY beside it', () => {
    const sat = decideEodReportWrite({}, noonEtOn('2026-08-15'));
    expect(sat.write).toBe(false);
    expect(sat.date).toBe('2026-08-15');
    expect(sat.write === false && sat.skipReason).toBe('non_market_day');

    const fri = decideEodReportWrite({}, noonEtOn('2026-08-14'));
    expect(fri.write).toBe(true);
    expect(fri.date).toBe('2026-08-14');
  });

  it('refuses a SUNDAY and writes the MONDAY beside it', () => {
    // 2026-08-09 is the Sunday the live ledger census found booked across 63
    // books (the TRA-3267 host-local-weekday mechanism). This gate refuses it.
    expect(decideEodReportWrite({}, noonEtOn('2026-08-09')).write).toBe(false);
    expect(decideEodReportWrite({}, noonEtOn('2026-08-10')).write).toBe(true);
  });

  it('refuses a HOLIDAY that falls on a MONDAY — so the predicate is the calendar, not day-of-week', () => {
    // Labor Day 2026-09-07 is a Monday. A weekday-only gate passes it; this one
    // must not, or the gate is a weekend filter wearing a calendar's name.
    expect(isMarketDayIso('2026-09-07')).toBe(false);
    const labor = decideEodReportWrite({}, noonEtOn('2026-09-07'));
    expect(labor.write).toBe(false);
    expect(labor.write === false && labor.skipReason).toBe('non_market_day');

    const tue = decideEodReportWrite({}, noonEtOn('2026-09-08'));
    expect(tue.write).toBe(true);
    expect(tue.date).toBe('2026-09-08');
  });

  it('refuses a malformed asOfDate rather than filing a cell under an unresolvable name', () => {
    for (const bad of ['2026-8-14', 'yesterday', '', '2026-08-14T00:00:00Z']) {
      const d = decideEodReportWrite({ asOfDate: bad });
      expect(d.write, bad).toBe(false);
      expect(d.date, bad).toBe(bad);
    }
    expect(decideEodReportWrite({ asOfDate: '2026-08-14' }).write).toBe(true);
  });
});

describe('TRA-3848 — the BACKFILL still writes its named past date (acceptance 2/3)', () => {
  it('admits every historical session a backfill can name', () => {
    for (const iso of ['2026-05-04', '2026-06-30', '2026-07-31', '2026-08-14', '2026-08-17']) {
      const d = decideEodReportWrite({ asOfDate: iso });
      expect(d.write, iso).toBe(true);
      expect(d.date, iso).toBe(iso);
      expect(d.backfill, iso).toBe(true);
    }
  });

  it('is a no-op on the catch-up path BY CONSTRUCTION, measured against the real missedTradingDays', () => {
    // The ticket says to verify rather than assume that the backfill's `asOfDate`
    // is always a session. `missedTradingDays` is the ONLY source of that value
    // (index.ts `catchUpMissedEodReports`), so run the real function over a window
    // that spans two weekends and a holiday and assert the gate admits all of it.
    const existing = ['2026-06-25'];
    const missed = missedTradingDays(existing, '2026-07-09', 14);
    expect(missed.length).toBeGreaterThan(0);
    for (const iso of missed) {
      expect(decideEodReportWrite({ asOfDate: iso }).write, iso).toBe(true);
    }
    // …and that the window it was drawn from genuinely CONTAINED non-sessions,
    // otherwise the assertion above is vacuous.
    expect(missed).not.toContain('2026-07-03'); // Independence Day (observed)
    expect(missed).not.toContain('2026-07-04'); // Saturday
    expect(missed).not.toContain('2026-07-05'); // Sunday
    expect(missed).toContain('2026-07-02');
    expect(missed).toContain('2026-07-06');
  });
});

describe('TRA-3848 — writer/reader calendar agreement over a contiguous span', () => {
  it('the SET of admitted dates equals isMarketDayIso over 2026-08-08..2026-09-13', () => {
    // The drift test, which is the defect itself: the gate and the calendar every
    // reader uses must not be able to disagree about a single day. Spans two
    // weekends either side of Labor Day.
    const admitted: string[] = [];
    const sessions: string[] = [];
    for (let t = Date.UTC(2026, 7, 8); t <= Date.UTC(2026, 8, 13); t += 86_400_000) {
      const iso = new Date(t).toISOString().slice(0, 10);
      if (decideEodReportWrite({ asOfDate: iso }).write) admitted.push(iso);
      if (isMarketDayIso(iso)) sessions.push(iso);
    }
    expect(admitted).toEqual(sessions);
    expect(sessions.length).toBe(24);        // not a vacuous empty-equals-empty
    expect(admitted).toContain('2026-08-10');
    expect(admitted).toContain('2026-09-08');
    expect(admitted).not.toContain('2026-09-07');
  });
});

describe('TRA-3848 — ONE derivation of the date across an ET midnight', () => {
  it('resolves the ET date, not the UTC date, on a Friday evening', () => {
    // 2026-08-15T01:00:00Z is Friday 2026-08-14 21:00 ET — the archive tick's own
    // instant. Its UTC date is a SATURDAY. A gate reading the UTC day refuses a
    // real session here (that is TRA-3267's Friday-dropping half); a gate reading
    // ET passes it and, critically, hands back `2026-08-14` for the writer to
    // stamp so the two cannot disagree.
    const d = decideEodReportWrite({}, new Date('2026-08-15T01:00:00Z'));
    expect(d.write).toBe(true);
    expect(d.date).toBe('2026-08-14');
  });

  it('refuses the Saturday-evening instant whose UTC date is a Sunday', () => {
    // 2026-08-16T01:00:00Z is Saturday 2026-08-15 21:00 ET. Both readings are
    // non-sessions, but they are DIFFERENT non-sessions, and the returned date is
    // the ET one — which is the date any refusal log will name.
    const d = decideEodReportWrite({}, new Date('2026-08-16T01:00:00Z'));
    expect(d.write).toBe(false);
    expect(d.date).toBe('2026-08-15');
  });

  it('a Sunday-evening instant is refused under its ET date, not promoted to Monday', () => {
    // 2026-08-10T01:00:00Z is Sunday 2026-08-09 21:00 ET. `isMarketDay`'s own doc
    // names this exact case: the host-local reading returned "Monday" and booked a
    // phantom Sunday session on 2026-08-09.
    const d = decideEodReportWrite({}, new Date('2026-08-10T01:00:00Z'));
    expect(d.write).toBe(false);
    expect(d.date).toBe('2026-08-09');
  });
});

// ── Wiring pins ───────────────────────────────────────────────────────────────
//
// The unit arms above prove the DECISION. They cannot prove `index.ts` asks for
// it, asks before it writes, or acts on the answer — and that gap is the whole
// reason this bug existed (every predicate lived in a caller). Nothing can import
// `index.ts`, so these read its source, which is the pattern the repo already
// uses for route wiring (`storage-health.test.ts`, `route-registration-uniqueness.test.ts`).

describe('TRA-3848 — index.ts wiring', () => {
  // Line endings NORMALISED: this repo is developed on Windows and `index.ts` is
  // CRLF on disk, so a multi-line `toContain` written with `\n` would fail here
  // and pass in CI — a pin that is red for a reason nobody caused gets deleted.
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8').replace(/\r\n/g, '\n');
  const body = (() => {
    const start = src.indexOf('async function generateAndSaveReport(');
    expect(start, 'generateAndSaveReport not found — this pin has drifted').toBeGreaterThan(0);
    const end = src.indexOf('\nasync function catchUpMissedEodReports', start);
    expect(end, 'end of generateAndSaveReport not found').toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  it('REFUSES before any write, mkdir, or network reconcile', () => {
    // Anchored on the refusal `return`, NOT on `decideEodReportWrite(` — the call
    // site is not the property. A first draft of this pin measured `indexOf` of
    // the call and survived a mutant that hoisted a bare
    // `const d = decideEodReportWrite(opts).date` to the top of the function while
    // moving the actual bail past the Tradier reconcile. What matters is the
    // earliest point the function can stop, because every side effect below it is
    // one this gate is supposed to prevent.
    const gate = body.indexOf('return { written: false, date: reportDate, skipReason: decision.skipReason };');
    expect(gate, 'the market-day refusal return has moved or changed shape').toBeGreaterThan(-1);
    for (const sideEffect of [
      'reconcileTradierOptionsHistory(', // network + merges closes into per-day reports
      'writeFile(',
      'ctx.tracker.saveSnapshot(',
      'writeCloseLedger(',
      'broadcastToUser(',
    ]) {
      const at = body.indexOf(sideEffect);
      if (at === -1) continue;
      expect(at, `${sideEffect} runs before the gate`).toBeGreaterThan(gate);
    }
  });

  it('stamps the report with the date the gate RESOLVED — never a second clock read', () => {
    expect(body).toContain('generateEodReport(finalSnapshot, reportDate)');
    // The old shape re-derived it. If either of these comes back, the straddle does.
    expect(body).not.toContain('generateEodReport(finalSnapshot, opts.asOfDate)');
    expect(body.match(/opts\.asOfDate \?\? etDateString\(\)/g) ?? []).toHaveLength(0);
  });

  it('returns an outcome rather than void, so a refusal cannot read as a success', () => {
    expect(src).toContain('): Promise<EodReportOutcome> {');
    expect(src).toContain("skipReason: 'non_market_day' | 'settled_report_clobber'");
  });

  it('every caller reads the outcome', () => {
    // Three callers: the backfill, the EOD sweep, and POST /api/reports/generate.
    const calls = [...src.matchAll(/^\s*(?:const \w+ = )?await generateAndSaveReport\(/gm)];
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c[0], `a caller discards the outcome: ${c[0].trim()}`).toContain('const ');
    }
  });

  it('the route answers 409 with the reason instead of ok:true', () => {
    const route = src.slice(src.indexOf("app.post('/api/reports/generate'"));
    const handler = route.slice(0, route.indexOf('\n});'));
    expect(handler).toContain('res.status(409)');
    expect(handler).toContain('skipReason: outcome.skipReason');
    // ...and the success answer must still exist, or "it never 200s" would pass.
    expect(handler).toContain("message: 'EOD report generated successfully'");
  });

  it('the archive sweep does not book participation for a refused write', () => {
    // A `participated` row for a report that was never written is the
    // never-measured-vs-clean conflation TRA-2930 exists to end.
    expect(src).toContain("outcome = 'skipped_not_market_day';\n            outcomeReason = `gate refused ${eod.date}");
  });
});
