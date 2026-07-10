import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { isTerminalOutboxError, type ApiGateway, type ApiSnapshot } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
/** An error shaped like the one apiGateway.req throws (carries the HTTP status). */
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [],
    activities: [],
    checklist: null,
    reviews: [],
    review: null,
    reinspectionCreated: false,
    drawings: [],
    phases: [],
    dailyLog: null,
    notifications: [{ text: 'SERVER applied', time: 'just now', color: '#3F7A54' }],
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
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1 }]);
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

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1);
    expect(gw.startActivity).toHaveBeenCalledWith('ACT-31');
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

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1);
    expect(s().outbox).toHaveLength(0);
  });

  it('persists the queue to storage and rehydrates it', () => {
    const gw = { approveDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(globalThis.localStorage?.getItem('vitan.outbox')).toContain('DL-014');

    // simulate a reload: fresh state, then hydrate from storage
    useStore.setState(getInitialState());
    expect(s().outbox).toHaveLength(0);
    s().hydrateOutbox();
    expect(s().outbox).toEqual([{ t: 'approve', decisionId: 'DL-014', optionIndex: 1 }]);
  });

  it('queues a progress photo while offline and shows it optimistically', () => {
    const gw = { uploadMedia: vi.fn(), snapshot: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    const before = s().dailyLog.photos.length;
    s().addProgressPhoto('data:image/jpeg;base64,AAAA');

    expect(gw.uploadMedia).not.toHaveBeenCalled(); // not uploaded while offline
    expect(s().outbox).toEqual([{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA' } }]);
    expect(s().dailyLog.photos.length).toBe(before + 1); // shown right away
    expect(s().dailyLog.photos[0].url).toBe('data:image/jpeg;base64,AAAA');
    expect(s().dailyLog.photos[0].id).toBeUndefined(); // no server id yet
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

    expect(gw.uploadMedia).toHaveBeenCalledWith({ kind: 'progress', mime: 'image/png', data: 'BBBB' });
    expect(gw.snapshot).toHaveBeenCalled(); // refetched to reconcile photos
    expect(s().outbox).toHaveLength(0);
    expect(s().syncQueue).toHaveLength(0);
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
      { t: 'startActivity', activityId: 'ACT-31' },
      { t: 'completeActivity', activityId: 'ACT-31' },
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
