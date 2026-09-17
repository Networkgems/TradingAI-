// TRA-419 — AccountModeSwitcher component extracted from App.tsx.
import { useState } from 'react';
import { useToast } from '../lib/toast.tsx';
import { logger } from '../lib/logger';
import { HTTP_URL } from '../server-url';

type AccountMode = 'demo' | 'live';

function isAccountMode(v: unknown): v is AccountMode {
  return v === 'demo' || v === 'live';
}

/**
 * TRA-3809 — the mode the SERVER actually ended up in, read off the 200 body,
 * or `null` when the response does not tell us.
 *
 * `PUT /api/account/settings` answers `{ ok, settings, missingLiveCredentials }`
 * where `settings` is the POST-repair object: the TRA-2649 write-path arm
 * (`applyLiveBrokerArm`, server `index.ts`) runs BEFORE the persist, so for the
 * pinned operator a body of `{mode:'demo'}` is re-converged and `settings.mode`
 * comes back `'live'`. The client has the ground truth in its hand.
 *
 * `null` is deliberately DISTINCT from "the switch failed" and from "the switch
 * worked". A body we cannot parse means we did not observe the outcome, and the
 * entire point of this ticket is that the UI must stop asserting a real-money
 * account state it never verified. Callers must render the unknown case as
 * unknown rather than collapsing it into either verdict.
 */
async function readAppliedMode(r: Response): Promise<AccountMode | null> {
  try {
    const body = (await r.json()) as { settings?: { mode?: unknown } } | null;
    const m = body?.settings?.mode;
    return isAccountMode(m) ? m : null;
  } catch {
    // Non-JSON / already-consumed body — unknown, not "fine".
    return null;
  }
}

/**
 * TRA-3910 — the view route's 200 body. `bookView` is what the dashboard will
 * render from the next frame; `mode` is the routing mode, which this route can
 * never change (it 400s on any body key but `viewMode`).
 */
async function readViewResult(r: Response): Promise<{ bookView: AccountMode; mode: AccountMode } | null> {
  try {
    const body = (await r.json()) as { bookView?: unknown; mode?: unknown } | null;
    return isAccountMode(body?.bookView) && isAccountMode(body?.mode)
      ? { bookView: body.bookView, mode: body.mode }
      : null;
  } catch {
    return null;
  }
}

export function AccountModeSwitcher({
  mode,
  engineMode,
  liveBrokerArmPinned = false,
  onChange,
  market,
  token,
}: {
  /** The BOOK currently shown. */
  mode: AccountMode;
  /** TRA-3910 — the engine's ROUTING mode; defaults to `mode` (no override). */
  engineMode?: AccountMode;
  /**
   * TRA-3910 — when true this user's `mode` is held on the live arm by the
   * server (`GET /api/account/settings` → `liveBrokerArmPinned`), so a press is
   * sent to `PUT /api/account/view-mode` — a pure VIEW change that never writes
   * `mode`, is never clamped, and leaves no `bootArmRepairLedger` row. The live
   * routing is untouched either way; the header banner says so.
   */
  liveBrokerArmPinned?: boolean;
  onChange: (mode: AccountMode) => void;
  market: 'stocks';
  token: string;
}) {
  const [busy, setBusy] = useState(false);
  // TRA-3809 — the mode the server clamped us BACK to, once we have actually
  // observed a clamp. Derived only from an observed response, never guessed
  // from an env/pin lookup the client does not have; so it starts null and the
  // annotation only ever appears after the toggle has been proven inert here.
  const [clampedTo, setClampedTo] = useState<AccountMode | null>(null);
  const toast = useToast();

  async function switchViewTo(next: AccountMode) {
    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/account/view-mode`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewMode: next }),
      });
      if (!r.ok) {
        logger.warn('account-mode', `view switch to ${next} returned HTTP ${r.status}`);
        toast.error(`Could not switch the view to the ${next === 'live' ? 'Live' : 'Demo'} book — HTTP ${r.status}`);
        return;
      }
      const applied = await readViewResult(r);
      if (applied === null) {
        logger.warn('account-mode', `view switch to ${next} returned 200 but no bookView — outcome unverified`);
        toast.info('Sent the view switch, but the server did not report which book it will show. Reload to confirm.');
        return;
      }
      setClampedTo(null);
      onChange(applied.bookView);
      toast.success(
        `Viewing the ${applied.bookView === 'live' ? 'Live' : 'Demo'} book`
        + (applied.bookView !== applied.mode
          ? ` — the engine is still routing to the ${applied.mode.toUpperCase()} account; nothing was disarmed.`
          : '.'),
      );
    } catch (err) {
      logger.error('account-mode', `failed to switch the view to ${next}`, err);
      toast.error(`Could not switch the view to ${next} — network error`);
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(next: AccountMode) {
    if (next === mode || busy) return;
    // TRA-3910 — the pinned live operator: change what is SHOWN, never what is
    // ARMED. No `mode` write ⇒ no TRA-2649 clamp, no repair-ledger row.
    if (liveBrokerArmPinned) {
      await switchViewTo(next);
      return;
    }
    if (next === 'live') {
      const ackKey = `liveModeAcknowledged_${market}`;
      const alreadyAcknowledged = localStorage.getItem(ackKey) === 'true';
      if (!alreadyAcknowledged) {
        const ok = window.confirm(
          'Switch Stocks dashboard to LIVE account?\n\n' +
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
        // TRA-3809 — report the mode the SERVER is in, never the one we asked
        // for. `r.ok` only means the write was accepted; it does NOT mean the
        // requested mode was applied. For the operator pinned by
        // `LIVE_EQUITY_BOOT_USER`, the TRA-2649 write-path arm re-converges a
        // `mode:'demo'` write back to `'live'` and still answers 200, so the
        // old `onChange(next)` + "Switched to Demo account" told an operator
        // that a REAL-MONEY arm had been stood down while it kept placing live
        // orders. First observed in anger on bqb1 2026-08-16T18:42:20Z
        // (`bootArmWriteRepairs` 0 -> 1, `repaired:["mode"]`,
        // `bodyFields:["mode"]` — this component's own payload shape).
        const applied = await readAppliedMode(r);
        if (applied === null) {
          // We did not observe the outcome. Do not claim one — and do not move
          // the parent's mode to a value we never saw confirmed.
          logger.warn(
            'account-mode',
            `switch to ${next} returned 200 but no settings.mode — outcome unverified`,
          );
          toast.info(
            `Sent the switch to ${next === 'live' ? 'Live' : 'Demo'} account, but the server did not `
            + 'report the resulting mode. Reload to see which account is actually active before trading.',
          );
        } else if (applied !== next) {
          // The server clamped us. Say so, and name the lever that actually works.
          setClampedTo(applied);
          onChange(applied);
          logger.warn(
            'account-mode',
            `server clamped the switch to ${next}: account is still ${applied}`,
          );
          toast.error(
            `Account is STILL ${applied === 'live' ? 'LIVE' : 'DEMO'} — the switch to `
            + `${next === 'live' ? 'Live' : 'Demo'} was not applied. This operator is pinned to the `
            + 'ratified live-broker arm, so the account toggle cannot stand it down. The supported '
            + 'de-escalation is clearing the LIVE_EQUITY_BOOT_USER service env var and redeploying.',
          );
        } else {
          setClampedTo(null);
          onChange(applied);
          toast.success(`Switched to ${applied === 'live' ? 'Live' : 'Demo'} account`);
        }
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

  // TRA-3809 (c) — annotate, do NOT disable, the side the server has been seen
  // to refuse. Disabling would strand the operator on a stale observation: if
  // the pin is later cleared the toggle would stay dead until a reload, and
  // this is the control someone reaches for when they are trying to get OUT of
  // a live arm. An honest label beats a dead button.
  const routing: AccountMode = engineMode ?? mode;
  const clampNote = (side: AccountMode) =>
    liveBrokerArmPinned
      ? ` — VIEW only: the engine keeps routing to the ${routing.toUpperCase()} account (pinned live-broker arm)`
      : clampedTo !== null && clampedTo !== side
      ? ` — the server refused this switch and held the account on ${clampedTo === 'live' ? 'LIVE' : 'DEMO'};`
        + ' clear LIVE_EQUITY_BOOT_USER on the service to de-escalate'
      : '';

  return (
    <div className={`account-mode-switch${busy ? ' busy' : ''}`} role="group" aria-label="Account mode">
      <button
        type="button"
        className={`account-mode-option demo${mode === 'demo' ? ' active' : ''}`}
        onClick={() => switchTo('demo')}
        disabled={busy}
        aria-pressed={mode === 'demo'}
        data-clamped={clampedTo !== null && clampedTo !== 'demo' ? 'true' : undefined}
        title={`Use the demo (paper) account${clampNote('demo')}`}
      >
        Demo
      </button>
      <button
        type="button"
        className={`account-mode-option live${mode === 'live' ? ' active' : ''}`}
        onClick={() => switchTo('live')}
        disabled={busy}
        aria-pressed={mode === 'live'}
        data-clamped={clampedTo !== null && clampedTo !== 'live' ? 'true' : undefined}
        title={`Use the live brokerage account${clampNote('live')}`}
      >
        Live
      </button>
    </div>
  );
}
