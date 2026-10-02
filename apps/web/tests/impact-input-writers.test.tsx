import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { ChangeModal } from '@/screens/modals/ChangeModal';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';

/**
 * #482 comment 5923291892, FAMILY-WIDE (#687 shadow review): the strip-and-default parsing that turned
 * "12.50" into 1250, "abc" into 0 and a Unicode minus "−5" into +5 had two more writers besides the
 * countersign controls — the delivered Change Request (`submitChange`, the same `ChangeRequest.costImpact` /
 * `timeImpactDays` fact) and the option price delta on a newly issued decision. Both now read through
 * `readImpact`: an unsupported entry is refused visibly and nothing is sent; a whole number is sent exactly
 * as typed. RED at 4707c5d (main).
 */

const s = () => useStore.getState();
beforeEach(() => { globalThis.localStorage?.clear(); useStore.setState(getInitialState()); s()._setGateway(null); });
afterEach(() => cleanup());

const openChange = (changeCost: string, changeTime: string) =>
  useStore.setState((st) => {
    st.modal = { type: 'change', decId: 'DL-006', title: 'Staircase Railing', changeText: 'Glass panel lead time', changeCost, changeTime };
  });

describe('the Change Request — submitChange sends exactly what was typed, or nothing', () => {
  it('a refused cost or time sends nothing: the decision is unchanged, nothing is queued, the modal stays open', () => {
    const before = s().decisions.find((x) => x.id === 'DL-006');
    const outbox = s().outbox.length;
    for (const [cost, time] of [['12.50', ''], ['', '1.5'], ['abc', ''], ['', 'abc'], ['12,50', '2']]) {
      openChange(cost, time);
      s().submitChange();
      const d = s().decisions.find((x) => x.id === 'DL-006');
      expect(d?.status, `${cost} / ${time}`).toBe(before?.status); // was flipped to 'change' with 1250 / 15 / 0
      expect(d?.changeRequest, `${cost} / ${time}`).toEqual(before?.changeRequest);
      expect(s().outbox.length, `${cost} / ${time}`).toBe(outbox);
      expect(s().modal.type, `${cost} / ${time}`).toBe('change');
    }
  });

  it('a supported whole number is sent exactly, its sign kept', () => {
    const cases: Array<[string, string, number, number]> = [
      ['', '', 0, 0],
      ['12000', '6', 12000, 6],
      ['+45000', '+4', 45000, 4], // the modal's own placeholders
      ['₹ 1,00,000', '3 days', 100000, 3],
      ['−5', '−2', -5, -2], // was +5 / +2
    ];
    for (const [cost, time, costImpact, timeImpactDays] of cases) {
      useStore.setState(getInitialState());
      openChange(cost, time);
      s().submitChange();
      const d = s().decisions.find((x) => x.id === 'DL-006');
      expect(d?.changeRequest, `${cost} / ${time}`).toEqual({ reason: 'Glass panel lead time', costImpact, timeImpactDays });
      expect(s().modal.type).toBe(null);
    }
  });

  it('the modal shows each refusal under its field and disables Submit while one stands', () => {
    openChange('', '');
    const r = render(<ChangeModal />);
    // located by what the user sees (placeholder, label), so the base run fails on behaviour, not on ids
    const costInput = r.getByPlaceholderText('+45000');
    const timeInput = r.getByPlaceholderText('+4');
    const submit = r.getByRole('button', { name: 'Submit for Re-approval' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.change(costInput, { target: { value: '12.50' } });
    expect(submit.disabled).toBe(true);
    expect(r.getByTestId('change-cost-error').textContent).toMatch(/whole rupees only/i);
    expect(costInput.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(costInput, { target: { value: '12,500' } });
    expect(r.queryByTestId('change-cost-error')).toBeNull();
    fireEvent.change(timeInput, { target: { value: 'abc' } });
    expect(r.getByTestId('change-time-error').textContent).toMatch(/enter whole days/i);
    expect(submit.disabled).toBe(true);
    fireEvent.change(timeInput, { target: { value: '' } });
    expect(submit.disabled).toBe(false);
  });
});

describe('Issue a decision — each option’s price delta is read exactly, or the save is blocked', () => {
  const setup = () => {
    const issued: Array<{ options: Array<{ delta: number }> }> = [];
    useStore.setState({
      role: 'pmc',
      nodes: [{ id: 'zoneA', parentId: null, name: 'Zone A', kind: 'zone', order: 0 }],
      members: [],
      issueDecision: ((input: { options: Array<{ delta: number }> }) => issued.push(input)) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<IssueDecisionModal onClose={() => {}} />);
    fireEvent.change(r.getByTestId('dec-title'), { target: { value: 'Countertop' } });
    fireEvent.change(r.getByTestId('dec-loc-select-zone'), { target: { value: 'zoneA' } });
    fireEvent.change(r.getByTestId('dec-opt-0'), { target: { value: 'Granite' } });
    fireEvent.change(r.getByTestId('dec-opt-1'), { target: { value: 'Quartz' } });
    fireEvent.click(within(r.getByTestId('dec-opt-1-more')).getByRole('button'));
    // located by its placeholder (what the user sees), so the base run fails on the issued value
    const delta = () => r.getAllByPlaceholderText('₹ delta (0 = base)')[0];
    return { r, issued, delta };
  };

  it('a refused delta blocks both saves and shows its reason outside the collapsible details', () => {
    for (const [raw, reason] of [['12.50', /whole rupees only/i], ['abc', /enter whole rupees/i], ['12,50', /enter whole rupees/i]] as const) {
      const { r, issued, delta } = setup();
      fireEvent.change(delta(), { target: { value: raw } });
      fireEvent.click(r.getByTestId('save-decision'));
      expect(issued, raw).toHaveLength(0); // was issued with 1250 / 0
      expect(r.getByTestId('dec-opt-1-delta-error').textContent, raw).toMatch(reason);
      expect(delta().getAttribute('aria-invalid')).toBe('true');
      // the reason is NOT inside the collapsible: closing "More details" leaves it visible
      fireEvent.click(within(r.getByTestId('dec-opt-1-more')).getByRole('button'));
      expect(r.getByTestId('dec-opt-1-delta-error')).toBeTruthy();
      expect((r.getByTestId('save-decision') as HTMLButtonElement).disabled, raw).toBe(true);
      expect((r.getByTestId('save-draft') as HTMLButtonElement).disabled, raw).toBe(true);
      cleanup();
    }
  });

  it('a supported delta is issued exactly, its sign kept', () => {
    for (const [raw, expected] of [['90000', 90000], ['₹ 1,20,000', 120000], ['−5,000', -5000], ['-500', -500]] as const) {
      const { r, issued, delta } = setup();
      fireEvent.change(delta(), { target: { value: raw } });
      expect(r.queryByTestId('dec-opt-1-delta-error'), raw).toBeNull();
      fireEvent.click(r.getByTestId('save-decision'));
      expect(issued, raw).toHaveLength(1);
      expect(issued[0].options.map((o) => o.delta), raw).toEqual([0, expected]); // option 1 keeps its default "0"
      cleanup();
    }
  });
});
