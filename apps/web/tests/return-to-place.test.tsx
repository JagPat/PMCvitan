import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RouteBridge } from '@/layout/RouteBridge';
import { useStore, getInitialState } from '@/store/store';
import { emptyProjectData } from '@/store/projectScope';
import { PlacesScreen } from '@/screens/PlacesScreen';
import { ReturnToPlace } from '@/components/ReturnToPlace';

/**
 * #633 (unit 1) — a record opened from the Site Map offers the way back to the place it was opened from:
 * named, one tap, on that record's screen only. Any other navigation, or a project switch, drops it.
 */
const s = () => useStore.getState();

beforeEach(() => useStore.setState(getInitialState()));
afterEach(cleanup);

describe('a record opened from the Site Map leads back to its place', () => {
  it('a drawing opened at a place shows "Back to <place>", which reopens that place', () => {
    const drawing = s().drawings.find((d) => !d.draft && d.nodeId);
    expect(drawing).toBeTruthy();
    const node = s().nodes.find((n) => n.id === drawing!.nodeId)!;
    useStore.setState((st) => { st.role = 'pmc'; st.screen = 'places'; st.routeItem = node.id; });
    render(<PlacesScreen />).getByTestId(`place-drawing-${drawing!.number}`).click();
    expect(s().screen).toBe('drawings');
    cleanup();
    const r = render(<ReturnToPlace />);
    expect(r.getByTestId('return-to-place').textContent).toContain(`Back to ${node.name}`);
    fireEvent.click(r.getByTestId('return-to-place'));
    expect(s().screen).toBe('places');
    expect(s().routeItem).toBe(node.id);
    expect(s().returnPlace).toBeNull();
  });

  it('a record opened from the whole-project view leads back to the Site Map itself', () => {
    const decision = s().decisions.find((d) => !d.draft && d.nodeId);
    expect(decision).toBeTruthy();
    useStore.setState((st) => { st.role = 'pmc'; st.screen = 'places'; st.routeItem = null; });
    fireEvent.click(render(<PlacesScreen />).getByTestId(`place-decision-${decision!.id}`));
    expect(s().screen).toBe('decision-log');
    cleanup();
    const r = render(<ReturnToPlace />);
    expect(r.getByTestId('return-to-place').textContent).toContain('Back to the Site Map');
    fireEvent.click(r.getByTestId('return-to-place'));
    expect(s().screen).toBe('places');
    expect(s().routeItem).toBeNull();
  });

  it('a place removed meanwhile returns to the Site Map, not to a missing place', () => {
    useStore.setState((st) => { st.screen = 'drawings'; st.routeItem = 'D-1'; st.returnPlace = { nodeId: 'GONE', screen: 'drawings', item: 'D-1' }; });
    const r = render(<ReturnToPlace />);
    expect(r.getByTestId('return-to-place').textContent).toContain('Back to the Site Map');
    fireEvent.click(r.getByTestId('return-to-place'));
    expect(s().routeItem).toBeNull();
  });
});

describe('the way back appears only where it applies', () => {
  it('a record opened from anywhere else offers no way back to a place', () => {
    const decision = s().decisions[0];
    useStore.setState((st) => { st.returnPlace = { nodeId: null, screen: 'decision-log', item: decision.id }; });
    s().openItem('decision-log', decision.id);
    expect(s().returnPlace).toBeNull();
    expect(render(<ReturnToPlace />).queryByTestId('return-to-place')).not.toBeInTheDocument();
  });

  it('a nav visit drops it', () => {
    s().openDrawing('any', { nodeId: null });
    expect(s().returnPlace).toEqual({ nodeId: null, screen: 'drawings', item: 'any' });
    s().setScreen('drawings');
    expect(s().returnPlace).toBeNull();
  });

  it('closing the record, or moving to another on the same screen, leaves the way back behind', () => {
    // #826 Codex 4257851275 — the way back belongs to the record opened from the place, not to its screen
    const [first, second] = s().drawings;
    s().openDrawing(first.id, { nodeId: null });
    const r = render(<ReturnToPlace />);
    expect(r.queryByTestId('return-to-place')).toBeInTheDocument();
    act(() => s().setRouteItem(second.id));
    expect(r.queryByTestId('return-to-place')).not.toBeInTheDocument();
    act(() => s().setRouteItem(null));
    expect(r.queryByTestId('return-to-place')).not.toBeInTheDocument();
  });

  it('it shows only on the screen the record was opened on', () => {
    s().openActivity('any', { nodeId: null });
    useStore.setState((st) => { st.screen = 'dashboard'; });
    expect(render(<ReturnToPlace />).queryByTestId('return-to-place')).not.toBeInTheDocument();
  });

  it('the URL sync that follows an open keeps it', async () => {
    useStore.setState((st) => { st.role = 'pmc'; st.screen = 'places'; });
    render(<MemoryRouter initialEntries={[`/projects/${s().activeProjectId}/places`]}><RouteBridge /></MemoryRouter>);
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    act(() => s().openDrawing(s().drawings[0].id, { nodeId: null }));
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    expect(s().screen).toBe('drawings');
    expect(s().returnPlace).toEqual({ nodeId: null, screen: 'drawings', item: s().drawings[0].id });
  });

  it('it is project-owned: every scope change tears it down', () => {
    expect(emptyProjectData().returnPlace).toBeNull();
  });
});
