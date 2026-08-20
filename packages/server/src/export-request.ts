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

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3883 — the strict parse above stopped at the EXACT SPELLING, and both
// edges of that scope were still reachable on live bytes.
//
// ## R1 — the key refusal was case-SENSITIVE, so one capital letter restored it
//
// `?format=json&from=2026-08-18&to=2026-08-18&markets=options` plus:
//
//   mode=demo   (enumerated)          → 400  unrecognized query parameter 'mode'
//   Mode=demo   (one capital)         → 200, 2 rows, BOTH mode: "live"   ← the trap
//   MODES=demo  (the REAL key, caps)  → 200, 2 rows, BOTH mode: "live"   ← the trap
//
// The two ends of the TRA-3874 fix composed into the hole between them: the
// confusable check did `hasOwnProperty` over a lowercase map, so `Mode` was
// invisible to it; the parse read `query['modes']` literally, so `MODES` was an
// ABSENT key — and an absent key is the one input still allowed to mean
// "everything". That is the parent's headline sentence verbatim on the deployed
// remedy: the caller asked for demo and was handed two live real-money rows
// under a 200.
//
// So the key lookup is CASE-FOLDED (never a longer enumeration of variants —
// `Mode`/`MODE`/`mOdE` is an infinite list), and a case-variant of a REAL
// parameter is refused too. That second half is the more confusing one: there
// IS a working parameter by that name and the caller believes they used it.
// `MODES=demo` must not be silently ignored, and honouring it would make the
// route's own accepted-spelling table a lie.
//
// ## R2 — an unparseable `from` was DROPPED, and the drop defeated TRA-3860
//
// `?format=json&to=2026-08-18&markets=options&modes=live` plus:
//
//   from=2026-01-01  (real date, below the journal floor) → 400  "earlier than
//                                                                 this export can
//                                                                 attest to"
//   from=2026-31-01  (same intent, unparseable)           → 200, 15 rows
//   from=18-08-2026  (EU-format typo)                     → 200, 15 rows
//   from=2026-08-18  (the window actually meant)          → 200, 2 rows
//
// The sharp part is not the widening, it is that a request REFUSED when spelled
// correctly is SERVED when misspelled. `parseExportBoundary` returned
// `undefined` on anything it could not parse and `undefined` means "no floor" —
// the same overloaded empty the parent fixed for `modes`/`markets`, one field
// over. The typo does not merely widen; it walks straight through the range
// guard.
//
// The asymmetry the parent ruled on is PRESERVED: an ABSENT `from`/`to` still
// legally means "no bound". Only a key the caller put there on purpose and this
// route cannot use is refused.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Every query parameter this route reads, in its ONE accepted spelling. This is
 * both the `accepted` list published in a refusal and the set a case-variant is
 * measured against, so the message a caller is given and the rule they are held
 * to cannot drift apart.
 */
export const EXPORT_QUERY_PARAMETERS: readonly string[] = [
  'format',
  'modes',
  'markets',
  'from',
  'to',
];

/**
 * Refuse a request whose query key this route will not guess at.
 *
 * Two classes, both refused with one 400:
 *
 *  1. A known-confusable key (`mode`, `market`, `book`, `username`) — a spelling
 *     that maps onto a parameter that works, or onto nothing at all.
 *  2. A case-variant of a REAL parameter (`MODES`, `Markets`, `From`, `Format`).
 *     Refusing rather than honouring is the parent's verb, and it cannot serve a
 *     row nobody asked for. Silently ignoring it is the defect (TRA-3883 R1).
 *
 * BOTH lookups are CASE-FOLDED, so `Mode`, `MODE` and `mOdE` are the same
 * offender. Enumerating the variants instead would be an infinite list, and the
 * one variant left out is the one that serves live rows to a caller who asked
 * for demo.
 *
 * An unknown-but-harmless key (a cache buster, a tracing id) still passes:
 * refusing every unrecognized parameter would break callers over keys that never
 * meant anything here.
 *
 * ALL offending keys are named in one refusal, not just the first. The parent's
 * own worst row was `?market=options&mode=demo` — two confusables at once — and a
 * first-one-wins message would have sent the caller round the loop twice, with
 * the intermediate request (`markets=options&mode=demo`) being the one that
 * served two live real-money rows to someone who asked for demo.
 *
 * Order is the CONFUSABLE set then `EXPORT_QUERY_PARAMETERS`, never the order the
 * caller happened to write the keys in, so `parameter` and `rejected` are stable
 * across two spellings of the same request.
 */
export function checkExportQueryKeys(
  query: Record<string, unknown>,
): { ok: true } | { ok: false; refusal: FilterRefusal } {
  // Case-folded index of what the caller ACTUALLY sent. A key can appear under
  // several spellings at once (`?Mode=demo&MODE=live`), and every one of them is
  // named — a refusal that reported only the first would leave the caller
  // deleting one capital letter and hitting the same 400 again.
  const spellingsByLowerKey = new Map<string, string[]>();
  for (const key of Object.keys(query)) {
    const lower = key.toLowerCase();
    const seen = spellingsByLowerKey.get(lower);
    if (seen) seen.push(key);
    else spellingsByLowerKey.set(lower, [key]);
  }

  const offenders: { key: string; hint: string }[] = [];
  for (const [lower, hint] of CONFUSABLE_EXPORT_KEYS) {
    for (const spelling of spellingsByLowerKey.get(lower) ?? []) offenders.push({ key: spelling, hint });
  }
  for (const canonical of EXPORT_QUERY_PARAMETERS) {
    for (const spelling of spellingsByLowerKey.get(canonical.toLowerCase()) ?? []) {
      if (spelling === canonical) continue;
      offenders.push({
        key: spelling,
        hint:
          `query parameters here are case-SENSITIVE; \`${canonical}\` is a real parameter of this `
          + `route but \`${spelling}\` is not the same key, and it was IGNORED rather than applied. `
          + `Spell it \`${canonical}\`.`,
      });
    }
  }
  if (offenders.length === 0) return { ok: true };

  const keys = offenders.map(o => o.key);
  const named = keys.map(k => `\`${k}\``).join(', ');
  const hints = offenders.map(o => `\`${o.key}\`: ${o.hint}`).join(' ');
  return {
    ok: false,
    refusal: {
      error:
        keys.length === 1
          ? `unrecognized query parameter '${keys[0]}'`
          : `unrecognized query parameters: ${keys.map(k => `'${k}'`).join(', ')}`,
      detail:
        `${named} ${keys.length === 1 ? 'is not a parameter' : 'are not parameters'} of `
        + `/api/trades/export. ${hints} `
        + 'It refuses rather than ignoring the parameter, because an ignored filter '
        + 'serves the FULL population (including live real-money rows) under a 200 that '
        + 'is indistinguishable from a filter that worked (TRA-3874/TRA-3883).',
      /** The first offender, for callers that key off a single field. */
      parameter: keys[0]!,
      rejected: keys,
      accepted: [...EXPORT_QUERY_PARAMETERS],
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

/** Largest epoch-ms a `Date` can represent; anything beyond is an Invalid Date. */
const MAX_TIME_MS = 8.64e15;

/**
 * The boundary spellings named in a refusal. Deliberately short: this is the set
 * a caller should REACH FOR, not the set that parses. `Date.parse` also accepts
 * `2026/08/18`, `08-18-2026`, `Aug 18 2026` and `2026-8-18`, and TRA-3883 AC3
 * pins those as still-resolving controls — the point of this change is to refuse
 * what CANNOT be read, not to tighten what can.
 */
export const EXPORT_BOUNDARY_FORMATS: readonly string[] = [
  'YYYY-MM-DD (e.g. 2026-08-18)',
  'an ISO-8601 timestamp (e.g. 2026-08-18T13:30:00Z)',
  'epoch milliseconds (e.g. 1755475200000)',
];

export type BoundaryParse =
  | { ok: true; value: number | undefined }
  | { ok: false; refusal: FilterRefusal };

/**
 * TRA-3883 R2 — parse a `from`/`to` boundary as epoch-ms, STRICTLY.
 *
 * - Absent key      → `{ ok: true, value: undefined }` — "no bound". This is the
 *                     parent's ruling and the ONE input still allowed to widen.
 * - Present + blank → refused. `?from=` is a bound the caller put there on purpose.
 * - Repeated key    → refused. Express hands the route `string[]`.
 * - Unparseable     → refused, naming the token and the accepted formats. It used
 *                     to return `undefined`, i.e. "no floor" — so `from=2026-31-01`
 *                     was SERVED the full 15-row population while the correctly
 *                     spelled `from=2026-01-01` was REFUSED by TRA-3860's range
 *                     guard. The typo defeated the guard.
 *
 * A date-only `to` is widened to the end of that UTC day, so the upper bound is
 * inclusive of trades closed any time that day. Pure: no clock, no I/O.
 */
export function parseExportBoundary(raw: unknown, parameter: 'from' | 'to'): BoundaryParse {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };

  const refuse = (error: string, detail: string, rejected: string[]): BoundaryParse => ({
    ok: false,
    refusal: {
      error,
      detail:
        `${detail} It refuses rather than dropping the value, because a dropped bound leaves `
        + `\`${parameter}\` UNSET, which this route reads as NO BOUND — so a request that is `
        + 'REFUSED when spelled correctly (TRA-3860: "earlier than this export can attest to") '
        + 'would instead be SERVED the full population, including live real-money rows, under a '
        + '200 (TRA-3883).',
      parameter,
      rejected,
      accepted: [...EXPORT_BOUNDARY_FORMATS],
    },
  });

  if (Array.isArray(raw)) {
    return refuse(
      `${parameter} was supplied more than once`,
      `\`${parameter}\` must appear exactly once.`,
      raw.map(v => String(v)),
    );
  }

  if (typeof raw !== 'string') {
    return refuse(
      `${parameter} must be a date string`,
      `\`${parameter}\` was received as ${typeof raw}, which this route cannot interpret.`,
      [],
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return refuse(
      `${parameter} was provided but names no value`,
      `\`${parameter}\` is present and empty. OMIT the parameter to leave that bound open; `
      + 'an empty value is not a way to say "unbounded".',
      [],
    );
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_TIME_MS) {
      return refuse(
        `unusable ${parameter} value: '${raw}'`,
        `\`${parameter}\` looks like epoch milliseconds but is outside the representable range.`,
        [trimmed],
      );
    }
    return { ok: true, value: n };
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return refuse(
      `unrecognized ${parameter} value: '${raw}'`,
      `\`${parameter}\` accepts ${EXPORT_BOUNDARY_FORMATS.join(', ')}. `
      + `Received '${raw}', which is not a date this route can read.`,
      [trimmed],
    );
  }

  // Date-only end boundary → end of the UTC day (inclusive).
  if (parameter === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: true, value: ms + 86_400_000 - 1 };
  }
  return { ok: true, value: ms };
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
