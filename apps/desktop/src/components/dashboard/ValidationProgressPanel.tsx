// TRA-4729 (design TRA-4733) — net-of-fee forward-validation progress, read
// from the open `/api/health/validation-progress` route (TRA-4607).
//
// ⚠️ THE SPAN LABEL IS READ FROM THE PAYLOAD, NEVER HARD-CODED. The TRA-4733
// spec asked for a fixed "Trailing 30 days" label; since TRA-4727 the graded
// tape is the never-pruned archive ∪ the 30-day calibration window, so that
// label would now be wrong in the other direction. `coverage.earliestFillTs` is
// how far back the evidence actually reaches, and it is what we print. A
// `null` coverage prints "span unknown" rather than guessing.
//
// Deliberately NOT here (spec §3.3):
//   • no progress bar — `requiredN` is derived from the cohort's own σ and
//     moves with the data, so a bar would imply a fixed denominator;
//   • no paraphrase of `note` — it carries the underpowered / blocked /
//     unmeasured distinction and is rendered verbatim;
//   • no polling — the tape changes on fills, not seconds. Manual refresh with
//     a "last updated" stamp instead.
import { useCallback, useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';

interface SleeveVerdict {
  observedN: number;
  observedLiveN: number;
  shortfall: number;
  passes: boolean;
  blockers: string[];
  power: { requiredN: number };
}

interface SleeveProgress {
  sleeve: string;
  verdict: SleeveVerdict;
  feeQuality: { reported: number; derived: number; unknown: number };
  note: string;
}

interface EvidenceCoverage {
  retentionDays: number;
  windowFills: number;
  archivedFills: number;
  evidenceFills: number;
  earliestFillTs: number | null;
  archiveErrors: number;
  ephemeral: boolean;
}

export interface ValidationProgressPayload {
  time?: string;
  fillsSeen: number;
  coverage: EvidenceCoverage | null;
  roundTrips: number;
  excluded: Record<string, number>;
  sleeves: SleeveProgress[];
  unmeasured: boolean;
  note: string;
}

const EXCLUSION_LABELS: Record<string, string> = {
  unattributed: 'Unattributed',
  otherSleeve: 'Other sleeve',
  unpriced: 'Unpriced',
  unreportedFees: 'Unreported fees',
  unmeasuredMid: 'Unmeasured mid',
  stillOpen: 'Still open',
  noMatchingOpen: 'No matching open',
};

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The span label. Exported so the test can pin it against the payload. */
export function evidenceSpanLabel(coverage: EvidenceCoverage | null): string {
  if (!coverage) return 'Evidence span unknown';
  if (coverage.earliestFillTs == null) return 'No fills on the evidence tape yet';
  return `Evidence since ${fmtDate(coverage.earliestFillTs)} · archive + ${coverage.retentionDays}d window`;
}

export function sleeveBadge(v: SleeveVerdict): { text: string; tone: 'pass' | 'pending' | 'blocked' | 'unmeasured' } {
  if (v.passes) return { text: 'PASSES', tone: 'pass' };
  if (v.observedN === 0) return { text: 'UNMEASURED', tone: 'unmeasured' };
  if (v.shortfall > 0) return { text: `${v.observedN} of ${v.power.requiredN} required`, tone: 'pending' };
  return { text: 'BLOCKED', tone: 'blocked' };
}

export function ValidationProgressPanel({ token }: { token: string }) {
  const [report, setReport] = useState<ValidationProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/health/validation-progress`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        setError(`Could not load validation progress (HTTP ${r.status})`);
        return;
      }
      setReport((await r.json()) as ValidationProgressPayload);
      setLoadedAt(new Date());
      setError(null);
    } catch (err) {
      logger.warn('validation-progress', 'fetch failed', err);
      setError('Could not reach the trading server.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const totalExcluded = report
    ? Object.values(report.excluded ?? {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    : 0;

  return (
    <section className="validation-progress-panel" aria-label="Validation progress">
      <header className="validation-progress-panel__head">
        <h3>Validation Progress</h3>
        <span className="validation-progress-panel__window muted">
          {report ? evidenceSpanLabel(report.coverage) : '…'}
        </span>
      </header>

      {!report && !error && <p className="muted">Loading validation progress…</p>}
      {error && <div className="empty">{error}{report ? ' Showing last loaded report.' : ''}</div>}

      {report?.coverage?.ephemeral && (
        <p className="validation-progress-panel__warn">
          ⚠ The evidence tape sits on an EPHEMERAL data dir — it does not survive a redeploy.
        </p>
      )}

      {report && report.unmeasured && (
        <p className="validation-progress-panel__unmeasured">{report.note}</p>
      )}

      {report && !report.unmeasured && (
        <>
          <dl className="validation-progress-panel__summary">
            <div><dt>Fills seen</dt><dd>{report.fillsSeen}</dd></div>
            <div><dt>Round-trips</dt><dd>{report.roundTrips}</dd></div>
            <div><dt>Excluded</dt><dd>{totalExcluded}</dd></div>
          </dl>
          <p className="muted validation-progress-panel__note">{report.note}</p>
          <div className="validation-progress-panel__sleeves">
            {report.sleeves.map(s => {
              const badge = sleeveBadge(s.verdict);
              return (
                <div key={s.sleeve} className="sleeve-progress-card">
                  <div className="sleeve-progress-card__head">
                    <strong>{s.sleeve}</strong>
                    <span className={`sleeve-progress-card__badge sleeve-progress-card__badge--${badge.tone}`}>
                      {badge.text}
                    </span>
                  </div>
                  <p className="sleeve-progress-card__note">{s.note}</p>
                  <div className="sleeve-progress-card__fees muted">
                    <span title="Fees reported by the broker">Reported fees: {s.feeQuality.reported}</span>
                    <span title="Fees inferred from cost/proceeds, not reported">Derived: {s.feeQuality.derived}</span>
                    {s.feeQuality.unknown > 0 && <span title="Unknown fee source">Unknown: {s.feeQuality.unknown}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {report && (
        <details className="validation-progress-panel__exclusions">
          <summary>Exclusions detail</summary>
          <dl>
            {Object.entries(report.excluded ?? {}).map(([k, v]) => (
              <div key={k}><dt>{EXCLUSION_LABELS[k] ?? k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </details>
      )}

      <footer className="validation-progress-panel__foot muted">
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {loadedAt && <span>Last updated {loadedAt.toLocaleTimeString()}</span>}
      </footer>
    </section>
  );
}
