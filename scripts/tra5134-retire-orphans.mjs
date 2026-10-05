/**
 * TRA-5134 — drive the bulk orphan-book retirement ruled on TRA-5132 (card
 * 10dfc4b1: Q1 = retire ALL legacy orphans, Q2 = the 64 TRA-4902 QA books
 * included). MOVE-ONLY; the server route refuses to delete anything and this
 * driver has no delete verb to offer.
 *
 *   ADMIN_PASSWORD=… node scripts/tra5134-retire-orphans.mjs            # dry run
 *   ADMIN_PASSWORD=… node scripts/tra5134-retire-orphans.mjs --apply    # execute
 *
 * The server endpoint (`POST /api/admin/orphaned-books/retire-sweep`) owns the
 * guards: registry read at sweep start, fail-closed on an empty/disjoint
 * registry, skip-and-report on any tree written after sweep start, per-tree
 * byte-completeness witnesses, RTH refusal on apply. This driver batches calls,
 * prints the plan/witnesses, and records the raw responses to disk.
 *
 * ⚠ `TRADING_API_BASE` is deliberately not read — it is the self-host in agent
 * shells. Override with `--base=`.
 */
import { writeFileSync } from 'fs';

const BASE =
  process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
  'https://tradingai-bqb1.onrender.com';
const APPLY = process.argv.includes('--apply');
const BATCH = Number(process.argv.find((a) => a.startsWith('--batch='))?.slice('--batch='.length) ?? 60);

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
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const ver = await (await fetch(`${BASE}/api/health/options-live`)).json().catch(() => ({}));
  const build = ver.build ?? {};
  console.log(`host      : ${BASE}`);
  console.log(`build     : ${build.commitShort ?? '?'}  pid ${build.pid ?? '?'}  boot ${build.startedAt ?? '?'}`);
  console.log(`mode      : ${APPLY ? 'APPLY — trees will MOVE to orphaned-books/ (nothing deleted)' : 'DRY RUN'}`);

  const census0 = await (await fetch(`${BASE}/api/health/storage/ledger`, { headers: H })).json().catch(() => null);
  if (census0?.dirs) {
    console.log('\nledger census BEFORE:');
    for (const k of Object.keys(census0.dirs)) {
      const d = census0.dirs[k];
      console.log(`  ${k}/ ${mib(d.bytes)} of ${mib(d.maxBytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} rows`);
    }
  }

  const post = async (body) => {
    const r = await fetch(`${BASE}/api/admin/orphaned-books/retire-sweep`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`retire-sweep ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
    return j;
  };

  // ── Always plan first, apply or not ──
  const plan = await post({ apply: false });
  console.log(`\nregistry  : ${plan.registeredUsers} registered — ${plan.registeredBooks.map((b) => b.name).join(', ')}`);
  console.log(`disk      : ${plan.bookDirsOnDisk} book dirs, ${plan.orphanCount} orphans`);
  if (plan.nonDirectoryEntries.length) console.log(`non-dirs  : ${plan.nonDirectoryEntries.join(', ')}`);
  const planBytes = plan.rows.reduce((s, r) => s + r.before.bytes, 0);
  const planFiles = plan.rows.reduce((s, r) => s + r.before.files, 0);
  console.log(`move plan : ${plan.rows.length} trees, ${planFiles} files, ${mib(planBytes)}`);
  for (const row of plan.rows) {
    console.log(`  ${row.name}  ${row.before.files}f ${mib(row.before.bytes)}${row.skipped && row.skipped !== 'dry_run' ? `  [SKIP: ${row.skipped}]` : ''}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`.tra5134-plan-${stamp}.json`, JSON.stringify(plan, null, 2));
  console.log(`\nplan saved: .tra5134-plan-${stamp}.json`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing moved. Re-run with --apply (outside RTH).');
    return;
  }

  // ── Apply in batches; each call re-reads the registry at its own sweep start ──
  const batches = [];
  let totalMoved = 0;
  for (let i = 0; ; i++) {
    const r = await post({ apply: true, limit: BATCH });
    batches.push(r);
    if (r.refused) throw new Error(`REFUSED by server guard: ${r.refused}`);
    totalMoved += r.moved;
    console.log(
      `batch ${i + 1}: orphans ${r.orphanCount}, moved ${r.moved}, skipped ${r.skippedCount}, ` +
      `failures ${r.failures}, byte-complete ${r.zeroDeletionWitness}, registered untouched ${r.registeredUntouched}, ` +
      `dirs now ${r.bookDirsOnDiskAfter}`,
    );
    if (r.failures > 0 || !r.zeroDeletionWitness || !r.registeredUntouched) {
      console.log('⛔ STOPPING — a witness failed. Raw batch follows.');
      console.log(JSON.stringify(r.rows.filter((x) => x.skipped === null && !x.ok), null, 2));
      break;
    }
    const remaining = r.orphanCount - r.rows.length;
    if (remaining <= 0) break;
    if (r.moved === 0) {
      console.log(`⚠ no progress with ${remaining} orphans remaining (all skipped?) — stopping.`);
      break;
    }
  }
  writeFileSync(`.tra5134-apply-${stamp}.json`, JSON.stringify(batches, null, 2));
  console.log(`\napply record saved: .tra5134-apply-${stamp}.json  (moved ${totalMoved} total)`);

  // ── Verify by value (TRA-2163): fresh dry run must now find ~0 orphans ──
  const after = await post({ apply: false });
  console.log(`\nAFTER: ${after.bookDirsOnDisk} book dirs on disk vs ${after.registeredUsers} registered; orphans remaining: ${after.orphanCount}`);
  for (const b of after.registeredBooks) {
    console.log(`  KEEP ${b.name}: dir ${b.dirExists ? 'present ✓' : '⚠ MISSING'}`);
  }

  const census1 = await (await fetch(`${BASE}/api/health/storage/ledger`, { headers: H })).json().catch(() => null);
  if (census0?.dirs && census1?.dirs) {
    console.log('\nledger census AFTER:');
    for (const k of Object.keys(census1.dirs)) {
      const d0 = census0.dirs[k];
      const d = census1.dirs[k];
      console.log(`  ${k}/ ${mib(d.bytes)} (${((d.bytes / d.maxBytes) * 100).toFixed(1)}%), ${d.files} files, ${d.books.length} rows   [was ${mib(d0?.bytes ?? 0)}, ${d0?.files ?? '?'}f, ${d0?.books?.length ?? '?'} rows]`);
    }
  }
  console.log('\nbackups/ stops re-mirroring the moved trees at the next rotation (~12h) —');
  console.log('record that delta separately; it cannot be read in the same breath as the move.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
