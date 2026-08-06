// TRA-2631 / TRA-3063 (ruling B) — the read-time provenance stamp.
//
// The controls here are the ruling's four binding scope points, one test each,
// plus the two ways this ships broken while looking shipped:
//
//   • an array-only stamp (the `markdown` string is what the News tab renders,
//     and it is frozen into the stored file at generation time);
//   • an inline mark that silently stops matching after a formatter change,
//     which degrades to "no rows flagged" — indistinguishable from clean.
//
// The positive control is a REAL archived row: `| SELX | $0.34 | +1316.67% |`,
// the row quoted verbatim off the 2026-07-21 live artifact on TRA-2631.

import { describe, it, expect } from 'vitest';
import type { EodMover } from '@trading-app/shared';
import { SUSPECT_MOVE_RATIO } from '@trading-app/shared';
import {
  annotateReportProvenance,
  MOVER_PROVENANCE_RULE_ID,
  INLINE_SUSPECT_MARK,
} from './mover-provenance.js';
import { formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';

const BUILD = '7a5317605e1c';

/** The fabricated 2026-07-21 headline: implied prev close 0.0240, r = 14.17. */
const SELX: EodMover = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };
/** A genuine near-doubling that sits just UNDER the bar (INLF, 2026-08-05). */
const INLF: EodMover = { symbol: 'INLF', price: 6.27, changePct: 97.17 };
const NVDA: EodMover = { symbol: 'NVDA', price: 178.25, changePct: 2.41 };

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

describe('read-time mover provenance (TRA-2631, ruling B)', () => {
  it('flags the real archived SELX headline with the arithmetic, not a bare label', () => {
    const out = annotateReportProvenance(report([SELX, INLF, NVDA]), BUILD);
    const p = out.top5Movers[0]!.provenance!;

    expect(p.verdict).toBe('suspect');
    expect(p.reason).toBe('implausible_move_ratio');
    expect(p.ratio).toBeCloseTo(14.17, 2);
    expect(p.impliedPrevClose).toBeCloseTo(0.024, 4);
    // Scope point 3 — SELF-DATING. Rule id + threshold + build, so a later
    // threshold change re-annotates instead of silently contradicting.
    expect(p.ruleId).toBe(MOVER_PROVENANCE_RULE_ID);
    expect(p.threshold).toBe(SUSPECT_MOVE_RATIO);
    expect(p.build).toBe(BUILD);
  });

  it('does not flag the genuine near-doubling under the bar', () => {
    const out = annotateReportProvenance(report([INLF, NVDA]), BUILD);
    expect(out.top5Movers.map(m => m.provenance!.verdict)).toEqual(['plausible', 'plausible']);
    // INLF is r = 1.9717 against a threshold of 2 — 1.4% of headroom. This is
    // the FALSE-POSITIVE control: a stamp that flagged it would be flagging a
    // real mover, which is the failure mode a tighter threshold buys.
    expect(out.top5Movers[0]!.provenance!.ratio).toBeCloseTo(1.9717, 4);
  });

  // ── Scope point 4: no reordering, no renumbering, numbers untouched ─────────
  it('leaves rank, order and every published number byte-identical', () => {
    const input = report([SELX, INLF, NVDA]);
    const out = annotateReportProvenance(input, BUILD);

    expect(out.top5Movers).toHaveLength(3);
    expect(out.top5Movers.map(m => m.symbol)).toEqual(['SELX', 'INLF', 'NVDA']);
    // The fabricated row STAYS at #1, flagged. Demoting it is option A, which
    // was declined: a quiet bad headline is the one nobody files a ticket on.
    expect(out.top5Movers[0]!.symbol).toBe('SELX');
    expect(out.top5Movers[0]!.price).toBe(0.34);
    expect(out.top5Movers[0]!.changePct).toBe(1316.67);
  });

  // ── Scope point 2: annotate the response, never the artifact ────────────────
  it('does not mutate the object it was handed', () => {
    const input = report([SELX, INLF]);
    const before = JSON.parse(JSON.stringify(input));
    annotateReportProvenance(input, BUILD);
    expect(input).toEqual(before);
    expect(input.top5Movers[0]).not.toHaveProperty('provenance');
  });

  // ── Scope point 1: BOTH surfaces ───────────────────────────────────────────
  it('marks the offending row in place in the markdown, keeping the row 3 columns', () => {
    const out = annotateReportProvenance(report([SELX, INLF, NVDA]), BUILD);
    const line = out.markdown.split('\n').find(l => l.startsWith('| SELX '))!;

    expect(line).toContain(INLINE_SUSPECT_MARK);
    // The published numbers survive verbatim — flagged, not corrected.
    expect(line).toContain('| SELX | $0.34 | +1316.67%');
    // Three columns: a fourth cell breaks the header and some renderers drop it.
    expect(line.split('|').filter(s => s.trim().length > 0)).toHaveLength(3);
    // And the clean rows are untouched.
    expect(out.markdown).toContain(formatMoverMarkdownRow(NVDA));
    expect(out.markdown).not.toContain(`| INLF | $6.27 | +97.17% ${INLINE_SUSPECT_MARK}`);
  });

  it('appends a self-dating note under the table, above the next heading', () => {
    const out = annotateReportProvenance(report([SELX, INLF, NVDA]), BUILD);
    const lines = out.markdown.split('\n');
    const noteIdx = lines.findIndex(l => l.includes('PROVENANCE'));
    const nextHeadingIdx = lines.findIndex(l => l === '## Signal Accuracy');

    expect(noteIdx).toBeGreaterThan(lines.indexOf(MOVERS_MARKDOWN_HEADING));
    expect(noteIdx).toBeLessThan(nextHeadingIdx);
    expect(out.markdown).toContain(MOVER_PROVENANCE_RULE_ID);
    expect(out.markdown).toContain(`SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}`);
    expect(out.markdown).toContain(BUILD);
    // The jurisdiction disclaimer: an unflagged row is unflagged, not verified.
    expect(out.markdown).toContain('TRA-2634');
  });

  it('says the check RAN when every row passes, so silence is not read as clean', () => {
    const out = annotateReportProvenance(report([INLF, NVDA]), BUILD);
    expect(out.markdown).toContain('**Provenance:** all 2 row(s) above pass');
    expect(out.markdown).toContain(BUILD);
    expect(out.markdown).not.toContain(INLINE_SUSPECT_MARK);
  });

  // ── The two silent-degradation modes ───────────────────────────────────────
  it('still emits the note, and SAYS SO, when the row cannot be matched in place', () => {
    // A stored document rendered by an OLDER formatter: same row, different text.
    // The inline mark cannot land — and the failure must be stated, because an
    // unmarked suspect row reads exactly like a clean one.
    const stale = markdownWith([SELX]).replace(formatMoverMarkdownRow(SELX), '| SELX | 0.34 | 1316.67 |');
    const out = annotateReportProvenance({ top5Movers: [SELX], markdown: stale }, BUILD);

    expect(out.markdown).not.toContain(INLINE_SUSPECT_MARK);
    expect(out.markdown).toContain('PROVENANCE');
    expect(out.markdown).toContain('could not be matched to a line in the table above');
    // The verdict itself still stands — it comes from the JSON row, not the text.
    expect(out.markdown).toContain('implausible_move_ratio');
  });

  it('appends at the end, flagged as unlocated, when the table heading is absent', () => {
    const out = annotateReportProvenance(
      { top5Movers: [SELX], markdown: '# Some other document\n\nNo movers section here.\n' },
      BUILD,
    );
    expect(out.markdown).toContain('could not be located in this stored document');
    expect(out.markdown).toContain('PROVENANCE');
  });

  // ── No-ops ─────────────────────────────────────────────────────────────────
  it('leaves a report with no movers exactly as it was (journal calendar cells)', () => {
    const cell = { date: '2026-07-21', top5Movers: [], markdown: '# cell' };
    expect(annotateReportProvenance(cell, BUILD)).toBe(cell);
  });

  it('stamps the array even when the report carries no markdown', () => {
    const bare: { top5Movers: EodMover[]; markdown?: string } = { top5Movers: [SELX] };
    const out = annotateReportProvenance(bare, BUILD);
    expect(out.top5Movers[0]!.provenance!.verdict).toBe('suspect');
    expect(out.markdown).toBeUndefined();
  });

  it('reports an unassessable row as unassessable, never as plausible', () => {
    // price <= 0 is the no-quote paths' jurisdiction: the session-move rule has
    // nothing to say, and saying `plausible` would be a pass it did not give.
    const sblx: EodMover = { symbol: 'SBLX', price: 0, changePct: 0 };
    const out = annotateReportProvenance({ top5Movers: [sblx] }, BUILD);
    expect(out.top5Movers[0]!.provenance!.verdict).toBe('unassessable');
    expect(out.top5Movers[0]!.provenance!.ratio).toBeNull();
  });
});
