import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { ProjectMember, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { PhotoMarkup } from '@/components/PhotoMarkup';
import { ApiGateway, tellSiteVisits, type OutboxOp, type SiteVisit, type SiteVisitFile } from '@/data/apiGateway';
import { listVisitPhotos, visitPhotoScope } from '@/data/visitPhotoStore';
import { photoDecodes } from '@/lib/photoDecodes';
import { MAX_PHOTO_BASE64 } from '@/lib/shrinkPhoto';
import { MARKUP_OPEN_WAIT_MS, MARKUP_RELINK_PAGES, refreshSiteVisits, useSiteVisits } from '@/lib/useSiteVisits';
import { MK } from '@/lib/photoMarkup';

/**
 * Site Visits M3: Mark up on a visit's photos (Stage 1's editor, site visits first: Jagrut, 19 Oct 2026). The marked-up
 * copy is a NEW visit file naming the photo it was drawn on, kept on the phone and sent exactly as a photo is (#1017);
 * the original stays as it was. The same people may mark up as may add a photo, never after the visit is closed, and
 * only a photo this browser decodes is offered. Opening a photo is bounded and stops when the person goes on.
 */

const CONSULTANT = 'u-cons';
const ENG = 'u-eng';
const MEMBERS = [
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
  { userId: ENG, name: 'Ramesh Patel', role: 'engineer', email: null, phone: null, status: 'active' },
] as ProjectMember[];
const walked = [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null }];

function stored(over: Partial<SiteVisitFile> = {}): SiteVisitFile {
  return {
    mediaId: 'm-1', url: '/media/m-1?t=9999999999.sig', mime: 'image/jpeg', clientKey: null, takenAt: '14 Oct 2026 · 10:05 AM',
    note: 'Crack near the sill', rating: 'concern', place: { nodeId: 'n-kit', name: 'Kitchen' },
    addedById: ENG, addedByName: 'Ramesh Patel', addedByRole: 'engineer', addedAt: '2026-10-14T04:50:00.000Z', ...over,
  };
}
function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: walked, attendees: [], files: [stored()],
    ...over,
  };
}

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };
function fakeGateway(list: SiteVisit[], over: Fake = {}): Fake {
  return {
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? list.filter((v) => v.status === 'open') : list)),
    ...over,
  };
}
function setUp(role: Role, me: string, gw: Fake, outbox: OutboxOp[] = []) {
  useStore.setState({ ...getInitialState(), outbox, role, lang: 'en', sessionUserId: me, nodes: [], members: MEMBERS, loadTeam: async () => true });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
}
async function mount(gw: Fake, role: Role = 'consultant', me = CONSULTANT) {
  setUp(role, me, gw);
  const view = render(<SiteVisitsScreen />);
  await act(async () => {});
  return view;
}

/** The card's thumbnail of `mediaId` draws (`ok`) or fails to decode in this browser. */
function thumb(mediaId: string, ok = true) {
  const img = screen.getByTestId(`sv-file-${mediaId}`).querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: ok ? 800 : 0, configurable: true });
  act(() => { if (ok) fireEvent.load(img); else fireEvent.error(img); });
}
const markUp = (mediaId: string) => screen.queryByTestId(`sv-markup-${mediaId}`);
async function openEditor(mediaId = 'm-1') {
  thumb(mediaId);
  await act(async () => { fireEvent.click(markUp(mediaId)!); });
  return screen.findByTestId('photo-markup-canvas');
}
function drag(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 300, clientY: 200, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 300, clientY: 200, pointerId: 1 });
}
const queuedFile = () => useStore.getState().outbox.find((o) => o.t === 'siteVisitAddFile') as Extract<OutboxOp, { t: 'siteVisitAddFile' }> | undefined;
const rows = () => listVisitPhotos(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId);
const network = () => new Error('network');
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });
/** A download that answers only when told, and stops when aborted (as the browser's does). */
function heldFetch() {
  const calls: { signal: AbortSignal; answer: (r: Response) => void }[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal!;
    calls.push({ signal, answer: resolve });
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  return { fetch, calls };
}

let decodes = true;
beforeEach(() => {
  decodes = true;
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1600;
    naturalHeight = 1200;
    set src(v: string) { if (v) setTimeout(() => (decodes ? this.onload?.() : this.onerror?.()), 0); }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    return {
      strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', font: '', textBaseline: 'alphabetic',
      clearRect: () => {}, drawImage: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, ellipse: () => {},
      stroke: () => {}, fill: () => {}, strokeText: () => {}, fillText: () => {}, measureText: () => ({ width: 10 }),
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJD');
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('jpeg', { status: 200 })));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

describe('Site Visits M3: Mark up on a visit’s photos', () => {
  it('offers Mark up to the visitor and anyone present, while the visit is not closed, on a stored photo once it decodes here', async () => {
    const offered = async (role: Role, me: string, v: SiteVisit, ok = true) => {
      await mount(fakeGateway([v]), role, me);
      thumb('m-1', ok);
      const has = markUp('m-1') !== null;
      cleanup();
      return has;
    };
    expect(await offered('consultant', CONSULTANT, visit())).toBe(true);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'ended' }))).toBe(true);
    const present = { id: 'a-1', kind: 'member' as const, userId: ENG, role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null };
    expect(await offered('engineer', ENG, visit({ attendees: [present] }))).toBe(true);
    expect(await offered('engineer', ENG, visit({ attendees: [{ ...present, retiredAt: '2026-10-14T04:46:00.000Z' }] }))).toBe(false);
    expect(await offered('engineer', ENG, visit())).toBe(false);
    expect(await offered('client', 'u-client', visit())).toBe(false);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'closed', closeReason: 'Left open' }))).toBe(false);
    // the thumbnail did not decode in this browser: not offered
    expect(await offered('consultant', CONSULTANT, visit(), false)).toBe(false);
  });

  it('decides by this browser’s decode, not the type: a HEIC photo whose thumbnail draws is offered, one whose thumbnail fails is not', async () => {
    const heic = visit({ files: [stored({ mime: 'image/heic' })] });
    await mount(fakeGateway([heic]));
    // not before the thumbnail has drawn
    expect(markUp('m-1')).toBeNull();
    thumb('m-1');
    expect(markUp('m-1')).not.toBeNull();
    cleanup();
    await mount(fakeGateway([heic]));
    thumb('m-1', false);
    expect(markUp('m-1')).toBeNull();
    cleanup();
    // a type the upload does not take is never offered, whatever the browser draws
    await mount(fakeGateway([visit({ files: [stored({ mime: 'image/bmp' })] })]));
    thumb('m-1');
    expect(markUp('m-1')).toBeNull();
  });

  it('asks the thumbnail again when its link is renewed: a fresh link is offered only once it too has drawn', async () => {
    const gw = fakeGateway([visit()]);
    await mount(gw);
    thumb('m-1');
    expect(markUp('m-1')).not.toBeNull();
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [stored({ url: '/media/m-1?t=9999999999.fresh' })] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1').querySelector('img')!.getAttribute('src')).toContain('fresh'));
    expect(markUp('m-1')).toBeNull();
    thumb('m-1');
    expect(markUp('m-1')).not.toBeNull();
  });

  it('never offers Mark up on the phone’s own copy of a photo still on its way', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    // beside a stored photo, which is offered
    await mount(fakeGateway([visit()], { uploadMedia }));
    await act(async () => { fireEvent.change(screen.getByTestId('sv-photo-file-v-1'), { target: { files: [new File([new Uint8Array([1, 2, 3])], 's.png', { type: 'image/png' })] } }); });
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // its picture is the phone's own copy, shown once the kept row is read
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).querySelector('img')).not.toBeNull());
    thumb(key);
    thumb('m-1');
    expect(markUp('m-1')).not.toBeNull();
    expect(markUp(key)).toBeNull();
  });

  it('saves the copy as a new visit file naming the original, kept on the phone in the one write, and sends it with no camera time', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-2', url: '/media/m-2' }));
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    const canvas = await openEditor();
    // the photo is downloaded once, with no credentials (the signed link is the permission)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    drag(canvas);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MK.save.en })); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const [input] = uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({ kind: 'visit', mime: 'image/jpeg', data: 'QUJD', sourceMediaId: 'm-1', nodeId: 'n-kit', siteVisit: { visitId: 'v-1' } });
    // the server gives it the original's camera time and location: the phone sends none, nor a note or rating
    for (const k of ['takenAt', 'geoLat', 'geoLng']) expect(input).not.toHaveProperty(k);
    expect(input.siteVisit).toEqual({ visitId: 'v-1' });
    // the editor closed once the copy was kept
    await vi.waitFor(() => expect(screen.queryByTestId('photo-markup-canvas')).toBeNull());
  });

  it('keeps the copy on the phone with sourceMediaId when there is no signal, labelled as a marked-up copy', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    drag(await openEditor());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MK.save.en })); });
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const op = queuedFile()!;
    expect(op.file).toEqual({ id: op.file.id, mime: 'image/jpeg', sourceMediaId: 'm-1', nodeId: 'n-kit' });
    expect((await rows()).map((r) => [r.clientKey, r.state, r.data, r.op.file.sourceMediaId])).toEqual([[op.file.id, 'queued', 'QUJD', 'm-1']]);
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${op.file.id}`).textContent).toContain('Marked-up copy'));
    expect(screen.getByTestId(`sv-file-${op.file.id}`).textContent).toContain('waiting to send');
    // the original is untouched
    expect(screen.getByTestId('sv-file-m-1').textContent).not.toContain('Marked-up copy');
  });

  it.each([
    [404, 'The photo to mark up is not on this site visit'],
    [409, 'This site visit was closed by the PMC and takes no more files'],
  ])('a copy refused offline (%s) ends not sent, with the server’s words, and is never sent again', async (status, words) => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    drag(await openEditor());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MK.save.en })); });
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // the save's own send has met no signal (and may still be settling: the next send is coalesced into it)
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    uploadMedia.mockClear();
    uploadMedia.mockRejectedValue(refusal(status, words));
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(async () => {
      expect(uploadMedia).toHaveBeenCalledTimes(1);
      expect(useStore.getState().outbox).toHaveLength(0);
      expect((await rows()).map((r) => [r.clientKey, r.state, r.reason])).toEqual([[key, 'failed', words]]);
    });
    const row = await screen.findByTestId(`sv-not-sent-${key}`);
    expect(row.textContent).toContain('Marked-up copy');
    expect(row.textContent).toContain(words);
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('does not open a photo this phone cannot decode, and says so', async () => {
    await mount(fakeGateway([visit()]));
    thumb('m-1');
    decodes = false;
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This phone cannot open this photo for marking.'));
    expect(screen.queryByTestId('photo-markup-canvas')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks once for a fresh link when the first is refused, and stops when the fresh read no longer lists the photo', async () => {
    const gw = fakeGateway([visit()]);
    const fetchMock = vi.fn(async (url: string) => (url.includes('fresh') ? new Response('jpeg') : new Response('', { status: 403 })));
    vi.stubGlobal('fetch', fetchMock);
    await mount(gw);
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [stored({ url: '/media/m-1?t=9999999999.fresh' })] })]);
    thumb('m-1');
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await screen.findByTestId('photo-markup-canvas');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining('9999999999.sig'), expect.stringContaining('fresh')]);
    cleanup();
    // the fresh read no longer lists the photo: no second download
    const gone = fakeGateway([visit()]);
    fetchMock.mockClear();
    await mount(gone);
    gone.listSiteVisits!.mockImplementation(async () => [visit({ files: [] })]);
    thumb('m-1');
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The photo could not be opened'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole open: a download that never answers is stopped at the limit and said to have failed', async () => {
    const held = heldFetch();
    vi.stubGlobal('fetch', held.fetch);
    await mount(fakeGateway([visit()]));
    thumb('m-1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    expect(screen.getByRole('status').textContent).toBe('Opening the photo…');
    await act(async () => { await vi.advanceTimersByTimeAsync(MARKUP_OPEN_WAIT_MS - 1); });
    expect(held.calls[0].signal.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(held.calls[0].signal.aborted).toBe(true);
    vi.useRealTimers();
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The photo could not be opened'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('holds its limit even over a step that ignores the stop', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await mount(fakeGateway([visit()]));
    thumb('m-1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(MARKUP_OPEN_WAIT_MS); });
    vi.useRealTimers();
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The photo could not be opened'));
  });

  it.each([
    ['Cancel', () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); }],
    ['signing out', () => { useStore.getState().completeSignOut(); }],
    ['switching project', () => { void useStore.getState().switchProject('other'); }],
    ['leaving the screen', () => { cleanup(); }],
  ])('stops an open on %s: the download is aborted, and a late answer never opens the editor or says anything', async (_label, leave) => {
    const held = heldFetch();
    vi.stubGlobal('fetch', held.fetch);
    await mount(fakeGateway([visit()], { switchProject: vi.fn(() => new Promise(() => {})) }));
    thumb('m-1');
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await act(async () => { leave(); });
    expect(held.calls[0].signal.aborted).toBe(true);
    await act(async () => { held.calls[0].answer(new Response('late')); });
    await act(async () => {});
    expect(screen.queryByTestId('photo-markup-canvas')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a second Mark up supersedes the first: the first download stops and only the second photo opens', async () => {
    const held = heldFetch();
    vi.stubGlobal('fetch', held.fetch);
    await mount(fakeGateway([visit({ files: [stored(), stored({ mediaId: 'm-3', url: '/media/m-3?t=9999999999.sig' })] })]));
    thumb('m-1');
    thumb('m-3');
    await act(async () => { fireEvent.click(markUp('m-1')!); });
    await act(async () => { fireEvent.click(markUp('m-3')!); });
    expect(held.calls[0].signal.aborted).toBe(true);
    expect(held.calls[1].signal.aborted).toBe(false);
    await act(async () => { held.calls[1].answer(new Response('m3')); });
    await screen.findByTestId('photo-markup-canvas');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes the photo for good when the viewer may no longer add to its visit, not only hides it', async () => {
    const present = (over: Partial<SiteVisit['attendees'][number]> = {}) => ({
      id: 'a-1', kind: 'member' as const, userId: ENG, role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null, ...over,
    });
    const gw = fakeGateway([visit({ attendees: [present()] })]);
    await mount(gw, 'engineer', ENG);
    await openEditor();
    // taken off the visit on another device: the editor goes
    gw.listSiteVisits!.mockImplementation(async () => [visit({ attendees: [present({ retiredAt: '2026-10-14T05:00:00.000Z' })] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.queryByTestId('photo-markup-canvas')).toBeNull());
    // and recorded as present again: the photo stays closed (its state was ended, not just hidden from the screen)
    gw.listSiteVisits!.mockImplementation(async () => [visit({ attendees: [present({ retiredAt: '2026-10-14T05:00:00.000Z' }), present({ id: 'a-2' })] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(markUp('m-1')).not.toBeNull());
    expect(screen.queryByTestId('photo-markup-canvas')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the editor when the visit is closed meanwhile', async () => {
    const gw = fakeGateway([visit()]);
    await mount(gw);
    await openEditor();
    gw.listSiteVisits!.mockImplementation(async () => [visit({ status: 'closed', closeReason: 'Left open' })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.queryByTestId('photo-markup-canvas')).toBeNull());
  });

  it('says a copy may not have been saved when the phone never confirms, and keeps the drawing to save again', async () => {
    await mount(fakeGateway([visit()], { uploadMedia: vi.fn().mockRejectedValue(network()) }));
    const canvas = await openEditor();
    drag(canvas);
    // the database opens, but a write's transaction never reports its end, and ignores the stop (a wedged connection)
    const held: (() => void)[] = [];
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const t = real.apply(this, args);
      if (args[1] !== 'readwrite') return t;
      return new Proxy(t, {
        set: (target, prop, value) => {
          if (prop === 'oncomplete') { target.oncomplete = () => held.push(() => (value as () => void)()); return true; }
          if (prop === 'onabort' || prop === 'onerror') return true;
          return Reflect.set(target, prop, value);
        },
        get: (target, prop) => { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; },
      });
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MK.save.en })); });
    await vi.waitFor(() => expect(screen.getByTestId('photo-markup-notice').textContent).toContain('This photo may not have been saved'), { timeout: 9000 });
    // still open, with the mark, and Save offered again
    expect(screen.getByTestId('photo-markup-canvas')).toBeTruthy();
    expect(screen.getByRole('button', { name: MK.undo.en }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: MK.save.en }).hasAttribute('disabled')).toBe(false);
    expect(queuedFile()).toBeUndefined();
    // the phone reports the save after all: the copy is kept and queued, as a photo's late save is (#1017)
    vi.mocked(IDBDatabase.prototype.transaction).mockRestore();
    await act(async () => { for (const end of held.splice(0)) end(); });
    await vi.waitFor(() => expect(queuedFile()?.file.sourceMediaId).toBe('m-1'));
  }, 20_000);

  it('says in the editor only what is about the copy: another act’s refusal stays on the page', async () => {
    await mount(fakeGateway([visit()]));
    await openEditor();
    const st = useStore.getState();
    await act(async () => { tellSiteVisits({ kind: 'refused', project: st.activeProjectId, generation: st.projectScopeGeneration, message: 'Project is archived' }); });
    expect(screen.queryByTestId('photo-markup-notice')).toBeNull();
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('Project is archived'))).toBe(true);
  });

  it('refuses a copy too large to send before anything is kept, says so, and keeps the editor open', async () => {
    let sv: ReturnType<typeof useSiteVisits> | null = null;
    function Probe() { sv = useSiteVisits(); return null; }
    setUp('consultant', CONSULTANT, fakeGateway([visit()]));
    render(<Probe />);
    await act(async () => {});
    await act(async () => { await sv!.openMarkup('v-1', 'm-1'); });
    expect(sv!.markup?.phase).toBe('open');
    let kept = true;
    await act(async () => { kept = await sv!.saveMarkup({ mime: 'image/jpeg', data: 'A'.repeat(MAX_PHOTO_BASE64 + 1) }); });
    expect(kept).toBe(false);
    expect(sv!.markupNotice).toBe('This marked-up copy is too large to send.');
    expect(sv!.error).toBeNull();
    expect(sv!.markup?.phase).toBe('open');
    expect(await rows()).toEqual([]);
  });

  it('names the photo each copy was drawn on, with its thumbnail opening it, and never guesses a gone original (Codex 4327055852)', async () => {
    const files = [
      stored({ mediaId: 'm-c2', url: '/media/m-c2?t=1.sig', sourceMediaId: 'm-2', note: null }),
      stored({ mediaId: 'm-c1', url: '/media/m-c1?t=1.sig', sourceMediaId: 'm-1', note: null }),
      stored({ mediaId: 'm-2', url: '/media/m-2?t=1.sig', note: 'Beam' }),
      stored({ mediaId: 'm-1', url: '/media/m-1?t=1.sig' }),
      stored({ mediaId: 'm-c9', url: '/media/m-c9?t=1.sig', sourceMediaId: 'm-9', note: null }),
    ];
    await mount(fakeGateway([visit({ files })]));
    const of = (id: string) => screen.getByTestId(`sv-copy-of-${id}`);
    // each copy names its own original by its place in the visit's photos, and its thumbnail opens that photo
    expect(of('m-c2').textContent).toBe('Marked-up copy of photo 3');
    expect(of('m-c2').getAttribute('href')).toContain('/media/m-2?t=1.sig');
    expect(of('m-c2').querySelector('img')!.getAttribute('src')).toContain('/media/m-2?t=1.sig');
    expect(of('m-c1').textContent).toBe('Marked-up copy of photo 4');
    expect(of('m-c1').getAttribute('href')).toContain('/media/m-1?t=1.sig');
    // an original the visit no longer lists is said to be gone, with no link and no number
    expect(of('m-c9').textContent).toBe('Marked-up copy · original no longer available');
    expect(of('m-c9').getAttribute('href')).toBeNull();
    expect(of('m-c9').querySelector('img')).toBeNull();
    // the originals carry no copy label
    expect(screen.queryByTestId('sv-copy-of-m-1')).toBeNull();
    cleanup();
    for (const lang of ['hi', 'gu'] as const) {
      setUp('consultant', CONSULTANT, fakeGateway([visit({ files })]));
      useStore.setState({ lang });
      render(<SiteVisitsScreen />);
      await act(async () => {});
      expect(screen.getByTestId('sv-copy-of-m-c2').textContent).not.toMatch(/[A-Za-z]/);
      expect(screen.getByTestId('sv-copy-of-m-c9').textContent).not.toMatch(/[A-Za-z]/);
      cleanup();
    }
  });

  describe('a visit shown from beyond the pages read (Codex 4327055870)', () => {
    // a full first page of newer visits, ended (not in the open read), so the old visit is beyond the page cursor
    const newer = Array.from({ length: 20 }, (_, i) => visit({ id: `v-n${i}`, status: 'ended', startedAt: `2026-10-15T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00.000Z`, files: [] }));
    const old = visit({ id: 'v-old', status: 'ended', startedAt: '2026-10-01T04:30:00.000Z', files: [stored({ url: '/media/m-1?t=1.old' })] });
    const older = (url: string | null) => [visit({ id: 'v-x', status: 'ended', startedAt: '2026-10-05T04:30:00.000Z', files: [] }), ...(url ? [{ ...old, files: [stored({ url })] }] : [])];
    type Q = { status?: string; before?: string } | undefined;
    const beforeReads = (gw: Fake) => gw.listSiteVisits!.mock.calls.filter(([q]) => (q as Q)?.before).map(([q]) => (q as Q)!.before);
    /** the old visit on screen (an act on it, queued without signal, was answered with it), its link expired */
    async function openOld(list: (q: Q, signal?: AbortSignal) => Promise<SiteVisit[]>) {
      const gw = fakeGateway([], { listSiteVisits: vi.fn(list) });
      const fetchMock = vi.fn(async (url: string) => (url.includes('fresh') ? new Response('jpeg') : new Response('', { status: 403 })));
      vi.stubGlobal('fetch', fetchMock);
      const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-old', claimedAt: '2026-10-01T05:30:00.000Z', idempotencyKey: 'k-end' };
      setUp('consultant', CONSULTANT, gw, [end]);
      useStore.setState({ online: false });
      render(<SiteVisitsScreen />);
      await act(async () => {});
      await act(async () => { tellSiteVisits({ kind: 'answer', project: gw.project as unknown as string, generation: useStore.getState().projectScopeGeneration, visit: old }); });
      await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1')).toBeTruthy());
      thumb('m-1');
      await act(async () => { fireEvent.click(markUp('m-1')!); });
      return { gw, fetchMock };
    }
    const failed = () => screen.queryByRole('alert')?.textContent?.includes('The photo could not be opened') ?? false;

    it('renews its link by reading the older pages on from the page cursor, and opens it', async () => {
      const { gw, fetchMock } = await openOld(async (q) => (q?.status === 'open' ? [] : q?.before ? older('/media/m-1?t=9.fresh') : newer));
      await screen.findByTestId('photo-markup-canvas');
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining('1.old'), expect.stringContaining('9.fresh')]);
      expect(beforeReads(gw)).toEqual(['v-n19']);
    });

    it('says it could not be opened only once that read has answered without it', async () => {
      let answer!: () => void;
      const { gw, fetchMock } = await openOld((q) => (q?.status === 'open' ? Promise.resolve([]) : q?.before
        ? new Promise<SiteVisit[]>((done) => { answer = () => done(older(null)); })
        : Promise.resolve(newer)));
      await vi.waitFor(() => expect(beforeReads(gw)).toEqual(['v-n19']));
      // held: nothing said yet
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(failed()).toBe(false);
      await act(async () => { answer(); });
      await vi.waitFor(() => expect(failed()).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads on at most MARKUP_RELINK_PAGES pages when every page is full', async () => {
      let n = 0;
      const { gw } = await openOld(async (q) => (q?.status === 'open' ? [] : q?.before
        ? Array.from({ length: 20 }, () => visit({ id: `v-p${(n += 1)}`, status: 'ended', files: [] }))
        : newer));
      await vi.waitFor(() => expect(failed()).toBe(true));
      expect(beforeReads(gw)).toHaveLength(MARKUP_RELINK_PAGES);
      expect(MARKUP_RELINK_PAGES).toBe(10);
    });

    it('cancels the older-page read itself when the open is stopped', async () => {
      const signals: AbortSignal[] = [];
      await openOld((q, signal) => {
        if (q?.status === 'open') return Promise.resolve([]);
        if (!q?.before) return Promise.resolve(newer);
        signals.push(signal!);
        return new Promise<SiteVisit[]>(() => {});
      });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0].aborted).toBe(false);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
      expect(signals[0].aborted).toBe(true);
    });

    it('takes a newer read’s answer when its own fresh read is overtaken, instead of saying it failed', async () => {
      // the open's own read is held; a newer read (another act's answer, a refresh) answers with the visit's fresh link
      let held: (() => void) | null = null;
      let reads = 0;
      const { fetchMock } = await openOld((q) => {
        if (q?.status === 'open') return Promise.resolve([]);
        if (q?.before) return Promise.resolve(older(null));
        reads += 1;
        // the first page reads: mount's (1), the open's own (2, held), the newer one (3) with the old visit on it
        if (reads === 2) return new Promise<SiteVisit[]>((done) => { held = () => done(newer); });
        if (reads >= 3) return Promise.resolve([{ ...old, files: [stored({ url: '/media/m-1?t=9.fresh' })] }]);
        return Promise.resolve(newer);
      });
      await vi.waitFor(() => expect(held).not.toBeNull());
      await act(async () => { refreshSiteVisits(); });
      await act(async () => { held!(); });
      await screen.findByTestId('photo-markup-canvas');
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining('1.old'), expect.stringContaining('9.fresh')]);
      expect(failed()).toBe(false);
    });

    describe('the open’s fresh read, followed to the newest and stopped with the open (Codex 4328350105, 4328350114)', () => {
      it('follows any number of overtaken reads to the newest, and opens with the one that answers', async () => {
        // the open's own read (2) and four reads after it (3 to 6): each one is overtaken by the next before it answers,
        // and only the last answers. The open must follow all of them, with no cap on how many
        const held: (() => void)[] = [];
        let reads = 0;
        const { fetchMock } = await openOld((q) => {
          if (q?.status === 'open') return Promise.resolve([]);
          if (q?.before) return Promise.resolve(older(null));
          reads += 1;
          if (reads === 1) return Promise.resolve(newer);
          const rows = reads === 6 ? [{ ...old, files: [stored({ url: '/media/m-1?t=9.fresh' })] }] : newer;
          return new Promise<SiteVisit[]>((done) => { held[reads] = () => done(rows); });
        });
        await vi.waitFor(() => expect(held[2]).toBeDefined());
        for (let n = 3; n <= 5; n += 1) {
          // a newer read is sent, then the one the open is waiting on comes back overtaken
          await act(async () => { refreshSiteVisits(); });
          await vi.waitFor(() => expect(held[n]).toBeDefined());
          await act(async () => { held[n - 1](); });
          expect(failed()).toBe(false);
        }
        await act(async () => { refreshSiteVisits(); });
        await vi.waitFor(() => expect(held[6]).toBeDefined());
        await act(async () => { held[5](); });
        expect(failed()).toBe(false);
        // the newest answers last, after four overtaken reads
        await act(async () => { held[6](); });
        await screen.findByTestId('photo-markup-canvas');
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining('1.old'), expect.stringContaining('9.fresh')]);
        expect(failed()).toBe(false);
        expect(reads).toBe(6);
      });

      it('ends as could not be opened when its own read fails and nothing newer was sent: it never waits on it again', async () => {
        // a wait on the same settled read again would spin on microtasks, where no timer can end it: each wait adds an
        // abort listener, so past 50 the spin is ended by a throw and counted, and the test fails at once
        let added = 0;
        const listen = AbortSignal.prototype.addEventListener;
        vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (this: AbortSignal, ...args: Parameters<AbortSignal['addEventListener']>) {
          if (args[0] === 'abort' && (added += 1) > 50) throw new Error('waited on the same read again');
          return listen.apply(this, args);
        });
        let reads = 0;
        const { fetchMock } = await openOld((q) => {
          if (q?.status === 'open') return Promise.resolve([]);
          reads += 1;
          // mount's read answers; the open's own fails, and it is still the newest read
          return reads === 1 ? Promise.resolve(newer) : Promise.reject(network());
        });
        await vi.waitFor(() => expect(failed()).toBe(true));
        expect(added).toBeLessThanOrEqual(50);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      it.each([
        ['a full page: no further page is asked for, and nothing it read is shown', 200],
        ['the last page: nothing it read is shown', 3],
      ])('stops its read on Cancel, answered after with %s', async (_label, size) => {
        // the open's own read of the open visits is held, and answers after Cancel
        const late = Array.from({ length: size }, (_, i) => visit({ id: `v-late${i}`, files: [] }));
        let openReads = 0;
        let answer: (() => void) | null = null;
        const signals: (AbortSignal | undefined)[] = [];
        const { gw } = await openOld((q, signal) => {
          if (q?.status !== 'open') return Promise.resolve(q?.before ? older(null) : newer);
          if (q.before) return Promise.resolve([]);
          openReads += 1;
          if (openReads !== 2) return Promise.resolve([]);
          signals.push(signal);
          return new Promise<SiteVisit[]>((done) => { answer = () => done(late); });
        });
        await vi.waitFor(() => expect(answer).not.toBeNull());
        expect(signals[0]?.aborted).toBe(false);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
        expect(signals[0]?.aborted).toBe(true);
        const asked = gw.listSiteVisits!.mock.calls.length;
        await act(async () => { answer!(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(gw.listSiteVisits!.mock.calls.length).toBe(asked);
        expect(screen.queryByTestId('sv-visit-v-late0')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
      });

      it('sends the open’s read again with its signal when an act’s answer overtakes it, and Cancel stops that read too', async () => {
        const signals: (AbortSignal | undefined)[] = [];
        const held: (() => void)[] = [];
        let reads = 0;
        await openOld((q, signal) => {
          if (q?.status === 'open') return Promise.resolve([]);
          if (q?.before) return Promise.resolve(older(null));
          reads += 1;
          if (reads === 1) return Promise.resolve(newer);
          signals.push(signal);
          return new Promise<SiteVisit[]>((done) => { held.push(() => done(newer)); });
        });
        await vi.waitFor(() => expect(held).toHaveLength(1));
        // an act's answer lands while the open's read is out: the read comes back overtaken and is sent again
        await act(async () => { tellSiteVisits({ kind: 'answer', project: useStore.getState().activeProjectId, generation: useStore.getState().projectScopeGeneration, visit: newer[0] }); });
        await act(async () => { held[0](); });
        await vi.waitFor(() => expect(held).toHaveLength(2));
        expect(signals[1]).toBe(signals[0]);
        expect(signals[1]?.aborted).toBe(false);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
        expect(signals[1]?.aborted).toBe(true);
      });

      describe('a stopped open gives the screen back its read (m3-r2 check gap 1)', () => {
        const other = visit({ id: 'v-other', files: [] });
        /** the server: `others` holds a visit started on another device once it is set; page reads are held while
         *  `holding`, each answered by its gate, and a held request whose signal aborts fails, as the browser's does */
        function server() {
          const state = { others: false, holding: false, gates: [] as (() => void)[] };
          const list = (q: Q, signal?: AbortSignal) => {
            if (q?.before) return Promise.resolve(older(null));
            const rows = q?.status === 'open' ? (state.others ? [other] : []) : newer;
            if (!state.holding) return Promise.resolve(rows);
            return new Promise<SiteVisit[]>((done, fail) => {
              state.gates.push(() => done(rows));
              signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
            });
          };
          return { state, list };
        }
        async function openWith(list: (q: Q, signal?: AbortSignal) => Promise<SiteVisit[]>, beforeOpen: () => Promise<void>) {
          const gw = fakeGateway([], { listSiteVisits: vi.fn(list) });
          vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
          const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-old', claimedAt: '2026-10-01T05:30:00.000Z', idempotencyKey: 'k-end' };
          setUp('consultant', CONSULTANT, gw, [end]);
          useStore.setState({ online: false });
          render(<SiteVisitsScreen />);
          await beforeOpen();
          await act(async () => { tellSiteVisits({ kind: 'answer', project: gw.project as unknown as string, generation: useStore.getState().projectScopeGeneration, visit: old }); });
          await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1')).toBeTruthy());
          thumb('m-1');
          await act(async () => { fireEvent.click(markUp('m-1')!); });
          return gw;
        }

        it('a refresh the open’s read overtook is still shown after Cancel: a visit started on another device appears', async () => {
          const { state, list } = server();
          await openWith(list, async () => {
            await act(async () => {});
            // a refresh is out (a ping, a reconnect) when the open sends its read
            state.others = true;
            state.holding = true;
            await act(async () => { refreshSiteVisits(); });
          });
          // both reads are out: the refresh's two requests, then the open's two
          await vi.waitFor(() => expect(state.gates).toHaveLength(4));
          state.holding = false;
          await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
          await act(async () => { for (const g of state.gates) g(); });
          expect(await screen.findByTestId('sv-visit-v-other')).toBeTruthy();
        });

        it('a first read still out when the open is cancelled leaves the screen ready, with Start visit shown', async () => {
          const { state, list } = server();
          state.holding = true;
          await openWith(list, async () => {});
          await vi.waitFor(() => expect(state.gates).toHaveLength(4));
          state.holding = false;
          await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
          await act(async () => { for (const g of state.gates) g(); });
          // the read it handed back answered: no Try again, as the stopped read did not fail
          expect(await screen.findByTestId('sv-start')).toBeTruthy();
          expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
          expect(screen.queryByRole('alert')).toBeNull();
        });

        it('sends no read of its own on Cancel when a newer screen read is already out: that one serves', async () => {
          const { state, list } = server();
          const gw = await openWith(list, async () => { await act(async () => {}); state.holding = true; });
          await vi.waitFor(() => expect(state.gates).toHaveLength(2));
          state.others = true;
          await act(async () => { refreshSiteVisits(); });
          await vi.waitFor(() => expect(state.gates).toHaveLength(4));
          const asked = gw.listSiteVisits!.mock.calls.length;
          await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
          expect(gw.listSiteVisits!.mock.calls.length).toBe(asked);
          await act(async () => { for (const g of state.gates) g(); });
          expect(await screen.findByTestId('sv-visit-v-other')).toBeTruthy();
        });
      });
    });
  });

  it('hands the page read’s signal to the request, so a stopped read is cancelled', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { seen.push(init?.signal); return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); }));
    const ctrl = new AbortController();
    await new ApiGateway('http://api.test', 'ambli').listSiteVisits({ before: 'v-1', limit: 20 }, ctrl.signal);
    expect(seen[0]).toBe(ctrl.signal);
  });

  it('labels a stored copy by its original, and reads a list from an API before M3 (no field) as no copy', async () => {
    await mount(fakeGateway([visit({ files: [stored(), stored({ mediaId: 'm-2', sourceMediaId: 'm-1', note: null })] })]));
    expect(screen.getByTestId('sv-file-m-2').textContent).toContain('Marked-up copy');
    const plain = stored();
    delete (plain as { sourceMediaId?: unknown }).sourceMediaId;
    expect(screen.getByTestId('sv-file-m-1').textContent).not.toContain('Marked-up copy');
    cleanup();
    await mount(fakeGateway([visit({ files: [plain] })]));
    expect(within(screen.getByTestId('sv-file-m-1')).queryByText('Marked-up copy')).toBeNull();
  });
});

describe('Site Visits M3: the pieces the editor rests on', () => {
  it('photoDecodes answers false at once when stopped, stops the image and lets its object URL go', async () => {
    let img: { src: string; onload: unknown } | null = null;
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private s = '';
      constructor() { img = this as never; }
      get src() { return this.s; }
      set src(v: string) { this.s = v; } // never answers
    });
    const ctrl = new AbortController();
    const answer = photoDecodes(new Blob(['x']), ctrl.signal);
    ctrl.abort();
    expect(await answer).toBe(false);
    expect(img!.src).toBe('');
    expect(img!.onload).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
    // and once only: the revoke its own end schedules finds it already let go
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toHaveLength(1);
  });

  it('the editor never hands on a copy the API’s body limit would refuse (between it and the old 14,000,000 ceiling)', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(`data:image/jpeg;base64,${'A'.repeat(MAX_PHOTO_BASE64 + 1)}`);
    expect(MAX_PHOTO_BASE64 + 1).toBeLessThan(14_000_000);
    const onSave = vi.fn();
    render(<PhotoMarkup source={new Blob(['x'])} lang="en" onSave={onSave} onCancel={() => {}} />);
    drag(await screen.findByTestId('photo-markup-canvas'));
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(MK.tooLarge.en);
  });
});
