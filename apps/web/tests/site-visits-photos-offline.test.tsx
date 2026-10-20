import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { ProjectMember, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { moveSiteVisitOps, type ApiGateway, type OutboxOp, type SiteVisit } from '@/data/apiGateway';
import { failVisitPhoto, failVisitPhotosOn, fileVisitPhoto, listVisitPhotos, moveVisitPhotos, putVisitPhoto, settleFiledVisitPhotos, visitPhotoScope, visitsHeldByPhotos } from '@/data/visitPhotoStore';
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
/** the queue's own localStorage writes fail, silently (a full localStorage refuses them); a photo's small key, written
 *  beside its row, still fits */
const failQueueWrites = () => {
  const real = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (k.startsWith('vitan.visitPhotoHeld.')) return real.call(this, k, v);
    throw new Error('QuotaExceededError');
  });
};
const heldKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('vitan.visitPhotoHeld.'));
/** the rows still to send or refused: a sent photo's row stays, filed, until a Site Visits read settles it */
const waiting = async () => (await rows()).filter((r) => r.state !== 'filed');
const network = () => new Error('network');
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });
/** A send a test holds open on purpose, on a barrier only `sendsSettled` lets go. */
let heldSend: (() => void) | null = null;
/** No send is running. A test's store outlives the screens it unmounts, so a "reload" waits for this first: a real
 *  reload ends the old page's send, and here it would otherwise run on into the new page. A held send is let go first. */
const sendsSettled = () => {
  heldSend?.();
  heldSend = null;
  return vi.waitFor(() => expect(useStore.getState()._outboxFlushing()).toBe(false), { timeout: 10_000 });
};
/** The test's own send: a send still running from an earlier act (the pick's, the save's) settles first, or the store
 *  would coalesce this one into it and return before anything was sent. */
const flushOwn = async () => {
  await sendsSettled();
  await useStore.getState().flushOutbox();
};

// every test begins with no flush running: one left from the test before would take this test's sends into its rerun
beforeEach(() => {
  expect(useStore.getState()._outboxFlushing()).toBe(false);
});

afterEach(async () => {
  // the store outlives a test, and so does a flush still running when it ends: it is let settle against this test's own
  // gateway, or the next test's flushes are coalesced into it and its put-back reads the next test's rows
  await sendsSettled();
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
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const kept = queuedFile()!;
    // once the server has it, its list shows it
    gw.listSiteVisits!.mockImplementation(async () => (uploadMedia.mock.calls.length < 2 ? [visit()] : [visit({ files: [{
      mediaId: 'm-2', url: '/media/m-2', mime: 'image/png', clientKey: kept.file.id, takenAt: null, note: null, rating: null, place: null,
      addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
    }] })]));
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
    // sent: nothing of it is left on the phone, nor its picture on the screen once the server's own shows (Codex 4319124631)
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    await vi.waitFor(() => expect(screen.queryByTestId(`sv-file-${kept.file.id}`)).toBeNull());
    expect(screen.getByTestId('sv-file-m-2')).toBeTruthy();
  });

  it('sends a photo whose act localStorage failed to keep, after a reload (Codex 4319124614)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    // localStorage is full: every write of the queue fails, silently
    failQueueWrites();
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
    expect(await waiting()).toEqual([]);
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
    await act(flushOwn);
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
    await act(flushOwn);
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
    expect(await waiting()).toEqual([]);
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
    await act(flushOwn);
    const [a, b] = sent(uploadMedia);
    expect(a.clientKey).not.toBe(b.clientKey);
    expect([a.siteVisit.note, b.siteVisit.note]).toEqual(['Before', 'After']);
    expect(await waiting()).toEqual([]);
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
    await act(flushOwn);
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

  it('keeps a photo’s act out of every stored queue, so a release before it never meets one (Codex 4320122193, 4320404449)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // the pick's own send has ended (it writes this tab's lane as it goes), so what the earlier release's tab writes
    // below is what the reload reads
    await sendsSettled();
    // nothing a release reads holds the act, and the visit lane stays where every release reads it, never removed
    const project = useStore.getState().activeProjectId;
    const v1 = `vitan.siteVisitQueue.dev:${CONSULTANT}.${project}`;
    expect(Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes('siteVisitAddFile'))).toEqual([]);
    expect(localStorage.getItem(v1)).toBe('[]');
    // an earlier release's tab ends the visit, where it reads and writes
    const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' };
    localStorage.setItem(v1, JSON.stringify([end]));
    // a reload keeps that act, and puts the photo back from its row, ahead of the end it was taken before
    cleanup();
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    useStore.getState().hydrateOutbox();
    await vi.waitFor(() => expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitAddFile', 'siteVisitEnd']));
    expect(queuedFile()!.file.id).toBe(key);
    expect(JSON.parse(localStorage.getItem(v1)!)).toEqual([end]);
  });

  it('sends the start a kept photo needs when the outbox lost both, ahead of the photo (Codex 4320122186)', async () => {
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([], { startSiteVisit, uploadMedia });
    // localStorage keeps no queue: the start lives only in memory
    failQueueWrites();
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

  it('keeps a refused photo’s act until its row says so, and a sent one’s until its row is marked sent (Codex 4320122168)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit({ status: 'ended' })], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    // refused for good, but the phone cannot mark the row: the act stays
    uploadMedia.mockRejectedValue(refusal(409, 'This site visit was closed by the PMC and takes no more files'));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await act(flushOwn);
    expect(queuedFile()?.file.id).toBe(key);
    expect((await rows()).map((r) => r.state)).toEqual(['queued']);
    // it can now: sent again, refused again, marked, and only then let go
    put.mockRestore();
    await act(flushOwn);
    expect(queuedFile()).toBeUndefined();
    expect((await rows()).map((r) => r.state)).toEqual(['failed']);
    // sent, but the phone cannot mark the row sent: the act stays, and goes once the row says so
    await act(async () => { await failVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, key, null); });
    cleanup();
    const sent = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia: sent }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const second = queuedFile()!.file.id;
    sent.mockResolvedValue({ id: 'm-2', url: '/media/m-2' });
    const mark = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('broken', 'UnknownError'); });
    await act(flushOwn);
    expect(queuedFile()?.file.id).toBe(second);
    mark.mockRestore();
    await act(flushOwn);
    expect(queuedFile()).toBeUndefined();
    // marked sent, then settled by the screen's read after it
    await vi.waitFor(async () => expect((await rows()).filter((r) => r.clientKey === second)).toEqual([]));
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

/**
 * #999's round 2 (head 8161943): each test fails there.
 */
describe('Site Visits SV2: a kept photo lives in its row alone (#792, #999 round 2)', () => {
  const startOp = (): Extract<OutboxOp, { t: 'siteVisitStart' }> => ({
    t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
    visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
  });

  it('files a photo moved onto the open visit there after a project switch mid-flush and a reload (Codex 4320404441)', async () => {
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([], { startSiteVisit, uploadMedia });
    await mount(gw, [startOp()]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-tmp')).toBeTruthy());
    await pick('v-tmp');
    await vi.waitFor(() => expect(queuedFile()?.visitId).toBe('v-tmp'));
    const project = useStore.getState().activeProjectId;
    cleanup();
    // the start is refused for an open visit, and the person switches project while that visit is looked up
    startSiteVisit.mockRejectedValue(refusal(409, 'You already have a site visit open on this project'));
    gw.listSiteVisits!.mockImplementation(async () => {
      useStore.setState({ activeProjectId: 'p-other', projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 });
      return [visit({ id: 'v-open' })];
    });
    await act(async () => { await useStore.getState().flushOutbox(); });
    const starts = startSiteVisit.mock.calls.length;
    // back on the project, after a reload: the photo goes to the open visit, and the refused start is not sent again
    gw.listSiteVisits!.mockImplementation(async () => [visit({ id: 'v-open' })]);
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', gw);
    expect(useStore.getState().activeProjectId).toBe(project);
    useStore.getState().hydrateOutbox();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ siteVisit: { visitId: 'v-open' } })));
    expect(startSiteVisit.mock.calls.length).toBe(starts);
  });

  it('keeps a refused start and its photo queued when the phone cannot mark the photo, then marks it (Codex 4320404431)', async () => {
    const startSiteVisit = vi.fn().mockRejectedValue(network());
    const uploadMedia = vi.fn();
    await mount(fakeGateway([], { startSiteVisit, uploadMedia }), [startOp()]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-tmp')).toBeTruthy());
    await pick('v-tmp');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    startSiteVisit.mockRejectedValue(refusal(422, 'Project is archived'));
    const update = vi.spyOn(IDBCursor.prototype, 'update').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    // nothing is let go while its row still says queued
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitStart', 'siteVisitAddFile']);
    expect((await rows()).map((r) => r.state)).toEqual(['queued']);
    update.mockRestore();
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(useStore.getState().outbox).toHaveLength(0);
    expect((await rows()).map((r) => [r.clientKey, r.state, r.reason])).toEqual([[key, 'failed', 'Project is archived']]);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('shows a waiting photo as added when it was added, however often the list is drawn again (Codex 4320404453)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T05:00:00.000Z'));
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`)).toBeTruthy());
    const first = screen.getByTestId(`sv-file-${key}`).textContent;
    // two hours on, the list is read and drawn again
    vi.setSystemTime(new Date('2026-10-14T07:00:00.000Z'));
    await act(async () => { refreshSiteVisits(); });
    await act(async () => {});
    expect(screen.getByTestId(`sv-file-${key}`).textContent).toBe(first);
    vi.useRealTimers();
  });
});

/**
 * #1004's round 1 (head cb30b35): each test fails there.
 */
describe('Site Visits SV2: a kept photo goes in its place, with or without the screen (#792, #1004 round 1)', () => {
  const fileOp = (): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });

  it('sends a photo put back on load before a close queued after it, however the queue is first sent (Codex 4320690147)', async () => {
    const order: string[] = [];
    const uploadMedia = vi.fn(async () => { order.push('photo'); return { id: 'm-1', url: '/media/m-1' }; });
    const closeSiteVisit = vi.fn(async () => { order.push('close'); return visit({ status: 'closed', closeReason: 'Done' }); });
    setUp('consultant', fakeGateway([visit()], { uploadMedia, closeSiteVisit }));
    const project = useStore.getState().activeProjectId;
    // the photo is kept on the phone; the close made after it is in the stored visit lane
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), project, fileOp(), 'AQID');
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    localStorage.setItem(`vitan.siteVisitQueue.dev:${CONSULTANT}.${project}`, JSON.stringify([close]));
    // a reload: the queue is loaded and sent at once (the network coming back, the server's reconnect ping, a new act)
    useStore.getState().hydrateOutbox();
    void useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(order).toEqual(['photo', 'close']));
  });

  it('sends a kept photo when the network comes back or the server reconnects, with no visit screen open (Codex review 5579878680)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    // the person leaves Site Visits; the network comes back
    cleanup();
    uploadMedia.mockClear();
    uploadMedia.mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    await act(async () => { globalThis.dispatchEvent(new Event('online')); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    // and a photo still waiting goes on the server's reconnect ping too
    uploadMedia.mockClear();
    uploadMedia.mockRejectedValueOnce(network()).mockResolvedValue({ id: 'm-2', url: '/media/m-2' });
    render(<SiteVisitsScreen />);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-1')).toBeTruthy());
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
  });
});

describe('Site Visits SV2: every send puts kept photos back first, and holds visit acts when it cannot (#792, #1004 round 2)', () => {
  const fileOp = (visitId = 'v-1'): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId, scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });
  const startOp = (): Extract<OutboxOp, { t: 'siteVisitStart' }> => ({
    t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
    visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
  });
  /** a photo kept on the phone, and the close made after it in the stored visit lane; then a reload */
  async function keptPhotoThenClose(order: string[]) {
    const uploadMedia = vi.fn(async () => { order.push('photo'); return { id: 'm-1', url: '/media/m-1' }; });
    const closeSiteVisit = vi.fn(async () => { order.push('close'); return visit({ status: 'closed', closeReason: 'Done' }); });
    setUp('consultant', fakeGateway([visit()], { uploadMedia, closeSiteVisit }));
    const project = useStore.getState().activeProjectId;
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), project, fileOp(), 'AQID');
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    localStorage.setItem(`vitan.siteVisitQueue.dev:${CONSULTANT}.${project}`, JSON.stringify([close]));
    return { closeSiteVisit };
  }

  it('holds a close queued after a kept photo while the phone cannot read its kept photos, and sends both once it can (Codex 4321084738)', async () => {
    const order: string[] = [];
    const { closeSiteVisit } = await keptPhotoThenClose(order);
    // the phone's database fails to open for a while (a transient IndexedDB failure)
    let broken = true;
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (broken) throw new Error('UnknownError');
      return realOpen(name, version);
    });
    useStore.getState().hydrateOutbox();
    await act(async () => { await useStore.getState().flushOutbox(); });
    // the photo could not be put back: the close is not sent ahead of it, and stays queued
    expect(closeSiteVisit).not.toHaveBeenCalled();
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitClose']);
    // the database is back: the next send puts the photo back in its place, ahead of the close
    broken = false;
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(order).toEqual(['photo', 'close']));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    expect(await waiting()).toEqual([]);
  });

  it('holds a close queued after a kept photo while the photo is slow to be put back, past the wait', async () => {
    const order: string[] = [];
    const { closeSiteVisit } = await keptPhotoThenClose(order);
    // the phone is slow to read its kept photos back: every read waits until released
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let released = false;
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      const req = realOpen(name, version);
      if (released) return req;
      let onsuccess: ((this: IDBRequest, ev: Event) => unknown) | null = null;
      req.addEventListener('success', (ev) => { void slow.then(() => onsuccess?.call(req, ev)); });
      return new Proxy(req, {
        get: (t, k) => (k === 'onsuccess' ? onsuccess : Reflect.get(t, k, t)),
        set: (t, k, v) => { if (k === 'onsuccess') onsuccess = v; else Reflect.set(t, k, v, t); return true; },
      });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      useStore.getState().hydrateOutbox();
      const flushing = useStore.getState().flushOutbox();
      await vi.advanceTimersByTimeAsync(5000);
      await flushing;
      // past the wait the rest of the queue may go, but the close waits for its photo
      expect(closeSiteVisit).not.toHaveBeenCalled();
      expect(useStore.getState().outbox.map((o) => o.t)).toContain('siteVisitClose');
    } finally {
      vi.useRealTimers();
      released = true;
      release();
    }
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(order).toEqual(['photo', 'close']));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
  });

  it('settles a photo kept just after its refused start was settled, with no reload (Codex 4321084743)', async () => {
    const project = () => useStore.getState().activeProjectId;
    const startSiteVisit = vi.fn().mockRejectedValue(refusal(422, 'Project is archived'));
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    // another act sent after the refused start: while it is in flight the person adds a photo on the refused visit,
    // and the phone writes it only now, after the refusal marked the visit's photos
    const closeSiteVisit = vi.fn(async () => {
      await putVisitPhoto(visitPhotoScope(null, CONSULTANT), project(), fileOp('v-tmp'), 'AQID', startOp());
      useStore.getState().queueSiteVisitAct(fileOp('v-tmp'), 'queued');
      return visit({ id: 'v-2', status: 'closed', closeReason: 'Done' });
    });
    const other: OutboxOp = { t: 'siteVisitClose', visitId: 'v-2', reason: 'Done', idempotencyKey: 'k-c2' };
    setUp('consultant', fakeGateway([], { startSiteVisit, uploadMedia, closeSiteVisit }), [startOp(), other]);
    await act(async () => { await useStore.getState().flushOutbox(); });
    // the photo is not left waiting with no act to send it: it is settled like the others on that start, with why
    await vi.waitFor(async () => expect((await rows()).map((r) => [r.clientKey, r.state, r.reason])).toEqual([['c-1', 'failed', 'Project is archived']]));
    expect(uploadMedia).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
  });

  it('leaves a queue alone when the project changes while its kept photos are read: no act sent, no lease taken for the new one', async () => {
    const approveA = vi.fn(async () => undefined);
    const gwA = fakeGateway([visit()], { approveDecision: approveA });
    const approve: OutboxOp = { t: 'approve', decisionId: 'D-1', optionIndex: 0, idempotencyKey: 'k-a' };
    setUp('consultant', gwA, [approve]);
    // the read of the kept photos waits until released
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      const req = realOpen(name, version);
      let onsuccess: ((this: IDBRequest, ev: Event) => unknown) | null = null;
      req.addEventListener('success', (ev) => { void slow.then(() => onsuccess?.call(req, ev)); });
      return new Proxy(req, {
        get: (t, k) => (k === 'onsuccess' ? onsuccess : Reflect.get(t, k, t)),
        set: (t, k, v) => { if (k === 'onsuccess') onsuccess = v; else Reflect.set(t, k, v, t); return true; },
      });
    });
    const flushing = useStore.getState().flushOutbox();
    // the person moves to another project meanwhile
    const snapshotB = vi.fn(() => new Promise(() => {}));
    useStore.setState((st) => { st.activeProjectId = 'B'; st.projectScopeGeneration += 1; st.outbox = []; });
    useStore.getState()._setGateway({ project: 'B', snapshot: snapshotB } as unknown as ApiGateway);
    release();
    const result = await flushing;
    expect(result.ran).toBe(false);
    expect(approveA).not.toHaveBeenCalled();
    expect(snapshotB).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('sends nothing from a retry armed for one queue once the project or sign-in has changed', async () => {
    const order: string[] = [];
    await keptPhotoThenClose(order);
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('UnknownError'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      useStore.getState().hydrateOutbox();
      await useStore.getState().flushOutbox(); // the read failed: the close is held and a retry armed
      const flush = vi.fn(async () => ({ ran: false, scopeMoved: false, succeededKeys: [], droppedKeys: [], pendingKeys: [] }));
      const realFlush = useStore.getState().flushOutbox;
      onTestFinished(() => useStore.setState({ flushOutbox: realFlush }));
      useStore.setState({ flushOutbox: flush });
      // signed in as someone else before it fires
      useStore.setState({ sessionUserId: 'u-other' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Site Visits SV2: a photo still waiting is always tried again (#792, #1008 round 1)', () => {
  const fileOp = (): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });
  const serverFile = (clientKey: string) => ({
    mediaId: 'm-1', url: '/media/m-1', mime: 'image/png', clientKey, takenAt: null, note: null, rating: null, place: null,
    addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
  });
  afterEach(() => { vi.useRealTimers(); });

  it('tries a kept photo again when the phone could not read it on load or when sending, with nothing else queued (Codex 4321558423)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    // after a reload the photo is only in the phone's database, and the database fails for a while
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    let broken = true;
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (broken) throw new Error('UnknownError');
      return realOpen(name, version);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useStore.getState().hydrateOutbox();
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(uploadMedia).not.toHaveBeenCalled();
    // the database recovers; no ping, reconnect or screen comes, yet the photo goes
    broken = false;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
  });

  it('keeps a sent photo on screen until the server lists it, reading again until it does (Codex 4321558427)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const gw = fakeGateway([visit()], { uploadMedia });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount(gw);
    // the read made after the upload fails; the server lists the photo from the next read on
    let key = '';
    let reads = 0;
    gw.listSiteVisits!.mockImplementation(async () => {
      if (!uploadMedia.mock.calls.length) return [visit()];
      reads += 1;
      if (reads <= 2) throw network(); // the first read after the upload (both of its lists) fails
      return [visit({ files: [serverFile(key)] })];
    });
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    key = (uploadMedia.mock.calls[0] as unknown as [{ clientKey: string }])[0].clientKey;
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await act(async () => {});
    // the server has it, but its list has not said so yet: the photo is still shown, and not as waiting to send
    expect(screen.getByTestId(`sv-file-${key}`).querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect(screen.getByTestId(`sv-file-${key}`).textContent).not.toContain('waiting to send');
    // the retry reads again, with no ping or reconnect, and the server's own copy takes its place
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1')).toBeTruthy());
    expect(screen.queryByTestId(`sv-file-${key}`)).toBeNull();
  });

  it('tries a photo again after a busy or failing server, after the server’s own wait, with the socket up (Codex 4321558432)', async () => {
    const busy = Object.assign(refusal(503, 'Busy'), { retryAfter: 8 });
    const uploadMedia = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await useStore.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    // not before the server's own wait
    await vi.advanceTimersByTimeAsync(7000);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    expect(await waiting()).toEqual([]);
  });

  it.each([
    ['no wait', refusal(429, 'Slow down')],
    ['a wait that is not a number', Object.assign(refusal(429, 'Slow down'), { retryAfter: '8' })],
    ['a wait that is not finite', Object.assign(refusal(503, 'Busy'), { retryAfter: Infinity })],
  ])('tries a photo again on the usual wait when the server gives %s, never at once', async (_label, err) => {
    const uploadMedia = vi.fn().mockRejectedValueOnce(err).mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await useStore.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
  });

  it('honours a server’s wait only up to ten minutes', async () => {
    const uploadMedia = vi.fn().mockRejectedValueOnce(Object.assign(refusal(429, 'Slow down'), { retryAfter: 86_400 })).mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await useStore.getState().flushOutbox();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1000);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
  });
});

describe('Site Visits SV2: a sent photo is kept until the server lists it; queues stay whole (#792, #1008 round 2)', () => {
  const startOp = (): Extract<OutboxOp, { t: 'siteVisitStart' }> => ({
    t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
    visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
  });
  const fileOp = (visitId = 'v-1'): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId, scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });
  const serverFile = (clientKey: string) => ({
    mediaId: 'm-1', url: '/media/m-1', mime: 'image/png', clientKey, takenAt: null, note: null, rating: null, place: null,
    addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
  });

  it('shows a photo sent before the screen read the phone’s kept photos, when the server’s read then fails (Codex 4321998475)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await vi.waitFor(() => expect(screen.getByTestId('sv-photo-file-v-1')).toBeTruthy());
    // a photo the screen has not read from the phone yet (kept by another tab, or before this screen's read landed)
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    // it is sent, and the server's read after it fails
    gw.listSiteVisits!.mockRejectedValue(network());
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    // still shown, from the phone's own record of it, and not as waiting to send
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-c-1').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID'));
    expect(screen.getByTestId('sv-file-c-1').textContent).not.toContain('waiting to send');
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
    // the server's list shows it: the phone lets go of its copy
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [serverFile('c-1')] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1')).toBeTruthy());
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    expect(screen.queryByTestId('sv-file-c-1')).toBeNull();
  });

  it('keeps a sent photo’s row through a reload, and never sends it again', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const gw = fakeGateway([visit()], { uploadMedia });
    setUp('consultant', gw);
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    await useStore.getState().flushOutbox();
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
    // a reload before any Site Visits read: the row is still there to show, and is not put back to be sent
    setUp('consultant', gw);
    useStore.getState().hydrateOutbox();
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
  });

  it('keeps a command queued while a flush with a visit photo runs, when the project changes before it ends (Codex 4321998480)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const approveDecision = vi.fn(async () => { await held; return undefined; });
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const a: OutboxOp = { t: 'approve', decisionId: 'D-1', optionIndex: 0, idempotencyKey: 'k-a' };
    const b: OutboxOp = { t: 'approve', decisionId: 'D-2', optionIndex: 0, idempotencyKey: 'k-b' };
    setUp('consultant', fakeGateway([visit()], { uploadMedia, approveDecision }), [fileOp(), a]);
    const project = useStore.getState().activeProjectId;
    const lane = `vitan.outbox.dev:${CONSULTANT}.${project}`;
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), project, fileOp(), 'AQID');
    localStorage.setItem(lane, JSON.stringify([a]));
    const flushing = useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledTimes(1));
    // another command is stored meanwhile, then the person moves to another project before the flush ends
    localStorage.setItem(lane, JSON.stringify([a, b]));
    useStore.setState((st) => { st.activeProjectId = 'B'; st.projectScopeGeneration += 1; });
    release();
    await flushing;
    expect((JSON.parse(localStorage.getItem(lane) ?? '[]') as OutboxOp[]).map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual(['k-b']);
  });

  it('puts a kept photo’s start back ahead of it when only the photo is queued (Codex 4321998492)', async () => {
    const order: string[] = [];
    const startSiteVisit = vi.fn(async () => { order.push('start'); return visit({ id: 'v-tmp' }); });
    const uploadMedia = vi.fn(async () => { order.push('photo'); return { id: 'm-1', url: '/media/m-1' }; });
    // the photo was kept just after a flush settled its start, then queued alone
    setUp('consultant', fakeGateway([], { startSiteVisit, uploadMedia }), [fileOp('v-tmp')]);
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp('v-tmp'), 'AQID', startOp());
    await useStore.getState().flushOutbox();
    expect(order).toEqual(['start', 'photo']);
    // once the server took the start, the kept photo no longer carries it: it is not sent again
    expect((await rows()).map((r) => r.start ?? null)).toEqual([null]);
  });
});

/**
 * #1012's round 1 (head af14e65): a phone whose IndexedDB always fails held every site visit act for good; a server's
 * longer wait arriving after a retry was armed was not honoured; another tab's refusal could undo a confirmed upload.
 * Each test fails at af14e65.
 */
describe('Site Visits SV2: holds only what a kept photo needs, for as long as the server asks (#792, #1012 round 1)', () => {
  const fileOp = (): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['fails to open', () => { throw new Error('UnknownError'); }],
    ['never answers', () => ({}) as IDBOpenDBRequest],
  ])('sends a close on a phone whose database %s, when it never kept a visit photo here (Codex 4322430052)', async (_label, open) => {
    const closeSiteVisit = vi.fn(async () => visit({ status: 'closed', closeReason: 'Done' }));
    setUp('consultant', fakeGateway([visit()], { closeSiteVisit }));
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    localStorage.setItem(`vitan.siteVisitQueue.dev:${CONSULTANT}.${useStore.getState().activeProjectId}`, JSON.stringify([close]));
    vi.spyOn(indexedDB, 'open').mockImplementation(open);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useStore.getState().hydrateOutbox();
    const flushing = useStore.getState().flushOutbox();
    await vi.advanceTimersByTimeAsync(5000);
    await flushing;
    // no photo was ever kept on this phone for this project, so none can be waiting ahead of the close
    expect(closeSiteVisit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('adds nothing, and says why, when the phone cannot note that it keeps visit photos (Codex 4322430052)', async () => {
    const uploadMedia = vi.fn();
    await mount(fakeGateway([visit()], { uploadMedia }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo was not added: it could not be saved on this phone. Free some space on the phone, then add it again.'));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('sends a close after a photo was refused because the phone’s database would not open (Codex 4322430052)', async () => {
    const uploadMedia = vi.fn();
    const closeSiteVisit = vi.fn(async () => visit({ status: 'closed', closeReason: 'Done' }));
    await mount(fakeGateway([visit()], { uploadMedia, closeSiteVisit }));
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('UnknownError'); });
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo was not added: it could not be saved on this phone. Free some space on the phone, then add it again.'));
    // the refused photo left no mark, so nothing holds the visit's later acts
    expect(heldKeys()).toEqual([]);
    useStore.getState().queueSiteVisitAct({ t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' }, 'queued');
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(closeSiteVisit).toHaveBeenCalledTimes(1);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('holds a visit’s acts while the phone can read neither its photo keys nor its database, says so, and sends them on Send anyway (Codex 4323247780)', async () => {
    const closeSiteVisit = vi.fn(async () => visit({ status: 'closed', closeReason: 'Done' }));
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    // site storage blocked: the photo keys cannot be listed, and the database will not open. A photo kept on an earlier
    // page load may still be waiting on this visit
    const gw = fakeGateway([visit()], { closeSiteVisit });
    setUp('consultant', gw, [close]);
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    render(<SiteVisitsScreen />);
    // the close does not overtake it: it waits, and the visit says why
    expect(closeSiteVisit).not.toHaveBeenCalled();
    const held = await screen.findByTestId('sv-held-v-1');
    expect(held.textContent).toContain('this phone’s storage cannot be read right now');
    // the person chooses to send it anyway
    await act(async () => { fireEvent.click(within(held).getByRole('button', { name: 'Send anyway' })); });
    await vi.waitFor(() => expect(closeSiteVisit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByTestId('sv-held-v-1')).toBeNull());
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it.each([
    ['signing out', () => useStore.getState().completeSignOut()],
    ['switching project', () => { void useStore.getState().switchProject('other'); }],
  ])('forgets a Send anyway and a held visit on %s, so neither carries over to the next person or project', async (_label, leave) => {
    setUp('consultant', fakeGateway([visit()], { switchProject: vi.fn(() => new Promise(() => {})) }));
    useStore.setState({ siteVisitsHeld: { project: useStore.getState().activeProjectId, generation: useStore.getState().projectScopeGeneration, visits: ['v-1'] } });
    useStore.getState().sendSiteVisitAnyway('v-1');
    expect(useStore.getState().siteVisitsSentAnyway).toHaveLength(1);
    await act(async () => { leave(); });
    expect(useStore.getState().siteVisitsSentAnyway).toEqual([]);
    expect(useStore.getState().siteVisitsHeld).toBeNull();
  });

  it('moves an armed retry later when the server then asks for a longer wait, never sooner (Codex 4322430055)', async () => {
    const uploadMedia = vi.fn()
      .mockRejectedValueOnce(network())
      .mockRejectedValueOnce(Object.assign(refusal(429, 'Slow down'), { retryAfter: 60 }))
      .mockRejectedValueOnce(network())
      .mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await useStore.getState().flushOutbox(); // no answer: a retry is armed for 5 seconds
    await vi.advanceTimersByTimeAsync(1000);
    await useStore.getState().flushOutbox(); // the server asks for a minute
    await vi.advanceTimersByTimeAsync(1000);
    await useStore.getState().flushOutbox(); // no answer again: the minute stands
    expect(uploadMedia).toHaveBeenCalledTimes(3);
    // the minute counts from the server's answer, at 1 second: not at 5 seconds, nor before 61
    await vi.advanceTimersByTimeAsync(59_000 - 1);
    expect(uploadMedia).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(4));
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
  });

  it('never lets a refusal undo a confirmed upload, and a confirmed upload outranks a refusal (Codex 4322430064)', async () => {
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    // one tab's upload is confirmed, then another tab's send of the same photo is refused
    await putVisitPhoto(owner, project, fileOp(), 'AQID');
    await fileVisitPhoto(owner, project, 'c-1');
    await failVisitPhoto(owner, project, 'c-1', 'This site visit was closed by the PMC and takes no more files');
    expect((await rows()).map((r) => [r.state, r.reason])).toEqual([['filed', null]]);
    // the other way round: the refusal lands first, then the confirmation
    await act(async () => { await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); }); });
    await putVisitPhoto(owner, project, fileOp(), 'AQID');
    await failVisitPhoto(owner, project, 'c-1', 'Busy');
    await fileVisitPhoto(owner, project, 'c-1');
    expect((await rows()).map((r) => [r.state, r.reason])).toEqual([['filed', null]]);
  });
});

/**
 * #1012's round 2 (head 6e7e50a): its one mark per project, written before the row, stayed when the row's put failed;
 * with reads then failing, every visit act on the project was held for good. Each key now stands for one queued row and
 * names its visits. The first test fails at 6e7e50a; the rest show each way a key could outlive its row.
 */
describe('Site Visits SV2: a photo’s key never outlives its row, and holds only its visit (#792, #1012 round 2)', () => {
  const owner = () => visitPhotoScope(null, CONSULTANT);
  const project = () => useStore.getState().activeProjectId;
  const fileOp = (id = 'c-1', visitId = 'v-1'): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId, scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: `k-${id}`,
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id, mime: 'image/png' },
  });
  const closeOp = (visitId: string): OutboxOp => ({ t: 'siteVisitClose', visitId, reason: 'Done', idempotencyKey: `k-close-${visitId}` });
  /** the phone's database stops opening, and never opens again */
  const breakForGood = () => vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('UnknownError'); });
  const closes = () => vi.fn(async (id: string) => visit({ id, status: 'closed', closeReason: 'Done' }));
  afterEach(() => { vi.useRealTimers(); });

  it('sends a close when a photo’s save failed after the database opened, with every read failing after (Codex 4322700480)', async () => {
    const closeSiteVisit = closes();
    setUp('consultant', fakeGateway([visit()], { closeSiteVisit }));
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await expect(putVisitPhoto(owner(), project(), fileOp(), 'AQID')).rejects.toBeTruthy();
    expect(heldKeys()).toEqual([]);
    breakForGood();
    useStore.setState({ outbox: [closeOp('v-1')] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(closeSiteVisit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it.each([
    ['sent', async () => { await fileVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, 'c-1'); }],
    ['refused', async () => { await failVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, 'c-1', 'Closed'); }],
  ])('lets a photo’s key go once it is %s, so a close goes with every read failing after', async (_label, settle) => {
    const closeSiteVisit = closes();
    setUp('consultant', fakeGateway([visit()], { closeSiteVisit }));
    await putVisitPhoto(owner(), project(), fileOp(), 'AQID');
    expect(visitsHeldByPhotos(owner(), project())).toEqual(new Set(['v-1']));
    await settle();
    expect(heldKeys()).toEqual([]);
    breakForGood();
    useStore.setState({ outbox: [closeOp('v-1')] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(closeSiteVisit).toHaveBeenCalledTimes(1);
  });

  it('keeps one tab’s key when another tab’s save of a photo fails at the same time', async () => {
    const closeSiteVisit = closes();
    setUp('consultant', fakeGateway([visit(), visit({ id: 'v-2' })], { closeSiteVisit }));
    const realPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if ((value as { clientKey?: string }).clientKey === 'c-bad') throw new DOMException('full', 'QuotaExceededError');
      return realPut.call(this, value, key);
    });
    const [good, bad] = await Promise.allSettled([
      putVisitPhoto(owner(), project(), fileOp('c-good', 'v-1'), 'AQID'),
      putVisitPhoto(owner(), project(), fileOp('c-bad', 'v-1'), 'AQID'),
    ]);
    expect([good.status, bad.status]).toEqual(['fulfilled', 'rejected']);
    expect(heldKeys()).toEqual([`vitan.visitPhotoHeld.${owner()}.${project()}.c-good`]);
    // the database fails for good: the close of the kept photo's visit waits behind it; another visit's goes
    breakForGood();
    useStore.setState({ outbox: [closeOp('v-1'), closeOp('v-2')] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(closeSiteVisit.mock.calls.map((c) => c[0])).toEqual(['v-2']);
    expect(useStore.getState().outbox.map((o) => (o as { visitId: string }).visitId)).toEqual(['v-1']);
  });

  it.each([
    ['within its save', null],
    ['just after it was sent', 'filed'],
  ])('holds only its own visit when a page died %s, and lets the key go on the next read that works', async (_label, state) => {
    const closeSiteVisit = closes();
    setUp('consultant', fakeGateway([visit(), visit({ id: 'v-2' })], { closeSiteVisit }));
    if (state) {
      await putVisitPhoto(owner(), project(), fileOp('c-1', 'v-1'), 'AQID');
      await fileVisitPhoto(owner(), project(), 'c-1');
    }
    // the page died before the key could go: it is left with no queued row behind it
    localStorage.setItem(`vitan.visitPhotoHeld.${owner()}.${project()}.c-1`, JSON.stringify(['v-1']));
    let broken = true;
    const realOpen = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (broken) throw new Error('UnknownError');
      return realOpen(name, version);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useStore.setState({ outbox: [closeOp('v-1'), closeOp('v-2')] });
    await useStore.getState().flushOutbox();
    // while reads fail, however long, only that visit's acts wait
    expect(closeSiteVisit.mock.calls.map((c) => c[0])).toEqual(['v-2']);
    vi.useRealTimers();
    // a read that works finds no queued row for it: the key goes, and the close with it
    broken = false;
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(closeSiteVisit.mock.calls.map((c) => c[0])).toEqual(['v-2', 'v-1']);
    expect(heldKeys()).toEqual([]);
  });

  it.each([['the save first'], ['the read first']])('never lets a read take the key of a save it runs beside (%s)', async (first) => {
    setUp('consultant', fakeGateway([visit()]));
    const save = () => putVisitPhoto(owner(), project(), fileOp(), 'AQID');
    const read = () => listVisitPhotos(owner(), project());
    const [a, b] = first === 'the save first' ? [save(), read()] : [read(), save()];
    await Promise.all([a, b]);
    expect((await rows()).map((r) => r.state)).toEqual(['queued']);
    expect(heldKeys()).toEqual([`vitan.visitPhotoHeld.${owner()}.${project()}.c-1`]);
  });

  it('names both visits on a photo moved onto the visitor’s open visit', async () => {
    setUp('consultant', fakeGateway([visit()]));
    await putVisitPhoto(owner(), project(), fileOp('c-1', 'v-tmp'), 'AQID');
    await moveVisitPhotos(owner(), project(), 'v-tmp', 'v-1');
    expect(visitsHeldByPhotos(owner(), project())).toEqual(new Set(['v-tmp', 'v-1']));
    // a read that works finds the row still queued, and keeps its key
    await listVisitPhotos(owner(), project());
    expect(visitsHeldByPhotos(owner(), project())).toEqual(new Set(['v-tmp', 'v-1']));
  });

  it('holds every visit act when a key cannot be read for its visits', async () => {
    setUp('consultant', fakeGateway([visit()]));
    localStorage.setItem(`vitan.visitPhotoHeld.${owner()}.${project()}.c-1`, '{not json');
    expect(visitsHeldByPhotos(owner(), project())).toBe('all');
  });
});

/**
 * #1014's round 1 (head c8eb37f): an older server's answer settled filed photos it never listed, and a sent photo
 * vanished when the phone's database and the server both failed to read just after it was sent. Each test fails at
 * c8eb37f. (Its other two findings are tested beside their own code: the held-visit note in "#1012 round 1" above, and
 * the link refresh in site-visits-photos.test.tsx.)
 */
describe('Site Visits SV2: a sent photo stays until a read that can speak for it (#792, #1014 round 1)', () => {
  const fileOp = (): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: 'k-f',
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' },
  });
  const serverFile = (clientKey: string) => ({
    mediaId: 'm-1', url: '/media/m-1', mime: 'image/png', clientKey, takenAt: null, note: null, rating: null, place: null,
    addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
  });
  /** a visit as an API from before SV2 answers it: no `files` at all */
  const olderApi = (): SiteVisit => { const { files: _files, ...v } = visit(); return v as SiteVisit; };

  it('keeps a sent photo when an older server answers without files, and settles it once a read lists it (Codex 4323247753)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const gw = fakeGateway([olderApi()], { uploadMedia });
    gw.listSiteVisits!.mockImplementation(async () => [olderApi()]);
    await mount(gw);
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    // the older server answers, and says nothing of the photo: it stays on the phone, and on the screen
    await act(async () => { refreshSiteVisits(); });
    await act(async () => {});
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-c-1').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID'));
    // a read that lists it settles it
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [serverFile('c-1')] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
    expect(screen.getByTestId('sv-file-m-1')).toBeTruthy();
  });

  it('keeps a sent photo when a read sent before it was filed answers after, covering its visit without it', async () => {
    let filed = false;
    let online = false;
    const uploadMedia = vi.fn(async () => { if (!online) throw network(); filed = true; return { id: 'm-1', url: '/media/m-1' }; });
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    // a read goes out before the upload, and its answer is slow; every read after the upload fails
    const early: (() => void)[] = [];
    gw.listSiteVisits!.mockImplementation(() => (filed
      ? Promise.reject(network())
      : new Promise<SiteVisit[]>((done) => { early.push(() => done([visit({ files: [] })])); })));
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(early.length).toBeGreaterThanOrEqual(2));
    online = true;
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(async () => expect((await rows()).map((r) => r.state)).toEqual(['filed']));
    expect(filed).toBe(true);
    // the early read answers now: it covers the visit, with files, but was sent before the photo was filed
    await act(async () => { for (const answer of early) answer(); });
    await act(async () => {});
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
  });

  it('settles a filed photo on a read that covers its visit only when that read was sent after it was filed', async () => {
    setUp('consultant', fakeGateway([visit()]));
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    const before = Date.now() - 1;
    await putVisitPhoto(owner, project, fileOp(), 'AQID');
    await fileVisitPhoto(owner, project, 'c-1');
    // sent before it was filed: covering its visit with files, not listing it, says nothing of it
    await settleFiledVisitPhotos(owner, project, before, new Set(), new Set(), new Set(['v-1']));
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
    // nor does one sent after, that neither lists it nor covers its visit
    await settleFiledVisitPhotos(owner, project, Date.now() + 1, new Set(), new Set(), new Set(['v-2']));
    expect((await rows()).map((r) => r.state)).toEqual(['filed']);
    // one sent after, covering its visit, does
    await settleFiledVisitPhotos(owner, project, Date.now() + 1, new Set(), new Set(), new Set(['v-1']));
    expect(await rows()).toEqual([]);
  });

  it('lets a sent photo go when a read of its visit with its files no longer holds it', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    const gw = fakeGateway([visit()], { uploadMedia });
    gw.listSiteVisits!.mockImplementation(async () => [olderApi()]);
    await mount(gw);
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp(), 'AQID');
    await act(async () => { await useStore.getState().flushOutbox(); });
    // the server read the visit with its files, and the photo is not among them (removed since)
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
  });

  it('keeps a sent photo on screen when the phone’s database and the server both fail to read just after it was sent (Codex 4323247762)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('waiting to send'));
    // the upload goes through; just then the phone's database can no longer list its rows, and the server's read fails
    let broken = false;
    const realCursor = IDBObjectStore.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['openCursor']>) {
      if (broken) throw new DOMException('broken', 'UnknownError');
      return realCursor.apply(this, args);
    });
    uploadMedia.mockImplementation(async () => {
      broken = true;
      gw.listSiteVisits!.mockRejectedValue(network());
      return { id: 'm-9', url: '/media/m-9' };
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    await act(async () => {});
    // still shown from the phone's own copy, and not as waiting to send
    expect(screen.getByTestId(`sv-file-${key}`).querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect(screen.getByTestId(`sv-file-${key}`).textContent).not.toContain('waiting to send');
  });
});

/**
 * #1014's round 2 (head 85f29a1): a replayed act told the screen its photo was sent whenever its row was not queued,
 * a refused one included, and the screen upgraded the row to sent; a photo put back from its row went after any photo
 * already queued, taken later or not. Each test fails at 85f29a1.
 */
describe('Site Visits SV2: a photo is shown in the state its row holds, and sent in the order taken (#792, #1014 round 2)', () => {
  const fileOp = (key: string): Extract<OutboxOp, { t: 'siteVisitAddFile' }> => ({
    t: 'siteVisitAddFile', visitId: 'v-1', scope: visitPhotoScope(null, CONSULTANT), idempotencyKey: `k-${key}`,
    by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: key, mime: 'image/png' },
  });
  const CLOSED = 'This site visit was closed by the PMC and takes no more files';

  it('shows a photo another tab saw refused as not sent when this tab replays its old act, and sends nothing (r4323657302)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('waiting to send'));
    // another tab sends the same photo and the server refuses it: the row is failed there, while this tab still holds
    // the act it queued
    await failVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, key, CLOSED);
    // and from now on this tab cannot list the phone's rows: the screen has only what it is told
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(() => { throw new DOMException('broken', 'UnknownError'); });
    uploadMedia.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    await act(async () => {});
    // not sent again, never shown as sent: listed as not sent, with the server's words
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId(`sv-not-sent-${key}`).textContent).toContain(`This was not saved. ${CLOSED}`);
    expect(screen.queryByTestId(`sv-file-${key}`)).toBeNull();
    vi.restoreAllMocks();
    expect((await rows()).map((r) => [r.state, r.reason])).toEqual([['failed', CLOSED]]);
  });

  it('sends a photo put back from its row before a photo taken after it that another tab queued (r4323657318)', async () => {
    const order: string[] = [];
    const uploadMedia = vi.fn(async (b: { clientKey: string }) => { order.push(b.clientKey); return { id: `m-${b.clientKey}`, url: `/media/${b.clientKey}` }; });
    setUp('consultant', fakeGateway([visit()], { uploadMedia }));
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    // P1 was taken first, in a tab since closed: only its row is left. P2, taken after, is queued in this tab
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 60_000);
    await putVisitPhoto(owner, project, fileOp('p-1'), 'AQID');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await putVisitPhoto(owner, project, fileOp('p-2'), 'AQID');
    vi.restoreAllMocks();
    useStore.setState({ outbox: [fileOp('p-2')] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(() => expect(order).toEqual(['p-1', 'p-2']));
  });

  it('puts a restored photo after its own visit’s start, and before that visit’s later acts, whatever was taken after it', async () => {
    const order: string[] = [];
    const uploadMedia = vi.fn(async (b: { clientKey: string }) => { order.push(`photo ${b.clientKey}`); return { id: 'm', url: '/media/m' }; });
    const startSiteVisit = vi.fn(async () => { order.push('start'); return visit(); });
    const closeSiteVisit = vi.fn(async () => { order.push('close'); return visit({ status: 'closed', closeReason: 'Done' }); });
    setUp('consultant', fakeGateway([visit()], { uploadMedia, startSiteVisit, closeSiteVisit }));
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    const start = { t: 'siteVisitStart', body: { id: 'v-1' }, idempotencyKey: 'k-s' } as unknown as OutboxOp;
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    // a photo taken after the restored one, on another visit, sits ahead of this visit's start
    const other = { ...fileOp('p-2'), visitId: 'v-2' };
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 60_000);
    await putVisitPhoto(owner, project, fileOp('p-1'), 'AQID');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await putVisitPhoto(owner, project, other, 'AQID');
    vi.restoreAllMocks();
    useStore.setState({ outbox: [other, start, close] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(() => expect(order).toEqual(['photo p-2', 'start', 'photo p-1', 'close']));
  });

  it('puts a restored photo after the queued act adding the place it was taken at (coordinator, sv2-unit-h)', async () => {
    const order: string[] = [];
    const uploadMedia = vi.fn(async () => { order.push('photo'); return { id: 'm', url: '/media/m' }; });
    const addSiteVisitPlace = vi.fn(async () => { order.push('place'); return visit(); });
    setUp('consultant', fakeGateway([visit()], { uploadMedia, addSiteVisitPlace }));
    // offline: place X is added, then a photo is taken at X; a reload leaves the place act stored and the photo's row
    const place: OutboxOp = { t: 'siteVisitAddPlace', visitId: 'v-1', body: { id: 'p-x', nodeId: 'n-x', claimedAt: '2026-10-14T04:40:00.000Z' }, name: 'Kitchen', idempotencyKey: 'k-p' };
    const taken = { ...fileOp('p-1'), file: { id: 'p-1', mime: 'image/png', nodeId: 'n-x' } };
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, taken, 'AQID');
    useStore.setState({ outbox: [place] });
    await act(async () => { await useStore.getState().flushOutbox(); });
    await vi.waitFor(() => expect(order).toEqual(['place', 'photo']));
  });

  it('holds a photo whose row cannot be read even on Send anyway, and sends the visit’s close and other visits’ acts (coordinator, sv2-unit-h)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    const closeSiteVisit = vi.fn(async () => visit({ status: 'closed', closeReason: 'Done' }));
    const endSiteVisit = vi.fn(async () => visit({ id: 'v-2', status: 'ended' }));
    const gw = fakeGateway([visit()], { uploadMedia, closeSiteVisit, endSiteVisit });
    await mount(gw);
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const photoKey = queuedFile()!.idempotencyKey;
    // a close of this visit and an end of another, queued after the photo; then the phone's database stops opening
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    const end = { t: 'siteVisitEnd', visitId: 'v-2', claimedAt: '2026-10-14T05:00:00.000Z', idempotencyKey: 'k-e' } as OutboxOp;
    useStore.setState({ outbox: [...useStore.getState().outbox, close, end] });
    uploadMedia.mockClear();
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('broken', 'UnknownError'); });
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(closeSiteVisit).not.toHaveBeenCalled();
    const held = await screen.findByTestId('sv-held-v-1');
    // Send anyway: the close goes; the photo, which can only be sent from its row, stays queued
    await act(async () => { fireEvent.click(within(held).getByRole('button', { name: 'Send anyway' })); });
    await vi.waitFor(() => expect(closeSiteVisit).toHaveBeenCalledTimes(1));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox.map((o) => ('idempotencyKey' in o ? o.idempotencyKey : o.t))).toEqual([photoKey]);
  });

  it('holds a photo whose row never answers while it is sent, sends the rest, and lets the next send run (coordinator, sv2-unit-h)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm', url: '/media/m' }));
    const closeSiteVisit = vi.fn(async () => visit({ status: 'closed', closeReason: 'Done' }));
    const endSiteVisit = vi.fn(async () => visit({ id: 'v-2', status: 'ended' }));
    setUp('consultant', fakeGateway([visit()], { uploadMedia, closeSiteVisit, endSiteVisit }));
    await putVisitPhoto(visitPhotoScope(null, CONSULTANT), useStore.getState().activeProjectId, fileOp('p-1'), 'AQID');
    const close: OutboxOp = { t: 'siteVisitClose', visitId: 'v-1', reason: 'Done', idempotencyKey: 'k-c' };
    const end = { t: 'siteVisitEnd', visitId: 'v-2', claimedAt: '2026-10-14T05:00:00.000Z', idempotencyKey: 'k-e' } as OutboxOp;
    useStore.setState({ outbox: [fileOp('p-1'), close, end] });
    // the flush's own read of the rows works; the photo's own read, as it is sent, never answers
    const real = indexedDB.open.bind(indexedDB);
    let opens = 0;
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      opens += 1;
      return opens === 1 ? real(name, version) : ({} as IDBOpenDBRequest);
    });
    const first = await useStore.getState().flushOutbox();
    expect(first.ran).toBe(true);
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(uploadMedia).not.toHaveBeenCalled();
    // the close waits behind its photo, and the next send is not locked out
    expect(closeSiteVisit).not.toHaveBeenCalled();
    expect(useStore.getState().outbox.map((o) => ('idempotencyKey' in o ? o.idempotencyKey : o.t))).toEqual(['k-p-1', 'k-c']);
    expect(useStore.getState().siteVisitsHeld?.visits).toEqual(['v-1']);
    vi.restoreAllMocks();
    const next = await useStore.getState().flushOutbox();
    expect(next.ran).toBe(true);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(closeSiteVisit).toHaveBeenCalledTimes(1);
  }, 20_000);
});

/**
 * #1017's round 1 (head 14d62f8): two writes of the phone's record had no bound: the flush's clearing of a started
 * visit's start from its photos, and a new photo's first save. A database that never answered held the flush's lock, or
 * the photo controls, for the rest of the page load. Each test fails at 14d62f8.
 */
describe('Site Visits SV2: every write of a kept photo is bounded (#792, #1017 round 1)', () => {
  /** opens of the phone's database wait while `held` is true, and run when let go (a slow or stuck database) */
  const stallOpens = () => {
    const real = indexedDB.open.bind(indexedDB);
    const waiting: (() => void)[] = [];
    const ctl = { held: true, opens: 0, letGo: () => { ctl.held = false; for (const run of waiting.splice(0)) run(); } };
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      ctl.opens += 1;
      if (!ctl.held) return real(name, version);
      let inner: IDBOpenDBRequest | null = null;
      const outer = {
        onsuccess: null as ((e: Event) => void) | null, onerror: null as ((e: Event) => void) | null,
        onupgradeneeded: null as ((e: Event) => void) | null,
        get result() { return inner!.result; }, get error() { return inner!.error; },
      };
      waiting.push(() => {
        inner = real(name, version);
        inner.onupgradeneeded = (e) => outer.onupgradeneeded?.(e);
        inner.onsuccess = (e) => outer.onsuccess?.(e);
        inner.onerror = (e) => outer.onerror?.(e);
      });
      return outer as unknown as IDBOpenDBRequest;
    });
    return ctl;
  };

  it('gives the controls back and says the photo was not kept when its save never answers, and never sends it after (Codex 4324453905)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    await mount(fakeGateway([visit()], { uploadMedia }));
    const ctl = stallOpens();
    await act(async () => { fireEvent.change(screen.getByTestId('sv-photo-file-v-1'), { target: { files: [photo()] } }); });
    // the save is stuck: the controls wait, then come back with the reason
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('This photo was not added'), { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Add photo' }).hasAttribute('disabled')).toBe(false);
    // the database answers late: the save it was asked for does not land, so nothing is kept or sent behind the person
    ctl.letGo();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(await rows()).toEqual([]);
    expect(heldKeys()).toEqual([]);
    await act(async () => { await useStore.getState().flushOutbox(); });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(queuedFile()).toBeUndefined();
  }, 20_000);

  it('gives the controls back as unconfirmed when the phone never says whether the save or its stop won, and keeps a save that lands late (Codex 4324453905)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(network());
    await mount(fakeGateway([visit()], { uploadMedia }));
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
        get: (target, prop) => {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    });
    await act(async () => { fireEvent.change(screen.getByTestId('sv-photo-file-v-1'), { target: { files: [photo()] } }); });
    // the controls come back, saying the photo may not have been saved: never that it definitely was not
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('This photo may not have been saved'), { timeout: 9000 });
    expect(screen.getByRole('button', { name: 'Add photo' }).hasAttribute('disabled')).toBe(false);
    expect(queuedFile()).toBeUndefined();
    // the phone reports the save after all: the photo is kept, queued and shown from its row, waiting to send
    vi.mocked(IDBDatabase.prototype.transaction).mockRestore();
    await act(async () => { for (const end of held.splice(0)) end(); });
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const key = queuedFile()!.file.id;
    expect((await rows()).map((r) => [r.clientKey, r.state])).toEqual([[key, 'queued']]);
    await vi.waitFor(() => expect(screen.getByTestId(`sv-file-${key}`).textContent).toContain('waiting to send'));
  }, 20_000);

  it('lets a flush go on when clearing a started visit’s start from its photos never answers, and clears it on the next (Codex 4324453897)', async () => {
    const startSiteVisit = vi.fn(async (_body: unknown, _key?: string) => visit({ id: 'v-tmp' }));
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    setUp('consultant', fakeGateway([], { startSiteVisit, uploadMedia }));
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    const start: OutboxOp = { t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' }, visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null } } as OutboxOp;
    const photoOp = { t: 'siteVisitAddFile', visitId: 'v-tmp', scope: owner, idempotencyKey: 'k-f', by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' } } as Extract<OutboxOp, { t: 'siteVisitAddFile' }>;
    await putVisitPhoto(owner, project, photoOp, 'AQID', start as Extract<OutboxOp, { t: 'siteVisitStart' }>);
    useStore.setState({ outbox: [start, photoOp] });
    // the flush's read of the rows answers; the clearing write after the start, and every open after it, stalls
    const real = indexedDB.open.bind(indexedDB);
    let opens = 0;
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      opens += 1;
      return opens === 1 ? real(name, version) : ({} as IDBOpenDBRequest);
    });
    const first = await useStore.getState().flushOutbox();
    expect(first.ran).toBe(true);
    expect(startSiteVisit).toHaveBeenCalledTimes(1);
    // the lock is let go: the next send runs and sends the photo
    vi.restoreAllMocks();
    void useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1), { timeout: 8000 });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    // and the start the rows still carried was sent again under its own key (the server answers that replay with the
    // same visit) and cleared
    expect(startSiteVisit.mock.calls.map((c) => c[1])).toEqual(['k-s', 'k-s']);
    expect((await rows()).map((r) => [r.state, r.start])).toEqual([['filed', null]]);
  }, 30_000);
});

/**
 * #1017's round 2 (head 233db0c): a refused start's photos were moved or marked with no bound, so a database that never
 * answered held the flush's lock for the rest of the page load. Every call on the phone's record is now bounded (the
 * body lists each). The test fails at 233db0c.
 */
describe('Site Visits SV2: a refused start never holds the queue on the phone’s record (#792, #1017 round 2)', () => {
  it('stops at a refused start whose photos cannot be marked in time, then marks them once when it is refused again (Codex 4324836535)', async () => {
    const CANNOT = 'You cannot start a site visit on this project';
    const startSiteVisit = vi.fn().mockRejectedValue(refusal(403, CANNOT));
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    setUp('consultant', fakeGateway([], { startSiteVisit, uploadMedia }));
    const owner = visitPhotoScope(null, CONSULTANT);
    const project = useStore.getState().activeProjectId;
    const start = { t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' }, visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null } } as Extract<OutboxOp, { t: 'siteVisitStart' }>;
    const photoOp = { t: 'siteVisitAddFile', visitId: 'v-tmp', scope: owner, idempotencyKey: 'k-f', by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id: 'c-1', mime: 'image/png' } } as Extract<OutboxOp, { t: 'siteVisitAddFile' }>;
    await putVisitPhoto(owner, project, photoOp, 'AQID', start);
    useStore.setState({ outbox: [start, photoOp] });
    // the flush's read of the rows answers; the marking of the refused start's photos waits (a stuck database)
    const real = indexedDB.open.bind(indexedDB);
    const stalled: (() => void)[] = [];
    let opens = 0;
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      opens += 1;
      if (opens === 1) return real(name, version);
      let inner: IDBOpenDBRequest | null = null;
      const outer = {
        onsuccess: null as ((e: Event) => void) | null, onerror: null as ((e: Event) => void) | null, onupgradeneeded: null as ((e: Event) => void) | null,
        get result() { return inner!.result; }, get error() { return inner!.error; },
      };
      stalled.push(() => {
        inner = real(name, version);
        inner.onupgradeneeded = (e) => outer.onupgradeneeded?.(e);
        inner.onsuccess = (e) => outer.onsuccess?.(e);
        inner.onerror = (e) => outer.onerror?.(e);
      });
      return outer as unknown as IDBOpenDBRequest;
    });
    const first = await useStore.getState().flushOutbox();
    // the flush ends, and lets go of its lock, with the start and its photo still queued
    expect(first.ran).toBe(true);
    expect(startSiteVisit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox.map((o) => ('idempotencyKey' in o ? o.idempotencyKey : o.t))).toEqual(['k-s', 'k-f']);
    // the mark lands late, after all
    vi.restoreAllMocks();
    await act(async () => { for (const go of stalled.splice(0)) go(); await new Promise((r) => setTimeout(r, 100)); });
    expect((await rows()).map((r) => [r.state, r.reason])).toEqual([['failed', CANNOT]]);
    // the next send is refused the same way: nothing is left to mark twice, the photo is not sent, and the queue empties
    void useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0), { timeout: 8000 });
    expect(startSiteVisit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect((await rows()).map((r) => [r.state, r.reason])).toEqual([['failed', CANNOT]]);
  }, 30_000);

  it('moves or marks a refused start’s photos once, however often the refusal is settled again', async () => {
    const owner = visitPhotoScope(null, CONSULTANT);
    setUp('consultant', fakeGateway([]));
    const project = useStore.getState().activeProjectId;
    const photoOp = (id: string, visitId: string) => ({ t: 'siteVisitAddFile', visitId, scope: owner, idempotencyKey: `k-${id}`, by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, file: { id, mime: 'image/png' } }) as Extract<OutboxOp, { t: 'siteVisitAddFile' }>;
    await putVisitPhoto(owner, project, photoOp('p-1', 'v-a'), 'AQID');
    await putVisitPhoto(owner, project, photoOp('p-2', 'v-b'), 'AQID');
    await moveVisitPhotos(owner, project, 'v-a', 'v-open');
    await moveVisitPhotos(owner, project, 'v-a', 'v-open');
    expect(await failVisitPhotosOn(owner, project, 'v-b', 'No')).toEqual(['p-2']);
    expect(await failVisitPhotosOn(owner, project, 'v-b', 'No')).toEqual([]);
    expect((await rows()).map((r) => [r.clientKey, r.op.visitId, r.state]).sort()).toEqual([['p-1', 'v-open', 'queued'], ['p-2', 'v-b', 'failed']]);
  });
});

describe('Site Visits SV2: each test starts with no send left running from the one before', () => {
  // A test that ends with a send still running hands it to the next test: the store and its flush lock outlive a test,
  // so the next test's sends are coalesced into it (its own `flushOutbox()` returns at once, sending nothing) and that
  // send's put-back can read the next test's rows. Under load this failed Codex 4319124653 and 4319124642 now and then;
  // here the send is held on a barrier that only the wait in `afterEach` lets go, and the test sees it in flight before
  // it ends, so the pair fails every time without that wait, however loaded the machine is.
  const end = (key: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: key });

  it('ends with a send still running (the test before)', async () => {
    const endSiteVisit = vi.fn(() => new Promise((done) => { heldSend = () => done(visit({ status: 'ended' })); }));
    setUp('consultant', fakeGateway([visit()], { endSiteVisit }), [end('k-first')]);
    void useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(endSiteVisit).toHaveBeenCalledTimes(1));
    expect(useStore.getState()._outboxFlushing()).toBe(true);
  });

  it('sends its own queue when it asks, never folded into a send left from the test before', async () => {
    const endSiteVisit = vi.fn(async () => visit({ status: 'ended' }));
    setUp('consultant', fakeGateway([visit()], { endSiteVisit }), [end('k-second')]);
    const result = await useStore.getState().flushOutbox();
    expect(result.ran).toBe(true);
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toHaveLength(0);
  });
});
