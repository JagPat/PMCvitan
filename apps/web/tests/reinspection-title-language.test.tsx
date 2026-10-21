import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { inspectionTitle, type Checklist, type Lang, type PlacedInspection, type ProjectNode, type Review } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #482 V-1018-5 — the server wrote the fixed English words "Re-inspection: " into every re-inspection's stored
 * title, so Hindi and Gujarati readers saw English in a record nobody typed. The server now stores the
 * inspection's own title, and every screen labels a re-inspection from its `reinspectionOfId` in the reader's
 * language. A title is never read for its words: one that merely starts "Re-inspection: " is shown as recorded.
 */

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/EngineerChecklistScreen'), () => import('@/screens/InspectionReviewScreen'), () => import('@/screens/PlacesScreen'), () => import('@/store/selectors'), () => import('@vitan/shared'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const LABEL = { en: 'Re-inspection', hi: 'दोबारा निरीक्षण', gu: 'ફરી નિરીક્ષણ' } as const;
const LANGS = ['en', 'hi', 'gu'] as const;

describe('inspectionTitle', () => {
  it.each(LANGS)('in %s: a re-inspection is labelled, every other title is shown as recorded', (lang) => {
    expect(inspectionTitle({ title: 'Terrace waterproofing', reinspectionOfId: 'INSP-1' }, lang)).toBe(`${LABEL[lang]}: Terrace waterproofing`);
    expect(inspectionTitle({ title: 'Terrace waterproofing', reinspectionOfId: null }, lang)).toBe('Terrace waterproofing');
    expect(inspectionTitle({ title: 'Terrace waterproofing' }, lang)).toBe('Terrace waterproofing');
    // a typed title that imitates the old stored words is data, not a re-inspection
    expect(inspectionTitle({ title: 'Re-inspection: Stair', reinspectionOfId: null }, lang)).toBe('Re-inspection: Stair');
  });
});

const item = (id: string) => ({ id, name: 'Level', state: null, photos: 0, note: '', evidence: [] });
const CHILD: Checklist = { id: 'INSP-9', title: 'Terrace waterproofing', zone: 'Terrace', date: '18 Oct 2026', submitted: false, reinspectionOfId: 'INSP-8', items: [item('i1')] } as unknown as Checklist;
const ORDINARY: Checklist = { ...CHILD, id: 'INSP-10', title: 'Stair railing', reinspectionOfId: null } as unknown as Checklist;

async function store(lang: Lang, role: 'engineer' | 'pmc', over: Record<string, unknown>) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', inspectionsLoad: 'ready', role, lang, routeItem: null, ...over });
  return useStore;
}

describe.each(LANGS)('in %s, every place a re-inspection is named carries the label', (lang) => {
  it('the engineer checklist: its heading and the picker', async () => {
    await store(lang, 'engineer', { openChecklists: [CHILD, ORDINARY], checklist: CHILD, selectedChecklistId: null });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    expect(view.getByTestId('checklist-title').textContent).toBe(`${LABEL[lang]}: Terrace waterproofing`);
    expect(view.getByTestId('checklist-tab-INSP-9').textContent).toContain(`${LABEL[lang]}: Terrace waterproofing`);
    expect(view.getByTestId('checklist-tab-INSP-10').textContent).toContain('Stair railing');
    expect(view.getByTestId('checklist-tab-INSP-10').textContent).not.toContain(LABEL[lang]);
  });

  it('the Inspection Review: the queue, the heading and the out-on-site list', async () => {
    const review: Review = { id: 'INSP-9', title: 'Terrace waterproofing', zone: 'Terrace', by: 'Asha Rao', date: '18 Oct 2026', decided: false, reinspectionOfId: 'INSP-8', items: [] };
    const other: Review = { ...review, id: 'INSP-11', title: 'Kitchen tiling', reinspectionOfId: undefined };
    await store(lang, 'pmc', { screen: 'inspect-review', reviews: [review, other], activeReviewId: 'INSP-9', openChecklists: [{ ...CHILD, id: 'INSP-12' }] });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const view = render(<InspectionReviewScreen />);
    const text = view.container.textContent!;
    expect(text.split(`${LABEL[lang]}: Terrace waterproofing`).length - 1).toBe(3); // queue button, heading, out on site
    expect(view.getByTestId('outstanding-checklist-INSP-12').textContent).toContain(`${LABEL[lang]}: Terrace waterproofing`);
    expect(text).not.toContain(`${LABEL[lang]}: Kitchen tiling`);
  });

  it('the Site Map row, from the lineage the server serves', async () => {
    const NODES: ProjectNode[] = [{ id: 'roof', parentId: null, name: 'Roof', kind: 'zone', order: 0 }];
    const placed = (id: string, title: string, reinspectionOfId: string | null): PlacedInspection => ({ id, title, zone: '', nodeId: 'roof', kind: 'checklist', submitted: false, decided: false, failedItems: 0, openIssues: 0, reinspectionOfId });
    await store(lang, 'pmc', { routeItem: 'roof', nodes: NODES, placedInspections: [placed('INSP-9', 'Terrace waterproofing', 'INSP-8'), placed('INSP-10', 'Stair railing', null)] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const view = render(<PlacesScreen />);
    expect(view.getByTestId('place-inspection-INSP-9').textContent).toContain(`${LABEL[lang]}: Terrace waterproofing`);
    expect(view.getByTestId('place-inspection-INSP-10').textContent).not.toContain(LABEL[lang]);
  });

  it('the For You cards name it with the label', async () => {
    const useStore = await store(lang, 'engineer', { openChecklists: [CHILD], checklist: CHILD });
    const { selectActionItems } = await import('@/store/selectors');
    const { actionItemText } = await import('@vitan/shared');
    const card = selectActionItems(useStore.getState()).find((i) => i.key === 'eng-checklist')!;
    expect(actionItemText(card, lang).title).toContain(`${LABEL[lang]}: Terrace waterproofing`);
    useStore.setState({ role: 'pmc', reviews: [], openChecklists: [{ ...CHILD, assigneeId: 'u1', dueDate: null }] });
    const pmc = selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reinspections')!;
    expect(actionItemText(pmc, lang).detail).toContain(`${LABEL[lang]}: Terrace waterproofing`);
  });
});
