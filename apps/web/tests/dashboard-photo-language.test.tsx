import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Lang, Photo } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #954 (#482 6229527017, observation 2) — in Hindi and Gujarati the Dashboard's photo section stayed in English:
 * the "LATEST · SITE PHOTOS" heading, the "No progress photos recorded" line, each photo's kind and its alt text.
 * The client's empty photo line read the same English. English stays as it was. A photo's capture stamp is data.
 */

const STAMP = '2026-10-18 10:30';
const PHOTOS: Photo[] = [
  { id: 'm1', url: '/media/m1', takenAt: STAMP, kind: 'progress' },
  { id: 'm2', url: '/media/m2', takenAt: STAMP, kind: 'inspection' },
  { id: 'm3', url: '/media/m3', takenAt: STAMP, kind: 'material' },
];

async function load(screen: 'dashboard' | 'client-health', lang: Lang, photos: Photo[]) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({ role: screen === 'dashboard' ? 'pmc' : 'client', lang, screen, photos });
  if (screen === 'dashboard') {
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    return render(<DashboardScreen />);
  }
  const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
  return render(<ClientHealthScreen />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(['hi', 'gu'] as const)('the Dashboard photo section in %s (#954)', (lang) => {
  it('with no photos: the heading and the empty line show no English', async () => {
    const r = await load('dashboard', lang, []);
    expect(leftoverEnglish(r.getByTestId('dash-photo-block'))).toEqual([]);
  });

  it('with photos: the heading, each kind and each alt text show no English', async () => {
    const r = await load('dashboard', lang, PHOTOS);
    const block = r.getByTestId('dash-photo-block');
    expect(block.querySelectorAll('img')).toHaveLength(3);
    expect(leftoverEnglish(block)).toEqual([]);
  });
});

describe('English is unchanged (#954)', () => {
  it('the heading, empty line, kinds and alt text read as before', async () => {
    const empty = await load('dashboard', 'en', []);
    expect(empty.getByTestId('dash-photo-block').textContent).toBe('LATEST · SITE PHOTOSNo progress photos recorded');
    cleanup();
    const full = await load('dashboard', 'en', PHOTOS);
    const block = full.getByTestId('dash-photo-block');
    expect(block.textContent).toContain('Progress');
    expect(block.textContent).toContain('Material');
    expect(block.querySelector('img')?.getAttribute('alt')).toBe('Site photo 1');
  });
});

describe('the client\'s empty photo line (#954)', () => {
  it.each([
    ['hi', 'प्रगति की कोई फ़ोटो दर्ज नहीं'],
    ['gu', 'પ્રગતિનો કોઈ ફોટો નોંધાયો નથી'],
    ['en', 'No progress photos recorded'],
  ] as const)('reads in %s', async (lang, line) => {
    const r = await load('client-health', lang, []);
    expect(r.container.textContent).toContain(line);
  });
});
