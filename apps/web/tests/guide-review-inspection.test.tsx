import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { warmImports } from './warm-imports';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 step 3c (Jagrut, 27 Oct: hold people's hands wherever they ask for help): the PMC's inspection review guide. It
 * points at the controls that decide a submitted inspection (Approve, Send back, or, with a failed item, Approve's
 * confirm) and ends only on the decision's own report (sent, or kept on this phone to send), or once a refresh shows
 * the review decided.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-pmc';

const snapshot = () => ({
  project: { id: 'qa', name: 'QA', short: 'QA', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

await warmImports(() => import('@/store/store'), () => import('@/screens/InspectionReviewScreen'), () => import('@/guide/GuideHost'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'));

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

/** the screen with the seeded queue (its first review has a FAILED item unless `passing`), under a server when `gateway` */
async function open(gateway: Record<string, unknown> | null, { online = true, passing = false, lang = 'en' as 'en' | 'hi' | 'gu' } = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const seeded = useStore.getState().reviews;
  const reviews = passing ? seeded.map((r, i) => (i === 0 ? { ...r, items: r.items.map((it) => ({ ...it, result: 'PASS' as const, rejected: false })) } : r)) : seeded;
  useStore.setState({
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'pmc', sessionUserId: 'u-pmc', short: 'QA',
    lang, screen: 'inspect-review', online, outbox: [], syncQueue: [], reviews, activeReviewId: reviews[0]!.id,
  } as never);
  if (gateway) useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), ...gateway } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  const { GUIDES } = await import('@/guide/guides');
  const { useGuideState } = await import('@/guide/guideState');
  const outcomes = await import('@/guide/outcomes');
  const seen: string[] = [];
  outcomes.subscribeGuideOutcome((o) => seen.push(o));
  render(<><GuideHost /><InspectionReviewScreen /></>);
  const guide = GUIDES.find((g) => g.id === 'review-inspection')!;
  const id = reviews[0]!.id;
  return { useStore, useGuideState, guide, seen, id };
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const tipAt = (n: string) => vi.waitFor(() => { if (step() !== n) throw new Error(`tip at ${step()}`); });
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const isDone = () => vi.waitFor(() => { if (!done().includes('review-inspection')) throw new Error('not done'); });
const press = (testId: string) => act(() => { fireEvent.click(document.querySelector(`[data-testid="${testId}"]`)!); });
const guided = () => [...document.querySelectorAll('[data-guide="review-decide"]')].map((el) => el.getAttribute('data-testid'));

describe('the inspection review guide (#482 step 3c)', () => {
  it('nothing failed: Approve, and done once the server takes it', async () => {
    const decideReview = vi.fn(async () => snapshot());
    const { useGuideState, guide, seen } = await open({ decideReview }, { passing: true });
    expect(guide.available!()).toBe(true);
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    expect(guided()).toEqual(['approve-inspection', 'send-reinspection']);
    press('approve-inspection');
    await isDone();
    expect(decideReview).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['review-decided']);
    expect(useGuideState.getState().run).toBeNull();
  });

  it('a failed item: Approve asks first, so its confirm is pointed at (not Send back behind it), and confirming finishes it', async () => {
    const decideReview = vi.fn(async () => snapshot());
    const { useGuideState, guide } = await open({ decideReview });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    // Approve (which only asks) is not a guide target; Send back is
    expect(guided()).toEqual(['send-reinspection']);
    press('approve-inspection');
    expect(guided()).toEqual(['confirm-approve-confirm']);
    expect(useGuideState.getState().run?.waiting).toBe(false);
    press('confirm-approve-confirm');
    await isDone();
    expect(decideReview).toHaveBeenCalledTimes(1);
  });

  it('Send back the server refuses leaves it on the review, unfinished', async () => {
    const decideReview = vi.fn(async () => { throw Object.assign(new Error('closed'), { status: 409 }); });
    const { useGuideState, guide } = await open({ decideReview });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('send-reinspection');
    await vi.waitFor(() => { if (decideReview.mock.calls.length !== 1 || useGuideState.getState().run?.waiting !== false) throw new Error('waiting'); });
    expect(done()).not.toContain('review-inspection');
    await tipAt('0');
  });

  it('while a decision sent online is unanswered, no review is pointed at (Codex 4403491374); a refusal points again', async () => {
    let refuse!: (e: unknown) => void;
    const decideReview = vi.fn(() => new Promise((_, reject) => { refuse = reject; }));
    const { useStore, useGuideState, guide } = await open({ decideReview });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('send-reinspection');
    await vi.waitFor(() => { if (decideReview.mock.calls.length !== 1) throw new Error('not sent'); });
    // the buttons stay, but pressing again would decide it twice: nothing is pointed at, nor offered
    expect(document.querySelector('[data-testid="send-reinspection"]')).not.toBeNull();
    expect(guided()).toEqual([]);
    expect(guide.available!()).toBe(false);
    // nor on another review the PMC turns to meanwhile
    act(() => { useStore.setState((s) => ({ reviews: [...s.reviews, { ...s.reviews[0]!, id: 'INSP-OTHER', decided: false }], activeReviewId: 'INSP-OTHER' })); });
    expect(document.querySelector('[data-testid="send-reinspection"]')).not.toBeNull();
    expect(guided()).toEqual([]);
    expect(guide.available!()).toBe(false);
    await act(async () => { refuse(Object.assign(new Error('closed'), { status: 409 })); });
    expect(useStore.getState().reviewDecisionsSending).toBe(0);
    await vi.waitFor(() => { if (guided().length === 0) throw new Error('not pointed at'); });
    expect(guided()).toEqual(['send-reinspection']);
    expect(guide.available!()).toBe(true);
  });

  it('a refusal whose review a refresh already shows decided (gone from the queue) still finishes it', async () => {
    let refuse!: (e: unknown) => void;
    const decideReview = vi.fn(() => new Promise((_, reject) => { refuse = reject; }));
    const { useStore, useGuideState, guide, id } = await open({ decideReview });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('send-reinspection');
    await vi.waitFor(() => { if (decideReview.mock.calls.length !== 1) throw new Error('not sent'); });
    // a refresh brings the queue without it first; then the decision's own answer is lost (refused on replay)
    act(() => { useStore.setState((s) => ({ reviews: s.reviews.filter((r) => r.id !== id) })); });
    await act(async () => { refuse(Object.assign(new Error('already decided'), { status: 409 })); });
    await isDone();
  });

  it('without signal: done once the decision is kept on this phone to send, and that review is not pointed at again', async () => {
    const decideReview = vi.fn();
    const { useStore, useGuideState, guide } = await open({ decideReview }, { online: false, passing: true });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('approve-inspection');
    await isDone();
    expect(decideReview).not.toHaveBeenCalled();
    expect(useStore.getState().outbox.filter((o) => o.t === 'decideReview')).toHaveLength(1);
    // its decision waits to send: the review still shows its buttons, but the guide neither offers nor points at them,
    // so a second press is never guided into a second decision
    expect(guided()).toEqual([]);
    expect(guide.available!()).toBe(false);
  });

  it('a queued decision the flush replays is on its way until the flush ends: its review is never pointed at meanwhile (Codex 4403818412)', async () => {
    const decideReview = vi.fn(async () => snapshot());
    const { useStore, useGuideState, guide, id } = await open({ decideReview }, { online: false, passing: true });
    const { reviewDecisionWaits } = await import('@/store/store');
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('approve-inspection');
    await isDone();
    // every state the flush passes through: the review still undecided on screen is always one with a decision on its way
    const open_: string[] = [];
    const stop = useStore.subscribe((s) => {
      if (s.reviews.some((r) => r.id === id && !r.decided) && !reviewDecisionWaits(s, id)) open_.push(`outbox ${s.outbox.length}`);
    });
    act(() => { useStore.setState({ online: true }); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    stop();
    expect(decideReview).toHaveBeenCalledTimes(1);
    expect(open_).toEqual([]);
    expect(useStore.getState().reviewDecisionsSending).toBe(0);
  });

  it('without signal, a decision this phone would not keep ends the run unfinished', async () => {
    const { useGuideState, guide, seen } = await open({ decideReview: vi.fn() }, { online: false, passing: true });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    // the phone's storage refuses every write, so the queued decision is not kept
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    press('approve-inspection');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['review-decide-not-kept']);
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).not.toContain('review-inspection');
  });

  it('nothing failed but an item marked Reject item: only Send back is pointed at, never Approve past the mark (Codex 4403818425)', async () => {
    const { useStore, useGuideState, guide } = await open(null, { passing: true });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    expect(guided()).toEqual(['approve-inspection', 'send-reinspection']);
    act(() => { useStore.getState().toggleReject(0); });
    expect(guided()).toEqual(['send-reinspection']);
    act(() => { useStore.getState().toggleReject(0); });
    expect(guided()).toEqual(['approve-inspection', 'send-reinspection']);
  });

  it('Send back with nothing marked or failed is refused at once and told, so the guide does not wait', async () => {
    const decideReview = vi.fn();
    const { useGuideState, guide, seen } = await open({ decideReview }, { passing: true });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('send-reinspection');
    expect(seen).toEqual(['review-decide-failed']);
    expect(decideReview).not.toHaveBeenCalled();
    expect(useGuideState.getState().run?.waiting ?? false).toBe(false);
    expect(done()).not.toContain('review-inspection');
  });

  it('the demo (no server) records the decision: done', async () => {
    const { useStore, useGuideState, guide, seen, id } = await open(null, { passing: true });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('approve-inspection');
    await isDone();
    expect(seen).toEqual(['review-decided']);
    expect(useStore.getState().reviews.find((r) => r.id === id)?.decided).toBe(true);
    // the decided review stays on screen as its record, with nothing to press: not offered, though another still waits
    act(() => { useStore.setState((s) => ({ reviews: [...s.reviews, { ...s.reviews[0]!, id: 'INSP-OTHER', decided: false }] })); });
    expect(useStore.getState().activeReviewId).toBe(id);
    expect(guide.available!()).toBe(false);
  });

  it('is offered, and points, only for the PMC, with a review waiting on a settled read', async () => {
    const { useStore, guide } = await open(null);
    expect(guide.roles).toEqual(['pmc']);
    expect(guide.available!()).toBe(true);
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    // a failed or loading refresh retains the last review, buttons and all: the guide neither offers nor points at them
    // (Codex 4403491383)
    act(() => { useStore.setState({ inspectionsLoad: 'error' }); });
    expect(guide.available!()).toBe(false);
    expect(document.querySelector('[data-testid="send-reinspection"]')).not.toBeNull();
    expect(guided()).toEqual([]);
    act(() => { useStore.setState({ inspectionsLoad: 'loading' }); });
    expect(guide.available!()).toBe(false);
    expect(document.querySelector('[data-testid="send-reinspection"]')).not.toBeNull();
    expect(guided()).toEqual([]);
    act(() => { useStore.setState({ inspectionsLoad: 'ready' }); });
    expect(guide.available!()).toBe(true);
    expect(guided()).toEqual(['send-reinspection']);
    act(() => { useStore.setState((s) => ({ reviews: s.reviews.map((r) => ({ ...r, decided: true })) })); });
    expect(guide.available!()).toBe(false);
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over', async (lang) => {
    const { useGuideState, guide } = await open(null, { passing: true, lang });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});
