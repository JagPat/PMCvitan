import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ApiGateway, ApiSnapshot, ModuleDecisions } from '@/data/apiGateway';
import type { Decision } from '@vitan/shared';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Live bug 1 — the bell opens the record a notice is about; a notice whose record cannot be found
 * says so in place and offers the screen, instead of dropping the viewer on the parent list.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function mount(
  notifications: { text: string; time: string; color: string; decisionId?: string }[],
  over: Record<string, unknown> = {},
) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ notifOpen: true, notifications, role: 'pmc', screen: 'inbox', ...over });
  const { NotificationPanel } = await import('@/layout/NotificationPanel');
  return { useStore, ...render(<NotificationPanel />) };
}

describe('NotificationPanel — the record a notice opens', () => {
  it('a notice naming a decision opens that decision and closes the panel', async () => {
    const { useStore, getByTestId } = await mount([{ text: 'Decision awaiting approval: Anything', time: 'now', color: '#000', decisionId: 'DL-009' }]);
    fireEvent.click(getByTestId('notif-item'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBe('DL-009');
    expect(s.notifOpen).toBe(false);
  });

  it('a notice whose record cannot be found is explained in place, and offers the screen', async () => {
    const { useStore, getByTestId, queryByTestId } = await mount([{ text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' }]);
    fireEvent.click(getByTestId('notif-item'));
    // nothing navigated: the viewer is told, not dropped on the register
    expect(useStore.getState().screen).toBe('inbox');
    expect(getByTestId('notif-missing').textContent).toContain("isn't available");
    expect(getByTestId('notif-item').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(getByTestId('notif-missing-open'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBeNull();
    expect(s.notifOpen).toBe(false);
    expect(queryByTestId('notif-missing')).toBeNull();
  });

  it('Codex 4203544279 — while the decision read is in flight, a template notice is "loading", never "missing"', async () => {
    const { useStore, getByTestId, queryByTestId } = await mount(
      [{ text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' }],
      { decisionsLoad: 'loading' },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('inbox');
    expect(getByTestId('notif-loading').textContent).toContain("hasn't loaded");
    expect(queryByTestId('notif-missing')).toBeNull();
  });

  it('Codex 4203544271 — a client opens a decision they are not deciding in the register, not the approval screen', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'Client approved Master Bath CP Fittings — Kohler', time: 'now', color: '#000', decisionId: 'DL-009' }],
      { role: 'client' },
    );
    fireEvent.click(getByTestId('notif-item'));
    const s = useStore.getState();
    expect(s.screen).toBe('decision-log');
    expect(s.routeItem).toBe('DL-009');
  });
});

describe('a committed command still reconciling is not a settled slice (Codex 4204448859)', () => {
  it('a template notice is "loading" and a client is routed to the register, while the reconcile is owed', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' }],
      { commandReconcilePending: true },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(getByTestId('notif-loading')).toBeTruthy();
    expect(useStore.getState().screen).toBe('inbox');
  });

  it('a client tapping a notice for a decision the retained slice still shows awaiting them opens the register', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    // DL-014 is pending in the retained (pre-command) slice and the client is its decider
    const awaiting = useStore.getState().decisions.find((d) => d.id === 'DL-014')!;
    expect(awaiting.status).toBe('pending');
    const { getByTestId } = await mount(
      [{ text: 'Client approved Living Room Flooring — Marble', time: 'now', color: '#000', decisionId: 'DL-014' }],
      { role: 'client', commandReconcilePending: true },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('decision-log');
    expect(useStore.getState().routeItem).toBe('DL-014');
  });
});

describe('the explanation belongs to its notice (Codex 4203960936)', () => {
  it('a refresh that changes the list withdraws the explanation instead of leaving it under another notice', async () => {
    const missing = { text: 'New decision issued for approval: Porch Tiles', time: 'now', color: '#000' };
    const { useStore, getAllByTestId, queryByTestId } = await mount([missing]);
    fireEvent.click(getAllByTestId('notif-item')[0]);
    expect(queryByTestId('notif-missing')).not.toBeNull();
    // a realtime refresh prepends ANOTHER unresolvable notice: row 0 is now a different notice, and an
    // index-keyed explanation would sit under it, explaining the wrong one
    act(() => {
      useStore.setState({ notifications: [{ text: 'New decision issued for approval: Garden Gate', time: 'now', color: '#000' }, missing] });
    });
    expect(queryByTestId('notif-missing')).toBeNull();
  });
});

describe('the local decision writers stamp their notice with the decision (Codex 4203544300)', () => {
  it('a demo approval files "Client approved …" naming its decision', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const pending = useStore.getState().decisions.find((d) => d.status === 'pending' && !d.draft)!;
    useStore.setState({ modal: { type: 'approve', decId: pending.id, optIdx: 0 } });
    useStore.getState().confirmApprove();
    expect(useStore.getState().notifications[0]).toMatchObject({ decisionId: pending.id });
    expect(useStore.getState().notifications[0].text).toMatch(/^Client approved /);
  });
});

describe('the store marks a command still reconciling (Codex 4204448859)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const dec = (id: string, status: Decision['status'] = 'pending'): Decision =>
    ({ id, title: id, room: 'GF', status, photoSwatch: 'marble', options: [], deciderKind: 'client' }) as Decision;
  const snapshot = (): ApiSnapshot => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  } as unknown as ApiSnapshot);

  it('from the command\'s own snapshot until the reconcile carrying its module reads lands', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const s = () => useStore.getState();
    let release!: (d: ModuleDecisions) => void;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(snapshot()),
      decisions: vi.fn().mockResolvedValueOnce({ decisions: [dec('D-1')], source: 'live', generation: null } as ModuleDecisions),
      approveDecision: vi.fn().mockResolvedValue(snapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().requestFreshSnapshot();
    await flush();
    await flush();
    expect(s().commandReconcilePending).toBe(false);

    // the approval's own snapshot lands; the module read its reconcile owes is held open
    gw.decisions.mockImplementationOnce(() => new Promise<ModuleDecisions>((r) => { release = r; }));
    useStore.setState({ modal: { type: 'approve', decId: 'D-1', optIdx: 0 } });
    s().confirmApprove();
    await flush();
    await flush();
    expect(gw.approveDecision).toHaveBeenCalled();
    // the retained slice still says D-1 is pending and its read is 'ready' — and nothing may judge from it
    expect(s().decisionsLoad).toBe('ready');
    expect(s().commandReconcilePending).toBe(true);

    release({ decisions: [dec('D-1', 'approved')], source: 'live', generation: null } as ModuleDecisions);
    await flush();
    await flush();
    expect(s().decisions[0].status).toBe('approved');
    expect(s().commandReconcilePending).toBe(false);
    s()._setGateway(null);
  });
});

