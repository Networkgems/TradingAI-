// TRA-422 — option close + Tradier sync logic for the Stocks Options panel,
// extracted from Dashboard.tsx so the panel component stays under the size
// budget. Owns the TRA-358 Tradier-style limit-close drawer, the direct-close
// path (imported / demo positions), pending-exit cancellation, and the manual
// Tradier positions sync. Behaviour is carried through unchanged.
import { useCallback, useRef, useState } from 'react';
import type { OptionPosition } from '@trading-app/shared';
import { HTTP_URL } from '../server-url';
import { logger } from '../lib/logger';
import { useToast } from '../lib/toast.tsx';
import { useFocusTrap } from '../lib/useFocusTrap';
import { validateLimitPrice, validateCloseQty } from '../lib/validation';

// TRA-358 — Tradier-style close drawer for engine-opened LIVE option
// positions. Mirrors the price/qty/duration form Tradier shows on its web
// close panel; submit posts a sell_to_close LIMIT and the row transitions into
// a "Pending #N" state with a Cancel button until Tradier fills (or rejects,
// surfacing exitErrorReason). Demo and imported positions skip the drawer and
// use the legacy direct close.
export interface CloseDrawerState {
  optionId: string;
  symbol: string;
  optionSymbol?: string | undefined;
  optionType: 'call' | 'put';
  contractsRemaining: number;
  defaultPrice: number;
  price: string;
  qty: string;
  duration: 'day' | 'gtc' | 'pre' | 'post';
  submitting: boolean;
  error?: string | undefined;
}

export function useStockOptionClose(token: string, tradierEnv: 'sandbox' | 'production') {
  const [closeDrawer, setCloseDrawer] = useState<CloseDrawerState | null>(null);
  // TRA-358 — Cancel button on a pending-exit row uses this to lock the button
  // while the cancel POST is in flight; per-row state keyed by option id so
  // multiple in-flight cancels don't fight for one boolean.
  const [cancellingExits, setCancellingExits] = useState<Record<string, boolean>>({});
  // TRA-407 (C4) — per-row lock while a close POST is in flight. Closes the
  // narrow double-click window before the server's `pendingCloseOrderId`
  // round-trips back, so a single contract can't get two `sell_to_close`
  // orders working at once.
  const [closingOptions, setClosingOptions] = useState<Record<string, boolean>>({});
  const [tradierSyncing, setTradierSyncing] = useState(false);
  const [tradierSyncStatus, setTradierSyncStatus] = useState('');
  const tradierSyncStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  const closeDrawerCancel = useCallback(() => {
    setCloseDrawer(prev => (prev?.submitting ? prev : null));
  }, []);

  // TRA-409 — keyboard accessibility for the close drawer: trap Tab focus
  // inside the dialog while it is open, close it on Esc, and restore focus to
  // the triggering control once it closes.
  const closeDrawerRef = useFocusTrap<HTMLDivElement>(closeDrawer != null, closeDrawerCancel);

  function setSyncStatus(message: string, ms: number) {
    setTradierSyncStatus(message);
    if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
    tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), ms);
  }

  // TRA-358 — direct close path used by the imported and demo branches (no
  // user-facing limit form). The engine-opened LIVE branch goes through
  // `submitCloseDrawer` instead because the user is choosing price + qty +
  // duration in a Tradier-style panel.
  async function closeOption(optionId: string, body?: Record<string, unknown>) {
    const r = await fetch(`${HTTP_URL}/api/options/${optionId}/close`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => null);
    // TRA-323 / TRA-348 / TRA-358 — surface broker-side rejection so the row
    // doesn't sit stuck. The 202 path (Tradier accepted but the order didn't
    // reach a terminal state in the wait window) leaves the row visible with
    // a Pending badge.
    if (!r) {
      logger.error('stock-close', 'network error closing option', { optionId });
      toast.error('Close failed — network error');
      return { ok: false as const, error: 'Network error' };
    }
    const data = await r.json().catch(() => ({} as {
      error?: string;
      status?: string;
      orderId?: number | string;
      fillPrice?: number;
      reason?: string;
      message?: string;
    }));
    if (r.status === 202 && data?.status === 'pending') {
      setSyncStatus(`Tradier close pending #${data.orderId ?? '?'} — row will drop once Tradier fills`, 8000);
      toast.info(`Tradier close pending #${data.orderId ?? '?'}`);
      return { ok: true as const, status: 'pending' as const, orderId: data?.orderId };
    }
    if (!r.ok) {
      const message = data?.error ?? `Close failed (${r.status})`;
      logger.warn('stock-close', 'option close rejected', { optionId, status: r.status, message });
      setSyncStatus(`Close failed: ${message}`, 6000);
      toast.error(`Close failed: ${message}`);
      return { ok: false as const, error: message };
    }
    // TRA-2799 — Tradier was flat on this contract, so no order filled, but the
    // stale row IS gone. "Option close submitted" would be a lie (nothing was
    // submitted) and an error toast would be wrong too (the user got exactly
    // what they clicked for), so this outcome gets its own message.
    if (data?.status === 'reconciled') {
      const message = data.message
        ?? 'Tradier no longer holds this position — closed here at break-even, booking $0 realized.';
      logger.info('stock-close', 'stale option row reconciled against a flat broker', {
        optionId,
        reason: data.reason,
      });
      setSyncStatus(message, 10000);
      toast.success('Position cleared — Tradier no longer holds it');
      return { ok: true as const, status: 'reconciled' as const, orderId: data?.orderId };
    }
    toast.success('Option close submitted');
    return { ok: true as const, status: data?.status ?? 'filled', orderId: data?.orderId, fillPrice: data?.fillPrice };
  }

  // TRA-358 — open the limit-close drawer for a position. Engine-opened live
  // positions submit through this path; everything else (imported,
  // engine-opened demo) skips the drawer and runs the direct close which keeps
  // the existing TRA-352 / TRA-348 behaviour.
  function openCloseDrawer(o: OptionPosition, isLiveEngineOpened: boolean) {
    if (!isLiveEngineOpened) {
      // TRA-407 (C4) — direct close path (imported / engine-opened demo).
      // Lock the row while the POST is in flight so a double-click can't fire
      // a second sell_to_close before the server's pendingCloseOrderId
      // round-trips back and swaps the button for a "Pending #N" badge.
      if (closingOptions[o.id]) return;
      setClosingOptions(prev => ({ ...prev, [o.id]: true }));
      void closeOption(o.id).finally(() => {
        setClosingOptions(prev => {
          const next = { ...prev };
          delete next[o.id];
          return next;
        });
      });
      return;
    }
    if (o.pendingExit) {
      // Already pending — let the user cancel from the row's badge.
      return;
    }
    // TRA-2890 — deliberately the NBBO mid (`currentPremium`), NOT the
    // last-trade display mark the table renders: this seeds a real limit
    // order, and a resting limit at a stale print on an illiquid contract
    // either can't fill or gives away the spread. Execution stays on the mid.
    const defaultPrice = Number.isFinite(o.currentPremium) && o.currentPremium > 0
      ? o.currentPremium
      : o.premiumPaid;
    setCloseDrawer({
      optionId: o.id,
      symbol: o.symbol,
      optionSymbol: o.optionSymbol,
      optionType: o.optionType,
      contractsRemaining: o.contractsRemaining,
      defaultPrice,
      price: defaultPrice.toFixed(2),
      qty: String(o.contractsRemaining),
      duration: 'day',
      submitting: false,
    });
  }

  async function submitCloseDrawer() {
    if (!closeDrawer || closeDrawer.submitting) return;
    // TRA-419 — validation routed through src/lib/validation.ts so the
    // close-drawer rules are unit-tested and stay in sync with the server.
    const priceError = validateLimitPrice(closeDrawer.price);
    if (priceError) {
      setCloseDrawer(prev => prev ? { ...prev, error: priceError } : prev);
      return;
    }
    const qtyError = validateCloseQty(closeDrawer.qty, closeDrawer.contractsRemaining);
    if (qtyError) {
      setCloseDrawer(prev => prev ? { ...prev, error: qtyError } : prev);
      return;
    }
    const limitPrice = Number(closeDrawer.price);
    const qty = Number(closeDrawer.qty);
    setCloseDrawer(prev => prev ? { ...prev, submitting: true, error: undefined } : prev);
    const result = await closeOption(closeDrawer.optionId, {
      limitPrice,
      qty,
      duration: closeDrawer.duration,
    });
    if (result.ok) {
      setCloseDrawer(null);
    } else {
      setCloseDrawer(prev => prev ? {
        ...prev,
        submitting: false,
        error: result.error ?? 'Close failed.',
      } : prev);
    }
  }

  // TRA-358 — fire the matching Tradier cancel for an in-flight pending exit.
  // On success the server clears the position's pendingExit and the next state
  // broadcast re-renders the Close button on the row.
  async function cancelPendingExit(optionId: string) {
    setCancellingExits(prev => ({ ...prev, [optionId]: true }));
    try {
      const r = await fetch(`${HTTP_URL}/api/options/${optionId}/cancel-pending-exit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!r) {
        logger.error('stock-close', 'network error cancelling pending exit', { optionId });
        setTradierSyncStatus('Cancel failed: network error');
        toast.error('Cancel failed — network error');
      } else if (!r.ok) {
        const data = await r.json().catch(() => ({} as { error?: string }));
        const message = data?.error ?? String(r.status);
        logger.warn('stock-close', 'cancel pending exit rejected', { optionId, message });
        setTradierSyncStatus(`Cancel failed: ${message}`);
        toast.error(`Cancel failed: ${message}`);
      } else {
        setTradierSyncStatus('Tradier cancel accepted');
        toast.success('Tradier cancel accepted');
      }
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 6000);
    } finally {
      setCancellingExits(prev => {
        const next = { ...prev };
        delete next[optionId];
        return next;
      });
    }
  }

  // TRA-323 — pull open option positions from Tradier into TradeAI so the user
  // can close them from here. Defaults to whichever Tradier env is currently
  // selected; the server-side handler routes the import into the matching env.
  async function syncTradierPositions() {
    setTradierSyncing(true);
    try {
      const r = await fetch(
        `${HTTP_URL}/api/tradier/positions/sync?env=${encodeURIComponent(tradierEnv)}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await r.json().catch(() => ({} as { error?: string; added?: number; updated?: number; removed?: number; total?: number }));
      if (!r.ok) {
        const message = data?.error ?? `Sync failed (${r.status})`;
        logger.warn('tradier-sync', 'positions sync rejected', { env: tradierEnv, message });
        setTradierSyncStatus(message);
        toast.error(`Tradier sync failed: ${message}`);
      } else {
        const added = data.added ?? 0;
        const updated = data.updated ?? 0;
        const removed = data.removed ?? 0;
        const total = data.total ?? 0;
        if (total === 0) {
          setTradierSyncStatus(`Tradier ${tradierEnv}: no open positions`);
          toast.info(`Tradier ${tradierEnv}: no open positions`);
        } else {
          const summary = `Synced ${total} Tradier ${tradierEnv} position(s): +${added} new, ~${updated} updated, −${removed} closed`;
          setTradierSyncStatus(summary);
          toast.success(summary);
        }
      }
    } catch (err) {
      logger.error('tradier-sync', 'positions sync failed', err);
      setTradierSyncStatus(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
      toast.error('Tradier sync failed — network error');
    } finally {
      setTradierSyncing(false);
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 6000);
    }
  }

  return {
    closeDrawer, setCloseDrawer, closeDrawerRef, closeDrawerCancel, submitCloseDrawer,
    openCloseDrawer, cancelPendingExit, cancellingExits, closingOptions,
    syncTradierPositions, tradierSyncing, tradierSyncStatus,
  };
}
