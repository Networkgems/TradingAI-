// TRA-422 — the Stocks Options tab, extracted from Dashboard.tsx. Renders the
// open / closed option tables and the bottom buying-power summary; the close
// flow (direct close, the Tradier limit-close drawer, pending-exit cancel and
// the manual Tradier sync) is owned by the useStockOptionClose hook.
import type { AccountState, OptionsAccountState, OptionPosition } from '@trading-app/shared';
import { fmt, fmtDollar, fmtPct, formatTime, formatExpirationShort, signalLabel } from '../../lib/format';
import { useTableSort, sortRows, SortableTH } from '../../lib/sort.tsx';
import { getOptionOpenSortValue, getOptionClosedSortValue } from '../../lib/stockSort';
import type { OptionOpenSortKey, OptionClosedSortKey } from '../../lib/stockSort';
import { useStockOptionClose } from '../../hooks/useStockOptionClose';
import { CloseOptionDrawer } from './CloseOptionDrawer';
import { AccountSummaryCard } from './AccountSummaryCard';
import { PortfolioGreeksPanel } from './PortfolioGreeksPanel';
import { OptionsAlertsPanel } from './OptionsAlertsPanel';

export function StockOptionsPanel({
  token,
  tradierEnv,
  accountMode,
  account,
  optionsState,
  openOptions,
  closedOptions,
  optionsDailyLimit,
}: {
  token: string;
  tradierEnv: 'sandbox' | 'production';
  accountMode: 'demo' | 'live';
  account: AccountState | undefined;
  optionsState: OptionsAccountState | undefined;
  openOptions: OptionPosition[];
  closedOptions: OptionPosition[];
  optionsDailyLimit: number;
}) {
  const openOptSort = useTableSort<OptionOpenSortKey>('opened', 'desc');
  const closedOptSort = useTableSort<OptionClosedSortKey>('closed', 'desc');
  const {
    closeDrawer, setCloseDrawer, closeDrawerRef, closeDrawerCancel, submitCloseDrawer,
    openCloseDrawer, cancelPendingExit, cancellingExits, closingOptions,
    syncTradierPositions, tradierSyncing, tradierSyncStatus,
  } = useStockOptionClose(token, tradierEnv);

  // TRA-503 — Demo doesn't route through Tradier, so the manual "Sync Tradier
  // positions" import has nothing to pull. Hide the button (and its status
  // line) in demo to avoid the misleading "production" wording in the demo
  // header.
  const showTradierSync = accountMode === 'live';

  return (
    <div className="positions-panel">
      {/* TRA-1125 — Open Option Positions hoisted to the top of the Options tab
          so the live book is the first thing the user sees. The account summary,
          portfolio Greeks and the (now collapsed-by-default) Options Alerts
          panel follow below. */}
      {openOptions.length > 0 && (
        <>
          <h3 style={{ marginTop: 0 }}>Open Option Positions</h3>
          <table>
            <thead>
              <tr>
                <SortableTH label="Symbol" sortKey="symbol" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <SortableTH label="Type" sortKey="type" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                {/* TRA-372 — surface contract detail directly on the table. */}
                <th>Strike</th>
                <th>Expiration</th>
                <SortableTH label="Contracts" sortKey="contracts" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <SortableTH label="Premium Paid" sortKey="premiumPaid" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <SortableTH label="Current Mark" sortKey="currentMark" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <SortableTH label="Status" sortKey="status" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <th>Trail / SL</th>
                <th>Signal</th>
                <SortableTH label="Opened" sortKey="opened" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortRows(openOptions, openOptSort.sort, getOptionOpenSortValue).map(o => {
                // TRA-367 — imports flow through the same auto-managed pipeline
                // as engine-opened rows; render Current Mark / P&L / Status /
                // Trail-SL the same way for both origins. The `(Tradier)` badge
                // still flags origin so the user knows closing routes a real
                // `sell_to_close`.
                const isImported = !!o.importedFromTradier;
                const hasMark = Number.isFinite(o.currentPremium) && o.currentPremium > 0 && o.premiumPaid > 0;
                const pnlPct = hasMark ? ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100 : 0;
                const unrealized = hasMark ? (o.currentPremium - o.premiumPaid) * o.contractsRemaining * 100 : 0;
                const pnlDollar = unrealized + (o.pnl ?? 0);
                // Auto-managed imports get RV-default thresholds; legacy imports
                // with auto-management off keep sentinels and render "—".
                const hasStopSchedule = o.stopLossPremium > 0 && Number.isFinite(o.tp1Premium);
                return (
                  <tr key={o.id}>
                    <td className="symbol">
                      {o.symbol}
                      {isImported && (
                        <span
                          className="muted"
                          title="Imported from Tradier — closing here will submit a sell-to-close order on Tradier"
                          style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}
                        >
                          (Tradier)
                        </span>
                      )}
                    </td>
                    <td className={o.optionType === 'call' ? 'green' : 'red'}>
                      {o.optionType.toUpperCase()}
                    </td>
                    <td>{o.strike != null ? `$${Math.round(o.strike)}` : '—'}</td>
                    <td className="muted">{o.expiration ? formatExpirationShort(o.expiration) : '—'}</td>
                    <td>{o.contracts}</td>
                    <td>${fmt(o.premiumPaid)}</td>
                    <td className={!hasMark ? 'muted' : (pnlPct >= 0 ? 'green' : 'red')}>
                      {hasMark ? `$${fmt(o.currentPremium)} (${fmtPct(pnlPct)})` : '—'}
                    </td>
                    <td className={!hasMark ? 'muted' : (pnlDollar >= 0 ? 'green' : 'red')}>
                      {hasMark ? fmtDollar(pnlDollar) : '—'}
                    </td>
                    <td className={o.trailingActive ? 'green' : 'muted'}>
                      {o.trailingActive ? 'TRAILING' : 'OPEN'}
                    </td>
                    <td className={hasStopSchedule ? 'red' : 'muted'}>
                      {!hasStopSchedule
                        ? '—'
                        : o.trailingActive
                          ? `$${fmt(o.trailingStopPremium)} (trail)`
                          : `$${fmt(o.stopLossPremium)} (SL)`}
                    </td>
                    <td>{signalLabel(o.signalType)}</td>
                    <td className="muted">{formatTime(o.openedAt)}</td>
                    <td>
                      {/* TRA-348 / TRA-358 — a working sell_to_close swaps the
                          Close button for a disabled "Pending #N" badge so the
                          user can't fire a duplicate. Engine-opened LIVE rows
                          carry `pendingExit` (limit + qty + duration) and get a
                          Cancel button; reject reasons land on `exitErrorReason`. */}
                      {(() => {
                        const isLiveEngineOpened = !isImported && o.mode === 'live';
                        if (o.pendingCloseOrderId != null) {
                          return (
                            <button
                              className="btn-close-pos"
                              disabled
                              title="Tradier sell_to_close accepted but not yet filled"
                            >
                              Pending #{o.pendingCloseOrderId}
                            </button>
                          );
                        }
                        if (o.pendingExit) {
                          const orderRef = o.pendingExit.tradierOrderId === '' || o.pendingExit.tradierOrderId === undefined
                            ? '?'
                            : String(o.pendingExit.tradierOrderId);
                          const cancelInFlight = cancellingExits[o.id] === true;
                          return (
                            <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                              <button
                                className="btn-close-pos"
                                disabled
                                title={`Tradier sell_to_close ${o.pendingExit.kind} qty=${o.pendingExit.qty} @ $${o.pendingExit.limitPrice.toFixed(2)} duration=${o.pendingExit.duration ?? 'day'}`}
                              >
                                Pending #{orderRef}
                              </button>
                              <button
                                className="btn-secondary"
                                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                                disabled={cancelInFlight}
                                onClick={() => cancelPendingExit(o.id)}
                                title="Cancel the working Tradier sell_to_close"
                              >
                                {cancelInFlight ? 'Cancelling…' : 'Cancel'}
                              </button>
                            </span>
                          );
                        }
                        const closeInFlight = closingOptions[o.id] === true;
                        return (
                          <button
                            className="btn-close-pos"
                            disabled={closeInFlight}
                            onClick={() => openCloseDrawer(o, isLiveEngineOpened)}
                            title={isLiveEngineOpened
                              ? 'Open the limit-close panel (mirrors Tradier price/qty/duration)'
                              : 'Close this position'}
                          >
                            {closeInFlight ? 'Closing…' : 'Close'}
                          </button>
                        );
                      })()}
                      {o.exitErrorReason && (
                        <div className="muted" style={{ fontSize: '0.7rem', marginTop: '0.25rem', maxWidth: '12rem', whiteSpace: 'normal' }}>
                          {o.exitErrorReason}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <AccountSummaryCard account={account} accountMode={accountMode} />
      {/* TRA-844 — portfolio Greeks + theta-$ bleed + allocation-by-name/sector
          over the open options book. Renders nothing when the book is empty. */}
      <PortfolioGreeksPanel greeks={optionsState?.portfolioGreeks} />
      {/* TRA-845 — Layer-4 alert engine: new strikes/expiries + big IV moves
          (chain-diff) and target/stop hits, from /api/options/alerts. TRA-1125:
          collapsed by default to cut the noise on the tab. */}
      <OptionsAlertsPanel token={token} />
      {/* TRA-323 — pull open option positions from Tradier into TradeAI so they
          can be closed from here. The button targets the Tradier env selected
          in Settings; the toast that follows reports the count summary. */}
      {showTradierSync && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={syncTradierPositions}
            disabled={tradierSyncing}
            title={`Pull open option positions from Tradier ${tradierEnv} into TradeAI`}
          >
            {tradierSyncing ? 'Syncing…' : `Sync Tradier ${tradierEnv} positions`}
          </button>
          {tradierSyncStatus && (
            <span className="muted" style={{ fontSize: '0.85rem' }}>{tradierSyncStatus}</span>
          )}
        </div>
      )}

      {closedOptions.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem' }}>
            Closed Today ({closedOptions.length})
          </h3>
          <table>
            <thead>
              <tr>
                <SortableTH label="Symbol" sortKey="symbol" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <SortableTH label="Type" sortKey="type" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                {/* TRA-372 — mirror Open Options contract detail on the closed table too. */}
                <th>Strike</th>
                <th>Expiration</th>
                <SortableTH label="Contracts" sortKey="contracts" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <SortableTH label="Premium Paid" sortKey="premiumPaid" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <SortableTH label="Exit Premium" sortKey="exitPremium" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <SortableTH label={<>P&amp;L %</>} sortKey="pnlPct" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                <th>Signal</th>
                <SortableTH label="Closed" sortKey="closed" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
              </tr>
            </thead>
            <tbody>
              {sortRows(closedOptions, closedOptSort.sort, getOptionClosedSortValue).map(o => {
                const pnlDollar = o.pnl ?? 0;
                // TRA-367 — P&L % from entry-to-exit premium.
                const hasEntry = o.premiumPaid > 0;
                const pnlPct = hasEntry ? ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100 : 0;
                return (
                  <tr key={o.id}>
                    <td className="symbol">{o.symbol}</td>
                    <td className={o.optionType === 'call' ? 'green' : 'red'}>
                      {o.optionType.toUpperCase()}
                    </td>
                    <td>{o.strike != null ? `$${Math.round(o.strike)}` : '—'}</td>
                    <td className="muted">{o.expiration ? formatExpirationShort(o.expiration) : '—'}</td>
                    <td>{o.contracts}</td>
                    <td>${fmt(o.premiumPaid)}</td>
                    <td>${fmt(o.currentPremium)}</td>
                    <td className={!hasEntry ? 'muted' : pnlPct >= 0 ? 'green' : 'red'}>
                      {hasEntry ? fmtPct(pnlPct) : '—'}
                    </td>
                    <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                    <td>{signalLabel(o.signalType)}</td>
                    <td className="muted">{o.closedAt ? formatTime(o.closedAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {openOptions.length === 0 && closedOptions.length === 0 && (
        <div className="empty">
          No open option positions. Stock options are opened by the <strong>Relative Value</strong> scanner — it pulls each ticker's full chain, fits the IV skew across nearby strikes, and buys long premium on contracts that are statistically cheap vs. the local curve / monotonic price / no-arb checks.
          <br /><br />
          <strong>Strategy:</strong> long premium only · cheap call → buy CALL · cheap put → buy PUT · no naked short legs<br />
          <strong>Take profit:</strong> +40% partial exit (50%) → trailing stop activates at +25%, trails 15% below peak · <strong>Stop loss:</strong> −25% · <strong>Cap:</strong> {optionsDailyLimit} option trades/day per env
          <br /><br />
          <span className="muted">Closed contracts stay listed here until the 9:00 PM ET archive — full per-day history is under the <strong>Calendar</strong> tab.</span>
        </div>
      )}

      {optionsState && (() => {
        // TRA-367 — on Live mode the paper "Options Cash" bucket is misleading;
        // show the broker-side option buying power instead. `optionBuyingPower`
        // is absent in demo and before the first Tradier balance fetch lands.
        const isLive = accountMode === 'live';
        const liveOptionBP = isLive ? account?.optionBuyingPower : undefined;
        const showLiveBP = isLive && typeof liveOptionBP === 'number';
        // TRA-483 — surface Day Trade Buying Power next to Option BP so the
        // user can see when DTBP=$0 is the reason no live RV trades are
        // opening (the screenshot in the issue showed positive Option BP
        // but DTBP $0). Only margin / PDT accounts carry it.
        const liveDayTradeBP = isLive ? account?.dayTradeBuyingPower : undefined;
        const showLiveDayTradeBP = isLive && typeof liveDayTradeBP === 'number';
        // TRA-711 — the footer "Total Options P&L" previously read the engine's
        // cumulative mode-scoped realized total (`optionsState.optionsPnl`),
        // which sits directly under the open-positions table yet contradicted
        // every row in it (board screenshot: visible opens summed to +$41.50
        // while the footer showed −$79.50 of old realized closes). Recompute it
        // from exactly the rows the panel renders so the total always equals
        // the sum of the per-row P&L the user can see: open unrealized
        // (`(mark − paid) × contractsRemaining × 100` + any partial-exit
        // realized) plus today's closed realized. Mirrors the row formulas at
        // the open/closed table bodies above.
        const totalOptionsPnl =
          openOptions.reduce((sum, o) => {
            const hasMark = Number.isFinite(o.currentPremium) && o.currentPremium > 0 && o.premiumPaid > 0;
            const unrealized = hasMark ? (o.currentPremium - o.premiumPaid) * o.contractsRemaining * 100 : 0;
            return sum + unrealized + (o.pnl ?? 0);
          }, 0)
          + closedOptions.reduce((sum, o) => sum + (o.pnl ?? 0), 0);
        return (
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            {showLiveBP ? (
              <span title="Tradier option buying power for the active live env">
                Options Buying Power: <strong>${fmt(liveOptionBP!)}</strong>
              </span>
            ) : (
              <span>Options Cash: <strong>${fmt(optionsState.optionsCash)}</strong></span>
            )}
            {showLiveDayTradeBP ? (
              <span title="Tradier day-trade buying power (PDT limit). When this hits $0 the live engine refuses new day-trade RV opens.">
                Day Trade BP:{' '}
                <strong className={liveDayTradeBP! <= 0 ? 'red' : ''}>
                  ${fmt(liveDayTradeBP!)}
                </strong>
              </span>
            ) : null}
            <span>Total Options P&amp;L: <strong className={totalOptionsPnl >= 0 ? 'green' : 'red'}>{fmtDollar(totalOptionsPnl)}</strong></span>
            <span>Daily Trades: <strong className={optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}>{optionsState.dailyOptionsCount}/{optionsDailyLimit}</strong></span>
            {/* TRA-374 — surface the demo cost-model drag (slippage + per-contract
                fee). Hidden in live and when both buckets are 0. */}
            {accountMode === 'demo'
              && (typeof optionsState.demoSlippageCost === 'number' || typeof optionsState.demoFeeCost === 'number')
              && ((optionsState.demoSlippageCost ?? 0) > 0 || (optionsState.demoFeeCost ?? 0) > 0) ? (
              <>
                <span title="Demo-only modelled slippage haircut paid across opens + closes (TRA-374).">
                  Demo Slippage: <strong className="red">−${fmt(optionsState.demoSlippageCost ?? 0)}</strong>
                </span>
                <span title="Demo-only modelled per-contract fee debited across opens + closes (TRA-374).">
                  Demo Fees: <strong className="red">−${fmt(optionsState.demoFeeCost ?? 0)}</strong>
                </span>
              </>
            ) : null}
          </div>
        );
      })()}

      <CloseOptionDrawer
        closeDrawer={closeDrawer}
        drawerRef={closeDrawerRef}
        setCloseDrawer={setCloseDrawer}
        onCancel={closeDrawerCancel}
        onSubmit={submitCloseDrawer}
      />
    </div>
  );
}
