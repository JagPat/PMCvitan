import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { reserveCoalesceKey } from '@/lib/materialsKeys';
import { queueWritten, releaseQueueLocks, storedQueue, unwatchFlushes, watchFlushes } from './queueWrites';

/**
 * WEB-02 cross-tab drain (plan `notes/site-visits/web-02-U3/xtab-drain/plan.md` §3′; it ends #1136's stated residual):
 * an act another tab of this release took from a queue key (sent, refused or discarded, then wrote the key through the
 * ledger) is never sent again by this tab, nor written back, nor kept in a made record. The evidence is the key's last
 * write (`takenBy`, plan §3″): its writer read the occurrence this tab knew in the side it overwrote, and the key, read
 * in that write's own side, no longer holds it. A cleared key takes nothing (Codex 4358186342), nor do bytes in no
 * exact frame (R-a), nor a write over set-aside bytes (Stage 1 gap-check of f9a9bc8, gap 1).
 * The other tab is a second queue key guard on the same storage: it loads, marks what it sends, and writes through the
 * ledger (token and committed side). Rows wait on storage events, queue locks and the store's flush calls; acts are
 * found by identity.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const DAMAGED = '{damaged';
/** an act with no idempotency key: its identity is its bytes */
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const keysIn = (raw: string | null) => storedQueue<{ idempotencyKey?: string; t?: string }>(raw).map((o) => o.idempotencyKey ?? o.t);
const madeHere = () => s().outbox.filter((o) => o.t === 'startActivity');

function signedIn(general: string | null, visits: string | null = null, gw: Record<string, unknown> = {}) {
  if (general !== null) localStorage.setItem(key, general);
  if (visits !== null) localStorage.setItem(lane, visits);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab writes `k` (null: removes it), and this tab hears it */
function otherTabWrites(k: string | null, raw: string | null) {
  if (k === null) localStorage.clear(); else if (raw === null) localStorage.removeItem(k); else localStorage.setItem(k, raw);
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: raw, storageArea: localStorage })); });
}
const goOnline = async () => { useStore.setState({ online: true }); await act(async () => { await s().flushOutbox(); }); };

/** every flush the store asks in a row; each row ends once they have all settled, so none runs into the next row */
let flushes: ReturnType<typeof watchFlushes>;
beforeEach(() => { flushes = watchFlushes(); });
afterEach(async () => {
  releaseQueueLocks();
  await flushes.atRest();
  unwatchFlushes();
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('cross-tab drain: another tab took the act', () => {
  const OTHER = approve('k-other');
  const hear = () => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); }); };
  const online = async () => { await flushes.atRest(); await goOnline(); await flushes.atRest(); };
  const sentWith = (fn: ReturnType<typeof vi.fn>, k: string) => fn.mock.calls.filter((c) => JSON.stringify(c).includes(k)).length;

  for (const interlude of [false, true]) {
    const I = interlude ? ' (after the key was damaged and the other tab set it aside)' : '';
    /** the key holds `acts`, as a tab of this release wrote it; this tab loads them, and so does the other tab. With
     *  the interlude, a third hand damages the key (this tab hears it and withholds the acts), and the other tab sets
     *  it aside, writing its memory back */
    let theirs: OutboxOp[] = [];
    const start = (gw: Record<string, unknown>, acts: OutboxOp[] = [approve('k-a')]) => {
      expect(createQueueKeyGuard().write(localStorage, key, acts)).toBe(true);
      signedIn(null, null, gw);
      const other = createQueueKeyGuard();
      theirs = other.load(localStorage, key); // the other tab's memory: the acts as it loaded them
      expect(theirs.length).toBe(acts.length);
      if (interlude) {
        otherTabWrites(key, DAMAGED);
        other.heard(localStorage, key, theirs);
        expect(other.setAside(localStorage, [key])).toBe('ok');
        expect(other.writeAll(localStorage, [{ key, mine: theirs, takes: () => true }])).toBe('all');
        hear();
      }
      return other;
    };

    it(`forced probe: another tab sent k-a and drained the key; this tab, online, does not send it again${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      const other = start({ approveDecision });
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [])).toBe(true);
      hear();
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(0);
      expect(keysIn(localStorage.getItem(key))).toEqual([]);
      expect(s().outbox).toEqual([]);
    });

    it(`forced probe: another tab sent k-a and stored k-other; this tab, online, sends neither${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      const other = start({ approveDecision });
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [OTHER])).toBe(true);
      hear();
      // memory lets it go as soon as this tab hears the write: it is not counted as waiting to send
      expect(s().outbox.filter((o) => JSON.stringify(o).includes('k-a'))).toEqual([]);
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(0);
      expect(keysIn(localStorage.getItem(key))).toEqual(['k-other']);
    });

    it(`forced probe: after that, this tab's next act offline never writes k-a back${I}`, async () => {
      const other = start({});
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [OTHER])).toBe(true);
      hear();
      s().startActivity('B-1');
      await queueWritten();
      const now = keysIn(localStorage.getItem(key));
      expect(now).not.toContain('k-a');
      expect(now.slice(0, 1)).toEqual(['k-other']);
      expect(madeHere().length).toBe(1);
    });

    it(`forced probe: the same when this tab writes before it hears the other tab's write (no storage event yet)${I}`, async () => {
      const other = start({});
      expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
      expect(other.write(localStorage, key, [OTHER])).toBe(true);
      s().startActivity('B-1');
      await queueWritten();
      expect(keysIn(localStorage.getItem(key))).not.toContain('k-a');
      expect(Object.keys(localStorage).filter((n) => n.startsWith(`vitan.made.${key}.`)).map((n) => keysIn(localStorage.getItem(n)))).not.toContainEqual(expect.arrayContaining(['k-a']));
    });

    it(`forced probe: a keyless act another tab sent and drained is not sent again${I}`, async () => {
      const submitInspection = vi.fn(async () => null);
      const other = start({ submitInspection }, [U]);
      expect(other.settled(localStorage, key, theirs[0])).toBe(true);
      expect(other.write(localStorage, key, [])).toBe(true);
      hear();
      await online();
      expect(submitInspection).not.toHaveBeenCalled();
    });

    it(`forced probe: an act another tab dropped for good (no mark) and drained is not sent again${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      const other = start({ approveDecision });
      expect(other.write(localStorage, key, [])).toBe(true);
      hear();
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(0);
    });

    it(`guard: the other tab only reads; this tab sends k-a once${I}`, async () => {
      const approveDecision = vi.fn(async () => null);
      start({ approveDecision });
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(1);
    });
  }

  it('forced probe: an act another tab takes while this tab\'s flush sends an earlier act is not sent by that flush', async () => {
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const approveDecision = vi.fn(async (_d: string, _i: number, k: string) => { if (k === 'k-first') { entered(); await gate; } return null; });
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-first'), approve('k-a')])).toBe(true);
    signedIn(null, null, { approveDecision });
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(theirs.length).toBe(2);
    await flushes.atRest();
    useStore.setState({ online: true });
    const flushing = act(async () => { await s().flushOutbox(); });
    await inFlight; // this tab's flush is sending k-first
    expect(other.settled(localStorage, key, theirs[1])).toBe(true); // the other tab sends k-a
    expect(other.write(localStorage, key, [theirs[0]])).toBe(true);
    hear();
    release();
    await flushing;
    await flushes.atRest();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(sentWith(approveDecision, 'k-first')).toBe(1);
  });

  /** this tab's flush is sending k-first (held at `gate`) when the other tab sends k-a and drains it; this tab hears it */
  const takenMidFlush = async (gw: Record<string, unknown> = {}, second: OutboxOp = approve('k-a'), setup = () => {}, fails = false) => {
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const approveDecision = vi.fn(async (_d: string, _i: number, k: string) => {
      if (k === 'k-first') { entered(); await gate; if (fails) throw new TypeError('Failed to fetch'); }
      return null;
    });
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-first'), second])).toBe(true);
    signedIn(null, null, { approveDecision, ...gw });
    setup();
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    await flushes.atRest();
    useStore.setState({ online: true });
    const flushing = act(async () => { await s().flushOutbox(); });
    await inFlight;
    expect(other.settled(localStorage, key, theirs[1])).toBe(true);
    expect(other.write(localStorage, key, [theirs[0]])).toBe(true);
    hear();
    return { approveDecision, release, flushing };
  };

  /** the key holds `acts`; this tab's flush sends them, held at k-first; another tab, which loaded them, takes the one
   *  at `takeIdx` (none: -1) */
  const heldAtFirst = async (acts: OutboxOp[], takeIdx: number) => {
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const approveDecision = vi.fn(async (_d: string, _i: number, k: string) => { if (k === 'k-first') { entered(); await gate; } return null; });
    expect(createQueueKeyGuard().write(localStorage, key, acts)).toBe(true);
    signedIn(null, null, { approveDecision });
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    await flushes.atRest();
    useStore.setState({ online: true });
    const flushing = act(async () => { await s().flushOutbox(); });
    await inFlight;
    if (takeIdx >= 0) {
      expect(other.settled(localStorage, key, theirs[takeIdx])).toBe(true);
      expect(other.write(localStorage, key, theirs.filter((_, i) => i !== takeIdx))).toBe(true);
      hear();
    }
    return { approveDecision, release, flushing };
  };

  it('forced probe (Stage 1 re-check of bfdffcd9, gap 1): a reload of the queue while the flush sends: each act is sent once, and memory keeps none twice', async () => {
    const { approveDecision, release, flushing } = await heldAtFirst([approve('k-first'), approve('k-b')], -1);
    act(() => { s().hydrateOutbox(); }); // the same scope: a role-only change runs the sync effect again
    release();
    await flushing;
    await flushes.atRest();
    expect(s().outbox).toEqual([]);
    await online();
    expect(sentWith(approveDecision, 'k-first')).toBe(1);
    expect(sentWith(approveDecision, 'k-b')).toBe(1);
    expect(keysIn(localStorage.getItem(key))).toEqual([]);
  });

  it('forced probe (Stage 1 re-check of bfdffcd9, gap 1): an act another tab took stays taken for the running flush across a reload of the queue', async () => {
    const { approveDecision, release, flushing } = await heldAtFirst([approve('k-first'), approve('k-a'), approve('k-b')], 1);
    act(() => { s().hydrateOutbox(); });
    release();
    await flushing;
    await flushes.atRest();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(sentWith(approveDecision, 'k-first')).toBe(1);
    expect(sentWith(approveDecision, 'k-b')).toBe(1);
    expect(keysIn(localStorage.getItem(key))).toEqual([]);
  });

  it('forced probe (Stage 1 re-check of bfdffcd9, minor): an act another tab sent asks this tab for a fresh read', async () => {
    const { release, flushing } = await heldAtFirst([approve('k-first'), approve('k-a')], 1);
    const asked = s().commandReconcilePending; // read while the flush still sends k-first: its own read is not asked yet
    release();
    await flushing;
    expect(asked).toBe(true);
  });

  it('forced probe (#1138 r1, Codex 4382389280): an act queued while the flush sends, after another tab took a later act, is kept and sent', async () => {
    const startActivity = vi.fn(async () => null);
    const { approveDecision, release, flushing } = await takenMidFlush({ startActivity });
    useStore.setState({ online: false }); // the connection drops: the new act is queued behind the running flush
    s().startActivity('B-1');
    await queueWritten();
    release();
    await flushing;
    await flushes.atRest();
    expect(madeHere().length).toBe(1);
    expect(keysIn(localStorage.getItem(key))).toContain((madeHere()[0] as { idempotencyKey: string }).idempotencyKey);
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('forced probe (#1138 r1, Codex 4382389296): a project switch while the flush sends never keeps the taken act for the project left', async () => {
    const { approveDecision, release, flushing } = await takenMidFlush({ switchProject: vi.fn(async () => ({ role: 'pmc', token: 't-2', projectId: 'p-2' })) });
    await act(async () => { await s().switchProject('p-2'); });
    expect(s().activeProjectId).toBe('p-2');
    release();
    await flushing;
    await flushes.atRest();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(keysIn(localStorage.getItem(key))).not.toContain('k-a');
    const kept = Object.keys(localStorage).filter((n) => n.startsWith(`vitan.unreadable.${key}`) || n.startsWith(`vitan.made.${key}.`)).map((n) => localStorage.getItem(n) ?? '');
    expect(kept.filter((v) => v.includes('"k-a"'))).toEqual([]);
  });

  it('forced probe (#1138 r1, Codex 4382389288): a materials act another tab took frees its action: its pending key goes, and the materials are read again', async () => {
    const materialReadiness = vi.fn(async () => ({ activities: [], shortages: [] }));
    const mats = {
      materialReadiness,
      materialRequirements: vi.fn(async () => ({ requirements: [] })),
      materialRequisitions: vi.fn(async () => ({ requisitions: [] })),
      materialPurchaseOrders: vi.fn(async () => ({ purchaseOrders: [] })),
      materialStock: vi.fn(async () => ({ lots: [] })),
      materialIssues: vi.fn(async () => ({ issues: [] })),
      reserveStock: vi.fn(async () => ({})),
    };
    signedIn(null, null, mats);
    useStore.setState({ capabilities: ['materials'] });
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    await queueWritten();
    expect(s().materialsPending).toHaveLength(1);
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(theirs.length).toBe(1);
    expect(other.settled(localStorage, key, theirs[0])).toBe(true);
    expect(other.write(localStorage, key, [])).toBe(true);
    materialReadiness.mockClear();
    hear();
    expect(s().outbox).toEqual([]);
    expect(s().materialsPending).toEqual([]);
    expect(materialReadiness).toHaveBeenCalled();
  });

  it('forced probe (#1138 r1, Codex 4382389288): a materials act taken while the flush sends is reconciled at once, and the flush never sends it', async () => {
    const materialReadiness = vi.fn(async () => ({ activities: [], shortages: [] }));
    const reserveStock = vi.fn(async () => ({}));
    const reserve = { t: 'reserveStock', input: { lotId: 'LOT-1', storeLocation: 'yard-store', activityId: 'ACT-1', qty: '10' }, idempotencyKey: 'k-r', coalesceKey: reserveCoalesceKey('ACT-1', 'LOT-1', 'yard-store') } as unknown as OutboxOp;
    const { release, flushing } = await takenMidFlush({
      materialReadiness,
      materialRequirements: vi.fn(async () => ({ requirements: [] })),
      materialRequisitions: vi.fn(async () => ({ requisitions: [] })),
      materialPurchaseOrders: vi.fn(async () => ({ purchaseOrders: [] })),
      materialStock: vi.fn(async () => ({ lots: [] })),
      materialIssues: vi.fn(async () => ({ issues: [] })),
      reserveStock,
    }, reserve, () => { useStore.setState({ capabilities: ['materials'] }); expect(s().materialsPending).toHaveLength(1); });
    const pending = s().materialsPending;
    const read = materialReadiness.mock.calls.length;
    release();
    await flushing;
    await flushes.atRest();
    expect(pending).toEqual([]); // at the take, while the flush still sends k-first
    expect(read).toBeGreaterThan(0);
    expect(reserveStock).not.toHaveBeenCalled();
    expect(s().materialsPending).toEqual([]);
  });

  it('forced probe (#1138 r1, root-cause audit): a flush that stops on a failed send never keeps the act another tab took meanwhile', async () => {
    const { approveDecision, release, flushing } = await takenMidFlush({}, approve('k-a'), () => {}, true);
    release();
    await flushing;
    await flushes.atRest();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual(['k-first']);
    expect(keysIn(localStorage.getItem(key))).toEqual(['k-first']);
  });

  it('guard: the other tab stores its own act beside k-a; this tab sends k-a once and leaves k-other', async () => {
    const approveDecision = vi.fn(async () => null);
    const other = start2({ approveDecision });
    expect(other.write(localStorage, key, [approve('k-a'), OTHER])).toBe(true);
    hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
    expect(keysIn(localStorage.getItem(key))).toContain('k-other');
  });

  it('guard (Codex 4358186342): a key cleared after a drain is a cleared key: this tab\'s next write puts k-a back', async () => {
    const other = start2({});
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    otherTabWrites(key, null);
    s().startActivity('B-1');
    await queueWritten();
    expect(keysIn(localStorage.getItem(key))).toContain('k-a');
  });

  it('guard (Codex 4358186342): a key cleared after a drain, written by this tab before it hears the clear, gets k-a back', async () => {
    const other = start2({});
    expect(other.settled(localStorage, key, approve('k-a'))).toBe(true);
    localStorage.removeItem(key); // its event not yet delivered
    s().startActivity('B-1');
    await queueWritten();
    expect(keysIn(localStorage.getItem(key))).toContain('k-a');
  });

  it('guard (R-a): bytes in no exact frame (a hand or an earlier release wrote them) take nothing: k-a is still sent', async () => {
    const approveDecision = vi.fn(async () => null);
    start2({ approveDecision });
    otherTabWrites(key, JSON.stringify([OTHER]));
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  it('guard: a reload of the key ends what was taken; k-a stored again by another tab is this tab\'s to send again', async () => {
    const approveDecision = vi.fn(async () => null);
    const other = start2({ approveDecision });
    expect(other.write(localStorage, key, [])).toBe(true);
    hear();
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    s().hydrateOutbox();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(1);
  });

  function start2(gw: Record<string, unknown>) {
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null, null, gw);
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key).length).toBe(1);
    return other;
  }
});

/** Stage 1 gap-check of f9a9bc8, gap 1 (false takes): a write that did not send an act this tab still owes never takes it.
 *  Set aside writes the tapping tab's memory over damaged bytes with no `prev` side: it took nothing */
describe('cross-tab drain: another tab that never held k-a sets the damaged key aside', () => {
  const OTHER = approve('k-other');
  const hear = () => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); }); };
  const online = async () => { await flushes.atRest(); await goOnline(); await flushes.atRest(); };
  const sentWith = (fn: ReturnType<typeof vi.fn>, k: string) => fn.mock.calls.filter((c) => JSON.stringify(c).includes(k)).length;

  for (const [label, theirs] of [['holds nothing', [] as OutboxOp[]], ['holds its own k-other', [OTHER]]] as const) {
    it(`forced probe FP1 (opened after the damage, ${label}): this tab still sends k-a`, async () => {
      const approveDecision = vi.fn(async () => null);
      expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
      signedIn(null, null, { approveDecision });
      expect(s().outbox.length).toBe(1);
      otherTabWrites(key, DAMAGED); // a hand damages the key: this tab withholds k-a
      const other = createQueueKeyGuard(); // a tab opened now: its load reads nothing from damaged bytes
      expect(other.load(localStorage, key)).toEqual([]);
      other.heard(localStorage, key, []);
      expect(other.setAside(localStorage, [key])).toBe('ok');
      expect(other.writeAll(localStorage, [{ key, mine: [...theirs], takes: () => true }])).toBe('all');
      hear();
      expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual(['k-a']);
      await online();
      expect(sentWith(approveDecision, 'k-a')).toBe(1);
    });
  }

  it('forced probe FP2 (both tabs open; this tab queued an act after the other loaded; key damaged; the other sets aside its memory)', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn(null, null, { startActivity });
    const other = createQueueKeyGuard();
    expect(other.load(localStorage, key)).toEqual([]); // the other tab loaded first: nothing
    s().startActivity('B-1');
    await queueWritten();
    otherTabWrites(key, DAMAGED);
    other.heard(localStorage, key, []);
    expect(other.setAside(localStorage, [key])).toBe('ok');
    expect(other.writeAll(localStorage, [{ key, mine: [], takes: () => true }])).toBe('all');
    hear();
    expect(s().outbox.length).toBe(1);
    await online();
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('forced probe FP3 (this tab writes before it hears the set-aside): its new act goes in, and k-a too', async () => {
    const approveDecision = vi.fn(async () => null);
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
    signedIn(null, null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    const other = createQueueKeyGuard();
    other.load(localStorage, key);
    other.heard(localStorage, key, []);
    expect(other.setAside(localStorage, [key])).toBe('ok');
    expect(other.writeAll(localStorage, [{ key, mine: [], takes: () => true }])).toBe('all');
    s().startActivity('B-1'); // no storage event yet
    await queueWritten();
    expect(keysIn(localStorage.getItem(key))).toContain('k-a');
  });
});

/** Stage 1 re-check of 82df57d, gap 1: a write of another tab that only carried this tab's act never drops it, nor
 *  does this tab count it taken (`known` is what the writing tab held) */
describe('cross-tab drain: another tab of this release writes twice after this tab queued an act', () => {
  const hear = () => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); }); };
  const online = async () => { await flushes.atRest(); await goOnline(); await flushes.atRest(); };
  for (const heardBetween of [false, true]) {
    it(`forced probe TW: this tab's offline act survives the other tab's two writes${heardBetween ? ' (first write heard)' : ''}`, async () => {
      const startActivity = vi.fn(async () => null);
      const approveDecision = vi.fn(async () => null);
      signedIn(null, null, { startActivity, approveDecision });
      const other = createQueueKeyGuard();
      expect(other.load(localStorage, key)).toEqual([]);
      s().startActivity('B-1');
      await queueWritten();
      const kb = approve('k-b'); const kc = approve('k-c');
      expect(other.write(localStorage, key, [kb])).toBe(true);
      if (heardBetween) hear();
      expect(other.write(localStorage, key, [kb, kc])).toBe(true);
      hear();
      await online();
      expect(startActivity).toHaveBeenCalledTimes(1);
    });
  }
  for (const second of [false, true]) {
    it(`${second ? 'forced probe' : 'guard'} TW2: a tab loaded after the damage, this tab sets aside, then that tab writes normally ${second ? 'twice' : 'once'}: k-a still sent`, async () => {
      const approveDecision = vi.fn(async () => null);
      expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
      signedIn(null, null, { approveDecision });
      otherTabWrites(key, DAMAGED);
      const other = createQueueKeyGuard();
      expect(other.load(localStorage, key)).toEqual([]);
      await act(async () => { await s().setAsideUnreadableQueue(); });
      other.heard(localStorage, key, []);
      const kb = approve('k-b'); const kc = approve('k-c');
      expect(other.write(localStorage, key, [kb])).toBe(true);
      hear();
      if (second) { expect(other.write(localStorage, key, [kb, kc])).toBe(true); hear(); }
      await online();
      expect(approveDecision.mock.calls.filter((c) => JSON.stringify(c).includes('k-a')).length).toBe(1);
    });
  }
});
