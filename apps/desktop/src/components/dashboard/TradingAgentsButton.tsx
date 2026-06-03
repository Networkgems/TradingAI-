// TRA-544 (TRA-529 §2B) — the "Trading Agents" banner toggle. One switch with
// clear ownership: OFF (default) → today's deterministic strategy/router system
// drives trading; ON → the multi-agent analyst layer takes over as the active
// decision-maker and deterministic auto-routing is suspended (never both at
// once). It is a RUNTIME flag, flipped live via POST /api/trading/trading-agents
// — the WS `state` push then confirms the new value, like the kill switch.
//
// Takeover never means "bypass risk": even ON, agent orders still clear the
// deterministic RiskManager hard caps and the TRA-526 kill switch overrides
// everything (TRA-529 §2B). Switching EITHER direction changes who decides, so
// both flips go through a confirm step. P1 is advisory-only — the agent layer
// runs the deterministic STUB (no LLM spend); gating mode is P4.
//
// The button keeps an optimistic local state so the label flips the instant the
// POST succeeds, while the seed `enabled` prop (from account settings / WS
// state) keeps it correct across reloads and cross-operator changes.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';

export function TradingAgentsButton({
  token,
  enabled,
  onToggled,
}: {
  token: string;
  enabled: boolean;
  /** Notifies the parent of the new state after a successful toggle. */
  onToggled?: (enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const toast = useToast();

  // Re-seed from the authoritative snapshot when it arrives/changes.
  useEffect(() => { setLocalEnabled(enabled); }, [enabled]);

  async function toggle() {
    const next = !localEnabled;
    const ok = window.confirm(
      next
        ? 'Switch the active decision-maker to TRADING AGENTS?\n\n'
          + 'The multi-agent analyst layer takes over and the deterministic '
          + 'strategy auto-router is SUSPENDED. Orders still pass the risk caps '
          + 'and the kill switch still overrides everything.\n\n'
          + '(P1: advisory stub — no live LLM spend yet.)'
        : 'Switch back to the DETERMINISTIC strategy system?\n\n'
          + 'The multi-agent layer stops driving and the strategy / router / '
          + 'risk stack resumes control of trading.',
    );
    if (!ok) return;

    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/trading-agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: next }),
      });
      if (r.ok) {
        setLocalEnabled(next);
        onToggled?.(next);
        toast.success(next
          ? 'Trading Agents ON — multi-agent layer is now driving'
          : 'Trading Agents OFF — deterministic system resumed');
      } else {
        logger.warn('trading-agents', `toggle returned HTTP ${r.status}`);
        toast.error(`Could not toggle Trading Agents (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('trading-agents', 'failed to toggle Trading Agents', err);
      toast.error('Could not toggle Trading Agents — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`logout-btn trading-agents-btn${localEnabled ? ' active' : ''}`}
      onClick={toggle}
      disabled={busy}
      title={localEnabled
        ? 'Trading Agents are ON — the multi-agent layer is the active decision-maker (deterministic auto-routing suspended). Click to hand control back.'
        : 'Switch to the multi-agent decision-maker — suspends deterministic auto-routing (still behind the risk caps + kill switch)'}
    >
      {localEnabled ? '🤖 Trading Agents ON' : '🤖 Trading Agents'}
    </button>
  );
}
