// TRA-569 — dashboard coach-mark tour behaviour: anchor resolution, step nav,
// keyboard, replay event, and graceful degradation when an anchor is missing.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoachMarkTour, DashboardTour } from './CoachMarkTour';
import { TOUR_STOPS, START_TOUR_EVENT, TOUR_AUTOSTART_KEY } from './tour';

/** Render anchored target elements so the tour can resolve every data-tour id. */
function Anchors() {
  return (
    <div>
      {TOUR_STOPS.map(s => (
        <button key={s.id} data-tour={s.id}>{s.id}</button>
      ))}
    </div>
  );
}

describe('CoachMarkTour', () => {
  it('renders nothing when inactive', () => {
    render(<CoachMarkTour active={false} onClose={() => {}} />);
    expect(screen.queryByTestId('coachmark')).not.toBeInTheDocument();
  });

  it('opens on the first stop with the step counter', () => {
    render(<><Anchors /><CoachMarkTour active onClose={() => {}} /></>);
    expect(screen.getByRole('heading', { name: TOUR_STOPS[0].title })).toBeInTheDocument();
    expect(screen.getByText(`1 / ${TOUR_STOPS.length}`)).toBeInTheDocument();
    // Back is disabled on the first stop.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('steps forward and back through all stops with the nav buttons', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<><Anchors /><CoachMarkTour active onClose={onClose} /></>);

    for (let i = 1; i < TOUR_STOPS.length; i++) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByRole('heading', { name: TOUR_STOPS[i].title })).toBeInTheDocument();
    }
    // On the last stop the primary button reads "Done" and ends the tour.
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates with the arrow keys and closes on Escape (design §3.4)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<><Anchors /><CoachMarkTour active onClose={onClose} /></>);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('heading', { name: TOUR_STOPS[1].title })).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('heading', { name: TOUR_STOPS[0].title })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Skip ends the tour from any stop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<><Anchors /><CoachMarkTour active onClose={onClose} /></>);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still renders the tooltip (centred, no spotlight) when an anchor is missing', () => {
    // No <Anchors/> rendered → every data-tour query misses.
    render(<CoachMarkTour active onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: TOUR_STOPS[0].title })).toBeInTheDocument();
    // The spotlight cut-out is only drawn when an anchor resolves.
    expect(document.querySelector('.coachmark-spotlight')).toBeNull();
  });
});

describe('DashboardTour', () => {
  it('auto-starts once when the autostart breadcrumb is set, then clears it', () => {
    localStorage.setItem(TOUR_AUTOSTART_KEY, '1');
    render(<><Anchors /><DashboardTour /></>);
    expect(screen.getByTestId('coachmark')).toBeInTheDocument();
    expect(localStorage.getItem(TOUR_AUTOSTART_KEY)).toBeNull();
  });

  it('does not start without a breadcrumb, then starts on the replay event', () => {
    localStorage.clear();
    render(<><Anchors /><DashboardTour /></>);
    expect(screen.queryByTestId('coachmark')).not.toBeInTheDocument();
    fireEvent(window, new CustomEvent(START_TOUR_EVENT));
    expect(screen.getByTestId('coachmark')).toBeInTheDocument();
  });
});
