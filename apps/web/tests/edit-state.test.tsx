import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Decision, Drawing, DrawingRevision, ProjectNode } from '@vitan/shared';

/**
 * Editing states — "can I edit this? if not, why? what may I do instead?"
 *
 * The governance rules are unchanged: an approved decision is still locked, a change request is
 * still with the client, a drawing's location still cannot be moved off an unsettled register, and
 * only the PMC files a drawing. What changes is that each of those states now STATES ITS REASON and
 * offers the valid next action, instead of a lock glyph or a greyed control that explains nothing.
 */

const NODES: ProjectNode[] = [{ id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }];

const decision = (id: string, status: Decision['status'], extra: Partial<Decision> = {}): Decision => ({
  id, title: 'Floor tile', room: 'Ground Floor', nodeId: 'gf', status,
  options: [
    { key: 'a', material: 'Kota', delta: 0, swatch: 'tile', recommended: true },
    { key: 'b', material: 'Marble', delta: 40000, swatch: 'tile', recommended: false },
  ],
  approvedOption: status === 'approved' ? 'a' : undefined,
  material: 'Kota', cost: 0, approver: status === 'approved' ? 'Mr Shah' : undefined,
  date: '01 Aug 2026', ageDays: 3, photoSwatch: 'tile',
  ...extra,
} as Decision);

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}`,
  sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (nodeId?: string): Drawing => ({
  id: 'DWG-1', number: 'A-101', title: 'Plan', discipline: 'architectural', zone: 'GF',
  activityId: null, decisionId: null, draft: false, current: rev('r1'), ackedByMe: false,
  revisions: [rev('r1')], nodeId,
});

async function loadStore(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc',
    short: 'Villa Bodakdev',
    nodes: NODES,
    ...overrides,
  });
  return useStore;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('EditState — the shared presentation', () => {
  it('carries its verdict, its reason and its action', async () => {
    await loadStore();
    const { EditState } = await import('@/components');
    const clicks: number[] = [];
    const r = render(
      <EditState
        state="locked"
        reason="Locked after approval"
        action={{ label: 'Request change', onClick: () => clicks.push(1), testId: 'act' }}
        testId="es"
      />,
    );
    expect(r.getByTestId('es')).toHaveAttribute('data-edit-state', 'locked');
    expect(r.getByTestId('es').textContent).toContain('Locked after approval');
    fireEvent.click(r.getByTestId('act'));
    expect(clicks).toEqual([1]);
  });

  it('a disabled action still says WHY it is disabled — the control is never silently inert', async () => {
    await loadStore();
    const { EditState } = await import('@/components');
    const r = render(
      <EditState state="paused" reason="Still loading — paused until it refreshes." action={{ label: 'Move', onClick: () => {}, disabled: true, testId: 'act' }} testId="es" />,
    );
    expect(r.getByTestId('act')).toBeDisabled();
    expect(r.getByTestId('es').textContent).toContain('paused until it refreshes');
  });
});

describe('an approved decision is locked, and says so', () => {
  it('states the reason and offers Request change', async () => {
    const useStore = await loadStore({ decisions: [decision('D-1', 'approved')] });
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    const r = render(<DecisionLogScreen />);
    const state = r.getByTestId('edit-state-D-1');
    expect(state).toHaveAttribute('data-edit-state', 'locked');
    expect(state.textContent).toContain('Locked after approval');
    // the valid next action is present and drives the existing change-request flow
    fireEvent.click(r.getByTestId('request-change-D-1'));
    expect(useStore.getState().modal.type).toBe('change');
  });

  it('a PENDING decision is not presented as locked', async () => {
    await loadStore({ decisions: [decision('D-2', 'pending')] });
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    const r = render(<DecisionLogScreen />);
    expect(r.queryByTestId('edit-state-D-2')).not.toBeInTheDocument();
  });

  it('a decision with a change request reads as workflow-blocked, not as editable', async () => {
    await loadStore({
      decisions: [decision('D-3', 'change', { changeRequest: { reason: 'Different tone', costImpact: 0, timeImpactDays: 0 } })],
    });
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    const r = render(<DecisionLogScreen />);
    const state = r.getByTestId('edit-state-D-3');
    expect(state).toHaveAttribute('data-edit-state', 'workflow');
    expect(state.textContent).toContain('with the client');
  });
});

describe("a drawing's location control explains every state it can be in", () => {
  it('editable: the action is offered with a reason', async () => {
    await loadStore({ drawings: [dwg('gf')] });
    const { DrawingViewer } = await import('@/screens/DrawingsScreen');
    const r = render(<DrawingViewer drawing={dwg('gf')} onClose={() => {}} />);
    expect(r.getByTestId('drawing-location-state')).toHaveAttribute('data-edit-state', 'editable');
    expect(r.getByTestId('drawing-refile')).not.toBeDisabled();
  });

  it('paused: the control stays visible but disabled, WITH the reason beside it', async () => {
    const useStore = await loadStore({ drawings: [dwg('gf')], drawingsLoad: 'loading' }, { VITE_DRAWINGS_READ: 'moduleQuery' });
    const { DrawingViewer } = await import('@/screens/DrawingsScreen');
    const r = render(<DrawingViewer drawing={dwg('gf')} onClose={() => {}} />);
    expect(r.getByTestId('drawing-location-state')).toHaveAttribute('data-edit-state', 'paused');
    expect(r.getByTestId('drawing-refile')).toBeDisabled();
    expect(r.getByTestId('drawing-location-state').textContent).toContain('still loading');
    // …and it recovers on its own when the register settles — the reason was honest
    act(() => { useStore.setState({ drawingsLoad: 'ready' }); });
    expect(r.getByTestId('drawing-location-state')).toHaveAttribute('data-edit-state', 'editable');
    expect(r.getByTestId('drawing-refile')).not.toBeDisabled();
  });

  it('restricted: a role without drawing.file is told WHO may file, not shown a dead end', async () => {
    await loadStore({ drawings: [dwg('gf')], role: 'contractor' });
    const { DrawingViewer } = await import('@/screens/DrawingsScreen');
    const r = render(<DrawingViewer drawing={dwg('gf')} onClose={() => {}} />);
    const state = r.getByTestId('drawing-location-state');
    expect(state).toHaveAttribute('data-edit-state', 'restricted');
    expect(state.textContent).toContain('Only the PMC');
    // the permission itself is unchanged: no action is offered
    expect(r.queryByTestId('drawing-refile')).not.toBeInTheDocument();
  });
});
