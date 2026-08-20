import type { AccountMode } from '@trading-app/shared';
import type {
  ExportCoverage,
  ExportCoverageSource,
  ExportFilters,
  ExportMarket,
  ExportMarketCoverage,
  ExportMoneyRestatement,
  ExportTradeRow,
} from './export.js';
import { formatHoldDuration } from './export.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

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
  const json = JSON.stringify({
    ...floors,
    noteIn: 'summary.coverage.note of the JSON export (TRA-3860)',
  });
  // `\uXXXX`-escape everything outside printable ASCII. JSON parses the escapes
  // back to the identical string, so the value stays machine-readable.
  return json.replace(/[^\x20-\x7E]/g, ch =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
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
    // one column over. Unrestated rows keep the mark, unchanged.
    entry_price: restated && isFiniteNumber(r.entryFillPremium)
      ? r.entryFillPremium
      : (isFiniteNumber(r.entryMarkUsd) ? r.entryMarkUsd : null),
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
    source: 'journal',
    pnl_basis: restated ? 'broker-fill' : 'book',
  };
}

/**
 * TRA-3875 — the restatements a book row must adopt, keyed by trade id.
 *
 * ⚠️ Same precondition as {@link selectJournalExportRows} — `rows` must ALREADY
 * be book-scoped by `journalRowsForBook`, or one account's restatement lands on
 * another's book row.
 *
 * `bookIds` is the in-memory book's id set: this is deliberately the COMPLEMENT
 * of the set `selectJournalExportRows` serves. Every closed journal row either
 * (a) has no book twin and is served directly by that function, carrying its own
 * restated money, or (b) has a book twin, is dropped there, and its money is
 * carried over HERE. Exactly one path handles each row, so no restatement is
 * double-counted and none is lost.
 *
 * Only `pnlBasis: 'broker-fill'` rows produce an entry. A journal row without it
 * holds the engine's own figure — the same figure the book holds — so there is
 * nothing to supersede, and manufacturing an entry would replace a number with
 * itself while incrementing `supersededRowCount`. A restatement is a MEASURED
 * disagreement or it is not published.
 *
 * `feesUsd` is set only alongside `pnlBasis` (TRA-2819, never zero-filled), so
 * the `fees_usd: 0` fallback here is unreachable in practice and is kept only so
 * the type is total.
 */
export function collectJournalMoneyRestatements(
  rows: readonly OptionTradeJournalRecord[],
  bookIds: ReadonlySet<string>,
): Map<string, ExportMoneyRestatement> {
  const out = new Map<string, ExportMoneyRestatement>();
  for (const r of rows) {
    if (r.outcome === 'OPEN') continue;
    if (!isFiniteNumber(r.closeTs)) continue;
    if (!bookIds.has(r.id)) continue;
    if (r.pnlBasis !== 'broker-fill') continue;
    const mapped = rowFromJournalRecord(r);
    out.set(r.id, {
      gross_pnl_usd: mapped.gross_pnl_usd,
      fees_usd: mapped.fees_usd,
      net_pnl_usd: mapped.net_pnl_usd,
      // The restatement re-derives `realizedR` in the same write that moves the
      // money (`option-trade-journal.ts`), so R travels with it. Keeping the
      // book's R would publish an R computed from the number just replaced.
      pnl_r: mapped.pnl_r,
      exit_price: mapped.exit_price,
      entry_price: mapped.entry_price,
    });
  }
  return out;
}

/**
 * The journal rows this book's export may serve: closed, and carrying a usable
 * exit timestamp.
 *
 * ⚠️ Same precondition as {@link journalFloorForMode} — `rows` must ALREADY be
 * book-scoped by `journalRowsForBook`. The floor and the served rows are derived
 * from the identical input for that reason: a floor computed over a wider
 * population than the rows would publish coverage the export cannot honour.
 *
 * `excludeIds` is the in-memory book's id set. The journal is keyed on the
 * position id (`recordOptionTradeOpen({ id: position.id })`), so an id present in
 * both is the SAME trade, and exactly one of the two copies may be served or the
 * day double-counts. The BOOK copy is the one that survives — it carries the
 * exit premium, the exit reason and the strategy label.
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
  excludeIds: ReadonlySet<string>,
): ExportTradeRow[] {
  const out: ExportTradeRow[] = [];
  for (const r of rows) {
    if (r.outcome === 'OPEN') continue;
    if (!isFiniteNumber(r.closeTs)) continue;
    if (excludeIds.has(r.id)) continue;
    out.push(rowFromJournalRecord(r));
  }
  return out;
}
