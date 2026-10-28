import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Decision, Lang } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';

/**
 * #482 step 3 (Jagrut, 27 Oct: hand-hold every role) — the client's walkthrough: on their Decisions screen, Approve on
 * the option they want, then confirm. The confirm step finishes only when the approval really went through (sent, or
 * kept on this phone to send), and follows the one decision the client pressed Approve on.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-1';

const dec = (id: string): Decision =>
  ({
    id, title: `Title ${id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true }, { label: 'B', key: 'b', material: 'Quartz', delta: 12000, swatch: 'tile' }],
    ageDays: 2, approvalCycle: 0,
  }) as unknown as Decision;

/** the server's answer to an approval: the project's decisions with that one approved */
const answer = (projectId: string, decisions: Decision[]) => ({
  project: { id: projectId, name: 'A', short: 'A', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions, activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/guide/GuideHost'), () => import('@/guide/Help'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'), () => import('@/screens/ClientDecisionsScreen'), () => import('@/layout/ModalHost'));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function client(decisions: Decision[] = [dec('DL-1'), dec('DL-2')], lang: Lang = 'en') {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'project-a',
    projectScopeGeneration: 1,
    projectLoadState: 'ready',
    role: 'client',
    screen: 'client-decisions',
    lang,
    sessionUserId: 'u-1',
    decisions,
  } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { ClientDecisionsScreen } = await import('@/screens/ClientDecisionsScreen');
  const { ModalHost } = await import('@/layout/ModalHost');
  const { useGuideState } = await import('@/guide/guideState');
  const view = render(<><GuideHost /><ClientDecisionsScreen /><ModalHost /></>);
  return { useStore, useGuideState, view };
}

const tick = (ms = 400) => act(() => { vi.advanceTimersByTime(ms); });
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const press = (el: Element) => act(() => { fireEvent.click(el); });
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** the client on the confirm step for DL-2's option B */
async function atConfirm() {
  const c = await client();
  tick();
  press(byTestId('approve-DL-2-b')!);
  tick();
  expect(step()).toBe('1');
  return c;
}

describe('the client is guided through approving a choice', () => {
  it('shows itself the first time, walks Approve → confirm, and is done once the approval is taken (demo)', async () => {
    const { useStore } = await client();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('approve-decision-client');
    expect(tip()?.textContent).toContain('tap Approve on the one you want');
    expect(document.querySelectorAll('[data-guide="approve-option"]')).toHaveLength(4);
    // any Approve moves it on, carrying its decision
    press(byTestId('approve-DL-2-b')!);
    tick();
    expect(step()).toBe('1');
    expect(tip()?.textContent).toContain('tap here to confirm');
    expect(tip()?.closest('[role="dialog"]')?.contains(byTestId('approve-lock'))).toBe(true);
    expect(byTestId('approve-lock')?.getAttribute('data-guide-key')).toBe('DL-2');
    press(byTestId('approve-lock')!);
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['approve-decision-client']);
    expect(useStore.getState().decisions.find((d) => d.id === 'DL-2')?.status).toBe('approved');
  });

  it('Cancel steps back to Approve, and nothing is done', async () => {
    await atConfirm();
    press(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Cancel')!);
    tick(400);
    tick(1000);
    expect(step()).toBe('0');
    expect(done()).toEqual([]);
  });

  it('online: waits while the approval is sent, a refusal steps back, an accepted one finishes', async () => {
    const { useStore, useGuideState } = await atConfirm();
    let refuse!: (e: Error) => void;
    act(() => { useStore.getState()._setGateway({ approveDecision: vi.fn(() => new Promise((_, reject) => { refuse = reject; })) } as never); });
    press(byTestId('approve-lock')!);
    await settle();
    tick(60_000);
    expect(useGuideState.getState().run?.step).toBe(1);
    await act(async () => { refuse(new Error('refused')); });
    await settle();
    tick(400);
    tick(1000);
    expect(useGuideState.getState().run?.step).toBe(0);
    expect(done()).toEqual([]);

    // again, and this time the server takes it
    press(byTestId('approve-DL-2-b')!);
    tick();
    const approved = { ...dec('DL-2'), status: 'approved' } as Decision;
    act(() => { useStore.getState()._setGateway({ approveDecision: vi.fn().mockResolvedValue(answer('project-a', [dec('DL-1'), approved])), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    press(byTestId('approve-lock')!);
    await settle();
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['approve-decision-client']);
  });

  it('another decision approved meanwhile does not finish it: the confirm step follows the one pressed', async () => {
    const { useGuideState } = await atConfirm();
    const { emitGuideOutcome, guideRunToken } = await import('@/guide/outcomes');
    act(() => emitGuideOutcome('decision-approved', 'DL-1', guideRunToken()));
    tick();
    expect(useGuideState.getState().run?.step).toBe(1);
    act(() => emitGuideOutcome('decision-approved', 'DL-2', guideRunToken()));
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['approve-decision-client']);
  });

  it('a refused approval of a decision withdrawn meanwhile is not an approval: the guide is not done', async () => {
    const { useStore, useGuideState } = await atConfirm();
    act(() => { useStore.getState()._setGateway({ approveDecision: vi.fn().mockRejectedValue(new Error('withdrawn')) } as never); });
    press(byTestId('approve-lock')!);
    act(() => { useStore.setState((st) => ({ decisions: st.decisions.map((d) => (d.id === 'DL-2' ? { ...d, status: 'withdrawn' } : d)) }) as never); });
    await settle();
    tick(400);
    tick(1000);
    expect(useGuideState.getState().run?.step).toBe(0);
    expect(done()).toEqual([]);
  });

  it('an approval sent on for the architect\'s countersign finishes it, also when a refresh shows it first', async () => {
    const { useStore, useGuideState } = await atConfirm();
    act(() => { useStore.getState()._setGateway({ approveDecision: vi.fn(() => new Promise(() => {})) } as never); });
    press(byTestId('approve-lock')!);
    await settle();
    act(() => { useStore.setState((st) => ({ decisions: st.decisions.map((d) => (d.id === 'DL-2' ? { ...d, status: 'awaiting_countersign' } : d)) }) as never); });
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['approve-decision-client']);
  });

  it('a decision to re-approve is guided the same way', async () => {
    const reopened = { ...dec('DL-3'), status: 'change' } as Decision;
    await client([reopened]);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('approve-decision-client');
    press(byTestId('approve-DL-3-a')!);
    tick();
    expect(byTestId('approve-lock')?.getAttribute('data-guide-key')).toBe('DL-3');
    press(byTestId('approve-lock')!);
    tick();
    expect(done()).toEqual(['approve-decision-client']);
  });

  it('a decision opened on its own (from a notice) shows no guide; Help\'s "Show me how" goes back to the list and starts it there', async () => {
    const c = await client();
    const { HelpButton } = await import('@/guide/Help');
    act(() => { c.useStore.getState().openDecision('DL-2'); });
    tick(2000);
    expect(byTestId('decision-focus-approve')).toBeTruthy();
    expect(tip()).toBeNull();
    render(<HelpButton />);
    press(byTestId('help-open')!);
    press(byTestId('help-guide-approve-decision-client')!);
    tick();
    expect(c.useStore.getState().decisionFocus).toBeNull();
    expect(tip()?.getAttribute('data-guide-id')).toBe('approve-decision-client');
    expect(step()).toBe('0');
  });

  it('nothing waiting on the client means no guide', async () => {
    await client([]);
    tick();
    expect(tip()).toBeNull();
    const { GUIDES } = await import('@/guide/guides');
    expect(GUIDES.find((g) => g.id === 'approve-decision-client')?.available?.()).toBe(false);
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over', async (lang) => {
    await client(undefined, lang);
    tick();
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});

describe('the store reports an approval\'s outcome for the guide', () => {
  async function store() {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'project-a', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'client', sessionUserId: 'u-1', decisions: [dec('DL-1')] } as never);
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: Array<[string, string | null]> = [];
    subscribeGuideOutcome((o, key) => seen.push([o, key]));
    const approve = () => { useStore.getState().openApprove('DL-1', 0); useStore.getState().confirmApprove(); };
    return { useStore, seen, approve };
  }

  it('taken in demo, refused, answered for another project, and kept offline', async () => {
    const { useStore, seen, approve } = await store();
    approve();
    expect(seen).toEqual([['decision-approved', 'DL-1']]);

    act(() => { useStore.setState({ decisions: [dec('DL-1')] } as never); useStore.getState()._setGateway({ approveDecision: vi.fn().mockRejectedValue(new Error('no')) } as never); });
    approve();
    await settle();
    expect(seen[1]).toEqual(['decision-approve-failed', 'DL-1']);

    act(() => { useStore.getState()._setGateway({ approveDecision: vi.fn().mockResolvedValue(answer('another-project', [])), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    approve();
    await settle();
    expect(seen[2]).toEqual(['decision-approve-failed', 'DL-1']);

    act(() => { useStore.setState({ online: false } as never); });
    approve();
    await settle();
    expect(seen[3]).toEqual(['decision-approved', 'DL-1']);
  });
});
