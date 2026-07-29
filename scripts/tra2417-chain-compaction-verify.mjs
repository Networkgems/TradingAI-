#!/usr/bin/env node
/**
 * TRA-2417 — post-deploy grade for option-chain archive compaction.
 *
 * The thing being graded: after the deploy carrying the compactor boots, the
 * ~403 MB of plaintext option-chain partitions on bqb1's 1 GB `/data` should be
 * ~48 MB of `.json.gz`, reclaiming ~355 MB, with every partition still present.
 *
 * ## Why this is a script and not a curl
 *
 * The failure modes here all *read like a pass*:
 *
 *   - **Not deployed.** `/api/health/chain-capture` 200s on the old build too —
 *     it just has no `storage` key. `jq '.storage.compactedPartitions'` prints
 *     `null` and a shell `-gt` comparison on null is false-y in exactly the same
 *     way a real zero is. That gets its own exit code (2), never a FAIL.
 *   - **Compaction never ran.** `filesCompacted: 0` is ALSO the steady state on
 *     a second boot. `lastCompaction` being present at all is what separates
 *     "ran, nothing to do" from "never ran"; `failures` is what separates a
 *     healthy no-op from a compactor that kept plaintext on every file.
 *   - **Nothing was lost.** A compactor that reclaims space by dropping
 *     partitions would score BETTER on every byte metric. `partitions` must not
 *     have fallen below the count captured before the deploy — this is checked,
 *     not assumed, via --expect-partitions.
 *
 * ## Two arms, and an unmeasurable arm is not a pass (TRA-2413)
 *
 *   A. the app's own accounting  — `/api/health/chain-capture` → `.storage`
 *   B. the volume actually got the bytes back — Render's disk-usage metric
 *
 * Arm A alone reads identically in the "compacted" world and the "compacted but
 * the volume is still full because something else ate it" world. Arm B needs
 * `RENDER_API_KEY`; without it the run exits **4 PARTIAL**, which is NOT a pass
 * and NOT a failure — it is "half the verdict is missing".
 *
 * Exit codes
 *   0  PASS          both arms green
 *   1  FAIL          deployed, but compaction did not do its job
 *   2  NOT_DEPLOYED  200 without the `storage` key — the old build
 *   3  BLIND         unreachable / non-200 / unparseable — never a pass
 *   4  PARTIAL       arm A green, arm B unmeasurable (no RENDER_API_KEY)
 *
 * Usage
 *   node scripts/tra2417-chain-compaction-verify.mjs [--host=…] [--expect-partitions=48]
 */

const HOST =
  process.argv.find((a) => a.startsWith('--host='))?.slice(7) ??
  'https://tradingai-bqb1.onrender.com';
const EXPECT_PARTITIONS = Number(
  process.argv.find((a) => a.startsWith('--expect-partitions='))?.slice(20) ?? '48',
);
const SERVICE = 'srv-d7mb7rr7uimc73ev0chg';

const EXIT = { PASS: 0, FAIL: 1, NOT_DEPLOYED: 2, BLIND: 3, PARTIAL: 4 };
const MB = (b) => `${(b / 1048576).toFixed(1)} MB`;

function done(code, label, lines) {
  console.log(`\n[TRA-2417] ${label} (exit ${code})`);
  for (const l of lines) console.log(`  ${l}`);
  process.exit(code);
}

async function main() {
  // ── Arm A: the app's own accounting ────────────────────────────────────────
  let res;
  try {
    res = await fetch(`${HOST}/api/health/chain-capture`, { signal: AbortSignal.timeout(45_000) });
  } catch (err) {
    done(EXIT.BLIND, 'BLIND — health route unreachable', [String(err?.message ?? err)]);
  }
  if (res.status !== 200) {
    // A 502 across every route is a deploy swap in flight, not an outage — re-probe.
    done(EXIT.BLIND, `BLIND — /api/health/chain-capture http=${res.status}`, [
      res.status === 502 ? 'a 502 is often a deploy swap IN FLIGHT — re-probe' : '',
    ]);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    done(EXIT.BLIND, 'BLIND — response was not JSON', [String(err?.message ?? err)]);
  }

  // Key-presence is only meaningful on a 200 (checked above). No `storage` on a
  // 200 means the live build predates this change.
  const s = body.storage;
  if (!s || typeof s !== 'object') {
    done(EXIT.NOT_DEPLOYED, 'NOT DEPLOYED — 200 without `storage`', [
      `tradingDaysCaptured=${body.tradingDaysCaptured} lastDate=${body.lastDate}`,
      'the sibling keys ARE present, so this is the old build, not a broken read',
    ]);
  }

  // A partition with ZERO per-symbol files (e.g. 2026-06-02, which holds only
  // its `_meta.json`) is counted in `partitions` but in NEITHER `compacted`
  // nor `plain` — both buckets require `files > 0`. It has no bytes to
  // reclaim, so it must not count against the compaction identity below.
  const emptyPartitions = Array.isArray(s.perPartition)
    ? s.perPartition.filter((p) => p.files === 0)
    : [];

  const facts = [
    `partitions            ${s.partitions} (expected >= ${EXPECT_PARTITIONS})`,
    `compacted / plain     ${s.compactedPartitions} / ${s.plainPartitions}${emptyPartitions.length ? ` (+${emptyPartitions.length} EMPTY: ${emptyPartitions.map((p) => p.date).join(', ')})` : ''}`,
    `archive               ${s.totalMb} MB`,
    `lastCompaction        ${s.lastCompaction ? `${s.lastCompaction.at} trigger=${s.lastCompaction.trigger} files=${s.lastCompaction.filesCompacted} reclaimed=${s.lastCompaction.mbReclaimed} MB failures=${s.lastCompaction.failures}` : 'ABSENT — compaction never ran this boot'}`,
    `retention (report)    ${s.retention?.beyondWindow?.length ?? '?'} partitions beyond ${s.retention?.tradingDays}d = ${s.retention?.beyondWindowMb} MB, enforced=${s.retention?.enforced}`,
  ];

  const failures = [];
  // Nothing was deleted to make the numbers look good.
  if (!(s.partitions >= EXPECT_PARTITIONS)) {
    failures.push(
      `PARTITIONS LOST: ${s.partitions} < ${EXPECT_PARTITIONS} — compaction must never drop a partition`,
    );
  }
  if (!s.lastCompaction) {
    failures.push('lastCompaction ABSENT — the compactor did not run on this boot');
  } else if (s.lastCompaction.failures > 0) {
    failures.push(`${s.lastCompaction.failures} file(s) kept their plaintext — see chain-compaction warnings`);
  }
  // The newest partition is left plain on purpose; every other one must be gz.
  if (s.plainPartitions > 1) {
    failures.push(`${s.plainPartitions} plain partitions — only the newest should be uncompacted`);
  }
  const compactablePartitions = s.partitions - s.plainPartitions - emptyPartitions.length;
  if (s.compactedPartitions < compactablePartitions) {
    failures.push(
      `${s.compactedPartitions}/${compactablePartitions} aged non-empty partitions compacted — the reclaim is incomplete`,
    );
  }
  if (s.retention?.enforced !== false) {
    failures.push('retention.enforced is not false — this script grades a NON-deleting policy');
  }

  if (failures.length > 0) done(EXIT.FAIL, 'FAIL', [...facts, '', ...failures]);

  // ── Arm B: the volume actually got the bytes back ──────────────────────────
  const key = (process.env.RENDER_API_KEY ?? '').trim();
  if (!key) {
    done(EXIT.PARTIAL, 'PARTIAL — arm A green, disk arm UNMEASURABLE (no RENDER_API_KEY)', [
      ...facts,
      '',
      'the app says the archive is compacted; nothing here confirms /data has the space.',
      'set RENDER_API_KEY and re-run for a full verdict.',
    ]);
  }

  const end = new Date();
  const start = new Date(end.getTime() - 6 * 3600 * 1000);
  const q = (path, extra = '') =>
    `https://api.render.com/v1/metrics/${path}?resource=${SERVICE}${extra}`;
  let usage, capacity;
  try {
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const [u, c] = await Promise.all([
      fetch(
        q('disk-usage', `&startTime=${start.toISOString()}&endTime=${end.toISOString()}&resolutionSeconds=600`),
        { headers, signal: AbortSignal.timeout(45_000) },
      ),
      fetch(q('disk-capacity'), { headers, signal: AbortSignal.timeout(45_000) }),
    ]);
    if (!u.ok || !c.ok) {
      done(EXIT.PARTIAL, `PARTIAL — arm A green, Render metrics http=${u.status}/${c.status}`, facts);
    }
    usage = await u.json();
    capacity = await c.json();
  } catch (err) {
    done(EXIT.PARTIAL, 'PARTIAL — arm A green, Render metrics unreachable', [
      ...facts,
      String(err?.message ?? err),
    ]);
  }

  const series = usage?.[0]?.values ?? [];
  const cap = capacity?.[0]?.values?.at(-1)?.value ?? null;
  const latest = series.at(-1)?.value ?? null;
  if (latest == null || cap == null) {
    done(EXIT.PARTIAL, 'PARTIAL — arm A green, disk metric empty', facts);
  }

  // `capacity - usage` runs ~16.9 MB ABOVE the `bavail` the alert grades
  // (reserved blocks). Quoted as an upper bound, deliberately — a verdict that
  // rounds in the optimistic direction on a disk-full ticket is worthless.
  const freeUpper = cap - latest;
  const freePctUpper = (freeUpper / cap) * 100;
  const diskFacts = [
    `disk used             ${MB(latest)} of ${MB(cap)}`,
    `free (UPPER bound)    ${MB(freeUpper)} = ${freePctUpper.toFixed(2)}%  — bavail runs ~16.9 MB lower`,
    `10% alert floor       ${MB(cap * 0.1)}`,
  ];

  // Post-compaction the archive is ~48 MB, so free should be far clear of the
  // floor. Grading against the floor (not a fixed byte target) is what makes
  // this survive the archive growing again.
  if (freeUpper - 16.9 * 1048576 < cap * 0.1) {
    done(EXIT.FAIL, 'FAIL — archive compacted but /data is still under the 10% floor', [
      ...facts,
      '',
      ...diskFacts,
      'something OTHER than the chain archive is consuming the volume — do not close on arm A',
    ]);
  }

  done(EXIT.PASS, 'PASS — archive compacted, no partition lost, volume clear of the floor', [
    ...facts,
    '',
    ...diskFacts,
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(EXIT.BLIND);
});
