import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { warmImports } from './warm-imports';

/**
 * #482 QA item 2 — on Inspection Review, when any item FAILED the expected decision is to send it back:
 * "Send back for re-inspection" is the primary (first, solid) button and Approve steps down to a
 * secondary button that asks for confirmation before signing the inspection off. With nothing failed
 * Approve stays first and decides at once.
 */

await warmImports(() => import('@/store/store'), () => import('@/screens/InspectionReviewScreen'));

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function mount(state: Record<string, unknown> = {}) {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ role: 'pmc', screen: 'inspect-review', ...state });
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  return { useStore, view: render(<InspectionReviewScreen />) };
}

/** the seeded queue with its first review's items all passing */
async function allPassing() {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const reviews = useStore.getState().reviews.map((r, i) => (i === 0 ? { ...r, items: r.items.map((it) => ({ ...it, result: 'PASS' as const, rejected: false })) } : r));
  return { reviews, activeReviewId: reviews[0].id };
}

describe('Inspection Review — a review with a FAILED item (#482 QA item 2)', () => {
  it('puts Send back first as the primary button and Approve second', async () => {
    const { useStore, view } = await mount();
    // the seeded review (INSP-21) has one FAILED item
    expect(useStore.getState().reviews[0].items.some((it) => it.result === 'FAIL')).toBe(true);
    const sendBack = view.getByTestId('send-reinspection');
    const approve = view.getByTestId('approve-inspection');
    expect(sendBack.textContent).toBe('Send back for re-inspection');
    expect(sendBack.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // primary = solid red; Approve is the outlined secondary, no longer the solid green
    expect(sendBack.style.background).not.toBe('transparent');
    expect(sendBack.style.color).toBe('rgb(255, 255, 255)');
    expect(approve.style.background).toBe('transparent');
  });

  it('Approve asks first; Cancel leaves the review undecided', async () => {
    const { useStore, view } = await mount();
    const id = useStore.getState().reviews[0].id;
    fireEvent.click(view.getByTestId('approve-inspection'));
    const dialog = view.getByTestId('confirm-approve');
    expect(dialog.textContent).toContain('Approve with failed items?');
    expect(dialog.textContent).toContain('1 item failed');
    fireEvent.click(within(dialog).getByTestId('confirm-approve-cancel'));
    expect(view.queryByTestId('confirm-approve')).toBeNull();
    expect(useStore.getState().reviews.find((r) => r.id === id)?.decided).toBe(false);
  });

  it('confirming "Approve anyway" records the approval', async () => {
    const { useStore, view } = await mount();
    const id = useStore.getState().reviews[0].id;
    fireEvent.click(view.getByTestId('approve-inspection'));
    fireEvent.click(view.getByTestId('confirm-approve-confirm'));
    expect(useStore.getState().reviews.find((r) => r.id === id)?.decided).toBe(true);
    expect(view.queryByTestId('confirm-approve')).toBeNull();
  });

  it('Send back decides at once, with no confirmation', async () => {
    const { useStore, view } = await mount();
    const id = useStore.getState().reviews[0].id;
    fireEvent.click(view.getByTestId('send-reinspection'));
    expect(view.queryByTestId('confirm-approve')).toBeNull();
    expect(useStore.getState().reviews.find((r) => r.id === id)?.decided).toBe(true);
  });
});

describe('Inspection Review — a review with nothing failed', () => {
  it('keeps Approve first as the primary button, and it decides without asking', async () => {
    const { useStore, view } = await mount(await allPassing());
    const id = useStore.getState().reviews[0].id;
    const approve = view.getByTestId('approve-inspection');
    const sendBack = view.getByTestId('send-reinspection');
    expect(approve.compareDocumentPosition(sendBack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(approve.style.background).not.toBe('transparent');
    fireEvent.click(approve);
    expect(view.queryByTestId('confirm-approve')).toBeNull();
    expect(useStore.getState().reviews.find((r) => r.id === id)?.decided).toBe(true);
  });
});
