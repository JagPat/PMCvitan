import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { ledgerTag, sidecarName } from '@/store/queueLedger';
import { queueActIdent } from '@/store/queueActIdent';
import { dailyLogCommandInFlight } from '@/store/dailyLogPending';
import { queueWritten, releaseQueueLocks, storedQueue, unwatchFlushes, watchFlushes } from './queueWrites';

/**
 * xtab-drain redesign U2 (`notes/site-visits/web-02-U3/xtab-drain/redesign/plan.md` rev 3 §2.1, §2.2, §3 U2): a done
 * fact `vitan.done.<lane key>.<tag>` is written when this phone has the server's answer for an act with a key or a
 * photo's client key (sent, or refused for good), and the flush asks it before each send. A done act is not sent; it
 * leaves through the flush's own settle effects. Facts are kept to a per-person budget and always give way to a queue
 * write. Absence is never evidence: a key that no longer holds an act, with no fact, sends it.
 * The other tab is a second queue key guard on the same storage. Rows wait on storage events, queue locks and the
 * store's flush calls, never a clock; acts are found by identity.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const otherPerson = `vitan.outbox.dev:u-other.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const OTHER = approve('k-other');
const DAMAGED = '{damaged';
/** an act with no idempotency key: its identity is its bytes */
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const VID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
const end = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: VID, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
const start = { t: 'siteVisitStart', idempotencyKey: 'k-s', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null }, body: { id: VID, claimedAt: '2026-10-14T04:30:00.000Z' } } as unknown as OutboxOp;
const keysIn = (raw: string | null) => storedQueue<{ idempotencyKey?: string; t?: string }>(raw).map((o) => o.idempotencyKey ?? o.t);
const snap = (dailyLog: unknown = null) => ({ project: { id: P, name: 'P', short: 'P', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 }, decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false, drawings: [], phases: [], dailyLog, notifications: [], companies: [], nodes: [], photos: [], materials: [] });
const facts = () => Object.keys(localStorage).filter((n) => n.startsWith('vitan.done.'));
const factOf = (name: string) => JSON.parse(localStorage.getItem(name) ?? 'null') as { i: string; n: number; r?: 1 } | null;
/** the fact's name and how it reads, spelled out here (plan rev 3 §2.1), so the rows run against a base without them */
const doneName = (k: string, o: OutboxOp) => `vitan.done.${k}.${ledgerTag(queueActIdent(o))}`;
const doneOf = (_st: Storage, k: string, o: OutboxOp): 'sent' | 'refused' | null => {
  const f = factOf(doneName(k, o));
  return f && f.i === queueActIdent(o) && !queueActIdent(o).startsWith('json:') ? (f.r === 1 ? 'refused' : 'sent') : null;
};
const DONE_CAP = 1000;
const DONE_REFUSALS = 500;
const sentWith = (fn: ReturnType<typeof vi.fn>, k: string) => fn.mock.calls.filter((c) => JSON.stringify(c).includes(k)).length;

function signedIn(general: string | null, visits: string | null = null, gw: Record<string, unknown> = {}) {
  if (general !== null) localStorage.setItem(key, general);
  if (visits !== null) localStorage.setItem(lane, visits);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab writes `k` (null bytes: removes it), and this tab hears it */
function otherTabWrites(k: string, raw: string | null) {
  if (raw === null) localStorage.removeItem(k); else localStorage.setItem(k, raw);
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: raw, storageArea: localStorage })); });
}
const hear = (k = key) => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: localStorage.getItem(k), storageArea: localStorage })); }); };
/** storage throws `err` for each `setItem` that `full` names, while it does */
function storeFull(full: (name: string) => boolean, err: () => unknown = () => new DOMException('full', 'QuotaExceededError')) {
  const real = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
    if (full(name)) throw err();
    return real.call(this, name, value);
  });
}

let flushes: ReturnType<typeof watchFlushes>;
const online = async () => { await flushes.atRest(); useStore.setState({ online: true }); await act(async () => { await s().flushOutbox(); }); await flushes.atRest(); };
beforeEach(() => { flushes = watchFlushes(); });
afterEach(async () => {
  vi.restoreAllMocks();
  releaseQueueLocks();
  await flushes.atRest();
  unwatchFlushes();
  s().completeSignOut();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('the flush settles an act another tab has the server\'s answer for (xtab-drain redesign U2)', () => {
  /** the key holds `acts`, as a tab of this release wrote them; this tab loads them, and so does the other tab. A
   *  damaged interlude: a hand damages the key (this tab hears it and withholds its acts), and the other tab sets it
   *  aside and writes its memory back; with `tap`, this tab's own tap comes after that write and stops */
  const begin = async (gw: Record<string, unknown>, interlude: 'none' | 'aside' | 'tap', acts: OutboxOp[] = [approve('k-a')]) => {
    expect(createQueueKeyGuard().write(localStorage, key, acts)).toBe(true);
    signedIn(null, null, gw);
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(theirs.length).toBe(acts.length);
    if (interlude !== 'none') {
      otherTabWrites(key, DAMAGED);
      other.heard(localStorage, key, theirs);
      expect(other.setAside(localStorage, [key])).toBe('ok');
      expect(other.writeAll(localStorage, [{ key, mine: theirs, takes: () => true }])).toBe('all');
      if (interlude === 'tap') await act(async () => { await s().setAsideUnreadableQueue(); });
      hear();
    }
    return { other, theirs };
  };

  for (const interlude of ['none', 'aside', 'tap'] as const) {
    const I = { none: '', aside: ' (F7: after the key was damaged and the other tab set it aside)', tap: ' (F7: the same, with this tab\'s tap stopped)' }[interlude];
    it(`forced probe F1: another tab sent k-a and drained the key; this tab, online, does not send it${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      const { other } = await begin({ approveDecision }, interlude);
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [])).toBe(true);
      hear();
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(0);
      expect(keysIn(localStorage.getItem(key))).toEqual([]);
      expect(s().outbox).toEqual([]);
    });

    it(`forced probe F2: another tab sent k-a and stored k-other; this tab sends neither, and k-other stays${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      const { other } = await begin({ approveDecision }, interlude);
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [OTHER])).toBe(true);
      hear();
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(0);
      expect(sentWith(approveDecision, 'k-other')).toBe(0);
      expect(keysIn(localStorage.getItem(key))).toEqual(['k-other']);
    });
  }

  it('forced probe F6: another tab refused k-a for good and drained; this tab does not send it', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'), true)).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(s().outbox).toEqual([]);
  });

  it('forced probe T3b (Stage 1, 30963a9a): another tab loads this tab\'s own new act, sends it and drains; this tab does not send it', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn(null, null, { startActivity });
    s().startActivity('B-1');
    await queueWritten();
    const C = createQueueKeyGuard();
    const theirs = C.load(localStorage, key);
    expect(theirs.length).toBe(1);
    expect(C.settled(localStorage, key, theirs[0])).toBe(true);
    expect(C.write(localStorage, key, [])).toBe(true);
    hear();
    await online();
    expect(startActivity).not.toHaveBeenCalled();
  });

  it('forced probe (chain): after the drain two more tabs write the key twice; k-a is still not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    const C = createQueueKeyGuard(); C.load(localStorage, key);
    expect(C.write(localStorage, key, [approve('k-c')])).toBe(true); hear();
    const D = createQueueKeyGuard(); const dMem = D.load(localStorage, key);
    expect(D.write(localStorage, key, [...dMem, approve('k-d')])).toBe(true); hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (no event): the drain is never heard; k-a is not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(other.write(localStorage, key, [OTHER])).toBe(true);
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (closed before its drain): another tab sent k-a and its page closed before it wrote the key; k-a is not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (removal): after the drain a hand removes the key; k-a is not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    otherTabWrites(key, null);
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (R-a): after the drain raw bytes with no write token are written; k-a is not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    const { other } = await begin({ approveDecision }, 'none');
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    otherTabWrites(key, JSON.stringify([OTHER]));
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (site-visit lane, gap 3): a visit act another tab sent from the lane is not sent by this tab\'s flush', async () => {
    const endSiteVisit = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, lane, [end('k-v')])).toBe(true);
    signedIn(null, null, { endSiteVisit });
    expect(s().outbox.map((o) => o.t)).toEqual(['siteVisitEnd']);
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, lane);
    expect(other.settled(localStorage, lane, theirs[0])).toBe(true);
    expect(other.write(localStorage, lane, [])).toBe(true);
    hear(lane);
    await online();
    expect(endSiteVisit).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([]);
  });

  for (const earlier of [false, true]) {
  it(`forced probe (4383486364, freeze): another tab sent this tab's queued daily log send; the flush skips it, and the log stays read-only until the read after it lands${earlier ? ' (Stage 1 U2 gap 3: not cleared by the snapshot of an act this flush sent before it, whose read began earlier)' : ''}`, async () => {
    const send = { t: 'submitDailyLog', log: { checkedIn: true, checkinTime: '09:00', progress: 3, crew: [] }, idempotencyKey: 'k-log' } as unknown as OutboxOp;
    let land!: (v: unknown) => void;
    const read = new Promise((r) => { land = r; });
    const snapshot = vi.fn(() => read);
    const submitDailyLog = vi.fn(async () => snap());
    const approveDecision = vi.fn(async () => snap());
    const acts = earlier ? [approve('k-first'), send] : [send];
    expect(createQueueKeyGuard().write(localStorage, key, acts)).toBe(true);
    signedIn(null, null, { snapshot, submitDailyLog, approveDecision });
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(other.settled(localStorage, key, theirs[acts.length - 1])).toBe(true);
    expect(other.write(localStorage, key, theirs.slice(0, -1))).toBe(true);
    hear();
    expect(dailyLogCommandInFlight(s())).toBe(true);
    let landed = false;
    const gaps: string[] = [];
    const stop = useStore.subscribe((st) => { if (!landed && !dailyLogCommandInFlight(st)) gaps.push('the log is offered before its read'); });
    await online();
    expect(submitDailyLog).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([]);
    expect(snapshot).toHaveBeenCalled(); // the read after the send is asked for
    expect(dailyLogCommandInFlight(s())).toBe(true);
    landed = true;
    land(snap({ date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: true, progress: 3, crew: [], materials: [], photos: [] }));
    await flushes.atRest();
    await act(async () => { await read; });
    stop();
    expect(gaps).toEqual([]);
    expect(dailyLogCommandInFlight(s())).toBe(false);
    if (earlier) expect(sentWith(approveDecision, 'k-first')).toBe(1);
  });
  }

  it('forced probe (4383486361, pending): a flush that stops on a failed send neither counts nor keys a done act after the stop as pending', async () => {
    const approveDecision = vi.fn(async (_d: string, _i: number, k: string) => { if (k === 'k-first') throw new TypeError('Failed to fetch'); return null; });
    const { other, theirs } = await begin({ approveDecision }, 'none', [approve('k-first'), approve('k-a')]);
    expect(other.settled(localStorage, key, theirs[1])).toBe(true);
    expect(other.write(localStorage, key, [theirs[0]])).toBe(true);
    hear();
    await flushes.atRest();
    useStore.setState({ online: true });
    let out: Awaited<ReturnType<ReturnType<typeof s>['flushOutbox']>> | undefined;
    await act(async () => { out = await s().flushOutbox(); });
    await flushes.atRest();
    expect(out && 'pendingKeys' in out ? out.pendingKeys : null).toEqual(['k-first']);
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual(['k-first']);
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });

  it('forced probe (4382389288, module): a done materials act frees its pending key, and the materials are read again', async () => {
    const materialReadiness = vi.fn(async () => ({ activities: [], shortages: [] }));
    const reserveStock = vi.fn(async () => ({}));
    signedIn(null, null, {
      materialReadiness, reserveStock,
      materialRequirements: vi.fn(async () => ({ requirements: [] })),
      materialRequisitions: vi.fn(async () => ({ requisitions: [] })),
      materialPurchaseOrders: vi.fn(async () => ({ purchaseOrders: [] })),
      materialStock: vi.fn(async () => ({ lots: [] })),
      materialIssues: vi.fn(async () => ({ issues: [] })),
    });
    useStore.setState({ capabilities: ['materials'] });
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    await queueWritten();
    expect(s().materialsPending).toHaveLength(1);
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(other.settled(localStorage, key, theirs[0])).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    materialReadiness.mockClear();
    await online();
    expect(reserveStock).not.toHaveBeenCalled();
    expect(s().materialsPending).toEqual([]);
    expect(materialReadiness).toHaveBeenCalled();
  });

  it('forced probe (gap 2): a fact write that throws never stops the drain; this tab\'s next landed write writes it', async () => {
    const approveDecision = vi.fn(async () => null);
    let blocked = true;
    storeFull((n) => blocked && n.startsWith('vitan.done.'));
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
    expect(keysIn(localStorage.getItem(key))).toEqual([]);
    expect(s().outbox).toEqual([]);
    expect(facts()).toEqual([]);
    blocked = false;
    useStore.setState({ online: false });
    s().startActivity('B-1');
    await queueWritten();
    expect(factOf(doneName(key, approve('k-a')))?.i).toBe('k:k-a');
  });
});

describe('done facts are written beside the mark, and kept to the person\'s budget (U2)', () => {
  const seed = (k: string, n: number, refused = false, tag = `t${n}`) => localStorage.setItem(`vitan.done.${k}.${tag}`, JSON.stringify(refused ? { i: `k:${tag}`, n, r: 1 } : { i: `k:${tag}`, n }));
  /** this tab sends k-new and drains: its fact is written, and the release pass prunes */
  const sendOne = () => {
    const A = createQueueKeyGuard();
    A.load(localStorage, key);
    const k = approve('k-new');
    expect(A.write(localStorage, key, [k])).toBe(true);
    expect(A.settled(localStorage, key, k)).toBe(true);
    expect(A.write(localStorage, key, [])).toBe(true);
  };
  const mine = () => facts().filter((n) => n.startsWith(`vitan.done.vitan.outbox.dev:${USER}.`) || n.startsWith(`vitan.done.vitan.siteVisitQueue.dev:${USER}.`));

  it('forced probe: settled writes the fact at once, numbered one past the person\'s newest, in either lane', () => {
    seed(lane, 7);
    seed(otherPerson, 50);
    const A = createQueueKeyGuard();
    A.load(localStorage, key);
    expect(A.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(factOf(doneName(key, approve('k-a')))).toEqual({ i: 'k:k-a', n: 8 });
    expect(A.settled(localStorage, key, approve('k-b'), true)).toBe(true);
    expect(factOf(doneName(key, approve('k-b')))).toEqual({ i: 'k:k-b', n: 9, r: 1 });
    expect(doneOf(localStorage, key, approve('k-b'))).toBe('refused');
  });

  it('forced probe (prune boundary): at the cap, one more fact prunes exactly the oldest success fact; an older refusal outlives newer successes', () => {
    seed(key, 1, true);
    for (let n = 2; n <= DONE_CAP; n += 1) seed(n % 2 ? key : lane, n);
    expect(mine()).toHaveLength(DONE_CAP);
    sendOne();
    expect(mine()).toHaveLength(DONE_CAP);
    expect(localStorage.getItem(`vitan.done.${lane}.t2`)).toBeNull();
    expect(localStorage.getItem(`vitan.done.${key}.t1`)).not.toBeNull();
    expect(localStorage.getItem(`vitan.done.${key}.t3`)).not.toBeNull();
    expect(factOf(doneName(key, approve('k-new')))?.n).toBe(DONE_CAP + 1);
  });

  it('forced probe (prune boundary): refusal facts past half the cap go, oldest first, before any success fact', () => {
    for (let n = 1; n <= DONE_REFUSALS + 3; n += 1) seed(key, n, true);
    seed(key, 900);
    sendOne();
    const left = mine().map((n) => factOf(n)!);
    expect(left.filter((f) => f.r === 1)).toHaveLength(DONE_REFUSALS);
    expect(left.filter((f) => f.r === 1).map((f) => f.n).sort((a, b) => a - b)[0]).toBe(4);
    expect(localStorage.getItem(`vitan.done.${key}.t900`)).not.toBeNull();
  });

  it('guard (prune boundary): another person\'s facts, and other names, are never pruned', () => {
    seed(otherPerson, 0);
    seed('vitan.siteVisitQueue.dev:u-other.p-2', 0, true);
    localStorage.setItem(`vitan.done.vitan.outbox.dev:${USER}x.${P}.t0`, JSON.stringify({ i: 'k:x', n: 0 }));
    localStorage.setItem(`vitan.settled.${otherPerson}.t.o1`, 'k:x');
    localStorage.setItem(`vitan.made.${otherPerson}.1.n.t`, '[]');
    for (let n = 1; n <= DONE_CAP; n += 1) seed(key, n);
    sendOne();
    expect(mine()).toHaveLength(DONE_CAP);
    expect(localStorage.getItem(`vitan.done.${otherPerson}.t0`)).not.toBeNull();
    expect(localStorage.getItem('vitan.done.vitan.siteVisitQueue.dev:u-other.p-2.t0')).not.toBeNull();
    expect(localStorage.getItem(`vitan.done.vitan.outbox.dev:${USER}x.${P}.t0`)).not.toBeNull();
    expect(localStorage.getItem(`vitan.settled.${otherPerson}.t.o1`)).toBe('k:x');
    expect(localStorage.getItem(`vitan.made.${otherPerson}.1.n.t`)).toBe('[]');
  });
});

describe('done facts always give way to a queue write (U2, gap 2)', () => {
  it('forced probe (Stage 1 U2 gap 2, C6: made record): a record write that meets a full store removes facts and keeps the act', () => {
    for (let n = 1; n <= 3; n += 1) localStorage.setItem(`vitan.done.${otherPerson}.s${n}`, JSON.stringify({ i: `k:s${n}`, n }));
    const A = createQueueKeyGuard();
    A.load(localStorage, key);
    localStorage.setItem(key, DAMAGED); // never written over: the act is copied aside, else kept in a made record
    storeFull((n) => (n.startsWith('vitan.made.') && facts().length > 0) || n.startsWith('vitan.unreadable.'));
    expect(A.write(localStorage, key, [approve('k-a')])).toBe(false);
    vi.restoreAllMocks();
    const made = Object.keys(localStorage).filter((n) => n.startsWith(`vitan.made.${key}.`));
    expect(made.map((n) => keysIn(localStorage.getItem(n)))).toEqual([['k-a']]);
    expect(facts()).toEqual([]);
  });

  const seedFacts = (successes: number, refusals: number) => {
    for (let n = 1; n <= successes; n += 1) localStorage.setItem(`vitan.done.${otherPerson}.s${n}`, JSON.stringify({ i: `k:s${n}`, n }));
    for (let n = 1; n <= refusals; n += 1) localStorage.setItem(`vitan.done.${key}.r${n}`, JSON.stringify({ i: `k:r${n}`, n, r: 1 }));
  };
  const refusalsLeft = () => facts().filter((n) => factOf(n)?.r === 1).length;
  /** this tab queues an act offline; its write must land in the key */
  const queueOne = async () => {
    signedIn(null);
    s().startActivity('B-1');
    await queueWritten();
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(storedQueue<{ t: string }>(localStorage.getItem(key)).map((o) => o.t)).toEqual(['startActivity']);
  };

  it('forced probe (give-way): a queue key write that meets a full store removes success facts and keeps the act; refusal facts stay', async () => {
    seedFacts(3, 2);
    storeFull((n) => n === key && facts().some((f) => factOf(f)?.r !== 1));
    await queueOne();
    expect(refusalsLeft()).toBe(2);
    expect(facts()).toHaveLength(2);
  });

  it('forced probe (not enough): removing success facts is not enough, so refusal facts go too, and the write lands', async () => {
    seedFacts(2, 2);
    storeFull((n) => n === key && facts().length > 0);
    await queueOne();
    expect(facts()).toEqual([]);
  });

  it('forced probe (sidecar): a sidecar write that meets a full store gives way the same way', async () => {
    seedFacts(2, 0);
    storeFull((n) => n === sidecarName(key) && facts().length > 0);
    await queueOne();
    expect(facts()).toEqual([]);
  });

  for (const [code, err] of [
    [22, () => new DOMException('full', 'QuotaExceededError')],
    [1014, () => Object.assign(new Error('full'), { name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 })],
  ] as const) {
    it(`forced probe (any code): a write that throws code ${code} gives way`, async () => {
      seedFacts(2, 0);
      storeFull((n) => n === key && facts().length > 0, err);
      await queueOne();
      expect(facts()).toEqual([]);
    });
  }
});

describe('guards: no fact, no skip (U2)', () => {
  it('guard (Stage 1 U2 gap 1, C3): another person\'s fact for the same key never stops this person\'s act', async () => {
    const approveDecision = vi.fn(async () => null);
    const B = createQueueKeyGuard();
    B.load(localStorage, otherPerson);
    expect(B.settled(localStorage, otherPerson, approve('k-a'))).toBe(true); // at U2 its fact is on this phone
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard FP1 (Stage 1 gap-check of f9a9bc8): a tab opened after the damage sets the key aside; this tab still sends k-a', async () => {
    const approveDecision = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null, null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key)).toEqual([]);
    other.heard(localStorage, key, []);
    expect(other.setAside(localStorage, [key])).toBe('ok');
    expect(other.writeAll(localStorage, [{ key, mine: [OTHER], takes: () => true }])).toBe('all');
    hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard FP2: this tab queued after the other loaded; the key is damaged and the other sets aside its memory; this tab sends its act', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn(null, null, { startActivity });
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key)).toEqual([]);
    s().startActivity('B-1');
    await queueWritten();
    otherTabWrites(key, DAMAGED);
    other.heard(localStorage, key, []);
    expect(other.setAside(localStorage, [key])).toBe('ok');
    expect(other.writeAll(localStorage, [{ key, mine: [], takes: () => true }])).toBe('all');
    hear();
    await online();
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('guard FP3: this tab writes before it hears the set-aside: its new act goes in, and k-a too', async () => {
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null);
    otherTabWrites(key, DAMAGED);
    const other = createQueueKeyGuard();
    other.load(localStorage, key);
    other.heard(localStorage, key, []);
    expect(other.setAside(localStorage, [key])).toBe('ok');
    expect(other.writeAll(localStorage, [{ key, mine: [], takes: () => true }])).toBe('all');
    s().startActivity('B-1');
    await queueWritten();
    expect(keysIn(localStorage.getItem(key))).toContain('k-a');
  });

  it('guard (set-aside): this tab sets the damaged key aside, and another tab writes over it; k-a is sent once', async () => {
    const approveDecision = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null, null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key)).toEqual([]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    other.heard(localStorage, key, []);
    expect(other.write(localStorage, key, [approve('k-b')])).toBe(true);
    hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard (fallback read): a key with no write token, read by its bytes, sends k-a once', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard (Codex 4358186342): a key cleared with no fact gives k-a back at this tab\'s next write', async () => {
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null);
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key)).toHaveLength(1);
    otherTabWrites(key, null);
    s().startActivity('B-1');
    await queueWritten();
    expect(keysIn(localStorage.getItem(key))).toContain('k-a');
  });

  it('guard: a fact read that throws is no fact; k-a is sent once', async () => {
    const approveDecision = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null, null, { approveDecision });
    const other = createQueueKeyGuard();
    other.load(localStorage, key);
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name: string) {
      if (name.startsWith('vitan.done.')) throw new DOMException('denied', 'SecurityError');
      return real.call(this, name);
    });
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard (plan §6): a keyless act another tab sent and drained has no fact, so it is sent again', async () => {
    const submitInspection = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, key, [U])).toBe(true);
    signedIn(null, null, { submitInspection });
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(other.settled(localStorage, key, theirs[0])).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    expect(facts()).toEqual([]);
    await online();
    expect(submitInspection).toHaveBeenCalledTimes(1);
  });

  it('guard: a fact under the act\'s name that holds another identity is not this act\'s; k-a is sent once', async () => {
    const approveDecision = vi.fn(async () => null);
    localStorage.setItem(doneName(key, approve('k-a')), JSON.stringify({ i: 'k:k-z', n: 1 }));
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard (re-queue, gap 1): a start refused as a second open visit with no open visit now writes no fact, and is sent again under its key', async () => {
    const conflict = () => Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have a site visit open on this project; end it first' });
    const startSiteVisit = vi.fn(async () => { throw conflict(); });
    expect(createQueueKeyGuard().write(localStorage, lane, [start])).toBe(true);
    signedIn(null, null, { startSiteVisit });
    await online();
    expect(startSiteVisit).toHaveBeenCalledTimes(1);
    expect(doneOf(localStorage, lane, start)).toBeNull();
    expect(s().outbox.map((o) => o.t)).toEqual(['siteVisitStart']);
    await act(async () => { await s().flushOutbox(); });
    await flushes.atRest();
    expect(startSiteVisit.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('guard: a visit start another tab refused for good is sent again, so its refusal path runs here with the server\'s words', async () => {
    const startSiteVisit = vi.fn(async () => { throw Object.assign(new Error('422'), { status: 422, serverMessage: 'Project is archived' }); });
    expect(createQueueKeyGuard().write(localStorage, lane, [start])).toBe(true);
    signedIn(null, null, { startSiteVisit });
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, lane);
    expect(other.settled(localStorage, lane, theirs[0], true)).toBe(true);
    expect(other.write(localStorage, lane, [])).toBe(true);
    hear(lane);
    await online();
    expect(startSiteVisit).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
  });

  it('guard (re-queue, gap 1): a photo evidence act another tab refused has no fact, so its retry is still sent', () => {
    const evidence = { t: 'uploadEvidence', scope: 's-1', clientKey: 'c-1' } as OutboxOp;
    const other = createQueueKeyGuard();
    other.load(localStorage, key);
    other.settled(localStorage, key, evidence, true);
    expect(facts()).toEqual([]);
    expect(doneOf(localStorage, key, { ...evidence })).toBeNull();
  });
});
