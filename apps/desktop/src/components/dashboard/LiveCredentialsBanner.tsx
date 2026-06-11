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

const FIELD_LABELS: Record<LiveCredentialField, string> = {
  liveApiKeyOptionsProduction: 'Tradier production API token',
  liveAccountIdOptionsProduction: 'Tradier production account ID',
  liveApiKeyOptionsSandbox: 'Tradier sandbox API token',
  liveAccountIdOptionsSandbox: 'Tradier sandbox account ID',
  liveApiKeyCrypto: 'Coinbase API key',
  liveApiSecretCrypto: 'Coinbase API secret',
};

// TRA-798 — the Coinbase (crypto) credential fields. Used to scope the banner
// to its host dashboard so the crypto "missing API key" warning shows on the
// Crypto dashboard and the Tradier/options warning shows on the Stocks
// dashboard, instead of every page surfacing every market's missing creds.
const CRYPTO_FIELDS: readonly LiveCredentialField[] = [
  'liveApiKeyCrypto',
  'liveApiSecretCrypto',
];

interface Props {
  settings: AccountSettings | null;
  onOpenSettings: (focusField: LiveCredentialField) => void;
  // TRA-798 — restrict the banner to one market's credentials. 'crypto' shows
  // only Coinbase fields; 'stocks' shows everything else (Tradier). Omit to
  // show all missing creds (legacy behaviour).
  market?: 'stocks' | 'crypto';
}

export function LiveCredentialsBanner({ settings, onOpenSettings, market }: Props) {
  if (!settings || settings.mode !== 'live') return null;
  const allMissing = findMissingLiveCredentials(settings);
  const missing =
    market === 'crypto'
      ? allMissing.filter(f => CRYPTO_FIELDS.includes(f))
      : market === 'stocks'
        ? allMissing.filter(f => !CRYPTO_FIELDS.includes(f))
        : allMissing;
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
