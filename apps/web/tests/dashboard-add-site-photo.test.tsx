import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { Role } from '@vitan/shared';

const NODES = [
  { id: 'z1', projectId: 'qa', parentId: null, kind: 'zone', name: 'Tower A', order: 0 },
  { id: 'r1', projectId: 'qa', parentId: 'z1', kind: 'room', name: 'Lobby', order: 0 },
  { id: 'd1', projectId: 'qa', parentId: null, kind: 'zone', name: 'Private draft', order: 1, draft: true },
];

async function loadApiMode(role: Role, photos: { id: string; url: string; kind: string }[] = []) {
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
    photos,
    nodes: NODES as never,
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

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 site photos: "Add site photo" on the Dashboard', () => {
  it.each(['pmc', 'engineer', 'contractor', 'consultant', 'client'] as const)('is offered to %s, with published places only', async (role) => {
    await loadApiMode(role);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const button = r.getByTestId('add-site-photo');
    expect(button.textContent).toContain('Add site photo');
    expect(button.closest('[data-guide="add-site-photo"]')).not.toBeNull();
    const options = Array.from(r.getByTestId('add-site-photo-place').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Where is it? (optional)', 'Tower A', 'Tower A › Lobby']);
  });

  it('is not offered to a role the server does not let upload', async () => {
    await loadApiMode('architect' as Role);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect(r.queryByTestId('add-site-photo')).toBeNull();
  });

  it('uploads with no daily log open, files the chosen place, and shows the new photo first', async () => {
    const { useStore } = await loadApiMode('contractor', [{ id: 'old', url: 'http://api.test/old.jpg', kind: 'progress' }]);
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg' });
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);

    fireEvent.change(r.getByTestId('add-site-photo-place'), { target: { value: 'r1' } });
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });

    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({ kind: 'progress', mime: 'image/jpeg', data: 'AAAA', nodeId: 'r1' });
    expect(uploadMedia.mock.calls[0][0].clientKey).toEqual(expect.any(String));
    await waitFor(() => expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(2));
    expect((r.getByAltText('Site photo 1') as HTMLImageElement).src).toBe('http://api.test/new.jpg');
    expect(r.getByTestId('tile-photos-value').textContent).toBe('2');
  });

  it('lists the newest photos first, as the snapshot sends them', async () => {
    const photos = [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, url: `http://api.test/m${n}.jpg`, kind: 'progress' }));
    await loadApiMode('pmc', photos);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    const shown = r.getAllByAltText(/^Site photo \d+$/).map((img) => (img as HTMLImageElement).src);
    expect(shown).toEqual(['http://api.test/m1.jpg', 'http://api.test/m2.jpg', 'http://api.test/m3.jpg', 'http://api.test/m4.jpg']);
  });

  it('keeps one upload key with an offline pick, so a replay cannot store the photo twice', async () => {
    const { useStore } = await loadApiMode('client');
    const uploadMedia = vi.fn();
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: false } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['y'], 'q.jpg', { type: 'image/jpeg' })] } });
    expect(uploadMedia).not.toHaveBeenCalled();
    const keys = useStore.getState().outbox.map((o) => (o as { input?: { clientKey?: string } }).input?.clientKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
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

  it('waits while the day\'s log is being sent, as the Daily Log does', async () => {
    const { useStore } = await loadApiMode('engineer');
    useStore.setState({ outbox: [{ t: 'submitDailyLog' }] } as never);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    expect((r.getByTestId('add-site-photo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uploads without a place when the chosen place is gone, rather than sending its old id', async () => {
    const { useStore } = await loadApiMode('contractor');
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg' });
    useStore.getState()._setGateway({ uploadMedia } as never);
    useStore.setState({ online: true } as never);
    stubFileReader('data:image/jpeg;base64,AAAA');
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    fireEvent.change(r.getByTestId('add-site-photo-place'), { target: { value: 'r1' } });
    act(() => useStore.setState({ nodes: NODES.filter((n) => n.id !== 'r1') as never }));
    expect((r.getByTestId('add-site-photo-place') as HTMLSelectElement).value).toBe('');
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    expect(uploadMedia.mock.calls[0][0].nodeId).toBeUndefined();
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
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    act(() => useStore.setState({ photos: [{ id: 'new', url: 'http://api.test/new.jpg', kind: 'progress' }] }));
    await act(async () => reply({ id: 'new', url: 'http://api.test/new.jpg' }));
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['new']);
    expect(r.getAllByAltText(/^Site photo \d+$/)).toHaveLength(1);
  });
});

