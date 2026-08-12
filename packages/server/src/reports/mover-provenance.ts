// TRA-2631 — READ-TIME FILTER + PROVENANCE STAMP for stored top-movers rows.
//
// ── What this exists for ──────────────────────────────────────────────────────
// 64 of the 105 stored EOD top-movers tables carry a row the deployed
// plausibility rule calls fabricated, and in all 64 it sits at **#1** — because
// `top5Movers` ranks on `|changePct|` (`eod-report.ts`), so an inflated move
// necessarily outranks the genuine ones. TRA-2610 fixed report GENERATION and
// six consecutive clean sessions say the fix holds; it does not, and cannot,
// rewrite files already on disk, and `GET /api/reports/{date}` serves those files
// verbatim. The LIVE fold is affected: live `latest` is 2026-07-21 with
// `SELX +1,316.67%` at #1.
//
// Regeneration is NOT available: no per-symbol quote tape is retained, so
// regenerating 2026-05-03 would stamp TODAY's movers onto a May date. (TRA-2689's
// feed-boundary ring does not rescue this — it is a bounded in-process ring that
// starts on 2026-07-30.) That is what forces a READ-TIME remedy.
//
// ── The ruling this implements ────────────────────────────────────────────────
// **Board, 2026-08-06, TRA-3020 card `09bee410`, relayed on TRA-3084: option A —
// read-time filter + provenance stamp on BOTH surfaces.**
//
// This SUPERSEDES the earlier CTO ruling on TRA-3063, which selected B (flag, do
// not filter) and which the previous revision of this file implemented. B's
// artifacts are not discarded — the per-row `MoverProvenance` stamp built for it
// is exactly what the audit trail under A needs — but its behaviour is inverted:
// a `suspect` row is now SUPPRESSED, not badged in place.
//
// Three binding scope points, each load-bearing and each with a test:
//
//   1. READ-TIME FILTER. Stored reports are not regenerable, so the fabricated
//      row is suppressed at READ. Nothing on disk is rewritten.
//   2. PROVENANCE STAMP, so a filtered report is visibly DISTINGUISHABLE from a
//      clean one. This is the half that keeps the filter honest and it is not
//      optional garnish: drop SELX from 2026-07-21 and what is left is a
//      four-row table indistinguishable from a table that always had four good
//      rows. Every response therefore states its own denominator
//      (`publishedCount` / `servedCount` / `filteredCount`), and a report that
//      filtered NOTHING still says so out loud.
//   3. BOTH SURFACES. The `top5Movers` array AND the pre-rendered `markdown`
//      string. `markdown` is frozen at generation time and is the surface the
//      News tab and session reviews render, so an array-only filter would leave
//      the fabricated headline fully visible exactly where humans read it — a
//      partial fix that reads as complete. (The desktop Calendar grid renders
//      the array, so it is a third surface and gets the notice too.)
//
// ── What the filter deliberately does NOT do ──────────────────────────────────
// It suppresses `verdict: 'suspect'` ONLY. An `'unassessable'` row — one the rule
// has no jurisdiction over — is RETAINED and served with its stamp. Suppressing
// it would mean deleting published rows on the strength of a blind spot, which is
// a strictly worse error than showing a flagged one. `'unassessable'` is not a
// weaker `'suspect'`; it is the absence of a verdict.
//
// Nothing is destroyed. A suppressed row survives verbatim, with its published
// price and change % and its verdict, inside `moversProvenance.filtered`, and the
// stored file remains byte-intact on disk. A past citation of a published report
// is still verifiable — which was the standing objection to touching the archive
// at all, and it is answered by recoverability, not by inaction.
//
// ── Jurisdiction, stated so a clean stamp is not over-read ────────────────────
// This applies the SESSION-MOVE rule (`assessQuotePlausibility`, r >= 2) only:
// does one row's own `price` and `changePct` believe each other? It is NOT the
// TRA-2634 cross-artifact continuity test, which needs the adjacent prior
// session's artifact and would make a read of one date a read of two. So an
// unsuppressed row means "this rule found nothing", not "verified" — and the
// markdown note says so in as many words. It is also the exact predicate
// `scripts/tra2610-archive-scan.mjs` grades with, so the filter and the published
// 64/105 census cannot disagree.

import type { EodMover, EodReport, MoverProvenance, MoversFilterProvenance } from '@trading-app/shared';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO_FLOOR } from '@trading-app/shared';
import { formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';

/**
 * Rule identity carried by every stamp. Versioned by the ticket that DERIVED the
 * threshold, not by the ticket that shipped the filter: a reader who wants to know
 * why `1.9` chased down `SUSPECT_MOVE_RATIO_FLOOR`'s derivation, which lives on
 * TRA-3241 (the k = 2 proximity band under TRA-2379's anchor). Stamps are applied
 * at READ time, so historical artifacts re-served today carry the current rule —
 * bumping this id re-labels every serve, which is the versioning working.
 */
export const MOVER_PROVENANCE_RULE_ID = 'TRA-3241:session-move-ratio';

/** Anything with a top-movers table. Journal calendar cells qualify structurally. */
type ReportLike = Pick<EodReport, 'top5Movers'> & {
  markdown?: string;
  moversProvenance?: MoversFilterProvenance;
};

function assess(m: EodMover, build: string): MoverProvenance {
  const v = assessQuotePlausibility({ price: m.price, changePct: m.changePct });
  const base = {
    ruleId: MOVER_PROVENANCE_RULE_ID,
    threshold: SUSPECT_MOVE_RATIO_FLOOR,
    ratio: v.ratio,
    impliedPrevClose: v.impliedPrevClose,
    build,
  };
  if (v.suspect) return { ...base, verdict: 'suspect', ...(v.reason ? { reason: v.reason } : {}) };
  // `assessQuotePlausibility` returns a NON-suspect verdict for the rows it has
  // no jurisdiction over (price <= 0 / non-finite, or a row carrying neither a
  // change nor a percentage). Those are blind spots, not passes, and collapsing
  // them into `plausible` is precisely the "absence of a flag reads as clean"
  // mistake TRA-2610 was filed on. Under A it also decides retention: a blind
  // spot is RETAINED and flagged, never suppressed.
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
 * It is emitted on EVERY stamped report, including a clean one. That is scope
 * point 2: without it, a table whose fabricated #1 was silently dropped and a
 * table that was always clean render as the same four rows. The note is the only
 * thing on this surface that tells them apart.
 *
 * `unremoved` is NOT swallowed: if a suppressed row's line could not be located in
 * the stored document, the row is gone from the JSON array but still present in
 * the rendered table — a HALF-filtered report, which is worse than either end
 * state — so the note says so explicitly and names the rows.
 */
function buildProvenanceNote(
  served: EodMover[],
  suppressed: EodMover[],
  publishedCount: number,
  build: string,
  unremoved: EodMover[],
  tableLocated: boolean,
): string {
  const unassessable = served.filter(m => m.provenance?.verdict === 'unassessable');
  const rule = `rule \`${MOVER_PROVENANCE_RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = ${SUSPECT_MOVE_RATIO_FLOOR}\`), build \`${build}\``;
  const jurisdiction =
    '> _Session-move test only — it asks whether a row\'s own price and change % believe each other. '
    + 'It is **not** the TRA-2634 cross-artifact continuity test, so a row it did not suppress is unflagged, not verified._';

  // ── The clean branch. It still declares the denominator. ───────────────────
  if (suppressed.length === 0) {
    const lines = [
      `> **Provenance — 0 of ${publishedCount} row(s) suppressed; this table is as published.**`,
      `> Filtered at read time by ${rule} (TRA-2631, board ruling A).`,
    ];
    if (unassessable.length > 0) {
      lines.push(
        `> ⚠️ ${unassessable.length} row(s) (${unassessable.map(m => m.symbol).join(', ')}) could **not be assessed**`
        + ' by this rule and are RETAINED, not vouched for — the rule has no jurisdiction over them,'
        + ' which is not the same as passing.',
      );
    }
    lines.push(jurisdiction);
    return lines.join('\n');
  }

  const rows = suppressed.map((m, i) => {
    const p = m.provenance!;
    return `> | ${i + 1} | ${m.symbol} | ${moverCell(m)} | ${p.verdict}${p.reason ? ` (${p.reason})` : ''} | ${num(p.impliedPrevClose)} | ${p.ratio === null ? 'n/a' : p.ratio.toFixed(2)} |`;
  });

  const lines = [
    `> ⚠️ **PROVENANCE — ${suppressed.length} of ${publishedCount} published row(s) SUPPRESSED as unverified.`
    + ` ${served.length} row(s) shown above.**`,
    `> Filtered at read time by ${rule} (TRA-2631, board ruling A).`,
    '> The stored report on disk is **unchanged and byte-intact** — this is a read-time filter, not a rewrite,'
    + ' so the published artifact remains the record of what we served on this date. The suppressed rows are'
    + ' reproduced verbatim below and in the response\'s `moversProvenance.filtered`, so nothing is lost:',
    jurisdiction,
    '>',
    '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
    '> |---|--------|-----------|---------|--------------------|-------|',
    ...rows,
  ];

  if (unassessable.length > 0) {
    lines.push(
      '>',
      `> ⚠️ Separately, ${unassessable.length} row(s) still shown above (${unassessable.map(m => m.symbol).join(', ')})`
      + ' could **not be assessed** and are RETAINED, not vouched for. A blind spot is not a pass, and it is'
      + ' also not grounds to delete a published row.',
    );
  }

  if (!tableLocated) {
    lines.push(
      '>',
      `> ⛔ The \`${MOVERS_MARKDOWN_HEADING}\` table could not be located in this stored document, so this note`
      + ' is appended at the end and **no row was removed from the rendered table** — the JSON array is'
      + ' filtered and this text is not. Read the JSON surface as authoritative for this date.',
    );
  } else if (unremoved.length > 0) {
    lines.push(
      '>',
      `> ⛔ ${unremoved.length} of the suppressed row(s) (${unremoved.map(m => m.symbol).join(', ')}) could not be`
      + ' matched to a line in the table above (this document was rendered by an older formatter) and are'
      + ' therefore **still rendered in the table** while being absent from the JSON array. Treat the table'
      + ' above as containing those rows in error.',
    );
  }

  return lines.join('\n');
}

/**
 * Remove the suppressed rows from the rendered table and append the note.
 *
 * Fails OPEN but LOUD: an unrecognisable document still gets the note (at the
 * end), and the note says the table was not found. Returning the string unchanged
 * and silently would be the worst outcome — a served document filtered on the
 * JSON surface and untouched on the rendered one, with nothing saying so.
 *
 * Rows are DELETED, not blanked, and the remaining rows keep their published
 * order. There is no `#` column in the generated table, so removing a row cannot
 * renumber a survivor; the surviving rows' text is byte-identical to what was
 * published.
 */
export function annotateMoversMarkdown(
  markdown: string,
  served: EodMover[],
  suppressed: EodMover[],
  publishedCount: number,
  build: string,
): string {
  const lines = markdown.split('\n');
  const headingIdx = lines.findIndex(l => l.trim() === MOVERS_MARKDOWN_HEADING);

  if (headingIdx === -1) {
    const note = buildProvenanceNote(served, suppressed, publishedCount, build, suppressed, false);
    return `${markdown}\n\n${note}\n`;
  }

  // The table runs from the heading to the next heading (or EOF).
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) { endIdx = i; break; }
  }

  // Locate every suppressed row first, THEN delete — deleting as we go would
  // shift `endIdx` and the indices of rows not yet located.
  const unremoved: EodMover[] = [];
  const doomed = new Set<number>();
  for (const m of suppressed) {
    const want = formatMoverMarkdownRow(m);
    let hit = -1;
    for (let i = headingIdx + 1; i < endIdx; i++) {
      if (!doomed.has(i) && lines[i]!.trim() === want) { hit = i; break; }
    }
    if (hit === -1) { unremoved.push(m); continue; }
    doomed.add(hit);
  }

  const kept = lines.filter((_, i) => !doomed.has(i));
  const removedBefore = (idx: number) => [...doomed].filter(d => d < idx).length;
  const newEndIdx = endIdx - removedBefore(endIdx);
  const newHeadingIdx = headingIdx - removedBefore(headingIdx);

  // Trailing blank lines inside the section belong after the note, not before.
  let insertAt = newEndIdx;
  while (insertAt > newHeadingIdx + 1 && kept[insertAt - 1]!.trim() === '') insertAt--;

  const note = buildProvenanceNote(served, suppressed, publishedCount, build, unremoved, true);
  kept.splice(insertAt, 0, '', note);
  return kept.join('\n');
}

/**
 * Filter and stamp a report for SERVING. Pure: the input object is never mutated,
 * because some callers hand us a cached/shared cell.
 *
 * A report with no movers is returned UNCHANGED — there is nothing to filter, and
 * a note under an empty table is noise (this is what keeps journal calendar cells,
 * which carry no movers, byte-identical to what they serve today).
 *
 * Note the asymmetry that makes `moversProvenance` meaningful: it is attached
 * whenever the filter RAN, including when it suppressed nothing. Its ABSENCE
 * therefore means "this report never went through the filter", which is a
 * different fact from "this report was clean" — and the check script relies on
 * exactly that distinction to tell a working filter from a bypassed one.
 */
export function annotateReportProvenance<T extends ReportLike>(
  report: T,
  build: string,
): T & { moversProvenance?: MoversFilterProvenance } {
  if (!report || !Array.isArray(report.top5Movers) || report.top5Movers.length === 0) return report;

  const publishedCount = report.top5Movers.length;
  const stamped = report.top5Movers.map(m => ({ ...m, provenance: assess(m, build) }));
  const suppressed = stamped.filter(m => m.provenance.verdict === 'suspect');
  const served = stamped.filter(m => m.provenance.verdict !== 'suspect');

  const moversProvenance: MoversFilterProvenance = {
    ruleId: MOVER_PROVENANCE_RULE_ID,
    threshold: SUSPECT_MOVE_RATIO_FLOOR,
    build,
    publishedCount,
    servedCount: served.length,
    filteredCount: suppressed.length,
    filtered: suppressed,
  };

  const md = typeof report.markdown === 'string' && report.markdown.length > 0
    ? { markdown: annotateMoversMarkdown(report.markdown, served, suppressed, publishedCount, build) }
    : {};

  return { ...report, top5Movers: served, moversProvenance, ...md } as T;
}
