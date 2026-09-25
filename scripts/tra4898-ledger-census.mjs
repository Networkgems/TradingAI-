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
 *   ADMIN_PASSWORD=… node scripts/tra4898-ledger-census.mjs
 */

const BASE = process.env.TRADING_API_BASE || 'https://tradingai-bqb1.onrender.com';
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

  for (const kind of Object.keys(census.dirs)) {
    const d = census.dirs[kind];
    console.log(`\n=== ${kind}/  ${mib(d.bytes)} of ${mib(d.maxBytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} book×mode rows`);
    console.log(`    reserved (reports/live + crypto-reports/live): ${mib(d.liveBytes)}, ${d.liveFiles} files`);

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
      console.log(`    ${b.bytes.toString().padStart(9)}  ${b.files.toString().padStart(4)}f  ${b.book}/${b.root}/${b.mode}${b.live ? '  [RESERVED]' : ''}  ${b.oldest}..${b.newest}`);
    }
    console.log('  --- next to evict (in order)');
    for (const f of d.nextToEvict) console.log(`    ${f.book}/${f.root}/${f.mode}/${f.name}  ${f.bytes}B`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
