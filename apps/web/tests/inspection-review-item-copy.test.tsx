import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Review } from '@vitan/shared';

/**
 * #482 F-C4.4 / F-C4.5 (Q4 C4) — on the PMC's Inspection Review, "Reject item" only marks an item to go back:
 * it said "Rejected — re-inspection task created" before anything was sent. And every item tile carried a
 * "PHOTO" tag, even the placeholder swatch with no photo attached.
 */
afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function mount(over: Partial<Review>, lang: Lang = 'en') {
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  const seed = useStore.getState().reviews[0]!;
  const review: Review = {
    ...structuredClone(seed),
    decided: false,
    items: seed.items.slice(0, 2).map((it, k) => ({ ...it, rejected: false, evidence: k === 0 ? ['data:image/png;base64,AA=='] : [] })),
    ...over,
  };
  useStore.setState({ role: 'pmc', screen: 'inspect-review', lang, reviews: [review], activeReviewId: review.id, projectLoadState: 'ready' });
  const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
  const view = render(<InspectionReviewScreen />);
  /** change item 1 (and the review) the way a server reply would, as a new object */
  const patch = (item: Partial<Review['items'][number]>, rev: Partial<Review> = {}) => act(() => {
    const r = useStore.getState().reviews[0]!;
    useStore.setState({ reviews: [{ ...r, ...rev, items: r.items.map((it, k) => (k === 1 ? { ...it, ...item } : it)) }] });
  });
  return { view, useStore, patch };
}

describe('#482 F-C4.4 — a rejected item says it will go back, until Send back decides it', () => {
  it('Reject item marks it "Will be sent back for re-inspection", never "task created"', async () => {
    const { view } = await mount({});
    fireEvent.click(view.getAllByRole('button', { name: /reject item/i })[1]!);
    expect(view.getByTestId('review-reject-state-1').textContent).toContain('Will be sent back for re-inspection');
    expect(view.container.textContent).not.toContain('re-inspection task created');
  });

  it('once decided, the item says the re-inspection task was created', async () => {
    const { view, patch } = await mount({});
    patch({ rejected: true }, { decided: true });
    expect(view.getByTestId('review-reject-state-1').textContent).toContain('Sent back — re-inspection task created');
  });

  it('speaks Hindi and Gujarati', async () => {
    const hi = await mount({}, 'hi');
    hi.patch({ rejected: true });
    expect(hi.view.getByTestId('review-reject-state-1').textContent).toContain('दोबारा निरीक्षण के लिए वापस भेजा जाएगा');
    cleanup();
    vi.resetModules();
    const gu = await mount({}, 'gu');
    gu.patch({ rejected: true });
    expect(gu.view.getByTestId('review-reject-state-1').textContent).toContain('ફરી નિરીક્ષણ માટે પાછું મોકલાશે');
  });
});

describe('#482 F-C4.5 — the photo tag names attached photos only', () => {
  it('an item with a photo is tagged; the placeholder swatch is not', async () => {
    const { view } = await mount({});
    expect(view.getByTestId('review-photo-tag-0').textContent).toBe('PHOTO');
    expect(view.queryByTestId('review-photo-tag-1')).toBeNull();
  });

  it('several photos are counted', async () => {
    const { view, patch } = await mount({});
    patch({ evidence: ['/media/a', '/media/b'] });
    expect(view.getByTestId('review-photo-tag-1').textContent).toBe('2 PHOTOS');
  });
});
