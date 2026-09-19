// TRA-506 — persistent warning row that fires when the dashboard is in Live
// mode but at least one required broker credential is blank. The user the
// issue captured spent a week assuming they were trading against their
// funded Tradier production account while `liveTradierEnvOptions` was still
// sandbox and the production keys were empty. The banner closes that gap by
// surfacing the gap on every page render until the user fixes it; it also
// deep-links into Settings → Brokers with the first missing field focused
// so the click → fix path stays one step.
import type { AccountSettings, LiveCredentialField } from '@trading-app/shared';
import { findMissingLiveCredentials } from '@trading-app/shared';

// TRA-4729 — the retired Coinbase fields are gone from LiveCredentialField
// (TRA-4629 left them there pending this backend removal), so the map is now
// total: a new credential field fails to compile until it is labelled. The
// filter below stays as a belt-and-braces guard against an unlabelled value.
const FIELD_LABELS: Record<LiveCredentialField, string> = {
  liveApiKeyOptionsProduction: 'Tradier production API token',
  liveAccountIdOptionsProduction: 'Tradier production account ID',
  liveApiKeyOptionsSandbox: 'Tradier sandbox API token',
  liveAccountIdOptionsSandbox: 'Tradier sandbox account ID',
};

interface Props {
  settings: AccountSettings | null;
  onOpenSettings: (focusField: LiveCredentialField) => void;
  // TRA-798 — restrict the banner to one market's credentials. Since
  // TRA-4629, 'stocks' (Tradier) is the only market.
  market?: 'stocks';
}

export function LiveCredentialsBanner({ settings, onOpenSettings }: Props) {
  if (!settings || settings.mode !== 'live') return null;
  const missing = findMissingLiveCredentials(settings)
    .filter(f => FIELD_LABELS[f] !== undefined);
  if (missing.length === 0) return null;
  const firstMissing = missing[0]!;
  return (
    <div
      role="alert"
      data-testid="live-credentials-banner"
      className="live-creds-banner"
      style={{
        background: 'var(--warning-bg, #fff5e6)',
        border: '1px solid var(--warning-border, #e69500)',
        color: 'var(--warning-fg, #663300)',
        padding: '0.75rem 1rem',
        margin: '0.5rem 1rem',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: '240px' }}>
        <strong>Live trading is on but broker credentials are missing.</strong>{' '}
        No live signals will execute until you add{' '}
        {missing.map((f, i) => (
          <span key={f}>
            {i > 0 && (i === missing.length - 1 ? ' and ' : ', ')}
            <strong>{FIELD_LABELS[f]}</strong>
          </span>
        ))}
        {' '}in Settings.
      </div>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onOpenSettings(firstMissing)}
      >
        Open settings →
      </button>
    </div>
  );
}
