/**
 * TRA-3101 — a missing daily balance snapshot renders as a FLAT `$0.00` day.
 *
 * The live calendar's `tradier-balance` cell is `todayBalance − prevBalance −
 * cashFlow`. `findPreviousBalanceSnapshot` returns the nearest earlier row and
 * nothing ever asks whether that row is a COPY of the target day's own value.
 * When a snapshot write fails (the 2026-07-30..08-03 ENOSPC-on-inodes outage,
 * TRA-2817 — and a second, still-unidentified source that hit June), the
 * reconcile subtracts a stale anchor from itself and books exactly `0.00`.
 *
 * ⛔ **`0.00` is the same value a genuine quiet day produces.** `CalendarTab`
 * colours only `> 0` / `< 0`, so the cell renders neutral-flat. There is no
 * absence state: the calendar cannot say "I do not know what happened on this
 * day", and a failed snapshot is pixel-identical to a flat market. That is why
 * seven of these survived from June to August unnoticed.
 *
 * The one that proves it is a defect and not a quiet day is **2026-06-12**: the
 * broker's own `gainloss.csv` books **−$141.72** of realized option closes that
 * day (META, AAPL, RKLB) while the cell reads `$0.00`. An account cannot end a
 * day at the identical cent it started it on when it realized a $141.72 loss.
 *
 * ## What this module does — and deliberately does NOT do
 *
 * It CLASSIFIES. It never repairs. A stale anchor means the equity series has a
 * HOLE, and inventing a value to fill it is precisely how the original
 * phantom-green calendar happened (TRA-2864). The output is a verdict the
 * caller stamps onto the row as `pnlUnknown`, so the cell can render an absence
 * state instead of a number nobody can stand behind.
 *
 * ## The rule, and why each arm is where it is
 *
 * 1. `reportBalance !== anchorBalance` → **ok**. There is a real delta; whatever
 *    else may be wrong with it is not this defect.
 * 2. Balances identical AND the evidence read FAILED → **unverifiable**. A read
 *    that throws is BLIND, not empty. Returning `ok` here would make an
 *    unreadable sidecar look exactly like a verified quiet day — the same
 *    failure-blind-read shape as TRA-3073, where `[]` on a non-2xx made an
 *    outage read as "broker flat". This arm FAILS CLOSED on purpose.
 * 3. Balances identical AND the day shows activity → **stale_anchor**. Any of
 *    three independent channels counts as activity, and each is a physical
 *    argument that equity CANNOT have been unchanged to the cent:
 *      • broker closes / realized $ that day (the 06-12 proof),
 *      • engine-recorded trades,
 *      • **open positions carried across the span** — marks move, so an
 *        unchanged-to-the-cent equity is not a thing a book with open risk does.
 *    The third channel matters because it is present on EVERY stored row
 *    (`openPositionCount`), including the June cells whose broker sidecar has
 *    long since rolled out of the reconcile window.
 * 4. Balances identical AND all three channels read a genuine ZERO → **ok**,
 *    flagged `flatVerified`. A dormant all-cash account really does sit still,
 *    and flagging it would be noise that trains the reader to ignore the badge.
 *
 * Note the asymmetry between arms 2 and 4: they differ ONLY in whether the
 * evidence was readable. That distinction is the entire point of the module and
 * is why `DayActivityEvidence` is a discriminated union rather than three
 * numbers that default to 0.
 */

/**
 * What we could establish about whether anything happened on the report date.
 *
 * `known: false` is for a read that FAILED (sidecar unparseable, broker fetch
 * threw). It is NOT for a read that succeeded and found nothing — that is
 * `known: true` with zeroes, and it is a completely different claim.
 */
export type DayActivityEvidence =
  | {
      known: true;
      /** Broker-truth realized option closes attributed to this date. */
      brokerCloses: number;
      /** Broker-truth realized $ on this date (signed; 0 when none). */
      brokerRealizedUsd: number;
      /** Trades the engine recorded for this date. */
      engineTrades: number;
      /** Positions open at report time — marks move, so this is activity too. */
      openPositions: number;
    }
  | {
      known: false;
      /** Why the evidence could not be read. Surfaced verbatim to the operator. */
      reason: string;
    };

export interface BalanceAnchorInput {
  /** ET calendar date of the cell being computed, `YYYY-MM-DD`. */
  reportDate: string;
  /** The balance the cell is computed FROM. */
  reportBalance: number;
  /** Date of the anchor `findPreviousBalanceSnapshot` returned. */
  anchorDate: string;
  /** The anchor's balance — the value suspected of being a copy. */
  anchorBalance: number;
  activity: DayActivityEvidence;
}

export type BalanceAnchorStatus = 'ok' | 'stale_anchor' | 'unverifiable';

export interface BalanceAnchorVerdict {
  status: BalanceAnchorStatus;
  /** True only for arm 4 — identical balances that activity evidence CLEARS. */
  flatVerified: boolean;
  /** Calendar days between anchor and report date (1 = consecutive). */
  spanDays: number;
  /** Operator-facing sentence. Never a number the caller should trade on. */
  detail: string;
  activity: DayActivityEvidence;
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function spanDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Classify the balance anchor behind one live-calendar cell.
 *
 * Pure. Reads no files, makes no network calls, and NEVER proposes a corrected
 * P&L — see the module docblock for why re-deriving is out of scope.
 */
export function classifyBalanceAnchor(input: BalanceAnchorInput): BalanceAnchorVerdict {
  const { reportDate, reportBalance, anchorDate, anchorBalance, activity } = input;
  const spanDays = spanDaysBetween(anchorDate, reportDate);
  const base = { spanDays, activity };

  // Arm 1 — a real delta. Not this defect.
  if (
    !Number.isFinite(reportBalance) ||
    !Number.isFinite(anchorBalance) ||
    reportBalance !== anchorBalance
  ) {
    return { ...base, status: 'ok', flatVerified: false, detail: '' };
  }

  // Arm 2 — identical balances and we are BLIND. Fail closed.
  if (!activity.known) {
    return {
      ...base,
      status: 'unverifiable',
      flatVerified: false,
      detail:
        `The balance snapshot for ${reportDate} (${usd(reportBalance)}) is identical to the ` +
        `${anchorDate} anchor to the cent, which is the fingerprint of a snapshot that never ` +
        `landed. Whether the account actually traded that day could not be established ` +
        `(${activity.reason}), so this day's P&L is UNKNOWN, not $0.00.`,
    };
  }

  const channels: string[] = [];
  if (activity.brokerCloses > 0) {
    channels.push(
      `${activity.brokerCloses} broker option close${activity.brokerCloses === 1 ? '' : 's'}` +
        (activity.brokerRealizedUsd !== 0
          ? ` totalling ${activity.brokerRealizedUsd < 0 ? '−' : '+'}${usd(activity.brokerRealizedUsd)} realized`
          : ''),
    );
  } else if (activity.brokerRealizedUsd !== 0) {
    channels.push(
      `${activity.brokerRealizedUsd < 0 ? '−' : '+'}${usd(activity.brokerRealizedUsd)} of broker-realized P&L`,
    );
  }
  if (activity.engineTrades > 0) {
    channels.push(`${activity.engineTrades} engine-recorded trade${activity.engineTrades === 1 ? '' : 's'}`);
  }
  if (activity.openPositions > 0) {
    channels.push(
      `${activity.openPositions} open position${activity.openPositions === 1 ? '' : 's'} carrying mark-to-market`,
    );
  }

  // Arm 3 — identical balances CONTRADICTED by activity.
  if (channels.length > 0) {
    return {
      ...base,
      status: 'stale_anchor',
      flatVerified: false,
      detail:
        `The balance snapshot for ${reportDate} (${usd(reportBalance)}) is identical to the ` +
        `${anchorDate} anchor to the cent, yet the day shows ${channels.join(', ')}. Equity ` +
        `cannot be unchanged across that, so the ${reportDate} snapshot did not land and the ` +
        `reconcile subtracted a stale anchor from itself. This day's P&L is UNKNOWN — it is ` +
        `NOT $0.00, and it has deliberately not been re-derived (the equity series has a hole; ` +
        `filling it by inference is TRA-2864's phantom-green calendar).`,
    };
  }

  // Arm 4 — identical balances, and the evidence positively clears them.
  return {
    ...base,
    status: 'ok',
    flatVerified: true,
    detail:
      `Balance unchanged from ${anchorDate} and confirmed quiet: no broker closes, no engine ` +
      `trades, no open positions. A genuine flat day.`,
  };
}

/** True when the verdict means the cell must NOT render a P&L number. */
export function isPnlUnknown(verdict: BalanceAnchorVerdict): boolean {
  return verdict.status !== 'ok';
}

// ── The WRITE DECISION ───────────────────────────────────────────────────────
//
// ★ TRA-2864's lesson, applied ahead of time: a fix can be arithmetically
// perfect and structurally unable to reach the wrong cells, and the thing you
// have to grade is therefore the WRITE DECISION, not the compute. When that
// decision is a few inlined `if`s inside a 12k-line `index.ts`, a test can only
// REPRODUCE it — a mirrored gate agrees with itself by construction and proves
// nothing (TRA-3100 had to extract `calendar-write-decision.ts` for exactly this
// reason, after its tests said so in a comment).
//
// So the "what does the stored row look like" decision lives here, exported,
// with the classifier it depends on. `applyTradierBalanceOverride` in
// `index.ts` is a thin caller over it.

/**
 * ⛔ THE REACH GATE — which stored rows the read-time audit is allowed to look at.
 *
 * This one line is where this fix nearly died. The first draft was
 * `pnlSource === 'tradier-balance'`, which is the obviously correct-sounding
 * scope and is WRONG: measured against the live book on 2026-08-06, the three
 * June cells — **including 2026-06-12, the one cell that proves the defect** —
 * carry NO `pnlSource` at all. They were written before TRA-1192 added the
 * field, so they read back `undefined` and that gate skipped every one of them.
 *
 * A detector scoped so it cannot reach the broken rows is TRA-2864's exact
 * failure re-run, and the ONLY reason it was caught is that the live cells were
 * read before shipping instead of after. Hence: allow-list what is provably NOT
 * balance-derived, rather than deny-list everything that isn't a known label.
 * `undefined` means "we do not know what this row measures", and not knowing is
 * a reason to audit, not a reason to skip.
 *
 * @param pnlSource the row's `pnlSource`, or `undefined` on a pre-labelling row.
 */
export function shouldAuditBalanceAnchor(pnlSource: string | undefined): boolean {
  // Explicitly labelled non-balance measures have no balance anchor at all, so
  // there is nothing for them to have a stale one.
  return (
    pnlSource !== 'realized-backfill' && pnlSource !== 'engine' && pnlSource !== 'live-intraday'
  );
}

/** The absence-state block stamped onto a row. Mirrors `EodReport['pnlUnknown']`. */
export interface PnlUnknownBlock {
  reason: 'stale_balance_anchor' | 'balance_evidence_unreadable';
  anchorDate: string;
  anchorBalance: number;
  reportedBalance: number;
  spanDays: number;
  evidence: DayActivityEvidence;
  detail: string;
  at: string;
}

export interface BalanceCellDisposition {
  /** Non-null exactly when the cell must not be read as a P&L. */
  pnlUnknown: PnlUnknownBlock | null;
  /** The markdown header the row carries. */
  header: string;
}

/**
 * Decide how one live balance-delta cell presents itself.
 *
 * Note what this does NOT do: it does not change `combinedPnl`. The stored
 * number stays exactly what the arithmetic produced, because overwriting it
 * would be a repair, and a stale anchor means the equity series has a HOLE —
 * inventing a value for it is how the original phantom-green calendar happened.
 * What changes is whether the row CLAIMS that number, and the header leads with
 * the answer either way (the pre-fix header printed "= +0.00" as a finding).
 *
 * @param at ISO timestamp, injected so the decision is a pure function.
 */
export function decideBalanceCellDisposition(
  input: {
    reportDate: string;
    todayBalance: number;
    prevDate: string;
    prevBalance: number;
    netCashFlow: number;
    combinedPnl: number;
    verdict: BalanceAnchorVerdict;
  },
  at: string,
): BalanceCellDisposition {
  const { reportDate, todayBalance, prevDate, prevBalance, netCashFlow, combinedPnl, verdict } = input;
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);

  if (!isPnlUnknown(verdict)) {
    return {
      pnlUnknown: null,
      header:
        `> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for ${reportDate} = ` +
        `today's Tradier equity (${usd(todayBalance)}) − prev snapshot ${prevDate} ` +
        `(${usd(prevBalance)}) − net cash flow (${sign(netCashFlow)}) = **${sign(combinedPnl)}**. ` +
        `Engine-side realized / unrealized / options breakdown below is informational; the calendar ` +
        `uses the broker-truth value.`,
    };
  }

  const pnlUnknown: PnlUnknownBlock = {
    reason: verdict.status === 'stale_anchor' ? 'stale_balance_anchor' : 'balance_evidence_unreadable',
    anchorDate: prevDate,
    anchorBalance: Number(prevBalance.toFixed(2)),
    reportedBalance: Number(todayBalance.toFixed(2)),
    spanDays: verdict.spanDays,
    evidence: verdict.activity,
    detail: verdict.detail,
    at,
  };
  return {
    pnlUnknown,
    header:
      `> **⚠ P&L for ${reportDate} is UNKNOWN — the balance snapshot did not land (TRA-3101).** ` +
      `The stored equity for ${reportDate} (${usd(todayBalance)}) is identical to the ${prevDate} ` +
      `anchor (${usd(prevBalance)}), so \`today − prev − cash flow\` evaluates to ` +
      `**${sign(combinedPnl)}** by subtracting a stale anchor from itself. That zero is an ` +
      `ARTEFACT, not a flat day. ${verdict.detail} **Do not read \`combinedPnl\` on this row**, and ` +
      `do not sum it into a monthly total as though the day were measured.`,
  };
}
