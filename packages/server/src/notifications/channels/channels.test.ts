import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_ALERT_PREFERENCES, resolveAlertPreferences } from '@trading-app/shared';
import type { AlertPreferences } from '@trading-app/shared';
import { EmailChannelAdapter } from './email.js';
import { TelegramChannelAdapter } from './telegram.js';
import { DiscordChannelAdapter, isValidDiscordWebhook } from './discord.js';
import type { ExitAlertEvent } from '../dispatcher.js';

process.env['LOG_NO_FILE'] = '1';

const TS = Date.parse('2026-05-17T18:32:00Z');

const exitEvent: ExitAlertEvent = {
  kind: 'exit',
  username: 'alice',
  timestamp: TS,
  symbol: 'ETH-USD',
  market: 'crypto',
  mode: 'live',
  exitReason: 'take-profit',
  pnl: 84.2,
  pnlR: 1.32,
  strategy: 'mean-reversion',
};

function prefsWith(over: (p: AlertPreferences) => void): AlertPreferences {
  const p = resolveAlertPreferences({ alertPreferences: DEFAULT_ALERT_PREFERENCES });
  over(p);
  return p;
}

function okResponse(): Response {
  return { ok: true, status: 200, text: async () => '' } as unknown as Response;
}
function errResponse(status: number): Response {
  return { ok: false, status, text: async () => 'nope' } as unknown as Response;
}

describe('EmailChannelAdapter', () => {
  it('is configured only when SMTP is available', () => {
    const on = new EmailChannelAdapter({ smtpConfigured: () => true });
    const off = new EmailChannelAdapter({ smtpConfigured: () => false });
    const p = prefsWith(() => {});
    expect(on.isConfigured(p)).toBe(true);
    expect(off.isConfigured(p)).toBe(false);
  });

  it('prefers the per-channel override address, else the login email', () => {
    const a = new EmailChannelAdapter({ resolveLoginEmail: () => 'login@x.com' });
    const withOverride = prefsWith((p) => {
      p.channels.email.emailAddress = 'override@x.com';
    });
    const noOverride = prefsWith(() => {});
    expect(a.resolveAddress('alice', withOverride)).toBe('override@x.com');
    expect(a.resolveAddress('alice', noOverride)).toBe('login@x.com');
  });

  it('sends a rendered message to the resolved address', async () => {
    const sendMail = vi.fn(async () => {});
    const a = new EmailChannelAdapter({
      sendMail,
      resolveLoginEmail: () => 'login@x.com',
      now: () => TS,
    });
    await a.send(exitEvent, prefsWith(() => {}));
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0];
    expect(arg.to).toBe('login@x.com');
    expect(arg.subject).toContain('Position Exited');
    expect(arg.html).toContain('ETH-USD');
    expect(arg.text).toContain('P&L: +$84.20');
  });

  it('throws when no address can be resolved', async () => {
    const a = new EmailChannelAdapter({ sendMail: async () => {}, resolveLoginEmail: () => undefined });
    await expect(a.send(exitEvent, prefsWith(() => {}))).rejects.toThrow(/no email address/);
  });
});

describe('TelegramChannelAdapter', () => {
  it('is configured only with a bot token AND a linked chat id', () => {
    const withTok = new TelegramChannelAdapter({ botToken: 'T' });
    const noTok = new TelegramChannelAdapter({ botToken: undefined });
    const linked = prefsWith((p) => {
      p.channels.telegram.telegramChatId = '123';
    });
    const unlinked = prefsWith(() => {});
    expect(withTok.isConfigured(linked)).toBe(true);
    expect(withTok.isConfigured(unlinked)).toBe(false);
    expect(noTok.isConfigured(linked)).toBe(false);
  });

  it('POSTs sendMessage with the chat id and rendered text', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const a = new TelegramChannelAdapter({ botToken: 'BOTTOK', fetchFn, now: () => TS });
    const prefs = prefsWith((p) => {
      p.channels.telegram.telegramChatId = '999';
    });
    await a.send(exitEvent, prefs);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain('/botBOTTOK/sendMessage');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe('999');
    expect(body.text).toContain('Position Exited');
  });

  it('throws on a non-OK Telegram response', async () => {
    const a = new TelegramChannelAdapter({
      botToken: 'T',
      fetchFn: vi.fn(async () => errResponse(400)),
    });
    const prefs = prefsWith((p) => {
      p.channels.telegram.telegramChatId = '1';
    });
    await expect(a.send(exitEvent, prefs)).rejects.toThrow(/telegram sendMessage failed: 400/);
  });
});

describe('DiscordChannelAdapter', () => {
  const goodUrl = 'https://discord.com/api/webhooks/123/abc';

  it('validates webhook URLs', () => {
    expect(isValidDiscordWebhook(goodUrl)).toBe(true);
    expect(isValidDiscordWebhook('https://discordapp.com/api/webhooks/1/x')).toBe(true);
    expect(isValidDiscordWebhook('http://discord.com/api/webhooks/1/x')).toBe(false); // not https
    expect(isValidDiscordWebhook('https://evil.com/api/webhooks/1/x')).toBe(false);
    expect(isValidDiscordWebhook('https://discord.com/channels/1')).toBe(false); // wrong path
    expect(isValidDiscordWebhook(undefined)).toBe(false);
    expect(isValidDiscordWebhook('not a url')).toBe(false);
  });

  it('is configured only with a valid webhook', () => {
    const a = new DiscordChannelAdapter();
    expect(a.isConfigured(prefsWith((p) => { p.channels.discord.discordWebhookUrl = goodUrl; }))).toBe(true);
    expect(a.isConfigured(prefsWith((p) => { p.channels.discord.discordWebhookUrl = 'bad'; }))).toBe(false);
  });

  it('POSTs the rendered text as webhook content', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const a = new DiscordChannelAdapter({ fetchFn, now: () => TS });
    const prefs = prefsWith((p) => { p.channels.discord.discordWebhookUrl = goodUrl; });
    await a.send(exitEvent, prefs);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(goodUrl);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.content).toContain('Position Exited');
  });

  it('throws on invalid webhook at send time', async () => {
    const a = new DiscordChannelAdapter({ fetchFn: vi.fn(async () => okResponse()) });
    const prefs = prefsWith((p) => { p.channels.discord.discordWebhookUrl = 'bad'; });
    await expect(a.send(exitEvent, prefs)).rejects.toThrow(/invalid discord webhook/);
  });

  it('throws on a non-OK Discord response', async () => {
    const a = new DiscordChannelAdapter({ fetchFn: vi.fn(async () => errResponse(429)) });
    const prefs = prefsWith((p) => { p.channels.discord.discordWebhookUrl = goodUrl; });
    await expect(a.send(exitEvent, prefs)).rejects.toThrow(/discord webhook failed: 429/);
  });
});
