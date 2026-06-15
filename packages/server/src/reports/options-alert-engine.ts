// TRA-845 — Layer-4 options alert engine (chain-diff + target/stop + IV-move).
//
// The fourth and last monitoring layer from the TRA-841 analysis. Layers 1–3
// (data/valuation, portfolio analytics, market context) already exist; this
// closes Layer 4: turn the daily artifacts we already persist into actionable
// alerts.
//
// Three pure detectors, all deterministic given their inputs:
//
//   1. chain-diff   — diff today's recorded chain vs yesterday's (the snapshots
//                     options-chain-recorder already writes) to surface NEW
//                     expiries and NEW strikes added to an existing expiry.
//   2. iv-move      — for contracts present in BOTH days, flag a big day-over-day
//                     implied-vol move (prefers smvVol "Theo IV", falls back to
//                     midIv).
//   3. target/stop  — scan the OPEN options book and flag positions whose live
//                     mark has reached their take-profit (tp1) or stop-loss.
//
// Everything here is a pure primitive — no I/O, no clock except the injected
// `now`. The server route (`/api/health/options-alerts`) loads the last two
// chain partitions + the open book and calls these; the daily chain-record hook
// reuses the same functions to fan results through the existing notification
// dispatcher (see `toAlertEvents`). Mirrors the Layer-2 rollup design in
// `portfolio-greeks.ts`: pure core, thin wiring.

import type { OptionPosition } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import type { SignalAlertEvent } from '../notifications/index.js';

/** A single per-symbol chain snapshot — the read shape the recorder writes. */
export interface ChainSnapshot {
  symbol: string;
  spot: number | null;
  recordedAt: number;
  expirations: string[];
  rows: OptionChainRow[];
}

export type OptionsAlertKind = 'new_expiry' | 'new_strike' | 'iv_move' | 'target_hit' | 'stop_hit';

/** "info" = informational chain change; "action" = a held position needs attention. */
export type OptionsAlertSeverity = 'info' | 'action';

export interface OptionsAlert {
  kind: OptionsAlertKind;
  severity: OptionsAlertSeverity;
  symbol: string;
  /** Human-readable one-liner suitable for a dashboard row or a push body. */
  message: string;
  /** Stable key so repeated runs of the same day collapse to one push (dedup). */
  dedupKey: string;
  /** Structured payload — present fields depend on `kind`. */
  expiration?: string;
  strike?: number;
  optionType?: 'call' | 'put';
  /** iv_move: prior / current vol (absolute, e.g. 0.42), and the signed delta. */
  ivFrom?: number;
  ivTo?: number;
  ivDelta?: number;
  /** target/stop: the live mark and the level it crossed (per-share premium). */
  mark?: number;
  level?: number;
}

export interface OptionsAlertOptions {
  /**
   * Absolute implied-vol move (in vol points, e.g. 0.10 = 10 IV points) that
   * trips an `iv_move` alert. Default 0.10.
   */
  ivMoveThreshold?: number;
  /**
   * Cap on `new_strike` alerts emitted per (symbol, expiration) so a day where a
   * provider back-fills a whole strike ladder doesn't bury the action items.
   * Excess strikes are summarized into one rollup alert. Default 8.
   */
  maxNewStrikesPerExpiry?: number;
  /** Wall-clock ms for `asOf` stamps. Defaults to Date.now(). */
  now?: number;
}

const DEFAULT_IV_MOVE_THRESHOLD = 0.1;
const DEFAULT_MAX_NEW_STRIKES_PER_EXPIRY = 8;

/** Stable identity for a chain row across days (type|expiration|strike). */
function rowKey(r: OptionChainRow): string {
  return `${r.optionType}|${r.expiration}|${r.strike}`;
}

/** The vol we diff: smvVol ("Theo IV") when present, else midIv. */
function rowIv(r: OptionChainRow): number | undefined {
  const v = Number.isFinite(r.smvVol ?? NaN) && (r.smvVol ?? 0) > 0 ? r.smvVol : r.midIv;
  return Number.isFinite(v ?? NaN) && (v ?? 0) > 0 ? v : undefined;
}

/**
 * Diff one symbol's chain across two days. Detects expiries that opened today
 * (not present yesterday), strikes added to a *pre-existing* expiry, and big
 * IV moves on contracts quoted both days. A brand-new expiry is reported once
 * as `new_expiry` and its strikes are NOT also reported as `new_strike` — the
 * expiry alert already covers the whole ladder.
 */
export function diffChain(
  prev: ChainSnapshot,
  today: ChainSnapshot,
  opts: OptionsAlertOptions = {},
): OptionsAlert[] {
  const ivThreshold = opts.ivMoveThreshold ?? DEFAULT_IV_MOVE_THRESHOLD;
  const maxNewStrikes = opts.maxNewStrikesPerExpiry ?? DEFAULT_MAX_NEW_STRIKES_PER_EXPIRY;
  const symbol = today.symbol.toUpperCase();
  const date = etDay(today.recordedAt);
  const alerts: OptionsAlert[] = [];

  const prevExpiries = new Set(prev.rows.map((r) => r.expiration));
  const todayExpiries = new Set(today.rows.map((r) => r.expiration));

  // 1. New expiries — sorted so output is deterministic.
  const newExpiries = [...todayExpiries].filter((e) => !prevExpiries.has(e)).sort();
  for (const exp of newExpiries) {
    const ladder = today.rows.filter((r) => r.expiration === exp).length;
    alerts.push({
      kind: 'new_expiry',
      severity: 'info',
      symbol,
      expiration: exp,
      message: `${symbol}: new expiry ${exp} opened (${ladder} contracts)`,
      dedupKey: `new_expiry:${symbol}:${exp}:${date}`,
    });
  }

  // 2. New strikes added to an expiry that already existed yesterday.
  const prevKeys = new Set(prev.rows.map(rowKey));
  const newStrikeRows = today.rows.filter(
    (r) => prevExpiries.has(r.expiration) && !prevKeys.has(rowKey(r)),
  );
  const byExpiry = new Map<string, OptionChainRow[]>();
  for (const r of newStrikeRows) {
    const list = byExpiry.get(r.expiration) ?? [];
    list.push(r);
    byExpiry.set(r.expiration, list);
  }
  for (const exp of [...byExpiry.keys()].sort()) {
    const rows = byExpiry.get(exp)!.slice().sort((a, b) => a.strike - b.strike);
    if (rows.length > maxNewStrikes) {
      alerts.push({
        kind: 'new_strike',
        severity: 'info',
        symbol,
        expiration: exp,
        message: `${symbol}: ${rows.length} new strikes added to ${exp}`,
        dedupKey: `new_strike:${symbol}:${exp}:rollup:${date}`,
      });
      continue;
    }
    for (const r of rows) {
      alerts.push({
        kind: 'new_strike',
        severity: 'info',
        symbol,
        expiration: exp,
        strike: r.strike,
        optionType: r.optionType,
        message: `${symbol}: new ${r.optionType} strike ${r.strike} @ ${exp}`,
        dedupKey: `new_strike:${symbol}:${rowKey(r)}:${date}`,
      });
    }
  }

  // 3. IV moves on contracts quoted both days.
  const prevIvByKey = new Map<string, number>();
  for (const r of prev.rows) {
    const iv = rowIv(r);
    if (iv != null) prevIvByKey.set(rowKey(r), iv);
  }
  for (const r of today.rows) {
    const k = rowKey(r);
    const from = prevIvByKey.get(k);
    const to = rowIv(r);
    if (from == null || to == null) continue;
    const delta = to - from;
    if (Math.abs(delta) < ivThreshold) continue;
    const dir = delta > 0 ? 'up' : 'down';
    alerts.push({
      kind: 'iv_move',
      severity: 'info',
      symbol,
      expiration: r.expiration,
      strike: r.strike,
      optionType: r.optionType,
      ivFrom: from,
      ivTo: to,
      ivDelta: delta,
      message: `${symbol} ${r.optionType} ${r.strike} ${r.expiration}: IV ${dir} ${(from * 100).toFixed(0)}%→${(to * 100).toFixed(0)}% (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}pts)`,
      dedupKey: `iv_move:${symbol}:${k}:${date}`,
    });
  }

  return alerts;
}

/**
 * Scan the open book for positions whose live mark has reached their take-profit
 * (`tp1Premium`, only while the partial hasn't fired) or stop-loss
 * (`stopLossPremium` / active trailing stop). One alert per crossed level.
 */
export function scanTargetStop(
  openOptions: readonly OptionPosition[],
  opts: OptionsAlertOptions = {},
): OptionsAlert[] {
  const date = etDay(opts.now ?? Date.now());
  const alerts: OptionsAlert[] = [];

  for (const p of openOptions) {
    const mark = p.currentPremium;
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const label = `${p.symbol} ${p.optionType}${p.strike != null ? ` ${p.strike}` : ''}${p.expiration ? ` ${p.expiration}` : ''}`;

    // Target — only while the first partial hasn't already been taken.
    if (!p.tp1Hit && Number.isFinite(p.tp1Premium) && p.tp1Premium > 0 && mark >= p.tp1Premium) {
      alerts.push({
        kind: 'target_hit',
        severity: 'action',
        symbol: p.symbol.toUpperCase(),
        expiration: p.expiration,
        strike: p.strike,
        optionType: p.optionType,
        mark,
        level: p.tp1Premium,
        message: `${label}: target hit — mark ${mark.toFixed(2)} >= TP ${p.tp1Premium.toFixed(2)}`,
        dedupKey: `target_hit:${p.id}:${date}`,
      });
    }

    // Stop — hard stop, or the active trailing stop, whichever the mark has
    // breached. Trailing only counts once it's engaged.
    const trailing = p.trailingActive && Number.isFinite(p.trailingStopPremium) && p.trailingStopPremium > 0
      ? p.trailingStopPremium
      : undefined;
    const hardStop = Number.isFinite(p.stopLossPremium) && p.stopLossPremium > 0 ? p.stopLossPremium : undefined;
    // The binding stop is the higher of the two levels the mark could breach.
    const stopLevel = Math.max(trailing ?? 0, hardStop ?? 0) || undefined;
    if (stopLevel != null && mark <= stopLevel) {
      const isTrailing = trailing != null && stopLevel === trailing;
      alerts.push({
        kind: 'stop_hit',
        severity: 'action',
        symbol: p.symbol.toUpperCase(),
        expiration: p.expiration,
        strike: p.strike,
        optionType: p.optionType,
        mark,
        level: stopLevel,
        message: `${label}: ${isTrailing ? 'trailing ' : ''}stop hit — mark ${mark.toFixed(2)} <= stop ${stopLevel.toFixed(2)}`,
        dedupKey: `stop_hit:${p.id}:${date}`,
      });
    }
  }

  return alerts;
}

export interface ComputeOptionsAlertsInput {
  /** Yesterday's recorded chains, keyed by uppercase symbol. */
  prevBySymbol: ReadonlyMap<string, ChainSnapshot>;
  /** Today's recorded chains, keyed by uppercase symbol. */
  todayBySymbol: ReadonlyMap<string, ChainSnapshot>;
  /** The open options book (both modes) for target/stop scanning. */
  openOptions: readonly OptionPosition[];
  opts?: OptionsAlertOptions;
}

export interface OptionsAlertsResult {
  alerts: OptionsAlert[];
  /** Symbols diffed (present in both days). */
  symbolsDiffed: string[];
  counts: Record<OptionsAlertKind, number>;
  asOf: number;
}

/**
 * Run all three detectors and return the merged, deterministically-ordered alert
 * set. Chain-diff runs for every symbol present in BOTH days; target/stop runs
 * over the whole open book. Order: action items (target/stop) first, then info
 * (chain changes), each group stable by symbol then dedupKey.
 */
export function computeOptionsAlerts(input: ComputeOptionsAlertsInput): OptionsAlertsResult {
  const opts = input.opts ?? {};
  const now = opts.now ?? Date.now();
  const out: OptionsAlert[] = [];

  const symbolsDiffed: string[] = [];
  for (const [symbol, today] of [...input.todayBySymbol.entries()].sort()) {
    const prev = input.prevBySymbol.get(symbol);
    if (!prev) continue;
    symbolsDiffed.push(symbol);
    out.push(...diffChain(prev, today, opts));
  }

  out.push(...scanTargetStop(input.openOptions, opts));

  const severityRank: Record<OptionsAlertSeverity, number> = { action: 0, info: 1 };
  out.sort((a, b) => {
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity];
    }
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0;
  });

  const counts: Record<OptionsAlertKind, number> = {
    new_expiry: 0,
    new_strike: 0,
    iv_move: 0,
    target_hit: 0,
    stop_hit: 0,
  };
  for (const a of out) counts[a.kind] += 1;

  return { alerts: out, symbolsDiffed, counts, asOf: now };
}

/** ET YYYY-MM-DD for a timestamp — scopes dedup keys to the trading day. */
export function etDay(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Map alerts onto the existing notification event model so they fan out through
 * the dispatcher (email / Telegram / Discord) — the "optional push via existing
 * notifications plumbing" the issue asks for. Each alert becomes an options
 * `signal` event carrying its kind as `signalType`; the alert's own `dedupKey`
 * is threaded through so the dispatcher collapses repeats within its TTL window.
 * Stop/target hits map to a `sell` side; informational chain changes to `info`.
 */
export function toAlertEvents(
  alerts: readonly OptionsAlert[],
  username: string,
  timestamp?: number,
): SignalAlertEvent[] {
  return alerts.map((a) => ({
    kind: 'signal',
    username,
    market: 'options',
    symbol: a.symbol,
    signalType: `options_alert_${a.kind}`,
    side: a.kind === 'stop_hit' || a.kind === 'target_hit' ? 'sell' : 'info',
    dedupKey: a.dedupKey,
    timestamp,
  }));
}
