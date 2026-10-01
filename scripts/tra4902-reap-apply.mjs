/**
 * TRA-4902 scope #2 EXECUTION — option A, as ruled by the board on card
 * `e9754ca6` (human_only, resolved 2026-10-01T16:08:38Z):
 *
 *   action     = a_deregister  — deregister the 64 QA accounts, DELETE NOTHING
 *   scope_check = list_ok      — the published list is correct, all 64 are safe
 *
 * `DELETE /api/admin/users/:username` splices the credential row and calls
 * `destroyUserContext`. It leaves the book tree on disk (TRA-142, index.ts:10046)
 * and records an identity tombstone (TRA-2410). Reversal is
 * `POST /api/admin/users {username, email, password, adoptExistingBook: true}`
 * — the flag skips `retireOrphanedBook`, so the tree is adopted in place rather
 * than moved to `orphaned-books/` (index.ts:9890).
 *
 *   ADMIN_PASSWORD=… node scripts/tra4902-reap-apply.mjs            # dry run
 *   ADMIN_PASSWORD=… node scripts/tra4902-reap-apply.mjs --apply    # execute
 *
 * ⚠ `TRADING_API_BASE` is deliberately not read — it is the self-host in agent
 * shells. Override with `--base=`.
 */
const BASE =
  process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
  'https://tradingai-bqb1.onrender.com';
const APPLY = process.argv.includes('--apply');

/**
 * The 64 names the BOARD APPROVED, verbatim from document
 * `tra4902-reap-candidates-20260925` as it stood when card `e9754ca6` was
 * answered.
 *
 * This list is hard-coded on purpose, and it is the central safety property of
 * this script. Re-deriving the predicate at apply time would silently widen the
 * blast radius: any QA-named book registered since 2026-09-25 would match the
 * pattern and be deleted without ever having been seen by the human who ruled.
 * The predicate decided the list; the RULING is on the list. So the live set is
 * re-derived below only to be COMPARED against this one, never to replace it.
 */
const APPROVED = [
  'qa_tra1475_1783821169', 'qa_reg_0710202220', 'qa_tra2282_5beed8b8', 'qa_tra2251_7b0483ee',
  'qtverify_1785048357', 'qtprobe3', 'tra2339v66f17374', 'qa_tra2492_ex_1785285374',
  'qa_tra2485_inv_1785284987', 'qa_tra2485_ex_1785284987', 'qa_tra2490_neg_1785285303',
  'qa_tra2490_inv_1785285303', 'qa_tra2492_del_1785285374', 'qa_tra2491_ex_1785285868',
  'qa_tra2492_ctl_1785285374', 'qa_tra2492_inv_1785285374', 'qa_tra2490_ex_1785285303',
  'qa_tra2407_ms5ajurt', 'qa_tra2491_neg_1785285984', 'qa_tra2491_inv_1785285868',
  'qtverify_tra2331_0729a', 'qa_tra2511_114524', 'qa_tra2407_ms6395jy', 'qa_tra2511_v2',
  'qa_tra2407_ms6342f6', 'qa_mirror_1578_38096', 'qtverify_1785371176', 'qtverify_1785371190',
  'ctoverify_tra2331', 'ctoverify_tra2331d', 'ctoverify_tra2333', 'ctoverify_tra2354',
  'ctoverify_tra2388s', 'ctoverify_tra2331b', 'ctoverify_tra2388', 'ctoverify_tra2406',
  'ctoverify_tra2341', 'ctoverify_tra2449', 'ctoverify_tra2356v', 'ctoverify_tra2227',
  'ctoverify_2225_1784856407', 'ctoverify_2225b_1784856491', 'ctoverify_tra2211',
  'ctoverify_2218_230da93', 'ctoverify_qt2331b', 'ctoverify_tra2329', 'ceo2251v130001',
  'ctoverify_qa_tra2406b', 'ctoverify_tra2284', 'qa2395_1785337210', 'ctoverify_tra2388w',
  'ctoverify_qa2407v1785284396', 'ctoverify_tra2388w195302', 'ctoverify_tra2388w195221',
  'ctoverify_tra2416', 'ctoverify_tra2439a', 'qa2716t0730a', 'qa3120t0806a',
  'ctoverify_tra2331_scope_probe', 'qa581t0811a', 'qa2711ret', 'qa3599_1401',
  'cfo3475222507', 'leaddev4479reset',
];

/** The 4 books the ruling KEEPS. Named so the guard below can be positive, not an absence. */
const KEEP = ['admin', 'Richard', 'enock', 'v0nni'];

const QA_PATTERNS = [/^ctoverify_/i, /^qa_?\d/i, /^qa_/i, /^qtverify_/i, /^qtprobe/i, /^cfo\d/i, /^ceo\d/i, /^leaddev\d/i, /^tra\d+v/i, /^v0nni$/i];
const MiB = 1024 * 1024;
const mib = (b) => `${(b / MiB).toFixed(3)} MiB`;

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD not set');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
  const { token } = await login.json();
  const H = { Authorization: `Bearer ${token}` };

  const ver = await (await fetch(`${BASE}/api/health/options-live`)).json().catch(() => ({}));
  const build = ver.build ?? {};
  console.log(`host      : ${BASE}`);
  console.log(`build     : ${build.commitShort ?? '?'}  pid ${build.pid ?? '?'}  boot ${build.startedAt ?? '?'}`);
  console.log(`tradierEnv: ${ver.serviceTradierEnv}`);
  console.log(`mode      : ${APPLY ? 'APPLY — this will deregister accounts' : 'DRY RUN'}`);

  const census0 = await (await fetch(`${BASE}/api/health/storage/ledger`, { headers: H })).json();
  const roster0 = await (await fetch(`${BASE}/api/admin/users`, { headers: H })).json();
  const names0 = (Array.isArray(roster0) ? roster0 : roster0.users ?? []).map((u) => u.username ?? u);
  console.log(`\nroster BEFORE: ${names0.length} accounts`);
  for (const k of Object.keys(census0.dirs)) {
    const d = census0.dirs[k];
    console.log(`  ${k}/ ${mib(d.bytes)} of ${mib(d.maxBytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} rows`);
  }

  // ── Guard 1: the approved list must still be exactly the live predicate's set ──
  // A mismatch is NOT a licence to act on the live set; it means the ruling no
  // longer covers the population and a human has to look again.
  const liveBooks = new Map();
  for (const k of Object.keys(census0.dirs)) {
    for (const b of census0.dirs[k].books) {
      const cur = liveBooks.get(b.book) ?? { live: false };
      liveBooks.set(b.book, { live: cur.live || !!b.live });
    }
  }
  const derived = [...liveBooks.entries()]
    .filter(([name, v]) => !v.live && QA_PATTERNS.some((re) => re.test(name)))
    .map(([name]) => name);
  const newSinceRuling = derived.filter((n) => !APPROVED.includes(n));
  const goneSinceRuling = APPROVED.filter((n) => !derived.includes(n));
  if (newSinceRuling.length > 0) {
    console.log(`\n⚠ ${newSinceRuling.length} QA-named book(s) exist that the ruling never saw — NOT touching them:`);
    for (const n of newSinceRuling) console.log(`    ${n}`);
  }
  if (goneSinceRuling.length > 0) {
    console.log(`\nnote: ${goneSinceRuling.length} approved name(s) no longer hold ledger rows: ${goneSinceRuling.join(', ')}`);
  }

  // ── Guard 2: nothing on the KEEP list, and nothing holding a real-money row ──
  // The mode clause is re-asserted HERE even though the published predicate
  // already applied it: this is the script that actually writes, and a guard
  // that lives only in the script that decided the list protects nothing.
  const targets = APPROVED.filter((n) => names0.includes(n));
  const alreadyGone = APPROVED.filter((n) => !names0.includes(n));
  for (const n of targets) {
    if (KEEP.some((k) => k.toLowerCase() === n.toLowerCase())) {
      throw new Error(`REFUSING: ${n} is on the KEEP list`);
    }
    if (liveBooks.get(n)?.live) {
      throw new Error(`REFUSING: ${n} holds a real-money (live) ledger row`);
    }
  }
  console.log(`\ntargets: ${targets.length} to deregister, ${alreadyGone.length} already absent from the roster`);
  for (const k of KEEP) {
    console.log(`  KEEP ${k}: ${names0.includes(k) ? 'present ✓' : '⚠ NOT IN ROSTER'}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  // ── Execute, one at a time, recording every status ──
  const results = [];
  for (const name of targets) {
    const r = await fetch(`${BASE}/api/admin/users/${encodeURIComponent(name)}`, { method: 'DELETE', headers: H });
    const body = await r.text();
    results.push({ name, status: r.status, body: body.slice(0, 200) });
    if (!r.ok) console.log(`  ✗ ${name} → ${r.status} ${body.slice(0, 120)}`);
  }
  const ok = results.filter((r) => r.status === 200);
  console.log(`\ndeleted ${ok.length}/${targets.length}`);
  for (const r of results.filter((r) => r.status !== 200)) console.log(`  FAILED ${r.name}: ${r.status} ${r.body}`);

  // ── Verify BY VALUE, not by the 200s above (TRA-2163) ──
  const roster1 = await (await fetch(`${BASE}/api/admin/users`, { headers: H })).json();
  const names1 = (Array.isArray(roster1) ? roster1 : roster1.users ?? []).map((u) => u.username ?? u);
  const stillPresent = APPROVED.filter((n) => names1.includes(n));
  const keepLost = KEEP.filter((k) => !names1.includes(k));
  console.log(`\nroster AFTER: ${names1.length} accounts (was ${names0.length})`);
  console.log(`  approved names still registered: ${stillPresent.length === 0 ? 'none ✓' : stillPresent.join(', ')}`);
  console.log(`  KEEP accounts lost: ${keepLost.length === 0 ? 'none ✓' : `⛔ ${keepLost.join(', ')}`}`);
  console.log(`  remaining roster: ${names1.join(', ')}`);

  const census1 = await (await fetch(`${BASE}/api/health/storage/ledger`, { headers: H })).json();
  console.log(`\nuserCount ${census0.userCount ?? '?'} → ${census1.userCount ?? '?'}   userContextCount ${census0.userContextCount ?? '?'} → ${census1.userContextCount ?? '?'}`);
  for (const k of Object.keys(census1.dirs)) {
    const d0 = census0.dirs[k];
    const d = census1.dirs[k];
    console.log(`  ${k}/ ${mib(d.bytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} rows   [was ${mib(d0.bytes)}, ${d0.files}f, ${d0.books.length} rows]`);
  }
  console.log('\nBytes on disk are UNCHANGED by design — option A deletes nothing. The');
  console.log('pools drain at the next boundary sweeps, live book last (TRA-4898).');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
