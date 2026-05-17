// TRA-409 — shared form-validation helpers.
//
// Validation rules were previously inlined inside event handlers (login,
// sign-up, the TRA-358 close drawer), which made them impossible to unit test
// and easy to drift apart. Each helper returns a human-readable error string,
// or null when the value is valid.

export type ValidationResult = string | null;

/** Validate an email address for the login / sign-up forms. */
export function validateEmail(value: string): ValidationResult {
  const v = value.trim();
  if (!v) return 'Email is required.';
  // Deliberately permissive: one @, a dot in the domain, no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Enter a valid email address.';
  return null;
}

/** Validate a password. `requireStrong` enforces the sign-up minimum length. */
export function validatePassword(value: string, requireStrong = false): ValidationResult {
  if (!value) return 'Password is required.';
  if (requireStrong && value.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

/** Validate that a confirmation password matches the original. */
export function validatePasswordConfirm(password: string, confirm: string): ValidationResult {
  if (!confirm) return 'Please confirm your password.';
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

/**
 * Validate the limit price entered in the close drawer. Mirrors the rule the
 * server enforces: the price must parse to a finite number greater than 0.
 */
export function validateLimitPrice(value: string): ValidationResult {
  const price = Number(value);
  if (value.trim() === '' || !Number.isFinite(price) || price <= 0) {
    return 'Limit price must be greater than 0.';
  }
  return null;
}

/**
 * Validate the contract quantity entered in the close drawer. Must be a whole
 * number between 1 and the number of contracts still open on the position.
 */
export function validateCloseQty(value: string, contractsRemaining: number): ValidationResult {
  const qty = Number(value);
  if (
    value.trim() === '' ||
    !Number.isFinite(qty) ||
    !Number.isInteger(qty) ||
    qty <= 0 ||
    qty > contractsRemaining
  ) {
    return `Qty must be between 1 and ${contractsRemaining}.`;
  }
  return null;
}
