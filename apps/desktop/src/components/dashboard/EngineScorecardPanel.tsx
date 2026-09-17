// TRA-1141 (TRA-1139) — compact "engine scorecard" panel: the two idea engines
// side by side on out-of-sample data, so the board can compare them honestly
// instead of guessing "which is more accurate". Binds the read-only, secrets-free
// `GET /api/health/engine-scorecard` probe.
//
// Like HealthPanel/PromotionGatePanel, every number shown is the SERVER's computed
// value — we never recompute a metric. The only client logic is mapping the API's
// sample-adequacy label to a display tone. The panel deliberately surfaces the
// API's winner-free `comparison.note` verbatim and badges small/insufficient
// samples, so a thin sample can never read as a winner.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';

type SampleLabel = 'insufficient' | 'thin' | 'adequate';

interface SampleAdequacy {
  n: number;
  minSample: number;
  label: SampleLabel;
  sufficient: boolean;
}

// Mirror of the server's engine-scorecard shape (packages/server/src/engine-scorecard.ts).
// Not exported from @trading-app/shared, so the read fields are mirrored locally —
// same pattern as HealthPanel/PromotionGatePanel.
interface ProposalsScorecard {
  available: boolean;
  source: string;
  agent: { winRate: number | null; avgR: number | null; n: number };
  baseline: { winRate: number | null; avgR: number | null; n: number };
  edgeVsBaseline: { winRateDelta: number | null; avgRDelta: number | null };
  horizonBars: number | null;
  totalRecommendations: number;
  sample: SampleAdequacy;
  generatedWindow: { start: string; end: string } | null;
}

interface AiIdeasScorecard {
  available: boolean;
  source: string;
  surfaced: number;
  resolved: number;
  open: number;
  excluded: number;
  hitRate: number | null;
  expectancyR: number | null;
  expectancyNetR: number | null;
  avgPredictedPop: number | null;
  popCalibrationGap: number | null;
  maxLossBreaches: number;
  sample: SampleAdequacy;
}

interface EngineScorecard {
  proposals: ProposalsScorecard;
  aiIdeas: AiIdeasScorecard;
  comparison: { bothSamplesSufficient: boolean; note: string };
}

const POLL_MS = 60_000;

function pct(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Number((n * 100).toFixed(decimals))}%`;
}

function rmult(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n.toFixed(2));
  return `${v > 0 ? '+' : ''}${v}R`;
}

function sampleTone(s: SampleAdequacy): 'ok' | 'warn' | 'bad' {
  return s.label === 'adequate' ? 'ok' : s.label === 'thin' ? 'warn' : 'bad';
}

function SampleBadge({ s }: { s: SampleAdequacy }) {
  const tone = sampleTone(s);
  return (
    <span className={`health-row-value health-${tone}`} title={`n=${s.n}, floor=${s.minSample}`}>
      n={s.n} · {s.label}
    </span>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="health-row">
      <span className="health-row-label">{label}</span>
      <span className={`health-row-value${tone ? ` health-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function ProposalsCard({ p }: { p: ProposalsScorecard }) {
  if (!p.available) {
    return (
      <div className="health-panel">
        <div className="health-panel-head">Proposals · equity (OOS A/B)</div>
        <div className="health-panel-body">
          <p className="muted" style={{ fontSize: '0.85em' }}>{p.source}</p>
        </div>
      </div>
    );
  }
  const edgeTone = p.edgeVsBaseline.avgRDelta == null
    ? undefined
    : p.edgeVsBaseline.avgRDelta > 0 ? 'ok' : 'bad';
  return (
    <div className="health-panel">
      <div className="health-panel-head">Proposals · equity (OOS A/B)</div>
      <div className="health-panel-body">
        <Row label="Sample (routable trades)" value={<SampleBadge s={p.sample} />} />
        <Row label="Agent win-rate" value={pct(p.agent.winRate)} />
        <Row label="Agent avg-R" value={rmult(p.agent.avgR)} />
        <Row label="Baseline win-rate" value={pct(p.baseline.winRate)} />
        <Row label="Edge vs baseline (win-rate)" value={pct(p.edgeVsBaseline.winRateDelta)} tone={edgeTone} />
        <Row label="Edge vs baseline (avg-R)" value={rmult(p.edgeVsBaseline.avgRDelta)} tone={edgeTone} />
        <Row label="Horizon" value={p.horizonBars != null ? `${p.horizonBars} bars` : '—'} />
      </div>
    </div>
  );
}

function AiIdeasCard({ a }: { a: AiIdeasScorecard }) {
  const calTone = a.popCalibrationGap == null
    ? undefined
    : Math.abs(a.popCalibrationGap) <= 0.1 ? 'ok' : 'warn';
  return (
    <div className="health-panel">
      <div className="health-panel-head">AI Ideas · defined-risk options (forward-test)</div>
      <div className="health-panel-body">
        <Row label="Sample (resolved priced)" value={<SampleBadge s={a.sample} />} />
        <Row label="Hit-rate" value={pct(a.hitRate)} />
        <Row label="Mean predicted POP" value={pct(a.avgPredictedPop)} />
        <Row
          label="POP calibration gap"
          value={a.popCalibrationGap == null ? '—' : pct(a.popCalibrationGap)}
          tone={calTone}
        />
        <Row label="Expectancy (net R)" value={rmult(a.expectancyNetR)} tone={a.expectancyNetR != null ? (a.expectancyNetR > 0 ? 'ok' : 'bad') : undefined} />
        <Row label="Open / excluded" value={`${a.open} / ${a.excluded}`} />
        <Row label="Max-loss breaches" value={a.maxLossBreaches} tone={a.maxLossBreaches > 0 ? 'bad' : 'ok'} />
      </div>
    </div>
  );
}

export function EngineScorecardPanel() {
  const [card, setCard] = useState<EngineScorecard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Read-only, secrets-free probe — no auth header needed.
        const r = await fetch(`${HTTP_URL}/api/health/engine-scorecard`);
        if (!r.ok) {
          if (!cancelled) setError(`Could not load engine scorecard (HTTP ${r.status})`);
          return;
        }
        const data = (await r.json()) as Partial<EngineScorecard>;
        if (cancelled) return;
        // Defensive shape guard — only render a genuine scorecard payload (the
        // panel shares an auth/fetch surface with other health reads in tests).
        if (!data || !data.proposals || !data.aiIdeas || !data.comparison) {
          setError(null);
          return;
        }
        setCard(data as EngineScorecard);
        setError(null);
      } catch (err) {
        logger.warn('engine-scorecard', 'fetch failed; will retry', err);
        if (!cancelled) setError('Could not reach the trading server.');
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!card && !error) return null; // quiet until first load — it's an auxiliary panel
  if (error && !card) return <div className="health-issues muted">{error}</div>;

  const c = card!;
  return (
    <div className="engine-scorecard">
      <div className="health-issues-head">Engine accuracy scorecard (OOS)</div>
      <p className="muted" style={{ fontSize: '0.85em', margin: '4px 0 10px' }}>{c.comparison.note}</p>
      <div className="health-grid">
        <ProposalsCard p={c.proposals} />
        <AiIdeasCard a={c.aiIdeas} />
      </div>
    </div>
  );
}
