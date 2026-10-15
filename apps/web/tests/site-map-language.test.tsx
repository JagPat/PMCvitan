import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  createMenuLabels, locationDeleteText, photoTakenAtIn, placeToastText, siteMapText,
  type Activity, type Decision, type Drawing, type Lang, type Material, type Phase, type Photo, type PlacedInspection, type ProjectNode,
} from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { placeCountWords } from '@/lib/placeCountWords';
import { describeLocationDelete, locationDeleteBlocked } from '@/lib/locationDelete';
import { materialBlockedReason } from '@/lib/createOptions';

/**
 * #482 QA item 3 — the Site Map in Hindi and Gujarati: the whole project and an opened place (the tree, the
 * breadcrumb, the counts, "Places inside" with each status, the colour key, every "Work and records here"
 * section and its empty line, Intent vs Reality), the empty project, the PMC's place editor and its delete
 * confirmation, the Add menu, and what renaming or deleting a place says back show no English. English stays
 * as it was. Place names, record ids and titles, phase and material names and quantities are project data.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'store', parentId: 'gf', name: 'Store', kind: 'room', order: 1 },
  { id: 'bath', parentId: 'gf', name: 'Bath', kind: 'room', order: 2 },
  { id: 'door', parentId: 'kit', name: 'Main Door', kind: 'element', order: 0 },
];
const act = (over: Partial<Activity>): Activity => ({
  id: 'ACT-1', name: 'Kitchen Tiling', zone: 'Kitchen', decisionId: null, phaseId: 'ph-1', nodeId: 'kit', ps: 2, pe: 9, as: null, ae: null,
  plannedStartDate: '2026-10-14', plannedEndDate: '2026-10-21', status: 'in-progress', gm: 'ok', gt: 'ok', gi: 'ok', ...over,
} as Activity);
const ACTS: Activity[] = [
  act({ id: 'ACT-1' }),
  act({ id: 'ACT-2', name: 'Store Shelving', nodeId: 'store', status: 'blocked', block: 'Pump failure', phaseId: null }),
  act({ id: 'ACT-3', name: 'Bath Fittings', nodeId: 'bath', status: 'done' }),
];
const PHASES: Phase[] = [{ id: 'ph-1', name: 'Finishes', order: 0, plannedStart: 0, plannedEnd: 30, plannedStartDate: '2026-10-12', plannedEndDate: '2026-11-11', activityTotal: 3, done: 1, inProgress: 1, blocked: 1, notStarted: 0, donePct: 33 }];
const rev = { rev: 'B', url: 'k.png', acks: [{ by: 'Asha' }] };
const DRAWINGS = [
  { id: 'dw1', number: 'A-101', title: 'Kitchen Layout', nodeId: 'kit', draft: false, current: rev, revisions: [rev] },
  { id: 'dw2', number: 'A-100', title: 'Floor Plan', nodeId: 'gf', draft: false, current: { ...rev, acks: [] }, revisions: [] },
  { id: 'dw3', number: 'A-102', title: 'Door Detail', nodeId: 'door', draft: false, current: null, revisions: [] },
] as unknown as Drawing[];
const DECISIONS = [
  { id: 'DL-1', title: 'Kitchen Counter', room: '', nodeId: 'kit', status: 'approved', approvedOption: 'Granite', material: 'Black Galaxy', options: [] },
  { id: 'DL-2', title: 'Tile Colour', room: '', nodeId: 'kit', status: 'change', options: [] },
  { id: 'DL-3', title: 'Sink', room: '', nodeId: 'kit', status: 'awaiting_countersign', options: [] },
] as unknown as Decision[];
const PHOTOS: Photo[] = [
  { id: 'p1', url: 'a.png', nodeId: 'kit', kind: 'progress', takenAt: '03 Jul 2026 · 9:12 AM' },
  { id: 'p2', url: 'b.png', nodeId: 'kit', kind: 'progress' },
];
const MATERIALS: Material[] = [{ id: 'm1', name: 'Vitrified Tile', qty: '40 boxes', zone: 'Kitchen', matched: false, swatch: 'tile' as Material['swatch'], nodeId: 'kit' }];
const insp = (id: string, over: Partial<PlacedInspection>): PlacedInspection => ({
  id, title: 'Plumbing', zone: '', nodeId: 'kit', kind: 'checklist', submitted: true, decided: true, failedItems: 0, openIssues: 0, ...over,
});
const INSPECTIONS: PlacedInspection[] = [
  insp('INSP-1', { openIssues: 1, failedItems: 1 }),
  insp('INSP-2', { submitted: false, decided: false }),
  insp('INSP-3', { decided: false }),
  insp('INSP-4', {}),
];

// project data, and the acronyms sites use as they are
const DATA = [
  'Ground Floor', 'Kitchen', 'Store', 'Bath', 'Main Door', 'Kitchen Tiling', 'Store Shelving', 'Bath Fittings', 'Pump failure', 'Finishes',
  'A-101', 'A-100', 'A-102', 'Kitchen Layout', 'Floor Plan', 'Door Detail', 'B', 'DL-1', 'DL-2', 'DL-3', 'Kitchen Counter', 'Tile Colour', 'Sink',
  'Granite', 'Black Galaxy', 'Vitrified Tile', '40 boxes', 'Plumbing', 'INSP-1', 'INSP-2', 'INSP-3', 'INSP-4', 'ACT-1', 'ACT-2', 'ACT-3', 'PMC',
];

async function load(lang: Lang, over: Record<string, unknown> = {}, { demo = false } = {}) {
  vi.stubEnv('VITE_API_URL', demo ? '' : 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', activitiesLoad: 'ready', inspectionsLoad: 'ready', decisionsLoad: 'ready',
    role: 'pmc', short: 'Villa B', lang, routeItem: null,
    nodes: NODES, activities: ACTS, phases: PHASES, drawings: DRAWINGS, decisions: DECISIONS, photos: PHOTOS, materials: MATERIALS,
    placedInspections: INSPECTIONS,
    ...over,
  });
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return { useStore, r: render(<PlacesScreen />) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(['hi', 'gu'] as const)('the Site Map in %s (#482 QA item 3)', (lang) => {
  it.each([
    ['the whole project', null],
    ['a zone with places inside', 'gf'],
    ['a room with every kind of record', 'kit'],
    ['a room with nothing filed', 'store'],
    ['an object', 'door'],
  ])('%s shows no English', async (_, place) => {
    await load(lang, { routeItem: place });
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it.each([
    ['for an engineer', { role: 'engineer' }],
    ['for a client', { role: 'client' }],
    ['while the activities load', { activitiesLoad: 'loading', activities: [] }],
  ])('the opened zone %s shows no English', async (_, over) => {
    await load(lang, { routeItem: 'gf', ...over });
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the empty project, for the PMC and for anyone else, shows no English', async () => {
    const empty = { nodes: [], activities: [], drawings: [], decisions: [], photos: [], materials: [], placedInspections: [] };
    await load(lang, empty);
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    cleanup();
    await load(lang, { ...empty, role: 'engineer' });
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the PMC\'s add, rename and duplicate-name forms show no English', async () => {
    const { r } = await load(lang, { routeItem: 'kit' });
    fireEvent.click(r.getByTestId('place-add-object'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('place-rename'));
    fireEvent.change(r.getByTestId('place-structure-input'), { target: { value: 'Store' } });
    expect(r.getByTestId('place-structure-duplicate')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the delete confirmation, refused and allowed, shows no English', async () => {
    const { r } = await load(lang, { routeItem: 'kit' });
    fireEvent.click(r.getByTestId('place-delete'));
    expect(r.getByTestId('confirm-location-delete')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    cleanup();
    const store = await load(lang, { routeItem: 'store' });
    fireEvent.click(store.r.getByTestId('place-delete'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the Add menu, with a delivery blocked, shows no English', async () => {
    const { r } = await load(lang, { routeItem: 'kit', dailyLog: null });
    fireEvent.click(r.getByTestId('place-add'));
    expect(r.getByTestId('create-material-blocked')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('renaming or deleting without the server says so in the language', async () => {
    const { useStore } = await load(lang, {}, { demo: true });
    useStore.getState().renameNode('kit', 'Pantry');
    expect(useStore.getState().toast).toBeTruthy();
    expect(leftoverEnglish(Object.assign(document.createElement('div'), { textContent: useStore.getState().toast }))).toEqual([]);
    useStore.getState().deleteNode('kit');
    expect(leftoverEnglish(Object.assign(document.createElement('div'), { textContent: useStore.getState().toast }))).toEqual([]);
  });

  it('what renaming or deleting a place says back, and the delete rule, have no English', () => {
    const lines = [
      placeToastText.renamed('Pantry', lang), placeToastText.removed[lang], placeToastText.deleteRefused('', lang),
      locationDeleteText.unsettled[lang], describeLocationDelete('zone', lang), describeLocationDelete('element', lang),
      locationDeleteBlocked(1, lang) ?? '', locationDeleteBlocked(3, lang) ?? '',
      materialBlockedReason(null, true, lang) ?? '', materialBlockedReason({ submitted: true }, false, lang) ?? '',
    ];
    for (const line of lines) expect((line.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => w !== 'Pantry')).toEqual([]);
  });

  it('counts read in the language, one and many alike', () => {
    const counts = { decisions: 1, drawings: 2, photos: 1, activities: 1, materials: 3, inspections: 1, openIssues: 1 };
    const known = { inspections: 'known', activitiesKnown: true, photosCapped: false } as const;
    for (const opts of [known, { ...known, photosCapped: true }]) {
      for (const c of [counts, { decisions: 2, drawings: 1, photos: 4, activities: 2, materials: 1, inspections: 2, openIssues: 5 }]) {
        const text = placeCountWords(c, opts, lang).map((w) => w.text).join(' ');
        expect(text.match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
      }
    }
  });

  it('a photo\'s recorded time reads in the language; anything else is shown as recorded', () => {
    expect(photoTakenAtIn('03 Jul 2026 · 9:12 PM', lang)).toMatch(/^.+ 2026 · 21:12$/);
    expect(photoTakenAtIn('03 Jul 2026 · 9:12 PM', lang)).not.toMatch(/[A-Za-z]/);
    expect(photoTakenAtIn('12 Dec 2026 · 12:05 AM', lang)).toMatch(/· 00:05$/);
    expect(photoTakenAtIn('yesterday', lang)).toBe('yesterday');
  });
});

describe.each(['hi', 'gu'] as const)('the Site Map in %s, Codex review of #922', (lang) => {
  it('the All locations editor, with a draft and an add-inside form, shows no English', async () => {
    const nodes = [...NODES, { id: 'draft', parentId: 'gf', name: 'Store', kind: 'room', order: 3, draft: true } as ProjectNode];
    const { r } = await load(lang, { routeItem: 'kit', nodes });
    fireEvent.click(r.getByTestId('manage-locations'));
    expect(r.getByTestId('manage-new-zone')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('loc-add-room-gf'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the desktop Add button reads in the language', async () => {
    await load(lang, { routeItem: 'kit' });
    const { CreateRailButton } = await import('@/layout/CreateControl');
    const rail = render(<CreateRailButton />);
    expect(rail.getByTestId('create-rail').textContent?.trim()).toBe(createMenuLabels.add[lang]);
  });

  it('a blocker the server wrote reads in the language; a typed one is kept', async () => {
    const activities = [act({ id: 'ACT-1', status: 'blocked', block: 'Material ≠ approved' }), act({ id: 'ACT-2', status: 'blocked', block: 'Pump failure' })];
    await load(lang, { routeItem: 'kit', activities });
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    expect(document.body.textContent).toContain('Pump failure');
  });

  it('the server\'s refusals to delete a place read in the language; an unknown one is kept', () => {
    for (const why of [
      'Move or remove the 2 decision(s) under this location before deleting it.',
      'Move or remove the 3 photo(s) on this unpublished place before deleting it.',
      'Location not found in this project',
      'the server refused it',
    ]) expect(placeToastText.deleteRefused(why, lang).match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect(placeToastText.deleteRefused('Move or remove the 2 decision(s) under this location before deleting it.', lang)).toContain('2');
    expect(placeToastText.deleteRefused('Something newer', lang)).toContain('Something newer');
  });

  it('a recorded photo time the calendar or clock does not have is shown as recorded', () => {
    for (const bad of ['31 Feb 2026 · 9:12 AM', '03 Jul 0099 · 9:12 AM', '03 Jul 2026 · 13:12 PM', '03 Jul 2026 · 0:12 AM', '03 Jul 2026 · 9:75 AM']) {
      expect(photoTakenAtIn(bad, lang)).toBe(bad);
    }
    expect(photoTakenAtIn('28 Feb 2026 · 9:12 AM', lang)).not.toMatch(/[A-Za-z]/);
  });
});

describe('the Site Map in English is unchanged', () => {
  it('keeps its words', async () => {
    const { r } = await load('en', { routeItem: 'gf' });
    expect(r.getByTestId('place-children-title').textContent).toBe('Places inside');
    expect(r.getByTestId('place-work-records-where').textContent).toBe('At Ground Floor and the places inside it');
    expect(r.getByTestId('place-node-kit').textContent).toContain('ROOM');
    expect(r.getByTestId('place-status-kit').textContent).toBe('Under wayFinishes · 0/1 done');
    expect(r.getByTestId('place-status-store').textContent).toBe('Blocked0/1 done · 1 blocked');
    expect(r.getByTestId('site-map-tree-store').textContent).toBe('StoreBlocked');
    expect(r.getByTestId('site-map-tree-project').textContent).toBe('Whole project');
    expect(r.getByTestId('site-map-legend').textContent).toContain('Colours mean');
    cleanup();
    const kit = await load('en', { routeItem: 'kit' });
    expect(kit.r.getByTestId('place-inspection-issues-INSP-1').textContent).toBe('1 open issue');
    expect(kit.r.getByTestId('place-decision-lock-DL-1').textContent).toBe('Locked after approval. Open it to request a change.');
    expect(kit.r.getByTestId('place-activity-plan-ACT-1').textContent).toMatch(/^Finishes · Plan /);
    expect(kit.r.getByTestId('intent-reality').textContent).toContain('Building to Rev B · 1 acknowledged');
    expect(kit.r.getByTestId('intent-reality').textContent).toContain('Latest · 03 Jul 2026 · 9:12 AM');
    expect(kit.r.getByTestId('place-section-decisions').textContent).toContain('APPROVED & LOCKED');
    fireEvent.click(kit.r.getByTestId('place-add'));
    expect(kit.r.getByTestId('create-inspection').textContent).toContain('Check something here');
  });

  it('keeps its lines', () => {
    expect(siteMapText.count('openIssues', 2, 'en')).toBe('2 open issues');
    expect(siteMapText.count('photos', 1, 'en', true)).toBe('1 recent photo');
    expect(locationDeleteBlocked(1)).toBe('1 decision is filed here. Move or remove it in the Decision Log first.');
    expect(placeToastText.renamed('Pantry', 'en')).toBe('Renamed to Pantry.');
    expect(placeToastText.deleteRefused('it holds decisions', 'en')).toBe('Couldn\'t delete this location — it holds decisions');
    expect(photoTakenAtIn('03 Jul 2026 · 9:12 AM', 'en')).toBe('03 Jul 2026 · 9:12 AM');
  });
});
