import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface DailySnapshot {
  date: string;
  openingEquity: number;
  closingEquity: number;
  dailyPnl: number;
  optionsPnl: number;
  combinedPnl: number;
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
  private readonly initialEquity: number;
  private state: PersistedState;
  private snapshots: DailySnapshot[] = [];

  constructor(dataDir: string, initialEquity = 25_000) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.initialEquity = initialEquity;
    this.stateFile = join(dataDir, 'equity-state.json');
    this.snapshotsFile = join(dataDir, 'daily-snapshots.json');
    this.state = this.loadState();
    this.snapshots = this.loadSnapshots();
    this.advanceDayIfNeeded();
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
    const sum = (from: string) =>
      past.filter(s => s.date >= from).reduce((acc, s) => acc + s.combinedPnl, 0);

    const peakEquity = Math.max(
      this.initialEquity,
      currentEquity,
      ...this.snapshots.map(s => s.closingEquity),
    );

    return {
      allTimePnl: currentEquity - this.initialEquity,
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
