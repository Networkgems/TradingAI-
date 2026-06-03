// TRA-563 (TRA-410 A1) — notification dispatcher core.
//
// The dispatcher is the single fan-out point for user-facing trading alerts.
// Engine event hooks (fills / exits / new signals / risk-halt) call the
// fire-and-forget `emitAlert()` helper; the dispatcher then:
//
//   1. resolves the user's alert preferences (per-user AccountSettings),
//   2. drops duplicates inside a short TTL window (dedup),
//   3. suppresses non-critical alerts during quiet hours (risk_halt bypasses),
//   4. batches `signal` alerts when a digest mode is selected,
//   5. routes each surviving event to the channels enabled for its class, and
//   6. fans out to the registered channel adapters (email / Telegram / Discord,
//      built in A2) under a per-channel timeout-bounded try/catch.
//
// Failure isolation (TRA-410 §1.5 / TRA-402 §5): a channel send can NEVER throw
// into the caller. `emit()` schedules the work and returns synchronously; every
// send is wrapped so a slow or failing channel is logged, never propagated, and
// never blocks a trade tick.

import {
  ALERT_CHANNELS,
  resolveAlertPreferences,
  type AccountMode,
  type AccountSettings,
  type AlertChannel,
  type AlertEventClass,
  type AlertPreferences,
} from '@trading-app/shared';
import { logger, type Logger } from '../observability/index.js';

// ── Event model ──────────────────────────────────────────────────────────────

export type AlertMarket = 'stocks' | 'crypto' | 'options';

interface AlertEventBase {
  /** `kind` doubles as the routing class (see {@link AlertEventClass}). */
  kind: AlertEventClass;
  /** Owning user — keys preference resolution and digest/dedup buffers. */
  username: string;
  /** Epoch ms the event occurred. Defaults to the dispatcher clock when omitted. */
  timestamp?: number;
  /**
   * Explicit dedup key. When omitted a stable key is derived per kind so a
   * burst of identical emits (e.g. a repeated risk-halt every tick) collapses
   * to one delivery inside the dedup window.
   */
  dedupKey?: string;
}

export interface FillAlertEvent extends AlertEventBase {
  kind: 'fill';
  symbol: string;
  market: AlertMarket;
  mode: AccountMode;
  side: string;
  quantity: number;
  price: number;
  strategy?: string;
  positionId?: string;
}

export interface ExitAlertEvent extends AlertEventBase {
  kind: 'exit';
  symbol: string;
  market: AlertMarket;
  mode: AccountMode;
  /** take-profit / stop-loss / trailing / manual / etc. */
  exitReason?: string;
  pnl?: number;
  pnlR?: number;
  strategy?: string;
  positionId?: string;
}

export interface SignalAlertEvent extends AlertEventBase {
  kind: 'signal';
  symbol: string;
  market: AlertMarket;
  /** Strategy / signal type (orb, bb_fade, ichimoku, relative_value, …). */
  signalType: string;
  side: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface RiskHaltAlertEvent extends AlertEventBase {
  kind: 'risk_halt';
  mode: AccountMode;
  reason: string;
}

export type AlertEvent =
  | FillAlertEvent
  | ExitAlertEvent
  | SignalAlertEvent
  | RiskHaltAlertEvent;

/** A channel adapter rendered the event; shape is owned by A2's renderer. */
export interface ChannelAdapter {
  readonly channel: AlertChannel;
  /**
   * Whether the channel has everything it needs to deliver (e.g. a Discord
   * webhook URL / a linked Telegram chat). Unconfigured channels are skipped
   * even when enabled, so a user can flip a toggle on before linking.
   */
  isConfigured(prefs: AlertPreferences): boolean;
  /** Render + deliver. May reject / hang; the dispatcher bounds and isolates it. */
  send(event: AlertEvent, prefs: AlertPreferences): Promise<void>;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export interface DispatcherDeps {
  /**
   * Resolve a user's persisted settings (source of alert preferences). May be
   * async. Returning undefined ↔ "unknown user" → the event is dropped.
   */
  loadSettings: (
    username: string,
  ) => AccountSettings | undefined | Promise<AccountSettings | undefined>;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Per-channel send timeout. Default 5_000ms. */
  sendTimeoutMs?: number;
  /** Dedup window — identical keys inside it collapse to one send. Default 60_000ms. */
  dedupTtlMs?: number;
  logger?: Logger;
  /**
   * Schedule a deferred digest flush. Injectable so tests can drive flushes
   * deterministically. Defaults to an unref'd setTimeout.
   */
  scheduleFlush?: (fn: () => void, ms: number) => void;
}

const DIGEST_INTERVAL_MS: Record<Exclude<AlertPreferences['signalDigest'], 'immediate'>, number> = {
  '15min': 15 * 60_000,
  hourly: 60 * 60_000,
};

export class NotificationDispatcher {
  private readonly adapters = new Map<AlertChannel, ChannelAdapter>();
  /** dedup key → epoch ms at which the entry expires. */
  private readonly dedup = new Map<string, number>();
  /** username → buffered signal events awaiting the next digest flush. */
  private readonly digestBuffers = new Map<string, SignalAlertEvent[]>();
  /** usernames with a flush already scheduled (avoids stacking timers). */
  private readonly digestScheduled = new Set<string>();

  private readonly now: () => number;
  private readonly sendTimeoutMs: number;
  private readonly dedupTtlMs: number;
  private readonly log: Logger;
  private readonly scheduleFlush: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sendTimeoutMs = deps.sendTimeoutMs ?? 5_000;
    this.dedupTtlMs = deps.dedupTtlMs ?? 60_000;
    this.log = (deps.logger ?? logger).child({ module: 'notifications' });
    this.scheduleFlush =
      deps.scheduleFlush ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Don't let a pending digest keep the process alive at shutdown.
        (t as { unref?: () => void }).unref?.();
      });
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /** True if any adapter is registered for `channel`. */
  hasAdapter(channel: AlertChannel): boolean {
    return this.adapters.has(channel);
  }

  /**
   * Fire-and-forget entry point. Returns synchronously and NEVER throws — the
   * async pipeline is detached and fully error-isolated so a trade tick that
   * emits an alert is never blocked or broken by notification work.
   */
  emit(event: AlertEvent): void {
    try {
      void this.process(event).catch((err) => {
        this.log.error('alert pipeline error', {
          kind: event.kind,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      // Defensive: even the synchronous scheduling cannot escape.
      this.log.error('alert emit error', {
        kind: event.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async process(event: AlertEvent): Promise<void> {
    const ts = event.timestamp ?? this.now();

    // 1. Dedup — drop identical events seen inside the TTL window.
    if (this.isDuplicate(event, ts)) {
      this.log.debug('alert deduped', { kind: event.kind, username: event.username });
      return;
    }

    const settings = await this.deps.loadSettings(event.username);
    if (!settings) {
      this.log.debug('alert dropped — unknown user', {
        kind: event.kind,
        username: event.username,
      });
      return;
    }
    const prefs = resolveAlertPreferences(settings);

    // 2. Quiet hours — non-critical classes are suppressed; risk_halt bypasses.
    if (event.kind !== 'risk_halt' && this.inQuietHours(prefs.quietHours, ts)) {
      this.log.debug('alert suppressed by quiet hours', {
        kind: event.kind,
        username: event.username,
      });
      return;
    }

    // 3. Digest — batch high-frequency signal alerts when a digest is selected.
    if (event.kind === 'signal' && prefs.signalDigest !== 'immediate') {
      this.bufferForDigest(event, prefs.signalDigest);
      return;
    }

    await this.fanOut(event, prefs, ts);
  }

  // ── routing + fan-out ────────────────────────────────────────────────────

  private async fanOut(event: AlertEvent, prefs: AlertPreferences, ts: number): Promise<void> {
    const matrix = prefs.events[event.kind];
    const targets = ALERT_CHANNELS.filter((ch) => {
      if (!matrix[ch]) return false; // class not routed to this channel
      if (!prefs.channels[ch]?.enabled) return false; // channel toggled off
      const adapter = this.adapters.get(ch);
      return !!adapter && adapter.isConfigured(prefs); // adapter present + ready
    });

    if (targets.length === 0) {
      this.log.debug('alert has no eligible channels', {
        kind: event.kind,
        username: event.username,
      });
      return;
    }

    this.log.info('dispatching alert', {
      kind: event.kind,
      username: event.username,
      channels: targets,
      ts,
    });

    await Promise.all(
      targets.map((ch) => this.sendIsolated(this.adapters.get(ch)!, event, prefs)),
    );
  }

  /**
   * Deliver through one adapter under a timeout, swallowing+logging any failure.
   * The returned promise ALWAYS resolves — a channel error or timeout can never
   * reject into the fan-out, so one bad channel never blocks the others or the
   * caller.
   */
  private async sendIsolated(
    adapter: ChannelAdapter,
    event: AlertEvent,
    prefs: AlertPreferences,
  ): Promise<void> {
    try {
      await this.withTimeout(adapter.send(event, prefs), this.sendTimeoutMs, adapter.channel);
    } catch (err) {
      this.log.warn('alert channel send failed', {
        channel: adapter.channel,
        kind: event.kind,
        username: event.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, channel: AlertChannel): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`channel ${channel} timed out after ${ms}ms`)),
        ms,
      );
      (timer as { unref?: () => void }).unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // ── dedup ──────────────────────────────────────────────────────────────────

  private isDuplicate(event: AlertEvent, ts: number): boolean {
    // Opportunistically prune so the map can't grow without bound.
    for (const [key, expiry] of this.dedup) {
      if (expiry <= ts) this.dedup.delete(key);
    }
    const key = this.dedupKey(event);
    const existing = this.dedup.get(key);
    if (existing != null && existing > ts) return true;
    this.dedup.set(key, ts + this.dedupTtlMs);
    return false;
  }

  private dedupKey(event: AlertEvent): string {
    if (event.dedupKey) return `${event.kind}:${event.username}:${event.dedupKey}`;
    switch (event.kind) {
      case 'fill':
        return `fill:${event.username}:${event.positionId ?? `${event.symbol}@${event.price}`}`;
      case 'exit':
        return `exit:${event.username}:${event.positionId ?? `${event.symbol}@${event.pnl ?? ''}`}`;
      case 'signal':
        return `signal:${event.username}:${event.symbol}:${event.signalType}:${event.side}`;
      case 'risk_halt':
        return `risk_halt:${event.username}:${event.reason}`;
    }
  }

  // ── quiet hours ──────────────────────────────────────────────────────────

  /** Whether `ts` falls inside the (possibly midnight-wrapping) quiet window. */
  inQuietHours(qh: AlertPreferences['quietHours'], ts: number): boolean {
    if (!qh.enabled) return false;
    const start = parseHm(qh.start);
    const end = parseHm(qh.end);
    if (start == null || end == null || start === end) return false;
    const cur = this.minutesInTz(qh.timezone, ts);
    if (cur < 0) return false; // bad tz → fail open (don't suppress)
    return start < end
      ? cur >= start && cur < end // same-day window
      : cur >= start || cur < end; // wraps past midnight
  }

  /** Minutes-since-midnight for `ts` in `tz`, or -1 if the tz is unusable. */
  private minutesInTz(tz: string, ts: number): number {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(new Date(ts));
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 'x') % 24;
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 'x');
      if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
      return h * 60 + m;
    } catch {
      return -1;
    }
  }

  // ── digest batching ──────────────────────────────────────────────────────

  private bufferForDigest(event: SignalAlertEvent, mode: '15min' | 'hourly'): void {
    const buf = this.digestBuffers.get(event.username) ?? [];
    buf.push(event);
    this.digestBuffers.set(event.username, buf);
    this.log.debug('signal buffered for digest', {
      username: event.username,
      mode,
      buffered: buf.length,
    });
    if (!this.digestScheduled.has(event.username)) {
      this.digestScheduled.add(event.username);
      this.scheduleFlush(() => {
        void this.flushDigest(event.username);
      }, DIGEST_INTERVAL_MS[mode]);
    }
  }

  /**
   * Flush a user's buffered signal alerts now. Each is delivered through the
   * normal routing/fan-out path (digest already applied). Public so tests — and
   * a future graceful-shutdown — can force delivery. Always resolves.
   */
  async flushDigest(username: string): Promise<void> {
    this.digestScheduled.delete(username);
    const buffered = this.digestBuffers.get(username);
    this.digestBuffers.delete(username);
    if (!buffered || buffered.length === 0) return;

    const settings = await this.deps.loadSettings(username);
    if (!settings) return;
    const prefs = resolveAlertPreferences(settings);
    this.log.info('flushing signal digest', { username, count: buffered.length });
    for (const event of buffered) {
      await this.fanOut(event, prefs, event.timestamp ?? this.now());
    }
  }

  /** Pending buffered-signal count for a user (test/inspection helper). */
  pendingDigestCount(username: string): number {
    return this.digestBuffers.get(username)?.length ?? 0;
  }
}

function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// ── module singleton + safe emit helper ────────────────────────────────────

let singleton: NotificationDispatcher | undefined;

/** Install the process-wide dispatcher. Called once at server boot. */
export function initNotificationDispatcher(deps: DispatcherDeps): NotificationDispatcher {
  singleton = new NotificationDispatcher(deps);
  return singleton;
}

export function getNotificationDispatcher(): NotificationDispatcher | undefined {
  return singleton;
}

/** Test seam — drop the installed dispatcher. */
export function __resetNotificationDispatcherForTest(): void {
  singleton = undefined;
}

/**
 * Fire-and-forget emit used by the engine hooks. No-op when the dispatcher
 * isn't installed (e.g. in unit tests of the engine) and NEVER throws — the
 * call site is a trade path and must not be affected by notification state.
 */
export function emitAlert(event: AlertEvent): void {
  try {
    singleton?.emit(event);
  } catch {
    // Unreachable in practice (emit is itself guarded) — belt-and-suspenders.
  }
}
