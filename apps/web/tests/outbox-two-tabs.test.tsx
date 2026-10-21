import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ApiGateway } from '@/data/apiGateway';
import type { useStore as UseStore } from '@/store/store';
import { warmImports } from './warm-imports';

/**
 * #1051 r2 gap check: two tabs of this release on one project. Each tab is its own instance of the store module, with
 * its own 'storage' listener, sharing one localStorage; each tab's writes are delivered to the other tab's listener
 * only, as a browser does.
 *
 * G1: when one tab settles an act the other still holds, the holder puts it back once and the settler takes it off
 * again; neither heal puts back an act already put back once, so the two never answer each other's writes for ever. G2: a draft another tab wrote since is merged three ways
 * over the bytes this tab last saw, so a field this tab did not change is the other tab's. G3: two tabs' equivalent
 * coalescing acts are one act at the next load.
 *
 * Every test here fails at fdcd504.
 */

await warmImports(() => import('@/store/store'));

const USER = 'u-eng';
const P1 = 'p-1';
const token = `h.${btoa(JSON.stringify({ sub: USER, exp: 4102444800 }))}.s`;
const key = `vitan.outbox.${USER}.${P1}`;
const draftKey = `vitan.dailyLogDraft.${USER}.${P1}`;
const snap = () => ({
  project: { id: P1, name: P1, short: P1, descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});
const ids = () => (JSON.parse(localStorage.getItem(key) ?? '[]') as { activityId?: string; t: string }[]).map((o) => o.activityId ?? o.t);

type Tab = { name: string; store: typeof UseStore; init: () => object; listeners: ((e: StorageEvent) => void)[] };
let current = 'A';
const writes: { tab: string; key: string; value: string | null }[] = [];
const realSet = Storage.prototype.setItem;
const realRemove = Storage.prototype.removeItem;

/** a tab: a fresh instance of the store module, its storage listener kept for `deliver` */
async function openTab(name: string): Promise<Tab> {
  vi.resetModules();
  const listeners: ((e: StorageEvent) => void)[] = [];
  const add = globalThis.addEventListener.bind(globalThis);
  const spy = vi.spyOn(globalThis, 'addEventListener').mockImplementation(((type: string, fn: EventListener, o?: AddEventListenerOptions) => {
    if (type === 'storage') listeners.push(fn as (e: StorageEvent) => void);
    else add(type, fn, o);
  }) as typeof globalThis.addEventListener);
  const mod = await import('@/store/store');
  spy.mockRestore();
  return { name, store: mod.useStore, init: mod.getInitialState, listeners };
}
/** every write of localStorage is recorded with the tab that made it */
function recordWrites() {
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    realSet.call(this, k, v);
    if (this === localStorage) writes.push({ tab: current, key: k, value: v });
  };
  Storage.prototype.removeItem = function (this: Storage, k: string) {
    realRemove.call(this, k);
    if (this === localStorage) writes.push({ tab: current, key: k, value: null });
  };
}
function as<T>(tab: Tab, run: () => T): T {
  const was = current;
  current = tab.name;
  try { return run(); } finally { current = was; }
}
/** each recorded write delivered to the other tabs' listeners, until none is left or `cap` were delivered */
function deliver(tabs: Tab[], cap = 40): number {
  let delivered = 0;
  while (writes.length > 0 && delivered < cap) {
    const w = writes.shift()!;
    for (const t of tabs) {
      if (t.name === w.tab) continue;
      as(t, () => { for (const l of t.listeners) l(new StorageEvent('storage', { key: w.key, newValue: w.value, storageArea: localStorage })); });
    }
    delivered += 1;
  }
  return delivered;
}
function signIn(tab: Tab, gw: Record<string, unknown> = {}) {
  as(tab, () => {
    tab.store.setState({ ...tab.init(), outbox: [], role: 'engineer', lang: 'en', sessionToken: token, sessionUserId: USER, activeProjectId: P1, online: false });
    tab.store.getState()._setGateway({ startActivity: vi.fn(async () => snap()), ...gw } as unknown as ApiGateway);
    tab.store.getState().hydrateOutbox();
  });
}
const onLog = (t: Tab) => t.store.setState((st) => { st.dailyLog = { ...st.dailyLog!, id: 'LOG-1', submitted: false }; });

afterEach(() => {
  Storage.prototype.setItem = realSet;
  Storage.prototype.removeItem = realRemove;
  writes.length = 0;
  current = 'A';
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1051 r2 check G1: two tabs never answer each other’s writes for ever', () => {
  it('A sends an act B loaded too: B puts it back once, A takes it off again, and the writes end with the key empty', async () => {
    const A = await openTab('A');
    const B = await openTab('B');
    recordWrites();
    signIn(A);
    as(A, () => A.store.getState().startActivity('K'));
    signIn(B); // B's load takes K into its memory too
    writes.length = 0;
    A.store.setState({ online: true });
    await as(A, () => A.store.getState().flushOutbox());
    expect(deliver([A, B])).toBeLessThanOrEqual(3);
    expect(ids()).toEqual([]);
    // B still holds K: counted as not kept there, and sent from there (the server takes a keyed act once)
    expect(B.store.getState().outbox).toHaveLength(1);
    expect(B.store.getState().queueUnkept).toHaveLength(1);
  });

  it('the same when A drops the act for good on a refusal', async () => {
    const A = await openTab('A');
    const B = await openTab('B');
    recordWrites();
    signIn(A, { startActivity: vi.fn(async () => { throw Object.assign(new Error('refused'), { status: 422 }); }) });
    as(A, () => A.store.getState().startActivity('K'));
    signIn(B);
    writes.length = 0;
    A.store.setState({ online: true });
    await as(A, () => A.store.getState().flushOutbox());
    expect(deliver([A, B])).toBeLessThanOrEqual(3);
    expect(ids()).toEqual([]);
  });

  it('each tab settled an act the other still holds: neither puts an act back twice, and the writes end', async () => {
    const busy = () => Object.assign(new Error('busy'), { status: 503 });
    // A sends K and K2, then J meets a busy server (the flush stops); B sends J, then K meets a busy server
    const gwA = { startActivity: vi.fn(async (id: string) => { if (id === 'J') throw busy(); return snap(); }) };
    const gwB = { startActivity: vi.fn(async (id: string) => { if (id === 'K') throw busy(); return snap(); }) };
    const A = await openTab('A');
    const B = await openTab('B');
    recordWrites();
    signIn(A, gwA); signIn(B, gwB);
    as(A, () => A.store.getState().startActivity('K'));
    as(B, () => B.store.getState().startActivity('J')); // B writes its own first: [J, K]
    as(B, () => B.store.getState().hydrateOutbox()); // B holds [J, K]
    as(A, () => A.store.getState().startActivity('K2')); // A writes its own first: [K, K2, J]
    as(A, () => A.store.getState().hydrateOutbox()); // A holds [K, K2, J]
    deliver([A, B], 10);
    writes.length = 0;
    A.store.setState({ online: true });
    current = 'A';
    await A.store.getState().flushOutbox();
    expect(deliver([A, B])).toBeLessThanOrEqual(3);
    B.store.setState({ online: true });
    // every write B's flush makes, after its sends too, is B's
    current = 'B';
    await B.store.getState().flushOutbox();
    current = 'A';
    expect(deliver([A, B])).toBeLessThanOrEqual(3);
    expect(writes).toEqual([]);
  });
});

describe('#1051 r2 check G2: a draft another tab wrote since is merged over what this tab last saw', () => {
  it('a row this tab never changed keeps the other tab’s later count', async () => {
    const A = await openTab('A');
    const B = await openTab('B');
    signIn(A); onLog(A);
    const c0 = A.store.getState().dailyLog!.crew[0].count;
    const c1 = A.store.getState().dailyLog!.crew[1].count;
    as(A, () => A.store.getState().crewStep(0, +1));
    signIn(B); onLog(B);
    as(A, () => A.store.getState().crewStep(0, +1));
    as(B, () => B.store.getState().crewStep(1, +1));
    const after = JSON.parse(localStorage.getItem(draftKey)!);
    expect(after.crewRows['0'].count).toBe(c0 + 2);
    expect(after.crewRows['1'].count).toBe(c1 + 1);
  });

  it('a check-out made in the other tab stays when this tab then changes the crew', async () => {
    const A = await openTab('A');
    const B = await openTab('B');
    signIn(A); onLog(A);
    as(A, () => A.store.getState().checkIn());
    signIn(B); onLog(B);
    as(A, () => A.store.getState().checkOut());
    as(B, () => B.store.getState().crewStep(1, +1));
    const after = JSON.parse(localStorage.getItem(draftKey)!);
    expect(after.checkIn.checkedIn).toBe(false);
  });
});

describe('#1051 r2 check G3: two tabs’ equivalent coalescing acts are one act at the next load', () => {
  it('two tabs each reserve the same stock offline; the next load sends one reservation', async () => {
    const A = await openTab('A');
    const B = await openTab('B');
    recordWrites();
    signIn(A); signIn(B);
    A.store.setState({ capabilities: ['materials'] });
    B.store.setState({ capabilities: ['materials'] });
    as(A, () => A.store.getState().reserveCandidate('ACT-1', 'LOT-1', 'STORE', '5'));
    as(B, () => B.store.getState().reserveCandidate('ACT-1', 'LOT-1', 'STORE', '5'));
    deliver([A, B], 10);
    writes.length = 0;
    const reserveStock = vi.fn(async () => snap());
    const C = await openTab('C');
    signIn(C);
    as(C, () => C.store.getState()._setGateway(new Proxy({ reserveStock, snapshot: async () => snap() } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : k === 'then' ? undefined : async () => null) }) as unknown as ApiGateway));
    C.store.setState({ online: true, capabilities: ['materials'] });
    await C.store.getState().flushOutbox();
    expect(reserveStock).toHaveBeenCalledTimes(1);
  });
});
