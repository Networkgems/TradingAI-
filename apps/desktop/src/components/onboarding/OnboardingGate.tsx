// TRA-565 (TRA-410 C1) — mount point for the first-run wizard.
//
// Keeps the App.tsx shell free of onboarding logic (design §6 build
// constraint): App renders a single <OnboardingGate token={token} ... />, and
// all the fetch / show-decision / persistence lives here + in `useOnboarding`.
// Renders nothing until settings load and only when the user has not yet
// finished onboarding.
import { useOnboarding } from '../../hooks/useOnboarding';
import { WizardModal } from './WizardModal';

export interface OnboardingGateProps {
  token: string | null;
  /**
   * Invoked when the user clicks "Open broker settings" in step 2. The gate
   * marks onboarding complete (they're leaving the flow) and then hands off to
   * this navigator, wired by App to open Settings → Brokers.
   */
  onConnectBroker: () => void;
}

export function OnboardingGate({ token, onConnectBroker }: OnboardingGateProps) {
  const { status, complete } = useOnboarding(token);

  if (status !== 'show') return null;

  return (
    <WizardModal
      onFinish={() => complete()}
      onConnectBroker={() => {
        complete();
        onConnectBroker();
      }}
    />
  );
}
