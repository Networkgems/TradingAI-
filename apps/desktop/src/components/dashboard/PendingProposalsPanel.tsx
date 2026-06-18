// TRA-941 (TRA-813 P2) — pending-proposals confirmation panel, built to the
// TRA-940 UX spec. An APPROVE agent recommendation surfaces here as a pending
// proposal the operator confirms or rejects; ONLY a confirmed proposal routes to
// capital (Piece 3). The panel polls /api/proposals (5s) for the queue + the live
// daily-cap usage, and surfaces the kill-switch + cap context BEFORE any approve.
//
// Demo reads as safe/blue/reversible; live borrows the kill-switch RED language
// (REAL MONEY flag + a required confirm checkbox + a red Approve button + a final
// window.confirm) so a real-money action can never look like a demo one.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  type TradeProposal,
  type AccountMode,
  AUTO_CONFIRM_MIN_CONVICTION,
  AUTO_CONFIRM_MAX_NOTIONAL_USD,
} from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { RejectProposalModal } from './RejectProposalModal';

interface CapStatus {
  live: { orders: number; ordersCap: number; notionalUsd: number; notionalCap: number; perOrderCap: number };
  demo: { orders: number; softCap: number };
}

interface ProposalsResponse {
  proposals: TradeProposal[];
  caps: CapStatus;
  killSwitchEngaged: boolean;
  tradingAgentsEnabled: boolean;
}

const POLL_MS = 5_000;

function relAge(createdAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function PendingProposalsPanel({ token, accountMode }: { token: string; accountMode: AccountMode }) {
  const toast = useToast();
  const [data, setData] = useState<ProposalsResponse | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [liveConfirmed, setLiveConfirmed] = useState<Record<string, boolean>>({});
  const [rejecting, setRejecting] = useState<TradeProposal | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${HTTP_URL}/api/proposals`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setData((await r.json()) as ProposalsResponse);
    } catch (err) {
      logger.error('proposals', 'load failed', err);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => { setNow(Date.now()); void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const proposals = data?.proposals ?? [];
  const caps = data?.caps;
  const killSwitchEngaged = data?.killSwitchEngaged ?? false;
  const agentsOff = !(data?.tradingAgentsEnabled ?? false);
  const liveCapMaxed = caps ? (caps.live.orders >= caps.live.ordersCap || caps.live.notionalUsd >= caps.live.notionalCap) : false;

  const counts = useMemo(() => ({
    total: proposals.length,
    demo: proposals.filter(p => p.mode === 'demo').length,
    live: proposals.filter(p => p.mode === 'live').length,
  }), [proposals]);

  async function approve(p: TradeProposal) {
    if (p.mode === 'live') {
      if (!liveConfirmed[p.id]) return;
      const ok = window.confirm(`Place a REAL live ${p.side.toUpperCase()} of ${p.size} ${p.symbol} (~$${p.notional.toFixed(0)})?`);
      if (!ok) return;
    }
    setBusy(b => ({ ...b, [p.id]: true }));
    try {
      const r = await fetch(`${HTTP_URL}/api/proposals/${encodeURIComponent(p.id)}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (r.ok && body.ok) toast.success(`Approved ${p.symbol} — ${body.reason ?? 'routed'}`);
      else toast.error(`Could not approve ${p.symbol}: ${body.reason ?? `HTTP ${r.status}`}`);
    } catch (err) {
      logger.error('proposals', 'approve failed', err);
      toast.error(`Could not approve ${p.symbol} — network error`);
    } finally {
      setBusy(b => ({ ...b, [p.id]: false }));
      void load();
    }
  }

  async function reject(p: TradeProposal, reason: string) {
    setRejecting(null);
    setBusy(b => ({ ...b, [p.id]: true }));
    try {
      const r = await fetch(`${HTTP_URL}/api/proposals/${encodeURIComponent(p.id)}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (r.ok && body.ok) toast.success(`Rejected ${p.symbol}`);
      else toast.error(`Could not reject ${p.symbol}: ${body.reason ?? `HTTP ${r.status}`}`);
    } catch (err) {
      logger.error('proposals', 'reject failed', err);
      toast.error(`Could not reject ${p.symbol} — network error`);
    } finally {
      setBusy(b => ({ ...b, [p.id]: false }));
      void load();
    }
  }

  return (
    <div className="signals-panel" data-testid="pending-proposals-panel">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Pending Proposals</h3>
        <span className="signal-side" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>
          {counts.total}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-dim)' }}>↻ Auto · 5s</span>
      </div>

      {/* Per-mode context strip — kill switch + live cap usage, always visible. */}
      {caps && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <ModeCell label="Demo" color="var(--blue)" killOn={!killSwitchEngaged && !agentsOff}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              auto under conviction ≥{AUTO_CONFIRM_MIN_CONVICTION} & ≤${AUTO_CONFIRM_MAX_NOTIONAL_USD}
            </span>
          </ModeCell>
          <ModeCell label="● Live" color="var(--green)" killOn={!killSwitchEngaged && !agentsOff}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--orange)' }}>MANUAL ONLY</span>
            <span style={{ fontSize: 11, color: capColor(caps.live.orders, caps.live.ordersCap) }}>
              {caps.live.orders}/{caps.live.ordersCap} live orders ·{' '}
              <span style={{ color: capColor(caps.live.notionalUsd, caps.live.notionalCap) }}>
                ${caps.live.notionalUsd.toFixed(0)}/${caps.live.notionalCap} notional
              </span>
            </span>
          </ModeCell>
        </div>
      )}

      {/* Empty / disabled states */}
      {agentsOff ? (
        <EmptyState
          tone="red"
          title="KILL SWITCH OFF"
          body="Agent trading is paused — it won't queue new proposals."
        />
      ) : proposals.length === 0 ? (
        <EmptyState
          tone="neutral"
          title="No proposals pending"
          body="Agents are watching the market."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {proposals.map(p => (
            <ProposalCard
              key={p.id}
              p={p}
              now={now}
              busy={!!busy[p.id]}
              liveCapMaxed={liveCapMaxed}
              liveConfirmed={!!liveConfirmed[p.id]}
              activeMode={accountMode}
              onToggleLiveConfirm={() => setLiveConfirmed(s => ({ ...s, [p.id]: !s[p.id] }))}
              onApprove={() => void approve(p)}
              onReject={() => setRejecting(p)}
            />
          ))}
        </div>
      )}

      {liveCapMaxed && (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
          Daily live cap reached — live approvals disabled until tomorrow. Demo proposals are unaffected.
        </p>
      )}

      {rejecting && (
        <RejectProposalModal
          symbol={rejecting.symbol}
          side={rejecting.side}
          onCancel={() => setRejecting(null)}
          onConfirm={reason => void reject(rejecting, reason)}
        />
      )}
    </div>
  );
}

function capColor(used: number, cap: number): string {
  if (used >= cap) return 'var(--red)';
  if (used >= cap * 0.75) return 'var(--orange)';
  return 'var(--text-dim)';
}

function ModeCell({ label, color, killOn, children }: {
  label: string; color: string; killOn: boolean; children: ReactNode;
}) {
  return (
    <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600, color }}>{label}</span>
        <span
          className="signal-side"
          style={{
            background: killOn ? 'var(--green-soft)' : 'var(--red-soft)',
            color: killOn ? 'var(--green)' : 'var(--red)',
          }}
        >
          {killOn ? 'ON' : 'OFF'}
        </span>
      </div>
      {children}
    </div>
  );
}

function EmptyState({ tone, title, body }: { tone: 'red' | 'neutral'; title: string; body: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 12px', color: 'var(--text-dim)' }}>
      <div
        className="signal-side"
        style={{
          background: tone === 'red' ? 'var(--red-soft)' : 'var(--surface)',
          color: tone === 'red' ? 'var(--red)' : 'var(--text-dim)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <p style={{ margin: 0 }}>{body}</p>
    </div>
  );
}

function ProposalCard({
  p, now, busy, liveCapMaxed, liveConfirmed, activeMode, onToggleLiveConfirm, onApprove, onReject,
}: {
  p: TradeProposal;
  now: number;
  busy: boolean;
  liveCapMaxed: boolean;
  liveConfirmed: boolean;
  activeMode: AccountMode;
  onToggleLiveConfirm: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isLive = p.mode === 'live';
  const convPct = Math.round(p.conviction * 100);
  const convOk = p.conviction >= AUTO_CONFIRM_MIN_CONVICTION;
  // Approve is blocked when the engine's active mode differs from the proposal's
  // mode (the server refuses a cross-mode confirm), when busy, or — for live —
  // until the checkbox is ticked and the daily cap has headroom.
  const wrongMode = p.mode !== activeMode;
  const approveDisabled = busy || wrongMode || (isLive && (!liveConfirmed || liveCapMaxed));

  return (
    <div
      className={`signal-card ${p.side === 'sell' ? 'sell' : 'buy'}`}
      style={isLive ? { borderLeft: '3px solid var(--green)', boxShadow: '0 0 0 1px var(--red-soft)' } : { borderLeft: '3px solid var(--blue)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{p.symbol}</strong>
        <span className={`signal-side ${p.side === 'sell' ? 'sell' : 'buy'}`}>{p.side.toUpperCase()}</span>
        <span
          className="signal-side"
          style={isLive
            ? { background: 'transparent', color: 'var(--green)', border: '1px solid var(--green)' }
            : { background: 'var(--blue-soft)', color: 'var(--blue)' }}
        >
          {isLive ? '● Live' : 'Demo'}
        </span>
        {isLive && (
          <span className="signal-side" style={{ background: 'var(--red-soft)', color: 'var(--red)', fontWeight: 700 }}>
            REAL MONEY
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          🕑 {relAge(p.createdAt, now)}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, margin: '8px 0', fontSize: 12 }}>
        <Stat label="Size" value={String(p.size)} />
        <Stat label="Notional" value={`$${p.notional.toFixed(0)}`} />
        <Stat label="Conviction" value={`${convPct}%`} valueColor={convOk ? 'var(--green)' : 'var(--orange)'} />
        <Stat label="Verdict" value={p.verdict} />
      </div>
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginBottom: 8 }}>
        <div style={{ width: `${convPct}%`, height: '100%', borderRadius: 2, background: convOk ? 'var(--green)' : 'var(--orange)' }} />
      </div>

      {p.note && <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-dim)' }}>{p.note}</p>}

      {isLive && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={liveConfirmed} onChange={onToggleLiveConfirm} />
          I confirm placing a real live order (counts toward the live daily cap).
        </label>
      )}

      {wrongMode && (
        <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--orange)' }}>
          Switch to {p.mode} mode to confirm this proposal.
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary btn-sm" disabled={busy} onClick={onReject}>Reject</button>
        <button
          className={isLive ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
          disabled={approveDisabled}
          onClick={onApprove}
        >
          {isLive ? 'Approve live order' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600, ...(valueColor ? { color: valueColor } : {}) }}>{value}</div>
    </div>
  );
}
