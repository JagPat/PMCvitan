import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { placeContents, trailOf } from '@/lib/locationTree';
import type { Activity, ProjectNode } from '@vitan/shared';

/**
 * Location context — "where does this belong?", answered wherever a located record is read.
 *
 * The nested-locations unit already made zone-level filing and zone-level objects legal in the
 * tree and the picker. What was missing was the READING half: a record showed a bare caption (or
 * nothing), so a user could not see the place or get back to it. These probes pin the two things
 * that matter after nesting:
 *   • the trail is the REAL chain — a zone-filed activity reads as the zone, with no invented room;
 *   • every crumb navigates to the Site Map AT that place.
 */

/** Site-level work and a zone-level object — the two shapes the plan says must not need a pseudo-room. */
const NODES: ProjectNode[] = [
  { id: 'site', parentId: null, name: 'Site', kind: 'zone', order: 0 },
  { id: 'zoneA', parentId: 'site', name: 'Zone A', kind: 'room', order: 0 },
  { id: 'gate', parentId: 'site', name: 'Site Gate', kind: 'element', order: 1 },
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 1 },
  { id: 'east', parentId: 'gf', name: 'East Wing', kind: 'room', order: 0 },
  { id: 'mbr', parentId: 'east', name: 'Master Bedroom', kind: 'room', order: 0 },
  { id: 'wardrobe', parentId: 'mbr', name: 'Wardrobe', kind: 'element', order: 0 },
];

const activity = (id: string, name: string, nodeId?: string): Activity => ({
  id, name, zone: 'legacy text', decisionId: null, phaseId: null, nodeId,
  ps: 0, pe: 2, as: null, ae: null, status: 'not-started',
  gm: 'na', gt: 'na', gi: 'na',
});

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
  });
  const { LocationContext } = await import('@/components');
  return { useStore, LocationContext };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('LocationContext — the trail a record actually carries', () => {
  it('a SITE-level record reads "project › Site" — no invented middle level', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="site" testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe('Residence at Ambli›Site');
  });

  it('a ZONE-level record reads through to the zone it was filed at', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="zoneA" testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe('Residence at Ambli›Site›Zone A');
  });

  it('an OBJECT hanging directly off a zone shows that zone, not a room that does not exist', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="gate" testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe('Residence at Ambli›Site›Site Gate');
  });

  it('a deeply nested object shows the whole spatial chain', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="wardrobe" testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe('Residence at Ambli›Ground Floor›East Wing›Master Bedroom›Wardrobe');
  });

  it('compact mode drops the project crumb for lists already scoped to one project', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="zoneA" compact testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe('Site›Zone A');
  });

  it('an unfiled record says so, and a legacy free-text location is shown as plain text', async () => {
    const { LocationContext } = await load();
    const a = render(<LocationContext nodeId={undefined} testId="ctx-a" />);
    expect(a.getByTestId('ctx-a').textContent).toBe('Not filed to a location');
    cleanup();
    const b = render(<LocationContext nodeId={null} fallback="Kitchen (legacy)" testId="ctx-b" />);
    expect(b.getByTestId('ctx-b').textContent).toBe('Kitchen (legacy)');
    // free text points at no place the Site Map can open — it is deliberately not a button
    expect(b.queryByTestId('ctx-b-crumb-0')).not.toBeInTheDocument();
  });

  it('reuses the shared trail helper rather than recomputing the path', async () => {
    const { LocationContext } = await load();
    const r = render(<LocationContext nodeId="wardrobe" compact testId="ctx" />);
    expect(r.getByTestId('ctx').textContent).toBe(trailOf(NODES, 'wardrobe').map((n) => n.name).join('›'));
  });
});

describe('a crumb navigates to the Site Map at that place', () => {
  it('tapping an intermediate crumb opens Places focused on that node', async () => {
    const { useStore, LocationContext } = await load();
    const r = render(<LocationContext nodeId="wardrobe" testId="ctx" />);
    // crumbs: [project, Ground Floor, East Wing, Master Bedroom, Wardrobe]
    fireEvent.click(r.getByTestId('ctx-crumb-2'));
    expect(useStore.getState().screen).toBe('places');
    expect(useStore.getState().placeFocus).toBe('east');
  });

  it('the project crumb opens the whole-project view', async () => {
    const { useStore, LocationContext } = await load();
    const r = render(<LocationContext nodeId="zoneA" testId="ctx" />);
    fireEvent.click(r.getByTestId('ctx-crumb-0'));
    expect(useStore.getState().screen).toBe('places');
    expect(useStore.getState().placeFocus).toBeNull();
  });

  it('the focus is PROJECT-owned: a scope change clears it, so another project never opens at this node', async () => {
    const { useStore } = await load();
    const scope = await import('@/store/projectScope');
    act(() => { useStore.getState().openPlace('zoneA'); });
    expect(useStore.getState().placeFocus).toBe('zoneA');
    act(() => { useStore.setState({ ...scope.emptyProjectData() }); });
    expect(useStore.getState().placeFocus).toBeNull();
  });
});

describe('the Site Map adopts the requested place, once', () => {
  it('opens at the focused node, then releases it so a later walk is not yanked back', async () => {
    const { useStore } = await load({ activities: [activity('A-1', 'Excavation', 'zoneA')] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    act(() => { useStore.getState().openPlace('zoneA'); });
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-breadcrumb').textContent).toContain('Zone A');
    expect(useStore.getState().placeFocus).toBeNull(); // consumed
  });
});

describe('zone-level and site-level work is FILED and READ where it belongs (no pseudo-rooms)', () => {
  it('an excavation filed directly on the Site is listed at the Site', async () => {
    const { useStore } = await load({ activities: [activity('A-1', 'Excavation', 'site')] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    act(() => { useStore.getState().openPlace('site'); });
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-activity-A-1')).toBeInTheDocument();
    // …and its own context names the Site, not a container invented to hold it
    expect(r.getByTestId('place-breadcrumb').textContent).toContain('Site');
  });

  it('an excavation filed directly on Zone A is listed at Zone A', async () => {
    const { useStore } = await load({ activities: [activity('A-2', 'Zone A excavation', 'zoneA')] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    act(() => { useStore.getState().openPlace('zoneA'); });
    const r = render(<PlacesScreen />);
    expect(r.getByTestId('place-activity-A-2')).toBeInTheDocument();
  });

  it('subtree semantics still roll zone work up to the site, and never invent a room to hold it', () => {
    const acts = [activity('A-1', 'Excavation', 'site'), activity('A-2', 'Zone A excavation', 'zoneA')];
    const atSite = placeContents('site', NODES, [], [], [], acts, [], []);
    const atZone = placeContents('zoneA', NODES, [], [], [], acts, [], []);
    expect(atSite.activities.map((a) => a.id)).toEqual(['A-1', 'A-2']);
    expect(atZone.activities.map((a) => a.id)).toEqual(['A-2']);
    // the only nodes between them are the ones the PMC actually created
    expect(trailOf(NODES, 'zoneA').map((n) => n.name)).toEqual(['Site', 'Zone A']);
  });
});
