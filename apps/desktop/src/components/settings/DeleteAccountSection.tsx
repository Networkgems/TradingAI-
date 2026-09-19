// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import { useEffect, useState } from 'react';
import { PasswordInput } from './PasswordInput';

/**
 * What is NOT deleted, stated once so the promise made BEFORE the delete and the
 * receipt shown AFTER it cannot drift apart.
 *
 * ⚠️ This is not a hedge — it is the deliberate design. The option journal
 * (`option-trade-journal.jsonl`) is shared, append-only, and firm-wide. Purging a
 * departing user's rows would shrink board-graded sample sizes, and blanking
 * their `account` field is worse: every desk/firm reader treats an `account`-less
 * row as IN SCOPE, so "anonymising" would inject a deleted book into firm P&L.
 * The rows stay and the TRA-2421 tombstone scopes them out of any future holder
 * of the username instead.
 *
 * The earlier copy here said the calendar was deleted "from this server and from
 * its backups". The calendar is DERIVED from these retained rows, so that
 * sentence was false about the one axis the reporter cared about most.
 */
const RETENTION_NOTICE =
  'They are no longer linked to your account, and are not visible to anyone who registers '
  + 'this username later — including on the trading calendar.';

/**
 * TRA-2421 — self-serve account deletion (board request on TRA-2406).
 *
 * Two confirmations, because this is irreversible and there is no undo anywhere
 * behind it: the CURRENT PASSWORD (the server requires it — a borrowed unlocked
 * laptop must not be able to destroy the book) and the username typed out by hand.
 *
 * ⚠️ The refusal rules — operator books, the last remaining administrator — are
 * NOT duplicated here. They live in one place on the server
 * (`isReservedOperatorBookName`, shared with the signup guard), and a second copy
 * in the UI would drift from it; the copy that drifts is the one someone trusts.
 * The button is offered to everyone and the server's reason is shown verbatim.
 */
export function DeleteAccountSection({
  token,
  httpUrl,
  onLogout,
}: { token: string; httpUrl: string; onLogout?: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set once the account is actually gone. The form is replaced rather than
  // re-enabled: the token is dead from this point, so every other control on the
  // page would 401 and read as a connection problem.
  const [destroyed, setDestroyed] = useState<null | {
    clean: boolean;
    message: string;
    /** Option-journal rows deliberately retained (see the retention note below). */
    journalRowsRetained: number | null;
  }>(null);

  useEffect(() => {
    fetch(`${httpUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: { username?: string }) => { if (data.username) setUsername(data.username); })
      .catch(() => { /* the confirm field simply stays unmatchable */ });
  }, [token, httpUrl]);

  const canSubmit = username.length > 0
    && confirmName === username
    && password.length > 0
    && !busy;

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${httpUrl}/api/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password }),
      });
      const data = await r.json() as {
        ok?: boolean;
        error?: string;
        receipt?: { ok?: boolean };
        journalRowsRetained?: number | null;
      };
      const retained = typeof data.journalRowsRetained === 'number' ? data.journalRowsRetained : null;
      if (r.ok && data.ok) {
        setDestroyed({
          clean: true,
          message: 'Your account and its trading data have been deleted.',
          journalRowsRetained: retained,
        });
        return;
      }
      // A `receipt` in the body means the identity WAS destroyed even though the
      // wipe left residue. The session is dead either way, so this cannot be
      // presented as a retryable failure — say what happened and send them out.
      if (data.receipt) {
        setDestroyed({
          clean: false,
          message: data.error
            ?? 'Your account was deleted, but some stored data could not be removed. This has been reported.',
          journalRowsRetained: retained,
        });
        return;
      }
      setError(data.error ?? 'Could not delete this account.');
    } catch {
      setError('Cannot reach server');
    } finally {
      setBusy(false);
    }
  }

  if (destroyed) {
    return (
      <section className="settings-section">
        <h2 className="settings-section-title">Account Deleted</h2>
        <p className={destroyed.clean ? undefined : 'save-error'} data-testid="delete-account-done">
          {destroyed.message}
        </p>
        {/* The server COMPUTES this count on every delete. Rendering it nowhere
            would leave the one honest number about the retention on the floor,
            after having promised it up front. `> 0` only: "0 records remain" is
            noise on a book that never traded an option. */}
        {destroyed.journalRowsRetained !== null && destroyed.journalRowsRetained > 0 && (
          <p className="field-hint" data-testid="delete-account-retained">
            {destroyed.journalRowsRetained.toLocaleString()} simulated option-trade{' '}
            {destroyed.journalRowsRetained === 1 ? 'record remains' : 'records remain'} in the firm's
            research ledger. {RETENTION_NOTICE}
          </p>
        )}
        <div className="settings-footer" style={{ marginTop: '1rem', paddingTop: 0, borderTop: 'none' }}>
          <button type="button" className="btn-primary" onClick={() => onLogout?.()}>
            Return to Sign In
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Delete Account</h2>
      <p className="field-hint" data-testid="delete-account-warning">
        This permanently deletes your account and its trading data — open positions, reports,
        watchlist, settings and saved trade history — from this server and from its backups.{' '}
        <strong>This cannot be undone.</strong>
      </p>
      <p className="field-hint" data-testid="delete-account-retention">
        <strong>One exception.</strong> Records of your simulated option trades remain in the firm's
        research ledger, which is shared and append-only. {RETENTION_NOTICE}
      </p>
      <form onSubmit={handleDelete}>
        <div className="settings-grid">
          <div className="settings-field">
            {/* Explicitly associated (the other sections' bare <label>s are not) —
                a confirmation control nobody can address by name is one a screen
                reader user has to guess at, on the one form in the app that
                destroys data. */}
            <label htmlFor="delete-account-password">Current Password</label>
            <PasswordInput
              id="delete-account-password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="delete-account-confirm">Type your username to confirm</label>
            <input
              id="delete-account-confirm"
              type="text"
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder={username || 'username'}
              autoComplete="off"
              disabled={busy}
            />
            <span className="field-hint">
              Enter <strong>{username || 'your username'}</strong> exactly.
            </span>
          </div>
        </div>
        {error && <p className="save-error" style={{ marginTop: '0.5rem' }}>{error}</p>}
        <div className="settings-footer" style={{ marginTop: '1rem', paddingTop: 0, borderTop: 'none' }}>
          <button type="submit" className="btn-danger" disabled={!canSubmit}>
            {busy ? 'Deleting…' : 'Delete My Account'}
          </button>
        </div>
      </form>
    </section>
  );
}

