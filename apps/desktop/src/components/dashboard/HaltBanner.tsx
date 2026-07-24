// TRA-535 — prominent red banner shown whenever trading is halted, so the
// ENGAGED state of the TRA-526 kill switch (or a daily circuit-breaker on the
// stock engine) is impossible to miss. On the Stocks dashboard `halted` /
// `reason` come straight from the live `tradingHalted` / `haltReason` fields in
// `/api/state`, where the kill-switch reason already takes precedence over the
// daily circuit-breakers (see DailyRiskGovernor.getHaltReason). The Crypto
// dashboard drives it from the kill-switch engaged state, its only halt source.
//
// TRA-895 — when the halt is from the daily circuit-breaker (not the kill
// switch), show a "Clear halt" button so an operator can resume without waiting
// for the ET midnight day-roll. Kill-switch halts must be released via the
// dedicated KillSwitchButton — not here.
//
// TRA-2246 — the "Clear halt" button POSTs /api/trading/reset-halt, which resets
// ONLY the daily circuit-breaker (loss-streak / drawdown). The book give-back cap
// and session-stop halts are a SEPARATE, day-latched risk control that clears
// only on the ET day roll — reset-halt never touches them. So for those halts the
// button ran but nothing changed ("clicking Clear halt does nothing"). We now
// classify the halt via `haltKind`: the button is offered only when the halt is
// actually clearable here; day-latched book halts show a "lifts next day" note
// instead of a dead control. `haltKind` is optional — when absent (older server)
// we fall back to the prior !isKillSwitch behavior.
export function HaltBanner({
  halted,
  reason,
  isKillSwitch = false,
  onClearHalt,
  haltKind,
}: {
  halted: boolean;
  reason: string | null;
  isKillSwitch?: boolean;
  onClearHalt?: () => void;
  haltKind?: 'kill_switch' | 'daily_breaker' | 'book_giveback' | 'session_stop' | 'feed_stale' | null;
}) {
  if (!halted) return null;

  // TRA-2246 — a day-latched book give-back / session-stop halt is NOT clearable
  // by the operator here; it lifts on the ET day roll. Suppress the button (which
  // would silently no-op) and explain the behavior instead.
  const isDayLatchedBookHalt = haltKind === 'book_giveback' || haltKind === 'session_stop';
  const showClearButton = !!onClearHalt && !isKillSwitch && !isDayLatchedBookHalt;
  return (
    <div
      role="alert"
      data-testid="halt-banner"
      className="halt-banner"
      style={{
        background: 'var(--red-soft)',
        border: '1px solid var(--red)',
        color: 'var(--red-strong)',
        padding: '0.75rem 1rem',
        margin: '0.5rem 1rem',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>🛑</span>
      <span style={{ flex: 1 }}>
        Trading halted — no new entries.
        {reason ? <span style={{ fontWeight: 400 }}>{` ${reason}`}</span> : ' Global kill switch engaged.'}
      </span>
      {showClearButton && (
        <button
          onClick={onClearHalt}
          style={{
            background: 'transparent',
            border: '1px solid var(--red)',
            color: 'var(--red-strong)',
            borderRadius: '4px',
            padding: '0.25rem 0.65rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          Clear halt
        </button>
      )}
      {/* TRA-2246 — book give-back / session-stop halts are day-latched and not
          operator-clearable here; say so rather than showing a dead button. */}
      {isDayLatchedBookHalt && (
        <span
          data-testid="halt-daylatched-note"
          style={{ fontSize: '0.78rem', fontWeight: 500, opacity: 0.85, whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          Lifts automatically at the next trading day (ET)
        </span>
      )}
    </div>
  );
}
