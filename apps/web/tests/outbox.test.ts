import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { isTerminalOutboxError, type ApiGateway, type ApiSnapshot } from '@/data/apiGateway';
import { queueWritten } from './queueWrites';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
/** An error shaped like the one apiGateway.req throws (carries the HTTP status). */
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', location: '', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [],
    activities: [],
    placedInspections: [],
    checklist: null,
    reviews: [],
    review: null,
    reinspectionCreated: false,
    drawings: [],
    phases: [],
    dailyLog: null,
    notifications: [{ text: 'SERVER applied', time: 'just now', color: '#3F7A54' }],
    companies: [],
    nodes: [],
    photos: [],
    materials: [],
    ...partial,
  };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('Phase 8 offline outbox', () => {
  it('queues a mutation while offline instead of calling the gateway', () => {
    const gw = { approveDecision: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();

    expect(gw.approveDecision).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1, idempotencyKey: expect.any(String) }]);
    expect(s().syncQueue.length).toBe(1); // banner reflects the queued op
    expect(s().modal.type).toBeNull();
  });

  it('replays the queue in order on reconnect and reconciles from the snapshot', async () => {
    const snap = makeSnapshot({ notifications: [{ text: 'SERVER applied', time: 'now', color: '#3F7A54' }] });
    const gw = {
      approveDecision: vi.fn().mockResolvedValue(snap),
      startActivity: vi.fn().mockResolvedValue(snap),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    s().startActivity('ACT-31');
    expect(s().outbox).toHaveLength(2);

    s().toggleOnline(); // back online → flush
    await flush();

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1, expect.any(String));
    // Task 10 (Module 4): the queued op replays under its minted, stable idempotency key
    expect(gw.startActivity).toHaveBeenCalledWith('ACT-31', expect.any(String));
    expect(s().outbox).toHaveLength(0);
    expect(s().syncQueue).toHaveLength(0);
    expect(s().notifications[0].text).toBe('SERVER applied'); // snapshot reconciled
    expect(s().online).toBe(true);
  });

  it('online mutations go straight to the gateway (nothing queued)', async () => {
    const gw = { approveDecision: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    await flush();

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1, expect.any(String));
    expect(s().outbox).toHaveLength(0);
  });

  it('persists the queue to identity-scoped storage and rehydrates it (WEB-02)', async () => {
    const gw = { approveDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    await queueWritten(); // step B1: written under the queue's lock, after the act
    // key carries WHO (anon — no session token) and WHERE (the active project)
    const scopedKey = `vitan.outbox.anon.${s().activeProjectId}`;
    expect(globalThis.localStorage?.getItem(scopedKey)).toContain('DL-014');

    // simulate a reload: fresh state, then hydrate from storage
    useStore.setState(getInitialState());
    expect(s().outbox).toHaveLength(0);
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1, idempotencyKey: expect.any(String) }]);
  });

  it('WEB-02: work queued under one project is not hydrated in another', async () => {
    const gw = { approveDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(s().outbox).toHaveLength(1);
    await queueWritten();

    // switch to another project: hydration swaps to THAT scope's (empty) queue…
    useStore.setState((st) => { st.activeProjectId = 'villa'; });
    s().hydrateOutbox();
    expect(s().outbox).toHaveLength(0);

    // …and switching back restores the original project's queued work.
    useStore.setState((st) => { st.activeProjectId = 'ambli'; });
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1, idempotencyKey: expect.any(String) }]);
  });

  it('WEB-02: work queued by one user is not hydrated for another (shared browser)', async () => {
    const gw = { approveDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    // JWT payloads: {"sub":"u1"} and {"sub":"u2"} — header/signature are irrelevant here
    const tokenFor = (sub: string) => `x.${btoa(JSON.stringify({ sub }))}.y`;
    useStore.setState((st) => { st.online = false; st.sessionToken = tokenFor('u1'); });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(s().outbox).toHaveLength(1);

    // sign out: the queue is quarantined (cleared in memory, persisted under u1's key)
    s().signOut();
    expect(s().outbox).toHaveLength(0);
    await queueWritten();

    // another user signs in on the same browser — nothing of u1's leaks in
    useStore.setState((st) => { st.sessionToken = tokenFor('u2'); });
    s().hydrateOutbox();
    expect(s().outbox).toHaveLength(0);

    // u1 returns — their queued work resumes
    useStore.setState((st) => { st.sessionToken = tokenFor('u1'); });
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1, idempotencyKey: expect.any(String) }]);
  });

  it('WEB-02: migrates a legacy unscoped queue into the current scope once', () => {
    globalThis.localStorage?.setItem('vitan.outbox', JSON.stringify([{ t: 'startActivity', activityId: 'ACT-31' }]));
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'startActivity', activityId: 'ACT-31' }]);
    expect(globalThis.localStorage?.getItem('vitan.outbox')).toBeNull(); // legacy key consumed
  });

  it('#1085 r2 audit: a legacy queue is removed only once its bytes are in the scoped key', () => {
    const legacy = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-31' }]);
    globalThis.localStorage?.setItem('vitan.outbox', legacy);
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.outbox.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    s().hydrateOutbox();
    spy.mockRestore();
    expect(globalThis.localStorage?.getItem('vitan.outbox')).toBe(legacy); // not lost: adopted at a later load
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'startActivity', activityId: 'ACT-31' }]);
    expect(globalThis.localStorage?.getItem('vitan.outbox')).toBeNull();
  });

  it('#1085 r2 gap-check G1: a legacy queue beside a non-empty scoped key is copied aside, never adopted by the next user or project', () => {
    const tokenFor = (sub: string) => `x.${btoa(JSON.stringify({ sub }))}.y`;
    const legacy = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-31' }]);
    const mine = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-1' }]);
    localStorage.setItem('vitan.outbox', legacy);
    localStorage.setItem('vitan.outbox.userA.ambli', mine);
    useStore.setState({ sessionToken: tokenFor('userA'), activeProjectId: 'ambli', online: false });
    s().hydrateOutbox();
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
    expect(localStorage.getItem('vitan.unreadable.vitan.outbox.vitan.outbox.userA.ambli')).toBe(legacy);
    expect(localStorage.getItem('vitan.outbox.userA.ambli')).toBe(mine);
    useStore.setState({ sessionToken: tokenFor('userB'), activeProjectId: 'villa' });
    s().hydrateOutbox();
    expect(s().outbox).toEqual([]);
  });

  it('#1085 r2 re-check R1: a legacy queue copied aside never writes over an earlier copy holding other bytes', () => {
    const tokenFor = (sub: string) => `x.${btoa(JSON.stringify({ sub }))}.y`;
    const earlier = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-30' }]);
    const legacy = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-31' }]);
    const aside = 'vitan.unreadable.vitan.outbox.vitan.outbox.userA.ambli';
    // an earlier load copied a legacy queue aside; a rollback to a release before scoping then wrote a new one
    localStorage.setItem(aside, earlier);
    localStorage.setItem('vitan.outbox', legacy);
    localStorage.setItem('vitan.outbox.userA.ambli', JSON.stringify([{ t: 'startActivity', activityId: 'ACT-1' }]));
    useStore.setState({ sessionToken: tokenFor('userA'), activeProjectId: 'ambli', online: false });
    s().hydrateOutbox();
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
    expect(localStorage.getItem(aside)).toBe(earlier);
    expect(localStorage.getItem(`${aside}.1`)).toBe(legacy);
  });

  it('#1085 r2 gap-check: a legacy queue left by a failed write is adopted only by a scope with no other queue key on this phone', () => {
    const tokenFor = (sub: string) => `x.${btoa(JSON.stringify({ sub }))}.y`;
    const legacy = JSON.stringify([{ t: 'startActivity', activityId: 'ACT-31' }]);
    localStorage.setItem('vitan.outbox', legacy);
    // user A keeps a queue on another project, so this phone holds another scope's key
    localStorage.setItem('vitan.siteVisitQueue.userA.villa', '[]');
    useStore.setState({ sessionToken: tokenFor('userB'), activeProjectId: 'ambli', online: false });
    s().hydrateOutbox();
    expect(s().outbox).toEqual([]);
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
    expect(localStorage.getItem('vitan.unreadable.vitan.outbox.vitan.outbox.userB.ambli')).toBe(legacy);
  });

  it('queues a progress photo while offline and shows it optimistically', () => {
    const gw = { uploadMedia: vi.fn(), snapshot: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    const before = s().dailyLog!.photos.length;
    s().addProgressPhoto('data:image/jpeg;base64,AAAA');

    expect(gw.uploadMedia).not.toHaveBeenCalled(); // not uploaded while offline
    expect(s().outbox).toEqual([{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', clientKey: expect.any(String) } }]);
    expect(s().dailyLog!.photos.length).toBe(before + 1); // shown right away
    expect(s().dailyLog!.photos[0].url).toBe('data:image/jpeg;base64,AAAA');
    expect(s().dailyLog!.photos[0].id).toBeUndefined(); // no server id yet
    expect(s().syncQueue.length).toBe(1);
  });

  it('replays a queued photo on reconnect (uploads, then reconciles from snapshot)', async () => {
    const gw = {
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().addProgressPhoto('data:image/png;base64,BBBB');
    expect(s().outbox).toHaveLength(1);

    s().toggleOnline(); // back online → flush
    await flush();

    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'BBBB', clientKey: expect.any(String) });
    expect(gw.snapshot).toHaveBeenCalled(); // refetched to reconcile photos
    expect(s().outbox).toHaveLength(0);
    expect(s().syncQueue).toHaveLength(0);
  });

  it('a queued photo replays under one key: a retry after a lost reply is the same photo, and each pick has its own (#482)', async () => {
    const gw = {
      uploadMedia: vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    s().addProgressPhoto('data:image/png;base64,BBBB');
    s().addProgressPhoto('data:image/png;base64,CCCC');
    const keys = s().outbox.map((o) => (o as { input?: { clientKey?: string } }).input?.clientKey);
    expect(new Set(keys).size).toBe(2);

    s().toggleOnline(); // the first attempt fails in transit; the op stays queued
    await flush();
    await s().flushOutbox();
    await flush();

    const sent = gw.uploadMedia.mock.calls.map((c) => (c[0] as { data: string; clientKey: string }));
    const bbbb = sent.filter((i) => i.data === 'BBBB');
    expect(bbbb.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bbbb.map((i) => i.clientKey))).toEqual(new Set([keys[0]]));
    expect(s().outbox).toHaveLength(0);
  });

  it('a photo queued by an earlier release, with no key, gets one key on load, kept for every replay (#482)', async () => {
    const scopedKey = `vitan.outbox.anon.${s().activeProjectId}`;
    globalThis.localStorage?.setItem(scopedKey, JSON.stringify([{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB' } }]));
    s().hydrateOutbox();
    const key = (s().outbox[0] as { input: { clientKey?: string } }).input.clientKey;
    expect(key).toEqual(expect.any(String));
    await queueWritten();
    // persisted, so a reload does not mint a different one
    expect(JSON.parse(globalThis.localStorage!.getItem(scopedKey)!)[0].input.clientKey).toBe(key);
    s().hydrateOutbox();
    expect((s().outbox[0] as { input: { clientKey?: string } }).input.clientKey).toBe(key);
  });

  it('two tabs loading the same unkeyed queue reach the same key, and two identical picks keep two keys (#482)', () => {
    const scopedKey = `vitan.outbox.anon.${s().activeProjectId}`;
    const legacy = JSON.stringify([
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB' } },
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB' } },
    ]);
    const keysAfterLoad = (): (string | undefined)[] => {
      globalThis.localStorage?.setItem(scopedKey, legacy); // each tab read the queue before either wrote it back
      s().hydrateOutbox();
      return s().outbox.map((o) => (o as { input: { clientKey?: string } }).input.clientKey);
    };
    const tabA = keysAfterLoad();
    const tabB = keysAfterLoad();
    expect(tabA).toEqual(tabB);
    expect(new Set(tabA).size).toBe(2);
  });

  it('a full storage on the key write-back keeps the queued photo, under the key the next load derives (#482)', () => {
    const scopedKey = `vitan.outbox.anon.${s().activeProjectId}`;
    globalThis.localStorage?.setItem(scopedKey, JSON.stringify([{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'BBBB' } }]));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      s().hydrateOutbox();
    } finally {
      setItem.mockRestore();
    }
    expect(s().outbox).toHaveLength(1);
    const key = (s().outbox[0] as { input: { clientKey?: string } }).input.clientKey;
    expect(key).toEqual(expect.any(String));
    s().hydrateOutbox();
    expect((s().outbox[0] as { input: { clientKey?: string } }).input.clientKey).toBe(key);
  });

  it('without a gateway, offline mutations still apply locally (demo)', () => {
    useStore.setState((st) => { st.online = false; });
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    // no gateway → optimistic local mutation, nothing queued in the API outbox
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('approved');
    expect(s().outbox).toHaveLength(0);
  });
});

describe('Phase 8 outbox — failure handling (replay poisoning fix)', () => {
  it('classifies terminal 4xx as permanent and network/401/429/5xx as transient', () => {
    // Permanent — the server will keep rejecting; drop the op.
    expect(isTerminalOutboxError(httpError(400))).toBe(true);
    expect(isTerminalOutboxError(httpError(403))).toBe(true);
    expect(isTerminalOutboxError(httpError(404))).toBe(true);
    expect(isTerminalOutboxError(httpError(409))).toBe(true);
    expect(isTerminalOutboxError(httpError(422))).toBe(true);
    // Transient — keep the op and retry later.
    expect(isTerminalOutboxError(httpError(401))).toBe(false); // needs re-auth
    expect(isTerminalOutboxError(httpError(408))).toBe(false); // timeout
    expect(isTerminalOutboxError(httpError(429))).toBe(false); // rate limited
    expect(isTerminalOutboxError(httpError(503))).toBe(false); // server down
    expect(isTerminalOutboxError(new Error('network down'))).toBe(false); // no status
  });

  it('drops a permanently-rejected (4xx) op instead of re-replaying it forever', async () => {
    const snap = makeSnapshot();
    const gw = {
      requestChange: vi.fn().mockRejectedValue(httpError(403)), // e.g. role not permitted
      startActivity: vi.fn().mockResolvedValue(snap),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.online = false;
      st.modal = { type: 'change', decId: 'DL-014', title: 'Flooring', changeText: 'need a change', changeCost: '', changeTime: '' };
    });

    s().submitChange(); // reads the modal → queues a 'change' op
    s().startActivity('ACT-31'); // queued after it
    expect(s().outbox).toHaveLength(2);

    s().toggleOnline();
    await flush();

    // The 403 op is discarded; the following op still applies; the queue fully drains.
    expect(gw.requestChange).toHaveBeenCalledTimes(1);
    expect(gw.startActivity).toHaveBeenCalledTimes(1);
    expect(s().outbox).toHaveLength(0);
    expect(s().syncQueue).toHaveLength(0);

    // A second flush must NOT re-run anything (the poison op is gone, not stuck).
    await s().flushOutbox();
    await flush();
    expect(gw.requestChange).toHaveBeenCalledTimes(1);
  });

  it('keeps a transiently-failed op (and those after it) for the next reconnect, without re-running successes', async () => {
    const snap = makeSnapshot();
    const gw = {
      approveDecision: vi.fn().mockResolvedValue(snap), // first op: succeeds
      startActivity: vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValue(snap), // second: 503 then ok
      completeActivity: vi.fn().mockResolvedValue(snap), // third: never reached on first pass
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    s().startActivity('ACT-31');
    s().completeActivity('ACT-31');
    expect(s().outbox).toHaveLength(3);

    s().toggleOnline();
    await flush();

    // First succeeded and is committed; the 503 stops the flush, so op1 is gone but the
    // 503 op and everything after it are retained. The op after the failure never ran.
    expect(gw.approveDecision).toHaveBeenCalledTimes(1);
    expect(gw.startActivity).toHaveBeenCalledTimes(1);
    expect(gw.completeActivity).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([
      { t: 'startActivity', activityId: 'ACT-31', idempotencyKey: expect.any(String) },
      { t: 'completeActivity', activityId: 'ACT-31', idempotencyKey: expect.any(String) },
    ]);

    // Reconnect again: the retained ops replay, the already-synced approve is NOT re-run.
    await s().flushOutbox();
    await flush();
    expect(gw.approveDecision).toHaveBeenCalledTimes(1); // not double-applied
    expect(gw.startActivity).toHaveBeenCalledTimes(2); // retried, now succeeds
    expect(gw.completeActivity).toHaveBeenCalledTimes(1);
    expect(s().outbox).toHaveLength(0);
  });
});
