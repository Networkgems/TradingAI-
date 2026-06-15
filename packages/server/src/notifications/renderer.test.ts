import { describe, it, expect } from 'vitest';
import { renderAlert } from './renderer.js';
import type {
  BriefingAlertEvent,
  ExitAlertEvent,
  FillAlertEvent,
  RiskHaltAlertEvent,
  RoutineAlertEvent,
  SignalAlertEvent,
} from './dispatcher.js';

// 2026-05-17 14:32 ET → fixed epoch so the timestamp footer is deterministic.
// 18:32Z is 14:32 America/New_York (EDT, UTC-4) on that date.
const TS = Date.parse('2026-05-17T18:32:00Z');

describe('renderAlert', () => {
  it('renders a profitable exit like the §1.4 sample', () => {
    const e: ExitAlertEvent = {
      kind: 'exit',
      username: 'alice',
      timestamp: TS,
      symbol: 'ETH-USD',
      market: 'crypto',
      mode: 'live',
      exitReason: 'take-profit @ 3,142.50',
      pnl: 84.2,
      pnlR: 1.32,
      strategy: 'mean-reversion',
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🟢 TradingAI — Position Exited');
    expect(r.text).toContain('ETH-USD  ·  LIVE  ·  mean-reversion');
    expect(r.text).toContain('Exit: take-profit @ 3,142.50');
    expect(r.text).toContain('P&L: +$84.20 (+1.32R)');
    expect(r.text).toContain('2026-05-17 14:32 ET');
    expect(r.subject).toBe('TradingAI — Position Exited: ETH-USD LIVE');
  });

  it('uses a red marker and signed loss for a losing exit', () => {
    const e: ExitAlertEvent = {
      kind: 'exit',
      username: 'bob',
      timestamp: TS,
      symbol: 'AAPL',
      market: 'stocks',
      mode: 'demo',
      exitReason: 'stop-loss',
      pnl: -120.5,
      pnlR: -1,
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🔴 TradingAI — Position Exited');
    expect(r.text).toContain('P&L: -$120.50 (-1R)');
  });

  it('renders a fill', () => {
    const e: FillAlertEvent = {
      kind: 'fill',
      username: 'alice',
      timestamp: TS,
      symbol: 'TSLA',
      market: 'stocks',
      mode: 'live',
      side: 'buy',
      quantity: 10,
      price: 250.25,
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🔵 TradingAI — Order Filled');
    expect(r.text).toContain('Buy 10 @ 250.25');
    expect(r.text).toContain('TSLA  ·  LIVE');
  });

  it('renders a signal with levels', () => {
    const e: SignalAlertEvent = {
      kind: 'signal',
      username: 'alice',
      timestamp: TS,
      symbol: 'BTC-USD',
      market: 'crypto',
      signalType: 'orb',
      side: 'long',
      entryPrice: 65000,
      stopLoss: 64000,
      takeProfit: 67000,
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🔔 TradingAI — New Trade Signal');
    expect(r.text).toContain('BTC-USD  ·  orb');
    expect(r.text).toContain('entry 65,000');
    expect(r.text).toContain('SL 64,000');
    expect(r.text).toContain('TP 67,000');
  });

  it('renders a risk halt', () => {
    const e: RiskHaltAlertEvent = {
      kind: 'risk_halt',
      username: 'alice',
      timestamp: TS,
      mode: 'live',
      reason: 'daily loss cap reached',
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🛑 TradingAI — Risk Halt Triggered');
    expect(r.text).toContain('LIVE');
    expect(r.text).toContain('daily loss cap reached');
  });

  it('HTML-escapes user-influenced strings', () => {
    const e: SignalAlertEvent = {
      kind: 'signal',
      username: 'alice',
      timestamp: TS,
      symbol: '<script>',
      market: 'stocks',
      signalType: 'x&y',
      side: 'long',
    };
    const r = renderAlert(e);
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('x&amp;y');
    expect(r.html).not.toContain('<script>');
  });

  // ── TRA-849 morning brief ──────────────────────────────────────────────────

  it('renders a full morning brief with all four sections', () => {
    const e: BriefingAlertEvent = {
      kind: 'briefing',
      username: 'alice',
      timestamp: TS,
      date: '2026-05-17',
      macro: {
        regime: 'yellow',
        rationale: 'VIX elevated at 24; breakouts gated.',
        indexes: [
          { label: 'VIX', value: 24.1, note: 'elevated' },
          { label: '10Y Yield', value: 4.32 },
          { label: 'Credit (HYG)', value: null, note: 'feed down' },
        ],
      },
      setups: [
        { symbol: 'AAPL', signalType: 'orb_long', side: 'buy', entryPrice: 150, stopLoss: 147, takeProfit: 156 },
      ],
      positions: [
        { symbol: 'ETH-USD', market: 'crypto', side: 'long', quantity: 2, entryPrice: 3140, pnl: 84.2 },
      ],
      news: [{ title: 'Fed holds rates steady', source: 'Reuters' }],
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🟡 TradingAI — Morning Brief 2026-05-17');
    expect(r.subject).toBe('TradingAI — Morning Brief 2026-05-17 (regime YELLOW)');
    // Macro
    expect(r.text).toContain('Macro gate: 🟡 YELLOW');
    expect(r.text).toContain('VIX 24.1 — elevated');
    expect(r.text).toContain('Credit (HYG) — — feed down');
    // Setups
    expect(r.text).toContain('AAPL · orb_long · buy · entry 150 · SL 147 · TP 156');
    // Positions
    expect(r.text).toContain('ETH-USD CRYPTO · long 2 @ 3,140 · P&L +$84.20');
    // News
    expect(r.text).toContain('Fed holds rates steady (Reuters)');
    expect(r.text).toContain('2026-05-17 14:32 ET');
    expect(r.html.length).toBeGreaterThan(0);
  });

  it('renders explicit "none" for empty brief sections', () => {
    const e: BriefingAlertEvent = {
      kind: 'briefing',
      username: 'bob',
      timestamp: TS,
      date: '2026-05-17',
      macro: { regime: 'green', rationale: '', indexes: [] },
      setups: [],
      positions: [],
      news: [],
    };
    const r = renderAlert(e);
    expect(r.title).toBe('🟢 TradingAI — Morning Brief 2026-05-17');
    expect(r.text).toContain('Watchlist setups (0)');
    expect(r.text).toContain('Open positions (0)');
    expect(r.text).toContain('Overnight news (0)');
    expect(r.text.match(/• none/g)?.length).toBe(3);
  });

  it('HTML-escapes brief news + setup strings', () => {
    const e: BriefingAlertEvent = {
      kind: 'briefing',
      username: 'alice',
      timestamp: TS,
      date: '2026-05-17',
      macro: { regime: 'green', rationale: '<b>ok</b>', indexes: [] },
      setups: [],
      positions: [],
      news: [{ title: '<script>x</script>', source: 'A&B' }],
    };
    const r = renderAlert(e);
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('A&amp;B');
    expect(r.html).not.toContain('<script>x');
  });

  // ── TRA-851 routine ────────────────────────────────────────────────────────

  it('frames a routine push with headline + body + timestamp', () => {
    const e: RoutineAlertEvent = {
      kind: 'routine',
      username: 'alice',
      timestamp: TS,
      routineId: 'r1',
      date: '2026-05-17',
      title: 'Routine: scan (semis)',
      body: 'Scan (semis) — 1 signal(s):\n  NVDA long orb @ 120.50',
    };
    const r = renderAlert(e);
    expect(r.title).toBe('⏰ TradingAI — Routine: scan (semis)');
    expect(r.subject).toBe('TradingAI — Routine: scan (semis)');
    expect(r.text).toContain('NVDA long orb @ 120.50');
    expect(r.text).toContain('2026-05-17 14:32 ET');
    expect(r.html.length).toBeGreaterThan(0);
  });

  it('HTML-escapes a routine body', () => {
    const e: RoutineAlertEvent = {
      kind: 'routine',
      username: 'alice',
      timestamp: TS,
      routineId: 'r1',
      date: '2026-05-17',
      title: 'Routine: status',
      body: '<b>equity</b> & cash',
    };
    const r = renderAlert(e);
    expect(r.html).toContain('&lt;b&gt;equity&lt;/b&gt; &amp; cash');
    expect(r.html).not.toContain('<b>equity');
  });

  it('produces a non-empty html and a text/html pair for every kind', () => {
    const e: FillAlertEvent = {
      kind: 'fill',
      username: 'a',
      timestamp: TS,
      symbol: 'X',
      market: 'stocks',
      mode: 'demo',
      side: 'sell',
      quantity: 1,
      price: 1,
    };
    const r = renderAlert(e);
    expect(r.html.length).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.subject.length).toBeGreaterThan(0);
  });
});
