// TRA-4729 (design TRA-4733 §2) — the Diagnostics tab. Every surface that is
// not one of the five primary panels lives here: MOVED, not deleted. A vertical
// sidebar picks exactly one sub-panel at a time (same conditional-render model
// the old flat tab bar used), and collapses to a <select> on narrow screens.
//
// The sub-panels are passed in as render functions so `Dashboard` keeps owning
// the engine state they read; this component owns only which one is showing.
import type { ReactNode } from 'react';
import { ErrorBoundary } from '../../ErrorBoundary.tsx';

export interface DiagnosticsItem<T extends string = string> {
  id: T;
  label: string;
  /** Sidebar section heading this item sits under. */
  section: string;
  title?: string;
  /** Optional `data-tour` anchor for the coach-mark tour. */
  dataTour?: string;
  render: () => ReactNode;
}

export function DiagnosticsView<T extends string>({
  items,
  active,
  onSelect,
}: {
  items: DiagnosticsItem<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  const current = items.find(i => i.id === active) ?? items[0];
  const sections: string[] = [];
  for (const i of items) if (!sections.includes(i.section)) sections.push(i.section);

  return (
    <div className="diagnostics-layout">
      <nav className="diagnostics-sidebar" aria-label="Diagnostics panels">
        <select
          className="diagnostics-sidebar__select"
          aria-label="Diagnostics panel"
          value={current?.id}
          onChange={e => onSelect(e.target.value as T)}
        >
          {items.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        {sections.map(section => (
          <div key={section} className="diagnostics-sidebar__section">
            <div className="diagnostics-sidebar__heading muted">{section}</div>
            {items.filter(i => i.section === section).map(i => (
              <button
                key={i.id}
                type="button"
                data-tour={i.dataTour}
                title={i.title}
                aria-current={i.id === current?.id ? 'page' : undefined}
                className={`diagnostics-sidebar__item ${i.id === current?.id ? 'active' : ''}`}
                onClick={() => onSelect(i.id)}
              >
                {i.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="diagnostics-content">
        {/* TRA-398 — per-panel error boundary, remounted on switch so a crash in
            one diagnostics panel cannot take the others down. */}
        {current && (
          <ErrorBoundary key={current.id} label={`stocks:diagnostics:${current.id}`} variant="panel">
            {current.render()}
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
