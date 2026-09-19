// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import { useState } from 'react';

export function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
  required,
  minLength,
  // TRA-506 — set on cred inputs so the dashboard's missing-creds banner can
  // querySelector → focus the right input on modal open.
  dataCredField,
  // TRA-2421 — optional DOM id so a <label htmlFor> can actually address the
  // field. The sections above use bare <label>s, which look associated and are
  // not; the delete-account form opts in because a confirmation control that no
  // assistive tech can name is a bad thing to put in front of a destructive
  // action.
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  minLength?: number;
  dataCredField?: string;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  // TRA-798 — the `data-*-ignore` attrs below (TRA-778) stop 1Password /
  // LastPass, but Chromium's BUILT-IN password manager still ignores
  // `autoComplete="off"` on a `type="password"` field and prefills the saved
  // app-login (admin) password before the user types. Two more defenses are
  // needed and only for fields that want NO autofill (they pass `off` or omit
  // autoComplete) — the password-change form opts into real autofill
  // (`current-password` / `new-password`) and must keep it: (1) send
  // `autocomplete="new-password"` so the manager treats it as a *new*
  // credential and never injects the saved login; (2) render read-only until
  // first focus so nothing can be filled on mount. Neither alone is reliable.
  const suppressAutofill = !autoComplete || autoComplete === 'off';
  const effectiveAutoComplete = suppressAutofill ? 'new-password' : autoComplete;
  const [autofillGuard, setAutofillGuard] = useState(suppressAutofill);
  const antiAutofillProps = suppressAutofill
    ? { readOnly: autofillGuard, onFocus: () => setAutofillGuard(false) }
    : {};
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={effectiveAutoComplete}
        {...antiAutofillProps}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        minLength={minLength}
        data-cred-field={dataCredField}
        // TRA-778 — stop Chromium / 1Password / LastPass from autofilling the
        // app login (admin) username + password into broker credential fields.
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        style={{ paddingRight: '2.5rem', width: '100%', boxSizing: 'border-box' }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        disabled={disabled}
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: '0.5rem',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--muted, #888)',
          padding: '0.25rem',
          display: 'flex',
          alignItems: 'center',
          lineHeight: 0,
        }}
      >
        {show ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

