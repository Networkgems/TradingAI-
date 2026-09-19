// TRA-4729 — Validation Progress panel. The load-bearing property is the SPAN
// LABEL: since TRA-4727 the graded tape is archive ∪ window, so the label must
// come from `coverage.earliestFillTs`, never from a literal. The design spec
// (TRA-4733) asked for a fixed "Trailing 30 days"; the tests below fail if that
// literal ever comes back.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ValidationProgressPanel,
  evidenceSpanLabel,
  sleeveBadge,
  type ValidationProgressPayload,
} from './ValidationProgressPanel';

const EARLIEST = Date.parse('2026-06-02T14:31:00Z');

function payload(over: Partial<ValidationProgressPayload> = {}): ValidationProgressPayload {
  return {
    fillsSeen: 22,
    coverage: {
      retentionDays: 30,
      windowFills: 10,
      archivedFills: 12,
      evidenceFills: 22,
      earliestFillTs: EARLIEST,
      archiveErrors: 0,
      ephemeral: false,
    },
    roundTrips: 6,
    excluded: { unattributed: 3, otherSleeve: 1, unpriced: 0, unreportedFees: 0, unmeasuredMid: 0, stillOpen: 2, noMatchingOpen: 4 },
    sleeves: [
      {
        sleeve: 'single_leg_otm',
        verdict: { observedN: 6, observedLiveN: 6, shortfall: 721, passes: false, blockers: [], power: { requiredN: 727 } },
        feeQuality: { reported: 1, derived: 5, unknown: 0 },
        note: 'Underpowered: 6 of 727 required round-trips.',
      },
    ],
    unmeasured: false,
    note: 'Report caveat verbatim.',
    ...over,
  };
}

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evidenceSpanLabel', () => {
  it('names how far back the tape reaches — archive + window, from the payload', () => {
    const label = evidenceSpanLabel(payload().coverage);
    expect(label).toContain('2026-06-02');
    expect(label).toContain('30d window');
    expect(label).not.toMatch(/trailing/i);
  });

  it('follows the payload: a different earliest fill gives a different label', () => {
    const a = evidenceSpanLabel(payload().coverage);
    const b = evidenceSpanLabel({ ...payload().coverage!, earliestFillTs: Date.parse('2026-09-01T00:00:00Z') });
    expect(a).not.toBe(b);
    expect(b).toContain('2026-09-01');
  });

  it('never guesses: null coverage and an empty tape each say so', () => {
    expect(evidenceSpanLabel(null)).toBe('Evidence span unknown');
    expect(evidenceSpanLabel({ ...payload().coverage!, earliestFillTs: null })).toBe('No fills on the evidence tape yet');
  });
});

describe('sleeveBadge', () => {
  const v = payload().sleeves[0].verdict;
  it('prints observed-of-required as TEXT (requiredN moves with σ — no bar)', () => {
    expect(sleeveBadge(v)).toEqual({ text: '6 of 727 required', tone: 'pending' });
  });
  it('separates PASSES / UNMEASURED / BLOCKED', () => {
    expect(sleeveBadge({ ...v, passes: true }).text).toBe('PASSES');
    expect(sleeveBadge({ ...v, observedN: 0 }).text).toBe('UNMEASURED');
    expect(sleeveBadge({ ...v, shortfall: 0 }).text).toBe('BLOCKED');
  });
});

describe('ValidationProgressPanel', () => {
  it('renders the span from the payload, the sleeve note verbatim, and no progress bar', async () => {
    stubFetch(payload());
    render(<ValidationProgressPanel token="t" />);
    expect(await screen.findByText(/Evidence since 2026-06-02/)).toBeInTheDocument();
    expect(screen.queryByText(/Trailing 30 days/i)).not.toBeInTheDocument();
    expect(screen.getByText('Underpowered: 6 of 727 required round-trips.')).toBeInTheDocument();
    expect(screen.getByText('6 of 727 required')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // Excluded total = sum of the exclusion buckets (3+1+2+4).
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('unmeasured is rendered as the report note, not as a failing sleeve', async () => {
    stubFetch(payload({ unmeasured: true, sleeves: [], note: 'UNMEASURED — no graded sleeve has a priced round-trip.' }));
    render(<ValidationProgressPanel token="t" />);
    expect(await screen.findByText('UNMEASURED — no graded sleeve has a priced round-trip.')).toBeInTheDocument();
    expect(screen.queryByText('BLOCKED')).not.toBeInTheDocument();
  });

  it('warns when the evidence tape is on an ephemeral data dir', async () => {
    stubFetch(payload({ coverage: { ...payload().coverage!, ephemeral: true } }));
    render(<ValidationProgressPanel token="t" />);
    expect(await screen.findByText(/EPHEMERAL/)).toBeInTheDocument();
  });

  it('surfaces an HTTP failure and refetches only on demand', async () => {
    const fn = stubFetch({}, 503);
    render(<ValidationProgressPanel token="t" />);
    expect(await screen.findByText(/HTTP 503/)).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });
});
