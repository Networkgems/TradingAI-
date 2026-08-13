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
  /** TRA-945 §2 — store TTL (ms); a proposal nearing it greys out (§6). Older
   *  servers omit it, so the staleness treatment is feature-detected. */
  proposalTtlMs?: number;
}

const POLL_MS = 5_000;

// TRA-945 §2 — how long before the store TTL a pending proposal starts showing
// the "about to expire" treatment. Capped at 20% of the TTL so a short test/env
// TTL still has a pre-expiry window rather than flagging everything stale.
const STALE_WARN_MS = 120_000; // 2 minutes

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

  const [enablingAgents, setEnablingAgents] = useState(false);

  const proposals = useMemo(() => data?.proposals ?? [], [data]);
  const caps = data?.caps;
  const killSwitchEngaged = data?.killSwitchEngaged ?? false;
  const agentsOff = !(data?.tradingAgentsEnabled ?? false);
  const liveCapMaxed = caps ? (caps.live.orders >= caps.live.ordersCap || caps.live.notionalUsd >= caps.live.notionalCap) : false;
  // TRA-945 §2 — a proposal within this window of the store TTL greys out with a
  // disabled Approve + "stale — re-request" hint. Feature-detected: when the
  // server doesn't report a TTL we keep the prior disappear-on-expiry behavior.
  const staleWarnAfterMs = data?.proposalTtlMs != null
    ? data.proposalTtlMs - Math.min(STALE_WARN_MS, data.proposalTtlMs * 0.2)
    : undefined;

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

  // TRA-945 §1 — empty-state-B CTA: re-enable agent trading without leaving the
  // panel. Hits the same master-switch route the header TradingAgentsButton uses
  // (POST /api/trading/trading-agents); on success a poll repopulates the queue.
  async function enableAgents() {
    setEnablingAgents(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/trading-agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: true }),
      });
      if (r.ok) {
        toast.success('Trading Agents ON — agents will start queuing proposals');
        void load();
      } else {
        toast.error(`Could not turn on agent trading (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('proposals', 'enable agents failed', err);
      toast.error('Could not turn on agent trading — network error');
    } finally {
      setEnablingAgents(false);
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
          cta={{ label: 'Turn on agent trading', busy: enablingAgents, onClick: () => void enableAgents() }}
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
              staleWarnAfterMs={staleWarnAfterMs}
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

function EmptyState({ tone, title, body, cta }: {
  tone: 'red' | 'neutral';
  title: string;
  body: string;
  cta?: { label: string; busy: boolean; onClick: () => void };
}) {
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
      {cta && (
        <button
          type="button"
          className="btn-link"
          onClick={cta.onClick}
          disabled={cta.busy}
          style={{
            marginTop: 10,
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--blue)',
            font: 'inherit',
            cursor: cta.busy ? 'default' : 'pointer',
            textDecoration: 'underline',
            opacity: cta.busy ? 0.6 : 1,
          }}
        >
          {cta.busy ? 'Turning on…' : cta.label}
        </button>
      )}
    </div>
  );
}

function ProposalCard({
  p, now, staleWarnAfterMs, busy, liveCapMaxed, liveConfirmed, activeMode, onToggleLiveConfirm, onApprove, onReject,
}: {
  p: TradeProposal;
  now: number;
  staleWarnAfterMs: number | undefined;
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
  // TRA-3514 (TRA-3460 (c) §2) — WHICH GRAPH PRODUCED THIS CONVICTION.
  //
  // ⭐ `=== true`, not `!== false`: an equity/agent proposal that arrives without the
  // stamp has not PROVEN an LLM read, and the server's auto-confirm gate refuses it
  // on exactly that reading. The panel must not be more optimistic than the gate, or
  // an operator reads a green conviction on a card the server already declined to
  // route and concludes the difference is a bug.
  //
  // ⚠️ `kind === 'options'` proposals come from the AI-Ideas feed, which has no
  // advisory graph behind it, so they legitimately carry no stamp and are exempted
  // rather than badged FALLBACK. Badging them would be a false alarm on every card
  // in the options queue — an unexplained warning on a healthy rail teaches
  // operators to ignore the badge, which costs us the one case it exists for.
  const backingKnown = p.kind !== 'options';
  const llmBacked = p.llmUsed === true;
  const isFallbackRead = backingKnown && !llmBacked;
  // The conviction number itself is DE-EMPHASISED on a fallback read, not just
  // annotated. The requirement is that it "must not render identically to a real
  // one", and a badge elsewhere in the header is easy to miss while reading the
  // number — so the number stops being green even when it clears the threshold.
  const convOk = p.conviction >= AUTO_CONFIRM_MIN_CONVICTION && !isFallbackRead;
  // TRA-945 §2 — near-TTL staleness: once a pending proposal ages into the warn
  // window the server reported (proposalTtlMs), grey it out and disable Approve
  // with a "stale — re-request" hint, rather than letting it silently vanish at
  // the TTL. The server still drops it from the pending list once fully expired.
  const nearStale = staleWarnAfterMs != null && now - p.createdAt >= staleWarnAfterMs;
  // Approve is blocked when the engine's active mode differs from the proposal's
  // mode (the server refuses a cross-mode confirm), when busy, when near-stale,
  // or — for live — until the checkbox is ticked and the daily cap has headroom.
  const wrongMode = p.mode !== activeMode;
  const approveDisabled = busy || wrongMode || nearStale || (isLive && (!liveConfirmed || liveCapMaxed));

  return (
    <div
      className={`signal-card ${p.side === 'sell' ? 'sell' : 'buy'}`}
      style={{
        ...(isLive ? { borderLeft: '3px solid var(--green)', boxShadow: '0 0 0 1px var(--red-soft)' } : { borderLeft: '3px solid var(--blue)' }),
        ...(nearStale ? { opacity: 0.55, filter: 'grayscale(0.7)' } : {}),
      }}
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
        {nearStale && (
          <span className="signal-side" style={{ background: 'var(--surface)', color: 'var(--orange)', border: '1px solid var(--orange)' }}>
            STALE
          </span>
        )}
        {/* TRA-3514 §2 — the backing badge. Shown in BOTH directions on purpose: a
            silent card would leave the operator unable to tell "LLM-backed" from
            "this build does not report backing", and an absent badge is exactly what
            the old build looked like. */}
        {backingKnown && (
          <span
            className="signal-side"
            title={isFallbackRead
              ? 'Conviction came from the DETERMINISTIC zero-cost graph (no model call — the daily LLM cap was reached, the layer was off, or no credential was wired). Auto-confirm is refused on this read; approve only on your own judgement.'
              : 'Conviction came from a real LLM analyst/trader/risk run.'}
            style={isFallbackRead
              ? { background: 'var(--orange-soft, var(--surface))', color: 'var(--orange)', border: '1px solid var(--orange)', fontWeight: 700 }
              : { background: 'var(--surface)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
          >
            {isFallbackRead ? '⚠ FALLBACK — no LLM read' : 'LLM-backed'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          🕑 {relAge(p.createdAt, now)}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, margin: '8px 0', fontSize: 12 }}>
        <Stat label="Size" value={String(p.size)} />
        <Stat label="Notional" value={`$${p.notional.toFixed(0)}`} />
        <Stat
          label={isFallbackRead ? 'Conviction (deterministic)' : 'Conviction'}
          value={`${convPct}%`}
          valueColor={convOk ? 'var(--green)' : 'var(--orange)'}
        />
        <Stat label="Verdict" value={p.verdict} />
      </div>
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginBottom: 8 }}>
        <div
          style={{
            width: `${convPct}%`,
            height: '100%',
            borderRadius: 2,
            background: convOk ? 'var(--green)' : 'var(--orange)',
            // A hatched/faded bar on a fallback read, so the AT-A-GLANCE signal (bar
            // length) is visibly not a researched measurement either.
            ...(isFallbackRead ? { opacity: 0.45 } : {}),
          }}
        />
      </div>
      {isFallbackRead && (
        <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--orange)' }}>
          No model call backed this recommendation — the numbers above come from the
          deterministic fallback graph. Auto-confirm is refused on a fallback read.
        </p>
      )}

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

      {nearStale && (
        <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--orange)' }}>
          stale — re-request. This proposal is about to expire and can no longer be confirmed.
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
