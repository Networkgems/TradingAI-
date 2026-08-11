// TRA-3216 (parent TRA-2760) — the LIVE OTM UNDERLYING ALLOWLIST.
//
// ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
// `runOtmScan(activeSymbols)` is handed `getActiveSymbols()` — the FULL watchlist
// (~614 names on bqb1) — and there was no live universe restriction anywhere in
// the path. Every quality guard downstream is a per-candidate filter; none of
// them is a universe. So the real-money OTM sleeve was free to open on whatever
// name happened to screen cheapest, and on 2026-08-06..10 it did exactly that:
// the three post-cost-bar live opens were KVYO, TROW and ABCL. Real money went
// into thin names because nothing stopped it.
//
// The board's back/forward-tested live set is AAPL, SPY, QQQ, PLTR, TSLA — the
// only live names with the liquidity this sleeve needs. The mid→fill haircut runs
// −25% / −33% on sub-$0.10 contracts (TRA-2536) and round-trip commission is
// $0.227/contract, so a name whose contracts are cheap AND thin loses the modeled
// edge twice before the thesis gets a vote.
//
// ── CONTRACT ─────────────────────────────────────────────────────────────────
//   • TIGHTENING-ONLY. It can only REMOVE live opens, never add one, so it is
//     TRA-1897-HOLD-safe.
//   • Applied at the `mode === 'live'` branch only. Demo is byte-for-byte
//     unchanged — demo is the graded book and its universe is deliberately wide.
//   • RESTRICTIVE BY DEFAULT, and every failure direction lands on the
//     restrictive side. An unset var, a malformed var, a var that parses to zero
//     symbols — all resolve to the five-name default. The ONLY way to run the
//     614-name universe live is to set the value to an explicit `*`, which is
//     visible as a raw string on `/api/health/live-enforce-gates`. A typo can
//     never silently re-open the universe (contrast the fail-OPEN default that a
//     bare `symbols.length === 0 ⇒ allow everything` parse would have given).
//   • Read from the PROCESS env only — a live-order toggle, never the demo-flags
//     file override, and NOT on the demo-flag allowlist.
//
// ── WHY THE REJECTS ARE COUNTED (and this module does not do the counting) ────
// A scanner-level filter whose rejects are invisible is indistinguishable from an
// inert one — the same reason TRA-2763 built the δ-floor per-candidate rather
// than by pre-filtering the symbol list. This module is PURE resolution; the call
// site records every armed verdict (admitted AND blocked) to
// `live-enforce-gate-ledger.ts` under gate `universe`, keyed by symbol and
// stamped with the BOOK, so the payload answers "which live books did this
// actually govern" and not merely "some process has a list".

/** Operator override for the live OTM underlying allowlist. Comma/space separated. */
export const OPTION_LIVE_OTM_UNIVERSE_VAR = 'OPTION_LIVE_OTM_UNIVERSE';

/**
 * The shipped live universe (board's back/forward-tested set, TRA-3216). This is
 * the value an UNSET, malformed or empty override resolves to — deliberately the
 * restrictive end, so no env accident widens what real money can buy.
 */
export const OPTION_LIVE_OTM_UNIVERSE_DEFAULT: readonly string[] = ['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA'];

/**
 * The one value that turns the restriction OFF (also accepts `ALL`). Spelled as
 * an explicit sentinel rather than "empty means everything" so that removing the
 * restriction is an affirmative, auditable ops act that shows up verbatim in
 * `raw` on the health route.
 */
export const OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED = '*';

/**
 * Where the resolved list came from — the discriminator between "an operator
 * chose this" and "we fell back". `env_invalid` is NOT the same reading as
 * `default`: both yield the five names, but the first means someone set a value
 * that did not parse and believes something else is in force.
 */
export type LiveOtmUniverseSource = 'default' | 'env' | 'env_unrestricted' | 'env_invalid';

export interface LiveOtmUniverseResolution {
  /** Resolved allowlist, uppercased / deduped / order-preserved. EMPTY iff `restricted` is false. */
  symbols: string[];
  /** FALSE only for the explicit `*` / `ALL` sentinel. Every other outcome restricts. */
  restricted: boolean;
  source: LiveOtmUniverseSource;
  /** The RAW env value, so a typo that fell back to the default is visible rather than inferred. */
  raw: string | null;
}

/** Split on commas and/or whitespace, uppercase, trim, drop empties, dedupe (order preserved). */
function parseSymbolList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\s,;]+/)) {
    const sym = piece.trim().toUpperCase();
    if (sym === '') continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

/**
 * Resolve the live OTM underlying allowlist from the process env.
 *
 * Fail direction is RESTRICTIVE in every branch: only a literal `*` / `ALL`
 * unrestricts, and anything unparseable falls back to
 * {@link OPTION_LIVE_OTM_UNIVERSE_DEFAULT} rather than to "no filter". Pure — the
 * env is an argument so this is unit-testable without mutating `process.env`.
 */
export function resolveLiveOtmUniverse(env: NodeJS.ProcessEnv = process.env): LiveOtmUniverseResolution {
  const rawValue = env[OPTION_LIVE_OTM_UNIVERSE_VAR];
  const raw = typeof rawValue === 'string' ? rawValue : null;

  if (raw === null || raw.trim() === '') {
    return { symbols: [...OPTION_LIVE_OTM_UNIVERSE_DEFAULT], restricted: true, source: 'default', raw };
  }

  const trimmed = raw.trim().toUpperCase();
  if (trimmed === OPTION_LIVE_OTM_UNIVERSE_UNRESTRICTED || trimmed === 'ALL') {
    return { symbols: [], restricted: false, source: 'env_unrestricted', raw };
  }

  const parsed = parseSymbolList(raw);
  if (parsed.length === 0) {
    // Set, non-empty, but nothing survived the parse (e.g. ",,,"). Do NOT read
    // that as "allow everything" — fall back to the shipped restriction.
    return { symbols: [...OPTION_LIVE_OTM_UNIVERSE_DEFAULT], restricted: true, source: 'env_invalid', raw };
  }
  return { symbols: parsed, restricted: true, source: 'env', raw };
}

/**
 * True iff `symbol` may be opened live under `resolution`. An unrestricted
 * resolution admits everything; a restricted one admits only exact (uppercased)
 * membership. A blank/absent symbol NEVER passes a restricted universe — it
 * cannot prove membership, so it fails closed, matching the δ-floor's
 * no-usable-delta branch.
 */
export function isSymbolInLiveOtmUniverse(symbol: string | null | undefined, resolution: LiveOtmUniverseResolution): boolean {
  if (!resolution.restricted) return true;
  if (typeof symbol !== 'string') return false;
  const sym = symbol.trim().toUpperCase();
  if (sym === '') return false;
  return resolution.symbols.includes(sym);
}
