import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  POSTER_WAIT_MS, clearVisitPoster, fileVisitPhoto, getVisitPhoto, posterWaits, putVisitPhoto, settleFiledVisitPhotos,
  type SiteVisitAddFileOp,
} from '@/data/visitPhotoStore';

/**
 * #995 V2b-2: a clip's still frame is kept on the clip's own row (`visitPhotoStore`), in the same write, and waits there
 * until the server takes it or refuses it for good. A sent clip's row stays while its frame waits, up to a bound.
 */

const SCOPE = 'u-1';
const PROJECT = 'p-1';
const VISIT = '6b0f6a52-6c5d-4d1e-9a51-2f7a4b8f1c11';
const op = (id: string, mime = 'video/webm'): SiteVisitAddFileOp => ({
  t: 'siteVisitAddFile', visitId: VISIT, idempotencyKey: `k-${id}`, scope: SCOPE, file: { id, mime },
  by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: '2026-10-28T09:00:00.000Z',
});
const FRAME = '/9j/AAAA';
let now = 1_000_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

describe('#995 V2b-2: the still frame on its clip’s row', () => {
  it('is kept with the clip, and the id the server gave the clip is kept only on a row with a frame', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await putVisitPhoto(SCOPE, PROJECT, op('c-1'), 'AQID', null, undefined, FRAME);
    await putVisitPhoto(SCOPE, PROJECT, op('c-2'), 'AQID');
    await putVisitPhoto(SCOPE, PROJECT, op('p-1', 'image/jpeg'), 'AQID');
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-1')).toMatchObject({ state: 'queued', poster: FRAME });
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-2')).not.toHaveProperty('poster');
    expect(await fileVisitPhoto(SCOPE, PROJECT, 'c-1', 'm-1')).toEqual({ state: 'filed', reason: null });
    await fileVisitPhoto(SCOPE, PROJECT, 'c-2', 'm-2');
    await fileVisitPhoto(SCOPE, PROJECT, 'p-1');
    const clip = (await getVisitPhoto(SCOPE, PROJECT, 'c-1'))!;
    expect(clip).toMatchObject({ state: 'filed', poster: FRAME, mediaId: 'm-1', filedAt: now });
    expect(posterWaits(clip)).toBe(true);
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-2')).not.toHaveProperty('mediaId');
    expect(posterWaits((await getVisitPhoto(SCOPE, PROJECT, 'c-2'))!)).toBe(false);
    expect(posterWaits((await getVisitPhoto(SCOPE, PROJECT, 'p-1'))!)).toBe(false);
  });

  it('adds to the row’s shape only: a row with no frame is written, filed and read exactly as before, and one with a frame only adds its fields', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await putVisitPhoto(SCOPE, PROJECT, op('p-1', 'image/jpeg'), 'AQID');
    await putVisitPhoto(SCOPE, PROJECT, op('c-1'), 'AQID', null, undefined, FRAME);
    const before = ['clientKey', 'createdAt', 'data', 'key', 'op', 'projectId', 'reason', 'start', 'state', 'userScope'];
    expect(Object.keys((await getVisitPhoto(SCOPE, PROJECT, 'p-1'))!).sort()).toEqual(before);
    expect(Object.keys((await getVisitPhoto(SCOPE, PROJECT, 'c-1'))!).sort()).toEqual([...before, 'poster'].sort());
    await fileVisitPhoto(SCOPE, PROJECT, 'p-1', 'm-1');
    await fileVisitPhoto(SCOPE, PROJECT, 'c-1', 'm-2');
    expect(Object.keys((await getVisitPhoto(SCOPE, PROJECT, 'p-1'))!).sort()).toEqual([...before, 'filedAt'].sort());
    expect(Object.keys((await getVisitPhoto(SCOPE, PROJECT, 'c-1'))!).sort()).toEqual([...before, 'filedAt', 'mediaId', 'poster'].sort());
  });

  it('a row another tab filed first gets the clip’s id and keeps its own filing time', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await putVisitPhoto(SCOPE, PROJECT, op('c-1'), 'AQID', null, undefined, FRAME);
    await fileVisitPhoto(SCOPE, PROJECT, 'c-1');
    const first = now;
    now += 5_000;
    await fileVisitPhoto(SCOPE, PROJECT, 'c-1', 'm-1');
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-1')).toMatchObject({ mediaId: 'm-1', filedAt: first });
    // and the first id stands
    await fileVisitPhoto(SCOPE, PROJECT, 'c-1', 'm-other');
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-1')).toMatchObject({ mediaId: 'm-1' });
  });

  it('a frame not yet sent keeps a listed clip’s row, up to a day after filing; any other filed row goes as before', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await putVisitPhoto(SCOPE, PROJECT, op('c-1'), 'AQID', null, undefined, FRAME);
    await putVisitPhoto(SCOPE, PROJECT, op('c-2'), 'AQID', null, undefined, FRAME);
    await putVisitPhoto(SCOPE, PROJECT, op('c-3'), 'AQID');
    for (const [k, m] of [['c-1', 'm-1'], ['c-2', 'm-2'], ['c-3', 'm-3']]) await fileVisitPhoto(SCOPE, PROJECT, k, m);
    // c-2's frame was taken
    await clearVisitPoster(SCOPE, PROJECT, 'c-2');
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-2')).not.toHaveProperty('poster');
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-2')).not.toHaveProperty('mediaId');
    const listed = new Set(['c-1', 'c-2', 'c-3']);
    now += POSTER_WAIT_MS - 1;
    await settleFiledVisitPhotos(SCOPE, PROJECT, now, new Set(), listed, new Set());
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-1')).toMatchObject({ poster: FRAME });
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-2')).toBeNull();
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-3')).toBeNull();
    now += 1;
    await settleFiledVisitPhotos(SCOPE, PROJECT, now, new Set(), listed, new Set());
    expect(await getVisitPhoto(SCOPE, PROJECT, 'c-1')).toBeNull();
  });
});
