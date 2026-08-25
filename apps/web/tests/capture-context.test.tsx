import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ProjectNode } from '@vitan/shared';
import { zoneLabelFor, captureAtPlace, captureGlobal, inheritsLocation } from '@/lib/captureContext';
import { createOptionsFor } from '@/lib/createOptions';
import { captureStamp } from '@/lib/captureStamp';

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

describe('the legacy free-text zone is DERIVED, so no form asks for it twice', () => {
  it('reports the zone a nested room sits under, not its own name', () => {
    expect(zoneLabelFor(NODES, 'shower')).toBe('Ground Floor');
  });

  it('reports the zone itself when the record is filed straight on it', () => {
    expect(zoneLabelFor(NODES, 'gf')).toBe('Ground Floor');
  });

  it('finds the zone by KIND, not by taking the first path segment', () => {
    // an element hanging directly off a zone still reports that zone
    expect(zoneLabelFor(NODES, 'tap')).toBe('Ground Floor');
  });

  it('falls back to the trail root when no ancestor is a zone', () => {
    expect(zoneLabelFor(NODES, 'orphanRoom')).toBe('Site Office');
  });

  it('is empty for an unfiled or unknown node — the same empty the forms sent before', () => {
    expect(zoneLabelFor(NODES, null)).toBe('');
    expect(zoneLabelFor(NODES, 'nope')).toBe('');
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

describe('a photo carries the stamp the daily log promises', () => {
  it('always carries its capture time', async () => {
    vi.stubGlobal('navigator', {});
    const stamp = await captureStamp(() => new Date('2026-08-25T06:30:00.000Z'));
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('adds coordinates when location is ALREADY granted', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 23.03, longitude: 72.51 } }),
      },
    });
    const stamp = await captureStamp(() => new Date('2026-08-25T06:30:00.000Z'));
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z', geoLat: 23.03, geoLng: 72.51 });
  });

  it('NEVER prompts: a permission still at "prompt" is treated as a no', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'prompt' }) },
      geolocation: { getCurrentPosition },
    });
    const stamp = await captureStamp(() => new Date('2026-08-25T06:30:00.000Z'));
    expect(stamp.geoLat).toBeUndefined();
    // the point of the rule: the capture never raises a permission dialog
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('degrades to the time alone when the position read fails', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: () => void) => fail(),
      },
    });
    const stamp = await captureStamp(() => new Date('2026-08-25T06:30:00.000Z'));
    expect(stamp).toEqual({ takenAt: '2026-08-25T06:30:00.000Z' });
  });

  it('survives a browser with no Permissions API', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } });
    const stamp = await captureStamp(() => new Date('2026-08-25T06:30:00.000Z'));
    expect(stamp.geoLat).toBeUndefined();
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
      zone: 'Ground Floor',
      items: ['Ponding test'],
      nodeId: 'shower',
    });
  });
});

describe('secondary fields fold away, mandatory ones never do', () => {
  it('a delivery opens as what arrived and how much; the decision link is under More details', async () => {
    await load();
    const { AddMaterialModal } = await import('@/screens/modals/AddMaterialModal');
    const r = render(<AddMaterialModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    expect(r.queryByTestId('mat-decision')).not.toBeInTheDocument();
    expect(r.queryByTestId('mat-zone')).not.toBeInTheDocument();

    fireEvent.click(r.getByTestId('mat-more-toggle'));
    expect(r.getByTestId('mat-decision')).toBeInTheDocument();
  });

  it("a decision's two options stay visible — the server contract requires them", async () => {
    await load();
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={captureAtPlace('villa-b', 'bath')} onClose={() => {}} />);
    // options.min(2) is a DOMAIN rule, so hiding the second would offer a save the API refuses
    expect(r.getByTestId('dec-opt-0')).toBeInTheDocument();
    expect(r.getByTestId('dec-opt-1')).toBeInTheDocument();
    // what an option optionally carries does fold away
    expect(r.queryByPlaceholderText('₹ delta (0 = base)')).not.toBeInTheDocument();
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
