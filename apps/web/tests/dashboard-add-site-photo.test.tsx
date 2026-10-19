import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { Lang, Role } from '@vitan/shared';

/**
 * #482 site photos — every member the server lets upload adds a site photo from the Dashboard with one button.
 * The photo shows at once, newest first, and is filed as a Daily Log photo is: the project and the day's log
 * it was chosen in.
 */

async function loadApiMode(role: Role, photos: { id: string; url: string; kind: string }[] = [], lang: Lang = 'en') {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'qa',
    projectScopeGeneration: 1,
    projectLoadState: 'ready',
    name: 'QA Test Project',
    short: 'QA Test',
    stage: 'Structure Stage',
    portfolio: [],
    role,
    lang,
    photos: photos as never,
    dailyLog: null,
  });
  return { useStore };
}

function stubFileReader(dataUrl: string) {
  class SyncFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL() {
      this.result = dataUrl;
      this.onload?.();
    }
  }
  vi.stubGlobal('FileReader', SyncFileReader);
}

const pick = (r: ReturnType<typeof render>, name = 'p.jpg') =>
  fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 site photos: "Add site photo" on the Dashboard', () => {
  it.each(['pmc', 'engineer', 'contractor', 'consultant', 'client'] as const)('is offered to %s', async (role) => {
    await loadApiMode(role);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const button = r.getByTestId('add-site-photo');
    expect(button.textContent).toContain('Add site photo');
    expect(button.closest('[data-guide="add-site-photo"]')).not.toBeNull();
    // one button: no other control comes with it
    expect(button.closest('[data-guide="add-site-photo"]')!.querySelectorAll('select, button')).toHaveLength(1);
    // no `capture`: the gallery stays open on Android
    expect(r.getByTestId('add-site-photo-file').hasAttribute('capture')).toBe(false);
  });

  it.each([['hi', 'साइट फ़ोटो जोड़ें'], ['gu', 'સાઇટ ફોટો ઉમેરો']] as const)('reads in %s', async (lang, text) => {
    await loadApiMode('client', [], lang);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('add-site-photo').textContent).toContain(text);
  });

  it('is not offered to a role the server does not let upload', async () => {
    await loadApiMode('architect' as Role);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.queryByTestId('add-site-photo')).toBeNull();
  });

  it('is not offered in demo mode, where the Dashboard shows sample highlights rather than the photo list', async () => {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ role: 'pmc' });
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.queryByTestId('add-site-photo')).toBeNull();
  });

  it('uploads with no daily log open, unplaced, and shows the new photo first', async () => {
    const { useStore } = await loadApiMode('contractor', [{ id: 'old', url: 'http://api.test/old.jpg', kind: 'progress' }]);
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg' });
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);

    pick(r);

    expect(uploadMedia).toHaveBeenCalledTimes(1);
    const input = uploadMedia.mock.calls[0][0];
    expect(input).toMatchObject({ kind: 'progress', mime: 'image/jpeg', data: 'AAAA' });
    expect(input.clientKey).toEqual(expect.any(String));
    expect(input.nodeId).toBeUndefined();
    expect(input.dailyLogId).toBeUndefined();
    await waitFor(() => expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(2));
    expect((r.getByAltText('Site photo 1') as HTMLImageElement).src).toBe('http://api.test/new.jpg');
    expect(r.getByTestId('tile-photos-value').textContent).toBe('2');
  });

  it('files the photo on the day\'s log on screen, once, as the Daily Log does', async () => {
    const { useStore } = await loadApiMode('engineer');
    const log = { id: 'log-1', date: '19 Oct', checkedIn: true, checkinTime: null, submitted: false, crew: [], materials: [], progress: 0, photos: [] };
    useStore.setState({ dailyLog: log } as never);
    let reply: (v: { id: string; url: string }) => void = () => {};
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { reply = res; }));
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    pick(r);
    expect(uploadMedia.mock.calls[0][0].dailyLogId).toBe('log-1');
    // the refresh's log read failed: the photo list has the new photo, the log is the last good one
    act(() => useStore.setState({ photos: [{ id: 'new', url: 'http://api.test/new.jpg', kind: 'progress' }] }));
    await act(async () => reply({ id: 'new', url: 'http://api.test/new.jpg' }));
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['new']);
    expect(useStore.getState().dailyLog?.photos.map((p) => p.id)).toEqual(['new']);
    expect(useStore.getState().dailyLog?.progress).toBe(1);
  });

  it('adds the photo once when a refresh already brought it in before the upload reply', async () => {
    const { useStore } = await loadApiMode('pmc');
    let reply: (v: { id: string; url: string }) => void = () => {};
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { reply = res; }));
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    pick(r);
    act(() => useStore.setState({ photos: [{ id: 'new', url: 'http://api.test/new.jpg', kind: 'progress' }] }));
    await act(async () => reply({ id: 'new', url: 'http://api.test/new.jpg' }));
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['new']);
    expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(1);
  });

  it('keeps the photo list to the snapshot\'s window when a new photo joins a full one', async () => {
    const { SNAPSHOT_SITE_PHOTO_LIMIT } = await import('@vitan/shared');
    const full = Array.from({ length: SNAPSHOT_SITE_PHOTO_LIMIT }, (_, n) => ({ id: `m${n}`, url: `http://api.test/m${n}.jpg`, kind: 'progress' }));
    const { useStore } = await loadApiMode('pmc', full);
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg' }) } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    pick(r);
    await waitFor(() => expect(useStore.getState().photos[0]?.id).toBe('new'));
    expect(useStore.getState().photos).toHaveLength(SNAPSHOT_SITE_PHOTO_LIMIT);
  });

  it('lists the newest photos first, as the snapshot sends them', async () => {
    const photos = [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, url: `http://api.test/m${n}.jpg`, kind: 'progress' }));
    await loadApiMode('pmc', photos);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const shown = r.getAllByAltText(/^Site photo \d+$/).map((img) => (img as HTMLImageElement).src);
    expect(shown).toEqual(['http://api.test/m1.jpg', 'http://api.test/m2.jpg', 'http://api.test/m3.jpg', 'http://api.test/m4.jpg']);
  });

  it('keeps one upload key with each offline pick, so a replay cannot store the photo twice', async () => {
    const { useStore } = await loadApiMode('client');
    const uploadMedia = vi.fn();
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: false } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    pick(r, 'p.jpg');
    pick(r, 'q.jpg');
    expect(uploadMedia).not.toHaveBeenCalled();
    const keys = useStore.getState().outbox.map((o) => (o as { input?: { clientKey?: string } }).input?.clientKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it('waits while the day\'s log is being sent, as the Daily Log does', async () => {
    const { useStore } = await loadApiMode('engineer');
    useStore.setState({ outbox: [{ t: 'submitDailyLog' }] } as never);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect((r.getByTestId('add-site-photo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops a photo whose project was left before it finished reading', async () => {
    const { useStore } = await loadApiMode('contractor');
    const uploadMedia = vi.fn();
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    let finish: () => void = () => {};
    class LateFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        finish = () => { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); };
      }
    }
    vi.stubGlobal('FileReader', LateFileReader);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    pick(r);
    act(() => useStore.setState({ activeProjectId: 'other', projectScopeGeneration: 2 } as never));
    finish();
    expect(uploadMedia).not.toHaveBeenCalled();
  });
});
