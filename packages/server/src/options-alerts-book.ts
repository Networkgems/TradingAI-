// TRA-4501 — which book `GET /api/options/alerts` scans for target/stop hits.
//
// The route used to read `ctx.engine.getState()` with no view argument, i.e. the
// ROUTING book, while `/api/state` (the open-options table rendered directly
// above the alerts panel) reads the VIEW book through `viewMode` (TRA-3910). An
// operator routing live and viewing demo was shown stop hits from a book the
// table beside them was not showing, and missed the ones in the book it was.
//
// Both routes now take the book from `dashboardBookViewFor`, so they cannot
// drift apart again. Only the target/stop rows depend on the book: the
// chain-diff rows (`new_expiry` / `new_strike` / `iv_move`) come from chain
// partitions on disk and have no book to scope.
import type { AccountSettings, OptionPosition } from '@trading-app/shared';
import type { ChainDay } from '@trading-app/backtest';
import { computeOptionsAlerts, scanTargetStop } from './reports/options-alert-engine.js';

/**
 * Which book the dashboard should render, or `undefined` when the view simply
 * follows the engine's routing mode (the default for everyone). Only returns a
 * value when an override is set AND differs from `mode`, so the common path
 * keeps `getState()`'s default argument.
 */
export function dashboardBookViewFor(
  settings: Pick<AccountSettings, 'mode' | 'viewMode'>,
): 'demo' | 'live' | undefined {
  const v = settings.viewMode;
  if (v !== 'demo' && v !== 'live') return undefined;
  const routing: 'demo' | 'live' = settings.mode === 'live' ? 'live' : 'demo';
  return v === routing ? undefined : v;
}

/**
 * The `/api/options/alerts` response body. `openOptions` must be the book the
 * dashboard is showing (`dashboardEngineState(ctx).options.openOptions`), and
 * `bookView` is that state's own label, echoed so a reader can check the panel
 * and the table agree without guessing.
 */
export function buildOptionsAlertsBody(
  days: readonly ChainDay[],
  openOptions: readonly OptionPosition[],
  bookView: 'demo' | 'live' | undefined,
  opts?: Parameters<typeof scanTargetStop>[1],
) {
  if (days.length < 2) {
    const positionAlerts = scanTargetStop(openOptions, opts);
    return {
      issue: 'TRA-845',
      bookView,
      chainDates: days.map((d) => d.date),
      symbolsDiffed: [] as string[],
      counts: {
        new_expiry: 0,
        new_strike: 0,
        iv_move: 0,
        target_hit: positionAlerts.filter((a) => a.kind === 'target_hit').length,
        stop_hit: positionAlerts.filter((a) => a.kind === 'stop_hit').length,
      },
      alerts: positionAlerts,
      note: 'fewer than 2 chain partitions on disk — chain-diff skipped, target/stop only',
    };
  }
  const prevDay = days[days.length - 2];
  const todayDay = days[days.length - 1];
  const result = computeOptionsAlerts({
    prevBySymbol: prevDay.bySymbol,
    todayBySymbol: todayDay.bySymbol,
    openOptions,
    opts,
  });
  return { issue: 'TRA-845', bookView, chainDates: [prevDay.date, todayDay.date], ...result };
}
