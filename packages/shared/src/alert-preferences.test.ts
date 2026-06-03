import { describe, it, expect } from 'vitest';
import {
  ALERT_CHANNELS,
  ALERT_EVENT_CLASSES,
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_ALERT_PREFERENCES,
  resolveAlertPreferences,
} from './index.js';
import type { AlertPreferences } from './index.js';

// TRA-563 (TRA-410 A1) — lock the alert-preferences schema + resolver contract.
describe('resolveAlertPreferences — TRA-563', () => {
  it('returns defaults for absent / null prefs (back-compat with pre-563 snapshots)', () => {
    expect(resolveAlertPreferences(undefined)).toEqual(DEFAULT_ALERT_PREFERENCES);
    expect(resolveAlertPreferences(null)).toEqual(DEFAULT_ALERT_PREFERENCES);
    expect(resolveAlertPreferences({})).toEqual(DEFAULT_ALERT_PREFERENCES);
    expect(resolveAlertPreferences({ alertPreferences: undefined })).toEqual(
      DEFAULT_ALERT_PREFERENCES,
    );
  });

  it('returns a deep clone so callers cannot mutate the shared default', () => {
    const a = resolveAlertPreferences(undefined);
    a.channels.email.enabled = false;
    a.events.fill.discord = false;
    expect(DEFAULT_ALERT_PREFERENCES.channels.email.enabled).toBe(true);
    expect(DEFAULT_ALERT_PREFERENCES.events.fill.discord).toBe(true);
  });

  it('deep-merges a partial save over defaults', () => {
    const resolved = resolveAlertPreferences({
      alertPreferences: {
        channels: { discord: { enabled: true, discordWebhookUrl: 'https://x/y' } },
        signalDigest: 'hourly',
      } as Partial<AlertPreferences> as AlertPreferences,
    });
    // Saved field wins…
    expect(resolved.channels.discord).toEqual({
      enabled: true,
      discordWebhookUrl: 'https://x/y',
    });
    expect(resolved.signalDigest).toBe('hourly');
    // …everything unset falls back to defaults.
    expect(resolved.channels.email).toEqual(DEFAULT_ALERT_PREFERENCES.channels.email);
    expect(resolved.events).toEqual(DEFAULT_ALERT_PREFERENCES.events);
    expect(resolved.quietHours).toEqual(DEFAULT_ALERT_PREFERENCES.quietHours);
  });

  it('merges a partial event matrix row without dropping the other channels', () => {
    const resolved = resolveAlertPreferences({
      alertPreferences: {
        events: { signal: { email: true } },
      } as Partial<AlertPreferences> as AlertPreferences,
    });
    // Overridden cell + preserved siblings from the default signal row.
    expect(resolved.events.signal.email).toBe(true);
    expect(resolved.events.signal.discord).toBe(DEFAULT_ALERT_PREFERENCES.events.signal.discord);
    expect(resolved.events.signal.telegram).toBe(
      DEFAULT_ALERT_PREFERENCES.events.signal.telegram,
    );
    // Untouched rows are intact.
    expect(resolved.events.risk_halt).toEqual(DEFAULT_ALERT_PREFERENCES.events.risk_halt);
  });

  it('default matrix matches the §1.3 mockup: risk_halt on every channel', () => {
    for (const ch of ALERT_CHANNELS) {
      expect(DEFAULT_ALERT_PREFERENCES.events.risk_halt[ch]).toBe(true);
    }
    // Every event class has a cell for every channel.
    for (const ev of ALERT_EVENT_CLASSES) {
      for (const ch of ALERT_CHANNELS) {
        expect(typeof DEFAULT_ALERT_PREFERENCES.events[ev][ch]).toBe('boolean');
      }
    }
  });

  it('DEFAULT_ACCOUNT_SETTINGS carries the default alert preferences', () => {
    expect(DEFAULT_ACCOUNT_SETTINGS.alertPreferences).toEqual(DEFAULT_ALERT_PREFERENCES);
  });
});
