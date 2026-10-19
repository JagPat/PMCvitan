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
// what the server sends on the viewer's own site photo added `m` minutes ago
const until = (m: number) => new Date(Date.now() - m * 60_000 + SITE_PHOTO_DELETE_WINDOW_MS).toISOString();

// a whole snapshot of the project on screen, with these photos
const snapOf = (photos: Photo[]) => ({
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos, materials: [],
});

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
  it('offers Delete only where the server marked the photo the viewer\'s to delete, and only within the hour', async () => {
    const { r } = await load('en', [
      { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) },
      { id: 'old', url: '/media/old', kind: 'progress', at: minutesAgo(61), deletableUntil: until(61) },
      { id: 'theirs', url: '/media/theirs', kind: 'progress', at: minutesAgo(5), by: 'Ravi Patel' },
      // evidence, or a photo on a log already sent: the server sends no deletableUntil
      { id: 'evidence', url: '/media/evidence', kind: 'inspection', at: minutesAgo(5) },
    ]);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('asks first, then deletes and shows the fresh snapshot without the photo', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) }]);
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
    expect(useStore.getState().photos).toEqual([]);
  });

  it('a delete the server confirmed stays done when the refresh after it fails (Codex 4316959524)', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) }]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true });
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway({ deleteMedia, snapshot } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await waitFor(() => expect(useStore.getState().photos).toEqual([]));
    expect(JSON.stringify(useStore.getState())).toContain('Photo deleted.');
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
  });

  it('keeps the viewer\'s deletable photo reachable behind four newer ones (Codex 4316959529)', async () => {
    const newer = [1, 2, 3, 4].map((n): Photo => ({ id: `n${n}`, url: `/media/n${n}`, kind: 'progress', at: minutesAgo(n), by: 'Ravi Patel' }));
    const { r } = await load('en', [...newer, { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(10), deletableUntil: until(10) }]);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('with no signal, says to connect and deletes nothing', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) }], { online: false });
    const deleteMedia = vi.fn();
    useStore.getState()._setGateway({ deleteMedia } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    expect(deleteMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState())).toContain('Connect to the internet to delete a photo.');
  });

  it('leaves when the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { r } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(59), deletableUntil: until(59) }]);
    expect(r.getByTestId('site-photo-delete')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(61_000); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('shows no English in %s', async (lang) => {
    const { r } = await load(lang, [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) }]);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    expect(leftoverEnglish(r.getByTestId('site-photo-delete-confirm'), [])).toEqual([]);
  });

  it('a photo just uploaded offers Delete once the server says it is the viewer\'s to delete (Codex 4317884803)', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    let answer!: (snap: unknown) => void;
    const snapshot = vi.fn().mockReturnValue(new Promise((res) => { answer = res; }));
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at }), snapshot } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    // listed at once, but no Delete the client made up: the log it went on may already be sent
    await waitFor(() => expect(r.getAllByTestId('dash-photo-who')).toHaveLength(1));
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await waitFor(() => expect(snapshot).toHaveBeenCalled());
    await act(async () => { answer(snapOf([{ id: 'new', url: '/media/new', kind: 'progress', at, deletableUntil: until(0) }])); });
    await waitFor(() => expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1));
  });

  it('a confirmed delete takes the photo off the day\'s count Send stores, even when the refresh fails (Codex 4317884791)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) };
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [{ id: 'own', url: '/media/own' }] };
    const { r, useStore } = await load('en', [own], { dailyLog });
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: 'log-1' });
    useStore.getState()._setGateway({ deleteMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await waitFor(() => expect(useStore.getState().dailyLog?.photoCount).toBe(2));
    expect(useStore.getState().dailyLog?.progress).toBe(2);
  });

  it('a photo on another log, or one a refresh already took off, leaves the day\'s count alone', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) };
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [] };
    const { useStore } = await load('en', [own], { dailyLog });
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: 'log-0' }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    await useStore.getState().deleteSitePhoto('own');
    expect(useStore.getState().dailyLog?.photoCount).toBe(3);
    // already gone from the list: the refresh that took it off counted it out
    useStore.setState({ photos: [] });
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: 'log-1' }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    await useStore.getState().deleteSitePhoto('own');
    expect(useStore.getState().dailyLog?.photoCount).toBe(3);
  });

  it('while a delete is on its way, there is nothing to tap twice, and a second ask joins the first (Codex 4317884827)', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletableUntil: until(5) }]);
    let answer!: (v: unknown) => void;
    const deleteMedia = vi.fn().mockReturnValue(new Promise((res) => { answer = res; }));
    useStore.getState()._setGateway({ deleteMedia, snapshot: vi.fn().mockResolvedValue({ photos: [] }) } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    expect(r.queryByTestId('site-photo-delete-confirm')).toBeNull();
    void useStore.getState().deleteSitePhoto('own');
    expect(deleteMedia).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true }); });
    await waitFor(() => expect(useStore.getState().photos).toEqual([]));
    expect(deleteMedia).toHaveBeenCalledTimes(1);
  });
});

describe('sitePhotoDeletable', () => {
  it('holds until the time the server gave', () => {
    const deletableUntil = '2026-10-19T10:30:00.000Z';
    const t1 = Date.parse(deletableUntil);
    expect(sitePhotoDeletable({ deletableUntil }, t1 - 1)).toBe(true);
    expect(sitePhotoDeletable({ deletableUntil }, t1)).toBe(false);
    expect(sitePhotoDeletable({}, t1 - 1)).toBe(false);
  });
});
