// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.


export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const DAY_LABELS_FULL = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
export const DAY_LABELS_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

// TRA-369 — stocks market is closed Sat/Sun, so any P&L row dated on a
// weekend is stale/imported noise. Strip weekend rows so monthly totals,
// trading-day counts, and win-rate stats reflect the real trading week.
export function isWeekendIso(dateIso: string): boolean {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun … 6=Sat
  return dow === 0 || dow === 6;
}

// Compact P&L format matching the Webull reference: +$1.00K, -$234.56, --
export function fmtCompact(value: number): string {
  // TRA-1192 — a day that HAS a report but netted zero realized P&L is still a
  // *reported* day; render it as "$0.00", not "--". Only a date with no report
  // at all renders "--" (handled at the call site by the `report ? … : --`
  // guard). Conflating the two made every flat/in-progress day — and today's
  // running cell before any close — look like missing data on the calendar.
  if (value === 0) return '$0.00';
  const sign = value > 0 ? '+' : '-';
  const abs  = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtDollar(n: number) {
  // TRA-424 — same negative-sign bug as lib/format.ts#fmtDollar: `Math.abs(n)`
  // strips the sign so the negative branch must prepend '-' explicitly.
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${fmt(Math.abs(n))}`;
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// TRA-2246 — Week view helpers. Weeks start on Monday to line up with the month
// grid's Mon–Fri columns.
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function startOfWeekMonday(d: Date): Date {
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const backToMon = dow === 0 ? 6 : dow - 1;
  return addDays(d, -backToMon);
}

// Build an array of weeks for the given month. Each week is an N-element array
// of day numbers or null for out-of-month / padding.
// TRA-369 — the stocks market is closed on Sat/Sun, so the stocks calendar
// renders Mon–Fri only and skips weekend rows. `cols` controls the layout:
// 7 → Mon–Sun, 5 → Mon–Fri (stocks).
export function buildMonthWeeks(year: number, month: number, cols: 5 | 7): (number | null)[][] {
  const weeks: (number | null)[][] = [];
  const lastDayNum = new Date(year, month + 1, 0).getDate();
  const emptyWeek = (): (number | null)[] => Array.from({ length: cols }, () => null);
  let week = emptyWeek();

  for (let d = 1; d <= lastDayNum; d++) {
    const dow = new Date(year, month, d).getDay(); // 0=Sun … 6=Sat
    if (cols === 5 && (dow === 0 || dow === 6)) {
      // Skip weekends in the stocks layout; close the row on Friday or month-end.
      if (dow === 0 || d === lastDayNum) {
        // Only push if the row already has at least one weekday entry.
        if (week.some(c => c !== null)) {
          weeks.push(week);
          week = emptyWeek();
        }
      }
      continue;
    }
    const col = cols === 5
      ? dow - 1                              // Mon=0 … Fri=4
      : (dow === 0 ? 6 : dow - 1);           // Mon=0 … Sun=6
    week[col] = d;
    const endOfWeek = cols === 5 ? dow === 5 : dow === 0;
    if (endOfWeek || d === lastDayNum) {
      weeks.push(week);
      week = emptyWeek();
    }
  }

  return weeks;
}

// ── Month grid ──────────────────────────────────────────────────────────────

