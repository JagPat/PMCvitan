import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Role } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #482 (board decision 14 Oct) — the in-app guide for "add a site photo", and the empty Dashboard photo box's line.
 *
 * The guide points at the Dashboard's real "Add site photo" button the first time a PMC or engineer reaches it, and
 * finishes only once the store has the photo (sent, or kept to send), never on the press alone: the picker can be
 * cancelled and the upload can fail. jsdom lays nothing out, so every connected element reports one client rect.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-1';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DashboardScreen'), () => import('@/guide/GuideHost'), () => import('@/guide/guideState'), () => import('@/guide/guides'), () => import('@/guide/outcomes'), () => import('@/guide/EmptyHint'), () => import('@/layout/CreateControl'), () => import('@vitan/shared'));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** the Dashboard of a live project with no photos, as `role`, with the guide host mounted */
async function dashboard(role: Role, opts: { lang?: Lang; online?: boolean; done?: string[]; photos?: unknown[]; load?: string; state?: Record<string, unknown> } = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'project-a',
    projectScopeGeneration: 1,
    projectLoadState: opts.load ?? 'ready',
    name: 'QA Test Project',
    short: 'QA Test',
    stage: 'Structure Stage',
    portfolio: [],
    role,
    screen: 'dashboard',
    lang: opts.lang ?? 'en',
    sessionUserId: 'u-1',
    photos: opts.photos ?? [],
    dailyLog: null,
    online: opts.online ?? true,
    ...opts.state,
  } as never);
  // the PMC's two earlier Dashboard guides are done, so this one is the visit's one start
  localStorage.setItem(DONE_KEY, JSON.stringify(opts.done ?? (role === 'pmc' ? ['raise-issue-pmc', 'record-decision-pmc'] : [])));
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  const { GuideHost } = await import('@/guide/GuideHost');
  // the shell's + (the PMC's earlier Dashboard guides start on it)
  const { CreateControl } = await import('@/layout/CreateControl');
  const view = render(<><GuideHost /><CreateControl /><DashboardScreen /></>);
  return { useStore, view };
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

const tick = (ms = 400) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const press = (el: Element) => act(() => { fireEvent.click(el); });
const pick = (view: ReturnType<typeof render>) =>
  act(() => { fireEvent.change(view.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } }); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('the "add a site photo" guide', () => {
  it.each(['pmc', 'engineer'] as const)('starts by itself for a %s on the Dashboard, pointing at Add site photo', async (role) => {
    await dashboard(role);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(tip()?.textContent).toContain('Tap here to add a photo of the site');
  });

  it('comes after the PMC\'s two earlier Dashboard guides, never on top of them', async () => {
    await dashboard('pmc', { done: [] });
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
  });

  it.each(['contractor', 'consultant', 'client'] as const)('is not shown to a %s', async (role) => {
    const { view } = await dashboard(role);
    tick();
    // the button is theirs too; the guide is the PMC's and engineer's (board decision)
    expect(view.getByTestId('add-site-photo')).toBeTruthy();
    expect(tip()).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('its tip is in %s, with no English words left in it', async (lang) => {
    await dashboard('engineer', { lang });
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(tip()!.querySelector('p')!.textContent).not.toMatch(/[A-Za-z]/);
  });

  it('waits after the press: a cancelled picker leaves the tip; a photo the server took finishes the guide', async () => {
    const { useStore, view } = await dashboard('engineer');
    let reply!: (v: unknown) => void;
    const uploadMedia = vi.fn(() => new Promise((res) => { reply = res; }));
    act(() => { useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    press(view.getByTestId('add-site-photo'));
    tick(2000);
    // no photo chosen yet (or the picker was closed): nothing to finish, the tip stays on the button
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(done()).not.toContain('add-site-photo');
    pick(view);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    tick(2000);
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    await act(async () => { reply({ id: 'new', url: 'http://api.test/new.jpg' }); });
    await flush();
    tick();
    expect(tip()).toBeNull();
    expect(done()).toContain('add-site-photo');
  });

  it('a failed upload does not finish it: the tip stays for another try', async () => {
    const { useStore, view } = await dashboard('engineer');
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(new Error('offline')) } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    press(view.getByTestId('add-site-photo'));
    const { useGuideState } = await import('@/guide/guideState');
    expect(useGuideState.getState().run?.waiting).toBe(true);
    pick(view);
    await flush();
    tick();
    // the failure ends the wait (the guide no longer holds on an answer that came)
    expect(useGuideState.getState().run?.waiting).toBe(false);
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(done()).not.toContain('add-site-photo');
  });

  it('a file that is not a readable photo does not finish it', async () => {
    const { useStore, view } = await dashboard('engineer');
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn() } as never); });
    stubFileReader('not a data url');
    tick();
    press(view.getByTestId('add-site-photo'));
    pick(view);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(done()).not.toContain('add-site-photo');
  });

  it('a photo kept on this phone to send later finishes it, as an offline submit does', async () => {
    const { useStore, view } = await dashboard('pmc', { online: false });
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn() } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    press(view.getByTestId('add-site-photo'));
    pick(view);
    expect(useStore.getState().outbox.some((op) => op.t === 'uploadMedia')).toBe(true);
    // done once the queue's write holds it on this phone
    await vi.waitFor(() => expect(done()).toContain('add-site-photo'));
    tick();
    expect(tip()).toBeNull();
  });

  it('a photo that could not be kept on this phone does not finish it, and does not ask for it again: it is still sent from memory', async () => {
    const { useStore, view } = await dashboard('pmc', { online: false });
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn() } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.outbox.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    tick();
    press(view.getByTestId('add-site-photo'));
    const { useGuideState } = await import('@/guide/guideState');
    expect(useGuideState.getState().run?.waiting).toBe(true);
    pick(view);
    // the write's answer ends the run unfinished: lost on a reload, so not marked done, but the same photo is still on its
    // way from memory, so no tip invites a second pick that would send it twice
    await vi.waitFor(() => expect(useGuideState.getState().run).toBeNull());
    expect(done()).not.toContain('add-site-photo');
    expect(useStore.getState().outbox.filter((op) => op.t === 'uploadMedia')).toHaveLength(1);
    tick(2000);
    expect(tip()).toBeNull();
    // "Guide me" still offers it
    const { GUIDES } = await import('@/guide/guides');
    act(() => { useGuideState.getState().start(GUIDES.find((g) => g.id === 'add-site-photo')!); });
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
  });

  it('a live refresh that shows the photo before the upload answers finishes it', async () => {
    const { useStore, view } = await dashboard('engineer');
    const uploadMedia = vi.fn((_input: { clientKey: string }) => new Promise(() => {}));
    act(() => { useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    press(view.getByTestId('add-site-photo'));
    pick(view);
    tick(2000);
    expect(done()).not.toContain('add-site-photo');
    const { clientKey } = uploadMedia.mock.calls[0]![0];
    // another photo on record (someone else's, no key of this pick) is not this one
    act(() => { useStore.setState({ photos: [{ id: 'other', url: 'http://api.test/o.jpg', kind: 'progress' }] } as never); });
    tick();
    expect(done()).not.toContain('add-site-photo');
    act(() => { useStore.setState({ photos: [{ id: 'mine', url: 'http://api.test/m.jpg', kind: 'progress', clientKey }] } as never); });
    tick();
    expect(done()).toContain('add-site-photo');
    expect(tip()).toBeNull();
  });

  it.each(['before', 'after'] as const)('a photo a live refresh shows %s its upload reports a failure still finishes it', async (when) => {
    const { useStore, view } = await dashboard('engineer');
    let fail!: (e: Error) => void;
    const uploadMedia = vi.fn((_input: { clientKey: string }) => new Promise((_res, rej) => { fail = rej; }));
    act(() => { useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    press(view.getByTestId('add-site-photo'));
    pick(view);
    const { clientKey } = uploadMedia.mock.calls[0]![0];
    const record = () => useStore.setState({ photos: [{ id: 'mine', url: 'http://api.test/m.jpg', kind: 'progress', clientKey }] } as never);
    const showIt = () => act(record);
    // the server took the photo but its answer was lost on the way back; 'before': the refresh lands in the same moment,
    // with no look at the guide in between (its next poll comes after the failure)
    await act(async () => {
      if (when === 'before') record();
      fail(new Error('connection reset'));
    });
    await flush();
    if (when === 'after') {
      tick();
      expect(done()).not.toContain('add-site-photo');
      showIt();
    }
    tick();
    expect(done()).toContain('add-site-photo');
    expect(tip()).toBeNull();
  });

  it('points at the button itself, not the row around it', async () => {
    await dashboard('engineer');
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    const target = document.querySelector('[data-guide="add-site-photo"]')!;
    expect(target.tagName).toBe('BUTTON');
    expect(target.getAttribute('data-testid')).toBe('add-site-photo');
  });

  it('a late reply to a photo added before a replay does not finish the replay', async () => {
    const { useStore, view } = await dashboard('engineer');
    let reply!: (v: unknown) => void;
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn(() => new Promise((res) => { reply = res; })), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    stubFileReader('data:image/jpeg;base64,AAAA');
    tick();
    press(view.getByTestId('add-site-photo'));
    pick(view);
    // the person starts the guide again while that upload is on its way
    const { useGuideState } = await import('@/guide/guideState');
    const { GUIDES } = await import('@/guide/guides');
    act(() => {
      useGuideState.getState().stop();
      useGuideState.getState().start(GUIDES.find((g) => g.id === 'add-site-photo')!);
    });
    tick();
    await act(async () => { reply({ id: 'new', url: 'http://api.test/new.jpg' }); });
    await flush();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(done()).not.toContain('add-site-photo');
  });
});

describe('the empty Dashboard photo box', () => {
  it('tells the person to tap Add site photo, the button above it, inside the empty box', async () => {
    const { view } = await dashboard('client');
    const hint = view.getByTestId('empty-hint');
    expect(hint.getAttribute('data-hint')).toBe('photo');
    expect(hint.textContent).toBe('To add the first photo of the site, tap Add site photo above.');
    expect(hint.parentElement?.textContent).toContain('No progress photos');
    expect(view.getByTestId('add-site-photo').textContent).toContain('Add site photo');
  });

  it.each([['hi', 'साइट फ़ोटो जोड़ें'], ['gu', 'સાઇટ ફોટો ઉમેરો']] as const)('the line is in %s, naming the button as it reads', async (lang, label) => {
    const { view } = await dashboard('engineer', { lang });
    const text = view.getByTestId('empty-hint').textContent ?? '';
    expect(text).toContain(label);
    expect(view.getByTestId('add-site-photo').textContent).toContain(label);
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it('a project with photos is not empty: no line', async () => {
    const { view } = await dashboard('pmc', { photos: [{ id: 'p1', url: 'http://api.test/p1.jpg', kind: 'progress' }] });
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });

  it.each(['loading', 'switching', 'error'] as const)('no line while the project is %s: its photos are not known to be none', async (load) => {
    const { view } = await dashboard('pmc', { load });
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });

  it('a role with no Add site photo button is shown no line', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ role: 'worker' } as never);
    const { EmptyHint } = await import('@/guide/EmptyHint');
    const view = render(<EmptyHint task="photo" />);
    expect(view.queryByTestId('empty-hint')).toBeNull();
  });
});

describe('the guide follows the photo it was shown for', () => {
  it('does not start on a greyed-out Add site photo (the day\'s log is being sent), and starts once it can be pressed', async () => {
    // a send of the day's log on its way when the Dashboard opens
    const { useStore, view } = await dashboard('engineer', { state: { outbox: [{ t: 'submitDailyLog', log: {}, idempotencyKey: 'k' }] } });
    expect((view.getByTestId('add-site-photo') as HTMLButtonElement).disabled).toBe(true);
    tick();
    expect(tip()).toBeNull();
    act(() => { useStore.setState({ outbox: [] } as never); });
    expect((view.getByTestId('add-site-photo') as HTMLButtonElement).disabled).toBe(false);
    tick();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
  });

  it('a photo chosen before the guide began, whose read ends after, does not finish it', async () => {
    const { useStore, view } = await dashboard('engineer', { done: ['add-site-photo'] });
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'n', url: 'http://api.test/n.jpg' }), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    let finishRead!: () => void;
    class SlowReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { finishRead = () => { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }; }
    }
    vi.stubGlobal('FileReader', SlowReader);
    tick();
    expect(tip()).toBeNull();
    pick(view); // chosen with no guide running
    const { useGuideState } = await import('@/guide/guideState');
    const { GUIDES } = await import('@/guide/guides');
    act(() => { useGuideState.getState().start(GUIDES.find((g) => g.id === 'add-site-photo')!); }); // "Guide me"
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    act(() => { finishRead(); });
    await flush();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(useGuideState.getState().run?.step).toBe(0);
  });

  it('a photo the phone could not read ends the wait', async () => {
    const { useStore, view } = await dashboard('engineer');
    act(() => { useStore.getState()._setGateway({ uploadMedia: vi.fn() } as never); });
    class FailingReader {
      result: string | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.onerror?.(); }
    }
    vi.stubGlobal('FileReader', FailingReader);
    tick();
    press(view.getByTestId('add-site-photo'));
    const { useGuideState } = await import('@/guide/guideState');
    expect(useGuideState.getState().run?.waiting).toBe(true);
    pick(view);
    expect(useGuideState.getState().run?.waiting).toBe(false);
    expect(done()).not.toContain('add-site-photo');
  });
});
