import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_ALERT_PREFERENCES,
  type AccountSettings,
  type AlertChannel,
  type AlertPreferences,
} from '@trading-app/shared';
import {
  NotificationDispatcher,
  type AlertEvent,
  type ChannelAdapter,
} from './dispatcher.js';

// Quiet the file sink during the suite (logger writes are harmless but noisy).
process.env['LOG_NO_FILE'] = '1';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Adapter that records every event it is asked to send. */
class RecordingAdapter implements ChannelAdapter {
  readonly sent: AlertEvent[] = [];
  constructor(
    readonly channel: AlertChannel,
    private readonly configured = true,
    private readonly behaviour: 'ok' | 'throw' | 'hang' = 'ok',
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async send(event: AlertEvent): Promise<void> {
    if (this.behaviour === 'throw') throw new Error('boom');
    if (this.behaviour === 'hang') return new Promise<void>(() => {}); // never resolves
    this.sent.push(event);
  }
}

/** Build prefs with all channels enabled+configured and a full-true matrix. */
function allOnPrefs(overrides: Partial<AlertPreferences> = {}): AlertPreferences {
  const base = structuredClone(DEFAULT_ALERT_PREFERENCES);
  for (const ch of ['email', 'telegram', 'discord'] as AlertChannel[]) {
    base.channels[ch].enabled = true;
  }
  for (const ev of Object.keys(base.events) as (keyof typeof base.events)[]) {
    base.events[ev] = { email: true, telegram: true, discord: true };
  }
  return { ...base, ...overrides };
}

function settingsWith(prefs: AlertPreferences): AccountSettings {
  return { alertPreferences: prefs } as AccountSettings;
}

const fillEvent = (over: Partial<AlertEvent> = {}): AlertEvent =>
  ({
    kind: 'fill',
    username: 'alice',
    symbol: 'ETH-USD',
    market: 'crypto',
    mode: 'demo',
    side: 'buy',
    quantity: 1,
    price: 100,
    positionId: 'pos-1',
    ...over,
  }) as AlertEvent;

describe('NotificationDispatcher — TRA-563', () => {
  let prefs: AlertPreferences;
  let dispatcher: NotificationDispatcher;
  let email: RecordingAdapter;
  let discord: RecordingAdapter;

  function build(opts: Partial<ConstructorParameters<typeof NotificationDispatcher>[0]> = {}) {
    dispatcher = new NotificationDispatcher({
      loadSettings: () => settingsWith(prefs),
      now: () => 1_000,
      // Capture the flush callback instead of using a real timer.
      scheduleFlush: () => {},
      ...opts,
    });
    email = new RecordingAdapter('email');
    discord = new RecordingAdapter('discord');
    dispatcher.registerAdapter(email);
    dispatcher.registerAdapter(discord);
  }

  beforeEach(() => {
    prefs = allOnPrefs();
  });

  it('routes an event only to enabled+configured channels in the matrix', async () => {
    prefs = allOnPrefs();
    prefs.channels.discord.enabled = false; // toggled off
    build();
    dispatcher.emit(fillEvent());
    await tick();
    expect(email.sent).toHaveLength(1);
    expect(discord.sent).toHaveLength(0);
  });

  it('skips a channel that is enabled but not configured', async () => {
    prefs = allOnPrefs();
    build();
    // Replace discord with an unconfigured adapter.
    dispatcher.registerAdapter(new RecordingAdapter('discord', /* configured */ false));
    dispatcher.emit(fillEvent());
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('does not route an event class whose matrix cell is false', async () => {
    prefs = allOnPrefs();
    prefs.events.fill.email = false;
    prefs.events.fill.discord = false;
    build();
    dispatcher.emit(fillEvent());
    await tick();
    expect(email.sent).toHaveLength(0);
    expect(discord.sent).toHaveLength(0);
  });

  it('isolates a throwing channel — siblings still deliver', async () => {
    prefs = allOnPrefs();
    build();
    dispatcher.registerAdapter(new RecordingAdapter('discord', true, 'throw'));
    // Should not reject / throw.
    dispatcher.emit(fillEvent());
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('bounds a hanging channel by timeout without blocking others', async () => {
    prefs = allOnPrefs();
    dispatcher = new NotificationDispatcher({
      loadSettings: () => settingsWith(prefs),
      now: () => 1_000,
      sendTimeoutMs: 15,
    });
    email = new RecordingAdapter('email');
    dispatcher.registerAdapter(email);
    dispatcher.registerAdapter(new RecordingAdapter('discord', true, 'hang'));
    dispatcher.emit(fillEvent());
    await new Promise((r) => setTimeout(r, 40)); // past the 15ms timeout
    expect(email.sent).toHaveLength(1); // sibling delivered despite the hang
  });

  it('dedups identical events inside the TTL window', async () => {
    prefs = allOnPrefs();
    build({ dedupTtlMs: 60_000 });
    dispatcher.emit(fillEvent());
    dispatcher.emit(fillEvent()); // same positionId → same dedup key
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('does not dedup distinct events', async () => {
    prefs = allOnPrefs();
    build();
    dispatcher.emit(fillEvent({ positionId: 'pos-1' }));
    dispatcher.emit(fillEvent({ positionId: 'pos-2' }));
    await tick();
    expect(email.sent).toHaveLength(2);
  });

  it('suppresses non-critical alerts during quiet hours', async () => {
    prefs = allOnPrefs({
      quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'America/New_York' },
    });
    // 2026-06-03T03:00:00Z == 23:00 EDT — inside the 22:00–07:00 window.
    const ts = Date.parse('2026-06-03T03:00:00Z');
    build();
    dispatcher.emit(fillEvent({ timestamp: ts }));
    await tick();
    expect(email.sent).toHaveLength(0);
  });

  it('risk_halt bypasses quiet hours (safety-critical)', async () => {
    prefs = allOnPrefs({
      quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'America/New_York' },
    });
    const ts = Date.parse('2026-06-03T03:00:00Z');
    build();
    dispatcher.emit({
      kind: 'risk_halt',
      username: 'alice',
      mode: 'live',
      reason: '3 consecutive losses',
      timestamp: ts,
    });
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('delivers outside the quiet window', async () => {
    prefs = allOnPrefs({
      quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'America/New_York' },
    });
    // 2026-06-03T17:00:00Z == 13:00 EDT — outside the window.
    const ts = Date.parse('2026-06-03T17:00:00Z');
    build();
    dispatcher.emit(fillEvent({ timestamp: ts }));
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('buffers signal alerts under a digest and delivers on flush', async () => {
    prefs = allOnPrefs({ signalDigest: '15min' });
    build();
    const signal: AlertEvent = {
      kind: 'signal',
      username: 'alice',
      symbol: 'AAPL',
      market: 'stocks',
      signalType: 'orb',
      side: 'buy',
    };
    dispatcher.emit(signal);
    await tick();
    expect(email.sent).toHaveLength(0); // buffered, not delivered
    expect(dispatcher.pendingDigestCount('alice')).toBe(1);

    await dispatcher.flushDigest('alice');
    await tick();
    expect(email.sent).toHaveLength(1);
    expect(dispatcher.pendingDigestCount('alice')).toBe(0);
  });

  it('delivers signals immediately when digest is immediate', async () => {
    prefs = allOnPrefs({ signalDigest: 'immediate' });
    build();
    dispatcher.emit({
      kind: 'signal',
      username: 'alice',
      symbol: 'AAPL',
      market: 'stocks',
      signalType: 'orb',
      side: 'buy',
    });
    await tick();
    expect(email.sent).toHaveLength(1);
  });

  it('drops events for unknown users (no settings)', async () => {
    dispatcher = new NotificationDispatcher({ loadSettings: () => undefined, now: () => 1_000 });
    email = new RecordingAdapter('email');
    dispatcher.registerAdapter(email);
    dispatcher.emit(fillEvent());
    await tick();
    expect(email.sent).toHaveLength(0);
  });
});
