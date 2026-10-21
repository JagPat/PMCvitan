import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import type { Decision, Drawing, PlacedInspection, ProjectNode } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #633 unit A (mockup 7) — the opened place lists "Places inside" and then "Work and records here": one
 * section per kind of record, inspections with open issues first, each row opening its own record.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
];
const drawing = (id: string, nodeId: string) => ({ id, number: id, title: id, nodeId, draft: false }) as unknown as Drawing;
const decision = (id: string, nodeId: string) => ({ id, title: id, room: '', nodeId, status: 'pending', options: [] }) as unknown as Decision;
const insp = (id: string, nodeId: string, openIssues: number): PlacedInspection => ({
  id, title: id, zone: '', nodeId, kind: 'checklist', submitted: true, decided: true, failedItems: 0, openIssues,
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
    drawings: [drawing('K-01', 'kit')],
    decisions: [decision('DL-1', 'kit')],
    placedInspections: [insp('INSP-1', 'kit', 0), insp('INSP-2', 'kit', 2)],
  });
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return render(<PlacesScreen />);
}

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/PlacesScreen'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Work and records here (#633 mockup 7)', () => {
  it('names the place and lists its records in order: inspections, decisions, work, drawings, materials, photos', async () => {
    const r = await load('pmc', 'kit');
    const panel = r.getByTestId('place-work-records');
    expect(within(panel).getByRole('heading', { level: 2, name: 'Work and records here' })).toBeTruthy();
    expect(r.getByTestId('place-work-records-where').textContent).toBe('At Kitchen');
    const keys = Array.from(panel.querySelectorAll('[data-testid^="place-section-"]')).map((el) => el.getAttribute('data-testid'));
    expect(keys).toEqual(['inspections', 'decisions', 'work', 'drawings', 'materials', 'photos'].map((k) => `place-section-${k}`));
  });

  it('puts the inspection with open issues first and says how many', async () => {
    const r = await load('pmc', 'kit');
    const rows = Array.from(r.getByTestId('place-section-inspections').querySelectorAll('[data-testid^="place-inspection-INSP"]'));
    expect(rows.map((el) => el.getAttribute('data-testid'))).toEqual(['place-inspection-INSP-2', 'place-inspection-INSP-1']);
    expect(r.getByTestId('place-inspection-issues-INSP-2').textContent).toBe('2 open issues');
    expect(r.queryByTestId('place-inspection-issues-INSP-1')).toBeNull();
  });

  it('a role without inspections gets no inspections section', async () => {
    const r = await load('client', 'kit');
    expect(r.queryByTestId('place-section-inspections')).toBeNull();
    expect(r.getByTestId('place-section-decisions')).toBeTruthy();
  });

  it('shows "Places inside" above the child places, and the whole project when nothing is opened', async () => {
    const r = await load('pmc', 'gf');
    expect(r.getByTestId('place-children-title').textContent).toBe('Places inside');
    expect(r.getByTestId('place-work-records-where').textContent).toBe('At Ground Floor and the places inside it');
    cleanup();
    const top = await load('pmc', null);
    expect(top.getByTestId('place-work-records-where').textContent).toBe('Across the whole project');
  });
});
