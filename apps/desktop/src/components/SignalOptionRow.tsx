// TRA-419 — SignalOptionRow component extracted from App.tsx.
// TRA-372 — contract detail row rendered under the entry/stop/target/RR block
// on option signals (currently relative_value; future option SignalTypes fall
// through the same render path as long as `strike`/`expiration` are present).
// Returns null for non-option signals so the crypto signal feed renders byte
// identical to before.
import type { TradeSignal, OptionType } from '@trading-app/shared';
import { formatExpirationFull, daysToExpiration } from '../lib/format';

export function SignalOptionRow({ sig }: { sig: TradeSignal }) {
  const opt = sig as TradeSignal & { optionType?: OptionType; strike?: number; expiration?: string };
  if (sig.type !== 'relative_value') return null;
  if (opt.strike == null || !opt.expiration) return null;
  const expFull = formatExpirationFull(opt.expiration);
  if (!expFull) return null;
  const dte = daysToExpiration(opt.expiration, sig.timestamp);
  const optType = opt.optionType ?? 'call';
  return (
    <div className="signal-option-row">
      <span className={`option-badge ${optType}`}>{optType.toUpperCase()}</span>
      <span className="option-strike">Strike ${Math.round(opt.strike)}</span>
      <span className="option-exp">
        Exp {expFull}
        {dte != null && <span className="option-dte"> ({dte}d)</span>}
      </span>
    </div>
  );
}
