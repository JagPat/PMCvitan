import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import type { Decision, ProjectNode } from '@vitan/shared';

/**
 * #633 unit B (UX brief §10) — the Site Map says what its colours mean, and a locked record says why it is
 * locked and how to change it.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
];
const decision = (id: string, status: Decision['status']) =>
  ({ id, title: id, room: '', nodeId: 'kit', status, options: [] }) as unknown as Decision;

async function load(role: 'pmc' | 'client' | 'contractor') {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', activitiesLoad: 'ready', inspectionsLoad: 'ready',
    role, short: 'Villa B', nodes: NODES, routeItem: 'kit',
    decisions: [decision('DL-1', 'approved'), decision('DL-2', 'pending')],
  });
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return render(<PlacesScreen />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Site Map colours and locks (#633 unit B)', () => {
  it('shows one "Colours mean" key, each colour named in words', async () => {
    const view = await load('pmc');
    const legend = view.getByTestId('site-map-legend');
    expect(view.getAllByTestId('site-map-legend')).toHaveLength(1);
    expect(within(legend).getByText('Colours mean')).toBeTruthy();
    expect(within(legend).getByTestId('site-map-legend-done').textContent).toBe('Done, or approved and locked');
    expect(within(legend).getByTestId('site-map-legend-under-way').textContent).toBe('Under way, or waiting on someone');
    expect(within(legend).getByTestId('site-map-legend-attention').textContent).toBe('Blocked, failed or an open issue');
    expect(within(legend).getByTestId('site-map-legend-not-started').textContent).toBe('Not started');
    expect(legend.getAttribute('role')).toBe('group');
    expect(legend.getAttribute('aria-labelledby')).toBe('site-map-legend-title');
  });

  for (const role of ['pmc', 'client', 'contractor'] as const) {
    it(`a locked decision says why and how to change it, and an open one does not (${role})`, async () => {
      const view = await load(role);
      const locked = view.getByTestId('place-decision-DL-1');
      expect(within(locked).getByTestId('place-decision-lock-DL-1').textContent).toBe('Locked after approval. Open it to request a change.');
      expect(view.queryByTestId('place-decision-lock-DL-2')).toBeNull();
    });
  }
});
