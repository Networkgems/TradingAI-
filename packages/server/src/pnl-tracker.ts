import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * TRA-2829 / TRA-3288 — the {@link DailySnapshot.closingEquityBasis} vocabulary.
 *
 * Defined HERE (not in `eod-row-backfill.ts`, which re-exports them) because
 * `pnl-reconciliation.ts` must test rows against the broker value and
 * `eod-row-backfill.ts` already value-imports from `pnl-reconciliation.ts` — a
 * definition in either leaf would force an import cycle. `pnl-tracker.ts` is the
 * module both already depend on.
 */
export const CLOSING_EQUITY_BASIS_BROKER = 'broker-eod-balance';
export const CLOSING_EQUITY_BASIS_NOT_MEASURED = 'not-measured';
/**
 * TRA-3288 — what the 21:00 ET archive's recorded-row writer ACTUALLY writes:
 * `PaperAccount.getState().totalEquity`, the engine's paper book. On a demo book
 * that is the book. On a `mode: live` book it is the PRESERVED demo state —
 * live stock fills and live option credits are both refused entry by design
 * (`setSettings` live early-return; `bindOptionsPnlToEquityBook` non-demo
 * refusal) — so the number never moves and is NOT the broker's NAV. The stamp
 * exists so a read site can tell this surface from `'broker-eod-balance'`
 * without inferring it from the row's age or the field's absence.
 */
export const CLOSING_EQUITY_BASIS_ENGINE_PAPER = 'engine-paper-account';
/**
 * TRA-3288 item 2 — `openingEquityBasis` on a live BROKER-shaped recorded row:
 * the opening anchor is the PREVIOUS broker balance entry from
 * `tradier-eod-balance.<env>.json`, so the row telescopes on the broker
 * surface, not the paper one. Deliberately a value the TRA-3043 demo-anchor
 * vocabulary cannot produce: it must never read as `verified-prior-session-close`
 * (nothing verified the PAPER anchor here) and `stampAnchorBasis` must not
 * overwrite it with the paper anchor's provenance (it returns early on any
 * present value).
 */
export const OPENING_EQUITY_BASIS_BROKER_PREV = 'broker-prev-eod-balance';
/**
 * TRA-2829 / TRA-3948 — residual (USD) below which the equity probe is treated
 * as agreeing the booked-`0` stock leg is inert. Not zero: the probe also
 * absorbs broker rounding, so demanding an exact 0.00 would flag every row on
 * noise.
 *
 * MOVED HERE FROM `eod-row-backfill.ts` BY TRA-3948, for the same reason the
 * basis vocabulary above moved: the READER (`pnl-reconciliation.ts`) has to
 * apply the identical threshold the WRITER stamped the basis with, and it
 * cannot value-import from `eod-row-backfill.ts` without a cycle. Two copies of
 * this number would let the reader's verdict and the row's own
 * `stockLegBasis` disagree about the same row — the failure mode where a
 * `'zero-probe-disagrees'` row sits inside a green cohort. `eod-row-backfill.ts`
 * re-exports it so existing importers keep compiling.
 */
export const STOCK_LEG_PROBE_TOLERANCE_USD = 1;

export interface DailySnapshot {
  date: string;
  /**
   * TRA-2829 — `null` on a BACK-FILLED row whose broker equity anchor could not
   * be measured. See {@link DailySnapshot.closingEquity}; the two are widened
   * together because a row's opening equity is the prior session's close, so
   * whatever makes one unmeasurable makes the other so too.
   */
  openingEquity: number | null;
  /**
   * **`null` means NOT MEASURED, and it is load-bearing.**
   *
   * TRA-2829 — a day close always writes a real number here. A row inserted by
   * the EOD back-fill writer (`rowSource: 'backfill-TRA-2827'`) may not be able
   * to: the options leg is reconstructable from the durable per-trade journal at
   * exact cents, but the equity anchor is only as good as
   * `tradier-eod-balance.<env>.json`, and that file has holes wherever the EOD
   * write failed. Interpolating across such a hole would produce a row that
   * reads exactly like a recorded one while carrying a number nobody measured —
   * the TRA-2079 unannounced-correction trap, and the specific thing the CFO
   * ruling on this back-fill forbids.
   *
   * So: honest `null`, never an interpolation. Every consumer that arithmetics
   * on this field guards with `Number.isFinite` (which rejects `null`), so an
   * unmeasured row drops OUT of the population rather than poisoning it with
   * `NaN` or, worse, with a plausible zero.
   */
  closingEquity: number | null;
  dailyPnl: number;
  optionsPnl: number;
  combinedPnl: number;
  /**
   * TRA-1633 BUG 2 — the options P&L REALIZED on this ET day only (Σ options
   * closed that day, same basis as EOD report `optionsPnl`). Distinct from
   * `optionsPnl`, which was booked from the mode's ALL-TIME cumulative
   * `optionsAccount.optionsPnl` and therefore inflated every weekly/monthly/
   * yearly window that summed `combinedPnl`. The window sums now use
   * `dailyPnl + optionsDailyPnl` so no cumulative-options carry leaks in —
   * mirroring the TRA-1557 fix already applied to `allTimePnl`. Optional for
   * back-compat with snapshots persisted before this field existed (treated as
   * 0, so an old row contributes stock-only to the windows, never a phantom).
   */
  optionsDailyPnl?: number;
  /**
   * TRA-2314 — which source booked `optionsDailyPnl` (see
   * `options-daily-pnl-source.ts`). `'journal'` = the durable option-trade
   * journal, `'journal-repair'` = rewritten from the journal by the historical
   * repair, `'journal-restated'` = a named TRA-4506 restatement of a non-zero
   * cell, `'bucket-*'` = the legacy volatile in-memory bucket. Absent on rows
   * written before this ticket, which were ALL bucket-sourced.
   *
   * This field is what gives the repair a failing state. Without it a repaired
   * cell and a cell that was never broken read identically once both hold the
   * right number — the TRA-2301 lesson, where a repair wrote into the very store
   * its health route read and "repaired" and "never broken" both showed `gap:0`.
   */
  optionsDailyPnlSource?: string;
  /**
   * TRA-2314 — the volatile-bucket figure that WOULD have been booked before
   * this ticket (0.00 on every repaired row). Preserved so the before/after of a
   * board-facing correction stays readable on the row itself, not just in a
   * closing comment.
   */
  optionsDailyPnlBucket?: number;
  /** TRA-2314 — option closes the durable journal recorded on this ET day for this book. */
  optionsDailyJournalCloses?: number;
  /**
   * TRA-3043 — WHICH authority set the `openingEquity` this row was computed
   * against, as declared by the writer at the moment it wrote the row.
   *
   * The row already carries {@link DailySnapshot.openingEquity}, but that is the
   * anchor's VALUE; this is its PROVENANCE, and the two answer different
   * questions. `stockDaily = (equity − openingEquity) − creditWindow`, so a row
   * whose anchor was rolled off `state.equity` (the TRA-3039 defect) and a row
   * whose anchor is the prior session's recorded close produce the same shape of
   * number and differ only in whether that number means anything. Deriving the
   * distinction after the fact requires joining this row against the previous
   * one and asserting `openingEquity(N) === closingEquity(N−1)` — an INFERENCE,
   * and one that is unavailable at all wherever the previous row is missing or
   * carries a TRA-2829 null close.
   *
   * Values are exactly {@link PersistedState.openingEquityBasis}'s, plus the
   * positive marker only the TRA-3039 day roll can write:
   *
   *  - `verified-prior-session-close` ({@link ANCHOR_BASIS_VERIFIED}) — a boot
   *    CHECKED `openingEquity` against the newest recorded session's
   *    `closingEquity` and they matched, i.e. the telescoping invariant holds.
   *    **No build before TRA-3043 can write this string**, which is what makes
   *    it the discriminator — and it is phrased as a claim about the ANCHOR, not
   *    about which build rolled the day, so a boot that merely INHERITS a
   *    correct anchor can still vouch for it. See {@link ANCHOR_BASIS_VERIFIED}
   *    for the 2026-08-06 case that forced that distinction.
   *  - `prior-session-close` — the anchor was last written by `saveSnapshot` and
   *    no day roll has re-declared it since. On a row dated AFTER the session
   *    that set it, this means the roll for this session was performed by a
   *    build that does not write provenance, i.e. a PRE-fix build.
   *  - `day-roll-state-equity` — the lossy branch ran: no closed session to
   *    anchor on, so the anchor came from `state.equity` (TRA-241).
   *  - `rebase` — `syncOpeningEquity` deliberately moved the anchor off the
   *    prior close (starting-balance edit / mode switch / forced reset, TRA-138).
   *  - `broker-prev-eod-balance` ({@link OPENING_EQUITY_BASIS_BROKER_PREV}) —
   *    TRA-3288: a live BROKER-shaped row whose opening anchor is the previous
   *    `tradier-eod-balance` entry, NOT the paper anchor this vocabulary
   *    otherwise describes. Written by the row shaper, so `stampAnchorBasis`
   *    (which yields to any present value) can never claim the paper anchor's
   *    provenance for a broker number.
   *
   * ABSENT means NOT MEASURED, and it is load-bearing in two distinct cases that
   * must not be read as a verdict: a row written by any pre-TRA-3043 build, and
   * a row whose date is not the session the live anchor belongs to (an EOD
   * back-fill row — see the stamping guard in {@link PnlTracker.saveSnapshot},
   * which refuses to attribute the CURRENT anchor's provenance to a HISTORICAL
   * row it did not govern).
   */
  openingEquityBasis?: string;
  /**
   * TRA-2895 — partial exits (TP1 trims / manual partial `sell_to_close` /
   * partial fills) the journal dated on this ET day for this book.
   *
   * Load-bearing for reading a row, not decoration. `optionsDailyPnlSource:
   * 'journal'` with `optionsDailyJournalCloses: 0` was, before this ticket, an
   * impossible pair — closes > 0 was the ONLY way to reach the journal branch.
   * It is now the signature of a trim-only day, and without this second count
   * such a row is indistinguishable from a writer regression that took the
   * journal branch on an empty census.
   *
   * Absent on rows written before TRA-2895 — which is not the same as 0, and is
   * why this is written only when the census actually supplied it.
   */
  optionsDailyJournalPartialCloses?: number;
  /**
   * TRA-2323 — `PaperAccount.getOptionsCredited()` as of this row: the CUMULATIVE
   * realized option P&L absorbed into `closingEquity` since the fix went live.
   *
   * Exists so the stock-only leg stays recoverable. `dailyPnl` is written as the
   * equity delta over the day window, and since TRA-2323 that delta contains the
   * options leg too. Differencing this field against the previous row recovers
   * exactly what was credited in the SAME window the delta spans — the two
   * telescope, because `openingEquity` is the previous row's `closingEquity`.
   * Deriving the subtraction from the journal or the daily bucket instead would
   * re-introduce the TRA-2302/2314 disagreement between what was BOOKED and what
   * was CREDITED; this measures the credit itself.
   *
   * Absent on rows written before this fix, treated as 0 — correct, because a
   * pre-fix book's equity contains no option P&L at all.
   */
  optionsCreditedCumulative?: number;
  /**
   * TRA-2829 — **provenance marker. Absent on every RECORDED row.**
   *
   * Set to `EOD_BACKFILL_ROW_SOURCE` on rows the back-fill writer INSERTED for a
   * session the ledger never wrote. Distinct from `optionsDailyPnlSource`, which
   * says where one FIELD's number came from on a row that already existed; this
   * says the whole row is a reconstruction.
   *
   * Mandatory per the CFO ruling: a back-filled row that reads like a recorded
   * one is a defect even when every number in it is right. Undefined here means
   * "the 21:00 ET archive wrote this", and nothing else may set it.
   */
  rowSource?: string;
  /**
   * TRA-2829 — how `closingEquity` was established.
   * `'broker-eod-balance'` = read from `tradier-eod-balance.<env>.json` for that
   * exact session. `'not-measured'` = the balance series has no entry, so
   * `closingEquity`/`openingEquity` are `null`.
   *
   * TRA-3288 — no longer absent on recorded rows: the 21:00 ET archive stamps
   * `'engine-paper-account'` ({@link CLOSING_EQUITY_BASIS_ENGINE_PAPER}),
   * naming the surface it actually writes — the demo paper book, which on a
   * live book is a preserved constant, not NAV. Before this stamp a
   * broker-sourced back-filled row and a demo-book live row were
   * INDISTINGUISHABLE at the read site, which is how `postOnsetCredit` came to
   * grade broker-journal dollars against demo-book dollars. ABSENT (a
   * pre-TRA-3288 row) must be read as NOT broker-sourced — absent is not
   * broker, and `summarizePostOnsetLiveCredit` fails a live book closed on it.
   */
  closingEquityBasis?: string;
  /**
   * TRA-2829 — how `dailyPnl` (the STOCK leg) was established on a back-filled
   * row, and the evidence for it. The CFO ruling requires the stock leg be shown
   * inert before any Tradier stock reconstruction is built, so the writer books
   * `0` and publishes both the basis and {@link DailySnapshot.stockLegProbeUsd}
   * — a falsifiable measurement of that `0`, not an assertion of it.
   */
  stockLegBasis?: string;
  /**
   * TRA-2829 — `(closingEquity − openingEquity) − optionsDailyPnl` on a
   * back-filled row, when BOTH equity anchors were measured; `null` otherwise.
   *
   * This is the residual the stock leg would have to explain. It is published as
   * a MEASUREMENT and is deliberately NOT booked into `dailyPnl`: it also
   * absorbs any broker cash flow, so it is an upper bound on stock activity, not
   * stock activity. Its job is to make the booked `0` falsifiable — a materially
   * non-zero probe is the trigger the ruling names for building stock
   * reconstruction, and without it "the stock leg was inert" is unfalsifiable.
   */
  stockLegProbeUsd?: number | null;
  /**
   * TRA-3288 item 2 — signed broker cash flow (deposits − withdrawals +
   * dividends − fees, from `tradier-cash-flow.<env>.json`) over the span this
   * row's equity delta covers: `(openingEquity's anchor date, date]`. Written
   * on live BROKER-shaped recorded rows only, and only when the TRA-359 cash
   * event fetch actually succeeded this run — `null` means NOT MEASURED, and a
   * consumer must fail its window closed rather than assume 0: a deposit
   * inside the window would otherwise read as uncredited P&L. Absent on demo
   * rows and on every row written before this ticket.
   */
  netCashFlowUsd?: number | null;
  /**
   * TRA-3954 — the EOD unrealized P&L on OPEN option positions at this
   * session's close (`option_long_value − Σ cost_basis`, from
   * `tradier-eod-option-mark.<env>.json`), USD. Written on live broker-shaped
   * recorded rows only. `null` = the mark was not captured for this session —
   * NOT MEASURED, never 0 (0 is the "nothing open" reading). Absent on demo
   * rows and on every row written before this ticket.
   */
  openOptionMarkUsd?: number | null;
  /**
   * TRA-3954 — `openOptionMarkUsd(date) − openOptionMarkUsd(prevDate)` over the
   * SAME span the equity delta covers. This is the FOURTH operand of
   * {@link DailySnapshot.stockLegProbeUsd}: `closingEquity` is mark-to-market
   * while every other operand is realized, so without it the probe measured the
   * MTM-vs-realized gap and pinned RED on every overnight-option session
   * (TRA-3951 reconciled 08-17's −197.36 to this exactly). `null` when EITHER
   * endpoint's mark is uncaptured; the probe then falls back to the
   * three-operand form and says so via `stockLegProbeMarkBasis`.
   */
  openOptionMarkDeltaUsd?: number | null;
  /**
   * TRA-3954 — which form of the probe the writer stamped: `'mark-differenced'`
   * (four operands, the mark delta subtracted) or `'mark-not-measured'` (three
   * operands, the pre-TRA-3954 form — the probe on such a row still contains
   * unrealized mark motion). Diagnosis only; the reader's verdict keys on the
   * probe NUMBER, never on this string.
   */
  stockLegProbeMarkBasis?: string;
  /**
   * TRA-4506 AC1 — the broker-FEE operand the writer subtracted from
   * {@link DailySnapshot.stockLegProbeUsd}: Σ non-capital broker events (today
   * exactly `fee`) over the same span as `netCashFlowUsd`, signed as posted (a $10
   * fee is −10). `netCashFlowUsd` excludes fees by TRA-2906's ruling, so without
   * this term a fee read as unbooked stock motion (admin 2026-09-03, −10.12).
   * `null` = not measured (a v1-aggregate cash record, whose flow already carries
   * the fee). ABSENT on every row written before this ticket — the reader then
   * supplies the operand itself, and PRESENCE (even `null`) tells it not to.
   */
  stockLegProbeBrokerFeeUsd?: number | null;
  /**
   * TRA-4506 AC2 — `optionsDailyPnl` as it stood before a NAMED restatement
   * (`optionsDailyPnlSource: 'journal-restated'`). Carried on the row so the
   * correction is auditable from the row alone.
   */
  optionsDailyPnlBeforeRestatement?: number;
  /** TRA-4506 AC2 — the ticket that authorized the restatement. */
  optionsDailyPnlRestatedBy?: string;
  trades: number;
}

export interface CumulativeStats {
  allTimePnl: number;
  weeklyPnl: number;
  monthlyPnl: number;
  yearlyPnl: number;
  peakEquity: number;
}

interface PersistedState {
  equity: number;
  optionsPnl: number;
  openingEquity: number;
  openingOptionsPnl: number;
  openingDate: string;
  updatedAt: string;
  /**
   * TRA-3039 — WHICH authority last set {@link PersistedState.openingEquity}.
   *
   * Provenance only: nothing branches on it, and it is absent on every state
   * file written before this ticket (so it can never gate the fix on a
   * migration). It exists because the three writers below produce the SAME
   * number on a healthy book and wildly different ones on a sick book, and
   * without a marker the on-disk state cannot say which one ran:
   *
   *  - `prior-session-close` — {@link PnlTracker.saveSnapshot}. The anchor is
   *    the previous session's recorded `closingEquity`, which is the ONLY value
   *    that makes the daily rows telescope (`openingEquity(N) === closingEquity(N-1)`).
   *  - `rebase` — {@link PnlTracker.syncOpeningEquity}. A starting-balance edit
   *    / mode switch / forced reset deliberately moved the anchor off the prior
   *    close so the rebase does not read as daily P&L (TRA-138).
   *  - `day-roll-state-equity` — {@link PnlTracker.advanceDayIfNeeded} rolled a
   *    session that never closed. This is the lossy branch: it orphans whatever
   *    moved since the last booked row (the leak TRA-1557 documented).
   */
  openingEquityBasis?: string;
}

/**
 * TRA-3039 — the anchor-preservation comparison is on RECORDED DOLLARS, both
 * sides of which `saveSnapshot` assigned from the same `number`. A half-cent
 * window absorbs a JSON round-trip without being wide enough to admit a
 * starting-balance rebase, which is the only other writer of this field and
 * always moves it by whole dollars.
 */
const ANCHOR_MATCH_EPSILON_USD = 0.005;

/**
 * TRA-3043 — the ATTESTED value of {@link PersistedState.openingEquityBasis}.
 *
 * Its meaning is one sentence, and the sentence is deliberately about the
 * ANCHOR rather than about which branch of which build ran: *at the last boot,
 * `openingEquity` was verified equal to the `closingEquity` of the newest
 * recorded session, and that session is strictly older than `openingDate`.*
 * That is the telescoping invariant `openingEquity(N) === closingEquity(N−1)`,
 * which is precisely what the TRA-3039 day-roll defect breaks.
 *
 * Stated that way it survives the case that actually occurred on 2026-08-06: a
 * PRE-fix build (`00a8cbb4`) held the box across the 04:00Z ET-day boundary and
 * a fixed build took over 39 minutes later, so the fixed build never performed
 * that day's roll and had no roll-branch on which to report. A marker that
 * claimed "the fixed roll ran" would have been silent on the one session it was
 * built to grade. A marker that claims the invariant holds can be checked by any
 * boot, at any time, against durable state.
 *
 * No build before TRA-3043 can emit this string, so its ABSENCE remains the
 * evidence — a stale `prior-session-close` is never a pass.
 */
export const ANCHOR_BASIS_VERIFIED = 'verified-prior-session-close';

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The ET calendar date of this week's Monday, `YYYY-MM-DD`.
 *
 * TRA-3421 (secondary) — derived from the ET CALENDAR DATE, never from the
 * host's local one. The previous version took `new Date().getDay()`, which
 * reads the PROCESS timezone (UTC on bqb1) and then formatted the result in ET.
 * Between 00:00Z and 04:00Z those two disagree by a day, so the subtraction ran
 * off a day-of-week one ahead of the ET date it was labelling and returned
 * SUNDAY as the week start. Harmless on a stock/options book — Sunday carries
 * no rows — but `CryptoEngine` feeds this same tracker a 7-day tape, so the
 * previous Sunday's realized P&L leaked into "this week" for those four hours.
 *
 * Anchoring at 12:00 UTC keeps the arithmetic clear of every DST edge: no ET
 * transition moves a date across midday.
 */
function startOfWeek(): string {
  const [y, m, d] = todayKey().split('-').map(Number);
  const anchor = new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12));
  const dow = anchor.getUTCDay();
  anchor.setUTCDate(anchor.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return anchor.toISOString().slice(0, 10);
}

/**
 * TRA-4003 — the longest run of consecutive NON-session ET days the anchor
 * check will walk before giving up. A Thu/Fri holiday pair around a weekend is
 * 4; 10 leaves margin and bounds the loop so a malformed date cannot spin
 * (same figure `scheduler.ts` uses for its session lookback).
 */
const ANCHOR_NON_SESSION_SPAN_MAX_DAYS = 10;

/** `YYYY-MM-DD` + `days`, arithmetic done at 12:00 UTC so no DST edge moves the date. */
function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export class PnlTracker {
  private readonly stateFile: string;
  private readonly snapshotsFile: string;
  private initialEquity: number;
  private hadSavedState: boolean;
  private state: PersistedState;
  private snapshots: DailySnapshot[] = [];
  /**
   * TRA-4003 — the exchange calendar, `YYYY-MM-DD` → is that ET day a session.
   * `null` = no calendar supplied: every day is treated as a session, which is
   * byte-for-byte the pre-TRA-4003 behaviour (the crypto tracker, and every
   * test that constructs a tracker without one).
   */
  private readonly isMarketDay: ((dateIso: string) => boolean) | null;

  constructor(
    dataDir: string,
    initialEquity = 25_000,
    opts?: { isMarketDay?: (dateIso: string) => boolean },
  ) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.isMarketDay = opts?.isMarketDay ?? null;
    this.initialEquity = initialEquity;
    this.stateFile = join(dataDir, 'equity-state.json');
    this.snapshotsFile = join(dataDir, 'daily-snapshots.json');
    this.hadSavedState = existsSync(this.stateFile);
    this.state = this.loadState();
    this.snapshots = this.loadSnapshots();
    this.advanceDayIfNeeded();
  }

  /** True when equity-state.json existed at construction (i.e. a prior session ran). */
  hasSavedState(): boolean {
    return this.hadSavedState;
  }

  /** Update the configured starting balance baseline (used by allTimePnl). */
  setInitialEquity(value: number): void {
    this.initialEquity = value;
  }

  private loadState(): PersistedState {
    if (existsSync(this.stateFile)) {
      try {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8')) as PersistedState;
      } catch { /* use defaults */ }
    }
    const today = todayKey();
    return {
      equity: this.initialEquity,
      optionsPnl: 0,
      openingEquity: this.initialEquity,
      openingOptionsPnl: 0,
      openingDate: today,
      updatedAt: new Date().toISOString(),
    };
  }

  private loadSnapshots(): DailySnapshot[] {
    if (existsSync(this.snapshotsFile)) {
      try {
        return JSON.parse(readFileSync(this.snapshotsFile, 'utf-8')) as DailySnapshot[];
      } catch { /* use empty */ }
    }
    return [];
  }

  /**
   * TRA-3039 — the most recently DATED snapshot, or `null` when none is booked.
   *
   * Scans rather than reading `at(-1)`: `saveSnapshot` keeps the array sorted,
   * but `loadSnapshots` parses a file that the EOD back-fill writer and past
   * hand-repairs also touch, and an out-of-order tail would silently hand the
   * anchor test the wrong row.
   */
  private latestSnapshot(): DailySnapshot | null {
    let latest: DailySnapshot | null = null;
    for (const s of this.snapshots) {
      if (!s || typeof s.date !== 'string') continue;
      if (latest === null || s.date > latest.date) latest = s;
    }
    return latest;
  }

  /**
   * TRA-3039 — is `openingEquity` ALREADY the previous session's recorded close?
   *
   * `saveSnapshot` writes `openingEquity = closingEquity` and `openingDate =
   * snapshot.date` as a pair, meaning "this anchor is the close of `openingDate`,
   * i.e. the opening of whatever session comes next". When both still hold, the
   * anchor needs no roll — it is already correct for the new day, and re-rolling
   * it can only move it AWAY from the prior close.
   *
   * A `syncOpeningEquity` rebase breaks the equality (it moves the anchor off the
   * close on purpose), so this correctly returns false there and the rebase keeps
   * its TRA-138 day-roll behaviour.
   *
   * TRA-4003 — THE SECOND ROLL ACROSS A WEEKEND CLOBBERED THE ANCHOR TRA-3039
   * HAD JUST PRESERVED.
   *
   * The preserve branch below stamps `openingDate = today`, and the test above
   * was `latest.date === openingDate`. That equality survives exactly ONE roll.
   * On a weekday that is enough: the day rolled into closes at 21:00 ET and
   * `saveSnapshot` re-establishes the pair. On a NON-session day nothing closes,
   * so after a Saturday boot the state reads `openingDate: Sat` against
   * `latest.date: Fri`, and the next boot — Sunday, or Monday itself — fails
   * the equality and falls through to the `state.equity` roll. That is the
   * TRA-3039 defect again, gated to weekends and holidays, and only when the
   * process restarts on more than one distinct ET day between a Friday close
   * and the Monday one.
   *
   * Live bqb1, session 2026-08-24 (Render deploys Sat 08-22, Sun 08-23T20:45Z,
   * Mon 08-24T20:12Z/20:43Z): **41 of 64 demo books** wrote an 08-24 row with
   * `openingEquityBasis: 'day-roll-state-equity'` and `openingEquity !==
   * closingEquity(08-21)`, against 0 of 64 on every weekday session 08-18 →
   * 08-25 and 15 of 64 on the previous Monday (08-17). 19 of the 41 booked a
   * non-zero `stockDaily` on a session whose equity did not move. On 6 of them
   * `state.equity` had last been written by the trade path BEFORE Friday's
   * option credit reached `PaperAccount`, so the stale anchor was short by
   * exactly `optionsDaily(08-21)` and the row read `stockDaily(08-24) ===
   * optionsDaily(08-21)` to the cent — the TRA-2630 Defect B signature,
   * produced with an intact credit counter. TRA-2636's tripwire filed that as a
   * Defect B recurrence; it is this.
   *
   * THE RULE NOW. The anchor is still the prior session's close when the newest
   * recorded close is the anchor's value AND every ET day STRICTLY BETWEEN that
   * close and today is a non-session day — measured against TODAY, not against
   * `openingDate`, because `openingDate` is exactly the field the preserve
   * branch keeps moving. A session day in that span with no row is the case
   * TRA-3039 kept the lossy roll for (server down at the 21:00 ET archive) and
   * it still rolls. Without a calendar the test degrades to the strict
   * equality — a caller that cannot name the sessions gets the old behaviour,
   * never a guess.
   */
  private anchorIsPriorSessionClose(today: string): boolean {
    const latest = this.latestSnapshot();
    if (latest === null) return false;
    if (latest.date !== this.state.openingDate
      && !this.onlyNonSessionsBetween(latest.date, today)) return false;
    const close = latest.closingEquity;
    if (close === null || !Number.isFinite(close)) return false;
    if (!Number.isFinite(this.state.openingEquity)) return false;
    return Math.abs(close - this.state.openingEquity) <= ANCHOR_MATCH_EPSILON_USD;
  }

  /**
   * TRA-4003 — is every ET day in the OPEN interval `(closeDate, today)` a
   * non-session day? `today` itself is excluded: it is the session this roll
   * opens, and it has not had the chance to close yet. `false` without a
   * calendar, on a malformed or non-increasing pair, and on a span longer than
   * {@link ANCHOR_NON_SESSION_SPAN_MAX_DAYS}: each of those is "cannot prove
   * it", and the caller treats that as the strict equality failing, which is
   * the pre-fix branch.
   */
  private onlyNonSessionsBetween(closeDate: string, today: string): boolean {
    if (this.isMarketDay === null) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
    if (!(today > closeDate)) return false;
    let d = closeDate;
    for (let i = 0; i < ANCHOR_NON_SESSION_SPAN_MAX_DAYS; i++) {
      d = addDaysIso(d, 1);
      if (!(d < today)) return true;
      if (this.isMarketDay(d)) return false;
    }
    return false;
  }

  /**
   * TRA-3039 — DO NOT re-anchor a day whose predecessor actually closed.
   *
   * THE DEFECT THIS FIXES. `saveSnapshot` and this method disagreed about what
   * `openingDate` means. `saveSnapshot` writes it as "the session this anchor
   * CLOSED"; this method read it as "the session this anchor OPENS", concluded
   * the anchor was stale on every boot into a new ET day, and overwrote a
   * correct `closingEquity(N-1)` with `state.equity` — a cache only the TRADE
   * path (`saveEquity`) ever writes. On any book where those two durable records
   * had drifted apart, the anchor moved OFF the prior close, and the next 21:00
   * ET row booked
   *
   *     stockDaily = (equity - openingEquity) - creditWindow
   *
   * over a window that starts before the prior close — re-booking a slice of the
   * previous session into this one.
   *
   * Live bqb1, 2026-08-05 (the pull on TRA-3039): **31 of 47 gradeable books**
   * wrote an 08-05 row whose derived `openingEquity` was byte-identical to the
   * 08-04 row's `openingEquity` and DIFFERENT from the 08-04 row's
   * `closingEquity` — the anchor had not advanced across the close at all,
   * because those books were idle and `state.equity` had not moved between the
   * two boots. Both directions occur (22 books anchored BELOW the prior close,
   * 14 ABOVE), so no "pick the fresher file" heuristic covers it; the only
   * correct anchor is the recorded close itself.
   *
   * 5 of those 31 additionally tripped the TRA-2658 frozen-counter arm and were
   * reported as a credit-durability regression — they are not one. The frozen
   * predicate fires on the subset whose anchor error happens to fit inside the
   * book's realized-options pool, so it under-counts this defect ~6x and
   * mis-attributes it. `ctoverify_tra2333` read CLEAN over the same broken
   * anchor only because the TRA-2847 reseed added exactly the 73.05 its stale
   * window was short: two errors of equal size cancelling, not a repair.
   *
   * The roll from `state.equity` REMAINS for the case it was written for: a
   * session that never closed (server down at the 21:00 ET archive, or a process
   * that crossed midnight without the EOD job). There the last snapshot's date
   * is older than `openingDate`, nothing recorded a close to anchor on, and
   * rolling to current equity is what keeps the dashboard's daily P&L from
   * opening the day at a phantom figure (TRA-241). That branch is still lossy —
   * it orphans the elapsed move from the booked ledger, which is exactly the
   * leak TRA-1557 reconciles `allTimePnl` against — so it now says so on disk
   * via {@link PersistedState.openingEquityBasis}.
   */
  /**
   * TRA-3043 — verify the LIVE anchor against the newest recorded close and,
   * when it holds, say so on disk. Writes provenance; never touches the anchor.
   *
   * WHY THIS EXISTS AT ALL, rather than trusting the roll branch to report.
   * `advanceDayIfNeeded` is constructor-only, so exactly one process per ET day
   * performs that day's roll — and on 2026-08-06 that process was a PRE-fix
   * build. It rolled at some point after 04:00Z, wrote no provenance, and the
   * fixed build that replaced it at 04:33Z found `openingDate` already stamped
   * and returned without a word. Nothing in the roll path could have graded that
   * session, because the fixed build was never the one that rolled it.
   *
   * The invariant, though, is still sitting in durable state and can be checked
   * by whoever boots next:
   *
   *     openingEquity === closingEquity(newest recorded session)
   *
   * If a pre-fix roll clobbered the anchor off `state.equity`, this comparison
   * FAILS and nothing is written — the honest absent. If it holds, the anchor is
   * sound no matter which build put it there, and that is the fact being graded.
   *
   * The `latest.date < openingDate` guard is what makes this a statement about a
   * COMPLETED prior session. When they are equal, `saveSnapshot` has just booked
   * a close for the currently-open date; the anchor is that close, the day has
   * not rolled, and `prior-session-close` already describes it exactly.
   */
  private attestAnchorAgainstLatestClose(): void {
    if (this.state.openingEquityBasis === ANCHOR_BASIS_VERIFIED) return; // idempotent, no churn
    const latest = this.latestSnapshot();
    if (latest === null) return;
    if (!(latest.date < this.state.openingDate)) return;
    const close = latest.closingEquity;
    if (close === null || !Number.isFinite(close)) return;
    if (!Number.isFinite(this.state.openingEquity)) return;
    if (Math.abs(close - this.state.openingEquity) > ANCHOR_MATCH_EPSILON_USD) return;
    this.state.openingEquityBasis = ANCHOR_BASIS_VERIFIED;
    this.persistState();
  }

  /**
   * TRA-3043 — the LIVE anchor and its provenance, for publication on
   * `/api/health/pnl-reconciliation` beside the per-row copy.
   *
   * The row-level field is the durable record, but it only exists once the 21:00
   * ET writer has run. This is the same declaration readable BEFORE that write —
   * which is the only way to answer "is today's anchor sound?" while today is
   * still in progress, instead of finding out from the row that today's grade
   * was already spent.
   */
  getAnchorState(): { openingDate: string; openingEquity: number; openingEquityBasis: string | null } {
    return {
      openingDate: this.state.openingDate,
      openingEquity: this.state.openingEquity,
      openingEquityBasis: typeof this.state.openingEquityBasis === 'string'
        && this.state.openingEquityBasis !== ''
        ? this.state.openingEquityBasis
        : null,
    };
  }

  private advanceDayIfNeeded(): void {
    const today = todayKey();
    if (this.state.openingDate === today) {
      // TRA-3043 — the day is already open, so there is nothing to roll. ATTEST
      // anyway. See `attestAnchorAgainstLatestClose`: this branch is the one a
      // build reaches when it boots into a day some EARLIER process already
      // rolled, and it is the only opportunity that build has to say anything at
      // all about the anchor it inherited.
      this.attestAnchorAgainstLatestClose();
      return;
    }
    if (this.anchorIsPriorSessionClose(today)) {
      // The anchor is already `closingEquity(N-1)`. Stamp the new day onto it and
      // leave the equity/options anchors untouched, so the rows telescope.
      this.state.openingDate = today;
      // TRA-3043 — POSITIVE marker, and the reason this line is not simply left
      // holding the `prior-session-close` that `saveSnapshot` already wrote.
      //
      // A pre-TRA-3039 build takes the roll below unconditionally and writes NO
      // provenance at all, so it clobbers `openingEquity` while leaving the
      // basis string reading `prior-session-close` from the previous session's
      // close. If this branch also left that string alone, the healthy case and
      // the clobbered case would publish the SAME declaration — the field would
      // be silent in exactly the situation it exists to discriminate. Stamping a
      // value no earlier build can produce makes its ABSENCE the evidence:
      // whichever build rolled this session, it was not this one.
      this.state.openingEquityBasis = ANCHOR_BASIS_VERIFIED;
      this.persistState();
      return;
    }
    this.state.openingEquity = this.state.equity;
    this.state.openingOptionsPnl = this.state.optionsPnl;
    this.state.openingDate = today;
    this.state.openingEquityBasis = 'day-roll-state-equity';
    this.persistState();
  }

  getSavedEquity(): number {
    return this.state.equity;
  }

  getSavedOptionsPnl(): number {
    return this.state.optionsPnl;
  }

  getOpeningEquity(): number {
    return this.state.openingEquity;
  }

  getOpeningOptionsPnl(): number {
    return this.state.openingOptionsPnl;
  }

  saveEquity(equity: number, optionsPnl: number): void {
    this.state.equity = equity;
    this.state.optionsPnl = optionsPnl;
    this.state.updatedAt = new Date().toISOString();
    this.persistState();
  }

  /**
   * Realign persisted openingEquity to match the in-memory state after an
   * equity rebase (settings save, mode switch, or forceReset). On the next
   * restart, dailyPnl is reseeded as `equity - openingEquity`; without this
   * sync, a stale openingEquity makes the equity rebase show up as phantom
   * daily P&L. Pass the current totalEquity and dailyPnl from the in-memory
   * account; openingEquity is set to their difference.
   */
  syncOpeningEquity(currentEquity: number, dailyPnl: number): void {
    this.state.openingEquity = currentEquity - dailyPnl;
    // TRA-3039 — provenance only. This is the one writer that is SUPPOSED to
    // move the anchor off the prior session's close, and `advanceDayIfNeeded`
    // detects that structurally (the equality with the last snapshot's
    // `closingEquity` breaks), never by reading this field.
    this.state.openingEquityBasis = 'rebase';
    this.persistState();
  }

  /**
   * TRA-3043 — copy `snapshot` with {@link DailySnapshot.openingEquityBasis} set
   * to the provenance of the anchor this row was actually computed against.
   *
   * Read BEFORE `saveSnapshot` overwrites `state.openingEquityBasis` to
   * `prior-session-close`: that assignment is about the anchor for the NEXT
   * session, and stamping it here would make every row declare
   * `prior-session-close` unconditionally — a field that is green by
   * construction, which is the TRA-2641 self-confirming trap.
   *
   * TWO refusals, both of which produce an honest ABSENT rather than a guess:
   *
   *  1. `snapshot.date !== state.openingDate` — this row is not the session the
   *     live anchor governs. That is an EOD BACK-FILL row (`rowSource:
   *     'backfill-TRA-2827'`) or a hand repair reaching into history, and the
   *     current in-memory provenance says nothing about the anchor that was in
   *     force on that past day. Attributing it would be a fabricated audit
   *     trail, and worse than none.
   *  2. The state carries no basis at all — every state file written before
   *     TRA-3039. Absent stays absent.
   *
   * A caller that supplied its own basis keeps it; the back-fill writer is the
   * one that may legitimately know a historical row's provenance when this
   * method cannot.
   */
  private stampAnchorBasis(snapshot: DailySnapshot): DailySnapshot {
    if (snapshot.openingEquityBasis !== undefined) return snapshot;
    const basis = this.state.openingEquityBasis;
    if (typeof basis !== 'string' || basis === '') return snapshot;
    if (snapshot.date !== this.state.openingDate) return snapshot;
    // Spread, never a field-by-field rebuild: this method must stay transparent
    // to fields added to `DailySnapshot` after it was written.
    return { ...snapshot, openingEquityBasis: basis };
  }

  saveSnapshot(
    snapshot: DailySnapshot,
    // TRA-3288 item 2 — the dashboard-rebase anchor, SEPARATED from the row's
    // `closingEquity`. A live broker-shaped row carries the BROKER close, but
    // the state anchor below is a PAPER-book instrument: it feeds
    // `getOpeningEquity()` → `stockOnlyDailyPnl` and the demo dashboard
    // baseline that live mode deliberately preserves for a later switch back.
    // Rebasing it to a broker number would manufacture a (paper − broker)
    // phantom stock leg on the very next write. A caller writing a broker row
    // passes the paper equity here; omitting the option keeps the historical
    // behaviour (rebase to the row's own close).
    opts?: { dashboardAnchorEquity?: number | null },
  ): void {
    this.snapshots = this.snapshots.filter(s => s.date !== snapshot.date);
    this.snapshots.push(this.stampAnchorBasis(snapshot));
    this.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(this.snapshotsFile, JSON.stringify(this.snapshots, null, 2), 'utf-8');

    // TRA-2829 — a real day close always carries a measured `closingEquity`, so
    // this guard should never fire from `generateAndSaveReport`. It exists so
    // that if some future caller ever hands `saveSnapshot` an unmeasured row,
    // the dashboard's opening equity is LEFT ALONE rather than rebased to
    // `null` — which would read as $0 and manufacture a book-sized phantom P&L.
    // TRA-3288 — same guard, same reason, for the explicit anchor: an
    // unmeasured override leaves the state alone, never rebases to null/NaN.
    const rebaseTo = opts && 'dashboardAnchorEquity' in opts
      ? opts.dashboardAnchorEquity
      : snapshot.closingEquity;
    if (rebaseTo !== null && rebaseTo !== undefined && Number.isFinite(rebaseTo)) {
      this.state.openingEquity = rebaseTo;
      this.state.openingOptionsPnl = this.state.optionsPnl;
      this.state.openingDate = snapshot.date;
      // TRA-3039 — this pair (`openingEquity` = the close, `openingDate` = the
      // session that closed) is exactly what `advanceDayIfNeeded` must now
      // PRESERVE rather than overwrite from `state.equity`.
      //
      // TRA-3288 — on a live book the row's close is now broker-sourced while
      // this anchor stays paper, so `anchorIsPriorSessionClose()` reads false
      // at the next day roll and the roll takes the `day-roll-state-equity`
      // branch. That is numerically identical on a live book (the paper equity
      // is frozen, so `state.equity === state.openingEquity`) and the label is
      // honest: nothing can verify a PAPER anchor against a BROKER ledger row.
      this.state.openingEquityBasis = 'prior-session-close';
      this.persistState();
    }
  }

  /**
   * TRA-2314 — apply the historical `optionsDailyPnl` repair produced by
   * `planOptionsDailyPnlRepair`. Rewrites only the days the plan names, stamps
   * each with its provenance (`journal-repair`) and the ORIGINAL bucket figure,
   * and persists. Returns the number of rows actually rewritten.
   *
   * Deliberately does NOT touch `openingEquity` / `openingDate` the way
   * `saveSnapshot` does — this is a backfill of a past cell, not a day close, and
   * rebasing the dashboard's opening equity off a historical row is the exact
   * corruption `generateAndSaveReport` skips snapshots on a backfill to avoid.
   *
   * Idempotent: a second run finds no row whose `optionsDailyPnl` is still 0 on
   * a day the journal names closes, so it writes nothing. bqb1 restarts several
   * times an hour, so this MUST be a no-op after the first pass.
   */
  applyOptionsDailyPnlRepair(
    deltas: ReadonlyArray<{ date: string; after: number; journalCloses: number }>,
  ): number {
    if (deltas.length === 0) return 0;
    const byDate = new Map(deltas.map(d => [d.date, d]));
    let repaired = 0;
    this.snapshots = this.snapshots.map(s => {
      const d = byDate.get(s.date);
      if (!d) return s;
      repaired += 1;
      return {
        ...s,
        optionsDailyPnl: d.after,
        optionsDailyPnlSource: 'journal-repair',
        optionsDailyPnlBucket: s.optionsDailyPnl ?? 0,
        optionsDailyJournalCloses: d.journalCloses,
      };
    });
    if (repaired > 0) {
      writeFileSync(this.snapshotsFile, JSON.stringify(this.snapshots, null, 2), 'utf-8');
    }
    return repaired;
  }

  /**
   * TRA-4506 AC2 — apply the NAMED restatements `planOptionsDailyPnlRestatements`
   * cleared. Sibling of {@link applyOptionsDailyPnlRepair}, for the case that one
   * deliberately refuses: a NON-zero cell the journal later superseded. It
   * rewrites `optionsDailyPnl` only, stamps `'journal-restated'`, and keeps the
   * prior figure and the authorizing ticket on the row. `combinedPnl`, the
   * equity anchors and the stamped probe are left as written — on a live row
   * `combinedPnl` is the broker's figure, which was never wrong.
   *
   * Idempotent through the planner: a restated row no longer holds `before`, so
   * the next boot plans nothing.
   */
  applyOptionsDailyPnlRestatement(
    entries: ReadonlyArray<{ date: string; before: number; after: number; ticket: string }>,
  ): number {
    if (entries.length === 0) return 0;
    const byDate = new Map(entries.map(e => [e.date, e]));
    let restated = 0;
    this.snapshots = this.snapshots.map(s => {
      const e = byDate.get(s.date);
      if (!e) return s;
      restated += 1;
      return {
        ...s,
        optionsDailyPnl: e.after,
        optionsDailyPnlSource: 'journal-restated',
        optionsDailyPnlBeforeRestatement: e.before,
        optionsDailyPnlRestatedBy: e.ticket,
      };
    });
    if (restated > 0) {
      writeFileSync(this.snapshotsFile, JSON.stringify(this.snapshots, null, 2), 'utf-8');
    }
    return restated;
  }

  /**
   * TRA-2829 (parent TRA-2827) — INSERT ledger rows for sessions the 21:00 ET
   * archive never wrote, from the durable option-trade journal.
   *
   * Sibling of {@link applyOptionsDailyPnlRepair} and held to the same
   * discipline, but the opposite operation: that one REWRITES a field on a row
   * that exists, this one CREATES a row that is absent. Both are back-fills of a
   * past cell, so neither may call `saveSnapshot` — doing so would rebase
   * `openingEquity`/`openingDate` off a historical row and hand the live
   * dashboard a days-old anchor, which is exactly the corruption
   * `generateAndSaveReport` skips snapshots on a backfill to avoid.
   *
   * **Append-only against existing rows.** A date that already has a row is
   * skipped outright — never merged, never overwritten. The recorded ledger is
   * the authority wherever it spoke at all; this writer only fills silence. That
   * is also what makes it idempotent, which is not optional: bqb1 restarts
   * several times an hour, so the second pass MUST write nothing.
   *
   * Returns the dates actually inserted.
   */
  applyEodRowBackfill(rows: ReadonlyArray<DailySnapshot>): string[] {
    if (rows.length === 0) return [];
    const existing = new Set(this.snapshots.map(s => s.date));
    const inserted: DailySnapshot[] = [];
    for (const r of rows) {
      if (existing.has(r.date)) continue;
      // Refuse to write an unmarked row. The provenance marker is the whole
      // point of this path per the CFO ruling, so a caller that forgets it gets
      // nothing written rather than a row that reads as recorded — a defect that
      // would be undetectable after the fact.
      if (!r.rowSource) continue;
      existing.add(r.date);
      inserted.push(r);
    }
    if (inserted.length === 0) return [];
    this.snapshots = [...this.snapshots, ...inserted].sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(this.snapshotsFile, JSON.stringify(this.snapshots, null, 2), 'utf-8');
    return inserted.map(r => r.date).sort();
  }

  getCumulativeStats(currentEquity: number): CumulativeStats {
    // TRA-3421 (secondary) — every window boundary is cut from the ET calendar
    // date, the same clock `todayKey()` / the snapshot `date` keys use. `new
    // Date().getFullYear()/.getMonth()` read the PROCESS timezone (UTC on bqb1),
    // which is a DIFFERENT day from 00:00Z to 04:00Z. On 2026-08-01T02:00Z the
    // ET date is still 2026-07-31, so the old month boundary read "2026-08-01"
    // — strictly AFTER today — and the monthly window silently excluded the
    // whole of July plus the live session. Same defect at the year boundary,
    // where it would blank the yearly window for four hours on Dec 31.
    const today = todayKey();
    const weekStart = startOfWeek();
    const monthStart = `${today.slice(0, 7)}-01`;
    const yearStart = `${today.slice(0, 4)}-01-01`;

    // TRA-1633 BUG 2 — sum DAY-ONLY realized (stock `dailyPnl` + day-only
    // `optionsDailyPnl`) over each window, NOT the per-snapshot `combinedPnl`.
    // `combinedPnl` carried the mode's ALL-TIME cumulative options total
    // (`optionsPnl` booked from `optionsAccount.optionsPnl` at index.ts), so the
    // weekly/monthly/yearly windows re-added the running options total on every
    // day with option activity — the same phantom class TRA-1557 removed from
    // `allTimePnl`. `optionsDailyPnl` is absent on legacy rows (→ 0), so they
    // contribute stock-only rather than a phantom.
    const bookedFrom = (from: string) =>
      this.snapshots
        .filter(s => s.date >= from)
        .reduce((acc, s) => acc + s.dailyPnl + (s.optionsDailyPnl ?? 0), 0);

    // TRA-2829 — an unmeasured `closingEquity` (`null` on a back-filled row) is
    // dropped, not coerced. `Math.max(..., null)` is 0, which would not merely
    // be wrong here — it would silently CAP `peakEquity` at 0 and turn every
    // drawdown reading on the book into a fiction.
    const peakEquity = Math.max(
      this.initialEquity,
      currentEquity,
      ...this.snapshots
        .map(s => s.closingEquity)
        .filter((v): v is number => v !== null && Number.isFinite(v)),
    );

    // TRA-1557 — all-time P&L must reconcile with the booked daily-snapshot
    // ledger, NOT the raw equity mark. `currentEquity - initialEquity` silently
    // absorbs "un-booked equity re-anchors": when the server is down across a
    // day boundary (the desktop is routinely closed overnight; a Render reboot
    // does the same), `advanceDayIfNeeded()` / `syncOpeningEquity()` roll
    // `openingEquity` forward to the current equity WITHOUT booking a snapshot
    // for the elapsed day, so that equity delta never enters the daily ledger —
    // yet it stays in `equity`, inflating the equity-mark all-time into a
    // phantom gain that disagrees with the Calendar's realized track and with
    // the weekly/monthly/yearly windows (which sum the booked ledger). On the
    // admin demo book this surfaced as +$1,067 all-time vs a −$1,144 realized
    // ledger — a ~$2,211 phantom.
    //
    // Derive all-time from the SAME booked ledger every other window uses, plus
    // today's not-yet-booked running delta (`currentEquity - openingEquity`), so
    // every P&L surface agrees.
    //
    // TRA-3239 — the booked leg sums `dailyPnl + optionsDailyPnl` (the windows'
    // exact basis), NOT `dailyPnl` alone. The original TRA-1557 fix summed the
    // stock leg only, justified by "`totalEquity` excludes the separately-tracked
    // options P&L" — a premise TRA-2323 ended: `creditRealizedOptionsPnl` moves
    // equity on every option close, so `todayRunning` ALREADY contains today's
    // options credits while the booked sum contained none. The result on an
    // options-only book (live repro: demo `qa3120t0806a`, 08-11): all-time read
    // "today's options P&L" — 26 with weekly at 80, then ~0 after the day roll
    // re-anchored — strictly SMALLER than the weekly window it super-sets, and
    // the book's true +106 never appeared on any read. Same telescoping
    // property as before: with every day booked and credits absorbed, the sum
    // collapses to `currentEquity - initialEquity`. Legacy rows without
    // `optionsDailyPnl` contribute stock-only (absent → 0), matching the windows.
    const bookedPnl = this.snapshots.reduce(
      (acc, s) => acc + s.dailyPnl + (s.optionsDailyPnl ?? 0), 0);
    const todayRunning = currentEquity - this.state.openingEquity;
    const allTimePnl = bookedPnl + todayRunning;

    // TRA-3421 — THE WINDOWS WERE BLIND TO THE CURRENT ET DAY, both halves of it.
    //
    // The old basis was `snapshots.filter(date < today)`, so a window covering
    // today contributed nothing for today: not the booked row (excluded by the
    // strict `<`, from the moment the 21:00 ET close writes it until the next
    // day roll makes it "past"), and not the un-booked running delta before that
    // (`currentEquity − openingEquity`, which never entered `sum` at all).
    // Every rolling window therefore understated the book by its ENTIRE
    // same-day P&L, on exactly the surface a human reads intraday.
    //
    // It produced a one-read impossibility on any book whose realized history is
    // only today. Live repro, bqb1 `4780dc9edc43` pid 73, book `qa581t0811a`
    // (one closed EQUITY row, NBIS +13.12, 2026-08-12): `dailyPnl 13.12` /
    // `allTimePnl 13.12` against `weekly = monthly = yearly = 0` — a weekly
    // strictly below the daily it super-sets, which no boundary convention
    // permits (2026-08-12 is a Wednesday, inside its own week/month/year).
    //
    // NOT the filed hypothesis. The defect is not an EQUITY-vs-OPTIONS asymmetry:
    // the reducer above sums `dailyPnl + optionsDailyPnl` and cannot tell the two
    // asset classes apart. The control book `qa3120t0806a` read 106 only because
    // its rows are dated 08-10/08-11 — PAST days. Re-measured 02:5xZ with its own
    // rows now past, the equity book still read weekly 0 with the row booked, so
    // the discriminator is the row's DATE, not its asset class. Corollary worth
    // stating: this defect SELF-HEALS at the next ET day roll, so a re-read the
    // following morning shows the true number and reads as "not reproducible".
    //
    // Fix: give the windows the same two-part basis `allTimePnl` already uses —
    // booked rows in the window (today's INCLUDED) plus `todayRunning`. The two
    // never double-count: `saveSnapshot` rebases `openingEquity` to the row's own
    // close, so `todayRunning` collapses to ~0 the instant today's row is booked,
    // and before that the row does not exist. This also makes the whole family
    // telescope exactly — `allTimePnl − yearlyPnl` is now precisely the sum of
    // booked rows before Jan 1 — which is the property that rules out the entire
    // "a window exceeds the window that contains it" class, not just this
    // instance of it.
    const windowPnl = (from: string) => bookedFrom(from) + todayRunning;

    return {
      allTimePnl,
      weeklyPnl: windowPnl(weekStart),
      monthlyPnl: windowPnl(monthStart),
      yearlyPnl: windowPnl(yearStart),
      peakEquity,
    };
  }

  getSnapshots(): DailySnapshot[] {
    return [...this.snapshots];
  }

  /**
   * TRA-2323 — the `optionsCreditedCumulative` baseline the next day's window
   * differences against: the value on the most recent booked row, or 0 when no
   * row carries one (a fresh book, or every row predating the fix).
   *
   * Reads the LAST row by date rather than "the row before today", to match how
   * `openingEquity` telescopes — `saveSnapshot` sets `openingEquity` to the row
   * it just closed, so the equity delta and this baseline span the same window
   * even when a day is skipped (weekend, outage, a redeploy that ate a close).
   */
  getLastOptionsCreditedCumulative(): number {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const v = this.snapshots[i]?.optionsCreditedCumulative;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
  }

  private persistState(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}
