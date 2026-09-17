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
  type ReportCadence,
} from '@trading-app/shared';
import { logger, type Logger } from '../observability/index.js';

// ── Event model ──────────────────────────────────────────────────────────────

export type AlertMarket = 'stocks' | 'options';

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
  /**
   * TRA-4388 — per-event override of the dispatcher's dedup window (default
   * 60s). The default TTL assumes the emitter re-fires on a TICK cadence, so a
   * minute is enough to collapse a burst. It is NOT enough for an emitter whose
   * repeats are minutes-to-hours apart, and it is not enough to collapse the
   * SAME condition observed independently by several engines: bqb1 runs 67
   * engine instances, each with its own `DailyRiskGovernor`, and a firm-wide
   * market-data outage transitions each of them separately. Those transitions
   * are not synchronised to within 60s, so the same user was mailed once per
   * engine per episode.
   *
   * An emitter that knows the horizon over which its condition is ONE event
   * states it here. Ignored unless it exceeds the dispatcher default — an
   * emitter may widen its own collapse window, never narrow it below the
   * baseline burst protection.
   */
  dedupTtlMs?: number;
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

/** One macro-index reading on the morning brief (VIX / breadth / credit / rates). */
export interface BriefMacroIndex {
  label: string;
  value: number | null;
  note?: string;
}

/** One candidate trade setup surfaced on the brief's watchlist. */
export interface BriefSetup {
  symbol: string;
  signalType: string;
  side: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

/** One open position summarised on the brief. */
export interface BriefPosition {
  symbol: string;
  market: AlertMarket;
  side: string;
  quantity: number;
  entryPrice: number;
  pnl?: number;
  /** Optional extra qualifier, e.g. an options leg "call 150 2026-06-19". */
  detail?: string;
}

/** One overnight headline on the brief. */
export interface BriefHeadline {
  title: string;
  source: string;
}

/**
 * TRA-4303 — one row of the brief's overnight/pre-close setups section.
 *
 * Distinct from {@link BriefSetup}, which is an engine TRADE SIGNAL (entry / stop
 * / target) drawn from `getState().signals`. At 08:30 ET no bar has evaluated
 * since yesterday's close, so that section is by construction the PRIOR session's
 * signal log. This row is the thing the board actually asked for: a name that
 * earned attention from what happened before the close or overnight, with the
 * reason attached and no levels implied.
 */
/**
 * TRA-4303 AC-4 — "eligibility is a column, not a claim."
 *
 * What the row's admission looks like AT 08:30, against the gate values read
 * from LIVE CONFIG (never source literals — the TRA-3515 `barR` failure mode).
 *
 * ⛔ Deliberately scoped to the gates that are DECIDABLE PRE-OPEN. The three
 * gates the scope note named — the $0.50 premium floor, the |Δ| band and the
 * cost-bar margin — are all per-CONTRACT: each needs a live option quote for a
 * specific strike, and US options do not quote pre-market. A 08:30 verdict on
 * them would be computed off yesterday's closing chain and would not be the
 * verdict the 09:30+ order site faces. They are published as values-in-force on
 * {@link BriefGateReadout.deferred} instead of being guessed at per row.
 */
export interface BriefOvernightEligibility {
  /**
   * `watched`   — already in the engine's base universe; no 09:00 add needed.
   * `eligible`  — newcomer that clears every pre-open-decidable gate.
   * `blocked`   — a pre-open-decidable gate rejects it; {@link gate} names which.
   * `unknown`   — no pre-open price on hand, so the 09:00 price floor cannot be
   *               pre-decided. NOT the same as `eligible`: the 09:00 build
   *               prices these off a live quote and drops the ones that miss.
   */
  status: 'watched' | 'eligible' | 'blocked' | 'unknown';
  /** The gate behind a `blocked` / `unknown` status, with the value in force. */
  gate?: string;
}

/**
 * TRA-4303 AC-4 — the gate values in force, resolved from live config at compose
 * time by the same resolvers the enforcement path uses.
 *
 * Split by DECIDABILITY, not by importance: `decidedPreOpen` are the gates the
 * per-row column above actually ruled on, `deferred` are the ones that need a
 * live option quote and therefore cannot be ruled on at 08:30. Publishing them
 * together as one list would let a reader take the second group as adjudicated.
 */
export interface BriefGateReadout {
  decidedPreOpen: string[];
  deferred: string[];
}

export interface BriefOvernightSetup {
  symbol: string;
  /**
   * Why the symbol is listed — one human label per contributing leg
   * ("prior-close mover", "pre-market gainer", …). Multiple legs mean multiple
   * sources agreed, which is exactly what the shared scorer ranks on.
   */
  legs: string[];
  /**
   * Move size behind the listing: the pre-market screener's %-change when there
   * is one, else the prior session's. Absent when neither leg carries a
   * TRUSTED number (a prior-session row that fails the plausibility rule is
   * dropped, never rendered — see `suspectMover`).
   */
  changePct?: number;
  /** Rank score from the shared watchlist scorer; higher = more legs agreed. */
  score: number;
  /** TRA-4303 AC-4 — admission status against the gates decidable at 08:30. */
  eligibility: BriefOvernightEligibility;
}

/**
 * TRA-4303 — the overnight-setups section as a whole.
 *
 * `available: false` is NOT the same as an empty `rows`: the first means both
 * source legs failed and the section could not be computed, the second means it
 * was computed and found nothing. The renderer keeps them distinguishable
 * ("unavailable" vs "none") — same posture as the macro gate's neutral fallback.
 */
export interface BriefOvernightSection {
  available: boolean;
  rows: BriefOvernightSetup[];
  /** Degradation note naming whichever leg failed, when one did. */
  note?: string;
  /** TRA-4303 AC-4 — the gate values in force behind the eligibility column. */
  gates?: BriefGateReadout;
}

/**
 * TRA-849 — scheduled pre-market morning briefing. Fired once per trading day
 * (~8:30 ET) by the scheduler's `onMorningBrief` hook and dispatched per user
 * through the existing fan-out pipeline. Carries the four structured sections the
 * shared renderer formats into a single channel-agnostic message: the macro gate
 * (VIX / breadth / credit / rates), today's watchlist setups, the open book, and
 * overnight news. Unlike `signal` it is never digest-batched (it is already a
 * once-daily digest by construction).
 */
export interface BriefingAlertEvent extends AlertEventBase {
  kind: 'briefing';
  /** ET trading date the brief targets, `YYYY-MM-DD`. Scopes the daily dedup key. */
  date: string;
  macro: {
    /** Regime label from the latest market review, e.g. 'green' | 'yellow' | 'red'. */
    regime: string;
    /** Human rationale for the regime. */
    rationale: string;
    indexes: BriefMacroIndex[];
  };
  /**
   * TRA-4303 — the engine's most recent trade signals. At the 08:30 fire these
   * are the PRIOR session's: `recentSignals` only grows when a bar evaluates and
   * no bar evaluates overnight. The renderer labels it accordingly; the
   * overnight read is the separate {@link overnight} section.
   */
  setups: BriefSetup[];
  positions: BriefPosition[];
  news: BriefHeadline[];
  /**
   * TRA-4303 — overnight / pre-close setups. Optional so a producer that has no
   * overnight read (or has it switched off) emits a brief byte-identical to the
   * pre-TRA-4303 one; the renderer then omits the section entirely rather than
   * printing a misleading empty one.
   */
  overnight?: BriefOvernightSection;
}

/**
 * TRA-851 — output of a user-defined natural-language routine. Fired by the
 * scheduler's routine loop at the user's chosen time, it carries an already-
 * rendered `title` + `body` (built from the same read paths the chat commands
 * use) so the renderer just frames it. `routineId` + `date` scope the per-day
 * dedup key so a redeploy across the fire minute can't double-send.
 */
export interface RoutineAlertEvent extends AlertEventBase {
  kind: 'routine';
  /** Stable id of the routine that fired (`r1`, `r2`, …). */
  routineId: string;
  /** ET date the routine fired, `YYYY-MM-DD` — scopes the daily dedup key. */
  date: string;
  /** Headline, e.g. "Routine: scan (semis)". */
  title: string;
  /** Pre-rendered plain-text body (scan rows / status / positions / brief). */
  body: string;
}

/**
 * TRA-2252 — one day's contribution to a period report, rolled from the
 * `DailySnapshot` ledger. `pnl` is the day-only realized total (stock `dailyPnl`
 * + `optionsDailyPnl`), NOT the cumulative-carrying `combinedPnl` (that leak is
 * the TRA-1633 BUG 2 the aggregator deliberately avoids).
 */
export interface ReportDaySummary {
  /** ET calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Day-only realized P&L across stocks + options. */
  pnl: number;
  /** Closed trades booked that day. */
  trades: number;
}

/**
 * TRA-2252 — the rolled-up statistics a period report renders. Pure aggregate
 * of the per-day snapshots in the period window; see `scheduled-report.ts`.
 */
export interface ReportPeriodStats {
  /** Σ day-only realized P&L over the window. */
  totalPnl: number;
  /** Σ stock realized P&L (`DailySnapshot.dailyPnl`). */
  stockPnl: number;
  /** Σ day-only realized options P&L (`DailySnapshot.optionsDailyPnl`). */
  optionsPnl: number;
  /** Σ closed trades over the window. */
  totalTrades: number;
  /** Days with a booked snapshot in the window. */
  tradingDays: number;
  /** Days closing green / red (pnl > 0 / < 0). */
  winDays: number;
  lossDays: number;
  /** Combined book equity at the period's opening / close (Σ across trackers). */
  startEquity: number;
  endEquity: number;
  /** Best / worst single day by combined P&L (absent when the window is empty). */
  bestDay?: ReportDaySummary;
  worstDay?: ReportDaySummary;
}

/**
 * TRA-2252 — scheduled P&L + trade-summary report. Emitted at a period boundary
 * (day / ISO-week-ending-Sunday / month-end / Dec 31) by `runScheduledReports`
 * for each user whose `reportCadence` matches, and dispatched through the same
 * fan-out pipeline as `briefing`/`routine` so quiet-hours + dedup are inherited.
 * `cadence` + `periodEnd` scope the per-period dedup key so a redeploy across the
 * archive window can't double-send.
 */
export interface ReportAlertEvent extends AlertEventBase {
  kind: 'report';
  cadence: Exclude<ReportCadence, 'off'>;
  /** Human label, e.g. "Weekly — 2026-07-20 to 2026-07-26". */
  periodLabel: string;
  /** ET date the period opened, `YYYY-MM-DD` (inclusive). */
  periodStart: string;
  /** ET date the period closed, `YYYY-MM-DD` (inclusive) — scopes the dedup key. */
  periodEnd: string;
  stats: ReportPeriodStats;
}

export type AlertEvent =
  | FillAlertEvent
  | ExitAlertEvent
  | SignalAlertEvent
  | RiskHaltAlertEvent
  | BriefingAlertEvent
  | RoutineAlertEvent
  | ReportAlertEvent;

/** A channel adapter rendered the event; shape is owned by A2's renderer. */
export interface ChannelAdapter {
  readonly channel: AlertChannel;
  /**
   * Whether the channel has everything it needs to deliver (e.g. a Discord
   * webhook URL / a linked Telegram chat). Unconfigured channels are skipped
   * even when enabled, so a user can flip a toggle on before linking.
   */
  isConfigured(prefs: AlertPreferences): boolean;
  /**
   * TRA-2416 — the THIRD disposition. Return a machine-readable reason when this
   * specific recipient must not be attempted at all; `undefined` (or an absent
   * implementation) means "deliverable, go ahead".
   *
   * This exists because neither of the two dispositions the dispatcher already
   * had is correct for a recipient we deliberately refuse to mail:
   *
   *   • resolving from {@link send} records a SUCCESS for a mail that was never
   *     sent — a false green, manufactured inside the very surface TRA-2284
   *     grades the mail path on (`POST /api/notifications/report/test` reports a
   *     channel as `delivered` precisely when `send` resolves).
   *   • throwing from {@link send} records a transport FAILURE that did not
   *     happen — a false red, which also feeds the alerting path.
   *
   * So suppression is decided BEFORE the send, and is reported as its own state
   * that is neither `delivered` nor `failed`. Unlike {@link isConfigured} this
   * takes the event, because the decision is per-RECIPIENT (whose address is
   * resolved from `event.username` + prefs), not per-channel.
   */
  suppressionReason?(event: AlertEvent, prefs: AlertPreferences): string | undefined;
  /** Render + deliver. May reject / hang; the dispatcher bounds and isolates it. */
  send(event: AlertEvent, prefs: AlertPreferences): Promise<void>;
}

/**
 * TRA-2416 — ask one adapter whether this recipient must be refused, shared by
 * the dispatcher's fan-out and by the on-demand test routes so the two can never
 * drift on what counts as suppressed.
 *
 * An adapter with no `suppressionReason` implementation is never suppressed.
 *
 * FAILURE DIRECTION, deliberately chosen: if the predicate itself throws we
 * report `errored` and DO NOT suppress. Failing the other way — treating an
 * error as "suppress" — would silently stop real users' mail on a transient
 * lookup fault, which is precisely the too-wide gate that reads identically to a
 * working one (TRA-2356). Attempting the send instead surfaces the same fault as
 * a visible channel FAILURE, because `send()` re-resolves the address and hits it
 * again. An error becomes a red, never a silent drop.
 */
export function channelSuppressionReason(
  adapter: ChannelAdapter,
  event: AlertEvent,
  prefs: AlertPreferences,
): { reason?: string; errored?: string } {
  if (!adapter.suppressionReason) return {};
  try {
    const reason = adapter.suppressionReason(event, prefs);
    return reason ? { reason } : {};
  } catch (err) {
    return { errored: err instanceof Error ? err.message : String(err) };
  }
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

    // TRA-2416 — split the routed targets into ATTEMPTED and SUPPRESSED before
    // any send. A suppressed channel is deliberately not mailed, so it must land
    // in neither ledger the dispatcher already keeps ("dispatching alert" ⇒
    // delivered / "alert channel send failed" ⇒ failed).
    const suppressed: Array<{ channel: AlertChannel; reason: string }> = [];
    const attempted = targets.filter((ch) => {
      const reason = this.suppressionReasonFor(this.adapters.get(ch)!, event, prefs);
      if (!reason) return true;
      suppressed.push({ channel: ch, reason });
      return false;
    });

    if (suppressed.length > 0) {
      // `info`, not `debug`: a suppression must be COUNTABLE in prod (bqb1 runs
      // at LOG_LEVEL=error/warn/info, and a silent no-op is the failure mode this
      // whole issue is about). One line per fan-out, carrying every reason.
      this.log.info('alert channels suppressed', {
        kind: event.kind,
        username: event.username,
        disposition: 'suppressed',
        suppressed: suppressed.map((s) => `${s.channel}:${s.reason}`),
        issue: 'TRA-2416',
      });
    }

    if (attempted.length === 0) {
      // Distinct from 'alert has no eligible channels' above on purpose: that one
      // means MISCONFIGURED (nothing routed/enabled/ready), this one means every
      // routed channel was refused by design. Same silence, different causes —
      // and TRA-2356's whole lesson is that conflating them is how a too-wide
      // gate reads exactly like a working one.
      this.log.info('alert fully suppressed — no channel attempted', {
        kind: event.kind,
        username: event.username,
        disposition: 'suppressed',
      });
      return;
    }

    this.log.info('dispatching alert', {
      kind: event.kind,
      username: event.username,
      channels: attempted,
      ts,
    });

    await Promise.all(
      attempted.map((ch) => this.sendIsolated(this.adapters.get(ch)!, event, prefs)),
    );
  }

  /** Suppression verdict for one adapter. See {@link channelSuppressionReason}. */
  private suppressionReasonFor(
    adapter: ChannelAdapter,
    event: AlertEvent,
    prefs: AlertPreferences,
  ): string | undefined {
    const verdict = channelSuppressionReason(adapter, event, prefs);
    if (verdict.errored) {
      this.log.warn('suppression check errored — attempting the send', {
        channel: adapter.channel,
        kind: event.kind,
        username: event.username,
        reason: verdict.errored,
      });
    }
    return verdict.reason;
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
    // TRA-4388 — an emitter may WIDEN its own collapse window, never narrow it.
    // `max` (not `??`) so a stale/short caller value cannot weaken the baseline
    // burst protection every other event class relies on.
    const ttl = Math.max(this.dedupTtlMs, event.dedupTtlMs ?? 0);
    this.dedup.set(key, ts + ttl);
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
      case 'briefing':
        // One brief per user per trading day — a re-run (catch-up / restart)
        // inside the TTL window collapses to the single delivery.
        return `briefing:${event.username}:${event.date}`;
      case 'routine':
        // One fire per routine per ET day — a restart across the fire minute
        // collapses to the single delivery (matches the runner's own dedup).
        return `routine:${event.username}:${event.routineId}:${event.date}`;
      case 'report':
        // One report per user per cadence per period end — a redeploy across the
        // 21:00 archive window collapses to the single delivery.
        return `report:${event.username}:${event.cadence}:${event.periodEnd}`;
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
