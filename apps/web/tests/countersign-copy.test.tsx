import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import { ApproveModal } from '@/screens/modals/ApproveModal';
import { ConsultationThread } from '@/components/ConsultationThread';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import { ClientDecisionsScreen } from '@/screens/ClientDecisionsScreen';
import type { Decision, ProjectMember } from '@vitan/shared';

/**
 * Phase 6 task 4d-ii-b / B4 — the COPY, the consultation surface and the withdraw rule (the web arms of
 * P31's provisional copy under an active chain and of P33's suppressed Withdraw).
 *
 * Under an active architect chain an approval is PROVISIONAL: the server's compare-and-set lands the
 * decision `awaiting_countersign` (4d-ii-a / A8a) and overlays `countersignRequired` on every row it
 * serves (A5c). B4 makes the client say what actually happens — before the act (the confirmation reads
 * the overlay) and after it (the toast reads the RETURNED snapshot's status) — widens the consultation
 * surface's open set to the server's, loads the roster the chooser needs, and withholds Withdraw from a
 * request the architect opened by rejecting a countersign (the service 409s it). Every test PLANTS both
 * shapes: with the 4d facts, and without them, where the copy must be byte-identical to what it was.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: over.title ?? `Title ${over.id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true }, { label: 'B', key: 'b', material: 'Quartz', delta: 12000, swatch: 'tile' }],
    ageDays: 2, approvalCycle: 0, ...over,
  }) as Decision;
const member = (userId: string, role: ProjectMember['role']): ProjectMember =>
  ({ userId, membershipId: `m-${userId}`, name: userId, email: null, phone: null, role, status: 'active' }) as ProjectMember;
function makeSnapshot(decisions: Decision[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions, activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}
/** an unsigned JWT-shaped token whose `sub` the screens read for the requester rule */
const tokenFor = (sub: string) => `h.${btoa(JSON.stringify({ sub }))}.s`;

beforeEach(() => { useStore.setState(getInitialState()); s()._setGateway(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B4 — the confirmation reads countersignRequired', () => {
  it('under an active chain the modal says the approval is sent to the architect; without the overlay the delivered copy is byte-identical', () => {
    useStore.setState({ role: 'client', decisions: [dec({ id: 'DL-CH', countersignRequired: true }), dec({ id: 'DL-PLAIN' })] } as never);
    s().openApprove('DL-CH', 0);
    let r = render(<ApproveModal />);
    expect(r.getByTestId('approve-outcome').textContent).toContain('Will be sent to the architect for countersign');
    expect(r.getByTestId('approve-explainer').textContent).toContain('sent to the architect for countersign');
    expect(r.getByTestId('approve-explainer').textContent).toContain('locks when the architect countersigns');
    expect(r.getByTestId('approve-lock').textContent).toBe('Approve & send for countersign');
    expect(r.getByTestId('approve-outcome').textContent).not.toContain('Will be locked');
    cleanup();

    s().openApprove('DL-PLAIN', 0);
    r = render(<ApproveModal />);
    expect(r.getByTestId('approve-outcome').textContent).toBe('Will be locked ');
    expect(r.getByTestId('approve-explainer').textContent).toBe('This decision will be recorded against your name, time-stamped, and locked. Any later change needs a formal Change Request.');
    expect(r.getByTestId('approve-lock').textContent).toBe('Approve & Lock');
  });
});

describe('B4 — the success copy follows the RETURNED snapshot', () => {
  const approveVia = async (returned: Decision[]): Promise<string | null> => {
    const gw = { approveDecision: vi.fn().mockResolvedValue(makeSnapshot(returned)) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ role: 'client', decisions: [dec({ id: 'DL-014', countersignRequired: true })] } as never);
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    await flush();
    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1, expect.any(String));
    return s().toast;
  };

  it('a row returned awaiting_countersign is announced as awaiting the architect', async () => {
    expect(await approveVia([dec({ id: 'DL-014', status: 'awaiting_countersign', approvedOption: 'B', approver: 'Mr. Shah', countersignRequired: true })]))
      .toBe('Approved — awaiting the architect’s countersign.');
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('awaiting_countersign');
  });

  it('a row returned approved keeps the delivered copy, even when the confirmation had read the overlay', async () => {
    expect(await approveVia([dec({ id: 'DL-014', status: 'approved', approvedOption: 'B', approver: 'Mr. Shah' })]))
      .toBe('Approved & locked — saved to the server.');
  });

  it('a returned slice that does not carry the row invents nothing: the delivered copy', async () => {
    expect(await approveVia([])).toBe('Approved & locked — saved to the server.');
  });
});

describe('B4 — the consultation surface: the server’s open set, and the roster loaded for the chooser', () => {
  const pmcWith = (members: ProjectMember[]) => {
    const loadTeam = vi.fn(() => Promise.resolve());
    useStore.setState({ role: 'pmc', sessionUserId: 'u-pmc', members, loadTeam } as never);
    return loadTeam;
  };

  it('an awaiting decision is still open to advice: Ask is offered on it as on a pending or reopened one, never on an approved one', () => {
    pmcWith([member('u-pmc', 'pmc'), member('u-eng', 'engineer')]);
    for (const status of ['pending', 'change', 'awaiting_countersign'] as Decision['status'][]) {
      const r = render(<ConsultationThread decision={dec({ id: `D-${status}`, status })} />);
      expect(r.queryByTestId(`consultation-ask-D-${status}`), status).not.toBeNull();
      cleanup();
    }
    for (const status of ['approved', 'recorded', 'withdrawn'] as Decision['status'][]) {
      const r = render(<ConsultationThread decision={dec({ id: `D-${status}`, status })} />);
      expect(r.queryByTestId(`consultation-ask-D-${status}`), status).toBeNull();
      cleanup();
    }
  });

  it('opening the chooser over an EMPTY roster loads it once; over a loaded roster it does not', () => {
    let loadTeam = pmcWith([]);
    let r = render(<ConsultationThread decision={dec({ id: 'D1', status: 'awaiting_countersign' })} />);
    expect(loadTeam).not.toHaveBeenCalled(); // never on render — a register of N rows would fire N reads
    fireEvent.click(r.getByTestId('consultation-ask-D1'));
    expect(loadTeam).toHaveBeenCalledTimes(1);
    cleanup();

    loadTeam = pmcWith([member('u-pmc', 'pmc'), member('u-eng', 'engineer')]);
    r = render(<ConsultationThread decision={dec({ id: 'D2' })} />);
    fireEvent.click(r.getByTestId('consultation-ask-D2'));
    expect(loadTeam).not.toHaveBeenCalled();
    expect(r.getByLabelText('Who to ask')).toBeTruthy();
  });
});

describe('B4 — Withdraw is withheld from a countersign rejection, and the rejection reads as what it is', () => {
  const rows = [
    dec({ id: 'DL-REJ', title: 'Kitchen top', status: 'change', approvedOption: 'A', material: 'Granite', cost: 0, approver: 'Mr. Shah', date: '01 Jul 2026',
      changeRequest: { reason: 'Veneer grain runs the wrong way', costImpact: 0, timeImpactDays: 2, requestedById: 'u-arch', origin: 'countersign_rejection' } }),
    dec({ id: 'DL-STD', title: 'Main door', status: 'change', approvedOption: 'A', material: 'Granite', cost: 0, approver: 'Mr. Shah', date: '01 Jul 2026',
      changeRequest: { reason: 'Lot rejected', costImpact: 5000, timeImpactDays: 0, requestedById: 'u-eng' } }),
  ];

  it('the PMC may withdraw a standard request but not the architect’s rejection; the rejection names its origin and impacts', () => {
    useStore.setState({ role: 'pmc', sessionToken: tokenFor('u-pmc'), sessionUserId: 'u-pmc', decisions: rows } as never);
    const r = render(<DecisionLogScreen />);
    expect(r.queryByTestId('withdraw-DL-STD')).not.toBeNull();
    expect(r.queryByTestId('withdraw-DL-REJ')).toBeNull();
    expect(r.getByTestId('cr-origin-DL-REJ').textContent).toBe('Sent back by the architect: Veneer grain runs the wrong way');
    expect(r.getByTestId('cr-detail-DL-REJ').textContent).toContain('2 days');
    expect(r.getByTestId('cr-detail-DL-REJ').textContent).toContain('awaiting the client’s re-approval');
    // the standard request reads exactly as it always did
    expect(r.getByTestId('cr-detail-DL-STD').textContent).toContain('Change requested: Lot rejected');
    expect(r.queryByTestId('cr-origin-DL-STD')).toBeNull();
  });

  it('the requester of a standard request may withdraw it; the rejection is withheld from every viewer, the requester included', () => {
    useStore.setState({ role: 'engineer', sessionToken: tokenFor('u-eng'), sessionUserId: 'u-eng', decisions: rows } as never);
    let r = render(<DecisionLogScreen />);
    expect(r.queryByTestId('withdraw-DL-STD')).not.toBeNull();
    cleanup();
    useStore.setState({ role: 'engineer', sessionToken: tokenFor('u-arch'), sessionUserId: 'u-arch', decisions: rows } as never);
    r = render(<DecisionLogScreen />);
    expect(r.queryByTestId('withdraw-DL-REJ')).toBeNull();
  });

  it('the approval surface tells the decider their approval was sent back, not that a colleague asked for a change', () => {
    useStore.setState({ role: 'client', sessionUserId: 'u-cli', decisions: rows } as never);
    const r = render(<ClientDecisionsScreen />);
    expect(r.getByTestId('cr-origin-DL-REJ').textContent).toBe('Sent back by the architect: Veneer grain runs the wrong way');
    expect(r.getByTestId('cr-context-DL-STD').textContent).toContain('Change requested: Lot rejected');
  });
});
