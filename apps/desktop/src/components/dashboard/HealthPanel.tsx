// TRA-539 — desktop "Health" dashboard tab. Follow-up to TRA-528, which shipped
// the server reliability core + `GET /api/health/live`. This panel binds that
// endpoint so the desk can see Live health at a glance — a one-look diagnosis
// for the recurring "nothing works in Live" incidents — instead of shelling
// into the box and curling three endpoints.
//
// The verdict is authoritative: the GREEN/YELLOW/RED status and the `issues[]`
// list are the API's own computed values. We never recompute the status; the
// panels below merely lay out the same `LiveHealthSummary` fields the server
// already rolled up (mode/broker, feed freshness, trading state, build).
import { useEffect, useState } from 'react';
import type { AccountMode, TradierEnv } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { formatUptime, type BuildInfo } from './VersionChip';
import { EngineScorecardPanel } from './EngineScorecardPanel';
import { TradierStreamPanel } from './TradierStreamPanel';

type HealthStatus = 'green' | 'yellow' | 'red';

interface FeedHealth {
  trackedSymbols: number;
  freshSymbols: number;
  staleSymbols: number;
  neverQuoted: number;
  lastTickAgeSec: number | null;
  stale: boolean;
}

// Mirror of the server `LiveHealthSummary` + the route's `build`/`time` wrap
// (packages/server/src/observability/live-health.ts, health-routes.ts). The
// types aren't exported from @trading-app/shared, so the fields the panel reads
// are mirrored locally — same pattern as PromotionGatePanel/VersionChip.
interface LiveHealth {
  status: HealthStatus;
  mode: AccountMode;
  broker: { env: TradierEnv; authOk: boolean; missingCredentials: string[] };
  autoTradingEnabled: boolean;
  tradingHalted: boolean;
  haltReason: string | null;
  marketOpen: boolean;
  feed: FeedHealth;
  issues: string[];
  build: BuildInfo;
  time: string;
}

const POLL_MS = 45_000;

const STATUS_LABEL: Record<HealthStatus, string> = {
  green: 'All systems healthy',
  yellow: 'Degraded — needs a look',
  red: 'Live path is broken',
};

function ageLabel(sec: number | null): string {
  if (sec == null) return 'never';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="health-panel">
      <div className="health-panel-head">{title}</div>
      <div className="health-panel-body">{children}</div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="health-row">
      <span className="health-row-label">{label}</span>
      <span className={`health-row-value${tone ? ` health-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function StatusBanner({ status, time }: { status: HealthStatus; time: string }) {
  const label = STATUS_LABEL[status];
  const checkedAt = (() => {
    const d = new Date(time);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  })();
  return (
    <div className={`health-banner health-banner-${status}`} role="status" data-testid="health-banner">
      <span className="health-banner-dot" aria-hidden="true" />
      <span className="health-banner-status">{status.toUpperCase()}</span>
      <span className="health-banner-label">{label}</span>
      {checkedAt && <span className="health-banner-time">checked {checkedAt}</span>}
    </div>
  );
}

export function HealthPanel({ token }: { token: string }) {
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${HTTP_URL}/api/health/live`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          if (!cancelled) setError(`Could not load live health (HTTP ${r.status})`);
          return;
        }
        const data = (await r.json()) as LiveHealth;
        if (cancelled) return;
        setHealth(data);
        setError(null);
      } catch (err) {
        logger.warn('health', 'live-health fetch failed; will retry', err);
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

  if (!health && !error) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading live health…</p>
      </div>
    );
  }

  if (error && !health) {
    return <div className="empty">{error}</div>;
  }

  const h = health!;
  const isLive = h.mode === 'live';
  const feed = h.feed;

  return (
    <div className="health-tab">
      <StatusBanner status={h.status} time={h.time} />

      {error && <div className="health-stale muted">{error} Showing last loaded health.</div>}

      {/* Authoritative problem list, worst-first, straight from the API. */}
      {h.issues.length > 0 ? (
        <div className="health-issues">
          <div className="health-issues-head">Active issues</div>
          <ul className="health-issues-list">
            {h.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="health-issues health-issues-clear">
          No active issues — the live trading path is healthy.
        </div>
      )}

      <div className="health-grid">
        {/* Mode & broker */}
        <Panel title="Mode &amp; broker">
          <Row
            label="Account mode"
            value={isLive ? 'LIVE' : 'Demo'}
            tone={isLive ? 'warn' : undefined}
          />
          <Row label="Tradier environment" value={h.broker.env === 'production' ? 'Production' : 'Sandbox'} />
          <Row
            label="Broker auth"
            value={h.broker.authOk ? 'OK' : 'Missing credentials'}
            tone={h.broker.authOk ? 'ok' : isLive ? 'bad' : 'warn'}
          />
          {!h.broker.authOk && h.broker.missingCredentials.length > 0 && (
            <Row
              label="Missing"
              value={h.broker.missingCredentials.join(', ')}
              tone="bad"
            />
          )}
          <Row label="Market" value={h.marketOpen ? 'Open' : 'Closed'} />
        </Panel>

        {/* Feed freshness */}
        <Panel title="Feed freshness">
          <Row label="Tracked symbols" value={feed.trackedSymbols} />
          <Row
            label="Fresh"
            value={feed.freshSymbols}
            tone={feed.trackedSymbols > 0 && feed.freshSymbols === 0 ? 'bad' : 'ok'}
          />
          <Row label="Stale" value={feed.staleSymbols} tone={feed.staleSymbols > 0 ? 'warn' : undefined} />
          <Row label="Never quoted" value={feed.neverQuoted} tone={feed.neverQuoted > 0 ? 'warn' : undefined} />
          <Row
            label="Last engine tick"
            value={ageLabel(feed.lastTickAgeSec)}
            tone={feed.stale ? 'bad' : undefined}
          />
        </Panel>

        {/* Trading state */}
        <Panel title="Trading state">
          <Row
            label="Auto-trading"
            value={h.autoTradingEnabled ? 'Enabled' : 'Disabled'}
            tone={h.autoTradingEnabled ? 'ok' : isLive ? 'warn' : undefined}
          />
          <Row
            label="Kill switch / halt"
            value={h.tradingHalted ? 'HALTED' : 'Clear'}
            tone={h.tradingHalted ? 'warn' : 'ok'}
          />
          {h.tradingHalted && h.haltReason && (
            <Row label="Halt reason" value={h.haltReason} tone="warn" />
          )}
        </Panel>

        {/* Build */}
        <Panel title="Build">
          <Row
            label="Commit"
            value={<code>{h.build.commitShort ?? 'unknown'}</code>}
            tone={h.build.commitSource === 'none' ? 'warn' : undefined}
          />
          <Row label="Branch" value={h.build.branch ?? '—'} />
          <Row label="Source" value={h.build.commitSource} />
          <Row label="Build time" value={h.build.buildTime ?? '—'} />
          <Row label="Uptime" value={formatUptime(h.build.uptimeSec)} />
          <Row label="Node / pid" value={`${h.build.nodeVersion} · ${h.build.pid}`} />
        </Panel>
      </div>

      {/* TRA-4707 — Tradier /markets/events stream: connection state + per-symbol
          quote age (stale above 2s). Self-fetching; reads "Disabled" while
          ENABLE_TRADIER_STREAM is off. */}
      <TradierStreamPanel token={token} />

      {/* TRA-1141 — combined accuracy scorecard: both idea engines side by side
          on out-of-sample data. Auxiliary, self-fetching, winner-free. */}
      <EngineScorecardPanel />
    </div>
  );
}
