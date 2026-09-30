import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { CountersignControls } from '@/components/CountersignControls';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import type { Decision, ProjectMember, Role } from '@vitan/shared';
import registerSource from '@/screens/DecisionLogScreen.tsx?raw';

/**
 * Phase 6 task 4d-ii-b / B5b — the countersign chain's AFFORDANCES and CONTROLS (the web arms of P30, P33
 * and P34): the Forward affordance following the ONE shell read, the architect's Countersign / Reject back /
 * Forward on, the PMC's stranded Complete / Return, each driving B5a's write-ahead acts and disabled while an
 * act on the row is still in the outbox. Every test PLANTS the rollout and the rows the server will serve
 * once the doors drop; with the rollout reserved and no awaiting row — the delivered world — nothing renders.
 */

const s = () => useStore.getState();
const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: over.title ?? `Title ${over.id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true }, { label: 'B', key: 'b', material: 'Quartz', delta: 12000, swatch: 'tile' }],
    ageDays: 2, approvalCycle: 0, ...over,
  }) as Decision;
const awaiting = (id: string, over: Partial<Decision> = {}): Decision =>
  dec({ id, status: 'awaiting_countersign', approvedOption: 'A', material: 'Granite', cost: 0, approver: 'Mr. Shah', date: '03 Jul 2026', countersignRequired: true, ...over });
const stranded = (id: string, over: Partial<Decision> = {}): Decision => {
  const d = awaiting(id, over);
  delete (d as { countersignRequired?: true }).countersignRequired;
  return d;
};
const member = (userId: string, role: ProjectMember['role']): ProjectMember =>
  ({ userId, membershipId: `m-${userId}`, name: userId, email: null, phone: null, role, status: 'active' }) as ProjectMember;
const acts = () => {
  const spies = { forwardDecision: vi.fn(), countersignDecision: vi.fn(), disagreeDecision: vi.fn(), resolveStrandedCountersign: vi.fn(), loadTeam: vi.fn(() => Promise.resolve()) };
  useStore.setState(spies as never);
  return spies;
};
const as = (role: Role, userId: string | null = 'u-me', rollout: 'reserved' | 'open' = 'open') =>
  useStore.setState({ role, sessionUserId: userId, phase6_4dRollout: rollout } as never);

beforeEach(() => { useStore.setState(getInitialState()); s()._setGateway(null); useStore.setState({ members: [member('u-pmc', 'pmc'), member('u-eng', 'engineer')] } as never); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B5b — the Forward affordance follows the ONE shell read', () => {
  it('renders for the holder, the PMC and an architect on an OPEN decision only while the rollout is open', () => {
    acts();
    const openRow = dec({ id: 'P', deciderKind: 'member', deciderUserId: 'u-eng' });
    const cases: Array<[Role, string, 'reserved' | 'open', boolean]> = [
      ['pmc', 'u-pmc', 'open', true], ['pmc', 'u-pmc', 'reserved', false],
      ['architect', 'u-arch', 'open', true], ['architect', 'u-arch', 'reserved', false],
      ['engineer', 'u-eng', 'open', true], // the named holder
      ['engineer', 'u-other', 'open', false], // a same-role non-holder
      ['client', 'u-cli', 'open', false], // not this decision's holder
      ['contractor', 'u-con', 'open', false],
    ];
    for (const [role, uid, rollout, expected] of cases) {
      as(role, uid, rollout);
      const r = render(<CountersignControls decision={openRow} />);
      expect(r.queryByTestId('forward-P') !== null, `${role}/${uid}/${rollout}`).toBe(expected);
      cleanup();
    }
    // a client-held pending row: the client is its holder
    as('client', 'u-cli', 'open');
    let r = render(<CountersignControls decision={dec({ id: 'C' })} />);
    expect(r.queryByTestId('forward-C')).not.toBeNull();
    cleanup();
    // never on a decided row, a record, a withdrawn row, or a draft
    as('pmc', 'u-pmc', 'open');
    for (const row of [dec({ id: 'OK', status: 'approved' }), dec({ id: 'R', status: 'recorded', deciderKind: 'none' }), dec({ id: 'W', status: 'withdrawn' }), dec({ id: 'D', draft: true })]) {
      r = render(<CountersignControls decision={row} />);
      expect(r.queryByTestId(`forward-${row.id}`), row.id).toBeNull();
      expect(r.queryByTestId(`chain-controls-${row.id}`), row.id).toBeNull();
      cleanup();
    }
  });

  it('the Forward form: a target, a required reason, the roster loaded once when it opens over an empty slice; the act carries the exact shared input', () => {
    const spies = acts();
    as('pmc', 'u-pmc', 'open');
    let r = render(<CountersignControls decision={dec({ id: 'P' })} />);
    fireEvent.click(r.getByTestId('forward-P'));
    expect(spies.loadTeam).not.toHaveBeenCalled(); // the roster is loaded
    // a blank reason cannot be sent
    expect((r.getByTestId('chain-send-P') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('chain-kind-P'), { target: { value: 'member' } });
    fireEvent.change(r.getByTestId('chain-reason-P'), { target: { value: '  The engineer owns this detail  ' } });
    // a member target without a chosen member cannot be sent either
    expect((r.getByTestId('chain-send-P') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('chain-member-P'), { target: { value: 'm-u-eng' } });
    fireEvent.click(r.getByTestId('chain-send-P'));
    expect(spies.forwardDecision).toHaveBeenCalledWith('P', { toDesignationKind: 'member', toDesignationMembershipId: 'm-u-eng', reason: 'The engineer owns this detail' }); // trimmed at the control
    expect(r.queryByTestId('chain-panel-P')).toBeNull(); // the panel closes on send
    cleanup();

    // over an EMPTY roster the chooser's opening loads it — once
    useStore.setState({ members: [] } as never);
    r = render(<CountersignControls decision={dec({ id: 'Q' })} />);
    fireEvent.click(r.getByTestId('forward-Q'));
    expect(spies.loadTeam).toHaveBeenCalledTimes(1);
    fireEvent.change(r.getByTestId('chain-reason-Q'), { target: { value: 'r' } });
    fireEvent.click(r.getByTestId('chain-send-Q'));
    expect(spies.forwardDecision).toHaveBeenLastCalledWith('Q', { toDesignationKind: 'pmc', reason: 'r' });
  });
});

describe('B5b — the architect’s controls on an awaiting decision', () => {
  it('Countersign, Reject back and Forward on render for the architect alone, and drive the acts with the shared inputs', () => {
    const spies = acts();
    as('architect', 'u-arch');
    const r = render(<CountersignControls decision={awaiting('A1')} />);
    expect(r.getByTestId('countersign-A1')).toBeTruthy();
    expect(r.getByTestId('reject-back-A1')).toBeTruthy();
    expect(r.getByTestId('forward-on-A1')).toBeTruthy();
    expect(r.queryByTestId('forward-A1')).toBeNull(); // an awaiting decision is not forwarded; it is forwarded ON
    expect(r.queryByTestId('stranded-complete-A1')).toBeNull();

    fireEvent.click(r.getByTestId('countersign-A1'));
    expect(spies.countersignDecision).toHaveBeenCalledWith('A1');

    fireEvent.click(r.getByTestId('reject-back-A1'));
    expect(r.queryByTestId('chain-kind-A1')).toBeNull(); // reject back keeps the decider: no target
    fireEvent.change(r.getByTestId('chain-reason-A1'), { target: { value: 'Grain runs the wrong way' } });
    fireEvent.change(r.getByTestId('chain-cost-A1'), { target: { value: '₹ 5,000' } });
    fireEvent.change(r.getByTestId('chain-days-A1'), { target: { value: '2 days' } });
    fireEvent.click(r.getByTestId('chain-send-A1'));
    expect(spies.disagreeDecision).toHaveBeenLastCalledWith('A1', { path: 'reject_back', reason: 'Grain runs the wrong way', costImpact: 5000, timeImpactDays: 2 });

    fireEvent.click(r.getByTestId('forward-on-A1'));
    fireEvent.change(r.getByTestId('chain-kind-A1'), { target: { value: 'client' } });
    fireEvent.change(r.getByTestId('chain-reason-A1'), { target: { value: 'The client should re-decide' } });
    fireEvent.click(r.getByTestId('chain-send-A1'));
    expect(spies.disagreeDecision).toHaveBeenLastCalledWith('A1', { path: 'forward_on', reason: 'The client should re-decide', costImpact: 0, timeImpactDays: 0, toDesignationKind: 'client' });
  });

  it('no other role gets the architect’s controls on an awaiting row, and the PMC gets none while the chain is active', () => {
    acts();
    for (const role of ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      as(role, 'u-x');
      const r = render(<CountersignControls decision={awaiting('A1', { deciderKind: 'client' })} />);
      expect(r.queryByTestId('countersign-A1'), role).toBeNull();
      expect(r.queryByTestId('reject-back-A1'), role).toBeNull();
      expect(r.queryByTestId('forward-on-A1'), role).toBeNull();
      expect(r.queryByTestId('stranded-complete-A1'), role).toBeNull();
      cleanup();
    }
  });
});

describe('B5b — the PMC’s stranded resolution', () => {
  it('Complete / Return render for the PMC on a STRANDED row only, and drive the act with its outcome, reason and target', () => {
    const spies = acts();
    as('pmc', 'u-pmc');
    let r = render(<CountersignControls decision={stranded('S1')} />);
    fireEvent.click(r.getByTestId('stranded-complete-S1'));
    expect(spies.resolveStrandedCountersign).toHaveBeenCalledWith('S1', { outcome: 'completed', reason: 'No active architect — completed by the PMC' });
    fireEvent.click(r.getByTestId('stranded-return-S1'));
    expect((r.getByTestId('chain-kind-S1') as HTMLSelectElement).value).toBe('client'); // a return re-homes to a decider
    fireEvent.change(r.getByTestId('chain-kind-S1'), { target: { value: 'pmc' } });
    fireEvent.change(r.getByTestId('chain-reason-S1'), { target: { value: 'Re-check the lot' } });
    fireEvent.click(r.getByTestId('chain-send-S1'));
    expect(spies.resolveStrandedCountersign).toHaveBeenLastCalledWith('S1', { outcome: 'returned', reason: 'Re-check the lot', costImpact: 0, timeImpactDays: 0, toDesignationKind: 'pmc' });
    cleanup();
    // an awaiting row under an ACTIVE chain is the architect's: the PMC resolves nothing
    r = render(<CountersignControls decision={awaiting('A1')} />);
    expect(r.queryByTestId('stranded-complete-A1')).toBeNull();
    expect(r.queryByTestId('chain-controls-A1')).toBeNull();
    cleanup();
    // and nobody but the PMC resolves a stranded one
    for (const role of ['architect', 'client', 'engineer'] as Role[]) {
      as(role, 'u-x');
      r = render(<CountersignControls decision={stranded('S1')} />);
      expect(r.queryByTestId('stranded-complete-S1'), role).toBeNull();
      cleanup();
    }
  });
});

describe('B5b — disabled while an act on the row is in flight; the register renders the controls', () => {
  it('every control is disabled and reads Working… while a chain act for THIS decision sits in the outbox', () => {
    acts();
    as('architect', 'u-arch');
    useStore.setState({ outbox: [{ t: 'countersignDecision', decisionId: 'A1', idempotencyKey: 'k1' }] } as never);
    const r = render(<><CountersignControls decision={awaiting('A1')} /><CountersignControls decision={awaiting('A2')} /></>);
    for (const id of ['countersign-A1', 'reject-back-A1', 'forward-on-A1']) {
      expect((r.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
      expect(r.getByTestId(id).textContent).toBe('Working…');
    }
    // another row's controls are live
    expect((r.getByTestId('countersign-A2') as HTMLButtonElement).disabled).toBe(false);
    expect(r.getByTestId('countersign-A2').textContent).toBe('Countersign');
  });

  it('the Decision Log renders the controls on its rows — and, with the rollout reserved and no awaiting row, none at all', () => {
    acts();
    expect(registerSource).toContain('<CountersignControls decision={d} />');
    // the delivered world: reserved, the seeded rows — nothing renders for the PMC
    as('pmc', 'u-pmc', 'reserved');
    let r = render(<DecisionLogScreen />);
    expect(r.queryAllByTestId(/^chain-controls-/)).toHaveLength(0);
    expect(r.queryAllByTestId(/^forward-/)).toHaveLength(0);
    cleanup();
    // the open world: the PMC gets Forward on every open row, and the stranded resolution on a stranded one
    as('pmc', 'u-pmc', 'open');
    useStore.setState({ decisions: [dec({ id: 'P' }), dec({ id: 'C', status: 'change', changeRequest: { reason: 'r', costImpact: 0, timeImpactDays: 0 } }), stranded('S1'), dec({ id: 'OK', status: 'approved' })] } as never);
    r = render(<DecisionLogScreen />);
    expect(r.getByTestId('forward-P')).toBeTruthy();
    expect(r.getByTestId('forward-C')).toBeTruthy();
    expect(r.getByTestId('stranded-complete-S1')).toBeTruthy();
    expect(r.queryByTestId('forward-OK')).toBeNull();
  });
});
