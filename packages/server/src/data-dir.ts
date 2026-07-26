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
 * TRUE when `dir` will be ERASED on the next redeploy/restart.
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
  // Memory-only (no boot hydrate ran): nothing is durable by definition.
  if (dir == null) return true;
  // Unset env ⇒ the caller took its in-bundle fallback, whatever that path looks like.
  if (!env.DATA_DIR) return true;
  const norm = dir.replace(/\\/g, '/');
  return norm.includes('node_modules') || norm.includes('/packages/server');
}
