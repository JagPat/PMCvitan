import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { describeLocationDelete, locationDeleteBlocked, visibleDecisionsUnder } from '@/lib/locationDelete';
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

describe('the location delete states the server rule, never a count it cannot vouch for (#699 root cause)', () => {
  it('a zone or room: children and other people’s drafts go; placed records are unfiled', () => {
    const text = describeLocationDelete('zone');
    expect(text).toContain('Every room and object inside it is deleted too, including private drafts other people are preparing.');
    expect(text).toContain('Activities, drawings, inspections, material deliveries and photos filed here or inside it are kept, but no longer filed to a location.');
    expect(text).toContain('the server refuses and says why');
    expect(text).not.toMatch(/\d/); // no count: the viewer never holds the whole subtree (hidden drafts, capped photos)
  });

  it('an object has no children to mention', () => {
    expect(describeLocationDelete('element')).not.toContain('room and object inside it');
  });

  it('a decision the viewer can see anywhere below is a certain refusal', () => {
    const n = visibleDecisionsUnder(NODES, 'gf', [{ nodeId: 'kit' }, { nodeId: 'elsewhere' }]);
    expect(n).toBe(1);
    expect(locationDeleteBlocked(n)).toBe('1 decision is filed here. Move or remove it in the Decision Log first.');
    expect(locationDeleteBlocked(0)).toBeNull();
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
    await vi.waitFor(() => expect(addLocationNode).toHaveBeenCalledWith({ name: 'Pantry', kind: 'room', parentId: 'gf', publish: true }));
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
    expect(dlg.textContent).toContain('Every room and object inside it is deleted too, including private drafts other people are preparing.');
    expect(dlg.textContent).not.toMatch(/\d/); // the rule, not the browser's partial count
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
    const { ManageLocationsModal } = await import('@/screens/modals/ManageLocationsModal');
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
    expect(r.getByTestId('confirm-phase-delete').textContent).toContain('Its activities stay in the schedule, under Unphased.');
    expect(r.getByTestId('confirm-phase-delete').textContent).not.toMatch(/\d/); // no count a stale read could falsify (4174270527)
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

describe('#699 Codex round 1', () => {
  it('a create is submitted once: Add is disabled while the request is pending (4174074853)', async () => {
    let finish!: (id: string) => void;
    const addLocationNode = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    const { useStore, PlacesScreen } = await load({ addLocationNode });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add-room'));
    fireEvent.change(r.getByLabelText('New room in Ground Floor'), { target: { value: 'Pantry' } });
    fireEvent.click(r.getByTestId('place-structure-save'));
    fireEvent.click(r.getByTestId('place-structure-save')); // the double-click
    fireEvent.submit(r.getByTestId('place-structure-form')); // and Enter
    expect(addLocationNode).toHaveBeenCalledTimes(1);
    expect(r.getByTestId('place-structure-save')).toBeDisabled();
    await act(async () => { finish('new-room'); });
    expect(r.queryByTestId('place-structure-form')).toBeNull();
  });

  it('a name the place already holds is refused, whatever its case or spacing (retries cannot duplicate)', async () => {
    const addLocationNode = vi.fn(async () => 'x');
    const { useStore, PlacesScreen } = await load({ addLocationNode });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add-room'));
    fireEvent.change(r.getByLabelText('New room in Ground Floor'), { target: { value: '  kitchen ' } });
    expect(r.getByTestId('place-structure-duplicate').textContent).toBe('Ground Floor already has “kitchen”.');
    expect(r.getByTestId('place-structure-save')).toBeDisabled();
    fireEvent.submit(r.getByTestId('place-structure-form'));
    expect(addLocationNode).not.toHaveBeenCalled();
  });

  it('renaming to a sibling’s name is refused, naming the parent', async () => {
    const renameNode = vi.fn();
    const { useStore, PlacesScreen } = await load({ renameNode });
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-rename'));
    fireEvent.change(r.getByRole('textbox', { name: 'Rename Kitchen' }), { target: { value: 'Main Door' } });
    expect(r.getByTestId('place-structure-duplicate').textContent).toBe('Ground Floor already has “Main Door”.');
    fireEvent.submit(r.getByTestId('place-structure-form'));
    expect(renameNode).not.toHaveBeenCalled();
  });

  it('the delete is not described, nor offered, while what is filed there has not loaded (4174074843)', async () => {
    const deleteNode = vi.fn();
    const { useStore, PlacesScreen } = await load({ deleteNode, projectLoadState: 'error' });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.getByTestId('confirm-location-delete-blocked').textContent).toContain("haven't finished loading");
    expect(r.getByTestId('confirm-location-delete').textContent).not.toContain('Every room');
    expect(r.queryByTestId('confirm-location-delete-confirm')).toBeNull();
  });

  it('a failed module-owned decisions read also withholds the delete', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    const { useStore, PlacesScreen } = await load({ decisionsLoad: 'error' });
    act(() => { useStore.getState().openPlace('door'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.queryByTestId('confirm-location-delete-confirm')).toBeNull();
    cleanup();
    useStore.setState({ decisionsLoad: 'ready' });
    const again = render(<PlacesScreen />);
    act(() => { useStore.getState().openPlace('door'); });
    fireEvent.click(again.getByTestId('place-delete'));
    expect(again.getByTestId('confirm-location-delete-confirm')).toBeInTheDocument();
  });

  it('the activity delete names every server blocker (4174074850)', async () => {
    const { ScheduleScreen } = await (async () => {
      await load({ phases: [PHASE], activities: [activity('A-1', 'Tiling', 'kit', 'ph-fin')] });
      return import('@/screens/ScheduleScreen');
    })();
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByTestId('edit-A-1'));
    fireEvent.click(r.getByTestId('activity-delete'));
    expect(r.getByTestId('confirm-activity-delete').textContent).toContain('inspections or material records');
  });

  it('the Locations editor is its own module; the Decision Log no longer carries it (4174074847)', async () => {
    const log = await import('@/screens/DecisionLogScreen');
    expect('ManageLocationsModal' in log).toBe(false);
    const mod = await import('@/screens/modals/ManageLocationsModal');
    expect(typeof mod.ManageLocationsModal).toBe('function');
  });
});

describe('#699 shadow review round 2', () => {
  async function storeWith(deleteNode: () => Promise<unknown>) {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.getState()._setGateway({ deleteNode, snapshot: vi.fn(() => new Promise(() => {})) } as never);
    return useStore;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a refusal with no readable reason still says it was refused, never "could not reach the server"', async () => {
    const useStore = await storeWith(() => Promise.reject(Object.assign(new Error('DELETE 403'), { status: 403 })));
    useStore.getState().deleteNode('gf');
    await flush();
    expect(useStore.getState().toast).toBe("Couldn't delete this location — the server refused it");
  });
});

describe('#699 Codex round 2 — no partial count is ever shown as complete', () => {
  it("another PMC's hidden draft room below is covered by the rule, not missed by a count (4174270523)", async () => {
    // the viewer's tree has no children under Main Door's zone sibling; the server may hold drafts there
    const { useStore, PlacesScreen } = await load({ nodes: [{ id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }] });
    act(() => { useStore.getState().openPlace('gf'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.getByTestId('confirm-location-delete').textContent).toContain('including private drafts other people are preparing');
  });

  it('photos beyond the snapshot cap are covered by the rule, not left out of a count (4174270519)', async () => {
    const { useStore, PlacesScreen } = await load({ photos: [] }); // the snapshot holds none of this place's photos
    act(() => { useStore.getState().openPlace('kit'); });
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.getByTestId('confirm-location-delete').textContent).toContain('photos filed here or inside it are kept, but no longer filed to a location');
  });
});
