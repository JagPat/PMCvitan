import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard, queueActIdent } from '@/store/queueKeyGuard';
import { storedQueue } from './queueWrites';

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
    expect(storedQueue(localStorage.getItem(key)!)).toEqual([]);
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
    expect(storedQueue(localStorage.getItem(key)!)).toEqual([approve('k-1')]);
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('made: an act a record already holds is not recorded again', () => {
    localStorage.setItem(key, '{damaged');
    failingCopies();
    const g = createQueueKeyGuard();
    g.write(localStorage, key, [approve('k-1')]);
    g.write(localStorage, key, [approve('k-1'), approve('k-2')]);
    const records = named(`vitan.made.${key}.`).map((n) => (storedQueue(localStorage.getItem(n)!) as OutboxOp[]).map(queueActIdent)).sort();
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

  it('removed: a write from memory that still holds a settled act does not put it back, and its mark then goes', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const g = createQueueKeyGuard();
    g.settled(localStorage, key, approve('k-1'));
    // L2b (gap check 2): the settled occurrence stays settled while memory holds it, so the write leaves it out; with
    // the key no longer holding it, its mark guards nothing
    expect(g.write(localStorage, key, [approve('k-1')])).toBe(true);
    expect(storedQueue(localStorage.getItem(key))).toEqual([]);
    expect(named(`vitan.settled.${key}.`)).toEqual([]);
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

describe('#1101 round 1 (Codex review 5628535504)', () => {
  const copiesFailFor = (match: (k: string, v: string) => boolean) => {
    const real = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (match(k, v)) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
  };

  it('forced probe (4359759846): a Set aside whose second write fails leaves the first key’s made record, so its act loads after a reload', () => {
    const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
    localStorage.setItem(key, '{damaged');
    localStorage.setItem(lane, '{damaged too');
    // an act beside the general key that no copy could hold: kept in a made record
    const spy = copiesFailFor((k) => k.startsWith('vitan.unreadable.'));
    createQueueKeyGuard().write(localStorage, key, [approve('k-1')]);
    spy.mockRestore();
    expect(named(`vitan.made.${key}.`)).toHaveLength(1);
    // the person's Set aside: both keys copied, the general key written, then the lane's write fails
    const g = createQueueKeyGuard();
    // U3c: the tap re-reads each key through heard, with memory's acts for it, before Set aside copies it
    g.heard(localStorage, key, [approve('k-1')]); g.heard(localStorage, lane);
    expect(g.setAside(localStorage, [key, lane])).toBe('ok');
    copiesFailFor((k, v) => k === lane && v !== '{damaged too');
    expect(g.writeAll(localStorage, [{ key, mine: [approve('k-1')], takes: () => true }, { key: lane, mine: [], takes: () => true }])).toBe('none');
    vi.restoreAllMocks();
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(idents(createQueueKeyGuard().load(localStorage, key))).toEqual([queueActIdent(approve('k-1'))]);
  });

  it('guard: a Set aside whose writes all land removes the made record', () => {
    localStorage.setItem(key, '{damaged');
    const spy = copiesFailFor((k) => k.startsWith('vitan.unreadable.'));
    createQueueKeyGuard().write(localStorage, key, [approve('k-1')]);
    spy.mockRestore();
    const g = createQueueKeyGuard();
    g.heard(localStorage, key, [approve('k-1')]);
    expect(g.setAside(localStorage, [key])).toBe('ok');
    expect(g.writeAll(localStorage, [{ key, mine: [approve('k-1')], takes: () => true }])).toBe('all');
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('forced probe (4359759832): acts kept in successive made records load in the order they were made', () => {
    // the first act made (a visit's start, say) and the one made after it (its end), each refused in turn
    const first = (n: number) => approve(`first-${n}`);
    const then = (n: number) => approve(`then-${n}`);
    copiesFailFor((k) => k.startsWith('vitan.unreadable.'));
    // eight keys, one pair each: with no order kept, the names' hashes put some later acts first
    const keys = Array.from({ length: 8 }, (_, n) => `vitan.outbox.dev:${USER}.p-order-${n}`);
    keys.forEach((k, n) => {
      localStorage.setItem(k, '{damaged');
      const g = createQueueKeyGuard();
      g.write(localStorage, k, [first(n)]);
      g.write(localStorage, k, [first(n), then(n)]);
    });
    vi.restoreAllMocks();
    for (const [n, k] of keys.entries()) {
      expect(named(`vitan.made.${k}.`)).toHaveLength(2);
      expect(idents(createQueueKeyGuard().load(localStorage, k))).toEqual([queueActIdent(first(n)), queueActIdent(then(n))]);
    }
  });

  it('forced probe (4359759858): an act held stranded that the server has is not handed back by the next load', () => {
    const g = createQueueKeyGuard();
    // a scope-moved write with no storage to be had: the unsent act is held stranded
    expect(g.keepUnsent(null, key, [approve('k-1')], [approve('k-1')], (l) => l)).toBe(false);
    // handed back once, sent, and marked settled before the scope moved again
    expect(idents(g.load(localStorage, key))).toEqual([queueActIdent(approve('k-1'))]);
    expect(g.settled(localStorage, key, approve('k-1'))).toBe(true);
    g.forget();
    expect(g.load(localStorage, key)).toEqual([]);
    expect(g.strandedCount()).toBe(0);
  });
});

describe('#1101 round 2 (Codex 4360012661): a mark goes only once nothing it guards is left', () => {
  const failing = (method: 'setItem' | 'removeItem' | 'getItem', match: (k: string) => boolean, how: 'throw' | 'ignore' = 'throw') => {
    const real = Storage.prototype[method] as (...a: unknown[]) => unknown;
    return vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, ...a: unknown[]) {
      if (match(a[0] as string)) {
        if (how === 'throw') throw new DOMException('refused', 'QuotaExceededError');
        return undefined; // a removal that answers but leaves the item
      }
      return real.apply(this, a);
    } as never);
  };
  /** k-1 kept only in a made record (its key unreadable, no copy aside), then sent and marked settled, then the key is
   *  written by another tab without it: the next load's tidy finds the record done */
  const madeThenSettled = () => {
    localStorage.setItem(key, '{damaged');
    const spy = failing('setItem', (k) => k.startsWith('vitan.unreadable.'));
    createQueueKeyGuard().write(localStorage, key, [approve('k-1')]);
    spy.mockRestore();
    expect(createQueueKeyGuard().settled(localStorage, key, approve('k-1'))).toBe(true);
    localStorage.setItem(key, '[]');
  };

  for (const how of ['throw', 'ignore'] as const) {
    it(`forced probe (4360012661, removal ${how === 'throw' ? 'throws' : 'leaves the record'}): the settled mark stays while the made record does, so a reload does not send the act again`, () => {
      madeThenSettled();
      const spy = failing('removeItem', (k) => k.startsWith('vitan.made.'), how);
      expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
      spy.mockRestore();
      expect(named(`vitan.made.${key}.`)).toHaveLength(1);
      // the reload: the record is still there, and so is the act's mark
      const g = createQueueKeyGuard();
      expect(g.load(localStorage, key)).toEqual([]);
      // L2b (plan §2): records and marks go only at a write, under its lock, never at a load. The next write's release
      // removes the record, and then the mark
      expect(g.write(localStorage, key, [])).toBe(true);
      expect(named(`vitan.made.${key}.`)).toEqual([]);
      expect(named(`vitan.settled.${key}.`)).toEqual([]);
    });
  }

  it('audit (a made record that cannot be read when tidied): every mark of the key stays', () => {
    madeThenSettled();
    const spy = failing('getItem', (k) => k.startsWith('vitan.made.'));
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
    spy.mockRestore();
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
  });

  it('audit (a made record a newer release wrote): every mark of the key stays, and the record with it', () => {
    localStorage.setItem(key, '[]');
    createQueueKeyGuard().settled(localStorage, key, approve('k-1'));
    localStorage.setItem(`vitan.made.${key}.1.x`, '{"v":99}');
    createQueueKeyGuard().load(localStorage, key);
    expect(named(`vitan.settled.${key}.`)).toHaveLength(1);
    expect(localStorage.getItem(`vitan.made.${key}.1.x`)).toBe('{"v":99}');
  });

  it('audit (a mark whose removal fails): it stays, and the act it names, held by nothing, loads nowhere', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const g = createQueueKeyGuard();
    g.settled(localStorage, key, approve('k-1'));
    const spy = failing('removeItem', (k) => k.startsWith('vitan.settled.'));
    expect(g.write(localStorage, key, [])).toBe(true);
    spy.mockRestore();
    expect(named(`vitan.settled.${key}.`)).toHaveLength(1);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
  });

  it('forced probe (audit, copies aside): a Set aside whose second write fails keeps the copy aside the first key’s acts were in', () => {
    const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
    localStorage.setItem(key, '{damaged');
    localStorage.setItem(lane, '{damaged too');
    const g = createQueueKeyGuard();
    // a refused write of memory's act: copied aside beside the key
    expect(g.write(localStorage, key, [approve('k-1')])).toBe(false);
    const heldIn = () => named(`vitan.unreadable.${key}.`).filter((n) => localStorage.getItem(n) === JSON.stringify([approve('k-1')]));
    expect(heldIn()).toHaveLength(1);
    g.heard(localStorage, key, [approve('k-1')]); g.heard(localStorage, lane);
    expect(g.setAside(localStorage, [key, lane])).toBe('ok');
    // the lane's write fails, and so would any new copy or record: the put-back key holds k-1 no more
    failing('setItem', (k) => k === lane || k.startsWith('vitan.unreadable.') || k.startsWith('vitan.made.'));
    expect(g.writeAll(localStorage, [{ key, mine: [approve('k-1')], takes: () => true }, { key: lane, mine: [], takes: () => true }])).toBe('none');
    vi.restoreAllMocks();
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(heldIn()).toHaveLength(1);
  });

  it('guard: a Set aside whose writes all land removes the copies aside of acts the key now holds', () => {
    localStorage.setItem(key, '{damaged');
    const g = createQueueKeyGuard();
    g.write(localStorage, key, [approve('k-1')]);
    g.heard(localStorage, key, [approve('k-1')]);
    expect(g.setAside(localStorage, [key])).toBe('ok');
    expect(g.writeAll(localStorage, [{ key, mine: [approve('k-1')], takes: () => true }])).toBe('all');
    expect(named(`vitan.unreadable.${key}.`).filter((n) => localStorage.getItem(n) === JSON.stringify([approve('k-1')]))).toEqual([]);
  });

  it('audit (a made record that storage refuses): the act stays held, counted, and listed not kept', () => {
    localStorage.setItem(key, '{damaged');
    failing('setItem', (k) => k.startsWith('vitan.unreadable.') || k.startsWith('vitan.made.'));
    const g = createQueueKeyGuard();
    expect(g.write(localStorage, key, [approve('k-1')])).toBe(false);
    vi.restoreAllMocks();
    expect(named(`vitan.made.${key}.`)).toEqual([]);
    expect(g.notKept(key)).toEqual([queueActIdent(approve('k-1'))]);
    expect(g.strandedCount() + g.notKeptCount()).toBeGreaterThan(0);
  });

  it('audit (a mark that storage refuses): settled says so, and the act stays in its key under its idempotency key', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const spy = failing('setItem', (k) => k.startsWith('vitan.settled.'));
    expect(createQueueKeyGuard().settled(localStorage, key, approve('k-1'))).toBe(false);
    spy.mockRestore();
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([approve('k-1')]);
  });
});
