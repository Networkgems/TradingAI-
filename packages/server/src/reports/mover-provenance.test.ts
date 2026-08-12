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

import { describe, it, expect } from 'vitest';
import type { EodMover } from '@trading-app/shared';
import { SUSPECT_MOVE_RATIO_FLOOR } from '@trading-app/shared';
import {
  annotateReportProvenance,
  MOVER_PROVENANCE_RULE_ID,
} from './mover-provenance.js';
import { formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';

const BUILD = '7a5317605e1c';

/** The fabricated 2026-07-21 headline: implied prev close 0.0240, r = 14.17. */
const SELX: EodMover = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };
/**
 * A genuine large mover safely under the band (QMCO, 2026-08-11, r = 1.642).
 * TRA-3241 retired INLF ($6.27 / +97.17%, r = 1.9717) from this role: it sits
 * INSIDE the k = 2 proximity band — an MNST-shaped row, correctly suppressed
 * by the current rule.
 */
const QMCO: EodMover = { symbol: 'QMCO', price: 19.34, changePct: 64.18 };
const NVDA: EodMover = { symbol: 'NVDA', price: 178.25, changePct: 2.41 };
/** The second fabricated headline, off the 2026-07-15 live artifact. */
const JEM: EodMover = { symbol: 'JEM', price: 6.05, changePct: 1102.07 };

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
    const out = annotateReportProvenance(report([QMCO, NVDA]), BUILD);
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
    const out = annotateReportProvenance(report([SELX, QMCO, NVDA]), BUILD);

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
