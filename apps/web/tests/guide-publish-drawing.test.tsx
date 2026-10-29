import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { warmImports } from './warm-imports';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 step 3c (Jagrut, 27 Oct: hold people's hands wherever they ask for help): the PMC's drawing guide. It points at
 * Issue drawing, then at the file box (done once a file is attached), then at Publish, and ends only on the publish's own
 * report, or once a refresh shows that revision in the register. A publish that did not go through goes back to Issue.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-pmc';

const drawing = (number: string, rev: string, draft = false) => {
  const r = { id: `${number}-${rev}`, rev, status: 'for_construction', mime: 'application/pdf', url: 'x', sizeBytes: 1, note: '', issuedBy: 'JP', issuedAt: 'now', acks: [] };
  return { id: `DWG-${number}`, number, title: 'Ground floor plan', discipline: 'architectural', zone: null, activityId: null, decisionId: null, nodeId: null, draft, ackedByMe: false, current: r, revisions: [r] };
};

const snapshot = (drawings: unknown[] = []) => ({
  project: { id: 'qa', name: 'QA', short: 'QA', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings, phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

await warmImports(() => import('@/store/store'), () => import('@/screens/DrawingsScreen'), () => import('@/guide/GuideHost'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** the Drawings screen for the PMC, under a server when `gateway` */
async function open(gateway: Record<string, unknown> | null, { lang = 'en' as 'en' | 'hi' | 'gu' } = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'pmc', sessionUserId: 'u-pmc', short: 'QA',
    lang, screen: 'drawings', online: true, outbox: [], syncQueue: [], drawings: [], routeItem: null,
  } as never);
  if (gateway) useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), ...gateway } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { DrawingsScreen } = await import('@/screens/DrawingsScreen');
  const { GUIDES } = await import('@/guide/guides');
  const { useGuideState } = await import('@/guide/guideState');
  const outcomes = await import('@/guide/outcomes');
  const seen: string[] = [];
  outcomes.subscribeGuideOutcome((o) => seen.push(o));
  render(<><GuideHost /><DrawingsScreen /></>);
  const guide = GUIDES.find((g) => g.id === 'publish-drawing')!;
  return { useStore, useGuideState, guide, seen };
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const tipAt = (n: string, timeout = 1000) => vi.waitFor(() => { if (step() !== n) throw new Error(`tip at ${step()}`); }, { timeout });
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const isDone = () => vi.waitFor(() => { if (!done().includes('publish-drawing')) throw new Error('not done'); });
const press = (testId: string) => act(() => { fireEvent.click(document.querySelector(`[data-testid="${testId}"]`)!); });

/** Issue drawing, then the form filled in and a file attached: the tip is on Publish */
async function fillForm() {
  await tipAt('0');
  press('issue-drawing');
  await tipAt('1');
  const [number, , title] = [...document.querySelectorAll<HTMLInputElement>('input:not([type="file"])')];
  act(() => { fireEvent.change(number!, { target: { value: 'A-201' } }); fireEvent.change(title!, { target: { value: 'Ground floor plan' } }); });
  const file = new File(['%PDF-1'], 'a201.pdf', { type: 'application/pdf' });
  act(() => { fireEvent.change(document.querySelector('[data-testid="issue-drawing-file"]')!, { target: { files: [file] } }); });
  await tipAt('2');
}

const prepared = () => vi.fn(async (i: unknown) => ({ ...(i as object), contentSha256: 'digest' }));

describe('the drawing guide (#482 step 3c)', () => {
  it('Issue drawing, its file, then Publish: done once the server takes it', async () => {
    const submitIssue = vi.fn(async () => ({ drawingId: 'DWG-1', revisionId: 'r1' }));
    const { useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue });
    expect(guide.available!()).toBe(true);
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await isDone();
    expect(submitIssue).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['drawing-published']);
    expect(useGuideState.getState().run).toBeNull();
  });

  it('a cancelled file picker leaves the tip on the file box', async () => {
    const { useGuideState, guide } = await open({ prepareIssue: prepared(), submitIssue: vi.fn() });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('issue-drawing');
    await tipAt('1');
    act(() => { fireEvent.change(document.querySelector('[data-testid="issue-drawing-file"]')!, { target: { files: [] } }); });
    await tipAt('1');
  });

  it('a file attached before the number and title leaves the tip on the form until Publish can be pressed', async () => {
    const { useGuideState, guide } = await open({ prepareIssue: prepared(), submitIssue: vi.fn() });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('issue-drawing');
    await tipAt('1');
    act(() => { fireEvent.change(document.querySelector('[data-testid="issue-drawing-file"]')!, { target: { files: [new File(['%PDF-1'], 'a201.pdf', { type: 'application/pdf' })] } }); });
    await vi.waitFor(() => { if (!document.querySelector('[data-guide="drawing-file"]')?.textContent?.includes('a201.pdf') && !document.body.textContent?.includes('a201.pdf')) throw new Error('not attached'); });
    await tipAt('1');
    const [number, , title] = [...document.querySelectorAll<HTMLInputElement>('input:not([type="file"])')];
    act(() => { fireEvent.change(number!, { target: { value: 'A-201' } }); fireEvent.change(title!, { target: { value: 'Ground floor plan' } }); });
    await tipAt('2');
  });

  it('a publish the server refuses goes back to Issue drawing, unfinished', async () => {
    const submitIssue = vi.fn(async () => { throw Object.assign(new Error('taken'), { status: 409 }); });
    const { useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['drawing-publish-failed']);
    await tipAt('0');
    expect(done()).not.toContain('publish-drawing');
  });

  it('a file that cannot be prepared (no signal) goes back to Issue drawing, unfinished', async () => {
    const prepareIssue = vi.fn(async () => { throw new TypeError('offline'); });
    const submitIssue = vi.fn();
    const { useGuideState, guide, seen } = await open({ prepareIssue, submitIssue });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['drawing-publish-failed']);
    expect(submitIssue).not.toHaveBeenCalled();
    await tipAt('0');
  });

  it('an answer lost twice, whose refresh shows the revision published, still finishes it', async () => {
    const submitIssue = vi.fn(async () => { throw new TypeError('network aborted'); });
    const snap = vi.fn(async () => snapshot([drawing('A-201', 'A')]));
    const { useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue, snapshot: snap });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await isDone();
    expect(submitIssue).toHaveBeenCalledTimes(2);
    expect(snap).toHaveBeenCalled();
    expect(seen).toEqual(['drawing-publish-failed']);
  });

  it('an answer lost twice, whose refresh does not show it, goes back to Issue drawing', async () => {
    const submitIssue = vi.fn(async () => { throw new TypeError('network aborted'); });
    const snap = vi.fn(async () => snapshot([drawing('A-201', 'A', true)]));
    const { useGuideState, guide } = await open({ prepareIssue: prepared(), submitIssue, snapshot: snap });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await vi.waitFor(() => { if (!snap.mock.calls.length) throw new Error('no refresh'); });
    await tipAt('0');
    expect(done()).not.toContain('publish-drawing');
  });

  it('a revision label already in the register never finishes it: the refusal goes back to Issue drawing', async () => {
    const submitIssue = vi.fn(async () => { throw Object.assign(new Error('rev used'), { status: 409 }); });
    const { useStore, useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue });
    act(() => { useStore.setState({ drawings: [drawing('A-201', 'A')] as never }); });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['drawing-publish-failed']);
    await tipAt('0');
    expect(done()).not.toContain('publish-drawing');
  });

  it('an answer lost twice waits for a refresh begun after it: one already on its way, without the revision, does not send it back', async () => {
    const submitIssue = vi.fn(async () => { throw new TypeError('network aborted'); });
    const pulls: ((s: unknown) => void)[] = [];
    const snap = vi.fn(() => new Promise((ok) => { pulls.push(ok); }));
    const { useStore, useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue, snapshot: snap });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    // a refresh is already on its way (a live update) before the publish
    void useStore.getState().requestFreshSnapshot();
    await vi.waitFor(() => { if (pulls.length !== 1) throw new Error('no pull'); });
    press('publish-drawing');
    await vi.waitFor(() => { if (submitIssue.mock.calls.length !== 2) throw new Error('not tried twice'); });
    // that earlier pull predates the publish: it brings no revision, and the guide is not told yet
    await act(async () => { pulls[0]!(snapshot()); });
    expect(seen).toEqual([]);
    expect(useGuideState.getState().run?.waiting).toBe(true);
    // the pull begun after it shows the revision published: done
    await vi.waitFor(() => { if (pulls.length !== 2) throw new Error('no rerun'); });
    await act(async () => { pulls[1]!(snapshot([drawing('A-201', 'A')])); });
    await isDone();
  });

  it('Save as draft is not a publish: the guide is not finished by it', async () => {
    const submitIssue = vi.fn(async () => ({ drawingId: 'DWG-1', revisionId: 'r1' }));
    const { useGuideState, guide, seen } = await open({ prepareIssue: prepared(), submitIssue });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('save-draft-drawing');
    await vi.waitFor(() => { if (submitIssue.mock.calls.length !== 1) throw new Error('not saved'); });
    // the form closed with no publish: the guide steps back to Issue drawing once its Publish is gone a moment
    await tipAt('0', 5000);
    expect(seen).toEqual([]);
    expect(done()).not.toContain('publish-drawing');
  });

  it('the demo (no server) publishes it: done', async () => {
    const { useStore, useGuideState, guide, seen } = await open(null);
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('publish-drawing');
    await isDone();
    expect(seen).toEqual(['drawing-published']);
    expect(useStore.getState().drawings.find((d) => d.number === 'A-201')?.draft).toBe(false);
  });

  it('is offered, and points, only for the PMC, on a settled register', async () => {
    const { useStore, guide } = await open(null);
    expect(guide.roles).toEqual(['pmc']);
    expect(guide.available!()).toBe(true);
    expect(document.querySelector('[data-guide="drawing-issue"]')).not.toBeNull();
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    act(() => { useStore.setState({ drawingsLoad: 'loading' }); });
    expect(guide.available!()).toBe(false);
    expect(document.querySelector('[data-testid="issue-drawing"]')).not.toBeNull();
    expect(document.querySelector('[data-guide="drawing-issue"]')).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over', async (lang) => {
    const { useGuideState, guide } = await open(null, { lang });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});
