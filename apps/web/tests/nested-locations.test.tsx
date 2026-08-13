import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { ProjectNode } from '@vitan/shared';

/**
 * Phase 6 task 2 — nested locations, the §C reader probes P9 (the Locations dialog can
 * BUILD both new shapes) and P13 (the filing picker can SELECT AND CREATE both new
 * shapes at any legal depth).
 *
 * §C's finding: the fixed-depth assumption lives in the READERS too. The dialog only
 * created zones (rooms existed only because the picker offered create-as-you-type),
 * and the picker held state for exactly `zone`/`room` with three fixed rows — so a
 * fourth-level room was unreachable from every filing flow and a zone-level element
 * could not be selected at all. Labels stay 'Room'/'Object' — the copy belongs to the
 * deferred rename; only the STRUCTURE changes here.
 */

const NESTED: ProjectNode[] = [
  { id: 'z1', parentId: null, name: 'Site', kind: 'zone', order: 0 },
  { id: 'w1', parentId: 'z1', name: 'West Wing', kind: 'room', order: 0 },
  { id: 'w2', parentId: 'w1', name: 'Pour 2', kind: 'room', order: 0 },
  { id: 'g1', parentId: 'z1', name: 'Site Gate', kind: 'element', order: 1 },
];

const DEEP: ProjectNode[] = [
  { id: 'z1', parentId: null, name: 'Site', kind: 'zone', order: 0 },
  { id: 'r1', parentId: 'z1', name: 'L2', kind: 'room', order: 0 },
  { id: 'r2', parentId: 'r1', name: 'L3', kind: 'room', order: 0 },
  { id: 'r3', parentId: 'r2', name: 'L4', kind: 'room', order: 0 },
  { id: 'r4', parentId: 'r3', name: 'L5', kind: 'room', order: 0 },
];

type Store = typeof import('@/store/store');

async function loadStore(nodes: ProjectNode[], overrides: Record<string, unknown> = {}): Promise<Store['useStore']> {
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
    short: 'Villa Bodakdev',
    nodes,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return useStore;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── P13 — the filing picker: structural recursion, select AND create ───────────────────

describe('P13 — LocationPicker on a nested tree', () => {
  const renderPicker = async (nodes: ProjectNode[], addLocationNode = vi.fn(async () => 'new-id')) => {
    const useStore = await loadStore(nodes, { addLocationNode });
    const { LocationPicker } = await import('@/components/LocationPicker');
    const onChange = vi.fn();
    const r = render(<LocationPicker value={null} onChange={onChange} idPrefix="p13" />);
    return { r, onChange, addLocationNode, useStore };
  };

  it('a nested room (level 3) is reachable and SELECTABLE; the deepest choice is the filed target', async () => {
    const { r, onChange } = await renderPicker(NESTED);
    fireEvent.change(r.getByTestId('p13-select-zone'), { target: { value: 'z1' } });
    expect(onChange).toHaveBeenLastCalledWith('z1');
    fireEvent.change(r.getByTestId('p13-select-d1'), { target: { value: 'w1' } });
    expect(onChange).toHaveBeenLastCalledWith('w1');
    fireEvent.change(r.getByTestId('p13-select-d2'), { target: { value: 'w2' } });
    expect(onChange).toHaveBeenLastCalledWith('w2');
  });

  it('an element directly under a zone is offered and SELECTABLE (never shown as a room level)', async () => {
    const { r, onChange } = await renderPicker(NESTED);
    fireEvent.change(r.getByTestId('p13-select-zone'), { target: { value: 'z1' } });
    const level1 = r.getByTestId('p13-select-d1') as HTMLSelectElement;
    const optionValues = [...level1.options].map((o) => o.value);
    expect(optionValues).toContain('g1'); // the zone-level element is a child option here
    fireEvent.change(level1, { target: { value: 'g1' } });
    expect(onChange).toHaveBeenLastCalledWith('g1');
    // an element is a LEAF — no further level renders below it
    expect(r.queryByTestId('p13-select-d2')).toBeNull();
  });

  it('CREATES inline: a room under a room, and an element directly under a zone', async () => {
    const { r, addLocationNode } = await renderPicker(NESTED);
    fireEvent.change(r.getByTestId('p13-select-zone'), { target: { value: 'z1' } });
    // an element directly under the zone, from level 1's create control
    fireEvent.change(r.getByTestId('p13-select-d1'), { target: { value: '__new_element__' } });
    fireEvent.change(r.getByTestId('p13-new-element-d1'), { target: { value: 'Gate 2' } });
    fireEvent.keyDown(r.getByTestId('p13-new-element-d1'), { key: 'Enter' });
    await vi.waitFor(() => expect(addLocationNode).toHaveBeenCalledWith({ name: 'Gate 2', kind: 'element', parentId: 'z1' }));
    // the level's select returns once the inline create settles
    await r.findByTestId('p13-select-d1');
    // a room under the room West Wing, from level 2's create control
    fireEvent.change(r.getByTestId('p13-select-d1'), { target: { value: 'w1' } });
    fireEvent.change(r.getByTestId('p13-select-d2'), { target: { value: '__new_room__' } });
    fireEvent.change(r.getByTestId('p13-new-room-d2'), { target: { value: 'Pour 3' } });
    fireEvent.keyDown(r.getByTestId('p13-new-room-d2'), { key: 'Enter' });
    await vi.waitFor(() => expect(addLocationNode).toHaveBeenCalledWith({ name: 'Pour 3', kind: 'room', parentId: 'w1' }));
  });

  it('stops at the depth cap: no sixth level is offered below a level-5 room', async () => {
    const { r } = await renderPicker(DEEP);
    fireEvent.change(r.getByTestId('p13-select-zone'), { target: { value: 'z1' } });
    fireEvent.change(r.getByTestId('p13-select-d1'), { target: { value: 'r1' } });
    fireEvent.change(r.getByTestId('p13-select-d2'), { target: { value: 'r2' } });
    fireEvent.change(r.getByTestId('p13-select-d3'), { target: { value: 'r3' } });
    fireEvent.change(r.getByTestId('p13-select-d4'), { target: { value: 'r4' } });
    expect(r.queryByTestId('p13-select-d5')).toBeNull();
  });
});

// ── P9 — the Locations dialog can BUILD both new shapes ────────────────────────────────

describe('P9 — the Locations dialog add-child control', () => {
  const renderDialog = async (nodes: ProjectNode[], addLocationNode = vi.fn(async () => 'new-id')) => {
    await loadStore(nodes, { addLocationNode });
    const { ManageLocationsModal } = await import('@/screens/DecisionLogScreen');
    const r = render(<ManageLocationsModal onClose={() => {}} />);
    return { r, addLocationNode };
  };

  it('a zone row can add a room AND an object; a room row can add a room AND an object; an element row adds nothing', async () => {
    const { r } = await renderDialog(NESTED);
    expect(r.getByTestId('loc-add-room-z1')).toBeTruthy();
    expect(r.getByTestId('loc-add-element-z1')).toBeTruthy();
    expect(r.getByTestId('loc-add-room-w1')).toBeTruthy();
    expect(r.getByTestId('loc-add-element-w1')).toBeTruthy();
    expect(r.queryByTestId('loc-add-room-g1')).toBeNull();
    expect(r.queryByTestId('loc-add-element-g1')).toBeNull();
  });

  it('builds a room under a ROOM (the nested shape) through the dialog', async () => {
    const { r, addLocationNode } = await renderDialog(NESTED);
    fireEvent.click(r.getByTestId('loc-add-room-w1'));
    const input = r.getByTestId('loc-add-input-w1');
    fireEvent.change(input, { target: { value: 'Pour 3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(addLocationNode).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pour 3', kind: 'room', parentId: 'w1' })));
  });

  it('builds an element directly under a ZONE through the dialog', async () => {
    const { r, addLocationNode } = await renderDialog(NESTED);
    fireEvent.click(r.getByTestId('loc-add-element-z1'));
    const input = r.getByTestId('loc-add-input-z1');
    fireEvent.change(input, { target: { value: 'Site Gate 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(addLocationNode).toHaveBeenCalledWith(expect.objectContaining({ name: 'Site Gate 2', kind: 'element', parentId: 'z1' })));
  });

  it('offers no add-child at the depth cap (a level-5 room cannot take children)', async () => {
    const { r } = await renderDialog(DEEP);
    expect(r.queryByTestId('loc-add-room-r4')).toBeNull();
    expect(r.queryByTestId('loc-add-element-r4')).toBeNull();
    expect(r.getByTestId('loc-add-room-r3')).toBeTruthy(); // level-4's children land at 5 — still legal
  });
});

// ── P11's PUBLIC UI DOOR (Codex round 1 on #333) — the New Project modal must EXPRESS the target ──

describe('the New Project modal expresses the room-anchor graft target', () => {
  const DOOR_MODULE = {
    id: 'mod-door', name: 'Main Door', category: 'element', anchorKind: 'room',
    version: 1, description: '', counts: { nodes: 1, phases: 0, activities: 0, inspections: 0 },
  };
  const ZONE_MODULE = {
    id: 'mod-wing', name: 'Wing', category: 'zone', anchorKind: 'zone',
    version: 1, description: '', counts: { nodes: 2, phases: 0, activities: 0, inspections: 0 },
  };

  const renderModal = async () => {
    const createProject = vi.fn();
    const useStore = await loadStore([], {
      createProject,
      orgModules: [DOOR_MODULE, ZONE_MODULE],
      orgTemplates: [],
      memberships: [],
      loadOrgModules: vi.fn(),
      loadOrgTemplates: vi.fn(),
    });
    void useStore;
    const { CreateProjectModal } = await import('@/layout/ProjectSwitcher');
    const r = render(<CreateProjectModal orgId="org-1" onClose={() => {}} />);
    fireEvent.change(r.getByPlaceholderText(/Full name/), { target: { value: 'P' } });
    fireEvent.change(r.getByPlaceholderText(/Short name/), { target: { value: 'p' } });
    return { r, createProject };
  };

  it('an element-root module pick sends underRoom for the named room', async () => {
    const { r, createProject } = await renderModal();
    fireEvent.click(r.getByTestId('np-module-mod-door'));
    fireEvent.change(r.getByTestId('np-under-room-mod-door'), { target: { value: 'Master Bedroom' } });
    fireEvent.click(r.getByRole('button', { name: 'Create' }));
    expect(createProject).toHaveBeenCalledWith('org-1', expect.objectContaining({
      modules: [{ moduleId: 'mod-door', count: 1, underRoom: 'Master Bedroom' }],
    }));
  });

  it('the same pick can target a zone instead (the element-under-zone edge), sending underZone', async () => {
    const { r, createProject } = await renderModal();
    fireEvent.click(r.getByTestId('np-module-mod-door'));
    fireEvent.change(r.getByTestId('np-target-kind-mod-door'), { target: { value: 'zone' } });
    fireEvent.change(r.getByTestId('np-under-zone-mod-door'), { target: { value: 'Entrance' } });
    fireEvent.click(r.getByRole('button', { name: 'Create' }));
    expect(createProject).toHaveBeenCalledWith('org-1', expect.objectContaining({
      modules: [{ moduleId: 'mod-door', count: 1, underZone: 'Entrance' }],
    }));
  });

  it('Create is disabled while an element-root pick has NO target — the guaranteed 400 is never sent', async () => {
    const { r, createProject } = await renderModal();
    fireEvent.click(r.getByTestId('np-module-mod-door'));
    const create = r.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(createProject).not.toHaveBeenCalled();
    fireEvent.change(r.getByTestId('np-under-room-mod-door'), { target: { value: 'Bed' } });
    expect((r.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a zone-anchored module keeps its existing optional underZone input and payload shape', async () => {
    const { r, createProject } = await renderModal();
    fireEvent.click(r.getByTestId('np-module-mod-wing'));
    expect(r.queryByTestId('np-target-kind-mod-wing')).toBeNull(); // no room-target controls for zone anchors
    fireEvent.click(r.getByRole('button', { name: 'Create' }));
    expect(createProject).toHaveBeenCalledWith('org-1', expect.objectContaining({
      modules: [{ moduleId: 'mod-wing', count: 1 }],
    }));
  });
});
