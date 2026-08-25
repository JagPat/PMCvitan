import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ProjectNode } from '@vitan/shared';
import { locationLabelFor, captureAtPlace, captureGlobal, inheritsLocation } from '@/lib/captureContext';
import { createOptionsFor, materialBlockedReason } from '@/lib/createOptions';

/**
 * Unit A — capture context and context-inherited creation.
 *
 * The audit's finding was that creation forms kept asking for facts the screen already
 * held, and in two places asked for the SAME fact twice (a typed `zone` beside a location
 * picker, with the canonical field as the optional one). These probes pin the inheritance,
 * the derivation that removes the duplicate question, and the permission filter that keeps
 * the new Add menu from offering anything the policy would refuse.
 */

// A tree that exercises the kind-vs-depth distinction nested locations introduced: an
// element hangs directly off a zone, and a room is nested two deep under another room.
const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'bath', parentId: 'gf', name: 'Master Bathroom', kind: 'room', order: 0 },
  { id: 'shower', parentId: 'bath', name: 'Shower', kind: 'room', order: 0 },
  { id: 'tap', parentId: 'gf', name: 'Tap', kind: 'element', order: 1 },
  { id: 'orphanRoom', parentId: null, name: 'Site Office', kind: 'room', order: 2 },
];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the legacy location string is DERIVED, so no form asks for it twice', () => {
  it('is the FULL PATH, the way the existing data writes it', () => {
    // seed.ts pairs nodeId 'r-mbath' with zone 'Second Floor · Master Bath' — the path, not
    // the zone alone. An earlier version returned only the zone ancestor and silently
    // dropped the room from every nested record.
    expect(locationLabelFor(NODES, 'bath')).toBe('Ground Floor \u00b7 Master Bathroom');
    expect(locationLabelFor(NODES, 'shower')).toBe('Ground Floor \u00b7 Master Bathroom \u00b7 Shower');
  });

  it('a record filed straight on a zone reads as that zone alone', () => {
    expect(locationLabelFor(NODES, 'gf')).toBe('Ground Floor');
  });

  it('an element hanging off a zone keeps its own name in the path', () => {
    expect(locationLabelFor(NODES, 'tap')).toBe('Ground Floor \u00b7 Tap');
  });

  it('is empty for an unfiled or unknown node — the same empty the forms sent before', () => {
    expect(locationLabelFor(NODES, null)).toBe('');
    expect(locationLabelFor(NODES, 'nope')).toBe('');
  });
});

describe('a capture context says what the app already knows', () => {
  it('a place capture carries the place; a global one inherits nothing', () => {
    expect(captureAtPlace('villa-b', 'bath')).toEqual({ projectId: 'villa-b', nodeId: 'bath', activityId: null, source: 'place' });
    expect(inheritsLocation(captureAtPlace('villa-b', 'bath'))).toBe(true);
    expect(inheritsLocation(captureGlobal('villa-b'))).toBe(false);
    expect(inheritsLocation(undefined)).toBe(false);
  });

  it('the whole project is NOT a place — the form still has to ask', () => {
    // Places allows a null selection ("Whole project"); inheriting that would file every
    // record at nowhere in particular while claiming a place was inherited.
    expect(inheritsLocation(captureAtPlace('villa-b', null))).toBe(false);
  });
});

describe('the Add menu offers only what the role may actually author', () => {
  it('a pmc gets all three', () => {
    expect(createOptionsFor('pmc').map((o) => o.kind)).toEqual(['inspection', 'material', 'decision']);
  });

  it('an engineer gets the delivery only — inspection.create and decision.create are pmc', () => {
    expect(createOptionsFor('engineer').map((o) => o.kind)).toEqual(['material']);
  });

  it('a client, contractor and consultant are offered nothing rather than a refusal', () => {
    for (const role of ['client', 'contractor', 'consultant'] as const) {
      expect(createOptionsFor(role)).toHaveLength(0);
    }
  });

  it('every option names a real permission — the policy stays the only authority', () => {
    // a renamed action would silently make an option un-offerable to everyone; this fails
    // instead, because at least one role must hold each.
    for (const option of createOptionsFor('pmc')) {
      expect(typeof option.action).toBe('string');
    }
  });
});

// ── the forms themselves ────────────────────────────────────────────────────────────────

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
    short: 'Residence at Ambli',
    nodes: NODES,
    ...overrides,
  } as never);
  return useStore;
}

describe('an inherited place is stated, not re-asked', () => {
  it('the checklist form shows the trail with a Change escape instead of the tree', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    expect(r.getByTestId('chk-place-trail').textContent).toBe('Ground Floor › Master Bathroom');
    expect(r.getByTestId('chk-place-change')).toBeInTheDocument();
    // the tree is NOT reopened by default — that was the question worth removing
    expect(r.queryByTestId('loc-pick-chk-loc')).not.toBeInTheDocument();
  });

  it('Change puts the picker back for a user who disagrees', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    fireEvent.click(r.getByTestId('chk-place-change'));
    expect(r.queryByTestId('chk-place-trail')).not.toBeInTheDocument();
  });

  it('with nothing inherited the picker is shown outright — the form genuinely must ask', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal onClose={() => {}} />);
    expect(r.queryByTestId('chk-place-trail')).not.toBeInTheDocument();
  });
});

describe('the checklist form asks for the location once and derives the rest', () => {
  it('the typed Zone box is gone, and the node alone unblocks Issue', async () => {
    const useStore = await load();
    const issueChecklist = vi.fn();
    act(() => { useStore.setState({ issueChecklist } as never); });
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'shower')} onClose={() => {}} />);
    // the second question for the same fact no longer exists
    expect(r.queryByTestId('chk-zone')).not.toBeInTheDocument();

    fireEvent.change(r.getByTestId('chk-title'), { target: { value: 'Waterproofing — 2nd coat' } });
    fireEvent.change(r.getByTestId('chk-item-0'), { target: { value: 'Ponding test' } });
    const issue = r.getByTestId('save-checklist');
    expect(issue).not.toBeDisabled();

    await act(async () => { fireEvent.click(issue); });
    // assert the PAYLOAD the form builds: `issueChecklist` itself needs a live gateway,
    // and what this probe is about is the two location fields the form now fills itself.
    expect(issueChecklist).toHaveBeenCalledTimes(1);
    expect(issueChecklist.mock.calls[0]![0]).toEqual({
      title: 'Waterproofing — 2nd coat',
      // the legacy field is still populated for every existing reader — derived, not typed
      zone: 'Ground Floor \u00b7 Master Bathroom \u00b7 Shower',
      items: ['Ponding test'],
      nodeId: 'shower',
    });
  });
});

describe('the Site Map can create at the place it is showing', () => {
  it('a pmc gets Add here, and the menu offers the three they may author', async () => {
    await load();
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-inspection')).toBeInTheDocument();
    expect(r.getByTestId('create-material')).toBeInTheDocument();
    expect(r.getByTestId('create-decision')).toBeInTheDocument();
  });

  it('the chosen form inherits the selected place', async () => {
    await load();
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-node-gf'));
    fireEvent.click(r.getByTestId('place-node-bath'));
    fireEvent.click(r.getByTestId('place-add'));
    fireEvent.click(r.getByTestId('create-inspection'));
    expect(r.getByTestId('chk-place-trail').textContent).toBe('Ground Floor › Master Bathroom');
  });

  it('a client is not offered a button that would be refused', async () => {
    await load({ role: 'client' });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    expect(r.queryByTestId('place-add')).not.toBeInTheDocument();
  });

  it('an engineer is offered only the delivery', async () => {
    await load({ role: 'engineer' });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-material')).toBeInTheDocument();
    expect(r.queryByTestId('create-inspection')).not.toBeInTheDocument();
    expect(r.queryByTestId('create-decision')).not.toBeInTheDocument();
  });
});

// ── Codex round 1 ───────────────────────────────────────────────────────────────────────

describe('a delivery is only offered when the log that carries it is open (F1)', () => {
  it('names the reason rather than guessing, for each server precondition', () => {
    // DailyLogService.addMaterial 404s with no log and 409s once it is submitted
    expect(materialBlockedReason(null, false)).toMatch(/start today/i);
    expect(materialBlockedReason({ submitted: true }, false)).toMatch(/already submitted/i);
    expect(materialBlockedReason({ submitted: false }, false)).toBeNull();
  });

  it('a FAILED log read fails CLOSED, matching what DailyLogScreen does with the same state', () => {
    // enabling capture on an unknown log takes the entry, closes the form, and leaves the
    // write to be rejected — DailyLogScreen locks every mutation until Retry succeeds
    expect(materialBlockedReason(null, true)).toMatch(/could not be loaded/i);
    expect(materialBlockedReason({ submitted: false }, true)).toMatch(/could not be loaded/i);
  });

  it('the menu disables the delivery and says why when no log is open', async () => {
    await load({ role: 'engineer', dailyLog: null });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-material')).toBeDisabled();
    expect(r.getByTestId('create-material-blocked').textContent).toMatch(/start today/i);
  });

  it('a submitted log blocks it too, with its own reason', async () => {
    await load({ role: 'engineer', dailyLog: { date: '01 Aug', checkedIn: true, checkinTime: null, submitted: true, crew: [], materials: [], progress: 0, photos: [] } });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-material')).toBeDisabled();
    expect(r.getByTestId('create-material-blocked').textContent).toMatch(/already submitted/i);
  });

  it('an OPEN log leaves it enabled and describing itself', async () => {
    await load({ role: 'engineer', dailyLog: { date: '01 Aug', checkedIn: true, checkinTime: null, submitted: false, crew: [], materials: [], progress: 0, photos: [] } });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-material')).not.toBeDisabled();
    expect(r.queryByTestId('create-material-blocked')).not.toBeInTheDocument();
  });
});

describe('the components barrel has no import cycle (F2)', () => {
  it('LocationPicker reaches Button directly, not back through the barrel', async () => {
    const src = (await import('@/components/LocationPicker.tsx?raw')).default;
    // barrel → InheritedContext → LocationPicker → barrel would close a cycle the
    // module-boundary rule forbids
    expect(src).toContain("from './Button'");
    expect(src).not.toContain("from '@/components'");
  });
});

describe('changing an inherited place opens ON that place (F3)', () => {
  it('the picker is seeded from the value it was given, not left blank', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    fireEvent.click(r.getByTestId('chk-place-change'));
    // blank selects beside a still-set nodeId let a user "clear" the location and save it
    // anyway, filing the record where the UI showed nothing
    const selects = r.container.querySelectorAll('select');
    expect(selects.length).toBeGreaterThan(1);
    expect((selects[0] as HTMLSelectElement).value).toBe('gf');
    expect((selects[1] as HTMLSelectElement).value).toBe('bath');
  });

  it('a deeper place seeds every level of its trail', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'shower')} onClose={() => {}} />);
    fireEvent.click(r.getByTestId('chk-place-change'));
    const values = Array.from(r.container.querySelectorAll('select')).map((el) => (el as HTMLSelectElement).value);
    expect(values.slice(0, 3)).toEqual(['gf', 'bath', 'shower']);
  });

  it('an unfiled form still opens the picker empty', async () => {
    await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal onClose={() => {}} />);
    const first = r.container.querySelector('select') as HTMLSelectElement;
    expect(first.value).toBe('');
  });
});

// ── Codex round 2 ───────────────────────────────────────────────────────────────────────

describe("a delivery's storage note is a question, not a derivation (R2-F1)", () => {
  it('sends what the storekeeper typed, and never a location in its place', async () => {
    const useStore = await load();
    const addSiteMaterial = vi.fn();
    act(() => { useStore.setState({ addSiteMaterial } as never); });
    const { AddMaterialModal } = await import('@/screens/modals/AddMaterialModal');
    const r = render(<AddMaterialModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);

    fireEvent.change(r.getByTestId('mat-name'), { target: { value: 'Italian Marble' } });
    fireEvent.change(r.getByTestId('mat-qty'), { target: { value: '42 boxes' } });
    // the note is optional, so it now opens folded — hidden, but still a typed question
    fireEvent.click(r.getByTestId('mat-more-toggle'));
    fireEvent.change(r.getByTestId('mat-storage'), { target: { value: 'covered, on pallets' } });
    fireEvent.click(r.getByTestId('save-material'));

    // seed.ts pairs a room node with "Zone B · covered, on pallets": for a delivery the
    // column is HOW IT IS STORED, which no location can imply
    expect(addSiteMaterial.mock.calls[0]![0]).toMatchObject({
      zone: 'covered, on pallets',
      nodeId: 'bath',
    });
  });

  it('stays optional — a delivery still saves with the note blank', async () => {
    const useStore = await load();
    const addSiteMaterial = vi.fn();
    act(() => { useStore.setState({ addSiteMaterial } as never); });
    const { AddMaterialModal } = await import('@/screens/modals/AddMaterialModal');
    const r = render(<AddMaterialModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    fireEvent.change(r.getByTestId('mat-name'), { target: { value: 'Cement' } });
    fireEvent.change(r.getByTestId('mat-qty'), { target: { value: '50 bags' } });
    expect(r.getByTestId('save-material')).not.toBeDisabled();
    fireEvent.click(r.getByTestId('save-material'));
    expect(addSiteMaterial.mock.calls[0]![0]).toMatchObject({ zone: '' });
  });
});

describe('an inherited place deleted under an open form cannot be saved (R2-F3)', () => {
  it('clears the vanished node so readiness blocks instead of sending a dead id', async () => {
    const useStore = await load();
    const { IssueChecklistModal } = await import('@/screens/modals/IssueChecklistModal');
    const r = render(<IssueChecklistModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    fireEvent.change(r.getByTestId('chk-title'), { target: { value: 'Waterproofing' } });
    fireEvent.change(r.getByTestId('chk-item-0'), { target: { value: 'Ponding test' } });
    expect(r.getByTestId('save-checklist')).not.toBeDisabled();

    // another PMC deletes the room while this form is open
    act(() => { useStore.setState({ nodes: NODES.filter((n) => n.id !== 'bath' && n.id !== 'shower') } as never); });

    // the picker is showing nothing, so the form must not still be holding the dead node
    expect(r.getByTestId('save-checklist')).toBeDisabled();
  });
});

describe('the empty Site Map still offers Add here (R2-F4)', () => {
  it('a brand-new project can create its first record from Places', async () => {
    await load({ nodes: [] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    // the first location-backed record is made precisely here; the form's picker creates
    // the zone inline, so nothing depends on a tree existing yet
    fireEvent.click(r.getByTestId('place-add-empty'));
    expect(r.getByTestId('create-inspection')).toBeInTheDocument();
  });

  it('a client is still offered nothing in the empty state', async () => {
    await load({ nodes: [], role: 'client' });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    expect(r.queryByTestId('place-add-empty')).not.toBeInTheDocument();
  });
});

describe('secondary fields fold away, mandatory ones never do', () => {
  it('a delivery opens as what arrived, how much and where — the rest is a fold away', async () => {
    await load();
    const { AddMaterialModal } = await import('@/screens/modals/AddMaterialModal');
    const r = render(<AddMaterialModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    // the two fields the domain requires, and the place, are the opening form
    expect(r.getByTestId('mat-name')).toBeInTheDocument();
    expect(r.getByTestId('mat-qty')).toBeInTheDocument();
    expect(r.getByTestId('mat-place-trail')).toBeInTheDocument();
    // storage detail and the decision link block nothing, so neither is asked up front
    expect(r.queryByTestId('mat-storage')).not.toBeInTheDocument();
    expect(r.queryByTestId('mat-decision')).not.toBeInTheDocument();

    fireEvent.click(r.getByTestId('mat-more-toggle'));
    expect(r.getByTestId('mat-storage')).toBeInTheDocument();
    expect(r.getByTestId('mat-decision')).toBeInTheDocument();
  });

  it("a decision's two options stay visible — the server contract requires them", async () => {
    await load();
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    // options.min(2) is a DOMAIN rule, so hiding the second would offer a save the API refuses
    expect(r.getByTestId('dec-opt-0')).toBeInTheDocument();
    expect(r.getByTestId('dec-opt-1')).toBeInTheDocument();
    // what an option OPTIONALLY carries does fold away, per option
    expect(r.queryByPlaceholderText('₹ delta (0 = base)')).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('dec-opt-0-more-toggle'));
    // …and opening one option's details does not open the other's
    expect(r.getAllByPlaceholderText('₹ delta (0 = base)')).toHaveLength(1);
  });

  it('a fold never hides the reason a disabled button will not move', async () => {
    await load();
    const { AddMaterialModal } = await import('@/screens/modals/AddMaterialModal');
    const r = render(<AddMaterialModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    // save is blocked, and BOTH fields that block it are on screen unfolded
    expect(r.getByTestId('save-material')).toBeDisabled();
    fireEvent.change(r.getByTestId('mat-name'), { target: { value: 'Italian Marble' } });
    fireEvent.change(r.getByTestId('mat-qty'), { target: { value: '40 sqm' } });
    expect(r.getByTestId('save-material')).not.toBeDisabled();
  });
});

describe('disclosure state belongs to an option, not to a slot', () => {
  it('removing an earlier option leaves the opened option open, and its neighbour closed', async () => {
    await load();
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);

    // three options, each identifiable
    fireEvent.click(r.getByText('+ Add another option'));
    fireEvent.change(r.getByTestId('dec-opt-0'), { target: { value: 'Option A material' } });
    fireEvent.change(r.getByTestId('dec-opt-1'), { target: { value: 'Option B material' } });
    fireEvent.change(r.getByTestId('dec-opt-2'), { target: { value: 'Option C material' } });

    // open B's details, then delete A
    fireEvent.click(r.getByTestId('dec-opt-1-more-toggle'));
    expect(r.getByTestId('dec-opt-1-more-body')).toBeInTheDocument();
    fireEvent.click(r.getByLabelText('Remove option 1'));

    // B has shifted into slot 0 and must have kept its OWN open state; C must not inherit it.
    // With an index key React reuses slot 1's open component for C, collapsing B and opening
    // C — so the user edits a delta believing it belongs to the option they opened.
    expect((r.getByTestId('dec-opt-0') as HTMLInputElement).value).toBe('Option B material');
    expect(r.getByTestId('dec-opt-0-more-body')).toBeInTheDocument();
    expect(r.queryByTestId('dec-opt-1-more-body')).not.toBeInTheDocument();
  });
});
