import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import type { PlacedInspection, ProjectNode } from '@vitan/shared';
import { siteMapTree } from '@/components/SiteMapTree';

/**
 * #633 unit C (mockup 10) — on a desktop the Site Map keeps the places as a tree beside the opened place: the
 * whole project, the top-level places, and the places inside each place on the path to the one on show.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'ff', parentId: null, name: 'First Floor', kind: 'zone', order: 1 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'liv', parentId: 'gf', name: 'Living Room', kind: 'room', order: 1 },
  { id: 'bed', parentId: 'ff', name: 'Bedroom', kind: 'room', order: 0 },
  { id: 'sink', parentId: 'kit', name: 'Sink', kind: 'element', order: 0 },
];
const insp = (id: string, nodeId: string, openIssues: number): PlacedInspection => ({
  id, title: id, zone: '', nodeId, kind: 'checklist', submitted: true, decided: true, failedItems: openIssues, openIssues,
});

type Item = ReturnType<typeof siteMapTree>;
const flat = (t: Item): [string | null, number][] => [[t.id, t.depth], ...t.children.flatMap(flat)];

describe('siteMapTree', () => {
  it('shows the whole project and the top-level places when nothing is open', () => {
    expect(flat(siteMapTree(NODES, null))).toEqual([[null, 0], ['gf', 1], ['ff', 1]]);
  });

  it('opens the branch down to the place on show, and no other', () => {
    expect(flat(siteMapTree(NODES, 'kit'))).toEqual([
      [null, 0], ['gf', 1], ['kit', 2], ['sink', 3], ['liv', 2], ['ff', 1],
    ]);
  });
});

async function load(role: 'pmc' | 'client', routeItem: string | null) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', activitiesLoad: 'ready', inspectionsLoad: 'ready',
    role, short: 'Villa B', nodes: NODES, routeItem,
    placedInspections: [insp('INSP-1', 'sink', 2)],
  });
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return { view: render(<PlacesScreen />), useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the desktop places tree (#633 unit C)', () => {
  it('marks the place on show, and a click opens another place', async () => {
    const { view, useStore } = await load('pmc', 'kit');
    const tree = view.getByTestId('site-map-tree');
    expect(tree.tagName).toBe('NAV');
    expect(tree.getAttribute('aria-label')).toBe('Places');
    expect(within(tree).getByTestId('site-map-tree-kit').getAttribute('aria-current')).toBe('true');
    expect(within(tree).getByTestId('site-map-tree-gf').getAttribute('aria-current')).toBeNull();
    fireEvent.click(within(tree).getByTestId('site-map-tree-ff'));
    expect(useStore.getState().routeItem).toBe('ff');
    fireEvent.click(within(tree).getByTestId('site-map-tree-project'));
    expect(useStore.getState().routeItem).toBeNull();
  });

  it('says a place has open issues, counting the places inside it, for a role that sees inspections', async () => {
    const { view } = await load('pmc', 'kit');
    const tree = view.getByTestId('site-map-tree');
    expect(within(tree).getByTestId('site-map-tree-flag-gf').textContent).toBe('2 open issues');
    expect(within(tree).getByTestId('site-map-tree-flag-sink').textContent).toBe('2 open issues');
    expect(within(tree).queryByTestId('site-map-tree-flag-liv')).toBeNull();
  });

  it('never shows inspection issues to the client', async () => {
    const { view } = await load('client', 'kit');
    const tree = view.getByTestId('site-map-tree');
    expect(within(tree).queryByTestId('site-map-tree-flag-gf')).toBeNull();
    expect(within(tree).queryByTestId('site-map-tree-flag-sink')).toBeNull();
  });

  it('nests each place in the list of the place it sits in, so its level is not only visual', async () => {
    const { view } = await load('pmc', 'kit');
    const kitchen = view.getByTestId('site-map-tree-kit');
    // button → li (Kitchen) → ul → li (Ground Floor)
    const parentItem = kitchen.parentElement?.parentElement?.closest('li');
    expect(within(parentItem as HTMLElement).getByTestId('site-map-tree-gf')).toBeTruthy();
    expect(kitchen.closest('ul')?.getAttribute('role')).toBe('list');
    expect(within(kitchen.parentElement as HTMLElement).getByTestId('site-map-tree-sink')).toBeTruthy();
  });

  it('keeps every row at the 44 px touch floor', async () => {
    const { view } = await load('pmc', 'kit');
    expect(view.getByTestId('site-map-tree-kit').style.minHeight).toBe('44px');
  });

  it('is not built at all below the desktop breakpoint', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    const { view } = await load('pmc', 'kit');
    expect(view.queryByTestId('site-map-tree')).toBeNull();
    expect(view.getByTestId('place-breadcrumb')).toBeTruthy();
  });
});
