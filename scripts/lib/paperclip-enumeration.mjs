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
