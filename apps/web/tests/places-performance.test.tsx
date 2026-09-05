import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Photo, ProjectNode } from '@vitan/shared';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.resetModules(); });

it('counts every Site Map card without rescanning all photos for each card', async () => {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const { emptyProjectData } = await import('@/store/projectScope');
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  const count = 40;
  const nodes: ProjectNode[] = Array.from({ length: count }, (_, i) => [
    { id: `z${i}`, parentId: null, name: `Zone ${i}`, kind: 'zone' as const, order: i },
    { id: `r${i}`, parentId: `z${i}`, name: `Room ${i}`, kind: 'room' as const, order: 0 },
  ]).flat();
  let locationReads = 0;
  const photos: Photo[] = nodes.map((node, i) => ({
    id: `p${i}`, url: `/media/p${i}`, kind: 'progress',
    get nodeId() { locationReads += 1; return node.id; },
  }));
  useStore.setState({
    ...getInitialState(), ...emptyProjectData(), role: 'pmc',
    activeProjectId: 'site-a', projectLoadState: 'ready', nodes, photos,
  });
  locationReads = 0;
  const view = render(<PlacesScreen />);
  for (let i = 0; i < count; i += 1) {
    expect(view.getByTestId(`place-node-z${i}`).querySelector('[title="photos"]')).toHaveTextContent('2');
  }
  expect(locationReads).toBeLessThanOrEqual(photos.length * 4);
});
