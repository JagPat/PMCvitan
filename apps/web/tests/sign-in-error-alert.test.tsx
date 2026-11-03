import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { AccessState } from '@vitan/shared';
import { signInErrors } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { TeamAccessScreen } from '@/screens/TeamAccessScreen';

/**
 * A failed sign-in used to show its reason only as red text, so a screen reader announced nothing when the form
 * failed. Each sign-in step now shows the error as an alert (`role="alert"`), mounted only while there is an error
 * and keyed by the failure, so each new failure on the same step (a different error, or the same one again) is a new
 * alert and is announced again, while a language switch re-words it in place.
 */

afterEach(() => cleanup());

const failed = (key: 'wrongPassword' | 'serverDown' | 'emailWrongCode'): Partial<AccessState> =>
  ({ error: signInErrors.en[key], errorKey: { key } } as unknown as Partial<AccessState>);

function show(access: Partial<AccessState>) {
  useStore.setState(getInitialState());
  useStore.setState((s) => ({ lang: 'en', access: { ...s.access, ...access } }));
  return render(<TeamAccessScreen />);
}

const steps: Array<[string, Partial<AccessState>]> = [
  ['phone', { step: 'phone', who: 'team' }],
  ['login', { step: 'login' }],
  ['password-email', { step: 'password-email', email: 'asha@vitan.in' }],
  ['password-code', { step: 'password-code', email: 'asha@vitan.in', passwordRequestId: 'r1' }],
  ['password-create', { step: 'password-create', passwordSetupToken: 'st' }],
  ['emailentry', { step: 'emailentry', email: 'asha@vitan.in' }],
  ['emailcode', { step: 'emailcode', email: 'asha@vitan.in' }],
  ['otp', { step: 'otp', who: 'team', phone: '9876543210', codeLength: 4 }],
];

describe('a sign-in error is announced to screen readers', () => {
  it.each(steps)('%s: the error is an alert with its words', (_name, access) => {
    const view = show({ ...access, ...failed('wrongPassword') });
    expect(view.getByRole('alert').textContent).toBe(signInErrors.en.wrongPassword);
  });

  it.each(steps)('%s: no error, no alert', (_name, access) => {
    const view = show(access);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('a different error on the same step is a new alert, so it is announced again', () => {
    const view = show({ step: 'login', ...failed('wrongPassword') });
    const first = view.getByRole('alert');
    act(() => { useStore.setState((s) => ({ access: { ...s.access, ...failed('serverDown') } })); });
    const second = view.getByRole('alert');
    expect(second.textContent).toBe(signInErrors.en.serverDown);
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it('the same error again is a new alert too, so a repeated failure is announced again', () => {
    const view = show({ step: 'login' });
    act(() => { useStore.getState().login('', ''); });
    const first = view.getByRole('alert');
    act(() => { useStore.getState().login('', ''); });
    const second = view.getByRole('alert');
    expect(second.textContent).toBe(first.textContent);
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it('a language switch re-words the same alert in place, without a second announcement of a new error', () => {
    const view = show({ step: 'login', ...failed('wrongPassword') });
    const first = view.getByRole('alert');
    act(() => { useStore.getState().setLang('hi'); });
    const after = view.getByRole('alert');
    expect(after).toBe(first);
    expect(after.textContent).toBe(signInErrors.hi.wrongPassword);
  });

  it('the code rows keep the alert in line, and hide it while a check is sending', () => {
    const view = show({ step: 'emailcode', email: 'asha@vitan.in', ...failed('emailWrongCode') });
    expect(view.getByRole('alert').tagName).toBe('SPAN');
    act(() => { useStore.setState((s) => ({ access: { ...s.access, sending: true } })); });
    expect(view.queryByRole('alert')).toBeNull();
  });
});
