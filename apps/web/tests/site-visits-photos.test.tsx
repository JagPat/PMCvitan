import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { moveSiteVisitOps, type ApiGateway, type OutboxOp, type SiteVisit } from '@/data/apiGateway';
import { shrinkPhoto, PHOTO_MAX_EDGE } from '@/lib/shrinkPhoto';
import { refreshSiteVisits, LINK_REFRESH_MS } from '@/lib/useSiteVisits';
import { getVisitPhoto } from '@/data/visitPhotoStore';
import { leftoverEnglish } from './leftover-english';

/**
 * Site Visits SV2 (#792): photos on a visit. Every member reads them; the visitor and anyone recorded as present add
 * them while the visit is not closed (Jagrut, 19 Oct 2026). A photo is queued on the phone with its own key, so one
 * taken without signal is kept and sent once, and a refusal says so in the server's words.
 */

const PMC = 'u-pmc';
const CONSULTANT = 'u-cons';

const NODES: ProjectNode[] = [
  { id: 'n-gf', parentId: null, name: 'Ground floor', kind: 'zone', order: 0 },
  { id: 'n-kit', parentId: 'n-gf', name: 'Kitchen', kind: 'room', order: 0 },
];
const MEMBERS = [
  { userId: PMC, name: 'Priya Shah', role: 'pmc', email: null, phone: null, status: 'active' },
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
  { userId: 'u-eng', name: 'Ramesh Patel', role: 'engineer', email: null, phone: null, status: 'active' },
] as ProjectMember[];

function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [],
    ...over,
  };
}

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };

function fakeGateway(list: SiteVisit[], over: Fake = {}): Fake {
  return {
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? list.filter((v) => v.status === 'open') : list)),
    ...over,
  };
}

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en') {
  useStore.setState({ ...getInitialState(), outbox: [], role, lang, sessionUserId: me, nodes: NODES, members: MEMBERS, loadTeam: async () => true });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
  const view = render(<SiteVisitsScreen />);
  await act(async () => {});
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
});

describe('Site Visits SV2: photos on a visit (#792)', () => {
  const ENG = 'u-eng';
  const file = (over: Partial<NonNullable<SiteVisit['files']>[number]> = {}) => ({
    mediaId: 'm-1', url: '/media/m-1?sig=x', mime: 'image/jpeg', takenAt: '14 Oct 2026 · 10:05 AM', note: 'Crack near the sill',
    rating: 'concern' as const, place: { nodeId: 'n-kit', name: 'Kitchen' }, addedById: CONSULTANT, addedByName: 'Kiran Rao',
    addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z', ...over,
  });
  const walked = [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null }];
  const present = (over: Partial<SiteVisit['attendees'][number]> = {}) => ({
    id: 'a-1', kind: 'member' as const, userId: ENG, role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null, ...over,
  });
  const photo = () => new File([new Uint8Array([1, 2, 3])], 'site.png', { type: 'image/png' });
  async function pick(visitId: string, f: File = photo()) {
    await act(async () => { fireEvent.change(screen.getByTestId(`sv-photo-file-${visitId}`), { target: { files: [f] } }); });
    // the file is read, and its bytes kept on the phone, before it is queued (and sent, with signal): callers wait for
    // the outcome they expect
  }
  const queuedFile = () => useStore.getState().outbox.find((o) => o.t === 'siteVisitAddFile') as Extract<OutboxOp, { t: 'siteVisitAddFile' }>;

  it('lists a visit’s photos with the note, rating, place, who added them and when, for every member', async () => {
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', places: walked, files: [file()] })]));
    const row = screen.getByTestId('sv-file-m-1');
    expect(row.textContent).toContain('Concern');
    expect(row.textContent).toContain('Crack near the sill');
    expect(row.textContent).toContain('Kitchen');
    expect(row.textContent).toContain('Added by Kiran Rao · ');
    expect(row.textContent).toContain('taken 14 Oct 2026 · 10:05 AM');
    expect(row.querySelector('img')!.getAttribute('src')).toContain('/media/m-1?sig=x');
    // the client is not on the visit: nothing to add
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers Add photo to the visitor and anyone present, while the visit is not closed', async () => {
    const offered = async (role: Role, me: string, v: SiteVisit) => {
      await mount(role, me, fakeGateway([v]));
      const has = within(screen.getByTestId(`sv-visit-${v.id}`)).queryByRole('button', { name: 'Add photo' }) !== null;
      cleanup();
      return has;
    };
    expect(await offered('consultant', CONSULTANT, visit())).toBe(true);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'ended' }))).toBe(true);
    expect(await offered('engineer', ENG, visit({ attendees: [present()] }))).toBe(true);
    expect(await offered('engineer', ENG, visit({ attendees: [present({ retiredAt: '2026-10-14T04:46:00.000Z' })] }))).toBe(false);
    expect(await offered('engineer', ENG, visit())).toBe(false);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'closed', closeReason: 'Left open' }))).toBe(false);
  });

  it('sends a picked photo as a visit file with its note, rating and place, then reads the visit again', async () => {
    const stored = file({ mediaId: 'm-9', addedById: ENG, addedByName: 'Ramesh Patel', addedByRole: 'engineer', note: 'Wiring done', rating: 'fine' });
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const gw = fakeGateway([visit({ places: walked, attendees: [present()] })], { uploadMedia });
    await mount('engineer', ENG, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: '  Wiring done ' } });
    fireEvent.change(within(card).getByLabelText('How is it? (optional)'), { target: { value: 'fine' } });
    fireEvent.change(within(card).getByLabelText('Place (optional)'), { target: { value: 'n-kit' } });
    gw.listSiteVisits!.mockImplementation(async () => [visit({ places: walked, attendees: [present()], files: [stored] })]);
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const [input] = uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      kind: 'visit', mime: 'image/png', data: 'AQID', nodeId: 'n-kit',
      siteVisit: { visitId: 'v-1', note: 'Wiring done', rating: 'fine' },
    });
    expect(typeof input.clientKey).toBe('string');
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-9').textContent).toContain('Wiring done'));
    expect(useStore.getState().outbox).toHaveLength(0);
    // the form is clear for the next photo
    expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('');
  });

  it('keeps a photo taken without signal on the phone, shows it waiting, and sends the same file again', async () => {
    const uploadMedia = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ id: 'm-2', url: '/media/m-2' });
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitAddFile']);
    const kept = queuedFile();
    // the bytes wait in the phone's database, not in the queue localStorage holds (Codex 4318755268)
    expect(kept.file).not.toHaveProperty('data');
    expect(JSON.stringify(localStorage)).not.toContain('AQID');
    expect((await getVisitPhoto(kept.scope, useStore.getState().activeProjectId, kept.file.id))?.data).toBe('AQID');
    const row = screen.getByTestId(`sv-file-${kept.file.id}`);
    expect(row.textContent).toContain('waiting to send');
    expect(row.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AQID');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    const [[first], [again]] = uploadMedia.mock.calls as unknown as [[{ clientKey: string }], [{ clientKey: string }]];
    // the same file under the same key: the server stores it once
    expect(again).toEqual(first);
    expect(first).toMatchObject({ data: 'AQID', clientKey: kept.file.id });
    expect(useStore.getState().outbox).toHaveLength(0);
    // sent: the phone's copy goes
    expect(await getVisitPhoto(kept.scope, useStore.getState().activeProjectId, kept.file.id)).toBeNull();
  });

  it('shows a photo once when a read already holds it before its answer comes (Codex 4318755283)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(new Error('network'));
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount('consultant', CONSULTANT, gw);
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const key = queuedFile().file.id;
    // the upload had committed and only its answer was lost: the next read holds the stored file under the same key
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [file({ mediaId: 'm-7', clientKey: key, note: null, rating: null, place: null })] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-7')).toBeTruthy());
    expect(screen.queryAllByTestId(/^sv-file-/)).toHaveLength(1);
    // the retry is answered (the server holds it under that key) and the queue empties
    uploadMedia.mockResolvedValue({ id: 'm-7', url: '/media/m-7' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
  });

  it('says so, and queues nothing, when the phone cannot keep the photo', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo could not be saved on this phone. Try again with signal.'));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(uploadMedia).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refuses before queueing an image type the upload does not take and the phone cannot redraw (Codex 4318755312)', async () => {
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await pick('v-1', new File(['<svg/>'], 'plan.svg', { type: 'image/svg+xml' }));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo could not be read. Try another.'));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('does not send a place that was removed from the visit after it was chosen (Codex 4318755297)', async () => {
    const uploadMedia = vi.fn(async () => ({ id: 'm-3', url: '/media/m-3' }));
    const gw = fakeGateway([visit({ places: walked })], { uploadMedia });
    await mount('consultant', CONSULTANT, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Place (optional)'), { target: { value: 'n-kit' } });
    gw.listSiteVisits!.mockImplementation(async () => [visit({ places: [{ ...walked[0], retiredAt: '2026-10-14T04:50:00.000Z' }] })]);
    await act(async () => { refreshSiteVisits(); });
    await vi.waitFor(() => expect(within(card).queryByLabelText('Place (optional)')).toBeNull());
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(uploadMedia.mock.calls[0]).not.toHaveProperty('0.nodeId');
  });

  it('shows a capture time of any length bounded (Codex 4318755335)', async () => {
    await mount('client', 'u-client', fakeGateway([visit({ files: [file({ takenAt: 'x'.repeat(100_000) })] })]));
    expect(screen.getByTestId('sv-file-m-1').textContent!.length).toBeLessThan(400);
  });

  it('reads the visits again before the photos’ signed links expire (Codex 4318755326)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const gw = fakeGateway([visit({ files: [file()] })]);
    await mount('client', 'u-client', gw);
    const before = gw.listSiteVisits!.mock.calls.length;
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [file({ url: '/media/m-1?sig=fresh' })] })]);
    await act(async () => { vi.advanceTimersByTime(LINK_REFRESH_MS); });
    vi.useRealTimers();
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1').querySelector('img')!.getAttribute('src')).toContain('sig=fresh'));
    expect(gw.listSiteVisits!.mock.calls.length).toBeGreaterThan(before);
  });

  it('says so when a closed visit refuses the photo, and takes it off the screen', async () => {
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'This site visit was closed by the PMC and takes no more files' });
    await mount('consultant', CONSULTANT, fakeGateway([visit({ status: 'ended' })], { uploadMedia: vi.fn().mockRejectedValue(refused) }));
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This was not saved. This site visit was closed by the PMC and takes no more files'));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.queryAllByTestId(/^sv-file-/)).toHaveLength(0);
  });

  it('lets go of the phone’s copy of a photo the server refused for good', async () => {
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'This site visit was closed by the PMC and takes no more files' });
    const uploadMedia = vi.fn().mockImplementation(async () => { throw refused; });
    await mount('consultant', CONSULTANT, fakeGateway([visit({ status: 'ended' })], { uploadMedia }));
    // queued while the phone is offline, so its key can be read before it is sent
    useStore.setState({ online: false });
    await pick('v-1');
    await vi.waitFor(() => expect(queuedFile()).toBeTruthy());
    const kept = queuedFile();
    useStore.setState({ online: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    expect(await getVisitPhoto(kept.scope, useStore.getState().activeProjectId, kept.file.id)).toBeNull();
  });

  it('moves a photo queued on a start refused for an open visit onto that visit', () => {
    const op: OutboxOp = {
      t: 'siteVisitAddFile', visitId: 'v-tmp', scope: 'u-pmc', idempotencyKey: 'k-f', by: { name: 'Priya Shah', role: 'pmc' }, placeName: null,
      file: { id: 'c-1', mime: 'image/png' },
    };
    expect(moveSiteVisitOps([op], 'v-tmp', 'v-open')).toEqual([{ ...op, visitId: 'v-open' }]);
  });

  it.each(['hi', 'gu'] as Lang[])('shows no English in %s on a visit with a photo and the photo controls', async (lang) => {
    const v = visit({ places: walked, files: [file()] });
    const { container } = await mount('consultant', CONSULTANT, fakeGateway([v]), lang);
    expect(leftoverEnglish(container, ['Kiran Rao', 'Ramesh Patel', 'Priya Shah', 'Kitchen', 'Ground floor', 'PMC', 'Crack near the sill', '14 Oct 2026 · 10:05 AM'])).toEqual([]);
  });
});

describe('shrinkPhoto (SV2: a photo small enough to wait on the phone)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const big = `data:image/jpeg;base64,${'A'.repeat(2_000_000)}`;

  it('redraws a large photo with its longest side at the edge, as a JPEG', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4096, height: 3072, close })));
    const drawn: { w?: number; h?: number } = {};
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return real(tag);
      const c = real('canvas') as HTMLCanvasElement;
      c.getContext = (() => ({ drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => { drawn.w = w; drawn.h = h; } })) as unknown as HTMLCanvasElement['getContext'];
      c.toDataURL = () => 'data:image/jpeg;base64,AQID';
      return c;
    }) as typeof document.createElement);
    expect(await shrinkPhoto(big)).toBe('data:image/jpeg;base64,AQID');
    expect(drawn).toEqual({ w: PHOTO_MAX_EDGE, h: 1536 });
    expect(close).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('sends the photo as it was when the browser cannot redraw it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('HEIC'); }));
    expect(await shrinkPhoto(big)).toBe(big);
    vi.stubGlobal('createImageBitmap', undefined);
    expect(await shrinkPhoto(big)).toBe(big);
  });

  it('leaves a small photo as it is', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
    const small = 'data:image/png;base64,AQID';
    expect(await shrinkPhoto(small)).toBe(small);
  });
});
