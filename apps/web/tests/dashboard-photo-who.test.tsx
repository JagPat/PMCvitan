import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Lang, Photo } from '@vitan/shared';
import { sitePhotoAddedAt, sitePhotoWho } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 site photos — each Dashboard photo says who added it, their role on the project and when, in the
 * viewer's language and the project's time zone. A person's name is data.
 */

const AT = '2026-10-19T09:30:00.000Z'; // 3:00 PM in Asia/Kolkata
const PHOTOS: Photo[] = [
  { id: 'm1', url: '/media/m1', kind: 'progress', by: 'Ravi Patel', byRole: 'contractor', at: AT },
  { id: 'm2', url: '/media/m2', kind: 'progress', at: AT },
];

async function load(lang: Lang, photos: Photo[], extra: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({ role: 'pmc', lang, screen: 'dashboard', photos, timeZone: 'Asia/Kolkata', ...extra } as never);
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { r: render(<DashboardScreen />), useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('who added each Dashboard photo (#482)', () => {
  it('reads name, role and time in English', async () => {
    const { r } = await load('en', PHOTOS);
    expect(r.getAllByTestId('dash-photo-who').map((n) => n.textContent)).toEqual(['Ravi Patel · Contractor · 19 Oct, 3:00 PM', '19 Oct, 3:00 PM']);
  });

  it.each(['hi', 'gu'] as const)('shows no English but the name in %s', async (lang) => {
    const { r } = await load(lang, PHOTOS);
    const who = r.getAllByTestId('dash-photo-who')[0]!;
    expect(who.textContent).toContain('15:00');
    expect(leftoverEnglish(r.getByTestId('dash-photo-block'), ['Ravi Patel'])).toEqual([]);
  });

  it('a photo just added says it is the viewer\'s, at the time the server recorded it, with no role claimed (Codex 4315262110, 4315262098)', async () => {
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah', role: 'client', online: true });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at: AT }) } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(r.getAllByTestId('dash-photo-who')).toHaveLength(1));
    // the server's time, not this device's clock; the role comes with the next snapshot
    expect(r.getByTestId('dash-photo-who').textContent).toBe('Asha Shah · 19 Oct, 3:00 PM');
  });
});

describe('sitePhotoWho', () => {
  it('leaves out what is not known, and an unknown role', () => {
    expect(sitePhotoWho({}, 'en')).toBe('');
    expect(sitePhotoWho({ by: 'Ravi', byRole: 'nobody' }, 'en')).toBe('Ravi');
    expect(sitePhotoWho({ byRole: 'engineer' }, 'hi')).toBe('इंजीनियर');
  });

  it('reads the time in the project\'s zone, and survives a bad time or zone', () => {
    expect(sitePhotoAddedAt(AT, 'en', 'Asia/Kolkata')).toBe('19 Oct, 3:00 PM');
    expect(sitePhotoAddedAt(AT, 'en', 'UTC')).toBe('19 Oct, 9:30 AM');
    expect(sitePhotoAddedAt('not a time', 'en', 'Asia/Kolkata')).toBe('');
    expect(sitePhotoAddedAt(AT, 'en', 'Not/AZone')).not.toBe('');
  });

  it('a photo waiting for signal says it is the viewer\'s, and claims no role (Codex 4315262098)', async () => {
    const queued = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', clientKey: 'k1' } };
    const { r } = await load('en', [], { userName: 'Jagrut Patel', outbox: [queued] });
    expect(r.getAllByTestId('dash-photo-who').map((e) => e.textContent)).toEqual(['Jagrut Patel']);
  });
});
