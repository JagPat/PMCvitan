import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { selectActionItems } from '@/store/selectors';
import { replayOutboxOp, type ApiGateway, type ApiSnapshot, type OutboxOp } from '@/data/apiGateway';

/**
 * Phase 1 Task 3 — controlled drawings on the web side. Acknowledgements queue
 * offline (the server ack is an idempotent upsert, so replay is safe), and the
 * unacked-Inbox nudge is RECIPIENT-aware: only someone on the governing
 * revision's frozen distribution is asked to acknowledge.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    notifications: [],
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

describe('acknowledgeDrawing — offline queueing (Phase 1 Task 3)', () => {
  it('offline: queues an ackDrawing op, marks ackedByMe optimistically, replays on reconnect', async () => {
    const gw = {
      acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true, ackCount: 1 }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().acknowledgeDrawing('DWG-2'); // seeded, unacked, current rev S-101-A
    expect(gw.acknowledgeDrawing).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([{ t: 'ackDrawing', revisionId: 'S-101-A' }]);
    expect(s().drawings.find((d) => d.id === 'DWG-2')?.ackedByMe).toBe(true); // optimistic

    s().toggleOnline();
    await flush();
    expect(gw.acknowledgeDrawing).toHaveBeenCalledWith('S-101-A');
    expect(gw.snapshot).toHaveBeenCalled(); // refetched to reconcile the register
    expect(s().outbox).toHaveLength(0);
  });

  it('online: calls the gateway directly (nothing queued)', async () => {
    const gw = {
      acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true, ackCount: 1 }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().acknowledgeDrawing('DWG-2');
    await flush();
    expect(gw.acknowledgeDrawing).toHaveBeenCalledWith('S-101-A');
    expect(s().outbox).toHaveLength(0);
  });

  it('replayOutboxOp maps ackDrawing to acknowledge-then-refetch', async () => {
    const gw = {
      acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true, ackCount: 2 }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    const op: OutboxOp = { t: 'ackDrawing', revisionId: 'rev-42' };
    await replayOutboxOp(gw as unknown as ApiGateway, op);
    expect(gw.acknowledgeDrawing).toHaveBeenCalledWith('rev-42');
    expect(gw.snapshot).toHaveBeenCalled();
  });
});

describe('recipient-aware unacked nudge (Phase 1 Task 3)', () => {
  it('a drawing whose governing revision does NOT include the viewer is not their to-do', () => {
    useStore.setState((st) => {
      st.role = 'engineer';
      // API mode fact: the viewer is not on DWG-2's frozen distribution
      const d = st.drawings.find((x) => x.id === 'DWG-2');
      if (d) d.recipientOfCurrent = false;
    });
    const item = selectActionItems(s()).find((i) => i.key === 'eng-ack');
    expect(item?.title).toContain('2 drawings'); // DWG-2 excluded; legacy/demo rows remain
  });

  it('legacy/demo drawings (no recipientOfCurrent) keep the everyone-builds nudge', () => {
    useStore.setState((st) => { st.role = 'contractor'; });
    const item = selectActionItems(s()).find((i) => i.key === 'con-ack');
    expect(item?.title).toContain('3 drawings'); // all seeded sheets, unchanged
  });
});
