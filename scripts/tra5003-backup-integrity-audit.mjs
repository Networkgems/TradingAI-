#!/usr/bin/env node
/**
 * TRA-5003 -- local guard for the Paperclip DB backup path.
 *
 * Two upstream defects (vendored @paperclipai, not patchable here) make the
 * backup directory able to present a file that CANNOT restore as a restore point:
 *
 *   1. `server/dist/services/database-backup-health.js:38-58` picks `latestBackup`
 *      as newest-by-mtime among `*.sql.gz` with NO size and NO integrity predicate,
 *      and only `ageHours` is ever graded (:75). A 20-byte archive reports green.
 *   2. `db/dist/backup-lib.js:56-112` `pruneOldBackups` keeps the NEWEST member of
 *      each week/month bucket and matches `.sql` as well as `.sql.gz`, so a
 *      truncated orphan intermediate can become a tier representative AND evict
 *      every genuine backup of its bucket.
 *
 * A size floor is NOT a sufficient check: between `backup-lib.js:800` and `:801`
 * the real archive is a *partial* gzip with a current mtime, and mid-compress it
 * comfortably exceeds any plausible floor. The sound test is the terminator:
 * a complete Paperclip dump ends with `COMMIT;` (emitted at `backup-lib.js:795`).
 * This script tests that, not the size.
 *
 * Usage:
 *   node scripts/tra5003-backup-integrity-audit.mjs [--dir <backupDir>] [--all] [--json]
 *
 * Default scope is the files that actually matter: whatever `/api/health` would
 * publish as `latestBackup`, plus every file the next prune would retain as a
 * week/month tier representative. `--all` verifies every archive (slow: each
 * archive decompresses to ~2.9 GB).
 *
 * Exit code 0 = clean, 1 = findings, 2 = could not run.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const PREFIX = "paperclip";
const TERMINATOR = "COMMIT;";
// Retention in force on the self-host (instance_settings.general.backupRetention is
// absent -> DEFAULT_BACKUP_RETENTION in @paperclipai/shared). Verified TRA-4895.
const RETENTION = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const backupDir = resolve(opt("--dir",
  join(homedir(), ".paperclip", "instances", "default", "data", "backups")));
const verifyAll = flag("--all");
const asJson = flag("--json");

if (!existsSync(backupDir)) {
  console.error(`[tra5003] backup dir not found: ${backupDir}`);
  process.exit(2);
}

/* ---- faithful port of pruneOldBackups (backup-lib.js:30-112) ---- */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthlyCutoffOf = (nowMs) => {
  const n = new Date(nowMs);
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - Math.max(1, RETENTION.monthlyMonths), 1);
};

function planPrune(entries, nowMs) {
  const dailyCutoff = nowMs - Math.max(1, RETENTION.dailyDays) * 864e5;
  const weeklyCutoff = nowMs - Math.max(1, RETENTION.weeklyWeeks) * 7 * 864e5;
  const monthlyCutoff = monthlyCutoffOf(nowMs);
  const weekB = new Set(), monthB = new Set();
  const reps = [];
  for (const e of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (e.mtimeMs >= dailyCutoff) continue;              // daily tier: keeps everything
    const d = new Date(e.mtimeMs);
    if (e.mtimeMs >= weeklyCutoff) {
      const wk = isoWeekKey(d);
      if (!weekB.has(wk)) { weekB.add(wk); reps.push({ ...e, tier: `weekly ${wk}` }); }
      continue;
    }
    if (e.mtimeMs >= monthlyCutoff) {
      const mo = monthKey(d);
      if (!monthB.has(mo)) { monthB.add(mo); reps.push({ ...e, tier: `monthly ${mo}` }); }
    }
  }
  return reps;
}

/* ---- the integrity test: does the dump carry its COMMIT; terminator? ---- */
async function verifyArchive(fullPath) {
  const gz = fullPath.endsWith(".gz");
  const raw = createReadStream(fullPath);
  const stream = gz ? raw.pipe(createGunzip()) : raw;
  let tail = "";
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      tail = (tail + chunk.toString("utf8", Math.max(0, chunk.length - 8192))).slice(-8192);
    }
  } catch (err) {
    return { ok: false, bytes, reason: `decompress failed: ${err.code ?? err.message}` };
  }
  if (!tail.includes(TERMINATOR)) {
    return { ok: false, bytes, reason: `TRUNCATED -- no ${TERMINATOR} in the final 8 KB` };
  }
  return { ok: true, bytes, reason: null };
}

/* ---- inventory, exactly the set prune operates on ---- */
const entries = readdirSync(backupDir)
  .filter((n) => n.startsWith(`${PREFIX}-`) && (n.endsWith(".sql") || n.endsWith(".sql.gz")))
  .map((name) => {
    const fullPath = join(backupDir, name);
    const st = statSync(fullPath);
    return { name, fullPath, mtimeMs: st.mtimeMs, size: st.size };
  });

const findings = [];
const gzOnly = entries.filter((e) => e.name.endsWith(".sql.gz"))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);
const published = gzOnly[0] ?? null;   // what /api/health reports as latestBackup
const reps = planPrune(entries, Date.now());

/* finding A: uncompressed intermediates present at all */
for (const e of entries.filter((x) => x.name.endsWith(".sql"))) {
  findings.push({
    code: "orphan_intermediate",
    file: e.name,
    detail: `uncompressed intermediate present (${(e.size / 1048576).toFixed(1)} MB). ` +
      `backup-lib.js:802 only unlinks it on the success path, and prune matches .sql (:67), ` +
      `so it can become a tier representative.`,
  });
}

/* finding B: an archive small enough that it cannot be a dump */
for (const e of gzOnly.filter((x) => x.size < 1_048_576)) {
  findings.push({
    code: "database_backup_truncated",
    file: e.name,
    detail: `${e.size} bytes -- cannot be a dump. ` +
      (e.size === 20 ? "20 bytes is a VALID, COMPLETE, EMPTY gzip member, so a CRC/gzip -t " +
        "integrity check PASSES on it. " : "") +
      `health publishes this verbatim as latestBackup with no size predicate.`,
  });
}

/* finding C: the files that matter fail the terminator test */
const toVerify = verifyAll
  ? entries
  : [...new Map([...(published ? [published] : []), ...reps].map((e) => [e.name, e])).values()];

for (const e of toVerify) {
  if (e.size < 1_048_576) continue;                 // already reported by finding B
  const r = await verifyArchive(e.fullPath);
  const role = [
    published && e.name === published.name ? "health latestBackup" : null,
    reps.find((x) => x.name === e.name)?.tier ?? null,
  ].filter(Boolean).join(" + ") || "archive";
  if (!r.ok) {
    findings.push({
      code: "unrestorable_restore_point",
      file: e.name,
      detail: `[${role}] ${r.reason} (decompressed ${r.bytes} bytes). ` +
        `This file is presented as a restore point and cannot restore.`,
    });
  } else if (!asJson) {
    console.log(`  ok   ${e.name}  [${role}]  ${(r.bytes / 1073741824).toFixed(2)} GB decompressed, ${TERMINATOR} present`);
  }
}

if (asJson) {
  console.log(JSON.stringify({
    backupDir, checkedAt: new Date().toISOString(), retention: RETENTION,
    archiveCount: entries.length,
    latestBackup: published ? { name: published.name, sizeBytes: published.size } : null,
    tierRepresentatives: reps.map((r) => ({ name: r.name, tier: r.tier })),
    verified: toVerify.map((e) => e.name), findings,
  }, null, 2));
} else {
  console.log(`\n[tra5003] ${backupDir}`);
  console.log(`  ${entries.length} archives; latestBackup = ${published ? `${published.name} (${(published.size / 1048576).toFixed(1)} MB)` : "NONE"}`);
  for (const r of reps) console.log(`  tier rep: ${r.name}  <- ${r.tier}`);
  if (!findings.length) {
    console.log(`\n[tra5003] CLEAN -- every presented restore point carries its ${TERMINATOR} terminator.`);
  } else {
    console.log(`\n[tra5003] ${findings.length} FINDING(S):`);
    for (const f of findings) console.log(`  ${f.code}: ${f.file}\n      ${f.detail}`);
  }
}

process.exit(findings.length ? 1 : 0);
