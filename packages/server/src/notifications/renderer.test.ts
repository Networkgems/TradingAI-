import { describe, it, expect } from 'vitest';
import { renderAlert } from './renderer.js';
import type {
  ExitAlertEvent,
  FillAlertEvent,
  RiskHaltAlertEvent,
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
