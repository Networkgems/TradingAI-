/**
 * The ```deploy-order block — the ONE machine-readable record of WHAT a deploy carrier
 * was ordered to put on the box and BY WHEN.
 *
 * Extracted from `check-deploy-train-window.mjs` (TRA-3533) for TRA-3713, which needs
 * the same `deadline` field to decide whether a LATE fire landed inside or outside the
 * window its own body reasoned about.
 *
 * ⛔ IT IS AN EXTRACTION, NOT A REWRITE. `check-deploy-train-window.mjs` imports and
 * re-exports these two so its public surface and its controls are unchanged; the reason
 * it could not simply be imported the other way round is that it calls `main()` at
 * MODULE SCOPE, so importing it runs a full live grade and `process.exit()`s the
 * importer. That is the same trap `scripts/lib/paperclip-enumeration.mjs` was extracted
 * to survive, and the same reason `gradeAncestry` is a deliberate local copy there.
 */

/**
 * A deploy mention is an ORDER only if it is not inside a prohibition or a retraction.
 * Both lists are matched per-LINE, because a body that both orders a deploy and quotes
 * the freeze rule is normal and must still classify as TRAIN.
 */
const ORDER_PATTERNS = [
  /render-redeploy\.mjs/i,
  /\/v1\/services\/[^\s`'"]*\/deploys/i,
  /\bre-?deploy\b[^.\n]{0,90}\b(bqb1|tradingai-bqb1|srv-[a-z0-9]+)\b/i,
  /\bdeploy\b[^.\n]{0,90}\b(bqb1|tradingai-bqb1|srv-[a-z0-9]+)\b/i,
  /\b(bqb1|tradingai-bqb1)\b[^.\n]{0,90}\bre-?deploy\b/i,
];

const NEGATION_PATTERNS = [
  /\b(do not|do NOT|don't|never|must not|shall not|cannot|can't|no longer|refus\w*|forbidden|prohibit\w*|instead of|rather than|deprecated|superseded|supersedes|retract\w*|withdrawn|is not an order|not an order)\b/i,
];

const OPT_OUT_MARKER = /<!--\s*deploy-order:\s*none\s*-->/i;

/**
 * Is a deploy mention on this line an ORDER, or is it being quoted in order to be
 * forbidden? Exported so the controls can pin it directly.
 */
export function lineOrdersDeploy(line) {
  if (!ORDER_PATTERNS.some((re) => re.test(line))) return false;
  if (NEGATION_PATTERNS.some((re) => re.test(line))) return false;
  return true;
}

/**
 * 3-way classification with the matched span carried out, so a finding can be resolved
 * by reading the line rather than by trusting the label.
 *
 * @returns {{ kind: 'train'|'not-train'|'ambiguous', span: string|null, reason: string }}
 */
export function classifyCarrier(description) {
  const body = typeof description === 'string' ? description : '';

  // The block IS the order. It short-circuits the prose predicate in both directions:
  // it promotes a body whose wording the patterns would miss, and it gives an author a
  // way to settle a false AMBIGUOUS without arguing with a regex.
  if (findOrderBlocks(body).length > 0) {
    return { kind: 'train', span: '```deploy-order block present', reason: 'explicit deploy-order block' };
  }

  if (OPT_OUT_MARKER.test(body)) {
    return { kind: 'not-train', span: null, reason: 'explicit `deploy-order: none` opt-out' };
  }

  const lines = body.split(/\r?\n/);
  const ordering = lines.filter((l) => lineOrdersDeploy(l));
  if (ordering.length > 0) {
    return { kind: 'train', span: ordering[0].trim().slice(0, 200), reason: 'prose orders a deploy' };
  }

  const mentions = lines.filter((l) => ORDER_PATTERNS.some((re) => re.test(l)));
  if (mentions.length > 0) {
    // Every mention was negated. That is USUALLY a retraction or a quoted freeze rule
    // and genuinely not a train — but a substring grep cannot prove which, and dropping
    // it silently is the fail-open. One human glance at the printed span settles it.
    return {
      kind: 'ambiguous',
      span: mentions[0].trim().slice(0, 200),
      reason: 'mentions deploying, every mention inside a prohibition or retraction',
    };
  }

  return { kind: 'not-train', span: null, reason: 'no deploy mention' };
}

/** Every ```deploy-order fenced block in a body, as raw inner text. */
export function findOrderBlocks(body) {
  const out = [];
  const re = /^[ \t]*(?:```|~~~)[ \t]*deploy-order[ \t]*\r?\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/gim;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Parse THE order. Fails closed and NAMES the missing field: a half-parsed order that
 * defaults its deadline is worse than no order at all, because it grades.
 *
 * @returns {{ ok: true, order: {commit,host,deadlineMs,deadline} } | { ok: false, error: string }}
 */
export function parseDeployOrder(description) {
  const body = typeof description === 'string' ? description : '';
  const blocks = findOrderBlocks(body);
  if (blocks.length === 0) return { ok: false, error: 'no ```deploy-order block' };
  if (blocks.length > 1) {
    return { ok: false, error: `${blocks.length} deploy-order blocks — which one is the order?` };
  }

  const fields = {};
  for (const line of blocks[0].split(/\r?\n/)) {
    const m = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m) fields[m[1].toLowerCase()] = m[2];
  }

  const missing = ['commit', 'host', 'deadline'].filter((k) => !fields[k]);
  if (missing.length > 0) return { ok: false, error: `deploy-order missing: ${missing.join(', ')}` };

  const commit = fields.commit.replace(/^`|`$/g, '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return { ok: false, error: `deploy-order commit is not a sha: ${JSON.stringify(commit)}` };
  }

  // ⛔ MUST end in Z. Routine crons are evaluated in ET and these windows are written in
  // UTC; a bare `2026-08-13T13:25:00` would be read as local time by Date.parse on some
  // runtimes and as UTC on others, and both answers look equally confident.
  const deadline = fields.deadline.trim();
  if (!/Z$/.test(deadline)) {
    return { ok: false, error: `deadline must be an absolute UTC instant ending in Z, got ${JSON.stringify(deadline)}` };
  }
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return { ok: false, error: `unparseable deadline ${JSON.stringify(deadline)}` };

  return { ok: true, order: { commit, host: fields.host.trim(), deadline, deadlineMs } };
}
