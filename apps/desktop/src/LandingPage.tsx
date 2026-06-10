interface Props {
  /** Single primary CTA — routes to SignUpPage ("Create your account"). */
  onStart: () => void;
  /** Secondary, visually subordinate link to the Features & Strategies page. */
  onFeatures: () => void;
  /** Low-emphasis nav link for returning users. */
  onSignIn: () => void;
}

/**
 * Public landing / front page (logged-out route, `authScreen='landing'`).
 *
 * Copy is shipped VERBATIM from the Marketing Copy Deck §2 (TRA-752, CEO/CFO
 * signed off) — see /TRA/issues/TRA-752#document-marketing-copy-deck. Every
 * claim maps to a `working` audit row or carries the audit caveat; no invented
 * performance/return numbers appear anywhere. The Section 5 risk disclaimer is
 * rendered in full in the footer and condensed under the hero CTA.
 *
 * Visual direction: TRA-765 Visual / UI Spec (single-column rhythm, F-pattern
 * hierarchy, single high-contrast primary CTA, secondary actions as text
 * links, abstract chart motif with descriptive alt text, WCAG AA contrast).
 */
export default function LandingPage({ onStart, onFeatures, onSignIn }: Props) {
  return (
    <div className="lp">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="lp-nav">
        <span className="lp-brand">TradeAI</span>
        <nav className="lp-nav-links" aria-label="Primary">
          <button type="button" className="lp-nav-link" onClick={onFeatures}>
            Features &amp; strategies
          </button>
          <button type="button" className="lp-nav-link" onClick={onSignIn}>
            Sign in
          </button>
        </nav>
      </header>

      <main>
        {/* ── 1. Hero ───────────────────────────────────────────────────── */}
        <section className="lp-hero" aria-labelledby="lp-hero-h1">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Multi-asset auto-trading</p>
            <h1 id="lp-hero-h1" className="lp-h1">
              Disciplined trading, on autopilot.
            </h1>
            <p className="lp-subhead">
              TradeAI scans crypto and equities for rules-based setups, sizes
              every position to protect your capital, and signals the exact
              moment it enters or exits — so you don't have to stare at charts.
            </p>
            <div className="lp-cta-row">
              <button type="button" className="lp-cta-primary" onClick={onStart}>
                Create your account
              </button>
              <button type="button" className="lp-cta-secondary" onClick={onFeatures}>
                See features &amp; strategies <span aria-hidden="true">→</span>
              </button>
            </div>
            <p className="lp-cta-note">Starts in demo mode. Real-money trading is opt-in.</p>
            <p className="lp-cta-fineprint">
              Trading involves substantial risk of loss. Not financial advice. Equities &amp; options start in demo; crypto is real-money only.
            </p>
          </div>
          <DashboardMock />
        </section>

        {/* ── 2. Value pillars (3-up, benefit-led) ──────────────────────── */}
        <section className="lp-section" aria-label="Why TradeAI">
          <div className="lp-cards">
            <article className="lp-card">
              <CardIcon kind="shield" />
              <h2 className="lp-card-h">Risk-first by design</h2>
              <p className="lp-card-lead">Keep losses small by default.</p>
              <p className="lp-card-b">
                The engine deploys only 50% of your account, caps each position
                at $150 or 15% of equity (whichever is larger), and applies a
                default 1% risk-per-trade budget with an automatic drawdown
                brake.
              </p>
            </article>
            <article className="lp-card">
              <CardIcon kind="watch" />
              <h2 className="lp-card-h">Always watching, never guessing</h2>
              <p className="lp-card-lead">Setups found for you, around the clock.</p>
              <p className="lp-card-b">
                Named, tested strategies run live on a fixed 25 high-volume
                stock universe and a curated crypto list, re-evaluated every 30
                seconds.
              </p>
            </article>
            <article className="lp-card">
              <CardIcon kind="signal" />
              <h2 className="lp-card-h">Know the moment it acts</h2>
              <p className="lp-card-lead">Live entry signals, automatic exits.</p>
              <p className="lp-card-b">
                Real-time buy signals stream over a live connection; stop-loss,
                take-profit, and trailing exits fire and surface automatically.
              </p>
            </article>
          </div>
        </section>

        {/* ── 3. Strategy proof strip ───────────────────────────────────── */}
        <section className="lp-section lp-strip" aria-label="Live strategies">
          <div className="lp-chips">
            {[
              'Opening Range Breakout',
              'Momentum',
              'Bollinger-Band Fade',
              'Breakout-Vol',
              'Mean-Reversion',
              'Ichimoku',
              'Swing',
              'Perp Shorts',
            ].map((name) => (
              <span key={name} className="lp-chip">{name}</span>
            ))}
          </div>
          <p className="lp-chips-caption">
            Eight live strategies across equities and crypto.
          </p>
        </section>

        {/* ── 4. How it works ───────────────────────────────────────────── */}
        <section className="lp-section lp-how" aria-labelledby="lp-how-h">
          <h2 id="lp-how-h" className="lp-section-h">How it works</h2>
          <ol className="lp-steps">
            <li className="lp-step">
              <span className="lp-step-num" aria-hidden="true">1</span>
              <div>
                <h3 className="lp-step-h">Connect &amp; choose your mode.</h3>
                <p className="lp-step-b">
                  Start in demo with simulated capital, or opt in to live
                  trading with your own broker credentials.
                </p>
              </div>
            </li>
            <li className="lp-step">
              <span className="lp-step-num" aria-hidden="true">2</span>
              <div>
                <h3 className="lp-step-h">The engine works your plan.</h3>
                <p className="lp-step-b">
                  It scans the universe, applies your risk budget, and only acts
                  on setups that clear its filters.
                </p>
              </div>
            </li>
            <li className="lp-step">
              <span className="lp-step-num" aria-hidden="true">3</span>
              <div>
                <h3 className="lp-step-h">You stay informed.</h3>
                <p className="lp-step-b">
                  Live signals tell you when it enters; automatic exits manage
                  the downside.
                </p>
              </div>
            </li>
          </ol>
        </section>

        {/* ── 5. Secondary CTA band ─────────────────────────────────────── */}
        <section className="lp-cta-band" aria-labelledby="lp-cta-h">
          <h2 id="lp-cta-h" className="lp-cta-band-h">Built to protect capital first.</h2>
          <p className="lp-cta-band-b">
            See exactly which strategies and risk controls are live today.
          </p>
          <button type="button" className="lp-cta-secondary lp-cta-band-link" onClick={onFeatures}>
            Explore features &amp; strategies <span aria-hidden="true">→</span>
          </button>
        </section>
      </main>

      {/* ── Footer (full Section 5 risk disclaimer) ─────────────────────── */}
      <footer className="lp-footer-wrap">
        <RiskDisclaimer />
        <div className="lp-footer">
          <span className="lp-brand">TradeAI</span>
          <nav className="lp-footer-links" aria-label="Footer">
            <button type="button" className="lp-nav-link" onClick={onFeatures}>
              Features &amp; strategies
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

/* ── Required trading-risk disclaimer — Copy Deck §5, verbatim ─────────────── */
export function RiskDisclaimer() {
  return (
    <section className="lp-risk" aria-labelledby="lp-risk-h">
      <h2 id="lp-risk-h" className="lp-risk-h">Risk disclosure</h2>
      <p className="lp-risk-body">
        TradeAI is automated trading software, not financial advice. Trading
        equities, options, and crypto involves substantial risk, including the
        possible loss of your entire investment. Automated strategies can and do
        lose money; past or simulated performance does not guarantee future
        results. Equities and options start in demo mode — real-money trading is
        opt-in and requires your own production broker credentials. Crypto is
        real-money only and has no paper mode. You are solely responsible for
        your trading decisions. No representation is made that any account will
        or is likely to achieve profits.
      </p>
    </section>
  );
}

/* ── Hero graphic ──────────────────────────────────────────────────────────
 * Lightweight inline mock of the real-time dashboard (signal feed + open
 * positions + 25-stock watchlist). Abstract chart/grid motif only — no
 * fabricated equity curves or P&L numbers. Decorative chrome is aria-hidden;
 * the figure carries descriptive alt text via role="img" + aria-label.
 */
function DashboardMock() {
  return (
    <div
      className="lp-mock"
      role="img"
      aria-label="TradeAI dashboard mock showing a live signal feed, open positions, and the 25-stock volume watchlist updating in real time."
    >
      <div className="lp-mock-bar" aria-hidden="true">
        <span className="lp-mock-dot" />
        <span className="lp-mock-dot" />
        <span className="lp-mock-dot" />
        <span className="lp-mock-bar-label">TradeAI — live</span>
      </div>
      <div className="lp-mock-body" aria-hidden="true">
        <div className="lp-mock-panel">
          <span className="lp-mock-panel-h">Signals</span>
          <div className="lp-mock-row"><span className="lp-tag lp-buy">BUY</span><span>NVDA · ORB</span></div>
          <div className="lp-mock-row"><span className="lp-tag lp-sell">EXIT</span><span>AAPL · BB-Fade</span></div>
          <div className="lp-mock-row"><span className="lp-tag lp-buy">BUY</span><span>BTC · Mean-Rev</span></div>
        </div>
        <div className="lp-mock-panel">
          <span className="lp-mock-panel-h">Positions</span>
          <div className="lp-mock-row"><span>MSFT</span><span className="lp-pos-up">open</span></div>
          <div className="lp-mock-row"><span>SPY</span><span className="lp-pos-up">open</span></div>
          <div className="lp-mock-row"><span>ETH-PERP</span><span className="lp-pos-dn">short</span></div>
        </div>
        <div className="lp-mock-panel lp-mock-watch">
          <span className="lp-mock-panel-h">Watchlist · 25</span>
          <div className="lp-mock-spark">
            {[38, 52, 44, 61, 49, 70, 58, 66].map((h, i) => (
              <span key={i} className="lp-mock-spark-bar" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Decorative card icons (aria-hidden; the card heading carries meaning) ── */
function CardIcon({ kind }: { kind: 'watch' | 'shield' | 'signal' }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'lp-card-icon',
  };
  if (kind === 'watch') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (kind === 'shield') {
    return (
      <svg {...common}>
        <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3 17l5-6 4 3 4-6 5 4" />
      <circle cx="8" cy="11" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
