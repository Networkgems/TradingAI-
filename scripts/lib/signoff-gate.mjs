// signoff-gate.mjs — TRA-5265. Pure predicate + reader for render-redeploy's exit-11 gate.
//
// THE GAP. Every other gate in render-redeploy.mjs is indexed on WHEN/WHERE you deploy or on
// whether the target moves BACKWARDS. None asks whether a commit in live..target carries an
// authorization nobody has given. 2026-10-07: 9abf167f (TRA-5118, "sign-off at deploy time")
// rode into bqb1 as the PARENT of an unrelated fix, 3m10s before the sign-off was posted.
//
// Registry: ops/deploy-signoffs.json — `requires[]` (sha, ticket, why) and `grants[]`
// (sha, ticket, decision, by, ref, at). Granting is an APPEND; `requires` is never edited.
// A missing file is BLIND (not clear): the gate cannot be disarmed by deleting its input.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SIGNOFF_FILE = 'ops/deploy-signoffs.json';
const REQ_FIELDS = ['sha', 'ticket', 'why'];
const GRANT_FIELDS = ['sha', 'ticket', 'decision', 'by', 'ref', 'at'];
const FULL_SHA = /^[0-9a-f]{40}$/i;
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

// → { verdict: 'OK' | 'BLIND', requires, grants, why, path }
export function readSignoffs(root, file = SIGNOFF_FILE) {
  const blind = why => ({ verdict: 'BLIND', requires: [], grants: [], why, path: file });
  let raw;
  try {
    const base = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
    raw = readFileSync(new URL(file, pathToFileURL(base)), 'utf8');
  } catch (err) {
    return blind(`${file} could not be read (${err?.code ?? err?.message ?? err})`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return blind(`${file} is not valid JSON (${err?.message ?? err})`);
  }
  for (const [key, fields] of [['requires', REQ_FIELDS], ['grants', GRANT_FIELDS]]) {
    if (!Array.isArray(doc?.[key])) return blind(`${file} has no \`${key}\` array (found ${typeof doc?.[key]})`);
    for (const [i, r] of doc[key].entries()) {
      if (!r || typeof r !== 'object') return blind(`${file} ${key}[${i}] is not an object`);
      const missing = fields.filter(k => !nonEmpty(r[k]));
      if (missing.length) {
        return blind(`${file} ${key}[${i}]${nonEmpty(r.ticket) ? ` (${r.ticket})` : ''} is missing field(s): ${missing.join(', ')}`);
      }
      // Full 40-hex only: a prefix could silently match a different commit later.
      if (!FULL_SHA.test(r.sha)) {
        return blind(`${file} ${key}[${i}] sha must be a full 40-hex commit id (got ${JSON.stringify(r.sha.slice(0, 48))})`);
      }
      if (key === 'grants' && !['approve', 'decline'].includes(r.decision)) {
        return blind(`${file} grants[${i}] decision must be "approve" or "decline" (got ${JSON.stringify(r.decision)})`);
      }
    }
  }
  return { verdict: 'OK', requires: doc.requires, grants: doc.grants, why: null, path: file };
}

// isAncestor(a, b) → true | false | null (cannot tell). live.sha may be null (unreadable).
// → { verdict: 'CLEAR' | 'UNMET' | 'BLIND', unmet: [{...require, state}], inRange, why }
export function signoffState(read, { target, live }, isAncestor) {
  if (read.verdict === 'BLIND') return { verdict: 'BLIND', unmet: [], inRange: 0, why: read.why };
  if (!read.requires.length) return { verdict: 'CLEAR', unmet: [], inRange: 0, why: null };
  if (!target?.sha) {
    return { verdict: 'BLIND', unmet: [], inRange: 0, why: 'the deploy target did not resolve to a sha, so live..target cannot be enumerated' };
  }
  const unmet = [];
  const blindWhy = [];
  let inRange = 0;
  for (const r of read.requires) {
    const inTarget = isAncestor(r.sha, target.sha);
    if (inTarget === null) {
      blindWhy.push(`cannot tell whether ${r.sha.slice(0, 8)} (${r.ticket}) is in the target`);
      continue;
    }
    if (!inTarget) continue;
    // Already serving ⇒ not a passenger of THIS deploy. Unknown live ⇒ assume it ships.
    if (live?.sha && isAncestor(r.sha, live.sha) === true) continue;
    inRange++;
    const grants = read.grants.filter(g => g.sha.toLowerCase() === r.sha.toLowerCase());
    if (grants.some(g => g.decision === 'decline')) unmet.push({ ...r, state: 'DECLINED' });
    else if (!grants.some(g => g.decision === 'approve')) unmet.push({ ...r, state: 'UNMET' });
  }
  if (unmet.length) return { verdict: 'UNMET', unmet, inRange, why: null };
  if (blindWhy.length) return { verdict: 'BLIND', unmet: [], inRange, why: blindWhy.join('; ') };
  return { verdict: 'CLEAR', unmet: [], inRange, why: null };
}

export const signoffBlocks = verdict => verdict !== 'CLEAR';

export const signoffOverrideNamesTicket = reason => /\bTRA-\d+\b/.test(reason ?? '');

export function renderSignoffRefusal(state, { live, target } = {}) {
  const head =
    state.verdict === 'BLIND'
      ? `[render-redeploy] REFUSED: the deploy sign-off registry cannot be trusted — BLIND, not clear (TRA-5265).\n  blind   : ${state.why}\n`
      : `[render-redeploy] REFUSED: live..target CARRIES ${state.unmet.length} COMMIT(S) WITH NO RECORDED SIGN-OFF (TRA-5265).\n` +
        state.unmet.map(u => `  ✗ ${u.sha.slice(0, 12)}  ${u.state}  — owed on ${u.ticket}: ${u.why}`).join('\n') +
        '\n';
  return (
    head +
    `  live    : ${live?.sha ?? '(unreadable)'}\n  target  : ${target?.sha ?? '(unresolved)'}\n` +
    `  These commits would ship as PASSENGERS of this deploy. Obtain the sign-off on the named ticket and append a\n` +
    `  grant to ops/deploy-signoffs.json (the requires row is never edited), or deploy a commit that predates them.\n` +
    `  If it is truly urgent: --override-signoff="TRA-#### why" (must name a ticket; echoed on the record).`
  );
}

export function renderSignoffLine(state, { isSoakHost = true, overridden = false } = {}) {
  if (!isSoakHost) return '(not the soak host — gate N/A)';
  if (state.verdict === 'CLEAR') return `${state.inRange} registered commit(s) in live..target, all signed off`;
  return `${state.verdict}${overridden ? ', OVERRIDDEN (--override-signoff)' : ''}`;
}
