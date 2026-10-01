import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type {
  OptionTradeCloseBasis,
  OptionTradeCloseUnmeasured,
  OptionTradeJournalRecord,
  OptionTradeOutcome,
} from './option-trade-journal.js';
import { outcomeForR } from './option-trade-journal.js';
import {
  allocate,
  claimFillsBySiblingRows,
  ENTRY_MATCH_WINDOW_MS,
  isFinitePositive,
  partitionClaimedFills,
  round2,
  round4,
  type AllocatedFill,
  type ExcludedFill,
  type FillClaims,
} from './tra3485-stale-open-repair.js';

// TRA-2819 asks 1+2 (CTO, 2026-08-14) — restate the MONEY on live journal rows
// that are already closed, from the app's own arithmetic onto broker truth.
//
// ── What is actually wrong, after the ingestion fix ──────────────────────────
//
// The original P0 was that exit fills were never ingested at all: three live
// round trips that settled +$713.73 at Tradier were booked −$2.00, because a
// boot reconcile force-closed them at the last local MARK. That half is fixed —
// the exits now carry the broker's fill prices (2.78 / 0.12 / 0.10, matching the
// ledger's `filledPrice` to the cent).
//
// What is left is smaller, permanent, and in the direction that flatters. The
// same three rows now read +$739.00 against the broker's +$713.73, and the
// +$25.27 residual is not noise — it decomposes EXACTLY, every cent of it:
//
//   +23.00  entry basis. An engine-opened row books `premiumPaid = signal.mark`,
//           the scanner's pre-trade NBBO MID, and the journal's `entryMarkUsd`
//           freezes it. AAPL filled at 1.04 against a 0.995 mid: 0.045 × 4 × 100
//           = 18.00. Same shape on both SPY legs (2.00 and 3.00).
//           `restateEngineOpenedBasis` (TRA-2889) fixes this on the POSITION,
//           but only while it is still open and only once the 30s reconcile
//           reaches it — these three went phantom before it ever did.
//    +2.27  commission. Nothing subtracts it, because it is not knowable at
//           close time: the order-status payload carries no commission and the
//           account HISTORY endpoint only publishes it after settlement
//           (TRA-1929). So the close path books a GROSS number and no later
//           pass ever nets it down.
//
// ── The control that makes this diagnosis safe to act on ────────────────────
//
// A fourth live row sits in the same store, on the same book, closed the same
// week: `PLTR260911C00170000`, the round trip TRA-3485 reconstructed. It reads
// 155.75 against the broker's 155.75 — exact. It is exact because it was priced
// from ledger FILLS and netted of MEASURED fees, which is precisely the
// arithmetic below. So this is not a new theory about what broker truth is; it
// is the arithmetic that already produced a broker-exact row in production,
// pointed at the three rows the engine wrote instead.
//
// That is also why this module imports `allocate` from the TRA-3485 planner
// rather than reimplementing it. A second copy of the fee pro-rating rule is how
// the reconstructed rows and the restated rows would silently stop agreeing.
//
// ── Refusal is a first-class outcome, and stricter here than in TRA-3485 ─────
//
// TRA-3485 tolerated `feesComplete: false` — it was CREATING a row where none
// existed, and a fee-incomplete row beats no row. This module OVERWRITES a
// number with one that claims to be broker-settled, so it refuses outright when
// any allocated leg's fee is unmeasured. `fees: null` means UNMEASURED, not free
// (TRA-1707); a GROSS figure wearing a broker-truth label is strictly worse than
// the wrong figure it replaced, because it stops anyone from looking again.

// ── The third treatment (TRA-4947) ──────────────────────────────────────────
//
// `restate` is "I have a broker number, write it". `skip` is "I have no number,
// leave the row alone". The 2026-09-25 SOFI row is neither: there is no broker
// number AND the figure already on the row was never priced against a fill, so
// leaving it alone preserves a fabrication. `unmeasure` is the honest write —
// `realizedPnlUsd: null`, `realizedR: null`, `outcome: 'UNMEASURED'`.
//
// `skip` stays the default for every other refusal, and that is not timidity:
// most skipped rows hold perfectly good numbers from a real fill that this pass
// simply could not re-derive, and `fees_unmeasured` in particular is TEMPORARY
// (the fee reconcile back-fills a day after settlement). Nulling those would
// destroy recoverable information.
//
// ── THE PREDICATE, and why it is spelled this way ───────────────────────────
//
// `exitReason === 'broker_reconcile' && brokerOrderId === null`, conjunctively,
// plus a refusal label from {@link UNPRICEABLE_SKIP_REASONS} below.
//
// NEVER `brokerOrderId === null` alone. That widening shipped as `7b2f9b50`,
// served bqb1 from 00:25:10Z to 00:37:17Z on 2026-09-25 and was reverted in
// `a73706dc`; it cost nothing only because the market was closed.
// `queueJournalClose` has 13 call sites and exactly 2 pass a `brokerOrderId`
// (`finalizePendingExit`, `recordImportedFill`). The other 11 — `tp1`,
// `assigned`, `called_away`, `partial_drain`, every demo/paper exit, every
// expiry settle — default to null while carrying a perfectly real
// `position.pnl`. MEASURED on the live tape 2026-10-01T17:08Z (serving commit
// `faae9388`): of 27 closed live export rows, 18 carry `broker_order_id: null`
// and only 9 carry one, so the widened form sweeps TWO THIRDS of the tape.
// With `exitReason` ANDed in, the live population is exactly 1 — row
// `34f1ee99`. The other `broker_reconcile` row, `a2f9c8cd`
// (`NOK261002C00010500`), carries `broker_order_id 144350660` and a real
// −$22.50, and the conjunction correctly spares it.
//
// `exitReason` is the only surviving marker of the synthesis, and a PRICE test
// cannot substitute for it: the reconcile closes at `breakEvenFill =
// opt.premiumPaid`, so the fabricated figure is a finite number, not an absent
// one. `position.pnl == null` never fires.
//
// ⚠️ Grading this predicate off `closeBasisSweep.lastRows` on
// `/api/health/option-journal` is not possible and must not be attempted: that
// projection carries 10 keys and NEITHER `exitReason` nor `brokerOrderId`, so
// both conjuncts read `undefined` there and any AND over them is vacuous. Read
// the full plan off the dry-run route, which is why `brokerOrderId` is published
// on {@link CloseBasisPlanRow} below.

/** How the restatement proposes to treat one closed live row. */
export type CloseBasisTreatment = 'restate' | 'skip' | 'unmeasure';

/**
 * TRA-4947 — the refusal labels that mean "this pass LOOKED at the fill ledger
 * and could not establish a price for a leg". Only these qualify a row for the
 * `unmeasure` treatment.
 *
 * An ALLOW-list, not a deny-list, and that direction is deliberate: a deny-list
 * silently admits the next `CloseBasisSkipReason` anybody adds, and the thing on
 * the other side of this gate is a money column. Four reasons are excluded, each
 * for its own reason:
 *
 *   • `already_restated` — `pnlBasis: 'broker-fill'`. The figure IS broker
 *     truth; nulling it is a strict loss. (Also unreachable: checked first.)
 *   • `zero_delta` — the arithmetic reached the row, priced it, and agreed. That
 *     is the positive control for the whole pass, not a candidate.
 *   • `fees_unmeasured` — TEMPORARY. Both legs are there and priced; only the
 *     fee reconcile is behind. Re-running later restates it properly.
 *   • `no_option_symbol` / `no_contract_count` / `no_at_risk_basis` — the pass
 *     never got as far as the ledger. These are structural defects in the row
 *     and want their own remedy, not a retraction.
 */
export const UNPRICEABLE_SKIP_REASONS: readonly CloseBasisSkipReason[] = [
  'no_entry_fill_in_window',
  'fills_claimed_by_sibling',
  'entry_partially_covered',
  'entry_price_unmeasured',
  'no_exit_fill_in_window',
  'exit_partially_covered',
  'exit_price_unmeasured',
];

/**
 * TRA-4947 — does this row's own close prove its figure was never priced against
 * a fill? The conjunction, in one place, so there is exactly one spelling of it.
 */
export function isUnpricedReconcileClose(row: {
  exitReason?: string | null;
  brokerOrderId?: string | number | null;
}): boolean {
  // `== null` covers both null and an absent key. A numeric order id of 0 is a
  // real handle and must NOT read as absent, which is why this is not `!`.
  return row.exitReason === 'broker_reconcile' && row.brokerOrderId == null;
}

/**
 * Why a row was skipped. Named rather than boolean because the denominator must
 * never be implicit: a pass that matched nothing and a pass that matched
 * everything and agreed produce the same journal, and only the reasons tell them
 * apart. `zero_delta` is the one that matters most — it means the engine's
 * figure ALREADY equals broker truth, so the row is evidence the close path is
 * healthy, not evidence the pass failed to reach it.
 */
export type CloseBasisSkipReason =
  | 'already_restated'
  | 'no_option_symbol'
  | 'no_contract_count'
  | 'no_at_risk_basis'
  /**
   * TRA-4025 — the contract HAS fills, but every one is already the entry or
   * exit of ANOTHER journal row. Named separately from `no_entry_fill_in_window`
   * because the remedy differs: the window says "look wider", this says "the
   * fills exist and belong to someone else" (the BAC `6bbc5d17` shape).
   */
  | 'fills_claimed_by_sibling'
  | 'no_entry_fill_in_window'
  | 'entry_partially_covered'
  | 'entry_price_unmeasured'
  | 'no_exit_fill_in_window'
  | 'exit_partially_covered'
  | 'exit_price_unmeasured'
  | 'fees_unmeasured'
  /**
   * TRA-4947 — the row is an unpriced reconcile close that has ALREADY been
   * retracted (`outcome: 'UNMEASURED'`, money null). The idempotence twin of
   * `already_restated`, and named for the same reason: without it the row would
   * re-report as `unmeasure` on every pass forever, the write would be refused
   * by the fold each time, and a permanently-refusing pass would be
   * indistinguishable from a broken one.
   */
  | 'already_unmeasured'
  | 'zero_delta';

/**
 * How far past the journalled `closeTs` a `sell_to_close` fill may sit and still
 * be THIS row's exit.
 *
 * The upper bound exists only on this pass and not on TRA-3485's, and it is the
 * one guard a closed row can afford that an open row cannot: a closed row knows
 * when it closed. Without it, a LATER re-acquisition of the same OCC symbol —
 * this book trades the same contracts repeatedly — would have its exit pulled
 * back onto an older row and reprice a settled trade off somebody else's fill.
 *
 * Generous in the same direction as the entry window, because `closeTs` is
 * itself sometimes the reconcile's clock rather than the fill's: on the three
 * 2026-07-30 rows the exit fills land within 1ms of `closeTs`, but a row
 * force-closed by a boot reconcile carries a `closeTs` minutes to days AFTER its
 * fills. That direction is safe — those fills are still `>= lastEntryTs` and
 * still before the close — so the bound only has to keep out the NEXT position.
 */
export const EXIT_MATCH_GRACE_MS = 10 * 60 * 1000;

/** One row's decision, with every number it was reached from. */
export interface CloseBasisPlanRow {
  id: string;
  symbol: string;
  optionSymbol: string | null;
  mode: 'demo' | 'live';
  openTs: number;
  closeTs: number | null;
  contracts: number | null;
  atRiskUsd: number;
  exitReason: string | null;
  /**
   * TRA-4947 — the row's own close order, PUBLISHED. It is half of the
   * `unmeasure` predicate, and until this ticket it was readable only inside
   * `planOne`: the first attempt to grade the predicate from outside read
   * `undefined` on all 32 live rows and so evaluated `brokerOrderId === null`
   * as vacuously TRUE for every one of them. A conjunct nobody can see from the
   * published plan is a conjunct nobody can grade.
   */
  brokerOrderId: string | number | null;
  treatment: CloseBasisTreatment;
  skipReason: CloseBasisSkipReason | null;
  /** Human-readable, row-by-row auditable. */
  reason: string;
  /** What the journal says today. */
  realizedPnlUsdBefore: number | null;
  /** What broker fills say, net of measured fees; `null` when the row is skipped. */
  realizedPnlUsdAfter: number | null;
  /** `after − before`. Negative means the app was OVERSTATING this trade. */
  deltaUsd: number | null;
  /** The journal's frozen entry mid, and the broker's actual entry fill. */
  entryMarkUsd: number | null;
  entryFillPremium: number | null;
  exitFillPremium: number | null;
  feesUsd: number | null;
  /** Split of `deltaUsd` into its two independent causes. They must sum to it. */
  entryBasisDeltaUsd: number | null;
  feeDeltaUsd: number | null;
  /**
   * TRA-4947 — the audit record to write, present iff
   * `treatment === 'unmeasure'`. Mutually exclusive with `basis`: one of them
   * says "here is the number", the other says "there is no number".
   */
  unmeasured?: OptionTradeCloseUnmeasured;
  allocations: AllocatedFill[];
  /**
   * Ledger fills on this contract that were NOT claimed, each with a why.
   * Includes (TRA-4025) fills wholly owned by a SIBLING journal row, named.
   */
  excluded: ExcludedFill[];
  /** The restatement to write; present iff `treatment === 'restate'`. */
  basis?: OptionTradeCloseBasis;
}

export interface CloseBasisPlan {
  /** Closed live rows considered. */
  scanned: number;
  rows: CloseBasisPlanRow[];
  /**
   * TRA-4947 — `unmeasure` is counted SEPARATELY and is not folded into either
   * of the other two. It is not a restatement (it writes no money) and it is not
   * a skip (it writes), so adding it to either would make the acceptance figure
   * for that treatment wrong in a direction nobody would notice.
   */
  counts: { restate: number; skip: number; unmeasure: number };
  /** Σ `deltaUsd` over the `restate` rows — what the pass would move the book by. */
  netDeltaUsd: number;
  /** Per-reason skip census, so the denominator is never implicit. */
  skipsByReason: Record<string, number>;
}

/**
 * A restatement below this many dollars is treated as agreement, not as a
 * correction.
 *
 * Half a cent: the journal stores a float (`713.9999999999999` is a real stored
 * value), so an exact compare would restate rows that already agree and burn an
 * append line per pass per row — and, worse, would make the idempotency check
 * below unreadable. Never `===` a computed float in a criterion.
 */
export const ZERO_DELTA_EPSILON_USD = 0.005;

/**
 * Plan the restatement. PURE — no I/O, no clock, no store.
 *
 * `rows` is filtered to live, CLOSED rows here rather than trusting the caller,
 * so no call site can widen the blast radius by passing the demo book. Demo rows
 * are excluded on principle and not merely by accident: a demo fill has no
 * broker behind it, so there is no truth to restate toward, and the modelled
 * `demoSlippagePct` haircut baked into their `premiumPaid` is deliberate.
 */
export function planCloseBasisRestate(
  rows: OptionTradeJournalRecord[],
  ledger: LiveOptionFillRecord[],
): CloseBasisPlan {
  const live = rows.filter((r) => r.mode === 'live' && r.outcome !== 'OPEN');
  const byContract = new Map<string, LiveOptionFillRecord[]>();
  for (const f of ledger) {
    if (f.mode !== 'live') continue;
    const list = byContract.get(f.optionSymbol) ?? [];
    list.push(f);
    byContract.set(f.optionSymbol, list);
  }

  // TRA-4025 (AC4) — the SAME sibling-claim pass the stale-OPEN planner runs
  // (TRA-3986), over ALL live rows (open and closed): a fill that is another
  // row's entry or exit is not on offer here either. Without it this pass would
  // re-price the desk's BAC row `6bbc5d17` off the ENGINE's 1.65 entry and 0.91
  // exit — the very write TRA-4004 superseded — the moment it saw the row
  // without `pnlBasis`.
  const claims = claimFillsBySiblingRows(rows, byContract);

  const planned = [...live]
    .sort((a, b) => a.openTs - b.openTs)
    .map((row) => planOne(row, byContract.get(row.optionSymbol ?? '') ?? [], claims));

  const restate = planned.filter((r) => r.treatment === 'restate');
  const unmeasure = planned.filter((r) => r.treatment === 'unmeasure');
  const skipsByReason: Record<string, number> = {};
  for (const r of planned) {
    if (r.skipReason) skipsByReason[r.skipReason] = (skipsByReason[r.skipReason] ?? 0) + 1;
  }
  return {
    scanned: live.length,
    rows: planned,
    counts: {
      restate: restate.length,
      // `skip` is now the REMAINDER of both writing treatments, not of
      // `restate` alone. Leaving it as `planned.length - restate.length` would
      // have quietly counted every `unmeasure` row as a skip.
      skip: planned.length - restate.length - unmeasure.length,
      unmeasure: unmeasure.length,
    },
    // Σ over `restate` only, unchanged. An `unmeasure` row's `deltaUsd` is null
    // by construction (the after-figure is empty, so the difference is not a
    // number), and folding it in as 0 would publish "this pass moved the book by
    // nothing" over a pass that withdrew a figure.
    netDeltaUsd: round2(restate.reduce((s, r) => s + (r.deltaUsd ?? 0), 0)),
    skipsByReason,
  };
}

function planOne(row: OptionTradeJournalRecord, allFills: LiveOptionFillRecord[], claims: FillClaims): CloseBasisPlanRow {
  // TRA-4025 — shared helper, not a re-spelling: what a sibling row already
  // owns leaves the candidate set here, named in `excluded`.
  const { fills, available, excluded: claimedExcluded } = partitionClaimedFills(row.id, allFills, claims);
  const before = Number.isFinite(row.realizedPnlUsd) ? (row.realizedPnlUsd as number) : null;
  const base = {
    id: row.id,
    symbol: row.symbol,
    optionSymbol: row.optionSymbol ?? null,
    mode: row.mode,
    openTs: row.openTs,
    closeTs: Number.isFinite(row.closeTs) ? (row.closeTs as number) : null,
    contracts: row.contracts ?? null,
    atRiskUsd: row.atRiskUsd,
    exitReason: row.exitReason ?? null,
    // `?? null` not `|| null`: a numeric order id of 0 is a real handle.
    brokerOrderId: row.brokerOrderId ?? null,
    realizedPnlUsdBefore: before,
    realizedPnlUsdAfter: null,
    deltaUsd: null,
    entryMarkUsd: Number.isFinite(row.entryMarkUsd) ? (row.entryMarkUsd as number) : null,
    entryFillPremium: null,
    exitFillPremium: null,
    feesUsd: null,
    entryBasisDeltaUsd: null,
    feeDeltaUsd: null,
    allocations: [] as AllocatedFill[],
    excluded: claimedExcluded,
  };
  // TRA-4947 — every refusal path routes through here, so the third treatment is
  // installed ONCE rather than spliced into each of the seven `return skip(...)`
  // sites. That matters beyond tidiness: the predicate is narrow and a
  // hand-copied conjunct is how one of the seven would end up spelled
  // `brokerOrderId == null` alone.
  //
  // The UPGRADE is conditioned on BOTH halves and never on the skip reason
  // alone. A row whose basis cannot be established is the NORMAL state of most
  // skipped rows (11 of 32 live rows read `no_entry_fill_in_window` on
  // 2026-10-01), and nulling those would destroy real figures from real fills;
  // what makes this row different is that its own close proves no fill was ever
  // consulted.
  const skip = (skipReason: CloseBasisSkipReason, reason: string, extra: Partial<CloseBasisPlanRow> = {}): CloseBasisPlanRow => {
    const planned: CloseBasisPlanRow = { ...base, ...extra, treatment: 'skip', skipReason, reason };
    if (!UNPRICEABLE_SKIP_REASONS.includes(skipReason)) return planned;
    if (!isUnpricedReconcileClose(row)) return planned;
    return {
      ...planned,
      treatment: 'unmeasure',
      reason:
        `${reason}. AND this row's own close proves its journalled figure was never priced against a `
        + 'fill either: exitReason broker_reconcile with no brokerOrderId, which the reconcile writes at '
        + '`breakEvenFill = premiumPaid` (TRA-3978). Leaving '
        + `${planned.realizedPnlUsdBefore} on it would preserve a fabrication, so the honest write is `
        + 'realizedPnlUsd null / realizedR null / outcome UNMEASURED (TRA-4857 ruling, TRA-4859)',
      unmeasured: {
        reason:
          `unpriced ${String(row.exitReason)} close with no brokerOrderId; the close-basis pass refused to `
          + `establish a broker basis (${skipReason}), and the figure on the row was synthesised at `
          + 'breakEvenFill = premiumPaid rather than observed on a fill',
        issue: 'TRA-4947 (TRA-4859; ruling TRA-3978 comment 821c3fef; forward path TRA-4857)',
        skipReason,
      },
    };
  };

  // Idempotency. A row already carrying broker provenance is not re-priced: a
  // second pass would re-derive the same number, but it would also append a
  // second amend line per row per run, and `netDeltaUsd` — the acceptance
  // figure — would then read 0 on a re-run and be indistinguishable from a pass
  // that found nothing to do.
  if (row.pnlBasis === 'broker-fill') {
    return skip('already_restated', 'row already carries pnlBasis broker-fill; nothing to restate');
  }
  // TRA-4947 — idempotence for the third treatment, and it must sit AHEAD of
  // every other refusal. A retracted row still has no establishable basis, so it
  // would otherwise fall into `no_entry_fill_in_window`, be upgraded to
  // `unmeasure` again, and have the write refused by the fold on every pass
  // forever. Keyed on BOTH the label and the emptiness of the money column: an
  // `UNMEASURED` outcome beside a surviving figure is a half-applied row and
  // must still be finished.
  if (row.outcome === 'UNMEASURED' && before === null) {
    return skip(
      'already_unmeasured',
      'row already reads outcome UNMEASURED with realizedPnlUsd null; the unbacked figure has already been retracted (TRA-4947)',
    );
  }
  if (!row.optionSymbol) {
    return skip('no_option_symbol', 'row carries no optionSymbol; cannot join to the fill ledger');
  }
  const contracts = row.contracts;
  if (!isFinitePositive(contracts)) {
    return skip(
      'no_contract_count',
      'journal row carries no contract count; the round trip cannot be priced without inferring its size',
    );
  }
  if (!isFinitePositive(row.atRiskUsd)) {
    // R is `realizedPnlUsd / atRiskUsd`. Restating the money without a
    // denominator would leave `realizedR` describing the OLD figure, and R is
    // what `outcome` and every expectancy fold read — a row whose P&L and R
    // disagree is worse than one that is uniformly wrong.
    return skip('no_at_risk_basis', 'row carries no atRiskUsd; realizedR could not be recomputed alongside the money');
  }

  // TRA-4025 — the contract has fills and every one is a sibling's. Refuse by
  // name rather than fall through to "none in the window": the fills are right
  // there, and the honest reading is that they are spoken for.
  if (allFills.length > 0 && fills.length === 0) {
    return skip(
      'fills_claimed_by_sibling',
      `ledger has ${allFills.filter((f) => f.side === 'buy_to_open').length} buy_to_open / `
        + `${allFills.filter((f) => f.side === 'sell_to_close').length} sell_to_close on this contract, and every one is `
        + 'already the entry or exit of another journal row — re-pricing this row off them would book a sibling\'s '
        + 'round trip twice (the 2026-08-21 BAC write, TRA-4004)',
    );
  }

  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  const excluded: CloseBasisPlanRow['excluded'] = [...claimedExcluded];

  const entryCandidates = sorted.filter(
    (f) => f.side === 'buy_to_open' && Math.abs(f.ts - row.openTs) <= ENTRY_MATCH_WINDOW_MS,
  );
  for (const f of sorted) {
    if (f.side === 'buy_to_open' && !entryCandidates.includes(f)) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why: `buy_to_open ${Math.round(Math.abs(f.ts - row.openTs) / 1000)}s from this row's openTs, outside the ${ENTRY_MATCH_WINDOW_MS / 1000}s entry window — belongs to a different position on the same contract`,
      });
    }
  }
  if (entryCandidates.length === 0) {
    return skip(
      'no_entry_fill_in_window',
      `ledger has ${sorted.filter((f) => f.side === 'buy_to_open').length} buy_to_open on this contract but none inside this row's entry window; the broker entry basis cannot be established`,
      { excluded },
    );
  }

  const entry = allocate(entryCandidates, contracts, available);
  if (entry.remaining > 0) {
    return skip(
      'entry_partially_covered',
      `entry fills cover only ${contracts - entry.remaining}/${contracts} journalled contracts; pricing the whole position off a fraction of its basis is how a wrong number hides`,
      { excluded, allocations: entry.allocations },
    );
  }
  if (entry.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return skip('entry_price_unmeasured', 'an allocated entry fill carries no filledPrice; the broker entry basis is unmeasured', {
      excluded,
      allocations: entry.allocations,
    });
  }

  // Exit legs are bounded on BOTH sides: at or after the last entry fill (so an
  // earlier position's exit on the same contract cannot be claimed) and at or
  // before this row's own close (so a LATER position's exit cannot be either).
  const lastEntryTs = Math.max(...entry.allocations.map((a) => a.ts));
  const closeCeiling = base.closeTs === null ? Infinity : base.closeTs + EXIT_MATCH_GRACE_MS;
  const windowed = sorted.filter(
    (f) => f.side === 'sell_to_close' && f.ts >= lastEntryTs && f.ts <= closeCeiling,
  );
  // TRA-4082 — a witnessed order beats the clock. When the row names its own
  // close order (`brokerOrderId`) and the ledger holds a `sell_to_close` under
  // that order inside the window, THAT fill is the exit; the window's other
  // sells are another lot's. Measured 2026-08-26T14:01Z on RIG `8a849902`: the
  // row's primary carried order 143384264 (0.15, 08-26) and the window held the
  // sibling's 143048620 (0.18, 08-24) two days earlier; oldest-first took 0.18
  // and priced this row's close off the other lot's fill. The sibling-claim
  // pass keys its exit claim on the order id already; the allocation here did
  // not, so a row could be handed its own order by `claims` and still price off
  // a neighbour. Fallback (no order on the row, or none of the window's fills
  // carries it) is the window rule, unchanged.
  const rowOrder = row.brokerOrderId == null ? null : String(row.brokerOrderId);
  const ownOrder = rowOrder === null
    ? []
    : windowed.filter((f) => f.orderId != null && String(f.orderId) === rowOrder);
  const exitCandidates = ownOrder.length > 0 ? ownOrder : windowed;
  for (const f of sorted) {
    if (f.side === 'sell_to_close' && !exitCandidates.includes(f)) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why:
          windowed.includes(f)
            ? `sell_to_close inside the window under order ${String(f.orderId)}, but this row's own close is order ${rowOrder} and the ledger holds that fill — a witnessed order beats the clock (TRA-4082)`
            : f.ts < lastEntryTs
              ? "sell_to_close predates this row's entry fill; it closed an earlier position on the same contract"
              : `sell_to_close ${Math.round((f.ts - (base.closeTs ?? 0)) / 1000)}s after this row's closeTs, outside the ${EXIT_MATCH_GRACE_MS / 1000}s grace — it closed a LATER position on the same contract`,
      });
    }
  }
  if (exitCandidates.length === 0) {
    return skip(
      'no_exit_fill_in_window',
      'no sell_to_close between this row\'s entry fill and its close; the realized proceeds cannot be established from broker truth',
      { excluded, allocations: entry.allocations },
    );
  }

  const exit = allocate(exitCandidates, contracts, available);
  if (exit.remaining > 0) {
    return skip(
      'exit_partially_covered',
      `exit fills cover only ${contracts - exit.remaining}/${contracts} journalled contracts; the journal asserts a completed round trip that broker truth does not support`,
      { excluded, allocations: [...entry.allocations, ...exit.allocations] },
    );
  }
  if (exit.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return skip('exit_price_unmeasured', 'an allocated exit fill carries no filledPrice; the realized proceeds are unmeasured', {
      excluded,
      allocations: [...entry.allocations, ...exit.allocations],
    });
  }

  const allocations = [...entry.allocations, ...exit.allocations];

  // Fees must be COMPLETE. See the header: this pass replaces a number with one
  // that claims to be broker-settled, so a null fee is a refusal and never a
  // zero. The reconcile back-fills fees a day after settlement, so the honest
  // answer for a just-closed row is "not yet", and the pass will pick it up on a
  // later run — which is exactly why the skip is named rather than silent.
  if (allocations.some((a) => a.allocatedFees === null)) {
    const missing = allocations.filter((a) => a.allocatedFees === null).length;
    return skip(
      'fees_unmeasured',
      `${missing}/${allocations.length} allocated fills carry fees: null (UNMEASURED, not free — TRA-1707). A gross figure labelled broker-settled is worse than the wrong figure it would replace; re-run once the fee reconcile has back-filled this lot`,
      { excluded, allocations },
    );
  }

  const entryCost = entry.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const exitProceeds = exit.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const feesUsd = round2(allocations.reduce((s, a) => s + (a.allocatedFees ?? 0), 0));
  const realizedPnlUsd = round2(exitProceeds - entryCost - feesUsd);

  // `atRiskUsd` is the basis captured AT OPEN and is what makes R comparable
  // across rows — the same call TRA-3485 made on the reconstructed closes. It is
  // NOT the fill cost and is deliberately not replaced by it here: restating the
  // R denominator would silently re-scale every historical R this cohort
  // contributes to, which is a different ruling than "book the broker's money".
  const realizedR = realizedPnlUsd / row.atRiskUsd;
  // Re-derived, never carried over. A fee-and-basis correction is small in
  // dollars and can still move a row across the ±0.1 scratch band, and R is not
  // rounded before the classification: `-0.109` is a LOSS, and a planner that
  // rounds it to one decimal calls it SCRATCH.
  const outcome: OptionTradeOutcome = outcomeForR(realizedR);

  const entryFillPremium = round4(entryCost / contracts / 100);
  const exitFillPremium = round4(exitProceeds / contracts / 100);
  const deltaUsd = before === null ? null : round2(realizedPnlUsd - before);
  // The two independent causes, published separately so the correction can be
  // checked against the mechanism rather than taken on trust. They sum to
  // `deltaUsd` whenever the engine's figure was `(exit − entryMark) × n × 100`,
  // and a row where they DON'T sum is a row whose close was wrong for some third
  // reason — which is worth seeing, so this reports rather than asserts.
  const entryBasisDeltaUsd =
    base.entryMarkUsd === null ? null : round2(-(entryFillPremium - base.entryMarkUsd) * contracts * 100);

  const priced = {
    ...base,
    realizedPnlUsdAfter: realizedPnlUsd,
    deltaUsd,
    entryFillPremium,
    exitFillPremium,
    feesUsd,
    entryBasisDeltaUsd,
    feeDeltaUsd: -feesUsd,
    allocations,
    excluded,
  };

  // Already broker-exact. Reported WITH its numbers rather than as a bare skip:
  // this is the shape the PLTR row (reconstructed by TRA-3485 from these same
  // fills) lands in, and it is the positive control for the whole pass — a row
  // the arithmetic reaches, prices, and finds nothing wrong with.
  if (deltaUsd !== null && Math.abs(deltaUsd) < ZERO_DELTA_EPSILON_USD) {
    return {
      ...priced,
      treatment: 'skip',
      skipReason: 'zero_delta',
      reason:
        `broker fills agree with the journal to within ${ZERO_DELTA_EPSILON_USD} USD `
        + `(${before} vs ${realizedPnlUsd}) — this row was already priced from fills and netted of fees, `
        + 'so it is evidence the close path is healthy, not a row that needs correcting',
    };
  }

  return {
    ...priced,
    treatment: 'restate',
    skipReason: null,
    reason:
      `broker fills on BOTH legs (${entry.allocations.length} entry / ${exit.allocations.length} exit slice(s), `
      + `${contracts}/${contracts} contracts, fees measured on all ${allocations.length}). Restating the money from `
      + `entry mark ${base.entryMarkUsd ?? '?'} to entry fill ${entryFillPremium} and netting ${feesUsd} of commission; `
      + `closeTs / exitReason / holdDays unchanged`,
    basis: {
      realizedPnlUsd,
      realizedR: round4(realizedR),
      outcome,
      feesUsd,
      entryFillPremium,
      exitFillPremium,
    },
  };
}
