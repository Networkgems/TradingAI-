// TRA-941 (TRA-813 P2) — reject-reason modal for the pending-proposals panel,
// built to the TRA-940 UX spec §6. A rejection reason is REQUIRED for the audit
// trail: the operator picks a quick-reason chip and/or types free text (≤280),
// and "Confirm reject" stays disabled until at least one is provided. Modeled on
// ExportTradesModal (`.modal-backdrop` + `.modal-card`, useFocusTrap, Esc-close).
import { useMemo, useState } from 'react';
import { useFocusTrap } from '../../lib/useFocusTrap';

const QUICK_REASONS = [
  'Low conviction',
  'Bad timing',
  'Size too large',
  'Conflicts with position',
  "Don't trust signal",
] as const;

const MAX_REASON_LEN = 280;

export function RejectProposalModal({
  symbol,
  side,
  onCancel,
  onConfirm,
}: {
  symbol: string;
  side: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [chip, setChip] = useState<string | null>(null);
  const [text, setText] = useState('');
  const containerRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  // The combined reason sent to the audit trail: chip label + free text.
  const reason = useMemo(() => [chip, text.trim()].filter(Boolean).join(' — '), [chip, text]);
  const canConfirm = reason.length > 0;

  return (
    <div className="modal-backdrop" data-testid="reject-proposal-modal" onMouseDown={onCancel}>
      <div
        ref={containerRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Reject ${side} ${symbol} proposal`}
        style={{ maxWidth: 380 }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Reject {side} {symbol}</h3>
          <button className="btn-secondary btn-sm" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>
          A reason is required for the audit trail. Pick one and/or add a note.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {QUICK_REASONS.map(r => (
            <button
              key={r}
              type="button"
              className={chip === r ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              aria-pressed={chip === r}
              onClick={() => setChip(chip === r ? null : r)}
            >
              {r}
            </button>
          ))}
        </div>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
          Optional note
        </label>
        <textarea
          value={text}
          maxLength={MAX_REASON_LEN}
          rows={3}
          onChange={e => setText(e.target.value.slice(0, MAX_REASON_LEN))}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="Add context (optional)…"
        />
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)' }}>
          {text.length}/{MAX_REASON_LEN}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="btn-danger"
            disabled={!canConfirm}
            onClick={() => canConfirm && onConfirm(reason)}
          >
            Confirm reject
          </button>
        </div>
      </div>
    </div>
  );
}
