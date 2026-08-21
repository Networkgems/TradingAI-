// TRA-2631 — CONTROL SUITE for `tra2631-provenance-stamp-check.mjs`.
//
// ── Why this file exists ──────────────────────────────────────────────────────
// The grader is an instrument too, and against the live box it has only ever
// taken ONE exit (`2 NOT_DEPLOYED`, because the filter is not deployed yet). A
// checker that has only ever taken one exit is unproven code: every OTHER branch
// — including the PASS it will eventually print, which is the branch a human will
// act on — is untested. This is the same class of defect the check itself hunts.
//
// So: stand up a stub that serves synthetic artifacts, point the real script at
// it, and assert the exit code and the reasoning for each branch. The script is
// run AS A SUBPROCESS, unmodified, so what is graded here is the shipped file and
// not a re-implementation of it.
//
// ── The mutation controls that actually matter ────────────────────────────────
// Three of these cases are deliberate MUTATIONS of a correct payload — a leaked
// suspect row, an over-filtered genuine row, and a half-filtered artifact. If any
// of them PASSES, the check is vacuous and the "PASS" it prints against the live
// box would mean nothing. Each must FAIL, and for the stated reason.
//
// Run: `node scripts/tra2631-provenance-stamp-check-selftest.mjs`
// Exit 0 = all controls green.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatQuoteLevel } from '../packages/shared/dist/index.js';

// `new URL(...).pathname` yields `/C:/...` on Windows, which `spawn` resolves to
// the nonexistent `C:\C:\...`. Every control then fails identically for a reason
// that has nothing to do with the check — a false red, which is as useless as a
// false green.
const CHECK = fileURLToPath(new URL('./tra2631-provenance-stamp-check.mjs', import.meta.url));

const RULE_ID = 'TRA-3241:session-move-ratio';
const BUILD = 'deadbeef1234';
const HEADING = '## Top 5 Movers (Watchlist)';

/** The real 2026-07-21 fabricated headline (r = 14.17). */
const SELX = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };
/**
 * The genuine large mover safely UNDER the band (r = 1.642, 2026-08-11 tape).
 * TRA-3241 retired INLF (+97.17%, r = 1.9717) from this role: it sits INSIDE
 * the k = 2 proximity band, i.e. it was an MNST-shaped row all along.
 */
const QMCO = { symbol: 'QMCO', price: 19.34, changePct: 64.18 };
const NVDA = { symbol: 'NVDA', price: 178.25, changePct: 2.41 };

function moverRow(m) {
  const usd = '$' + Math.abs(m.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2);
  return `| ${m.symbol} | ${usd} | ${pct}% |`;
}

function stamp(m, verdict, reason) {
  return {
    ...m,
    provenance: {
      ruleId: RULE_ID, threshold: 1.9, verdict, build: BUILD,
      ratio: verdict === 'suspect' ? 14.1667 : 1.64, impliedPrevClose: 0.024,
      ...(reason ? { reason } : {}),
    },
  };
}

/**
 * TRA-3915 — the row rendering a build shipping TODAY'S `formatMoverMarkdownRow`
 * writes. Differs from `moverRow` above exactly where TRA-3390 made it differ:
 * a foreign or undenominated level. Fixtures built with this one are post-3390
 * artifacts; fixtures built with `moverRow` are the archive.
 */
function moverRowCurrent(m) {
  const pct = (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2);
  return `| ${m.symbol} | ${formatQuoteLevel(Math.abs(m.price), m.currency)} | ${pct}% |`;
}

/** Build a served artifact the way the annotator would. */
function artifact({ served, suppressed, markdownRows, note, render = moverRow }) {
  const md = [
    '# Daily EOD Report — 2026-07-21',
    '',
    HEADING,
    '| Symbol | Price | Change % |',
    '|--------|-------|----------|',
    ...markdownRows.map(render),
    '',
    note,
    '',
    '## Signal Accuracy',
  ].join('\n');
  return {
    date: '2026-07-21',
    generatedAt: '2026-07-21T20:05:00Z',
    top5Movers: served,
    moversProvenance: {
      ruleId: RULE_ID, threshold: 1.9, build: BUILD,
      publishedCount: served.length + suppressed.length,
      servedCount: served.length,
      filteredCount: suppressed.length,
      filtered: suppressed,
    },
    markdown: md,
  };
}

// TRA-3296 — every served note now also has to speak about the WRITE-TIME stage,
// so these fixtures carry that line too. Both are the "recorded, nothing reached
// the table" wording, which is what a post-fix build emits on a clean session; the
// UNKNOWN and the non-empty wordings get their own dedicated controls below.
const WRITE_TIME_CLEAN =
  '> _Write-time exclusions: none reached this table. 0 row(s) of 2 candidate(s) were dropped'
  + ' during generation, none of which would have ranked into the top 5 (build `' + BUILD + '`)._';

const NOTE_FILTERED = [
  `> ⚠️ **PROVENANCE — 1 of 3 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**`,
  `> Filtered at read time by rule \`${RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = 1.9\`), build \`${BUILD}\`.`,
  '> The stored report on disk is **unchanged and byte-intact** — TRA-2634.',
  WRITE_TIME_CLEAN,
  '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
  '> | 1 | SELX | $0.34 / +1316.67% | suspect (implausible_move_ratio) | 0.0240 | 14.17 |',
].join('\n');

const NOTE_CLEAN = [
  `> **Provenance — 0 of 2 row(s) suppressed; this table is as published.**`,
  `> Filtered at read time by rule \`${RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = 1.9\`), build \`${BUILD}\`. TRA-2634.`,
  WRITE_TIME_CLEAN,
].join('\n');

// ── the cases ────────────────────────────────────────────────────────────────
const GOOD = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(SELX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [QMCO, NVDA],
  note: NOTE_FILTERED,
});

const CLEAN_ONLY = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [],
  markdownRows: [QMCO, NVDA],
  note: NOTE_CLEAN,
});

// MUTATION 1 — the filter ran and MISSED. SELX is still served.
const LEAKED = artifact({
  served: [stamp(SELX, 'plausible'), stamp(QMCO, 'plausible')],
  suppressed: [],
  markdownRows: [SELX, QMCO],
  note: NOTE_CLEAN,
});

// MUTATION 2 — the filter DELETED a genuine mover (QMCO, r = 1.642).
const OVER = artifact({
  served: [stamp(NVDA, 'plausible')],
  suppressed: [stamp(QMCO, 'suspect', 'implausible_move_ratio')],
  markdownRows: [NVDA],
  note: NOTE_FILTERED,
});

// MUTATION 3 — filtered on the JSON surface only; the row is still rendered.
const HALF = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(SELX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [SELX, QMCO, NVDA],
  note: NOTE_FILTERED,
});

// MUTATION 3b — TRA-3915. The SAME defect as MUTATION 3, on a row whose level
// TRA-3390 changed the rendering of, in an artifact written by a post-TRA-3390
// build. This is the case the checker was BLIND to: its locator reconstructed
// `| 000660.KS | $1,550,000.00 | -14.65% |` while the served table said
// `| 000660.KS | 1,550,000.00 KRW | -14.65% |`, the strings did not match, and a
// non-match reads as "not in the table" — i.e. as correctly suppressed.
//
// ⚠️ It must fail with **HALF-FILTERED** specifically, not merely with a non-zero
// exit. SURFACE DIVERGENCE fires here too (3 markdown rows vs 2 served) and it
// fired before this fix as well, so an exit-code-only control would have called
// the blind checker green. The message is the discriminator.
const HYNIX = { symbol: '000660.KS', price: 1550000, changePct: 1316.67, currency: 'KRW' };
const HALF_FOREIGN = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(HYNIX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [HYNIX, QMCO, NVDA],
  // Its own note, naming the foreign symbol, so this case fails on the surface
  // legs alone and cannot be scored green-adjacent by the DISTINGUISHABLE leg
  // firing for an unrelated reason.
  note: [
    `> ⚠️ **PROVENANCE — 1 of 3 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**`,
    `> Filtered at read time by rule \`${RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = 1.9\`), build \`${BUILD}\`.`,
    '> The stored report on disk is **unchanged and byte-intact** — TRA-2634.',
    WRITE_TIME_CLEAN,
    '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
    '> | 1 | 000660.KS | 1,550,000.00 KRW / +1316.67% | suspect (implausible_move_ratio) | 109,388.00 | 14.17 |',
  ].join('\n'),
  render: moverRowCurrent,
});

// MUTATION 4 — filtered, but the response does not SAY it was filtered. This is
// the defect the ruling's second half exists to prevent, so it must not pass.
const SILENT = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(SELX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [QMCO, NVDA],
  note: NOTE_CLEAN,
});

// MUTATION 5 (TRA-3296) — the note speaks about the read-time stage and is SILENT
// about the write-time one. This is the artifact the ticket was filed on: the
// 2026-08-11 report certified itself "as published" 14 ms after `eod-report.ts`
// dropped MNST's 2:1 split, and nothing in the document said a stage had run.
//
// ⭐ It exists because the write-time leg must be able to FAIL. A leg that only
// ever passes is decoration, and the version of this check that shipped without a
// mutation control is precisely how the original gap survived a green suite.
const WRITE_TIME_SILENT = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(SELX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [QMCO, NVDA],
  note: [
    `> ⚠️ **PROVENANCE — 1 of 3 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**`,
    `> Filtered at read time by rule \`${RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = 1.9\`), build \`${BUILD}\`.`,
    '> The stored report on disk is **unchanged and byte-intact** — TRA-2634.',
    '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
    '> | 1 | SELX | $0.34 / +1316.67% | suspect (implausible_move_ratio) | 0.0240 | 14.17 |',
  ].join('\n'),
});

// TRA-3296 — the BACKFILL shape, and it must PASS. Every artifact stored before
// the fix carries no write-time record and renders UNKNOWN. Those are not
// repairable, and failing them would condemn the whole archive for a defect it
// cannot fix; stating the unknown is the required behaviour, not a finding.
const WRITE_TIME_UNKNOWN = artifact({
  served: [stamp(QMCO, 'plausible'), stamp(NVDA, 'plausible')],
  suppressed: [stamp(SELX, 'suspect', 'implausible_move_ratio')],
  markdownRows: [QMCO, NVDA],
  note: [
    `> ⚠️ **PROVENANCE — 1 of 3 published row(s) SUPPRESSED as unverified. 2 row(s) shown above.**`,
    `> Filtered at read time by rule \`${RULE_ID}\` (threshold \`SUSPECT_MOVE_RATIO_FLOOR = 1.9\`), build \`${BUILD}\`.`,
    '> The stored report on disk is **unchanged and byte-intact** — TRA-2634.',
    '> ⚠️ **Write-time exclusions: UNKNOWN.** This stored report was generated before TRA-3296.',
    '> | # | Symbol | Published | Verdict | Implied prev close | Ratio |',
    '> | 1 | SELX | $0.34 / +1316.67% | suspect (implausible_move_ratio) | 0.0240 | 14.17 |',
  ].join('\n'),
});

// The pre-deploy shape: served, but no stamp at all.
const UNSTAMPED = { date: '2026-07-21', generatedAt: 'x', top5Movers: [QMCO, NVDA], markdown: `${HEADING}\n| Symbol | Price | Change % |\n|--|--|--|\n${moverRow(QMCO)}` };

const CASES = [
  { name: 'PASS — a correctly filtered artifact', reports: [GOOD], expect: 0, expectText: 'PASS' },
  { name: 'FAIL at zero — everything clean, nothing filtered corpus-wide', reports: [CLEAN_ONLY], expect: 1, expectText: 'matched ZERO rows' },
  { name: 'MUTATION leaked — a suspect row survived into the served array', reports: [GOOD, LEAKED], expect: 1, expectText: 'LEAKED' },
  { name: 'MUTATION over-filtered — a genuine mover was deleted', reports: [OVER], expect: 1, expectText: 'OVER-FILTERED' },
  { name: 'MUTATION half-filtered — gone from JSON, still in the markdown', reports: [HALF], expect: 1, expectText: 'HALF-FILTERED' },
  { name: 'MUTATION half-filtered on a FOREIGN row, post-TRA-3390 rendering (TRA-3915)', reports: [HALF_FOREIGN], expect: 1, expectText: 'HALF-FILTERED' },
  { name: 'MUTATION silent — filtered but the note does not say so', reports: [SILENT], expect: 1, expectText: 'reads as clean' },
  { name: 'MUTATION write-time silent — the note never mentions the WRITE-TIME stage (TRA-3296)', reports: [WRITE_TIME_SILENT], expect: 1, expectText: 'SILENT about write-time' },
  { name: 'PASS — a pre-fix artifact that honestly renders write-time as UNKNOWN (TRA-3296)', reports: [WRITE_TIME_UNKNOWN], expect: 0, expectText: 'PASS' },
  { name: 'NOT_DEPLOYED — served, but no stamp anywhere', reports: [UNSTAMPED], expect: 2, expectText: 'NOT_DEPLOYED' },
  { name: 'BLIND — no readable movers table at all', reports: [], expect: 3, expectText: 'BLIND' },
];

function serve(reports) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/api/auth/login') return json({ token: 't' });
      if (url.pathname === '/api/reports') {
        // Only the `demo` fold carries the fixtures; the others list nothing, so
        // each case's corpus is exactly its `reports` array.
        return json({ dates: url.searchParams.get('mode') === 'demo' ? reports.map((_, i) => `2026-07-${String(10 + i).padStart(2, '0')}`) : [] });
      }
      const m = url.pathname.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        const i = Number(m[1].slice(-2)) - 10;
        if (url.searchParams.get('mode') === 'demo' && reports[i]) return json({ ...reports[i], date: m[1] });
        res.writeHead(404); return res.end('{}');
      }
      res.writeHead(404); res.end('{}');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function run(port) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CHECK], {
      env: { ...process.env, HOST: `http://127.0.0.1:${port}`, ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'b' },
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  });
}

let failures = 0;
for (const c of CASES) {
  const { srv, port } = await serve(c.reports);
  const { code, out } = await run(port);
  srv.close();
  const ok = code === c.expect && out.includes(c.expectText);
  if (!ok) {
    failures++;
    console.log(`  ✗ ${c.name}`);
    console.log(`      expected exit ${c.expect} containing ${JSON.stringify(c.expectText)}, got exit ${code}`);
    console.log(out.split('\n').map(l => `      | ${l}`).join('\n'));
  } else {
    console.log(`  ✓ ${c.name}  (exit ${code})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${CASES.length} controls FAILED — the check is not trustworthy.`);
  process.exit(1);
}
console.log(`\nALL ${CASES.length} CONTROLS GREEN — every exit of tra2631-provenance-stamp-check.mjs is reachable,`);
console.log('and the three mutations of a correct payload (leaked / over-filtered / half-filtered)');
console.log('plus the silent-filter case each FAIL, so a PASS from it is not vacuous.');
process.exit(0);
