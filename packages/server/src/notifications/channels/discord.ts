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

/**
 * TRA-4303 — marker appended when the render does not fit.
 *
 * The `slice(0, 2000)` below is correct but was SILENT: an over-length morning
 * brief arrived on Discord looking complete, just missing however many trailing
 * sections fell off the end — and the section most likely to be cut is the last
 * one (overnight news), which reads identically to "there was no news".
 *
 * Measured against the compiled renderer on a maximally-loaded brief (8
 * overnight rows + 8 signals + 6 positions + 6 news, ~75-char headlines): 1,895
 * chars, of which this ticket's new section is 305. The headroom was already
 * thin before this change (1,590) and realistic headlines close the rest of it,
 * so the pre-existing truncation is now reachable in normal use. Making it
 * VISIBLE is the fix that belongs at this layer; email and Telegram have no
 * such cap (Telegram's is 4096 and the brief is nowhere near it).
 */
const DISCORD_TRUNCATION_MARKER = '\n… (truncated — Discord 2000-char limit; see the email brief)';

/**
 * Trim a rendered body to Discord's `content` ceiling, saying so when it had to.
 * Exported for the unit test. Pure.
 */
export function fitDiscordContent(text: string, limit = DISCORD_CONTENT_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - DISCORD_TRUNCATION_MARKER.length)) + DISCORD_TRUNCATION_MARKER;
}

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
    const content = fitDiscordContent(msg.text);
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
