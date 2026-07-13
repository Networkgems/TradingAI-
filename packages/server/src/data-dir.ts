// TRA-1681 — one predicate for "is this DATA_DIR actually durable?".
//
// A LEAF module on purpose: it imports nothing, so any store that needs to publish
// its own durability can depend on it without risking the barrel/cycle shape that
// fused 59 modules into one SCC (TRA-1684).
//
// The predicate itself is not new — `checkDataDirHealth()` (trade-store, TRA-140) has
// computed it since forever. What was missing is that it only ever reached a LOG LINE.
// bqb1 exposes no log surface to a grader (no TRADING_ADMIN_*; only public
// `/api/health/*`), so the one fact that invalidates every durable counter on the box
// was, in practice, unreadable. Lifting it here lets a store put it in its payload.

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
