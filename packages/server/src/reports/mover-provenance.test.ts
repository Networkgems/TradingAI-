// TRA-2631 (board ruling A) — the read-time FILTER + provenance stamp.
//
// The controls here are the ruling's three binding scope points, plus the ways
// this ships broken while looking shipped. In rough order of how badly each one
// would fool a reader:
//
//   • a SILENT filter — rows dropped with nothing on the response saying so, which
//     makes a filtered table and a genuinely-clean table read identically. That is
//     the exact defect class this whole ticket family exists for, so shipping it
//     inside the fix would be the worst outcome available;
//   • an array-only filter (the `markdown` string is what the News tab renders,
//     and it is frozen into the stored file at generation time) — the fabricated
//     headline would stay fully visible where humans actually read it;
//   • a HALF filter — the row removed from one surface and left on the other;
//   • a row locator that silently stops matching after a formatter change, which
//     degrades to "nothing removed" — indistinguishable from clean.
//
// The positive control is a REAL archived row: `| SELX | $0.34 | +1316.67% |`,
// the row quoted verbatim off the 2026-07-21 live artifact on TRA-2631.
//
// ⚠️ TRA-3915 — THE FIXTURES BELOW CARRY AN EXPLICIT `currency: 'USD'`, AND THAT
// IS LOAD-BEARING, NOT DECORATION. Since TRA-3390 every level on both surfaces
// renders through `formatQuoteLevel`, whose rule 2 is *unknown is not USD*: a
// fixture with no `currency` renders `0.34`, bare. That is correct behaviour and
// it is also what silently voided the positive control — the fourth bullet
// above, arriving as itself. `not.toContain('| SELX | $0.34 | +1316.67% |')`
// went VACUOUSLY true, and would have stayed green with the filter deleted
// outright. These four rows are US listings quoted off live artifacts in
// dollars, so USD is the fixture's fact about the row, not a default being
// reinstated. A currency-LESS row is pinned separately, on purpose, below.

import { describe, it, expect } from 'vitest';
import type {
  EodMover, MoverWriteTimeExclusion, MoversWriteTimeProvenance,
} from '@trading-app/shared';
import { SUSPECT_MOVE_RATIO_FLOOR } from '@trading-app/shared';
import {
  annotateReportProvenance,
  MOVER_PROVENANCE_RULE_ID,
} from './mover-provenance.js';
import { formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';

const BUILD = '7a5317605e1c';

/** The fabricated 2026-07-21 headline: implied prev close 0.0240, r = 14.17. */
const SELX: EodMover = { symbol: 'SELX', price: 0.34, changePct: 1316.67, currency: 'USD' };
/**
 * A genuine large mover safely under the band (QMCO, 2026-08-11, r = 1.642).
 * TRA-3241 retired INLF ($6.27 / +97.17%, r = 1.9717) from this role: it sits
 * INSIDE the k = 2 proximity band — an MNST-shaped row, correctly suppressed
 * by the current rule.
 */
const QMCO: EodMover = { symbol: 'QMCO', price: 19.34, changePct: 64.18, currency: 'USD' };
const NVDA: EodMover = { symbol: 'NVDA', price: 178.25, changePct: 2.41, currency: 'USD' };
/** The second fabricated headline, off the 2026-07-15 live artifact. */
const JEM: EodMover = { symbol: 'JEM', price: 6.05, changePct: 1102.07, currency: 'USD' };

function markdownWith(movers: EodMover[]): string {
  return [
    '# Daily EOD Report — 2026-07-21',
    '',
    '## Trade Log',
    '_No closed trades today._',
    '',
    MOVERS_MARKDOWN_HEADING,
    '| Symbol | Price | Change % |',
    '|--------|-------|----------|',
    ...movers.map(formatMoverMarkdownRow),
    '',
    '## Signal Accuracy',
    '| Metric | Value |',
  ].join('\n');
}

function report(movers: EodMover[]) {
  return { date: '2026-07-21', top5Movers: movers, markdown: markdownWith(movers) };
}

/**
 * TRA-3296 — a report from a build that KEEPS a write-time record. `report()`
 * above deliberately still omits the key, because that is the shape of every
 * artifact stored before the fix and the backfill assertions need it.
 */
function reportWithWriteTime(movers: EodMover[], writeTime: MoversWriteTimeProvenance) {
  return { ...report(movers), moversWriteTime: writeTime };
}

/** A write-time record that dropped nothing into this table. */
function emptyWriteTime(candidateCount = 2, excludedTotal = 0): MoversWriteTimeProvenance {
  return { displaced: [], excludedTotal, candidateCount, build: BUILD };
}

function cleanReport(movers: EodMover[]) {
  return reportWithWriteTime(movers, emptyWriteTime(movers.length));
}

/**
 * The two rows bqb1 dropped at WRITE time on 2026-08-11, quoted off the tape line
 * in the filing ticket verbatim:
 *   `["PLAG@5.81:927.05%:ok","MNST@45.53:-50.21%:ok"]`
 * MNST is the one that matters — a genuine 2:1 split, ex-dated that session, named
 * as such by the TRA-3068 calendar, and absent from the document a human reads as
 * the session summary while the footer called that document "as published".
 */
const PLAG_WT: MoverWriteTimeExclusion = {
  symbol: 'PLAG', price: 5.81, changePct: 927.05, currency: 'USD',
  instrument: 'TRA-2610:session-move', reason: 'implausible_session_move',
  impliedPrevClose: 0.5657, ratio: 10.27,
};
const MNST_WT: MoverWriteTimeExclusion = {
  symbol: 'MNST', price: 45.53, changePct: -50.21, currency: 'USD',
  instrument: 'TRA-3068:corporate-action', reason: 'corporate_action',
  impliedPrevClose: 91.44, ratio: 2.008,
  corporateAction: '2:1 exDate=2026-08-11',
};
/**
 * TRA-3915 — the write-time surface's foreign row. SK Hynix is THE row TRA-3390
 * was filed on (`| 000660.KS | $1,550,000.00 | -14.65% |`, 2026-07-28), and it is
 * a ranking candidate like any other, so it can be condemned at write time and
 * land in the displaced table. Before this ticket that table rendered it
 * `$1550000.00` — the original defect, one paragraph below the table that had
 * been fixed.
 */
const HYNIX_WT: MoverWriteTimeExclusion = {
  symbol: '000660.KS', price: 1550000, changePct: -14.65, currency: 'KRW',
  instrument: 'TRA-2634:level-continuity', reason: 'level_discontinuity',
  impliedPrevClose: 1816056.64, ratio: 1.17,
};

/** Data rows of the movers table in a served document (header rows excluded). */
function tableRows(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(l => l.trim() === MOVERS_MARKDOWN_HEADING);
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith('## ')) break;
    if (!l.startsWith('|')) continue;
    if (l.startsWith('| Symbol ') || l.startsWith('|---')) continue;
    out.push(l);
  }
  return out;
}

describe('read-time mover filter + provenance (TRA-2631, board ruling A)', () => {
  // ── Scope point 1: READ-TIME FILTER ────────────────────────────────────────
  it('suppresses the real archived SELX headline from the served array', () => {
    const out = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);

    expect(out.top5Movers.map(m => m.symbol)).toEqual(['QMCO', 'NVDA']);
    expect(out.top5Movers.some(m => m.symbol === 'SELX')).toBe(false);
    // The survivors keep their published numbers and their published order —
    // suppression is not a re-rank and not a restatement.
    expect(out.top5Movers[0]!.price).toBe(19.34);
    expect(out.top5Movers[0]!.changePct).toBe(64.18);
  });

  it('carries the suppressed row verbatim, with its arithmetic, in moversProvenance', () => {
    const out = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);
    const mp = out.moversProvenance!;

    expect(mp.publishedCount).toBe(3);
    expect(mp.servedCount).toBe(2);
    expect(mp.filteredCount).toBe(1);
    // Recoverability: what was removed is still IN the response, unedited.
    expect(mp.filtered).toHaveLength(1);
    expect(mp.filtered[0]!.symbol).toBe('SELX');
    expect(mp.filtered[0]!.price).toBe(0.34);
    expect(mp.filtered[0]!.changePct).toBe(1316.67);

    const p = mp.filtered[0]!.provenance!;
    expect(p.verdict).toBe('suspect');
    expect(p.reason).toBe('implausible_move_ratio');
    expect(p.ratio).toBeCloseTo(14.17, 2);
    expect(p.impliedPrevClose).toBeCloseTo(0.024, 4);
    // SELF-DATING. Rule id + threshold + build, so a later threshold change
    // re-annotates instead of silently contradicting.
    expect(mp.ruleId).toBe(MOVER_PROVENANCE_RULE_ID);
    expect(mp.threshold).toBe(SUSPECT_MOVE_RATIO_FLOOR);
    expect(mp.build).toBe(BUILD);
  });

  it('suppresses EVERY suspect row, not just the headline', () => {
    // 2026-07-28 demo is the real shape here: 5 of 5 rows suspect. A filter that
    // only ever removed index 0 would pass every single-bad-row fixture.
    const out = annotateReportProvenance(report([SELX, JEM, NVDA]), BUILD);
    expect(out.top5Movers.map(m => m.symbol)).toEqual(['NVDA']);
    expect(out.moversProvenance!.filtered.map(m => m.symbol)).toEqual(['SELX', 'JEM']);
    expect(tableRows(out.markdown)).toEqual([formatMoverMarkdownRow(NVDA)]);
  });

  it('empties the table when every row is suspect, and still says why', () => {
    // The dangerous case: an empty `top5Movers` is indistinguishable from "no
    // movers that day" unless the stamp survives to explain it.
    const out = annotateReportProvenance(report([SELX, JEM]), BUILD);
    expect(out.top5Movers).toEqual([]);
    expect(out.moversProvenance!.publishedCount).toBe(2);
    expect(out.moversProvenance!.filteredCount).toBe(2);
    expect(out.moversProvenance!.servedCount).toBe(0);
    expect(tableRows(out.markdown)).toEqual([]);
    expect(out.markdown).toContain('2 of 2 published row(s) SUPPRESSED');
  });

  it('does not flag or suppress the genuine large mover under the band', () => {
    const out = annotateReportProvenance(report([QMCO, NVDA]), BUILD);
    expect(out.top5Movers.map(m => m.symbol)).toEqual(['QMCO', 'NVDA']);
    expect(out.top5Movers.map(m => m.provenance!.verdict)).toEqual(['plausible', 'plausible']);
    // QMCO is r = 1.6418 against the 1.9 band edge. This is the FALSE-POSITIVE
    // control: suppressing it would be DELETING a real mover, which under A is
    // a materially worse error than a wrong badge was under B. (The old control
    // here, INLF at r = 1.9717, is inside the TRA-3241 band and is now a
    // correct suppression, not a false positive.)
    expect(out.top5Movers[0]!.provenance!.ratio).toBeCloseTo(1.6418, 4);
    expect(out.moversProvenance!.filteredCount).toBe(0);
  });

  // ── Scope point 2: a filtered report must not read like a clean one ─────────
  it('states the denominator on a CLEAN report, so silence is never the answer', () => {
    // TRA-3296 — the report now has to CARRY a write-time record to earn the
    // "as published" certificate. `cleanReport` supplies an empty one; a report
    // WITHOUT the key is the backfill case and is asserted separately below.
    const out = annotateReportProvenance(cleanReport([QMCO, NVDA]), BUILD);
    // Present-with-zero, NOT absent. Absent means the filter never ran, which is
    // a different fact, and the check script discriminates on exactly this.
    expect(out.moversProvenance).toBeDefined();
    expect(out.moversProvenance!.filteredCount).toBe(0);
    expect(out.moversProvenance!.publishedCount).toBe(2);
    expect(out.markdown).toContain('0 of 2 row(s) suppressed; this table is as published');
    expect(out.markdown).toContain(BUILD);
  });

  it('renders a filtered table and a clean table DIFFERENTLY on both surfaces', () => {
    // The whole point of scope point 2, as one assertion. Both documents end up
    // with the same two visible rows; if the surfaces did not disagree, the fix
    // would have reproduced the defect it was filed on.
    const filtered = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);
    const clean = annotateReportProvenance(report([QMCO, NVDA]), BUILD);

    expect(tableRows(filtered.markdown)).toEqual(tableRows(clean.markdown));
    expect(filtered.top5Movers.map(m => m.symbol)).toEqual(clean.top5Movers.map(m => m.symbol));

    // ...and yet:
    expect(filtered.markdown).not.toBe(clean.markdown);
    expect(filtered.markdown).toContain('SUPPRESSED');
    expect(clean.markdown).not.toContain('SUPPRESSED');
    expect(filtered.moversProvenance!.filteredCount).not.toBe(clean.moversProvenance!.filteredCount);
    expect(filtered.moversProvenance!.publishedCount).not.toBe(clean.moversProvenance!.publishedCount);
  });

  it('reproduces the suppressed row in the note so the response stays self-contained', () => {
    const out = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);
    expect(out.markdown).toContain('1 of 3 published row(s) SUPPRESSED');
    expect(out.markdown).toContain('SELX');
    expect(out.markdown).toContain('$0.34 / +1316.67%');
    expect(out.markdown).toContain('implausible_move_ratio');
    expect(out.markdown).toContain(MOVER_PROVENANCE_RULE_ID);
    expect(out.markdown).toContain(`SUSPECT_MOVE_RATIO_FLOOR = ${SUSPECT_MOVE_RATIO_FLOOR}`);
    expect(out.markdown).toContain(BUILD);
    // The jurisdiction disclaimer: an unsuppressed row is unflagged, not verified.
    expect(out.markdown).toContain('TRA-2634');
    // And the archive is explicitly stated to be intact, so a reader knows the
    // published record is still recoverable off disk.
    expect(out.markdown).toContain('byte-intact');
  });

  it('places the note under the table, above the next heading', () => {
    const out = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);
    const lines = out.markdown.split('\n');
    const noteIdx = lines.findIndex(l => l.includes('PROVENANCE'));
    const nextHeadingIdx = lines.findIndex(l => l === '## Signal Accuracy');

    expect(noteIdx).toBeGreaterThan(lines.indexOf(MOVERS_MARKDOWN_HEADING));
    expect(noteIdx).toBeLessThan(nextHeadingIdx);
  });

  // ── Scope point 3: BOTH surfaces, and never half of one ────────────────────
  it('removes the row from the rendered table, leaving the clean rows byte-identical', () => {
    const input = report([SELX, QMCO, NVDA]);
    // TRA-3915 — the negative control's own control. `not.toContain` is only
    // evidence if the string is one the UNFILTERED document actually renders;
    // otherwise deleting the filter outright leaves this test green. It went
    // vacuous once already, silently, when TRA-3390 moved the renderer under a
    // currency-less fixture, so it is now pinned in both directions.
    expect(input.markdown).toContain('| SELX | $0.34 | +1316.67% |');

    const out = annotateReportProvenance(input, BUILD);

    expect(out.markdown).not.toContain('| SELX | $0.34 | +1316.67% |');
    expect(tableRows(out.markdown)).toEqual([
      formatMoverMarkdownRow(QMCO),
      formatMoverMarkdownRow(NVDA),
    ]);
    // Everything outside the movers section survives untouched.
    expect(out.markdown).toContain('## Trade Log');
    expect(out.markdown).toContain('_No closed trades today._');
    expect(out.markdown).toContain('## Signal Accuracy');
  });

  it('keeps the two surfaces in agreement — no half-filtered report', () => {
    const out = annotateReportProvenance(report([SELX, JEM, QMCO, NVDA]), BUILD);
    const rows = tableRows(out.markdown);
    expect(rows).toHaveLength(out.top5Movers.length);
    expect(rows).toEqual(out.top5Movers.map(m => formatMoverMarkdownRow(m)));
    // ...and the suppressed symbols appear nowhere in the table itself.
    for (const f of out.moversProvenance!.filtered) {
      expect(rows.some(r => r.startsWith(`| ${f.symbol} `))).toBe(false);
    }
  });

  // ── Read-time only: annotate the response, never the artifact ──────────────
  it('does not mutate the object it was handed', () => {
    const input = report([SELX, QMCO]);
    const before = JSON.parse(JSON.stringify(input));
    annotateReportProvenance(input, BUILD);
    expect(input).toEqual(before);
    expect(input.top5Movers).toHaveLength(2);
    expect(input.top5Movers[0]!.symbol).toBe('SELX');
    expect(input).not.toHaveProperty('moversProvenance');
  });

  // ── The two silent-degradation modes ───────────────────────────────────────
  it('SAYS SO when a suppressed row could not be removed from the table', () => {
    // A stored document rendered by an OLDER formatter: same row, different text.
    // The row cannot be located, so it is gone from the JSON and still in the
    // table — a half-filtered report, which must never be silent.
    const stale = markdownWith([SELX]).replace(formatMoverMarkdownRow(SELX), '| SELX | 0.34 | 1316.67 |');
    const out = annotateReportProvenance({ top5Movers: [SELX], markdown: stale }, BUILD);

    expect(out.top5Movers).toEqual([]);
    expect(out.markdown).toContain('still rendered in the table');
    expect(out.markdown).toContain('SELX');
    // The verdict itself still stands — it comes from the JSON row, not the text.
    expect(out.markdown).toContain('implausible_move_ratio');
  });

  it('appends at the end, flagged as unlocated, when the table heading is absent', () => {
    const out = annotateReportProvenance(
      { top5Movers: [SELX], markdown: '# Some other document\n\nNo movers section here.\n' },
      BUILD,
    );
    expect(out.markdown).toContain('could not be located in this stored document');
    expect(out.markdown).toContain('no row was removed from the rendered table');
    expect(out.top5Movers).toEqual([]);
  });

  // ── Mutation control on the retention predicate ────────────────────────────
  it('RETAINS an unassessable row rather than suppressing it', () => {
    // price <= 0 is the no-quote paths' jurisdiction: the session-move rule has
    // nothing to say. Suppressing on a blind spot would DELETE published rows on
    // the strength of a non-verdict — strictly worse than showing a flagged one.
    // This is the control that fails if the filter is rewritten to the tempting
    // `verdict === 'plausible'` predicate instead of `verdict !== 'suspect'`.
    const sblx: EodMover = { symbol: 'SBLX', price: 0, changePct: 0 };
    const out = annotateReportProvenance(report([sblx, NVDA]), BUILD);

    expect(out.top5Movers.map(m => m.symbol)).toEqual(['SBLX', 'NVDA']);
    expect(out.top5Movers[0]!.provenance!.verdict).toBe('unassessable');
    expect(out.top5Movers[0]!.provenance!.ratio).toBeNull();
    expect(out.moversProvenance!.filteredCount).toBe(0);
    // ...and it is not passed off as clean.
    expect(out.markdown).toContain('could **not be assessed**');
    expect(out.markdown).toContain('SBLX');
  });

  // ── No-ops ─────────────────────────────────────────────────────────────────
  it('leaves a report with no movers exactly as it was (journal calendar cells)', () => {
    const cell = { date: '2026-07-21', top5Movers: [], markdown: '# cell' };
    expect(annotateReportProvenance(cell, BUILD)).toBe(cell);
  });

  it('filters the array even when the report carries no markdown', () => {
    const bare: { top5Movers: EodMover[]; markdown?: string } = { top5Movers: [SELX] };
    const out = annotateReportProvenance(bare, BUILD);
    expect(out.top5Movers).toEqual([]);
    expect(out.moversProvenance!.filteredCount).toBe(1);
    expect(out.markdown).toBeUndefined();
  });
});

// ── TRA-3296 ─────────────────────────────────────────────────────────────────
//
// The read-time certificate above is honest about its own stage and silent about
// the one before it. `suppressed` is computed over rows ALREADY ON DISK, so rows
// dropped inside `eod-report.ts` are invisible here by construction — and the
// clean branch then printed "this table is as published" over the 2026-08-11
// report that had just lost MNST's 2:1 split.
//
// The controls are the filing ticket's own, in both directions, because the
// over-correction is the more dangerous failure: a fix that makes EVERY report
// claim a suppression is worse than the bug, and it would be shipped green by a
// suite that only tested the positive case.
describe('write-time exclusions are carried into the read-time note (TRA-3296)', () => {
  // ── POSITIVE: the 08-11 session, replayed off the tape line in the ticket ────
  it('names both write-time rows and does NOT claim the table is as published', () => {
    const out = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [PLAG_WT, MNST_WT], excludedTotal: 131, candidateCount: 525, build: BUILD,
      }),
      BUILD,
    );

    // The harm named by the ticket, killed: that exact string must be gone.
    expect(out.markdown).not.toContain('this table is as published');
    // Both symbols are named in the document a human reads.
    expect(out.markdown).toContain('PLAG');
    expect(out.markdown).toContain('MNST');
    // The split is named as the reason, not just the symbol.
    expect(out.markdown).toContain('2:1 exDate=2026-08-11');
    // Stage is LABELLED, so a read-time suppression is distinguishable from a
    // write-time one (TRA-3243's attribute-don't-pool rule, applied to the note).
    expect(out.markdown).toContain('TRA-3068:corporate-action');
    expect(out.markdown).toContain('TRA-2610:session-move');
    expect(out.markdown).toContain('dropped BEFORE this report was written');
  });

  it('keeps the read-time arithmetic invariant intact — write-time rows are NOT pooled in', () => {
    // `publishedCount === servedCount + filteredCount` is asserted corpus-wide by
    // `scripts/tra2631-provenance-stamp-check.mjs`. The write-time rows never
    // reached the file, so folding them into `filteredCount` would produce a
    // number that is true of neither stage AND fail that check everywhere.
    const mp = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [PLAG_WT, MNST_WT], excludedTotal: 131, candidateCount: 525, build: BUILD,
      }),
      BUILD,
    ).moversProvenance!;
    expect(mp.publishedCount).toBe(2);
    expect(mp.servedCount).toBe(2);
    expect(mp.filteredCount).toBe(0);
    expect(mp.publishedCount).toBe(mp.servedCount + mp.filteredCount);
  });

  it('pools BOTH stages when the same report is filtered at read time too', () => {
    const out = annotateReportProvenance(
      reportWithWriteTime([SELX, QMCO], {
        displaced: [MNST_WT], excludedTotal: 7, candidateCount: 500, build: BUILD,
      }),
      BUILD,
    );
    // Read-time stage still reports its own suppression...
    expect(out.moversProvenance!.filteredCount).toBe(1);
    expect(out.markdown).toContain('SELX');
    // ...and the write-time stage is named alongside it rather than swallowed.
    expect(out.markdown).toContain('MNST');
    expect(out.markdown).toContain('dropped BEFORE this report was written');
  });

  // ── NEGATIVE: the one that matters. Do not cry wolf on a clean session. ──────
  it('a genuinely clean session STILL renders the "as published" line, unchanged', () => {
    const out = annotateReportProvenance(cleanReport([QMCO, NVDA]), BUILD);
    expect(out.markdown).toContain('0 of 2 row(s) suppressed; this table is as published');
    expect(out.markdown).not.toContain('dropped BEFORE this report was written');
    expect(out.markdown).not.toContain('UNKNOWN');
  });

  it('a clean TABLE whose session dropped rows elsewhere still says "as published"', () => {
    // The over-correction guard. 131 rows were excluded from the ranking universe
    // but none would have reached the top 5, so this table really is as published
    // and must not be smeared with a suppression notice it did not earn.
    const out = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [], excludedTotal: 131, candidateCount: 525, build: BUILD,
      }),
      BUILD,
    );
    expect(out.markdown).toContain('this table is as published');
    expect(out.markdown).not.toContain('UNKNOWN');
    // The full census stays reachable without flooding the note.
    expect(out.markdown).toContain('131 row(s) of 525 candidate(s)');
  });

  // ── BACKFILL BOUNDARY: unrepairable must read as UNKNOWN, never as clean ─────
  it('a report with NO write-time record renders UNKNOWN, not "0 suppressed"', () => {
    // Every artifact stored before this change is this shape. They cannot be
    // repaired — the rows never reached the file and no per-symbol quote tape is
    // retained — so the note must say it does not know. Re-certifying a
    // silently-unrepairable archive as clean is the failure this ticket is about.
    const out = annotateReportProvenance(report([QMCO, NVDA]), BUILD);
    expect(out.markdown).toContain('Write-time exclusions: UNKNOWN');
    expect(out.markdown).not.toContain('this table is as published');
    // The read-time stage is still reported honestly — one silent stage must not
    // be traded for another.
    expect(out.moversProvenance!.filteredCount).toBe(0);
    expect(out.markdown).toContain('0 of 2 row(s) suppressed at read time');
  });

  it('discriminates ABSENT from RECORDED-EMPTY — the two must not render alike', () => {
    // The single assertion the whole backfill boundary rests on. If a truthiness
    // test ever replaces the `in` check, these two collapse and this fails.
    const absent = annotateReportProvenance(report([QMCO, NVDA]), BUILD).markdown;
    const recorded = annotateReportProvenance(cleanReport([QMCO, NVDA]), BUILD).markdown;
    expect(absent).not.toBe(recorded);
    expect(absent).toContain('UNKNOWN');
    expect(recorded).toContain('as published');
  });

  it('still suppresses at read time on a pre-fix artifact — the filter is not disabled', () => {
    // A record-less report is UNKNOWN about the write-time stage only. The
    // read-time filter must go on doing its job, or the backfill branch would be a
    // silent regression of TRA-2631 wearing a transparency fix's clothes.
    const out = annotateReportProvenance(report([SELX, QMCO]), BUILD);
    expect(out.top5Movers.map(m => m.symbol)).toEqual(['QMCO']);
    expect(out.moversProvenance!.filteredCount).toBe(1);
    expect(out.markdown).toContain('Write-time exclusions: UNKNOWN');
  });
});

// ── TRA-3915 ─────────────────────────────────────────────────────────────────
//
// This note renders levels on THREE surfaces — the movers table, the read-time
// suppression rows, and the write-time displaced rows — and TRA-3390's docblock
// argues at length that they must not disagree about the same datum. Nothing
// pinned that. The read-time cell went currency-aware in `edb7e65`, the
// write-time cell kept a hard-coded `$` for another five months, and the only
// test that touched either was asserting the OLD string off a fixture that had
// no currency to render — so it failed for being stale rather than for catching
// the divergence one line below it.
//
// The rule under test is TRA-3390's rule 2, **UNKNOWN IS NOT USD**, and the
// reason it gets its own block is that the tempting repair for a red
// `toContain('$0.34')` is to default the absent currency back to USD on "just
// this surface". That is the original defect, re-shipped silently, for every row
// the adapter was quiet on.
describe('every level on this note carries its own currency (TRA-3915 / TRA-3390)', () => {
  const KRW: EodMover = { symbol: '000660.KS', price: 1550000, changePct: 1316.67, currency: 'KRW' };
  /** The archived shape: stored before TRA-3390, so genuinely undenominated. */
  const NOCCY: EodMover = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };

  it('renders a foreign level in ITS OWN currency in the suppression note, not dollars', () => {
    const out = annotateReportProvenance(report([KRW, QMCO, NVDA]), BUILD);
    expect(out.moversProvenance!.filteredCount).toBe(1);
    expect(out.markdown).toContain('1,550,000.00 KRW');
    // The defect, stated as the assertion that catches it coming back.
    expect(out.markdown).not.toContain('$1,550,000.00');
    expect(out.markdown).not.toContain('$1550000.00');
  });

  it('renders an UNKNOWN currency bare — absent must never be re-defaulted to USD', () => {
    const out = annotateReportProvenance(report([NOCCY, QMCO, NVDA]), BUILD);
    expect(out.moversProvenance!.filteredCount).toBe(1);
    expect(out.markdown).toContain('0.34 / +1316.67%');
    expect(out.markdown).not.toContain('$0.34 / +1316.67%');
  });

  it('agrees with the movers table about the same row, on both surfaces', () => {
    // The property TRA-3390's docblock claims and TRA-3915 found unenforced: the
    // note re-prints levels the table also prints, and a reader must not see the
    // same number denominated two ways in one document.
    for (const m of [SELX, KRW, NOCCY]) {
      const out = annotateReportProvenance(report([m, QMCO, NVDA]), BUILD);
      const level = formatMoverMarkdownRow(m).split('|')[2]!.trim();
      expect(out.markdown).toContain(`${level} / `);
    }
  });

  it('renders the WRITE-TIME displaced table in each row\'s own currency too', () => {
    const out = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [MNST_WT, HYNIX_WT], excludedTotal: 131, candidateCount: 525, build: BUILD,
      }),
      BUILD,
    );
    // USD is unchanged from the pre-TRA-3915 rendering — this fix moves the UNIT,
    // not the digits, for every row that was already correct.
    expect(out.markdown).toContain('$45.53 / -50.21%');
    // ...and the row the whole currency ticket was filed on is no longer dollars.
    expect(out.markdown).toContain('1,550,000.00 KRW / -14.65%');
    expect(out.markdown).not.toContain('$1550000.00');
  });

  it('leaves an undenominated write-time row bare rather than asserting dollars', () => {
    // Every `MoverWriteTimeExclusion` persisted before TRA-3915 is this shape.
    const { currency: _drop, ...archived } = MNST_WT;
    const out = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [archived], excludedTotal: 7, candidateCount: 500, build: BUILD,
      }),
      BUILD,
    );
    expect(out.markdown).toContain('45.53 / -50.21%');
    expect(out.markdown).not.toContain('$45.53');
  });

  it('still says n/a for a non-finite write-time price — no number is not unknown unit', () => {
    // The discrimination `moverCell` documents, now asserted on the surface that
    // only ever had it by accident.
    const out = annotateReportProvenance(
      reportWithWriteTime([QMCO, NVDA], {
        displaced: [{ ...MNST_WT, price: Number.NaN }],
        excludedTotal: 7, candidateCount: 500, build: BUILD,
      }),
      BUILD,
    );
    expect(out.markdown).toContain('n/a / -50.21%');
    // `formatQuoteLevel`'s own non-finite rendering must NOT leak through here:
    // an em-dash would be a third spelling of a fact this note already has two
    // agreed words for.
    expect(out.markdown).not.toContain('— / -50.21%');
  });
});
