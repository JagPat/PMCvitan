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
    const { r, useStore } = await load('en', [{ id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) }]);
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true });
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway({ deleteMedia, snapshot } as never);
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await waitFor(() => expect(useStore.getState().photos).toEqual([]));
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
    useStore.getState()._setGateway({ deleteMedia } as never);
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
    await act(async () => { answer(snapOf([{ id: 'new', url: '/media/new', kind: 'progress', at, deletable: true, deletableUntil: until(0) }])); });
    await waitFor(() => expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1));
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
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot } as never);
    const deleting = useStore.getState().deleteSitePhoto('own');
    useStore.getState().requestFreshSnapshot();
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
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
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: 'log-0' }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    await useStore.getState().deleteSitePhoto('own');
    expect(useStore.getState().dailyLogPhotoCountAfter).toBeNull();
    expect(useStore.getState().dailyLog?.photoCount).toBe(3);
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
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
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

describe('a confirmed delete stays done (#482 redesign after #987)', () => {
  it('a snapshot asked for before the delete never brings the photo back, even when the pull after it fails (Codex 4318519722)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5) };
    const { r, useStore } = await load('en', [own]);
    let oldAnswer!: (snap: unknown) => void;
    const snapshot = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { oldAnswer = res; }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }), snapshot } as never);
    // a pull already on its way when the member deletes
    useStore.getState().requestFreshSnapshot();
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(r.getByTestId('site-photo-delete'));
    fireEvent.click(r.getByTestId('site-photo-delete-yes'));
    await waitFor(() => expect(useStore.getState().photos).toEqual([]));
    // the old pull lands, carrying the photo as it was before the delete
    await act(async () => { oldAnswer(snapOf([own])); });
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    expect(useStore.getState().photos).toEqual([]);
  });

  it('no Delete while the photo\'s upload is still queued here, and the store refuses one; it comes once the upload has gone (Codex 4322142028, 4318519735)', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(5), deletable: true, deletableUntil: until(5), clientKey: 'k-own' };
    const queued = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', clientKey: 'k-own' } };
    const other = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'BBBB', clientKey: 'k-other' } };
    const { r, useStore } = await load('en', [own], { outbox: [queued, other] });
    const deleteMedia = vi.fn().mockResolvedValue({ ok: true, dailyLogId: null });
    useStore.getState()._setGateway({ deleteMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
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
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot } as never);
    const deleting = useStore.getState().deleteSitePhoto('own');
    // a socket ping asks for a pull after the DELETE went out, and the server reads it before the delete commits
    useStore.getState().requestFreshSnapshot();
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    await act(async () => { answer({ ok: true, dailyLogId: null }); await deleting; });
    expect(useStore.getState().photos).toEqual([]);
    // that pull lands after the delete was confirmed, carrying the photo and its evidence as they were
    await act(async () => { racing({ ...snapOf([own]), checklist, openChecklists: [checklist] }); });
    await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
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
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockReturnValue(new Promise((res) => { answer = res; })), snapshot } as never);
    const deleting = useStore.getState().deleteSitePhoto('own');
    // the member switches project while the DELETE is on its way; the other project lists a photo of the same id
    const other: Photo = { ...own, url: '/media/own?other' };
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, photos: [other] } as never);
    await act(async () => { answer({ ok: true, dailyLogId: null }); await deleting; });
    expect(useStore.getState().photos).toEqual([other]);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('the viewer\'s photo in their hour beyond the newest 300 (#482, Codex 4322459282)', () => {
  it('a new upload keeps it, and its Delete stays reachable', async () => {
    const own: Photo = { id: 'own', url: '/media/own', kind: 'progress', at: minutesAgo(30), deletable: true, deletableUntil: until(30) };
    const newer = Array.from({ length: 299 }, (_, n): Photo => ({ id: `n${n}`, url: `/media/n${n}`, kind: 'progress', at: minutesAgo(1), by: 'Ravi Patel' }));
    const { r, useStore } = await load('en', [...newer, own], { userName: 'Asha Shah' });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockResolvedValue({ id: 'new', url: 'http://api.test/new.jpg', at: new Date().toISOString() }), snapshot: vi.fn().mockReturnValue(new Promise(() => {})) } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(useStore.getState().photos.some((p) => p.id === 'new')).toBe(true));
    expect(useStore.getState().photos.some((p) => p.id === 'own')).toBe(true);
    // the window stays the newest 300, with the viewer's own photo kept past it
    expect(useStore.getState().photos).toHaveLength(301);
    await waitFor(() => expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1));
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
    useStore.getState()._setGateway({ uploadMedia, snapshot, deleteMedia } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(uploadMedia).toHaveBeenCalled());
    const clientKey = (uploadMedia.mock.calls[0]![0] as { clientKey: string }).clientKey;
    // the upload committed and a pull already lists it, with the viewer's key, while the POST's answer is on its way
    const landed: Photo = { id: 'new', url: '/media/new', kind: 'progress', at, deletable: true, deletableUntil: until(0), clientKey };
    act(() => { useStore.setState({ photos: [landed] }); });
    expect(r.queryByTestId('site-photo-delete')).toBeNull();
    await useStore.getState().deleteSitePhoto('new');
    expect(deleteMedia).not.toHaveBeenCalled();
    // the answer comes: Delete is offered, and the delete goes
    await act(async () => { answerUpload({ id: 'new', url: 'http://api.test/media/new', at }); });
    await waitFor(() => expect(r.getAllByTestId('site-photo-delete')).toHaveLength(1));
    await useStore.getState().deleteSitePhoto('new');
    expect(deleteMedia).toHaveBeenCalledWith('new');
    expect(useStore.getState().photos).toEqual([]);
  });

  it('a late upload answer never puts back a photo this tab has deleted', async () => {
    const at = new Date().toISOString();
    const { r, useStore } = await load('en', [], { userName: 'Asha Shah' });
    let answerUpload!: (v: unknown) => void;
    const uploadMedia = vi.fn().mockReturnValue(new Promise((res) => { answerUpload = res; }));
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), deleteMedia: vi.fn().mockResolvedValue({ ok: true, dailyLogId: null }) } as never);
    class SyncFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload?.(); }
    }
    vi.stubGlobal('FileReader', SyncFileReader);
    fireEvent.change(r.getByTestId('add-site-photo-file'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(uploadMedia).toHaveBeenCalled());
    // listed without the viewer's key (as to a PMC), so nothing here ties it to the upload, and deleted before the POST answers
    act(() => { useStore.setState({ role: 'pmc', photos: [{ id: 'new', url: '/media/new', kind: 'progress', at, deletable: true }] } as never); });
    await useStore.getState().deleteSitePhoto('new');
    expect(useStore.getState().photos).toEqual([]);
    await act(async () => { answerUpload({ id: 'new', url: 'http://api.test/media/new', at }); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
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
