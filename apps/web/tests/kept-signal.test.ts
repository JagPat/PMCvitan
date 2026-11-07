import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { afterRowWrite, closeKeptSignals, listenRowWrites, signalRowWrite } from '@/data/keptSignal';
import { deleteEvidence, markEvidenceFailed, putEvidence, retryEvidence } from '@/data/evidenceStore';
import { deleteSitePhotoRow, markSitePhotoRefused, markSitePhotoSent, putSitePhotoRow } from '@/data/sitePhotoStore';
import {
  VISIT_PHOTO_ABORT_WAIT_MS, VISIT_PHOTO_READ_WAIT_MS, VisitPhotoUnconfirmed, clearVisitPhotoStart, clearVisitPoster, deleteRemovedVisitPhoto,
  deleteVisitPhoto, failVisitPhoto, failVisitPhotosOn, fileVisitPhoto, moveVisitPhotos, putVisitPhoto, settleFiledVisitPhotos,
} from '@/data/visitPhotoStore';

/**
 * #1397 (Codex 4499008032; Stage 1 G2, G3, G5): every row write of the three stores tells the person's other tabs, once,
 * on their own channel; a write that settles for a person this page no longer listens for opens nothing; the signal never
 * throws and never leaves a rejection unhandled. Every wait is on a heard message or a settled write, never a clock.
 */

// the visit store's two bounds, held by a test (the late commit) until it fires them itself; every other timer is real
const timers = vi.hoisted(() => ({ hold: false, held: new Map<number, () => void>() }));
vi.mock('@/lib/clampedTimer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/clampedTimer')>();
  return {
    ...real,
    setClampedTimeout: (fn: () => void, ms: number) => {
      if (!timers.hold) return real.setClampedTimeout(fn, ms);
      timers.held.set(ms, fn);
      return { clear: () => { timers.held.delete(ms); } } as ReturnType<typeof real.setClampedTimeout>;
    },
  };
});

/** BroadcastChannel as the platform has it: a post reaches every other open channel of the name, never itself */
class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  readonly name: string;
  constructor(name: string) { this.name = name; FakeChannel.open.add(this); }
  postMessage(data: unknown): void {
    for (const c of FakeChannel.open) if (c !== this && c.name === this.name) queueMicrotask(() => { if (!c.closed) c.onmessage?.({ data }); });
  }
  close(): void { this.closed = true; FakeChannel.open.delete(this); }
}

let n = 0;
let SUB = '';
let heard = 0;
beforeEach(() => {
  n += 1; SUB = `s-${n}`; heard = 0;
  closeKeptSignals(); FakeChannel.open.clear();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  listenRowWrites(SUB, () => {});
  new FakeChannel(`vitan.kept.${SUB}`).onmessage = () => { heard += 1; };
});
afterEach(() => { closeKeptSignals(); vi.unstubAllGlobals(); vi.restoreAllMocks(); timers.hold = false; timers.held.clear(); });

/** the messages the other tab heard, once every one posted so far has arrived */
const settled = async (): Promise<number> => { await new Promise<void>((r) => queueMicrotask(r)); await new Promise<void>((r) => queueMicrotask(r)); return heard; };

const P = 'p-1';
const ev = (ck: string) => ({ userScope: SUB, projectId: P, clientKey: ck, mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
const site = (ck: string) => ({ clientKey: ck, kind: 'progress' }) as never;
const file = (ck: string, visitId = 'v-1') =>
  ({ t: 'siteVisitAddFile', visitId, scope: SUB, file: { id: ck, mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: `sv-${ck}` }) as never;
const start = (visitId: string) => ({ t: 'siteVisitStart', body: { id: visitId }, idempotencyKey: `st-${visitId}` }) as never;

describe('every row write tells the person’s other tabs, exactly once (Stage 1 G2)', () => {
  // each: the rows it needs first (their own posts are counted before it), then the write itself
  const writes: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ['putEvidence', async () => {}, () => putEvidence(ev('e-1'))],
    ['markEvidenceFailed', () => putEvidence(ev('e-1')), () => markEvidenceFailed(SUB, P, 'e-1', 'refused')],
    ['retryEvidence', async () => { await putEvidence(ev('e-1')); await markEvidenceFailed(SUB, P, 'e-1', 'refused'); }, () => retryEvidence(SUB, P, 'e-1')],
    ['deleteEvidence', () => putEvidence(ev('e-1')), () => deleteEvidence(SUB, P, 'e-1')],
    ['putSitePhotoRow', async () => {}, () => putSitePhotoRow(SUB, P, site('s-1'))],
    ['markSitePhotoSent', () => putSitePhotoRow(SUB, P, site('s-1')), () => markSitePhotoSent(SUB, P, 's-1')],
    ['markSitePhotoRefused', () => putSitePhotoRow(SUB, P, site('s-1')), () => markSitePhotoRefused(SUB, P, 's-1')],
    ['deleteSitePhotoRow', () => putSitePhotoRow(SUB, P, site('s-1')), () => deleteSitePhotoRow(SUB, P, 's-1')],
    ['putVisitPhoto', async () => {}, () => putVisitPhoto(SUB, P, file('f-1'), 'AA==')],
    ['deleteVisitPhoto', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => deleteVisitPhoto(SUB, P, 'f-1')],
    ['deleteRemovedVisitPhoto', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => deleteRemovedVisitPhoto(SUB, P, 'f-1')],
    ['fileVisitPhoto', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => fileVisitPhoto(SUB, P, 'f-1')],
    ['settleFiledVisitPhotos', async () => { await putVisitPhoto(SUB, P, file('f-1'), 'AA=='); await fileVisitPhoto(SUB, P, 'f-1'); },
      () => settleFiledVisitPhotos(SUB, P, Date.now() + 1, new Set(), new Set(['f-1']), new Set())],
    ['clearVisitPoster', async () => { await putVisitPhoto(SUB, P, file('f-1'), 'AA==', null, undefined, 'BB=='); await fileVisitPhoto(SUB, P, 'f-1', 'm-1'); },
      () => clearVisitPoster(SUB, P, 'f-1')],
    ['failVisitPhoto', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => failVisitPhoto(SUB, P, 'f-1', 'refused')],
    ['clearVisitPhotoStart', () => putVisitPhoto(SUB, P, file('f-1'), 'AA==', start('v-1')), () => clearVisitPhotoStart(SUB, P, 'v-1')],
    ['moveVisitPhotos', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => moveVisitPhotos(SUB, P, 'v-1', 'v-2')],
    ['failVisitPhotosOn', () => putVisitPhoto(SUB, P, file('f-1'), 'AA=='), () => failVisitPhotosOn(SUB, P, 'v-1', 'refused')],
  ];
  it.each(writes)('%s', async (_name, before, write) => {
    await before();
    const was = await settled();
    await write();
    expect((await settled()) - was).toBe(1);
  });

  it('a visit photo saved after it was reported unconfirmed tells them when it lands (the late commit)', async () => {
    // the put's bound and its abort wait are fired by the test, at the moment the row is put: the abort finds the
    // transaction past saving (it throws), and the put is reported unconfirmed before the save is confirmed
    timers.hold = true;
    vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(() => { throw new Error('committed'); });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...a: Parameters<IDBObjectStore['put']>) {
      timers.held.get(VISIT_PHOTO_READ_WAIT_MS)?.();
      timers.held.get(VISIT_PHOTO_ABORT_WAIT_MS)?.();
      return put.apply(this, a);
    });
    let landed!: () => void;
    const late = new Promise<void>((r) => { landed = r; });
    await expect(putVisitPhoto(SUB, P, file('f-1'), 'AA==', null, () => landed())).rejects.toBeInstanceOf(VisitPhotoUnconfirmed);
    expect(await settled()).toBe(1); // the put's own settling
    await late;
    expect(await settled()).toBe(2); // and the save that landed after it
  });
});

describe('a person this page no longer listens for (Stage 1 G3)', () => {
  it('a write that settles after a sign-out opens no channel and says nothing', async () => {
    closeKeptSignals();
    await putSitePhotoRow(SUB, P, site('s-1'));
    expect([...FakeChannel.open].map((c) => c.name)).toEqual([`vitan.kept.${SUB}`]); // the other tab's alone
    expect(await settled()).toBe(0);
    // listened for again (signed in again): heard again
    listenRowWrites(SUB, () => {});
    await putSitePhotoRow(SUB, P, site('s-2'));
    expect(await settled()).toBe(1);
  });
});

describe('the signal never throws, and never leaves a rejection unhandled (Stage 1 G5)', () => {
  it('a post that throws: signalRowWrite does not throw, and afterRowWrite leaves no unhandled rejection', async () => {
    vi.spyOn(FakeChannel.prototype, 'postMessage').mockImplementation(() => { throw new Error('closed'); });
    expect(() => signalRowWrite(SUB)).not.toThrow();
    const unhandled: unknown[] = [];
    const seen = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', seen);
    try {
      await expect(afterRowWrite(SUB, Promise.resolve('kept'))).resolves.toBe('kept');
      // Node reports an unhandled rejection once the microtasks of the turn have run: wait for the next turn
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', seen);
    }
    expect(unhandled).toEqual([]);
  });
});
