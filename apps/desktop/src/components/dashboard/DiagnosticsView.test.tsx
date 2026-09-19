// TRA-4729 — the Diagnostics sidebar: every moved panel stays reachable, and
// exactly one renders at a time.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DiagnosticsView, type DiagnosticsItem } from './DiagnosticsView';

type Id = 'health' | 'news' | 'calendar';
const items: DiagnosticsItem<Id>[] = [
  { id: 'health', section: 'Core', label: 'Health', render: () => <p>health body</p> },
  { id: 'news', section: 'Feeds', label: 'News', render: () => <p>news body</p> },
  { id: 'calendar', section: 'Feeds', label: 'Calendar', dataTour: 'calendar', render: () => <p>calendar body</p> },
];

function Harness() {
  const [active, setActive] = useState<Id>('health');
  return <DiagnosticsView items={items} active={active} onSelect={setActive} />;
}

describe('DiagnosticsView', () => {
  it('renders only the active sub-panel, and every item is one click away', async () => {
    render(<Harness />);
    expect(screen.getByText('health body')).toBeInTheDocument();
    expect(screen.queryByText('news body')).not.toBeInTheDocument();

    for (const i of items) {
      await userEvent.click(screen.getByRole('button', { name: i.label }));
      expect(screen.getByText(`${i.id} body`)).toBeInTheDocument();
      for (const other of items.filter(o => o.id !== i.id)) {
        expect(screen.queryByText(`${other.id} body`)).not.toBeInTheDocument();
      }
    }
  });

  it('groups items under their section headings and keeps the tour anchor', () => {
    render(<Harness />);
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('Feeds')).toBeInTheDocument();
    expect(document.querySelector('[data-tour="calendar"]')).not.toBeNull();
  });

  it('the narrow-screen select drives the same selection', async () => {
    const onSelect = vi.fn();
    render(<DiagnosticsView items={items} active="health" onSelect={onSelect} />);
    await userEvent.selectOptions(screen.getByLabelText('Diagnostics panel'), 'news');
    expect(onSelect).toHaveBeenCalledWith('news');
  });

  it('a crash in one sub-panel is contained by its boundary', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => { throw new Error('boom'); };
    render(
      <DiagnosticsView
        items={[{ id: 'health', section: 'Core', label: 'Health', render: () => <Boom /> }]}
        active="health"
        onSelect={() => {}}
      />,
    );
    // The sidebar survives the crash.
    expect(screen.getByRole('button', { name: 'Health' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
