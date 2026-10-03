import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { describeLocationDelete, locationDeleteBlocked, locationDeleteImpact } from '@/lib/locationDelete';
import type { Activity, Decision, Phase, ProjectNode } from '@vitan/shared';

/**
 * Audit B3 / B4 / F-02 — the Site Map is where the location tree is built (a PMC adds a room
 * standing on the floor it belongs to), every location delete says what it does before it does
 * it, and a place's work names its phase and dates and leads to its schedule row.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'door', parentId: 'gf', name: 'Main Door', kind: 'element', order: 1 },
];

const activity = (id: string, name: string, nodeId: string, phaseId: string | null = null): Activity => ({
  id, name, zone: '', decisionId: null, phaseId, nodeId,
  ps: 0, pe: 2, as: null, ae: null, status: 'not-started',
  plannedStartDate: '2026-06-10', plannedEndDate: '2026-06-20',
  gm: 'na', gt: 'na', gi: 'na',
});

const PHASE: Phase = {
  id: 'ph-fin', name: 'Finishing', order: 0, plannedStart: 0, plannedEnd: 10,
  activityTotal: 1, done: 0, inProgress: 0, blocked: 0, notStarted: 1, donePct: 0,
} as Phase;

const decisionAt = (nodeId: string) => ({ id: 'DL-1', title: 'Counter', room: '', nodeId, status: 'pending', options: [] }) as unknown as Decision;

async function load(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc',
    short: 'Villa B',
    nodes: NODES,
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

describe('locationDeleteImpact — the server rule, said before the delete', () => {
  it('counts the locations that go with it and the records that are unfiled', () => {
    const impact = locationDeleteImpact(NODES, 'gf', {
      decisions: [], activities: [{ nodeId: 'kit' }, { nodeId: 'other' }], drawings: [{ nodeId: 'gf' }],
      inspections: [], materials: [], photos: [{ nodeId: 'door' }, { nodeId: 'door' }],
    });
    expect(impact.descendants).toBe(2);
    expect(impact.unfiled).toEqual({ activities: 1, drawings: 1, inspections: 0, materials: 0, photos: 2 });
    expect(describeLocationDelete(impact)).toBe(
      '2 locations inside it are deleted too. 1 activity, 1 drawing and 2 photos will be kept but no longer filed to a location.',
    );
    expect(locationDeleteBlocked(impact)).toBeNull();
  });

  it('a decision anywhere below blocks the delete, as the server refuses it', () => {
    const impact = locationDeleteImpact(NODES, 'gf', { decisions: [{ nodeId: 'kit' }], activities: [], drawings: [], inspections: [], materials: [], photos: [] });
    expect(locationDeleteBlocked(impact)).toBe('1 decision is filed here. Move or remove it in the Decision Log first.');
  });

  it('an empty leaf says nothing else is affected', () => {
    const impact = locationDeleteImpact(NODES, 'door', { decisions: [], activities: [], drawings: [], inspections: [], materials: [], photos: [] });
    expect(describeLocationDelete(impact)).toBe('Nothing else is filed here.');
  });
});

describe('B3 — the PMC builds the tree on the Site Map', () => {
  it('at Whole project: "+ Zone" and the full editor; no rename or delete of the project', async () => {
    const { PlacesScreen } = await load();
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-add-zone')).toBeInTheDocument();
    expect(r.getByTestId('manage-locations')).toBeInTheDocument();
    expect(r.queryByTestId('place-add-room')).toBeNull();
    expect(r.queryByTestId('place-delete')).toBeNull();
  });

  it('standing on Ground Floor, "+ Room" adds a room INSIDE it', async () => {
    const addLocationNode = vi.fn(async () => 'new-room');
    const { useStore, PlacesScreen } = await load({ addLocationNode });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add-room'));
    const input = r.getByLabelText('New room in Ground Floor');
    fireEvent.change(input, { target: { value: 'Pantry' } });
    fireEvent.click(r.getByTestId('place-structure-save'));
    await vi.waitFor(() => expect(addLocationNode).toHaveBeenCalledWith({ name: 'Pantry', kind: 'room', parentId: 'gf' }));
    await vi.waitFor(() => expect(r.queryByTestId('place-structure-form')).toBeNull());
  });

  it('an object is a leaf: it can be renamed or deleted but takes no children', async () => {
    const { useStore, PlacesScreen } = await load();
    act(() => { useStore.getState().openPlace('door'); });
    const r = render(<PlacesScreen />);
    expect(r.queryByTestId('place-add-room')).toBeNull();
    expect(r.queryByTestId('place-add-object')).toBeNull();
    expect(r.getByTestId('place-rename')).toBeInTheDocument();
  });

  it('renames the place being viewed', async () => {
    const renameNode = vi.fn();
    const { useStore, PlacesScreen } = await load({ renameNode });
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-rename'));
    const input = r.getByRole('textbox', { name: 'Rename Kitchen' });
    expect(input).toHaveValue('Kitchen');
    fireEvent.change(input, { target: { value: 'Kitchen & Pantry' } });
    fireEvent.click(r.getByTestId('place-structure-save'));
    expect(renameNode).toHaveBeenCalledWith('kit', 'Kitchen & Pantry');
  });

  it('a role without node.manage sees no structure controls', async () => {
    const { useStore, PlacesScreen } = await load({ role: 'client' });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    expect(r.queryByTestId('place-structure')).toBeNull();
    expect(r.queryByTestId('manage-locations')).toBeNull();
  });

  it('an empty project offers the PMC "+ Zone" right there, not a pointer to another screen', async () => {
    const { PlacesScreen } = await load({ nodes: [] });
    const r = render(<PlacesScreen />);
    expect(r.getByText(/Start with a zone/)).toBeInTheDocument();
    expect(r.getByTestId('place-add-zone')).toBeInTheDocument();
    expect(r.queryByText(/Decision Log/)).toBeNull();
  });
});

describe('B4 — a location delete is confirmed first', () => {
  it('nothing is deleted until the PMC confirms, and the dialog says what happens', async () => {
    const deleteNode = vi.fn();
    const { useStore, PlacesScreen } = await load({ deleteNode, activities: [activity('A-1', 'Tiling', 'kit')] });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(deleteNode).not.toHaveBeenCalled();
    const dlg = r.getByTestId('confirm-location-delete');
    expect(dlg.textContent).toContain('Delete Ground Floor?');
    expect(dlg.textContent).toContain('2 locations inside it are deleted too.');
    expect(dlg.textContent).toContain('1 activity will be kept but no longer filed to a location.');
    fireEvent.click(r.getByTestId('confirm-location-delete-cancel'));
    expect(r.queryByTestId('confirm-location-delete')).toBeNull();
    expect(deleteNode).not.toHaveBeenCalled();

    fireEvent.click(r.getByTestId('place-delete'));
    fireEvent.click(r.getByTestId('confirm-location-delete-confirm'));
    expect(deleteNode).toHaveBeenCalledWith('gf');
  });

  it('a location holding a decision offers only Close', async () => {
    const deleteNode = vi.fn();
    const { useStore, PlacesScreen } = await load({ deleteNode, decisions: [decisionAt('kit')] });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.getByTestId('confirm-location-delete-blocked').textContent).toContain('Move or remove it in the Decision Log first.');
    expect(r.queryByTestId('confirm-location-delete-confirm')).toBeNull();
  });

  it('the full Locations editor confirms its deletes too', async () => {
    const deleteNode = vi.fn();
    const { useStore } = await load({ deleteNode });
    void useStore;
    const { ManageLocationsModal } = await import('@/screens/DecisionLogScreen');
    const r = render(<ManageLocationsModal onClose={() => {}} />);
    fireEvent.click(r.getByRole('button', { name: 'Delete Main Door' }));
    expect(deleteNode).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('confirm-location-delete-confirm'));
    expect(deleteNode).toHaveBeenCalledWith('door');
  });

  it('the Decision Log no longer hosts the Locations editor', async () => {
    await load();
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    const r = render(<DecisionLogScreen />);
    expect(r.queryByTestId('manage-locations')).toBeNull();
  });
});

describe("F-02 — a place's work names its phase and dates and leads to the schedule", () => {
  it('shows the phase and planned window, and opens the schedule at that activity', async () => {
    const { useStore, PlacesScreen } = await load({ phases: [PHASE], activities: [activity('A-1', 'Tiling', 'kit', 'ph-fin')] });
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-activity-plan-A-1').textContent).toMatch(/^Finishing · Plan .+ → .+$/);
    fireEvent.click(r.getByTestId('place-activity-open-A-1'));
    expect(useStore.getState().screen).toBe('site-schedule');
    expect(useStore.getState().activityFocus).toBe('A-1');
  });

  it('an unphased activity says so', async () => {
    const { useStore, PlacesScreen } = await load({ activities: [activity('A-2', 'Wiring', 'kit')] });
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-activity-plan-A-2').textContent).toMatch(/^Unphased · Plan /);
  });

  it('a role without the schedule gets no link to it', async () => {
    const { useStore, PlacesScreen } = await load({ role: 'client', activities: [activity('A-1', 'Tiling', 'kit')] });
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    expect(r.queryByTestId('place-activity-open-A-1')).toBeNull();
  });

  it('the schedule brings the focused activity into view, outlines it, then lets go', async () => {
    const { useStore } = await load({ phases: [PHASE], activities: [activity('A-1', 'Tiling', 'kit', 'ph-fin')] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    act(() => { useStore.getState().openActivity('A-1'); });
    const r = render(<ScheduleScreen />);
    const row = r.getByTestId('sched-A-1');
    expect(row).toHaveAttribute('data-highlighted', 'true');
    expect(document.activeElement).toBe(row);
    expect(useStore.getState().activityFocus).toBeNull();
  });
});

describe('B4 — schedule deletes are confirmed first', () => {
  it('removing a phase says its activities stay, unphased', async () => {
    const deletePhase = vi.fn();
    const { ScheduleScreen } = await (async () => {
      await load({ deletePhase, phases: [PHASE], activities: [activity('A-1', 'Tiling', 'kit', 'ph-fin')] });
      return import('@/screens/ScheduleScreen');
    })();
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByRole('button', { name: 'Remove phase Finishing' }));
    expect(deletePhase).not.toHaveBeenCalled();
    expect(r.getByTestId('confirm-phase-delete').textContent).toContain('Its 1 activity stays in the schedule, under Unphased.');
    fireEvent.click(r.getByTestId('confirm-phase-delete-confirm'));
    expect(deletePhase).toHaveBeenCalledWith('ph-fin');
  });

  it('deleting an activity from its edit form asks first; Cancel returns to the form', async () => {
    const deleteActivity = vi.fn();
    const { ScheduleScreen } = await (async () => {
      await load({ deleteActivity, phases: [PHASE], activities: [activity('A-1', 'Tiling', 'kit', 'ph-fin')] });
      return import('@/screens/ScheduleScreen');
    })();
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByTestId('edit-A-1'));
    fireEvent.click(r.getByTestId('activity-delete'));
    expect(deleteActivity).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('confirm-activity-delete-cancel'));
    expect(r.getByTestId('activity-delete')).toBeInTheDocument();
    fireEvent.click(r.getByTestId('activity-delete'));
    fireEvent.click(r.getByTestId('confirm-activity-delete-confirm'));
    expect(deleteActivity).toHaveBeenCalledWith('A-1');
  });
});

describe('#699 shadow review — a delete the server refuses says why', () => {
  // Another PMC's private draft is never sent to this viewer, so the dialog can offer Delete while
  // the server's guard (which counts every decision) refuses it. The refusal must reach the viewer
  // as the server's reason, not as a network failure that sends them retrying.
  async function storeWith(deleteNode: () => Promise<unknown>) {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.getState()._setGateway({ deleteNode, snapshot: vi.fn(() => new Promise(() => {})) } as never);
    return useStore;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("a refused location delete shows the server's reason", async () => {
    const refusal = Object.assign(new Error('DELETE 400'), { status: 400, serverMessage: 'Move or remove the 1 decision(s) under this location before deleting it.' });
    const useStore = await storeWith(() => Promise.reject(refusal));
    useStore.getState().deleteNode('gf');
    await flush();
    expect(useStore.getState().toast).toBe("Couldn't delete this location — Move or remove the 1 decision(s) under this location before deleting it.");
  });

  it('a network failure still says so', async () => {
    const useStore = await storeWith(() => Promise.reject(new Error('offline')));
    useStore.getState().deleteNode('gf');
    await flush();
    expect(useStore.getState().toast).toBe('Could not reach the server — please try again.');
  });
});
