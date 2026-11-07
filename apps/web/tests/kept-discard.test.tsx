import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { listEvidence, putEvidence } from '@/data/evidenceStore';
import { holdSitePhotoLock, listSitePhotoRows, putSitePhotoRow } from '@/data/sitePhotoStore';
import { listVisitPhotos, putVisitPhoto } from '@/data/visitPhotoStore';
import { discardKept, projectNameKey, readKeptElsewhere, rememberProjectName } from '@/store/keptElsewhere';
import { normalizeGeneric, takenAs } from '@/store/loadTakes';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { DONE_CAP, doneName, recordBytes, recordName } from '@/store/queueLedger';
import { queueActIdent } from '@/store/queueActIdent';
import { QW } from '@/lib/queueWords';
import { closeKeptSignals } from '@/data/keptSignal';
import { EVIDENCE_READ_WAIT_MS } from '@/data/evidenceStore';
import { KeptElsewhereModal } from '@/layout/KeptElsewhere';
import { holdQueueLock, releaseQueueLocks, storedQueue } from './queueWrites';

/**
 * #1388 U2: the person's discard of changes this device keeps for a project they no longer hold. Rows go first, then
 * the acts naming them, under both keys' locks; every other entry stays byte for byte; nothing is discarded on a stale
 * or failed check of access. Every wait is on a held lock, a held request or a settled promise, never a clock (the
 * bound of the access check is advanced on purpose, once).
 */

// the visit store's removal records, made unreadable by a test; a row delete made to fail, or never to answer; and a
// store's read made to fail (`…Fails`: how many reads from now fail)
const ctl = vi.hoisted(() => ({
  removalsUnreadable: false, evidenceDeleteFails: false, evidenceDeleteHangs: null as null | (() => void), visitDeleteHangs: null as null | (() => void), siteDeleteHangs: null as null | (() => void),
  evidenceListFails: 0, visitReadFails: 0, siteListFails: 0,
}));
// each clamped wait armed, so a test can end one by hand (a signal, never a clock)
const timers = vi.hoisted(() => ({ armed: [] as { ms: number; fn: () => void }[] }));
vi.mock('@/lib/clampedTimer', async (orig) => {
  const real = await orig<typeof import('@/lib/clampedTimer')>();
  return { ...real, setClampedTimeout: (fn: () => void, ms: number) => { timers.armed.push({ ms, fn }); return real.setClampedTimeout(fn, ms); } };
});
const fails = (n: 'evidenceListFails' | 'visitReadFails' | 'siteListFails'): boolean => { if (ctl[n] <= 0) return false; ctl[n] -= 1; return true; };
vi.mock('@/data/visitPhotoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/visitPhotoStore')>();
  return {
    ...real,
    removedVisitPhotos: (...a: Parameters<typeof real.removedVisitPhotos>) => (ctl.removalsUnreadable ? 'unreadable' as const : real.removedVisitPhotos(...a)),
    readVisitPhotoRowsUntil: (...a: Parameters<typeof real.readVisitPhotoRowsUntil>) => (fails('visitReadFails') ? Promise.reject(new Error('idb')) : real.readVisitPhotoRowsUntil(...a)),
    deleteVisitPhoto: (...a: Parameters<typeof real.deleteVisitPhoto>) => {
      if (ctl.visitDeleteHangs) { ctl.visitDeleteHangs(); return new Promise<void>(() => {}); }
      return real.deleteVisitPhoto(...a);
    },
  };
});
vi.mock('@/data/evidenceStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/evidenceStore')>();
  return {
    ...real,
    deleteEvidence: (...a: Parameters<typeof real.deleteEvidence>) => {
      if (ctl.evidenceDeleteHangs) { ctl.evidenceDeleteHangs(); return new Promise<void>(() => {}); }
      return ctl.evidenceDeleteFails ? Promise.reject(new Error('blocked')) : real.deleteEvidence(...a);
    },
    listEvidence: (...a: Parameters<typeof real.listEvidence>) => (fails('evidenceListFails') ? Promise.reject(new Error('idb')) : real.listEvidence(...a)),
  };
});
vi.mock('@/data/sitePhotoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
  return {
    ...real,
    listSitePhotoRows: (...a: Parameters<typeof real.listSitePhotoRows>) => (fails('siteListFails') ? Promise.reject(new Error('idb')) : real.listSitePhotoRows(...a)),
    deleteSitePhotoRow: (...a: Parameters<typeof real.deleteSitePhotoRow>) => {
      if (ctl.siteDeleteHangs) { ctl.siteDeleteHangs(); return new Promise<void>(() => {}); }
      return real.deleteSitePhotoRow(...a);
    },
  };
});

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const ALPHA = { projectId: 'p-a', name: 'Alpha', short: 'ALP', role: 'pmc', orgId: null, orgName: null };
const GONE = { ...ALPHA, projectId: 'p-gone', name: 'Gone Tower' };
const approve = (k: string, d = 'd-1'): OutboxOp => ({ t: 'approve', decisionId: d, optionIndex: 0, idempotencyKey: k });
const visitFile = (id: string, visitId: string) =>
  ({ t: 'siteVisitAddFile', visitId, scope: SUB, file: { id, mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: `sv-${id}` }) as never;
const startOf = (visitId: string) => ({ t: 'siteVisitStart', body: { id: visitId, claimedAt: '2026-10-14T04:30:00.000Z' }, visitor: { name: 'Pat', role: 'pmc', placeName: null }, idempotencyKey: `st-${visitId}` }) as OutboxOp;
const closeOf = (visitId: string, k = `cl-${visitId}`) => ({ t: 'siteVisitClose', visitId, reason: 'done', idempotencyKey: k }) as OutboxOp;
const P = 'p-gone';
// a visit's id is a uuid (the server's start schema)
const V1 = '1c0d9e8f-7a6b-4c5d-9e3f-2a1b0c9d8e71';
const V2 = '1c0d9e8f-7a6b-4c5d-9e3f-2a1b0c9d8e72';
let n = 0;
let SUB = '';
const outbox = () => `vitan.outbox.${SUB}.${P}`;
const lane = () => `vitan.siteVisitQueue.${SUB}.${P}`;
/** a guard that reads the person's keys with their scopes, as the store's does */
const guard = () => createQueueKeyGuard(undefined, () => ({ evidence: SUB, visitPhoto: SUB }));
const keys = () => (Object.keys(localStorage) as string[]).sort();
const listed = async () => (await readKeptElsewhere(localStorage, SUB, new Set(['p-a'])))[0] ?? null;
const idOf = async (match: (id: string) => boolean): Promise<string> => (await listed())!.items.map((i) => i.id).find(match)!;

/** resolves once the store's state meets `cond` (a signal: the store's own change, never a poll) */
const until = (cond: (st: ReturnType<typeof useStore.getState>) => boolean): Promise<void> => new Promise((resolve) => {
  if (cond(useStore.getState())) { resolve(); return; }
  const stop = useStore.subscribe((st) => { if (cond(st)) { stop(); resolve(); } });
});

beforeEach(() => { n += 1; SUB = `d-${n}`; localStorage.clear(); });
afterEach(() => {
  cleanup();
  releaseQueueLocks();
  useStore.setState(getInitialState());
  ctl.removalsUnreadable = false; ctl.evidenceDeleteFails = false; ctl.evidenceDeleteHangs = null; ctl.visitDeleteHangs = null; ctl.siteDeleteHangs = null;
  ctl.evidenceListFails = 0; ctl.visitReadFails = 0; ctl.siteListFails = 0;
  timers.armed.length = 0;
  closeKeptSignals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('one line', () => {
  it('only that act goes: every other entry stays byte for byte, an act another tab wrote while the discard waited for the lock included', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    const target = await idOf((id) => id.includes('k-1'));
    const held = holdQueueLock(outbox());
    await held.has;
    const discarding = discardKept(localStorage, guard(), SUB, P, target);
    // another tab, holding the lock: its act lands before the discard runs
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2'), approve('k-other', 'd-3')]));
    held.release();
    expect(await discarding).toEqual({ ok: true, busy: false, unchecked: false, removed: true });
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-2', 'd-2'), approve('k-other', 'd-3')]);
    const ids = (await listed())!.items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => id.includes('k-1'))).toBe(false);
  });

  it('the discarded occurrence is marked before the write: a load that runs between the two does not take it', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    const target = await idOf((id) => id.includes('k-1'));
    // the key's write is refused: the mark alone stands, and the act is no longer owed
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === outbox()) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    expect((await discardKept(localStorage, guard(), SUB, P, target)).ok).toBe(false);
    vi.restoreAllMocks();
    expect((await listed())!.total).toBe(1);
    const loaded = guard().load(localStorage, outbox());
    expect(loaded).toEqual([approve('k-2', 'd-2')]);
  });

  it('an act a load leaves where it is (a visit act in the general key) stays byte for byte, and goes with "Discard all"', async () => {
    const misplaced = closeOf(V2);
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), misplaced]));
    const target = await idOf((id) => id.includes('k-1'));
    await discardKept(localStorage, guard(), SUB, P, target);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([misplaced]);
    expect(await listed()).toBeNull(); // not listed: a load never sends it
    await discardKept(localStorage, guard(), SUB, P, null);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
  });

  it('an earlier release’s unkeyed photo is discarded by the line the list shows it on (keyed as the load keys it)', async () => {
    const photo = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', nodeId: 'slab-1' } } as unknown as OutboxOp;
    localStorage.setItem(outbox(), JSON.stringify([photo, approve('k-1')]));
    const target = await idOf((id) => id.includes('photo:'));
    await discardKept(localStorage, guard(), SUB, P, target);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('a made record’s act goes, and the record with it', async () => {
    const rec = recordBytes([approve('k-2', 'd-2')], 'nonce1');
    localStorage.setItem(recordName(outbox(), [], rec, 'nonce1'), rec);
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    const target = await idOf((id) => id.includes('k-2'));
    await discardKept(localStorage, guard(), SUB, P, target);
    expect(keys().filter((k) => k.startsWith('vitan.made.'))).toEqual([]);
    expect((await listed())!.total).toBe(1);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });
});

describe('rows first, then acts', () => {
  const ev = (ck: string) => ({ userScope: SUB, projectId: P, clientKey: ck, mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
  const evOp = (ck: string): OutboxOp => ({ t: 'uploadEvidence', scope: SUB, clientKey: ck });

  it('an evidence photo: its row and its act both go', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1'), approve('k-1')]));
    const target = await idOf((id) => id.includes('e-1'));
    expect((await discardKept(localStorage, guard(), SUB, P, target)).ok).toBe(true);
    expect(await listEvidence(SUB, P)).toEqual([]);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('a row whose delete fails keeps its act: nothing the person can still see is half gone', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1')]));
    const target = await idOf((id) => id.includes('e-1'));
    ctl.evidenceDeleteFails = true;
    expect((await discardKept(localStorage, guard(), SUB, P, target)).ok).toBe(false);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([evOp('e-1')]);
    expect((await listed())!.total).toBe(1);
  });

  it('a row with no act (its act rebuilt at load) goes alone', async () => {
    await putSitePhotoRow(SUB, P, { clientKey: 's-1', kind: 'progress' } as never);
    const target = await idOf((id) => id === 'row:s-1');
    await discardKept(localStorage, guard(), SUB, P, target);
    expect(await listSitePhotoRows(SUB, P)).toEqual([]);
    expect(await listed()).toBeNull();
  });

  it('a site photo another tab is sending now is left, with its act, and said', async () => {
    await putSitePhotoRow(SUB, P, { clientKey: 's-1', kind: 'progress' } as never);
    const op = { t: 'uploadSitePhoto', scope: SUB, clientKey: 's-1' } as unknown as OutboxOp;
    localStorage.setItem(outbox(), JSON.stringify([op]));
    const release = await holdSitePhotoLock(SUB, P, 's-1'); // another tab sending it now
    const r = await discardKept(localStorage, guard(), SUB, P, null);
    release();
    expect(r.busy).toBe(true);
    expect(await listSitePhotoRows(SUB, P)).toHaveLength(1);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([op]);
  });

  it('a row store that cannot be read writes nothing, and says it could not discard: evidence (Stage 1 U2 G1)', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1'), approve('k-1')]));
    const before = localStorage.getItem(outbox());
    ctl.evidenceListFails = 1;
    expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: false, busy: false, unchecked: false, removed: false });
    expect(localStorage.getItem(outbox())).toBe(before);
    expect(await listEvidence(SUB, P)).toHaveLength(1);
  });

  it('a row store that cannot be read writes nothing: visit files (Stage 1 U2 G1)', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    const before = localStorage.getItem(lane());
    ctl.visitReadFails = 1;
    expect((await discardKept(localStorage, guard(), SUB, P, `visit:${V1}`)).ok).toBe(false);
    expect(localStorage.getItem(lane())).toBe(before);
    expect(await listVisitPhotos(SUB, P)).toHaveLength(1);
  });

  it('a row store that cannot be read writes nothing: site photos (Stage 1 U2 G1)', async () => {
    await putSitePhotoRow(SUB, P, { clientKey: 's-1', kind: 'progress' } as never);
    localStorage.setItem(outbox(), JSON.stringify([{ t: 'uploadSitePhoto', scope: SUB, clientKey: 's-1' }]));
    const before = localStorage.getItem(outbox());
    ctl.siteListFails = 1;
    expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(false);
    expect(localStorage.getItem(outbox())).toBe(before);
    expect(await listSitePhotoRows(SUB, P)).toHaveLength(1);
  });

  it('a row delete that does not answer in time leaves its row, which keeps its act (Stage 1 U2 G4)', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1'), approve('k-1')]));
    let asked: () => void = () => {};
    const deleting = new Promise<void>((r) => { asked = r; });
    ctl.evidenceDeleteHangs = () => asked();
    const discarding = discardKept(localStorage, guard(), SUB, P, null);
    await deleting;
    // the delete's bound ends, by hand
    const bound = timers.armed.filter((t) => t.ms === EVIDENCE_READ_WAIT_MS).at(-1)!;
    bound.fn();
    expect(await discarding).toEqual({ ok: false, busy: false, unchecked: false, removed: true });
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([evOp('e-1')]);
  });

  it('a visit file delete that does not answer in time leaves the file, which keeps its visit’s acts (Stage 1 U2 G4)', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    let asked: () => void = () => {};
    const deleting = new Promise<void>((r) => { asked = r; });
    ctl.visitDeleteHangs = () => asked();
    const discarding = discardKept(localStorage, guard(), SUB, P, `visit:${V1}`);
    await deleting;
    timers.armed.filter((t) => t.ms === EVIDENCE_READ_WAIT_MS).at(-1)!.fn();
    expect((await discarding).ok).toBe(false);
    expect(await listVisitPhotos(SUB, P)).toHaveLength(1);
    // the visit stays whole: its start stays with the file left
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([startOf(V1)]);
  });

  it('a site photo delete that does not answer in time leaves its row, which keeps its act (Stage 1 re-check 3)', async () => {
    await putSitePhotoRow(SUB, P, { clientKey: 's-1', kind: 'progress' } as never);
    const op = { t: 'uploadSitePhoto', scope: SUB, clientKey: 's-1' } as unknown as OutboxOp;
    localStorage.setItem(outbox(), JSON.stringify([op]));
    let asked: () => void = () => {};
    const deleting = new Promise<void>((r) => { asked = r; });
    ctl.siteDeleteHangs = () => asked();
    const discarding = discardKept(localStorage, guard(), SUB, P, null);
    await deleting;
    timers.armed.filter((t) => t.ms === EVIDENCE_READ_WAIT_MS).at(-1)!.fn();
    expect((await discarding).ok).toBe(false);
    expect(await listSitePhotoRows(SUB, P)).toHaveLength(1);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([op]);
  });

  it('a mark that cannot be written: not discarded, still listed, and no done fact left (Stage 1 re-check 1)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    const raw = localStorage.getItem(outbox());
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.settled.')) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(false);
    vi.restoreAllMocks();
    expect(localStorage.getItem(outbox())).toBe(raw);
    expect(keys().filter((k) => k.startsWith('vitan.done.'))).toEqual([]);
    expect((await listed())!.total).toBe(1);
  });

  it('the second mark cannot be written: the discard is undone whole, so a later load takes both acts (Stage 1 re-check 1)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    const raw = localStorage.getItem(outbox());
    const g = guard();
    let marks = 0;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.settled.') && ++marks === 2) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    expect((await discardKept(localStorage, g, SUB, P, null)).ok).toBe(false);
    vi.restoreAllMocks();
    expect(marks).toBe(2);
    expect(localStorage.getItem(outbox())).toBe(raw);
    expect(keys().filter((k) => k.startsWith('vitan.settled.') || k.startsWith('vitan.done.'))).toEqual([]);
    expect((await listed())!.total).toBe(2);
    // this tab does not count the first act as sent: its own write of the key, before any load, keeps both
    expect(g.write(localStorage, outbox(), [approve('k-1'), approve('k-2', 'd-2'), approve('k-3', 'd-3')])).toBe(true);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1'), approve('k-2', 'd-2'), approve('k-3', 'd-3')]);
    expect(g.load(localStorage, outbox())).toEqual([approve('k-1'), approve('k-2', 'd-2'), approve('k-3', 'd-3')]);
  });

  it('a discard’s done facts never push out a fact of an accepted act (Stage 1 re-check 2)', async () => {
    // the budget full of accepted acts' facts, newest numbered highest
    const accepted = Array.from({ length: DONE_CAP }, (_, i) => doneName(outbox(), approve(`acc-${i}`, `d-${i}`)));
    accepted.forEach((name, i) => localStorage.setItem(name, JSON.stringify({ i: queueActIdent(approve(`acc-${i}`, `d-${i}`)), n: i + 1 })));
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(true);
    expect(accepted.every((name) => localStorage.getItem(name) !== null)).toBe(true);
    expect(keys().filter((k) => k.startsWith('vitan.done.'))).toHaveLength(DONE_CAP);
  });

  it('asked again under the locks: the project no longer lost while the discard waited means nothing is written (Stage 1 U2 G6)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    const before = localStorage.getItem(outbox());
    const held = holdQueueLock(outbox());
    await held.has;
    let lost = true;
    const discarding = discardKept(localStorage, guard(), SUB, P, null, () => lost);
    lost = false;
    held.release();
    expect(await discarding).toEqual({ ok: false, busy: false, unchecked: false, removed: false, stale: true });
    expect(localStorage.getItem(outbox())).toBe(before);
  });

  it('a guard that cannot read a key the list read (its scopes not registered) writes nothing, and says so', async () => {
    const op = { t: 'uploadEvidence', scope: SUB, clientKey: 'e-9' } as OutboxOp;
    localStorage.setItem(outbox(), JSON.stringify([op]));
    expect((await discardKept(localStorage, createQueueKeyGuard(), SUB, P, null)).ok).toBe(false);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([op]);
  });

  it('with no lock nothing is written: no row, no act', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1')]));
    const locks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: false, busy: false, unchecked: false, removed: false });
    } finally {
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    }
    expect(await listEvidence(SUB, P)).toHaveLength(1);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([evOp('e-1')]);
  });
});

describe('a site visit is one line', () => {
  it('its acts and its files go together; another visit’s stay', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1), closeOf(V1), startOf(V2)]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    await putVisitPhoto(SUB, P, visitFile('f-2', V2), 'AA==');
    await discardKept(localStorage, guard(), SUB, P, `visit:${V1}`);
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([startOf(V2)]);
    expect((await listVisitPhotos(SUB, P)).map((r) => r.clientKey)).toEqual(['f-2']);
  });

  it('a file carrying its visit’s start: the row goes, and the start is neither listed nor put back', async () => {
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==', startOf(V1) as never);
    expect((await listed())!.total).toBe(2);
    await discardKept(localStorage, guard(), SUB, P, `visit:${V1}`);
    expect(await listVisitPhotos(SUB, P)).toEqual([]);
    expect(await listed()).toBeNull();
  });

  it('removal records that cannot be read: a visit line is not discarded; "Discard all" leaves each visit whole and says so; once they can be read, the visit goes', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    ctl.removalsUnreadable = true;
    expect(await discardKept(localStorage, guard(), SUB, P, `visit:${V1}`)).toEqual({ ok: true, busy: false, unchecked: true, removed: false });
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([startOf(V1)]);
    expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: true, busy: false, unchecked: true, removed: true });
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([startOf(V1)]);
    expect(await listVisitPhotos(SUB, P)).toHaveLength(1);
    // the person tries again once the records can be read: the visit goes whole
    ctl.removalsUnreadable = false;
    expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: true, busy: false, unchecked: false, removed: true });
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([]);
    expect(await listVisitPhotos(SUB, P)).toEqual([]);
    expect(await listed()).toBeNull();
  });
});

describe('"Discard all"', () => {
  it('both keys, made records and copies set aside go', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    const rec = recordBytes([approve('k-2', 'd-2')], 'nonce1');
    localStorage.setItem(recordName(outbox(), [], rec, 'nonce1'), rec);
    localStorage.setItem(`vitan.unreadable.${outbox()}.12-abc`, '[1]');
    await discardKept(localStorage, guard(), SUB, P, null);
    expect(keys().filter((k) => k.startsWith('vitan.made.') || k.startsWith('vitan.unreadable.'))).toEqual([]);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([]);
    expect(await listed()).toBeNull();
  });

  it('a damaged key goes whole; a newer release’s key is never touched', async () => {
    localStorage.setItem(outbox(), '{not a list');
    localStorage.setItem(lane(), JSON.stringify([{ t: 'siteVisitSomethingNewer', idempotencyKey: 'x' }]));
    const lanes = localStorage.getItem(lane());
    const before = (await listed())!;
    expect(before.unreadable).not.toBeNull();
    expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(true);
    expect(localStorage.getItem(outbox())).toBeNull();
    expect(localStorage.getItem(lane())).toBe(lanes);
  });

  it('a damaged lane key stays whole while the visit files cannot be checked, and the person is told (Stage 1 U2 G9)', async () => {
    localStorage.setItem(lane(), '{not a list');
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    ctl.removalsUnreadable = true;
    expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: true, busy: false, unchecked: true, removed: true });
    expect(localStorage.getItem(lane())).toBe('{not a list');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
  });

  it('a made record this version cannot read goes with "Discard all"; a newer release’s record stays', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    const bad = '{not a record';
    localStorage.setItem(recordName(outbox(), [], bad, 'nonce1'), bad);
    const newer = recordBytes([{ t: 'somethingNewer', idempotencyKey: 'x' } as never], 'nonce2');
    const newerName = recordName(outbox(), [], newer, 'nonce2');
    localStorage.setItem(newerName, newer);
    expect((await listed())!.unreadIncluded).toBe(true);
    expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(true);
    expect(keys().filter((k) => k.startsWith('vitan.made.'))).toEqual([newerName]);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
  });

  it('a project whose changes this version can all read says nothing more is included', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    expect((await listed())!.unreadIncluded).toBeUndefined();
    localStorage.setItem(`vitan.unreadable.${outbox()}.12-abc`, '[1]');
    expect((await listed())!.unreadIncluded).toBe(true);
  });
});

describe('this tab’s memory and another tab’s (Stage 1, #1397 §6)', () => {
  it('an act this tab holds stranded is let go by the discard', async () => {
    const g = guard();
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    g.load(localStorage, outbox());
    // the flush's write of the scope it moved off cannot be stored, nor kept in a record: its act is held stranded here
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.')) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    expect(g.keepUnsent(localStorage, outbox(), [approve('k-2', 'd-2')], [], (l) => l)).toBe(false);
    vi.restoreAllMocks();
    expect(g.strandedCount()).toBe(1);
    await discardKept(localStorage, g, SUB, P, null);
    expect(g.strandedCount()).toBe(0);
  });

  /** this tab loads the key, and a write of the scope it moved off cannot be stored: `k-2` is held stranded here */
  function strandOne(g: ReturnType<typeof guard>) {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    g.load(localStorage, outbox());
    const setItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.')) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    expect(g.keepUnsent(localStorage, outbox(), [approve('k-2', 'd-2')], [], (l) => l)).toBe(false);
    spy.mockRestore();
    expect(g.strandedCount()).toBe(1);
  }

  it('access returns in this tab after "Discard all": its load takes nothing discarded, the stranded act included (Stage 1 U2 G3)', async () => {
    const g = guard();
    strandOne(g);
    expect((await discardKept(localStorage, g, SUB, P, null)).ok).toBe(true);
    expect(g.strandedCount()).toBe(0);
    expect(g.load(localStorage, outbox())).toEqual([]);
  });

  it('a damaged key with an act held stranded: "Discard all" lets both go, and a load after takes nothing (Stage 1 U2 G3)', async () => {
    const g = guard();
    strandOne(g);
    localStorage.setItem(outbox(), '{not a list');
    expect((await discardKept(localStorage, g, SUB, P, null)).ok).toBe(true);
    expect(g.strandedCount()).toBe(0);
    expect(g.load(localStorage, outbox())).toEqual([]);
  });

  for (const damaged of [false, true]) {
    it(`after "Discard all"${damaged ? ' of a damaged key' : ''}, an act held stranded later is not let go by this tab’s next write (Stage 1 U2 G3: handed cleared)`, async () => {
      const g = guard();
      strandOne(g);
      // a load hands the stranded act back to memory
      g.load(localStorage, outbox());
      if (damaged) localStorage.setItem(outbox(), '{not a list');
      expect((await discardKept(localStorage, g, SUB, P, null)).ok).toBe(true);
      // access back: this tab loads the key again, a later write of its scope moved off cannot be stored, and its act
      // is held stranded; this tab's next write of the key must keep it held until the key holds it
      localStorage.setItem(outbox(), JSON.stringify([approve('k-5', 'd-5')]));
      g.load(localStorage, outbox());
      const setItem = Storage.prototype.setItem;
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
        if (k.startsWith('vitan.')) throw new DOMException('full', 'QuotaExceededError');
        setItem.call(this, k, v);
      });
      expect(g.keepUnsent(localStorage, outbox(), [approve('k-3', 'd-3')], [], (l) => l)).toBe(false);
      spy.mockRestore();
      expect(g.strandedCount()).toBe(1);
      expect(g.write(localStorage, outbox(), [approve('k-5', 'd-5')])).toBe(true);
      expect(g.strandedCount()).toBe(1);
    });
  }

  it('another tab holding a discarded act in memory: its next write does not put it back', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    const b = guard();
    const memB = b.load(localStorage, outbox());
    const target = await idOf((id) => id.includes('k-1'));
    await discardKept(localStorage, guard(), SUB, P, target);
    b.write(localStorage, outbox(), memB);
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-2', 'd-2')]);
  });
});

describe('one rule for the list and the discard', () => {
  it('takenAs takes, act by act, exactly what normalizeGeneric takes', () => {
    const photo = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', nodeId: 'slab-1' } };
    const legacyMaterials = { t: 'reserveStock', idempotencyKey: 'm-1', body: {} };
    const badMaterials = { t: 'reserveStock', body: {} };
    const acts = [photo, approve('k-1'), legacyMaterials, badMaterials, closeOf(V1), photo, null];
    const scope = outbox();
    const each = takenAs('generic', acts, scope).filter((o) => o !== null);
    expect(each).toEqual(normalizeGeneric(acts.filter((a) => a !== null) as OutboxOp[], scope).ops.filter((o) => o.t !== 'siteVisitClose'));
  });
});

describe('through the store: access is checked afresh, fail closed', () => {
  function signIn(listMemberships: ApiGateway['listMemberships']) {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', lang: 'en' });
    useStore.getState()._setGateway({ project: 'p-a', listMemberships } as unknown as ApiGateway);
  }

  it('not held: discarded, the list re-read, and the name record goes with the last change', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    rememberProjectName(localStorage, SUB, P, 'Gone Tower');
    signIn(vi.fn(async () => [ALPHA] as never));
    expect(await useStore.getState().discardKeptChanges(P, null)).toEqual({ outcome: 'done', busy: false, unchecked: false, removed: true });
    expect(useStore.getState().keptElsewhere).toEqual([]);
    expect(localStorage.getItem(projectNameKey(SUB, P))).toBeNull();
  });

  it('an act naming the person’s scope is discarded (the store registers the lost project’s scopes first)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([{ t: 'uploadEvidence', scope: SUB, clientKey: 'e-9' }, approve('k-1')]));
    signIn(vi.fn(async () => [ALPHA] as never));
    expect((await useStore.getState().discardKeptChanges(P, null)).outcome).toBe('done');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
  });

  it('the person changes while access is checked: nothing is discarded', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    let answer: (v: unknown) => void = () => {};
    signIn(vi.fn(() => new Promise((resolve) => { answer = resolve; })) as never);
    const asked = useStore.getState().discardKeptChanges(P, null);
    useStore.setState({ sessionToken: jwt({ sub: `${SUB}-other`, role: 'pmc', projectId: 'p-a' }) });
    answer([ALPHA]);
    expect((await asked).outcome).toBe('failed');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('the project comes back while the discard waits for the locks: nothing is discarded, and the person is told (Stage 1 U2 G6)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    signIn(vi.fn(async () => [ALPHA] as never));
    const held = holdQueueLock(outbox());
    await held.has;
    const asked = useStore.getState().discardKeptChanges(P, null);
    useStore.setState({ memberships: [ALPHA, GONE] as never });
    held.release();
    expect((await asked).outcome).toBe('held');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('held again: nothing is discarded, and the person is told', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    signIn(vi.fn(async () => [ALPHA, GONE] as never));
    expect((await useStore.getState().discardKeptChanges(P, null)).outcome).toBe('held');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('the access check fails: nothing is discarded', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    signIn(vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await useStore.getState().discardKeptChanges(P, null)).outcome).toBe('unknown');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });

  it('the access check never answers: at its bound nothing is discarded', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    vi.useFakeTimers();
    signIn(vi.fn((signal?: AbortSignal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)); })) as never);
    const asked = useStore.getState().discardKeptChanges(P, null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await asked).outcome).toBe('unknown');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });
});

describe('the list', () => {
  function signIn(listMemberships: ApiGateway['listMemberships']) {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', lang: 'en' });
    useStore.getState()._setGateway({ project: 'p-a', listMemberships } as unknown as ApiGateway);
  }

  it('a line’s Discard asks first, then the line goes and the list says so', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    rememberProjectName(localStorage, SUB, P, 'Gone Tower');
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    await within(list).findByText('2 changes');
    fireEvent.click(within(list).getAllByTestId('kept-discard')[0]);
    const ask = await screen.findByTestId('kept-confirm');
    expect(ask.textContent).toContain('Discard 1 change for Gone Tower? It was never sent and cannot be recovered.');
    expect(ask.textContent).not.toContain(QW.keptConfirmUnreadIncluded.en);
    fireEvent.click(within(ask).getByTestId('kept-confirm-confirm'));
    const said = await screen.findByTestId('kept-said');
    expect(said.textContent).toBe(QW.keptDiscarded.en);
    // the line is gone from the list (read again before the discard answered), and focus is on what it said
    expect(within(list).getByText('1 change')).toBeTruthy();
    expect(document.activeElement).toBe(said);
  });

  it('a project some of whose changes cannot be read offers "Discard all" only', async () => {
    localStorage.setItem(outbox(), '{not a list');
    const rec = recordBytes([approve('k-2', 'd-2')], 'nonce1');
    localStorage.setItem(recordName(outbox(), [], rec, 'nonce1'), rec);
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    await within(list).findByTestId('kept-unreadable');
    expect(within(list).queryAllByTestId('kept-discard')).toEqual([]);
    expect(within(list).getByTestId('kept-discard-all')).toBeTruthy();
    // its confirm says that changes this version cannot read go too
    fireEvent.click(within(list).getByTestId('kept-discard-all'));
    expect((await screen.findByTestId('kept-confirm')).textContent).toContain(QW.keptConfirmUnreadIncluded.en);
  });

  it('a site photo another tab is sending: the list says what is left', async () => {
    await putSitePhotoRow(SUB, P, { clientKey: 's-1', kind: 'progress' } as never);
    localStorage.setItem(outbox(), JSON.stringify([{ t: 'uploadSitePhoto', scope: SUB, clientKey: 's-1' }, approve('k-1')]));
    const release = await holdSitePhotoLock(SUB, P, 's-1');
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    fireEvent.click(await within(list).findByTestId('kept-discard-all'));
    fireEvent.click(within(await screen.findByTestId('kept-confirm')).getByTestId('kept-confirm-confirm'));
    expect((await screen.findByTestId('kept-said')).textContent).toBe(`${QW.keptDiscarded.en} ${QW.keptBusy.en}`);
    release();
  });

  it('visit files that cannot be checked: the list says so, and asks to try again later', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    ctl.removalsUnreadable = true;
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    fireEvent.click(await within(list).findByTestId('kept-discard-all'));
    fireEvent.click(within(await screen.findByTestId('kept-confirm')).getByTestId('kept-confirm-confirm'));
    expect((await screen.findByTestId('kept-said')).textContent).toBe(QW.keptVisitUnchecked.en);
    // the visit's line is still there to discard again
    expect(within(list).getAllByTestId('kept-item').length).toBeGreaterThan(0);
  });

  it('a line another tab discards leaves this tab’s open list: heard by the storage event (Stage 1 U2 G8)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    await within(list).findByText('2 changes');
    // the other tab: its own guard, the same storage
    const target = await idOf((id) => id.includes('k-1'));
    expect((await discardKept(localStorage, guard(), SUB, P, target)).ok).toBe(true);
    const read = useStore.getState().keptElsewhere;
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: outbox(), newValue: localStorage.getItem(outbox()), storageArea: localStorage })); });
    await until((st) => st.keptElsewhere !== read);
    expect(within(list).getByText('1 change')).toBeTruthy();
  });

  it('a row another tab discards leaves this tab’s open list: heard on the person’s channel (Stage 1 U2 G8)', async () => {
    const channels = new Map<string, Set<{ name: string; closed: boolean; onmessage: ((e: { data: unknown }) => void) | null }>>();
    class FakeChannel {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      closed = false;
      readonly name: string;
      constructor(name: string) { this.name = name; const open = channels.get(name) ?? new Set(); open.add(this); channels.set(name, open); }
      postMessage(data: unknown): void { for (const c of channels.get(this.name) ?? []) if (c !== this) queueMicrotask(() => { if (!c.closed) c.onmessage?.({ data }); }); }
      close(): void { this.closed = true; channels.get(this.name)?.delete(this); }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    try {
      await putEvidence({ userScope: SUB, projectId: P, clientKey: 'e-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
      signIn(vi.fn(async () => [ALPHA] as never));
      render(<KeptElsewhereModal onClose={() => {}} />);
      const list = await screen.findByTestId('kept-elsewhere');
      await within(list).findByText(QW.keptKindPhoto.en);
      // the store listens on the person's channel once it checks
      await act(async () => { useStore.getState().keptMayHaveChanged(); await until((st) => st.keptHeard > 0); });
      const heard = useStore.getState().keptHeard;
      // the other tab discards the row, and says so on the person's channel
      expect((await discardKept(localStorage, guard(), SUB, P, null)).ok).toBe(true);
      const read = useStore.getState().keptElsewhere;
      new FakeChannel(`vitan.kept.${SUB}`).postMessage('row');
      await until((st) => st.keptHeard > heard && st.keptElsewhere !== read);
      expect(await screen.findByTestId('kept-none')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a line another tab has already discarded: the list says nothing was left (Stage 1 re-check 4)', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    signIn(vi.fn(async () => [ALPHA] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    await within(list).findByText('2 changes');
    const target = await idOf((id) => id.includes('k-1'));
    // the other tab discards it, unheard here
    expect((await discardKept(localStorage, guard(), SUB, P, target)).ok).toBe(true);
    fireEvent.click(within(list).getAllByTestId('kept-discard')[0]);
    fireEvent.click(within(await screen.findByTestId('kept-confirm')).getByTestId('kept-confirm-confirm'));
    expect((await screen.findByTestId('kept-said')).textContent).toBe(QW.keptNothingLeft.en);
  });

  it('held again: the list says so, and nothing goes', async () => {
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    rememberProjectName(localStorage, SUB, P, 'Gone Tower');
    signIn(vi.fn(async () => [ALPHA, GONE] as never));
    render(<KeptElsewhereModal onClose={() => {}} />);
    const list = await screen.findByTestId('kept-elsewhere');
    fireEvent.click(await within(list).findByTestId('kept-discard-all'));
    fireEvent.click(within(await screen.findByTestId('kept-confirm')).getByTestId('kept-confirm-confirm'));
    expect((await screen.findByTestId('kept-said')).textContent).toBe('You have access to Gone Tower again. These changes will be sent when you open it.');
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([approve('k-1')]);
  });
});
