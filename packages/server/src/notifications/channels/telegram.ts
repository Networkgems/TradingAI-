// TRA-566 (TRA-410 A2) — Telegram channel adapter.
//
// Delivers via the Bot API `sendMessage` method using ONE shared bot token per
// deployment (`TELEGRAM_BOT_TOKEN`, §1.3). Each user links their personal chat
// via the `/start <token>` flow (see telegram-link.ts), which records their
// `chat_id` into `prefs.channels.telegram.telegramChatId`. The adapter is inert
// until both the deployment token and the user's chat id exist.

import type { AlertChannel, AlertPreferences } from '@trading-app/shared';
import type { AlertEvent, ChannelAdapter } from '../dispatcher.js';
import { renderAlert } from '../renderer.js';

export interface TelegramAdapterDeps {
  /** Shared bot token. Defaults to `process.env.TELEGRAM_BOT_TOKEN`. */
  botToken?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => number;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channel: AlertChannel = 'telegram';

  private readonly botToken: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(deps: TelegramAdapterDeps = {}) {
    this.botToken = deps.botToken ?? process.env['TELEGRAM_BOT_TOKEN'] ?? undefined;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Usable once a deployment bot token exists AND the user linked a chat. */
  isConfigured(prefs: AlertPreferences): boolean {
    return Boolean(this.botToken) && Boolean(prefs.channels.telegram.telegramChatId);
  }

  async send(event: AlertEvent, prefs: AlertPreferences): Promise<void> {
    const chatId = prefs.channels.telegram.telegramChatId;
    if (!this.botToken) throw new Error('TELEGRAM_BOT_TOKEN not configured');
    if (!chatId) throw new Error(`no telegram chat linked for user ${event.username}`);

    const msg = renderAlert(event, this.now());
    const res = await this.fetchFn(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The renderer's HTML is also valid Telegram HTML (div/span are stripped
        // by Telegram; bold/escaped text survives). Sending the plain text with
        // HTML parse mode keeps it readable while honoring entity escaping.
        body: JSON.stringify({
          chat_id: chatId,
          text: msg.text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const detail = await safeBody(res);
      throw new Error(`telegram sendMessage failed: ${res.status} ${detail}`);
    }
  }
}

async function safeBody(res: { text?: () => Promise<string> }): Promise<string> {
  try {
    const t = await res.text?.();
    return (t ?? '').slice(0, 200);
  } catch {
    return '';
  }
}
