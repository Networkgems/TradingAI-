/**
 * TRA-4479 / audit H4 item 4 — the client-side mirror of the server's
 * `MIN_PASSWORD_LENGTH` (`packages/server/src/auth.ts`).
 *
 * The server is the authority; this exists so the form refuses before the round
 * trip and so `minLength` on the inputs agrees with what the API will accept.
 * It was six, restated as a bare `6` in nine places across the server and this
 * app, which is why raising the floor had never been done: it was a nine-site
 * edit with no single place to look. Keep the two constants in step — the pair
 * disagreeing is only ever a worse error message, never a weaker check, because
 * the server re-validates every write path.
 */
export const MIN_PASSWORD_LENGTH = 8;
