// TRA-422 — account-settings helpers shared by the dashboards. Extracted from
// the pre-TRA-419 App.tsx (the helper was dropped during that decomposition,
// leaving Dashboard.tsx referencing an undefined name); restored here so the
// stock dashboard can resolve the active options daily-trade limit.
import type { AccountSettings } from '@trading-app/shared';

/**
 * Pick the options daily-trade limit that applies to the active account mode.
 * Live mode uses `optionsDailyTradesLimitLive` when present (TRA-327 split the
 * demo/live limits), falling back to the shared `optionsDailyTradesLimit`.
 */
export function pickOptionsDailyLimit(
  s: Partial<AccountSettings> | null | undefined,
): number | undefined {
  if (!s) return undefined;
  if (s.mode === 'live') {
    return typeof s.optionsDailyTradesLimitLive === 'number'
      ? s.optionsDailyTradesLimitLive
      : s.optionsDailyTradesLimit;
  }
  return s.optionsDailyTradesLimit;
}
