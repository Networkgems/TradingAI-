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
  markets: string;
}

/** Section A — strategies that run live. Copy verbatim from the TRA-754
 *  Features & Strategies Copy Deck §A. The internal "Audit" traceability column
 *  is deliberately NOT rendered. */
const STRATEGIES: StrategyRow[] = [
  {
    name: 'Opening Range Breakout (ORB)',
    what: "Trades the breakout of the first 30 minutes' range, only when the trend filter confirms momentum; targets a 2:1 reward-to-risk.",
    markets: 'Equities',
  },
  {
    name: 'Relative-Value Options Scanner',
    what: 'A quantitative scanner that flags mispriced single-leg options using IV-skew curve fitting and no-arbitrage checks.',
    markets: 'Stock options',
  },
  {
    name: 'Bollinger-Band Fade',
    what: 'A mean-reversion play that fades stretched moves back toward the mean in range-bound tape.',
    markets: 'Equities (long)',
  },
  {
    name: 'Ichimoku Cloud Breakout',
    what: 'Enters on confirmed Ichimoku cloud breakouts.',
    markets: 'Equities',
  },
  {
    name: 'SMA-200 Trend Pullback',
    what: 'Buys pullbacks in line with the longer-term 200-day trend.',
    markets: 'Equities',
  },
];

/**
 * Public "Features & Strategies" page (logged-out, `authScreen='features'`).
 *
 * Copy is shipped VERBATIM from the TRA-754 "Features & Strategies Page — Copy
 * Deck + Spec" issue document (source of truth: the TRA-753 Feature Audit) —
 * /TRA/issues/TRA-754#document-features-strategies-copy.
 *
 * Honesty guardrails enforced here (per the audit's ❌/⚠️ rows):
 *  - The options scanner is described as a quantitative/relative-value scanner,
 *    NEVER as "AI" — there is no LLM/AI surfaced to users on this page.
 *  - No live "Reversal" strategy; no Momentum / MACD-trend / Swing as live.
 *  - No Alpaca broker; no user-facing backtester or strategy builder.
 *  - No user-set "1–3% risk dial" or selectable reward:risk ratio.
 *  - No email/SMS trade alerts; equities/options default to a paper sandbox.
 *  - No performance numbers anywhere.
 *
 * The internal "Audit" traceability column from the deck is NOT rendered. The
 * four required risk disclaimers (deck §"Required risk disclaimers") render in
 * the footer with real visual weight.
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
        {/* ── Page intro ─────────────────────────────────────────────────── */}
        <section className="lp-section lp-features-intro" aria-labelledby="fp-h1">
          <h1 id="fp-h1" className="lp-h1">
            Everything TradeAI does — in plain language.
          </h1>
          <p className="lp-subhead">
            A complete, honest rundown of the strategies that trade your account
            and the controls that keep them in check. If it's in the live list
            below, it's running in the product today; anything in demo
            evaluation is labeled as such.
          </p>
        </section>

        {/* ── Section A — Trading strategies (live) ──────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-a">
          <h2 id="fp-a" className="lp-section-h">Trading strategies (live)</h2>
          <p className="lp-section-intro">
            Five rules-based strategies run across US equities and stock options.
            Each one defines its own entries, exits, and risk.
          </p>
          <div className="lp-feature-table" role="table" aria-label="Trading strategies that run live">
            <div className="lp-ft-head" role="row">
              <span role="columnheader">Strategy</span>
              <span role="columnheader">What it does</span>
              <span role="columnheader">Markets</span>
            </div>
            {STRATEGIES.map((s) => (
              <div className="lp-ft-row" role="row" key={s.name}>
                <span role="cell" className="lp-ft-name">{s.name}</span>
                <span role="cell">{s.what}</span>
                <span role="cell" className="lp-ft-markets">{s.markets}</span>
              </div>
            ))}
          </div>
          <p className="lp-ft-note">
            Note on SMA-200: only the pullback variant trades live; the "reclaim"
            signal is informational only.
          </p>
        </section>

        {/* ── Section B — Risk, sizing & auto-trading ────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-b">
          <h2 id="fp-b" className="lp-section-h">Risk, sizing &amp; auto-trading</h2>
          <p className="lp-section-intro">
            Risk management isn't a setting you remember to turn on — it's wired
            into the engine.
          </p>
          <ul className="lp-feature-list">
            <li>
              <strong>Trades ~half your account.</strong> Auto-trading (opt-in)
              deploys roughly 50% of your account as a built-in capital cap.
            </li>
            <li>
              <strong>~1% risk per trade.</strong> Each position is sized to
              about 1% of your managed equity.
            </li>
            <li>
              <strong>Favorable reward-to-risk by design.</strong> Strategies
              target a 2:1 or better reward-to-risk on their trades — it's an
              output of each strategy, not a knob you pick.
            </li>
            <li>
              <strong>Daily circuit-breaker.</strong> A daily risk governor halts
              new entries after three consecutive losses or a rough day, and
              resets the next session.
            </li>
          </ul>
        </section>

        {/* ── Section C — Brokers, markets & signals ─────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-c">
          <h2 id="fp-c" className="lp-section-h">Brokers, markets &amp; signals</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Equities via Tradier.</strong> Automated bracket orders on
              stocks — paper sandbox by default; real-money trading needs your
              own production credentials.
            </li>
            <li>
              <strong>Options via Tradier.</strong> Live long single-leg premium
              orders — paper sandbox by default.
            </li>
            <li>
              <strong>Live entry &amp; exit signals.</strong> The engine tells
              you when it's getting in and when it's cashing out, and executes
              automatically. Signals are delivered on the dashboard — no
              email/SMS alerts.
            </li>
            <li>
              <strong>25-stock volume watchlist.</strong> A curated 25-symbol
              universe (mega-caps + index ETFs) with premarket movers blended in,
              refreshed before the open — a curated default list, not a
              whole-market volume scan.
            </li>
          </ul>
        </section>

        {/* ── Section D — Platform ───────────────────────────────────────── */}
        <section className="lp-section" aria-labelledby="fp-d">
          <h2 id="fp-d" className="lp-section-h">Platform</h2>
          <ul className="lp-feature-list">
            <li>
              <strong>Real-time dashboard.</strong> A stocks dashboard —
              watchlist, signals, positions, options, news, and calendar —
              updating live.
            </li>
            <li>
              <strong>Daily P&amp;L reports &amp; calendar.</strong> End-of-day
              P&amp;L reporting with an in-app calendar view, reconciled against
              your broker — in-app, with no scheduled email delivery.
            </li>
            <li>
              <strong>Premarket scan &amp; market-review feed.</strong> A
              premarket watchlist build and a market-regime review surfaced in
              the News tab.
            </li>
            <li>
              <strong>Validated by internal backtesting.</strong> Strategies are
              pressure-tested with walk-forward and Monte-Carlo simulation before
              they go live. There is no user-facing backtester or strategy
              builder.
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

      {/* ── Footer (four required risk disclaimers, real visual weight) ──── */}
      <footer className="lp-footer-wrap">
        <FeaturesRiskDisclaimer />
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

/* ── Required risk disclaimers — TRA-754 deck, verbatim, four items ─────────── */
function FeaturesRiskDisclaimer() {
  return (
    <section className="lp-risk" aria-labelledby="fp-risk-h">
      <h2 id="fp-risk-h" className="lp-risk-h">Important risk disclosures</h2>
      <ul className="lp-risk-list">
        <li className="lp-risk-item">
          <strong>Paper-first:</strong> equities &amp; options default to a paper
          sandbox; real-money trading requires your own production broker
          credentials.
        </li>
        <li className="lp-risk-item">
          <strong>Auto-trading is opt-in</strong> and bounded by the daily risk
          governor; results are not guaranteed.
        </li>
        <li className="lp-risk-item">
          <strong>Trading involves substantial risk of loss.</strong> Backtested
          and simulated results do not guarantee future performance. TradeAI is a
          trading tool, not investment advice.
        </li>
      </ul>
    </section>
  );
}
