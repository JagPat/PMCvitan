import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import type { ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { GuideHost } from '@/guide/GuideHost';
import { GUIDES } from '@/guide/guides';
import { useGuideState } from '@/guide/guideState';
import type { ApiGateway, SiteVisit } from '@/data/apiGateway';
import { MAX_PHOTO_BASE64 } from '@/lib/shrinkPhoto';
import { noteOwnOpenVisit } from '@/guide/visitFacts';
import { flushesEnded, settled, startWork, tracked } from './site-visit-work';

/**
 * #482 step 3c (Jagrut, 27 Oct: hold people's hands wherever they ask for help): the site visit guide. Start visit,
 * then Add photo on the visit just started. Start ends once the visit shows (and is passed over when one is already
 * open); the photo step ends only once the server has the photo, so a refused photo, or one still waiting for signal,
 * leaves the guide unfinished.
 */

vi.mock('@/data/apiGateway', async (load) => ({ ...(await load<typeof import('@/data/apiGateway')>()), API_BASE: 'http://api.test' }));
// a phone whose save is refused, or neither confirmed nor refused in time, when a test says so
const keep = vi.hoisted(() => ({ next: null as 'refused' | 'unconfirmed' | null }));
vi.mock('@/data/visitPhotoStore', async (load) => {
  const real = await load<typeof import('@/data/visitPhotoStore')>();
  return {
    ...real,
    putVisitPhoto: (...args: Parameters<typeof real.putVisitPhoto>) => {
      const how = keep.next;
      keep.next = null;
      if (how === 'refused') return Promise.reject(new Error('QuotaExceededError'));
      if (how === 'unconfirmed') return Promise.reject(new real.VisitPhotoUnconfirmed());
      return real.putVisitPhoto(...args);
    },
  };
});

const PMC = 'u-pmc';
const DONE_KEY = `vitan.guide.done.v1:user:${PMC}`;
const NODES: ProjectNode[] = [{ id: 'n-gf', parentId: null, name: 'Ground floor', kind: 'zone', order: 0 }];
const GUIDE = GUIDES.find((g) => g.id === 'record-site-visit')!;

function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [],
    ...over,
  };
}

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };

/** a server holding `list`; a started visit joins it, and an uploaded photo is filed on its visit under its client key */
function server(list: SiteVisit[], over: Fake = {}): Fake {
  const visits = [...list];
  return {
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? visits.filter((v) => v.status === 'open') : visits)),
    startSiteVisit: vi.fn(async (input: { id: string }) => {
      const v = visit({ id: input.id });
      visits.unshift(v);
      return v;
    }),
    uploadMedia: vi.fn(async (input: { clientKey: string; siteVisit: { visitId: string } }) => {
      const at = visits.findIndex((v) => v.id === input.siteVisit.visitId);
      const id = `m-${input.clientKey}`;
      visits[at] = { ...visits[at]!, files: [...(visits[at]!.files ?? []), {
        mediaId: id, url: `/media/${id}`, mime: 'image/png', clientKey: input.clientKey, takenAt: null, sourceMediaId: null, note: null,
        rating: null, place: null, addedById: PMC, addedByName: 'Priya Shah', addedByRole: 'pmc', addedAt: '2026-10-14T04:50:00.000Z',
      }] };
      return { id, url: `/media/${id}` };
    }),
    ...over,
  };
}

async function mount(gw: Fake, role: Role = 'pmc', read = true) {
  useStore.setState({ ...getInitialState(), role, lang: 'en', sessionUserId: PMC, nodes: NODES, members: [], loadTeam: async () => true, screen: 'site-visits', projectLoadState: 'ready' });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(tracked(gw) as unknown as ApiGateway);
  render(<><GuideHost /><SiteVisitsScreen /></>);
  await act(async () => {});
  // a read held open on purpose is waited on by its own call instead
  if (read) await settled();
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const tipAt = (n: string) => vi.waitFor(() => { if (step() !== n) throw new Error(`tip at ${step()}`); });
const photo = () => new File([new Uint8Array([1, 2, 3])], 'site.png', { type: 'image/png' });
const pick = async (visitId: string, f: File = photo()) => {
  await act(async () => { fireEvent.change(screen.getByTestId(`sv-photo-file-${visitId}`), { target: { files: [f] } }); });
  await settled();
};

beforeEach(() => {
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  onTestFinished(startWork(useStore));
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(async () => {
  await flushesEnded();
  act(() => { useGuideState.getState().stop(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((ok) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => ok(null); });
});

describe('the site visit guide (#482 step 3c)', () => {
  it('walks Start visit → Add photo on the visit just started, and is done once the server has the photo', async () => {
    const gw = server([]);
    await mount(gw);
    act(() => { useGuideState.getState().start(GUIDE); });
    await tipAt('0');
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    await settled();
    expect(gw.startSiteVisit).toHaveBeenCalledTimes(1);
    await tipAt('1');
    const id = (gw.startSiteVisit!.mock.calls[0] as [{ id: string }])[0].id;
    // the tip points at the new visit's own Add photo
    expect(document.querySelector(`[data-testid="sv-visit-${id}"] [data-guide="sv-add-photo"]`)).not.toBeNull();
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    await pick(id);
    expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { if (!done().includes('record-site-visit')) throw new Error('not done'); });
    expect(useGuideState.getState().run).toBeNull();
  });

  it('a photo the server refuses leaves the guide on Add photo, unfinished', async () => {
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'This site visit was closed by the PMC and takes no more files' });
    const gw = server([visit()], { uploadMedia: vi.fn(async () => { throw refused; }) });
    await mount(gw);
    // already on the photo step of a visit started earlier in this run
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    await pick('v-1');
    expect(screen.getAllByTestId(/^sv-not-sent-/)).toHaveLength(1);
    await tipAt('1');
    expect(useGuideState.getState().run?.waiting).toBe(false);
    expect(done()).not.toContain('record-site-visit');
  });

  it('a photo still waiting for signal leaves the guide unfinished; it finishes once the photo is sent', async () => {
    let fail = true;
    const gw = server([visit()]);
    const upload = gw.uploadMedia!.getMockImplementation() as (input: never) => Promise<unknown>;
    gw.uploadMedia!.mockImplementation(async (input: never) => { if (fail) throw new Error('network'); return upload(input); });
    await mount(gw);
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    await pick('v-1');
    expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
    // kept on the phone and waiting to send: not done yet
    expect(useStore.getState().outbox).toHaveLength(1);
    expect(done()).not.toContain('record-site-visit');
    expect(useGuideState.getState().run).not.toBeNull();
    fail = false;
    await act(async () => { await useStore.getState().flushOutbox(); });
    await settled();
    await vi.waitFor(() => { if (!done().includes('record-site-visit')) throw new Error('not done'); });
  });

  it('a photo this phone will not keep or send (too large) leaves the guide on Add photo, unfinished', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const gw = server([visit()]);
    await mount(gw);
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    expect(useGuideState.getState().run?.waiting).toBe(true);
    await pick('v-1', new File([new Uint8Array((MAX_PHOTO_BASE64 / 4) * 3 + 1)], 'huge.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('alert').textContent).toBe('This photo is too large to send. Try a smaller one.');
    await vi.waitFor(() => { if (useGuideState.getState().run?.waiting !== false) throw new Error('still waiting'); });
    expect(gw.uploadMedia).not.toHaveBeenCalled();
    expect(done()).not.toContain('record-site-visit');
  });

  it('a photo this phone refused to keep leaves the guide on Add photo, unfinished', async () => {
    const gw = server([visit()]);
    await mount(gw);
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    keep.next = 'refused';
    await pick('v-1');
    await vi.waitFor(() => { if (useGuideState.getState().run?.waiting !== false) throw new Error('still waiting'); });
    expect(gw.uploadMedia).not.toHaveBeenCalled();
    expect(done()).not.toContain('record-site-visit');
  });

  it('a photo whose save this phone neither confirmed nor refused keeps the guide waiting on it (Codex 4399847403)', async () => {
    const gw = server([visit()]);
    await mount(gw);
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    fireEvent.click(document.querySelector('[data-guide="sv-add-photo"]')!);
    keep.next = 'unconfirmed';
    await pick('v-1');
    expect(keep.next).toBeNull();
    expect(screen.getByRole('alert')).not.toBeNull();
    // it may still be kept and sent: the guide does not ask for another photo
    expect(useGuideState.getState().run?.waiting).toBe(true);
    expect(done()).not.toContain('record-site-visit');
  });

  it('a photo on another person\'s visit the viewer is present on does not finish it, and is not pointed at', async () => {
    const theirs = visit({ id: 'v-2', visitorId: 'u-other', visitorName: 'Kiran Rao', visitorRole: 'consultant', startedAt: '2026-10-14T05:30:00.000Z',
      attendees: [{ id: 'a-1', kind: 'member', userId: PMC, role: 'pmc', name: 'Priya Shah', addedAt: '2026-10-14T05:31:00.000Z', retiredAt: null }] });
    const gw = server([theirs, visit()]);
    await mount(gw);
    expect(screen.getByTestId('sv-visit-v-2').querySelector('[data-guide="sv-add-photo"]')).toBeNull();
    act(() => { useGuideState.getState().start(GUIDE); useGuideState.getState().setStep(1); });
    await tipAt('1');
    await pick('v-2');
    expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sv-visit-v-2').querySelector('[data-testid^="sv-file-"]')).not.toBeNull();
    expect(done()).not.toContain('record-site-visit');
    expect(useGuideState.getState().run).not.toBeNull();
  });

  it('with a visit already open (a run left before its photo went), it goes straight to Add photo on it (Codex 4399847415)', async () => {
    await mount(server([visit()]));
    expect(GUIDE.available!()).toBe(true);
    expect(screen.queryByTestId('sv-start')).toBeNull();
    act(() => { useGuideState.getState().start(GUIDE); });
    await tipAt('1');
    expect(useGuideState.getState().run?.pressed).toBe(false);
    expect(document.querySelector('[data-testid="sv-visit-v-1"] [data-guide="sv-add-photo"]')).not.toBeNull();
    cleanup();
    // with none open, it starts at Start visit
    await mount(server([visit({ visitorId: 'u-other', visitorName: 'Kiran Rao', visitorRole: 'consultant' })]));
    act(() => { useGuideState.getState().start(GUIDE); });
    await tipAt('0');
    // an engineer is not shown Start visit
    expect(GUIDE.roles).not.toContain('engineer');
  });

  it('what the screen noted counts only for the same person and project, and only once the visits are read', async () => {
    const opened = GUIDE.steps[0]!.skip!;
    await mount(server([visit()]));
    expect(opened()).toBe(true);
    cleanup();
    // read again, the list not back yet: what was noted stands (nothing is assumed while loading)
    const held = vi.fn(() => new Promise(() => {}));
    await mount(server([], { listSiteVisits: held }), 'pmc', false);
    expect(held).toHaveBeenCalled();
    expect(opened()).toBe(true);
    // another project, or another person, is not what was noted
    act(() => { useStore.setState({ activeProjectId: 'project-b' }); });
    expect(opened()).toBe(false);
    act(() => { useStore.setState({ activeProjectId: getInitialState().activeProjectId }); });
    expect(opened()).toBe(true);
    act(() => { useStore.setState({ sessionUserId: 'u-someone' }); });
    expect(opened()).toBe(false);
    act(() => { noteOwnOpenVisit(false); });
  });
});
