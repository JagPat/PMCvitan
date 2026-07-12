import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, type RenderResult } from '@testing-library/react';

/**
 * API-mode truthfulness (Phase 0 Task 7): a live user sees only facts recorded
 * for the ACTIVE project. A blank Project B must never surface Ambli sample
 * content, fixed photo totals, or a fake "report generated" success — empty and
 * unavailable data is shown honestly.
 *
 * API_BASE is resolved at module load, so each test stubs VITE_API_URL, resets
 * the module registry and dynamically imports the store + screens fresh.
 */

type StoreModule = typeof import('@/store/store');

async function loadApiMode() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const storeMod: StoreModule = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  const { useStore, getInitialState } = storeMod;
  useStore.setState(getInitialState());
  // a freshly-loaded, EMPTY Project B — nothing recorded yet
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    name: 'Villa at Bodakdev',
    short: 'Villa Bodakdev',
    descriptor: 'G+1 Villa',
    stage: 'Structure Stage',
    siteCode: 'VB-01',
    location: 'Bodakdev, Ahmedabad',
    portfolio: [],
    role: 'pmc',
  });
  return { useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

function expectNoSeededClaims(r: RenderResult) {
  expect(r.queryByText(/Ambli/i)).not.toBeInTheDocument();
  expect(r.queryByText(/Residence at/i)).not.toBeInTheDocument();
}

describe('API mode shows only live project facts (blank Project B)', () => {
  it('DailyLogScreen: honest absence — no fabricated log, no Ambli header', async () => {
    await loadApiMode();
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expectNoSeededClaims(r);
    expect(r.getByText('No daily log started')).toBeInTheDocument();
  });

  it('DashboardScreen: live identity, computed photo total, no seeded highlights', async () => {
    await loadApiMode();
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expectNoSeededClaims(r);
    expect(r.getByText('Villa at Bodakdev')).toBeInTheDocument();
    // the photos KPI is COMPUTED from snapshot arrays — a blank project has zero
    expect(r.getByTestId('tile-photos-value').textContent).toBe('0');
    expect(r.queryByText('Across 6 zones')).not.toBeInTheDocument();
    // seeded photo highlights never render for a live project
    expect(r.queryByText(/marble laid/i)).not.toBeInTheDocument();
    expect(r.getByText('No progress photos recorded')).toBeInTheDocument();
  });

  it('DashboardScreen: report generation never fakes success', async () => {
    const { useStore } = await loadApiMode();
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const btn = r.getByRole('button', { name: /weekly report/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Report export is not available yet');
    fireEvent.click(btn);
    expect(useStore.getState().toast ?? '').not.toMatch(/report generated/i);
  });

  it('ClientHealthScreen: live stage, no seeded carousel or health claims', async () => {
    await loadApiMode();
    const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
    const r = render(<ClientHealthScreen />);
    expectNoSeededClaims(r);
    expect(r.getByText('Villa Bodakdev')).toBeInTheDocument();
    expect(r.getByText('Structure Stage')).toBeInTheDocument();
    // the demo's fabricated stage/health line and photo cards never render live
    expect(r.queryByText(/On track/i)).not.toBeInTheDocument();
    expect(r.queryByText(/Living Room · flooring/i)).not.toBeInTheDocument();
    expect(r.getByText('No progress photos recorded')).toBeInTheDocument();
  });

  it('PortfolioScreen: an empty portfolio is shown honestly, never a fabricated row', async () => {
    await loadApiMode();
    const { PortfolioScreen } = await import('@/screens/PortfolioScreen');
    const r = render(<PortfolioScreen />);
    expectNoSeededClaims(r);
    expect(r.getByText('No portfolio data available')).toBeInTheDocument();
    expect(r.queryByText(/Vitan Architecture/i)).not.toBeInTheDocument();
  });
});

describe('demo mode (no API) keeps the seeded prototype behavior', () => {
  it('PortfolioScreen still synthesises the seeded project row', async () => {
    vi.resetModules();
    const { useStore, getInitialState } = (await import('@/store/store')) as StoreModule;
    useStore.setState(getInitialState());
    const { PortfolioScreen } = await import('@/screens/PortfolioScreen');
    const r = render(<PortfolioScreen />);
    expect(r.getByText('Residence at Ambli')).toBeInTheDocument();
    expect(r.queryByText('No portfolio data available')).not.toBeInTheDocument();
  });

  it('DashboardScreen keeps the demo report flash and seeded highlights', async () => {
    vi.resetModules();
    const { useStore, getInitialState } = (await import('@/store/store')) as StoreModule;
    useStore.setState(getInitialState());
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const btn = r.getByRole('button', { name: /weekly report/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(useStore.getState().toast).toMatch(/report generated/i);
  });
});
