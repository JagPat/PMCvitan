import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Decision, Lang } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { ApproveModal } from '@/screens/modals/ApproveModal';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Top 10 #5) — the approve-and-lock confirmation is one of the paths Board named: in Hindi
 * and Gujarati it shows no English, under both the plain lock and an active countersign chain.
 * English stays byte-identical (countersign-copy.test.tsx pins it).
 */

const s = () => useStore.getState();
const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: 'Kitchen platform', room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 18000, swatch: 'tile', recommended: true }],
    ageDays: 2, approvalCycle: 0, ...over,
  }) as Decision;

// the option label and the material are data the PMC typed, not the app's words
const DATA = ['A', 'Granite'];

function open(lang: Lang, countersignRequired: boolean) {
  useStore.setState(getInitialState());
  useStore.setState({ role: 'client', lang, decisions: [dec({ id: 'DL-1', ...(countersignRequired ? { countersignRequired: true } : {}) })] } as never);
  s().openApprove('DL-1', 0);
  return render(<ApproveModal />);
}

afterEach(cleanup);

describe('the approve confirmation in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const chain of [false, true]) {
      it(`${lang}${chain ? ', countersign chain' : ''}: no leftover English`, () => {
        const r = open(lang, chain);
        expect(leftoverEnglish(r.container, DATA)).toEqual([]);
      });
    }
  }

  it('names the option and the material in the heading', () => {
    const r = open('gu', false);
    expect(r.container.textContent).toContain('તમે A — Granite મંજૂર કરી રહ્યા છો');
  });

  it('English is unchanged', () => {
    const r = open('en', false);
    expect(r.container.textContent).toContain('You are approving A — Granite');
    expect(r.getByTestId('approve-lock').textContent).toBe('Approve & Lock');
  });
});

describe('the leftover-English check itself', () => {
  it('catches an English word and ignores numbers, ₹ and allowed data', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span>₹18,000 Granite</span><input placeholder="e.g. lighter tone">';
    // "e.g." is single letters, so only the two real words are reported
    expect(leftoverEnglish(el, ['Granite'])).toEqual(['lighter', 'tone']);
  });
});
