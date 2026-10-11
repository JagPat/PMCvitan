import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AppNotification } from '@vitan/shared';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import {
  SEEN_CHUNK_SIZE, applySeenConfirmed, applySeenFailure, beginSeenAttempt, claimSeenChunk, emptyNotifSeen, planSeenChunks, reconcileSeen, showsUnread, unreadCount,
} from '@/lib/notificationSeen';

/**
 * Top 10 #4b unit D (#778) — the bell's per-notice read state against a STUBBED gateway (owner record #482
 * 6112637523, carrying proposal revisions 3 and 4): suppress an id only while its mark is in flight or once
 * the server confirmed THAT id; request success alone confirms nothing.
 *
 * Isolated automated tests: they establish no production or role-live QA.
 */

const notice = (id: string, unread = true): AppNotification =>
  ({ id, at: '2026-10-11T10:00:00.000Z', text: `Notice ${id}`, time: 'just now', color: '#000', unread });

describe('notificationSeen — the per-id state machine', () => {
  it('counts server-unread notices and those with no read state; a server-read notice is not counted', () => {
    const state = emptyNotifSeen();
    const feed = [notice('a'), notice('b', false), { text: 'local', time: 'now', color: '#000' } as AppNotification];
    expect(feed.map((n) => showsUnread(n, state))).toEqual([true, false, true]);
    expect(unreadCount(feed, state)).toBe(2);
  });

  it('plans only displayed server-unread ids not already in flight or confirmed, in chunks of at most 200', () => {
    const state = emptyNotifSeen();
    expect(SEEN_CHUNK_SIZE).toBe(200);
    const feed = Array.from({ length: 450 }, (_, i) => notice(`n${i}`));
    expect(planSeenChunks(feed, state).map((c) => c.length)).toEqual([200, 200, 50]);
    beginSeenAttempt(state, ['n0', 'n1']);
    applySeenConfirmed(state, 1, ['n0', 'n1'], ['n0']);
    // n0 confirmed, n1 unacknowledged (not resendable until a fresh snapshot re-serves it)
    const next = planSeenChunks(feed, state).flat();
    expect(next).not.toContain('n0');
    expect(next).not.toContain('n1');
    // a read notice, or one with no id or no `unread`, is never submitted
    expect(planSeenChunks([notice('r', false), { id: 'x', text: 'no read state', time: 'now', color: '#000' } as AppNotification, { text: 't', time: 'now', color: '#000', unread: true } as AppNotification], emptyNotifSeen())).toEqual([]);
  });

  it('an older failure or partial answer cannot undo a newer confirmation', () => {
    const state = emptyNotifSeen();
    const a1 = beginSeenAttempt(state, ['a']);
    const a2 = beginSeenAttempt(state, ['a']); // a newer attempt now owns `a`
    applySeenConfirmed(state, a2, ['a'], ['a']);
    applySeenFailure(state, a1, ['a']);
    expect(state.entries.a).toEqual({ kind: 'confirmed' });
    applySeenConfirmed(state, a1, ['a'], []);
    expect(state.entries.a).toEqual({ kind: 'confirmed' });
  });

  it('a chunk claims, at send time, only ids still free or re-armed: never a confirmed or another attempt\'s id (#482 6113161710)', () => {
    const state = emptyNotifSeen();
    applySeenConfirmed(state, beginSeenAttempt(state, ['c']), ['c'], ['c']); // confirmed
    beginSeenAttempt(state, ['p']); // held by another attempt
    applySeenConfirmed(state, beginSeenAttempt(state, ['r']), ['r'], []); // r unacknowledged…
    reconcileSeen(state, [notice('c'), notice('p'), notice('r')]); // …and re-served unread since: re-armed
    applySeenConfirmed(state, beginSeenAttempt(state, ['u']), ['u'], []); // u unacknowledged, no snapshot since
    const claim = claimSeenChunk(state, ['c', 'p', 'u', 'r', 'f']);
    expect(claim.ids).toEqual(['r', 'f']);
    expect(state.entries.c).toEqual({ kind: 'confirmed' });
    expect(state.entries.p).toMatchObject({ kind: 'pending', attempt: 2 });
    expect(state.entries.u).toMatchObject({ kind: 'unacknowledged', resendable: false });
    expect(state.entries.r).toEqual({ kind: 'pending', attempt: claim.attempt });
    // nothing left to claim: no attempt is spent
    const next = state.nextAttempt;
    expect(claimSeenChunk(state, ['c', 'p'])).toEqual({ attempt: 0, ids: [] });
    expect(state.nextAttempt).toBe(next);
  });

  it('a snapshot retires a confirmed id once it is served read or leaves the feed, and never while it is stale', () => {
    const state = emptyNotifSeen();
    applySeenConfirmed(state, beginSeenAttempt(state, ['a', 'b']), ['a', 'b'], ['a', 'b']);
    reconcileSeen(state, [notice('a'), notice('b')]); // stale: both still unread:true
    expect(Object.keys(state.entries).sort()).toEqual(['a', 'b']);
    reconcileSeen(state, [notice('a', false)]); // a served read, b gone
    expect(state.entries).toEqual({});
  });
});

describe('the bell marks displayed notices seen (store, stubbed gateway)', () => {
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  const snapshot = (notifications: AppNotification[]): ApiSnapshot => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications, companies: [], nodes: [], photos: [], materials: [],
  } as unknown as ApiSnapshot);

  type Answer = { confirmed: string[] } | Error;
  /** A gateway whose seen-mark answers are scripted per call (or held open with `defer`). */
  const setup = async (feed: AppNotification[]) => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    const s = () => useStore.getState();
    const calls: string[][] = [];
    const answers: Array<Answer | Promise<Answer>> = [];
    const gw = {
      markNotificationsSeen: vi.fn(async (ids: readonly string[]) => {
        calls.push([...ids]);
        const a = await (answers.shift() ?? { confirmed: [...ids] });
        if (a instanceof Error) throw a;
        return a;
      }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    expect(s().applySnapshot(snapshot(feed))).toBe(true);
    const open = async () => {
      if (s().notifOpen) s().toggleNotif();
      s().toggleNotif();
      await flush();
    };
    const badge = () => {
      const st = s();
      return unreadCount(st.notifications, st.notifSeen);
    };
    const defer = () => { let resolve!: (a: Answer) => void; const p = new Promise<Answer>((r) => { resolve = r; }); return { p, resolve }; };
    return { useStore, s, gw, calls, answers, open, badge, defer, apply: (f: AppNotification[]) => s().applySnapshot(snapshot(f)) };
  };

  afterEach(async () => {
    const { useStore } = await import('@/store/store');
    useStore.getState()._setGateway(null);
    vi.resetModules();
  });

  it('opening the bell marks the displayed unread notices; the badge counts unread, not every notice', async () => {
    const t = await setup([notice('a'), notice('b'), notice('r', false)]);
    expect(t.badge()).toBe(2);
    await t.open();
    expect(t.calls).toEqual([['a', 'b']]);
    expect(t.badge()).toBe(0);
    // a read notice is never submitted; reopening with nothing new sends nothing
    await t.open();
    expect(t.calls).toHaveLength(1);
  });

  it('a failed mark restores the badge, and the next open retries it', async () => {
    const t = await setup([notice('a'), notice('b')]);
    const held = t.defer();
    t.answers.push(held.p);
    t.s().toggleNotif();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.badge(), 'suppressed while in flight').toBe(0);
    held.resolve(Object.assign(new Error('/notifications/seen 503'), { status: 503 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(t.badge(), 'restored after the failure').toBe(2);
    await t.open();
    expect(t.calls).toEqual([['a', 'b'], ['a', 'b']]);
    expect(t.badge()).toBe(0);
  });

  it('450 displayed unread notices go as 200 / 200 / 50, sequentially, each confirmed on its own', async () => {
    const feed = Array.from({ length: 450 }, (_, i) => notice(`n${i}`));
    const t = await setup(feed);
    let inFlight = 0; let maxInFlight = 0;
    t.gw.markNotificationsSeen.mockImplementation(async (ids: readonly string[]) => {
      t.calls.push([...ids]);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return { confirmed: [...ids] };
    });
    await t.open();
    expect(t.calls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(maxInFlight, 'one chunk at a time').toBe(1);
    expect(t.badge()).toBe(0);
  });

  it('a failed middle chunk leaves only its ids unread', async () => {
    const feed = Array.from({ length: 450 }, (_, i) => notice(`n${i}`));
    const t = await setup(feed);
    t.answers.push({ confirmed: feed.slice(0, 200).map((n) => n.id!) }, new Error('/notifications/seen 409'), { confirmed: feed.slice(400).map((n) => n.id!) });
    await t.open();
    expect(t.badge()).toBe(200);
    const unread = feed.filter((n) => showsUnread(n, t.s().notifSeen)).map((n) => n.id);
    expect(unread).toEqual(feed.slice(200, 400).map((n) => n.id));
  });

  it('a partially accepted middle chunk leaves only its omitted subset unread', async () => {
    const feed = Array.from({ length: 450 }, (_, i) => notice(`n${i}`));
    const t = await setup(feed);
    const middle = feed.slice(200, 400).map((n) => n.id!);
    t.answers.push({ confirmed: feed.slice(0, 200).map((n) => n.id!) }, { confirmed: middle.slice(0, 150) }, { confirmed: feed.slice(400).map((n) => n.id!) });
    await t.open();
    const unread = feed.filter((n) => showsUnread(n, t.s().notifSeen)).map((n) => n.id);
    expect(unread).toEqual(middle.slice(150));
  });

  it('[A,B] → confirmed [A], then a stale unread snapshot: A stays suppressed, B unread; the next open resends only B', async () => {
    const A = notice('A'); const B = notice('B');
    const t = await setup([A, B]);
    t.answers.push({ confirmed: ['A'] });
    await t.open();
    expect(t.badge()).toBe(1);
    // reopening with no fresh snapshot resends nothing: B is unacknowledged, not retried in a loop
    await t.open();
    expect(t.calls).toEqual([['A', 'B']]);
    // a stale snapshot still serves both unread
    expect(t.apply([notice('A'), notice('B')])).toBe(true);
    expect(showsUnread(notice('A'), t.s().notifSeen), 'A stays suppressed').toBe(false);
    expect(t.badge(), 'B counts unread').toBe(1);
    // that snapshot re-served B unread, so the next open resends exactly B
    await t.open();
    expect(t.calls).toEqual([['A', 'B'], ['B']]);
  });

  it('a snapshot that no longer serves an unacknowledged id drops it with no request', async () => {
    const t = await setup([notice('A'), notice('B')]);
    t.answers.push({ confirmed: ['A'] });
    await t.open();
    expect(t.apply([notice('A', false)])).toBe(true);
    expect(t.s().notifSeen.entries).toEqual({});
    expect(t.badge()).toBe(0);
    await t.open();
    expect(t.calls).toEqual([['A', 'B']]);
  });

  it('overlapping opens: an older failure that lands after a newer confirmation undoes nothing of the newer one', async () => {
    const t = await setup([notice('A')]);
    const older = t.defer();
    t.answers.push(older.p);
    t.s().toggleNotif(); // open: A in flight (held)
    await new Promise((r) => setTimeout(r, 0));
    // a new notice arrives; the next open sends only it (A is still in flight)
    expect(t.apply([notice('C'), notice('A')])).toBe(true);
    await t.open();
    expect(t.calls).toEqual([['A'], ['C']]);
    expect(t.s().notifSeen.entries.C).toEqual({ kind: 'confirmed' });
    older.resolve(new Error('/notifications/seen 503'));
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    expect(t.s().notifSeen.entries.C, 'the newer confirmation stands').toEqual({ kind: 'confirmed' });
    expect(t.badge(), 'only A, whose own attempt failed, is unread again').toBe(1);
  });

  /**
   * #482 6113161710 — a chunk planned by an OLDER open and sent only later must not take over an id a newer open
   * already confirmed: 201 unread ids; open 1 sends its first 200 (held); a reopen sends the 201st (X) and is
   * confirmed; open 1 then reaches its queued chunk [X]. Unfixed, that chunk overwrote X's confirmation with a
   * pending claim, and its failure (or an empty confirmation) put X back in the badge.
   */
  for (const variant of ['fails', 'confirms nothing'] as const) {
    it(`a queued older chunk cannot undo a newer confirmation (the redundant request ${variant})`, async () => {
      const feed = Array.from({ length: 201 }, (_, i) => notice(`n${i}`));
      const X = 'n200';
      const t = await setup(feed);
      const first = t.defer();
      t.answers.push(first.p, { confirmed: [X] }, variant === 'fails' ? new Error('/notifications/seen 503') : { confirmed: [] });
      t.s().toggleNotif(); // open 1: [n0..n199] in flight, [X] queued behind it
      await new Promise((r) => setTimeout(r, 0));
      expect(t.calls.map((c) => c.length)).toEqual([200]);
      await t.open(); // close and reopen: open 2 sends only X, which is not yet claimed
      expect(t.calls[1]).toEqual([X]);
      expect(t.s().notifSeen.entries[X]).toEqual({ kind: 'confirmed' });
      first.resolve({ confirmed: feed.slice(0, 200).map((n) => n.id!) });
      for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
      // the stale feed still serves X unread, but X's durable confirmation stands and nothing re-sends it
      expect(t.s().notifSeen.entries[X], 'X stays confirmed').toEqual({ kind: 'confirmed' });
      expect(t.badge(), 'nothing returns to the badge').toBe(0);
      expect(t.calls, 'the queued chunk had nothing left to claim and sent nothing').toHaveLength(2);
    });
  }

  it('a project switch mid-flight: the old project\'s answer changes nothing in the new project', async () => {
    const t = await setup([notice('A')]);
    const held = t.defer();
    t.answers.push(held.p);
    t.s().toggleNotif();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.s().notifSeen.entries.A).toMatchObject({ kind: 'pending' });
    // the scope changes (as every project switch bumps it) and the project's state starts clean
    const { emptyProjectData } = await import('@/store/projectScope');
    t.useStore.setState((st) => ({ ...emptyProjectData(), projectScopeGeneration: st.projectScopeGeneration + 1, notifications: [notice('A')] }));
    expect(t.s().notifSeen.entries).toEqual({});
    held.resolve({ confirmed: ['A'] });
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    expect(t.s().notifSeen.entries, 'the stale answer is dropped').toEqual({});
    expect(t.badge()).toBe(1);
  });

  it('request success alone confirms nothing: an empty confirmation keeps every id unread', async () => {
    const t = await setup([notice('A'), notice('B')]);
    t.answers.push({ confirmed: [] });
    await t.open();
    expect(t.badge()).toBe(2);
    expect(t.s().notifSeen.entries.A).toMatchObject({ kind: 'unacknowledged' });
  });

  it('without the API (local/demo store) the bell sends nothing and the badge keeps counting', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.getState()._setGateway(null);
    useStore.setState({ notifications: [notice('A')] });
    useStore.getState().toggleNotif();
    await new Promise((r) => setTimeout(r, 0));
    const st = useStore.getState();
    expect(unreadCount(st.notifications, st.notifSeen)).toBe(1);
  });
});
