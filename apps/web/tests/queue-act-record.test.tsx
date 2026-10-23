import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard, queueActIdent } from '@/store/queueKeyGuard';

/**
 * WEB-02 step B1a: each queued act's life is kept on this phone, beside its queue key, at every step.
 * - made: an act its key could not store, and no copy aside could hold, is kept in a made record a load takes back.
 * - written: once its key holds it, the record goes.
 * - settled: the moment the server has it (or refused it for good) it is marked, and a load leaves it out.
 * - removed: once its key no longer holds it, the mark goes.
 * The page-close probes load a fresh copy of the store module over the same storage, as a reloaded page does, while
 * the first page's flush is still under way. Each forced probe fails at 481802c (main): probes/at-481802c.txt.
 */

const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
/** an approval an earlier release queued with no key: it replays unkeyed, so a second send is a second fact */
const unkeyed = { t: 'approve', decisionId: 'd-old', optionIndex: 0 } as OutboxOp;
const idents = (list: OutboxOp[]) => list.map(queueActIdent);
const named = (prefix: string) => Object.keys(localStorage).filter((x) => x.startsWith(prefix));

type Store = typeof useStore;
function signedIn(store: Store, gw: Record<string, unknown> = {}, online = false) {
  store.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online });
  store.getState()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  store.getState().hydrateOutbox();
}
/** A page opens: a fresh store module over this phone's storage, signed in. A page opened after another is that page
 *  reloaded: the old page's work in flight is never finished. */
async function page(gw: Record<string, unknown> = {}, online = false): Promise<Store> {
  vi.resetModules();
  const fresh = (await import('@/store/store')).useStore;
  signedIn(fresh, gw, online);
  return fresh;
}

afterEach(() => {
  vi.restoreAllMocks();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
});

describe('step B1a, page closes: nothing is lost and nothing is sent twice', () => {
  it('forced probe (settled): a page closed while its flush waits on the next act does not send the act already sent again', async () => {
    localStorage.setItem(key, JSON.stringify([unkeyed, approve('k-2')]));
    let secondAsked!: () => void;
    const asked = new Promise<void>((r) => { secondAsked = r; });
    const approveDecision = vi.fn()
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(() => { secondAsked(); return new Promise(() => {}); }); // no answer: the page closes first
    const first = await page({ approveDecision }, true);
    void first.getState().flushOutbox();
    await asked;
    expect(approveDecision).toHaveBeenCalledTimes(2);
    const next = await page();
    // the unkeyed approval the server already has is not loaded again; the one with no answer is, under its key
    expect(idents(next.getState().outbox)).toEqual([queueActIdent(approve('k-2'))]);
  });

  it('forced probe (made): an act no write and no copy aside could keep is back after the page reloads', async () => {
    localStorage.setItem(key, '{damaged');
    const first = await page();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    first.getState().startActivity('B-1');
    const made = first.getState().outbox.find((o) => o.t === 'startActivity')!;
    vi.restoreAllMocks();
    const next = await page();
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(idents(next.getState().outbox)).toEqual([queueActIdent(made)]);
  });

  it('guard: a flush that ends leaves no mark and no record behind', async () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const first = await page({ approveDecision: vi.fn(async () => null) }, true);
    await act(async () => { await first.getState().flushOutbox(); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([]);
    expect(named('vitan.settled.')).toEqual([]);
    expect(named('vitan.made.')).toEqual([]);
  });
});

describe('step B1a: one forced probe per step of an act’s life (guard)', () => {
  const failingCopies = () => {
    const real = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
  };

  it('made: a refused write whose copy aside fails keeps the acts in a made record, and a load takes them back', () => {
    localStorage.setItem(key, '{damaged');
    failingCopies();
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-1')])).toBe(false);
    vi.restoreAllMocks();
    expect(named(`vitan.made.${key}.`)).toHaveLength(1);
    expect(idents(createQueueKeyGuard().load(localStorage, key))).toEqual([queueActIdent(approve('k-1'))]);
  });

  it('made: a copy aside that holds the acts is enough, and no record is made', () => {
    localStorage.setItem(key, '{damaged');
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-1')])).toBe(false);
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('written: once the key holds the acts, their made record goes', () => {
    localStorage.setItem(key, '{damaged');
    failingCopies();
    createQueueKeyGuard().write(localStorage, key, [approve('k-1')]);
    vi.restoreAllMocks();
    localStorage.setItem(key, '[]'); // the person set the bytes aside, or another tab wrote the key
    const g = createQueueKeyGuard();
    expect(g.write(localStorage, key, g.load(localStorage, key))).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([approve('k-1')]);
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('made: an act a record already holds is not recorded again', () => {
    localStorage.setItem(key, '{damaged');
    failingCopies();
    const g = createQueueKeyGuard();
    g.write(localStorage, key, [approve('k-1')]);
    g.write(localStorage, key, [approve('k-1'), approve('k-2')]);
    const records = named(`vitan.made.${key}.`).map((n) => (JSON.parse(localStorage.getItem(n)!) as OutboxOp[]).map(queueActIdent)).sort();
    expect(records).toEqual([[queueActIdent(approve('k-1'))], [queueActIdent(approve('k-2'))]]);
  });

  it('settled: a marked act is not loaded, by this tab or another, while the key still holds it', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1'), approve('k-2')]));
    expect(createQueueKeyGuard().settled(localStorage, key, approve('k-1'))).toBe(true);
    expect(idents(createQueueKeyGuard().load(localStorage, key))).toEqual([queueActIdent(approve('k-2'))]);
  });

  it('removed: once the key no longer holds the act, its mark goes', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1'), approve('k-2')]));
    const g = createQueueKeyGuard();
    g.settled(localStorage, key, approve('k-1'));
    expect(g.write(localStorage, key, [approve('k-2')])).toBe(true);
    expect(named(`vitan.settled.${key}.`)).toEqual([]);
  });

  it('removed: a mark is kept while the key still holds the act (a write from memory that still holds it)', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const g = createQueueKeyGuard();
    g.settled(localStorage, key, approve('k-1'));
    g.write(localStorage, key, [approve('k-1')]);
    expect(named(`vitan.settled.${key}.`)).toHaveLength(1);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
  });

  it('a record this release cannot read loads nothing and is left where it is', () => {
    localStorage.setItem(`vitan.made.${key}.x`, '{damaged');
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
    expect(localStorage.getItem(`vitan.made.${key}.x`)).toBe('{damaged');
  });

  it('a scope-moved write that can neither write nor copy keeps the unsent acts in a made record', () => {
    localStorage.setItem(key, '{damaged');
    failingCopies();
    expect(createQueueKeyGuard().keepUnsent(localStorage, key, [approve('k-1')], [approve('k-1')], (l) => l)).toBe(false);
    vi.restoreAllMocks();
    expect(idents(createQueueKeyGuard().load(localStorage, key))).toEqual([queueActIdent(approve('k-1'))]);
  });
});
