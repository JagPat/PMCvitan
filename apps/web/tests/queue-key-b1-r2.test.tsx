import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard, queueActIdent } from '@/store/queueKeyGuard';

/**
 * #1099 round 2 (Codex review 5627374834), on step B1a's made records and settled marks. Each forced probe holds
 * another tab's queue lock, so this tab's write waits, and checks what this phone keeps while it waits: after a
 * sign-out, after the page closes (a fresh store module over the same storage, as a reload is), and after a switch.
 * The probes wait on the lock and the gateway's calls, never a clock. Red at ba55d3a: probes/at-ba55d3a.txt.
 */
const USER = 'u-pmc';
const key = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const idents = (list: OutboxOp[]) => list.map(queueActIdent);
const storedKeys = (raw: string | null) => ((JSON.parse(raw ?? '[]') ?? []) as { idempotencyKey?: string }[]).map((o) => o.idempotencyKey);
const named = (prefix: string) => Object.keys(localStorage).filter((x) => x.startsWith(prefix));

type Store = typeof useStore;
function signedIn(store: Store, p: string, gw: Record<string, unknown> = {}, online = false) {
  store.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: p, online });
  store.getState()._setGateway({ project: p, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  store.getState().hydrateOutbox();
}
/** A page opens: a fresh store module over this phone's storage, signed in. A page opened after another is that page
 *  reloaded: the old page's work still waiting (a write for its lock) is never finished. */
async function page(p: string, gw: Record<string, unknown> = {}, online = false): Promise<Store> {
  vi.resetModules();
  const fresh = (await import('@/store/store')).useStore;
  signedIn(fresh, p, gw, online);
  return fresh;
}
/** another tab of this release holds `k`'s queue lock until `release` */
function holdLock(k: string) {
  let release!: () => void;
  const out = new Promise<void>((r) => { release = r; });
  let taken!: () => void;
  const has = new Promise<void>((r) => { taken = r; });
  void navigator.locks.request(`vitan.queue.${k}`, async () => { taken(); await out; });
  return { has, release };
}
/** every write asked for `k`'s lock before this has run */
const lockRan = (k: string) => navigator.locks.request(`vitan.queue.${k}`, () => undefined);
let held: { release: () => void }[] = [];
const realFlush = useStore.getState().flushOutbox;
afterEach(async () => {
  for (const h of held.splice(0)) h.release();
  // a write still waiting for its lock runs now, before the next test's storage
  for (const p of ['p-1', 'p-2']) { await lockRan(key(p)); await lockRan(`vitan.siteVisitQueue.dev:${USER}.${p}`); }
  useStore.setState({ flushOutbox: realFlush });
  vi.restoreAllMocks();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
});

describe('#1099 round 2: an act whose write waits for its lock is on this phone the whole wait', () => {
  it('forced probe (4358855955): an offline act waiting behind another tab comes back after a sign-out and sign-in, while the lock is still held', async () => {
    signedIn(useStore, 'p-1');
    const other = holdLock(key('p-1'));
    held.push(other);
    await other.has;
    s().startActivity('B-1');
    const made = s().outbox.find((o) => o.t === 'startActivity')!;
    s().completeSignOut();
    signedIn(useStore, 'p-1');
    expect(idents(s().outbox)).toEqual([queueActIdent(made)]);
  });

  it('forced probe (page closed while a write waits for its lock): the act is back after the reload', async () => {
    const first = await page('p-1');
    const other = holdLock(key('p-1'));
    held.push(other);
    await other.has;
    first.getState().startActivity('B-1');
    const made = first.getState().outbox.find((o) => o.t === 'startActivity')!;
    // the page closes: its write never runs. The other tab still holds the lock
    const next = await page('p-1');
    expect(idents(next.getState().outbox)).toEqual([queueActIdent(made)]);
  });

  it('forced probe (review-body P1): a sent act is not loaded again by a page closed before the flush removes it, and the flush returns only once it is removed', async () => {
    localStorage.setItem(key('p-1'), JSON.stringify([approve('k-sent')]));
    const approveDecision = vi.fn(async () => null);
    const first = await page('p-1', { approveDecision }, true);
    const other = holdLock(key('p-1'));
    held.push(other);
    await other.has;
    let done = false;
    const flushed = first.getState().flushOutbox().then(() => { done = true; });
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledTimes(1));
    await act(async () => {});
    // the key still holds the sent act (its removal waits for the lock), and the flush has not returned
    expect(storedKeys(localStorage.getItem(key('p-1')))).toEqual(['k-sent']);
    expect(done).toBe(false);
    // a page opened now (the first one closed) does not load it: it is marked settled
    const next = await page('p-1');
    expect(next.getState().outbox).toEqual([]);
    other.release();
    await flushed;
    expect(storedKeys(localStorage.getItem(key('p-1')))).toEqual([]);
    expect(named('vitan.settled.')).toEqual([]);
  });

  it('forced probe (P2 4358855946): a write-ahead act made in one project never starts a flush (with its success line) after a switch to another', async () => {
    signedIn(useStore, 'p-1', { endSiteVisit: vi.fn(async () => null) }, true);
    const lane = `vitan.siteVisitQueue.dev:${USER}.p-1`;
    const other = holdLock(lane);
    held.push(other);
    await other.has;
    act(() => { s().queueSiteVisitAct({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-end-a' } as OutboxOp, 'queued'); });
    // the person moves to project p-2, which has its own queued act
    const approveB = vi.fn(async () => null);
    localStorage.setItem(key('p-2'), JSON.stringify([approve('k-b')]));
    useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
    s()._setGateway({ project: 'p-2', listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), approveDecision: approveB } as unknown as ApiGateway);
    s().hydrateOutbox();
    const afterSwitch: unknown[] = [];
    useStore.setState({ flushOutbox: ((o?: unknown) => { afterSwitch.push(o); return realFlush(o as never); }) as typeof realFlush });
    other.release();
    await act(async () => { await lockRan(lane); await Promise.resolve(); });
    await act(async () => {});
    expect({ startedOnB: afterSwitch.length, sentB: approveB.mock.calls.length }).toEqual({ startedOnB: 0, sentB: 0 });
    // A's act is in its own lane, sent from p-1's next flush
    expect(storedKeys(localStorage.getItem(lane))).toEqual(['k-end-a']);
  });
});

describe('#1099 round 2: the locked writer and B1a (guard)', () => {
  it('ask keeps the acts the key does not hold in a made record; the landed write lets it go', () => {
    localStorage.setItem(key('p-1'), JSON.stringify([approve('k-1')]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key('p-1'));
    const n = g.ask(localStorage, key('p-1'), [approve('k-1'), approve('k-2')]);
    const records = named(`vitan.made.${key('p-1')}.`).map((x) => (JSON.parse(localStorage.getItem(x)!) as OutboxOp[]).map(queueActIdent));
    expect(records).toEqual([[queueActIdent(approve('k-2'))]]);
    g.asked(n);
    expect(g.write(localStorage, key('p-1'), [approve('k-1'), approve('k-2')])).toBe(true);
    expect(named(`vitan.made.${key('p-1')}.`)).toEqual([]);
  });

  it('a write leaves out an act marked settled that memory does not hold, whichever tab marked it, and the mark goes', () => {
    localStorage.setItem(key('p-1'), JSON.stringify([approve('k-1'), approve('k-2')]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key('p-1'));
    // another tab sent k-2 and marked it before writing the key
    expect(createQueueKeyGuard().settled(localStorage, key('p-1'), approve('k-2'))).toBe(true);
    expect(idents(createQueueKeyGuard().load(localStorage, key('p-1')))).toEqual([queueActIdent(approve('k-1'))]);
    // a tab that never held k-2 (it loaded before k-2 was stored, or not at all) writes the key
    expect(createQueueKeyGuard().write(localStorage, key('p-1'), [approve('k-1')])).toBe(true);
    expect(storedKeys(localStorage.getItem(key('p-1')))).toEqual(['k-1']);
    expect(named(`vitan.settled.${key('p-1')}.`)).toEqual([]);
  });

  it('a write with no lock to be had keeps the made record its ask made, so a reload takes the act back', () => {
    localStorage.setItem(key('p-1'), '[]');
    const g = createQueueKeyGuard();
    g.load(localStorage, key('p-1'));
    const n = g.ask(localStorage, key('p-1'), [approve('k-1')]);
    g.asked(n);
    g.unwritten(localStorage, key('p-1'), [approve('k-1')]);
    expect(idents(createQueueKeyGuard().load(localStorage, key('p-1')))).toEqual([queueActIdent(approve('k-1'))]);
  });
});
