// TRA-1681 — one predicate for "is this DATA_DIR actually durable?".
//
// A LEAF module on purpose: it imports nothing from this package, so any store that
// needs to publish its own durability can depend on it without risking the
// barrel/cycle shape that fused 59 modules into one SCC (TRA-1684).
//
// TRA-2421 — `resolveDataDir` moved here from `trade-store.ts` for exactly that
// reason. `deleted-accounts.ts` needs the resolved root, and `trade-store.ts` needs
// to ask `deleted-accounts.ts` whether an account was destroyed before restoring it
// from a backup; leaving the resolver in `trade-store` made those two modules a
// cycle. Copying it would have been worse — two copies of a path predicate drift,
// and the copy that drifts is the one someone is trusting (the TRA-1681 lesson that
// created this file). `trade-store` re-exports it, so every existing importer is
// unchanged.
//
// The predicate itself is not new — `checkDataDirHealth()` (trade-store, TRA-140) has
// computed it since forever. What was missing is that it only ever reached a LOG LINE.
// bqb1 exposes no log surface to a grader (no TRADING_ADMIN_*; only public
// `/api/health/*`), so the one fact that invalidates every durable counter on the box
// was, in practice, unreadable. Lifting it here lets a store put it in its payload.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * TRA-522 — resolve the on-disk persistence root.
 *
 * Root cause of the silent demo-book swap on restart: this path was only ever
 * pinned to `process.env.DATA_DIR`, and the fallback anchors to the *module's*
 * location (`<repo>/packages/server/data`). On the self-hosted host two repos
 * exist (`_default/tradingai_repo` and a sibling `~/TradingAI`), each with its
 * own `packages/server/data`. A PM2 restart launched from a different repo /
 * ecosystem file therefore loaded a *different* book — that is how the demo
 * account flipped from $1,000 (live book) to $26,397 (stale sibling book).
 *
 * The contract this helper guarantees:
 *   1. When `DATA_DIR` is set, it wins verbatim — the canonical, launch-cwd /
 *      repo-independent location ops point every instance at (see
 *      `ops/bootstrap-trading-server.sh` and `docs/runbook.md` §1).
 *   2. The fallback is anchored to `moduleDir`, never to `process.cwd()`, so
 *      the resolved path does not move just because PM2 was started from a
 *      different working directory.
 *
 * `ecosystem.config.cjs` now sets `DATA_DIR` explicitly so the canonical
 * production launch path always takes branch (1); the fallback only applies to
 * ad-hoc / dev runs.
 *
 * TRA-2421 — the `moduleDir` default is this file's directory, which is the same
 * `packages/server/src` that `trade-store.ts` resolved against before the move, so
 * branch (2) resolves to the identical path.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = __dirname,
): string {
  const fromEnv = env.DATA_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return join(moduleDir, '..', 'data');
}

/**
 * TRA-4896 — the path substrings that mark a directory as NOT durable, each with the
 * reason it is not, because the two classes have different remedies.
 *
 * `in_build_bundle` is erased by the next *redeploy* (the bytes ship with the build).
 * `in_ephemeral_scratch_tree` is erased by the next *re-stage* of an agent scratch
 * tree, which is a separate event that no deploy record mentions.
 *
 * Exported so the marker list is greppable and testable in one place rather than
 * re-spelled at each call site — the copy-drifts lesson that created this module.
 */
export const EPHEMERAL_PATH_MARKERS: ReadonlyArray<{
  marker: string;
  reason: 'in_build_bundle' | 'in_ephemeral_scratch_tree';
}> = [
  { marker: 'node_modules', reason: 'in_build_bundle' },
  { marker: '/packages/server', reason: 'in_build_bundle' },
  // TRA-4896 — the Paperclip per-project scratch tree
  // (`~/.paperclip/instances/<inst>/projects/<company>/<project>/_default/...`) and the
  // per-agent workspace tree beside it are RE-STAGEABLE BY DESIGN: the harness may
  // replace the checkout wholesale between runs, and TRA-4851 already had to defend the
  // PM2 boot path against exactly that property. A data dir anywhere under
  // `.paperclip/instances/` is therefore ephemeral REGARDLESS of how durable the
  // underlying volume is, and — crucially — regardless of whether the path also happens
  // to contain `/packages/server`. Without this marker the obvious "fix" for TRA-4896
  // (point DATA_DIR at `<project>/_default/data`, one level up out of the bundle) would
  // clear the violation while changing nothing about what erases the bytes.
  { marker: '/.paperclip/instances/', reason: 'in_ephemeral_scratch_tree' },
];

/** Why a data dir is not durable, or `null` when it is. */
export type EphemeralDataDirReason =
  | 'memory_only'
  | 'data_dir_unset'
  | 'in_build_bundle'
  | 'in_ephemeral_scratch_tree'
  | null;

/** Why `dir` is not durable, or `null` when it is. See `isEphemeralDataDir`. */
export function ephemeralDataDirReason(
  dir: string | null,
  env: NodeJS.ProcessEnv = process.env,
): EphemeralDataDirReason {
  // Memory-only (no boot hydrate ran): nothing is durable by definition.
  if (dir == null) return 'memory_only';
  // Unset env ⇒ the caller took its in-bundle fallback, whatever that path looks like.
  if (!env.DATA_DIR) return 'data_dir_unset';
  const norm = dir.replace(/\\/g, '/');
  for (const { marker, reason } of EPHEMERAL_PATH_MARKERS) {
    if (norm.includes(marker)) return reason;
  }
  return null;
}

/**
 * TRUE when `dir` will be ERASED on the next redeploy/restart/re-stage.
 *
 * Two ways to be ephemeral, and the first is the one that bites: `DATA_DIR` unset means
 * the caller fell back to a path inside the build bundle (`index.ts` does
 * `process.env.DATA_DIR ?? join(__dirname, '..', 'data')`). That fallback is a real,
 * writable directory — `mkdirSync` succeeds, `appendFileSync` succeeds, the read-back
 * succeeds — so **every IO-level check passes and the data still evaporates on redeploy**.
 * There is no error to catch. The only way to know is to look at the PATH.
 */
export function isEphemeralDataDir(
  dir: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ephemeralDataDirReason(dir, env) !== null;
}
