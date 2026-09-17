// TRA-535 — operator-facing control for the TRA-526 global kill switch. The
// deterministic risk layer ("the AI proposes, the math disposes") shipped its
// backend on `main` (cad22de) with only a `POST /api/trading/kill-switch`
// route; until now the only way to engage the master halt was curl. This button
// lives in the Stocks dashboard header and toggles that single global switch —
// there is no separate per-engine endpoint, the one route halts new entries
// and persists via `globalKillSwitchEngaged` in account settings so the halt
// survives a restart.
//
// Engaging is gated behind a confirm dialog (it halts all new entries across
// both engines, so it must be hard to fat-finger) and prompts for an optional
// reason that surfaces in the halt banner. Releasing is a recovery action and
// goes through immediately. The button keeps its own optimistic engaged state
// so the label flips the instant the POST succeeds, while the seed `engaged`
// prop (read from account settings) keeps it correct across reloads.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';

export function KillSwitchButton({
  token,
  engaged,
  onToggled,
}: {
  token: string;
  engaged: boolean;
  /** Notifies the parent of the new engaged state after a successful toggle. */
  onToggled?: (engaged: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localEngaged, setLocalEngaged] = useState(engaged);
  const toast = useToast();

  // Re-seed from the authoritative settings snapshot when it arrives/changes
  // (e.g. another operator toggled it, or the initial fetch lands after mount).
  useEffect(() => { setLocalEngaged(engaged); }, [engaged]);

  async function toggle() {
    const next = !localEngaged;
    let reason: string | undefined;
    if (next) {
      const ok = window.confirm(
        'Engage the GLOBAL KILL SWITCH?\n\n' +
        'This immediately halts ALL new entries until you release it. ' +
        'Open positions are NOT closed. ' +
        'The halt persists across server restarts.',
      );
      if (!ok) return;
      const entered = window.prompt('Optional reason (shown in the halt banner):', '');
      // Cancel on the reason prompt aborts the whole action — the operator
      // backed out after the confirm, so don't engage silently.
      if (entered === null) return;
      reason = entered.trim() || undefined;
    }

    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/kill-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ engaged: next, ...(reason ? { reason } : {}) }),
      });
      if (r.ok) {
        setLocalEngaged(next);
        onToggled?.(next);
        toast.success(next ? 'Kill switch ENGAGED — all new entries halted' : 'Kill switch released');
      } else {
        logger.warn('kill-switch', `toggle returned HTTP ${r.status}`);
        toast.error(`Could not toggle kill switch (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('kill-switch', 'failed to toggle kill switch', err);
      toast.error('Could not toggle kill switch — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`logout-btn kill-switch-btn${localEngaged ? ' engaged' : ''}`}
      onClick={toggle}
      disabled={busy}
      title={localEngaged
        ? 'Global kill switch is ENGAGED — click to release and allow new entries'
        : 'Engage the global kill switch — halts all new entries across both engines'}
    >
      {localEngaged ? '🛑 Kill Switch ON' : '⦸ Kill Switch'}
    </button>
  );
}
