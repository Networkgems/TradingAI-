// TRA-565 (TRA-410 C1) — first-run onboarding wizard.
//
// A lightweight in-house modal (NO paid library, per design §3.4) that walks a
// brand-new user through the four first-run steps from the design §3.2 mockup:
//
//   1. Demo vs Live          — explains paper vs real-money trading
//   2. Connect a broker      — deep-links into Settings → Brokers (optional)
//   3. Dashboard tour        — hands off to the coach-mark tour (C2 / TRA-566)
//   4. You're set            — recap + where to replay the tour
//
// Accessibility (design §3.4, closes part of TRA-402 §6):
//   - focus-trap + Esc-to-skip via the shared `useFocusTrap` hook (TRA-409)
//   - arrow-key step navigation (◀ / ▶) handled here
//   - progress dots expose the current step to assistive tech
//
// This is a STANDALONE component (design §6 build constraint): it is mounted as
// an overlay from `OnboardingGate`, never spliced into the App.tsx shell.
import { useCallback, useEffect, useState } from 'react';
import { useFocusTrap } from '../../lib/useFocusTrap';

export type WizardFinishReason = 'completed' | 'skipped';

export interface WizardModalProps {
  /**
   * Called when the wizard ends. `'completed'` → the user clicked through to
   * the final step's "Finish"; `'skipped'` → Esc / "Skip tour". Both mark
   * onboarding complete (the wizard is one-and-done); the reason is forwarded
   * for telemetry / future "resume where you left off" behaviour.
   */
  onFinish: (reason: WizardFinishReason) => void;
  /**
   * Deep-link handler for step 2 — opens Settings → Brokers. The gate wires
   * this to navigate into a dashboard and pop the Settings modal. Invoking it
   * also finishes the wizard (the user is leaving the flow to configure a
   * broker), so the component does not call `onFinish` itself afterwards.
   */
  onConnectBroker: () => void;
  /**
   * TRA-569 — step 3 hand-off to the dashboard coach-mark tour. Like
   * `onConnectBroker`, the gate marks onboarding complete and starts the tour,
   * so the component does not call `onFinish` itself. Optional: when omitted the
   * step just describes the tour and the user replays it later from the menu.
   */
  onStartTour?: () => void;
}

const TOTAL_STEPS = 4;

export function WizardModal({ onFinish, onConnectBroker, onStartTour }: WizardModalProps) {
  const [step, setStep] = useState(0);

  const skip = useCallback(() => onFinish('skipped'), [onFinish]);

  // focus-trap + restore focus + Esc-to-skip (TRA-409 shared hook).
  const containerRef = useFocusTrap<HTMLDivElement>(true, skip);

  const goNext = useCallback(() => {
    setStep(s => Math.min(TOTAL_STEPS - 1, s + 1));
  }, []);
  const goPrev = useCallback(() => {
    setStep(s => Math.max(0, s - 1));
  }, []);

  // Arrow-key step navigation (design §3.4). Esc is owned by useFocusTrap, so
  // we only handle Left/Right here. Bound to the dialog container so it never
  // hijacks arrow keys elsewhere on the page.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    }
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [containerRef, goNext, goPrev]);

  const isLast = step === TOTAL_STEPS - 1;

  return (
    <div className="modal-backdrop onboarding-backdrop" data-testid="onboarding-wizard">
      <div
        ref={containerRef}
        className="modal-card onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
      >
        <header className="onboarding-header">
          <h2 id="onboarding-title" className="onboarding-title">
            Welcome to TradingAI
          </h2>
          <ol className="onboarding-dots" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <li
                key={i}
                className={`onboarding-dot${i === step ? ' is-active' : ''}${i < step ? ' is-done' : ''}`}
                aria-current={i === step ? 'step' : undefined}
              />
            ))}
          </ol>
        </header>

        <p className="onboarding-step-label">
          Step {step + 1} of {TOTAL_STEPS}
        </p>

        <div className="onboarding-body">
          {step === 0 && <StepDemoVsLive />}
          {step === 1 && <StepConnectBroker onConnectBroker={onConnectBroker} />}
          {step === 2 && <StepDashboardTour onStartTour={onStartTour} />}
          {step === 3 && <StepRecap />}
        </div>

        <footer className="onboarding-footer">
          <button type="button" className="onboarding-skip" onClick={skip}>
            {isLast ? 'Close' : 'Skip tour'}
          </button>
          <div className="onboarding-nav">
            <button
              type="button"
              className="onboarding-back"
              onClick={goPrev}
              disabled={step === 0}
            >
              ← Back
            </button>
            {isLast ? (
              <button
                type="button"
                className="onboarding-next onboarding-primary"
                onClick={() => onFinish('completed')}
              >
                Finish
              </button>
            ) : (
              <button
                type="button"
                className="onboarding-next onboarding-primary"
                onClick={goNext}
              >
                Next →
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function StepDemoVsLive() {
  return (
    <section aria-labelledby="onboarding-step1-h">
      <h3 id="onboarding-step1-h" className="onboarding-step-title">
        Demo vs Live
      </h3>
      <div className="onboarding-cards">
        <div className="onboarding-mode-card">
          <h4>Demo (paper)</h4>
          <p>Simulated cash. Safe to experiment. Start here.</p>
        </div>
        <div className="onboarding-mode-card">
          <h4>Live</h4>
          <p>Real broker, real money. Connect Tradier / Coinbase.</p>
        </div>
      </div>
      <p className="onboarding-note">
        You are in <strong>Demo</strong> now. Nothing here risks real funds.
      </p>
    </section>
  );
}

function StepConnectBroker({ onConnectBroker }: { onConnectBroker: () => void }) {
  return (
    <section aria-labelledby="onboarding-step2-h">
      <h3 id="onboarding-step2-h" className="onboarding-step-title">
        Connect a broker (optional)
      </h3>
      <p>
        Live trading needs a broker connection. You can set this up now in
        Settings → Brokers, or do it later — Demo works without one.
      </p>
      <button
        type="button"
        className="onboarding-primary onboarding-broker-btn"
        onClick={onConnectBroker}
      >
        Open broker settings
      </button>
      <p className="onboarding-note">You can also reach this anytime from Settings.</p>
    </section>
  );
}

function StepDashboardTour({ onStartTour }: { onStartTour?: () => void }) {
  return (
    <section aria-labelledby="onboarding-step3-h">
      <h3 id="onboarding-step3-h" className="onboarding-step-title">
        Your dashboard
      </h3>
      <p>
        Open positions, live signals, the auto-trading toggle, and your
        reports all live on the dashboard. A guided coach-mark tour walks you
        through each panel.
      </p>
      {/* TRA-569 — hand off to the coach-mark tour. The gate marks onboarding
          complete and starts the tour, so this both closes the wizard and kicks
          off the dashboard walkthrough. */}
      {onStartTour ? (
        <button
          type="button"
          className="onboarding-primary onboarding-broker-btn"
          onClick={onStartTour}
        >
          Start dashboard tour
        </button>
      ) : (
        <p className="onboarding-note">
          The interactive tour lands next — for now, click Next to finish setup.
        </p>
      )}
      <p className="onboarding-note">You can replay it anytime from the profile menu.</p>
    </section>
  );
}

function StepRecap() {
  return (
    <section aria-labelledby="onboarding-step4-h">
      <h3 id="onboarding-step4-h" className="onboarding-step-title">
        You're set
      </h3>
      <ul className="onboarding-recap">
        <li>You're in Demo — practice with simulated cash, zero risk.</li>
        <li>Connect a broker from Settings → Brokers when you're ready for Live.</li>
        <li>Replay this tour anytime from the Help menu.</li>
      </ul>
    </section>
  );
}
