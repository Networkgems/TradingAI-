import { useState } from 'react';

// TRA-2293 — a password field with the show/hide eye every auth screen was
// missing. Shared rather than repeated so the sign-in, sign-up and reset forms
// cannot drift apart on the details that matter: the toggle is `type="button"`
// (an unqualified <button> inside a <form> submits it), and it carries an
// aria-label plus aria-pressed so the control announces its state rather than
// reading as an unlabelled glyph.
//
// Reveal state is deliberately per-field and starts hidden on every mount — it is
// never persisted, so a password is not left on screen across navigations.

interface Props {
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
  placeholder?: string;
  id?: string;
}

export default function PasswordInput({
  value,
  onChange,
  autoComplete = 'current-password',
  disabled = false,
  required = false,
  minLength,
  autoFocus = false,
  placeholder,
  id,
}: Props) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="login-input-wrap">
      <input
        id={id}
        className="login-input login-input--with-toggle"
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        minLength={minLength}
        autoFocus={autoFocus}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="login-reveal-btn"
        onClick={() => setRevealed(r => !r)}
        disabled={disabled}
        aria-label={revealed ? 'Hide password' : 'Show password'}
        aria-pressed={revealed}
        title={revealed ? 'Hide password' : 'Show password'}
        // The field is the control; the toggle is decoration for keyboard users
        // tabbing through the form, so it comes after the input naturally.
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
