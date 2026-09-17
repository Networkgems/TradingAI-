// TRA-422 — the three profile-menu modals (Settings, Change Password, User
// Management) extracted from Dashboard.tsx. Behaviour is unchanged: backdrop
// click closes, the
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
  context: 'stocks';
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
        {/* TRA-1520 — `modal-card-scroll` keeps the sticky header (title + X)
            pinned while the body scrolls, so the close button is always
            reachable on both mobile and web even when the content is tall. */}
        <div className="modal-card modal-card-scroll" onClick={e => e.stopPropagation()}>
          <div className="modal-card-header">
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Change Password</h3>
            <button className="btn-secondary btn-sm" aria-label="Close" onClick={onClose}>&#x2715;</button>
          </div>
          <div className="modal-card-body">
            <ChangePasswordSection token={token} httpUrl={httpUrl} />
          </div>
        </div>
      </div>
    );
  }

  // user-management — admin-only; render nothing for a non-admin token.
  if (!isAdmin) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* TRA-1520 — see change-password note above; the user list is long, so
          the scroll + sticky close button matters most here. */}
      <div className="modal-card modal-card-scroll" style={{ maxWidth: '660px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-card-header">
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Account Management</h3>
          <button className="btn-secondary btn-sm" aria-label="Close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="modal-card-body">
          <UserManagementSection token={token} httpUrl={httpUrl} />
        </div>
      </div>
    </div>
  );
}
