import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { selectReapproval, selectActionItems } from '@/store/selectors';
import { replayOutboxOp, type ApiGateway, type ApiSnapshot, type OutboxOp } from '@/data/apiGateway';

/**
 * Phase 1 Task 2 — change control on the web side. The store's withdraw action
 * mirrors the new API endpoint (POST /decisions/:id/change/withdraw), queues
 * offline like every other mutation, and the client's surfaces treat a reopened
 * decision as work the CLIENT must finish (mandatory re-approval).
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

describe('withdrawChange store action', () => {
  it('online: calls the gateway and reconciles from the returned snapshot', async () => {
    const snap = makeSnapshot({ notifications: [{ text: 'SERVER applied', time: 'now', color: '#3F7A54' }] });
    const gw = { withdrawChange: vi.fn().mockResolvedValue(snap) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().withdrawChange('DL-003');
    await flush();

    expect(gw.withdrawChange).toHaveBeenCalledWith('DL-003', expect.any(String));
    expect(s().notifications[0].text).toBe('SERVER applied'); // snapshot reconciled
  });

  it('offline: queues a changeWithdraw op and replays it on reconnect', async () => {
    const gw = { withdrawChange: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });

    s().withdrawChange('DL-003');
    expect(gw.withdrawChange).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([{ t: 'changeWithdraw', decisionId: 'DL-003', idempotencyKey: expect.any(String) }]);

    s().toggleOnline();
    await flush();
    expect(gw.withdrawChange).toHaveBeenCalledWith('DL-003', expect.any(String));
    expect(s().outbox).toHaveLength(0);
  });

  it('replayOutboxOp maps the changeWithdraw op to gateway.withdrawChange', async () => {
    const gw = { withdrawChange: vi.fn().mockResolvedValue(makeSnapshot()) };
    const op: OutboxOp = { t: 'changeWithdraw', decisionId: 'DL-042', idempotencyKey: 'k-test' };
    await replayOutboxOp(gw as unknown as ApiGateway, op);
    expect(gw.withdrawChange).toHaveBeenCalledWith('DL-042', 'k-test');
  });

  it('demo (no gateway): re-locks the decision and clears the open change request', () => {
    const seeded = s().decisions.find((d) => d.id === 'DL-003');
    expect(seeded?.status).toBe('change');
    expect(seeded?.changeRequest).toBeDefined();

    s().withdrawChange('DL-003');

    const after = s().decisions.find((d) => d.id === 'DL-003');
    expect(after?.status).toBe('approved');
    expect(after?.changeRequest).toBeUndefined();
  });
});

describe('change request context on the decision (demo mode)', () => {
  it('submitChange records WHY on the decision, not just the status flip', () => {
    useStore.setState((st) => {
      st.modal = { type: 'change', decId: 'DL-006', title: 'Staircase Railing', changeText: 'Glass panel lead time', changeCost: '12000', changeTime: '6' };
    });
    s().submitChange();
    const d = s().decisions.find((x) => x.id === 'DL-006');
    expect(d?.status).toBe('change');
    expect(d?.changeRequest).toEqual({ reason: 'Glass panel lead time', costImpact: 12000, timeImpactDays: 6 });
  });

  it('a re-approval RESOLVES the change request locally too', () => {
    // DL-003 is seeded reopened; the client re-approving clears its request
    useStore.setState((st) => {
      const d = st.decisions.find((x) => x.id === 'DL-003');
      if (d) d.options = [{ label: 'Option A', key: 'A', material: 'Quartz (Statuario)', delta: 0, swatch: 'quartz', recommended: true }];
    });
    s().openApprove('DL-003', 0);
    s().confirmApprove();
    const d = s().decisions.find((x) => x.id === 'DL-003');
    expect(d?.status).toBe('approved');
    expect(d?.changeRequest).toBeUndefined();
  });
});

describe('client re-approval surfaces', () => {
  it('selectReapproval returns reopened (change) decisions, excluding drafts', () => {
    useStore.setState((st) => {
      st.decisions.push({ ...st.decisions[0], id: 'DL-DRAFT', status: 'change', draft: true });
    });
    const ids = selectReapproval(s()).map((d) => d.id);
    expect(ids).toContain('DL-003');
    expect(ids).not.toContain('DL-DRAFT');
  });

  it('the client action queue includes a re-approval item pointing at Client Decisions', () => {
    useStore.setState((st) => { st.role = 'client'; });
    const item = selectActionItems(s()).find((i) => i.key === 'client-reapprove');
    expect(item).toBeDefined();
    expect(item?.screen).toBe('client-decisions');
    expect(item?.tone).toBe('red');
    expect(item?.title).toContain('re-approval');
  });
});
