import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const PNG = 'data:image/png;base64,aGk=';

async function mount(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const { emptyProjectData } = await import('@/store/projectScope');
  useStore.setState({
    ...getInitialState(), ...emptyProjectData(),
    activeProjectId: 'project-a', projectScopeGeneration: 1, projectLoadState: 'ready',
    role: 'engineer', dailyLog: null,
    nodes: [{ id: 'room-a', parentId: null, name: 'Site office', kind: 'room', order: 0 }],
    ...overrides,
  } as never);
  const uploadMedia = vi.fn().mockResolvedValue({ id: 'photo-a', url: '/media/photo-a' });
  useStore.getState()._setGateway({ uploadMedia } as never);
  const { CreateControl } = await import('@/layout/CreateControl');
  const { PlacesScreen } = await import('@/screens/PlacesScreen');
  return { useStore, uploadMedia, CreateControl, PlacesScreen };
}

function fileReader() {
  let release = () => {};
  let fail = () => {};
  class Reader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      release = () => { this.result = PNG; this.onload?.(); };
      fail = () => { this.onerror?.(); };
    }
  }
  vi.stubGlobal('FileReader', Reader);
  return Object.assign(() => release(), { fail: () => fail() });
}

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
});

describe('capture progress where work happens', () => {
  it('records from Add without starting a daily log or typing a field', async () => {
    const { useStore, uploadMedia, CreateControl } = await mount();
    const release = fileReader();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    expect(r.getByRole('dialog')).toHaveAccessibleName('Add progress photo');
    expect(r.queryAllByRole('textbox')).toHaveLength(0);
    expect(r.getByRole('button', { name: 'Take photo' })).toBeEnabled();
    expect(r.getByRole('button', { name: 'Choose photo' })).toBeEnabled();
    fireEvent.change(r.getByTestId('quick-photo-library'), {
      target: { files: [new File([], 'site.png', { type: 'image/png' })] },
    });
    await act(async () => { release(); });
    expect(uploadMedia).toHaveBeenCalledExactlyOnceWith({ kind: 'progress', mime: 'image/png', data: 'aGk=' });
    expect(useStore.getState().dailyLog).toBeNull();
  });

  it('inherits the room from Add here and queues that place offline', async () => {
    const { useStore, uploadMedia, PlacesScreen } = await mount({ online: false });
    const release = fileReader();
    const r = render(<PlacesScreen />);
    fireEvent.click(r.getByTestId('place-node-room-a'));
    fireEvent.click(r.getByTestId('place-add'));
    fireEvent.click(r.getByTestId('create-photo'));
    expect(r.getByTestId('quick-photo-place-trail')).toHaveTextContent('Site office');
    expect(r.queryByTestId('loc-pick-quick-photo-loc')).toBeNull();
    fireEvent.change(r.getByTestId('quick-photo-camera'), {
      target: { files: [new File([], 'site.png', { type: 'image/png' })] },
    });
    expect(r.getByRole('button', { name: 'Change' })).toBeDisabled();
    act(() => { release(); });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toEqual([
      { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'aGk=', nodeId: 'room-a' } },
    ]);
  });

  it('does not upload to another project if the project changes during the read', async () => {
    const { useStore, uploadMedia, CreateControl } = await mount();
    const release = fileReader();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    fireEvent.change(r.getByTestId('quick-photo-library'), {
      target: { files: [new File([], 'site.png', { type: 'image/png' })] },
    });
    act(() => { useStore.setState({ activeProjectId: 'project-b', projectScopeGeneration: 2, projectLoadState: 'switching' }); });
    await act(async () => { release(); });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(r.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('cancelling the picker creates nothing and leaves the form usable', async () => {
    const { uploadMedia, CreateControl } = await mount();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    fireEvent.change(r.getByTestId('quick-photo-library'), { target: { files: [] } });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(r.getByRole('button', { name: 'Choose photo' })).toBeEnabled();
  });

  it('reports a file-read failure and allows a fresh selection', async () => {
    const { uploadMedia, CreateControl } = await mount();
    const release = fileReader();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    const input = r.getByTestId('quick-photo-library');
    const selection = { target: { files: [new File([], 'site.png', { type: 'image/png' })] } };
    fireEvent.change(input, selection);
    expect(r.getByRole('button', { name: 'Choose photo' })).toBeDisabled();
    act(() => { release.fail(); });
    expect(r.getByRole('alert')).toHaveTextContent('Could not read that photo');
    expect(uploadMedia).not.toHaveBeenCalled();
    fireEvent.change(input, selection);
    await act(async () => { release(); });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('cancelling the form during a file read does not upload later', async () => {
    const { uploadMedia, CreateControl } = await mount();
    const release = fileReader();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    fireEvent.change(r.getByTestId('quick-photo-library'), {
      target: { files: [new File([], 'site.png', { type: 'image/png' })] },
    });
    fireEvent.click(r.getByRole('button', { name: 'Cancel' }));
    await act(async () => { release(); });
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('rechecks upload permission when the file read finishes', async () => {
    const { useStore, uploadMedia, CreateControl } = await mount();
    const release = fileReader();
    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-photo'));
    fireEvent.change(r.getByTestId('quick-photo-library'), {
      target: { files: [new File([], 'site.png', { type: 'image/png' })] },
    });
    act(() => { useStore.setState({ role: 'client' }); });
    await act(async () => { release(); });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(r.queryByRole('dialog')).toBeNull();
  });

  it.each(['client', 'contractor', 'consultant'])('does not offer capture to %s', async (role) => {
    const { CreateControl, PlacesScreen } = await mount({ role });
    const r = render(<><CreateControl /><PlacesScreen /></>);
    expect(r.queryByTestId('create-fab')).toBeNull();
    expect(r.queryByTestId('place-add')).toBeNull();
  });
});
