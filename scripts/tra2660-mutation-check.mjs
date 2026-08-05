// TRA-2660 acceptance-4 mutation harness. For each mutation: apply a surgical
// string replacement to the PRODUCTION file, run ONE named test, assert that
// test goes RED, then restore by the inverse replacement (never a git checkout,
// which would clobber a concurrent edit on this shared tree).
//
// Usage — FROM THE REPO ROOT:  node scripts/tra2660-mutation-check.mjs
// Exit 0 = every mutation killed. Exit 1 = a mutation SURVIVED (an assertion
// that passes against the broken code is not an assertion). Exit 2 = pre-flight
// failed, i.e. a test-name pattern selected nothing — the "mutation test that
// cannot mutate reads as passing" trap.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HR = 'packages/server/src/observability/health-routes.ts';

const MUTATIONS = [
  {
    id: 'M1 predicate reuse',
    file: HR,
    from: `  const unrecognisedNames = new Set(
    unrecognisedDeskBooks([...byKey.values()].map(a => a.account), env).map(n => n.toLowerCase()),
  );`,
    to: `  const unrecognisedNames = new Set(
    [...byKey.values()].map(a => a.account.toLowerCase()),
  );`,
    test: 'does not count a test-classified journal account',
  },
  {
    id: 'M2 null sentinel collapses to 0',
    file: HR,
    from: `    unrecognisedDeskAccountCount: unrecognisedAccountCount,`,
    to: `    unrecognisedDeskAccountCount: unrecognisedAccountCount ?? 0,`,
    test: 'reports null — not 0 — when the journal read throws',
  },
  {
    id: 'M3 key dropped when zero (optional? / undefined)',
    file: HR,
    from: `    journalAccountCount: deskAccountFold ? deskAccountFold.journalAccountCount : null,`,
    to: `    journalAccountCount: deskAccountFold ? deskAccountFold.journalAccountCount : undefined as never,`,
    test: 'reports null — not 0 — when the journal read throws',
  },
  {
    id: 'M4 population narrowed back to demo-mode (the ticket defect)',
    file: HR,
    from: `  for (const row of rows) {
    const raw = typeof row.account === 'string' ? row.account.trim() : '';`,
    to: `  for (const row of rows.filter(r => r.mode === 'demo')) {
    const raw = typeof row.account === 'string' ? row.account.trim() : '';`,
    test: 'sees a live-mode journal account the demo-only resident read would drop',
  },
  {
    id: 'M5 blank accounts counted as books',
    file: HR,
    from: `    if (raw.length === 0) {
      rowsWithoutAccount += 1;
      continue;
    }`,
    to: `    if (raw.length === 0) {
      rowsWithoutAccount += 1;
    }`,
    test: 'does not count blank/absent account rows as unrecognised',
  },
  {
    id: 'M6 new count read off the RESIDENT population (fields move together)',
    file: HR,
    from: `  const unrecognisedAccountCount = deskAccountFold ? deskAccountFold.unrecognised.length : null;`,
    to: `  const unrecognisedAccountCount = deskAccountFold ? unrecognisedDesk.length : null;`,
    test: 'counts an unrecognised JOURNAL account the resident-engine field cannot see',
  },
  {
    id: 'M7 per-account row count not accumulated',
    file: HR,
    from: `    entry.rowCount += 1;`,
    to: `    entry.rowCount = 1;`,
    test: 'names the unrecognised accounts',
  },
  {
    id: 'M8 unreadable journal served as a clean 200',
    file: HR,
    from: `      if (!reading.ok) {
        // 503, not an empty 200: "could not read" must never be served as "clean".
        res.status(503).json({ ok: false, time: new Date(now()).toISOString(), reason: reading.reason });
        return;
      }`,
    to: `      if (!reading.ok) {
        res.json({ ok: true, unrecognisedDeskAccounts: [] });
        return;
      }`,
    test: 'serves 503 — never an empty clean 200 — when the admin read cannot see the journal',
  },
  {
    id: 'M10 test residual double-counts (classes stop partitioning)',
    file: HR,
    from: `    testAccountCount: byKey.size - unrecognised.length - roster.length,`,
    to: `    testAccountCount: byKey.size - unrecognised.length,`,
    test: 'names the VOUCHED half too, and the three classes partition the domain',
  },
  {
    id: 'M11 roster list echoes the allowlist instead of what was observed',
    file: HR,
    from: `  const roster = all.filter(a => rosterNames.has(a.account.toLowerCase()));`,
    to: `  const roster = [...rosterNames].map(n => ({
    account: n, rowCount: 0, firstOpenTs: null, lastOpenTs: null, modes: [],
  }));`,
    test: 'names the VOUCHED half too, and the three classes partition the domain',
  },
  {
    id: 'M9 includeTest allowed to change the account answer',
    file: HR,
    from: `    const deskAccounts = await readDeskAccountRoster();
    res.json(
      summarizeDemoBooksPublic(deps.fleetBooks?.() ?? [], now(), { includeTest, deskAccounts }),
    );`,
    to: `    const deskAccounts = includeTest
      ? ({ ok: false, reason: 'debug view' } as const)
      : await readDeskAccountRoster();
    res.json(
      summarizeDemoBooksPublic(deps.fleetBooks?.() ?? [], now(), { includeTest, deskAccounts }),
    );`,
    test: 'gives the same account answer with and without',
  },
];

function runTest(name) {
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', 'src/observability/health-routes.test.ts', '-t', name],
      { cwd: 'packages/server', stdio: 'pipe', shell: true },
    );
    return 'PASS';
  } catch {
    return 'FAIL';
  }
}

// PRE-FLIGHT — every pattern must select a GREEN test before it is mutated.
// Without this, a pattern that matches nothing exits non-zero and would be
// misread as "the mutation was killed" (a mutation test that cannot mutate
// reads as passing).
const preflight = [...new Set(MUTATIONS.map(m => m.test))].map(t => [t, runTest(t)]);
for (const [t, v] of preflight) console.log(`preflight ${v}: ${t}`);
if (preflight.some(([, v]) => v !== 'PASS')) {
  console.error('PRE-FLIGHT FAILED — a pattern selects no green test; aborting.');
  process.exit(2);
}

/** The working tree is checked out CRLF on Windows; anchors here are LF. */
const eol = (s, file) => (file.includes('\r\n') ? s.replace(/\n/g, '\r\n') : s);

const results = [];
for (const m of MUTATIONS) {
  const before = readFileSync(m.file, 'utf8');
  m.from = eol(m.from, before);
  m.to = eol(m.to, before);
  if (!before.includes(m.from)) {
    results.push({ ...m, verdict: 'ANCHOR-MISS' });
    continue;
  }
  writeFileSync(m.file, before.replace(m.from, m.to));
  let verdict;
  try {
    verdict = runTest(m.test);
  } finally {
    const after = readFileSync(m.file, 'utf8');
    writeFileSync(m.file, after.replace(m.to, m.from));
  }
  const restored = readFileSync(m.file, 'utf8');
  results.push({
    id: m.id,
    test: m.test,
    verdict,
    restoredClean: restored === before,
  });
  console.log(`${m.id}: mutated -> test ${verdict} (restored=${restored === before})`);
}

console.log('\n--- SUMMARY ---');
for (const r of results) {
  const ok = r.verdict === 'FAIL' && r.restoredClean;
  console.log(`${ok ? 'OK  ' : 'BAD '} ${r.id} -> ${r.verdict}`);
}
const bad = results.filter(r => !(r.verdict === 'FAIL' && r.restoredClean));
console.log(bad.length === 0 ? '\nALL MUTATIONS KILLED' : `\n${bad.length} MUTATION(S) SURVIVED`);
process.exit(bad.length === 0 ? 0 : 1);
