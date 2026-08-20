import type { AccountMode } from '@trading-app/shared';
import type { ExportFiltersRequested, ExportMarket } from './export.js';
import { ALL_EXPORT_MARKETS, ALL_EXPORT_MODES } from './export-history.js';

export type { ExportFiltersRequested };

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3874 — `/api/trades/export` silently widened `modes` / `markets` to
// EVERYTHING on an input a reader could not tell apart from a working filter.
//
// ## The defect, as measured on bqb1 build `08d61468f4d9`
//
// Six requests, all `from=2026-08-18&to=2026-08-18`, book `admin`:
//
//   markets=options&modes=live    → 200, 2 rows, filters.modes ["live"]  (control)
//   markets=options&modes=demo    → 200, 0 rows, filters.modes ["demo"]  (negative control)
//   markets=options&mode=demo     → 200, 2 LIVE rows, filters.modes []   ← trap: singular KEY
//   markets=options&modes=bogus   → 200, 2 LIVE rows, filters.modes []   ← trap: bad VALUE
//   markets=options               → 200, 2 rows,      filters.modes []   (no filter — correct)
//
// The negative control is what makes it a finding rather than a coincidence:
// `modes=demo` correctly returns 0, so the filter works when spelled right.
// `mode=demo` returned two real-money rows from the same route in the same
// second. The caller asked for demo and was handed live.
//
// ## The cause is an OVERLOADED EMPTY, not a missing alias
//
// The old parse was `parseCsvParam(query['modes']).filter(isValidMode)`:
// unrecognized tokens were DROPPED, and `applyFilters` reads an empty array as
// "no filter". So every way of failing to name a valid token — a typo, a renamed
// mode, a repeated `?modes=a&modes=b` (Express hands the route an ARRAY, which
// `parseCsvParam` rejects wholesale) — collapses onto the one value that means
// the opposite of filtering. Fixing only the `mode`→`modes` alias would have left
// `modes=bogus` widening exactly as before.
//
// Note on two examples in the filing that do NOT reproduce: `modes=Live` and
// `modes=live,demo ` (trailing space) both already worked, because the CSV parse
// trims and lower-cases each token before validating. The general point stands —
// any token outside the accepted set widens — but the case-folding and trimming
// were never the hole.
//
// ## Why this route, and why a 400
//
// Since TRA-3860 this route serves the DURABLE option-trade journal back to
// 2026-07-30 rather than a same-day scrap that expired at the 21:00 ET archive.
// It is the surface a human reconciles against a broker statement. TRA-3860 set
// the verb for this exact route one layer over: an unservable request is a `400`
// naming the limit, never a plausible `200`. An unrecognized filter token is the
// same shape — a request the route cannot honour — so it gets the same answer.
//
// Everything here is pure: no clock, no file, no network.
// ─────────────────────────────────────────────────────────────────────────────

/** The refusal body for a filter parameter this route will not guess at. */
export interface FilterRefusal {
  error: string;
  detail: string;
  /** The query parameter at fault, exactly as spelled by the caller. */
  parameter: string;
  /**
   * The tokens that could not be understood, as received (pre-normalisation, so
   * the caller can find them in their own URL). Empty for a key-level refusal.
   */
  rejected: string[];
  /** The full accepted set for `parameter`, so the message is self-servicing. */
  accepted: string[];
}

export type FilterParse<T extends string> =
  | { ok: true; values: T[] }
  | { ok: false; refusal: FilterRefusal };

/**
 * The singular / alternate spellings that are silently ignored by this route and
 * are confusable with a parameter that works. Express cannot tell a route that a
 * query key is a typo, so the known-confusable set is enumerated by hand.
 *
 * `mode` / `market` map onto a real plural parameter. `book` / `username` map
 * onto NOTHING: the export is always scoped to the authenticated user, so a
 * caller who passes one is asking for a book they will not get — the identical
 * failure shape, one field over. All four were observed silently ignored here and
 * on `/api/health/option-journal`.
 *
 * Extending this list is deliberately cheap; every entry is one more request that
 * refuses instead of answering something other than what was asked.
 */
export const CONFUSABLE_EXPORT_KEYS: ReadonlyMap<string, string> = new Map([
  ['mode', "did you mean `modes` (comma-separated, e.g. `modes=demo`)?"],
  ['market', "did you mean `markets` (comma-separated, e.g. `markets=options`)?"],
  [
    'book',
    'this route always exports the AUTHENTICATED book; there is no `book` selector. '
    + 'Authenticate as that user instead.',
  ],
  [
    'username',
    'this route always exports the AUTHENTICATED book; there is no `username` selector. '
    + 'Authenticate as that user instead.',
  ],
]);

/**
 * Refuse a request carrying a known-confusable query key.
 *
 * Only the enumerated set is rejected — an unknown-but-harmless key (a cache
 * buster, a tracing id) still passes, because refusing every unrecognized
 * parameter would break callers over keys that never meant anything here.
 *
 * ALL offending keys are named in one refusal, not just the first. The filing's
 * own worst row was `?market=options&mode=demo` — two confusables at once — and a
 * first-one-wins message would have sent the caller round the loop twice, with
 * the intermediate request (`markets=options&mode=demo`) being the one that
 * served two live real-money rows to someone who asked for demo.
 */
export function checkConfusableExportKeys(
  query: Record<string, unknown>,
): { ok: true } | { ok: false; refusal: FilterRefusal } {
  const offenders: string[] = [];
  for (const key of CONFUSABLE_EXPORT_KEYS.keys()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) offenders.push(key);
  }
  if (offenders.length === 0) return { ok: true };

  const named = offenders.map(k => `\`${k}\``).join(', ');
  const hints = offenders.map(k => `\`${k}\`: ${CONFUSABLE_EXPORT_KEYS.get(k)}`).join(' ');
  return {
    ok: false,
    refusal: {
      error:
        offenders.length === 1
          ? `unrecognized query parameter '${offenders[0]}'`
          : `unrecognized query parameters: ${offenders.map(k => `'${k}'`).join(', ')}`,
      detail:
        `${named} ${offenders.length === 1 ? 'is not a parameter' : 'are not parameters'} of `
        + `/api/trades/export. ${hints} `
        + 'It refuses rather than ignoring the parameter, because an ignored filter '
        + 'serves the FULL population (including live real-money rows) under a 200 that '
        + 'is indistinguishable from a filter that worked (TRA-3874).',
      /** The first offender, for callers that key off a single field. */
      parameter: offenders[0]!,
      rejected: offenders,
      accepted: ['format', 'modes', 'markets', 'from', 'to'],
    },
  };
}

/**
 * Parse one comma-separated enum filter STRICTLY.
 *
 * - Absent key      → `{ ok: true, values: [] }` — the honest "no filter", and the
 *                     only input that may still mean "everything".
 * - Present + blank → refused. `?modes=` is a key the caller put there on purpose;
 *                     reading it as "all modes" is the overloaded empty again.
 * - Repeated key    → refused. Express hands the route `string[]`, which the old
 *                     parse dropped wholesale — i.e. it widened.
 * - Unknown token   → refused, naming the token and the accepted set.
 *
 * Tokens are trimmed and lower-cased before matching (so `Options`, ` options `
 * are accepted), then de-duped. Output order follows `accepted`, so the echoed
 * `summary.filters` is stable regardless of how the caller ordered them.
 */
export function parseEnumFilterParam<T extends string>(
  raw: unknown,
  parameter: string,
  accepted: readonly T[],
): FilterParse<T> {
  if (raw === undefined || raw === null) return { ok: true, values: [] };

  const refuse = (error: string, detail: string, rejected: string[]): FilterParse<T> => ({
    ok: false,
    refusal: {
      error,
      detail:
        `${detail} It refuses rather than dropping the token, because a dropped token leaves `
        + `\`${parameter}\` empty, which this route reads as NO FILTER — so the response would `
        + 'serve the full population (including live real-money rows) under a 200 that is '
        + 'indistinguishable from a filter that worked (TRA-3874).',
      parameter,
      rejected,
      accepted: [...accepted],
    },
  });

  if (Array.isArray(raw)) {
    return refuse(
      `${parameter} was supplied more than once`,
      `\`${parameter}\` must appear exactly once, comma-separated `
      + `(e.g. \`${parameter}=${accepted.join(',')}\`), not repeated.`,
      raw.map(v => String(v)),
    );
  }

  if (typeof raw !== 'string') {
    return refuse(
      `${parameter} must be a comma-separated string`,
      `\`${parameter}\` was received as ${typeof raw}, which this route cannot interpret.`,
      [],
    );
  }

  const received = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (received.length === 0) {
    return refuse(
      `${parameter} was provided but names no value`,
      `\`${parameter}\` is present and empty. OMIT the parameter to export all of `
      + `${accepted.join(', ')}; an empty value is not a way to say "all".`,
      [],
    );
  }

  const acceptedLower = new Map(accepted.map(a => [a.toLowerCase(), a]));
  const rejected: string[] = [];
  const chosen = new Set<T>();
  for (const token of received) {
    const hit = acceptedLower.get(token.toLowerCase());
    if (hit === undefined) rejected.push(token);
    else chosen.add(hit);
  }

  if (rejected.length > 0) {
    return refuse(
      `unrecognized ${parameter} value: ${rejected.map(t => `'${t}'`).join(', ')}`,
      `\`${parameter}\` accepts ${accepted.join(', ')}. `
      + `Received ${rejected.map(t => `'${t}'`).join(', ')}.`,
      rejected,
    );
  }

  return { ok: true, values: accepted.filter(a => chosen.has(a)) };
}

/** `modes`, strictly. */
export function parseExportModes(raw: unknown): FilterParse<AccountMode> {
  return parseEnumFilterParam(raw, 'modes', ALL_EXPORT_MODES);
}

/** `markets`, strictly. */
export function parseExportMarkets(raw: unknown): FilterParse<ExportMarket> {
  return parseEnumFilterParam(raw, 'markets', ALL_EXPORT_MARKETS);
}

/**
 * TRA-3874 §3 — which filter parameters the REQUEST actually carried.
 *
 * The echo in `summary.filters` publishes the RESOLVED filter, where `[]` means
 * "everything". With the strict parse above, `[]` can now only be produced by an
 * absent key — a discarded token is a 400 and never reaches a summary. This block
 * says that on the wire anyway, so the document a reader saves as evidence states
 * whether a filter was asked for instead of requiring them to know the rule.
 *
 * The type itself is declared in `export.ts`; see the note there.
 */
export function describeRequestedFilters(query: Record<string, unknown>): ExportFiltersRequested {
  const present = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(query, key) && query[key] !== undefined;
  return {
    modes: present('modes'),
    markets: present('markets'),
    from: present('from'),
    to: present('to'),
  };
}
