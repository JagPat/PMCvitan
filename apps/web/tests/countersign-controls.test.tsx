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
    // no target is defaulted: the chooser opens on "Choose who decides…" and nothing can be sent until one is chosen
    expect((r.getByTestId('chain-kind-P') as HTMLSelectElement).value).toBe('');
    fireEvent.change(r.getByTestId('chain-reason-P'), { target: { value: 'r' } });
    expect((r.getByTestId('chain-send-P') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('chain-reason-P'), { target: { value: '' } });
    // a blank reason cannot be sent
    fireEvent.change(r.getByTestId('chain-kind-P'), { target: { value: 'member' } });
    expect((r.getByTestId('chain-send-P') as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.change(r.getByTestId('chain-kind-Q'), { target: { value: 'pmc' } });
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
    // a Forward on REQUIRES a chosen target: with the reason filled but no target, nothing can be sent
    fireEvent.change(r.getByTestId('chain-reason-A1'), { target: { value: 'x' } });
    expect((r.getByTestId('chain-send-A1') as HTMLButtonElement).disabled).toBe(true);
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
  it('Complete / Return render for the PMC on a STRANDED row only; both take the PMC’s own reason, and a Return re-homes only when a target is chosen', () => {
    const spies = acts();
    as('pmc', 'u-pmc');
    let r = render(<CountersignControls decision={stranded('S1')} />);
    // Complete goes through the required-reason form: nothing is enqueued on the click, and no reason is invented
    fireEvent.click(r.getByTestId('stranded-complete-S1'));
    expect(spies.resolveStrandedCountersign).not.toHaveBeenCalled();
    expect(r.queryByTestId('chain-kind-S1')).toBeNull(); // no target on a completion
    expect((r.getByTestId('chain-send-S1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('chain-reason-S1'), { target: { value: 'Two quotes agree; the architect left the project' } });
    fireEvent.click(r.getByTestId('chain-send-S1'));
    expect(spies.resolveStrandedCountersign).toHaveBeenLastCalledWith('S1', { outcome: 'completed', reason: 'Two quotes agree; the architect left the project' });
    // Return with NO target keeps the current decider: the act carries no designation
    fireEvent.click(r.getByTestId('stranded-return-S1'));
    expect((r.getByTestId('chain-kind-S1') as HTMLSelectElement).value).toBe('');
    fireEvent.change(r.getByTestId('chain-reason-S1'), { target: { value: 'Re-check the lot' } });
    fireEvent.click(r.getByTestId('chain-send-S1'));
    expect(spies.resolveStrandedCountersign).toHaveBeenLastCalledWith('S1', { outcome: 'returned', reason: 'Re-check the lot', costImpact: 0, timeImpactDays: 0 });
    // Return WITH a chosen target re-homes the decision
    fireEvent.click(r.getByTestId('stranded-return-S1'));
    fireEvent.change(r.getByTestId('chain-kind-S1'), { target: { value: 'pmc' } });
    fireEvent.change(r.getByTestId('chain-reason-S1'), { target: { value: 'The practice will re-decide' } });
    fireEvent.click(r.getByTestId('chain-send-S1'));
    expect(spies.resolveStrandedCountersign).toHaveBeenLastCalledWith('S1', { outcome: 'returned', reason: 'The practice will re-decide', costImpact: 0, timeImpactDays: 0, toDesignationKind: 'pmc' });
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

// #482 comment 5923291892 — the impact inputs on Reject back, Forward on and the stranded Return used to strip
// every character but digits and an ASCII minus, then fall back to 0: "12.50" sent 1250, "1.5" days sent 15,
// "abc" sent 0, and a Unicode minus "−5" sent +5. Each path now refuses an unsupported entry VISIBLY, sends
// nothing while it stands, and sends a supported whole number exactly as typed. RED at e4ac5d8 (main).
type ImpactPath = {
  name: string;
  role: Role;
  userId: string;
  decision: (id: string) => Decision;
  open: string;
  ready: (r: ReturnType<typeof render>, id: string) => void;
  spy: (spies: ReturnType<typeof acts>) => ReturnType<typeof vi.fn>;
  expected: (id: string, impacts: { costImpact: number; timeImpactDays: number }) => [string, Record<string, unknown>];
};
const IMPACT_PATHS: ImpactPath[] = [
  {
    name: 'Reject back', role: 'architect', userId: 'u-arch', decision: (id) => awaiting(id), open: 'reject-back',
    ready: (r, id) => fireEvent.change(r.getByTestId(`chain-reason-${id}`), { target: { value: 'Grain' } }),
    spy: (x) => x.disagreeDecision,
    expected: (id, i) => [id, { path: 'reject_back', reason: 'Grain', ...i }],
  },
  {
    name: 'Forward on', role: 'architect', userId: 'u-arch', decision: (id) => awaiting(id), open: 'forward-on',
    ready: (r, id) => {
      fireEvent.change(r.getByTestId(`chain-kind-${id}`), { target: { value: 'client' } });
      fireEvent.change(r.getByTestId(`chain-reason-${id}`), { target: { value: 'Re-decide' } });
    },
    spy: (x) => x.disagreeDecision,
    expected: (id, i) => [id, { path: 'forward_on', reason: 'Re-decide', ...i, toDesignationKind: 'client' }],
  },
  {
    name: 'stranded Return', role: 'pmc', userId: 'u-pmc', decision: (id) => stranded(id), open: 'stranded-return',
    ready: (r, id) => fireEvent.change(r.getByTestId(`chain-reason-${id}`), { target: { value: 'Re-check' } }),
    spy: (x) => x.resolveStrandedCountersign,
    expected: (id, i) => [id, { outcome: 'returned', reason: 'Re-check', ...i }],
  },
];

describe('the impact inputs are read exactly or refused visibly — never repaired (#482 comment 5923291892)', () => {
  const REFUSED: Array<[field: 'cost' | 'days', raw: string, reason: RegExp]> = [
    ['cost', '12.50', /whole rupees only/i], // was sent as 1250
    ['days', '1.5', /whole days only/i], // was sent as 15
    ['cost', 'abc', /enter whole rupees/i], // was sent as 0
    ['days', 'abc', /enter whole days/i], // was sent as 0
    ['cost', '12,50', /enter whole rupees/i], // a decimal comma would read as 1250
  ];

  for (const path of IMPACT_PATHS) {
    it(`${path.name}: an unsupported entry shows its reason, disables the send, and sends nothing`, () => {
      const spies = acts();
      as(path.role, path.userId);
      const id = 'X1';
      const r = render(<CountersignControls decision={path.decision(id)} />);
      fireEvent.click(r.getByTestId(`${path.open}-${id}`));
      path.ready(r, id);
      const send = r.getByTestId(`chain-send-${id}`) as HTMLButtonElement;
      expect(send.disabled).toBe(false); // ready to send with blank impacts…

      for (const [field, raw, reason] of REFUSED) {
        const other = field === 'cost' ? 'days' : 'cost';
        fireEvent.change(r.getByTestId(`chain-${other}-${id}`), { target: { value: '' } });
        fireEvent.change(r.getByTestId(`chain-${field}-${id}`), { target: { value: raw } });
        const error = r.getByTestId(`chain-${field}-error-${id}`);
        expect(error.textContent, raw).toMatch(reason);
        expect(error.getAttribute('role')).toBe('alert');
        expect(r.getByTestId(`chain-${field}-${id}`).getAttribute('aria-invalid'), raw).toBe('true');
        expect(r.queryByTestId(`chain-${other}-error-${id}`), raw).toBeNull();
        expect(send.disabled, raw).toBe(true); // …and NOT while an impact is refused
        fireEvent.click(send); // a click on the disabled button
        expect(path.spy(spies), raw).not.toHaveBeenCalled(); // no act, so no outbox entry and no request
      }
      // clearing the refused entry restores the send, with the agreed zero default
      fireEvent.change(r.getByTestId(`chain-cost-${id}`), { target: { value: '' } });
      expect(r.queryByTestId(`chain-cost-error-${id}`)).toBeNull();
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      expect(path.spy(spies)).toHaveBeenCalledTimes(1);
      expect(path.spy(spies)).toHaveBeenLastCalledWith(...path.expected(id, { costImpact: 0, timeImpactDays: 0 }));
    });

    it(`${path.name}: a supported whole number is sent exactly as typed, its sign kept`, () => {
      const cases: Array<[cost: string, days: string, costImpact: number, timeImpactDays: number]> = [
        ['', '', 0, 0], // blank → the agreed zero default
        ['₹ 5,000', '2 days', 5000, 2], // the formats the existing test pins
        ['1,00,000', '3', 100000, 3], // Indian grouping
        ['−5', '−2', -5, -2], // a Unicode minus keeps its sign (was +5 / +2)
        ['-₹ 1,200', '-1 day', -1200, -1],
      ];
      for (const [cost, days, costImpact, timeImpactDays] of cases) {
        const spies = acts();
        as(path.role, path.userId);
        const id = 'X2';
        const r = render(<CountersignControls decision={path.decision(id)} />);
        fireEvent.click(r.getByTestId(`${path.open}-${id}`));
        path.ready(r, id);
        fireEvent.change(r.getByTestId(`chain-cost-${id}`), { target: { value: cost } });
        fireEvent.change(r.getByTestId(`chain-days-${id}`), { target: { value: days } });
        expect(r.queryByTestId(`chain-cost-error-${id}`), cost).toBeNull();
        expect(r.queryByTestId(`chain-days-error-${id}`), days).toBeNull();
        fireEvent.click(r.getByTestId(`chain-send-${id}`));
        expect(path.spy(spies), `${cost} / ${days}`).toHaveBeenLastCalledWith(...path.expected(id, { costImpact, timeImpactDays }));
        cleanup();
      }
    });
  }

  it('the panels without impacts (Forward, Complete) are not gated by a stale impact entry', () => {
    const spies = acts();
    as('pmc', 'u-pmc');
    const r = render(<CountersignControls decision={stranded('S9')} />);
    fireEvent.click(r.getByTestId('stranded-return-S9'));
    fireEvent.change(r.getByTestId('chain-cost-S9'), { target: { value: '12.50' } });
    // switching to Complete resets the form, shows no impact fields, and sends the PMC's reason alone
    fireEvent.click(r.getByTestId('stranded-complete-S9'));
    expect(r.queryByTestId('chain-cost-S9')).toBeNull();
    fireEvent.change(r.getByTestId('chain-reason-S9'), { target: { value: 'Done' } });
    fireEvent.click(r.getByTestId('chain-send-S9'));
    expect(spies.resolveStrandedCountersign).toHaveBeenLastCalledWith('S9', { outcome: 'completed', reason: 'Done' });
  });
});
