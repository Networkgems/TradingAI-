# Vendor report (DRAFT, ready to file): Paperclip self-host backup path — two durability defects

**Status: SANITIZED AND READY. Per the decision of record on TRA-5032 (CEO ruling, 2026-10-04), an agent must NOT file this upstream. A human posts it — bundle with the Tuesday vendor report.**

Component: `@paperclipai` self-host distribution (installed via `npx`; observed tree `.../node_modules/@paperclipai`).
Severity: High — both defects together can silently reduce a deployment to zero restorable backups while `/api/health` reports `ok`.

---

## Defect 1 — backup health gates existence and age, but never integrity or size (fail-open on restore)

File: `@paperclipai/server/dist/services/database-backup-health.js`

- `findLatestBackup` filters `*.sql.gz`, sorts by mtime descending, takes the first entry.
- `sizeBytes` is computed and published on the result, but the only two warning gates are **existence** (`database_backup_missing`) and **age** (`database_backup_stale` when `ageHours > maxAgeHours`). `sizeBytes` is never tested; there is no integrity probe.

**Observed consequence (production self-host, 2026-09-25).** The host crashed between `backup-lib.js`'s `pipeline(sqlReadStream, createGzip(), gzWriteStream)` and the subsequent `unlinkSync(sqlFile)`, leaving:

- `paperclip-20260925-150739.sql.gz` at **20 bytes** — a valid, complete, EMPTY gzip member (`gunzip` succeeds on it):
  `1f 8b 08 00 00 00 00 00 00 0a 03 00 00 00 00 00 00 00 00 00`
- an orphan `paperclip-20260925-150739.sql` at ~700 MB (itself truncated — no terminator).

The 20-byte stub was the newest `.sql.gz` for the next 5.9 days, so `/api/health` named it `latestBackup` with `status: ok` for ~26 hours until the age gate tripped. A 20-byte gzip is not a restore point.

**The bounded window is the benign case.** If truncation repeats on a cadence faster than `maxAgeHours`, the fail-open is permanent: each new stub refreshes mtime, `ageHours` never exceeds the threshold, and the platform reports a healthy backup indefinitely while holding nothing restorable. At an hourly backup cadence this is exactly what would happen.

**Suggested fix.** Gate on restorability, not presence: a new warning code (e.g. `database_backup_truncated`) when the newest archive fails a cheap integrity probe. Note a size floor alone is insufficient — a crash mid-compress leaves a *partial* gzip with a current mtime that can exceed any plausible floor. The dump format already emits a deterministic terminator (`COMMIT;`); verifying the gzip trailer plus the terminator is cheap and decisive.

## Defect 2 — `pruneOldBackups` ranks tier representatives by mtime with no integrity predicate, and accepts bare `.sql`

File: `@paperclipai/db/dist/backup-lib.js` (`pruneOldBackups`)

- The weekly/monthly tiers keep the **newest** entry per ISO week / per month.
- The enumerator accepts bare `.sql` as well as `.sql.gz`.
- Newest-wins with no completeness test means **a crash artifact can outrank and evict the real backups of its bucket.**

**Observed consequence (same host, sweep of 2026-10-01T21:15Z).** The sweep kept a 2.6 GB **truncated, uncompressed** `.sql` crash orphan (no terminator; cannot restore) as the ISO-week-38 representative and **deleted that week's two genuine compressed backups**. Week 38 permanently lost its restore point.

**Suggested fix.** Exclude bare `.sql` from tier *representation* (still enumerate for deletion so orphans are cleaned up), and prefer a verified `.sql.gz` when choosing a bucket representative.

## Defect 3 (secondary) — crash window between archive finalization and source unlink

`backup-lib.js` unlinks the `.sql` source immediately after the gzip pipeline resolves. A crash between the two leaves the stub + orphan pair above. Writing to a temp name and renaming into place on success (`*.sql.gz.tmp` -> `*.sql.gz`) would make the artifact invisible to both health and prune until complete.

## Reproduction sketch

1. Create a 20-byte empty-member gzip named newer than every real backup in the backup directory: health reports `ok` and names it `latestBackup` until the age gate trips.
2. Place a bare `.sql` file with the newest mtime of an ISO week that also contains real `.sql.gz` backups; run the prune: the `.sql` becomes the week's representative and the real backups are deleted.
