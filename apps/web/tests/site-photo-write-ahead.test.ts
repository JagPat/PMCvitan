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
/** The server's log landed as a refresh lands it (the one place the store takes a server log), so the store counts the
 *  log's photos from it. The gateway answers it until the test sets another; its other calls are `gw`'s. */
const land = async (store: Store, log: { id: string }, gw: Record<string, unknown> = {}): Promise<void> => {
  store.getState()._setGateway({ uploadMedia: vi.fn(), ...gw, snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: log }), project: 'villa-b' } as never);
  await store.getState().requestFreshSnapshot();
  await until(store, (s) => s.dailyLog?.id === log.id);
};

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
  const LOG = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 0, crew: [], materials: [], photos: [], photoCount: 0, myPhotoKeys: [] as string[] };
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

  it('refused for good after a lost answer, it leaves the gallery and the count, and the draft never held it (4389428627, #1167)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: LOG }), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.photos).toHaveLength(1);
    // counted by the queue, never by the draft
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' })), snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: LOG }), project: 'villa-b' } as never);
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

  it('answered 410 after a lost answer takes its count and kept copy back too, as a refusal and a gone row do, and the draft never held it (Stage 1 r3, #1167)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: LOG }), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.progress).toBe(1);
    // the refresh after it fails, so the log on screen is still the one the photo was added to
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' })), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(A.getState().sitePhotosKept).toEqual([]);
    // and nothing saved on this phone counts it, so a reload does not bring the photo back into the count
    const saved = Object.keys(localStorage).filter((k) => k.startsWith('vitan.dailyLogDraft.') && !k.includes('.legacy.'));
    for (const k of saved) expect((JSON.parse(localStorage.getItem(k)!) as { photosAdded?: number }).photosAdded ?? 0).toBe(0);
  });

  it('refused for good after a reload takes its photo back out of the count, and no saved draft ever held it (#1167, Codex 4392115360)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.progress).toBe(1);
    // the page is loaded again: the log lands from the server, and the photo is counted from its row's op once more
    const B = await tab();
    startWork(B as never);
    await land(B, LOG);
    B.setState({ online: false } as never);
    B.getState().hydrateOutbox();
    await until(B, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(B.getState().dailyLog!.progress).toBe(1);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    B.setState({ online: true } as never);
    B.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 403'), { status: 403, serverMessage: 'no' })), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await B.getState().flushOutbox();
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().dailyLog!.progress).toBe(0);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    const saved = Object.keys(localStorage).filter((k) => k.startsWith('vitan.dailyLogDraft.') && !k.includes('.legacy.'));
    for (const k of saved) expect((JSON.parse(localStorage.getItem(k)!) as { photosAdded?: number }).photosAdded ?? 0).toBe(0);
  });

  it('sent after a lost answer, it stays counted until a read shows the server\'s count, and the draft never holds it (#1167)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    const key = (A.getState().outbox[0] as { clientKey: string }).clientKey;
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-k', url: '/media/m-k' }), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    // its answer's read failed: the count keeps it from the answer (#1195), and the draft is not touched
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().photoUploadsInFlight.map((u) => u.clientKey)).toEqual([key]);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
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

describe('the #1161 follow-ups (#1187, #1195, #1201, #1228)', () => {
  const LOG = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 0, crew: [], materials: [], photos: [], photoCount: 0, myPhotoKeys: [] as string[] };
  const GONE = () => Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' });
  const draftSaved = () => {
    const saved = Object.keys(localStorage).filter((k) => k.startsWith('vitan.dailyLogDraft.') && !k.includes('.legacy.'));
    return saved.length ? (JSON.parse(localStorage.getItem(saved[0]!)!) as { photosAdded?: number }) : null;
  };

  /** The next lock request (a row's, for a photo being kept) waits until `gate`; `asked` gives its name. */
  const gatedLock = () => {
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    const gate = deferred<void>();
    const asked = deferred<string>();
    vi.spyOn(navigator.locks, 'request').mockImplementationOnce((async (...args: unknown[]) => { asked.resolve(String(args[0])); await gate.promise; return request(...args); }) as never);
    return { gate, asked };
  };

  it('a row whose tab closed before its answer is counted in the log once, by its key, from the queue (#1187, Codex 4396140829)', async () => {
    const A = await tab();
    startWork(A as never);
    // the server's count does not hold it: the log's count is that count plus the photos queued here
    await land(A, LOG);
    A.setState({ online: false } as never);
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-orph', dailyLogId: 'log-1' });
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(A.getState().dailyLog!.progress).toBe(1);
    // queued only: the draft holds confirmed sends alone
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    // read again: it is queued and counted already
    A.getState().hydrateOutbox();
    await settled();
    expect(A.getState().dailyLog!.progress).toBe(1);
  });

  it('a lost answer counted before a reload is counted once after it, and again once when its row is read again (#1187)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.progress).toBe(1);
    const B = await tab();
    startWork(B as never);
    await land(B, LOG);
    B.setState({ online: false } as never);
    B.getState().hydrateOutbox();
    await until(B, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(B.getState().dailyLog!.progress).toBe(1);
    // the server's log lands again, and its row is read again
    await land(B, LOG);
    B.getState().hydrateOutbox();
    await settled();
    expect(B.getState().dailyLog!.progress).toBe(1);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
  });

  it('a lost answer for a photo the photo list alone already shows adds no second copy but is counted in the log until the server\'s count holds it (#1187 4396140838, #1242 r1 4410673630)', async () => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: LOG }), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    // a refresh landed while the send was out: its photo list holds the photo, by its key; the log's count does not hold
    // it yet, and its log's gallery does not show it yet
    A.setState({ photos: [{ id: 'm-p', url: '/media/m-p', kind: 'progress', clientKey: key }] } as never);
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
  });

  it('a lost answer for a photo the log\'s gallery already shows by its key adds no second copy and no draft photo, as a yes adds nothing then (#1187)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG } } as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    A.setState({ dailyLog: { ...LOG, progress: 1, photos: [{ id: 'm-g', url: '/media/m-g', clientKey: key }] } } as never);
    up.calls[0]!.answer.reject(lost());
    await until(A, (s) => s.toast === SAVED);
    expect(A.getState().dailyLog!.photos).toEqual([{ id: 'm-g', url: '/media/m-g', clientKey: key }]);
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
  });

  it('a queued photo sent while the log is read by its module stays in the day\'s count until that read shows it (#1195, Codex 4397101459)', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const A = await tab();
    A.setState({ online: false, dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } } as never);
    startWork(A as never);
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-mod', dailyLogId: 'log-1' });
    const read = deferred<unknown>();
    const asked = deferred<void>();
    const dailyLog = vi.fn(() => { asked.resolve(); return read.promise; });
    // the server's count holds the photo once it is sent: media's count, carried on the snapshot, laid on the module's log
    const held = { ...snap, dailyLog: { ...LOG, photoCount: 1, myPhotoKeys: ['k-mod'] } };
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-mod', url: '/media/m-mod' }), snapshot: vi.fn().mockResolvedValue(held), dailyLog, project: 'villa-b' } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(A.getState().dailyLog!.progress).toBe(1);
    A.setState({ online: true } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    // the answer's snapshot carries no daily-log read: the log's count still holds the photo, and its read is asked
    expect(A.getState().dailyLog!.progress).toBe(1);
    await asked.promise;
    read.resolve({ dailyLog: { ...LOG }, materials: [], source: 'projection', generation: 2 });
    await until(A, (s) => s.dailyLog?.myPhotoKeys?.includes('k-mod') ?? false);
    expect(A.getState().dailyLog!.progress).toBe(1);
    expect(A.getState().photoUploadsInFlight).toEqual([]);
  });

  it('a photo whose keeping on this phone is answered after the person moved scope is never sent, and its row is kept for that scope (#1201, Codex 4398157341)', async () => {
    const A = await tab();
    startWork(A as never);
    const uploadMedia = vi.fn();
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    // the row's lock is answered only when the test lets it go
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    const gate = deferred<void>();
    const asked = deferred<void>();
    vi.spyOn(navigator.locks, 'request').mockImplementationOnce((async (...args: unknown[]) => { asked.resolve(); await gate.promise; return request(...args); }) as never);
    A.getState().addProgressPhoto(PNG);
    await asked.promise;
    // signed out and in again (a new scope, a new gateway) while the photo is being kept
    const next = vi.fn();
    A.setState({ projectScopeGeneration: 2 } as never);
    A.getState()._setGateway({ uploadMedia: next, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    gate.resolve();
    await until(A, (s) => s.toast === SAVED);
    await settled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(A.getState().photoUploadsSending).toEqual([]);
    const rows = await rowsOf();
    const kept = await rows.listSitePhotoRows(ROWS, 'villa-b');
    expect(kept).toHaveLength(1);
    expect(rows.isSitePhotoSent(kept[0]!)).toBe(false);
    // its lock let go (the lock list is this file's, shared by its tests: only this photo's is asked about)
    expect((await rows.sitePhotosLocked(ROWS, 'villa-b')).has(kept[0]!.clientKey)).toBe(false);
  });

  it('a direct send answered 410 (another tab\'s replay of it landed and was deleted) takes every copy off screen and asks for the server\'s word (#1228, Codex 4407837836)', async () => {
    const A = await tab();
    startWork(A as never);
    A.setState({ dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } } as never);
    const up = uploads();
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await up.called();
    const key = up.calls[0]!.input.clientKey;
    // the other tab's replay landed and a pull brought the photo in, before it was deleted
    A.setState({ photos: [{ id: 'm-del', url: '/media/m-del', kind: 'progress', clientKey: key }], dailyLog: { ...LOG, photoCount: 1, myPhotoKeys: [key], photos: [{ id: 'm-del', url: '/media/m-del', clientKey: key }] } } as never);
    up.calls[0]!.answer.reject(GONE());
    await until(A, (s) => s.photoUploadsSending.length === 0);
    await settled();
    expect(A.getState().photos).toEqual([]);
    expect(A.getState().dailyLog!.photos).toEqual([]);
    expect(A.getState().toast).not.toBe(TRY_AGAIN);
    expect(A.getState().commandReconcilePending).toBe(true);
    expect(await (await rowsOf()).getSitePhotoRow(ROWS, 'villa-b', key)).toBeNull();
  });

  it('a photo whose keeping was answered "not kept" after the scope moved leaves no row to be sent later (the person was told to try again) (#1201, Stage 1 gap-check)', async () => {
    const A = await tab();
    startWork(A as never);
    const first = vi.fn();
    A.getState()._setGateway({ uploadMedia: first, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    const { gate, asked } = gatedLock();
    A.getState().addProgressPhoto(PNG);
    const name = await asked.promise;
    const key = name.slice(`vitan.sitePhoto.${ROWS}::villa-b::`.length);
    // the write commits but is answered after its bound (here: the commit stands in the database, and the app's own write
    // is refused once), the case send(false) covers with letRowGo ("a row that landed after its bound")
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: key });
    const transaction = IDBDatabase.prototype.transaction;
    let failOnce = true;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (failOnce && this.name === 'vitan-site-photos' && args[1] === 'readwrite') { failOnce = false; throw new Error('broken'); }
      return transaction.apply(this, args);
    } as IDBDatabase['transaction']);
    const next = vi.fn().mockResolvedValue({ id: 'm-dup', url: '/media/m-dup' });
    A.setState({ projectScopeGeneration: 2 } as never);
    A.getState()._setGateway({ uploadMedia: next, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    gate.resolve();
    await until(A, (s) => s.toast === TRY_AGAIN);
    await settled();
    // told to try again: its row is gone, and the next load sends nothing
    A.getState().hydrateOutbox();
    await settled();
    expect(next).not.toHaveBeenCalled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', key)).toBeNull();
  });

  it('a flushed queued photo deleted elsewhere before any read held it is let go from the day\'s count by the read after its answer (#1195, Stage 1 gap-check)', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const A = await tab();
    A.setState({ online: false, dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } } as never);
    startWork(A as never);
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-ghost', dailyLogId: 'log-1' });
    const read = deferred<unknown>();
    const asked = deferred<void>();
    const dailyLog = vi.fn(() => { asked.resolve(); return read.promise; });
    // by the time the log is read, the photo was deleted (another tab or device): the server neither counts nor names it
    const gone = { ...snap, dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } };
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-g', url: '/media/m-g' }), snapshot: vi.fn().mockResolvedValue(gone), dailyLog, project: 'villa-b' } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    A.setState({ online: true } as never);
    await A.getState().flushOutbox();
    expect(A.getState().outbox).toEqual([]);
    await asked.promise;
    read.resolve({ dailyLog: { ...LOG }, materials: [], source: 'projection', generation: 2 });
    await until(A, (s) => s.dailyLogLoad === 'ready');
    await settled();
    // the server says 0 and names no key of this viewer's: the read begun after the answer is the count
    expect(A.getState().photoUploadsInFlight).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
  });

  it('a replayed queued photo deleted between its upload and its own snapshot is let go from the day\'s count by that snapshot (#1246 r1, Codex 4412387979)', async () => {
    const A = await tab();
    A.setState({ online: false, dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } } as never);
    startWork(A as never);
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-del', dailyLogId: 'log-1' });
    // the snapshot the replay asks for after the upload's answer: the photo was deleted meanwhile, so the server neither
    // counts nor names it
    const gone = { ...snap, dailyLog: { ...LOG, photoCount: 0, myPhotoKeys: [] } };
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-d', url: '/media/m-d' }), snapshot: vi.fn().mockResolvedValue(gone), project: 'villa-b' } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    A.setState({ online: true } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([]);
    // that snapshot was read after the answer: its count is the server's, with no later read needed
    expect(A.getState().photoUploadsInFlight).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
  });

  /** A photo whose answer was lost here, then the page loaded again offline with the server's log landed; `after` changes
   *  its row as another tab would, before the reload reads it. */
  const reloaded = async (after: (rows: Rows, key: string) => Promise<void>, landed: (key: string) => typeof LOG = () => LOG) => {
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(lost()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === SAVED);
    const key = (A.getState().outbox[0] as { clientKey: string }).clientKey;
    expect(draftSaved()?.photosAdded ?? 0).toBe(0);
    const rows = await rowsOf();
    await after(rows, key);
    // loaded again as the app loads: this phone's queue and draft first, then the server's log
    const B = await tab();
    startWork(B as never);
    B.setState({ online: false } as never);
    B.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    B.getState().hydrateOutbox();
    await settled();
    await land(B, landed(key));
    await settled();
    return { B, key };
  };

  it('a queued photo whose row another tab\'s replay had refused is not counted after a reload (#1242 r1, 4410673596)', async () => {
    const { B } = await reloaded((rows, key) => rows.markSitePhotoRefused(ROWS, 'villa-b', key));
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().dailyLog!.progress).toBe(0);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(draftSaved()?.photosAdded ?? 0).toBe(0);
  });

  it('a queued photo another tab sent is in no draft, and after a reload is counted by the server\'s count alone (#1242 r1, 4410673596)', async () => {
    const { B } = await reloaded(async () => {
      // another tab, with the log on show, reads the row and sends it: its draft is not touched
      const C = await tab();
      startWork(C as never);
      await land(C, LOG);
      C.setState({ online: false } as never);
      C.getState().hydrateOutbox();
      await until(C, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
      await settled();
      C.setState({ online: true } as never);
      C.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-x', url: '/media/m-x' }), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
      await C.getState().flushOutbox();
      expect(draftSaved()?.photosAdded ?? 0).toBe(0);
    }, (key) => ({ ...LOG, photoCount: 1, myPhotoKeys: [key] }));
    expect(B.getState().outbox).toEqual([]);
    // the server's count holds it: counted once, and by no draft
    expect(B.getState().dailyLog!.progress).toBe(1);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
  });

  it('a queued photo answered 410 after a reload leaves the count, and no draft ever held it (#1242 r1, 4410673603)', async () => {
    const { B } = await reloaded(async () => {});
    expect(B.getState().outbox.some((o) => o.t === 'uploadSitePhoto')).toBe(true);
    expect(B.getState().dailyLog!.progress).toBe(1);
    B.setState({ online: true } as never);
    B.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(GONE()), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await B.getState().flushOutbox();
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().dailyLog!.progress).toBe(0);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(draftSaved()?.photosAdded ?? 0).toBe(0);
  });

  it('a draft saved by the live release (#1161), which counts a queued photo with no key, does not count it twice on a server with the day\'s count (Stage 1)', async () => {
    // #1161 counted a lost answer in the draft (`photosAdded`, no key). Every server since #941 sends `photoCount`, which
    // is the count shown and the count Send stores: that draft's `photosAdded` never reaches either
    localStorage.setItem('vitan.dailyLogDraft.anon.villa-b', JSON.stringify({ projectId: 'villa-b', logKey: 'date:today', logId: 'log-1', photosAdded: 1 }));
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-live', dailyLogId: 'log-1' });
    const A = await tab();
    startWork(A as never);
    A.setState({ online: false } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    await land(A, { ...LOG, photoCount: 0, myPhotoKeys: [] } as never);
    expect(A.getState().dailyLogDraft?.photosAdded).toBe(1);
    expect(A.getState().dailyLog!.progress).toBe(1);
    // sent: the server's count holds it, and the log counts it once
    A.setState({ online: true } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-live', url: '/media/m-live' }), snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: { ...LOG, photoCount: 1, myPhotoKeys: ['k-live'] } }), project: 'villa-b' } as never);
    await A.getState().flushOutbox();
    await until(A, (s) => s.dailyLog?.myPhotoKeys?.includes('k-live') ?? false);
    expect(A.getState().dailyLog!.progress).toBe(1);
  });

  it('a queued photo whose row a read of the rows finds already sent, before its own answer is applied, stays counted until its own answer is applied (Stage 1 gap-check of the replacement, PR1)', async () => {
    const { B, key } = await reloaded(async () => {});
    expect(B.getState().dailyLog!.progress).toBe(1);
    B.setState({ online: true } as never);
    // the flush's own read of the rows: its lock read waits until the test lets it go
    const query = navigator.locks.query.bind(navigator.locks);
    const G = deferred<void>();
    const asked = deferred<void>();
    let q = 0;
    vi.spyOn(navigator.locks, 'query').mockImplementation((async () => { q += 1; if (q === 1) { asked.resolve(); await G.promise; } return query(); }) as never);
    const D1 = deferred<{ id: string; url: string }>();
    const key2 = deferred<string>();
    // the server holds a photo from its answer on
    const held: string[] = [];
    const upload = vi.fn((input: { clientKey: string }) => (input.clientKey === key ? D1.promise : (key2.resolve(input.clientKey), held.push(input.clientKey), Promise.resolve({ id: 'm-2', url: '/media/m-2' }))));
    let armed = false;
    let countAtRead = -1;
    const snapFn = vi.fn(async () => {
      if (armed) {
        armed = false;
        // the read let go sees the direct send's settle and reads again; its apply (a new kept list) is waited for
        const before = B.getState().sitePhotosKept;
        G.resolve();
        await until(B, (s) => q >= 2 && s.sitePhotosKept !== before);
        // that read found the row sent while its op here is still out: it is still counted, once
        countAtRead = B.getState().dailyLog!.progress;
      }
      return { ...snap, dailyLog: { ...LOG, photoCount: held.length, myPhotoKeys: [...held] } };
    });
    B.getState()._setGateway({ uploadMedia: upload, snapshot: snapFn, project: 'villa-b' } as never);
    const flushed = B.getState().flushOutbox();
    await asked.promise;
    // another photo is taken and sent directly while that read is out; its row is let go (a settle the read sees)
    B.getState().addProgressPhoto(PNG);
    const k2 = await key2.promise;
    await navigator.locks.request(`vitan.sitePhoto.${ROWS}::villa-b::${k2}`, async () => {});
    armed = true; held.push(key); D1.resolve({ id: 'm-1', url: '/media/m-1' });
    await flushed;
    await settled();
    expect(countAtRead).toBe(2);
    // counted once each, by the server's count
    expect(B.getState().dailyLog!.progress).toBe(2);
    expect(B.getState().photoUploadsInFlight).toEqual([]);
  });

  it('a photo another tab marked sent and closed before its answer was applied there is counted once, from the server\'s count, after this tab\'s copy of the op settles (Stage 1 gap-check, PR5)', async () => {
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-x', dailyLogId: 'log-1' });
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.setState({ online: false } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    const B = await tab();
    startWork(B as never);
    await land(B, LOG);
    B.setState({ online: false } as never);
    B.getState().hydrateOutbox();
    await until(B, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(B.getState().dailyLog!.progress).toBe(1);
    // A sends it; its refresh never answers (the tab is closed then)
    const asked = deferred<void>();
    A.setState({ online: true } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-x', url: '/m' }), snapshot: vi.fn(() => { asked.resolve(); return new Promise(() => {}); }), project: 'villa-b' } as never);
    void A.getState().flushOutbox();
    await asked.promise;
    const up = vi.fn();
    B.setState({ online: true } as never);
    B.getState()._setGateway({ uploadMedia: up, snapshot: vi.fn().mockResolvedValue({ ...snap, dailyLog: { ...LOG, photoCount: 1, myPhotoKeys: ['k-x'] } }), project: 'villa-b' } as never);
    await B.getState().flushOutbox();
    expect(up).not.toHaveBeenCalled();
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().dailyLogDraft?.photosAdded ?? 0).toBe(0);
    expect(B.getState().dailyLog!.progress).toBe(1);
  });

  it('a photo another tab marked sent and closed, whose copy here settles with its refresh failed, stays counted once from the answer (#1246 r1 re-check, PR5b)', async () => {
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-x', dailyLogId: 'log-1' });
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.setState({ online: false } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    const B = await tab();
    startWork(B as never);
    await land(B, LOG);
    B.setState({ online: false } as never);
    B.getState().hydrateOutbox();
    await until(B, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(B.getState().dailyLog!.progress).toBe(1);
    // A sends it; its refresh never answers (the tab is closed then)
    const asked = deferred<void>();
    A.setState({ online: true } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'm-x', url: '/m' }), snapshot: vi.fn(() => { asked.resolve(); return new Promise(() => {}); }), project: 'villa-b' } as never);
    void A.getState().flushOutbox();
    await asked.promise;
    const up = vi.fn();
    B.setState({ online: true } as never);
    // B's refresh after it fails (or a module read owns the log and has not landed): its kept entry gives the log
    B.getState()._setGateway({ uploadMedia: up, snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    await B.getState().flushOutbox();
    expect(up).not.toHaveBeenCalled();
    expect(B.getState().outbox).toEqual([]);
    expect(B.getState().photoUploadsInFlight.map((u) => u.clientKey)).toEqual(['k-x']);
    expect(B.getState().dailyLog!.progress).toBe(1);
  });

  it('a kept entry held for a row another tab sent leaves with its op when the marker ends before the replay: nothing is left behind (Stage 1 re-check, RC3)', async () => {
    await (await rowsOf()).putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-y', dailyLogId: 'log-1' });
    const A = await tab();
    startWork(A as never);
    await land(A, LOG);
    A.setState({ online: false } as never);
    A.getState()._setGateway({ uploadMedia: vi.fn(), snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    A.getState().hydrateOutbox();
    await until(A, (s) => s.outbox.some((o) => o.t === 'uploadSitePhoto'));
    await settled();
    expect(A.getState().dailyLog!.progress).toBe(1);
    const rows = await rowsOf();
    // another tab sent it
    await rows.markSitePhotoSent(ROWS, 'villa-b', 'k-y');
    // this flush's replay of it waits for its row's lock until the test lets it go
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    const gate = deferred<void>();
    const asked = deferred<void>();
    vi.spyOn(navigator.locks, 'request').mockImplementation((async (...args: unknown[]) => { if (String(args[0]) === `vitan.sitePhoto.${ROWS}::villa-b::k-y`) { asked.resolve(); await gate.promise; } return request(...args); }) as never);
    const before = A.getState().sitePhotosKept;
    A.setState({ online: true } as never);
    const up = vi.fn();
    A.getState()._setGateway({ uploadMedia: up, snapshot: vi.fn().mockRejectedValue(lost()), project: 'villa-b' } as never);
    const flushed = A.getState().flushOutbox();
    // the flush's read of the rows applied: the sent row keeps its entry while its op is queued
    await until(A, (s) => s.sitePhotosKept !== before);
    await asked.promise;
    expect(A.getState().sitePhotosKept.map((k) => k.clientKey)).toEqual(['k-y']);
    expect(A.getState().dailyLog!.progress).toBe(1);
    // the marker passes its keep before the replay reads it
    await rows.dropSentMarkers(Date.now() + 1);
    gate.resolve();
    await flushed;
    await settled();
    expect(up).not.toHaveBeenCalled();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().sitePhotosKept).toEqual([]);
    expect(A.getState().dailyLog!.progress).toBe(0);
  });
});
