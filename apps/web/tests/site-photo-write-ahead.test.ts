import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { queuedSitePhotos, uploadQueued } from '@/lib/queuedSitePhotos';
import { warmImports } from './warm-imports';
import { settled, startWork } from './site-visit-work';
import { queueWritten, storedQueue } from './queueWrites';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/data/sitePhotoStore'), () => import('@/store/queueLedger'));

/**
 * #917 — a site photo sent online is kept on this phone before its upload, so an upload whose answer is lost is sent
 * again from that copy under the same key, and the server stores one photo instead of a second one from a fresh pick.
 * Every wait is on a signal: a store state reached (`until`, a store subscription), a server call made (a deferred the
 * mock resolves), or every database call, flush and turn having ended (`settled()`). A database read opened after a
 * write was asked for is answered after it (IndexedDB runs them in order). Each test starts with a fresh database.
 */
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const snap = {
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
};
const lost = () => new TypeError('Failed to fetch');
const SAVED = 'Photo saved offline — will upload when signal returns.';
const TRY_AGAIN = 'Could not upload the photo — please try again.';
const DISCARDED = '1 could not be applied and was discarded.';
// rows are kept under the signed-in user's id; with no session that is 'anon'
const ROWS = 'anon';

type Store = Awaited<ReturnType<typeof tab>>;
type Rows = typeof import('@/data/sitePhotoStore');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/** Resolves once the store's state meets `pred`, now or on a later change. */
const until = (store: Store, pred: (s: ReturnType<Store['getState']>) => boolean) => new Promise<void>((done) => {
  if (pred(store.getState())) { done(); return; }
  const off = store.subscribe((s) => { if (pred(s)) { off(); done(); } });
});

/** An upload mock that says when it is called, and answers each call as the test says. */
function uploads() {
  const calls: Array<{ input: { clientKey: string }; answer: ReturnType<typeof deferred<{ id: string; url: string }>> }> = [];
  const waiting: Array<{ n: number; done: () => void }> = [];
  const fn = vi.fn((input: { clientKey: string }) => {
    const answer = deferred<{ id: string; url: string }>();
    calls.push({ input, answer });
    for (const w of waiting.filter((x) => calls.length >= x.n)) { waiting.splice(waiting.indexOf(w), 1); w.done(); }
    return answer.promise;
  });
  const called = (n = 1) => new Promise<void>((done) => { if (calls.length >= n) done(); else waiting.push({ n, done }); });
  return { fn, calls, called };
}

/** One tab: its own store (and its own copy of the row store), over this test's database and storage. */
async function tab() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', online: true, lang: 'en' } as never);
  return useStore;
}
/** The row store the last tab loaded. */
const rowsOf = (): Promise<Rows> => import('@/data/sitePhotoStore');

const storedOutboxes = (): string[] => Object.keys(localStorage).filter((k) => k.startsWith('vitan.outbox')).map((k) => localStorage.getItem(k) ?? '');

beforeEach(() => {
  // a fresh phone database for every test: nothing one test leaves is read by the next
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

afterEach(async () => {
  (await rowsOf()).setSitePhotoDeadline(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('an online site photo whose answer is lost (#917)', () => {
  it('is queued by its key, said to be saved on this phone, and sent again from its copy under the same key', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
    // shown from this phone's copy, as an offline pick is
    expect(A.getState().sitePhotosKept.map((p) => p.clientKey)).toEqual([key]);
    const rows = await rowsOf();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', key)).toMatchObject({ input: { clientKey: key } });
    const flushed = A.getState().flushOutbox();
    await up.called(2);
    expect(up.calls[1]!.input).toEqual(up.calls[0]!.input);
    up.calls[1]!.answer.resolve({ id: 'm1', url: '/media/m1' });
    await flushed;
    expect(A.getState().outbox).toEqual([]);
    // the server took it: the bytes are gone, and a marker says so
    const after = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(after && rows.isSitePhotoSent(after)).toBe(true);
  });

  it('its op is never written to the stored outbox, and after a reload it comes back from its copy', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    // a release that knows no such kind (or one before #917) never reads one
    expect(storedOutboxes().join('')).not.toContain('uploadSitePhoto');
    // the page is loaded again, offline: the queue is read from storage and the row
    const B = await tab();
    B.setState({ online: false } as never);
    startWork(B as never);
    B.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    B.getState().hydrateOutbox();
    await until(B, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto' && o.clientKey === key));
    expect(B.getState().sitePhotosKept.map((p) => p.clientKey)).toEqual([key]);
  });

  it('after the person moved to another project, still says it is kept, keeps it, and sends it once they are back', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    A.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2 } as never);
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    await settled();
    expect(A.getState().outbox).toEqual([]);
    expect(await (await rowsOf()).getSitePhotoRow(ROWS, 'villa-b', key)).toMatchObject({ input: { clientKey: key } });
    // back on that project: its next flush gives the row its op, and sends it under the same key
    A.setState({ activeProjectId: 'villa-b', projectScopeGeneration: 3 } as never);
    void A.getState().flushOutbox();
    await up.called(2);
    expect(up.calls[1]!.input).toEqual(up.calls[0]!.input);
  });

  it('shows on the Dashboard from its copy while its send is queued, and not once the server holds it', () => {
    const outbox = [{ t: 'uploadSitePhoto' as const, scope: ROWS, clientKey: 'k1' }];
    const kept = [{ clientKey: 'k1', mime: 'image/png', data: 'AAAA', nodeId: 'n1' }];
    expect(queuedSitePhotos(outbox, [], kept)).toEqual([{ id: 'queued-k1', url: 'data:image/png;base64,AAAA', kind: 'progress', nodeId: 'n1' }]);
    expect(queuedSitePhotos(outbox, [{ id: 'm1', url: '/media/m1', kind: 'progress', clientKey: 'k1' }], kept)).toEqual([]);
    expect(queuedSitePhotos([], [], kept)).toEqual([]);
  });

  it('a Delete of it waits while its send is queued', () => {
    expect(uploadQueued([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k1' }], 'k1')).toBe(true);
    expect(uploadQueued([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k1' }], 'k2')).toBe(false);
  });
});

describe('an online site photo the server answers (#917)', () => {
  it('a yes leaves a marker in place of its copy and queues nothing', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    up.calls[0]!.answer.resolve({ id: 'm2', url: '/media/m2' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    const rows = await rowsOf();
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', up.calls[0]!.input.clientKey);
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a refusal lets its copy go and says to try again, as before', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    up.calls[0]!.answer.reject(Object.assign(new Error('too large'), { status: 413 }));
    await until(A, (s) => s.toast === TRY_AGAIN);
    expect(await (await rowsOf()).getSitePhotoRow(ROWS, 'villa-b', up.calls[0]!.input.clientKey)).toBeNull();
    expect(A.getState().outbox).toEqual([]);
  });

});


// this tab's own claim on its send: the row's Web Lock, and, in a browser without Web Locks, the tab's own record
describe.each([['with', true], ['without', false]])('this tab\'s own unanswered send, in a browser %s Web Locks (#917)', (_label, withLocks) => {
  const setup = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  beforeEach(() => { if (!withLocks) Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true }); });
  afterEach(() => { if (setup) Object.defineProperty(globalThis.navigator, 'locks', setup); });

  it('a flush while its send is unanswered gives its copy no op, so it is sent once', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([]);
    expect(up.fn).toHaveBeenCalledTimes(1);
    up.calls[0]!.answer.resolve({ id: 'm3', url: '/media/m3' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
  });

  it('a copy read before the yes and answered after it is not given an op: the send stays this tab\'s until its marker is written', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    // the phone's database is busy: the flush's read of the copies waits, and the marker after the yes waits behind it
    const busy = await holdDatabase();
    void A.getState().flushOutbox();
    // the flush's read of the copies is asked for (it waits behind the busy database) before the yes comes
    await busy.readAsked;
    up.calls[0]!.answer.resolve({ id: 'm4', url: '/media/m4' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    busy.release();
    await settled();
    expect(A.getState().outbox).toEqual([]);
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().toast).toMatch(/uploaded/);
  });
});

describe('a phone that cannot keep the photo (#917)', () => {
  it('sends it as before, and a lost answer still says to try again: nothing is claimed as saved', async () => {
    const A = await tab();
    startWork(A as never);
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('quota'); });
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === TRY_AGAIN);
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a database that never answers is given up at its bound: sent as before, and a lost answer says to try again', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    const bound = deferred<() => void>();
    rows.setSitePhotoDeadline((fire) => { bound.resolve(fire); return () => {}; });
    // an open whose request never answers
    vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    (await bound.promise)();
    await up.called();
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === TRY_AGAIN);
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a write whose bound passed before the database opened is never made', async () => {
    await tab();
    const rows = await rowsOf();
    // the bound passes at once, before the open is answered
    rows.setSitePhotoDeadline((fire) => { fire(); return () => {}; });
    await expect(rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-late' })).rejects.toBeInstanceOf(rows.SitePhotoUnreadable);
    rows.setSitePhotoDeadline(null);
    await settled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-late')).toBeNull();
  });

  it('a write whose bound passes while its transaction is running is aborted: it rejects and no row is left', async () => {
    await tab();
    const rows = await rowsOf();
    const hold = await holdDatabase();
    const bound = deferred<() => void>();
    rows.setSitePhotoDeadline((fire) => { bound.resolve(fire); return () => {}; });
    const put = rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-mid' });
    const outcome = put.then(() => null, (e: unknown) => e);
    // its transaction is made (waiting behind the hold) when the bound passes
    await hold.writeAsked;
    (await bound.promise)();
    await hold.release();
    expect(await outcome).toBeInstanceOf(rows.SitePhotoUnreadable);
    rows.setSitePhotoDeadline(null);
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-mid')).toBeNull();
  });
});

describe('a queued site photo sent from its copy (#917)', () => {
  it('whose copy is gone (another tab settled it) is not sent and is dropped quietly: counted neither sent nor discarded', async () => {
    const A = await tab();
    startWork(A as never);
    const uploadMedia = vi.fn();
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-no-row' }] } as never);
    await A.getState().flushOutbox();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast ?? '').not.toMatch(/discarded|synced/);
  });

  it('answered 410 (deleted since an earlier send landed) lets its copy go quietly', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-410' });
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' }));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-410' }] } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-410')).toBeNull();
    expect(A.getState().toast ?? '').not.toContain('discarded');
  });

  it('answered 410 with its refresh failed asks for one at once, as a queued photo answered 410 does (#482)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-410r' });
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' }));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-410r' }] } as never);
    await A.getState().flushOutbox();
    // settled by the 410 alone, and the read it owes is asked for at once, not left for the next write
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().commandReconcilePending).toBe(true);
  });

  it('a copy sent from its row writes no settled mark or done fact, even for a moment: no queue key holds its op', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-mark' });
    // every name written during the flush: a mark written and tidied by the end write would leave nothing at the end
    const written: string[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { written.push(k); return setItem.call(this, k, v); });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-1', url: '/media/m-1' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-mark' }] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
    expect(written.filter((k) => k.startsWith('vitan.settled.') || k.startsWith('vitan.done.'))).toEqual([]);
  });

  it('refused (403) with its row unable to be marked keeps its op, says nothing discarded, and keeps its copy', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-p5' });
    // the database fails from the moment the server has answered: the marker the refusal owes cannot be written
    const uploadMedia = vi.fn(async () => {
      vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('broken'); });
      throw Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' });
    });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-p5' }] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-p5' }]);
    expect(A.getState().toast ?? '').not.toContain('discarded');
    vi.restoreAllMocks();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-p5')).toMatchObject({ input: { clientKey: 'k-p5' } });
  });

  it('answered 410 after a lost answer takes its local copies off screen, as a queued photo answered 410 does (#482)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 0, photoCount: 0, myPhotoKeys: [], crew: [], materials: [], photos: [] } } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    const key = (A.getState().outbox[0] as { clientKey: string }).clientKey;
    // the gallery's copy carries its key, as an offline pick's does
    expect(A.getState().dailyLog!.photos.some((p) => (p as { clientKey?: string }).clientKey === key)).toBe(true);
    // an earlier pull recorded the photo (its first send landed), then it was deleted elsewhere
    A.setState({ photos: [{ id: 'm1', url: '/media/m1', kind: 'progress', clientKey: key }] } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' })), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().photos.some((p) => p.clientKey === key)).toBe(false);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLogPhotoCountAfter).not.toBeNull();
  });

  it('refused for good (403) lets its copy go and says so once: it is never sent again', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-403' });
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' }));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-403' }] } as never);
    await A.getState().flushOutbox();
    expect(A.getState().toast).toBe(DISCARDED);
    // its bytes are gone; a marker says it was refused, for a copy of its op another tab holds
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-403')).toMatchObject({ refused: true });
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-403')).not.toHaveProperty('input');
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('whose copy cannot be read is kept for the next flush, and the rest of the queue goes on', async () => {
    const A = await tab();
    startWork(A as never);
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm5', url: '/media/m5' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('broken'); });
    const photo = { t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-unread' };
    const other = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB', clientKey: 'k-other' } };
    A.setState({ outbox: [photo, other] } as never);
    await A.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledWith(other.input);
    expect(A.getState().outbox).toEqual([photo]);
  });

  it('whose op was lost (the page closed during its send) is queued again from its copy and sent under its key', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'BBBB', clientKey: 'k-orphan' });
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    void A.getState().flushOutbox();
    await up.called();
    expect(up.calls[0]!.input).toEqual({ kind: 'progress', mime: 'image/png', data: 'BBBB', clientKey: 'k-orphan' });
    up.calls[0]!.answer.resolve({ id: 'm6', url: '/media/m6' });
    await settled();
    expect(A.getState().outbox).toEqual([]);
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-orphan');
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
  });

  it('a marker past its keep is dropped at the next flush', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    A.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    await rows.markSitePhotoSent(ROWS, 'villa-b', 'k-old');
    await rows.markSitePhotoSent(ROWS, 'villa-c', 'k-new');
    // the old one was written a keep and a moment ago
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + rows.SITE_PHOTO_SENT_KEEP_MS + 1000);
    await rows.markSitePhotoSent(ROWS, 'villa-c', 'k-new');
    await A.getState().flushOutbox();
    await settled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-old')).toBeNull();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-c', 'k-new')).not.toBeNull();
  });
});

describe('a project switch during a flush or a load (#917)', () => {
  it('a flush whose project moves keeps, for the old project, every pick queued meanwhile, and never stores the op', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const pick = (data: string): void => {
      A.setState({ online: false } as never);
      A.getState().addProgressPhoto(`data:image/png;base64,${data}`);
      A.setState({ online: true } as never);
    };
    // P1 picked with no signal, then a photo sent online whose answer is lost, then P2 with no signal
    pick('UDE=');
    A.getState().addProgressPhoto(PNG);
    await up.called();
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    await settled();
    pick('UDI=');
    expect(A.getState().outbox.map((o) => o.t)).toEqual(['uploadMedia', 'uploadSitePhoto', 'uploadMedia']);
    const flushing = A.getState().flushOutbox();
    await up.called(2); // P1's send, held open
    // P3 picked while the flush is out, still on villa-b; then the person moves to villa-c
    pick('UDM=');
    A.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2 } as never);
    up.calls[1]!.answer.resolve({ id: 'm-p1', url: '/media/m-p1' });
    await flushing;
    await settled();
    await queueWritten();
    const stored = storedQueue<{ t: string; input: { data: string } }>(localStorage.getItem('vitan.outbox.anon.villa-b') ?? '[]');
    expect(stored.map((o) => o.t)).toEqual(['uploadMedia', 'uploadMedia']);
    expect(stored.map((o) => o.input.data)).toEqual(['UDI=', 'UDM=']);
  });

  it('a load whose read of the kept photos is answered after a project switch queues and shows nothing on the new one', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ online: false } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-b' });
    const hold = await holdDatabase();
    A.getState().hydrateOutbox();
    await hold.readAsked;
    A.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, outbox: [] } as never);
    await hold.release();
    await settled();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().sitePhotosKept).toEqual([]);
  });
});

// two store instances share this document's lock manager (the test setup's), as two tabs share the browser's
describe('two tabs of one person on one project (#917)', () => {
  it('a tab never sends a photo another tab is sending', async () => {
    const A = await tab();
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const B = await tab();
    const upB = uploads();
    B.getState()._setGateway({ uploadMedia: upB.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    startWork(B as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    // the realtime ping every tab hears
    await B.getState().flushOutbox();
    await settled();
    expect(upB.fn).not.toHaveBeenCalled();
    expect(B.getState().outbox).toEqual([]);
    upA.calls[0]!.answer.resolve({ id: 'm7', url: '/media/m7' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    await B.getState().flushOutbox();
    await settled();
    expect(upB.fn).not.toHaveBeenCalled();
    expect(B.getState().toast ?? '').not.toContain('discarded');
  });

  it('a copy of its op another tab still holds settles on the marker as synced once the photo was taken, never as "discarded"', async () => {
    const A = await tab();
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const B = await tab();
    const upB = uploads();
    B.getState()._setGateway({ uploadMedia: upB.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    startWork(B as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    const key = upA.calls[0]!.input.clientKey;
    // B holds an op for the same photo (from a flush of an earlier lost answer)
    B.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }] } as never);
    upA.calls[0]!.answer.resolve({ id: 'm8', url: '/media/m8' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    await settled();
    await B.getState().flushOutbox();
    expect(upB.fn).not.toHaveBeenCalled();
    expect(B.getState().outbox).toEqual([]);
    // the server holds the photo: the copy settles as synced, never as "discarded"
    expect(B.getState().toast).toBe('1 offline update synced.');
  });

  it('a lost answer queued in both tabs is sent again once, and neither says "discarded"', async () => {
    const A = await tab();
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const B = await tab();
    const upB = uploads();
    B.getState()._setGateway({ uploadMedia: upB.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    startWork(B as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    const key = upA.calls[0]!.input.clientKey;
    upA.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    await settled();
    // B's flush gives the row its op and sends it; A's flush meanwhile finds it taken by B and keeps its op, and the
    // rest of A's queue goes on
    void B.getState().flushOutbox();
    await upB.called();
    const other = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'CCCC', clientKey: 'k-other' } };
    A.setState({ outbox: [...A.getState().outbox, other] } as never);
    const sent = A.getState().flushOutbox();
    await upA.called(2);
    expect(upA.calls[1]!.input).toEqual(other.input);
    upA.calls[1]!.answer.resolve({ id: 'm10', url: '/media/m10' });
    await sent;
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
    upB.calls[0]!.answer.resolve({ id: 'm9', url: '/media/m9' });
    await until(B, (s) => s.outbox.length === 0);
    await settled();
    // A's next flush finds the marker: its op settles quietly
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(upA.fn).toHaveBeenCalledTimes(2);
    expect(upB.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().toast ?? '').not.toContain('discarded');
    expect(B.getState().toast ?? '').not.toContain('discarded');
  });

  it('a copy of its op in another tab, after that tab\'s replay was refused for good, is not sent and says "discarded" too', async () => {
    const A = await tab();
    startWork(A as never);
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    upA.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    await settled();
    // B rebuilds the op and replays it first; the server refuses it for good
    const B = await tab();
    const upB = vi.fn().mockRejectedValue(Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' }));
    B.getState()._setGateway({ uploadMedia: upB, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    void B.getState().flushOutbox();
    await until(B, (s) => s.toast === DISCARDED);
    await settled();
    A.setState({ toast: null } as never);
    await A.getState().flushOutbox();
    expect(upA.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toBe(DISCARDED);
  });

  it('a copy of its op a tab held past the marker\'s keep is never sent again, and never said to be discarded', async () => {
    const A = await tab();
    startWork(A as never);
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const B = await tab();
    const upB = vi.fn();
    B.getState()._setGateway({ uploadMedia: upB, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    B.setState({ online: false } as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    const key = upA.calls[0]!.input.clientKey;
    // B holds an op for it, and B's flushes do not run meanwhile (a tab left in the background)
    B.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }] } as never);
    upA.calls[0]!.answer.resolve({ id: 'm11', url: '/media/m11' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    await settled();
    const rows = await rowsOf();
    const marker = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(marker && rows.isSitePhotoSent(marker)).toBe(true);
    // a day later A's flush drops the marker
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + rows.SITE_PHOTO_SENT_KEEP_MS + 1000);
    await A.getState().flushOutbox();
    await settled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', key)).toBeNull();
    B.setState({ online: true } as never);
    await B.getState().flushOutbox();
    expect(upB).not.toHaveBeenCalled();
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().toast ?? '').not.toMatch(/discarded|synced/);
  });

  it('a photo this tab queued stays on its Dashboard and in the day\'s count while another tab sends it', async () => {
    const A = await tab();
    startWork(A as never);
    const upA = uploads();
    A.getState()._setGateway({ uploadMedia: upA.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    // the day's log on screen, counted by the server (none of this person's photos on it yet)
    A.setState({ dailyLog: { id: 'log-1', photoCount: 0, myPhotoKeys: [], photos: [], progress: 0 } } as never);
    A.getState().addProgressPhoto(PNG);
    await upA.called();
    const key = upA.calls[0]!.input.clientKey;
    upA.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    await settled();
    expect(A.getState().sitePhotosKept.map((k) => k.clientKey)).toEqual([key]);
    expect(A.getState().dailyLog?.progress).toBe(1);
    // B rebuilds its op and sends it; the upload is slow (held open), so B holds the photo's lock
    const B = await tab();
    const upB = uploads();
    B.getState()._setGateway({ uploadMedia: upB.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    void B.getState().flushOutbox();
    await upB.called();
    // A's next flush keeps its op for the next flush, and keeps showing the photo
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
    expect(A.getState().sitePhotosKept.map((k) => k.clientKey)).toEqual([key]);
    expect(queuedSitePhotos(A.getState().outbox, [], A.getState().sitePhotosKept)).toHaveLength(1);
    expect(A.getState().dailyLog?.progress).toBe(1);
    upB.calls[0]!.answer.resolve({ id: 'm12', url: '/media/m12' });
    await until(B, (s) => s.outbox.length === 0);
    await settled();
  });
});

/** Holds the phone's site photo database with a write the test ends: every call opened meanwhile waits behind it.
 *  `readAsked` / `writeAsked` resolve once a read / a write of it is asked for meanwhile; `release` resolves once the
 *  hold has ended. */
async function holdDatabase(): Promise<{ release: () => Promise<void>; readAsked: Promise<void>; writeAsked: Promise<void> }> {
  const db = await new Promise<IDBDatabase>((done, fail) => {
    const req = indexedDB.open('vitan-site-photos', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('photos', { keyPath: 'key' }).createIndex('sentAt', 'sentAt'); };
    req.onsuccess = () => done(req.result);
    req.onerror = () => fail(req.error);
  });
  let open = true;
  const t = db.transaction('photos', 'readwrite');
  const store = t.objectStore('photos');
  const keepAlive = (): void => { if (open) store.get('none').onsuccess = keepAlive; };
  keepAlive();
  const ended = new Promise<void>((done) => { t.oncomplete = () => { db.close(); done(); }; });
  const asked = deferred<void>();
  const write = deferred<void>();
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const made = transaction.apply(this, args);
    if (this.name === 'vitan-site-photos') (args[1] === 'readwrite' ? write : asked).resolve();
    return made;
  } as IDBDatabase['transaction']);
  return { release: () => { open = false; return ended; }, readAsked: asked.promise, writeAsked: write.promise };
}

describe('the settle skip touches only a site photo\'s op (#917 port, r2 re-check)', () => {
  it('a keyed act, a photo-identity upload, a json-identity upload and a refused json act are each marked; a site photo\'s op is not', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-p6' });
    const names: string[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { names.push(k); return setItem.call(this, k, v); });
    const uploadMedia = vi.fn(async (input: { data: string }) => {
      if (input.data === 'REFUSE') throw Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' });
      return { id: 'm', url: '/media/m' };
    });
    const publishDrawing = vi.fn().mockResolvedValue(snap);
    A.getState()._setGateway({ uploadMedia, publishDrawing, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const ops = [
      { t: 'publishDrawing', drawingId: 'd1', idempotencyKey: 'idem-p6' },
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'ck-p6' } },
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB' } },
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'REFUSE' } },
      { t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-p6' },
    ];
    const { markName, doneName } = await import('@/store/queueLedger');
    const key = 'vitan.outbox.anon.villa-b';
    A.setState({ outbox: ops } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(4);
    expect(publishDrawing).toHaveBeenCalledTimes(1);
    const marked = (o: unknown) => names.some((n) => n.startsWith(markName(key, o as never, '')));
    const faced = (o: unknown) => names.includes(doneName(key, o as never));
    expect(ops.map((o) => ({ t: o.t, mark: marked(o), fact: faced(o) }))).toEqual([
      { t: 'publishDrawing', mark: true, fact: true },
      { t: 'uploadMedia', mark: true, fact: true },
      { t: 'uploadMedia', mark: true, fact: false },
      { t: 'uploadMedia', mark: true, fact: false },
      { t: 'uploadSitePhoto', mark: false, fact: false },
    ]);
    expect(A.getState().outbox).toEqual([]);
  });
});

describe('Codex round 1 on #1161: a site photo is settled only once its row says so, and never left without a send (#917)', () => {
  const LOG = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 0, crew: [], materials: [], photos: [] };
  /** The phone's site photo database refuses every write while `on` is true; reads still answer. */
  const failingWrites = () => {
    const state = { on: false };
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (state.on && this.name === 'vitan-site-photos' && args[1] === 'readwrite') throw new Error('broken');
      return transaction.apply(this, args);
    } as IDBDatabase['transaction']);
    return state;
  };

  it('a replay the server took whose row could not be marked keeps its op, and its bytes stay to be sent again (4389428571)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-c1' });
    const writes = failingWrites();
    // the database fails from the moment the server has answered the first send: the marker it owes cannot be written
    const uploadMedia = vi.fn(async () => { if (uploadMedia.mock.calls.length === 1) writes.on = true; return { id: 'm-c1', url: '/media/m-c1' }; });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-c1' }] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-c1' }]);
    writes.on = false;
    // sent again under its key: the server answers with the same photo, and the row is marked this time
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(A.getState().outbox).toEqual([]);
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-c1');
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
  });

  it('a replay the server took whose refresh failed asks for one at once (4389428615)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-c2' });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-c2', url: '/media/m-c2' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-c2' }] } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().commandReconcilePending).toBe(true);
  });

  it('refused for good after a lost answer, it leaves the gallery, the count and the draft it was added to (4389428627)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG } } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.photos).toHaveLength(1);
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded).toBe(1);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' })), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().toast).toBe(DISCARDED);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(A.getState().sitePhotosKept).toEqual([]);
  });

  it('a lost answer for a photo a refresh already shows adds no second copy to the gallery and no draft photo (4389428620)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } } as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    // a refresh landed while the send was out: the server holds the photo, and its key is in the log's own list
    A.setState({ dailyLog: { ...LOG, photoCount: 1, myPhotoKeys: [key], photos: [{ id: 'm-c4', url: '/media/m-c4' }] } } as never);
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.photos).toEqual([{ id: 'm-c4', url: '/media/m-c4' }]);
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
  });

  it('whose row is gone leaves the gallery, the count and the draft, and asks for the server\'s word on it (4389716748)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG } } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    const key = (A.getState().outbox[0] as { clientKey: string }).clientKey;
    expect(A.getState().dailyLog!.photos).toHaveLength(1);
    // its marker passed its keep, or the site's data was cleared
    await (await rowsOf()).deleteSitePhotoRow(ROWS, 'villa-b', key);
    const uploadMedia = vi.fn();
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(A.getState().commandReconcilePending).toBe(true);
  });

  it('answered 410 after a lost answer takes the draft photo and kept copy back too, as a refusal and a gone row do (Stage 1 r3)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG } } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLogDraft?.photosAdded).toBe(1);
    // the refresh after it fails, so the log on screen is still the one the photo was added to
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' })), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(A.getState().sitePhotosKept).toEqual([]);
    // and the draft saved on this phone says so too, so a reload does not bring the photo back into the count
    const saved = Object.keys(localStorage).filter((k) => k.startsWith('vitan.dailyLogDraft.') && !k.includes('.legacy.'));
    expect(saved).toHaveLength(1);
    expect((JSON.parse(localStorage.getItem(saved[0]!)!) as { photosAdded?: number }).photosAdded ?? 0).toBe(0);
  });

  it('a replay the server took leaves no copy of the photo\'s bytes in memory (4391469504)', async () => {
    const A = await tab();
    startWork(A as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().sitePhotosKept).toHaveLength(1);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-r2', url: '/media/m-r2' }), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().sitePhotosKept).toEqual([]);
  });

  it('old markers are dropped without reading any row that keeps a photo\'s bytes (4391469530)', async () => {
    const rows = await rowsOf();
    await rows.putSitePhotoRow('someone-else', 'villa-c', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-bytes' });
    await rows.markSitePhotoSent(ROWS, 'villa-b', 'k-old');
    const walked = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    await rows.dropSentMarkers(Date.now() + 1);
    expect(walked).not.toHaveBeenCalled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-old')).toBeNull();
    expect(await rows.getSitePhotoRow('someone-else', 'villa-c', 'k-bytes')).toMatchObject({ input: { data: 'AAAA' } });
  });

  it('a marker written exactly at the cut-off is kept; only older ones go (4391469530, Stage 1 r5 P17)', async () => {
    const rows = await rowsOf();
    const before = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(before - 1); await rows.markSitePhotoSent(ROWS, 'villa-b', 'k-older');
    clock.mockReturnValue(before); await rows.markSitePhotoSent(ROWS, 'villa-b', 'k-edge');
    clock.mockRestore();
    await rows.dropSentMarkers(before);
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-older')).toBeNull();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', 'k-edge')).not.toBeNull();
  });

  it('a direct send the server took whose row could not be marked stays this tab\'s: no flush sends it again (4389428586)', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const writes = failingWrites();
    writes.on = true;
    up.calls[0]!.answer.resolve({ id: 'm-c5', url: '/media/m-c5' });
    await until(A, (s) => /uploaded/.test(s.toast ?? ''));
    await settled();
    writes.on = false;
    await A.getState().flushOutbox();
    await settled();
    expect(up.fn).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a read of the kept copies that fails is tried again, with nothing else queued (4389428598)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-c6' });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-c6', url: '/media/m-c6' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const broken = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('broken'); });
      A.getState().hydrateOutbox();
      await settled();
      expect(uploadMedia).not.toHaveBeenCalled();
      broken.mockRestore();
      await vi.advanceTimersByTimeAsync(5000);
      await settled();
    } finally {
      vi.useRealTimers();
    }
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a copy another tab was sending when it closed is sent here, with nothing else queued (4389428598)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-c7' });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-c7', url: '/media/m-c7' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    // the other tab's send holds the row's lock
    const release = await rows.holdSitePhotoLock(ROWS, 'villa-b', 'k-c7');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      A.getState().hydrateOutbox();
      await settled();
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(A.getState().outbox).toEqual([]);
      // that tab closes before its answer: its lock goes, and its row is still full
      release();
      await vi.advanceTimersByTimeAsync(5000);
      await settled();
    } finally {
      vi.useRealTimers();
    }
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a copy that could not be read while offline is read again when the app comes back online with nothing queued (4389428598)', async () => {
    const A = await tab();
    A.setState({ online: false } as never);
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-c8' });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm-c8', url: '/media/m-c8' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const broken = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('broken'); });
      A.getState().hydrateOutbox();
      await settled();
      broken.mockRestore();
      // the retry finds the app offline and sends nothing
      await vi.advanceTimersByTimeAsync(5000);
      await settled();
      expect(A.getState().outbox).toEqual([]);
      A.getState().toggleOnline();
      await settled();
    } finally {
      vi.useRealTimers();
    }
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });
});
