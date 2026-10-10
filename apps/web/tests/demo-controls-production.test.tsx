import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { SEED_DAILY_LOG, type DailyLog } from '@vitan/shared';
import { todayCivil } from '@/lib/civilDate';

/**
 * Top 10 #1 (#769) — the Board's 7 Oct UI/UX review: demo controls never reach production. In an
 * API-connected build the simulated connectivity row ("Simulate offline"), the fake QR check-in
 * ("Simulate a scan") and the access gate's trade in-charge and worker paths (a hard-coded mistri home;
 * a jobcard whose Listen/Photo/Problem buttons only flash) are absent. The API-less demo keeps them.
 *
 * API_BASE is resolved at module load, so each case resets the registry and imports fresh.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const log = (): DailyLog => ({ ...structuredClone(SEED_DAILY_LOG), logDate: todayCivil(null), checkedIn: true });

async function load(api: boolean) {
  if (api) vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  if (api) {
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'villa-b',
      projectLoadState: 'ready',
      short: 'Villa Bodakdev',
    });
  }
  useStore.setState({ role: 'engineer', lang: 'en', dailyLog: log() });
  return { useStore };
}

describe('Daily Log — simulated connectivity and the fake QR check-in', () => {
  it('a live (non-dev-server) build shows neither', async () => {
    await load(true);
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect(r.queryByTestId('toggle-online')).not.toBeInTheDocument();
    expect(r.queryByTestId('conn-text')).not.toBeInTheDocument();
    expect(r.queryByText(/Simulate offline/i)).not.toBeInTheDocument();
    expect(r.queryByText(/Worker self check-in/i)).not.toBeInTheDocument();
  });

  it('the API-less demo keeps both', async () => {
    const { useStore } = await load(false);
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('toggle-online')).toHaveTextContent('Simulate offline');
    fireEvent.click(r.getByText(/Worker self check-in/i));
    expect(useStore.getState().modal).toEqual({ type: 'qr' });
  });
});

it('the connectivity simulator is gated on the API and the Vite mode, nothing else', async () => {
  const src = (await import('@/data/apiGateway.ts?raw')).default;
  expect(src).toContain("export const CONNECTIVITY_SIMULATOR: boolean = !API_BASE || import.meta.env.MODE === 'development';");
  // unit tests run in mode 'test' and production builds in mode 'production': only the dev server keeps it
  expect(import.meta.env.MODE).toBe('test');
});

describe('Access gate — the prototype trade in-charge and worker paths', () => {
  it('a live build offers the team sign-in alone, and the store refuses the other paths', async () => {
    const { useStore } = await load(true);
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    const r = render(<TeamAccessScreen />);
    const buttons = r.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.some((t) => /team/i.test(t))).toBe(true);
    expect(buttons.some((t) => /mistri|trade in-charge/i.test(t))).toBe(false);
    expect(buttons.some((t) => /worker/i.test(t))).toBe(false);
    expect(r.queryByText(/Workers just tap their photo/i)).not.toBeInTheDocument();
    for (const who of ['worker', 'trade'] as const) {
      useStore.getState().accWho(who);
      expect(useStore.getState().access.step).toBe('who');
      expect(useStore.getState().access.who).toBeNull();
    }
    useStore.getState().accWho('team');
    expect(useStore.getState().access.step).toBe('phone');
  });

  it('the API-less demo keeps all three paths', async () => {
    const { useStore } = await load(false);
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    const r = render(<TeamAccessScreen />);
    expect(r.getByText(/Workers just tap their photo/i)).toBeInTheDocument();
    const buttons = r.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.some((t) => /trade in-charge/i.test(t))).toBe(true);
    expect(buttons.some((t) => /worker/i.test(t))).toBe(true);
    useStore.getState().accWho('worker');
    expect(useStore.getState().access.step).toBe('badge');
    useStore.getState().accWho('trade');
    expect(useStore.getState().access.step).toBe('trade');
  });
});
