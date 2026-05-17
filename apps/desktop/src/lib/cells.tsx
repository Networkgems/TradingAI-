import type { Position } from '@trading-app/shared';
import { signalLabel } from './format';

export function positionSignalCell(p: Position) {
  if (!p.signalId) {
    if (p.id.startsWith('imported-spot-')) return <span className="muted">Imported</span>;
    return <span className="muted">—</span>;
  }
  return signalLabel(p.signalType);
}
