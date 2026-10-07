import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ApiGateway, ApiSnapshot, ModuleDecisions, ModuleInspections } from '@/data/apiGateway';
import type { Checklist, Decision } from '@vitan/shared';
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

describe('a decider of any role opens the approval screen (Codex review 5440751865)', () => {
  const memberDecision = (status: Decision['status']) =>
    ({ id: 'DL-900', title: 'Site Gate', room: 'Entry', status, photoSwatch: 'marble', options: [], deciderKind: 'member', deciderUserId: 'u-eng' }) as Decision;

  it('an engineer named as decider of a pending decision lands where they can approve it', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'Decision awaiting approval: Site Gate', time: 'now', color: '#000', decisionId: 'DL-900' }],
      { role: 'engineer', sessionUserId: 'u-eng', decisions: [memberDecision('pending')] },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('client-decisions');
    // the approval screen focuses its row through `decisionFocus`
    expect(useStore.getState().decisionFocus).toBe('DL-900');
  });

  it('once that decision is decided, the same engineer reads it in the register', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'Decision awaiting approval: Site Gate', time: 'now', color: '#000', decisionId: 'DL-900' }],
      { role: 'engineer', sessionUserId: 'u-eng', decisions: [memberDecision('approved')] },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('decision-log');
  });
});

describe('a notice resolves only to a decision the viewer can open (Codex 4206188363)', () => {
  it('a contractor\'s id-less notice for a client-held pending decision is not resolved to it', async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'New decision issued for approval: Living Room Flooring', time: 'now', color: '#000' }],
      { role: 'contractor' },
    );
    // the seeded DL-014 is pending and client-held: the contractor's register never shows it
    expect(useStore.getState().decisions.find((d) => d.id === 'DL-014')?.status).toBe('pending');
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().routeItem).toBeNull();
    expect(getByTestId('notif-missing')).toBeTruthy();
  });

  it('a private draft never answers a notice, even for the pmc', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const draft = useStore.getState().decisions.find((d) => d.draft);
    expect(draft).toBeDefined();
    const { getByTestId } = await mount([{ text: `Decision awaiting approval: ${draft!.title}`, time: 'now', color: '#000' }]);
    fireEvent.click(getByTestId('notif-item'));
    expect(getByTestId('notif-missing')).toBeTruthy();
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

describe('an inspection notice opens the inspection its writer named (live bug 1b)', () => {
  it("an engineer's checklist notice opens that checklist on their field screen (Codex 4205610125)", async () => {
    const { useStore, getByTestId } = await mount(
      [{ text: 'New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor (INSP-22)', time: 'now', color: '#000' }],
      { role: 'engineer' },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('engineer-check');
    expect(useStore.getState().routeItem).toBe('INSP-22');
  });

  it('Codex 4209321875 — an id-less legacy notice opens the screen, never a record that reuses its title', async () => {
    const { useStore, getByTestId, queryByTestId } = await mount(
      [{ text: 'New checklist issued: Pre-Tiling Inspection — Bathroom 2 · 3rd Floor', time: 'now', color: '#000' }],
      { role: 'engineer' },
    );
    fireEvent.click(getByTestId('notif-item'));
    expect(useStore.getState().screen).toBe('engineer-check');
    expect(useStore.getState().routeItem).toBeNull();
    expect(queryByTestId('notif-missing')).toBeNull();
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
    // Codex 4209321885 — the approve's own snapshot APPLIED: only module-owned reads are owed
    expect(s().commandReconcileModulesOnly).toBe(true);

    release({ decisions: [dec('D-1', 'approved')], source: 'live', generation: null } as ModuleDecisions);
    await flush();
    await flush();
    expect(s().decisions[0].status).toBe('approved');
    expect(s().commandReconcilePending).toBe(false);
    s()._setGateway(null);
  });

  it('Codex 4206188320 — an APPLIED bulk publish owes its module reconcile too', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const s = () => useStore.getState();
    let release!: (d: ModuleDecisions) => void;
    const draft = { ...dec('D-2'), draft: true } as Decision;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(snapshot()),
      decisions: vi.fn().mockResolvedValueOnce({ decisions: [draft], source: 'live', generation: null } as ModuleDecisions),
      publishDecision: vi.fn().mockResolvedValue(snapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().requestFreshSnapshot();
    await flush();
    await flush();
    useStore.setState({ drawings: [] });
    expect(s().decisions[0].draft).toBe(true);

    gw.decisions.mockImplementationOnce(() => new Promise<ModuleDecisions>((r) => { release = r; }));
    s().publishAllDrafts();
    await flush();
    await flush();
    await flush();
    expect(gw.publishDecision).toHaveBeenCalled();
    // the publish's own snapshot APPLIED, carrying no decision slice: the retained one still says draft
    expect(s().decisions[0].draft).toBe(true);
    expect(s().commandReconcilePending).toBe(true);

    release({ decisions: [dec('D-2')], source: 'live', generation: null } as ModuleDecisions);
    await flush();
    await flush();
    expect(s().decisions[0].draft).toBeFalsy();
    expect(s().commandReconcilePending).toBe(false);
    s()._setGateway(null);
  });

  it('live bug 1b — an APPLIED inspection submit owes its module reconcile too', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const s = () => useStore.getState();
    const open: Checklist = {
      id: 'INSP-60', title: 'Slab Check', zone: 'Roof', date: 'Today', submitted: false,
      items: [{ id: 'i1', name: 'Slope', state: null, photos: 0, note: '' }],
    };
    const module = (checklists: Checklist[]): ModuleInspections =>
      ({ checklist: checklists[0] ?? null, openChecklists: checklists, reviews: [], review: null, reinspectionCreated: false, placedInspections: [], source: 'live', generation: null }) as unknown as ModuleInspections;
    let release!: (r: ModuleInspections) => void;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(snapshot()),
      inspections: vi.fn().mockResolvedValueOnce(module([open])),
      submitInspection: vi.fn().mockResolvedValue(snapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().requestFreshSnapshot();
    await flush();
    await flush();
    expect(s().checklist?.id).toBe('INSP-60');
    expect(s().commandReconcilePending).toBe(false);

    gw.inspections.mockImplementationOnce(() => new Promise<ModuleInspections>((r) => { release = r; }));
    s().setItem(0, 'pass');
    s().submitInspection();
    await flush();
    await flush();
    expect(gw.submitInspection).toHaveBeenCalled();
    // the submit's own snapshot APPLIED, carrying no inspection slice: the retained one still lists INSP-60
    expect(s().openChecklists.map((c) => c.id)).toEqual(['INSP-60']);
    expect(s().commandReconcilePending).toBe(true);

    release(module([]));
    await flush();
    await flush();
    expect(s().openChecklists).toHaveLength(0);
    expect(s().commandReconcilePending).toBe(false);
    s()._setGateway(null);
  });
});
