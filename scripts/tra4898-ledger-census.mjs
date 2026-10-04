/**
 * TRA-4898 AC4 — how much of the `closes/` pool belongs to the dead QA books?
 *
 * Reads the admin-gated census this ticket added
 * (`GET /api/health/storage/ledger`), classifies each book×mode row, and prints
 * the split. Read-only: the route stats files and deletes nothing.
 *
 * The classification is by NAME PATTERN and is printed per class WITH its
 * members, because "dead" is a judgement and the reader has to be able to
 * check it. Anything that matches no pattern lands in `other` rather than being
 * folded into either side — a residual that reads as QA would overstate the
 * reap, which is the direction that gets a reap approved on a false number.
 *
 * TRA-5036 also GRADES the published eviction queue here, rather than in a
 * script of its own: AC3 is "zero `inRegistry: true` rows ahead of any
 * `inRegistry: false` row, in both pools", and that is a property of the queue
 * this script already prints. A second grader would re-read the same route and
 * eventually disagree with this one about what it saw.
 *
 * Exit codes: `0` AC3 holds · `1` the run failed · `3` the host predates the
 * route · `4` AC3 FAILED · `5` AC3 is VACUOUS (no roster asserted, or no
 * registered rows in a pool, so the predicate passes without being tested).
 *
 *   ADMIN_PASSWORD=… node scripts/tra4898-ledger-census.mjs
 */

/**
 * ⚠ `TRADING_API_BASE` is DELIBERATELY NOT READ. It is `http://localhost:4242`
 * in the agent shells (the self-host), so honouring it silently pointed the
 * first run of this script at a box whose build predates the route — which
 * answered `404` and would have read as "the feature did not deploy" (TRA-4863
 * §x29). Say `--base=` if you mean something other than bqb1.
 */
const BASE =
  process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
  'https://tradingai-bqb1.onrender.com';
const QA_PATTERNS = [/^ctoverify_/i, /^qa_/i, /^qtverify_/i, /^qaverify_/i, /^cfoverify_/i, /^leadverify_/i];
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

  const res = await fetch(`${BASE}/api/health/storage/ledger`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    console.error('BLIND — /api/health/storage/ledger is 404. The build serving this host');
    console.error('predates TRA-4898; nothing measured here would be about the new code.');
    process.exit(3);
  }
  if (!res.ok) throw new Error(`ledger census ${res.status}: ${await res.text()}`);
  const census = await res.json();

  const ver = await (await fetch(`${BASE}/api/health/version`)).json().catch(() => ({}));
  console.log(`host      : ${BASE}`);
  console.log(`build     : ${ver.commit ?? ver.sha ?? 'unknown'}`);
  console.log(`measuredAt: ${census.measuredAt}`);
  // TRA-5036 — read this BEFORE any verdict. `undefined` means the build
  // predates the registry reservation; `false` means it shipped but this census
  // had no roster to assert, and then every AC3 check below is vacuous.
  console.log(`registryAsserted: ${census.registryAsserted ?? 'ABSENT (build predates TRA-5036)'}`);

  /** AC3 per pool, filled in below. */
  const ac3 = [];

  for (const kind of Object.keys(census.dirs)) {
    const d = census.dirs[kind];
    console.log(`\n=== ${kind}/  ${mib(d.bytes)} of ${mib(d.maxBytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} book×mode rows`);
    console.log(`    reserved tier 2 (reports/live + crypto-reports/live): ${mib(d.liveBytes)}, ${d.liveFiles} files`);
    // TRA-5036 — the second reservation, sized separately. Its bytes are the
    // amount tier 1 puts IN FRONT of real money, which is the number that says
    // how much slack the live book still has behind both reservations.
    console.log(`    reserved tier 1 (registered, non-live):              ${mib(d.registeredBytes ?? 0)}, ${d.registeredFiles ?? 0} files`);

    const classes = { qa: [], live: [], other: [] };
    for (const b of d.books) {
      if (QA_PATTERNS.some((re) => re.test(b.book))) classes.qa.push(b);
      else if (b.live) classes.live.push(b);
      else classes.other.push(b);
    }
    for (const [name, rows] of Object.entries(classes)) {
      const bytes = rows.reduce((a, b) => a + b.bytes, 0);
      const files = rows.reduce((a, b) => a + b.files, 0);
      const pct = d.bytes === 0 ? 0 : (bytes / d.bytes) * 100;
      console.log(`  ${name.padEnd(5)} ${mib(bytes).padStart(12)}  ${String(files).padStart(5)} files  ${pct.toFixed(1)}%  (${rows.length} rows)`);
    }
    console.log('  --- heaviest rows');
    for (const b of d.books.slice(0, 15)) {
      // Tier label, not a boolean: `[RESERVED]` alone could no longer say WHICH
      // reservation held a row, and after TRA-5036 that is the whole question.
      const tier = b.live ? '  [RESERVED live]' : b.inRegistry === true ? '  [RESERVED registry]' : '';
      console.log(`    ${b.bytes.toString().padStart(9)}  ${b.files.toString().padStart(4)}f  ${b.book}/${b.root}/${b.mode}${tier}  ${b.oldest}..${b.newest}`);
    }
    console.log('  --- next to evict (in order)');
    for (const f of d.nextToEvict) {
      const reg = f.inRegistry === true ? 'registered' : f.inRegistry === false ? 'orphan' : 'unasserted';
      console.log(`    tier ${f.evictionTier ?? '?'}  ${f.book}/${f.root}/${f.mode}/${f.name}  ${f.bytes}B  (${reg})`);
    }

    // ── TRA-5036 AC3 — the ordering claim, over the WHOLE queue ──
    //
    // ⛔ NOT off `nextToEvict`. That preview is capped, and on bqb1 its head is
    // ~12 MiB of dead QA tape, so a prefix-grader finds zero registered rows
    // and passes vacuously forever whether or not the reservation shipped.
    // `queueOrdering` is measured server-side over the full sorted queue — the
    // one the sweep walks.
    const o = d.queueOrdering;
    if (o == null) {
      ac3.push({ kind, missing: true });
      console.log('  --- AC3 BLIND — `queueOrdering` absent; this build predates TRA-5036');
      continue;
    }
    // VACUITY FIRST: no roster asserted, or no registered file in this pool,
    // and the predicate holds without ever being exercised.
    const vacuous = census.registryAsserted !== true || o.registeredFiles === 0;
    const ordered = o.registeredAheadOfUnregistered === 0 && o.liveAheadOfNonLive === 0;
    ac3.push({ kind, vacuous, ordered, monotone: o.tiersMonotone, o });
    console.log(
      `  --- AC3 ${vacuous ? 'VACUOUS' : ordered && o.tiersMonotone ? 'PASS' : 'FAIL'}`
      + `  registeredFiles=${o.registeredFiles}`
      + ` registeredAheadOfUnregistered=${o.registeredAheadOfUnregistered}`
      + ` liveAheadOfNonLive=${o.liveAheadOfNonLive}`
      + ` monotone=${o.tiersMonotone}`,
    );
    console.log(
      `      ranks: firstRegistered=${o.firstRegisteredRank} lastUnregistered=${o.lastUnregisteredRank}`
      + `  firstLive=${o.firstLiveRank} lastNonLive=${o.lastNonLiveRank}  (of ${d.files} files)`,
    );
  }

  console.log('\n=== TRA-5036 AC3 — zero registered rows ahead of any unregistered row, BOTH pools');
  for (const r of ac3) {
    const verdict = r.missing ? 'BLIND' : r.vacuous ? 'VACUOUS' : r.ordered && r.monotone ? 'PASS' : 'FAIL';
    console.log(`  ${r.kind.padEnd(7)} ${verdict}`);
  }
  if (ac3.some((r) => r.missing)) {
    console.error('BLIND — the build serving this host predates TRA-5036. Nothing graded.');
    process.exit(3);
  }
  if (ac3.some((r) => !r.vacuous && !(r.ordered && r.monotone))) {
    console.error('AC3 FAILED — a registered book sits ahead of an unregistered one in the queue.');
    process.exit(4);
  }
  if (ac3.some((r) => r.vacuous)) {
    console.error('AC3 VACUOUS — no roster asserted, or a pool holds no registered row.');
    console.error('This is NOT a pass: the predicate was never exercised. Check registryAsserted');
    console.error('and whether the build serving this host carries TRA-5036.');
    process.exit(5);
  }
  console.log('AC3 PASS in both pools.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
