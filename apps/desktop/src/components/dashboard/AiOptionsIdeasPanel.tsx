// TRA-600 (Phase 3 / C5 of TRA-595 "AI Options Ideas") — the new "AI Options
// Ideas" tab. This is the user-facing surface for the event-aware options
// research workflow: ranked, defined-risk ideas (ticker / strategy / thesis /
// POP / max-loss) with event-context badges ("earnings in 3d", "FOMC
// tomorrow"), an IV-rank indicator, a What-If style defined-risk P/L preview,
// and one-click PAPER entry. Live-capital entry is intentionally absent in the
// MVP (gated behind C6 — see the plan §7).
//
// DATA CONTRACT (this panel is the consumer; the producers are the blockers):
//   GET  /api/options/ideas                  -> OptionsIdeasFeed   (C4 TRA-599;
//                                               badges fed by C1/C2 TRA-596/597;
//                                               noDayTrading from C3 TRA-598)
//   POST /api/options/ideas/:id/paper-enter  -> places a PAPER order through the
//                                               existing options-account path.
// Neither endpoint exists yet (they land with C2/C3/C4). Until the live feed
// responds, the panel renders a clearly-labelled PREVIEW using illustrative
// ideas so the surface can be reviewed/screenshotted without being mistaken for
// tradeable signals, and the paper-entry button is disabled. The moment the
// real endpoint returns ideas, this panel renders them with no further change —
// the `source` field flips 'preview' -> 'live' and the banner clears.
//
// House pattern: the contract types are mirrored locally here (same as
// HealthPanel / PromotionGatePanel / VersionChip) rather than imported from
// @trading-app/shared, to avoid colliding with C4's in-flight ownership of the
// server-side shape. C4 should implement against the shape documented here.
import { useEffect, useMemo, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { fmt, fmtDollar } from '../../lib/format';

// ── Contract ───────────────────────────────────────────────────────────────
type EventKind = 'earnings' | 'fomc' | 'cpi' | 'jobs' | 'pce' | 'fed_headline';

interface IdeaEvent {
  kind: EventKind;
  /** Short human label, e.g. "Earnings", "FOMC", "CPI". */
  label: string;
  /** Calendar days until the event (0 = today, 1 = tomorrow). */
  daysAway: number;
}

interface IdeaLeg {
  action: 'buy' | 'sell';
  optionType: 'call' | 'put';
  strike: number;
  /** ISO expiration (yyyy-mm-dd). */
  expiration: string;
}

interface OptionsIdea {
  id: string;
  /** 1-based display rank (C4 emits these pre-sorted; we also sort defensively). */
  rank: number;
  ticker: string;
  underlyingPrice?: number;
  /** e.g. "Bull Put Spread", "Long Call", "Iron Condor". */
  strategy: string;
  thesis: string;
  /** Probability of profit in [0,1]. */
  pop: number;
  /** Defined max loss in USD (positive number = dollars at risk). */
  maxLossUsd: number;
  /** Defined max profit in USD. */
  maxProfitUsd: number;
  /** Net premium: positive = credit received, negative = debit paid. */
  netUsd: number;
  /** Underlying breakeven price(s). */
  breakevens: number[];
  /** IV rank [0,100], if available. */
  ivRank?: number;
  /** Days to expiration of the trade. */
  dte: number;
  events: IdeaEvent[];
  legs: IdeaLeg[];
}

interface OptionsIdeasFeed {
  ideas: OptionsIdea[];
  /** C3 "no day trading" guardrail status, surfaced verbatim from the server. */
  noDayTrading: { enforced: boolean; minHoldDays: number; note: string };
  generatedAt: number;
  /**
   * 'live' once C4 is wired; 'preview' is this panel's local illustrative set;
   * 'non_live' is the server's labelled "wired but no credential / no chains"
   * response (carries `note` explaining exactly what to configure).
   */
  source: 'live' | 'preview' | 'non_live';
  /** Server-supplied reason when source is 'non_live' (e.g. missing LLM credential). */
  note?: string;
}

// ── Preview (illustrative-only) feed ─────────────────────────────────────────
// Used ONLY when the live endpoint is absent/empty. Clearly labelled in the UI
// and never paper-tradeable. Values are internally consistent (defined-risk:
// maxLoss + maxProfit relate to net premium and strike width) so the P/L
// preview and badges render realistically for review.
const PREVIEW_FEED: OptionsIdeasFeed = {
  source: 'preview',
  generatedAt: 0,
  noDayTrading: {
    enforced: true,
    minHoldDays: 2,
    note: 'No day trading: 0DTE and same-session open+close are blocked; ideas target a 21–60 DTE swing window with a 2-day minimum hold.',
  },
  ideas: [
    {
      id: 'preview-msft-bps',
      rank: 1,
      ticker: 'MSFT',
      underlyingPrice: 432.1,
      strategy: 'Bull Put Spread',
      thesis: 'IV-rank elevated into a quiet event window; sell premium below support for defined-risk income. No earnings inside the holding period.',
      pop: 0.72,
      maxLossUsd: 320,
      maxProfitUsd: 180,
      netUsd: 180,
      breakevens: [418.2],
      ivRank: 64,
      dte: 35,
      events: [{ kind: 'fed_headline', label: 'Fed speakers', daysAway: 4 }],
      legs: [
        { action: 'sell', optionType: 'put', strike: 420, expiration: '2026-07-17' },
        { action: 'buy', optionType: 'put', strike: 415, expiration: '2026-07-17' },
      ],
    },
    {
      id: 'preview-nvda-ic',
      rank: 2,
      ticker: 'NVDA',
      underlyingPrice: 121.4,
      strategy: 'Iron Condor',
      thesis: 'High IV-rank with no scheduled catalyst before expiry; range-bound thesis harvests theta with defined wings on both sides.',
      pop: 0.68,
      maxLossUsd: 290,
      maxProfitUsd: 210,
      netUsd: 210,
      breakevens: [110.9, 131.1],
      ivRank: 78,
      dte: 28,
      events: [],
      legs: [
        { action: 'sell', optionType: 'put', strike: 113, expiration: '2026-07-02' },
        { action: 'buy', optionType: 'put', strike: 108, expiration: '2026-07-02' },
        { action: 'sell', optionType: 'call', strike: 129, expiration: '2026-07-02' },
        { action: 'buy', optionType: 'call', strike: 134, expiration: '2026-07-02' },
      ],
    },
    {
      id: 'preview-aapl-cds',
      rank: 3,
      ticker: 'AAPL',
      underlyingPrice: 198.7,
      strategy: 'Call Debit Spread',
      thesis: 'Constructive trend with moderate IV; defined-risk long delta. NOTE: earnings fall inside the window — sized small and capped risk to ride through IV crush.',
      pop: 0.54,
      maxLossUsd: 240,
      maxProfitUsd: 260,
      netUsd: -240,
      breakevens: [201.4],
      ivRank: 41,
      dte: 45,
      events: [{ kind: 'earnings', label: 'Earnings', daysAway: 3 }],
      legs: [
        { action: 'buy', optionType: 'call', strike: 200, expiration: '2026-07-24' },
        { action: 'sell', optionType: 'call', strike: 205, expiration: '2026-07-24' },
      ],
    },
  ],
};

// ── Event badge styling ──────────────────────────────────────────────────────
function eventBadgeColor(kind: EventKind): { bg: string; fg: string } {
  switch (kind) {
    case 'earnings':
      return { bg: 'rgba(245, 158, 11, 0.16)', fg: '#f59e0b' }; // amber — IV-crush risk
    case 'fomc':
    case 'fed_headline':
      return { bg: 'rgba(139, 92, 246, 0.16)', fg: '#a78bfa' }; // violet — macro
    default:
      return { bg: 'rgba(59, 130, 246, 0.16)', fg: '#60a5fa' }; // blue — econ print
  }
}

function eventBadgeText(e: IdeaEvent): string {
  const when =
    e.daysAway <= 0 ? 'today' : e.daysAway === 1 ? 'tomorrow' : `in ${e.daysAway}d`;
  return `${e.label} ${when}`;
}

function EventBadge({ e }: { e: IdeaEvent }) {
  const c = eventBadgeColor(e.kind);
  // Earnings inside the window is the dangerous one (long premium → IV crush);
  // flag it with a warning glyph so it reads at a glance.
  const danger = e.kind === 'earnings' && e.daysAway <= 7;
  return (
    <span
      title={
        danger
          ? 'Earnings fall inside the holding window — long premium is exposed to post-earnings IV crush'
          : `${e.label} event ${e.daysAway <= 0 ? 'today' : `in ${e.daysAway} day(s)`}`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        background: c.bg,
        color: c.fg,
        borderRadius: '999px',
        padding: '0.12rem 0.55rem',
        fontSize: '0.72rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {danger ? '⚠ ' : ''}
      {eventBadgeText(e)}
    </span>
  );
}

// ── IV-rank meter ────────────────────────────────────────────────────────────
function IvRankMeter({ ivRank }: { ivRank: number }) {
  // High IV-rank favours premium SELLING (the plan's defensible edge); colour
  // the meter green→amber→red as rank climbs so "sell-premium" setups read hot.
  const pct = Math.max(0, Math.min(100, ivRank));
  const color = pct >= 60 ? '#ef4444' : pct >= 35 ? '#f59e0b' : '#22c55e';
  return (
    <span
      title={`IV rank ${Math.round(pct)} / 100 — higher favours defined-risk premium selling`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
    >
      <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>IV rank</span>
      <span
        style={{
          position: 'relative',
          width: '46px',
          height: '6px',
          borderRadius: '999px',
          background: 'var(--border, rgba(255,255,255,0.12))',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: color,
            borderRadius: '999px',
          }}
        />
      </span>
      <span style={{ fontSize: '0.72rem', fontWeight: 600, color }}>{Math.round(pct)}</span>
    </span>
  );
}

// ── Defined-risk P/L preview (What-If payoff) ────────────────────────────────
// A compact piecewise-linear payoff sketch for a defined-risk position: the
// curve floors at −maxLoss, caps at +maxProfit, and crosses break-even at the
// idea's breakeven price(s). This mirrors Options AI's "What-If" payoff at a
// glance without re-deriving per-leg greeks (C4 owns the precise modelling; the
// sketch consumes the summary numbers it already emits).
function PayoffPreview({ idea }: { idea: OptionsIdea }) {
  const W = 240;
  const H = 64;
  const padX = 6;
  const padY = 8;

  const maxLoss = Math.max(1, idea.maxLossUsd);
  const maxProfit = Math.max(1, idea.maxProfitUsd);

  // y maps P/L → pixels: +maxProfit at top, −maxLoss at bottom, 0 at the
  // proportional zero line.
  const total = maxProfit + maxLoss;
  const zeroY = padY + (maxProfit / total) * (H - 2 * padY);
  const yFor = (pl: number) => {
    const clamped = Math.max(-maxLoss, Math.min(maxProfit, pl));
    return padY + ((maxProfit - clamped) / total) * (H - 2 * padY);
  };

  // x axis spans the underlying price range we sketch. Anchor around the
  // breakeven(s) and underlying so the kink lands inside the frame.
  const anchors = [
    ...(idea.underlyingPrice != null ? [idea.underlyingPrice] : []),
    ...idea.breakevens,
  ];
  const lo = Math.min(...anchors) * 0.94;
  const hi = Math.max(...anchors) * 1.06;
  const span = Math.max(1e-6, hi - lo);
  const xFor = (price: number) => padX + ((price - lo) / span) * (W - 2 * padX);

  // Build the payoff polyline. Single-breakeven (verticals/long single) is a
  // monotonic ramp from one cap to the other; two-breakeven (condors) is a
  // tent: floor → peak between the breakevens → floor.
  const points = useMemo(() => {
    const bes = [...idea.breakevens].sort((a, b) => a - b);
    const isCredit = idea.netUsd >= 0;
    if (bes.length >= 2) {
      // Range strategy: profit between the breakevens, loss outside.
      const mid = (bes[0] + bes[1]) / 2;
      return [
        [xFor(lo), yFor(-maxLoss)],
        [xFor(bes[0]), yFor(0)],
        [xFor(mid), yFor(maxProfit)],
        [xFor(bes[1]), yFor(0)],
        [xFor(hi), yFor(-maxLoss)],
      ];
    }
    const be = bes[0] ?? (lo + hi) / 2;
    // Credit (e.g. bull put spread): profit to the upside, loss to the
    // downside. Debit (e.g. call debit spread): the mirror.
    if (isCredit) {
      return [
        [xFor(lo), yFor(-maxLoss)],
        [xFor(be), yFor(0)],
        [xFor(hi), yFor(maxProfit)],
      ];
    }
    return [
      [xFor(lo), yFor(-maxLoss)],
      [xFor(be), yFor(0)],
      [xFor(hi), yFor(maxProfit)],
    ];
  }, [idea]); // eslint-disable-line react-hooks/exhaustive-deps

  const poly = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <svg width={W} height={H} role="img" aria-label="Defined-risk P/L preview" style={{ display: 'block' }}>
        {/* zero P/L line */}
        <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="var(--border, rgba(255,255,255,0.18))" strokeWidth={1} strokeDasharray="3 3" />
        {/* max-profit cap / max-loss floor guides */}
        <line x1={padX} y1={yFor(maxProfit)} x2={W - padX} y2={yFor(maxProfit)} stroke="rgba(34,197,94,0.25)" strokeWidth={1} />
        <line x1={padX} y1={yFor(-maxLoss)} x2={W - padX} y2={yFor(-maxLoss)} stroke="rgba(239,68,68,0.25)" strokeWidth={1} />
        {/* payoff curve */}
        <polyline points={poly} fill="none" stroke="var(--accent, #60a5fa)" strokeWidth={2} strokeLinejoin="round" />
        {/* breakeven markers */}
        {idea.breakevens.map((be) => (
          <circle key={be} cx={xFor(be)} cy={zeroY} r={2.5} fill="var(--accent, #60a5fa)" />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.68rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        <span className="green" title="Defined maximum profit">Max +{fmtDollar(idea.maxProfitUsd)}</span>
        <span title="Underlying break-even price(s)">
          B/E {idea.breakevens.map((b) => `$${fmt(b)}`).join(' / ')}
        </span>
        <span className="red" title="Defined maximum loss — your risk is capped at this">Max −{fmtDollar(idea.maxLossUsd)}</span>
      </div>
    </div>
  );
}

// ── Idea card ────────────────────────────────────────────────────────────────
function IdeaCard({
  idea,
  canTrade,
  entering,
  onPaperEnter,
}: {
  idea: OptionsIdea;
  canTrade: boolean;
  entering: boolean;
  onPaperEnter: (idea: OptionsIdea) => void;
}) {
  const popPct = Math.round(idea.pop * 100);
  const popColor = popPct >= 65 ? '#22c55e' : popPct >= 50 ? '#f59e0b' : '#ef4444';
  const riskReward = idea.maxLossUsd > 0 ? idea.maxProfitUsd / idea.maxLossUsd : 0;

  return (
    <div
      style={{
        border: '1px solid var(--border, rgba(255,255,255,0.12))',
        borderRadius: '10px',
        padding: '0.9rem 1rem',
        background: 'var(--panel, rgba(255,255,255,0.02))',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.65rem',
      }}
    >
      {/* header row: rank + ticker + strategy + events */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <span
          title={`Rank #${idea.rank}`}
          style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', minWidth: '1.4rem' }}
        >
          #{idea.rank}
        </span>
        <span className="symbol" style={{ fontSize: '1.05rem', fontWeight: 700 }}>{idea.ticker}</span>
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{idea.strategy}</span>
        {idea.underlyingPrice != null && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>@ ${fmt(idea.underlyingPrice)}</span>
        )}
        <span className="muted" style={{ fontSize: '0.78rem' }}>· {idea.dte}DTE</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          {idea.events.map((e, i) => (
            <EventBadge key={`${e.kind}-${i}`} e={e} />
          ))}
        </span>
      </div>

      {/* thesis */}
      <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.4, color: 'var(--text, inherit)' }}>{idea.thesis}</p>

      {/* metrics + payoff */}
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
          <span title="Probability of profit (model estimate)" style={{ display: 'inline-flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>POP</span>
            <span style={{ fontSize: '1.05rem', fontWeight: 700, color: popColor }}>{popPct}%</span>
          </span>
          <span title="Reward-to-risk (max profit ÷ max loss)" style={{ display: 'inline-flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>R/R</span>
            <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>{riskReward.toFixed(2)}×</span>
          </span>
          {idea.ivRank != null && <IvRankMeter ivRank={idea.ivRank} />}
        </div>
        <span style={{ flex: 1 }} />
        <PayoffPreview idea={idea} />
      </div>

      {/* legs + paper entry */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: '0.74rem' }}>
          {idea.legs
            .map(
              (l) =>
                `${l.action === 'buy' ? '+' : '−'}${l.optionType.toUpperCase()} $${Math.round(l.strike)}`,
            )
            .join('  ')}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn-primary"
          disabled={!canTrade || entering}
          onClick={() => onPaperEnter(idea)}
          title={
            canTrade
              ? 'Place a PAPER order for this defined-risk idea through the options account'
              : 'Paper entry activates when the live AI Options Ideas feed lands (C4 / TRA-599)'
          }
        >
          {entering ? 'Placing…' : 'Paper entry'}
        </button>
      </div>
    </div>
  );
}

// ── Anthropic console API-key setup (TRA-714) ────────────────────────────────
// The "another way" for a user with no server-env access (e.g. a Claude Max
// plan): paste a pay-as-you-go console API key (`sk-ant-api03…`) right here and
// it is stored with your account on the server's persistent disk — no Render
// access required. A Claude subscription token will NOT work (Anthropic
// rate-limits it for server use); the server rejects it with a clear message.
function AnthropicKeySetup({ token, onSaved }: { token: string; onSaved: () => void }) {
  const [status, setStatus] = useState<{ present: boolean; prefix: string } | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`${HTTP_URL}/api/options/anthropic-key`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setStatus((await r.json()) as { present: boolean; prefix: string });
    } catch {
      /* best-effort status read */
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${HTTP_URL}/api/options/anthropic-key`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: value.trim() }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not save the key (HTTP ${r.status}).`);
        return;
      }
      setValue('');
      await refresh();
      onSaved();
    } catch {
      setError('Could not reach the server to save the key.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await fetch(`${HTTP_URL}/api/options/anthropic-key`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      await refresh();
      onSaved();
    } catch {
      setError('Could not reach the server to remove the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--border, rgba(255,255,255,0.14))',
        borderRadius: '8px',
        padding: '0.75rem 0.9rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        fontSize: '0.82rem',
      }}
    >
      <strong style={{ fontSize: '0.86rem' }}>Activate AI Ideas with your own Anthropic key</strong>
      <p style={{ margin: 0, lineHeight: 1.4, color: 'var(--muted)' }}>
        Paste a pay-as-you-go console API key (starts with <code>sk-ant-api03…</code>) from{' '}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          console.anthropic.com → API keys
        </a>
        . It is stored with your account — no server/Render access needed. A Claude Pro/Max
        subscription token will <strong>not</strong> work here (Anthropic rate-limits it for server use).
        This feature is hard-capped at $2/month.
      </p>
      {status?.present && (
        <div className="green" style={{ fontSize: '0.78rem' }}>
          ✓ A console key is installed ({status.prefix}…). Replace it below, or remove it to fall back to
          the server credential.
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="password"
          value={value}
          placeholder="sk-ant-api03-…"
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: '220px',
            padding: '0.4rem 0.6rem',
            borderRadius: '6px',
            border: '1px solid var(--border, rgba(255,255,255,0.18))',
            background: 'var(--panel, rgba(255,255,255,0.03))',
            color: 'var(--text, inherit)',
            fontFamily: 'monospace',
          }}
        />
        <button className="btn-primary" disabled={busy || value.trim().length === 0} onClick={save}>
          {busy ? 'Saving…' : status?.present ? 'Replace key' : 'Save key'}
        </button>
        {status?.present && (
          <button className="btn-secondary" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
      </div>
      {error && (
        <div className="red" style={{ fontSize: '0.78rem', lineHeight: 1.35 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
const POLL_MS = 60_000;

export function AiOptionsIdeasPanel({ token }: { token: string }) {
  const [feed, setFeed] = useState<OptionsIdeasFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  // TRA-714 — bump to force an immediate ideas re-fetch after the user saves or
  // removes their console API key, so the banner clears without waiting a poll.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${HTTP_URL}/api/options/ideas`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          // Endpoint not deployed yet (404 until C4) → fall back to preview.
          if (!cancelled) {
            setFeed(PREVIEW_FEED);
            setLoading(false);
          }
          return;
        }
        const data = (await r.json()) as OptionsIdeasFeed;
        if (cancelled) return;
        // Empty live feed still beats nothing to look at — keep the preview
        // cards so the surface is reviewable, but carry the server's `note`
        // (and 'non_live' source) so the banner can explain exactly why Paper
        // entry is disabled and how to enable it (TRA-714), instead of a
        // generic preview message.
        setFeed(
          data.ideas?.length
            ? { ...data, source: 'live' }
            : { ...PREVIEW_FEED, source: data.source ?? 'preview', note: data.note },
        );
        setLoading(false);
      } catch (err) {
        logger.warn('options-ideas', 'ideas fetch failed; showing preview', err);
        if (!cancelled) {
          setFeed(PREVIEW_FEED);
          setLoading(false);
        }
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, reloadTick]);

  const ideas = useMemo(
    () => (feed ? [...feed.ideas].sort((a, b) => a.rank - b.rank) : []),
    [feed],
  );

  const isLive = feed?.source === 'live';

  async function onPaperEnter(idea: OptionsIdea) {
    if (!isLive) return; // preview ideas are never tradeable
    setEntering((m) => ({ ...m, [idea.id]: true }));
    try {
      const r = await fetch(`${HTTP_URL}/api/options/ideas/${encodeURIComponent(idea.id)}/paper-enter`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        // TRA-1117 — surface the server's specific reason (e.g. "max loss
        // exceeds the per-trade cap") rather than a bare HTTP code, so the user
        // understands WHY an idea didn't open instead of misreading the green
        // "No day trading" status badge as the cause.
        let detail = '';
        try {
          const body = (await r.json()) as { error?: string };
          if (body?.error) detail = ` ${body.error}`;
        } catch {
          /* non-JSON body — fall back to the status code */
        }
        setToast(detail ? detail.trim() : `Could not place paper order (HTTP ${r.status}).`);
      } else {
        setToast(`Paper order placed for ${idea.ticker} ${idea.strategy}. See the Options tab.`);
      }
    } catch {
      setToast('Could not reach the trading server to place the paper order.');
    } finally {
      setEntering((m) => ({ ...m, [idea.id]: false }));
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading AI options ideas…</p>
      </div>
    );
  }

  return (
    <div className="positions-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Preview banner — only when we're not on a live feed. Makes it
          impossible to mistake the illustrative set for tradeable signals. */}
      {!isLive && (
        <div
          style={{
            border: '1px solid rgba(245, 158, 11, 0.4)',
            background: 'rgba(245, 158, 11, 0.1)',
            color: '#f59e0b',
            borderRadius: '8px',
            padding: '0.6rem 0.85rem',
            fontSize: '0.82rem',
            lineHeight: 1.4,
          }}
        >
          <strong>Preview — illustrative ideas only.</strong>{' '}
          {feed?.note ? (
            <>
              Paper entry is disabled because the live feed isn’t running yet:{' '}
              {feed.note} The cards below show the surface, not real signals.
            </>
          ) : (
            <>
              The live AI Options Ideas feed ships with the earnings/Fed feeds, the
              no-day-trading guardrail, and the options-research LLM pass (TRA-597 /
              TRA-598 / TRA-599). Paper entry is disabled until then; the cards below
              show the surface, not real signals.
            </>
          )}
        </div>
      )}

      {/* TRA-714 — when the feed isn't live, offer the in-app console-key setup
          so a user with no server/Render access (e.g. Claude Max) can activate
          it themselves. */}
      {!isLive && <AnthropicKeySetup token={token} onSaved={() => setReloadTick((t) => t + 1)} />}

      {/* C3 "no day trading" status — surfaced clearly per acceptance. */}
      {feed?.noDayTrading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.82rem',
            color: 'var(--muted)',
          }}
        >
          <span
            title={feed.noDayTrading.note}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              background: feed.noDayTrading.enforced ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
              color: feed.noDayTrading.enforced ? '#22c55e' : '#ef4444',
              borderRadius: '999px',
              padding: '0.15rem 0.6rem',
              fontWeight: 600,
            }}
          >
            {feed.noDayTrading.enforced ? '✓ No day trading' : '⚠ Day-trading guard OFF'}
          </span>
          <span>{feed.noDayTrading.note}</span>
        </div>
      )}

      {toast && (
        <div
          className="empty"
          style={{ borderColor: 'var(--accent, #60a5fa)', cursor: 'pointer' }}
          onClick={() => setToast(null)}
          title="Dismiss"
        >
          {toast}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
        <h3 style={{ margin: 0 }}>Ranked Ideas ({ideas.length})</h3>
        <span className="muted" style={{ fontSize: '0.78rem' }}>
          defined-risk · paper-only (live entry gated behind forward-test) · {isLive ? 'live feed' : 'preview'}
        </span>
      </div>

      {ideas.length === 0 ? (
        <div className="empty">
          No ideas right now. The research pass publishes ranked, defined-risk
          ideas when scanner candidates line up with the IV-rank, event-proximity,
          and sentiment filters. Check back after the next pass.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              canTrade={isLive}
              entering={entering[idea.id] === true}
              onPaperEnter={onPaperEnter}
            />
          ))}
        </div>
      )}

      <p className="muted" style={{ fontSize: '0.74rem', margin: 0 }}>
        Ideas are research/education, paper-traded first. No live-capital entry in
        this MVP — live wiring is gated behind a positive paper/forward-test track
        record (TRA-595 plan §5, C6).
      </p>
    </div>
  );
}
