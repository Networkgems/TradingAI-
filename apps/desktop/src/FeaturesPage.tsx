import { RiskDisclaimer } from './LandingPage.tsx';

interface Props {
  /** Single primary CTA — routes to SignUpPage ("Create your account"). */
  onStart: () => void;
  /** Back to the public landing page. */
  onHome: () => void;
  /** Low-emphasis nav link for returning users. */
  onSignIn: () => void;
}

interface StrategyRow {
  name: string;
  what: string;
  beta?: boolean;
}

/** Section A — strategies that run live. Copy verbatim from Copy Deck §3. */
const STRATEGIES: StrategyRow[] = [
  {
    name: 'Opening Range Breakout (ORB)',
    what: "Catches the day's first decisive move on equities, with a trend-regime filter so it sits out choppy markets.",
  },
  {
    name: 'Momentum',
    what: 'Rides established crypto trends using EMA + Donchian breakouts.',
  },
  {
    name: 'Bollinger-Band Fade',
    what: 'Fades overstretched moves back toward the mean, on equities and crypto.',
  },
  {
    name: 'Breakout-Vol',
    what: 'Enters confirmed volatility breakouts in crypto.',
  },
  {
    name: 'Mean-Reversion (crypto)',
    what: 'Buys oversold dislocations with a tighter risk budget.',
  },
  {
    name: 'Ichimoku',
    what: 'Trend/momentum confirmation on equities.',
  },
  {
    name: 'Swing',
    what: 'Multi-day crypto positions on daily candles, no same-day exits.',
  },
  {
    name: 'Perp Shorts',
    what: 'Profits from downside on a curated perp universe, with funding and open-interest filters (1x isolated margin).',
  },
  {
    name: 'SMA-200 Pullback (Signal 2)',
    what: 'Buys equity pullbacks toward the 200-day trend after a confirmed setup.',
    beta: true,
  },
];

/**
 * Public "Features & Strategies" page (logged-out, `authScreen='features'`).
 *
 * Copy is shipped VERBATIM from the Marketing Copy Deck §3 (TRA-752, CEO/CFO
 * signed off) — /TRA/issues/TRA-752#document-marketing-copy-deck. Every row
 * maps to a `working` audit entry, or is explicitly labeled Beta with the
 * audit caveat. Deliberately excluded per the deck's traceability matrix:
 * reversal/MACD/scalping as live, user-selectable 1–3% risk or 1:2/1:3 toggle,
 * manual cash-out signal feed, SMA-200 reclaim (Signal 3) as live, Alpaca,
 * in-app backtesting, in-app P&L analytics. The §5 risk disclaimer is rendered
 * in full in the footer.
 */
export default function FeaturesPage({ onStart, onHome, onSignIn }: Props) {
  return (
    <div className="lp">
      <header className="lp-nav">
        <button type="button" className="lp-brand lp-brand-btn" onClick={onHome}>
          TradeAI
        </button>
        <nav className="lp-nav-links" aria-label="Primary">
          <button type="button" className="lp-nav-link" onClick={onHome}>
            Home
          </button>
          <button type="button" className="lp-nav-link" onClick={onSignIn}>
            Sign in
          </button>
        </nav>
      </header>

      <main className="lp-features">
        {/* ── Page header ───────────────────────────────────────────────── */}
        <section className="lp-section lp-features-intro" aria-labelledby="fp-h1">
          <h1 id="fp-h1" className="lp-h1">
            Everything TradeAI does today
          </h1>
          <p className="lp-subhead">
            A straight list of what's live right now — no roadmap items dressed
            up as features. Items marked Beta are live but ship off by default.
          </p>
        </section>

        {/* ── Section A — Strategies that run live ───────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-a">
          <h2 id="fp-a" className="lp-section-h">Strategies that run live</h2>
          <div className="lp-feature-table lp-ft-2col" role="table" aria-label="Strategies that run live">
            <div className="lp-ft-head" role="row">
              <span role="columnheader">Strategy</span>
              <span role="columnheader">What it does for you</span>
            </div>
            {STRATEGIES.map((s) => (
              <div className="lp-ft-row" role="row" key={s.name}>
                <span role="cell" className="lp-ft-name">
                  {s.name}
                  {s.beta && <span className="lp-beta">Beta</span>}
                </span>
                <span role="cell">{s.what}</span>
              </div>
            ))}
          </div>
          <p className="lp-ft-note">
            Note on SMA-200: only the pullback signal (Signal 2) is live-wired in
            the equity engine; the reclaim signal (Signal 3) is display-only.
          </p>
        </section>

        {/* ── Section B — Risk & money management ────────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-b">
          <h2 id="fp-b" className="lp-section-h">Risk &amp; money management (the part most apps hide)</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Only half your account is ever deployed.</strong> A hard
              50% managed-account ratio keeps the rest in reserve.
            </li>
            <li>
              <strong>Every position is capped.</strong> No single ticket
              exceeds $150 or 15% of equity, whichever is larger.
            </li>
            <li>
              <strong>Small, consistent risk per trade.</strong> A 1% default
              risk budget sizes positions from the stop; some strategies risk
              even less.
            </li>
            <li>
              <strong>Defined reward-to-risk per strategy.</strong> Each strategy
              carries its own reward:risk profile (for example, ORB targets
              ~2:1).
            </li>
            <li>
              <strong>Automatic drawdown brake.</strong> Hit a 10% drawdown and
              position sizing is halved automatically.
            </li>
            <li>
              <strong>Exposure caps.</strong> Total notional stays within 1x
              managed equity, with correlation/cluster limits to avoid stacking
              the same bet.
            </li>
          </ul>
        </section>

        {/* ── Section C — Live signals & monitoring ──────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-c">
          <h2 id="fp-c" className="lp-section-h">Live signals &amp; monitoring</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Live entry signals</strong> stream in real time over a
              secure WebSocket connection.
            </li>
            <li>
              <strong>Automatic exits</strong> — stop-loss, take-profit, and
              trailing stops fire and surface in your feed.
            </li>
            <li>
              <strong>25 high-volume stocks, monitored continuously</strong>,
              re-scanned every 30 seconds with a premarket scan.
            </li>
          </ul>
        </section>

        {/* ── Section D — Markets you can trade ──────────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-d">
          <h2 id="fp-d" className="lp-section-h">Markets you can trade</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Crypto — live today.</strong> Coinbase spot buys/sells and
              INTX perpetual shorts execute as real orders out of the box.
            </li>
            <li>
              <strong>Equities &amp; options — live-capable, opt-in (Beta).</strong>{' '}
              Full live order paths exist via Tradier (equity OTOCO brackets,
              options smart limit entry/exit) but ship in demo/sandbox by
              default; real-money trading requires your own production broker
              credentials and an explicit opt-in.
            </li>
          </ul>
        </section>

        {/* ── Section E — Test before you trust ──────────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-e">
          <h2 id="fp-e" className="lp-section-h">Test before you trust</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Walk-forward backtesting</strong> with rolling
              out-of-sample windows.
            </li>
            <li>
              <strong>Monte-Carlo bootstrap</strong> stress-testing across
              thousands of resampled paths.
            </li>
          </ul>
          <p className="lp-ft-note">
            Note: backtesting runs via the research toolchain, not yet as an
            in-app screen.
          </p>
        </section>

        {/* ── Section F — Platform ──────────────────────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-f">
          <h2 id="fp-f" className="lp-section-h">Platform</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Secure accounts</strong> with signed-token auth and
              per-user isolation.
            </li>
            <li>
              <strong>Demo and Live modes</strong> with mode-scoped settings.
            </li>
            <li>
              <strong>Stocks and Crypto dashboards</strong> — watchlist,
              signals, positions, options, news, calendar.
            </li>
          </ul>
        </section>

        {/* ── CTA ───────────────────────────────────────────────────────── */}
        <section className="lp-cta-band" aria-labelledby="fp-cta">
          <h2 id="fp-cta" className="lp-cta-band-h">See exactly which strategies are live today.</h2>
          <button type="button" className="lp-cta-primary" onClick={onStart}>
            Create your account
          </button>
        </section>
      </main>

      {/* ── Footer (full Section 5 risk disclaimer) ─────────────────────── */}
      <footer className="lp-footer-wrap">
        <RiskDisclaimer />
        <div className="lp-footer">
          <button type="button" className="lp-brand lp-brand-btn" onClick={onHome}>
            TradeAI
          </button>
          <nav className="lp-footer-links" aria-label="Footer">
            <button type="button" className="lp-nav-link" onClick={onHome}>
              Home
            </button>
            <button type="button" className="lp-nav-link" onClick={onSignIn}>
              Sign in
            </button>
          </nav>
        </div>
      </footer>
    </div>
  );
}
