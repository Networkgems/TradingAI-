// TRA-503 — manual "Sync Tradier {env} equity positions" button on the
// Stocks Positions panel. Mirrors the option-sync hook embedded in
// useStockOptionClose but calls the equity endpoint, which forces the engine's
// existing equity-portfolio reconcile (TRA-415) rather than reaching for
// Tradier directly.
import { useRef, useState } from 'react';
import { HTTP_URL } from '../server-url';
import { logger } from '../lib/logger';
import { useToast } from '../lib/toast.tsx';

export function useTradierEquitySync(token: string, tradierEnv: 'sandbox' | 'production') {
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState('');
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  async function syncTradierEquityPositions() {
    setSyncing(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/tradier/equity-positions/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json().catch(
        () => ({} as { error?: string; added?: number; updated?: number; removed?: number; total?: number }),
      );
      if (!r.ok) {
        const message = data?.error ?? `Sync failed (${r.status})`;
        logger.warn('tradier-equity-sync', 'positions sync rejected', { env: tradierEnv, message });
        setStatus(message);
        toast.error(`Tradier equity sync failed: ${message}`);
      } else {
        const added = data.added ?? 0;
        const updated = data.updated ?? 0;
        const removed = data.removed ?? 0;
        const total = data.total ?? 0;
        if (total === 0) {
          setStatus(`Tradier ${tradierEnv}: no open equity positions`);
          toast.info(`Tradier ${tradierEnv}: no open equity positions`);
        } else {
          const summary = `Synced ${total} Tradier ${tradierEnv} equity position(s): +${added} new, ~${updated} updated, −${removed} closed`;
          setStatus(summary);
          toast.success(summary);
        }
      }
    } catch (err) {
      logger.error('tradier-equity-sync', 'positions sync failed', err);
      setStatus(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
      toast.error('Tradier equity sync failed — network error');
    } finally {
      setSyncing(false);
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => setStatus(''), 6000);
    }
  }

  return { syncTradierEquityPositions, syncing, status };
}
