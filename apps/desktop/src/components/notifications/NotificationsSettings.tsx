// TRA-567 (TRA-410 A3) — Settings → Notifications.
//
// Standalone component (design §6: NOT added to the App.tsx monolith) that
// drives the A2 notification surface:
//   • channel toggles (Email / Telegram / Discord) + per-channel config and a
//     Send-test button that fires through ONE adapter;
//   • the Telegram /start-token link flow;
//   • the per-event × per-channel routing matrix (order filled / position
//     exited / new signal / risk-halt). risk-halt defaults ON for every channel
//     and bypasses quiet hours + digest on the server (TRA-563/566);
//   • quiet hours window + signal digest mode.
//
// Reads the resolved prefs from GET /api/account/settings (so a pre-A1 snapshot
// still renders defaults via the shared resolver) and persists the full,
// resolved object with PUT /api/account/notifications, which deep-merges +
// validates server-side.
import { useCallback, useEffect, useState } from 'react';
import { logger } from '../../lib/logger';
import type {
  AlertChannel,
  AlertDigestMode,
  AlertEventClass,
  AlertPreferences,
} from '@trading-app/shared';
import {
  ALERT_CHANNELS,
  ALERT_EVENT_CLASSES,
  resolveAlertPreferences,
} from '@trading-app/shared';

const CHANNEL_LABELS: Record<AlertChannel, string> = {
  email: 'Email',
  telegram: 'Telegram',
  discord: 'Discord',
};

const EVENT_LABELS: Record<AlertEventClass, string> = {
  fill: 'Order filled',
  exit: 'Position exited',
  signal: 'New signal',
  risk_halt: 'Risk halt',
  briefing: 'Daily briefing',
  routine: 'Scheduled routine',
};

const DIGEST_OPTIONS: { value: AlertDigestMode; label: string }[] = [
  { value: 'immediate', label: 'Immediate' },
  { value: '15min', label: 'Batched every 15 min' },
  { value: 'hourly', label: 'Hourly digest' },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type TestState = 'idle' | 'sending' | 'sent' | 'error';

interface ChannelFeedback {
  state: TestState;
  message?: string;
}

const EMPTY_FEEDBACK: Record<AlertChannel, ChannelFeedback> = {
  email: { state: 'idle' },
  telegram: { state: 'idle' },
  discord: { state: 'idle' },
};

export function NotificationsSettings({ token, httpUrl }: { token: string; httpUrl: string }) {
  const [prefs, setPrefs] = useState<AlertPreferences | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [testFeedback, setTestFeedback] =
    useState<Record<AlertChannel, ChannelFeedback>>(EMPTY_FEEDBACK);
  const [tgLink, setTgLink] = useState<{ deepLink?: string; note: string } | null>(null);

  const authHeaders = useCallback(
    (json = false): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }),
    [token],
  );

  // Load + resolve the persisted prefs. The resolver back-fills every field, so
  // even an account that never touched notifications renders the §1.3 defaults.
  const reload = useCallback(() => {
    fetch(`${httpUrl}/api/account/settings`, { headers: authHeaders() })
      .then(r => r.json())
      .then((settings: { alertPreferences?: AlertPreferences } | null) => {
        setPrefs(resolveAlertPreferences(settings));
        setLoadError('');
      })
      .catch(err => {
        logger.warn('notifications: failed to load settings', err);
        setLoadError('Could not load notification preferences.');
      });
  }, [httpUrl, authHeaders]);

  useEffect(() => reload(), [reload]);

  // ── immutable prefs updates ────────────────────────────────────────────────
  function patchPrefs(mut: (p: AlertPreferences) => AlertPreferences) {
    setPrefs(prev => (prev ? mut(structuredClone(prev)) : prev));
    if (saveState === 'saved') setSaveState('idle');
  }

  const setChannelEnabled = (ch: AlertChannel, enabled: boolean) =>
    patchPrefs(p => {
      p.channels[ch].enabled = enabled;
      return p;
    });

  const setChannelField = (ch: AlertChannel, field: 'emailAddress' | 'discordWebhookUrl', v: string) =>
    patchPrefs(p => {
      p.channels[ch][field] = v;
      return p;
    });

  const toggleMatrix = (ev: AlertEventClass, ch: AlertChannel, on: boolean) =>
    patchPrefs(p => {
      p.events[ev][ch] = on;
      return p;
    });

  const setQuiet = (mut: (q: AlertPreferences['quietHours']) => void) =>
    patchPrefs(p => {
      mut(p.quietHours);
      return p;
    });

  const setDigest = (mode: AlertDigestMode) =>
    patchPrefs(p => {
      p.signalDigest = mode;
      return p;
    });

  // ── persistence ────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!prefs) return;
    setSaveState('saving');
    setSaveError('');
    try {
      const r = await fetch(`${httpUrl}/api/account/notifications`, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify(prefs),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; alertPreferences?: AlertPreferences };
      if (r.ok && data.ok && data.alertPreferences) {
        setPrefs(data.alertPreferences);
        setSaveState('saved');
      } else {
        setSaveError(data.error ?? 'Failed to save notification preferences.');
        setSaveState('error');
      }
    } catch {
      setSaveError('Cannot reach server.');
      setSaveState('error');
    }
  }

  // ── test send ──────────────────────────────────────────────────────────────
  async function handleTest(ch: AlertChannel) {
    setTestFeedback(prev => ({ ...prev, [ch]: { state: 'sending' } }));
    try {
      const r = await fetch(`${httpUrl}/api/notifications/test`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ channel: ch }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string; code?: string };
      if (r.ok && data.ok) {
        setTestFeedback(prev => ({ ...prev, [ch]: { state: 'sent', message: 'Test sent — check the channel.' } }));
      } else {
        setTestFeedback(prev => ({
          ...prev,
          [ch]: { state: 'error', message: data.error ?? 'Test send failed.' },
        }));
      }
    } catch {
      setTestFeedback(prev => ({ ...prev, [ch]: { state: 'error', message: 'Cannot reach server.' } }));
    }
  }

  // ── Telegram link flow ─────────────────────────────────────────────────────
  async function handleTelegramLink() {
    setTgLink(null);
    try {
      const r = await fetch(`${httpUrl}/api/notifications/telegram/link`, {
        method: 'POST',
        headers: authHeaders(true),
        body: '{}',
      });
      const data = (await r.json()) as { ok?: boolean; deepLink?: string; error?: string };
      if (r.ok && data.ok) {
        if (data.deepLink) {
          window.open(data.deepLink, '_blank', 'noopener');
          setTgLink({
            deepLink: data.deepLink,
            note: 'Opened Telegram — tap Start in the chat, then Refresh status below.',
          });
        } else {
          setTgLink({ note: 'Link token issued, but no bot username is configured on this deployment.' });
        }
      } else {
        setTgLink({ note: data.error ?? 'Telegram is not enabled on this deployment.' });
      }
    } catch {
      setTgLink({ note: 'Cannot reach server.' });
    }
  }

  if (loadError) {
    return (
      <section className="settings-section">
        <h2 className="settings-section-title">Notifications</h2>
        <p className="save-error">{loadError}</p>
        <button type="button" className="btn-secondary" onClick={reload}>
          Retry
        </button>
      </section>
    );
  }
  if (!prefs) {
    return (
      <section className="settings-section">
        <h2 className="settings-section-title">Notifications</h2>
        <p className="settings-hint">Loading…</p>
      </section>
    );
  }

  return (
    <section className="settings-section" data-testid="notifications-settings">
      <h2 className="settings-section-title">Notifications</h2>
      <p className="settings-hint">
        Choose how the trading engine reaches you. Risk-halt alerts are on for every channel by
        default and always bypass quiet hours.
      </p>

      {/* ── Channels ─────────────────────────────────────────────────────── */}
      <div className="notif-channels">
        {ALERT_CHANNELS.map(ch => {
          const cfg = prefs.channels[ch];
          const fb = testFeedback[ch];
          return (
            <div className="notif-channel-card" key={ch}>
              <div className="notif-channel-head">
                <label className="notif-channel-toggle">
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={e => setChannelEnabled(ch, e.target.checked)}
                    aria-label={`Enable ${CHANNEL_LABELS[ch]}`}
                  />
                  <span className="notif-channel-name">{CHANNEL_LABELS[ch]}</span>
                </label>
                <button
                  type="button"
                  className="btn-secondary notif-test-btn"
                  onClick={() => handleTest(ch)}
                  disabled={fb.state === 'sending'}
                >
                  {fb.state === 'sending' ? 'Sending…' : 'Send test'}
                </button>
              </div>

              {ch === 'email' && (
                <div className="settings-field">
                  <label>Email address</label>
                  <input
                    type="email"
                    value={cfg.emailAddress ?? ''}
                    placeholder="Falls back to your account email"
                    onChange={e => setChannelField('email', 'emailAddress', e.target.value)}
                  />
                </div>
              )}

              {ch === 'discord' && (
                <div className="settings-field">
                  <label>Webhook URL</label>
                  <input
                    type="url"
                    value={cfg.discordWebhookUrl ?? ''}
                    placeholder="https://discord.com/api/webhooks/…"
                    onChange={e => setChannelField('discord', 'discordWebhookUrl', e.target.value)}
                  />
                  <span className="field-hint">
                    Server Settings → Integrations → Webhooks → copy the URL.
                  </span>
                </div>
              )}

              {ch === 'telegram' && (
                <div className="notif-telegram">
                  {cfg.telegramChatId ? (
                    <p className="field-hint">
                      Linked to chat <code>{cfg.telegramChatId}</code>.
                    </p>
                  ) : (
                    <p className="field-hint">Not linked yet.</p>
                  )}
                  <div className="settings-actions-row">
                    <button type="button" className="btn-secondary" onClick={handleTelegramLink}>
                      {cfg.telegramChatId ? 'Re-link Telegram' : 'Link Telegram'}
                    </button>
                    <button type="button" className="btn-secondary" onClick={reload}>
                      Refresh status
                    </button>
                  </div>
                  {tgLink && (
                    <p className="field-hint" style={{ marginTop: '0.4rem' }}>
                      {tgLink.note}
                      {tgLink.deepLink && (
                        <>
                          {' '}
                          <a href={tgLink.deepLink} target="_blank" rel="noopener noreferrer">
                            Open link
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}

              {fb.message && (
                <p className={fb.state === 'error' ? 'save-error' : 'save-success'}>{fb.message}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Event routing matrix ─────────────────────────────────────────── */}
      <h3 className="notif-subhead">Alert me when…</h3>
      <div className="user-table-wrap">
        <table className="user-table notif-matrix">
          <thead>
            <tr>
              <th>Event</th>
              {ALERT_CHANNELS.map(ch => (
                <th key={ch}>{CHANNEL_LABELS[ch]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALERT_EVENT_CLASSES.map(ev => (
              <tr key={ev}>
                <td>{EVENT_LABELS[ev]}</td>
                {ALERT_CHANNELS.map(ch => (
                  <td key={ch} className="notif-matrix-cell">
                    <input
                      type="checkbox"
                      checked={prefs.events[ev][ch]}
                      onChange={e => toggleMatrix(ev, ch, e.target.checked)}
                      aria-label={`${EVENT_LABELS[ev]} via ${CHANNEL_LABELS[ch]}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Quiet hours + digest ─────────────────────────────────────────── */}
      <h3 className="notif-subhead">Quiet hours &amp; digest</h3>
      <label className="notif-channel-toggle" style={{ marginBottom: '0.75rem' }}>
        <input
          type="checkbox"
          checked={prefs.quietHours.enabled}
          onChange={e => setQuiet(q => void (q.enabled = e.target.checked))}
        />
        <span>Mute non-critical alerts during quiet hours</span>
      </label>
      <div className="settings-grid">
        <div className="settings-field">
          <label>Start</label>
          <input
            type="time"
            value={prefs.quietHours.start}
            disabled={!prefs.quietHours.enabled}
            onChange={e => setQuiet(q => void (q.start = e.target.value))}
          />
        </div>
        <div className="settings-field">
          <label>End</label>
          <input
            type="time"
            value={prefs.quietHours.end}
            disabled={!prefs.quietHours.enabled}
            onChange={e => setQuiet(q => void (q.end = e.target.value))}
          />
        </div>
        <div className="settings-field">
          <label>Timezone</label>
          <input
            type="text"
            value={prefs.quietHours.timezone}
            disabled={!prefs.quietHours.enabled}
            placeholder="America/New_York"
            onChange={e => setQuiet(q => void (q.timezone = e.target.value))}
          />
          <span className="field-hint">IANA name. Risk-halt alerts ignore this window.</span>
        </div>
        <div className="settings-field">
          <label>New-signal digest</label>
          <select value={prefs.signalDigest} onChange={e => setDigest(e.target.value as AlertDigestMode)}>
            {DIGEST_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="field-hint">Batches the high-frequency signal alerts only.</span>
        </div>
      </div>

      {/* ── Save ──────────────────────────────────────────────────────────── */}
      <div className="settings-footer" style={{ marginTop: '1.25rem' }}>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : 'Save Notifications'}
        </button>
        {saveState === 'saved' && <span className="save-success">Saved.</span>}
        {saveState === 'error' && <span className="save-error">{saveError}</span>}
      </div>
    </section>
  );
}
