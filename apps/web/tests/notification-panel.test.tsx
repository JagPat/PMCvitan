import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/**
 * Live bug 1 — the bell opens the record a notice is about; a notice whose record cannot be found
 * says so in place and offers the screen, instead of dropping the viewer on the parent list.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function mount(notifications: { text: string; time: string; color: string; decisionId?: string }[]) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ notifOpen: true, notifications, role: 'pmc', screen: 'inbox' });
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
});
