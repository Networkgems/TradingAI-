// TRA-566 (TRA-410 A2) — Discord channel adapter.
//
// Simplest channel (§1.3): the user pastes an incoming-webhook URL into their
// prefs and the adapter POSTs the rendered text as the message `content`. No
// account linking, no shared deployment secret. Inert until the webhook is set.

import type { AlertChannel, AlertPreferences } from '@trading-app/shared';
import type { AlertEvent, ChannelAdapter } from '../dispatcher.js';
import { renderAlert } from '../renderer.js';

/** Discord caps webhook `content` at 2000 chars. */
const DISCORD_CONTENT_LIMIT = 2000;

export interface DiscordAdapterDeps {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => number;
}

/** Accept only well-formed Discord webhook URLs (defense against SSRF/typos). */
export function isValidDiscordWebhook(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'discord.com' || u.hostname === 'discordapp.com' || u.hostname.endsWith('.discord.com')) &&
      u.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly channel: AlertChannel = 'discord';

  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(deps: DiscordAdapterDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Usable once a valid incoming-webhook URL is present. */
  isConfigured(prefs: AlertPreferences): boolean {
    return isValidDiscordWebhook(prefs.channels.discord.discordWebhookUrl);
  }

  async send(event: AlertEvent, prefs: AlertPreferences): Promise<void> {
    const url = prefs.channels.discord.discordWebhookUrl;
    if (!isValidDiscordWebhook(url)) {
      throw new Error(`invalid discord webhook for user ${event.username}`);
    }
    const msg = renderAlert(event, this.now());
    const content = msg.text.slice(0, DISCORD_CONTENT_LIMIT);
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error(`discord webhook failed: ${res.status}`);
    }
  }
}
