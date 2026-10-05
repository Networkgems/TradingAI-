# Deep-history backup tier — policy of record (TRA-5032, CEO ruling 2026-10-04)

**Tier directory:** `~/.paperclip/instances/default/data/backup-archive-tra4895`

Formalized as the deep-history tier by the CEO ruling of record on TRA-5032 (delegated authority, TRA-5122). The ruling explicitly **refused** raising `monthlyMonths`: that lever widens a window governed by an mtime ranker with no completeness test — the exact defect (D2) that destroyed the ISO-week-38 restore point. Deep history is governed by this explicit policy, not by whatever the mtime ranker happens not to have evicted yet.

## Policy

1. **Cadence:** on the first fire of each UTC month, routine `aab5d4a0` (post-sweep backup integrity check, daily 21:45Z) copies the newest **verified** `.sql.gz` of the just-ended month from `data/backups` into the tier directory.
2. **Verification:** the *copy* (not the source) is verified end-to-end — full gunzip stream plus `COMMIT;` terminator — before it counts as archived. A size floor is not a verification (a mid-compress partial beats any floor).
3. **Integrity re-check:** the same monthly fire runs
   `node scripts/tra5003-backup-integrity-audit.mjs --dir <tier directory> --all`
   so previously archived files are re-verified, not merely retained.
4. **Deletion:** nothing in the tier directory is deleted without board sign-off. The vendor prune never touches it (it sweeps `data/backups` only, non-recursively).

## Retention arithmetic (recorded so it is not re-derived wrong)

With the in-force triple `{dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1}`, the oft-quoted 28-day figure is the **weekly floor**; the actual live-directory retention **sawtooths between ~31 and ~61 days**. Any retention argument must use the sawtooth, not the floor. The deep-history tier exists precisely because the live directory's horizon is both short and governed by a defective ranker.

## Inventory at formalization (2026-10-05)

| File | Bytes | Verified |
|---|---|---|
| `paperclip-20260823-225921.sql.gz` | 581,773,107 | pre-existing (TRA-4895 rescue) |
| `paperclip-20260828-171646.sql.gz` | 608,180,754 | pre-existing (TRA-4895 rescue) |
| `paperclip-20260925-140739.sql.gz` | 711,085,786 | 2026-10-05: gunzip 2,867,910,057 bytes, `COMMIT;` terminator OK |

Known permanent gap: **ISO week 38 (2026) has no restore point.** The 10-01 sweep deleted the week's two genuine backups in favor of a truncated orphan (quarantined under `data/backups/quarantine-tra5003`, provably not restorable — no terminator). Recorded here per TRA-5032 AC3 rather than left implied.
