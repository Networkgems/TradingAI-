/**
 * TRA-3064 — reclaim the write-only `<date>.md` report sidecars.
 *
 * ## What this deletes and why that is safe
 *
 * Every report write site wrote the SAME string to two inodes:
 *
 * ```
 * writeFile(`${date}.json`, JSON.stringify(report))   // report.markdown is a FIELD on this
 * writeFile(`${date}.md`,   report.markdown)          // ...and this is a verbatim copy of it
 * ```
 *
 * So the sidecar is not a rendering, a projection or a lossy export — it is the
 * same bytes written twice. And nothing ever read it back: `GET /api/reports`
 * filters `/^\d{4}-\d{2}-\d{2}\.json$/` so a `.md` is not even enumerable
 * through the API, `GET /api/reports/:date` joins `${date}.json` and nothing
 * else, and `apps/` and `packages/shared/src` hold zero non-doc consumers. The
 * pre-existing TRA-1475 scrub already deletes the sidecar "if present", i.e. the
 * codebase was written to tolerate its absence before this ticket existed.
 *
 * Measured on bqb1 2026-08-06T10:17:42Z (build `7a531760`): 3,820 `.md` files
 * against 3,822 `.json`, on a volume whose inode table is the binding
 * constraint — 23,070 of 65,536 inodes used, `users/` holding 55.0% of that
 * while bytes sat at 68.2% free. The 07-30 ENOSPC outage ran the volume out of
 * inodes while `freePct` read 37.6% and `belowThreshold: false`.
 *
 * ## The safety gate, which is the whole design
 *
 * A `<name>.md` is removed ONLY when `<name>.json` sits beside it in the same
 * directory. That single condition is what makes this reversible: while the
 * JSON is there, the deleted bytes are still on disk inside `json.markdown` and
 * can be re-rendered exactly. A `.md` with no JSON sibling is NOT a duplicate —
 * its bytes exist nowhere else — so it is kept and counted in `orphansKept`
 * rather than swept. "No code reads it" is not "nobody reads it", and an
 * orphan is precisely the shape a hand-placed or hand-salvaged file would take.
 *
 * This is why the sweep is safe to run before anyone rules on how far back a
 * user must be able to read their own daily report: it deletes only bytes that
 * are retained twice, so it cannot shorten anybody's history by one day.
 *
 * ## Why the bound here is a WORK bound, not an inode budget
 *
 * TRA-2817's lesson is that a retention policy denominated in the wrong unit has
 * no failing state — `MAX_BACKUPS = 24` bounded generations correctly while each
 * generation cost ~1,584 inodes, so the policy was doing exactly what it said at
 * 60% of the filesystem's capacity to hold a file at all.
 *
 * The honest reading of that lesson here: the sidecar term does not get an inode
 * BUDGET, it gets an inode bound of **zero**, by construction — the write sites
 * stopped writing it. A budget bounds a thing that keeps growing; nothing writes
 * this any more, so there is nothing to bound. Zero is strictly stronger than
 * any number a budget could carry, and it cannot drift as the fleet grows, which
 * is the failure mode that consumed the backup budget's headroom.
 *
 * `reportSidecarMaxUnlinks()` therefore bounds the WORK ONE SWEEP DOES, not what
 * is retained. It is a runaway guard on boot latency across a tree of unknown
 * size, and it is deliberately sized well above the 3,822 measured so the
 * one-shot reclaim completes in a single pass. Calling it a retention budget
 * would be the same category error in the opposite direction.
 *
 * The `<date>.json` half of `users/` — ~62 inodes/trading day, the residual
 * after this lands — is the part that genuinely needs a retention horizon, and
 * that is a product ruling (how far back must a user be able to read their own
 * report?), not a disk decision. It is deliberately NOT implemented here.
 *
 * ## No marker file
 *
 * The TRA-241 / TRA-1472 migrations gate on a marker so they run once. This one
 * does not, on purpose. A marker makes the sweep a historical event; the bound
 * it enforces has to hold forever, including across a rollback to a build that
 * still writes sidecars. Re-running is idempotent and costs one `readdir` per
 * report directory when there is nothing to do — cheap enough to pay every boot
 * in exchange for a bound that cannot be defeated by a deploy going backwards.
 */

import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from '../observability/index.js';

const log = logger.child({ module: 'report-sidecar-reclaim' });

/**
 * Runaway guard on unlinks per sweep. Sized ~5x the 3,822 sidecars measured on
 * bqb1 so the one-shot reclaim finishes in one pass; it exists so a tree of
 * unexpected size cannot turn boot into an unbounded `unlink` loop. Env-tunable
 * because a constant compiled into the bundle is one that cannot be moved during
 * an incident.
 */
export function reportSidecarMaxUnlinks(): number {
  const raw = Number(process.env['REPORT_SIDECAR_MAX_UNLINKS']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20_000;
}

export interface SidecarReclaimPlan {
  /** `<name>.md` files that sit beside a `<name>.json` — duplicates, safe to unlink. */
  remove: string[];
  /**
   * `<name>.md` files with NO `<name>.json` sibling. Their bytes exist nowhere
   * else, so they are KEPT. Named rather than counted so an unexpected one is
   * visible instead of silently surviving.
   */
  orphans: string[];
}

/**
 * Decide, from one directory's listing, which `.md` sidecars are duplicates of a
 * sibling `.json`. Pure — no I/O, so the delete decision is testable without a
 * filesystem, which for a delete path is the difference between a test and a
 * demonstration.
 *
 * Matches on basename, so `latest.md`/`latest.json` is handled by the same rule
 * as `2026-08-06.md`/`2026-08-06.json` — both are verbatim copies of
 * `json.markdown` written by the same call sites.
 *
 * Sorted output so the plan is deterministic across filesystems whose `readdir`
 * order differs.
 */
export function planSidecarReclaim(entries: readonly string[]): SidecarReclaimPlan {
  const jsonStems = new Set<string>();
  for (const name of entries) {
    if (name.endsWith('.json')) jsonStems.add(name.slice(0, -'.json'.length));
  }
  const remove: string[] = [];
  const orphans: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const stem = name.slice(0, -'.md'.length);
    if (jsonStems.has(stem)) remove.push(name);
    else orphans.push(name);
  }
  return { remove: remove.sort(), orphans: orphans.sort() };
}

export interface SidecarReclaimResult {
  /** Inodes actually released. */
  removed: number;
  /** Sidecars deliberately kept because they had no `.json` sibling. */
  orphansKept: number;
  /** Orphan paths, so an unexpected one is nameable rather than just counted. */
  orphanPaths: string[];
  /** True if `maxUnlinks` bound the sweep — the reclaim is then PARTIAL. */
  budgetExhausted: boolean;
  /** Unlinks that failed (raced away, permissions). Never fatal. */
  errors: number;
}

function emptyResult(): SidecarReclaimResult {
  return { removed: 0, orphansKept: 0, orphanPaths: [], budgetExhausted: false, errors: 0 };
}

/**
 * Reclaim duplicate sidecars in ONE directory. `remaining` is a shared mutable
 * counter so a whole-tree sweep bounds TOTAL unlinks rather than per-directory
 * ones — a per-directory cap across 62 books is not a bound on the sweep.
 *
 * Never throws: an unreadable directory contributes nothing and lets the rest of
 * the tree proceed. A reclaim that aborts the boot it runs on is worse than one
 * that reclaims less.
 */
export async function reclaimSidecarsInDir(
  dir: string,
  remaining: { left: number },
): Promise<SidecarReclaimResult> {
  const out = emptyResult();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Absent (a book with no reports yet) or unreadable — nothing to reclaim.
    return out;
  }

  const plan = planSidecarReclaim(entries);
  out.orphansKept = plan.orphans.length;
  out.orphanPaths = plan.orphans.map((n) => join(dir, n));

  for (const name of plan.remove) {
    if (remaining.left <= 0) {
      out.budgetExhausted = true;
      break;
    }
    try {
      await unlink(join(dir, name));
      out.removed += 1;
      remaining.left -= 1;
    } catch {
      // Raced away, or permissions. Not worth failing a boot over; the next
      // sweep sees it again because there is no marker file.
      out.errors += 1;
    }
  }
  return out;
}

/**
 * The directories a sweep visits under one report ROOT: the root itself (where
 * pre-TRA-244 legacy files live) plus its immediate subdirectories (the
 * `demo/` / `live/` / `sandbox/` mode buckets).
 *
 * Depth 1 on purpose rather than a recursive walk. It covers every layout that
 * has ever held a sidecar, and it stops the sweep from descending into
 * `<mode>/tape/` and the other nested artifact directories — a delete path
 * should visit a listed set of places, not everything below a root.
 */
async function reportDirsUnder(root: string): Promise<string[]> {
  const dirs = [root];
  try {
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (item.isDirectory()) dirs.push(join(root, item.name));
    }
  } catch {
    // Missing root — `reclaimSidecarsInDir` handles it as a no-op.
  }
  return dirs;
}

/**
 * The report roots for every book directory physically under `users/`.
 *
 * ⚠️ Enumerated from the FILESYSTEM, never from the user registry. The first
 * cut of this sweep built its roots from `getAllUsers()` and it under-reclaimed
 * by more than half: it released 1,242 sidecars on the 2026-08-06T10:34Z boot
 * and left 3,017 behind. The live walk explains why — `users/` holds **251**
 * `trades-stocks.json` files against **62** registered accounts, so roughly
 * three quarters of the book directories on that volume answer to no entry in
 * `users.json`.
 *
 * That gap is not an anomaly to be fixed here; it is the ordinary residue of a
 * fleet that went 28 -> 56 -> 62 while trees for departed accounts stayed on
 * disk. It is also exactly the trap TRA-2410 documents from the other side: a
 * book whose registry entry is gone is invisible to any `getAllUsers()` check,
 * and it is the most likely shape for a stale tree on this host.
 *
 * The inodes are held by the DIRECTORY, not by the account, so the reclaim has
 * to be denominated in directories. A registry-driven sweep silently scopes
 * itself to the shrinking half of the problem while reporting a clean run — the
 * same class of false-green as bounding backups by generation count.
 */
export async function bookReportRoots(usersRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let books: Array<{ name: string; isDirectory(): boolean }>;
  try {
    books = await readdir(usersRoot, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const book of books) {
    if (!book.isDirectory()) continue;
    roots.push(join(usersRoot, book.name, 'reports'));
    roots.push(join(usersRoot, book.name, 'crypto-reports'));
  }
  return roots;
}

/**
 * Sweep every report root given (a book's `reports/` and `crypto-reports/`),
 * sharing one unlink budget across all of them.
 */
export async function reclaimReportSidecars(
  roots: readonly string[],
  maxUnlinks: number = reportSidecarMaxUnlinks(),
): Promise<SidecarReclaimResult> {
  const remaining = { left: maxUnlinks };
  const out = emptyResult();
  for (const root of roots) {
    for (const dir of await reportDirsUnder(root)) {
      const r = await reclaimSidecarsInDir(dir, remaining);
      out.removed += r.removed;
      out.orphansKept += r.orphansKept;
      out.orphanPaths.push(...r.orphanPaths);
      out.errors += r.errors;
      if (r.budgetExhausted) out.budgetExhausted = true;
    }
  }
  if (out.removed > 0 || out.budgetExhausted) {
    // Logged at warn when the budget bound it: a PARTIAL reclaim reported as a
    // complete one is how a bound gets believed without holding.
    const line = 'reclaimed write-only report .md sidecars (TRA-3064)';
    const fields = {
      removed: out.removed,
      orphansKept: out.orphansKept,
      errors: out.errors,
      budgetExhausted: out.budgetExhausted,
      maxUnlinks,
    };
    if (out.budgetExhausted) log.warn(`${line} — PARTIAL, unlink budget exhausted`, fields);
    else log.info(line, fields);
  }
  if (out.orphanPaths.length > 0) {
    // An orphan means a `.md` whose bytes are NOT recoverable from a sibling
    // JSON. Nothing in this codebase can produce one, so if any appear they are
    // evidence of a workflow nobody has written down — name them.
    log.warn('report .md sidecars kept — no .json sibling to recover them from (TRA-3064)', {
      count: out.orphanPaths.length,
      paths: out.orphanPaths.slice(0, 20),
    });
  }
  return out;
}
