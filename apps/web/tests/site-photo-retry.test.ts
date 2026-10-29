import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { warmImports } from './warm-imports';
import { settled, startWork } from './site-visit-work';

/**
 * #917 (#1161 Codex round 1, Stage 1 r3) — the site photo retry: its waits, and the row change a direct send could not
 * write. The retry's timer is caught as it is armed and fired by the test, so no row waits on a clock: each waits on the
 * retry being armed (`armed`), or on every database call, flush and turn having ended (`settled()`).
 */
type Arm = { ms: number; fn: () => void };
const arms: Arm[] = [];
let armWaiters: Array<{ n: number; done: () => void }> = [];
vi.mock('@/lib/clampedTimer', async (orig) => {
  const real = await orig<typeof import('@/lib/clampedTimer')>();
  return {
    ...real,
    // only the site photo retry's own timer is caught; every other timer runs as it would
    setClampedTimeout: (fn: () => void, ms: number) => {
      if (!(new Error().stack ?? '').includes('retrySitePhotos')) return real.setClampedTimeout(fn, ms);
      arms.push({ ms, fn });
      for (const w of armWaiters.filter((x) => arms.length >= x.n)) { armWaiters = armWaiters.filter((x) => x !== w); w.done(); }
      return { clear: () => {} };
    },
  };
});
const armed = (n: number) => new Promise<void>((done) => { if (arms.length >= n) done(); else armWaiters.push({ n, done }); });

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/data/sitePhotoStore'));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const snap = {
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
};
// rows are kept under the signed-in user's id; with no session that is 'anon'
const ROWS = 'anon';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function tab() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', online: true, lang: 'en' } as never);
  return useStore;
}
type Store = Awaited<ReturnType<typeof tab>>;
const until = (store: Store, pred: (s: ReturnType<Store['getState']>) => boolean) => new Promise<void>((done) => {
  if (pred(store.getState())) { done(); return; }
  const off = store.subscribe((s) => { if (pred(s)) { off(); done(); } });
});
const rowsOf = () => import('@/data/sitePhotoStore');

/** Another tab holds this row's lock until `release`. */
function holdRowLock(clientKey: string) {
  let release!: () => void;
  const out = new Promise<void>((r) => { release = r; });
  let taken!: () => void;
  const has = new Promise<void>((r) => { taken = r; });
  void navigator.locks.request(`vitan.sitePhoto.${ROWS}::villa-b::${clientKey}`, async () => { taken(); await out; });
  return { has, release };
}

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

/** A direct send whose answer the test gives, with the phone's writes failing from the answer on. */
async function directSendAnswered(answer: (a: ReturnType<typeof deferred<{ id: string; url: string }>>) => void) {
  const A = await tab();
  startWork(A as never);
  const sent = deferred<void>();
  const reply = deferred<{ id: string; url: string }>();
  const uploadMedia = vi.fn((input: { clientKey: string }) => { if (uploadMedia.mock.calls.length === 1) { keyOf.resolve(input.clientKey); sent.resolve(); return reply.promise; } return Promise.resolve({ id: 'm-again', url: '/media/m-again' }); });
  const keyOf = deferred<string>();
  A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
  A.getState().addProgressPhoto(PNG);
  await sent.promise;
  const key = await keyOf.promise;
  const writes = failingWrites();
  writes.on = true;
  answer(reply);
  await armed(1);
  await settled();
  return { A, key, writes, uploadMedia };
}

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); localStorage.clear(); arms.length = 0; armWaiters = []; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

/** "sent" markers cannot be written (reads and other writes still work) until `heal()`; `keys` lists each marker tried */
function failMarkers() {
  const real = IDBObjectStore.prototype.put;
  let broken = true;
  const keys: string[] = [];
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, v: unknown, k?: IDBValidKey) {
    const row = v as { key?: string; sentAt?: number };
    if (row && typeof row === 'object' && 'sentAt' in row) { keys.push(String(row.key)); if (broken) throw new Error('quota'); }
    return real.call(this, v, k);
  });
  return { heal: () => { broken = false; }, keys };
}
/** the site photo row locks any tab holds or waits for */
const heldSiteLocks = async () => {
  const q = await navigator.locks.query();
  return [...(q.held ?? []), ...(q.pending ?? [])].map((l) => l.name ?? '').filter((n) => n.startsWith('vitan.sitePhoto.'));
};

describe('the site photo retry (#917, #1161)', () => {
  it('an op held while another tab sends its row backs off 5 s to a minute, and never starts again at 5 s while it is held (Stage 1 r3, P7)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-p7' });
    const lock = holdRowLock('k-p7');
    await lock.has;
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm', url: '/media/m' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-p7' }] } as never);
    await A.getState().flushOutbox();
    for (let n = 1; n <= 7; n++) {
      await armed(n);
      await settled();
      if (n < 7) { arms[n - 1]!.fn(); await settled(); }
    }
    lock.release();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(arms.map((a) => a.ms).slice(0, 6)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });

  it('a "sent" marker the phone could not write is written on the retry, and only then is the row\'s lock let go (Stage 1 r3)', async () => {
    const { A, key, writes, uploadMedia } = await directSendAnswered((reply) => reply.resolve({ id: 'm-b', url: '/media/m-b' }));
    const rows = await rowsOf();
    // held: no flush here or elsewhere takes the row while its marker is unwritten
    expect(await rows.sitePhotosLocked(ROWS, 'villa-b')).toContain(key);
    expect((await rows.getSitePhotoRow(ROWS, 'villa-b', key))).toMatchObject({ input: { clientKey: key } });
    writes.on = false;
    arms[0]!.fn();
    await settled();
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
    expect(await rows.sitePhotosLocked(ROWS, 'villa-b')).not.toContain(key);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a refused direct send whose row could not be removed is never sent again, and its row goes on the retry (Stage 1 r3, F5c)', async () => {
    const { A, key, writes, uploadMedia } = await directSendAnswered((reply) => reply.reject(Object.assign(new Error('too large'), { status: 413 })));
    await until(A, (s) => s.toast === 'Could not upload the photo — please try again.');
    const rows = await rowsOf();
    expect(await rows.sitePhotosLocked(ROWS, 'villa-b')).toContain(key);
    // a flush while its removal is unwritten gives the row no op
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(A.getState().outbox).toEqual([]);
    // still failing: kept, and tried again later
    arms[0]!.fn();
    await armed(2);
    await settled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', key)).toMatchObject({ input: { clientKey: key } });
    writes.on = false;
    arms[1]!.fn();
    await settled();
    expect(await rows.getSitePhotoRow(ROWS, 'villa-b', key)).toBeNull();
    expect(await rows.sitePhotosLocked(ROWS, 'villa-b')).not.toContain(key);
    await A.getState().flushOutbox();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('a marker that keeps failing is made again on a retry that backs off 5 s to a minute, and the lock goes once it lands (Stage 1 r4, P12)', async () => {
    const A = await tab();
    startWork(A as never);
    const m = failMarkers();
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm', url: '/media/m' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    for (let n = 1; n <= 7; n++) {
      await armed(n);
      await settled();
      if (n < 7) { arms[n - 1]!.fn(); await settled(); }
    }
    expect(arms.map((a) => a.ms).slice(0, 6)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(await heldSiteLocks()).toHaveLength(1);
    m.heal();
    arms[6]!.fn();
    await settled();
    expect(await heldSiteLocks()).toEqual([]);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it.each(['sign-out', 'a project switch'] as const)('after %s, the change made again writes only its own row, and no flush runs for it (Stage 1 r4, P13)', async (how) => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    // another person's and another project's kept rows on this phone
    await rows.putSitePhotoRow('someone-else', 'villa-b', { kind: 'progress', mime: 'image/png', data: 'XXXX', clientKey: 'k-other-user' });
    await rows.putSitePhotoRow(ROWS, 'villa-c', { kind: 'progress', mime: 'image/png', data: 'YYYY', clientKey: 'k-other-proj' });
    const m = failMarkers();
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'm', url: '/media/m' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await armed(1);
    await settled();
    const own = m.keys[0]!;
    if (how === 'a project switch') A.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2 } as never);
    else A.getState().completeSignOut();
    m.heal();
    const flush = vi.spyOn(A.getState(), 'flushOutbox');
    arms[0]!.fn();
    await settled();
    expect([...new Set(m.keys)]).toEqual([own]);
    expect(own.startsWith(`${ROWS}::villa-b::`)).toBe(true);
    expect(flush).not.toHaveBeenCalled();
    expect(await rows.getSitePhotoRow('someone-else', 'villa-b', 'k-other-user')).toMatchObject({ input: { data: 'XXXX' } });
    expect(await rows.getSitePhotoRow(ROWS, 'villa-c', 'k-other-proj')).toMatchObject({ input: { data: 'YYYY' } });
    expect(await heldSiteLocks()).toEqual([]);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('a direct send whose row was never kept lets it go after one try: a failing database is not asked again (4391469488)', async () => {
    const A = await tab();
    startWork(A as never);
    // the phone's database refuses every write: the photo is sent with no row kept
    const writes = failingWrites();
    writes.on = true;
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('too large'), { status: 413 }));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === 'Could not upload the photo — please try again.');
    await settled();
    expect(arms).toEqual([]);
    expect(await heldSiteLocks()).toEqual([]);
  });

  it('a lost answer while the app stays online is sent again on the retry, with nothing else to send (4391469520)', async () => {
    const A = await tab();
    startWork(A as never);
    const uploadMedia = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ id: 'm-l', url: '/media/m-l' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    await armed(1);
    await settled();
    expect(A.getState().outbox).toHaveLength(1);
    arms[0]!.fn();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(uploadMedia.mock.calls[1]![0]).toEqual(uploadMedia.mock.calls[0]![0]);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a replay that fails for now is tried again on the retry (4391469520)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-503' });
    const uploadMedia = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 })).mockResolvedValue({ id: 'm-503', url: '/media/m-503' });
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-503' }] } as never);
    await A.getState().flushOutbox();
    await armed(1);
    await settled();
    expect(A.getState().outbox).toHaveLength(1);
    arms[0]!.fn();
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(A.getState().outbox).toEqual([]);
  });

  it('a replay that keeps failing for now backs off 5 s to a minute, one upload each time (Stage 1 r5, P14a)', async () => {
    const A = await tab();
    startWork(A as never);
    const rows = await rowsOf();
    await rows.putSitePhotoRow(ROWS, 'villa-b', { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-p14' });
    const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: 'k-p14' }] } as never);
    await A.getState().flushOutbox();
    for (let n = 1; n <= 6; n++) { await armed(n); await settled(); arms[n - 1]!.fn(); await settled(); }
    await armed(7);
    A.setState({ online: false } as never);
    expect(uploadMedia).toHaveBeenCalledTimes(7);
    expect(arms.slice(0, 7).map((a) => a.ms)).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  });

  it('a lost answer whose replays keep losing theirs backs off 5 s to a minute, under the same key (Stage 1 r5, P14b)', async () => {
    const A = await tab();
    startWork(A as never);
    const uploadMedia = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    A.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    A.getState().addProgressPhoto(PNG);
    for (let n = 1; n <= 5; n++) { await armed(n); await settled(); arms[n - 1]!.fn(); await settled(); }
    await armed(6);
    A.setState({ online: false } as never);
    expect(uploadMedia).toHaveBeenCalledTimes(6);
    expect(new Set(uploadMedia.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey)).size).toBe(1);
    expect(arms.slice(0, 6).map((a) => a.ms)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });
});
