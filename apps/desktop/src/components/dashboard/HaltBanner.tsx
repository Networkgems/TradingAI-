// TRA-535 — prominent red banner shown whenever trading is halted, so the
// ENGAGED state of the TRA-526 kill switch (or a daily circuit-breaker on the
// stock engine) is impossible to miss. On the Stocks dashboard `halted` /
// `reason` come straight from the live `tradingHalted` / `haltReason` fields in
// `/api/state`, where the kill-switch reason already takes precedence over the
// daily circuit-breakers (see DailyRiskGovernor.getHaltReason). The Crypto
// dashboard drives it from the kill-switch engaged state, its only halt source.
export function HaltBanner({ halted, reason }: { halted: boolean; reason: string | null }) {
  if (!halted) return null;
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
      <span>
        Trading halted — no new entries.
        {reason ? <span style={{ fontWeight: 400 }}>{` ${reason}`}</span> : ' Global kill switch engaged.'}
      </span>
    </div>
  );
}
