import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';

/**
 * WEB-02 B1, unit U1 (Board plan, #1094 6370350429): every write of a stored queue key merges memory into the key as
 * it holds it now, synchronously, in its stored order, with identity counted as a multiset.
 * - Codex 4349463910 (#1086), 4338427583 (#1051), #1071 F3: another tab's act stored after this tab's load was
 *   written over at this tab's next save.
 * - Codex 4344812888 (#1084): this tab's acts went first, so a visit closed here was sent before a guest another tab
 *   added to it earlier.
 * - Codex 4360928298 (#1099 r3): an absent key was read as "every act taken".
 * - Codex 4360928338 (#1099 r3): one held act was written over every identical stored act.
 * - The B1a residual: two identical unkeyed acts shared one settled mark, so the owed second was dropped on reload.
 * Each probe says whether it is red at main 78dcf80 (probes/at-78dcf80.txt). Tests wait on calls, never a clock.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const close = (k: string): OutboxOp => ({ t: 'siteVisitClose', visitId: 'v-1', reason: 'done', idempotencyKey: k });
const guest = (k: string): OutboxOp => ({ t: 'siteVisitAddAttendee', visitId: 'v-1', name: 'Mr Mehta', body: { id: '1c0d9e8f-7a6b-4c5d-9e3f-2a1b0c9d8e7f', guestName: 'Mr Mehta' }, idempotencyKey: k });
/** an act with no idempotency key: its identity is its bytes */
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const stored = (k = key) => JSON.parse(localStorage.getItem(k) ?? 'null') as OutboxOp[] | null;
const keysOf = (k = key) => (stored(k) ?? []).map((o) => (o as { idempotencyKey?: string }).idempotencyKey);
const copies = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${key}.`)).map((x) => JSON.parse(localStorage.getItem(x)!) as unknown[]);
/** this phone's storage, with the queue key refusing every write (storage full) */
const fullFor = (k: string) => ({
  getItem: (n: string) => localStorage.getItem(n),
  setItem: (n: string, v: string) => { if (n === k) throw new DOMException('full', 'QuotaExceededError'); localStorage.setItem(n, v); },
  removeItem: (n: string) => localStorage.removeItem(n),
  key: (n: number) => localStorage.key(n),
  get length() { return localStorage.length; },
});
const marks = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.settled.${key}.`));

type Store = typeof useStore;
function signedIn(st: Store, online = false, gw: Record<string, unknown> = {}) {
  st.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online });
  st.getState()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  st.getState().hydrateOutbox();
}
/** a page opens (or reloads): a fresh store module over this phone's storage, signed in */
async function page(online: boolean, gw: Record<string, unknown> = {}): Promise<Store> {
  vi.resetModules();
  const fresh = (await import('@/store/store')).useStore;
  signedIn(fresh, online, gw);
  return fresh;
}

afterEach(() => {
  vi.restoreAllMocks();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
});

describe('B1 U1: the merge writer (forced probes)', () => {
  it('forced probe (4349463910, 4338427583, #1071 F3): an act another tab stored after this tab loaded the key stays at this tab’s next save', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    signedIn(useStore);
    // another tab adds its act after this tab loaded the key
    localStorage.setItem(key, JSON.stringify([approve('k-a'), approve('k-other')]));
    act(() => { s().startActivity('B-1'); });
    expect(keysOf()).toContain('k-other');
    expect(keysOf()[0]).toBe('k-a');
  });

  it('forced probe (4344812888): a guest another tab added first stays first; this tab’s close goes after it', () => {
    signedIn(useStore);
    localStorage.setItem(lane, JSON.stringify([guest('k-guest')])); // another tab, after this one loaded
    act(() => { s().queueSiteVisitAct(close('k-close'), 'saved offline'); });
    expect(keysOf(lane)).toEqual(['k-guest', 'k-close']);
  });

  it('forced probe (B1a residual, guard): the first of two identical unkeyed acts is sent and marked; the next load still owes the second', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([U, U]));
    expect(g.load(localStorage, key)).toEqual([U, U]);
    expect(g.settled(localStorage, key, U, 1)).toBe(true); // the first is sent
    // a page closed before the flush's end write: the key still holds both
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(g.write(localStorage, key, [U])).toBe(true); // the flush stops on the second; memory holds one
    expect(stored()).toEqual([U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(marks()).toEqual([]);
  });

  it('forced probe (4360928338 and the B1a residual, store): the first of two identical unkeyed acts is sent and the second fails; the key holds one, and a reload sends one', async () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    const submitInspection = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(null);
    const first = await page(true, { submitInspection });
    await first.getState().flushOutbox();
    expect(submitInspection).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([U]);
    const reloaded = await page(true, { submitInspection });
    expect(reloaded.getState().outbox).toEqual([U]);
    await reloaded.getState().flushOutbox();
    expect(submitInspection).toHaveBeenCalledTimes(3);
    expect(stored()).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it('forced probe (B1a residual, the flush’s marks): both identical unkeyed acts are sent and the key cannot be written after; a reload sends neither again', async () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    let full = false;
    const submitInspection = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(async () => { full = true; return null; }).mockResolvedValue(null);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (full && k === key) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    const first = await page(true, { submitInspection });
    await first.getState().flushOutbox();
    expect(submitInspection).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([U, U]); // the end write did not land
    const reloaded = await page(false);
    expect(reloaded.getState().outbox).toEqual([]);
  });
});

describe('B1 U1: the merge writer (guards)', () => {
  it('4360928298: a key another tab cleared before this tab’s write, its storage event not yet heard, gets every memory act back', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([approve('a')]));
    g.load(localStorage, key);
    localStorage.removeItem(key);
    expect(g.write(localStorage, key, [approve('a'), approve('b')])).toBe(true);
    expect(keysOf()).toEqual(['a', 'b']);
  });

  it('4360928298: the same with the storage event heard first', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([approve('a')]));
    g.load(localStorage, key);
    localStorage.removeItem(key);
    g.heard(localStorage, key);
    expect(g.write(localStorage, key, [approve('a'), approve('b')])).toBe(true);
    expect(keysOf()).toEqual(['a', 'b']);
  });

  it('4360928338: memory holding one of two identical unkeyed acts writes one, not two', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([U, U]));
    g.load(localStorage, key);
    expect(g.write(localStorage, key, [U])).toBe(true);
    expect(stored()).toEqual([U]);
  });

  it('R2: an act this tab held that another tab sent and wrote out of the key is not put back by this tab’s next write', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([approve('a'), approve('b')]));
    g.load(localStorage, key);
    localStorage.setItem(key, JSON.stringify([approve('a')])); // another tab sent b and wrote the key without it
    expect(g.write(localStorage, key, [approve('a'), approve('b'), approve('c')])).toBe(true);
    expect(keysOf()).toEqual(['a', 'c']);
  });

  it('a settled act memory does not hold leaves the key, and its mark goes', () => {
    localStorage.setItem(key, JSON.stringify([approve('a'), approve('b')]));
    expect(createQueueKeyGuard().settled(localStorage, key, approve('b'))).toBe(true); // another tab sent b
    expect(createQueueKeyGuard().write(localStorage, key, [approve('a')])).toBe(true); // a tab that never held b
    expect(keysOf()).toEqual(['a']);
    expect(marks()).toEqual([]);
  });

  it('R3 (refused write): memory holding two identical acts where the key holds one copies the second aside, and counts it not kept', () => {
    localStorage.setItem(key, JSON.stringify([U]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    expect(g.write(fullFor(key), key, [U, U])).toBe(false);
    expect(copies()).toEqual([[U]]);
    expect(g.notKeptCount()).toBe(1);
  });

  it('R3 (a later refused write): a further identical act made after the first was copied aside is copied too', () => {
    localStorage.setItem(key, '[]');
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    expect(g.write(fullFor(key), key, [U])).toBe(false);
    expect(g.write(fullFor(key), key, [U, U])).toBe(false);
    expect(copies().map((c) => c.length).sort()).toEqual([1, 2]);
  });

  it('R3 (the flush’s scope-moved write over an unreadable key): two identical unsent acts where the key holds one copy the second aside', () => {
    localStorage.setItem(key, JSON.stringify(['v3:format', U]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    expect(g.keepUnsent(localStorage, key, [U, U], [], (l) => l)).toBe(true);
    expect(copies()).toEqual([[U]]);
  });

  it('R1: a Set aside that is put back changes nothing this tab holds, so a later write still puts its acts back', () => {
    const other = `vitan.siteVisitQueue.dev:${USER}.${P}`;
    const DAMAGED = JSON.stringify(['v3:format', approve('x')]);
    localStorage.setItem(key, DAMAGED);
    localStorage.setItem(other, JSON.stringify([]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    g.load(localStorage, other);
    const st = {
      getItem: (k: string) => localStorage.getItem(k),
      setItem: (k: string, v: string) => { if (k === other) throw new Error('QuotaExceededError'); localStorage.setItem(k, v); },
      removeItem: (k: string) => localStorage.removeItem(k),
      key: (n: number) => localStorage.key(n),
      get length() { return localStorage.length; },
    };
    expect(g.setAside(st, [key])).toBe(true);
    expect(g.writeAll(st, [{ key, mine: [approve('a')], takes: () => true }, { key: other, mine: [close('k-close')], takes: () => true }])).toBe('none');
    expect(localStorage.getItem(key)).toBe(DAMAGED);
    // another tab sets its own copy aside and writes the key empty; this tab's next write puts its act back
    localStorage.setItem(key, '[]');
    expect(g.write(localStorage, key, [approve('a')])).toBe(true);
    expect(keysOf()).toEqual(['a']);
  });
});
