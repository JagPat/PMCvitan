import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { deciderNoun, changeModalExplainer, type Decision, type DeciderKind, type Lang } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { ChangeModal } from '@/screens/modals/ChangeModal';
import { impactReasonIn, readImpact } from '@/lib/impactInput';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Top 10 #5) — the change-request form, the second modal Board named: in Hindi and Gujarati
 * it shows no English, for every decider and with both impact fields refused. English stays
 * byte-identical.
 */

const s = () => useStore.getState();
const KINDS: DeciderKind[] = ['client', 'pmc', 'member', 'architect', 'none'];
// the decision title is data the PMC typed; "PMC" is the role's own short name, kept in brackets
const DATA = ['Kitchen platform', 'PMC'];

function open(lang: Lang, deciderKind: DeciderKind) {
  useStore.setState(getInitialState());
  const d = {
    id: 'DL-1', title: 'Kitchen platform', room: 'Kitchen', status: 'approved', deciderKind, photoSwatch: 'tile',
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile' }], ageDays: 2, approvalCycle: 0,
  } as unknown as Decision;
  useStore.setState({ role: 'pmc', lang, decisions: [d] } as never);
  s().openChange('DL-1');
  return render(<ChangeModal />);
}

afterEach(cleanup);

describe('the change-request form in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const kind of KINDS) {
      it(`${lang}, decided by ${kind}: no leftover English`, () => {
        const r = open(lang, kind);
        expect(leftoverEnglish(r.container, DATA)).toEqual([]);
      });
    }

    it(`${lang}: refused impacts explain themselves in ${lang}`, () => {
      const r = open(lang, 'client');
      act(() => {
        s().setChangeCost('12.50');
        s().setChangeTime('abc');
      });
      expect(r.getByTestId('change-cost-error')).toBeTruthy();
      expect(r.getByTestId('change-time-error')).toBeTruthy();
      expect(leftoverEnglish(r.container, DATA)).toEqual([]);
    });
  }
});

describe('English is unchanged', () => {
  it('the explainer names each decider exactly as before', () => {
    for (const kind of KINDS) {
      expect(changeModalExplainer(kind, 'en')).toBe(`This decision is locked. A change must be re-approved by ${deciderNoun(kind)} with cost & time impact.`);
    }
  });

  it('the form reads as before', () => {
    const r = open('en', 'client');
    expect(r.container.textContent).toContain('CHANGE REQUEST');
    expect(r.getByTestId('change-submit').textContent).toBe('Submit for Re-approval');
    expect(r.getByTestId('change-cost').getAttribute('aria-label')).toBe('Cost impact (₹)');
  });

  it('every refusal reason has a Hindi and Gujarati version, and English passes through', () => {
    const reasons = ['12.50', 'abc', '99999999999'].flatMap((raw) =>
      (['cost', 'days'] as const).map((k) => readImpact(raw, k)).flatMap((r) => (r.ok ? [] : [r.reason])),
    );
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    for (const reason of reasons) {
      expect(impactReasonIn(reason, 'en')).toBe(reason);
      expect(impactReasonIn(reason, 'hi')).not.toBe(reason);
      expect(impactReasonIn(reason, 'gu')).not.toBe(reason);
    }
  });
});

describe('an unrecognised decider', () => {
  it('reads as the client in every language, as deciderNoun does', () => {
    const odd = 'legacy' as unknown as DeciderKind;
    for (const lang of ['en', 'hi', 'gu'] as const) {
      expect(changeModalExplainer(odd, lang)).toBe(changeModalExplainer('client', lang));
    }
  });
});
