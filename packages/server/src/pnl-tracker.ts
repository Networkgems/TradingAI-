import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface DailySnapshot {
  date: string;
  openingEquity: number;
  closingEquity: number;
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

    this.state.openingEquity = snapshot.closingEquity;
    this.state.openingOptionsPnl = this.state.optionsPnl;
    this.state.openingDate = snapshot.date;
    this.persistState();
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

    const peakEquity = Math.max(
      this.initialEquity,
      currentEquity,
      ...this.snapshots.map(s => s.closingEquity),
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

  private persistState(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}
