import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { warmImports } from './warm-imports';
import { settled, startWork } from './site-visit-work';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/data/sitePhotoStore'), () => import('@/store/queueLedger'));

/**
 * #919 part 1 — a site photo whose place was removed (deleted or unpublished) after it was chosen is answered by the
 * server's 400 "Unknown location for this project". It is sent once more, under the same key, without the place, and
 * the person is told; it is never lost. The stated exception to "a 4xx is final for the web": that exact 400, a photo
 * that named a place, once. Every wait is on a signal (a mock's call, a store state, `settled()`); no clocks.
 */
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const snap = {
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
};
const ROWS = 'anon';
const DROPPED = 'Photo added. Its place was removed, so it was saved without a place.';
const ADDED = 'Progress photo uploaded — visible to PMC.';
const DROPPED_LINE = '1 photo saved without a place, because the place was removed.';
const TRY_AGAIN = 'Could not upload the photo — please try again.';
const SAVED = 'Photo saved offline — will upload when signal returns.';
const placeGone = () => Object.assign(new Error('/media 400'), { status: 400, serverMessage: 'Unknown location for this project' });
const otherRefusal = () => Object.assign(new Error('/media 400'), { status: 400, serverMessage: 'Unsupported image type' });
const lost = () => new TypeError('Failed to fetch');

type Answer = Error | { id: string; url: string; nodeId?: string | null };
/** An upload mock that answers its calls in the order given, and records each input. */
function uploads(...answers: Answer[]) {
  const inputs: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (input: Record<string, unknown>) => {
    inputs.push(input);
    const a = answers.shift() ?? lost();
    if (a instanceof Error) throw a;
    return a;
  });
  return { fn, inputs };
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
const gatewayOf = (store: Store, uploadMedia: ReturnType<typeof uploads>['fn']) =>
  store.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('an online site photo whose place was removed (#919)', () => {
  it('PG1: is sent once more under its key without the place, listed with no place, and the person is told', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), { id: 'm1', url: '/media/m1' });
    gatewayOf(A, up.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    // listed as the answer comes (the test's later refresh lists nothing); said once its marker is written
    await until(A, (s) => s.photos.some((p) => p.id === 'm1'));
    expect(A.getState().photos.find((p) => p.id === 'm1')).not.toHaveProperty('nodeId');
    await until(A, (s) => s.toast === DROPPED);
    expect(up.inputs).toHaveLength(2);
    expect(up.inputs[0]).toMatchObject({ nodeId: 'room-1' });
    expect(up.inputs[1]!.clientKey).toBe(up.inputs[0]!.clientKey);
    expect(up.inputs[1]).not.toHaveProperty('nodeId');
    await settled();
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', up.inputs[0]!.clientKey as string);
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
    // the marker says so, to a copy of its op another tab may hold (Stage 1 r2 gap: M5)
    expect(row).toMatchObject({ placeDropped: true });
    expect(A.getState().outbox).toEqual([]);
  });

  it('PG2: the same 400 again on the second send: no third send, refused as before, nothing said about a place', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), placeGone());
    gatewayOf(A, up.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.toast === TRY_AGAIN);
    await settled();
    expect(up.inputs).toHaveLength(2);
    expect(A.getState().outbox).toEqual([]);
  });

  it('PG3: another 400, or a photo with no place, is sent once and refused as before', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(otherRefusal(), placeGone());
    gatewayOf(A, up.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.toast === TRY_AGAIN);
    A.setState({ toast: null } as never);
    A.getState().addProgressPhoto(PNG);
    await until(A, (s) => s.toast === TRY_AGAIN);
    await settled();
    expect(up.inputs).toHaveLength(2);
    expect(up.inputs[1]).not.toHaveProperty('nodeId');
  });

  it('PG15: a direct send whose "sent" marker could not be written says "added" now, and the dropped place once the retry writes it', async () => {
    let failMark = false;
    vi.doMock('@/data/sitePhotoStore', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
      return { ...real, markSitePhotoSent: (...args: Parameters<typeof real.markSitePhotoSent>) => {
        if (failMark) { failMark = false; return Promise.reject(new Error('QuotaExceededError')); }
        return real.markSitePhotoSent(...args);
      } };
    });
    try {
      const A = await tab();
      startWork(A as never);
      const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(A, up.fn);
      failMark = true;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        A.getState().addProgressPhoto(PNG, 'room-1');
        await until(A, (s) => s.toast === ADDED);
        await settled();
        expect(failMark).toBe(false);
        const rows = await import('@/data/sitePhotoStore');
        const key = up.inputs[0]!.clientKey as string;
        // the row still holds the photo: not said yet, as its replay after a reload would say it
        const before = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
        expect(before && rows.isSitePhotoSent(before)).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        await until(A, (s) => s.toast === DROPPED);
        const after = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
        expect(after).toMatchObject({ placeDropped: true });
      } finally {
        vi.useRealTimers();
      }
      expect(up.inputs).toHaveLength(2);
    } finally {
      vi.doUnmock('@/data/sitePhotoStore');
    }
  });

  it('PG16: the marker write fails once and the tab closes before its retry: the reload\'s replay says it, once in all', async () => {
    let failMark = false;
    vi.doMock('@/data/sitePhotoStore', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
      return { ...real, markSitePhotoSent: (...args: Parameters<typeof real.markSitePhotoSent>) => {
        if (failMark) { failMark = false; return Promise.reject(new Error('QuotaExceededError')); }
        return real.markSitePhotoSent(...args);
      } };
    });
    // a closed tab lets its locks go; a browser without Web Locks stands in for that here, so the reload may send the row
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    const told: string[] = [];
    try {
      const A = await tab();
      startWork(A as never);
      A.subscribe((s, prev) => { if (s.toast && s.toast !== prev.toast) told.push(s.toast); });
      const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(A, up.fn);
      failMark = true;
      A.getState().addProgressPhoto(PNG, 'room-1');
      await until(A, (s) => s.toast === ADDED);
      await settled();
      const key = up.inputs[0]!.clientKey as string;
      // the page is loaded again: the kept row's op (by its key) is sent, and the key answers with the unplaced photo
      const B = await tab();
      startWork(B as never);
      B.subscribe((s, prev) => { if (s.toast && s.toast !== prev.toast) told.push(s.toast); });
      const up2 = uploads({ id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(B, up2.fn);
      B.setState({ outbox: [{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }] } as never);
      await B.getState().flushOutbox();
      await settled();
      expect(up2.inputs).toHaveLength(1);
      expect(B.getState().outbox).toEqual([]);
      expect(told.filter((t) => t.includes('without a place'))).toHaveLength(1);
    } finally {
      delete (globalThis.navigator as unknown as { locks?: unknown }).locks;
      vi.doUnmock('@/data/sitePhotoStore');
    }
  });

  it('PG17: no row kept (its write failed) and the marker not written either: nothing can replay it, so it is said at once', async () => {
    vi.doMock('@/data/sitePhotoStore', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
      return { ...real,
        putSitePhotoRow: () => Promise.reject(new Error('QuotaExceededError')),
        markSitePhotoSent: () => Promise.reject(new Error('QuotaExceededError')) };
    });
    try {
      const A = await tab();
      startWork(A as never);
      const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(A, up.fn);
      A.getState().addProgressPhoto(PNG, 'room-1');
      await until(A, (s) => s.toast === DROPPED);
      expect(up.inputs).toHaveLength(2);
    } finally {
      vi.doUnmock('@/data/sitePhotoStore');
    }
  });

  it('PG18: the person moves to another project while the marker is being written: nothing is said there', async () => {
    let letMarkGo!: () => void;
    vi.doMock('@/data/sitePhotoStore', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
      return { ...real, markSitePhotoSent: (...args: Parameters<typeof real.markSitePhotoSent>) =>
        new Promise<void>((done) => { letMarkGo = () => { void real.markSitePhotoSent(...args).then(done); }; }) };
    });
    try {
      const A = await tab();
      startWork(A as never);
      const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(A, up.fn);
      A.getState().addProgressPhoto(PNG, 'room-1');
      await until(A, (s) => s.photos.some((p) => p.id === 'm1'));
      A.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, toast: null } as never);
      letMarkGo();
      await settled();
      expect(A.getState().toast ?? '').not.toBe(DROPPED);
      expect(A.getState().toast ?? '').not.toBe(ADDED);
    } finally {
      vi.doUnmock('@/data/sitePhotoStore');
    }
  });

  it('PG10: the second send answered with a photo on its place (another tab sent it once the place was back): listed on it, nothing said', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: 'room-1' });
    gatewayOf(A, up.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.photos.some((p) => p.id === 'm1'));
    // listed on its place as the answer came (the test's later refresh lists nothing)
    expect(A.getState().photos.find((p) => p.id === 'm1')).toMatchObject({ nodeId: 'room-1' });
    await settled();
    expect(up.inputs).toHaveLength(2);
    expect(A.getState().toast ?? '').not.toBe(DROPPED);
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', up.inputs[0]!.clientKey as string);
    expect(row).not.toHaveProperty('placeDropped');
  });

  it('PG19: a send answered by its key with the stored photo, filed since on another place: listed on that place, nothing said', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads({ id: 'm1', url: '/media/m1', nodeId: 'room-2' });
    gatewayOf(A, up.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.photos.some((p) => p.id === 'm1'));
    // the server's answer is the truth, not the place asked (Codex 4436983880)
    expect(A.getState().photos.find((p) => p.id === 'm1')).toMatchObject({ nodeId: 'room-2' });
    await settled();
    expect(up.inputs).toHaveLength(1);
    expect(A.getState().toast ?? '').not.toBe(DROPPED);
  });
});

describe('a queued site photo whose place was removed (#919)', () => {
  /** A photo picked online whose answer was lost: queued from its row (`uploadSitePhoto`). */
  const queued = async (A: Store): Promise<string> => {
    const first = uploads(lost());
    gatewayOf(A, first.fn);
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.toast === SAVED);
    await settled();
    return first.inputs[0]!.clientKey as string;
  };

  it('PG4: a replay from its row is saved without the place, and the flush\'s line says so', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const up = uploads(placeGone(), { id: 'm1', url: '/media/m1' });
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs.map((i) => [i.clientKey, 'nodeId' in i])).toEqual([[key, true], [key, false]]);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(row && rows.isSitePhotoSent(row) && !row.refused).toBe(true);
    // the marker says so, to a copy of its op another tab may hold (Stage 1 r2 gap: M6)
    expect(row).toMatchObject({ placeDropped: true });
  });

  it('PG14: a replay whose row could not be marked sent says nothing yet; its next send, once marked, says it once', async () => {
    let failMark = false;
    vi.doMock('@/data/sitePhotoStore', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
      return { ...real, markSitePhotoSent: (...args: Parameters<typeof real.markSitePhotoSent>) => {
        if (failMark) { failMark = false; return Promise.reject(new Error('QuotaExceededError')); }
        return real.markSitePhotoSent(...args);
      } };
    });
    try {
      const A = await tab();
      startWork(A as never);
      const key = await queued(A);
      const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null }, { id: 'm1', url: '/media/m1', nodeId: null });
      gatewayOf(A, up.fn);
      failMark = true;
      await A.getState().flushOutbox();
      await settled();
      expect(failMark).toBe(false);
      expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
      expect(A.getState().toast ?? '').not.toContain('without a place');
      await A.getState().flushOutbox();
      await settled();
      expect(up.inputs.map((i) => 'nodeId' in i)).toEqual([true, false, true]);
      expect(A.getState().outbox).toEqual([]);
      expect(A.getState().toast).toContain(DROPPED_LINE);
    } finally {
      vi.doUnmock('@/data/sitePhotoStore');
    }
  });

  it('PG5: the same 400 again on a replay\'s second send: no third send, discarded as before, its row marked refused', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const up = uploads(placeGone(), placeGone());
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(2);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast ?? '').not.toContain('without a place');
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(row && rows.isSitePhotoSent(row) && row.refused).toBe(true);
  });

  it('PG6: the second send\'s answer lost: the photo stays queued; the next replay is answered by the key with the stored, unplaced photo, and the person is told then', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    // the server's key fast path answers before any place check (media.service.ts), with the photo the lost second send stored
    const up = uploads(placeGone(), lost(), { id: 'm1', url: '/media/m1', nodeId: null });
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
    expect(A.getState().toast ?? '').not.toContain(DROPPED_LINE);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs.map((i) => [i.clientKey, 'nodeId' in i])).toEqual([[key, true], [key, false], [key, true]]);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  // Codex 4437127228: a keyed answer with no place is also a photo taken off its place since (a re-file in another tab)
  // while the place stands. Which one is read from the tree as it is now, never the one the tab holds (Stage 1).
  const ROOM = { id: 'room-1', parentId: null, name: 'Room 1', kind: 'room' as const, order: 0 };
  const withTree = (A: Store, up: ReturnType<typeof uploads>['fn'], tree: () => Promise<Omit<typeof snap, 'nodes'> & { nodes: Array<typeof ROOM> }>) =>
    A.getState()._setGateway({ uploadMedia: up, snapshot: vi.fn(tree), project: 'villa-b' } as never);

  it('PG20: a keyed answer with no place while the place stands now: settled, nothing said, the marker says nothing dropped', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const up = uploads({ id: 'm1', url: '/media/m1', nodeId: null });
    withTree(A, up.fn, async () => ({ ...snap, nodes: [ROOM] }));
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(1);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast ?? '').not.toContain('without a place');
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', key);
    expect(row && rows.isSitePhotoSent(row) && !row.refused).toBe(true);
    expect(row).not.toHaveProperty('placeDropped');
  });

  it('PG21: the tab still holds the place, the tree as it is now does not: the place was removed, and the person is told', async () => {
    const A = await tab();
    startWork(A as never);
    await queued(A);
    A.setState({ nodes: [ROOM] } as never);
    const up = uploads({ id: 'm1', url: '/media/m1', nodeId: null });
    withTree(A, up.fn, async () => ({ ...snap, nodes: [] }));
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  it('PG22: the tree cannot be read: not settled, nothing said; its next send reads it again and says it once', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const up = uploads({ id: 'm1', url: '/media/m1', nodeId: null }, { id: 'm1', url: '/media/m1', nodeId: null });
    let treeDown = true;
    withTree(A, up.fn, async () => { if (treeDown) throw lost(); return { ...snap, nodes: [] }; });
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toEqual([{ t: 'uploadSitePhoto', scope: ROWS, clientKey: key }]);
    expect(A.getState().toast ?? '').not.toContain(DROPPED_LINE);
    treeDown = false;
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(2);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  it('PG23: a direct send answered with no place while the place stands now: listed with no place, nothing said', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads({ id: 'm1', url: '/media/m1', nodeId: null });
    withTree(A, up.fn, async () => ({ ...snap, nodes: [ROOM] }));
    A.getState().addProgressPhoto(PNG, 'room-1');
    await until(A, (s) => s.photos.some((p) => p.id === 'm1'));
    expect(A.getState().photos.find((p) => p.id === 'm1')).not.toHaveProperty('nodeId');
    await settled();
    expect(A.getState().toast ?? '').not.toBe(DROPPED);
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', up.inputs[0]!.clientKey as string);
    expect(row).not.toHaveProperty('placeDropped');
  });

  it.each([
    ['names the place it asked for', { id: 'm1', url: '/media/m1', nodeId: 'room-1' }],
    ['comes from an API that names no place', { id: 'm1', url: '/media/m1' }],
  ])('PG9: a keyed answer that %s says nothing about a place', async (_, answer) => {
    const A = await tab();
    startWork(A as never);
    await queued(A);
    const up = uploads(answer);
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(1);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast ?? '').not.toContain('without a place');
  });

  it('PG7: an earlier release\'s queued `uploadMedia` site photo is saved without the place too', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), { id: 'm1', url: '/media/m1' });
    gatewayOf(A, up.fn);
    A.setState({ outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-old', nodeId: 'room-1' } }] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs.map((i) => [i.clientKey, 'nodeId' in i])).toEqual([['k-old', true], ['k-old', false]]);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  it('PG11: a refresh that fails after an earlier release\'s photo was saved without its place: told once, by the send that settles it', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), { id: 'm1', url: '/media/m1', nodeId: null }, { id: 'm1', url: '/media/m1', nodeId: null });
    const snapshot = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(snap);
    A.getState()._setGateway({ uploadMedia: up.fn, snapshot, project: 'villa-b' } as never);
    A.setState({ outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-old', nodeId: 'room-1' } }] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(A.getState().outbox).toHaveLength(1);
    expect(A.getState().toast ?? '').not.toContain(DROPPED_LINE);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs.map((i) => 'nodeId' in i)).toEqual([true, false, true]);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  it('PG12: a copy of the op whose photo another tab saved without its place says so too, sending nothing', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const rows = await import('@/data/sitePhotoStore');
    // the other tab's send: answered, its row marked sent, without the place
    await rows.markSitePhotoSent(ROWS, 'villa-b', key, true);
    const up = uploads();
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(0);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast).toContain(DROPPED_LINE);
  });

  it('PG13: a copy whose photo another tab sent with its place, or an earlier release marked sent, says nothing about a place', async () => {
    const A = await tab();
    startWork(A as never);
    const key = await queued(A);
    const rows = await import('@/data/sitePhotoStore');
    await rows.markSitePhotoSent(ROWS, 'villa-b', key);
    const up = uploads();
    gatewayOf(A, up.fn);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs).toHaveLength(0);
    expect(A.getState().outbox).toEqual([]);
    expect(A.getState().toast ?? '').not.toContain('without a place');
  });

  it('PG8: a queued evidence or visit upload keeps the 4xx final: sent once', async () => {
    const A = await tab();
    startWork(A as never);
    const up = uploads(placeGone(), placeGone());
    gatewayOf(A, up.fn);
    A.setState({ outbox: [
      { t: 'uploadMedia', input: { kind: 'inspection', mime: 'image/png', data: 'AAAA', clientKey: 'k-ev', nodeId: 'room-1', inspectionId: 'I1', inspectionItemId: 'it1' } },
      { t: 'uploadMedia', input: { kind: 'visit', mime: 'image/png', data: 'AAAA', clientKey: 'k-v', nodeId: 'room-1', siteVisit: { visitId: 'v1' } } },
    ] } as never);
    await A.getState().flushOutbox();
    await settled();
    expect(up.inputs.map((i) => i.clientKey)).toEqual(['k-ev', 'k-v']);
    expect(A.getState().toast ?? '').not.toContain('without a place');
  });
});
