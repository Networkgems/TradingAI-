/**
 * TRA-3979 — FLEET CONCENTRATION: the same dollars the fleet bound counts,
 * sliced by CONTRACT and by UNDERLYING instead of by book.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * On 2026-08-24 both gate-open production books bought the identical option
 * 19 minutes apart inside one entry window:
 *
 *     v0nni  NVTS261002C00012500  1 ct @ 1.54  $154   14:25:07.953Z
 *     admin  NVTS261002C00012500  1 ct @ 1.51  $151   14:44:34.991Z
 *                                              ----
 *                                              $305  = 68.7% of $444 fleet at-risk
 *
 * NOTHING BREACHED AND NOTHING FAILED OPEN. Every gate passed and passed
 * correctly: each order was inside its book's `notionalCapUsd` and
 * `maxContracts`, the reachable bound read `within` with `overageUsd 0`, and
 * the canary ceiling read `within`. This module does not fix a defect in
 * enforcement — it measures the axis enforcement never had a reading on.
 *
 * ⭐⭐⭐ A DOLLAR CEILING IS NOT A RISK CEILING ONCE MORE THAN ONE BOOK SHARES A
 * SIGNAL GENERATOR. THE SECOND BOOK IS NOT DIVERSIFICATION; IT IS LEVERAGE
 * WITH A COMPLIANT RECEIPT. The per-book budget is `sizingBasisUsd × φ_eff`
 * and φ_eff is FLEET-derived, so adding books divides the DOLLARS and does not
 * divide the CONCENTRATION: N books each sized to one contract, each fed by
 * one shared generator, produce N contracts of one option and the fleet bound
 * reads that identically to $305 spread across three names, because it only
 * ever counts dollars.
 *
 * ── What this module is NOT ──────────────────────────────────────────────────
 * ⛔ ADVISORY. IT REFUSES NOTHING. No order site consults this object; the
 * report says so on the wire (`entryPathBehavior` / `refuses`) rather than
 * leaving the next reader to infer it from the absence of a call site. A
 * refusal at the `buy_to_open` path would be a board-facing change to a
 * ratified arm and needs a ceiling the BOARD set — this ships the measurement
 * they would set it against (TRA-3979 AC4; the number goes back to TRA-3703).
 *
 * ── The two folds, and why one is not enough ─────────────────────────────────
 * `byContract` keys on the OSI symbol. `byUnderlying` keys on the name. Both
 * ship because TWO DIFFERENT STRIKES ON ONE NAME ARE THE SAME HAZARD WEARING A
 * DIFFERENT KEY: an `optionSymbol`-only fold reads `NVTS …C00012500` beside
 * `NVTS …C00015000` as diversified, and they are one bet on NVTS.
 *
 * ── Zeros ────────────────────────────────────────────────────────────────────
 * ⚠ A `0` FROM AN EMPTY POPULATION AND A `0` MEANING "NO CONCENTRATION" MUST
 * NOT SHARE A BYTE (AC3). They do not here:
 *   • `status: 'unwired'` ⇒ the provider is absent. Nothing was graded.
 *   • `status: 'empty'`   ⇒ the gate admitted books but they hold no rows.
 *   • `status: 'measured'`⇒ a real reading over a real population.
 * and `maxContract` / `maxUnderlying` are `null` — never a synthetic zero
 * bucket — whenever there is nothing to be the max OF. `shareOfFleetAtRisk` is
 * `null` when the denominator is 0 rather than `0`, for the same reason.
 *
 * ⚠ AND THE DENOMINATOR IS NAMED. `populationGate` publishes WHICH gate owns
 * the rows this grades — `liveEntryGateOpen`, the same predicate
 * `aggregateFleetBound` sums on, derived once in
 * `SignalEngine.getLiveOtmFleetCapitalRow`. A fold whose population is implicit
 * cannot be argued with (TRA-3703: `fleet_reachable_bound` published
 * `evaluated 0` because a tighter sibling upstream ate its population, and
 * nothing in the payload said so).
 *
 * ── Lower bounds ─────────────────────────────────────────────────────────────
 * ⚠ `concentrationIsLowerBound: true` ⇒ THE MAX SHARE BELOW IS SOFT AND SOFT IN
 * THE PERMISSIVE DIRECTION. Two row classes cause it: an UNPRICED row (no
 * usable cost basis — contributes $0 to the fold the cap enforces on, so its
 * concentration is invisible too) and an UNKEYED row (multi-leg, no single OCC
 * — its dollars are in the denominator and in no bucket, which DILUTES every
 * share). Both are counted separately and neither is folded into a bucket:
 * a refusal must never share a column with a finding.
 */

/** One open live row, already priced by `rowOpenPremiumAtRisk`. */
export interface FleetConcentrationPositionRow {
  /** The OSI contract symbol. `null`/'' ⇒ UNKEYED (multi-leg): not foldable by contract. */
  optionSymbol: string | null;
  /** The underlying. `null`/'' ⇒ UNKEYED by name. */
  symbol: string | null;
  expiration: string | null;
  /** `contractsRemaining ?? contracts`; 0 on an unpriced row. */
  contracts: number;
  /** The row's exact contribution to `openPremiumAtRiskUsd`. 0 on an unpriced row. */
  atRiskUsd: number;
  /** `false` ⇒ premium/remaining unusable; counted, never bucketed. */
  priced: boolean;
}

/**
 * One book's offering. `positions: null` is a REFUSAL (the book could not
 * enumerate its rows) and is reported as blind — never as an empty book, which
 * is a finding about a book that holds nothing.
 */
export interface FleetConcentrationBookRow {
  book: string | null;
  liveEntryGateOpen: boolean;
  positions: readonly FleetConcentrationPositionRow[] | null;
}

export interface FleetConcentrationBucket {
  /** OSI symbol on `byContract`; underlying on `byUnderlying`. */
  key: string;
  /** The underlying, on both folds — so a contract bucket is name-readable. */
  symbol: string | null;
  /** Contract folds only; `null` on `byUnderlying` (it spans expiries by design). */
  expiration: string | null;
  atRiskUsd: number;
  contracts: number;
  /** Open rows behind the bucket. Two books × one row each is `2`. */
  rows: number;
  /** Distinct OSI symbols; always 1 on `byContract`. >1 on `byUnderlying` = same name, different strikes. */
  distinctContracts: number;
  /** The contributing books, sorted. THE FIELD THE CEO's REPORT IS ABOUT. */
  books: string[];
  bookCount: number;
  /** `atRiskUsd / fleetAtRiskUsd`, 0..1. `null` ⇒ the denominator is 0. */
  shareOfFleetAtRisk: number | null;
}

export type FleetConcentrationStatus = 'unwired' | 'empty' | 'measured';

export interface FleetConcentrationReport {
  status: FleetConcentrationStatus;
  /** ⛔ AC4 — stated on the wire, not inferred from the absence of a caller. */
  entryPathBehavior: 'advisory_no_refusal';
  refuses: false;
  /** AC3 — the gate that owns the population graded here. */
  populationGate: 'liveEntryGateOpen';
  populationOwner: string;
  /** Books the provider offered. */
  booksChecked: number;
  /** Of those, books the gate admitted. */
  booksEvaluated: number;
  /** Gate-open books that could not enumerate their rows. */
  booksBlind: number;
  blindBooks: string[];
  /** Rows offered by the evaluated books. */
  positionsChecked: number;
  /** Of those, rows that carried a usable basis and a key. */
  positionsEvaluated: number;
  /** Rows with no usable cost basis — $0 to the fold, invisible to concentration. */
  unpricedRows: number;
  /** Rows with no single OCC (multi-leg): dollars in the denominator, in no contract bucket. */
  unkeyedContractRows: number;
  unkeyedContractAtRiskUsd: number;
  /** Rows with no underlying string. */
  unkeyedUnderlyingRows: number;
  unkeyedUnderlyingAtRiskUsd: number;
  /** ⚠ `true` ⇒ every share below is a LOWER bound (see the file header). */
  concentrationIsLowerBound: boolean;
  /** Σ over evaluated rows. Equals Σ `openPremiumAtRiskUsd` over gate-open books. */
  fleetAtRiskUsd: number;
  byContract: FleetConcentrationBucket[];
  byUnderlying: FleetConcentrationBucket[];
  /** `null` when there is nothing to be the max of — never a synthetic zero. */
  maxContract: FleetConcentrationBucket | null;
  maxUnderlying: FleetConcentrationBucket | null;
  /** THE HAZARD: one contract held by more than one gate-open book. */
  multiBookContracts: FleetConcentrationBucket[];
  /** One NAME held by more than one gate-open book, any strike/expiry. */
  multiBookUnderlyings: FleetConcentrationBucket[];
  /** Discloses every term the reading was computed from. */
  reason: string;
}

const POPULATION_OWNER =
  'SignalEngine.getLiveOtmFleetCapitalRow — the same predicate aggregateFleetBound sums on '
  + '(mode live AND tradierLiveOptionsEnabled AND a live options client); NOT `mode`, which '
  + 'reads 3 books on bqb1 where only 2 can place a live order';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Accum {
  key: string;
  symbol: string | null;
  expiration: string | null;
  atRiskUsd: number;
  contracts: number;
  rows: number;
  contractKeys: Set<string>;
  books: Set<string>;
}

function bump(
  into: Map<string, Accum>,
  key: string,
  row: FleetConcentrationPositionRow,
  book: string,
  keepExpiration: boolean,
  /** The already-clamped dollars, so a bucket can never disagree with the total. */
  usd: number,
): void {
  let acc = into.get(key);
  if (acc === undefined) {
    acc = {
      key,
      symbol: row.symbol !== null && row.symbol !== '' ? row.symbol : null,
      expiration: keepExpiration ? row.expiration : null,
      atRiskUsd: 0,
      contracts: 0,
      rows: 0,
      contractKeys: new Set<string>(),
      books: new Set<string>(),
    };
    into.set(key, acc);
  }
  acc.atRiskUsd += usd;
  acc.contracts += Number.isFinite(row.contracts) && row.contracts > 0 ? row.contracts : 0;
  acc.rows += 1;
  if (typeof row.optionSymbol === 'string' && row.optionSymbol !== '') {
    acc.contractKeys.add(row.optionSymbol);
  }
  acc.books.add(book);
}

function finish(accs: Iterable<Accum>, denominatorUsd: number): FleetConcentrationBucket[] {
  const out: FleetConcentrationBucket[] = [];
  for (const a of accs) {
    out.push({
      key: a.key,
      symbol: a.symbol,
      expiration: a.expiration,
      atRiskUsd: round2(a.atRiskUsd),
      contracts: a.contracts,
      rows: a.rows,
      distinctContracts: a.contractKeys.size,
      books: Array.from(a.books).sort(),
      bookCount: a.books.size,
      // ⚠ `null`, never 0 — a share against an empty denominator is not a
      // small share, it is an unanswerable question.
      shareOfFleetAtRisk:
        denominatorUsd > 0 ? Math.round((a.atRiskUsd / denominatorUsd) * 10000) / 10000 : null,
    });
  }
  // Deterministic: dollars desc, then key asc. A grader diffing two reads must
  // not see churn from Map insertion order.
  out.sort((x, y) => (y.atRiskUsd - x.atRiskUsd) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out;
}

/**
 * Fold the fleet's open live rows by contract and by underlying. PURE.
 *
 * `books === null` ⇒ the provider is not wired on this build: `'unwired'`,
 * never an empty measurement (a build serving the route without the provider
 * would otherwise publish "no concentration" over a fleet it never read).
 */
export function gradeFleetConcentration(
  books: readonly FleetConcentrationBookRow[] | null,
): FleetConcentrationReport {
  const base = {
    entryPathBehavior: 'advisory_no_refusal' as const,
    refuses: false as const,
    populationGate: 'liveEntryGateOpen' as const,
    populationOwner: POPULATION_OWNER,
  };
  if (books === null) {
    return {
      ...base,
      status: 'unwired',
      booksChecked: 0,
      booksEvaluated: 0,
      booksBlind: 0,
      blindBooks: [],
      positionsChecked: 0,
      positionsEvaluated: 0,
      unpricedRows: 0,
      unkeyedContractRows: 0,
      unkeyedContractAtRiskUsd: 0,
      unkeyedUnderlyingRows: 0,
      unkeyedUnderlyingAtRiskUsd: 0,
      concentrationIsLowerBound: true,
      fleetAtRiskUsd: 0,
      byContract: [],
      byUnderlying: [],
      maxContract: null,
      maxUnderlying: null,
      multiBookContracts: [],
      multiBookUnderlyings: [],
      reason:
        'fleet concentration UNWIRED — this build serves the route without a position provider; '
        + 'nothing was graded. NOT a reading of zero concentration.',
    };
  }

  const byContract = new Map<string, Accum>();
  const byUnderlying = new Map<string, Accum>();
  const blindBooks: string[] = [];
  let booksEvaluated = 0;
  let positionsChecked = 0;
  let positionsEvaluated = 0;
  let unpricedRows = 0;
  let unkeyedContractRows = 0;
  let unkeyedContractAtRiskUsd = 0;
  let unkeyedUnderlyingRows = 0;
  let unkeyedUnderlyingAtRiskUsd = 0;
  let fleetAtRiskUsd = 0;

  for (const b of books) {
    if (b.liveEntryGateOpen !== true) continue;
    booksEvaluated += 1;
    const label = b.book !== null && b.book !== '' ? b.book : '(unnamed)';
    if (b.positions === null) {
      // A book that cannot be read is not a book holding nothing.
      blindBooks.push(label);
      continue;
    }
    for (const row of b.positions) {
      positionsChecked += 1;
      if (row.priced !== true) {
        unpricedRows += 1;
        continue;
      }
      // `!(x > 0)` and not `x <= 0`: a NaN at-risk must land in the refusing
      // branch, not in the arithmetic — one NaN would poison the whole fleet
      // total and read as a number until something compared it (TRA-3486).
      if (!Number.isFinite(row.atRiskUsd)) {
        unpricedRows += 1;
        continue;
      }
      const usd = row.atRiskUsd > 0 ? row.atRiskUsd : 0;
      positionsEvaluated += 1;
      fleetAtRiskUsd += usd;
      const occ = typeof row.optionSymbol === 'string' && row.optionSymbol !== ''
        ? row.optionSymbol
        : null;
      const name = typeof row.symbol === 'string' && row.symbol !== '' ? row.symbol : null;
      if (occ === null) {
        unkeyedContractRows += 1;
        unkeyedContractAtRiskUsd += usd;
      } else {
        bump(byContract, occ, row, label, true, usd);
      }
      if (name === null) {
        unkeyedUnderlyingRows += 1;
        unkeyedUnderlyingAtRiskUsd += usd;
      } else {
        bump(byUnderlying, name, row, label, false, usd);
      }
    }
  }

  const total = round2(fleetAtRiskUsd);
  const contractBuckets = finish(byContract.values(), fleetAtRiskUsd);
  const underlyingBuckets = finish(byUnderlying.values(), fleetAtRiskUsd);
  const lowerBound =
    unpricedRows > 0 || unkeyedContractRows > 0 || unkeyedUnderlyingRows > 0
    || blindBooks.length > 0;
  const status: FleetConcentrationStatus = positionsEvaluated > 0 ? 'measured' : 'empty';
  const maxContract = contractBuckets.length > 0 ? contractBuckets[0]! : null;
  const maxUnderlying = underlyingBuckets.length > 0 ? underlyingBuckets[0]! : null;

  const pct = (b: FleetConcentrationBucket | null): string =>
    b === null || b.shareOfFleetAtRisk === null
      ? 'n/a'
      : `${(b.shareOfFleetAtRisk * 100).toFixed(1)}%`;

  const reason = status === 'empty'
    ? `fleet concentration EMPTY — ${String(booksEvaluated)} book(s) passed liveEntryGateOpen and `
      + `${String(positionsChecked)} row(s) were offered, of which 0 were gradeable`
      + (blindBooks.length > 0 ? `; ${String(blindBooks.length)} book(s) BLIND` : '')
      + '. This is a statement about an empty population, NOT a reading of zero concentration.'
    : `fleet concentration MEASURED over ${String(booksEvaluated)} gate-open book(s) / `
      + `${String(positionsEvaluated)} row(s), $${total.toFixed(2)} at risk; top contract `
      + `${maxContract?.key ?? 'n/a'} $${(maxContract?.atRiskUsd ?? 0).toFixed(2)} `
      + `(${pct(maxContract)}, ${String(maxContract?.bookCount ?? 0)} book(s)); top underlying `
      + `${maxUnderlying?.key ?? 'n/a'} $${(maxUnderlying?.atRiskUsd ?? 0).toFixed(2)} `
      + `(${pct(maxUnderlying)}); ADVISORY — refuses nothing`
      + (lowerBound
        ? `; LOWER BOUND (${String(unpricedRows)} unpriced, ${String(unkeyedContractRows)} unkeyed, `
          + `${String(blindBooks.length)} blind book(s))`
        : '');

  return {
    ...base,
    status,
    booksChecked: books.length,
    booksEvaluated,
    booksBlind: blindBooks.length,
    blindBooks: blindBooks.slice().sort(),
    positionsChecked,
    positionsEvaluated,
    unpricedRows,
    unkeyedContractRows,
    unkeyedContractAtRiskUsd: round2(unkeyedContractAtRiskUsd),
    unkeyedUnderlyingRows,
    unkeyedUnderlyingAtRiskUsd: round2(unkeyedUnderlyingAtRiskUsd),
    concentrationIsLowerBound: lowerBound,
    fleetAtRiskUsd: total,
    byContract: contractBuckets,
    byUnderlying: underlyingBuckets,
    maxContract,
    maxUnderlying,
    multiBookContracts: contractBuckets.filter(b => b.bookCount > 1),
    multiBookUnderlyings: underlyingBuckets.filter(b => b.bookCount > 1),
    reason,
  };
}
