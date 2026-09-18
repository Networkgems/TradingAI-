/**
 * TRA-2392 — symbol universe utilities extracted from promotion-gate.
 * Moved to its own leaf so promotion-service can import it without circular dependency
 * (index.ts does `export * from './promotion-gate.js'` so promotion-gate may not import index).
 */

/**
 * TRA-2348 — is universe `a` contained in universe `b`, with `null` read as ⊤?
 *
 * The three edge cases are the whole point, so they are spelled out rather than
 * left to a clever one-liner:
 *   • `b === null` (⊤ container) — everything is a subset. A save moving from
 *     the full catalog to a pinned list is a NARROWING and must never be gated
 *     (TRA-1590 de-escalation).
 *   • `a === null`, `b` a list — ⊤ is NOT contained in any finite list. This is
 *     the widening TRA-2348 exists to catch (canary BTC → `crypto_core`).
 *   • both `null` — ⊤ ⊆ ⊤ is TRUE, so an unrelated edit that HOLDS an
 *     already-unbounded live universe is not mistaken for a widening.
 */
export function isSymbolUniverseSubset(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (b === null) return true;
  if (a === null) return false;
  return a.every(s => b.includes(s));
}
