import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Checklist } from '@vitan/shared';

/**
 * A PMC can have more than one checklist out on site at once. The engineer's field view opens ONE of
 * them, and before this it was the only one they could reach: the second was work no surface let them
 * do. Carrying the list to the client is half a fix — a list you cannot open is a count, not a task.
 *
 * These probes are about the SCREEN: that the picker appears exactly when there is a choice to make,
 * that tapping a checklist actually moves the edit slot to it, and that the marks each checklist
 * carries stay with that checklist rather than following the engineer between them.
 */

const checklist = (id: string, title: string): Checklist => ({
  id,
  title,
  zone: 'Ground floor',
  date: 'today',
  submitted: false,
  items: [{ id: `${id}-i1`, name: 'Verify', state: null, photos: 0, note: '', evidence: [] }],
});

async function mount(open: Checklist[], current: Checklist | null) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  useStore.setState({ ...getInitialState(), openChecklists: open, checklist: current, selectedChecklistId: null });
  const view = render(<EngineerChecklistScreen />);
  return { view, useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the engineer can open every checklist that is out on site', () => {
  it('shows no picker when there is only one checklist — nothing to choose between', async () => {
    const one = checklist('INSP-1', 'Rebar');
    const { view } = await mount([one], one);
    expect(view.queryByTestId('checklist-picker')).toBeNull();
    expect(view.getByTestId('checklist-title').textContent).toBe('Rebar');
  });

  it('offers every open checklist, names how many are out, and marks the one in the slot', async () => {
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view } = await mount(both, both[0]);
    expect(view.getByTestId('checklist-picker')).toBeTruthy();
    expect(view.getByText(/2 CHECKLISTS OUT/)).toBeTruthy();
    expect(view.getByTestId('checklist-tab-INSP-1').getAttribute('aria-current')).toBe('true');
    expect(view.getByTestId('checklist-tab-INSP-2').getAttribute('aria-current')).toBeNull();
  });

  it('tapping the other checklist moves the edit slot to it', async () => {
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0]);
    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-2')); });
    expect(useStore.getState().checklist?.id).toBe('INSP-2');
    expect(view.getByTestId('checklist-tab-INSP-2').getAttribute('aria-current')).toBe('true');
    // and the screen is now filling THAT checklist, not the one it opened on
    expect(view.getByTestId('checklist-title').textContent).toBe('Shuttering');
  });

  it('work marked on one checklist stays on it when the engineer moves to the other and back', async () => {
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0]);

    act(() => { fireEvent.click(view.getAllByText('Pass')[0]); });
    expect(useStore.getState().checklist?.items[0].state).toBe('pass');

    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-2')); });
    // the other checklist is server-clean — the first one's mark did not follow the engineer over
    expect(useStore.getState().checklist?.items[0].state).toBe(null);
    act(() => { fireEvent.click(view.getAllByText('Fail')[0]); });

    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-1')); });
    expect(useStore.getState().checklist?.items[0].state).toBe('pass');
    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-2')); });
    expect(useStore.getState().checklist?.items[0].state).toBe('fail');
  });

  it('demo submit moves the field view to the checklist still out on site', async () => {
    // In demo mode the submitted checklist leaves `openChecklists` but used to stay in the slot.
    // With one open entry left the picker hides, so the remaining checklist became unreachable —
    // the exact disappearance this change exists to end, reintroduced at the other end.
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')].map((c) => ({
      ...c, items: [{ ...c.items[0], state: 'pass' as const, photos: 1 }],
    }));
    const { view, useStore } = await mount(both, both[0]);
    await act(async () => { await useStore.getState().submitInspection(); });

    expect(useStore.getState().openChecklists.map((c) => c.id)).toEqual(['INSP-2']);
    expect(useStore.getState().checklist?.id).toBe('INSP-2');
    expect(useStore.getState().checklist?.submitted).toBe(false);
    expect(view.getByTestId('checklist-title').textContent).toBe('Shuttering');
  });

  it('a demo photo survives leaving the checklist and coming back', async () => {
    // `addPhoto` and the demo evidence branch write only the checklist in the slot — neither field
    // is a `checklistMarks` record — so a switch used to restore a clean clone and drop them. A
    // failed item whose only photo vanished cannot be submitted at all.
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0]);
    act(() => { useStore.getState().addPhoto(0); });
    expect(useStore.getState().checklist?.items[0].photos).toBe(1);

    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-2')); });
    expect(useStore.getState().checklist?.items[0].photos).toBe(0);

    act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-1')); });
    expect(useStore.getState().checklist?.items[0].photos).toBe(1);
  });
});
