import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { clientDecisionLabels as L, type Decision } from '@vitan/shared';

/**
 * U2b (design review, Client · Decision board): one decision on its own screen — pick one option,
 * then approve it through the SAME confirmation as the list (`openApprove` → `ApproveModal`).
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, title: `Kitchen countertop ${id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client',
  options: [
    { label: 'Option A', key: 'A', material: 'Granite', delta: 0, swatch: 'stone', recommended: true },
    { label: 'Option B', key: 'B', material: 'Quartz', delta: 20000, swatch: 'marble', recommended: false },
  ],
  ...over,
} as unknown as Decision);

async function load(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role: 'client', lang: 'en',
    short: 'Ambli', screen: 'client-decisions', decisions: [dec('D-1'), dec('D-2')], ...overrides,
  });
  const { ClientDecisionsScreen: Screen } = await import('@/screens/ClientDecisionsScreen');
  return { useStore, Screen, r: render(<Screen />) };
}

describe('U2b — one decision on its own screen', () => {
  it('opens the decision asked for; nothing is chosen for the client until they pick', async () => {
    const { useStore, Screen, r } = await load();
    useStore.getState().openDecision('D-2');
    r.rerender(<Screen />);
    expect(useStore.getState().screen).toBe('client-decisions');
    expect(r.getByTestId('decision-focus').dataset.decision).toBe('D-2');
    expect(r.getByTestId('decision-focus').textContent).toContain(L.pick.en);
    expect(r.getByTestId('decision-focus').textContent).toContain(L.recommends.en); // marked, not preselected
    const approve = r.getByTestId('decision-focus-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toBe(L.pickFirst.en);
    fireEvent.click(r.getByTestId('decision-option-D-2-B'));
    expect(r.getByTestId('decision-option-D-2-B').getAttribute('aria-checked')).toBe('true');
    expect(r.getByTestId('decision-option-D-2-B').textContent).toContain('+ ₹20,000');
    expect(r.getByTestId('decision-option-D-2-A').textContent).toContain(L.noChange.en);
    expect(approve.textContent).toBe('Approve Quartz');
  });

  it('approving goes through the existing confirmation, for the option picked', async () => {
    const { useStore, r } = await load({ decisionFocus: 'D-1' });
    fireEvent.click(r.getByTestId('decision-option-D-1-B'));
    fireEvent.click(r.getByTestId('decision-focus-approve'));
    expect(useStore.getState().modal).toMatchObject({ type: 'approve', decId: 'D-1', optIdx: 1 });
  });

  it('the lock note says where an approval goes when the architect must countersign', async () => {
    const plain = await load({ decisionFocus: 'D-1' });
    expect(plain.r.getByTestId('decision-focus-lock').textContent).toBe(L.lock.en);
    cleanup();
    const cs = await load({ decisionFocus: 'D-1', decisions: [dec('D-1', { countersignRequired: true } as Partial<Decision>)] });
    expect(cs.r.getByTestId('decision-focus-lock').textContent).toBe(L.lockCountersign.en);
  });

  it('a reopened decision shows its change request', async () => {
    const reopened = dec('D-3', { status: 'change', changeRequest: { reason: 'Lot rejected', costImpact: 0, timeImpactDays: 2 } } as Partial<Decision>);
    const { r } = await load({ decisionFocus: 'D-3', decisions: [reopened] });
    expect(r.getByTestId('decision-focus').textContent).toContain(L.reopened.en);
    expect(r.getByTestId('cr-context-D-3').textContent).toContain('Change requested: Lot rejected');
  });

  it('Back, the nav, and a decision no longer theirs all return to the list', async () => {
    const { useStore, r } = await load({ decisionFocus: 'D-1' });
    fireEvent.click(r.getByTestId('decision-focus-back'));
    expect(useStore.getState().decisionFocus).toBeNull();
    expect(r.getByText('Decisions waiting for you')).toBeTruthy();

    useStore.getState().openDecision('D-1');
    useStore.getState().setScreen('client-decisions'); // the nav's own way in starts at the list
    expect(useStore.getState().decisionFocus).toBeNull();

    // held by the PMC: not this client's to decide, so never shown on its own screen
    cleanup();
    const other = await load({ decisionFocus: 'D-9', decisions: [dec('D-9', { deciderKind: 'pmc' })] });
    expect(other.r.queryByTestId('decision-focus')).toBeNull();
    expect(other.useStore.getState().decisionFocus).toBeNull();
  });

  it('once approved, the screen lets go of it', async () => {
    const { useStore, Screen, r } = await load({ decisionFocus: 'D-1' });
    expect(r.getByTestId('decision-focus')).toBeTruthy();
    useStore.setState((s) => { s.decisions = s.decisions.map((d) => (d.id === 'D-1' ? { ...d, status: 'approved' } : d)); });
    r.rerender(<Screen />);
    expect(r.queryByTestId('decision-focus')).toBeNull();
    expect(useStore.getState().decisionFocus).toBeNull();
  });

  it("speaks the client's language", async () => {
    const { r } = await load({ decisionFocus: 'D-1', lang: 'gu' });
    expect(r.getByTestId('decision-focus').textContent).toContain(L.pick.gu);
    fireEvent.click(r.getByTestId('decision-option-D-1-A'));
    expect(r.getByTestId('decision-focus-approve').textContent).toBe('Granite મંજૂર કરો');
  });
});

describe("U2b — the Pulse's way in opens that decision", () => {
  it('"See the 2 options" opens the waiting decision on its own screen', async () => {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role: 'client', lang: 'en', short: 'Ambli', screen: 'inbox', decisions: [dec('D-1')] });
    const { InboxScreen } = await import('@/screens/InboxScreen');
    const r = render(<InboxScreen />);
    fireEvent.click(r.getByTestId('pulse-needs-go'));
    expect(useStore.getState()).toMatchObject({ screen: 'client-decisions', decisionFocus: 'D-1' });
  });
});
