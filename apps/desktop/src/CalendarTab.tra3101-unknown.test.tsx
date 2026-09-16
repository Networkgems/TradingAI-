import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import type { EodReport } from '@trading-app/shared';
import { CalendarTab } from './CalendarTab';
import {
  LIVE_JUNE_2026_DATES,
  LIVE_JUNE_2026_REPORTS,
  COHORT_DATE,
  LIVE_FLAT_BUT_MEASURED_DATES,
} from './tra3101-live-june-2026.fixture';

// TRA-3101 · A5 — THE RENDER HALF.
//
// The server half of this ticket is graded (TRA-3113): `GET /api/reports/
// 2026-06-12?mode=live` returns `pnlUnknown.reason = "stale_balance_anchor"`.
// That is the server refusing to claim a number. A5 is the other half, and it is
// the half a human actually experiences: does the CALENDAR stop rendering that
// day as a flat `$0.00`?
//
// ⚠️ The instrument problem this file exists to solve. A render test fed a
// hand-written `{ pnlUnknown: {...} }` row proves almost nothing: the fixture and
// the component were written by the same head, so it agrees with itself. Both
// sides here are therefore pinned to something outside this file —
//
//   · the INPUT is the verbatim live payload for all 22 stored June 2026 cells,
//     pulled from bqb1 build f3ce18b6 (see the fixture header), and
//   · the FAILING direction is reconstructed from the SAME live bytes with the
//     server's stamp deleted. That is not a hypothetical: it is byte-for-byte
//     the row the live server served BEFORE c472bc6, i.e. the incident. Every
//     positive assertion below is paired with its value on that row.
//
// If some future edit makes the grid ignore `pnlUnknown` again, the `RESTORED`
// block flips from asserting `$0.00` to failing — the control is load-bearing,
// not decorative.

const HTTP = 'http://test.local';

/**
 * How many of the 22 stored June rows the STOCKS calendar actually renders.
 *
 * Derived, not hard-coded: 2026-06-14 is a Sunday and the live book really does
 * carry a weekend-dated row for it (-$200.91), which TRA-369's filter drops
 * before any summary sees it. Computing it here means the P&L assertions below
 * cannot be quietly satisfied by the wrong month arithmetic.
 */
const VISIBLE_JUNE_ROWS = LIVE_JUNE_2026_DATES.filter(d => {
  const [y, m, day] = d.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return dow !== 0 && dow !== 6;
}).length;

/** Strip the server's stamp — reconstructs the pre-c472bc6 payload exactly. */
function withoutStamp(reports: Record<string, EodReport>): Record<string, EodReport> {
  const out: Record<string, EodReport> = {};
  for (const [date, r] of Object.entries(reports)) {
    const { pnlUnknown: _dropped, ...rest } = r as EodReport & { pnlUnknown?: unknown };
    out[date] = rest as EodReport;
  }
  return out;
}

/**
 * Serve the fixture over a stubbed `fetch`, exactly as the component asks for it:
 * the dates list first, then one request per day.
 */
function stubFetch(reports: Record<string, EodReport>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(HTTP, '').split('?')[0];
    if (path === '/api/reports') {
      return { ok: true, json: async () => ({ dates: LIVE_JUNE_2026_DATES }) } as Response;
    }
    const m = /^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (m && reports[m[1]]) {
      return { ok: true, json: async () => reports[m[1]] } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
}

/**
 * Render and page back to June 2026.
 *
 * The number of clicks is derived from the real clock rather than faked, so this
 * neither depends on `vi.setSystemTime` nor drifts as the calendar year rolls.
 */
async function renderJune2026(reports: Record<string, EodReport>) {
  stubFetch(reports);
  const view = render(
    <CalendarTab token="tok" httpUrl={HTTP} mode="live" market="stocks" isAdmin={false} />,
  );
  // The load has settled when the date filter has been populated from it. (The
  // month summary is NOT a usable signal: the calendar opens on the CURRENT
  // month, which this June-only fixture has no rows for, so it renders nothing.)
  await waitFor(() =>
    expect(view.container.querySelector(`option[value="${COHORT_DATE}"]`)).toBeTruthy(),
  );

  const now = new Date();
  const steps = (now.getFullYear() - 2026) * 12 + (now.getMonth() - 5); // 5 = June
  expect(steps).toBeGreaterThanOrEqual(0);
  const prev = view.container.querySelectorAll('.cal-nav-btn')[0] as HTMLElement;
  for (let i = 0; i < steps; i++) fireEvent.click(prev);

  await waitFor(() => expect(screen.getByText('June 2026')).toBeInTheDocument());
  return view;
}

/** The grid cell for an ISO date, found by its day number within the month grid. */
function cellFor(container: HTMLElement, iso: string): HTMLElement {
  const dayNum = String(Number(iso.slice(8, 10)));
  const cells = Array.from(container.querySelectorAll('.cal-grid .cal-cell')) as HTMLElement[];
  const hit = cells.find(c => c.querySelector('.cal-day-num')?.textContent === dayNum);
  if (!hit) throw new Error(`no grid cell for ${iso}`);
  return hit;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TRA-3101 A5 — the live stale-anchor cell renders as UNKNOWN, not as $0.00', () => {
  it('LIVE: the 2026-06-12 cell shows `?` in the unknown state and prints no zero', async () => {
    const { container } = await renderJune2026(LIVE_JUNE_2026_REPORTS);
    const cell = cellFor(container, COHORT_DATE);

    // The figure itself.
    const pnl = cell.querySelector('.cal-pnl') as HTMLElement;
    expect(pnl.textContent).toBe('?');
    expect(pnl.className).toContain('cal-pnl--unknown');

    // The tint: neither win nor loss, and its own state class. `.cal-cell--unknown`
    // is amber in the shipped stylesheet; green/red are what the incident rendered.
    expect(cell.className).toContain('cal-cell--unknown');
    expect(cell.className).not.toContain('cal-cell--win');
    expect(cell.className).not.toContain('cal-cell--loss');

    // The claim the ticket is named after must not appear anywhere in the cell.
    expect(cell.textContent).not.toMatch(/0\.00/);
    expect(cell.textContent).not.toMatch(/\$/);

    // The server's own prose travels to the reader as the tooltip, so the cell is
    // self-explaining rather than merely blank.
    expect(pnl.getAttribute('title')).toContain('did not land');
  });

  it('RESTORED (the incident): the SAME live bytes minus the stamp render a flat $0.00', async () => {
    // This is the control. Everything about the row is identical -- same equity,
    // same `combinedPnl: 0`, same open position -- except the server no longer
    // says it cannot measure it. That is precisely the state of production
    // between June and 2026-08-06, and it must be VISIBLY different here.
    const { container } = await renderJune2026(withoutStamp(LIVE_JUNE_2026_REPORTS));
    const cell = cellFor(container, COHORT_DATE);
    const pnl = cell.querySelector('.cal-pnl') as HTMLElement;

    expect(pnl.textContent).toBe('$0.00');
    expect(pnl.className).not.toContain('cal-pnl--unknown');
    expect(cell.className).not.toContain('cal-cell--unknown');
    expect(screen.queryByText(/could not be measured/)).toBeNull();
  });

  it('the five other live cells that are ALSO exactly $0.00 are left alone', async () => {
    // The render must key on the server's stamp, not on the zero. Without this
    // pairing, a component that flagged every 0.00 cell would pass the first test.
    const { container } = await renderJune2026(LIVE_JUNE_2026_REPORTS);
    for (const iso of LIVE_FLAT_BUT_MEASURED_DATES) {
      const cell = cellFor(container, iso);
      const pnl = cell.querySelector('.cal-pnl') as HTMLElement;
      expect(`${iso} -> ${pnl.textContent}`).toBe(`${iso} -> $0.00`);
      expect(`${iso} -> ${pnl.className}`).not.toContain('cal-pnl--unknown');
      expect(`${iso} -> ${cell.className}`).not.toContain('cal-cell--unknown');
    }
  });

  it('the month summary names the excluded date and drops it from the denominator', async () => {
    const { container } = await renderJune2026(LIVE_JUNE_2026_REPORTS);

    const note = container.querySelector('.cal-summary-unknown') as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.textContent).toContain('1 day could not be measured');
    expect(note.textContent).toContain('EXCLUDED');
    expect(note.textContent).toContain(COHORT_DATE); // the date is NAMED, not just counted
    expect(note.textContent).toContain('unknown, not $0.00');

    // The denominator, derived rather than asserted flat: 22 stored live cells,
    // of which 2026-06-14 is a SUNDAY and is dropped upstream by the TRA-369
    // weekend filter before the summary ever sees it => 21 rendered, of which 1
    // is unmeasurable => 20. (The first draft of this test asserted 21, and the
    // paired control below is what caught it. Keep them paired.)
    expect(Object.keys(LIVE_JUNE_2026_REPORTS)).toHaveLength(22);
    expect(VISIBLE_JUNE_ROWS).toBe(21);

    const stats = Array.from(container.querySelectorAll('.cal-summary-stat')) as HTMLElement[];
    const tradingDays = stats.find(s => s.querySelector('.cal-summary-label')?.textContent === 'Trading Days');
    expect(within(tradingDays!).getByText(String(VISIBLE_JUNE_ROWS - 1))).toBeInTheDocument();

    // ...and the win rate carries that denominator with it, so "/ 20" is checkable.
    const winRate = stats.find(s => s.querySelector('.cal-summary-label')?.textContent === 'Win Rate');
    expect(winRate!.textContent).toContain(`/ ${VISIBLE_JUNE_ROWS - 1} measured`);
  });

  it('RESTORED (the incident): the summary counts the unmeasured day and names nothing', async () => {
    const { container } = await renderJune2026(withoutStamp(LIVE_JUNE_2026_REPORTS));
    expect(container.querySelector('.cal-summary-unknown')).toBeNull();
    const stats = Array.from(container.querySelectorAll('.cal-summary-stat')) as HTMLElement[];
    const tradingDays = stats.find(s => s.querySelector('.cal-summary-label')?.textContent === 'Trading Days');
    // One MORE than the graded run above: the day nobody measured is back in the
    // denominator, silently, which is exactly what the parent ticket complains of.
    expect(within(tradingDays!).getByText(String(VISIBLE_JUNE_ROWS))).toBeInTheDocument();
  });

  it('the detail view refuses the figure in BOTH places it used to print it', async () => {
    // The detail screen is what an auditor opens to check a cell, so a `$0.00`
    // in the header strip or the stat tile is the disputed claim restated.
    await renderJune2026(LIVE_JUNE_2026_REPORTS);
    fireEvent.change(screen.getByTitle(/Jump to a specific date/), { target: { value: COHORT_DATE } });
    await waitFor(() => expect(screen.getByText(`EOD Report — ${COHORT_DATE}`)).toBeInTheDocument());

    // 1 — the header strip.
    expect(screen.getByText('P&L unknown')).toBeInTheDocument();
    // 2 — the Combined P&L stat tile.
    const tile = screen.getByText('Combined P&L').closest('.eod-stat') as HTMLElement;
    expect(within(tile).getByText('unknown')).toBeInTheDocument();
    expect(tile.textContent).not.toMatch(/\$0\.00/);

    // The banner has to say what is missing AND that it was deliberately not
    // repaired -- re-deriving the hole is how the phantom-green calendar happened.
    const banner = document.querySelector('.cal-unknown-banner') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('UNKNOWN, not $0.00');
    expect(banner.textContent).toContain('Anchor 2026-06-11');
    expect(banner.textContent).toContain('been re-derived');
    expect(banner.textContent).toContain('1 open positions'); // the live evidence, rendered
  });

  it("RESTORED (the incident): the detail view prints $0.00 as the day's finding", async () => {
    await renderJune2026(withoutStamp(LIVE_JUNE_2026_REPORTS));
    fireEvent.change(screen.getByTitle(/Jump to a specific date/), { target: { value: COHORT_DATE } });
    await waitFor(() => expect(screen.getByText(`EOD Report — ${COHORT_DATE}`)).toBeInTheDocument());

    expect(screen.queryByText('P&L unknown')).toBeNull();
    expect(document.querySelector('.cal-unknown-banner')).toBeNull();
    const tile = screen.getByText('Combined P&L').closest('.eod-stat') as HTMLElement;
    expect(tile.textContent).toContain('$0.00');
  });

  it('the year view flags June rather than presenting a partial month as complete', async () => {
    const { container } = await renderJune2026(LIVE_JUNE_2026_REPORTS);
    fireEvent.click(screen.getByText('Year'));
    await waitFor(() => expect(container.querySelector('.cal-year-grid')).toBeTruthy());

    const jun = Array.from(container.querySelectorAll('.cal-year-cell'))
      .find(c => c.querySelector('.cal-year-month')?.textContent === 'Jun') as HTMLElement;
    expect(jun.querySelector('.cal-year-unknown')?.textContent).toBe('?:1');
    expect(jun.getAttribute('title')).toContain('could not be measured');

    const stats = Array.from(container.querySelectorAll('.cal-summary-stat')) as HTMLElement[];
    const unmeasured = stats.find(s => s.querySelector('.cal-summary-label')?.textContent === 'Unmeasured Days');
    expect(unmeasured).toBeTruthy();
    expect(within(unmeasured!).getByText('1')).toBeInTheDocument();
  });

  it('RESTORED (the incident): the year view shows no marker at all', async () => {
    const { container } = await renderJune2026(withoutStamp(LIVE_JUNE_2026_REPORTS));
    fireEvent.click(screen.getByText('Year'));
    await waitFor(() => expect(container.querySelector('.cal-year-grid')).toBeTruthy());
    expect(container.querySelector('.cal-year-unknown')).toBeNull();
    expect(screen.queryByText('Unmeasured Days')).toBeNull();
  });
});
