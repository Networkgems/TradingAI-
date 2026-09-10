import type { AccountMode } from '@trading-app/shared';
import type {
  ExportCoverage,
  ExportCoverageSource,
  ExportEntryPriceBasis,
  ExportFilters,
  ExportJournalPremiumBasis,
  ExportMarket,
  ExportMarketCoverage,
  ExportMoneyRestatement,
  ExportScope,
  ExportTradeRow,
} from './export.js';
import { applyMoneyRestatement, formatHoldDuration, premiumRBasisLabel } from './export.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
// TRA-3930 — the two markers that tell a REPAIR-authored record of a close from
// the engine's own, used to pick which of two records of ONE close is published.
import { TRADIER_IMPORT_STRUCTURE } from './option-trade-journal.js';
import { RECONSTRUCTED_EXIT_REASON } from './tra3485-stale-open-repair.js';

export type {
  ExportCoverage,
  ExportCoverageSource,
  ExportMarketCoverage,
  ExportMoneyRestatement,
  ExportSourceCounts,
} from './export.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3860 — what `/api/trades/export` can actually ATTEST to, and the refusal
// that keeps an unservable range from being answered with `[]`.
//
// ## The defect
//
// The route's three inputs are the in-memory closed-trade buckets. The 21:00 ET
// archive (`archiveClosedTrades()` → `archiveClosedPositions()` /
// `archiveClosedOptions()`, TRA-219) empties all three by design, so the route is
// a SINCE-THE-LAST-ARCHIVE view while its `from`/`to` parameters advertise an
// arbitrary historical date range. A range over 2026-08-18 — a day with two real
// live option closes worth -$393 — came back `200 {"trades": []}`, byte-identical
// to a day that genuinely had no trades. There was no status difference, no
// `truncated` flag and no warning: **the emptiness was readable as an answer**,
// and a human reconciling a broker statement against it would conclude the fills
// never happened.
//
// ## The two halves of the fix, and why it needs both
//
// **1. Serve the history that genuinely exists.** For OPTIONS there is already a
// durable, append-only per-close ledger — the option-trade journal — carrying
// `closeTs`, `exitReason`, `realizedPnlUsd`, `contracts` and the owning
// `account`. Folding its closed rows in makes an archived day readable again.
//
// **2. REFUSE the rest.** There is no equivalent durable per-trade ledger for
// stocks or crypto, so for those markets the archive boundary really is the
// floor. Serving option history while leaving stocks/crypto silently truncated
// would be the exact shape the filing ticket warned against — *"a change that
// makes every range non-empty would pass AC1 and be worse than the bug"*. So an
// explicit `from` that precedes what a requested market can attest to is a
// **`400` naming the limit**, never an empty `200`.
//
// ## The asymmetry that decides the API surface
//
// Only an explicit `from` is refused. An unbounded export (the UI's own button)
// still succeeds — refusing it would break the surface for every caller who
// never asked for history — but every response, refused or served, carries
// {@link ExportCoverage}. So even the unbounded case states the window it speaks
// for, and its emptiness is qualified rather than bare.
//
// Everything here is pure. The route supplies the archive boundary and the
// journal rows; nothing in this module reads a file, a clock or the network.
// ─────────────────────────────────────────────────────────────────────────────

/** Every account mode the export can be asked for. Order is stable for messages. */
export const ALL_EXPORT_MODES: readonly AccountMode[] = ['demo', 'live'] as const;

/** Every market the export can be asked for. Order is stable for messages. */
export const ALL_EXPORT_MARKETS: readonly ExportMarket[] = ['stocks', 'crypto', 'options'] as const;

/**
 * ⚠️ The coverage TYPES (`ExportCoverage`, `ExportMarketCoverage`,
 * `ExportCoverageSource`, `ExportSourceCounts`) live in `export.ts` and are
 * re-exported above. They are declared there rather than here because
 * `ExportSummary` carries them on the wire and this module imports
 * `formatHoldDuration` as a VALUE from `export.ts` — declaring them here would
 * make the two modules a runtime cycle. The rules that PRODUCE them are here.
 */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Normalise the requested modes into the set the floors must hold for. An empty
 * / absent filter means "all modes", and the floors are then computed against
 * ALL of them — the conservative reading, because an unfiltered export claims to
 * speak for every book.
 */
export function requestedModes(filters: Pick<ExportFilters, 'modes'>): AccountMode[] {
  const asked = filters.modes ?? [];
  return asked.length > 0 ? [...asked] : [...ALL_EXPORT_MODES];
}

/** Same rule for markets. */
export function requestedMarkets(filters: Pick<ExportFilters, 'markets'>): ExportMarket[] {
  const asked = filters.markets ?? [];
  return asked.length > 0 ? [...asked] : [...ALL_EXPORT_MARKETS];
}

/**
 * The floor the option journal can push a single mode back to: the earliest
 * event it recorded for this book in that mode — i.e. `min(openTs)` across ALL
 * its rows, open and closed alike.
 *
 * ── Why `openTs`, and not the earliest CLOSE ─────────────────────────────────
 *
 * The earliest close is the ledger's oldest ROW; it is not the window the ledger
 * COVERS. Anchoring on it makes the floor jump forward every time an old row
 * ages out of relevance, and it refuses the exact query this ticket was filed
 * about: bqb1's two live closes were recorded at 2026-08-18T14:50Z, so an
 * earliest-close floor would refuse `from=2026-08-18` — a range that starts nine
 * hours before them and contains both. An OPEN row at time T, by contrast, is
 * positive evidence that the journal was capturing this book at T, which is the
 * property a coverage floor is actually asserting.
 *
 * ── The one hole, stated rather than hidden ──────────────────────────────────
 *
 * The journal writes a CLOSE only for a position whose OPEN it recorded. So a
 * position opened before capture began for this book, and closed after, has no
 * journal row and its exit is NOT recoverable here. That gap is disclosed on the
 * wire — `source: 'option-trade-journal'` plus the coverage note — rather than
 * being papered over with a fudged offset, because a floor nobody can reproduce
 * from the data is worse than a floor with a documented edge.
 *
 * ⚠️ `rows` MUST already be scoped to the requesting book with
 * `journalRowsForBook(rows, username, accountDeletedAt(username))`. The journal
 * is FIRM-WIDE — one file for the whole ~51-book demo fleet plus the live book —
 * so an unscoped fold leaks other books' trades into a per-user export. The
 * scoping is not a plain `account === username` test either: usernames are
 * RECYCLABLE and the journal outlives an account wipe, so a re-registered name
 * would inherit its predecessor's rows without the identity-epoch bound
 * (TRA-2421). This function deliberately does not re-implement that filter — one
 * audited scope, called by every consumer.
 *
 * Returns null when this book owns no row in that mode — the honest "journal
 * adds nothing here", which leaves the archive boundary standing.
 */
export function journalFloorForMode(
  rows: readonly OptionTradeJournalRecord[],
  mode: AccountMode,
): number | null {
  let earliest: number | null = null;
  for (const r of rows) {
    if (r.mode !== mode) continue;
    if (!isFiniteNumber(r.openTs)) continue;
    if (earliest === null || r.openTs < earliest) earliest = r.openTs;
  }
  return earliest;
}

export interface CoverageInput {
  /**
   * Epoch ms of the last observed archive tick on this book, or null if this
   * build has never seen one on it.
   */
  archiveBoundaryMs: number | null;
  /** Epoch ms this process started; the conservative fallback floor. */
  processStartMs: number;
  /**
   * The journal rows for THIS book — already narrowed by `journalRowsForBook`.
   * Empty when the journal is off, unreadable, or holds nothing for this book.
   */
  journalRows: readonly OptionTradeJournalRecord[];
  filters: Pick<ExportFilters, 'modes' | 'markets'>;
}

/**
 * Resolve the per-market floor this export can attest to.
 *
 * The options floor is the MAX over the requested modes of each mode's own
 * floor. Taking the max (not the min) is the load-bearing choice: if the journal
 * covers this user's demo book back to 08-01 but their live book only to 08-18,
 * then a `modes=demo,live` range starting 08-05 is servable for demo and NOT for
 * live — and answering it would put a silently-partial live leg behind a `200`,
 * which is the original defect with extra steps.
 */
export function resolveExportCoverage(input: CoverageInput): ExportCoverage {
  const { archiveBoundaryMs, processStartMs, journalRows, filters } = input;
  const modes = requestedModes(filters);

  const base: ExportMarketCoverage = isFiniteNumber(archiveBoundaryMs)
    ? { since: archiveBoundaryMs, sinceIso: iso(archiveBoundaryMs), source: 'archive-boundary' }
    : isFiniteNumber(processStartMs)
      ? { since: processStartMs, sinceIso: iso(processStartMs), source: 'process-start' }
      : { since: null, sinceIso: null, source: 'unknown' };

  // Options: the journal can only ever move the floor EARLIER, and only when it
  // covers every requested mode. A mode with no journal history keeps `base`,
  // and the max across modes carries that gap through to the published floor.
  let optionsSince = base.since;
  let optionsSource: ExportCoverageSource = base.source;
  if (base.since !== null) {
    let worst = -Infinity;
    let anyJournal = false;
    for (const mode of modes) {
      const journalFloor = journalFloorForMode(journalRows, mode);
      const floor = journalFloor === null ? base.since : Math.min(journalFloor, base.since);
      if (journalFloor !== null && journalFloor < base.since) anyJournal = true;
      if (floor > worst) worst = floor;
    }
    if (Number.isFinite(worst)) {
      optionsSince = worst;
      if (anyJournal && worst < base.since) optionsSource = 'option-trade-journal';
    }
  }

  const options: ExportMarketCoverage = {
    since: optionsSince,
    sinceIso: iso(optionsSince),
    source: optionsSource,
  };

  return {
    stocks: { ...base },
    crypto: { ...base },
    options,
    modes,
    note:
      'Each market states the earliest EXIT time this export can attest to. Stocks and '
      + 'crypto are bounded by the 21:00 ET archive (TRA-219), which clears the in-memory '
      + 'closed-trade buckets. Options extend further back wherever the durable '
      + 'option-trade journal was already recording this book: that floor is the earliest '
      + 'event the journal holds for it, and the journal writes a close only for a position '
      + 'whose open it recorded — so a position opened BEFORE that point, and closed after, '
      + 'has no journal row and its exit is not recoverable here. An empty result is only an '
      + 'answer INSIDE these bounds: a `from` earlier than a requested market\'s floor is '
      + 'refused with 400 rather than served as 0 trades (TRA-3860).',
  };
}

/**
 * The `X-Export-Coverage` header value: the coverage floors as compact,
 * GUARANTEED-ASCII JSON.
 *
 * Two things this exists to prevent, both measured on live bqb1:
 *
 * **1. It must not throw.** `res.setHeader` rejects any character outside
 * latin1 with `ERR_INVALID_CHAR`. {@link ExportCoverage.note} is human prose and
 * contains an em-dash (U+2014), so passing the whole object through
 * `JSON.stringify` turned EVERY CSV export — the route's DEFAULT format — into a
 * `500`. Escaping is done here, once, rather than trusting future edits of a
 * prose string to stay ASCII: the note is written to be read by humans and will
 * drift again.
 *
 * **2. It must stay a header.** The prose `note` is dropped, not escaped into
 * the header: a header is for the machine-readable floors, the JSON body carries
 * the full statement, and a multi-hundred-byte prose blob on every CSV response
 * is a cost with no reader. `noteIn` names where to find it.
 */
export function coverageHeaderValue(coverage: ExportCoverage): string {
  const { note: _note, ...floors } = coverage;
  return asciiHeaderJson({
    ...floors,
    noteIn: 'summary.coverage.note of the JSON export (TRA-3860)',
  });
}

/**
 * JSON, `\uXXXX`-escaped down to printable ASCII, for a response HEADER value.
 *
 * Extracted from {@link coverageHeaderValue} for TRA-3882, which adds a second
 * provenance header to the same CSV response. The escape is the part that must
 * not be re-implemented: `res.setHeader` throws `ERR_INVALID_CHAR` on any
 * character outside latin1, and that throw already turned every CSV export —
 * the route's DEFAULT format — into a `500` on live bqb1 once. A second header
 * hand-rolling `JSON.stringify` is that outage waiting for its first non-ASCII
 * field. JSON parses the escapes back to the identical string, so the value
 * stays machine-readable.
 *
 * ASCII, not latin1: `setHeader` would accept U+0080–U+00FF, but they are not
 * safely round-trippable through every HTTP client's header decoding, and no
 * value here needs them.
 */
export function asciiHeaderJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7E]/g, ch =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * TRA-4358 — the scope statement the route attaches to every export.
 *
 * Measured on live bqb1 2026-09-09: `/api/health/option-journal`
 * `summary.byMode.live.total` read 32 while `modes=live` on this route served
 * 27, and the delta was filed as the export DROPPING the five newest live rows.
 * It was not — the five belonged to the OTHER live book, and the export is
 * book-scoped by design (`journalRowsForBook`, TRA-2421; serving another
 * account's trades would be the leak that scoping exists to prevent). What was
 * genuinely missing is any statement of that rule on the wire: two documents,
 * one firm-wide and one per-book, read as the same population with rows lost.
 * The prose is deliberately generic — it names the RULE, never another book.
 */
export function exportScopeFor(username: string): ExportScope {
  return {
    book: username,
    note:
      'This export serves ONE book: the authenticated user\'s. Every candidate row is '
      + 'scoped to that book before any filter runs (`journalRowsForBook`, TRA-2421). The '
      + 'option-trade journal and the surfaces built on it (e.g. /api/health/option-journal '
      + '`summary.byMode`) are FIRM-WIDE and pool every book trading a mode, so a mode-level '
      + 'count there can legitimately exceed this document\'s row count without any row '
      + 'having been dropped. Compare the two only after scoping the firm-wide side to this '
      + 'book (TRA-4358).',
  };
}

/**
 * TRA-4358 — the same statement on the `X-Export-Scope` header, so the CSV form
 * — the route's DEFAULT format and the artifact a human saves — carries it too.
 * Same rules as {@link coverageHeaderValue}: through {@link asciiHeaderJson},
 * never a bare `JSON.stringify` (`setHeader` rejects non-latin1), and the prose
 * `note` is dropped in favour of a pointer, because a header is for the
 * machine-readable fact and a multi-hundred-byte prose blob on every CSV
 * response has no reader.
 */
export function scopeHeaderValue(scope: ExportScope): string {
  const { note: _note, ...fact } = scope;
  return asciiHeaderJson({
    ...fact,
    noteIn: 'summary.scope.note of the JSON export (TRA-4358)',
  });
}

export interface RangeRefusal {
  error: string;
  detail: string;
  requestedFrom: number;
  requestedFromIso: string;
  /** The markets that cannot serve the requested lower bound. */
  unservableMarkets: ExportMarket[];
  coverage: ExportCoverage;
}

/**
 * The gate. Refuses ONLY an explicit `from` that precedes a requested market's
 * floor — the case where the caller has asked, in so many words, for history
 * this route does not hold.
 *
 * An absent `from` is deliberately NOT refused. An unbounded export is a request
 * for "what you have", which the route can honestly answer; it is qualified by
 * the {@link ExportCoverage} that ships in the summary. Refusing it as well would
 * break every caller who never asked for history to buy nothing — the coverage
 * block already stops the emptiness from reading as a complete record.
 */
export function checkExportRangeServable(
  filters: Pick<ExportFilters, 'from' | 'modes' | 'markets'>,
  coverage: ExportCoverage,
): { ok: true } | { ok: false; refusal: RangeRefusal } {
  const from = filters.from;
  if (!isFiniteNumber(from)) return { ok: true };

  const markets = requestedMarkets(filters);
  const unservable: ExportMarket[] = [];
  for (const market of markets) {
    const since = coverage[market].since;
    if (since === null || from < since) unservable.push(market);
  }
  if (unservable.length === 0) return { ok: true };

  const parts = unservable.map(m => {
    const c = coverage[m];
    return c.since === null
      ? `${m}: coverage unknown (${c.source})`
      : `${m}: coverage begins ${c.sinceIso} (${c.source})`;
  });

  // Name the constraint that ACTUALLY binds, per market. Blaming the archive for
  // an options refusal — whose floor is the journal's start — would send a reader
  // to the wrong cause, which is the same class of defect as the empty 200 this
  // route is being fixed for.
  const sources = new Set(unservable.map(m => coverage[m].source));
  const causes: string[] = [];
  if (sources.has('archive-boundary')) {
    causes.push(
      'the daily 21:00 ET archive (TRA-219) clears the in-memory closed-trade buckets',
    );
  }
  if (sources.has('process-start')) {
    causes.push(
      'this process has not yet observed an archive tick on this book, so it can only attest '
      + 'from its own start (conservative — it refuses some ranges it may in fact hold)',
    );
  }
  if (sources.has('option-trade-journal')) {
    causes.push(
      'the durable option-trade journal only begins recording this book at the date above',
    );
  }
  if (sources.has('unknown')) {
    causes.push('there is no boundary this route can attest with at all');
  }

  return {
    ok: false,
    refusal: {
      error: 'from is earlier than this export can attest to',
      detail:
        `Requested from=${new Date(from).toISOString()}. ${parts.join('; ')}. `
        + `Cause: ${causes.join('; ')}. `
        + 'It refuses rather than returning 0 trades, because an empty result over an '
        + 'unservable range is indistinguishable from a range that genuinely had no trades '
        + '(TRA-3860). Narrow `from`, drop the unservable markets, or read the archived day '
        + 'from the EOD report / option-trade journal.',
      requestedFrom: from,
      requestedFromIso: new Date(from).toISOString(),
      unservableMarkets: unservable,
      coverage,
    },
  };
}

/**
 * Map one CLOSED journal row into the flat export row shape.
 *
 * Fields the journal never captured are `null`, never a stand-in. The journal
 * records the setup and the realized outcome, not the per-contract exit premium,
 * so `exit_price` is null on every journal-sourced row — and `entry_price` is
 * null on rows (e.g. `tradier_import`) that carried no fill mark. A fabricated
 * price in an audit export is worse than a blank one; a blank is also what makes
 * a journal-recovered row visually distinguishable from a book row.
 *
 * ── TRA-3864 — `fees_usd` is a JOURNAL field, not a book field ───────────────
 *
 * This function was written against the row shape `export.ts` defines, and took
 * its `fees_usd: 0` / `gross === net` premise with it. That premise is a true
 * statement about `Position` / `OptionPosition` (the engine records no
 * per-trade commission) and a FALSE one about the journal: `feesUsd` has been on
 * the journal row since TRA-2819, and TRA-3730's sweep put it on the live money
 * book. Measured live 2026-08-19 on `SPY260821C00777000` (2026-08-18): the
 * journal held `feesUsd 0.23`, `realizedPnlUsd -156.23`, `pnlBasis
 * 'broker-fill'`; the export published `fees_usd 0` and
 * `gross_pnl_usd -156.23 === net_pnl_usd`. `net` was right and both other
 * columns were wrong, so `gross - fees = net` held only vacuously.
 *
 * `realizedPnlUsd` is NET of `feesUsd` (see `OptionTradeJournalRecord.feesUsd`),
 * so gross is reconstructed as `net + fees` rather than measured separately.
 *
 * A row with no `feesUsd` (no `pnlBasis: 'broker-fill'`, i.e. never restated)
 * keeps `fees_usd: 0` and `gross === net`. That is the pre-existing behaviour
 * and it is NOT a claim the trade was free — the journal simply has no fee
 * measurement for it. The rounding is applied to `fees` and to `gross`
 * independently rather than to `net + fees` alone, so the published columns
 * satisfy `gross - fees === net` exactly at cent precision.
 */
export function rowFromJournalRecord(r: OptionTradeJournalRecord): ExportTradeRow {
  const restated = r.pnlBasis === 'broker-fill';
  const net = isFiniteNumber(r.realizedPnlUsd) ? Math.round((r.realizedPnlUsd + Number.EPSILON) * 100) / 100 : null;
  const fees = isFiniteNumber(r.feesUsd) ? Math.round((r.feesUsd + Number.EPSILON) * 100) / 100 : 0;
  const gross = net === null ? null : Math.round((net + fees + Number.EPSILON) * 100) / 100;
  // TRA-4031 — ONE basis per row, NAMED. In order of strength:
  //   1. a TRA-2819 restatement's broker ENTRY FILL (`'broker-fill'`, TRA-3875);
  //   2. the book's post-reconcile `premiumPaid` the CLOSE row carried
  //      (`entryBasisPremium`, `'book-basis'`) — the figure the book-sourced
  //      row of this same close published, so the two reads agree across the
  //      21:00 ET archive (AC1/AC2);
  //   3. the scanner's pre-trade mid frozen at the OPEN write (`entryMarkUsd`,
  //      `'pre-trade-mid'`) — a row closed before the stamp shipped keeps it,
  //      and SAYS so, rather than being backfilled (AC4).
  // On `NVTS261002C00012500` (2026-08-25) the sweep skipped the lot
  // (`fees_unmeasured`), so (1) was closed to it and it fell through to (3):
  // 1.395 served for a 1.51 basis, a number the engine never traded on.
  const entry: { price: number | null; basis: ExportEntryPriceBasis | null } =
    restated && isFiniteNumber(r.entryFillPremium)
      ? { price: r.entryFillPremium, basis: 'broker-fill' }
      : isFiniteNumber(r.entryBasisPremium) && r.entryBasisPremium > 0
        ? { price: r.entryBasisPremium, basis: 'book-basis' }
        : isFiniteNumber(r.entryMarkUsd)
          ? { price: r.entryMarkUsd, basis: 'pre-trade-mid' }
          : { price: null, basis: null };
  return {
    symbol: r.optionSymbol ?? r.symbol,
    market: 'options',
    mode: r.mode,
    // The journal only ever holds long-premium and defined-risk structures the
    // book opened; entry is the open leg, matching `rowFromOption`.
    side: 'buy',
    strategy: r.structure,
    quantity: isFiniteNumber(r.contracts) ? r.contracts : 0,
    entry_time: isFiniteNumber(r.openTs) ? new Date(r.openTs).toISOString() : '',
    // TRA-3875 — on a RESTATED row the broker's own entry fill is the basis the
    // published `net` was computed against (`tra2819-close-basis-restate.ts:386`,
    // `entryCost / contracts / 100` — per share, same unit as `entryMarkUsd` and
    // as `rowFromOption`'s `premiumPaid`). Publishing the pre-trade MID next to a
    // broker-settled P&L is the same internal contradiction this ticket is about,
    // one column over. Unrestated rows used to keep the mark, unchanged —
    // TRA-4031 now prefers the CLOSE row's `entryBasisPremium` over it (see
    // `entry` above) and labels whichever it published.
    entry_price: entry.price,
    entry_price_basis: entry.basis,
    exit_time: isFiniteNumber(r.closeTs) ? new Date(r.closeTs).toISOString() : '',
    // TRA-3875 — and the exit premium the doc-comment above says the journal
    // "never recorded" IS recorded, on restated rows only, as `exitFillPremium`.
    // That single fact is why TRA-3860's dedupe (book wins, because only the book
    // has the exit premium) had to be re-ruled: on a restated row the journal does
    // not tie the book here, it beats it — a broker fill against a last mark. The
    // "a blank beats a fabricated price" rule still holds for every other row,
    // because a measured fill is not a fabrication.
    exit_price: restated && isFiniteNumber(r.exitFillPremium) ? r.exitFillPremium : null,
    exit_reason: r.exitReason ?? '',
    gross_pnl_usd: gross,
    fees_usd: fees,
    net_pnl_usd: net,
    pnl_r: isFiniteNumber(r.realizedR) ? Math.round((r.realizedR + Number.EPSILON) * 1000) / 1000 : null,
    hold_duration: formatHoldDuration(r.openTs, r.closeTs),
    // TRA-3989 — `realizedR` is `realizedPnlUsd / atRiskUsd` = pnl ÷ FULL PREMIUM,
    // and `rowFromOption` now divides by the same thing, so a book-served row
    // and this one agree on `pnl_r` (the regression in
    // `tra3989-export-r-basis.test.ts` holds the two mappers to it).
    //
    // TRA-4246 (AC1) — the stop-basis column used to be a HARD `null` here,
    // with the comment "the journal records no stop … never a premium figure
    // re-scaled by a constant that is stale the day the stop is re-tuned (the
    // `0.25` in `GATE_R_PER_PREMIUM_R` already is: the live OTM stop is
    // `premium × 0.80`, a 5× not a 4×)". The refusal to re-scale was right and
    // stands. What was wrong was the premise: the journal DOES record a stop
    // now — the close row captures `|premiumPaid − stopLossPremium|` at the
    // write, from the row's own operands, and publishes the divisor beside it
    // (`stopBasisRPerPremiumR`). So this is the ROW's figure, never a constant
    // applied to it, and a row that had no armed stop still publishes `null`
    // with `pnlRStopBasisReason` on the journal record saying which kind of
    // nothing it was.
    //
    // ⚠️ Forward-only. Every row closed before the stamp shipped carries no
    // key at all and lands here as `null` — indistinguishable in THIS column
    // from a stamped null, which is why the reason lives on the journal record
    // and a grader reading the census must window on close date.
    pnl_r_stop_basis: isFiniteNumber(r.pnlRStopBasis) ? r.pnlRStopBasis : null,
    // TRA-4027 — and the premium it divides by is the one captured at the OPEN
    // MARK (`atRiskUsd`, frozen at open by TRA-991), which is why the label
    // names the instant and not merely the unit. `premium_basis_usd` is that
    // figure, so `pnl_r == net_pnl_usd / premium_basis_usd` reconciles here
    // exactly as it does on a book row. Null — never 0 — when the record states
    // no basis (a reconstructed lot; then `realizedR` is not finite either).
    //
    // TRA-4035 — the label is read off the record's OWN `atRiskBasis` (TRA-4028),
    // not asserted from the figure being present: BAC `6bbc5d17` was restated
    // onto its $117 ledger fill and read `pnl_r -0.026` (÷117, correct) under
    // `'premium-open-mark'` (wrong — $117 is the 1.17 FILL). `'mark'` and ABSENT
    // (pre-TRA-4028 rows, engine rows whose open IS the mark) keep the old label.
    pnl_r_basis: premiumRBasisLabel(r.atRiskBasis),
    premium_basis_usd: isFiniteNumber(r.atRiskUsd) && r.atRiskUsd > 0 ? r.atRiskUsd : null,
    source: 'journal',
    pnl_basis: restated ? 'broker-fill' : 'book',
    // TRA-3985 — the journal knows this close by `r.id`, which is
    // `journalIdForPosition(position)` at the write site and therefore joins to
    // a book row's `journal_id`, NEVER to its `lot_id`. The book position id is
    // not stored on this side and so is not recoverable: `lot_id` is null rather
    // than a copy of `r.id`, because a copy would read as a successful lot
    // attribution to any consumer joining on it — the exact false confidence
    // this ticket's Defect 2 is about.
    lot_id: null,
    journal_id: r.id,
    // TRA-3945 stamps the realising close's broker order id on the CLOSE row.
    // `??` not `||`: a numeric order id of 0 is a real handle.
    broker_order_id: r.brokerOrderId ?? null,
    // TRA-3990 — the journal's copy of the row's stamp, so an archive-served row
    // carries the same figure the book row did (AC2). Null on a pre-stamp row.
    entry_spread_pct: isFiniteNumber(r.entrySpreadPct) ? r.entrySpreadPct : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3930 — ONE CLOSE IS ONE ROW, and the row id is not the close id
//
// The export served **-130.00 for a -65.00 day** on live bqb1 2026-08-21, because
// the two halves of "de-dupe the journal against the book" were both keyed wrong:
//
//   Cause 1 — the book side was addressed by `position.id`, but the journal is
//   addressed by `position.journalId ?? position.id` (TRA-3078; see
//   {@link journalIdForPosition}). One of the day's two live closes was a
//   reconcile-REBOUND import whose two ids differ, so `excludeIds.has(r.id)` was
//   structurally unable to be true for it and its journal twin was served
//   alongside the book copy — same OCC, same exit timestamp to the millisecond,
//   same money, twice.
//
//   Cause 2 — and an id set cannot fix that alone, because the journal held TWO
//   records for one BAC close: the engine's (`chandelier_restarted`) and a
//   TRA-3485 reconstruction (`reconstructed-TRA-3472`) minted rather than rebound
//   by the import reconciler. The engine's record matched the book and was
//   correctly dropped; the reconstruction has no book twin under ANY id, so a
//   set of book ids — however it is keyed — can exclude at most one of them.
//
// So the unit of de-duplication here is the CLOSE, not the journal row. Rows are
// grouped by close identity first; a group with a book twin is dropped whole, and
// a group without one serves exactly ONE row.
//
// ⚠️ This is a REPORTING repair. The duplicate BAC record is a real defect in the
// import reconciler's MINT-vs-REBIND decision (the TRA-2937/TRA-3472 family) and
// is filed separately — an export that quietly renders a corrupt journal as a
// clean day would be worse than the double it replaces, which is why the collapse
// is published on `summary` rather than performed in silence.

/**
 * TRA-3930 — the identity of a CLOSE, as distinct from the identity of a ROW.
 *
 * `mode | OCC symbol | closeTs`, and every part is load-bearing. Two closes of
 * the SAME contract in the SAME book at the SAME millisecond are not two closes;
 * `closeTs` is stamped from the exit, so genuine sequential exits of one contract
 * differ by seconds at minimum, and the observed duplicate pair matched to the ms
 * (`closeTs 1787331910473` on both) — that is a copy, not a coincidence.
 *
 * `null` when the row carries no `optionSymbol` (pre-TRA-1656 rows). With no
 * contract identity there is nothing to assert sameness ON, so such a row is left
 * ungrouped and served on its own merits — collapsing on `mode|closeTs` alone
 * would merge two genuinely different contracts closed in the same batch.
 */
// TRA-3933 — EXPORTED so the duplicate-close census
// (`scripts/tra3933-duplicate-close-census.mjs`) enumerates the population with
// this predicate rather than a re-spelling of it. A census that answers "how many
// rows does the export collapse" with its own private definition of "same close"
// is measuring a different question than the one the export answers.
export function closeIdentityKey(r: OptionTradeJournalRecord): string | null {
  if (!r.optionSymbol) return null;
  if (!isFiniteNumber(r.closeTs)) return null;
  return `${r.mode}|${r.optionSymbol}|${r.closeTs}`;
}

/**
 * TRA-3930 — how good a DESCRIPTIVE record of a close a journal row is. Higher
 * wins; money is ranked separately (see {@link moneyRecordFor}) because the two
 * questions have different answers.
 *
 * A `tradier_import` row is inventory the firm did not select (TRA-2937), and a
 * `reconstructed-TRA-3472` exit reason explicitly means "the real exit was LOST
 * and this close was back-filled from broker fills" (TRA-3485) — it names the
 * ruling that authorised the reconstruction precisely so it is not mistaken for
 * an observed decision. Where an engine-authored record of the same close exists,
 * it is the one that carries the strategy label and the actual exit decision, and
 * it is the one that must be published.
 */
function descriptiveRank(r: OptionTradeJournalRecord): number {
  let rank = 0;
  if (r.structure !== TRADIER_IMPORT_STRUCTURE) rank += 2;
  if (r.exitReason && r.exitReason !== RECONSTRUCTED_EXIT_REASON) rank += 1;
  return rank;
}

/** The rows of one close, in first-appearance order, plus the book twin if any. */
interface JournalCloseGroup {
  rows: OptionTradeJournalRecord[];
  /**
   * The journal id under which the in-memory book holds this close, or `null`.
   * This is the key a restatement must be published under — the book row is
   * joined back by `journalIdForPosition(position)` in `export.ts`.
   */
  bookJournalId: string | null;
}

/**
 * TRA-3930 — group this book's CLOSED journal rows by the close each describes.
 *
 * `bookJournalIds` must be `new Set(closedOptions.map(journalIdForPosition))` —
 * the ids the JOURNAL knows the book's closes by, never the bare `position.id`
 * that Cause 1 used.
 *
 * Insertion-ordered: the served rows keep the journal's own order, so a book row
 * and its twin can never reorder between two calls (the TRA-3860 guarantee).
 */
function groupJournalCloses(
  rows: readonly OptionTradeJournalRecord[],
  bookJournalIds: ReadonlySet<string>,
): JournalCloseGroup[] {
  const groups = new Map<string, JournalCloseGroup>();
  for (const r of rows) {
    if (r.outcome === 'OPEN') continue;
    if (!isFiniteNumber(r.closeTs)) continue;
    // An ungroupable row keys on its own id, so it is its own group of one and
    // behaves exactly as it did before this ticket.
    const key = closeIdentityKey(r) ?? `row:${r.id}`;
    const existing = groups.get(key);
    const group = existing ?? { rows: [], bookJournalId: null };
    group.rows.push(r);
    if (bookJournalIds.has(r.id)) group.bookJournalId = r.id;
    if (!existing) groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The MEASURED-money record of a close, if the group holds one.
 *
 * TRA-2819/TRA-3875: only `pnlBasis: 'broker-fill'` is a measured disagreement.
 * A row without it holds the engine's own arithmetic — the same figure the book
 * holds — so there is nothing to supersede, and manufacturing an entry would
 * replace a number with itself while incrementing `supersededRowCount`.
 *
 * TRA-3930 widens the search from "the twin row" to "any record of THIS close",
 * because once two records can describe one close, the one holding broker truth
 * and the one holding the engine's exit decision need not be the same row. It is
 * scoped by {@link closeIdentityKey}, i.e. same book, same contract, same exit
 * millisecond — never across closes.
 */
function moneyRecordFor(group: JournalCloseGroup): OptionTradeJournalRecord | null {
  return group.rows.find(r => r.pnlBasis === 'broker-fill') ?? null;
}

/**
 * `feesUsd` is set only alongside `pnlBasis` (TRA-2819, never zero-filled), so
 * the `fees_usd: 0` fallback inside is unreachable in practice and is kept only
 * so the type is total.
 */
function restatementFromRecord(r: OptionTradeJournalRecord): ExportMoneyRestatement {
  const mapped = rowFromJournalRecord(r);
  return {
    gross_pnl_usd: mapped.gross_pnl_usd,
    fees_usd: mapped.fees_usd,
    net_pnl_usd: mapped.net_pnl_usd,
    // The restatement re-derives `realizedR` in the same write that moves the
    // money (`option-trade-journal.ts`), so R travels with it. Keeping the
    // book's R would publish an R computed from the number just replaced.
    pnl_r: mapped.pnl_r,
    exit_price: mapped.exit_price,
    entry_price: mapped.entry_price,
    // TRA-4031 — and the label of that entry travels with it (a restated record
    // always has `entryFillPremium`, so this reads `'broker-fill'`; the overlay
    // does not have to guess).
    entry_price_basis: mapped.entry_price_basis ?? null,
    // TRA-3985 — the order id travels with the money for the same reason `pnl_r`
    // does: it is measured by the SAME broker-fill restatement, and a book row
    // that adopts a broker-settled figure without the handle that settled it
    // cannot be reconciled against the broker afterwards.
    broker_order_id: mapped.broker_order_id ?? null,
    // TRA-4027 — and so does the basis the restated R was divided by: the
    // journal's open-mark `atRiskUsd`, unchanged by the restatement
    // (`OptionTradeCloseBasis.realizedR` — "same denominator as before").
    premium_basis_usd: mapped.premium_basis_usd ?? null,
    // TRA-4035 — and what that basis IS, so the overlay labels the book row the
    // way the journal labels itself (`atRiskBasis 'fill'` ⇒ `'premium-fill'`).
    pnl_r_basis: mapped.pnl_r_basis,
  };
}

/**
 * TRA-3875 — the restatements a book row must adopt, keyed by the id the JOURNAL
 * knows that book row by (`journalIdForPosition`, TRA-3930 — it was keyed by the
 * bare `position.id` and therefore missed every rebound position).
 *
 * ⚠️ Same precondition as {@link selectJournalExportRows} — `rows` must ALREADY
 * be book-scoped by `journalRowsForBook`, or one account's restatement lands on
 * another's book row.
 *
 * `bookJournalIds` is the book's closes addressed the journal's way: this is
 * deliberately the COMPLEMENT of what {@link selectJournalExportRows} serves.
 * Every CLOSE either (a) has no book twin and is served directly by that function
 * carrying its own restated money, or (b) has a book twin, is dropped there, and
 * its money is carried over HERE. Exactly one path handles each close, so no
 * restatement is double-counted and none is lost. Both functions partition on the
 * same {@link groupJournalCloses} call, so the two cannot drift apart.
 */
export function collectJournalMoneyRestatements(
  rows: readonly OptionTradeJournalRecord[],
  bookJournalIds: ReadonlySet<string>,
): Map<string, ExportMoneyRestatement> {
  const out = new Map<string, ExportMoneyRestatement>();
  for (const group of groupJournalCloses(rows, bookJournalIds)) {
    if (group.bookJournalId === null) continue;
    const money = moneyRecordFor(group);
    if (!money) continue;
    out.set(group.bookJournalId, restatementFromRecord(money));
  }
  return out;
}

/**
 * TRA-4027 — the journal twin's `atRiskUsd` for every book close that has one,
 * keyed like {@link collectJournalMoneyRestatements} by the id the JOURNAL knows
 * the book row by. `export.ts`'s `rowFromOption` divides `pnl_r` by this figure
 * on the book-served row so it publishes the SAME R its journal-served twin will
 * after the 21:00 ET archive.
 *
 * ── Why a second map, and not a field on the restatement ────────────────────
 *
 * The restatement map is populated only for `pnlBasis: 'broker-fill'` records —
 * a MEASURED disagreement over the money. The premium basis is different: the
 * book's `premiumPaid` is overwritten with the broker fill the moment the mirror
 * reconciles (`restateEngineOpenedBasis`, minutes after open), while the
 * journal's `atRiskUsd` is the open MARK, frozen at open (TRA-991) and never
 * restated to the fill. So the two denominators diverge on EVERY reconciled
 * live row, restated or not, hours before any close-basis restatement runs —
 * `NVTS261002C00012500` 2026-08-25 published `pnl_r` over $151 (fill) before
 * the archive and over $139.5 (mark) after it, 8.2% apart, on a row the
 * restatement never touched. Riding on the restatement map would have left
 * exactly that row uncovered.
 *
 * ── What is joined ──────────────────────────────────────────────────────────
 *
 * Every record whose id is in `bookJournalIds`, INCLUDING one still `OPEN`: the
 * journal close is written through an async queue, so a book row can be closed
 * for a beat while its twin still reads `OPEN` — and `atRiskUsd` is captured at
 * the open write, so it is already the right figure. This is deliberately wider
 * than {@link groupJournalCloses}, which skips `OPEN` rows because it is
 * grouping CLOSES; here the open row IS the evidence.
 *
 * Records with no finite positive `atRiskUsd` are skipped, not zero-filled: the
 * book row then divides inline and labels itself `'premium-fill'`, which is
 * true. The reconstructed-lot `atRiskUsd` miss on `BAC260925C00063000` is a
 * reference-row defect with its own child and is not papered over here.
 *
 * TRA-4035 — each entry carries the record's `atRiskBasis` (TRA-4028) beside
 * the figure, so `rowFromOption` labels the book row by what the twin SAYS its
 * basis is. A record without the field maps to `atRiskBasis: null` (instant
 * unknown ⇒ `'premium-open-mark'`, the pre-ticket label), never to `'fill'`.
 *
 * ⚠️ Same precondition as the sibling collectors — `rows` must ALREADY be
 * book-scoped by `journalRowsForBook`, or one account's open mark lands on
 * another's row.
 */
export function collectJournalPremiumBases(
  rows: readonly OptionTradeJournalRecord[],
  bookJournalIds: ReadonlySet<string>,
): Map<string, ExportJournalPremiumBasis> {
  const out = new Map<string, ExportJournalPremiumBasis>();
  for (const r of rows) {
    if (!bookJournalIds.has(r.id)) continue;
    if (!isFiniteNumber(r.atRiskUsd) || r.atRiskUsd <= 0) continue;
    // First finite basis per id wins. The journal folds one record per id, so
    // a second hit is the same record seen twice, never a competing figure.
    if (!out.has(r.id)) {
      out.set(r.id, {
        atRiskUsd: r.atRiskUsd,
        atRiskBasis: r.atRiskBasis === 'fill' || r.atRiskBasis === 'mark' ? r.atRiskBasis : null,
      });
    }
  }
  return out;
}

/**
 * The journal rows this book's export may serve: closed, carrying a usable exit
 * timestamp, and — since TRA-3930 — ONE PER CLOSE.
 *
 * ⚠️ Same precondition as {@link journalFloorForMode} — `rows` must ALREADY be
 * book-scoped by `journalRowsForBook`. The floor and the served rows are derived
 * from the identical input for that reason: a floor computed over a wider
 * population than the rows would publish coverage the export cannot honour.
 *
 * `bookJournalIds` is the in-memory book's closes addressed by
 * {@link journalIdForPosition} — the id the journal is actually keyed on, NOT the
 * bare `position.id`. An id present in both stores is the SAME trade, and exactly
 * one of the two copies may be served or the day double-counts. The BOOK copy is
 * the one that survives — it carries the exit premium, the exit reason and the
 * strategy label — and it survives for the whole GROUP, not merely for the row it
 * matched: a second journal record of an already-book-held close is still that
 * close, and serving it is the same double under a different id.
 *
 * ⚠️ TRA-3875 — dropping the twin used to drop its MONEY with it, and that cost
 * the close basis: a restated journal figure (-156.23) was discarded in favour of
 * the book's superseded one (-278.00) for as long as the book twin existed, i.e.
 * until the 21:00 ET archive. The row-level drop is still right; what was wrong
 * was that it was TOTAL. {@link collectJournalMoneyRestatements} now carries the
 * restated money columns across onto the surviving book row, and
 * `summary.supersededRowCount` publishes how often that happened. The original
 * objection to merging — "a recovered row silently inheriting a richer provenance
 * than it has" — is met by the `source`/`pnl_basis` fields, not by refusing to
 * merge: the merge is now stated on every row it touched.
 */
export function selectJournalExportRows(
  rows: readonly OptionTradeJournalRecord[],
  bookJournalIds: ReadonlySet<string>,
): ExportTradeRow[] {
  const out: ExportTradeRow[] = [];
  for (const group of groupJournalCloses(rows, bookJournalIds)) {
    // The book holds this close. Its row wins and this whole group is dropped;
    // the money, if any of these records measured it, went to the restatement map.
    if (group.bookJournalId !== null) continue;
    // No book twin, so the journal is the only record of this close. Publish the
    // best DESCRIPTIVE record of it, and overlay the measured money if a sibling
    // record of the same close holds it and the chosen one does not.
    let rep = group.rows[0]!;
    for (const r of group.rows) {
      if (descriptiveRank(r) > descriptiveRank(rep)) rep = r;
    }
    const money = moneyRecordFor(group);
    const row = rowFromJournalRecord(rep);
    out.push(
      money && money !== rep ? applyMoneyRestatement(row, restatementFromRecord(money)) : row,
    );
  }
  return out;
}
