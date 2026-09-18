// TRA-422 — the Stocks Signals tab, extracted from Dashboard.tsx. Owns the
// "Reset Signals" mutation; the signal list and regime context are passed in.
import type { TradeSignal, Sma200Signal, EngineMarketReviewState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmtSignedIntPct, fmtQuoteLevel, formatTime, signalLabel } from '../../lib/format';
import { RegimeBanner } from '../RegimeBanner';
import { SignalOptionRow } from '../SignalOptionRow';
import { Sma200SignalCard, isSma200Signal } from '../Sma200SignalCard';
import { WhyThisTradePanel } from './WhyThisTradePanel';
import type { SymbolState } from '../../types/app';
import { useState } from 'react';

export function StockSignalsPanel({
  token,
  signals,
  symbols,
  marketReview,
  lastScanAt,
  marketOpen,
}: {
  token: string;
  signals: (TradeSignal | Sma200Signal)[];
  symbols: SymbolState[];
  marketReview: EngineMarketReviewState | undefined;
  // TRA-1350 — last completed engine scan (ms) + session state, so the tab can
  // tell "scanned, nothing qualified" apart from "engine dead".
  lastScanAt?: number;
  marketOpen?: boolean;
}) {
  const toast = useToast();
  // TRA-4654 — which signal's "Why This Trade?" panel is expanded. One at a
  // time: the panel is dense, and the payload is fetched on expand only.
  const [whyOpenFor, setWhyOpenFor] = useState<string | null>(null);

  // TRA-1350 — scan-status line. `0 signals` on a closed market is EXPECTED
  // (the intraday strategies only fire in-session), so the tab needs to show
  // the engine is alive and scanned, not silently render an empty list.
  const marketLabel = marketOpen === false ? 'Market closed' : marketOpen === true ? 'Market open' : null;
  const setupCount = `${signals.length} setup${signals.length === 1 ? '' : 's'} qualified`;
  const scanStatus = lastScanAt && lastScanAt > 0
    ? `${marketLabel ? marketLabel + ' · ' : ''}Last scan ${formatTime(lastScanAt)} — ${setupCount}`
    : `${marketLabel ? marketLabel + ' · ' : ''}Waiting for first scan…`;

  async function resetSignals() {
    try {
      const r = await fetch(`${HTTP_URL}/api/signals/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success('Signals cleared');
      else toast.error(`Could not reset signals (HTTP ${r.status})`);
    } catch (err) {
      logger.error('stock-signals', 'reset signals failed', err);
      toast.error('Could not reset signals — network error');
    }
  }

  // TRA-451 — the SMA-200 daily trend signals get their own Signals-tab
  // category; the intraday strategy signals keep the existing card list.
  const sma200Signals = signals.filter(isSma200Signal);
  // TRA-3688 — the negative arm must be a typed predicate: only genuine
  // `TradeSignal`s (numeric takeProfit / R:R) may reach the generic card's
  // Target and R:R chips; an SMA-200 row's `null` has no rendering there.
  const tradeSignals = signals.filter((s): s is TradeSignal => !isSma200Signal(s));

  return (
    <div className="signals-panel">
      {/* TRA-389 — regime banner: shown once the operator opts into
          market-review gating, explains why a strategy is gated off. */}
      <RegimeBanner review={marketReview} />
      <div className="signals-toolbar">
        {/* TRA-1350 — always-visible scan status so an empty list reads as
            "scanned, nothing qualified" rather than "engine dead". */}
        <span className="scan-status" title="Timestamp of the last completed engine scan tick">
          {scanStatus}
        </span>
        <button
          className="btn-secondary btn-sm"
          onClick={resetSignals}
          disabled={signals.length === 0}
          title="Clear the signal list"
        >
          Reset Signals
        </button>
      </div>
      {signals.length === 0 ? (
        <div className="empty">No signals yet — engine is scanning {symbols.filter(s => s.lastUpdated > 0).length} symbols…</div>
      ) : (
        <>
          {tradeSignals.length > 0 && (
            <div className="signal-list">
              {tradeSignals.map(sig => {
                // TRA-3390 (impl child of TRA-2628) — a signal's entry / stop /
                // target are levels in the SYMBOL's quote currency, not the book's.
                // This card printed `$165.70 / $139.11 / $218.89` for the live
                // `ENR.DE` buy, which is EUR. The currency is read off the
                // watchlist row for the same symbol — the panel already receives
                // `symbols` — rather than re-derived here, so the card and the
                // watchlist can never disagree about one instrument's unit.
                // Unknown => rendered bare, never as dollars.
                const sigCurrency = symbols.find(x => x.symbol === sig.symbol)?.currency;
                return (
                <div key={sig.id} className={`signal-card ${sig.side}`}>
                  <div className="signal-header">
                    <span className="signal-symbol">{sig.symbol}</span>
                    <span className={`signal-side ${sig.side}`}>{sig.side.toUpperCase()}</span>
                    <span className="signal-type">{signalLabel(sig.type)}</span>
                    <span className="signal-time">{formatTime(sig.timestamp)}</span>
                  </div>
                  <div className="signal-body">
                    <div className="sig-stat">
                      <span>Entry</span>
                      <strong>{fmtQuoteLevel(sig.entryPrice, sigCurrency)}</strong>
                    </div>
                    <div className="sig-stat">
                      <span>Stop</span>
                      <strong className="red">
                        {fmtQuoteLevel(sig.stopLoss, sigCurrency)}
                        {sig.entryPrice > 0 && (
                          <span className="sig-stat-pct"> ({fmtSignedIntPct((sig.stopLoss - sig.entryPrice) / sig.entryPrice * 100)})</span>
                        )}
                      </strong>
                    </div>
                    <div className="sig-stat">
                      <span>Target</span>
                      <strong className="green">
                        {fmtQuoteLevel(sig.takeProfit, sigCurrency)}
                        {sig.entryPrice > 0 && (
                          <span className="sig-stat-pct"> ({fmtSignedIntPct((sig.takeProfit - sig.entryPrice) / sig.entryPrice * 100)})</span>
                        )}
                      </strong>
                    </div>
                    <div className="sig-stat">
                      <span>R:R</span>
                      <strong>1:{sig.riskRewardRatio}</strong>
                    </div>
                  </div>
                  <SignalOptionRow sig={sig} />
                  {/* TRA-4654 — expandable decision panel: what is the trade,
                      why is it valid, what breaks it, how much can I lose.
                      Server-assembled (GET /api/cards/:id/panel); fetched on
                      expand, rendered in one synchronous pass. */}
                  <button
                    className="btn-secondary btn-sm wtt-toggle"
                    onClick={() => setWhyOpenFor(whyOpenFor === sig.id ? null : sig.id)}
                    title="Full decision panel: trigger checklist, invalidation, sizing, portfolio impact, history"
                  >
                    {whyOpenFor === sig.id ? 'Hide details' : 'Why this trade?'}
                  </button>
                  {whyOpenFor === sig.id && <WhyThisTradePanel token={token} signalId={sig.id} />}
                </div>
                );
              })}
            </div>
          )}
          {/* TRA-451 — "SMA-200" category: daily-bar trend-filter signals.
              TRA-819 — pullback live entry is gated off (its params were never
              validated out-of-sample, TRA-455 was a FAIL); both pullbacks and
              reclaims are now DISPLAY-ONLY context until a strategy passes the
              TRA-817 OOS capital gate. Rendered as a separate category from the
              intraday strategy signals. */}
          {sma200Signals.length > 0 && (
            <div className="signal-category">
              <div className="signal-category-header">
                <span className="signal-category-title">SMA-200</span>
                <span className="signal-category-note">
                  Daily trend filter — display-only context; no position opens until the OOS capital gate passes
                </span>
              </div>
              <div className="signal-list">
                {/* TRA-3390 — same symbol lookup as the trade-signal cards above:
                    one source for a symbol's unit, so the two card kinds cannot
                    disagree. */}
                {sma200Signals.map(sig => (
                  <Sma200SignalCard
                    key={sig.id}
                    sig={sig}
                    currency={symbols.find(x => x.symbol === sig.symbol)?.currency}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
