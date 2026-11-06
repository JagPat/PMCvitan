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

await warmImports(() => import('@/store/store'), () => import('@/screens/InspectionReviewScreen'), () => import('@/screens/EngineerChecklistScreen'), () => import('@/components'));

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
    // the "…" option says what it is to a screen reader, and the select is marked busy while the list is read
    expect(select().selectedOptions[0]!.getAttribute('aria-label')).toBe('Name not loaded yet');
    expect(select().getAttribute('aria-busy')).toBe('true');
    await act(async () => { answer(TEAM); });
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Zed Contractor'));
    expect(select().disabled).toBe(false);
    expect(view.queryByText('…')).toBeNull();
  });

  it('a team read that fails keeps a named member held as "…", never "Nobody yet"; opening the picker asks again', async () => {
    let calls = 0;
    const listMembers = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Failed to fetch'), { status: 0 });
      return TEAM;
    });
    const { id, select } = await openReview({ listMembers });
    const { useStore } = await import('@/store/store');
    act(() => { useStore.setState({ responsibleMembers: [{ inspectionId: id, memberId: 'u-zed' }] }); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(select().getAttribute('aria-busy')).toBe('false'));
    expect(select().value).toBe('u-zed');
    expect(select().selectedOptions[0]!.textContent).toBe('…');
    expect(listMembers).toHaveBeenCalledTimes(1); // no automatic retry
    act(() => { fireEvent.focus(select()); });
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Zed Contractor'));
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it('offline, a named member the list does not hold stays held as "…" and no team read is made', async () => {
    const listMembers = vi.fn(async () => TEAM);
    const { id, select } = await openReview({ listMembers }, { online: false });
    const { useStore } = await import('@/store/store');
    act(() => { useStore.setState({ responsibleMembers: [{ inspectionId: id, memberId: 'u-zed' }] }); });
    await act(async () => {});
    expect(select().value).toBe('u-zed');
    expect(select().selectedOptions[0]!.textContent).toBe('…');
    expect(listMembers).not.toHaveBeenCalled();
    // back online: the read is made once and the name shows
    act(() => { useStore.setState({ online: true }); });
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Zed Contractor'));
    expect(listMembers).toHaveBeenCalledTimes(1);
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
    const listMembers = vi.fn(async () => TEAM);
    const snapshotRead = vi.fn(() => new Promise(() => {}));
    const { useStore, id, select } = await openReview({ listMembers, setResponsibleMember, snapshot: snapshotRead }, { members: TEAM });
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Could not save who fixes this. Try again.'));
    expect(select().value).toBe('');
    expect(setResponsibleMember).toHaveBeenCalledTimes(1);
    expect(useStore.getState().responsibleMembers.find((r) => r.inspectionId === id)).toBeUndefined();
    // the refusal reads the team and the project again, so a member who left stops being offered
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(1));
    expect(snapshotRead).toHaveBeenCalled();
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

  it('a re-inspection row names who fixes the work it re-checks: the inspection sent back, by its id (Codex #1361 r1)', async () => {
    const reinspection: Checklist = { id: 'INSP-95', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [], reinspectionOfId: 'INSP-60' };
    const setResponsibleMember = vi.fn(async (inspectionId: string, memberId: string | null) =>
      ({ ...snapshot(memberId ? [{ inspectionId, memberId }] : []), openChecklists: [reinspection] }));
    const { view, useStore } = await openReview(
      { listMembers: vi.fn(async () => TEAM), setResponsibleMember },
      { reviews: [], activeReviewId: null, openChecklists: [reinspection], members: TEAM },
    );
    const el = () => view.getByTestId('outstanding-responsible-INSP-95-select') as HTMLSelectElement;
    act(() => { fireEvent.change(el(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(1));
    expect((setResponsibleMember.mock.calls[0] as unknown as [string, string | null])[0]).toBe('INSP-60');
    await waitFor(() => expect(el().value).toBe('u-zed'));
    expect(useStore.getState().responsibleMembers).toEqual([{ inspectionId: 'INSP-60', memberId: 'u-zed' }]);
  });

  it('the same choice after an answer that never arrived re-sends the same key; a final refusal or a confirmed answer starts a new one (Codex #1361 r1)', async () => {
    let call = 0;
    const setResponsibleMember = vi.fn(async (inspectionId: string, memberId: string | null) => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('Failed to fetch'), {});
      if (call === 2) throw Object.assign(new Error('Bad gateway'), { status: 502 });
      if (call === 3) return answerKeepingQueue(memberId ? [{ inspectionId, memberId }] : []);
      throw Object.assign(new Error('refused'), { status: 400 });
    });
    const { useStore, id, select } = await openReview({ listMembers: vi.fn(async () => TEAM), setResponsibleMember, snapshot: vi.fn(() => new Promise(() => {})) }, { members: TEAM });
    const keyOf = (n: number) => (setResponsibleMember.mock.calls[n] as unknown as [string, string | null, string])[2];
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Could not save who fixes this. Try again.'));
    await waitFor(() => expect(select().disabled).toBe(false));
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
    await waitFor(() => expect(select().disabled).toBe(false));
    act(() => { fireEvent.change(select(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(select().value).toBe('u-zed'));
    expect(keyOf(2)).toBe(keyOf(0));
    // confirmed: the next naming is a new operation with a new key
    await waitFor(() => expect(select().disabled).toBe(false));
    act(() => { fireEvent.change(select(), { target: { value: 'u-amy' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(4));
    expect(keyOf(3)).not.toBe(keyOf(0));
    // a final refusal settles that key too: the same choice again is a new attempt
    await waitFor(() => expect(select().disabled).toBe(false));
    act(() => { fireEvent.change(select(), { target: { value: 'u-amy' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(5));
    expect(keyOf(4)).not.toBe(keyOf(3));
    expect(useStore.getState().responsibleMembers).toEqual([{ inspectionId: id, memberId: 'u-zed' }]);
  });

  it('every opening reads the team again, so a member added or removed in another tab is offered as they stand now (Codex #1361 r1)', async () => {
    let team = TEAM;
    const listMembers = vi.fn(async () => team);
    const { select } = await openReview({ listMembers });
    act(() => { fireEvent.focus(select()); });
    await waitFor(() => expect(optionTexts(select())).toEqual(['Nobody yet', 'Amy Consultant', 'Zed Contractor']));
    team = [...TEAM.filter((m) => m.userId !== 'u-zed'), member('u-new', 'Neha New', 'contractor')];
    act(() => { fireEvent.blur(select()); fireEvent.focus(select()); });
    await waitFor(() => expect(optionTexts(select())).toEqual(['Nobody yet', 'Amy Consultant', 'Neha New']));
    expect(listMembers).toHaveBeenCalledTimes(2);
    // a later read refreshes in the background: the picker stays usable while it runs
    expect(select().disabled).toBe(false);
  });

  it('a refusal while a team read is in flight reads the team once more after it (Codex #1361 r2)', async () => {
    const answers: Array<(m: ProjectMember[]) => void> = [];
    const listMembers = vi.fn(() => new Promise<ProjectMember[]>((r) => { answers.push(r); }));
    const setResponsibleMember = vi.fn(async () => { throw Object.assign(new Error('Only an active contractor or consultant'), { status: 400 }); });
    const { useStore, select } = await openReview({ listMembers, setResponsibleMember, snapshot: vi.fn(() => new Promise(() => {})) }, { members: TEAM });
    // opening starts a read; the refusal lands while it is still in flight (it may have been answered before the member left)
    act(() => { fireEvent.focus(select()); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(1));
    // two refusals while it runs share ONE read chained after it
    await useStore.getState().setResponsibleMember(REVIEW_ID, 'u-zed');
    await useStore.getState().setResponsibleMember(REVIEW_ID, 'u-amy');
    expect(listMembers).toHaveBeenCalledTimes(1);
    await act(async () => { answers[0]!(TEAM); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    // a refusal after the chained read was sent chains exactly one more after it
    await useStore.getState().setResponsibleMember(REVIEW_ID, 'u-zed');
    await useStore.getState().setResponsibleMember(REVIEW_ID, 'u-amy');
    expect(listMembers).toHaveBeenCalledTimes(2);
    await act(async () => { answers[1]!(TEAM); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(3));
    await act(async () => { answers[2]!(TEAM.filter((m) => m.userId !== 'u-zed')); });
    await waitFor(() => expect(optionTexts(select())).toEqual(['Nobody yet', 'Amy Consultant']));
    expect(listMembers).toHaveBeenCalledTimes(3);
  });

  it('a later opening reads the shown name again too, not only the team (Codex #1361 r2)', async () => {
    const listMembers = vi.fn(async () => TEAM);
    const fails: Array<() => void> = [];
    const snapshotRead = vi.fn(() => new Promise((_, reject) => { fails.push(() => reject(Object.assign(new Error('Bad gateway'), { status: 502 }))); }));
    const { select } = await openReview({ listMembers, snapshot: snapshotRead });
    act(() => { fireEvent.focus(select()); });
    await waitFor(() => expect(optionTexts(select())).toEqual(['Nobody yet', 'Amy Consultant', 'Zed Contractor']));
    const before = snapshotRead.mock.calls.length;
    act(() => { fireEvent.blur(select()); fireEvent.focus(select()); });
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(snapshotRead.mock.calls.length).toBe(before + 1));
    // opening again and again while that read runs joins it: one project read, not one per opening
    for (let i = 0; i < 5; i += 1) act(() => { fireEvent.blur(select()); fireEvent.focus(select()); });
    await waitFor(() => expect(listMembers.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(snapshotRead.mock.calls.length).toBe(before + 1);
    // nor is one queued behind it: when it settles, no further read follows
    await act(async () => { fails[fails.length - 1]!(); });
    const { useStore } = await import('@/store/store');
    await waitFor(() => expect(useStore.getState().projectLoadState).not.toBe('loading'));
    await act(async () => { await Promise.resolve(); });
    expect(snapshotRead.mock.calls.length).toBe(before + 1);
  });

  it('several rows naming a member the list does not hold share one team read', async () => {
    let answer!: (m: ProjectMember[]) => void;
    const listMembers = vi.fn(() => new Promise<ProjectMember[]>((r) => { answer = r; }));
    const rows: Checklist[] = ['INSP-91', 'INSP-92', 'INSP-93'].map((rowId) => ({ id: rowId, title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [] }));
    const { view } = await openReview({ listMembers }, { reviews: [], activeReviewId: null, openChecklists: rows });
    const { useStore } = await import('@/store/store');
    act(() => { useStore.setState({ responsibleMembers: rows.map((r) => ({ inspectionId: r.id, memberId: 'u-amy' })) }); });
    await waitFor(() => expect(listMembers).toHaveBeenCalled());
    await act(async () => { answer(TEAM); });
    for (const r of rows) {
      const el = view.getByTestId(`outstanding-responsible-${r.id}-select`) as HTMLSelectElement;
      await waitFor(() => expect(el.selectedOptions[0]!.textContent).toBe('Amy Consultant'));
    }
    expect(listMembers).toHaveBeenCalledTimes(1);
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

  it('on a re-inspection the engineer names who fixes the work it re-checks, by its id; a submitted one names itself (Codex #1361 r2)', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const reinspection: Checklist = { id: 'INSP-95', title: 'Slab', zone: 'Z', date: 'today', submitted: false, reinspectionOfId: 'INSP-60', items: [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }] };
    const setResponsibleMember = vi.fn(async (inspectionId: string, memberId: string | null) =>
      ({ ...snapshot(memberId ? [{ inspectionId, memberId }] : []), openChecklists: [reinspection], checklist: reinspection }));
    useStore.setState({ ...getInitialState(), activeProjectId: 'qa', projectScopeGeneration: 1, role: 'engineer', online: true, openChecklists: [reinspection], checklist: reinspection, selectedChecklistId: null, members: TEAM, responsibleMembers: [] } as never);
    useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), listMembers: vi.fn(async () => TEAM), setResponsibleMember } as never);
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    const el = () => view.getByTestId('checklist-responsible-select') as HTMLSelectElement;
    act(() => { fireEvent.change(el(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(1));
    expect((setResponsibleMember.mock.calls[0] as unknown as [string, string | null])[0]).toBe('INSP-60');
    const { responsibleTargetOf } = await import('@/components');
    expect(responsibleTargetOf({ ...reinspection, submitted: true })).toBe('INSP-95');
    expect(responsibleTargetOf({ id: 'INSP-7', submitted: false })).toBe('INSP-7');
  });

  it('a save still running for one checklist does not hold the picker busy on the next (Codex #1361 r2)', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const first: Checklist = { id: 'INSP-7', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }] };
    const second: Checklist = { ...first, id: 'INSP-8', title: 'Beam' };
    const setResponsibleMember = vi.fn(() => new Promise(() => {}));
    useStore.setState({ ...getInitialState(), activeProjectId: 'qa', projectScopeGeneration: 1, role: 'engineer', online: true, openChecklists: [first, second], checklist: first, selectedChecklistId: null, members: TEAM, responsibleMembers: [] } as never);
    useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), listMembers: vi.fn(async () => TEAM), setResponsibleMember } as never);
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    const el = () => view.getByTestId('checklist-responsible-select') as HTMLSelectElement;
    act(() => { fireEvent.change(el(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(setResponsibleMember).toHaveBeenCalledTimes(1));
    expect(el().disabled).toBe(true);
    act(() => { useStore.setState({ checklist: second } as never); });
    await waitFor(() => expect(view.getByTestId('checklist-title').textContent).toContain('Beam'));
    expect(el().disabled).toBe(false);
  });

  it('when an older save settles after a newer one, the newer one stays busy until its own answer (Codex #1361 r2)', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const first: Checklist = { id: 'INSP-7', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }] };
    const second: Checklist = { ...first, id: 'INSP-8', title: 'Beam' };
    const settle = new Map<string, () => void>();
    const setResponsibleMember = vi.fn((inspectionId: string) => new Promise((_, reject) => {
      settle.set(inspectionId, () => reject(Object.assign(new Error('Bad gateway'), { status: 502 })));
    }));
    useStore.setState({ ...getInitialState(), activeProjectId: 'qa', projectScopeGeneration: 1, role: 'engineer', online: true, openChecklists: [first, second], checklist: first, selectedChecklistId: null, members: TEAM, responsibleMembers: [] } as never);
    useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), listMembers: vi.fn(async () => TEAM), setResponsibleMember } as never);
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    const el = () => view.getByTestId('checklist-responsible-select') as HTMLSelectElement;
    act(() => { fireEvent.change(el(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(settle.has('INSP-7')).toBe(true));
    act(() => { useStore.setState({ checklist: second } as never); });
    await waitFor(() => expect(view.getByTestId('checklist-title').textContent).toContain('Beam'));
    act(() => { fireEvent.change(el(), { target: { value: 'u-amy' } }); });
    await waitFor(() => expect(settle.has('INSP-8')).toBe(true));
    expect(el().disabled).toBe(true);
    // the older save (INSP-7) answers first: INSP-8's save is still running, so its picker stays busy
    await act(async () => { settle.get('INSP-7')!(); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Could not save who fixes this. Try again.'));
    expect(el().disabled).toBe(true);
    await act(async () => { settle.get('INSP-8')!(); });
    await waitFor(() => expect(el().disabled).toBe(false));
  });

  it('two saves on the SAME inspection, the older settling after the newer: busy until the newer one settles (Codex #1361 r2)', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const first: Checklist = { id: 'INSP-7', title: 'Slab', zone: 'Z', date: 'today', submitted: false, items: [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }] };
    const second: Checklist = { ...first, id: 'INSP-8', title: 'Beam' };
    const settles: Array<{ inspectionId: string; fail: () => void }> = [];
    const setResponsibleMember = vi.fn((inspectionId: string) => new Promise((_, reject) => {
      settles.push({ inspectionId, fail: () => reject(Object.assign(new Error('Bad gateway'), { status: 502 })) });
    }));
    useStore.setState({ ...getInitialState(), activeProjectId: 'qa', projectScopeGeneration: 1, role: 'engineer', online: true, openChecklists: [first, second], checklist: first, selectedChecklistId: null, members: TEAM, responsibleMembers: [] } as never);
    useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), listMembers: vi.fn(async () => TEAM), setResponsibleMember } as never);
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<EngineerChecklistScreen />);
    const el = () => view.getByTestId('checklist-responsible-select') as HTMLSelectElement;
    const showing = async (c: Checklist) => {
      act(() => { useStore.setState({ checklist: c } as never); });
      await waitFor(() => expect(view.getByTestId('checklist-title').textContent).toContain(c.title));
    };
    // save 1 on INSP-7; away to INSP-8 and save there; back to INSP-7 (no longer the running save's) and save 3 on it
    act(() => { fireEvent.change(el(), { target: { value: 'u-zed' } }); });
    await waitFor(() => expect(settles).toHaveLength(1));
    await showing(second);
    act(() => { fireEvent.change(el(), { target: { value: 'u-amy' } }); });
    await waitFor(() => expect(settles).toHaveLength(2));
    await showing(first);
    expect(el().disabled).toBe(false);
    act(() => { fireEvent.change(el(), { target: { value: 'u-amy' } }); });
    await waitFor(() => expect(settles).toHaveLength(3));
    expect(settles.map((x) => x.inspectionId)).toEqual(['INSP-7', 'INSP-8', 'INSP-7']);
    expect(el().disabled).toBe(true);
    // the OLDER save on INSP-7 settles after the newer one on the same inspection was sent: still busy
    await act(async () => { settles[0]!.fail(); });
    await waitFor(() => expect(useStore.getState().toast).toBe('Could not save who fixes this. Try again.'));
    expect(el().disabled).toBe(true);
    await act(async () => { settles[2]!.fail(); });
    await waitFor(() => expect(el().disabled).toBe(false));
  });

  it('one rule names the inspection on all three sites: A sent back, B open re-checking it, then B submitted (Codex #1361 r2)', async () => {
    const { getInitialState } = await import('@/store/store');
    const seeded = getInitialState().reviews.find((r) => r.id === REVIEW_ID)!;
    const named = [{ inspectionId: 'INSP-60', memberId: 'u-zed' }, { inspectionId: 'INSP-95', memberId: 'u-amy' }];
    const items = [{ id: 'i1', name: 'Rebar', state: null, photos: 0, note: '', evidence: [] }];
    const bOpen: Checklist = { id: 'INSP-95', title: 'Slab', zone: 'Z', date: 'today', submitted: false, reinspectionOfId: 'INSP-60', items };
    const shown = (el: HTMLElement) => (el as HTMLSelectElement).selectedOptions[0]!.textContent;
    // B open: the outstanding row names A (the work it re-checks)
    const row = await openReview({ listMembers: vi.fn(async () => TEAM) }, { reviews: [], activeReviewId: null, openChecklists: [bOpen], members: TEAM, responsibleMembers: named });
    expect(shown(row.view.getByTestId('outstanding-responsible-INSP-95-select'))).toBe('Zed Contractor');
    cleanup();
    // B open: the engineer's screen names A too
    const engineer = async (c: Checklist) => {
      vi.resetModules();
      const { useStore, getInitialState: init } = await import('@/store/store');
      useStore.setState({ ...init(), activeProjectId: 'qa', projectScopeGeneration: 1, role: 'engineer', online: true, openChecklists: [c], checklist: c, selectedChecklistId: null, members: TEAM, responsibleMembers: named } as never);
      const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
      return render(<EngineerChecklistScreen />);
    };
    expect(shown((await engineer(bOpen)).getByTestId('checklist-responsible-select'))).toBe('Zed Contractor');
    cleanup();
    // B submitted: the engineer's screen and the review card name B itself
    expect(shown((await engineer({ ...bOpen, submitted: true })).getByTestId('checklist-responsible-select'))).toBe('Amy Consultant');
    cleanup();
    const bReview = { ...seeded, id: 'INSP-95', reinspectionOfId: 'INSP-60', decided: false };
    const card = await openReview({ listMembers: vi.fn(async () => TEAM) }, { reviews: [bReview], activeReviewId: 'INSP-95', members: TEAM, responsibleMembers: named });
    expect(shown(card.view.getByTestId('review-responsible-INSP-95-select'))).toBe('Amy Consultant');
  });

  it('a contractor, a consultant and a client see no picker', async () => {
    for (const role of ['contractor', 'consultant', 'client'] as const) {
      const { view, id } = await openReview({ listMembers: vi.fn(async () => TEAM) }, { role, members: TEAM });
      expect(view.queryByTestId(`review-responsible-${id}`)).toBeNull();
      cleanup();
    }
  });
});
