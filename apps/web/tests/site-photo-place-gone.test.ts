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
    await until(A, (s) => s.toast === DROPPED);
    expect(up.inputs).toHaveLength(2);
    expect(up.inputs[0]).toMatchObject({ nodeId: 'room-1' });
    expect(up.inputs[1]!.clientKey).toBe(up.inputs[0]!.clientKey);
    expect(up.inputs[1]).not.toHaveProperty('nodeId');
    const listed = A.getState().photos.find((p) => p.id === 'm1');
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('nodeId');
    await settled();
    const rows = await import('@/data/sitePhotoStore');
    const row = await rows.getSitePhotoRow(ROWS, 'villa-b', up.inputs[0]!.clientKey as string);
    expect(row && rows.isSitePhotoSent(row)).toBe(true);
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
