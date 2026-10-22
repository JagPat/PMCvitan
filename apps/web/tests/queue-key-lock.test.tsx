import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { holdQueueLock, nextToast, queueWritten, releaseQueueLocks } from './queueWrites';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { writeQueueKey } from '@/store/queueKeyLock';

/**
 * WEB-02 step B1 (#482 6333415419): every write of a stored queue key runs under one cross-tab lock per key, and merges
 * into the key as it holds it then, in its stored order.
 * - Codex 4344812898: two tabs each read the old list and wrote over each other, and "saved" was said before any write.
 * - Codex 4344812888: a stored act of another tab was placed after every act of this tab, so a close replayed before
 *   the attendee added ahead of it.
 * - Codex 4344812904: a key that turned unreadable on another tab's write left this tab's acts only in memory.
 * - Codex 4344270659: with no lock, nothing is written and the person is told it is not saved.
 *
 * Every test here fails at c385fad (step A).
 */

const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const end = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
const close = (k: string): OutboxOp => ({ t: 'siteVisitClose', visitId: 'v-1', reason: 'done', idempotencyKey: k });
const guest = (k: string): OutboxOp => ({ t: 'siteVisitAddAttendee', visitId: 'v-1', name: 'Mr Mehta', body: { id: '1c0d9e8f-7a6b-4c5d-9e3f-2a1b0c9d8e7f', guestName: 'Mr Mehta' }, idempotencyKey: k });
const keysOf = (k: string) => (JSON.parse(localStorage.getItem(k) ?? '[]') as { idempotencyKey?: string }[]).map((o) => o.idempotencyKey);
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => JSON.parse(localStorage.getItem(x)!) as OutboxOp[]);

function signedIn(stored: { general?: unknown[]; lane?: unknown[] } = {}) {
  if (stored.general) localStorage.setItem(key, JSON.stringify(stored.general));
  if (stored.lane) localStorage.setItem(lane, JSON.stringify(stored.lane));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null) } as unknown as ApiGateway);
  s().hydrateOutbox();
}
const heldElsewhere = holdQueueLock;

/** each flush first reads this phone's visit photos: a test may act once that read is back (a signal) */
const visitReads: (() => void)[] = [];
vi.mock('@/data/visitPhotoStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/data/visitPhotoStore')>();
  return { ...m, listVisitPhotos: (...a: Parameters<typeof m.listVisitPhotos>) => m.listVisitPhotos(...a).then((rows) => { for (const f of visitReads.splice(0)) f(); return rows; }) };
});
const visitRead = () => new Promise<void>((r) => { visitReads.push(r); });
/** every promise job queued so far has run (one task turn, not a duration): what a flush does after its read without
 *  waiting on anything outside this document has happened. "Not sent yet" has no signal of its own. */
const drained = () => new Promise<void>((r) => { setTimeout(r, 0); });

afterEach(() => {
  releaseQueueLocks();
  s().completeSignOut();
  vi.restoreAllMocks();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('WEB-02 step B1: one locked writer per queue key', () => {
  it('4344812898: another tab’s locked read, merge and write never loses this tab’s act, nor this tab its', async () => {
    signedIn();
    // another tab reads the lane under the lock, and writes its act after this tab acted
    const other = heldElsewhere(lane);
    await other.has;
    const read = JSON.parse(localStorage.getItem(lane) ?? '[]') as OutboxOp[];
    act(() => { s().queueSiteVisitAct(end('k-mine'), 'saved offline'); });
    localStorage.setItem(lane, JSON.stringify([...read, guest('k-theirs')]));
    other.release();
    await queueWritten();
    expect(keysOf(lane)).toEqual(['k-theirs', 'k-mine']);
  });

  it('4344812898: “saved” is said only once the act is written on this phone', async () => {
    signedIn();
    const other = heldElsewhere(lane);
    await other.has;
    const said = nextToast();
    act(() => { s().queueSiteVisitAct(end('k-mine'), 'saved offline'); });
    expect(s().toast).toBeNull();
    other.release();
    expect(await said).toBe('saved offline');
    expect(keysOf(lane)).toEqual(['k-mine']);
  });

  it('4344812888: an act another tab stored first stays first; this tab’s close goes after the attendee', async () => {
    signedIn();
    localStorage.setItem(lane, JSON.stringify([guest('k-guest')])); // another tab, after this one loaded
    act(() => { s().queueSiteVisitAct(close('k-close'), 'saved offline'); });
    await queueWritten();
    expect(keysOf(lane)).toEqual(['k-guest', 'k-close']);
  });

  it('4344270659: with no cross-tab lock nothing is written, and the person is told it is not saved yet', async () => {
    signedIn({ general: [] });
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')!;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      const said = nextToast();
      act(() => { s().startActivity('B-1'); });
      expect(await said).toBe('Not saved on this phone yet. Keep Vitan open until it sends.');
      expect(localStorage.getItem(key)).toBe('[]');
      expect(s().outbox.map((o) => o.t)).toEqual(['startActivity']); // still held here, and sent when online
    } finally {
      Object.defineProperty(navigator, 'locks', locks);
    }
  });

  it('4344812904: a key another tab made unreadable gets this tab’s acts it no longer holds copied aside beside it', async () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('k-mine'), 'saved offline'); });
    await queueWritten();
    const newer = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]);
    localStorage.setItem(lane, newer);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: lane, storageArea: localStorage })); });
    expect(localStorage.getItem(lane)).toBe(newer);
    expect(copiesOf(lane)).toEqual([[end('k-mine')]]);
    expect(s().queueUnreadable).toEqual([{ key: lane, read: 'newer', reloaded: false }]);
  });

  it('gap-check A: a scope switch before the lock is granted does not keep an act this tab sent in the old key', async () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    const legacy = { t: 'approve', decisionId: 'DL-9', optionIndex: 1 } as OutboxOp; // no key: sent again would be a second effect
    st.setItem(key, JSON.stringify([legacy]));
    const q = createQueueKeyGuard();
    q.load(st, key);
    // the flush sent it; its write of [] waits behind another tab, and the scope moves meanwhile
    const other = heldElsewhere(key);
    await other.has;
    const written = writeQueueKey(q, st, key, []);
    q.forget();
    q.load(st, 'vitan.outbox.dev:u-pmc.p-2');
    other.release();
    expect(await written).toBe(true);
    expect(st.getItem(key)).toBe('[]');
  });

  it('gap-check C2 (C2b): a drawing publish is sent only once its locked write has stored it', async () => {
    signedIn({ general: [] });
    let atSend: string | null | undefined;
    let sent!: () => void;
    const send = new Promise<void>((r) => { sent = r; });
    const publishDrawing = vi.fn(async () => { atSend ??= localStorage.getItem(key); sent(); return null; });
    s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), publishDrawing } as unknown as ApiGateway);
    const other = heldElsewhere(key);
    await other.has;
    const read = visitRead();
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.drawings = [{ id: 'DWG-1', number: 'A-1', draft: true, current: { id: 'r' }, revisions: [] } as never]; });
    act(() => { s().publishAllDrafts(); });
    await read; // the flush has read; its write still waits behind the other tab
    await drained();
    other.release();
    await send;
    expect((JSON.parse(atSend ?? '[]') as { t: string }[]).map((o) => o.t)).toEqual(['publishDrawing']);
  });

  it('gap-check C (C2b): an act whose write waits behind another tab is not sent by an earlier act’s flush', async () => {
    signedIn({ general: [] });
    let atSend: string | null | undefined;
    let sent!: () => void;
    const send = new Promise<void>((r) => { sent = r; });
    const publishDrawing = vi.fn(async () => { atSend ??= localStorage.getItem(key); sent(); return null; });
    s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), startDailyLog: vi.fn(async () => null), publishDrawing } as unknown as ApiGateway);
    const first = heldElsewhere(key);
    await first.has;
    useStore.setState({ online: true });
    act(() => { s().startDailyLog(); }); // its write waits behind the other tab
    const second = heldElsewhere(key); // the other tab asks again, ahead of the next write
    useStore.setState((st) => { st.projectLoadState = 'ready'; st.drawings = [{ id: 'DWG-1', number: 'A-1', draft: true, current: { id: 'r' }, revisions: [] } as never]; });
    act(() => { s().publishAllDrafts(); }); // its write waits behind that
    const read = visitRead();
    first.release();
    await second.has;
    await read; // the first act's flush has read; the publish's write still waits
    await drained();
    second.release();
    await send;
    expect((JSON.parse(atSend ?? '[]') as { t: string }[]).map((o) => o.t)).toContain('publishDrawing');
  });

  it('gap-check P3: a write asked for before the key is loaded again judges by its ask, and leaves what that load knows', async () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    const legacy = { t: 'approve', decisionId: 'DL-9', optionIndex: 1 } as OutboxOp;
    st.setItem(key, JSON.stringify([legacy]));
    const q = createQueueKeyGuard();
    q.load(st, key);
    const other = heldElsewhere(key);
    await other.has;
    const stale = writeQueueKey(q, st, key, []); // asked for before the same scope is loaded again
    q.load(st, key); // the load holds the act again
    other.release();
    expect(await stale).toBe(true);
    expect(st.getItem(key)).toBe('[]'); // a stale write judges by what this tab held when it asked: the act it sent goes
    st.setItem(key, '[]'); // another tab sends it
    expect(await writeQueueKey(q, st, key, [legacy])).toBe(true);
    expect(st.getItem(key)).toBe('[]'); // not put back: the load's knowledge stood
  });

  describe('re-check: a write asked for before a load or a scope move', () => {
    const P2 = 'vitan.outbox.dev:u-pmc.p-2';
    const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
    const ks = (st: ReturnType<typeof mem>) => (JSON.parse(st.getItem(key) ?? '[]') as { idempotencyKey: string }[]).map((o) => o.idempotencyKey);
    const appr = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'DL-1', optionIndex: 0, idempotencyKey: k });

    it('R-B1: it does not put back an act another tab sent before this tab loaded the key again', async () => {
      const st = mem();
      st.setItem(key, JSON.stringify([appr('x')]));
      const [A, B] = [createQueueKeyGuard(), createQueueKeyGuard()];
      A.load(st, key);
      B.load(st, key);
      const other = heldElsewhere(key);
      await other.has;
      const written = writeQueueKey(A, st, key, [appr('x'), appr('n')]); // A adds n, and waits for the lock
      st.setItem(key, '[]'); // meanwhile B, holding the lock, sends x and takes it off
      B.write(st, key, []);
      A.forget(); A.load(st, P2); A.forget(); A.load(st, key); // A switches away and back
      other.release();
      expect(await written).toBe(true);
      expect(ks(st)).toEqual(['n']);
    });

    it('R-B2: it still removes an act this tab sent before it asked', async () => {
      const st = mem();
      st.setItem(key, JSON.stringify([appr('y'), appr('z')]));
      const A = createQueueKeyGuard();
      A.load(st, key);
      const other = heldElsewhere(key);
      await other.has;
      const written = writeQueueKey(A, st, key, [appr('z')]); // A sent y
      A.forget(); A.load(st, P2); A.forget(); A.load(st, key); // loaded again before the lock: y is still stored
      other.release();
      await written;
      expect(ks(st)).toEqual(['z']);
    });

    it('R-C1: a write of a key not loaded since the memory went deletes no act this tab never took', async () => {
      const st = mem();
      st.setItem(key, JSON.stringify([appr('a')]));
      const A = createQueueKeyGuard();
      A.load(st, key); // on this project: a is stored and held
      A.forget(); A.load(st, P2); // another project: memory is its now
      A.forget(); // back (or the same person signs in again), before the load runs
      expect(await writeQueueKey(A, st, key, [appr('p2act')])).toBe(true);
      expect(ks(st)).toEqual(['a', 'p2act']);
    });
  });
});
