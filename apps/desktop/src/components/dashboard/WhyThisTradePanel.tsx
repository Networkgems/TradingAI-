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
// Action buttons carry INTENTS for the TRA-4651 lifecycle, serviced by
// POST /api/cards/:signalId/lifecycle/advance (TRA-4813): Paper Trade advances
// on a fill the TRA-4657 paper ledger already recorded, Require Approval
// attaches the operator's named identity — and the machine's refusals are
// rendered verbatim, never swallowed. Auto-Execute stays disabled by the
// server with its reasons shown. No order path exists in this component and
// none may be added (board directive, TRA-4645; TRA-4750/TRA-1653 hold).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { fmt, fmtDollar, formatTime, timeAgo, signalLabel } from '../../lib/format';
import type {
  DecisionPanelPayload,
  LifecycleAdvanceResponse,
  PanelSection,
} from '../../types/decision-panel';

/** An operator intent the advance route accepts. Execution is not one. */
export type LifecycleActionIntent = 'paper' | 'require_approval';

/** Outcome of the last advance attempt — rendered under the buttons. */
export interface LifecycleActionState {
  busy: boolean;
  /** One-line outcome; null before any attempt. */
  message: string | null;
  /** The machine's named refusal reasons, verbatim. */
  reasons: string[];
  tone: 'ok' | 'refused' | 'error' | null;
}

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

export function DecisionPanelBody({
  panel,
  onAction,
  actionState,
}: {
  panel: DecisionPanelPayload;
  /**
   * TRA-4813 — the advance dispatch. REQUIRED: a body rendered without a
   * dispatch would put enabled buttons on screen that do nothing on click,
   * which is the exact defect this issue removes.
   */
  onAction: (intent: LifecycleActionIntent) => void;
  actionState?: LifecycleActionState | null;
}) {
  const { header, checklist, freshness, risk, contract, portfolio, similarTrades, actions } = panel;
  const busy = actionState?.busy === true;
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

      {/* Action intents — serviced by POST /api/cards/:id/lifecycle/advance
          (TRA-4813). The machine's verdict, accepted or refused, is rendered
          below the buttons; nothing here executes. */}
      <div className="wtt-actions">
        <button
          className="btn-secondary btn-sm"
          disabled={!actions.paperTrade.enabled || busy}
          title={actions.paperTrade.reason ?? 'Advance on the recorded paper fill (lifecycle: Proposed → Paper, TRA-4657 ledger evidence)'}
          onClick={() => onAction('paper')}
        >
          Paper Trade
        </button>
        <button
          className="btn-secondary btn-sm"
          disabled={!actions.requireApproval.enabled || busy}
          title={actions.requireApproval.reason ?? 'Attach your approval (lifecycle: Paper → Approved, named approver)'}
          onClick={() => onAction('require_approval')}
        >
          Require Approval
        </button>
        {/* Permanently disabled — TRA-4750 stand-down / TRA-1653 pin; no onClick, ever. */}
        <button className="btn-secondary btn-sm" disabled title={actions.autoExecute.reason ?? 'Disabled'}>
          Auto-Execute
        </button>
      </div>
      {header.lifecycleState !== undefined && (
        <div className="wtt-lifecycle-state" data-testid="wtt-lifecycle-state">
          lifecycle: {header.lifecycleState ?? 'none'} · disposition: {header.disposition}
        </div>
      )}
      {actionState?.message && (
        <div className={`wtt-action-result ${actionState.tone ?? ''}`} data-testid="wtt-action-result">
          <div>{actionState.message}</div>
          {actionState.reasons.length > 0 && (
            <ul className="wtt-action-reasons">
              {actionState.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function WhyThisTradePanel({ token, signalId }: { token: string; signalId: string }) {
  const [panel, setPanel] = useState<DecisionPanelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<LifecycleActionState | null>(null);
  // Bumped after every advance attempt so the panel re-derives its actions and
  // disposition from the machine's NEW state — accepted or refused alike (a
  // refusal appends to the audit trail, so the surface must re-read too).
  const [refresh, setRefresh] = useState(0);

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
  }, [token, signalId, refresh]);

  // TRA-4813 — the advance dispatch. Every outcome is rendered: an accepted
  // advance names the new state, a machine refusal lists its named reasons
  // verbatim, an HTTP failure says so. Silence after a click is the defect
  // this issue removes, so there is no code path that swallows the result.
  const onAction = useCallback(
    async (intent: LifecycleActionIntent) => {
      setActionState({ busy: true, message: null, reasons: [], tone: null });
      try {
        const r = await fetch(
          `${HTTP_URL}/api/cards/${encodeURIComponent(signalId)}/lifecycle/advance`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent }),
          },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setActionState({
            busy: false,
            message: body?.error ?? `Advance request failed (HTTP ${r.status})`,
            reasons: [],
            tone: 'error',
          });
          return;
        }
        const body = (await r.json()) as LifecycleAdvanceResponse;
        setActionState({
          busy: false,
          message: body.ok
            ? `Lifecycle advanced to '${body.state}' (disposition: ${body.disposition}) — ${body.note}`
            : `Machine refused the transition — ${body.note}`,
          reasons: body.ok ? [] : body.reasons,
          tone: body.ok ? 'ok' : 'refused',
        });
      } catch (err) {
        logger.error('why-this-trade', 'lifecycle advance failed', err);
        setActionState({ busy: false, message: 'Advance request failed — network error', reasons: [], tone: 'error' });
      } finally {
        setRefresh((n) => n + 1);
      }
    },
    [token, signalId],
  );

  if (error) return <div className="wtt-panel wtt-error">{error}</div>;
  if (!panel) return <div className="wtt-panel wtt-loading">Assembling panel…</div>;
  return <DecisionPanelBody panel={panel} onAction={onAction} actionState={actionState} />;
}
