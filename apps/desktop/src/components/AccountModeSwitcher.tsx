// TRA-419 — AccountModeSwitcher component extracted from App.tsx.
import { useState } from 'react';
import { useToast } from '../lib/toast.tsx';
import { logger } from '../lib/logger';
import { HTTP_URL } from '../server-url';

export function AccountModeSwitcher({
  mode,
  onChange,
  market,
  token,
}: {
  mode: 'demo' | 'live';
  onChange: (mode: 'demo' | 'live') => void;
  market: 'stocks' | 'crypto';
  token: string;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function switchTo(next: 'demo' | 'live') {
    if (next === mode || busy) return;
    if (next === 'live') {
      const ackKey = `liveModeAcknowledged_${market}`;
      const alreadyAcknowledged = localStorage.getItem(ackKey) === 'true';
      if (!alreadyAcknowledged) {
        const ok = window.confirm(
          `Switch ${market === 'crypto' ? 'Crypto' : 'Stocks'} dashboard to LIVE account?\n\n` +
          'Live mode places real orders against your configured brokerage. ' +
          'Make sure your live credentials are set up in Settings.',
        );
        if (!ok) return;
        localStorage.setItem(ackKey, 'true');
      }
    }
    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/account/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (r.ok) {
        onChange(next);
        toast.success(`Switched to ${next === 'live' ? 'Live' : 'Demo'} account`);
      } else {
        // TRA-575 — surface the server's structured reason instead of a bare
        // "HTTP 422". The promotion gate returns { code, error, blocked } with
        // the exact blocking strategies; show the operator WHY and where to fix
        // it rather than an opaque status code.
        let reason = `HTTP ${r.status}`;
        let isPromotionGate = false;
        try {
          const body = (await r.json()) as { code?: string; error?: string };
          if (typeof body?.error === 'string' && body.error.trim() !== '') reason = body.error;
          isPromotionGate = body?.code === 'promotion_gate_blocked';
        } catch {
          // Non-JSON body — keep the status-code fallback.
        }
        logger.warn('account-mode', `mode switch returned HTTP ${r.status}: ${reason}`);
        toast.error(
          `Could not switch to ${next} account — ${reason}`
          + (isPromotionGate ? ' (promote the strategy in Settings → Promotion before going live)' : ''),
        );
      }
    } catch (err) {
      logger.error('account-mode', `failed to switch to ${next} account`, err);
      toast.error(`Could not switch to ${next} account — network error`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`account-mode-switch${busy ? ' busy' : ''}`} role="group" aria-label="Account mode">
      <button
        type="button"
        className={`account-mode-option demo${mode === 'demo' ? ' active' : ''}`}
        onClick={() => switchTo('demo')}
        disabled={busy}
        aria-pressed={mode === 'demo'}
        title="Use the demo (paper) account"
      >
        Demo
      </button>
      <button
        type="button"
        className={`account-mode-option live${mode === 'live' ? ' active' : ''}`}
        onClick={() => switchTo('live')}
        disabled={busy}
        aria-pressed={mode === 'live'}
        title="Use the live brokerage account"
      >
        Live
      </button>
    </div>
  );
}
