import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ApiGateway } from '@/data/apiGateway';
import type { AccessState, Lang } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 V-1018-6 — after sign-out the email sign-in page stayed English even with Hindi chosen, and the language
 * fell back to English at each login. The language is remembered per person on this device (no server copy,
 * Board 6254076212). Every sign-in screen now reads in the gate's language, and the gate opens in the language
 * last chosen on this device, so a reload or a sign-out keeps it.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => localStorage.clear());

/** a token the store reads `sub` from, as it does a real one */
const tokenFor = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.s`;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A fresh page load against the live API: modules re-imported, the browser's localStorage kept. */
async function page(gateway?: Partial<ApiGateway>) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  if (gateway) useStore.getState()._setGateway(gateway as ApiGateway);
  const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
  const { LangPreference } = await import('@/layout/LangPreference');
  const pref = await import('@/lib/langPreference');
  return { useStore, TeamAccessScreen, LangPreference, pref };
}

/** the person's own words and the firm's name: typed email addresses, the product name, the +91 code */
const DATA = ['asha@vitan.in', 'you@vitan.in', 'you@example.com', 'Vitan PMC', 'PMC', 'pmc', 'client', 'contractor', 'vitan', 'in', '6-digit'];

describe.each(['hi', 'gu'] as const)('every email and password sign-in screen in %s', (lang) => {
  const steps: Array<[string, Partial<AccessState>]> = [
    ['login', { step: 'login' }],
    ['password-email', { step: 'password-email', email: 'asha@vitan.in' }],
    ['password-code', { step: 'password-code', email: 'asha@vitan.in', passwordRequestId: 'r1' }],
    ['password-create', { step: 'password-create', passwordSetupToken: 'st' }],
    ['emailentry', { step: 'emailentry', email: 'asha@vitan.in' }],
    ['emailcode', { step: 'emailcode', email: 'asha@vitan.in' }],
  ];
  it.each(steps)('%s shows no English', async (_name, access) => {
    const { useStore, TeamAccessScreen } = await page();
    useStore.setState((s) => ({ lang, access: { ...s.access, ...access } }));
    const view = render(<TeamAccessScreen />);
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
  });

  it('the password guidance reads in the same language', async () => {
    const { useStore, TeamAccessScreen } = await page();
    useStore.setState((s) => ({ lang, access: { ...s.access, step: 'password-create', passwordSetupToken: 'st' } }));
    const view = render(<TeamAccessScreen />);
    fireEvent.change(view.getByLabelText(lang === 'hi' ? 'नया पासवर्ड' : 'નવો પાસવર્ડ'), { target: { value: 'short' } });
    expect(view.getByText(lang === 'hi' ? 'आगे बढ़ने के लिए 7 अक्षर और जोड़ें।' : 'આગળ વધવા 7 અક્ષર વધુ ઉમેરો.')).toBeInTheDocument();
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
  });

  it('a failed email sign-in says why in the same language, and a switch re-words it', async () => {
    const err = Object.assign(new Error('401'), { status: 401 });
    const { useStore, TeamAccessScreen } = await page({ login: vi.fn().mockRejectedValue(err) } as Partial<ApiGateway>);
    useStore.setState((s) => ({ lang, access: { ...s.access, step: 'login' } }));
    const view = render(<TeamAccessScreen />);
    fireEvent.change(view.getByTestId('login-email'), { target: { value: 'asha@vitan.in' } });
    fireEvent.change(view.getByTestId('login-password'), { target: { value: 'wrong-password' } });
    fireEvent.click(view.getByTestId('login-submit'));
    await flush();
    expect(useStore.getState().access.error).toBeTruthy();
    expect(leftoverEnglish(view.container, DATA)).toEqual([]);
    act(() => useStore.getState().setLang('en'));
    expect(view.container.textContent).toContain('Wrong email or password. Never set a password? Use “Set up or forgot password”.');
  });
});

describe('the sign-in screens in English are unchanged', () => {
  it('reads as before', async () => {
    const { useStore, TeamAccessScreen } = await page();
    useStore.setState((s) => ({ lang: 'en', access: { ...s.access, step: 'login' } }));
    const view = render(<TeamAccessScreen />);
    for (const s of ['Sign in', 'Architect, client & contractor accounts', 'Set up or forgot password']) expect(view.container.textContent).toContain(s);
    expect(view.getByTestId('login-password').getAttribute('placeholder')).toBe('Password');
    cleanup();
    useStore.setState((s) => ({ access: { ...s.access, step: 'password-code', email: 'asha@vitan.in' } }));
    const code = render(<TeamAccessScreen />);
    expect(code.container.textContent).toContain('If asha@vitan.in is an invited Vitan PMC account, a 6-digit code is on its way. It can take a minute; check your spam folder too.');
  });
});

describe('the gate opens in the language last chosen on this device', () => {
  it('a language picked at the gate is still there after a reload', async () => {
    const first = await page();
    const view = render(<first.TeamAccessScreen atGate />);
    fireEvent.click(view.getByTestId('gate-lang-hi'));
    cleanup();
    const again = await page();
    expect(again.useStore.getState().lang).toBe('hi');
    const gate = render(<again.TeamAccessScreen />);
    expect(gate.getByText('आपका मोबाइल नंबर')).toBeInTheDocument();
  });

  it('a guest pick inside a console without a token (dev auth) is never saved as the device language', async () => {
    const first = await page();
    expect(first.useStore.getState().sessionToken).toBeNull();
    const view = render(<first.TeamAccessScreen />);
    fireEvent.click(view.getByTestId('gate-lang-hi'));
    expect(first.useStore.getState().lang).toBe('hi');
    cleanup();
    const again = await page();
    expect(again.useStore.getState().lang).toBe('en');
  });

  async function signInWith(p: Awaited<ReturnType<typeof page>>, sub: string, role: 'client' | 'engineer' = 'client') {
    // the email + password sign-in the report used, against a server that signs this person in
    p.useStore.getState()._setGateway({ login: vi.fn().mockResolvedValue({ token: tokenFor(sub), role, name: 'Asha', projectId: 'villa-b' }) } as unknown as ApiGateway);
    p.useStore.getState().login('asha@vitan.in', 'a-long-password');
    await flush();
  }

  const choose = (p: Awaited<ReturnType<typeof page>>, lang: Lang) => act(() => {
    // what every console picker does
    p.pref.noteLangChoice(lang);
    p.useStore.getState().setLang(lang);
  });

  it('Hindi chosen in the console: after sign-out the gate and the email sign-in read Hindi, and the next sign-in keeps it', async () => {
    const p = await page();
    await signInWith(p, 'u-asha');
    const shell = render(<p.LangPreference />);
    choose(p, 'hi');
    shell.unmount();
    act(() => p.useStore.getState().completeSignOut());
    expect(p.useStore.getState().lang).toBe('hi');
    act(() => p.useStore.getState().accGoLogin());
    const gate = render(<p.TeamAccessScreen />);
    expect(leftoverEnglish(gate.container, DATA)).toEqual([]);
    cleanup();
    await signInWith(p, 'u-asha');
    render(<p.LangPreference />);
    expect(p.useStore.getState().lang).toBe('hi');
  });

  it('the same after a reload between sign-out and sign-in', async () => {
    const p = await page();
    await signInWith(p, 'u-asha');
    const shell = render(<p.LangPreference />);
    choose(p, 'gu');
    shell.unmount();
    act(() => p.useStore.getState().completeSignOut());
    const reload = await page();
    expect(reload.useStore.getState().lang).toBe('gu');
    await signInWith(reload, 'u-asha');
    render(<reload.LangPreference />);
    expect(reload.useStore.getState().lang).toBe('gu');
  });

  it('two people on one phone each keep their own language; the gate shows the last one chosen', async () => {
    const p = await page();
    await signInWith(p, 'u-asha');
    let shell = render(<p.LangPreference />);
    choose(p, 'hi');
    shell.unmount();
    act(() => p.useStore.getState().completeSignOut());
    await signInWith(p, 'u-ravi');
    shell = render(<p.LangPreference />);
    choose(p, 'gu');
    shell.unmount();
    act(() => p.useStore.getState().completeSignOut());
    expect(p.useStore.getState().lang).toBe('gu');
    await signInWith(p, 'u-asha');
    render(<p.LangPreference />);
    expect(p.useStore.getState().lang).toBe('hi');
  });

  it('a language saved before this release still opens the gate after sign-out and a reload', async () => {
    // an upgraded browser: only the person's own saved choice, no device language yet
    localStorage.setItem('vitan.lang.v1:user:u-asha', 'hi');
    const p = await page();
    await signInWith(p, 'u-asha');
    const shell = render(<p.LangPreference />);
    expect(p.useStore.getState().lang).toBe('hi');
    shell.unmount();
    act(() => p.useStore.getState().completeSignOut());
    expect(p.useStore.getState().lang).toBe('hi');
    const reload = await page();
    expect(reload.useStore.getState().lang).toBe('hi');
  });

  it('with nothing chosen on this device the gate opens in English', async () => {
    const p = await page();
    expect(p.useStore.getState().lang).toBe('en');
  });
});
