import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Photo } from '@vitan/shared';
import { SITE_PHOTO_DELETE_WINDOW_MS, sitePhotoDeletable } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';
import { calledTimes, heldOnPurpose, settled, startWork, tracked } from './site-visit-work';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DashboardScreen'), () => import('@/screens/DailyLogScreen'), () => import('@/screens/PlacesScreen'));

/**
 * #482 site photos (Board, 14 Oct 2026) — a member deletes a site photo they added, within the hour, from the
 * Dashboard. Asked once first; nobody else's photo offers it; gone when the hour is up.
 * Every wait is on the work's own end (`settled()`) or on a call held open on purpose (`calledTimes`), never on a clock;
 * the fake-timer advances in the deadline tests are the thing under test.
 */
let stopWork: (() => void) | null = null;

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
  stopWork = startWork(useStore as never);
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { r: render(<DashboardScreen />), useStore };
}

afterEach(() => {
  stopWork?.();
  stopWork = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('deleting your own site photo within the hour (#482)', () => {
  it('offers Delete only where the server marked the photo the viewer\'s to delete, and only within the hour', async () => {
    const { r } = await load('en', [
      { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) },
      { id: 'old', url: '/media/old', kind: 'progress', at: minutesAgo(61), deletable: true, deletableUntil: until(61) },
      { id: 'theirs', url: '/media/theirs', kind: 'progress', at: minutesAgo(5), by: 'Ravi Patel' },
      // evidence, or a photo on a log already sent: the server sends no deletableUntil
      { id: 'evidence', url: '/media/evidence', kind: 'inspection', at: minutesAgo(5) },
    ]);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('asks first, then deletes and shows the fresh snapshot without the photo', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true });
    const snapshot = vi.fn().mockResolvedValue({ photos: [] });
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot }) as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    expect(deleteMedia).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('site-photo-delete-keep'));
    expect(r.queryByTestId('site-photo-delete-confirm')).toBeNull();
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await settled();
    expect(deleteMedia).toHaveBeenCalledWith('own');
    expect(snapshot).toHaveBeenCalled();
    expect(useStore.getState().photos).toEqual([]);
  });

  it('a delete the server confirmed stays done when the refresh after it fails (Codex 4316959524)', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true });
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot }) as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await settled();
    expect(useStore.getState().photos).toEqual([]);
    expect(JSON.stringify(useStore.getState())).toContain('Photo deleted.');
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
  });

  it('offers the PMC Delete on any photo the server marked, with no hour, and only on the newest four (Codex 4320912804)', async () => {
    const { r } = await load('en', [
      ...['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, url: `/media/${id}`, kind: 'progress', at: minutesAgo(90), by: 'Ravi Patel', deletable: true })),
      // a photo a record keeps: the server leaves `deletable` off
      { id: 'kept', url: '/media/kept', kind: 'progress', at: minutesAgo(90) },
    ]);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(4);
  });

  it('keeps the viewer\'s deletable photo reachable behind four newer ones (Codex 4316959529)', async () => {
    const newer = [1, 2, 3, 4].map((n): Photo => ({ id: `n${n}`, url: `/media/n${n}`, kind: 'progress', at: minutesAgo(n), by: 'Ravi Patel' }));
    const { r } = await load('en', [...newer, { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(10), deletable: true, deletableUntil: until(10) }]);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('with no signal, says to connect and deletes nothing', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }], { online: false });
    const deleteMedia = vi.fn();
    useStore.getState()._setGateway(tracked({ deleteMedia }) as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    expect(deleteMedia).not.toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState())).toContain('Connect to the internet to delete a photo.');
  });

  it('leaves when the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { r } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(59), deletable: true, deletableUntil: until(59) }]);
    expect(r.getByTestId('site-photo-delete')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(61_000); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('shows no English in %s', async (lang) => {
    const { r } = await load(lang, [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    expect(leftoverEnglish(r.getByTestId('site-photo-delete-confirm'), [])).toEqual([]);
  });

  it('a photo just uploaded offers Delete once the server says it is the viewer\'s to delete (Codex 4317884803)', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    let answer!: (snap: unknown) => void;
    const snapshot = vi.fn().mockReturnValue(new Promise((res) => { answer = res; }));
    useStore.getState()._setGateway(tracked({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at }), snapshot }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    // listed at once, but no Delete the client made up: the log it went on may already be sent
    await settled();
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(1);
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await calledTimes('snapshot');
    await act(async () => { answer(snapOf([{ id: 'new', url: '/media/new', kind: 'progress', at, deletable: true, deletableUntil: until(0) }])); });
    await settled();
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('a confirmed delete shows no day\'s count until a pull begun after it brings the server\'s (Codex 4317884791, 4322142057)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [{ id: 'own', url: '/media/own' }] };
    const { useStore } = await load('en', [own], { dailyLog });
    // a pull already on its way when the delete is answered: it may have counted the photo while listing it gone
    let racing!: (snap: unknown) => void;
    const snapshot = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { racing = res; }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(snapOf([]));
    let answer!: (v: unknown) => void;
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    const deleting = useStore.getState().deleteSitePhoto('own');
    useStore.getState().requestFreshSnapshot();
    await calledTimes('snapshot', 1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true, dailyLogId: 'log-1' }); await deleting; });
    // no count is shown that may still hold the photo
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const screen = render(<DailyLogScreen />);
    expect(screen.getByTestId('progress-photo-count').textContent).toBe('Progress photos: updating the count…');
    // the racing pull lands with the list after the delete and the count before it: it is not the count
    await act(async () => { racing({ ...snapOf([]), dailyLog: { ...dailyLog, photos: [] } }); });
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
    // the refresh after the delete failed: still none shown. The next pull says the server's count.
    await calledTimes('snapshot', 2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await settled();
    expect(screen.getByTestId('progress-photo-count').textContent).toBe('Progress photos: updating the count…');
    snapshot.mockResolvedValue({ ...snapOf([]), dailyLog: { ...dailyLog, photoCount: 2, progress: 2, photos: [] } });
    await act(async () => { await useStore.getState().requestFreshSnapshot(); });
    expect(useStore.getState().dailyLogPhotoCountAfter).toBeNull();
    expect(useStore.getState().dailyLog?.progress).toBe(2);
    expect(screen.getByTestId('progress-photo-count').textContent).not.toContain('updating');
  });

  it('a photo on another log leaves the day\'s count shown', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [] };
    const { useStore } = await load('en', [own], { dailyLog });
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: 'log-0' }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await useStore.getState().deleteSitePhoto('own');
    expect(useStore.getState().dailyLogPhotoCountAfter).toBeNull();
    expect(useStore.getState().dailyLog?.photoCount).toBe(3);
  });

  it('the server deletes but its answer is lost: the retry\'s "not found" is the delete, never a refusal (#991)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [own] };
    const { useStore } = await load('en', [own], { dailyLog });
    const notFound = Object.assign(new Error('/media/own 404'), { status: 404, serverMessage: 'Media not found' });
    // the first DELETE commits on the server and its answer never arrives; the refresh after it fails as well
    const deleteMedia = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(notFound);
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot }) as never);
    await useStore.getState().deleteSitePhoto('own');
    // nothing is known yet: the photo stays, and the member is told the server was not reached
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['own']);
    expect(useStore.getState().toast).toBe('Could not reach the server — please try again.');
    // the retry finds the photo gone: it leaves, from the day's log too, and is reported deleted
    await useStore.getState().deleteSitePhoto('own');
    expect(deleteMedia).toHaveBeenCalledTimes(2);
    expect(useStore.getState().photos).toEqual([]);
    expect(useStore.getState().dailyLog?.photos).toEqual([]);
    expect(useStore.getState().toast).toBe('Photo deleted.');
    // it was on the log on screen, so that log's count is read again before one is shown
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
  });

  it('a "not found" for a photo the log\'s gallery does not hold still has the day\'s count read again: the gallery is only the newest 12 (#991, Codex 4337661426)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    // the 13th in-hour photo: twelve newer ones fill the gallery, and the log counts all thirteen
    const gallery = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, url: `/media/g${i}` }));
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 13, photoCount: 13, myPhotoKeys: [], crew: [], materials: [], photos: gallery };
    const { useStore } = await load('en', [own], { dailyLog });
    const notFound = Object.assign(new Error('/media/own 404'), { status: 404, serverMessage: 'Media not found' });
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockRejectedValue(notFound), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await useStore.getState().deleteSitePhoto('own');
    await settled();
    expect(useStore.getState().photos).toEqual([]);
    expect(useStore.getState().toast).toBe('Photo deleted.');
    // the refresh failed: the count stays "updating", never the 13 that may still hold the photo
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const screen = render(<DailyLogScreen />);
    expect(screen.getByTestId('progress-photo-count').textContent).toBe('Progress photos: updating the count…');
  });

  it('a "not found" with no log on screen marks no count', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const { useStore } = await load('en', [own], { dailyLog: null });
    const notFound = Object.assign(new Error('/media/own 404'), { status: 404, serverMessage: 'Media not found' });
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockRejectedValue(notFound), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await useStore.getState().deleteSitePhoto('own');
    expect(useStore.getState().photos).toEqual([]);
    expect(useStore.getState().dailyLogPhotoCountAfter).toBeNull();
  });

  it('a route\'s or a proxy\'s 404 is not the server saying the photo is gone: the photo stays, and nothing says it was deleted (#991)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const { useStore } = await load('en', [own]);
    const routeMiss = Object.assign(new Error('/media/own 404'), { status: 404, serverMessage: 'Cannot DELETE /media/own' });
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockRejectedValue(routeMiss), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await useStore.getState().deleteSitePhoto('own');
    await settled();
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['own']);
    expect(useStore.getState().toast).not.toBe('Photo deleted.');
  });

  it('one confirmed delete asks the server for exactly one fresh snapshot', async () => {
    const { useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    const snapshot = vi.fn().mockResolvedValue(snapOf([]));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot }) as never);
    await useStore.getState().deleteSitePhoto('own');
    await settled();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useStore.getState().photos).toEqual([]);
  });

  it('a deleted photo leaves the evidence of every checklist and review held here, and a decision option\'s sample, when the refresh fails (Codex 4322142035)', async () => {
    const photo: Photo = { id: 'ev1', url: 'http://api.test/media/ev1?t=a', kind: 'inspection', at: minutesAgo(5), deletable: true };
    const item = (id: string) => ({ id, name: id, state: 'fail', photos: 1, note: '', evidence: ['http://api.test/media/ev1?t=b', 'http://api.test/media/ev10?t=c'] });
    const checklist = { id: 'c1', title: 'Slab', items: [item('i1')] };
    const { useStore } = await load('en', [photo], {
      role: 'pmc',
      checklist,
      openChecklists: [checklist, { id: 'c2', title: 'Wall', items: [item('i2')] }],
      reviews: [{ id: 'r1', title: 'Slab', items: [{ ...item('i3'), result: 'FAIL' }] }],
      decisions: [{ id: 'd1', options: [{ label: 'A', key: 'a', photoUrl: 'http://api.test/media/ev1?t=d' }, { label: 'B', key: 'b', photoUrl: 'http://api.test/media/ev10?t=e' }] }],
    });
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await useStore.getState().deleteSitePhoto('ev1');
    const st = useStore.getState() as unknown as { checklist: typeof checklist; openChecklists: typeof checklist[]; reviews: typeof checklist[]; decisions: { options: { photoUrl?: string }[] }[] };
    const left = ['http://api.test/media/ev10?t=c'];
    expect(st.checklist.items[0]!.evidence).toEqual(left);
    expect(st.openChecklists.map((c) => c.items[0]!.evidence)).toEqual([left, left]);
    expect(st.reviews[0]!.items[0]!.evidence).toEqual(left);
    expect(st.decisions[0]!.options.map((o) => o.photoUrl)).toEqual([undefined, 'http://api.test/media/ev10?t=e']);
  });

  it('while a delete is on its way, there is nothing to tap twice, and a second ask joins the first (Codex 4317884827)', async () => {
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    let answer!: (v: unknown) => void;
    const deleteMedia = vi.fn().mockReturnValue(new Promise((res) => { answer = res; }));
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot: vi.fn().mockResolvedValue({ photos: [] }) }) as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    expect(r.queryByTestId('site-photo-delete-confirm')).toBeNull();
    void useStore.getState().deleteSitePhoto('own');
    expect(deleteMedia).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true }); });
    await settled();
    expect(useStore.getState().photos).toEqual([]);
    expect(deleteMedia).toHaveBeenCalledTimes(1);
  });
});

describe('a confirmed delete stays done (#482 redesign after #987)', () => {
  it('a snapshot asked for before the delete never brings the photo back, even when the pull after it fails (Codex 4318519722)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const { r, useStore } = await load('en', [own]);
    let oldAnswer!: (snap: unknown) => void;
    const snapshot = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { oldAnswer = res; }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    // a pull already on its way when the member deletes
    useStore.getState().requestFreshSnapshot();
    await calledTimes('snapshot', 1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await settled();
    expect(useStore.getState().photos).toEqual([]);
    // the old pull lands, carrying the photo as it was before the delete
    await act(async () => { oldAnswer(snapOf([own])); });
    await calledTimes('snapshot', 2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await settled();
    expect(useStore.getState().photos).toEqual([]);
  });

  it('no Delete while the photo\'s upload is still queued here, and the store refuses one; it comes once the upload has gone (Codex 4322142028, 4318519735)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5), clientKey: 'k-own' };
    const queued = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', clientKey: 'k-own' } };
    const other = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'BBBB', clientKey: 'k-other' } };
    const { r, useStore } = await load('en', [own], { outbox: [queued, other] });
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: null });
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    // a send of that upload may already be on its way: after a delete it would add the photo again
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await useStore.getState().deleteSitePhoto('own');
    expect(deleteMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toEqual([queued, other]);
    expect(useStore.getState().photos).toEqual([own]);
    expect(JSON.stringify(useStore.getState())).toContain('This photo is still uploading.');
    // an evidence upload holding the key is the same
    await act(async () => { useStore.setState({ outbox: [{ t: 'uploadEvidence', scope: 's', clientKey: 'k-own' }] } as never); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    // the upload landed and left the queue: Delete is offered, and deletes
    await act(async () => { useStore.setState({ outbox: [other] } as never); });
    expect(r.getByTestId('site-photo-delete')).toBeTruthy();
    await useStore.getState().deleteSitePhoto('own');
    expect(deleteMedia).toHaveBeenCalledWith('own');
    expect(useStore.getState().outbox).toEqual([other]);
  });
});

describe('a pull begun while the delete was on its way (#482, Codex 4322459274)', () => {
  it('never brings the photo or its evidence back, even when the pull after the delete fails', async () => {
    const own: Photo = { id: 'own', url: 'http://api.test/media/own?t=a', kind: 'inspection', at: minutesAgo(5), deletable: true };
    const checklist = { id: 'c1', title: 'Slab', items: [{ id: 'i1', name: 'i1', state: 'fail', photos: 1, note: '', evidence: ['http://api.test/media/own?t=b'] }] };
    const { useStore } = await load('en', [own], { role: 'pmc', checklist, openChecklists: [checklist] });
    let answer!: (v: unknown) => void;
    let racing!: (snap: unknown) => void;
    const snapshot = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { racing = res; }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    const deleting = useStore.getState().deleteSitePhoto('own');
    // a socket ping asks for a pull after the DELETE went out, and the server reads it before the delete commits
    useStore.getState().requestFreshSnapshot();
    await calledTimes('snapshot', 1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true, dailyLogId: null }); await deleting; });
    expect(useStore.getState().photos).toEqual([]);
    // that pull lands after the delete was confirmed, carrying the photo and its evidence as they were
    await act(async () => { racing({ ...snapOf([own]), checklist, openChecklists: [checklist] }); });
    await calledTimes('snapshot', 2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await settled();
    expect(useStore.getState().photos).toEqual([]);
    const st = useStore.getState() as unknown as { checklist: typeof checklist };
    expect(st.checklist.items[0]!.evidence).toEqual([]);
  });
});

describe('a delete answered after a project switch (#482)', () => {
  it('leaves the project now on screen untouched', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const { useStore } = await load('en', [own]);
    let answer!: (v: unknown) => void;
    const snapshot = vi.fn().mockReturnValue(new Promise(() => {}));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot }) as never);
    const deleting = useStore.getState().deleteSitePhoto('own');
    // the member switches project while the DELETE is on its way; the other project lists a photo of the same id
    const other: Photo = { ...own, url: '/media/own?other' };
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, photos: [other] } as never);
    await act(async () => { answer({ ok: true, dailyLogId: null }); await deleting; });
    expect(useStore.getState().photos).toEqual([other]);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('the viewer\'s photo in their hour beyond the newest 300 (#482, Codex 4322459282, 4322976249)', () => {
  const sync = () => {
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
  };
  const newer = (n: number) => Array.from({ length: n }, (_, i): Photo => ({ id: `n${i}`, url: `/media/n${i}`, kind: 'progress', at: minutesAgo(1), by: 'Ravi Patel' }));

  it('a delete from the full window keeps the count a floor until a snapshot rebuilds the window, also when the refresh fails (Codex 4337661439)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', [...newer(299), own], { nodes: [{ id: 'kit', parentId: null, name: 'Kitchen', kind: 'room', order: 0 }] });
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const CAPPED_PLACE = 'among the latest 300 photos on record';
    const place = () => { useStore.setState({ routeItem: 'kit' } as never); const p = render(<PlacesScreen />); const text = p.container.textContent; p.unmount(); return text; };
    expect(r.container.textContent).toContain('300+');
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot }) as never);
    await act(async () => { await useStore.getState().deleteSitePhoto('own'); });
    await settled();
    expect(snapshot).toHaveBeenCalled();
    // 299 left on screen, and an older photo may lie just past the window: "at least", never an exact 299, on the
    // Dashboard and on the Site Map alike
    expect(r.container.textContent).toContain('299+');
    expect(place()).toContain(CAPPED_PLACE);
    // a snapshot rebuilds the window: its own count is the server's again
    snapshot.mockResolvedValue(snapOf(newer(299)));
    await act(async () => { await useStore.getState().requestFreshSnapshot(); });
    expect(r.container.textContent).not.toContain('299+');
    expect(place()).not.toContain(CAPPED_PLACE);
  });

  it('a delete from a window that is not full leaves its count exact (Codex 4337661439)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', [...newer(4), own]);
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    await act(async () => { await useStore.getState().deleteSitePhoto('own'); });
    await settled();
    expect(useStore.getState().photos.some((p) => p.id === 'own')).toBe(false);
    expect(useStore.getState().photosWindowShort).toBe(false);
    expect(r.container.textContent).not.toContain('4+');
  });

  it('a pull begun before the delete was answered cannot rebuild the window, so the count stays a floor (Codex 4337661439)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', [...newer(299), own]);
    let answerStale!: (v: unknown) => void;
    const snapshot = vi.fn().mockReturnValueOnce(new Promise((res) => { answerStale = res; })).mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot }) as never);
    useStore.getState().requestFreshSnapshot();
    await act(async () => { await useStore.getState().deleteSitePhoto('own'); });
    await act(async () => { answerStale(snapOf([...newer(299), own])); });
    await settled();
    expect(useStore.getState().photos.some((p) => p.id === 'own')).toBe(false);
    expect(r.container.textContent).toContain('299+');
  });

  it('a new upload keeps the window at 300 and moves it to the viewer\'s own list, where its Delete stays reachable', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', [...newer(299), own], { userName: 'Asha Shah' });
    useStore.getState()._setGateway(tracked({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at: new Date().toISOString() }), snapshot: vi.fn().mockReturnValue(new Promise(() => {})) }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    sync();
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await settled();
    expect(useStore.getState().photos.some((p) => p.id === 'new')).toBe(true);
    // the window is the newest 300, so every count of it stays true
    expect(useStore.getState().photos).toHaveLength(300);
    expect(useStore.getState().photos.some((p) => p.id === 'own')).toBe(false);
    expect(useStore.getState().myDeletablePhotos.map((p) => p.id)).toEqual(['own']);
    await settled();
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('a trim never moves a photo whose upload from this tab is still on its way', async () => {
    const sending: Photo = { id: 'sending', url: '/media/sending', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30), clientKey: 'k-sending' };
    const { r, useStore } = await load('en', [...newer(299), sending], { userName: 'Asha Shah', photoUploadsSending: ['k-sending'] });
    useStore.getState()._setGateway(tracked({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at: new Date().toISOString() }), snapshot: vi.fn().mockReturnValue(new Promise(() => {})) }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    sync();
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await settled();
    expect(useStore.getState().photos.some((p) => p.id === 'new')).toBe(true);
    expect(useStore.getState().photos).toHaveLength(300);
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
  });

  it('shows the snapshot\'s own photos past the window with their Delete, and a delete takes one off at once', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', newer(4), { myDeletablePhotos: [own] });
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: null });
    useStore.getState()._setGateway(tracked({ deleteMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }) as never);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await settled();
    expect(deleteMedia).toHaveBeenCalledWith('own');
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(4);
  });

  it('a pull begun while the delete was on its way never refills the list (stale pull)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { useStore } = await load('en', newer(4), { myDeletablePhotos: [own] });
    let answer!: (v: unknown) => void;
    let racing!: (snap: unknown) => void;
    const snapshot = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { racing = res; }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot }) as never);
    // snapshot held open on purpose: waited on by its own barrier
    heldOnPurpose('snapshot');
    const deleting = useStore.getState().deleteSitePhoto('own');
    useStore.getState().requestFreshSnapshot();
    await calledTimes('snapshot', 1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: true, dailyLogId: null }); await deleting; });
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    // the pull read before the delete committed lands now, carrying the photo in the viewer's own list
    await act(async () => { racing({ ...snapOf(newer(4)), myDeletablePhotos: [own] }); });
    await calledTimes('snapshot', 2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await settled();
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
  });

  it('a late upload answer never puts back a photo deleted from the list (late answer)', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', newer(4), { userName: 'Asha Shah' });
    let answerUpload!: (v: unknown) => void;
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { answerUpload = res; }));
    useStore.getState()._setGateway(tracked({ uploadMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }) }) as never);
    // uploadMedia held open on purpose: waited on by its own barrier
    heldOnPurpose('uploadMedia');
    sync();
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await calledTimes('uploadMedia');
    // listed in the viewer's own list without its key (nothing ties it to the upload), and deleted before the POST answers
    act(() => { useStore.setState({ myDeletablePhotos: [{ id: 'new', url: '/media/new', kind: 'progress', at, deletable: true, deletableUntil: until(0) }] } as never); });
    await useStore.getState().deleteSitePhoto('new');
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    await act(async () => { answerUpload({ id: 'new', url: 'http://api.test/media/new', at }); });
    await settled();
    expect(useStore.getState().photos.some((p) => p.id === 'new')).toBe(false);
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
  });

  it('a card shown only for its hour leaves when the hour is up, with nothing else changing (Codex 4322976255)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const window: Photo = { id: 'win', url: '/media/win', kind: 'progress', at: minutesAgo(59.5), deletable: true, deletableUntil: until(59.5) };
    const past: Photo = { id: 'past', url: '/media/past', kind: 'progress', at: minutesAgo(59), deletable: true, deletableUntil: until(59) };
    const { r } = await load('en', [...newer(4), window], { myDeletablePhotos: [past] });
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(6);
    // the first deadline: the window's card leaves, the other stays
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(4);
  });

  it('an extra card from the window leaves at its deadline, with no store change (Codex 4322976255)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const window: Photo = { id: 'win', url: '/media/win', kind: 'progress', at: minutesAgo(59.5), deletable: true, deletableUntil: until(59.5) };
    const { r } = await load('en', [...newer(4), window]);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(4);
  });

  it('the viewer\'s own photo past the window arrives with a server pull and shows with its Delete', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { r, useStore } = await load('en', newer(4));
    useStore.getState()._setGateway(tracked({ snapshot: vi.fn().mockResolvedValue({ ...snapOf(newer(4)), myDeletablePhotos: [own] }) }) as never);
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await act(async () => { await useStore.getState().requestFreshSnapshot(); });
    await settled();
    expect(useStore.getState().myDeletablePhotos.map((p) => p.id)).toEqual(['own']);
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(5);
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
  });

  it('a card whose deadline has already passed is not shown, and nothing waits on it', async () => {
    const gone: Photo = { id: 'gone', url: '/media/gone', kind: 'progress', at: minutesAgo(61), deletable: true, deletableUntil: until(61) };
    const { r } = await load('en', newer(4), { myDeletablePhotos: [gone] });
    expect(r.getAllByTestId('dash-photo-who')).toHaveLength(4);
  });

  it('is emptied by a project switch and by signing out', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const { useStore } = await load('en', [], { myDeletablePhotos: [own], photosWindowShort: true });
    useStore.getState()._setGateway(tracked({ switchProject: vi.fn().mockReturnValue(new Promise(() => {})) }) as never);
    act(() => { void useStore.getState().switchProject('villa-c'); });
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    // the short-window floor is the old project's too (Codex 4337661439)
    expect(useStore.getState().photosWindowShort).toBe(false);
    act(() => { useStore.setState({ myDeletablePhotos: [own], photosWindowShort: true } as never); useStore.getState().signOut(); });
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    expect(useStore.getState().photosWindowShort).toBe(false);
  });
});

describe('a photo whose upload from this tab is still on its way (#482, Codex 4322715807)', () => {
  it('offers no Delete until the upload is answered, and a deleted photo is never put back by a late answer', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    let answerUpload!: (v: unknown) => void;
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { answerUpload = res; }));
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: null });
    useStore.getState()._setGateway(tracked({ uploadMedia, snapshot, deleteMedia }) as never);
    // uploadMedia held open on purpose: waited on by its own barrier
    heldOnPurpose('uploadMedia');
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await calledTimes('uploadMedia');
    const clientKey = (uploadMedia.mock.calls[0]![0] as { clientKey: string }).clientKey;
    // the upload committed and a pull already lists it, with the viewer's key, while the POST's answer is on its way
    const landed: Photo = { id: 'new', url: '/media/new', kind: 'progress', at, deletable: true, deletableUntil: until(0), clientKey };
    act(() => { useStore.setState({ photos: [landed] }); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await useStore.getState().deleteSitePhoto('new');
    expect(deleteMedia).not.toHaveBeenCalled();
    // the answer comes: Delete is offered, and the delete goes
    await act(async () => { answerUpload({ id: 'new', url: 'http://api.test/media/new', at }); });
    await settled();
    expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1);
    await useStore.getState().deleteSitePhoto('new');
    expect(deleteMedia).toHaveBeenCalledWith('new');
    expect(useStore.getState().photos).toEqual([]);
  });

  it('a late upload answer never puts back a photo this tab has deleted', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    let answerUpload!: (v: unknown) => void;
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { answerUpload = res; }));
    useStore.getState()._setGateway(tracked({ uploadMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }) }) as never);
    // uploadMedia held open on purpose: waited on by its own barrier
    heldOnPurpose('uploadMedia');
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await calledTimes('uploadMedia');
    // listed without the viewer's key (as to a PMC), so nothing here ties it to the upload, and deleted before the POST answers
    act(() => { useStore.setState({ role: 'pmc', photos: [{ id: 'new', url: '/media/new', kind: 'progress', at, deletable: true }] } as never); });
    await useStore.getState().deleteSitePhoto('new');
    expect(useStore.getState().photos).toEqual([]);
    await act(async () => { answerUpload({ id: 'new', url: 'http://api.test/media/new', at }); });
    await settled();
    expect(useStore.getState().photos).toEqual([]);
  });
});

describe('sitePhotoDeletable', () => {
  it('holds until the time the server gave', () => {
    const deletableUntil = '2026-10-19T10:30:00.000Z';
    const t1 = Date.parse(deletableUntil);
    expect(sitePhotoDeletable({ deletable: true, deletableUntil }, t1 - 1)).toBe(true);
    expect(sitePhotoDeletable({ deletable: true, deletableUntil }, t1)).toBe(false);
    expect(sitePhotoDeletable({}, t1 - 1)).toBe(false);
    // a deadline alone is not a yes: the server's `deletable` is (Codex 4320912804)
    expect(sitePhotoDeletable({ deletableUntil }, t1 - 1)).toBe(false);
  });

  it('has no end where the server gave none (the PMC and the engineer)', () => {
    expect(sitePhotoDeletable({ deletable: true }, Date.parse('2099-01-01T00:00:00Z'))).toBe(true);
  });
});
