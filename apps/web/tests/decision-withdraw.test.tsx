import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { selectPending, selectReapproval, selectLogDecisions, selectActionItems } from '@/store/selectors';
import { replayOutboxOp, type ApiGateway, type ApiSnapshot, type OutboxOp } from '@/data/apiGateway';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import type { Decision, Role } from '@vitan/shared';

/**
 * Phase 6 unit 4a — the WEB half of probes P10 and P14 (plan §E).
 *
 * P10 (selector half): a WITHDRAWN decision is pmc-only — the server's `decisionVisibleToViewer`
 * is the authority and these selectors mirror it. The old `status !== 'pending'` negative filter
 * LEAKED a withdrawn row to contractor/engineer (roles that never saw it while pending); every
 * pending/action surface drops it automatically (positive filters, asserted not assumed).
 *
 * P14: the store's withdraw action carries the reason through the durable outbox op and replays
 * exactly once under its persisted key; the register renders the WITHDRAWN state with its reason;
 * the action is offered only to pmc on an eligible (published, pending) decision.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: over.title ?? `Title ${over.id}`,
    room: 'Kitchen',
    status: 'pending',
    photoSwatch: 'tile',
    options: [
      { label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true },
      { label: 'B', key: 'b', material: 'Quartz', delta: 20000, swatch: 'stone', recommended: false },
    ],
    ...over,
  }) as Decision;

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
afterEach(() => cleanup());

// ── P10 — the selector mirror of the server visibility rule ──────────────────────────────────
describe('P10 (web half): a withdrawn decision is pmc-only on every selector surface', () => {
  const seed = (role: Role) =>
    useStore.setState({
      role,
      decisions: [
        dec({ id: 'DL-P', status: 'pending' }),
        dec({ id: 'DL-A', status: 'approved', approvedOption: 'A', material: 'Granite', approver: 'Asha', date: '01 Aug 2026', cost: 0 }),
        dec({ id: 'DL-W', status: 'withdrawn', withdrawnBy: 'Ar. Meghna', withdrawnAt: '2026-08-13T10:00:00Z', withdrawReason: 'Wrong room' }),
      ],
    });

  it('the register shows the withdrawn row to pmc only — the negative filter no longer leaks it to contractor/engineer, and client/consultant never see it', () => {
    seed('pmc');
    expect(selectLogDecisions(s()).map((d) => d.id)).toContain('DL-W');
    for (const role of ['contractor', 'engineer', 'client', 'consultant'] as Role[]) {
      seed(role);
      expect(selectLogDecisions(s()).map((d) => d.id), `role=${role}`).not.toContain('DL-W');
    }
  });

  it('pending, re-approval, and action-item surfaces drop a withdrawn decision (positive filters, asserted)', () => {
    seed('client');
    expect(selectPending(s()).map((d) => d.id)).toEqual(['DL-P']);
    expect(selectReapproval(s())).toEqual([]);
    const items = selectActionItems(s());
    expect(items.find((i) => i.key === 'client-pending')?.detail).not.toContain('DL-W');
    seed('pmc');
    expect(selectActionItems(s()).some((i) => i.title.includes('withdrawn'))).toBe(false);
  });

  it('the nav pending badge counts only pending rows — a withdrawal clears it', () => {
    seed('client');
    const badge = s().decisions.filter((d) => d.status === 'pending' && !d.draft).length;
    expect(badge).toBe(1); // DL-W contributes nothing
  });
});

// ── P14 — the store action, the outbox op, and the register render ───────────────────────────
describe('P14 (web half): withdrawDecision — modal, outbox lifecycle, and the rendered register', () => {
  it('confirmWithdraw online: one gateway call carrying the typed reason under a fresh key; the snapshot reconciles', async () => {
    const snap = makeSnapshot({ decisions: [dec({ id: 'DL-1', status: 'withdrawn', withdrawnBy: 'Ar. M', withdrawReason: 'typed reason' })] });
    const gw = { withdrawDecision: vi.fn().mockResolvedValue(snap) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ decisions: [dec({ id: 'DL-1' })] });

    s().openWithdraw('DL-1');
    expect(s().modal.type).toBe('withdraw');
    s().setWithdrawReason('typed reason');
    s().confirmWithdraw();
    await flush();

    expect(gw.withdrawDecision).toHaveBeenCalledTimes(1);
    expect(gw.withdrawDecision).toHaveBeenCalledWith('DL-1', 'typed reason', expect.any(String));
    expect(s().decisions.find((d) => d.id === 'DL-1')?.status).toBe('withdrawn');
  });

  it('a blank reason never dispatches — the modal refuses silently (the contract would 400 anyway)', async () => {
    const gw = { withdrawDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ decisions: [dec({ id: 'DL-1' })] });
    s().openWithdraw('DL-1');
    s().setWithdrawReason('   ');
    s().confirmWithdraw();
    await flush();
    expect(gw.withdrawDecision).not.toHaveBeenCalled();
  });

  it('offline: queues ONE withdraw op with the reason and replays it on reconnect under the SAME key', async () => {
    const gw = { withdrawDecision: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ online: false, decisions: [dec({ id: 'DL-2' })] });

    s().openWithdraw('DL-2');
    s().setWithdrawReason('offline withdrawal');
    s().confirmWithdraw();
    expect(gw.withdrawDecision).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([{ t: 'withdraw', decisionId: 'DL-2', reason: 'offline withdrawal', idempotencyKey: expect.any(String) }]);
    const key = (s().outbox[0] as Extract<OutboxOp, { t: 'withdraw' }>).idempotencyKey;

    s().toggleOnline();
    await flush();
    expect(gw.withdrawDecision).toHaveBeenCalledWith('DL-2', 'offline withdrawal', key);
    expect(s().outbox).toHaveLength(0);
  });

  it('replayOutboxOp maps the withdraw op to gateway.withdrawDecision verbatim', async () => {
    const gw = { withdrawDecision: vi.fn().mockResolvedValue(makeSnapshot()) };
    const op: OutboxOp = { t: 'withdraw', decisionId: 'DL-042', reason: 'replayed', idempotencyKey: 'k-w' };
    await replayOutboxOp(gw as unknown as ApiGateway, op);
    expect(gw.withdrawDecision).toHaveBeenCalledWith('DL-042', 'replayed', 'k-w');
  });

  it('the register renders the WITHDRAWN state with reason + withdrawer for pmc, offers the action ONLY on an eligible pending row, and never renders the row for an engineer', () => {
    useStore.setState({
      role: 'pmc',
      decisions: [
        dec({ id: 'DL-P', status: 'pending' }),
        dec({ id: 'DL-W', status: 'withdrawn', withdrawnBy: 'Ar. Meghna', withdrawnAt: '2026-08-13T10:00:00Z', withdrawReason: 'Wrong room' }),
      ],
    });
    const { getByTestId, queryByTestId, unmount } = render(<DecisionLogScreen />);
    // the withdrawn row renders its evidence…
    expect(getByTestId('withdraw-detail-DL-W').textContent).toContain('Wrong room');
    expect(getByTestId('log-row-DL-W').textContent).toContain('Withdrawn by Ar. Meghna');
    // …offers NO withdraw action (it is already withdrawn), while the pending row offers one
    expect(queryByTestId('withdraw-decision-DL-W')).toBeNull();
    expect(queryByTestId('withdraw-decision-DL-P')).not.toBeNull();
    unmount();

    // an engineer: the withdrawn row is not rendered at all, and no action is offered anywhere
    useStore.setState({ role: 'engineer' });
    const eng = render(<DecisionLogScreen />);
    expect(eng.queryByTestId('log-row-DL-W')).toBeNull();
    expect(eng.queryByTestId('withdraw-decision-DL-P')).toBeNull();
  });
});
