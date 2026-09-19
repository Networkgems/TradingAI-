// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.
import type { EodReport } from '@trading-app/shared';
import { UNLABELLED_MEASURE, pnlMeasure, deskFoldScope } from './pnl-day';
import { fmt, fmtDollar } from './format';

export function EodReportDetail({ report, onBack }: { report: EodReport; onBack: () => void }) {
  // TRA-3100 — the detail view is where "what does this number actually measure"
  // has to be answerable. The grid badge is a hint; this is the statement.
  const measure = pnlMeasure(report) ?? UNLABELLED_MEASURE;
  const superseded = report.supersededPnl;
  // TRA-3101 — when the day is unmeasured, the detail view must not print the
  // artefact figure anywhere, including the header strip. This is the screen an
  // auditor opens to check a cell; a `$0.00` here is the claim being disputed.
  const unknown = report.pnlUnknown;
  // TRA-3102 — and the auditor opening this screen on a green July cell needs to
  // be told the number is the engine's, not the broker's, before reading anything
  // else on the page.
  const unreconciled = report.pnlUnreconciled;
  // TRA-4201 — the realized companion, when the backfill reconstructed one.
  const companion = report.brokerRealized;
  // TRA-4203 — and WHOSE book this day is. This screen is the one an auditor
  // opens to check a cell, and until this ticket it printed the firm-wide fold's
  // trade log — other people's books — under an "EOD Report" header with nothing
  // saying so.
  const scope = deskFoldScope(report);
  return (
    <section className="eod-panel">
      <div className="eod-header" style={{ cursor: 'default' }}>
        <button className="cal-back-btn" onClick={onBack} title="Back to calendar">&#8592; Back</button>
        <span className="eod-title" style={{ flex: 1 }}>EOD Report — {report.date}</span>
        <span className="eod-summary">
          {unknown ? (
            <span className="cal-pnl--unknown" title={unknown.detail}>P&amp;L unknown</span>
          ) : unreconciled ? (
            // TRA-3102 — the header strip is the first thing read on this screen,
            // so it must not print a green figure the broker never confirmed.
            <span className="cal-pnl--unreconciled" title={unreconciled.detail}>
              {fmtDollar(report.combinedPnl)} (not broker-confirmed)
            </span>
          ) : (
            <span className={report.combinedPnl >= 0 ? 'green' : 'red'}>
              {fmtDollar(report.combinedPnl)}
            </span>
          )}
          &nbsp;·&nbsp;Win rate {(report.winRate * 100).toFixed(0)}%
          &nbsp;·&nbsp;{report.totalTrades} trades
        </span>
      </div>

      <div className="eod-body">
        {/* TRA-4203 — FIRST, above every measure banner. "What does this number
            measure" is the wrong question to answer first when the answer to
            "whose money is it" is `not yours`. */}
        {scope && (
          <div className="cal-scope-banner">
            <div>
              <strong>
                ⚠ This day is the FIRM-WIDE Desk fold — it is NOT this account&rsquo;s money.
              </strong>
            </div>
            <div className="cal-unknown-detail">{scope.detail}</div>
            <div className="cal-unknown-detail">
              The trade log below is the firm&rsquo;s demo Option-Trade Journal —{' '}
              {scope.tradeCount} trade{scope.tradeCount === 1 ? '' : 's'} across every demo book in
              the company, not this account&rsquo;s. This account&rsquo;s own demo book has no
              activity for {report.date}, which is the condition the fold exists to fill
              (TRA-1572). Nothing here is wrong; it is simply somebody else&rsquo;s.
            </div>
          </div>
        )}
        {unknown && (
          <div className="cal-unknown-banner">
            <div>
              <strong>⚠ This day&rsquo;s P&amp;L could not be established — it is UNKNOWN, not $0.00.</strong>
            </div>
            <div className="cal-unknown-detail">{unknown.detail}</div>
            <div className="cal-unknown-detail">
              Anchor {unknown.anchorDate} ({fmtDollar(unknown.anchorBalance)}) vs {report.date} (
              {fmtDollar(unknown.reportedBalance)}), span {unknown.spanDays}d
              {unknown.evidence.known ? (
                <>
                  {' '}· evidence: {unknown.evidence.brokerCloses} broker closes,{' '}
                  {fmtDollar(unknown.evidence.brokerRealizedUsd)} realized,{' '}
                  {unknown.evidence.engineTrades} engine trades,{' '}
                  {unknown.evidence.openPositions} open positions
                </>
              ) : (
                <> · evidence UNREADABLE: {unknown.evidence.reason}</>
              )}
            </div>
            <div className="cal-unknown-detail">
              The value has deliberately <em>not</em> been re-derived: a stale anchor means the equity
              series has a hole, and filling it by inference is what produced the original
              phantom-green calendar. The engine-side breakdown below is unaffected by this and is
              still shown.
            </div>
          </div>
        )}
        {unreconciled && (
          <div className="cal-unreconciled-banner">
            <div>
              <strong>
                ⚠ The P&amp;L shown for this day is NOT broker-confirmed — it comes from the
                engine&rsquo;s own closed-trade record.
              </strong>
            </div>
            <div className="cal-unknown-detail">{unreconciled.detail}</div>
            <div className="cal-unknown-detail">
              Rendered {fmtDollar(unreconciled.renderedPnl)} · engine options{' '}
              {fmtDollar(unreconciled.engineOptionsPnl)} ·{' '}
              {unreconciled.brokerPnl === null
                ? 'broker figure UNKNOWN (the comparison could not be made)'
                : `broker ${fmtDollar(unreconciled.brokerPnl)}`}{' '}
              · <code>{unreconciled.reason}</code>
            </div>
            <div className="cal-unknown-detail">
              The figure has deliberately <em>not</em> been corrected — this row is flagged, not
              rewritten. It is excluded from the monthly and weekly totals. An engine close with no
              matching broker fill is not money that moved.
            </div>
          </div>
        )}
        <div className="cal-measure-banner" title={measure.title}>
          <strong>P&amp;L measure:</strong> {measure.label}
          {superseded && (
            <>
              {' '}· <em>corrected {new Date(superseded.at).toLocaleDateString()} — previously read{' '}
              {fmtDollar(superseded.combinedPnl)} from “{superseded.pnlSource}”</em>
            </>
          )}
        </div>
        {/* TRA-4201 — the SECOND measure, stated next to the first rather than
            instead of it. On a protected row the figure above is the account-value
            delta and this is the broker-fill realized figure for the same day;
            they are two measures of one day and are never added together. The
            option/stock split is kept because folding them would tie the day out
            while misattributing which sleeve earned it (TRA-2876). */}
        {companion && (
          <div className="cal-measure-banner" title="Realized P&L on positions the broker recorded as CLOSED this day, FIFO-matched from Tradier fills. Stored beside the authoritative figure, never instead of it.">
            <strong>Realized (broker fills):</strong>{' '}
            {companion.closeCount === 0 ? (
              <em>no positions closed this day — 0 broker closes. Not $0.00; this day did not trade.</em>
            ) : (
              <>
                <span className={companion.combinedPnl >= 0 ? 'green' : 'red'}>
                  {fmtDollar(companion.combinedPnl)}
                </span>{' '}
                (options {fmtDollar(companion.optionsPnl)} · stocks {fmtDollar(companion.equityPnl)})
                {' '}· {companion.closeCount} close{companion.closeCount === 1 ? '' : 's'}
                {!companion.equityIncluded && (
                  <> · <strong>⚠ options only</strong> — stock realized was withheld this pass
                  (corporate-action feed unreadable or a split invalidated the lot book), so this
                  will not tie to an all-instrument statement.</>
                )}
              </>
            )}
          </div>
        )}
        <div className="eod-stats-row">
          <div className="eod-stat">
            <span className="eod-stat-label">Realized P&amp;L</span>
            <span className={`eod-stat-value ${report.realizedPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.realizedPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Unrealized P&amp;L</span>
            <span className={`eod-stat-value ${report.unrealizedPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.unrealizedPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Options P&amp;L</span>
            <span className={`eod-stat-value ${report.optionsPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.optionsPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Combined P&amp;L</span>
            {/* TRA-3101 — the stat tile is the second place the artefact zero
                would otherwise be printed as a finding. */}
            {unknown ? (
              <span className="eod-stat-value cal-pnl--unknown" title={unknown.detail}>unknown</span>
            ) : (
              <span className={`eod-stat-value ${report.combinedPnl >= 0 ? 'green' : 'red'}`}>
                {fmtDollar(report.combinedPnl)}
              </span>
            )}
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Win Rate</span>
            <span className="eod-stat-value">{(report.winRate * 100).toFixed(1)}%</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Avg R:R</span>
            <span className="eod-stat-value">1:{report.avgRR.toFixed(2)}</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Signals Fired</span>
            <span className="eod-stat-value">{report.signalAccuracy.totalSignals}</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Signal Win %</span>
            <span className="eod-stat-value">
              {(report.signalAccuracy.winRate * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* TRA-2631 (board ruling A) — this grid renders the stored `top5Movers`
            array, which the server has already FILTERED at read time. Two things
            follow, and both are load-bearing:

            1. The block must render when rows were SUPPRESSED even if nothing is
               left to show. 5 of 5 rows are suppressed on 2026-07-28 demo; the old
               `top5Movers.length > 0` guard alone would make that whole table
               vanish silently, which reads as "no movers that day".
            2. The suppression notice is not garnish. Without it a filtered table
               and a genuinely clean one render as the same rows — the exact
               instrument failure this ticket is about, relocated into the fix. */}
        {(report.top5Movers.length > 0 || (report.moversProvenance?.filteredCount ?? 0) > 0) && (
          <div className="eod-movers">
            <span className="eod-section-label">Top 5 Movers:</span>
            {report.top5Movers.map(m => (
              <span key={m.symbol} className="eod-mover">
                <strong>{m.symbol}</strong>
                <span className={m.changePct >= 0 ? 'green' : 'red'}>
                  &nbsp;{m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(2)}%
                </span>
                {/* A SERVED row can no longer be `suspect` — those are filtered out
                    upstream — but it can be `unassessable`, which is RETAINED on
                    purpose. Badge it: a blind spot must not render as a pass. */}
                {m.provenance && m.provenance.verdict !== 'plausible' && (
                  <span
                    className="eod-mover-flag"
                    title={
                      `${m.provenance.verdict === 'suspect' ? 'UNVERIFIED' : 'NOT ASSESSABLE'}`
                      + ` — ${m.provenance.ruleId}`
                      + `${m.provenance.reason ? ` (${m.provenance.reason})` : ''}`
                      + `, threshold ${m.provenance.threshold}`
                      + `${m.provenance.ratio !== null ? `, ratio ${m.provenance.ratio.toFixed(2)}` : ''}`
                      + `${m.provenance.impliedPrevClose !== null ? `, implied prev close $${m.provenance.impliedPrevClose.toFixed(4)}` : ''}`
                      + `, stamped by build ${m.provenance.build}.`
                      + ' Session-move test only — an unflagged row is unflagged, not verified.'
                    }
                  >
                    &nbsp;⚠️
                  </span>
                )}
              </span>
            ))}
            {report.moversProvenance && report.moversProvenance.filteredCount > 0 && (
              <span
                className="eod-movers-filtered"
                title={
                  `${report.moversProvenance.filteredCount} of ${report.moversProvenance.publishedCount}`
                  + ' published row(s) suppressed as unverified by'
                  + ` ${report.moversProvenance.ruleId} (threshold ${report.moversProvenance.threshold}),`
                  + ` build ${report.moversProvenance.build}. Suppressed: `
                  + report.moversProvenance.filtered
                    .map(f => `${f.symbol} $${f.price.toFixed(2)} ${f.changePct >= 0 ? '+' : ''}${f.changePct.toFixed(2)}%`)
                    .join('; ')
                  + '. The stored report on disk is unchanged — this is a read-time filter, not a rewrite.'
                }
              >
                ⚠️ {report.moversProvenance.filteredCount} of {report.moversProvenance.publishedCount} suppressed
              </span>
            )}
            {/* TRA-3296 — the WRITE-TIME badge. The notice above is scoped to the
                read-time filter, which computes its denominator over rows already
                stored; rows dropped inside `eod-report.ts` never reached the file,
                so that badge is silent about them by construction. Without this the
                grid renders a silently-short table — the same defect the markdown
                footer had, on the third surface. */}
            {report.moversWriteTime && report.moversWriteTime.displaced.length > 0 && (
              <span
                className="eod-movers-filtered"
                title={
                  `${report.moversWriteTime.displaced.length} row(s) were dropped BEFORE this report`
                  + ' was written and are NOT counted in the suppression figure above — they never'
                  + ' reached the stored file. Dropped: '
                  + report.moversWriteTime.displaced
                    .map(e => `${e.symbol} $${e.price.toFixed(2)} ${e.changePct >= 0 ? '+' : ''}${e.changePct.toFixed(2)}%`
                      + ` [${e.instrument}${e.corporateAction ? `, ${e.corporateAction}` : ''}]`)
                    .join('; ')
                  + `. ${report.moversWriteTime.excludedTotal} of ${report.moversWriteTime.candidateCount}`
                  + ' candidate(s) were excluded during generation in total.'
                }
              >
                ⛔ {report.moversWriteTime.displaced.length} dropped before publish
              </span>
            )}
            {/* The backfill boundary, on the grid. A stored report with no
                write-time record cannot be repaired, and rendering nothing here
                would let it read as "nothing was dropped" — which is the exact
                false certificate this ticket was filed on. */}
            {!report.moversWriteTime && (
              <span
                className="eod-movers-filtered"
                title={
                  'This stored report predates TRA-3296 and carries no record of rows dropped during'
                  + ' report generation (a corporate action, a level discontinuity, or a move the feed'
                  + ' condemned earlier in the session). It is not repairable — no per-symbol quote tape'
                  + ' is retained — so whether any rows are missing from this table is UNKNOWN.'
                }
              >
                ⚠️ pre-publish exclusions unknown
              </span>
            )}
          </div>
        )}

        <div className="eod-trades">
          <span className="eod-section-label">Closed Trades ({report.trades.length})</span>
          {report.trades.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Strategy</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>P&amp;L</th>
                  <th>R:R</th>
                </tr>
              </thead>
              <tbody>
                {report.trades.map(t => (
                  <tr key={t.id}>
                    <td className="symbol">{t.symbol}</td>
                    <td>{t.strategy}</td>
                    <td className={t.side === 'buy' ? 'green' : 'red'}>{t.side.toUpperCase()}</td>
                    <td>{t.quantity}</td>
                    <td>${fmt(t.entryPrice)}</td>
                    <td>${fmt(t.exitPrice)}</td>
                    <td className={t.pnl >= 0 ? 'green' : 'red'}>{fmtDollar(t.pnl)}</td>
                    <td>1:{t.rr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No trades closed on this date.</div>
          )}
        </div>

        <div className="eod-generated">
          Generated at {new Date(report.generatedAt).toLocaleString()}
        </div>
      </div>
    </section>
  );
}

// ── Main CalendarTab export ──────────────────────────────────────────────────

