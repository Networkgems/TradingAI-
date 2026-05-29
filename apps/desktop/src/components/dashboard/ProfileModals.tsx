// TRA-422 — the three profile-menu modals (Settings, Change Password, User
// Management) extracted from Dashboard.tsx / CryptoDashboard.tsx, which carried
// byte-identical copies. Behaviour is unchanged: backdrop click closes, the
// inner card stops propagation, and User Management is gated on `isAdmin`.
import type { LiveCredentialField } from '@trading-app/shared';
import SettingsPage, { ChangePasswordSection, UserManagementSection } from '../../SettingsPage.tsx';

export type ProfileModal = 'settings' | 'change-password' | 'user-management';

export function ProfileModals({
  which,
  onClose,
  token,
  httpUrl,
  context,
  isAdmin,
  onModeChange,
  onSettingsSaved,
  onLogout,
  focusCredField,
}: {
  which: ProfileModal | null;
  onClose: () => void;
  token: string;
  httpUrl: string;
  context: 'crypto' | 'stocks';
  isAdmin: boolean;
  onModeChange: (mode: 'demo' | 'live') => void;
  onSettingsSaved: (settings: import('@trading-app/shared').AccountSettings) => void;
  onLogout: () => void;
  /**
   * TRA-506 — when the Settings modal opens because the user clicked the
   * dashboard's missing-creds banner, focus this input on mount. Cleared
   * by the parent when the modal closes.
   */
  focusCredField?: LiveCredentialField | null;
}) {
  if (!which) return null;

  if (which === 'settings') {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-card modal-card-settings" onClick={e => e.stopPropagation()}>
          <button
            className="modal-close-corner"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            &#x2715;
          </button>
          <SettingsPage
            token={token}
            httpUrl={httpUrl}
            context={context}
            onModeChange={onModeChange}
            onSettingsSaved={onSettingsSaved}
            onLogout={onLogout}
            focusCredField={focusCredField ?? null}
          />
        </div>
      </div>
    );
  }

  if (which === 'change-password') {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Change Password</h3>
            <button className="btn-secondary btn-sm" onClick={onClose}>&#x2715;</button>
          </div>
          <ChangePasswordSection token={token} httpUrl={httpUrl} />
        </div>
      </div>
    );
  }

  // user-management — admin-only; render nothing for a non-admin token.
  if (!isAdmin) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: '660px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Account Management</h3>
          <button className="btn-secondary btn-sm" onClick={onClose}>&#x2715;</button>
        </div>
        <UserManagementSection token={token} httpUrl={httpUrl} />
      </div>
    </div>
  );
}
