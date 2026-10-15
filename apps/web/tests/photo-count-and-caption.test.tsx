import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

async function loadApiMode(photos: { id: string; url: string; kind: string; takenAt?: string }[]) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'qa',
    projectLoadState: 'ready',
    name: 'QA Test Project',
    short: 'QA Test',
    stage: 'Structure Stage',
    portfolio: [],
    role: 'pmc',
    photos,
  });
  return { useStore };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 QA 9: one photo count on the Dashboard', () => {
  it('shows only "Site photos on record", matching the photos listed, even when the log reports more', async () => {
    const { useStore } = await loadApiMode([{ id: 'm1', url: 'http://api.test/m1.jpg', kind: 'progress', takenAt: '14 Oct 2026, 10:02' }]);
    const { getInitialState } = await import('@/store/store');
    const seeded = getInitialState().dailyLog;
    expect(seeded).not.toBeNull();
    useStore.setState({ dailyLog: { ...seeded!, progress: 10 } });
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.queryByText('PROGRESS PHOTOS · DAILY LOG')).toBeNull();
    expect(r.getByText('SITE PHOTOS ON RECORD')).toBeTruthy();
    expect(r.getByTestId('tile-photos-value').textContent).toBe('1');
    expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(1);
  });
});

describe('#482 QA 8: no empty caption bar on Project Health photos', () => {
  it('omits the caption when a photo has no capture time (or only spaces), and keeps it when it has one', async () => {
    await loadApiMode([
      { id: 'm1', url: 'http://api.test/m1.jpg', kind: 'progress' },
      { id: 'm2', url: 'http://api.test/m2.jpg', kind: 'progress', takenAt: '14 Oct 2026, 10:02' },
      { id: 'm3', url: 'http://api.test/m3.jpg', kind: 'progress', takenAt: '   ' },
    ]);
    const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
    const r = render(<ClientHealthScreen />);
    expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(3);
    const captions = r.getAllByTestId('health-photo-caption');
    expect(captions).toHaveLength(1);
    expect(captions[0].textContent).toBe('14 Oct 2026, 10:02');
  });
});
