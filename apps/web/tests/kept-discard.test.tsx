import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { listEvidence, putEvidence } from '@/data/evidenceStore';
import { holdSitePhotoLock, listSitePhotoRows, putSitePhotoRow } from '@/data/sitePhotoStore';
import { listVisitPhotos, putVisitPhoto } from '@/data/visitPhotoStore';
import { discardKept, projectNameKey, readKeptElsewhere, rememberProjectName } from '@/store/keptElsewhere';
import { normalizeGeneric, takenAs } from '@/store/loadTakes';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { recordBytes, recordName } from '@/store/queueLedger';
import { QW } from '@/lib/queueWords';
import { KeptElsewhereModal } from '@/layout/KeptElsewhere';
import { holdQueueLock, releaseQueueLocks, storedQueue } from './queueWrites';

/**
 * #1388 U2: the person's discard of changes this device keeps for a project they no longer hold. Rows go first, then
 * the acts naming them, under both keys' locks; every other entry stays byte for byte; nothing is discarded on a stale
 * or failed check of access. Every wait is on a held lock, a held request or a settled promise, never a clock (the
 * bound of the access check is advanced on purpose, once).
 */

// the visit store's removal records, made unreadable by a test; and a row delete made to fail
const ctl = vi.hoisted(() => ({ removalsUnreadable: false, evidenceDeleteFails: false }));
vi.mock('@/data/visitPhotoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/visitPhotoStore')>();
  return { ...real, removedVisitPhotos: (...a: Parameters<typeof real.removedVisitPhotos>) => (ctl.removalsUnreadable ? 'unreadable' as const : real.removedVisitPhotos(...a)) };
});
vi.mock('@/data/evidenceStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/evidenceStore')>();
  return { ...real, deleteEvidence: (...a: Parameters<typeof real.deleteEvidence>) => (ctl.evidenceDeleteFails ? Promise.reject(new Error('blocked')) : real.deleteEvidence(...a)) };
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

beforeEach(() => { n += 1; SUB = `d-${n}`; localStorage.clear(); });
afterEach(() => {
  cleanup();
  releaseQueueLocks();
  useStore.setState(getInitialState());
  ctl.removalsUnreadable = false; ctl.evidenceDeleteFails = false;
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
    expect(await discarding).toEqual({ ok: true, busy: false, unchecked: false });
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

  it('with no lock nothing is written: no row, no act', async () => {
    await putEvidence(ev('e-1'));
    localStorage.setItem(outbox(), JSON.stringify([evOp('e-1')]));
    const locks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: false, busy: false, unchecked: false });
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

  it('removal records that cannot be read: a visit line is not discarded; "Discard all" leaves the files and says so', async () => {
    localStorage.setItem(lane(), JSON.stringify([startOf(V1)]));
    localStorage.setItem(outbox(), JSON.stringify([approve('k-1')]));
    await putVisitPhoto(SUB, P, visitFile('f-1', V1), 'AA==');
    ctl.removalsUnreadable = true;
    expect(await discardKept(localStorage, guard(), SUB, P, `visit:${V1}`)).toEqual({ ok: true, busy: false, unchecked: true });
    expect(storedQueue(localStorage.getItem(lane()))).toEqual([startOf(V1)]);
    expect(await discardKept(localStorage, guard(), SUB, P, null)).toEqual({ ok: true, busy: false, unchecked: true });
    expect(storedQueue(localStorage.getItem(outbox()))).toEqual([]);
    expect(await listVisitPhotos(SUB, P)).toHaveLength(1);
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
    expect(await useStore.getState().discardKeptChanges(P, null)).toEqual({ outcome: 'done', busy: false, unchecked: false });
    expect(useStore.getState().keptElsewhere).toEqual([]);
    expect(localStorage.getItem(projectNameKey(SUB, P))).toBeNull();
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
    fireEvent.click(within(ask).getByTestId('kept-confirm-confirm'));
    expect((await screen.findByTestId('kept-said')).textContent).toBe(QW.keptDiscarded.en);
    await waitFor(() => expect(within(list).getByText('1 change')).toBeTruthy());
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
