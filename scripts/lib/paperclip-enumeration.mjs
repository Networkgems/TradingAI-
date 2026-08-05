/**
 * Shared, paranoid enumeration of the Paperclip issue list.
 *
 * Extracted verbatim from `scripts/check-blocked-empty.mjs` (TRA-2364) when a
 * second detector (`check-phantom-rest.mjs`, TRA-2422) needed the same guard.
 * It is a LIBRARY and nothing else: importing it must never perform I/O, which
 * is exactly why it could not stay in the detector — that file calls `main()`
 * at module scope, so `import`ing it would have run a full live sweep and then
 * `process.exit()`ed the importer.
 *
 * ⛔ THE SILENT READ THIS EXISTS TO SURVIVE
 * `GET /api/companies/{c}/issues` CAPS AT 1000 ROWS and `offset` DOES paginate.
 * The company has ~2400 issues. One unpaginated call reads 42% of the board and
 * reports a clean bill of health on the half it never looked at.
 *
 * ⛔ Do NOT probe pagination by checking that page 2 is non-empty — an IGNORED
 * `offset` returns a full page too, and that failure mode is REAL on this API:
 * the routines route ignores BOTH `limit` and `offset` (measured 2026-07-26,
 * TRA-2422). We assert the deduped union GREW; a full page that adds zero new
 * ids is an ignored offset and exits BLIND.
 */

/**
 * Page the issue-list route to exhaustion, proving as we go that `offset` is
 * actually honoured.
 *
 * Returns { issues, pages, blind } — `blind` is a REASON STRING, never a
 * boolean, so the caller can print why the population is untrustworthy.
 */
export async function enumerateIssues(getIssuesPage, { limit = 1000, maxPages = 50 } = {}) {
  const byId = new Map();
  const pages = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const rows = await getIssuesPage({ limit, offset });
    if (!Array.isArray(rows)) {
      return { issues: [], pages, blind: `list route returned a non-array at offset=${offset}` };
    }

    const before = byId.size;
    for (const row of rows) if (row && row.id) byId.set(row.id, row);
    const added = byId.size - before;
    pages.push({ offset, returned: rows.length, added });

    // A short page is the honest terminator.
    if (rows.length < limit) return { issues: [...byId.values()], pages, blind: null };

    // A FULL page that adds nothing new means `offset` was ignored and we are
    // re-reading page 0 forever. Emptiness would have been the safe failure;
    // this one looks like data.
    if (added === 0) {
      return {
        issues: [],
        pages,
        blind:
          `list route ignored offset: offset=${offset} returned a full page of ${rows.length} ` +
          `rows and added 0 new ids. The population cannot be enumerated through this route.`,
      };
    }
  }

  // Hit the page cap with full pages still coming. Say so — do not truncate in
  // silence and report a count computed off a partial board.
  return {
    issues: [],
    pages,
    blind: `page cap (${maxPages}) reached with full pages still returning; enumeration is truncated`,
  };
}

/* ------------------------------------------------------------------ *
 * Routines
 *
 * Moved here from `check-phantom-rest.mjs` (TRA-2422) when a THIRD detector
 * (`check-routine-dispatch.mjs`, TRA-2331) needed the same guard. It has to
 * live in the library for the reason at the top of this file: importing the
 * detector would run its `main()` and `process.exit()` the importer.
 * ------------------------------------------------------------------ */

/** Counts that are indistinguishable from a silent server-side cap. */
export const ROUND_CAPS = new Set([25, 50, 100, 200, 250, 500, 1000, 2000]);

/**
 * The routines route ignores `limit` AND `offset` (measured 2026-07-26), so it
 * cannot be paged and exhaustiveness cannot be proved the way the issue list
 * proves it. What we CAN do is refuse the two readings that would be
 * indistinguishable from a truncated one:
 *
 *   - an EMPTY list. A company with no routines and a route that returned
 *     nothing render identically, and the empty reading turns every leaf on the
 *     board into a finding.
 *   - a count that is exactly a round cap. 143 is not a cap; 250 is.
 *
 * and one positive check: read it twice at DIFFERENT limits. If the smaller
 * read comes back shorter, the route honours `limit` after all — in which case
 * the larger read may itself have been truncated by the server and we say so
 * rather than guessing.
 */
export async function enumerateRoutines(getRoutines, { limit = 500 } = {}) {
  const big = await getRoutines({ limit, offset: 0 });
  if (!Array.isArray(big)) return { routines: [], blind: 'routines route returned a non-array' };
  if (big.length === 0) {
    return { routines: [], blind: 'routines route returned 0 rows — a company with no routines and an unread route are the same reading, and the empty one flags every leaf' };
  }
  if (ROUND_CAPS.has(big.length)) {
    return { routines: [], blind: `routines route returned exactly ${big.length} rows — indistinguishable from a silent cap at ${big.length}` };
  }

  const probeLimit = Math.max(1, Math.floor(big.length / 2));
  const small = await getRoutines({ limit: probeLimit, offset: 0 });
  if (!Array.isArray(small)) return { routines: [], blind: 'routines route returned a non-array on the limit probe' };
  if (small.length < big.length) {
    return {
      routines: [],
      blind:
        `routines route HONOURS limit (limit=${probeLimit} returned ${small.length} of ${big.length}) — it did not on ` +
        `2026-07-26, so paging semantics have changed and the limit=${limit} read may itself be truncated. ` +
        'Re-derive the enumeration before trusting a count.',
    };
  }

  return { routines: big, blind: null, probe: { limit, probeLimit, big: big.length, small: small.length } };
}
