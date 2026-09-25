/**
 * TRA-4902 scope #1 — decide, and PUBLISH, the reap predicate.
 *
 * The ticket asks to cross the name pattern with last-write mtime and with
 * `users.json` membership before deleting anything. This reads all three off
 * the TRA-4898 census (extended by this ticket) and prints the candidate list.
 *
 * It DELETES NOTHING and has no delete mode. Scope #2 requires a ruling first,
 * and a script that can already do the thing is how a ruling gets skipped.
 *
 *   ADMIN_PASSWORD=… node scripts/tra4902-reap-plan.mjs
 *
 * ⚠ `TRADING_API_BASE` is deliberately not read — see the note on
 * `tra4898-ledger-census.mjs`; it is the self-host in agent shells.
 */
const BASE =
  process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
  'https://tradingai-bqb1.onrender.com';

/**
 * The name convention QA fixtures have been created under. This is the WEAKEST
 * of the three axes and is reported, never trusted alone: the ticket names
 * `tra2339v66f17374` and `qtprobe3` as books that are plainly fixtures and
 * match nothing here, and a QA-named book could equally be a live fixture.
 */
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

  const res = await fetch(`${BASE}/api/health/storage/ledger?digests=1`, { headers: H });
  if (res.status === 404) {
    console.error('BLIND — /api/health/storage/ledger is 404; this build predates TRA-4898.');
    process.exit(3);
  }
  if (!res.ok) throw new Error(`census ${res.status}: ${await res.text()}`);
  const census = await res.json();
  const ver = await (await fetch(`${BASE}/api/health/version`)).json().catch(() => ({}));

  console.log(`host      : ${BASE}`);
  console.log(`build     : ${ver.commit ?? 'unknown'}`);
  console.log(`measuredAt: ${census.measuredAt}`);

  for (const kind of Object.keys(census.dirs)) {
    const d = census.dirs[kind];
    console.log(`\n${'='.repeat(78)}\n=== ${kind}/  ${mib(d.bytes)} of ${mib(d.maxBytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} rows`);

    // ── Axis 1: is the registry able to discriminate at all? ────────────────
    const asserted = d.books.filter((b) => b.inRegistry !== null);
    const orphans = asserted.filter((b) => b.inRegistry === false);
    console.log(`\n-- axis: users.json membership`);
    if (asserted.length === 0) console.log('   NOT ASSERTED (no roster wired) — cannot be used.');
    else {
      console.log(`   ${asserted.length - orphans.length}/${asserted.length} rows are REGISTERED accounts; ${orphans.length} orphaned.`);
      console.log(orphans.length === 0
        ? '   ⇒ DEGENERATE: it separates nothing, and every row is a book the nightly\n'
          + '     EOD archive iterates — so deleting its files reclaims nothing durable.'
        : `   orphans: ${orphans.map((b) => b.book).join(', ')}`);
    }

    // ── Axis 2: does mtime separate anything? ───────────────────────────────
    const now = Date.parse(census.measuredAt);
    const ages = d.books.map((b) => (now - Date.parse(b.newestMtime)) / 86_400_000).sort((a, b) => a - b);
    console.log(`\n-- axis: last-write mtime (days since newest write)`);
    console.log(`   min ${ages[0].toFixed(2)}d  median ${ages[Math.floor(ages.length / 2)].toFixed(2)}d  max ${ages[ages.length - 1].toFixed(2)}d`);
    const stale = d.books.filter((b) => (now - Date.parse(b.newestMtime)) / 86_400_000 > 7);
    console.log(stale.length === 0
      ? '   ⇒ DEGENERATE: no row has gone 7d without a write. There is no age floor\n'
        + '     that separates a dead book from a live one, because the archive writes\n'
        + '     every book in the roster every session.'
      : `   >7d stale: ${stale.map((b) => `${b.book}/${b.mode}`).join(', ')}`);

    // ── Axis 3: content. The one that discriminates. ────────────────────────
    console.log(`\n-- axis: content digest (books holding IDENTICAL ledgers)`);
    const classes = new Map();
    let digested = 0;
    for (const b of d.books) {
      if (b.contentDigest == null) continue;
      digested += 1;
      const c = classes.get(b.contentDigest) ?? [];
      c.push(b);
      classes.set(b.contentDigest, c);
    }
    if (digested === 0) console.log('   NOT MEASURED (re-run with ?digests=1).');
    const dupes = [...classes.values()].filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
    for (const c of dupes) {
      const bytes = c.reduce((a, b) => a + b.bytes, 0);
      const redundant = bytes - c[0].bytes; // one copy is information; the rest are not
      console.log(`   ${String(c.length).padStart(3)} books share one ledger — ${mib(bytes)} total, ${mib(redundant)} redundant`);
      console.log(`       ${c.map((b) => b.book).join(' ')}`);
    }
    const unique = [...classes.values()].filter((c) => c.length === 1).map((c) => c[0]);
    console.log(`   ${unique.length} rows hold a ledger no other book holds:`);
    for (const b of unique.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`       ${mib(b.bytes).padStart(11)}  ${b.files}f  ${b.book}/${b.mode}${b.live ? '  [RESERVED]' : ''}`);
    }

    // ── The fill rate, which decides whether a reap is a fix or a delay ─────
    console.log(`\n-- fill rate (why a one-off reap may not hold)`);
    for (const r of d.byDate) console.log(`   ${r.date}  ${mib(r.bytes).padStart(11)}  ${r.files} files`);
    const days = d.byDate.length;
    if (days >= 2) {
      // The OLDEST date in the pool is a partial day: eviction has already
      // trimmed it. Exclude it, or the rate reads low and the reap reads
      // longer-lived than it is.
      const full = d.byDate.slice(1);
      const perDay = full.reduce((a, r) => a + r.bytes, 0) / full.length;
      const qaPerDay = perDay * (d.books.filter((b) => QA_PATTERNS.some((re) => re.test(b.book))).reduce((a, b) => a + b.bytes, 0) / d.bytes);
      const freed = d.books.filter((b) => QA_PATTERNS.some((re) => re.test(b.book))).reduce((a, b) => a + b.bytes, 0);
      console.log(`   ⇒ ${mib(perDay)}/session over the ${full.length} complete dates (oldest excluded — eviction already trimmed it)`);
      console.log(`   ⇒ a name-pattern reap frees ${mib(freed)}; headroom after it = ${mib(d.maxBytes - (d.bytes - freed))}`);
      console.log(`   ⇒ FILES DELETED, ACCOUNTS KEPT: refills at ${mib(perDay)}/session ⇒ back at cap in ${((d.maxBytes - (d.bytes - freed)) / perDay).toFixed(1)} sessions`);
      console.log(`   ⇒ ACCOUNTS RETIRED TOO:        refills at ${mib(perDay - qaPerDay)}/session ⇒ back at cap in ${((d.maxBytes - (d.bytes - freed)) / (perDay - qaPerDay)).toFixed(1)} sessions`);
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('NOTHING WAS DELETED. Scope #2 (a ruling) gates that, and this script has');
  console.log('no delete mode on purpose.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
