import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { AccessState } from '@vitan/shared';
import { signInErrors } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { TeamAccessScreen } from '@/screens/TeamAccessScreen';

/**
 * A failed sign-in used to show its reason only as red text, so a screen reader announced nothing when the form
 * failed. Each sign-in step now keeps an alert region (`role="alert"`) in the page, empty until an error is written
 * into it (W3C ARIA19). Each failure is written as a new child keyed by the failure, so each new failure on the same
 * step (a different error, or the same one again) is a new addition and is announced, while a language switch
 * re-words it in place.
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

/** the alert region and the child its current words were written into */
const region = (view: ReturnType<typeof show>) => view.getByRole('alert');
const words = (view: ReturnType<typeof show>) => region(view).firstElementChild;

describe('a sign-in error is announced to screen readers', () => {
  it.each(steps)('%s: the alert region is in the page, empty, before any error, and the error is written into it', (_name, access) => {
    const view = show(access);
    const before = region(view);
    expect(before.textContent).toBe('');
    expect(before.childElementCount).toBe(0);
    act(() => { useStore.setState((s) => ({ access: { ...s.access, ...failed('wrongPassword') } })); });
    expect(region(view)).toBe(before);
    expect(before.textContent).toBe(signInErrors.en.wrongPassword);
    expect(words(view)).not.toBeNull();
  });

  it('a different error on the same step is a new addition to the same region, so it is announced again', () => {
    const view = show({ step: 'login', ...failed('wrongPassword') });
    const box = region(view);
    const first = words(view);
    act(() => { useStore.setState((s) => ({ access: { ...s.access, ...failed('serverDown') } })); });
    expect(region(view)).toBe(box);
    expect(box.textContent).toBe(signInErrors.en.serverDown);
    expect(words(view)).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });

  it('the same error again is a new addition too, so a repeated failure is announced again', () => {
    const view = show({ step: 'login' });
    const box = region(view);
    act(() => { useStore.getState().login('', ''); });
    const first = words(view);
    act(() => { useStore.getState().login('', ''); });
    expect(region(view)).toBe(box);
    expect(words(view)?.textContent).toBe(first?.textContent);
    expect(words(view)).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });

  it('a language switch re-words the same words in place, not as a new failure', () => {
    const view = show({ step: 'login', ...failed('wrongPassword') });
    const box = region(view);
    const first = words(view);
    act(() => { useStore.getState().setLang('hi'); });
    expect(region(view)).toBe(box);
    expect(words(view)).toBe(first);
    expect(box.textContent).toBe(signInErrors.hi.wrongPassword);
  });

  it('the code rows keep the region in line, and empty it while a check is sending', () => {
    const view = show({ step: 'emailcode', email: 'asha@vitan.in', ...failed('emailWrongCode') });
    const box = region(view);
    expect(box.tagName).toBe('SPAN');
    act(() => { useStore.setState((s) => ({ access: { ...s.access, sending: true } })); });
    expect(region(view)).toBe(box);
    expect(box.textContent).toBe('');
  });
});
