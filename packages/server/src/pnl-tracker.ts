import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

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
   * repair, `'bucket-*'` = the legacy volatile in-memory bucket. Absent on rows
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
   * TRA-2829 — how `closingEquity` on a back-filled row was established.
   * `'broker-eod-balance'` = read from `tradier-eod-balance.<env>.json` for that
   * exact session. `'not-measured'` = the balance series has no entry, so
   * `closingEquity`/`openingEquity` are `null`. Absent on recorded rows.
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
}

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function startOfWeek(): string {
  const now = new Date();
  const dow = now.getDay();
  const diff = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - diff);
  return mon.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export class PnlTracker {
  private readonly stateFile: string;
  private readonly snapshotsFile: string;
  private initialEquity: number;
  private hadSavedState: boolean;
  private state: PersistedState;
  private snapshots: DailySnapshot[] = [];

  constructor(dataDir: string, initialEquity = 25_000) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
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

  private advanceDayIfNeeded(): void {
    const today = todayKey();
    if (this.state.openingDate !== today) {
      this.state.openingEquity = this.state.equity;
      this.state.openingOptionsPnl = this.state.optionsPnl;
      this.state.openingDate = today;
      this.persistState();
    }
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
    this.persistState();
  }

  saveSnapshot(snapshot: DailySnapshot): void {
    this.snapshots = this.snapshots.filter(s => s.date !== snapshot.date);
    this.snapshots.push(snapshot);
    this.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(this.snapshotsFile, JSON.stringify(this.snapshots, null, 2), 'utf-8');

    // TRA-2829 — a real day close always carries a measured `closingEquity`, so
    // this guard should never fire from `generateAndSaveReport`. It exists so
    // that if some future caller ever hands `saveSnapshot` an unmeasured row,
    // the dashboard's opening equity is LEFT ALONE rather than rebased to
    // `null` — which would read as $0 and manufacture a book-sized phantom P&L.
    if (snapshot.closingEquity !== null && Number.isFinite(snapshot.closingEquity)) {
      this.state.openingEquity = snapshot.closingEquity;
      this.state.openingOptionsPnl = this.state.optionsPnl;
      this.state.openingDate = snapshot.date;
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
    const today = todayKey();
    const weekStart = startOfWeek();
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart = `${now.getFullYear()}-01-01`;

    const past = this.snapshots.filter(s => s.date < today);
    // TRA-1633 BUG 2 — sum DAY-ONLY realized (stock `dailyPnl` + day-only
    // `optionsDailyPnl`) over each window, NOT the per-snapshot `combinedPnl`.
    // `combinedPnl` carried the mode's ALL-TIME cumulative options total
    // (`optionsPnl` booked from `optionsAccount.optionsPnl` at index.ts), so the
    // weekly/monthly/yearly windows re-added the running options total on every
    // day with option activity — the same phantom class TRA-1557 removed from
    // `allTimePnl`. `optionsDailyPnl` is absent on legacy rows (→ 0), so they
    // contribute stock-only rather than a phantom.
    const sum = (from: string) =>
      past
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
    // every P&L surface agrees. `dailyPnl` (the stock equity delta) — not
    // `combinedPnl` — keeps the stock-only basis the equity-mark all-time always
    // had (`totalEquity` excludes the separately-tracked options P&L), so this
    // only removes the re-anchor leak and changes nothing on a continuously-run
    // book: with every day booked, `openingEquity` telescopes to the last close
    // and the sum collapses back to `currentEquity - initialEquity`.
    const bookedStockPnl = this.snapshots.reduce((acc, s) => acc + s.dailyPnl, 0);
    const todayRunning = currentEquity - this.state.openingEquity;
    const allTimePnl = bookedStockPnl + todayRunning;

    return {
      allTimePnl,
      weeklyPnl: sum(weekStart),
      monthlyPnl: sum(monthStart),
      yearlyPnl: sum(yearStart),
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
