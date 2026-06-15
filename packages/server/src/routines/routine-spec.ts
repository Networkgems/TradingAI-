// TRA-851 — user-configurable schedules (natural-language routines).
//
// A "routine" is a recurring job a user defines in plain language instead of a
// hard-coded scheduler tick: "brief me at 8:30", "scan semis daily",
// "positions at 4pm". This module is the channel-agnostic, side-effect-free
// front half: it turns a raw NL phrase into a typed {@link ParsedRoutine}, and
// provides the pure helpers (sector/symbol filter matching, scan formatting,
// labels) the store / runner / chat router reuse. No I/O, no clock — so the
// whole grammar is trivially unit-testable.
//
// Persistence (per-user CRUD) lives in routine-store.ts; the time-match + fire
// loop lives in routine-runner.ts; the chat verbs live in the inbound
// command-parser/router. This file owns ONLY the language → structure mapping.

import { sectorOf } from '@trading-app/shared';

/** The recurring actions a routine can run. Each maps to an existing read path. */
export type RoutineAction = 'brief' | 'scan' | 'status' | 'positions';

export const ROUTINE_ACTIONS: readonly RoutineAction[] = ['brief', 'scan', 'status', 'positions'];

/**
 * Resolved target for a `scan` routine. `symbols` is an explicit ticker list;
 * `sector` is one of the {@link SECTOR_ALIASES} keys (e.g. "semis"). At most one
 * is set; an empty filter scans the user's whole signal set.
 */
export interface RoutineFilter {
  symbols?: string[];
  sector?: string;
}

/** The structured routine the parser yields (before the store assigns id/createdAt). */
export interface ParsedRoutine {
  action: RoutineAction;
  /** Fire time in ET, `HH:MM` 24h. */
  timeEt: string;
  filter?: RoutineFilter;
  /** When true (default) the routine only fires on NYSE trading days. */
  marketDaysOnly: boolean;
}

export type ParseRoutineResult =
  | { ok: true; routine: ParsedRoutine }
  | { ok: false; error: string };

/**
 * NL sector words → the symbol set they scan. "semis" is finer-grained than the
 * shared {@link sectorOf} buckets (which only know coarse "Technology"), so it is
 * an explicit ticker list; broader words ("tech") resolve through `sectorOf` at
 * match time via {@link SECTOR_BUCKET_ALIASES}. Hand-maintained, lowercase keys.
 */
export const SECTOR_SYMBOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  semis: ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'MU', 'TSM', 'ASML', 'SMCI'],
  semiconductors: ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'MU', 'TSM', 'ASML', 'SMCI'],
  chips: ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'MU', 'TSM', 'ASML', 'SMCI'],
};

/** NL sector words that resolve through the shared coarse {@link sectorOf} bucket. */
export const SECTOR_BUCKET_ALIASES: Readonly<Record<string, string>> = {
  tech: 'Technology',
  technology: 'Technology',
  crypto: 'Crypto',
  financials: 'Financials',
  finance: 'Financials',
  index: 'Index',
  indexes: 'Index',
};

/** Default fire time per action when the phrase names no explicit time. */
const DEFAULT_TIME_BY_ACTION: Record<RoutineAction, string> = {
  brief: '08:30', // mirrors the TRA-849 pre-market morning brief
  scan: '09:30', // the opening bell
  status: '16:05', // just after the close
  positions: '16:05',
};

/** Words that signal an action, in priority order (first hit wins). */
const ACTION_KEYWORDS: ReadonlyArray<[RoutineAction, readonly string[]]> = [
  ['brief', ['brief', 'briefing', 'briefme']],
  ['positions', ['positions', 'position', 'pos', 'book', 'holdings']],
  ['scan', ['scan', 'screen', 'scanner']],
  ['status', ['status', 'health', 'account']],
];

const KNOWN_SECTOR_WORDS = new Set<string>([
  ...Object.keys(SECTOR_SYMBOL_ALIASES),
  ...Object.keys(SECTOR_BUCKET_ALIASES),
]);

/** A ticker token in the source phrase (uppercase 1–5 letters, optional `-USD`). */
const TICKER_RE = /^[A-Z]{1,5}(?:-USD)?$/;

/**
 * Parse a natural-language routine phrase into a typed {@link ParsedRoutine}.
 *
 * Examples (case-insensitive):
 *   "brief me at 8:30"          → brief  @ 08:30
 *   "scan semis daily"          → scan   @ 09:30, sector=semis
 *   "scan AAPL, MSFT at 10am"   → scan   @ 10:00, symbols=[AAPL,MSFT]
 *   "positions at 4pm"          → positions @ 16:00
 *
 * Symbols must be UPPERCASE in the source (so "brief me" never reads "ME" as a
 * ticker). When no time is named, an action-specific default is used. Returns a
 * structured error string when no action verb is recognisable.
 */
export function parseRoutine(text: string | null | undefined): ParseRoutineResult {
  const raw = (text ?? '').trim();
  if (raw === '') return { ok: false, error: 'Empty routine — say e.g. "brief me at 8:30".' };

  const action = detectAction(raw);
  if (!action) {
    return {
      ok: false,
      error: 'Could not understand the routine. Try "brief me at 8:30" or "scan semis daily".',
    };
  }

  const parsedTime = extractTime(raw);
  if (parsedTime === 'invalid') {
    return { ok: false, error: 'Invalid time — use a 24h "HH:MM" or "8:30am" form.' };
  }
  const timeEt = parsedTime ?? DEFAULT_TIME_BY_ACTION[action];

  const filter = extractFilter(raw);
  const lower = raw.toLowerCase();
  // Trading routines default to NYSE trading days; an explicit weekend opt-in
  // (useful for 24/7 crypto scans) widens it to every calendar day.
  const marketDaysOnly = !/(incl(?:uding)?\s+weekends?|every\s+calendar\s+day|weekends?\s+too)/.test(lower);

  return {
    ok: true,
    routine: { action, timeEt, marketDaysOnly, ...(filter ? { filter } : {}) },
  };
}

/** First recognisable action verb in the phrase, or null. */
function detectAction(raw: string): RoutineAction | null {
  const lower = ` ${raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  for (const [action, words] of ACTION_KEYWORDS) {
    for (const w of words) {
      if (lower.includes(` ${w} `)) return action;
    }
  }
  return null;
}

/**
 * Extract a fire time as `HH:MM` (24h). Returns null when no time is present and
 * the literal `'invalid'` when a time-like token is out of range. Accepts
 * "8:30", "08:30", "8:30am", "8 am", "3pm", "15:30".
 */
function extractTime(raw: string): string | null | 'invalid' {
  const lower = raw.toLowerCase();
  // HH:MM with optional am/pm.
  let m = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/.exec(lower);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const mer = m[3];
    if (min > 59) return 'invalid';
    if (mer) {
      if (h < 1 || h > 12) return 'invalid';
      h = to24h(h, mer);
    } else if (h > 23) {
      return 'invalid';
    }
    return `${pad2(h)}:${pad2(min)}`;
  }
  // Bare "8am" / "3 pm" (no minutes).
  m = /\b(\d{1,2})\s*(am|pm)\b/.exec(lower);
  if (m) {
    const h12 = Number(m[1]);
    if (h12 < 1 || h12 > 12) return 'invalid';
    return `${pad2(to24h(h12, m[2]!))}:00`;
  }
  return null;
}

function to24h(h12: number, mer: string): number {
  const pm = mer === 'pm';
  if (h12 === 12) return pm ? 12 : 0;
  return pm ? h12 + 12 : h12;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Resolve a scan filter from the phrase: an explicit uppercase ticker list takes
 * precedence; otherwise the first known sector word. Returns undefined when the
 * phrase names neither (an all-symbols scan).
 */
function extractFilter(raw: string): RoutineFilter | undefined {
  // Symbols — uppercase ticker tokens in the SOURCE (commas/space separated).
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (TICKER_RE.test(t)) {
      const up = t.toUpperCase();
      if (!seen.has(up)) {
        seen.add(up);
        symbols.push(up);
      }
    }
  }
  if (symbols.length) return { symbols };

  // Sector — first known sector word.
  for (const tok of raw.toLowerCase().split(/[\s,]+/)) {
    if (KNOWN_SECTOR_WORDS.has(tok)) return { sector: tok };
  }
  return undefined;
}

/**
 * Does `symbol` match a routine filter? An undefined/empty filter matches
 * everything. `symbols` matches by exact ticker; `sector` matches either the
 * explicit alias ticker set or the shared coarse {@link sectorOf} bucket.
 */
export function symbolMatchesFilter(symbol: string, filter?: RoutineFilter): boolean {
  if (!filter) return true;
  const up = (symbol ?? '').toUpperCase();
  if (filter.symbols && filter.symbols.length) {
    return filter.symbols.some((s) => s.toUpperCase() === up);
  }
  if (filter.sector) {
    const explicit = SECTOR_SYMBOL_ALIASES[filter.sector];
    if (explicit) return explicit.some((s) => s.toUpperCase() === up);
    const bucket = SECTOR_BUCKET_ALIASES[filter.sector];
    if (bucket) return sectorOf(up) === bucket;
    return false;
  }
  return true;
}

/** Short human label for a filter, e.g. "AAPL, MSFT" / "semis" / "all". */
export function filterLabel(filter?: RoutineFilter): string {
  if (!filter) return 'all';
  if (filter.symbols && filter.symbols.length) return filter.symbols.join(', ');
  if (filter.sector) return filter.sector;
  return 'all';
}

/** Minimal signal shape the scan formatter reads (subset of `TradeSignal`). */
export interface ScanSignalLike {
  symbol: string;
  side: string;
  type: string;
  entryPrice?: number;
  timestamp?: number;
}

/**
 * Format the scan body for a routine: the most-recent signals matching the
 * filter, newest first, capped. Pure — the runner passes in the live signal
 * list. Returns a "no matching signals" line when nothing matches so the push is
 * never an empty message.
 */
export function formatScan(
  signals: readonly ScanSignalLike[],
  filter: RoutineFilter | undefined,
  max = 8,
): string {
  const matched = [...signals]
    .filter((s) => symbolMatchesFilter(s.symbol, filter))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, max);
  const scope = filterLabel(filter);
  if (matched.length === 0) return `Scan (${scope}): no matching signals.`;
  const rows = matched.map((s) => {
    const px = Number.isFinite(s.entryPrice) ? ` @ ${(s.entryPrice as number).toFixed(2)}` : '';
    return `  ${s.symbol} ${s.side} ${s.type}${px}`;
  });
  return [`Scan (${scope}) — ${matched.length} signal(s):`, ...rows].join('\n');
}
