// TRA-5202 (parent TRA-5192) — the TRA-554 daily equity trades gate counted a
// POOLED population. `SignalEngine.dailySignals` is one list per engine, and the
// options sleeves push into it too: every `relative_value` / `otm_mispricing` row
// — including rows for option signals that were REFUSED and never booked a trade
// (taxonomy, entry window, delta floor/ceiling, allowlist, churn brake, …). On
// 2026-10-05 the demo equity sleeve rejected 8 of 14 candidates
// `daily_trades_limit` on a day whose book held exactly ONE trade (an XLF
// option): the option sleeve's signal rows had consumed the equity sleeve's
// entry budget. A sleeve gated off by a sibling sleeve's activity reads
// identically to a sleeve with no signal — so the count is split here, in a
// pure function the gate calls and a test can hold still.
import type { SignalType } from '@trading-app/shared';
import type { DailySignalRecord } from './reports/eod-report.js';
import { etDateString } from './scheduler.js';

/**
 * `dailySignals` rows the daily EQUITY gate must NOT count.
 *
 * These are the two literals the options-sleeve push sites stamp
 * (`this.dailySignals.push({ …type: 'relative_value' | 'otm_mispricing' })` in
 * signal-engine.ts). The options sleeves carry their OWN cap
 * (`optionsDailyTradesLimit`, enforced in PaperOptionsAccount), so counting
 * their rows here charged one budget twice and the equity budget with trades
 * it never made.
 *
 * The equity chokepoint pushes `type: signal.type` (an equity strategy type),
 * never a literal — `daily-trades-gate.test.ts` holds that convention in place
 * by scanning the push sites, so a new sleeve cannot silently re-pool.
 */
export const OPTION_SLEEVE_DAILY_SIGNAL_TYPES: ReadonlySet<SignalType> = new Set<SignalType>([
  'relative_value',
  'otm_mispricing',
]);

/** The two halves of today's `dailySignals` population, split by sleeve. */
export interface DailyTradesSplit {
  /** Rows the equity cap counts: today's equity-sleeve entries. */
  equityCount: number;
  /** Today's options-sleeve rows — visible for the funnel detail, never counted. */
  optionSleeveCount: number;
}

/**
 * Count today's `dailySignals` rows per sleeve. `dayKey` is an ET calendar day
 * (`etDateString`) — rows from other ET days are ignored entirely, matching the
 * gate's pre-existing day filter.
 */
export function splitDailySignalsForEquityGate(
  rows: readonly DailySignalRecord[],
  dayKey: string,
): DailyTradesSplit {
  let equityCount = 0;
  let optionSleeveCount = 0;
  for (const s of rows) {
    if (etDateString(new Date(s.firedAt)) !== dayKey) continue;
    if (OPTION_SLEEVE_DAILY_SIGNAL_TYPES.has(s.type)) optionSleeveCount += 1;
    else equityCount += 1;
  }
  return { equityCount, optionSleeveCount };
}
