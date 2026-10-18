import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Checklist, Decision, Lang, Review } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 6249090755 V-1018-2 — in Hindi and Gujarati the PMC's Inspection Review translated only the sidebar: "Reject
 * item", "Approve Inspection", "Send back for re-inspection", "PASS" and "0 item(s) marked for rejection" stayed
 * English. #482 6248989265 — the client's Project Health screen did too ("PROJECT HEALTH", the site status line,
 * the decisions line). V-1018-1 — an item with no photo showed a placeholder that read as a thumbnail, with no tag.
 * Review titles, item names, notes, people, places and ids are project data, shown as recorded.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ITEMS: Review['items'] = [
  { id: 'r1', name: 'Grout lines', result: 'PASS', evidence: ['data:image/png;base64,AA=='], swatch: 'tile', note: 'Even joints', rejected: false },
  { id: 'r2', name: 'Skirting level', result: 'FAIL', evidence: [], swatch: 'tile', note: 'Gap near door', rejected: false },
];
const REVIEW: Review = {
  id: 'INSP-027', title: 'Kitchen tiling', zone: 'Kitchen', by: 'Asha Rao', date: '18 Oct 2026', decided: false,
  closing: true, activityId: 'A-9', activityName: 'Tiling works', items: ITEMS,
};
const SECOND: Review = { ...REVIEW, id: 'INSP-028', title: 'Bath tiling', closing: false, items: [] };
const OUT: Checklist = { id: 'INSP-030', title: 'Bath waterproofing', zone: 'Bath', items: [] } as unknown as Checklist;
/** every word above is data the people on the project typed */
const DATA = ['INSP', 'Kitchen tiling', 'Bath tiling', 'Kitchen', 'Bath', 'Asha Rao', 'Tiling works', 'Grout lines', 'Even joints', 'Skirting level', 'Gap near door', 'Bath waterproofing'];

async function mountReview(lang: Lang, reviews: Review[], openChecklists: Checklist[] = [OUT]) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: 'pmc', screen: 'inspect-review', lang, reviews: structuredClone(reviews), openChecklists, activeReviewId: reviews[0]?.id ?? null, projectLoadState: 'ready' });
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  return { view: render(<InspectionReviewScreen />), useStore };
}

describe.each(['hi', 'gu'] as const)('the Inspection Review in %s (V-1018-2)', (lang) => {
  it('an undecided review: header, items, chips, buttons and the count line show no English', async () => {
    const { view } = await mountReview(lang, [REVIEW, SECOND]);
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
  });

  it('the "Approve with failed items?" confirmation shows no English', async () => {
    const { view } = await mountReview(lang, [REVIEW]);
    fireEvent.click(view.getByTestId('approve-inspection'));
    expect(view.getByTestId('confirm-approve')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('a decided review, a rejected item and the empty queue show no English', async () => {
    const decided = await mountReview(lang, [{ ...REVIEW, decided: true, items: ITEMS.map((it) => ({ ...it, rejected: true })) }, { ...SECOND, decided: true }]);
    expect(leftoverEnglish(decided.view.container, DATA)).toEqual([]);
    cleanup();
    vi.resetModules();
    const empty = await mountReview(lang, []);
    expect(leftoverEnglish(empty.view.container, DATA)).toEqual([]);
  });

  it('what Approve and Send back say back is in the same language', async () => {
    const { useStore } = await mountReview(lang, [{ ...REVIEW, closing: false }]);
    act(() => useStore.getState().approveInspection());
    expect(useStore.getState().toast).toBeTruthy();
    expect(useStore.getState().toast!.match(/[A-Za-z]{2,}/g)?.filter((w) => w !== 'INSP') ?? []).toEqual([]);
    cleanup();
    vi.resetModules();
    const again = await mountReview(lang, [{ ...REVIEW, closing: false }]);
    act(() => again.useStore.getState().sendReinspection());
    expect(again.useStore.getState().toast!.match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
  });
});

describe('English on the Inspection Review is unchanged', () => {
  it('reads as before', async () => {
    const { view } = await mountReview('en', [{ ...REVIEW, closing: false }]);
    const text = view.container.textContent!;
    for (const s of ['INSPECTION REVIEW', 'Submitted by Asha Rao', 'AWAITING REVIEW', 'PASS', 'FAIL', 'Reject item', 'Send back for re-inspection', 'Approve Inspection', '0 item(s) marked for rejection', 'OUT ON SITE · 1 AWAITING THE ENGINEER', '0 items']) {
      expect(text).toContain(s);
    }
  });
});

describe('V-1018-1 — the photo tag and a photo-less item', () => {
  it.each([
    ['en', 'PHOTO', 'No photo'],
    ['hi', 'फ़ोटो', 'कोई फ़ोटो नहीं'],
    ['gu', 'ફોટો', 'કોઈ ફોટો નથી'],
  ] as const)('in %s: the item with a photo is tagged; the one without says it has none', async (lang, tag, none) => {
    const { view } = await mountReview(lang, [REVIEW]);
    expect(view.getByTestId('review-photo-tag-0').textContent).toBe(tag);
    expect(view.queryByTestId('review-no-photo-0')).toBeNull();
    expect(view.getByTestId('review-no-photo-1').textContent).toBe(none);
    expect(view.queryByTestId('review-photo-tag-1')).toBeNull();
  });
});

async function mountHealth(lang: Lang, checkedIn: boolean) {
  // the demo seed's decisions and crew, served to a live (API) client screen
  const demo = await import('@/store/store');
  const seed = demo.getInitialState();
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', short: 'Villa B', stage: 'Planning' });
  const dailyLog = seed.dailyLog ? { ...seed.dailyLog, checkedIn } : null;
  useStore.setState({
    role: 'client', lang, screen: 'client-health', decisions: seed.decisions, dailyLog,
    photos: [{ id: 'm1', url: '/media/m1', takenAt: '2026-10-18 10:30', kind: 'progress' }],
  });
  const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
  const { selectDecisionsNeedingViewer, selectApprovedDecisions } = await import('@/store/selectors');
  const s = useStore.getState();
  return { view: render(<ClientHealthScreen />), pending: selectDecisionsNeedingViewer(s).length, approved: selectApprovedDecisions(s), workers: s.dailyLog?.crew.reduce((a, c) => a + c.count, 0) ?? 0 };
}

/** the data words a client's screen shows as recorded: decision titles, approvers, the project and its stage */
function healthData(approved: Decision[]): string[] {
  return ['Villa B', 'Planning', '2026-10-18 10:30', ...approved.flatMap((d) => [d.title, d.approver ?? '', d.date ?? ''])];
}

describe.each(['hi', 'gu'] as const)('the client Project Health in %s (#482 6248989265)', (lang) => {
  it.each([true, false])('site checked in = %s: heading, status line, decisions line and the rest show no English', async (checkedIn) => {
    const { view, pending, approved } = await mountHealth(lang, checkedIn);
    expect(pending).toBeGreaterThan(0); // the decisions line is on screen
    expect(approved.length).toBeGreaterThan(0); // and the approved list
    expect(leftoverEnglish(view.container, healthData(approved))).toEqual([]);
  });
});

describe('the client Project Health lines', () => {
  it.each([
    ['hi', 'प्रोजेक्ट की स्थिति', 'आज साइट पर काम चल रहा है', 'साइट आज थोड़ी देर में खुलेगी'],
    ['gu', 'પ્રોજેક્ટની સ્થિતિ', 'આજે સાઇટ પર કામ ચાલુ છે', 'સાઇટ આજે થોડી વારમાં ખૂલશે'],
    ['en', 'PROJECT HEALTH', 'Site active today', 'Site opens shortly today'],
  ] as const)('read in %s', async (lang, heading, active, opens) => {
    const on = await mountHealth(lang, true);
    expect(on.view.container.textContent).toContain(heading);
    expect(on.view.container.textContent).toContain(`${active} · ${on.workers}`);
    cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
    const off = await mountHealth(lang, false);
    expect(off.view.container.textContent).toContain(opens);
  });

  it('the decisions line has its own one-decision form', async () => {
    const { clientHealthText: T } = await import('@vitan/shared');
    expect(T.decisionsWaiting(1, 'en')).toBe('1 decision waiting for you');
    expect(T.decisionsWaiting(2, 'en')).toBe('2 decisions waiting for you');
    expect(T.decisionsWaiting(1, 'hi')).toBe('1 निर्णय आपकी राह देख रहा है');
    expect(T.decisionsWaiting(2, 'hi')).toBe('2 निर्णय आपकी राह देख रहे हैं');
    expect(T.decisionsWaiting(1, 'gu')).toBe('1 નિર્ણય તમારી રાહ જુએ છે');
  });
});

describe('Codex 4307111788 — an online decision says back in the language at settlement', () => {
  it.each([
    ['approve', 'निरीक्षण INSP-21 मंज़ूर हुआ', 'નિરીક્ષણ INSP-21 મંજૂર થયું'],
    ['send back', 'दोबारा निरीक्षण', 'ફરી નિરીક્ષણ'],
  ] as const)('%s: the viewer switches from Hindi to Gujarati while it is in flight', async (act_, hiLine, guLine) => {
    const { useStore, getInitialState } = await import('@/store/store');
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    useStore.setState({ role: 'pmc', lang: 'hi', activeReviewId: 'INSP-21', online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, outbox: [], syncQueue: [] });
    let commit!: (v: unknown) => void;
    const gw = { decideReview: vi.fn(() => new Promise((r) => { commit = r; })), getBrief: vi.fn(() => new Promise(() => {})), snapshot: vi.fn(() => new Promise(() => {})) };
    useStore.getState()._setGateway(gw as never);
    const review = useStore.getState().reviews.find((r) => r.id === 'INSP-21')!;
    useStore.setState({ reviews: [{ ...review, closing: false, items: review.items.map((it) => ({ ...it, result: 'FAIL' as const })) }] });
    if (act_ === 'approve') useStore.getState().approveInspection();
    else useStore.getState().sendReinspection();
    expect(gw.decideReview).toHaveBeenCalled();
    useStore.setState({ lang: 'gu' });
    // a whole snapshot for this project, so the reply is applied and announces its success
    commit({
      project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null,
      reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    });
    await vi.waitFor(() => { if (!useStore.getState().toast) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });
    expect(useStore.getState().toast).toContain(guLine);
    expect(useStore.getState().toast).not.toContain(hiLine);
  });
});
