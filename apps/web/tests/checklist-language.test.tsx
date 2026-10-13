import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { Checklist, Lang } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Top 10 #5) — the engineer's inspection checklist, a path Board named: in Hindi and Gujarati every
 * state of the screen shows no English (loading, unavailable, none issued, a link to a checklist that is
 * not there, the open checklist with a failed item and refused photos, the stale copy, submitting, queued
 * and submitted). English stays byte-identical. Checklist titles, item names, the zone and the date are
 * project data, shown as recorded.
 */

const checklist = (id: string, title: string, over: Partial<Checklist> = {}): Checklist => ({
  id,
  title,
  zone: 'Ground floor',
  date: '01 Jun 2026',
  submitted: false,
  items: [
    { id: `${id}-i1`, name: 'Rebar spacing', state: 'pass', photos: 1, note: '', evidence: ['data:image/png;base64,AA=='] },
    { id: `${id}-i2`, name: 'Cover blocks', state: 'fail', photos: 0, note: '', evidence: [] },
    { id: `${id}-i3`, name: 'Shuttering', state: null, photos: 0, note: '', evidence: [] },
  ],
  ...over,
});

const ONE = checklist('INSP-1', 'Slab casting');
const TWO = checklist('INSP-2', 'Brickwork');

// project data, and the acronyms Indian sites use as they are
const DATA = ['Slab casting', 'Brickwork', 'Ground floor', 'Rebar spacing', 'Cover blocks', 'Shuttering', '01 Jun 2026', 'INSP-1', 'INSP-2', 'INSP-9', 'PMC', 'MB'];

const REFUSED = { clientKey: 'k1', reason: 'upload rejected (400)', mime: 'image/png', inspectionId: 'INSP-2', inspectionItemId: 'INSP-2-i9' };

async function mount(lang: Lang, over: Record<string, unknown>, { mode = 'snapshot' } = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_INSPECTIONS_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState({
    ...getInitialState(),
    projectLoadState: 'ready', role: 'engineer', lang,
    openChecklists: [ONE, TWO], checklist: ONE, selectedChecklistId: null,
    ...over,
  });
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  return { view: render(<EngineerChecklistScreen />), useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const STATES: [string, Record<string, unknown>, { mode?: string }?][] = [
  ['loading', { checklist: null, openChecklists: [], inspectionsLoad: 'loading' }, { mode: 'moduleQuery' }],
  ['unavailable', { checklist: null, openChecklists: [], inspectionsLoad: 'error' }, { mode: 'moduleQuery' }],
  ['none issued', { checklist: null, openChecklists: [] }],
  ['a link to a checklist that is not there', { routeItem: 'INSP-9' }],
  ['open, a failed item, photos pending and refused', { pendingEvidenceCount: 2, failedEvidence: [REFUSED, { ...REFUSED, clientKey: 'k2', inspectionId: 'INSP-1', inspectionItemId: 'INSP-1-i2' }] }],
  ['stale copy', { inspectionsLoad: 'error' }, { mode: 'moduleQuery' }],
  ['submitting', { submission: { inspectionId: 'INSP-1', generation: 0, status: 'submitting', attempt: 1 } }],
  ['queued offline', { submission: { inspectionId: 'INSP-1', generation: 0, status: 'queued', attempt: 1 } }],
  ['submitted', { checklist: { ...ONE, submitted: true }, openChecklists: [] }],
  // Codex 4263137970 — a checklist filed nowhere (no place, blank zone) says so in the chosen language
  ['filed to no place', { checklist: { ...ONE, zone: '', nodeId: null }, openChecklists: [] }],
  // Codex 4263137981 — one photo waiting is its own case
  ['one photo waiting', { pendingEvidenceCount: 1 }],
];

describe('the inspection checklist in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const [name, over, opts] of STATES) {
      it(`${lang}, ${name}: no leftover English`, async () => {
        const { view } = await mount(lang, over, opts);
        expect(leftoverEnglish(view.container, DATA)).toEqual([]);
      });
    }

    it(`${lang}: what the submit says back is in the chosen language`, async () => {
      const { useStore } = await mount(lang, {});
      act(() => { useStore.getState().submitInspection(); });
      expect(useStore.getState().toast).toMatch(lang === 'hi' ? /सभी 3 आइटम/ : /બધી 3 આઇટમ/);
    });
  }
});

describe('the inspection checklist in English is unchanged', () => {
  it('keeps the words the engineer already knows', async () => {
    const { view } = await mount('en', { pendingEvidenceCount: 1, failedEvidence: [REFUSED] });
    const text = view.container.textContent ?? '';
    for (const s of ["TODAY'S INSPECTION", '2 CHECKLISTS OUT — TAP TO SWITCH', 'DONE', 'PHOTOS', 'Pass', 'Fail', 'N.A.',
      'Fail requires a note + photo evidence', '1 photo saved offline — will upload when signal returns',
      'Photos the server refused — choose for each', 'upload rejected (400)', 'on Brickwork — item INSP-2-i9', 'Retry', 'Delete', 'Submit Inspection']) {
      expect(text).toContain(s);
    }
    expect(view.getByPlaceholderText('Describe the issue…')).toBeTruthy();
    expect(view.getByAltText('Evidence 1 — Rebar spacing')).toBeTruthy();
    expect(view.getAllByLabelText('Add photo')).toHaveLength(3);
  });

  it('keeps the submit states and the toast', async () => {
    const queued = await mount('en', { submission: { inspectionId: 'INSP-1', generation: 0, status: 'queued', attempt: 1 } });
    expect(queued.view.getByTestId('submit-inspection').textContent).toBe('Queued — will submit when you reconnect');
    expect(queued.view.getByTestId('checklist-frozen-reason').textContent).toContain('Queued offline — editing is paused until it reaches the architect. It sends when you reconnect.');
    cleanup();
    const { useStore } = await mount('en', {});
    act(() => { useStore.getState().submitInspection(); });
    expect(useStore.getState().toast).toBe('Please mark all 3 items before submitting.');
  });
});

describe('an online photo upload says so in the chosen language (Codex 4262573038)', () => {
  const PX = `data:image/png;base64,${btoa('PNG')}`;
  for (const [lang, line] of [
    ['en', 'Evidence photo uploaded and linked to the item.'],
    ['hi', 'फ़ोटो सबूत अपलोड हुआ और आइटम से जुड़ गया।'],
    ['gu', 'ફોટો પુરાવો અપલોડ થયો અને આઇટમ સાથે જોડાયો.'],
  ] as const) {
    it(`${lang}`, async () => {
      vi.resetModules();
      const { useStore, getInitialState } = await import('@/store/store');
      const snap = {
        project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
        decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null,
        reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
      };
      useStore.setState(getInitialState());
      const gw = { uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }), snapshot: vi.fn().mockResolvedValue(snap) };
      useStore.getState()._setGateway(gw as never);
      useStore.setState({ online: true, lang, checklist: { ...ONE, items: ONE.items.map((it) => ({ ...it })) } });
      await useStore.getState().addChecklistEvidence(1, PX);
      expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
      expect(useStore.getState().toast).toBe(line);
    });
  }
});

describe('counts of one read as one (Codex 4263137981)', () => {
  for (const [lang, photo, mark] of [
    ['hi', '1 फ़ोटो ऑफ़लाइन सहेजी गई — नेटवर्क आते ही अपलोड होगी', 'भेजने से पहले आइटम पर निशान लगाएँ।'],
    ['gu', '1 ફોટો ઓફલાઇન સાચવ્યો — નેટવર્ક આવતાં અપલોડ થશે', 'મોકલતાં પહેલાં આઇટમ પર નિશાન કરો.'],
    ['en', '1 photo saved offline — will upload when signal returns', 'Please mark all 1 items before submitting.'],
  ] as const) {
    it(`${lang}: one photo waiting, one item to mark`, async () => {
      const single = checklist('INSP-1', 'Slab casting', { items: [{ id: 'x', name: 'Shuttering', state: null, photos: 0, note: '', evidence: [] }] });
      const { view, useStore } = await mount(lang, { pendingEvidenceCount: 1, checklist: single, openChecklists: [single] });
      expect(view.getByTestId('evidence-pending').textContent).toBe(photo);
      act(() => { useStore.getState().submitInspection(); });
      expect(useStore.getState().toast).toBe(mark);
    });
  }
});

describe('a checklist filed nowhere (Codex 4263137970)', () => {
  it('keeps its English line', async () => {
    const { view } = await mount('en', { checklist: { ...ONE, zone: '', nodeId: null }, openChecklists: [] });
    expect(view.getByTestId('checklist-place').textContent).toBe('Not filed to a location');
  });
});
