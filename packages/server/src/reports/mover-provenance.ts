// TRA-2631 / TRA-3063 — READ-TIME PROVENANCE STAMP for stored top-movers rows.
//
// ── What this exists for ──────────────────────────────────────────────────────
// 64 of the 105 stored EOD top-movers tables carry a row the deployed
// plausibility rule calls fabricated, and in all 64 it sits at **#1** — because
// `top5Movers` ranks on `|changePct|` (`eod-report.ts`), so an inflated move
// necessarily outranks the genuine ones. TRA-2610 fixed report GENERATION and
// six consecutive clean sessions say the fix holds; it does not, and cannot,
// rewrite files already on disk, and `GET /api/reports/{date}` serves those files
// verbatim.
//
// Regeneration is NOT available: no per-symbol quote tape is retained, so
// regenerating 2026-05-03 would stamp TODAY's movers onto a May date. (TRA-2689's
// feed-boundary ring does not rescue this — it is a bounded in-process ring that
// starts on 2026-07-30.)
//
// ── The ruling this implements (TRA-3063, option B) ───────────────────────────
// Four binding scope points, each load-bearing:
//
//   1. BOTH SURFACES. The `top5Movers` array *and* the pre-rendered `markdown`
//      string. `markdown` is frozen at generation time and is the surface the
//      News tab and session reviews render, so an array-only stamp is the partial
//      fix that reads as complete.
//   2. ADDITIVE, AT READ TIME. The 64 files on disk are NOT rewritten. The
//      byte-intact file is the published record of what we served on that date;
//      annotate the response, never the artifact.
//   3. SELF-DATING. The stamp names the rule id, the threshold and the build SHA
//      that produced the verdict — not a bare `suspect`. This is what stops the
//      "the same URL answers differently after a deploy" objection from
//      transferring onto the stamp: a later threshold change RE-ANNOTATES rather
//      than silently contradicts.
//   4. NO REORDERING OR RENUMBERING. #1 stays #1, flagged.
//
// Option A (read-time FILTER) was declined, not deferred, and the reason matters
// for anyone tempted to "finish the job" here: filtering makes a fabricated
// headline QUIET. Every ticket in this family exists because a human SAW a bad
// row at #1. It would also spend the archive's integrity — a stored EOD report is
// not a view of the data, it is the record of what we published that day, and a
// corpus that re-answers itself per deploy is not evidence for a go-live case.
// Re-open A only on a named consumer that reads these archives as fact DESPITE a
// stamp on both surfaces.
//
// ── Jurisdiction, stated so a clean stamp is not over-read ────────────────────
// This applies the SESSION-MOVE rule (`assessQuotePlausibility`, r >= 2) only:
// does one row's own `price` and `changePct` believe each other? It is NOT the
// TRA-2634 cross-artifact continuity test, which needs the adjacent prior
// session's artifact and would make a read of one date a read of two. So
// `verdict: 'plausible'` means "this rule found nothing", not "verified" — and
// the markdown note says so in as many words. It is also the exact predicate
// `scripts/tra2610-archive-scan.mjs` grades with, so the stamp and the published
// 64/105 census cannot disagree.

import type { EodMover, EodReport, MoverProvenance } from '@trading-app/shared';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO } from '@trading-app/shared';
import { formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';

/**
 * Rule identity carried by every stamp. Versioned by the ticket that DERIVED the
 * threshold, not by the ticket that shipped the stamp: a reader who wants to know
 * why `2` chased down `SUSPECT_MOVE_RATIO`'s derivation, which lives on TRA-2379.
 */
export const MOVER_PROVENANCE_RULE_ID = 'TRA-2379:session-move-ratio';

/** Inline marker appended inside the offending markdown row's last cell. */
export const INLINE_SUSPECT_MARK = '⚠️ UNVERIFIED';

/** Anything with a top-movers table. Journal calendar cells qualify structurally. */
type ReportLike = Pick<EodReport, 'top5Movers'> & { markdown?: string };

function assess(m: EodMover, build: string): MoverProvenance {
  const v = assessQuotePlausibility({ price: m.price, changePct: m.changePct });
  const base = {
    ruleId: MOVER_PROVENANCE_RULE_ID,
    threshold: SUSPECT_MOVE_RATIO,
    ratio: v.ratio,
    impliedPrevClose: v.impliedPrevClose,
    build,
  };
  if (v.suspect) return { ...base, verdict: 'suspect', ...(v.reason ? { reason: v.reason } : {}) };
  // `assessQuotePlausibility` returns a NON-suspect verdict for the rows it has
  // no jurisdiction over (price <= 0 / non-finite, or a row carrying neither a
  // change nor a percentage). Those are blind spots, not passes, and collapsing
  // them into `plausible` is precisely the "absence of a flag reads as clean"
  // mistake TRA-2610 was filed on.
  if (v.ratio === null) return { ...base, verdict: 'unassessable' };
  return { ...base, verdict: 'plausible' };
}

/** `0.0240` — enough significant figures to re-derive the ratio by hand. */
function num(x: number | null): string {
  return x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(4);
}

function moverCell(m: EodMover): string {
  const price = Number.isFinite(m.price) ? `$${Math.abs(m.price).toFixed(2)}` : 'n/a';
  const pct = Number.isFinite(m.changePct)
    ? `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`
    : 'n/a';
  return `${price} / ${pct}`;
}

/**
 * The block appended under the movers table.
 *
 * Rendered as a blockquote so it survives every markdown renderer we serve into
 * (including the desktop app's minimal one, which passes unknown lines through)
 * and cannot be mistaken for part of the published table.
 *
 * `unlocated` is NOT swallowed: if the annotator could not find a suspect row's
 * line in the stored document to mark it in place, that is a partial stamp and
 * the note says so, because a silently-unmarked row reads exactly like a clean
 * one.
 */
function buildProvenanceNote(
  stamped: EodMover[],
  build: string,
  unlocated: EodMover[],
  tableLocated: boolean,
): string {
  const suspect = stamped.filter(m => m.provenance?.verdict === 'suspect');
  const unassessable = stamped.filter(m => m.provenance?.verdict === 'unassessable');
  const rule = `rule \`${MOVER_PROVENANCE_RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}\`), build \`${build}\``;
  const jurisdiction =
    '> _Session-move test only — it asks whether a row\'s own price and change % believe each other. '
    + 'It is **not** the TRA-2634 cross-artifact continuity test, so a row it does not flag is unflagged, not verified._';

  if (suspect.length === 0 && unassessable.length === 0) {
    return [
      `> **Provenance:** all ${stamped.length} row(s) above pass — stamped at read time by ${rule}.`,
      jurisdiction,
    ].join('\n');
  }

  const rows = stamped
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.provenance?.verdict !== 'plausible')
    .map(({ m, i }) => {
      const p = m.provenance!;
      return `> | ${i + 1} | ${m.symbol} | ${moverCell(m)} | ${p.verdict}${p.reason ? ` (${p.reason})` : ''} | ${num(p.impliedPrevClose)} | ${p.ratio === null ? 'n/a' : p.ratio.toFixed(2)} |`;
    });

  const headline = suspect.length > 0
    ? `> ⚠️ **PROVENANCE — ${suspect.length} of the ${stamped.length} row(s) above is UNVERIFIED and is RETAINED, not corrected.**`
    : `> ⚠️ **PROVENANCE — ${unassessable.length} of the ${stamped.length} row(s) above could not be assessed.**`;

  const lines = [
    headline,
    `> Stamped at read time by ${rule}.`,
    '> The stored report is served **byte-intact**: rows are not filtered, re-ranked or renumbered, so'
    + ' the numbers below are exactly what we published on this date (TRA-2631, ruling TRA-3063 = B).',
    jurisdiction,
    '>',
    '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
    '> |---|--------|-----------|---------|--------------------|-------|',
    ...rows,
  ];

  if (!tableLocated) {
    lines.push(
      '>',
      `> ⛔ The \`${MOVERS_MARKDOWN_HEADING}\` table could not be located in this stored document,`
      + ' so this note is appended at the end and **no row is marked in place**. The verdicts above'
      + ' still stand — they are computed from the JSON rows, not from this text.',
    );
  } else if (unlocated.length > 0) {
    lines.push(
      '>',
      `> ⛔ ${unlocated.length} of the flagged row(s) (${unlocated.map(m => m.symbol).join(', ')})`
      + ' could not be matched to a line in the table above (this document was rendered by an older'
      + ' formatter), so they carry **no inline mark** — read this note as the complete list, not the table.',
    );
  }

  return lines.join('\n');
}

/**
 * Mark the offending rows in place and append the note under the table.
 *
 * Fails OPEN but LOUD: an unrecognisable document still gets the note (at the
 * end), and the note says the table was not found. Returning the string
 * unchanged would be the worst outcome — a served document that looks stamped
 * on the JSON surface and is silent on the rendered one.
 */
export function annotateMoversMarkdown(markdown: string, stamped: EodMover[], build: string): string {
  const lines = markdown.split('\n');
  const headingIdx = lines.findIndex(l => l.trim() === MOVERS_MARKDOWN_HEADING);
  const suspect = stamped.filter(m => m.provenance?.verdict === 'suspect');

  if (headingIdx === -1) {
    return `${markdown}\n\n${buildProvenanceNote(stamped, build, suspect, false)}\n`;
  }

  // The table runs from the heading to the next heading (or EOF).
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) { endIdx = i; break; }
  }

  const unlocated: EodMover[] = [];
  for (const m of suspect) {
    const want = formatMoverMarkdownRow(m);
    let hit = -1;
    for (let i = headingIdx + 1; i < endIdx; i++) {
      if (lines[i]!.trim() === want) { hit = i; break; }
    }
    if (hit === -1) { unlocated.push(m); continue; }
    // Mark INSIDE the last cell: appending a fourth cell would break the
    // three-column header and some renderers drop the overflow entirely. The
    // published price and percentage are left untouched — the row is flagged,
    // not corrected.
    lines[hit] = lines[hit]!.replace(/\s*\|\s*$/, ` ${INLINE_SUSPECT_MARK} (see note below) |`);
  }

  // Trailing blank lines inside the section belong after the note, not before.
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;

  const note = buildProvenanceNote(stamped, build, unlocated, true);
  lines.splice(insertAt, 0, '', note);
  return lines.join('\n');
}

/**
 * Stamp a report for SERVING. Pure: the input object is never mutated, because
 * some callers hand us a cached/shared cell.
 *
 * A report with no movers is returned UNCHANGED — there is nothing to stamp, and
 * a note under an empty table is noise (this is what keeps journal calendar
 * cells, which carry no movers, byte-identical to what they serve today).
 */
export function annotateReportProvenance<T extends ReportLike>(report: T, build: string): T {
  if (!report || !Array.isArray(report.top5Movers) || report.top5Movers.length === 0) return report;

  const stamped = report.top5Movers.map(m => ({ ...m, provenance: assess(m, build) }));
  const md = typeof report.markdown === 'string' && report.markdown.length > 0
    ? { markdown: annotateMoversMarkdown(report.markdown, stamped, build) }
    : {};
  return { ...report, top5Movers: stamped, ...md } as T;
}
