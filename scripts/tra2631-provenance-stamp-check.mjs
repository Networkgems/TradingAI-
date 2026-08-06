// TRA-2631 / TRA-3063 (ruling B) — grade the READ-TIME PROVENANCE STAMP on the
// archive as it is actually SERVED.
//
// The companion to `tra2610-archive-scan.mjs`. That one asks "how many stored
// tables carry a fabricated row?" (64 of 105, all at #1). This one asks the
// question the ruling turns on: **does the response say so, on BOTH surfaces?**
//
// Both surfaces, because `markdown` is built at generation time and frozen into
// the stored file — a stamp that lands only on the `top5Movers` array is
// invisible on the surface the News tab and session reviews render, i.e. the
// partial fix that reads as complete. So a row is only GRADED PASS when the JSON
// row carries `provenance.verdict === 'suspect'` AND the served markdown marks
// that row in place AND the self-dating note (rule id + threshold + build) is
// present.
//
// It also grades the two properties the ruling made binding, because "flag, do
// not filter" is only checkable against the artifact itself:
//
//   • NOT FILTERED — the markdown table and the JSON array carry the SAME number
//     of rows. A filter applied to one surface and not the other shows up here as
//     a count divergence; a filter applied to both would show up as a dirty
//     artifact that this scan can no longer see at all (which is exactly why the
//     64/105 census is re-run alongside, not replaced).
//   • NOT RE-RANKED — a stamped suspect row is reported WITH ITS RANK. The
//     ruling says #1 stays #1, flagged, so a suspect row that has quietly moved
//     off #1 is a FAILURE here, not a success.
//
// Exit: 0 PASS · 1 FAIL (served but unstamped / stamped on one surface only /
//       re-ranked) · 2 NOT_DEPLOYED (nothing served carries a stamp at all — the
//       honest pre-deploy answer, deliberately NOT folded into FAIL) · 3 BLIND
//       (no table readable, or a control failed).
//
// ⛔ Zero graded rows is BLIND, never PASS. An archive that has rolled clean
// would otherwise report "0 failures" and read identically to a shipped fix.
import fs from 'node:fs';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO } from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const RULE_ID = 'TRA-2379:session-move-ratio';
const INLINE_MARK = '⚠️ UNVERIFIED';
const MOVERS_HEADING = '## Top 5 Movers (Watchlist)';

// Creds from `.env` if this checkout has one, else from the process env. A
// missing `.env` must not throw: a stack trace is an unreadable verdict, and
// this check's whole contract is that an unanswerable question exits BLIND.
function loadEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}
const fileEnv = loadEnv();
const env = {
  ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? fileEnv.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? fileEnv.ADMIN_PASSWORD,
};

// ── controls (run first; a failed control is BLIND, not a verdict) ────────────
function selftest() {
  const fails = [];
  // The real 2026-07-21 row. If the rule ever stops calling this suspect, this
  // whole check is grading nothing.
  const selx = assessQuotePlausibility({ price: 0.34, changePct: 1316.67 });
  if (!selx.suspect) fails.push('control: SELX 0.34/+1316.67% must be suspect');
  // And the genuine near-doubling just under the bar must NOT be.
  const inlf = assessQuotePlausibility({ price: 6.27, changePct: 97.17 });
  if (inlf.suspect) fails.push('control: INLF 6.27/+97.17% must NOT be suspect');
  // The markdown grader must actually be able to fail.
  if (markdownMarks('| SELX | $0.34 | +1316.67% |', { symbol: 'SELX', price: 0.34, changePct: 1316.67 })) {
    fails.push('control: an UNMARKED row must not grade as marked');
  }
  return fails;
}

/** Is this mover's row marked in place in the served markdown? */
function markdownMarks(markdown, m) {
  const usd = '$' + Math.abs(m.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2);
  const head = `| ${m.symbol} | ${usd} | ${pct}% `;
  return markdown.split('\n').some(l => l.startsWith(head) && l.includes(INLINE_MARK));
}

/** Rows in the served markdown movers table — for the not-filtered check. */
function markdownRowCount(markdown) {
  const lines = markdown.split('\n');
  const h = lines.findIndex(l => l.trim() === MOVERS_HEADING);
  if (h === -1) return null;
  let n = 0;
  for (let i = h + 3; i < lines.length; i++) {           // +3 skips heading + 2 header rows
    const l = lines[i].trim();
    if (l.startsWith('## ')) break;
    if (l.startsWith('|') && !l.startsWith('| #')) n++;  // '| #' is the note's own table
    else if (l.length > 0 && !l.startsWith('>')) break;
  }
  return n;
}

const controlFails = selftest();
if (controlFails.length > 0) {
  for (const f of controlFails) console.error(f);
  console.error('BLIND — controls failed, no verdict computed');
  process.exit(3);
}

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) { console.error(`login ${login.status} — BLIND`); process.exit(3); }
const token = (await login.json()).token;
const H = { Authorization: `Bearer ${token}` };

console.log(`host                 : ${HOST}`);
console.log(`rule                 : ${RULE_ID}  (SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO})`);
console.log('controls             : 3/3 green');

const etToday = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const findings = [];
let graded = 0, dirty = 0, stampedRows = 0, anyProvenanceSeen = false, readable = 0;

for (const fold of FOLDS) {
  const list = await fetch(`${HOST}/api/reports?mode=${fold}`, { headers: H });
  if (!list.ok) { console.log(`${fold.padEnd(8)} list ${list.status} — skipped`); continue; }
  const dates = ((await list.json()).dates ?? []).filter(d => d < etToday);
  for (const date of dates) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
    if (!r.ok) continue;
    let rep;
    try { rep = await r.json(); } catch { continue; }
    const mv = Array.isArray(rep.top5Movers) ? rep.top5Movers : [];
    if (mv.length === 0) continue;
    readable++;
    if (mv.some(m => m.provenance)) anyProvenanceSeen = true;

    // NOT FILTERED — both surfaces must carry the same number of rows.
    if (typeof rep.markdown === 'string' && rep.markdown.length > 0) {
      const n = markdownRowCount(rep.markdown);
      if (n !== null && n !== mv.length) {
        findings.push(`${fold} ${date}: SURFACE DIVERGENCE — ${mv.length} JSON rows vs ${n} markdown rows`);
      }
    }

    for (let i = 0; i < mv.length; i++) {
      const m = mv[i];
      graded++;
      if (!assessQuotePlausibility({ price: m.price, changePct: m.changePct }).suspect) continue;
      dirty++;
      const p = m.provenance;
      const problems = [];
      if (!p) problems.push('JSON row carries NO provenance');
      else {
        if (p.verdict !== 'suspect') problems.push(`verdict=${p.verdict} (expected suspect)`);
        if (p.ruleId !== RULE_ID) problems.push(`ruleId=${p.ruleId}`);
        if (p.threshold !== SUSPECT_MOVE_RATIO) problems.push(`threshold=${p.threshold}`);
        if (!p.build || p.build === 'unknown') problems.push('build SHA missing — the stamp is not self-dating');
      }
      if (typeof rep.markdown === 'string' && rep.markdown.length > 0) {
        if (!markdownMarks(rep.markdown, m)) problems.push('markdown row NOT marked in place');
        if (!rep.markdown.includes(RULE_ID)) problems.push('markdown note missing the rule id');
      }
      // NOT RE-RANKED: the ruling says #1 stays #1, flagged.
      if (i !== 0 && mv.slice(0, i).every(x => !assessQuotePlausibility({ price: x.price, changePct: x.changePct }).suspect)) {
        problems.push(`suspect row sits at rank ${i + 1} behind only clean rows — was it demoted?`);
      }
      if (problems.length === 0) stampedRows++;
      else findings.push(`${fold} ${date} #${i + 1} ${m.symbol} ${m.price}/${m.changePct}%: ${problems.join('; ')}`);
    }
  }
}

console.log(`artifacts readable   : ${readable}`);
console.log(`rows graded          : ${graded}`);
console.log(`rows the rule flags  : ${dirty}`);
console.log(`flagged AND stamped  : ${stampedRows}/${dirty} (both surfaces)`);

if (readable === 0 || graded === 0) {
  console.error('BLIND — no top-movers table was readable; a zero here is not a pass');
  process.exit(3);
}
if (!anyProvenanceSeen) {
  console.log('\nNOT_DEPLOYED — nothing served carries a provenance stamp.');
  console.log('This is the honest pre-deploy answer, not a failure: merge is not deploy');
  console.log('(bqb1 runs autoDeploy=no). Re-run after the deploy that carries the stamp.');
  process.exit(2);
}
if (findings.length > 0) {
  console.log('\nFINDINGS');
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nPASS — every row the rule flags is stamped on both surfaces, at its published rank.');
process.exit(0);
