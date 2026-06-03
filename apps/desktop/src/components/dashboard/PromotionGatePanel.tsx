// TRA-537 — desktop Promotion-Gate status panel. Follow-up to TRA-532, which
// shipped the server enforcement + the `GET /api/promotion/status` endpoint.
// This panel binds that endpoint so the desk can see per-stage status and the
// exact failing checks BEFORE attempting a "go live" flip (the flip itself
// already refuses with the gate's reason; this surfaces *why* up front).
//
// Acceptance criterion #3 of TRA-532: the metrics shown here MUST be the API's
// computed values. We never recompute or hand-enter a metric — every number is
// read straight off `status.backtest.metrics` / `status.paper.metrics`. The
// only client-side comparison is the per-row pass/fail tick, which compares two
// API-provided numbers (the computed metric vs the API's effective threshold)
// purely for display colour; the authoritative verdict is the API's per-stage
// `state` and overall `canGoLive` / `blockedReasons`.
import { useEffect, useState } from 'react';
import type {
  PromotionStatus,
  PromotionThresholds,
  PromotionStageState,
} from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';

// The store-side `StrategyPromotionRecord` lives in the server package and is
// not importable here; mirror only the fields the panel reads.
interface StrategyRecord {
  strategyId: string;
  backtest: { reportId: string; registeredAt: string; registeredBy: string } | null;
  decisions: Array<{ reviewer: string; decidedAt: string; rationale?: string }>;
}

interface PromotionStatusEntry {
  record: StrategyRecord;
  status: PromotionStatus;
  thresholds: PromotionThresholds;
}

interface PromotionStatusResponse {
  strategies: PromotionStatusEntry[];
}

const POLL_MS = 30_000;

// Strategy ids are crypto-strategy preset ids / strategy names; humanise the
// common shapes (`bb_fade_sol_doge` → "Bb fade sol doge") without a lookup
// table so a newly-registered strategy still reads cleanly.
function prettyStrategyId(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Display-only metric formatter. Trims trailing zeros and guards non-finite
// values arriving over the wire. Mirrors the server's `fmt` look so the numbers
// read identically to the gate's own `failedChecks` strings.
function num(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n.toFixed(decimals)).toString();
}

function StageChip({ label, state }: { label: string; state: PromotionStageState }) {
  return (
    <span className={`gate-chip gate-chip-${state}`} title={`${label}: ${state}`}>
      <span className="gate-chip-icon" aria-hidden="true">
        {state === 'pass' ? '✓' : state === 'fail' ? '✕' : '–'}
      </span>
      <span className="gate-chip-label">{label}</span>
      <span className="gate-chip-state">{state}</span>
    </span>
  );
}

// One metric line: the API-computed value next to its API threshold, with a
// display-only pass tick. `pass === null` ⇒ informational row (no threshold to
// compare against, e.g. paper profit factor or an unverified slippage ratio).
function MetricRow({
  label,
  value,
  threshold,
  pass,
}: {
  label: string;
  value: string;
  threshold?: string;
  pass: boolean | null;
}) {
  return (
    <div className={`gate-metric${pass === false ? ' gate-metric-fail' : ''}`}>
      <span className="gate-metric-label">{label}</span>
      <span className="gate-metric-value">
        {value}
        {threshold && <span className="gate-metric-threshold"> / {threshold}</span>}
      </span>
      <span className="gate-metric-tick" aria-hidden="true">
        {pass === null ? '' : pass ? '✓' : '✕'}
      </span>
    </div>
  );
}

function StrategyCard({ entry }: { entry: PromotionStatusEntry }) {
  const { status, thresholds, record } = entry;
  const bt = status.backtest.metrics;
  const paper = status.paper.metrics;
  const t = thresholds;
  const latestSignoff = record.decisions.length > 0 ? record.decisions[record.decisions.length - 1] : null;

  return (
    <div className={`gate-card${status.canGoLive ? ' gate-card-ready' : ''}`}>
      <div className="gate-card-head">
        <div className="gate-card-title">
          <span className="gate-strategy-name">{prettyStrategyId(status.strategyId)}</span>
          <code className="gate-strategy-id">{status.strategyId}</code>
        </div>
        <span className={`gate-verdict ${status.canGoLive ? 'gate-verdict-ready' : 'gate-verdict-blocked'}`}>
          {status.canGoLive ? 'READY FOR LIVE' : 'BLOCKED'}
        </span>
      </div>

      <div className="gate-chips">
        <StageChip label="Backtest" state={status.backtest.state} />
        <StageChip label="Paper" state={status.paper.state} />
        <StageChip label="Sign-off" state={status.signoff === 'present' ? 'pass' : 'missing'} />
      </div>

      {/* Stage 1 — backtest */}
      <div className="gate-stage">
        <div className="gate-stage-head">Stage 1 · Backtest</div>
        {bt ? (
          <div className="gate-metrics">
            <MetricRow label="Sharpe" value={num(bt.sharpe)} threshold={`≥ ${t.backtest.minSharpe}`} pass={bt.sharpe >= t.backtest.minSharpe} />
            <MetricRow label="Expectancy (R)" value={num(bt.expectancy, 3)} threshold={`> ${t.backtest.minExpectancy}`} pass={bt.expectancy > t.backtest.minExpectancy} />
            <MetricRow label="Profit factor" value={num(bt.profitFactor)} threshold={`≥ ${t.backtest.minProfitFactor}`} pass={bt.profitFactor >= t.backtest.minProfitFactor} />
            <MetricRow label="Max drawdown" value={`${num(bt.maxDrawdown * 100, 1)}%`} threshold={`≤ ${t.backtest.maxDrawdownPct * 100}%`} pass={bt.maxDrawdown <= t.backtest.maxDrawdownPct} />
            <MetricRow label="Trades" value={num(bt.tradeCount, 0)} threshold={`≥ ${t.backtest.minTradeCount}`} pass={bt.tradeCount >= t.backtest.minTradeCount} />
          </div>
        ) : (
          <p className="gate-stage-empty">No backtest report registered.</p>
        )}
      </div>

      {/* Stage 2 — paper / forward test */}
      <div className="gate-stage">
        <div className="gate-stage-head">
          Stage 2 · Paper
          <span className="gate-stage-count">{status.paper.tradeCount} monitored trade{status.paper.tradeCount === 1 ? '' : 's'}</span>
        </div>
        {paper ? (
          <div className="gate-metrics">
            <MetricRow label="Trades" value={num(paper.tradeCount, 0)} threshold={`≥ ${t.paper.minTradeCount}`} pass={paper.tradeCount >= t.paper.minTradeCount} />
            <MetricRow label="Expectancy (R)" value={num(paper.expectancy, 3)} threshold={`> ${t.paper.minExpectancy}`} pass={paper.expectancy > t.paper.minExpectancy} />
            <MetricRow label="Sharpe" value={num(paper.sharpe)} threshold={`≥ ${t.paper.minSharpe}`} pass={paper.sharpe >= t.paper.minSharpe} />
            <MetricRow label="Profit factor" value={num(paper.profitFactor)} pass={null} />
            <MetricRow
              label="Slippage (realized ÷ modeled)"
              value={paper.slippageRatio == null ? 'unverified' : `${num(paper.slippageRatio)}×`}
              threshold={`≤ ${t.paper.maxSlippageRatio}×`}
              pass={paper.slippageRatio == null ? null : paper.slippageRatio <= t.paper.maxSlippageRatio}
            />
          </div>
        ) : (
          <p className="gate-stage-empty">No monitored paper trades recorded.</p>
        )}
      </div>

      {/* Stage 3 — sign-off */}
      <div className="gate-stage">
        <div className="gate-stage-head">Stage 3 · Sign-off</div>
        {status.signoff === 'present' && latestSignoff ? (
          <p className="gate-signoff">
            Signed off by <strong>{latestSignoff.reviewer}</strong>
            {latestSignoff.decidedAt && <> on {new Date(latestSignoff.decidedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</>}
            {latestSignoff.rationale && <span className="gate-signoff-rationale"> — {latestSignoff.rationale}</span>}
          </p>
        ) : (
          <p className="gate-stage-empty">No QuantTrader sign-off on record.</p>
        )}
      </div>

      {/* Exact failing checks — authoritative, straight from the API. */}
      {status.blockedReasons.length > 0 && (
        <div className="gate-blocked">
          <div className="gate-blocked-head">Why this strategy can't go live</div>
          <ul className="gate-blocked-list">
            {status.blockedReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PromotionGatePanel({ token }: { token: string }) {
  const [entries, setEntries] = useState<PromotionStatusEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${HTTP_URL}/api/promotion/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          if (!cancelled) setError(`Could not load promotion status (HTTP ${r.status})`);
          return;
        }
        const data = (await r.json()) as PromotionStatusResponse;
        if (cancelled) return;
        setEntries(data.strategies ?? []);
        setError(null);
      } catch (err) {
        logger.warn('promotion-gate', 'status fetch failed; will retry', err);
        if (!cancelled) setError('Could not reach the trading server.');
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  if (!entries && !error) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading promotion gate…</p>
      </div>
    );
  }

  if (error && !entries) {
    return <div className="empty">{error}</div>;
  }

  if (entries && entries.length === 0) {
    return (
      <div className="empty">
        No strategies are registered with the promotion gate yet. A strategy
        appears here once a backtest report or sign-off is recorded for it.
      </div>
    );
  }

  return (
    <div className="promotion-gate-panel">
      <p className="gate-intro muted">
        Live-Trading Promotion Gate (TRA-532). A strategy may flip to live only
        once it passes Stage 1 (backtest) and Stage 2 (paper) and carries a
        Stage 3 sign-off. Metrics are the server's computed values.
      </p>
      {error && <div className="gate-stale muted">{error} Showing last loaded status.</div>}
      <div className="gate-grid">
        {entries!.map(entry => (
          <StrategyCard key={entry.status.strategyId} entry={entry} />
        ))}
      </div>
    </div>
  );
}
