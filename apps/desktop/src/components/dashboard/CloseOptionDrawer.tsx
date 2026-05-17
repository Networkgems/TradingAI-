// TRA-422 — the TRA-358 Tradier-style limit-close drawer for engine-opened
// LIVE option positions, extracted from Dashboard.tsx. Renders into a portal so
// it overlays regardless of which panel mounts it; mirrors Tradier's web close
// panel (price / qty / duration) and submits a sell_to_close LIMIT.
import { createPortal } from 'react-dom';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { CloseDrawerState } from '../../hooks/useStockOptionClose';

export function CloseOptionDrawer({
  closeDrawer,
  drawerRef,
  setCloseDrawer,
  onCancel,
  onSubmit,
}: {
  closeDrawer: CloseDrawerState | null;
  drawerRef: RefObject<HTMLDivElement>;
  setCloseDrawer: Dispatch<SetStateAction<CloseDrawerState | null>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (!closeDrawer) return null;

  return createPortal(
    <>
      <div
        className="profile-dropdown-backdrop"
        onClick={onCancel}
        style={{ background: 'rgba(0,0,0,0.4)' }}
      />
      <div
        ref={drawerRef}
        className="profile-dropdown"
        role="dialog"
        aria-modal="true"
        aria-label="Close option position"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(28rem, 92vw)',
          padding: '1rem',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>
          Close {closeDrawer.symbol} {closeDrawer.optionType.toUpperCase()}
        </h3>
        <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}>
          {closeDrawer.optionSymbol ? (<>OCC <code>{closeDrawer.optionSymbol}</code> · </>) : null}
          Submits Tradier <code>sell_to_close</code> LIMIT.
        </div>
        <label style={{ display: 'block', marginBottom: '0.6rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
            Limit price (per share)
          </span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={closeDrawer.price}
            onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, price: e.target.value, error: undefined } : prev)}
            style={{ width: '100%', padding: '0.4rem' }}
            disabled={closeDrawer.submitting}
          />
          <span className="muted" style={{ fontSize: '0.7rem' }}>
            Default: current mark ${closeDrawer.defaultPrice.toFixed(2)}
          </span>
        </label>
        <label style={{ display: 'block', marginBottom: '0.6rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
            Quantity (contracts, max {closeDrawer.contractsRemaining})
          </span>
          <input
            type="number"
            step="1"
            min="1"
            max={closeDrawer.contractsRemaining}
            value={closeDrawer.qty}
            onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, qty: e.target.value, error: undefined } : prev)}
            style={{ width: '100%', padding: '0.4rem' }}
            disabled={closeDrawer.submitting}
          />
        </label>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
          <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
            Duration
          </span>
          <select
            value={closeDrawer.duration}
            onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, duration: e.target.value as 'day' | 'gtc' | 'pre' | 'post', error: undefined } : prev)}
            style={{ width: '100%', padding: '0.4rem' }}
            disabled={closeDrawer.submitting}
          >
            <option value="day">Day</option>
            <option value="gtc">GTC (Good Til Cancelled)</option>
            <option value="pre">Pre-market</option>
            <option value="post">Post-market</option>
          </select>
        </label>
        {closeDrawer.error && (
          <div className="red" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
            {closeDrawer.error}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={closeDrawer.submitting}
          >
            Cancel
          </button>
          <button
            className="btn-close-pos"
            onClick={onSubmit}
            disabled={closeDrawer.submitting}
          >
            {closeDrawer.submitting ? 'Submitting…' : 'Submit sell_to_close'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
