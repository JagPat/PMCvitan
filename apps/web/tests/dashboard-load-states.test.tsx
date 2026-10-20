import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #818 (Codex round 2) — with the Dashboard every role's home (#811), its unsettled and demo-only parts must hold
 * for roles that never reached it before:
 *   • a failed activities read offers its Retry on the Dashboard, since most roles hold no Schedule (4255945778);
 *   • a daily-log module read that has not landed shows unavailable or loading, never "Awaiting check-in" and
 *     zeros, and a failed one offers Retry (4255945769);
 *   • the demo's "Generate Weekly Report" stays the PMC's (4255945761).
 * VITE_* flags resolve against import.meta.env, so each case stubs them, resets the module registry and imports
 * the store and screen fresh.
 */

type StoreState = Record<string, unknown>;

async function loadDashboard(env: Record<string, string>, role: Role, overrides: StoreState = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  if (env.VITE_API_URL) useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', short: 'Villa Bodakdev' });
  useStore.setState({ role, screen: 'dashboard', ...overrides });
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { useStore, r: render(<DashboardScreen />) };
}

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DashboardScreen'));

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the Dashboard’s load states hold for every role', () => {
  it('a failed activities read offers Retry on the Dashboard to a role with no Schedule', async () => {
    const calls: number[] = [];
    const { r } = await loadDashboard({ VITE_API_URL: 'http://api.test', VITE_ACTIVITIES_READ: 'moduleQuery' }, 'client', { activities: [], activitiesLoad: 'error', requestFreshSnapshot: () => { calls.push(1); } });
    expect(r.getByTestId('dash-progress-basis').textContent).toMatch(/could not be loaded/);
    fireEvent.click(r.getByTestId('dash-progress-retry'));
    expect(calls).toHaveLength(1);
  });

  it('a failed daily-log read shows the strip as unavailable with Retry, not invented zeros', async () => {
    const { r } = await loadDashboard({ VITE_API_URL: 'http://api.test', VITE_DAILYLOG_READ: 'moduleQuery' }, 'contractor', { dailyLog: null, dailyLogLoad: 'error' });
    expect(r.getByText('The site log could not be loaded')).toBeInTheDocument();
    expect(r.queryByText('Awaiting check-in')).not.toBeInTheDocument();
    expect(r.getByTestId('dash-daily-log-retry')).toBeInTheDocument();
  });

  it('a daily-log read in flight shows loading, not "Awaiting check-in"', async () => {
    const { r } = await loadDashboard({ VITE_API_URL: 'http://api.test', VITE_DAILYLOG_READ: 'moduleQuery' }, 'client', { dailyLog: null, dailyLogLoad: 'loading' });
    expect(r.getByText('Loading the site log…')).toBeInTheDocument();
    expect(r.queryByTestId('dash-daily-log-retry')).not.toBeInTheDocument();
  });

  it('the demo’s weekly report action is the PMC’s alone', async () => {
    for (const role of ['client', 'contractor', 'engineer'] as Role[]) {
      const { r } = await loadDashboard({}, role);
      expect(r.queryByText(/Generate Weekly Report/), role).not.toBeInTheDocument();
      cleanup();
    }
    const { r } = await loadDashboard({}, 'pmc');
    expect(r.getByText(/Generate Weekly Report/)).toBeInTheDocument();
  });
});
