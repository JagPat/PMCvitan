import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * #827 (Board decision 13 Oct, "remove Google sign-in, one way in"): the sign-in screen offers no
 * Google button and never loads Google's sign-in script, even when a Google client id is configured.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  document.querySelectorAll('script[src*="accounts.google.com"]').forEach((el) => el.remove());
});

describe('sign-in has no Google option', () => {
  it('the email sign-in step shows no Google button and loads no Google script', async () => {
    // set before the screen's modules load, as a build-time variable would be
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com');
    vi.resetModules();
    const { useStore } = await import('@/store/store');
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    useStore.setState((s) => ({ access: { ...(s as { access: object }).access, step: 'login' } } as never));
    const r = render(<TeamAccessScreen />);
    await new Promise((r) => setTimeout(r, 0));
    expect(r.getByTestId('login-submit')).toBeTruthy();
    expect(r.container.textContent ?? '').not.toMatch(/google/i);
    expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
  });
});
