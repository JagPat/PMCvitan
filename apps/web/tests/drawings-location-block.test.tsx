import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Drawing, DrawingRevision, ProjectNode } from '@vitan/shared';

/**
 * Phase 2 Task 10 correction round 2 (C2b) — the drawing LOCATION editor is a set of drawing MUTATIONS
 * (re-file / unfile). Under module read-ownership (VITE_DRAWINGS_READ=moduleQuery) it must honour the same
 * single `drawingMutationsBlocked` gate as every other drawing command:
 *   • while the register is idle / loading / error (module read unsettled), the Move/File control is
 *     DISABLED — you cannot even open the location editor against stale/absent data;
 *   • if the register becomes blocked WHILE the editor is already open, the picker + Unfile disable
 *     immediately and a "paused" notice appears — every location mutation command is prevented;
 *   • once the read settles ('ready'), the controls re-enable for an authorized PMC user.
 * The store's own defensive `fileDrawing` guard remains the backstop; this is the UI half of the same gate.
 */

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=tok`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string, nodeId?: string): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)], nodeId,
});
const NODES: ProjectNode[] = [{ id: 'z1', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }];

type StoreState = Record<string, unknown>;

async function loadViewer(mode: 'snapshot' | 'moduleQuery', overrides: StoreState) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DRAWINGS_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc', // pmc holds drawing.file → the Move/Unfile controls render, so we can assert their state
    short: 'Villa Bodakdev',
    nodes: NODES,
    ...overrides,
  });
  const { DrawingViewer } = await import('@/screens/DrawingsScreen');
  return { useStore, DrawingViewer };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('C2b — DrawingLocationBlock honours drawingMutationsBlocked (moduleQuery)', () => {
  it('error WITH last-good: the Move/re-file control is DISABLED (cannot open the editor on stale data)', async () => {
    const { DrawingViewer } = await loadViewer('moduleQuery', { drawings: [dwg('DWG-1', 'A-101', 'z1')], drawingsLoad: 'error' });
    const r = render(<DrawingViewer drawing={dwg('DWG-1', 'A-101', 'z1')} onClose={() => {}} />);
    expect(r.getByTestId('drawing-refile')).toBeDisabled();
  });

  it('loading WITH last-good: the Move/re-file control is DISABLED until the read settles', async () => {
    const { DrawingViewer } = await loadViewer('moduleQuery', { drawings: [dwg('DWG-1', 'A-101', 'z1')], drawingsLoad: 'loading' });
    const r = render(<DrawingViewer drawing={dwg('DWG-1', 'A-101', 'z1')} onClose={() => {}} />);
    expect(r.getByTestId('drawing-refile')).toBeDisabled();
  });

  it('a click on the disabled Move control does NOT open the location editor', async () => {
    const { DrawingViewer } = await loadViewer('moduleQuery', { drawings: [dwg('DWG-1', 'A-101', 'z1')], drawingsLoad: 'error' });
    const r = render(<DrawingViewer drawing={dwg('DWG-1', 'A-101', 'z1')} onClose={() => {}} />);
    fireEvent.click(r.getByTestId('drawing-refile'));
    expect(r.queryByTestId('drawing-unfile')).not.toBeInTheDocument(); // editor never opened
  });

  it('register goes blocked WHILE the editor is OPEN: the Unfile control disables + a paused notice appears', async () => {
    const drawing = dwg('DWG-1', 'A-101', 'z1');
    const { useStore, DrawingViewer } = await loadViewer('moduleQuery', { drawings: [drawing], drawingsLoad: 'ready' });
    const r = render(<DrawingViewer drawing={drawing} onClose={() => {}} />);
    // ready → open the editor; Unfile is enabled and there is no paused notice
    fireEvent.click(r.getByTestId('drawing-refile'));
    expect(r.getByTestId('drawing-unfile')).not.toBeDisabled();
    expect(r.queryByTestId('drawing-location-paused')).not.toBeInTheDocument();
    // the module read fails while the editor is still open → every location mutation is prevented
    act(() => { useStore.setState({ drawingsLoad: 'error' }); });
    expect(r.getByTestId('drawing-unfile')).toBeDisabled();
    expect(r.getByTestId('drawing-location-paused')).toBeInTheDocument();
    // clicking the now-disabled Unfile never reaches the fileDrawing command (belt-and-braces with the
    // component's own `if (locked) return` guard) — the drawing's location is untouched
    const before = useStore.getState().drawings.find((d) => d.id === 'DWG-1')?.nodeId;
    fireEvent.click(r.getByTestId('drawing-unfile'));
    expect(useStore.getState().drawings.find((d) => d.id === 'DWG-1')?.nodeId).toBe(before); // unchanged
  });

  it('ready: the Move control is ENABLED and, once the editor is open, so is Unfile (no paused notice)', async () => {
    const drawing = dwg('DWG-1', 'A-101', 'z1');
    const { DrawingViewer } = await loadViewer('moduleQuery', { drawings: [drawing], drawingsLoad: 'ready' });
    const r = render(<DrawingViewer drawing={drawing} onClose={() => {}} />);
    expect(r.getByTestId('drawing-refile')).not.toBeDisabled();
    fireEvent.click(r.getByTestId('drawing-refile'));
    expect(r.getByTestId('drawing-unfile')).not.toBeDisabled();
    expect(r.queryByTestId('drawing-location-paused')).not.toBeInTheDocument();
  });

  it('re-enable: a register that recovers to ready unlocks the location controls again', async () => {
    const drawing = dwg('DWG-1', 'A-101', 'z1');
    const { useStore, DrawingViewer } = await loadViewer('moduleQuery', { drawings: [drawing], drawingsLoad: 'error' });
    const r = render(<DrawingViewer drawing={drawing} onClose={() => {}} />);
    expect(r.getByTestId('drawing-refile')).toBeDisabled();
    act(() => { useStore.setState({ drawingsLoad: 'ready' }); });
    expect(r.getByTestId('drawing-refile')).not.toBeDisabled();
  });
});

describe('C2b — snapshot mode leaves the location controls unlocked (no regression)', () => {
  it('a snapshot-mode register never locks Move/Unfile, whatever drawingsLoad reads', async () => {
    const drawing = dwg('DWG-1', 'A-101', 'z1');
    const { DrawingViewer } = await loadViewer('snapshot', { drawings: [drawing], drawingsLoad: 'idle' });
    const r = render(<DrawingViewer drawing={drawing} onClose={() => {}} />);
    expect(r.getByTestId('drawing-refile')).not.toBeDisabled();
    fireEvent.click(r.getByTestId('drawing-refile'));
    expect(r.getByTestId('drawing-unfile')).not.toBeDisabled();
    expect(r.queryByTestId('drawing-location-paused')).not.toBeInTheDocument();
  });
});
