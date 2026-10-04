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
const selftest = flag("--selftest");

if (!selftest && !existsSync(backupDir)) {
  console.error(`[tra5003] backup dir not found: ${backupDir}`);
  process.exit(2);
}

/* ---- faithful port of pruneOldBackups (backup-lib.js:30-112) ---- */
// TRA-5032: the vendor seeds this from the mtime's *LOCAL* calendar date
// (`date.getFullYear()/getMonth()/getDate()`, backup-lib.js:35) while keying the MONTH
// axis off UTC (`monthKey`, :41-42). That mix is the vendor's, and this port must
// reproduce it rather than correct it -- a port that reads UTC on the week axis names a
// DIFFERENT tier representative than the sweep will keep, so the audit would verify a
// file that is not the one at risk and report CLEAN over an unverified bucket.
// Measured on America/New_York (this host): the two keyings disagree on 226 of 8760
// hourly instants in 2026 (2.6%) -- the 00:00-04:59Z band, i.e. Sunday evening ET, which
// is exactly where the 23:15 ET backup slot lands (mtime ~03:17Z) once a week.
// DO NOT "fix" this to UTC without re-reading backup-lib.js:34-40 first.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
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
  // tierKey -> every entry that falls in that bucket (not just the kept one). AC2 needs
  // to know whether a `.sql.gz` existed alongside a `.sql` that outranked it.
  const bucketMembers = new Map();
  const addMember = (key, e) => {
    if (!bucketMembers.has(key)) bucketMembers.set(key, []);
    bucketMembers.get(key).push(e);
  };
  for (const e of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (e.mtimeMs >= dailyCutoff) continue;              // daily tier: keeps everything
    const d = new Date(e.mtimeMs);
    if (e.mtimeMs >= weeklyCutoff) {
      const wk = isoWeekKey(d);
      addMember(`weekly ${wk}`, e);
      if (!weekB.has(wk)) { weekB.add(wk); reps.push({ ...e, tier: `weekly ${wk}` }); }
      continue;
    }
    if (e.mtimeMs >= monthlyCutoff) {
      const mo = monthKey(d);
      addMember(`monthly ${mo}`, e);
      if (!monthB.has(mo)) { monthB.add(mo); reps.push({ ...e, tier: `monthly ${mo}` }); }
    }
  }
  return { reps, bucketMembers, dailyCutoff, weeklyCutoff, monthlyCutoff };
}

/**
 * TRA-5032 / AC3: which ISO weeks inside the weekly-retention span hold NO archive at all?
 *
 * A bucket with no member produces no tier representative, so it produces no row on any
 * surface -- the zero is invisible on the very surface that owns it. 2026-W38 is exactly
 * that case on this host: its one real archive (`paperclip-20260918-084201.sql.gz`) was
 * deleted by the 2026-10-01T21:15Z sweep as a "W38 duplicate" of a truncated 2.45 GB
 * `.sql` orphan that was newer, and the orphan has since been quarantined -- so the week
 * now holds nothing, and nothing anywhere said so.
 */
function weeklyCoverage(entries, dailyCutoff, weeklyCutoff) {
  const present = new Map();   // weekKey -> entries
  for (const e of entries) {
    const k = isoWeekKey(new Date(e.mtimeMs));
    if (!present.has(k)) present.set(k, []);
    present.get(k).push(e);
  }
  // Weeks wholly inside [weeklyCutoff, dailyCutoff): the at-risk span. Weeks newer than
  // dailyCutoff are covered by the daily tier (which keeps everything), so a gap there is
  // a backup-cadence question, not a retention question.
  const weeks = [];
  const seen = new Set();
  for (let t = weeklyCutoff; t < dailyCutoff; t += 864e5) {
    const k = isoWeekKey(new Date(t));
    if (seen.has(k)) continue;
    seen.add(k);
    weeks.push({ week: k, members: present.get(k) ?? [] });
  }
  return weeks;
}

/**
 * TRA-5032 port-fidelity selftest. The ONE thing that silently invalidates this whole
 * audit is someone "tidying" `isoWeekKey` onto UTC getters: the audit would then verify a
 * different file than the sweep keeps and report CLEAN over an unverified bucket. That is
 * unobservable from the audit's own output, so it is asserted here instead of trusted.
 *
 * Two arms, because neither alone is sound:
 *   STRUCTURAL -- always runs, zone-independent: the function must read LOCAL getters.
 *   BEHAVIOURAL -- only discriminates in a zone west of UTC; where it cannot discriminate
 *                  it reads NOT MEASURED and is NOT counted as a pass. In UTC the two
 *                  keyings are equivalent, so the host is not at risk and the structural
 *                  arm alone is sufficient to refuse the regression.
 *
 * Exit 0 PASS / 1 FAIL.
 */
function runSelftest() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = new Date(Date.UTC(2026, 0, 5, 2, 0)).getTimezoneOffset();
  console.log(`[tra5003 selftest] zone=${zone} offsetMin=${offsetMin}`);
  let failed = false;

  // --- arm 1: STRUCTURAL. The regression to catch is a UTC "tidy-up" of isoWeekKey.
  const src = isoWeekKey.toString();
  const seedsLocal = /date\.getFullYear\(\)/.test(src) && /date\.getMonth\(\)/.test(src) && /date\.getDate\(\)/.test(src);
  const seedsUtc = /date\.getUTC(FullYear|Month|Date)\(\)/.test(src);
  if (!seedsLocal || seedsUtc) {
    console.error("[tra5003 selftest] STRUCTURAL FAIL: isoWeekKey must seed from the mtime's LOCAL");
    console.error("  calendar date, as the vendor does (@paperclipai/db/dist/backup-lib.js:35).");
    console.error(`  seedsLocal=${seedsLocal} seedsUtc=${seedsUtc}`);
    failed = true;
  } else {
    console.log("[tra5003 selftest] STRUCTURAL PASS: isoWeekKey seeds from the LOCAL calendar date.");
  }

  // --- arm 2: BEHAVIOURAL. 2026-01-05T02:00Z is Monday 02:00 UTC = Sunday 21:00 west of
  // UTC. Vendor (LOCAL) -> Sunday -> 2026-W01; a UTC-keyed port -> Monday -> 2026-W02.
  const probe = new Date(Date.UTC(2026, 0, 5, 2, 0));
  if (offsetMin <= 0) {
    console.log(`[tra5003 selftest] BEHAVIOURAL: NOT MEASURED -- zone ${zone} does not discriminate`);
    console.log("  local-vs-UTC week keying, so the two are equivalent HERE and this host is not at");
    console.log("  risk. Not a pass; the structural arm above is what refuses the regression.");
  } else {
    const got = isoWeekKey(probe);
    if (got !== "2026-W01") {
      console.error(`[tra5003 selftest] BEHAVIOURAL FAIL: isoWeekKey(${probe.toISOString()}) = ${got}, expected 2026-W01.`);
      console.error("  A UTC-keyed port names a DIFFERENT tier representative than the sweep will keep,");
      console.error("  so the audit would verify the wrong file and report CLEAN over an unverified bucket.");
      failed = true;
    } else {
      console.log(`[tra5003 selftest] BEHAVIOURAL PASS: ${probe.toISOString()} -> ${got} (vendor-faithful).`);
    }
  }
  return failed ? 1 : 0;
}

if (selftest) process.exit(runSelftest());

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
const nowMs = Date.now();
const { reps, bucketMembers, dailyCutoff, weeklyCutoff } = planPrune(entries, nowMs);
const coverage = weeklyCoverage(entries, dailyCutoff, weeklyCutoff);

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

/* finding B2 (TRA-5032 / AC2): a bare `.sql` orphan was SELECTED as a tier representative
   while a `.sql.gz` existed in the same bucket. This fires even when the orphan passes the
   terminator test -- a complete `.sql` IS restorable (`restoreWithPsql` handles non-.gz),
   so truncation alone would not catch it, yet its mere existence means a run aborted and
   the `.gz` is the artifact the tier was meant to hold. */
for (const r of reps.filter((x) => x.name.endsWith(".sql"))) {
  const sibling = (bucketMembers.get(r.tier) ?? []).find((m) => m.name.endsWith(".sql.gz"));
  findings.push({
    code: "tier_rep_is_orphan",
    file: r.name,
    detail: `[${r.tier}] an uncompressed intermediate is this bucket's representative` +
      (sibling
        ? `, OUTRANKING a real archive in the same bucket (${sibling.name}, ` +
          `${(sibling.size / 1048576).toFixed(1)} MB) -- prune keeps newest-by-mtime (backup-lib.js:86-93), ` +
          `so the next sweep DELETES the real archive and keeps the orphan.`
        : ` and no \`.sql.gz\` remains in it -- the real archive of this bucket has already been evicted.`),
  });
}

/* finding D (TRA-5032 / AC3): an ISO week inside the weekly-retention span with no archive
   at all. Recorded explicitly, because a bucket with no member emits no tier-representative
   row and the gap is otherwise only visible as an absence nobody queries. */
for (const w of coverage.filter((x) => x.members.length === 0)) {
  findings.push({
    code: "restore_point_gap",
    file: `(none)`,
    detail: `ISO week ${w.week} is inside the ${RETENTION.weeklyWeeks}-week retention span ` +
      `and holds ZERO archives -- that week has no restore point. A bucket with no member ` +
      `produces no representative and therefore no row: the zero is invisible unless it is ` +
      `enumerated like this.`,
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
    weeklyCoverage: coverage.map((w) => ({ week: w.week, archives: w.members.length })),
    verified: toVerify.map((e) => e.name), findings,
  }, null, 2));
} else {
  console.log(`\n[tra5003] ${backupDir}`);
  console.log(`  ${entries.length} archives; latestBackup = ${published ? `${published.name} (${(published.size / 1048576).toFixed(1)} MB)` : "NONE"}`);
  for (const r of reps) console.log(`  tier rep: ${r.name}  <- ${r.tier}`);
  console.log(`  weekly-tier span [${new Date(weeklyCutoff).toISOString()} .. ${new Date(dailyCutoff).toISOString()}) coverage:`);
  for (const w of coverage) {
    console.log(`    ${w.week}: ${w.members.length} archive(s)${w.members.length === 0 ? "   <<< NO RESTORE POINT" : ""}`);
  }
  if (!findings.length) {
    console.log(`\n[tra5003] CLEAN -- every presented restore point carries its ${TERMINATOR} terminator.`);
  } else {
    console.log(`\n[tra5003] ${findings.length} FINDING(S):`);
    for (const f of findings) console.log(`  ${f.code}: ${f.file}\n      ${f.detail}`);
  }
}

process.exit(findings.length ? 1 : 0);
