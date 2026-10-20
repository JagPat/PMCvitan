import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { ProjectMember, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { moveSiteVisitOps, type ApiGateway, type OutboxOp, type SiteVisit } from '@/data/apiGateway';
import { failVisitPhoto, listVisitPhotos, putVisitPhoto, visitPhotoScope } from '@/data/visitPhotoStore';
import { refreshSiteVisits } from '@/lib/useSiteVisits';

/**
 * Site Visits SV2 (#792): a photo added on a visit is kept on the phone with the act that sends it (`visitPhotoStore`),
 * so one taken without signal waits and goes once when signal returns (Jagrut, 19 Oct 2026, 12:24Z). The store is the
 * one record of a queued photo: an act lost from localStorage is rebuilt from it, a refused photo (or one whose visit
 * could not be started) stays with the server's reason until dismissed, and a sent one leaves nothing behind.
 * Each test named for a #992 finding fails at #992's head 5bc854c.
 */

const CONSULTANT = 'u-cons';
const MEMBERS = [
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
] as ProjectMember[];

function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [], files: [],
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

function setUp(role: Role, gw: Fake, outbox: OutboxOp[] = []) {
  useStore.setState({ ...getInitialState(), outbox, role, lang: 'en', sessionUserId: CONSULTANT, nodes: [], members: MEMBERS, loadTeam: async () => true });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
}

async function mount(gw: Fake, outbox: OutboxOp[] = []) {
  setUp('consultant', gw, outbox);
  const view = render(<SiteVisitsScreen />);
  await act(async () => {});
  return view;
}

const photo = () => new File([new Uint8Array([1, 2, 3])], 'site.png', { type: 'image/png' });
async function pick(visitId: string) {
  await act(async () => { fireEvent.change(screen.getByTestId(`sv-photo-file-${visitId}`), { target: { files: [photo()] } }); });
}
const queuedFile = () => useStore.getState().outbox.find((o) => o.t === 'siteVisitAddFile') as Extract<OutboxOp, { t: 'siteVisitAddFile' }> | undefined;
const rows = () => listVisitPhotos(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId);
const network = () => new Error('network');
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

describe('Site Visits SV2: a photo kept on the phone until it is sent (#792)', () => {
  it('keeps a photo taken without signal, shows it waiting with its picture, and sends the same file once', async () => {
    const uploadMedia = vi.fn().mockRejectedValueOnce(network()).mockResolvedValue({ id: 'm-2', url: '/media/m-2' });
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const kept = queuedFile()!;
    // the act holds no bytes; they wait with the act in the phone's database, never in localStorage
    expect(kept.file).not.toHaveProperty('data');
    expect(JSON.stringify(localStorage)).not.toContain('AQID');
    expect((await rows()).map((r) => [r.clientKey, r.state, r.data])).toEqual([[kept.file.id, 'queued', 'AQID']]);
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${kept.file.id}`).querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID'));
    expect(screen.getByTestId(`sv-file-${kept.file.id}`).textContent).toContain('waiting to send');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    const [[first], [again]] = uploadMedia.mock.calls as unknown as [[{ clientKey: string }], [{ clientKey: string }]];
    expect(again).toEqual(first);
    expect(first).toMatchObject({ data: 'AQID', clientKey: kept.file.id, kind: 'visit', siteVisit: { visitId: 'v-1' } });
    // sent: nothing of it is left on the phone, nor its picture on the screen (Codex 4319124631)
    expect(await rows()).toEqual([]);
    await vi.waitFor(() => expect(screen.queryByTestId(`sv-file-${kept.file.id}`)).toBeNull());
  });

  it('sends a photo whose act localStorage failed to keep, after a reload (Codex 4319124614)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    // localStorage is full: every write to it fails, silently
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    cleanup();
    // a reload: the in-memory queue is gone, and localStorage never held the act
    setUp('consultant', gw);
    expect(useStore.getState().outbox).toHaveLength(0);
    useStore.getState().hydrateOutbox();
    await vi.waitFor(() => expect(queuedFile()?.file.id).toBe(key));
    uploadMedia.mockResolvedValue({ id: 'm-4', url: '/media/m-4' });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).toHaveBeenLastCalledWith(expect.objectContaining({ clientKey: key, data: 'AQID' }));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('shows a photo once when a read already holds it before its answer comes', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [{
      mediaId: 'm-7', url: '/media/m-7', mime: 'image/png', clientKey: key, takenAt: null, note: null, rating: null, place: null,
      addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
    }] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-7')).toBeTruthy());
    expect(screen.queryAllByTestId(/^sv-file-/)).toHaveLength(1);
  });

  it('keeps a photo the server refused while no visit screen was open, and says why when it opens (Codex 4319124653)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit({ status: 'ended' })], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // the person leaves the screen; the photo is sent and refused
    cleanup();
    uploadMedia.mockRejectedValue(refusal(409, 'This site visit was closed by the PMC and takes no more files'));
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(useStore.getState().outbox).toHaveLength(0);
    expect((await rows()).map((r) => [r.clientKey, r.state, r.reason])).toEqual([[key, 'failed', 'This site visit was closed by the PMC and takes no more files']]);
    // later, the screen opens: the photo is listed as not sent, with the server's reason, until dismissed
    render(<SiteVisitsScreen />);
    const row = await screen.findByTestId(`sv-not-sent-${key}`);
    expect(row.textContent).toContain('This was not saved. This site visit was closed by the PMC and takes no more files');
    expect(row.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AQID');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' })); });
    await vi.waitFor(() => expect(screen.queryByTestId('sv-not-sent')).toBeNull());
    expect(await rows()).toEqual([]);
  });

  it('keeps the photos of a start the server refused, with why, instead of losing their bytes (Codex 4319124642)', async () => {
    const start: OutboxOp = {
      t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
      visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
    };
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn();
    await mount(fakeGateway([], { startSiteVisit, uploadMedia }), [start]);
    // a photo on the visit started without signal waits behind its start
    await vi.waitFor(() => expect(within(screen.getByTestId('sv-visit-v-tmp')).getByRole('button', { name: 'Add photo' })).toBeTruthy());
    await pick('v-tmp');
    await vi.waitFor(() => expect(queuedFile()?.visitId).toBe('v-tmp'));
    const key = queuedFile()!.file.id;
    startSiteVisit.mockRejectedValue(refusal(422, 'Project is archived'));
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect((await rows()).map((r) => [r.clientKey, r.state, r.reason])).toEqual([[key, 'failed', 'Project is archived']]);
    await vi.waitFor(() => expect(screen.getByTestId(`sv-not-sent-${key}`).textContent).toContain('Project is archived'));
  });

  it('moves the photos of a start refused for an open visit onto that visit, kept rows too', async () => {
    const start: OutboxOp = {
      t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
      visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
    };
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-5', url: '/media/m-5' });
    const gw = fakeGateway([], { startSiteVisit, uploadMedia });
    await mount(gw, [start]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-tmp')).toBeTruthy());
    await pick('v-tmp');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    startSiteVisit.mockRejectedValue(refusal(409, 'You already have a site visit open on this project'));
    gw.listSiteVisits!.mockImplementation(async () => [visit({ id: 'v-open' })]);
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(uploadMedia.mock.calls[0]).toMatchObject([{ siteVisit: { visitId: 'v-open' }, data: 'AQID' }]);
    expect(await rows()).toEqual([]);
  });

  it('moves a queued photo act with its start', () => {
    const op: OutboxOp = {
      t: 'siteVisitAddFile', visitId: 'v-tmp', scope: 'u-pmc', idempotencyKey: 'k-f', by: { name: 'Priya Shah', role: 'pmc' }, placeName: null,
      file: { id: 'c-1', mime: 'image/png' },
    };
    expect(moveSiteVisitOps([op], 'v-tmp', 'v-open')).toEqual([{ ...op, visitId: 'v-open' }]);
  });

  it('adds nothing, and says why, on a phone that cannot keep photos (no IndexedDB)', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const uploadMedia = vi.fn();
    await mount(fakeGateway([visit()], { uploadMedia }));
    const note = within(screen.getByTestId('sv-visit-v-1')).getByLabelText('Note (optional)') as HTMLInputElement;
    fireEvent.change(note, { target: { value: 'Crack' } });
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe(
      'This photo was not added: this browser cannot save photos on the phone (private browsing cannot). Open the app in a normal browser window and add it again.'));
    // nothing went, nothing waits, and the note is still there to try again
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(note.value).toBe('Crack');
  });

  it('adds nothing, and says why, when the phone fails to save the photo', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const uploadMedia = vi.fn();
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo was not added: it could not be saved on this phone. Free some space on the phone, then add it again.'));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });
});

/**
 * #998's round 1 (head 8078211): every photo goes through the kept record above, with signal or without, so the
 * findings about a photo held in screen memory cannot arise. Each test fails at 8078211.
 */
describe('Site Visits SV2: every photo is kept until the server answers it (#792, #998 round 1)', () => {
  const sent = (uploadMedia: ReturnType<typeof vi.fn>) => uploadMedia.mock.calls.map(([i]) => i as { clientKey: string; siteVisit: { note?: string } });

  it('gives every pick its own key and keeps its own fields, even the same file picked again (Codex 4319699330, 4319699341)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    // the same file (same name, size, time and type) picked twice, with a different note each time
    const same = photo();
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: 'Before' } });
    await act(async () => { fireEvent.change(screen.getByTestId('sv-photo-file-v-1'), { target: { files: [same] } }); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(1));
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: 'After' } });
    await act(async () => { fireEvent.change(screen.getByTestId('sv-photo-file-v-1'), { target: { files: [same] } }); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(2));
    // two photos, two keys; each goes again exactly as it was first sent
    uploadMedia.mockClear();
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    await act(async () => { await useStore.getState().flushOutbox(); });
    const [a, b] = sent(uploadMedia);
    expect(a.clientKey).not.toBe(b.clientKey);
    expect([a.siteVisit.note, b.siteVisit.note]).toEqual(['Before', 'After']);
    expect(await rows()).toEqual([]);
  });

  it.each([401, 429, 503])('keeps a photo through a %i, says no false "no signal", and sends it again as it was (Codex 4319347063, 4319699367)', async (status) => {
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error(String(status)), { status }));
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const key = queuedFile()!.file.id;
    // it waits on its visit; nothing claims there is no signal
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('waiting to send'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('no signal');
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    const [first, again] = sent(uploadMedia);
    expect(again).toEqual(first);
    expect(again.clientKey).toBe(key);
  });

  it('keeps a photo through signing in again, and sends it after under the same key (Codex 4319699348)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const first = sent(uploadMedia)[0];
    // signing out leaves the screen and the in-memory queue; signing in again as the same person starts afresh
    cleanup();
    setUp('consultant', gw);
    useStore.setState({ projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 });
    expect(useStore.getState().outbox).toHaveLength(0);
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    useStore.getState().hydrateOutbox();
    render(<SiteVisitsScreen />);
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(sent(uploadMedia)[1]).toEqual(first);
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    expect(await rows()).toEqual([]);
  });

  it('keeps a photo while the person goes to another screen and back (Codex 4319699354)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // another screen: Site Visits is unmounted, the project and sign-in stay
    cleanup();
    render(<SiteVisitsScreen />);
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('waiting to send'));
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    // tried on the way back in and by Send now: always the one photo, under its key
    expect(sent(uploadMedia).length).toBeGreaterThan(1);
    expect(new Set(sent(uploadMedia).map((i) => i.clientKey))).toEqual(new Set([key]));
  });

  it('keeps the place a photo was taken at when the visit lets that place go before it is sent (Codex 4319699338)', async () => {
    const walked = [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null }];
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit({ places: walked })], { uploadMedia });
    await mount(gw);
    fireEvent.change(within(screen.getByTestId('sv-visit-v-1')).getByLabelText('Place (optional)'), { target: { value: 'n-kit' } });
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // another device removes the place from the visit; this photo was taken while it was walked
    gw.listSiteVisits!.mockImplementation(async () => [visit({ places: [{ ...walked[0], retiredAt: '2026-10-14T04:55:00.000Z' }] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('Kitchen'));
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).toHaveBeenLastCalledWith(expect.objectContaining({ clientKey: key, nodeId: 'n-kit' }));
  });
});

/**
 * #999's round 1 (head 2cefcc7): each test fails there.
 */
describe('Site Visits SV2: a kept photo is never stranded (#792, #999 round 1)', () => {
  const startOp = (): Extract<OutboxOp, { t: 'siteVisitStart' }> => ({
    t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
    visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
  });
  const fileOp = (over: Partial<Extract<OutboxOp, { t: 'siteVisitAddFile' }>> = {}): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' }, ...over,
  });

  it('keeps a lane holding a photo where the release before it never reads, and reads both back (Codex 4320122193)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    // the earlier release reads `vitan.siteVisitQueue.<user>.<project>` and would drop a photo act it has no case for
    const project = useStore.getState().activeProjectId;
    const v1 = `vitan.siteVisitQueue.dev:${CONSULTANT}.${project}`;
    const v2 = `vitan.siteVisitQueue.v2.dev:${CONSULTANT}.${project}`;
    expect(localStorage.getItem(v1)).toBeNull();
    expect(localStorage.getItem(v2)).toContain('siteVisitAddFile');
    // an earlier release's tab adds an end meanwhile, where it reads and writes
    const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' };
    localStorage.setItem(v1, JSON.stringify([end]));
    // a reload has both, the photo's lane first
    cleanup();
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitAddFile', 'siteVisitEnd']);
    // and a lane with no photo goes back where every release reads it
    useStore.setState({ outbox: [end] });
    useStore.getState().queueSiteVisitAct({ ...end, idempotencyKey: 'k-e2' }, 'queued');
    expect(localStorage.getItem(v2)).toBeNull();
    expect(JSON.parse(localStorage.getItem(v1)!).map((o: OutboxOp) => o.t)).toEqual(['siteVisitEnd', 'siteVisitEnd']);
  });

  it('sends the start a kept photo needs when the outbox lost both, ahead of the photo (Codex 4320122186)', async () => {
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([], { startSiteVisit, uploadMedia });
    // localStorage keeps nothing: the start lives only in memory
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    await mount(gw, [startOp()]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-tmp')).toBeTruthy());
    await pick('v-tmp');
    await vi.waitFor(() => expect(queuedFile()?.visitId).toBe('v-tmp'));
    // a reload: the in-memory queue, start included, is gone
    cleanup();
    setUp('consultant', gw);
    const order: string[] = [];
    startSiteVisit.mockImplementation(async () => { order.push('start'); return visit({ id: 'v-tmp' }); });
    uploadMedia.mockImplementation(async () => { order.push('photo'); return { id: 'm-1', url: '/media/m-1' }; });
    useStore.getState().hydrateOutbox();
    await vi.waitFor(() => expect(order).toEqual(['start', 'photo']));
    expect(startSiteVisit.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'v-tmp' })]));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
  });

  it('keeps a photo whose save lands after a sign-out or project switch, for the scope it was taken in (Codex 4320122181)', async () => {
    const uploadMedia = vi.fn();
    await mount(fakeGateway([visit()], { uploadMedia }));
    const project = useStore.getState().activeProjectId;
    // the person switches project while the photo is being written
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      useStore.setState({ activeProjectId: 'p-other', projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 });
      return put.apply(this, args);
    });
    await pick('v-1');
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-other'));
    await act(async () => {});
    vi.mocked(IDBObjectStore.prototype.put).mockRestore();
    // nothing went to the other project, and the photo is still kept for its own
    expect(useStore.getState().outbox).toHaveLength(0);
    const kept = await listVisitPhotos(visitPhotoScope(null, CONSULTANT), project);
    expect(kept.map((r) => r.state)).toEqual(['queued']);
  });

  it('keeps a refused photo’s act until its row says so, and a sent one’s until its row is gone (Codex 4320122168)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit({ status: 'ended' })], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // refused for good, but the phone cannot mark the row: the act stays
    uploadMedia.mockRejectedValue(refusal(409, 'This site visit was closed by the PMC and takes no more files'));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(queuedFile()?.file.id).toBe(key);
    expect((await rows()).map((r) => r.state)).toEqual(['queued']);
    // it can now: sent again, refused again, marked, and only then let go
    put.mockRestore();
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(queuedFile()).toBeUndefined();
    expect((await rows()).map((r) => r.state)).toEqual(['failed']);
    // sent, but the phone cannot let go of the row: the act stays, and goes once the row has
    await act(async () => { await failVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, key, null); });
    cleanup();
    const sent = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia: sent }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const second = queuedFile()!.file.id;
    sent.mockResolvedValue({ id: 'm-2', url: '/media/m-2' });
    const del = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => { throw new DOMException('broken', 'UnknownError'); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(queuedFile()?.file.id).toBe(second);
    del.mockRestore();
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(queuedFile()).toBeUndefined();
    expect((await rows()).filter((r) => r.clientKey === second)).toEqual([]);
  });

  it('sends a photo it rebuilt while no visit screen is open (Codex 4320122176)', async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    // a reload with no Site Visits screen on show
    useStore.getState().hydrateOutbox();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ clientKey: 'c-1', data: 'AQID' })));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
  });

  it('says the server’s reason for a photo not sent in Hindi and Gujarati too (Codex 4320122189)', async () => {
    const project = useStore.getState().activeProjectId;
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), project, fileOp(), 'AQID');
    await failVisitPhoto(visitPhotoScope(null, CONSULTANT), project, 'c-1', 'This site visit was closed by the PMC and takes no more files');
    for (const lang of ['hi', 'gu'] as const) {
      setUp('consultant', fakeGateway([visit()]));
      useStore.setState({ lang });
      render(<SiteVisitsScreen />);
      const row = await screen.findByTestId('sv-not-sent-c-1');
      expect(row.textContent).toContain('This site visit was closed by the PMC and takes no more files');
      cleanup();
    }
  });
});
