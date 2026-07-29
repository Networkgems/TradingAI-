// TRA-566 (TRA-410 A2) — shared event→message renderer.
//
// A single renderer turns a typed {@link AlertEvent} into one {@link RenderedAlert}
// (subject + plain text + minimal HTML) that every channel adapter reuses:
//   • email  → subject + html (falls back to text),
//   • Telegram → text (sent with parse_mode=HTML, so the html is also valid),
//   • Discord → text (posted as webhook `content`).
//
// The format follows the §1.4 sample payload:
//     🟢 TradingAI — Position Exited
//     ETH-USD  ·  LIVE  ·  mean-reversion
//     Exit: take-profit @ 3,142.50    P&L: +$84.20 (+1.32R)
//     2026-05-17 14:32 ET
//
// Pure + side-effect-free (no I/O, no module singletons) so it is trivially
// unit-testable and safe to call on every dispatch.

import type {
  AlertEvent,
  BriefingAlertEvent,
  BriefMacroIndex,
  BriefPosition,
  BriefSetup,
  ExitAlertEvent,
  FillAlertEvent,
  ReportAlertEvent,
  ReportPeriodStats,
  RiskHaltAlertEvent,
  RoutineAlertEvent,
  SignalAlertEvent,
} from './dispatcher.js';

/**
 * Events with their own multi-line render path (briefing's structured digest,
 * routine's pre-rendered title+body, the report's stats table); everything else
 * uses the compact single-context path below.
 */
type SimpleAlertEvent = Exclude<
  AlertEvent,
  BriefingAlertEvent | RoutineAlertEvent | ReportAlertEvent
>;

export interface RenderedAlert {
  /** Headline incl. status emoji, e.g. "🟢 TradingAI — Position Exited". */
  title: string;
  /** Email subject line (no emoji — some clients render it poorly in subjects). */
  subject: string;
  /** Plain-text body — used verbatim by Telegram/Discord and as the email text part. */
  text: string;
  /** Minimal HTML body for the email channel. Also valid Telegram HTML. */
  html: string;
}

// ── small formatting helpers ─────────────────────────────────────────────────

/** Compact price/number formatting with thousands separators. */
function fmtNum(n: number, maxFrac = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
}

/** Unsigned USD with fixed 2dp, e.g. "$25,000.00". Used for equity levels. */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed USD with fixed 2dp, e.g. "+$84.20" / "-$12.00". */
function fmtSignedUsd(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

/** "2026-05-17 14:32 ET" in US/Eastern (the desk's reference tz). */
function fmtTimestamp(ts: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // TRA-2498 — `hourCycle: 'h23'`, not `hour12: false`: the latter renders
      // midnight as "24:00" on Node 20 (the prod runtime), so an email sent in
      // the 00:00–00:59 ET hour was stamped "24:32 ET". Cosmetic-only here (no
      // gate reads this), but it is the same defect.
      hourCycle: 'h23',
    }).formatToParts(new Date(ts));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    // Belt-and-braces for any ICU that still emits h24 despite the option.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')} ET`;
  } catch {
    return new Date(ts).toISOString();
  }
}

/** HTML-escape so symbols/strategy names can never break the email markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── per-kind rendering ───────────────────────────────────────────────────────

interface Rendered {
  emoji: string;
  /** Short noun phrase, e.g. "Position Exited". */
  headline: string;
  /** Context line: "ETH-USD · LIVE · mean-reversion". */
  context: string;
  /** One or more detail lines. */
  lines: string[];
}

function renderFill(e: FillAlertEvent): Rendered {
  return {
    emoji: '🔵',
    headline: 'Order Filled',
    context: joinContext(e.symbol, e.mode, e.strategy),
    lines: [
      `${capitalize(e.side)} ${fmtNum(e.quantity, 6)} @ ${fmtNum(e.price)}`,
    ],
  };
}

function renderExit(e: ExitAlertEvent): Rendered {
  const profit = (e.pnl ?? 0) >= 0;
  const pnlBits: string[] = [];
  if (e.pnl != null) {
    const r = e.pnlR != null ? ` (${e.pnlR >= 0 ? '+' : ''}${fmtNum(e.pnlR)}R)` : '';
    pnlBits.push(`P&L: ${fmtSignedUsd(e.pnl)}${r}`);
  }
  const exitBit = e.exitReason ? `Exit: ${e.exitReason}` : 'Exited';
  return {
    emoji: profit ? '🟢' : '🔴',
    headline: 'Position Exited',
    context: joinContext(e.symbol, e.mode, e.strategy),
    lines: [[exitBit, ...pnlBits].join('    ')],
  };
}

function renderSignal(e: SignalAlertEvent): Rendered {
  const levels: string[] = [];
  if (e.entryPrice != null) levels.push(`entry ${fmtNum(e.entryPrice)}`);
  if (e.stopLoss != null) levels.push(`SL ${fmtNum(e.stopLoss)}`);
  if (e.takeProfit != null) levels.push(`TP ${fmtNum(e.takeProfit)}`);
  const lines = [`${capitalize(e.side)} signal`];
  if (levels.length) lines.push(levels.join('  ·  '));
  return {
    emoji: '🔔',
    headline: 'New Trade Signal',
    context: joinContext(e.symbol, undefined, e.signalType),
    lines,
  };
}

function renderRiskHalt(e: RiskHaltAlertEvent): Rendered {
  return {
    emoji: '🛑',
    headline: 'Risk Halt Triggered',
    context: e.mode.toUpperCase(),
    lines: [e.reason],
  };
}

function renderBody(event: SimpleAlertEvent): Rendered {
  switch (event.kind) {
    case 'fill':
      return renderFill(event);
    case 'exit':
      return renderExit(event);
    case 'signal':
      return renderSignal(event);
    case 'risk_halt':
      return renderRiskHalt(event);
  }
}

// ── public entry ─────────────────────────────────────────────────────────────

/** Render a typed alert event into a channel-agnostic message. Pure. */
export function renderAlert(event: AlertEvent, now: number = Date.now()): RenderedAlert {
  // TRA-849 — the morning brief is a multi-section digest, not a single-line
  // alert, so it gets its own render path rather than the compact context+lines
  // format shared by fill/exit/signal/risk_halt.
  if (event.kind === 'briefing') return renderBriefing(event, event.timestamp ?? now);
  // TRA-851 — a routine carries an already-rendered title + body; just frame it.
  if (event.kind === 'routine') return renderRoutine(event, event.timestamp ?? now);
  // TRA-2252 — the scheduled P&L report is a stats table, not a single-line alert.
  if (event.kind === 'report') return renderReport(event, event.timestamp ?? now);

  const r = renderBody(event);
  const ts = event.timestamp ?? now;
  const stamp = fmtTimestamp(ts);

  const title = `${r.emoji} TradingAI — ${r.headline}`;
  const subject = `TradingAI — ${r.headline}: ${plainContext(event)}`;

  const text = [title, r.context, ...r.lines, stamp].filter(Boolean).join('\n');

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9;background:#0d1117;padding:24px;border-radius:8px;max-width:520px;">`,
    `<div style="font-size:18px;font-weight:600;margin-bottom:4px;">${esc(title)}</div>`,
    `<div style="color:#8b949e;font-size:14px;margin-bottom:12px;">${esc(r.context)}</div>`,
    ...r.lines.map(
      (l) => `<div style="font-size:15px;margin:2px 0;">${esc(l)}</div>`,
    ),
    `<div style="color:#484f58;font-size:12px;margin-top:14px;">${esc(stamp)}</div>`,
    `</div>`,
  ].join('');

  return { title, subject, text, html };
}

// ── TRA-851 routine rendering ────────────────────────────────────────────────

/**
 * Frame a user-defined routine's pre-rendered output into a channel-agnostic
 * message. The body is already formatted by the routine executor (scan rows /
 * status / positions / brief); this only adds the headline + timestamp and the
 * email HTML wrapper, preserving the body's line breaks as separate rows.
 */
function renderRoutine(event: RoutineAlertEvent, ts: number): RenderedAlert {
  const title = `⏰ TradingAI — ${event.title}`;
  const subject = `TradingAI — ${event.title}`;
  const stamp = fmtTimestamp(ts);
  const bodyLines = event.body.split('\n');

  const text = [title, '', ...bodyLines, '', stamp].join('\n');

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9;background:#0d1117;padding:24px;border-radius:8px;max-width:560px;">`,
    `<div style="font-size:18px;font-weight:600;margin-bottom:8px;">${esc(title)}</div>`,
    ...bodyLines.map(
      (l) => `<div style="font-size:14px;margin:2px 0;color:#c9d1d9;white-space:pre;">${esc(l)}</div>`,
    ),
    `<div style="color:#484f58;font-size:12px;margin-top:14px;">${esc(stamp)}</div>`,
    `</div>`,
  ].join('');

  return { title, subject, text, html };
}

// ── internals ────────────────────────────────────────────────────────────────

function joinContext(symbol: string, mode?: string, tag?: string): string {
  return [symbol, mode ? mode.toUpperCase() : undefined, tag]
    .filter((s): s is string => !!s)
    .join('  ·  ');
}

/** A short symbol/mode tag for the email subject line. */
function plainContext(event: SimpleAlertEvent): string {
  switch (event.kind) {
    case 'fill':
    case 'exit':
      return `${event.symbol} ${event.mode.toUpperCase()}`;
    case 'signal':
      return `${event.symbol} ${event.signalType}`;
    case 'risk_halt':
      return event.mode.toUpperCase();
  }
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// ── TRA-849 morning brief rendering ──────────────────────────────────────────

const REGIME_EMOJI: Record<string, string> = { green: '🟢', yellow: '🟡', red: '🔴' };

/** Format a macro-index reading: "VIX 18.4 — calm" / "Credit (HYG) — feed down". */
function fmtMacroIndex(ix: BriefMacroIndex): string {
  const val = ix.value != null && Number.isFinite(ix.value) ? fmtNum(ix.value) : '—';
  const note = ix.note ? ` — ${ix.note}` : '';
  return `${ix.label} ${val}${note}`;
}

/** Format one watchlist setup row: "AAPL · orb_long · buy · entry 150 · SL 147 · TP 156". */
function fmtSetup(s: BriefSetup): string {
  const bits = [s.symbol, s.signalType, s.side];
  const levels: string[] = [];
  if (s.entryPrice != null) levels.push(`entry ${fmtNum(s.entryPrice)}`);
  if (s.stopLoss != null) levels.push(`SL ${fmtNum(s.stopLoss)}`);
  if (s.takeProfit != null) levels.push(`TP ${fmtNum(s.takeProfit)}`);
  return [bits.join(' · '), ...levels].join(' · ');
}

/** Format one open position row: "ETH-USD CRYPTO · long 2 @ 3,140 · P&L +$84.20". */
function fmtPosition(p: BriefPosition): string {
  const head = `${p.symbol} ${p.market.toUpperCase()}`;
  const det = p.detail ? ` ${p.detail}` : '';
  const core = `${p.side} ${fmtNum(p.quantity, 6)} @ ${fmtNum(p.entryPrice)}`;
  const pnl = p.pnl != null ? ` · P&L ${fmtSignedUsd(p.pnl)}` : '';
  return `${head}${det} · ${core}${pnl}`;
}

/**
 * TRA-849 — render the multi-section morning brief into one channel-agnostic
 * message. Pure. Empty sections render an explicit "none" line rather than being
 * dropped, so the reader can tell "no open positions" from "section missing".
 */
function renderBriefing(event: BriefingAlertEvent, ts: number): RenderedAlert {
  const emoji = REGIME_EMOJI[event.macro.regime.toLowerCase()] ?? '⚪';
  const regimeLabel = event.macro.regime.toUpperCase();
  const title = `${emoji} TradingAI — Morning Brief ${event.date}`;
  const subject = `TradingAI — Morning Brief ${event.date} (regime ${regimeLabel})`;

  // ── plain-text body ──
  const lines: string[] = [title, ''];

  lines.push(`📊 Macro gate: ${emoji} ${regimeLabel}`);
  if (event.macro.rationale) lines.push(`   ${event.macro.rationale}`);
  if (event.macro.indexes.length) {
    for (const ix of event.macro.indexes) lines.push(`   • ${fmtMacroIndex(ix)}`);
  }
  lines.push('');

  lines.push(`🎯 Watchlist setups (${event.setups.length})`);
  if (event.setups.length) {
    for (const s of event.setups) lines.push(`   • ${fmtSetup(s)}`);
  } else {
    lines.push('   • none');
  }
  lines.push('');

  lines.push(`📁 Open positions (${event.positions.length})`);
  if (event.positions.length) {
    for (const p of event.positions) lines.push(`   • ${fmtPosition(p)}`);
  } else {
    lines.push('   • none');
  }
  lines.push('');

  lines.push(`📰 Overnight news (${event.news.length})`);
  if (event.news.length) {
    for (const n of event.news) lines.push(`   • ${n.title} (${n.source})`);
  } else {
    lines.push('   • none');
  }
  lines.push('');

  const stamp = fmtTimestamp(ts);
  lines.push(stamp);
  const text = lines.join('\n');

  // ── HTML body ──
  const section = (heading: string, rows: string[]): string =>
    [
      `<div style="font-size:15px;font-weight:600;margin:14px 0 4px;">${esc(heading)}</div>`,
      ...rows.map(
        (r) => `<div style="font-size:14px;margin:2px 0;color:#c9d1d9;">${esc(r)}</div>`,
      ),
    ].join('');

  const macroRows = [
    ...(event.macro.rationale ? [event.macro.rationale] : []),
    ...event.macro.indexes.map(fmtMacroIndex),
  ];
  const setupRows = event.setups.length ? event.setups.map(fmtSetup) : ['none'];
  const posRows = event.positions.length ? event.positions.map(fmtPosition) : ['none'];
  const newsRows = event.news.length
    ? event.news.map((n) => `${n.title} (${n.source})`)
    : ['none'];

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9;background:#0d1117;padding:24px;border-radius:8px;max-width:560px;">`,
    `<div style="font-size:18px;font-weight:600;margin-bottom:8px;">${esc(title)}</div>`,
    section(`Macro gate: ${regimeLabel}`, macroRows),
    section(`Watchlist setups (${event.setups.length})`, setupRows),
    section(`Open positions (${event.positions.length})`, posRows),
    section(`Overnight news (${event.news.length})`, newsRows),
    `<div style="color:#484f58;font-size:12px;margin-top:14px;">${esc(stamp)}</div>`,
    `</div>`,
  ].join('');

  return { title, subject, text, html };
}

// ── TRA-2252 scheduled P&L report rendering ──────────────────────────────────

const CADENCE_TITLE: Record<ReportAlertEvent['cadence'], string> = {
  daily: 'Daily Report',
  weekly: 'Weekly Report',
  monthly: 'Monthly Report',
  yearly: 'Yearly Report',
};

/**
 * TRA-2252 — render the scheduled P&L + trade-summary report into one channel-
 * agnostic message, matching the dark theme the other alerts use. Pure. The
 * emoji follows the period's net P&L sign so a losing period reads at a glance;
 * an empty period never reaches here (the aggregator skips it), so `bestDay`/
 * `worstDay` are only absent for a genuinely flat-but-active period.
 */
function renderReport(event: ReportAlertEvent, ts: number): RenderedAlert {
  const s: ReportPeriodStats = event.stats;
  const up = s.totalPnl >= 0;
  const emoji = up ? '📈' : '📉';
  const cadenceName = CADENCE_TITLE[event.cadence];
  const title = `${emoji} TradingAI — ${cadenceName} (${event.periodLabel})`;
  const subject = `TradingAI — ${cadenceName}: ${fmtSignedUsd(s.totalPnl)} (${event.periodLabel})`;

  // The rows both the text body and the HTML table share, in one place so they
  // can never drift apart.
  const rows: Array<[string, string]> = [
    ['Net P&L', fmtSignedUsd(s.totalPnl)],
    ['Stocks P&L', fmtSignedUsd(s.stockPnl)],
    ['Options P&L', fmtSignedUsd(s.optionsPnl)],
    ['Closed trades', String(s.totalTrades)],
    ['Trading days', `${s.tradingDays} (${s.winDays} up / ${s.lossDays} down)`],
    ['Start equity', fmtUsd(s.startEquity)],
    ['End equity', fmtUsd(s.endEquity)],
  ];
  if (s.bestDay) rows.push(['Best day', `${s.bestDay.date}  ${fmtSignedUsd(s.bestDay.pnl)}`]);
  if (s.worstDay) rows.push(['Worst day', `${s.worstDay.date}  ${fmtSignedUsd(s.worstDay.pnl)}`]);

  const stamp = fmtTimestamp(ts);

  const text = [
    title,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    stamp,
  ].join('\n');

  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#8b949e;font-size:14px;">${esc(k)}</td>` +
        `<td style="padding:4px 0;color:#c9d1d9;font-size:14px;font-weight:600;">${esc(v)}</td></tr>`,
    )
    .join('');

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9;background:#0d1117;padding:24px;border-radius:8px;max-width:520px;">`,
    `<div style="font-size:18px;font-weight:600;margin-bottom:4px;">${esc(title)}</div>`,
    `<div style="color:#8b949e;font-size:13px;margin-bottom:12px;">${esc(`${event.periodStart} → ${event.periodEnd}`)}</div>`,
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${tableRows}</table>`,
    `<div style="color:#484f58;font-size:12px;margin-top:14px;">${esc(stamp)}</div>`,
    `</div>`,
  ].join('');

  return { title, subject, text, html };
}
