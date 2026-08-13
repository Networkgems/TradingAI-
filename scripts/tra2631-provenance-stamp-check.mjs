// TRA-2631 (board ruling A) — grade the READ-TIME FILTER + PROVENANCE STAMP on
// the archive as it is actually SERVED.
//
// The companion to `tra2610-archive-scan.mjs`. That one asks "how many stored
// tables carry a fabricated row?" (64 of 105, all at #1) and, since the filter
// shipped, reconstructs the PUBLISHED table before grading so its census is not
// blinded by this remedy. This one asks the question the ruling turns on:
// **were the fabricated rows actually suppressed, on BOTH surfaces, and does the
// response say so?**
//
// ── The verification bar, as the board set it ─────────────────────────────────
// *"Prove the filter actually matched rows. Count the rows filtered and fail at
// zero. A filter that matches nothing reads exactly like a clean corpus — that is
// the failure mode this whole issue is about, so do not reproduce it in the fix."*
//
// So `filteredRows === 0` across the corpus is a **FAIL**, not a pass. That is
// this check's single most important line and it is deliberately not softened
// into a warning.
//
// ── What is graded, per artifact ──────────────────────────────────────────────
//   • FILTER EFFECTIVE — no SERVED row is one the rule calls suspect. A leaked
//     row means the filter ran and missed, which is worse than not shipping.
//   • NOT OVER-FILTERED — every SUPPRESSED row is one the rule calls suspect.
//     Under A a false positive DELETES a genuine mover from the headline, so the
//     over-filtering control is not symmetric decoration; it is the expensive
//     direction. (QMCO at r = 1.642 is the live near-miss this protects —
//     TRA-3241 retired INLF at r = 1.9717 from the role, since the k = 2 band
//     now correctly flags that shape.)
//   • ARITHMETIC — `publishedCount === servedCount + filteredCount`, and
//     `servedCount` equals the array actually served. A stamp whose numbers do
//     not add up cannot be used to reconstruct the published table, which is what
//     the 2610 census now depends on.
//   • BOTH SURFACES — the markdown table carries exactly the served rows, and no
//     suppressed symbol survives in it. A filter applied to the JSON only would
//     leave the fabricated headline fully visible on the surface the News tab
//     renders: the partial fix that reads as complete.
//   • DISTINGUISHABLE — a filtered artifact says `SUPPRESSED` and a clean one
//     says `0 of N row(s) suppressed`. This is the half of A that stops the
//     remedy from becoming the defect: without it, a silently-filtered report and
//     a genuinely-clean one are the same bytes to a reader.
//   • SELF-DATING — rule id + threshold + a real build SHA on the stamp.
//
// Exit: 0 PASS · 1 FAIL (leaked row / over-filtered / surface divergence /
//       arithmetic / indistinguishable / **zero rows filtered corpus-wide**) ·
//       2 NOT_DEPLOYED (nothing served carries `moversProvenance` at all — the
//       honest pre-deploy answer, deliberately NOT folded into FAIL) · 3 BLIND
//       (no table readable, or a control failed).
//
// ⛔ Zero artifacts read is BLIND, never PASS. Zero rows FILTERED is FAIL, never
// PASS. The two zeros mean different things and are reported separately.
import fs from 'node:fs';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO_FLOOR } from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const RULE_ID = 'TRA-3241:session-move-ratio';
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
  ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? process.env.TRADING_ADMIN_USERNAME ?? fileEnv.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? process.env.TRADING_ADMIN_PASSWORD ?? fileEnv.ADMIN_PASSWORD,
};

/** The generator's row rendering. Must stay byte-identical to `formatMoverMarkdownRow`. */
function moverRow(m) {
  const usd = '$' + Math.abs(m.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2);
  return `| ${m.symbol} | ${usd} | ${pct}% |`;
}

/**
 * Data rows of the served markdown movers table.
 *
 * `null` means the table could not be located at all — which must NOT be read as
 * "zero rows". A missing table and an empty table are different facts and only
 * one of them is a finding.
 */
function markdownRows(markdown) {
  const lines = markdown.split('\n');
  const h = lines.findIndex(l => l.trim() === MOVERS_HEADING);
  if (h === -1) return null;
  const out = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('## ')) break;
    if (l.startsWith('>')) continue;                                  // the note, incl. its own table
    if (l.startsWith('| Symbol ') || l.startsWith('|---')) continue;  // header rows
    if (l.startsWith('|')) out.push(l);
  }
  return out;
}

// ── controls (run first; a failed control is BLIND, not a verdict) ────────────
function selftest() {
  const fails = [];
  // The real 2026-07-21 row. If the rule ever stops calling this suspect, this
  // whole check is grading nothing.
  const selx = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };
  if (!assessQuotePlausibility(selx).suspect) fails.push('control: SELX 0.34/+1316.67% must be suspect');
  // TRA-3241 — the factor-2 near-miss must BE suspect: MNST's real 2026-08-11
  // row (r = 1.99672, published -49.92% as the session's #1 loser, unflagged by
  // the old anchor). If the band ever stops firing here, the checker is grading
  // the pre-TRA-3241 rule.
  const mnst = { symbol: 'MNST', price: 45.79, changePct: -49.92 };
  if (assessQuotePlausibility(mnst).reason !== 'near_split_ratio') fails.push('control: MNST 45.79/-49.92% must be near_split_ratio suspect');
  // And a genuine large mover below the band must NOT be — under A this control
  // guards a DELETION, not a badge. QMCO is the 2026-08-11 tape's largest
  // plausibly-genuine mover (r = 1.642). INLF (+97.17%, r = 1.9717) retired from
  // this role: it sits INSIDE the k = 2 band, i.e. it was an MNST-shaped row all
  // along (TRA-3241).
  const qmco = { symbol: 'QMCO', price: 19.34, changePct: 64.18 };
  if (assessQuotePlausibility(qmco).suspect) fails.push('control: QMCO 19.34/+64.18% must NOT be suspect');
  // The row renderer must reproduce the archived line byte-for-byte, or the
  // surface check silently degrades to "no suppressed row found in the table",
  // which reads exactly like a correctly filtered table.
  if (moverRow(selx) !== '| SELX | $0.34 | +1316.67% |') {
    fails.push(`control: row renderer drifted — got ${moverRow(selx)}`);
  }
  // And the table parser must be able to SEE a row, else every artifact grades
  // as trivially consistent.
  const probe = markdownRows([MOVERS_HEADING, '| Symbol | Price | Change % |', '|---|---|---|', moverRow(qmco)].join('\n'));
  if (!probe || probe.length !== 1) fails.push(`control: table parser found ${probe?.length ?? 'null'} rows, expected 1`);
  return fails;
}

const controlFails = selftest();
if (controlFails.length > 0) {
  for (const f of controlFails) console.error(f);
  console.error('BLIND — controls failed, no verdict computed');
  process.exit(3);
}

if (!env.ADMIN_PASSWORD) { console.error('no admin password in env or .env — BLIND'); process.exit(3); }

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) { console.error(`login ${login.status} — BLIND`); process.exit(3); }
const token = (await login.json()).token;
const H = { Authorization: `Bearer ${token}` };

console.log(`host                 : ${HOST}`);
console.log(`rule                 : ${RULE_ID}  (SUSPECT_MOVE_RATIO_FLOOR = ${SUSPECT_MOVE_RATIO_FLOOR})`);
console.log('controls             : 4/4 green');

const etToday = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const findings = [];
let artifacts = 0, stamped = 0, filteredRows = 0, servedRows = 0, filteredArtifacts = 0;
let anyProvenanceSeen = false;

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
    const mp = rep.moversProvenance;
    // An artifact with neither served rows nor suppressed rows had no movers
    // table to begin with — not a graded population member.
    if (mv.length === 0 && !(mp && mp.filteredCount > 0)) continue;
    artifacts++;
    if (!mp) continue;                        // counted, ungraded — the NOT_DEPLOYED path
    anyProvenanceSeen = true;
    stamped++;

    const where = `${fold} ${date}`;
    const problems = [];
    const suppressed = Array.isArray(mp.filtered) ? mp.filtered : [];

    // ── ARITHMETIC ────────────────────────────────────────────────────────────
    if (mp.servedCount !== mv.length) problems.push(`servedCount=${mp.servedCount} but ${mv.length} rows served`);
    if (mp.filteredCount !== suppressed.length) problems.push(`filteredCount=${mp.filteredCount} but ${suppressed.length} rows carried`);
    if (mp.publishedCount !== mp.servedCount + mp.filteredCount) {
      problems.push(`published ${mp.publishedCount} != served ${mp.servedCount} + filtered ${mp.filteredCount}`);
    }

    // ── SELF-DATING ───────────────────────────────────────────────────────────
    if (mp.ruleId !== RULE_ID) problems.push(`ruleId=${mp.ruleId}`);
    if (mp.threshold !== SUSPECT_MOVE_RATIO_FLOOR) problems.push(`threshold=${mp.threshold}`);
    if (!mp.build || mp.build === 'unknown') problems.push('build SHA missing — the stamp is not self-dating');

    // ── FILTER EFFECTIVE: nothing suspect may survive into the served array ───
    for (let i = 0; i < mv.length; i++) {
      const v = assessQuotePlausibility({ price: mv[i].price, changePct: mv[i].changePct });
      if (v.suspect) {
        problems.push(`LEAKED — served row #${i + 1} ${mv[i].symbol} ${mv[i].price}/${mv[i].changePct}% is suspect (r=${v.ratio?.toFixed(2)})`);
      }
    }

    // ── NOT OVER-FILTERED: everything suppressed must be genuinely suspect ────
    for (const s of suppressed) {
      const v = assessQuotePlausibility({ price: s.price, changePct: s.changePct });
      if (!v.suspect) {
        problems.push(`OVER-FILTERED — suppressed ${s.symbol} ${s.price}/${s.changePct}% is NOT suspect (r=${v.ratio?.toFixed(2)}) — a genuine mover was deleted`);
      }
      if (s.provenance?.verdict !== 'suspect') problems.push(`suppressed ${s.symbol} carries verdict=${s.provenance?.verdict}`);
    }

    // ── BOTH SURFACES ─────────────────────────────────────────────────────────
    if (typeof rep.markdown === 'string' && rep.markdown.length > 0) {
      const rows = markdownRows(rep.markdown);
      if (rows === null) {
        // The note itself must then say the table was unlocatable — an
        // unexplained missing table is a finding, an explained one is not.
        if (!rep.markdown.includes('could not be located in this stored document')) {
          problems.push('markdown movers table not found and the note does not say so');
        }
      } else {
        if (rows.length !== mv.length) {
          problems.push(`SURFACE DIVERGENCE — ${mv.length} JSON rows vs ${rows.length} markdown rows`);
        }
        for (const s of suppressed) {
          if (rows.some(l => l === moverRow(s))) {
            problems.push(`HALF-FILTERED — ${s.symbol} suppressed from JSON but STILL RENDERED in the markdown table`);
          }
        }
      }
      if (!rep.markdown.includes(RULE_ID)) problems.push('markdown note missing the rule id');
      if (!rep.markdown.includes(String(mp.build))) problems.push('markdown note missing the build SHA');

      // ── DISTINGUISHABLE: filtered and clean must not read the same ──────────
      if (mp.filteredCount > 0) {
        if (!rep.markdown.includes('SUPPRESSED')) problems.push('filtered artifact does not SAY it was filtered — reads as clean');
        for (const s of suppressed) {
          if (!rep.markdown.includes(s.symbol)) problems.push(`note does not name the suppressed row ${s.symbol}`);
        }
      } else if (
        // TRA-3296 — a read-time-clean artifact now has TWO legal renderings, not
        // one, and this check must accept both or it condemns the entire archive.
        //
        //   • "…as published"            — the stored report carries a write-time
        //                                  record and that record is empty. The only
        //                                  state that earns the certificate.
        //   • "…suppressed at read time" — either the record exists and dropped
        //                                  rows, or the record is ABSENT (a pre-fix
        //                                  artifact, which renders UNKNOWN).
        //
        // ⛔ Do NOT relax this to a bare `includes('suppressed')`. The property being
        // graded is that the artifact STATES ITS DENOMINATOR, and both strings below
        // say a number out loud. A looser substring would make this leg a rubber
        // stamp — the exact defect the TRA-2610/2631/3296 family exists for.
        !rep.markdown.includes('row(s) suppressed; this table is as published')
        && !rep.markdown.includes('row(s) suppressed at read time')
      ) {
        problems.push('clean artifact does not state its denominator — silence is not an answer');
      }

      // ── TRA-3296 — the WRITE-TIME stage must state itself, in every branch ────
      // The original defect was a document that said nothing about a stage which
      // ran before it existed, while affirmatively certifying itself complete.
      // UNKNOWN is an acceptable answer for a pre-fix artifact; SILENCE is not.
      if (
        !rep.markdown.includes('Write-time exclusions: UNKNOWN')
        && !rep.markdown.includes('Write-time exclusions: none reached this table')
        && !rep.markdown.includes('dropped BEFORE this report was written')
      ) {
        problems.push(
          'note is SILENT about write-time exclusions (TRA-3296) — a stage that ran before the file existed');
      }
    }

    servedRows += mv.length;
    filteredRows += suppressed.length;
    if (suppressed.length > 0) filteredArtifacts++;
    if (problems.length > 0) findings.push(`${where}: ${problems.join('; ')}`);
  }
}

console.log(`artifacts read       : ${artifacts}`);
console.log(`artifacts stamped    : ${stamped}`);
console.log(`artifacts filtered   : ${filteredArtifacts}`);
console.log(`rows served          : ${servedRows}`);
console.log(`ROWS FILTERED        : ${filteredRows}   <-- the board's bar; zero is a FAIL, not a pass`);

if (artifacts === 0) {
  console.error('\nBLIND — no top-movers table was readable; a zero here is not a pass');
  process.exit(3);
}
if (!anyProvenanceSeen) {
  console.log('\nNOT_DEPLOYED — nothing served carries `moversProvenance`.');
  console.log('This is the honest pre-deploy answer, not a failure: merge is not deploy');
  console.log('(bqb1 runs autoDeploy=no). Re-run after the deploy that carries the filter.');
  process.exit(2);
}
if (findings.length > 0) {
  console.log('\nFINDINGS');
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}
if (filteredRows === 0) {
  console.error('\nFAIL — the filter matched ZERO rows across the whole corpus.');
  console.error('Per the board: "Count the rows filtered and fail at zero." A filter that');
  console.error('matches nothing is indistinguishable from a clean corpus, and the census');
  console.error(`says the corpus is not clean. Cross-check with tra2610-archive-scan.mjs:`);
  console.error('if that still reports dirty artifacts, this filter is not reaching them.');
  process.exit(1);
}
console.log(`\nPASS — ${filteredRows} fabricated row(s) suppressed across ${filteredArtifacts} artifact(s),`);
console.log('on both surfaces, with the published rows recoverable from the stamp, and every');
console.log('served artifact stating its own denominator.');
process.exit(0);
