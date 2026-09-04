import { describe, it, expect } from 'vitest';
import { renderAlert } from './renderer.js';
import type {
  BriefingAlertEvent,
  ExitAlertEvent,
  FillAlertEvent,
  ReportAlertEvent,
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
    // TRA-4303 — relabelled: this section is the engine's `recentSignals` tail,
    // which at the 08:30 fire is the PRIOR session's, never today's.
    expect(r.text).toContain('Prior-session engine signals (0)');
    expect(r.text).not.toContain('Watchlist setups');
    expect(r.text).toContain('Open positions (0)');
    expect(r.text).toContain('Overnight news (0)');
    // TRA-4303 — still 3, not 4: this event carries no `overnight`, and an
    // absent overnight read is omitted rather than rendered as an empty one.
    expect(r.text).not.toContain('Overnight setups');
    expect(r.text.match(/• none/g)?.length).toBe(3);
  });

  // ── TRA-4303 overnight setups ──────────────────────────────────────────────

  /** A brief carrying only the fields the overnight assertions need. */
  function briefWith(overnight: BriefingAlertEvent['overnight']): BriefingAlertEvent {
    return {
      kind: 'briefing',
      username: 'alice',
      timestamp: TS,
      date: '2026-05-17',
      macro: { regime: 'green', rationale: '', indexes: [] },
      setups: [],
      positions: [],
      news: [],
      ...(overnight ? { overnight } : {}),
    };
  }

  it('renders overnight setups above the prior-session signals, with legs and move size', () => {
    const r = renderAlert(
      briefWith({
        available: true,
        rows: [
          { symbol: 'NVDA', legs: ['prior-close mover', 'pre-market gainer'], changePct: 8.421, score: 9, eligibility: { status: 'eligible' } },
          { symbol: 'SOFI', legs: ['traded yesterday'], score: 3, eligibility: { status: 'watched' } },
        ],
      }),
    );
    expect(r.text).toContain('Overnight setups (2)');
    expect(r.text).toContain('NVDA · prior-close mover + pre-market gainer · +8.42%');
    // No move size on hand ⇒ the row still renders, without a fabricated number.
    expect(r.text).toContain('SOFI · traded yesterday');
    expect(r.text).not.toMatch(/SOFI[^\n]*%/);
    // Ordering: the overnight read is the only section that knows about last
    // night, so it comes first.
    expect(r.text.indexOf('Overnight setups')).toBeLessThan(
      r.text.indexOf('Prior-session engine signals'),
    );
    // Email path carries it too — that is the channel the board reads.
    expect(r.html).toContain('Overnight setups (2)');
    expect(r.html).toContain('+8.42%');
  });

  it('distinguishes an unavailable overnight section from an empty one', () => {
    const dead = renderAlert(
      briefWith({ available: false, rows: [], note: 'prior-session report unavailable; pre-market scan unavailable' }),
    );
    expect(dead.text).toContain('Overnight setups');
    expect(dead.text).toContain('• unavailable — prior-session report unavailable; pre-market scan unavailable');
    expect(dead.text).not.toContain('Overnight setups (0)');

    const empty = renderAlert(briefWith({ available: true, rows: [] }));
    expect(empty.text).toContain('Overnight setups (0)');
    expect(empty.text).not.toContain('unavailable');
  });

  it('keeps a one-legged overnight read but says which leg died', () => {
    const r = renderAlert(
      briefWith({
        available: true,
        rows: [{ symbol: 'AMD', legs: ['pre-market gainer'], changePct: -3.1, score: 4, eligibility: { status: 'eligible' } }],
        note: 'prior-session report unavailable',
      }),
    );
    expect(r.text).toContain('AMD · pre-market gainer · -3.10%');
    expect(r.text).toContain('(partial — prior-session report unavailable)');
  });

  // TRA-4303 AC-4 — eligibility is a column, not a claim.
  it('renders the eligibility column, and a rejection names its gate', () => {
    const r = renderAlert(
      briefWith({
        available: true,
        rows: [
          { symbol: 'NVDA', legs: ['prior-close mover'], score: 5, eligibility: { status: 'eligible' } },
          { symbol: 'AAPL', legs: ['traded yesterday'], score: 3, eligibility: { status: 'watched' } },
          {
            symbol: 'FAMI',
            legs: ['pre-market gainer'],
            changePct: 41.2,
            score: 4,
            eligibility: { status: 'blocked', gate: 'watchlist price floor $5.00 (last $0.15)' },
          },
          {
            symbol: 'VSXY',
            legs: ['trending'],
            score: 1,
            eligibility: { status: 'unknown', gate: 'watchlist price floor - no pre-open price' },
          },
        ],
      }),
    );
    expect(r.text).toContain('NVDA · prior-close mover · eligible');
    expect(r.text).toContain('AAPL · traded yesterday · already watched');
    expect(r.text).toContain('FAMI · pre-market gainer · +41.20% · BLOCKED (watchlist price floor $5.00 (last $0.15))');
    // Absent price must NOT read as eligible.
    expect(r.text).toContain('VSXY · trending · eligibility unknown');
    expect(r.text).not.toContain('VSXY · trending · eligible');
  });

  it('publishes the gate values in force, split by whether they were decidable pre-open', () => {
    const r = renderAlert(
      briefWith({
        available: true,
        rows: [{ symbol: 'NVDA', legs: ['prior-close mover'], score: 5, eligibility: { status: 'eligible' } }],
        gates: {
          decidedPreOpen: ['watchlist price floor $5.00 (shared constant, no env override)'],
          deferred: ['contract premium floor $0.50 · |delta| [0.25, 0.4]'],
        },
      }),
    );
    expect(r.text).toContain('gates in force: watchlist price floor $5.00');
    // The deferred group must never read as adjudicated.
    expect(r.text).toContain('not decidable pre-open (needs a live option quote): contract premium floor $0.50');
    expect(r.html).toContain('not decidable pre-open');
  });

  it('HTML-escapes overnight setup strings', () => {
    const r = renderAlert(
      briefWith({ available: true, rows: [{ symbol: '<script>x</script>', legs: ['A&B'], score: 1, eligibility: { status: 'blocked', gate: '<b>g&g</b>' } }] }),
    );
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('A&amp;B');
    expect(r.html).not.toContain('<script>x');
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

  // ── TRA-2252 scheduled P&L report ──────────────────────────────────────────

  it('renders a scheduled P&L report as a stats table', () => {
    const e: ReportAlertEvent = {
      kind: 'report',
      username: 'alice',
      timestamp: TS,
      cadence: 'weekly',
      periodStart: '2026-05-11',
      periodEnd: '2026-05-17',
      periodLabel: 'Weekly — 2026-05-11 to 2026-05-17',
      stats: {
        totalPnl: 350.5,
        stockPnl: 300.5,
        optionsPnl: 50,
        totalTrades: 5,
        tradingDays: 3,
        winDays: 2,
        lossDays: 1,
        startEquity: 25_000,
        endEquity: 25_350.5,
        bestDay: { date: '2026-05-14', pnl: 250, trades: 3 },
        worstDay: { date: '2026-05-12', pnl: -40, trades: 1 },
      },
    };
    const r = renderAlert(e);
    expect(r.title).toBe('📈 TradingAI — Weekly Report (Weekly — 2026-05-11 to 2026-05-17)');
    expect(r.subject).toContain('+$350.50');
    // Table carries the labelled rows in both parts.
    expect(r.text).toContain('Net P&L: +$350.50');
    expect(r.text).toContain('Best day: 2026-05-14  +$250.00');
    expect(r.text).toContain('Worst day: 2026-05-12  -$40.00');
    expect(r.html).toContain('End equity');
    expect(r.html).toContain('$25,350.50');
  });

  it('uses a losing-period emoji when net P&L is negative', () => {
    const e: ReportAlertEvent = {
      kind: 'report',
      username: 'alice',
      timestamp: TS,
      cadence: 'daily',
      periodStart: '2026-05-17',
      periodEnd: '2026-05-17',
      periodLabel: 'Daily — 2026-05-17',
      stats: {
        totalPnl: -120,
        stockPnl: -120,
        optionsPnl: 0,
        totalTrades: 2,
        tradingDays: 1,
        winDays: 0,
        lossDays: 1,
        startEquity: 25_000,
        endEquity: 24_880,
      },
    };
    const r = renderAlert(e);
    expect(r.title.startsWith('📉')).toBe(true);
    expect(r.subject).toContain('-$120.00');
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
