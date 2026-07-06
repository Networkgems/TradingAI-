// TRA-895 (TRA-796 P4) — the demo-only "Agent Gating" toggle. The "Trading
// Agents" switch alone is advisory: the multi-agent layer evaluates and
// recommends, but nothing opens automatically (and the deterministic
// auto-router is suspended while agents are ON). Gating is the switch that lets
// an agent APPROVE recommendation auto-route as a risk-checked order — i.e. the
// agents actually OPEN / monitor / close trades.
//
// This control is DEMO-ONLY by construction: it posts `liveEnabled: false` and
// is only rendered in demo (paper) mode, so it can never arm live routing. Live
// agent routing stays behind the separate board+CTO go-live gate
// (`tradingAgentsLiveGatingEnabled`), which has no UI and is API-only on
// purpose. Even when gating is ON, every agent order still clears the
// deterministic RiskManager hard caps + the TRA-554 daily trade cap, and the
// TRA-526 kill switch overrides everything.
//
// Flipped live via POST /api/trading/trading-agents/gating; the WS `state` push
// then confirms the new value, like the kill switch and the agents toggle. The
// seed `enabled` prop keeps it correct across reloads and cross-operator changes.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';

export function AgentGatingButton({
  token,
  enabled,
  agentsEnabled,
  onToggled,
}: {
  token: string;
  /** Seed: true ↔ demo gating is armed (agents auto-route paper orders). */
  enabled: boolean;
  /** Whether the Trading Agents layer is ON — gating only has effect when it is. */
  agentsEnabled: boolean;
  /** Notifies the parent of the new state after a successful toggle. */
  onToggled?: (enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const toast = useToast();

  // Re-seed from the authoritative snapshot when it arrives/changes.
  useEffect(() => { setLocalEnabled(enabled); }, [enabled]);

  // TRA-1350 — when the agent layer is OFF the control can't be armed, but a
  // plain `disabled` button gives no clue what unlocks it (a `title` tooltip
  // doesn't render on a disabled element in Chrome/Safari). Keep the button
  // clickable while locked and, on click, surface the exact enable path as a
  // toast instead of silently doing nothing.
  const locked = !agentsEnabled;

  async function toggle() {
    if (locked) {
      toast.info(
        'Auto-Trade is locked. Turn Trading Agents ON first — gating only '
        + 'routes while the agent layer is the active decision-maker.',
      );
      return;
    }
    const next = !localEnabled;
    const ok = window.confirm(
      next
        ? 'Arm DEMO agent gating?\n\n'
          + 'The Trading Agents will now AUTO-OPEN paper (demo) trades from their '
          + 'APPROVE recommendations, then monitor and close them. Every order '
          + 'still clears the risk caps + daily trade cap, and the kill switch '
          + 'overrides everything.\n\n'
          + 'This is PAPER ONLY — it can never place a live order.'
        : 'Disarm demo agent gating?\n\n'
          + 'The agents go back to advisory-only — they will recommend but no '
          + 'new paper trades will open automatically.',
    );
    if (!ok) return;

    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/trading-agents/gating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // liveEnabled is HARD-PINNED false: this control is demo-only and must
        // never arm live routing (that is the separate board+CTO go-live gate).
        body: JSON.stringify({ enabled: next, liveEnabled: false }),
      });
      if (r.ok) {
        setLocalEnabled(next);
        onToggled?.(next);
        toast.success(next
          ? 'Agent gating ARMED (demo) — agents will auto-open paper trades'
          : 'Agent gating OFF — agents are advisory-only');
      } else {
        logger.warn('agent-gating', `toggle returned HTTP ${r.status}`);
        toast.error(`Could not toggle agent gating (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('agent-gating', 'failed to toggle agent gating', err);
      toast.error('Could not toggle agent gating — network error');
    } finally {
      setBusy(false);
    }
  }

  const hint = locked
    ? 'Locked — turn Trading Agents ON first. Gating only routes while the agent layer is the active decision-maker.'
    : localEnabled
      ? 'Demo gating is ARMED — agents auto-open/monitor/close paper trades (still behind the risk caps + kill switch). Click to go advisory-only.'
      : 'Arm demo gating so the agents auto-open paper trades from their APPROVE recommendations (paper only — never live).';

  return (
    <span className="agent-gating-wrap">
      <button
        type="button"
        className={`logout-btn agent-gating-btn${localEnabled ? ' active' : ''}${locked ? ' locked' : ''}`}
        onClick={toggle}
        // Stay clickable while locked so the click can explain the enable path;
        // only a genuine in-flight request disables it.
        disabled={busy}
        aria-disabled={locked}
        title={hint}
      >
        {locked
          ? '🔒 Auto-Trade (demo)'
          : localEnabled ? '⚡ Auto-Trade ON (demo)' : '⚡ Auto-Trade (demo)'}
      </button>
      {locked && (
        <span className="agent-gating-note">Turn Trading Agents ON to enable</span>
      )}
    </span>
  );
}
