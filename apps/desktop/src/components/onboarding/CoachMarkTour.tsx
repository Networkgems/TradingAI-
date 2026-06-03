// TRA-569 (TRA-410 C2) — the dashboard coach-mark tour.
//
//   CoachMarkTour  — controlled orchestrator: walks `stops`, resolves each
//                    `data-tour` anchor to a live rect, handles Back/Next/Skip +
//                    arrow/Esc keys, and re-measures on resize/scroll. Renders
//                    one <CoachMark> at a time.
//   DashboardTour  — uncontrolled wrapper the Dashboard mounts once. Owns the
//                    open/closed state and the two start triggers (replay event +
//                    first-run autostart breadcrumb) so the Dashboard shell stays
//                    a one-liner (design §6).
import { useCallback, useEffect, useState } from 'react';
import { CoachMark, type AnchorRect } from './CoachMark';
import {
  TOUR_STOPS,
  START_TOUR_EVENT,
  consumeTourAutostart,
  type TourStop,
} from './tour';

export interface CoachMarkTourProps {
  active: boolean;
  onClose: () => void;
  /** Override the stop list (defaults to the design §3.3 sequence). */
  stops?: readonly TourStop[];
}

function measureAnchor(id: string): AnchorRect | null {
  const el = document.querySelector(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function CoachMarkTour({ active, onClose, stops = TOUR_STOPS }: CoachMarkTourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<AnchorRect | null>(null);

  // Always (re)start from the first stop when the tour opens.
  useEffect(() => {
    if (active) setIndex(0);
  }, [active]);

  const stop = active ? stops[index] : undefined;

  const next = useCallback(() => {
    setIndex(i => {
      if (i >= stops.length - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [stops.length, onClose]);

  const back = useCallback(() => setIndex(i => Math.max(0, i - 1)), []);

  // Resolve the anchored element and keep its rect fresh while the stop is shown.
  useEffect(() => {
    if (!stop) return;
    const remeasure = () => setRect(measureAnchor(stop.id));
    remeasure();
    // Bring the anchor into view (tab buttons/header controls are usually
    // visible, but be safe for short viewports), then re-measure post-scroll.
    document.querySelector(`[data-tour="${stop.id}"]`)?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
    });
    remeasure();
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [stop]);

  // Keyboard: Esc ends the tour, arrows step (design §3.4 a11y parity with the
  // wizard). Bound to the window since the spotlight covers the whole viewport.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, next, back, onClose]);

  if (!active || !stop) return null;

  return (
    <CoachMark
      rect={rect}
      title={stop.title}
      body={stop.body}
      index={index}
      total={stops.length}
      onBack={back}
      onNext={next}
      onClose={onClose}
    />
  );
}

/**
 * Self-contained tour controller the Dashboard mounts once. Starts on either the
 * replay event (profile menu) or the first-run autostart breadcrumb (consumed on
 * mount so it fires exactly once after the wizard).
 */
export function DashboardTour() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // First-run hand-off: the wizard set a breadcrumb before this dashboard
    // mounted. Consume it so it never re-triggers on a later mount.
    if (consumeTourAutostart()) setActive(true);
    const onStart = () => {
      consumeTourAutostart();
      setActive(true);
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  return <CoachMarkTour active={active} onClose={() => setActive(false)} />;
}
