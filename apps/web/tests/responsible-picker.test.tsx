import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import type { Checklist, ProjectMember } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #482 site photos, "Who fixes this?" (RM-w1) — the PMC and the engineer name the contractor or consultant member who
 * fixes an inspection's failed work, or nobody. ONLINE ONLY: a keyed PUT, never an outbox kind. The current name is the
 * snapshot's `responsibleMembers`; the choices are the project's active contractors and consultants.
 */

const member = (userId: string, name: string, role: ProjectMember['role'], status = 'active'): ProjectMember =>
  ({ userId, name, role, status, email: null, phone: null });
const TEAM: ProjectMember[] = [
  member('u-zed', 'Zed Contractor', 'contractor'),
  member('u-amy', 'Amy Consultant', 'consultant'),
  member('u-eng', 'Eli Engineer', 'engineer'),
  member('u-cli', 'Cara Client', 'client'),
  member('u-gone', 'Gina Gone', 'contractor', 'removed'),
];

/** the seeded review the card shows, named by id (never by its place in the queue) */
const REVIEW_ID = 'INSP-21';

const snapshot = (responsibleMembers: Array<{ inspectionId: string; memberId: string }> = []) => ({
  project: { id: 'qa', name: 'QA', short: 'QA', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  responsibleMembers,
});

await warmImports(() => import('@/store/store'), () => import('@/screens/InspectionReviewScreen'), () => import('@/screens/EngineerChecklistScreen'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The PMC's review screen on the seeded queue, under a server whose methods are `gateway`. */
async function openReview(gateway: Record<string, unknown>, state: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const reviews = useStore.getState().reviews;
  if (!reviews.some((r) => r.id === REVIEW_ID)) throw new Error(`the seeded queue no longer holds ${REVIEW_ID}`);
  useStore.setState({
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'pmc', sessionUserId: 'u-pmc', short: 'QA',
    lang: 'en', screen: 'inspect-review', online: true, outbox: [], syncQueue: [], reviews, activeReviewId: REVIEW_ID,
    openChecklists: [], responsibleMembers: [], members: [], ...state,
  } as never);
  useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), ...gateway } as never);
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  const view = render(<InspectionReviewScreen />);
  const id = REVIEW_ID;
  const select = () => view.getByTestId(`review-responsible-${id}-select`) as HTMLSelectElement;
  return { useStore, view, id, select };
}

/** a server answer that keeps the review queue the screen shows (only the responsible list is under test) */
const answerKeepingQueue = async (responsibleMembers: Array<{ inspectionId: string; memberId: string }>) => {
  const { useStore } = await import('@/store/store');
  const reviews = useStore.getState().reviews;
  return { ...snapshot(responsibleMembers), reviews, review: reviews.find((r) => r.id === REVIEW_ID) ?? null };
};

const optionTexts = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);

describe('"Who fixes this?" on the PMC review card (#482 RM-w1)', () => {
  it('starts at "Nobody yet", sends no team request until opened, then offers only active contractors and consultants', async () => {
    const listMembers = vi.fn(async () => TEAM);
    const { view, id, select } = await openReview({ listMembers });
    expect(view.getByTestId(`review-responsible-${id}`).textContent).toContain('Who fixes this?');
    expect(select().value).toBe('');
    expect(optionTexts(select())).toEqual(['Nobody yet']);
    expect(view.getByTestId(`review-responsible-${id}-hint`).textContent).toBe('Only contractors and consultants on this project can be chosen.');
    expect(listMembers).not.toHaveBeenCalled();
    act(() => { fireEvent.focus(select()); });
    await waitFor(() => expect(optionTexts(select())).toEqual(['Nobody yet', 'Amy Consultant', 'Zed Contractor']));
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('choosing a member sends one keyed PUT with that member and shows the name the server answers with', async () => {
    const setResponsibleMember = vi.fn(async (inspectionId: string, memberId: string | null) => answerKeepingQueue(memberId ? [{ inspectionId, memberId }] : []));
    const { useStore, id, select } = await openReview({ listMembers: vi.fn(async () => TEAM), setResponsibleMember }, { members: TEAM });
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(select().value).toBe('u-zed'));
    expect(setResponsibleMember).toHaveBeenCalledTimes(1);
    const [inspectionId, memberId, key] = setResponsibleMember.mock.calls[0] as unknown as [string, string | null, string];
    expect([inspectionId, memberId]).toEqual([id, 'u-zed']);
    expect(key).toMatch(/\S{8,}/);
    expect(useStore.getState().responsibleMembers).toEqual([{ inspectionId: id, memberId: 'u-zed' }]);
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('"Nobody yet" clears it: the PUT carries null', async () => {
    const setResponsibleMember = vi.fn(async () => answerKeepingQueue([]));
    const { id, select } = await openReview(
      { listMembers: vi.fn(async () => TEAM), setResponsibleMember },
      { members: TEAM, responsibleMembers: [] },
    );
    const { useStore } = await import('@/store/store');
    act(() => { useStore.setState({ responsibleMembers: [{ inspectionId: id, memberId: 'u-amy' }] }); });
    await waitFor(() => expect(select().value).toBe('u-amy'));
    act(() => { fireEvent.change(select(), { target: { value: '' } }); });
    await waitFor(() => expect(select().value).toBe(''));
    expect((setResponsibleMember.mock.calls[0] as unknown as [string, string | null])[1]).toBeNull();
  });

  it('a name the store cannot show yet is held (disabled, "…") until the team list answers, never shown as nobody', async () => {
    let answer!: (m: ProjectMember[]) => void;
    const listMembers = vi.fn(() => new Promise<ProjectMember[]>((r) => { answer = r; }));
    const { view, id, select } = await openReview({ listMembers });
    const { useStore: store } = await import('@/store/store');
    act(() => { store.setState({ responsibleMembers: [{ inspectionId: id, memberId: 'u-zed' }] }); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(1));
    expect(select().value).toBe('u-zed');
    expect(select().disabled).toBe(true);
    expect(select().selectedOptions[0]!.textContent).toBe('…');
    await act(async () => { answer(TEAM); });
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Zed Contractor'));
    expect(select().disabled).toBe(false);
    expect(view.queryByText('…')).toBeNull();
  });

  it('a name the read team list does not offer (removed, or re-roled) reads as "Nobody yet", as the server serves it', async () => {
    const { id, select } = await openReview({ listMembers: vi.fn(async () => TEAM) });
    const { useStore } = await import('@/store/store');
    act(() => { useStore.setState({ responsibleMembers: [{ inspectionId: id, memberId: 'u-gone' }] }); });
    await waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe('');
  });

  it('offline it is disabled and says why, and nothing is sent or queued', async () => {
    const setResponsibleMember = vi.fn(async () => snapshot());
    const { useStore, view, id, select } = await openReview({ listMembers: vi.fn(async () => TEAM), setResponsibleMember }, { members: TEAM, online: false });
    expect(select().disabled).toBe(true);
    expect(view.getByTestId(`review-responsible-${id}-hint`).textContent).toBe('Choosing who fixes this needs a connection.');
    // the action itself refuses too, whatever calls it
    await expect(useStore.getState().setResponsibleMember(id, 'u-zed')).resolves.toBe(false);
    expect(setResponsibleMember).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe('Choosing who fixes this needs a connection.');
  });

  it('a refusal says it could not save, keeps the old choice, and is not retried', async () => {
    const setResponsibleMember = vi.fn(async () => { throw Object.assign(new Error('Only an active contractor or consultant'), { status: 400 }); });
    const { useStore, id, select } = await openReview({ listMembers: vi.fn(async () => TEAM), setResponsibleMember }, { members: TEAM });
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Could not save who fixes this. Try again.'));
    expect(select().value).toBe('');
    expect(setResponsibleMember).toHaveBeenCalledTimes(1);
    expect(useStore.getState().responsibleMembers.find((r) => r.inspectionId === id)).toBeUndefined();
  });

  it('an answer that lands after the project changed is not adopted there', async () => {
    let answer!: (s: unknown) => void;
    const setResponsibleMember = vi.fn(() => new Promise((r) => { answer = r; }));
    const { useStore, id, select } = await openReview({ listMembers: vi.fn(async () => TEAM), setResponsibleMember }, { members: TEAM });
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(1));
    act(() => { useStore.setState({ activeProjectId: 'other', projectScopeGeneration: 2, responsibleMembers: [] } as never); });
    await act(async () => { answer(snapshot([{ inspectionId: id, memberId: 'u-zed' }])); });
    expect(useStore.getState().responsibleMembers).toEqual([]);
  });

  it('is named on each outstanding checklist too, right after it is issued', async () => {
    const out: Checklist = { id: 'INSP-90', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [] };
    const { view } = await openReview({ listMembers: vi.fn(async () => TEAM) }, { reviews: [], activeReviewId: null, openChecklists: [out] });
    expect(view.getByTestId('outstanding-responsible-INSP-90-select')).toBeTruthy();
  });
});

describe('"Who fixes this?" by role (#482 RM-w1)', () => {
  it('the engineer names one on the checklist they fill', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const current: Checklist = { id: 'INSP-7', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }] };
    useStore.setState({ ...getInitialState(), role: 'engineer', online: true, openChecklists: [current], checklist: current, selectedChecklistId: null, members: TEAM });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    expect(optionTexts(view.getByTestId('checklist-responsible-select') as HTMLSelectElement)).toEqual(['Nobody yet', 'Amy Consultant', 'Zed Contractor']);
  });

  it('a contractor, a consultant and a client see no picker', async () => {
    for (const role of ['contractor', 'consultant', 'client'] as const) {
      const { view, id } = await openReview({ listMembers: vi.fn(async () => TEAM) }, { role, members: TEAM });
      expect(view.queryByTestId(`review-responsible-${id}`)).toBeNull();
      cleanup();
    }
  });
});
