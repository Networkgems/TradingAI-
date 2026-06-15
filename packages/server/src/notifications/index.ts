// TRA-563 (TRA-410 A1) — notifications barrel.
// TRA-566 (TRA-410 A2) — channel adapters + shared renderer + link store added.
//
// The dispatcher core + event model, the shared event→message renderer, and the
// email / Telegram / Discord channel adapters are all re-exported from here.

export {
  NotificationDispatcher,
  initNotificationDispatcher,
  getNotificationDispatcher,
  emitAlert,
  __resetNotificationDispatcherForTest,
} from './dispatcher.js';
export type {
  AlertEvent,
  AlertMarket,
  FillAlertEvent,
  ExitAlertEvent,
  SignalAlertEvent,
  RiskHaltAlertEvent,
  BriefingAlertEvent,
  BriefMacroIndex,
  BriefSetup,
  BriefPosition,
  BriefHeadline,
  ChannelAdapter,
  DispatcherDeps,
} from './dispatcher.js';

export { renderAlert } from './renderer.js';
export type { RenderedAlert } from './renderer.js';

export { buildSampleAlertEvent } from './sample-event.js';

export {
  registerChannelAdapters,
  EmailChannelAdapter,
  TelegramChannelAdapter,
  DiscordChannelAdapter,
  isValidDiscordWebhook,
} from './channels/index.js';
export type {
  ChannelAdapterDeps,
  EmailAdapterDeps,
  TelegramAdapterDeps,
  DiscordAdapterDeps,
} from './channels/index.js';

export {
  issueLinkToken,
  consumeLinkToken,
  parseStartCommand,
  pendingLinkTokenCount,
  __resetLinkTokensForTest,
  LINK_TOKEN_TTL_MS,
} from './telegram-link.js';

// TRA-848 — inbound conversational-control (commands + approve/reject).
export { parseCommand } from './inbound/command-parser.js';
export type { InboundCommand } from './inbound/command-parser.js';
export { executeCommand, HELP_TEXT, KILL_SWITCH_NOTICE } from './inbound/command-router.js';
export type {
  CommandContext,
  RecommendationSummary,
  ActionResult,
} from './inbound/command-router.js';

// TRA-852 — Discord Interactions transport (Ed25519 verify + interaction map).
export {
  verifyDiscordRequest,
  extractInteraction,
  parseDiscordLinkToken,
  ed25519PublicKeyFromHex,
  DISCORD_INTERACTION_TYPE,
  DISCORD_RESPONSE_TYPE,
  DISCORD_EPHEMERAL_FLAG,
} from './inbound/discord-interactions.js';
export type { DiscordInteraction, ExtractedInteraction } from './inbound/discord-interactions.js';
