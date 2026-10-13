import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Decision, Drawing, PlacedInspection, ProjectNode } from '@vitan/shared';
import { openIssueCount, placeContents } from '@/lib/locationTree';
import { placeCountWords } from '@/lib/placeCountWords';

/**
 * #633 unit 2b — the Site Map's counts. A child card read its own subtree tally (no inspections, no inherited
 * drawings) while the place it opened counted differently, so a card and its place disagreed. Counts were
 * also bare symbols ("◆ 2 ▤ 3"). Now one function counts both, in words (mockups 7 and 10), with the one
 * "open issue" rule the Dashboard uses.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'bath', parentId: 'gf', name: 'Bath', kind: 'room', order: 1 },
];
const drawing = (id: string, nodeId: string) => ({ id, number: id, title: id, nodeId, draft: false }) as unknown as Drawing;
const decision = (id: string, nodeId: string) => ({ id, title: id, room: '', nodeId, status: 'pending', options: [] }) as unknown as Decision;
const insp = (id: string, nodeId: string, openIssues?: number): PlacedInspection => ({
  id, title: id, zone: '', nodeId, kind: 'checklist', submitted: false, decided: false, failedItems: 0,
  ...(openIssues === undefined ? {} : { openIssues }),
});

async function load(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', activitiesLoad: 'ready',
    role: 'pmc', short: 'Villa B', nodes: NODES,
    drawings: [drawing('A-01', 'gf'), drawing('K-01', 'kit')],
    decisions: [decision('DL-1', 'kit'), decision('DL-2', 'kit')],
    placedInspections: [insp('INSP-2', 'kit', 1), insp('INSP-3', 'bath', 0)],
    ...overrides,
  });
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return { useStore, PlacesScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('one open-issue count', () => {
  it('sums what the server counts per inspection', () => {
    expect(openIssueCount([insp('a', 'kit', 2), insp('b', 'kit', 1), insp('c', 'kit', 0)])).toBe(3);
  });
  it('is unknown when any row comes from a server older than the field', () => {
    expect(openIssueCount([insp('a', 'kit', 2), insp('b', 'kit')])).toBeNull();
    expect(placeCountWords(placeContents('kit', NODES, [], [], [], [], [], [insp('b', 'kit')]).counts, { inspections: true, activitiesKnown: true })
      .map((w) => w.key)).toEqual(['inspections']);
  });
});

describe('counts in words', () => {
  const words = (c: Parameters<typeof placeCountWords>[0], o = { inspections: true, activitiesKnown: true }) => placeCountWords(c, o).map((w) => w.text);
  const counts = { decisions: 2, drawings: 1, photos: 0, activities: 3, materials: 0, inspections: 1, openIssues: 1 };
  it('open issues first, singular and plural, zeros left out', () => {
    expect(words(counts)).toEqual(['1 open issue', '1 inspection', '2 decisions', '1 drawing', '3 activities']);
  });
  it('a viewer without inspections never sees an inspection or issue count', () => {
    expect(words(counts, { inspections: false, activitiesKnown: true })).toEqual(['2 decisions', '1 drawing', '3 activities']);
  });
  it('activities still loading are left out, not shown as none', () => {
    expect(words(counts, { inspections: true, activitiesKnown: false })).not.toContain('3 activities');
  });
});

describe('Site Map cards match the place they open', () => {
  it('a card counts inherited drawings, inspections and open issues like the opened place', async () => {
    const { PlacesScreen, useStore } = await load();
    useStore.setState({ routeItem: 'gf' });
    const { getByTestId, unmount } = render(<PlacesScreen />);
    const card = getByTestId('place-counts-kit');
    expect(card.textContent).toBe('1 open issue1 inspection ·2 decisions ·2 drawings');
    expect(card.querySelector('[data-count="openIssues"]')).not.toBeNull();
    unmount();
    useStore.setState({ routeItem: 'kit' });
    const here = render(<PlacesScreen />).getByTestId('place-counts-here');
    expect([...here.querySelectorAll('[data-count]')].map((e) => e.textContent)).toEqual(['1 open issue', '1 inspection', '2 decisions', '2 drawings']);
  });

  it('a place with nothing filed says so', async () => {
    const { PlacesScreen, useStore } = await load({ placedInspections: [], drawings: [drawing('K-01', 'kit')] });
    useStore.setState({ routeItem: 'gf' });
    expect(render(<PlacesScreen />).getByTestId('place-counts-bath').textContent).toBe('Nothing filed here yet');
  });

  it('a client sees no inspection or issue count on a card', async () => {
    const { PlacesScreen, useStore } = await load({ role: 'client', decisions: [decision('DL-1', 'kit'), decision('DL-2', 'kit')].map((d) => ({ ...d, status: 'approved' })) });
    useStore.setState({ routeItem: 'gf' });
    expect(render(<PlacesScreen />).getByTestId('place-counts-kit').textContent).toBe('2 decisions ·2 drawings');
  });
});
