import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * #482 QA (Jagrut, 15 Oct 2026, item 5) — reopening an approved decision is the client's call (and the PMC's,
 * on their behalf). The engineer, contractor and consultant see a locked decision as locked, with no
 * "Request change" button; the server refuses them too (`decision.change` is pmc + client).
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function lockedCards(role: string) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: role as never, screen: 'decision-log' });
  const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
  const view = render(<DecisionLogScreen />);
  const locked = useStore.getState().decisions.filter((d) => d.status === 'approved');
  return { view, locked };
}

describe('"Request change" on a locked decision (#482 QA item 5)', () => {
  it.each(['pmc', 'client'])('the %s sees it on every locked decision', async (role) => {
    const { view, locked } = await lockedCards(role);
    expect(locked.length).toBeGreaterThan(0);
    for (const d of locked) {
      if (view.queryByTestId(`edit-state-${d.id}`)) expect(view.getByTestId(`request-change-${d.id}`)).toBeTruthy();
    }
    expect(view.queryAllByTestId(/^request-change-/).length).toBeGreaterThan(0);
  });

  it.each(['engineer', 'contractor', 'consultant'])('the %s sees the decision locked, without the button', async (role) => {
    const { view } = await lockedCards(role);
    expect(view.queryAllByText('Locked after approval — the approved choice is the record.').length).toBeGreaterThan(0);
    expect(view.queryAllByTestId(/^request-change-/)).toHaveLength(0);
  });
});
