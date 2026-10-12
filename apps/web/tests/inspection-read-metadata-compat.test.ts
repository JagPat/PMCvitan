import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ApiSnapshot } from '@/data/apiGateway';
import type { Checklist, Review } from '@vitan/shared';

/**
 * #771 read contract (#482 6115700782) — the API now serves each checklist and review row's STORED assignee and
 * civil due date. This unit adds no UI; it proves the client takes the additive fields as they come:
 * - a current payload's values arrive in the store unchanged, `null` ("none stored") included;
 * - an older payload's ABSENT keys stay absent — never turned into `null`, which would claim "unassigned / no
 *   due date" for a server that simply cannot say;
 * - the counts that read these rows are unchanged by the new fields.
 *
 * Every case goes through `applySnapshot`, the path a live snapshot takes. Isolated automated tests only.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const item = (id: string) => ({ id, name: id, state: null, photos: 0, note: '', evidence: [] });
const reviewItem = (id: string) => ({ id, name: id, result: 'FAIL' as const, swatch: 'concrete' as const, note: '', rejected: false, evidence: [] });

function snapshot(partial: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'villa-b', name: 'Villa', short: 'Villa', descriptor: '', stage: 'x', siteCode: 'V', location: '', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    ...partial,
  } as ApiSnapshot;
}

async function live(snap: ApiSnapshot) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'pmc', name: 'Villa' });
  expect(useStore.getState().applySnapshot(snap)).toBe(true);
  const { selectOpenReinspections } = await import('@/store/selectors');
  return { state: useStore.getState(), selectOpenReinspections };
}

const current = (over: Partial<Checklist> & { id: string }): Checklist =>
  ({ title: over.id, zone: 'GF', date: 'today', submitted: false, reinspectionOfId: null, assigneeId: null, dueDate: null, items: [item(`${over.id}-0`)], ...over }) as Checklist;

describe('#771 read contract — the client takes the additive due date and assignee as served', () => {
  it('a current payload: values and explicit nulls arrive unchanged on open checklists and review rows', async () => {
    const reviewRow = { id: 'RE-2', title: 'RE-2', zone: 'GF', by: 'Eng', date: 'today', decided: false, reinspectionOfId: 'INSP-5', assigneeId: 'u-eng', dueDate: '2026-10-20', items: [reviewItem('RE-2-0')] } as Review;
    const { state, selectOpenReinspections } = await live(snapshot({
      openChecklists: [current({ id: 'RE-1', reinspectionOfId: 'INSP-1', assigneeId: 'u-eng', dueDate: '2026-10-15', items: [item('a'), item('b')] }), current({ id: 'CK-1' })],
      reviews: [reviewRow],
    }));
    const byId = Object.fromEntries(state.openChecklists.map((c) => [c.id, c]));
    expect(byId['RE-1']).toMatchObject({ assigneeId: 'u-eng', dueDate: '2026-10-15' });
    expect(byId['CK-1']).toHaveProperty('assigneeId', null);
    expect(byId['CK-1']).toHaveProperty('dueDate', null);
    expect(state.reviews[0]).toMatchObject({ assigneeId: 'u-eng', dueDate: '2026-10-20' });
    // the count that reads these rows is the same with the new fields present
    expect(selectOpenReinspections(state)).toEqual({ count: 2, items: 3, known: true });
  });

  it('an older payload: absent keys stay absent (unknown), never become null ("none")', async () => {
    const older = { id: 'RE-1', title: 'RE-1', zone: 'GF', date: 'today', submitted: false, reinspectionOfId: 'INSP-1', items: [item('a')] } as Checklist;
    const { state, selectOpenReinspections } = await live(snapshot({ openChecklists: [older] }));
    const [c] = state.openChecklists;
    expect(c).not.toHaveProperty('assigneeId');
    expect(c).not.toHaveProperty('dueDate');
    expect(selectOpenReinspections(state)).toEqual({ count: 1, items: 1, known: true });
  });
});
