import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
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

async function mount(open: Checklist[], current: Checklist | null, opts: { demo?: boolean } = {}) {
  // `demo` leaves VITE_API_URL unset, so the store has no gateway and the local mirror IS the record —
  // which is what makes an evidence mis-target observable without standing up a fake upload.
  if (!opts.demo) vi.stubEnv('VITE_API_URL', 'http://api.test');
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

  it('demo submit files the SUBMITTED checklist for review, not the one still out on site', async () => {
    // The advance above replaces the slot before the review is built. Reading the slot afterwards
    // filed the still-unsubmitted checklist into the PMC's queue — with PASS/FAIL results derived
    // from marks nobody had made — and lost the submitted one, so the work that was actually done
    // was never reviewable and the work still out on site read as finished.
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')].map((c) => ({
      ...c, items: [{ ...c.items[0], state: 'pass' as const, photos: 1 }],
    }));
    const { useStore } = await mount(both, both[0]);
    await act(async () => { await useStore.getState().submitInspection(); });

    const reviews = useStore.getState().reviews;
    const filed = reviews.find((r) => r.id === 'INSP-1');
    expect(filed?.title).toBe('Rebar'); // the checklist that was actually submitted
    // and the checklist still out on site is NOT in the queue
    expect(reviews.some((r) => r.id === 'INSP-2')).toBe(false);
  });

  it('a photo is filed against the checklist it was TAKEN on, even if the engineer switches while it reads', async () => {
    // Reading the file is asynchronous. The handler used to retain only an item INDEX and the store
    // re-read the edit slot, so a switch during the read filed the photo against the OTHER checklist's
    // item at the same position — evidence attached to work it is not evidence of. Demo mode, where
    // the local mirror is the whole record, makes the mis-target directly observable.
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0], { demo: true });

    // hold the read open so the switch lands strictly between the capture and the store call
    let fire: (() => void) | null = null;
    class HeldReader {
      result = 'data:image/jpeg;base64,AAAA';
      onload: (() => void) | null = null;
      readAsDataURL() { fire = () => this.onload?.(); }
    }
    const RealReader = globalThis.FileReader;
    (globalThis as unknown as { FileReader: unknown }).FileReader = HeldReader;
    try {
      act(() => { fireEvent.click(view.getByTestId('evidence-0')); }); // the camera opens on INSP-1's item
      const input = view.getByTestId('evidence-file-input') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })], configurable: true });
      act(() => { fireEvent.change(input); });
      expect(fire).not.toBeNull(); // the read is genuinely in flight — the switch below is not a no-op

      act(() => { fireEvent.click(view.getByTestId('checklist-tab-INSP-2')); }); // the engineer moves on
      expect(useStore.getState().checklist?.id).toBe('INSP-2');
      await act(async () => { fire!(); await Promise.resolve(); }); // the read finally completes
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = RealReader;
    }

    // the checklist the engineer switched TO did not acquire somebody else's photo
    expect(useStore.getState().checklist?.id).toBe('INSP-2');
    expect(useStore.getState().checklist?.items[0].photos).toBe(0);
    expect(useStore.getState().checklist?.items[0].evidence ?? []).toEqual([]);
  });

  it('a file set on the input WITHOUT the camera gesture is still captured, against the slot', async () => {
    // The acceptance suites populate the hidden input directly rather than clicking the camera, so
    // the pinned target is absent. Making the pin mandatory dropped every one of those captures in
    // silence — the photo simply never arrived. The fallback is the edit slot at item 0, which is
    // what this handler resolved to before the pin existed.
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0], { demo: true });

    const input = view.getByTestId('evidence-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })], configurable: true });
    act(() => { fireEvent.change(input); }); // the real FileReader resolves on a later task
    await waitFor(() => expect(useStore.getState().checklist?.items[0].photos).toBe(1));

    expect(useStore.getState().checklist?.id).toBe('INSP-1');
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

/**
 * ROUND 7, FINDING 4 — a refused photo must say WHOSE work it is before anyone can delete it.
 *
 * The Retry/Delete panel is project-wide; the picker above it is not. So the moment the engineer
 * switches from checklist A to B, A's failed uploads sit on B's screen behind a Delete button whose
 * only label was generic server text like `upload rejected (400)`. Delete is the one non-server path
 * that destroys bytes for good, and it was destroying work the engineer had no way to recognise as
 * belonging to a different checklist.
 */
describe('a refused photo names the work it belongs to', () => {
  const failed = (clientKey: string, inspectionId: string, inspectionItemId: string) =>
    ({ clientKey, reason: 'upload rejected (400)', mime: 'image/png', inspectionId, inspectionItemId });

  it('says which OTHER checklist and item a failure came from', async () => {
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[1]); // looking at Shuttering
    act(() => {
      useStore.setState({ failedEvidence: [failed('k1', 'INSP-1', 'INSP-1-i1')] });
    });
    const where = view.getByTestId('evidence-failed-where-k1').textContent ?? '';
    expect(where).toContain('Rebar');   // the checklist it belongs to, by the name the engineer knows
    expect(where).toContain('Verify');  // and the item on it
    // the row is still OFFERED, not filtered away: hiding it would strand the photo instead
    expect(view.getByTestId('evidence-retry-k1')).toBeTruthy();
  });

  it('says so plainly when the failure IS on the checklist in the slot', async () => {
    const both = [checklist('INSP-1', 'Rebar'), checklist('INSP-2', 'Shuttering')];
    const { view, useStore } = await mount(both, both[0]);
    act(() => {
      useStore.setState({ failedEvidence: [failed('k2', 'INSP-1', 'INSP-1-i1')] });
    });
    const where = view.getByTestId('evidence-failed-where-k2').textContent ?? '';
    expect(where).toContain('this checklist');
    expect(where).toContain('Verify');
  });

  it('still names a failure whose checklist has left the outstanding list', async () => {
    // submitted since the upload failed, so it is no longer in `openChecklists` — the stored ids are
    // the fallback, because a name that no longer resolves beats no name when Delete is permanent
    const one = checklist('INSP-2', 'Shuttering');
    const { view, useStore } = await mount([one], one);
    act(() => {
      useStore.setState({ failedEvidence: [failed('k3', 'INSP-77', 'INSP-77-i1')] });
    });
    const where = view.getByTestId('evidence-failed-where-k3').textContent ?? '';
    expect(where).toContain('INSP-77');
  });
});
