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

/**
 * TRA-5052 — CAN THE SANCTIONED PATH ACCEPT A DEPLOY AT THE INSTANT THE DEADLINE NAMES?
 *
 * A `deadline` used to be graded only against ancestry and the clock, so an order whose
 * deadline sits INSIDE the RTH freeze (13:25–20:00Z Mon–Fri) graded PENDING — benign —
 * right up to the deadline and then paged as STRANDED the moment it passed. But the only
 * approved executor, `scripts/render-redeploy.mjs`, REFUSES at that instant (exit 4): the
 * deadline was never reachable through the sanctioned path, which is an AUTHORING defect
 * wanting a different person to do a different thing than a stranded deploy does.
 * Measured 2026-10-02: 4 of 5 live block-carrying orders named 13:25:00Z — the FIRST
 * frozen instant, one minute past the last usable one — as house style, by two authors,
 * across five days. The honest weekday boundary is 13:24Z; the same instant on a weekend
 * is OPEN, so a blanket "reject 13:25Z" would be wrong, and so would a day-blind rule
 * (TRA-2313 is two of us reading the one freeze annotation backwards).
 *
 * ⛔ THE PREDICATES ARE INJECTED, NOT RE-DERIVED. A second copy of 13:25–20:00Z is a
 * second thing to get backwards. Callers pass `freezeState` / `embargoState` /
 * `activeCadenceCeiling` and the tables from `scripts/render-redeploy.mjs` itself — the
 * executor's own gates, byte-for-byte (that module is import-safe: its `main()` is gated
 * on `invokedDirectly`). This lib stays import-free, as `check-slot-loss.mjs` requires.
 *
 * ⛔ FAILS CLOSED. Missing predicates, an unreadable deadline, or a gate whose answer
 * needs state this function cannot read all grade `unread`, never `open` — "I could not
 * check the gate" and "the gate is open" must not share a code. The cadence ceiling is
 * the structurally unreadable one: a `CADENCE_CEILINGS` row covering the deadline makes
 * reachability depend on whether that window's quota is already SPENT, which is Render
 * deploy history, not table membership, so an active row reads `unread` here.
 *
 * @returns {{ gate: 'open'|'refused'|'unread', detail: string|null }}
 */
export function gradeDeadlineGates(deadlineMs, { freezeState, embargoState, activeCadenceCeiling, embargoes, cadenceCeilings } = {}) {
  if (!Number.isFinite(deadlineMs)) {
    return { gate: 'unread', detail: 'unreadable deadline instant — "could not check the gate" is not "the gate is open"' };
  }
  if (
    typeof freezeState !== 'function' || typeof embargoState !== 'function' ||
    typeof activeCadenceCeiling !== 'function' || !Array.isArray(embargoes) || !Array.isArray(cadenceCeilings)
  ) {
    return { gate: 'unread', detail: 'gate predicates not injected — "could not check the gate" is not "the gate is open"' };
  }

  const when = new Date(deadlineMs);
  const iso = when.toISOString();

  if (freezeState(when)?.frozen) {
    return {
      gate: 'refused',
      detail:
        `deadline ${iso} is INSIDE the RTH freeze (13:25–20:00Z Mon–Fri) — scripts/render-redeploy.mjs exits 4 at ` +
        'that instant, so the sanctioned path cannot act at the boundary this order names; the last deployable ' +
        'weekday minute is 13:24Z, and the weekend is OPEN',
    };
  }

  const embargo = embargoState(when, embargoes)?.active ?? null;
  if (embargo) {
    return {
      gate: 'refused',
      detail: `deadline ${iso} is inside the dated embargo ${embargo.from} → ${embargo.to} (${embargo.ticket}) — scripts/render-redeploy.mjs exits 5 there`,
    };
  }

  const ceiling = activeCadenceCeiling(when, cadenceCeilings);
  if (ceiling) {
    return {
      gate: 'unread',
      detail:
        `a CADENCE_CEILINGS row (${ceiling.ticket}; max ${ceiling.max}/window) covers deadline ${iso} — whether that ` +
        "window's quota is already spent is Render deploy history this predicate does not read, so the gate is UNREAD, not open",
    };
  }

  return { gate: 'open', detail: null };
}
