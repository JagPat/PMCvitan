import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Live bug 1 — the bell opens the record a notice is about; a notice whose record cannot be found
 * says so in place and offers the screen, instead of dropping the viewer on the parent list.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function mount(
  notifications: { text: string; time: string; color: string; decisionId?: string }[],
  over: Record<string, unknown> = {},
) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ notifOpen: true, notifications, role: 'pmc', screen: 'inbox', ...over });
  const { NotificationPanel } = await import('@/layout/NotificationPanel');
  return { useStore, ...render(<NotificationPanel />) };
}

describe('NotificationPanel — the record a notice opens', () => {
  it('a notice naming a decision opens that decision and closes the panel', async () => {
    const { useStore, getByTestId } = await mount([{ text: 'Decision awaiting approval: Anything', time: 'now', color: '#000', decisionId: 'DL-009' }]);
    fireEvent.click(getByTestId('notif-item'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBe('DL-009');
    expect(s.notifOpen).toBe(false);
  });

  it('a notice whose record cannot be found is explained in place, and offers the screen', async () => {
    const { useStore, getByTestId, queryByTestId } = await mount([{ text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' }]);
    fireEvent.click(getByTestId('notif-item'));
    // nothing navigated: the viewer is told, not dropped on the register
    expect(useStore.getState().screen).toBe('inbox');
    expect(getByTestId('notif-missing').textContent).toContain("isn't available");
    expect(getByTestId('notif-item').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(getByTestId('notif-missing-open'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBeNull();
    expect(s.notifOpen).toBe(false);
    expect(queryByTestId('notif-missing')).toBeNull();
  });

  it('Codex 4203544279 — while the decision read is in flight, a template notice is "loading", never "missing"', async () => {
    const { useStore, getByTestId, queryByTestId } = await mount(
      [{ text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' }],
      { decisionsLoad: 'loading' },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('inbox');
    expect(getByTestId('notif-loading').textContent).toContain("hasn't loaded");
    expect(queryByTestId('notif-missing')).toBeNull();
  });

  it('Codex 4203544271 — a client opens a decision they are not deciding in the register, not the approval screen', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'Client approved Master Bath CP Fittings — Kohler', time: 'now', color: '#000', decisionId: 'DL-009' }],
      { role: 'client' },
    );
    fireEvent.click(getByTestId('notif-item'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBe('DL-009');
  });
});

describe('the explanation belongs to its notice (Codex 4203960936)', () => {
  it('a refresh that changes the list withdraws the explanation instead of leaving it under another notice', async () => {
    const missing = { text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' };
    const { useStore, getAllByTestId, queryByTestId } = await mount([missing]);
    fireEvent.click(getAllByTestId('notif-item')[0]);
    expect(queryByTestId('notif-missing')).not.toBeNull();
    // a realtime refresh prepends ANOTHER unresolvable notice: row 0 is now a different notice, and an
    // index-keyed explanation would sit under it, explaining the wrong one
    act(() => {
      useStore.setState({ notifications: [{ text: 'New decision issued for approval: Garden Gate', time: 'now', color: '#000' }, missing] });
    });
    expect(queryByTestId('notif-missing')).toBeNull();
  });
});

describe('the local decision writers stamp their notice with the decision (Codex 4203544300)', () => {
  it('a demo approval files "Client approved …" naming its decision', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const pending = useStore.getState().decisions.find((d) => d.status === 'pending' && !d.draft)!;
    useStore.setState({ modal: { type: 'approve', decId: pending.id, optIdx: 0 } });
    useStore.getState().confirmApprove();
    expect(useStore.getState().notifications[0]).toMatchObject({ decisionId: pending.id });
    expect(useStore.getState().notifications[0].text).toMatch(/^Client approved /);
  });
});
