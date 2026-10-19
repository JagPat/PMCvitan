import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { Lang, Photo } from '@vitan/shared';
import { SITE_PHOTO_DELETE_WINDOW_MS, sitePhotoDeletable } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 site photos (Board, 14 Oct 2026) — a member deletes a site photo they added, within the hour, from the
 * Dashboard. Asked once first; nobody else's photo offers it; gone when the hour is up.
 */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function load(lang: Lang, photos: Photo[], extra: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({ role: 'contractor', lang, screen: 'dashboard', photos, timeZone: 'Asia/Kolkata', online: true, ...extra } as never);
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { r: render(<DashboardScreen />), useStore };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('deleting your own site photo within the hour (#482)', () => {
  it('offers Delete only on the viewer\'s own recent site photo', async () => {
    const { r } = await load('en', [
      { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), mine: true },
      { id: 'old', url: '/media/old', kind: 'progress', at: minutesAgo(61), mine: true },
      { id: 'theirs', url: '/media/theirs', kind: 'progress', at: minutesAgo(5), by: 'Ravi Patel' },
      { id: 'evidence', url: '/media/evidence', kind: 'inspection', at: minutesAgo(5), mine: true },
    ]);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('asks first, then deletes and shows the fresh snapshot without the photo', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), mine: true }]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true });
    const snapshot = vi.fn().mockResolvedValue({ photos: [] });
    useStore.getState()._setGateway({ deleteMedia, snapshot } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    expect(deleteMedia).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('site-photo-delete-keep'));
    expect(r.queryByTestId('site-photo-delete-confirm')).toBeNull();
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await waitFor(() => expect(deleteMedia).toHaveBeenCalledWith('own'));
    await waitFor(() => expect(snapshot).toHaveBeenCalled());
  });

  it('with no signal, says to connect and deletes nothing', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), mine: true }], { online: false });
    const deleteMedia = vi.fn();
    useStore.getState()._setGateway({ deleteMedia } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    expect(deleteMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState())).toContain('Connect to the internet to delete a photo.');
  });

  it('leaves when the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { r } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(59), mine: true }]);
    expect(r.getByTestId('site-photo-delete')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(61_000); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('shows no English in %s', async (lang) => {
    const { r } = await load(lang, [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), mine: true }]);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    expect(leftoverEnglish(r.getByTestId('site-photo-delete-confirm'), [])).toEqual([]);
  });

  it('a photo just uploaded is the viewer\'s own, so it offers Delete', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at }) } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1));
  });
});

describe('sitePhotoDeletable', () => {
  it('holds for an hour from when the server recorded it', () => {
    const at = '2026-10-19T09:30:00.000Z';
    const t0 = Date.parse(at);
    expect(sitePhotoDeletable({ mine: true, kind: 'progress', at }, t0 + SITE_PHOTO_DELETE_WINDOW_MS - 1)).toBe(true);
    expect(sitePhotoDeletable({ mine: true, kind: 'progress', at }, t0 + SITE_PHOTO_DELETE_WINDOW_MS)).toBe(false);
    expect(sitePhotoDeletable({ kind: 'progress', at }, t0)).toBe(false);
    expect(sitePhotoDeletable({ mine: true, kind: 'progress' }, t0)).toBe(false);
  });
});
