// TRA-4654 — "Why This Trade?" decision panel, rendered beside a signal card.
//
// Split in two so the acceptance is testable where it bites:
//   - `DecisionPanelBody` is PURE: one synchronous pass over the server's
//     precomputed payload (types/decision-panel.ts). No fetch, no folds, no
//     effects — that is how the <100ms render budget is met, and the perf test
//     measures exactly this component.
//   - `WhyThisTradePanel` is the container: fetches
//     GET /api/cards/:signalId/panel once on mount and renders loading /
//     error / 404 states honestly (a 404 means the card was evicted from the
//     ring — say so; it is not an empty panel).
//
// Action buttons are INTENTS, wired to nothing that executes: the TRA-4651
// lifecycle is the only path that advances a proposal, and Auto-Execute is
// disabled by the server with its reasons rendered verbatim. No order path
// exists in this component and none may be added (board directive, TRA-4645).
import { useEffect, useState, type ReactNode } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { fmt, fmtDollar, formatTime, timeAgo, signalLabel } from '../../lib/format';
import type {
  DecisionPanelPayload,
  PanelSection,
} from '../../types/decision-panel';

/** A cell the server could not build. Paired with a named reason below it. */
const NOT_BUILT = 'not built';

/** Render a section's fail-closed state: named missing inputs, never blanks. */
function SectionShell({
  title,
  section,
  children,
}: {
  title: string;
  section: PanelSection<unknown>;
  children: ReactNode;
}) {
  return (
    <div className={`wtt-section ${section.status}`}>
      <div className="wtt-section-header">
        <span className="wtt-section-title">{title}</span>
        {section.status === 'incomplete' && (
          <span className="wtt-incomplete-badge" title={`Missing: ${section.missing.join(', ')}`}>
            incomplete — missing {section.missing.join(', ')}
          </span>
        )}
      </div>
      {section.data !== null ? children : (
        <div className="wtt-empty">Not assembled — missing {section.missing.join(', ') || 'inputs'}</div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }) {
  return (
    <div className="sig-stat">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

/**
 * TRA-4788 — the tooltip is worded off the server's `calibrationStatus`, never
 * a hardcoded claim: "floor not cleared" was false on every build where
 * calibration had never run at all. The reasons array carries the server's own
 * one-line audit for the branch taken.
 */
function noConfidenceTitle(panel: DecisionPanelPayload): string {
  const why =
    panel.calibrationStatus === 'not_run'
      ? 'calibration has never run on this build'
      : panel.calibrationStatus === 'no_instances'
        ? 'no historical instances for this setup'
        : panel.calibrationStatus === 'below_floor'
          ? 'instance floor not cleared'
          : panel.calibrationStatus === 'oos_failed'
            ? 'out-of-sample validation failed'
            : 'calibration status unknown (server build predates the TRA-4788 stamp)';
  const reasons = panel.calibrationReasons?.length ? ` — ${panel.calibrationReasons.join('; ')}` : '';
  return `No calibrated expectancy for this setup: ${why}${reasons}. A number would be invented (TRA-4779).`;
}

export function DecisionPanelBody({ panel }: { panel: DecisionPanelPayload }) {
  const { header, checklist, freshness, risk, contract, portfolio, similarTrades, actions } = panel;
  return (
    <div className="wtt-panel" data-testid="wtt-panel">
      {/* What is the trade? */}
      <div className="wtt-header">
        <span className="signal-symbol">{header.symbol}</span>
        <span className="signal-type">{header.setupLabel ?? signalLabel(header.signalType)}</span>
        <span className="wtt-regime" title={header.regimeAsOf ? `Review of ${header.regimeAsOf}` : undefined}>
          {header.regimeEnabled && header.regime ? `Regime: ${header.regime}` : 'Regime: no market review'}
        </span>
        {panel.confidence ? (
          <span
            className="wtt-confidence"
            title={`Wilson lower bound over n=${panel.confidence.n} (${panel.confidence.basis}); expectancy ${fmt(panel.confidence.expectancyNetR)}R net of costs`}
          >
            {panel.confidence.displayWinRatePct}% confidence
          </span>
        ) : (
          <span className="wtt-confidence none" title={noConfidenceTitle(panel)}>
            confidence: not calibrated
          </span>
        )}
      </div>

      {/* Why is it valid? */}
      <SectionShell title="Trigger checklist" section={checklist}>
        {checklist.data && (
          <ul className="wtt-checklist">
            {checklist.data.criteria.map(c => (
              <li key={c.name} className={c.pass ? 'pass' : 'fail'}>
                <span className="wtt-check-mark">{c.pass ? '✓' : '✗'}</span>
                <span className="wtt-check-name">{c.name}</span>
                <span className="wtt-check-desc">{c.description}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionShell>

      <SectionShell title="Freshness" section={freshness}>
        {freshness.data && (
          <div className="wtt-grid">
            <Stat label="Signal fired" value={formatTime(freshness.data.firedAt)} />
            <Stat
              label="Age"
              value={timeAgo(freshness.data.firedAt)}
              tone={freshness.data.fresh ? undefined : 'red'}
            />
            <Stat
              label="Quote as of"
              value={freshness.data.quoteAsOf !== null ? formatTime(freshness.data.quoteAsOf) : 'no quote timestamp'}
            />
            {!freshness.data.fresh && (
              <div className="wtt-stale-warning">
                STALE — older than this setup's {Math.round(freshness.data.freshnessCeilingMs / 60_000)}min ceiling
              </div>
            )}
          </div>
        )}
      </SectionShell>

      {/* What breaks it? How much can I lose? */}
      <SectionShell title="Risk" section={risk}>
        {risk.data && (
          <>
            <div className="wtt-grid">
              <Stat label="Entry" value={risk.data.entry !== null ? fmt(risk.data.entry) : NOT_BUILT} />
              <Stat label="Stop" value={risk.data.stop !== null ? fmt(risk.data.stop) : NOT_BUILT} tone="red" />
              <Stat
                label="Target"
                value={
                  risk.data.takeProfit !== null
                    ? fmt(risk.data.takeProfit)
                    : (risk.data.exitRule ?? NOT_BUILT)
                }
                tone="green"
              />
              <Stat label="R:R" value={risk.data.rewardRisk !== null ? `1:${fmt(risk.data.rewardRisk, 1)}` : NOT_BUILT} />
              <Stat
                label="Size"
                value={risk.data.quantity !== null ? `${risk.data.quantity} ${risk.data.unit ?? ''}`.trim() : NOT_BUILT}
              />
              <Stat
                label="Max loss at stop"
                value={risk.data.maxLossAtStopUsd !== null ? `$${fmt(risk.data.maxLossAtStopUsd)}` : NOT_BUILT}
                tone="red"
              />
              {risk.data.maxLossHardUsd !== null && (
                <Stat label="Max loss (gap through stop)" value={`$${fmt(risk.data.maxLossHardUsd)}`} tone="red" />
              )}
              {risk.data.costR !== null && <Stat label="Round-trip cost" value={`${fmt(risk.data.costR)}R`} />}
            </div>
            {/* A blank cell above is explained here in the card's own words —
                never left as a bare dash (TRA-4654). */}
            {risk.data.gaps && risk.data.gaps.length > 0 && (
              <ul className="wtt-gaps" data-testid="wtt-risk-gaps">
                {risk.data.gaps.map(g => (
                  <li key={g.field} className={g.kind}>
                    <span className="wtt-gap-field">{g.field}</span>
                    {g.kind === 'refused' ? ' refused: ' : ' not built: '}
                    {g.reasons.length > 0 ? g.reasons.join('; ') : 'no reason recorded'}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </SectionShell>

      <SectionShell title="Contract & liquidity" section={contract}>
        {contract.data && (
          <div className="wtt-grid">
            <Stat
              label="Instrument"
              value={contract.data.selection.optionSymbol ?? contract.data.selection.symbol}
            />
            {contract.data.selection.delta !== null && (
              <Stat label="Delta" value={fmt(contract.data.selection.delta)} />
            )}
            <Stat
              label="Liquidity"
              value={contract.data.liquidity.grade}
              tone={contract.data.liquidity.grade === 'good' ? 'green' : contract.data.liquidity.grade === 'thin' ? 'red' : undefined}
            />
            {contract.data.liquidity.spreadFrac !== null && (
              <Stat label="Spread" value={`${fmt(contract.data.liquidity.spreadFrac * 100, 1)}%`} />
            )}
            {contract.data.liquidity.openInterest !== null && (
              <Stat label="Open interest" value={String(contract.data.liquidity.openInterest)} />
            )}
            {contract.data.liquidity.reasons.length > 0 && (
              <div className="wtt-liq-reasons">{contract.data.liquidity.reasons.join(' · ')}</div>
            )}
          </div>
        )}
      </SectionShell>

      <SectionShell title="Portfolio impact" section={portfolio}>
        {portfolio.data && (
          <div className="wtt-grid">
            <Stat label="Open positions" value={String(portfolio.data.openPositionCount)} />
            <Stat label={`Already in ${header.symbol}`} value={String(portfolio.data.sameSymbolCount)} />
            {portfolio.data.sameSymbolPctOfEquity !== null && (
              <Stat label="Symbol concentration" value={`${fmt(portfolio.data.sameSymbolPctOfEquity * 100, 1)}%`} />
            )}
            <Stat label="Same setup open" value={String(portfolio.data.sameSetupCount)} />
            <Stat
              label={`Net delta (${header.symbol})`}
              value={
                portfolio.data.netDeltaSharesSameSymbol !== null
                  ? `${fmt(portfolio.data.netDeltaSharesSameSymbol, 0)} sh`
                  : `unknown (${portfolio.data.deltaUnknownCount} position${portfolio.data.deltaUnknownCount === 1 ? '' : 's'} without delta)`
              }
            />
            {portfolio.data.proposedPctOfEquity !== null && (
              <Stat label="This trade adds" value={`${fmt(portfolio.data.proposedPctOfEquity * 100, 1)}% of equity`} />
            )}
            <div className="wtt-correlation-note" title={portfolio.data.correlation.reason}>
              correlation: not computed
            </div>
          </div>
        )}
      </SectionShell>

      <SectionShell title="Similar historical trades" section={similarTrades}>
        {similarTrades.data && (
          <div className="wtt-history">
            <div className="wtt-history-summary">
              {similarTrades.data.n === 0 ? (
                <span>No prior {signalLabel(header.signalType)} trades on record</span>
              ) : (
                <span>
                  {similarTrades.data.n} prior ({similarTrades.data.matchedBy === 'setup_and_symbol' ? `${header.symbol} + setup` : 'setup-wide'}):{' '}
                  {similarTrades.data.wins}W / {similarTrades.data.losses}L
                  {similarTrades.data.unknownOutcome > 0 && ` / ${similarTrades.data.unknownOutcome} unbooked`}
                  {similarTrades.data.totalPnlUsd !== null
                    ? ` · net ${fmtDollar(similarTrades.data.totalPnlUsd)}`
                    : ' · net unknowable (unbooked closes)'}
                </span>
              )}
            </div>
            {similarTrades.data.recent.length > 0 && (
              <ul className="wtt-history-rows">
                {similarTrades.data.recent.map((r, i) => (
                  <li key={`${r.symbol}-${r.closedAt ?? 'na'}-${i}`}>
                    <span>{r.symbol}</span>
                    <span>{r.closedAt !== null ? formatTime(r.closedAt) : '—'}</span>
                    <span className={r.pnlUsd !== null ? (r.pnlUsd > 0 ? 'green' : 'red') : undefined}>
                      {r.pnlUsd !== null ? fmtDollar(r.pnlUsd) : 'unbooked'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SectionShell>

      {/* Action intents — proposal only; nothing here executes. */}
      <div className="wtt-actions">
        <button className="btn-secondary btn-sm" disabled={!actions.paperTrade.enabled} title={actions.paperTrade.reason ?? 'Propose into the paper book (lifecycle: Proposed → Paper)'}>
          Paper Trade
        </button>
        <button className="btn-secondary btn-sm" disabled={!actions.requireApproval.enabled} title={actions.requireApproval.reason ?? 'Route to human approval (lifecycle: Proposed → Approved)'}>
          Require Approval
        </button>
        <button className="btn-secondary btn-sm" disabled title={actions.autoExecute.reason ?? 'Disabled'}>
          Auto-Execute
        </button>
      </div>
    </div>
  );
}

export function WhyThisTradePanel({ token, signalId }: { token: string; signalId: string }) {
  const [panel, setPanel] = useState<DecisionPanelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/cards/${encodeURIComponent(signalId)}/panel`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (r.status === 404) {
          // The ring evicted this card (or it predates the panel) — say so.
          setError('No proposal card for this signal any more — it aged out of the feed.');
          return;
        }
        if (!r.ok) {
          setError(`Could not load panel (HTTP ${r.status})`);
          return;
        }
        const body = (await r.json()) as DecisionPanelPayload;
        if (!cancelled) setPanel(body);
      } catch (err) {
        logger.error('why-this-trade', 'panel fetch failed', err);
        if (!cancelled) setError('Could not load panel — network error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, signalId]);

  if (error) return <div className="wtt-panel wtt-error">{error}</div>;
  if (!panel) return <div className="wtt-panel wtt-loading">Assembling panel…</div>;
  return <DecisionPanelBody panel={panel} />;
}
