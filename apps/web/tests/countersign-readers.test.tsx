import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, renderHook } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import {
  isStrandedCountersign, selectActionItems, selectAwaitingCountersign, selectCountersignObligations,
  selectDeciderPending, selectDeciderReapproval, selectLogDecisions, selectVisibleDecisions,
} from '@/store/selectors';
import { groupDecisions } from '@/lib/locationTree';
import { useNavItems } from '@/layout/useNavItems';
import { DecisionChip } from '@/components/StatusChip';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import { decisionChip, decisionChipLabel, type Decision, type Role } from '@vitan/shared';
import routeBridgeSource from '@/layout/RouteBridge.tsx?raw';

/**
 * Phase 6 task 4d-ii-b / B3 — the READERS of `awaiting_countersign` on the web (the plan's §A.2 web arms;
 * the web arm of P31): the Inbox branch, the audience mirrors, the register's label/rank/filter/rollup, the
 * row and the chip, and the Decision Log badge carrying the viewer's countersign obligations.
 *
 * No row can be awaiting while the six reservation doors stand, so every test PLANTS the rows the server
 * will serve once 4d-iii opens the chain — with and without the `countersignRequired` overlay, which is how
 * the DTO exposes the chain's activity (an active architect → every served row carries it; none → the
 * awaiting rows are STRANDED, the PMC's to resolve). The client never invents an active chain.
 */

const s = () => useStore.getState();
const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: over.title ?? `Title ${over.id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true }, { label: 'B', key: 'b', material: 'Quartz', delta: 12000, swatch: 'tile' }],
    ageDays: 2, approvalCycle: 0, ...over,
  }) as Decision;
/** an approval landed awaiting its countersign under an ACTIVE chain (the overlay present) */
const awaiting = (id: string, over: Partial<Decision> = {}): Decision =>
  dec({ id, status: 'awaiting_countersign', approvedOption: 'A', material: 'Granite', cost: 0, approver: 'Mr. Shah', date: '03 Jul 2026', countersignRequired: true, ...over });
/** the same row served with the chain INACTIVE — no overlay: stranded */
const stranded = (id: string, over: Partial<Decision> = {}): Decision => {
  const d = awaiting(id, over);
  delete (d as { countersignRequired?: true }).countersignRequired;
  return d;
};
const as = (role: Role, sessionUserId: string | null = 'u-me') => useStore.setState({ role, sessionUserId } as never);

beforeEach(() => { useStore.setState(getInitialState()); s()._setGateway(null); });
afterEach(() => { cleanup(); });

describe('B3 — the awaiting readers and the chain’s activity as the DTO exposes it', () => {
  it('selectAwaitingCountersign reads the awaiting rows; a row is STRANDED only when awaiting and served without the overlay', () => {
    useStore.setState({ decisions: [dec({ id: 'P' }), awaiting('A1'), stranded('S1'), dec({ id: 'D', draft: true, status: 'awaiting_countersign' })] } as never);
    expect(selectAwaitingCountersign(s()).map((d) => d.id)).toEqual(['A1', 'S1']);
    expect(isStrandedCountersign(awaiting('x'))).toBe(false);
    expect(isStrandedCountersign(stranded('x'))).toBe(true);
    // a pending row under an inactive chain is not stranded — only an awaiting one can be
    expect(isStrandedCountersign(dec({ id: 'x' }))).toBe(false);
  });

  it('the obligations: the architect owes every countersign, the PMC owes the stranded resolutions, nobody else owes anything', () => {
    useStore.setState({ decisions: [dec({ id: 'P' }), awaiting('A1'), awaiting('A2'), stranded('S1')] } as never);
    as('architect');
    expect(selectCountersignObligations(s()).map((d) => d.id)).toEqual(['A1', 'A2', 'S1']);
    as('pmc');
    expect(selectCountersignObligations(s()).map((d) => d.id)).toEqual(['S1']);
    for (const role of ['client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      as(role);
      expect(selectCountersignObligations(s()), role).toEqual([]);
    }
    // with an active chain the PMC owes nothing here: the countersigns are the architect's
    useStore.setState({ decisions: [awaiting('A1'), awaiting('A2')] } as never);
    as('pmc');
    expect(selectCountersignObligations(s())).toEqual([]);
  });
});

describe('B3 — the audience mirrors admit an awaiting row exactly as decisionVisibleToViewer does', () => {
  const rows = [
    awaiting('A-CLI', { deciderKind: 'client' }),
    awaiting('A-MEM', { deciderKind: 'member', deciderUserId: 'u-eng', consultations: [{ id: 'c1', consulteeMembershipId: 'm-con', consulteeUserId: 'u-con', requestedById: 'u-pmc', question: 'q', openCycle: 0, requestedAt: 't' }] }),
    dec({ id: 'P-CLI', deciderKind: 'client' }),
    dec({ id: 'W', status: 'withdrawn' }),
    dec({ id: 'OK', status: 'approved' }),
  ];
  const seen = (role: Role, userId: string | null) => {
    as(role, userId);
    const log = selectLogDecisions(s()).map((d) => d.id).sort();
    const visible = selectVisibleDecisions(s()).map((d) => d.id).sort();
    expect(visible, `${role}: the two mirrors agree`).toEqual(log);
    return log;
  };
  beforeEach(() => { useStore.setState({ decisions: rows } as never); });

  it('the PMC reads everything; the ARCHITECT reads every open demand (pending and awaiting) but never a withdrawn row', () => {
    expect(seen('pmc', 'u-pmc')).toEqual(['A-CLI', 'A-MEM', 'OK', 'P-CLI', 'W']);
    expect(seen('architect', 'u-arch')).toEqual(['A-CLI', 'A-MEM', 'OK', 'P-CLI']);
  });

  it('the decider and a standing consultee read the awaiting row whose approval it carries; a same-role non-decider does not', () => {
    expect(seen('client', 'u-cli')).toEqual(['A-CLI', 'OK', 'P-CLI']);
    expect(seen('engineer', 'u-eng')).toEqual(['A-MEM', 'OK']); // the named member-decider
    expect(seen('consultant', 'u-con')).toEqual(['A-MEM', 'OK']); // the standing consultee
    expect(seen('engineer', 'u-other')).toEqual(['OK']);
    expect(seen('contractor', 'u-x')).toEqual(['OK']);
  });
});

describe('B3 — the Inbox branch (§A.2): the architect’s item, the PMC’s summary and the PMC’s red stranded item', () => {
  it('the architect gets ONE amber item naming the count, pointed at the Decision Log', () => {
    useStore.setState({ decisions: [awaiting('A1', { title: 'Kitchen top' }), awaiting('A2', { title: 'Main door' }), dec({ id: 'P' })] } as never);
    as('architect');
    const items = selectActionItems(s());
    const item = items.find((i) => i.key === 'arch-countersign')!;
    expect(item).toBeTruthy();
    expect(item.title).toBe('2 decisions awaiting your countersign');
    expect(item.detail).toBe('Kitchen top, Main door');
    expect(item.screen).toBe('decision-log');
    expect(item.tone).toBe('amber');
    // the architect is not the decider of a client-held pending row: no approval item is invented for them
    expect(items.map((i) => i.key)).not.toContain('decider-pending');
  });

  it('the PMC gets the ink summary for the rows the architect holds and the RED stranded item for the rows nobody can countersign', () => {
    useStore.setState({ decisions: [awaiting('A1', { title: 'Kitchen top' }), stranded('S1', { title: 'Main door' }), stranded('S2', { title: 'Terrace tiles' })] } as never);
    as('pmc');
    const items = selectActionItems(s());
    const held = items.find((i) => i.key === 'pmc-countersign')!;
    expect(held.title).toBe('1 decision awaiting the architect’s countersign');
    expect(held.tone).toBe('ink');
    expect(held.screen).toBe('decision-log');
    const red = items.find((i) => i.key === 'pmc-stranded')!;
    expect(red.title).toBe('2 decisions stranded — no architect to countersign');
    expect(red.detail).toBe('Main door, Terrace tiles');
    expect(red.tone).toBe('red');
    expect(red.cta).toBe('Resolve');
    // the stranded item comes first: it is the PMC's own work; the summary describes the architect's
    expect(items.findIndex((i) => i.key === 'pmc-stranded')).toBeLessThan(items.findIndex((i) => i.key === 'pmc-countersign'));
  });

  it('an awaiting row is nobody else’s Inbox work, and with NO awaiting rows (the doors standing) none of the three items exists for anyone', () => {
    useStore.setState({ decisions: [awaiting('A1'), stranded('S1')] } as never);
    for (const role of ['client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      as(role);
      const keys = selectActionItems(s()).map((i) => i.key);
      expect(keys, role).not.toContain('arch-countersign');
      expect(keys, role).not.toContain('pmc-countersign');
      expect(keys, role).not.toContain('pmc-stranded');
      // an awaiting row has its decider's approval: it never re-demands one
      expect(keys, role).not.toContain('client-pending');
      expect(keys, role).not.toContain('decider-pending');
    }
    useStore.setState({ decisions: [dec({ id: 'P' }), dec({ id: 'C', status: 'change' })] } as never);
    for (const role of ['pmc', 'architect'] as Role[]) {
      as(role);
      const keys = selectActionItems(s()).map((i) => i.key);
      expect(keys.filter((k) => ['arch-countersign', 'pmc-countersign', 'pmc-stranded'].includes(k)), role).toEqual([]);
    }
  });
});

describe('B3 — the Decision Log badge carries the countersign obligations; the approval route and its badge stay on actionable states', () => {
  it('architect: the Decision Log badge is the awaiting count; pmc: the stranded count; the approval badge never counts an awaiting row', () => {
    useStore.setState({ decisions: [awaiting('A1'), awaiting('A2'), stranded('S1'), dec({ id: 'P', deciderKind: 'pmc' })] } as never);
    as('architect');
    let nav = renderHook(() => useNavItems()).result.current;
    expect(nav.find((m) => m.key === 'decision-log')!.badge).toBe(3);
    as('pmc');
    nav = renderHook(() => useNavItems()).result.current;
    expect(nav.find((m) => m.key === 'decision-log')!.badge).toBe(1);
    // the PMC's own approval task (the pmc-held pending row) is the approval badge's, unchanged by the awaiting rows
    expect(nav.find((m) => m.key === 'client-decisions')!.badge).toBe(1);
    expect(selectDeciderPending(s()).length + selectDeciderReapproval(s()).length).toBe(1);
  });

  it('a named member-decider holding ONLY an awaiting decision gets no approval route, no approval badge and a zero Decision Log badge (#677 review, finding 4145060024)', () => {
    useStore.setState({ decisions: [awaiting('A-MEM', { deciderKind: 'member', deciderUserId: 'u-eng' })] } as never);
    as('engineer', 'u-eng');
    const nav = renderHook(() => useNavItems()).result.current;
    expect(nav.some((m) => m.key === 'client-decisions')).toBe(false);
    expect(nav.find((m) => m.key === 'decision-log')!.badge).toBe(0);
    // RouteBridge's decider-route set stays pending/change — the source pin the tripwire's verdict rests on
    expect(routeBridgeSource).toContain("(d.status === 'pending' || d.status === 'change') && viewerIsDecider(d, s.role, s.sessionUserId)");
    expect(routeBridgeSource).not.toContain("d.status === 'awaiting_countersign'");
  });
});

describe('B3 — the register answers the value: label, rank, filter chip, rollup chip, the row and the status chip', () => {
  it('groupDecisions by status labels the group "Awaiting countersign" and ranks it between change and approved', () => {
    const groups = groupDecisions([dec({ id: 'OK', status: 'approved' }), awaiting('A1'), dec({ id: 'P' }), dec({ id: 'C', status: 'change' }), dec({ id: 'R', status: 'recorded' })], [], 'status');
    expect(groups.map((g) => g.key)).toEqual(['pending', 'change', 'awaiting_countersign', 'approved', 'recorded']);
    expect(groups.find((g) => g.key === 'awaiting_countersign')!.label).toBe('Awaiting countersign');
    expect(groups.find((g) => g.key === 'awaiting_countersign')!.counts.awaiting_countersign).toBe(1);
  });

  it('the status chip renders the value in its OWN styling, never the withdrawn fallback', () => {
    const r = render(<><DecisionChip status="awaiting_countersign" /><DecisionChip status="withdrawn" /></>);
    const chip = r.getByText(decisionChipLabel.awaiting_countersign);
    const fallback = r.getByText(decisionChipLabel.withdrawn);
    expect(chip.textContent).toBe('AWAITING COUNTERSIGN');
    expect(chip.style.color).not.toBe('');
    expect(chip.style.color).not.toBe(fallback.style.color);
    expect(decisionChip.awaiting_countersign).not.toEqual(decisionChip.withdrawn);
  });

  it('the Decision Log: the filter chips, the group rollup and the row — a provisional approval, its attribution, no lock', () => {
    useStore.setState({ decisions: [awaiting('A1', { title: 'Kitchen top' }), dec({ id: 'P', title: 'Main door' }), dec({ id: 'OK', title: 'Tiles', status: 'approved', approver: 'Mr. Shah', date: '01 Jul 2026', approvedOption: 'A', material: 'Granite', cost: 0 })] } as never);
    as('pmc');
    const r = render(<DecisionLogScreen />);
    // every status has its chip, the two B3 adds included
    for (const key of ['pending', 'approved', 'change', 'withdrawn', 'recorded', 'awaiting_countersign']) expect(r.getByTestId(`filter-${key}`)).toBeTruthy();
    // the group rollup counts the awaiting row under its own dot
    expect(r.getByTitle('1 awaiting countersign')).toBeTruthy();
    // the row: the provisional approval, attributed and still waiting; the lock is final-only
    const row = r.getByTestId('log-row-A1');
    expect(row.textContent).toContain('Approved by Mr. Shah — awaiting the architect’s countersign');
    expect(row.textContent).toContain('A — Granite');
    expect(row.textContent).toContain('PROVISIONAL');
    expect(row.textContent).toContain('AWAITING COUNTERSIGN');
    expect(row.textContent).not.toContain('awaiting client');
    expect(r.queryByTestId('lock-A1')).toBeNull();
    expect(r.getByTestId('lock-OK')).toBeTruthy();
    // withdrawing the DECISION is offered only on a never-approved pending row
    expect(r.queryByTestId('withdraw-decision-A1')).toBeNull();
    // the filter chip narrows the register to the awaiting row alone
    fireEvent.click(r.getByTestId('filter-awaiting_countersign'));
    expect(r.getByTestId('log-row-A1')).toBeTruthy();
    expect(r.queryByTestId('log-row-P')).toBeNull();
    expect(r.queryByTestId('log-row-OK')).toBeNull();
  });
});
