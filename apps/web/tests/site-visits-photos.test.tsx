import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import type { ApiGateway, OutboxOp, SiteVisit } from '@/data/apiGateway';
import { shrinkPhoto, MAX_PHOTO_BASE64, PHOTO_MAX_EDGE } from '@/lib/shrinkPhoto';
import { refreshSiteVisits, linkRefreshDelay, LINK_REFRESH_FLOOR_MS } from '@/lib/useSiteVisits';
import { leftoverEnglish } from './leftover-english';

/**
 * Site Visits SV2 (#792): photos on a visit. Every member reads them; the visitor and anyone recorded as present add
 * them while the visit is not closed (Jagrut, 19 Oct 2026). A photo is sent straight to the server: one the server
 * would refuse for its type or size is refused before it is sent, no signal is said plainly, and a refusal says so in
 * the server's words. Keeping a photo on the phone to send later is #992's Unit B.
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

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en', outbox: OutboxOp[] = []) {
  useStore.setState({ ...getInitialState(), outbox, role, lang, sessionUserId: me, nodes: NODES, members: MEMBERS, loadTeam: async () => true });
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
    // the file is read and shrunk before it is sent: callers wait for the outcome they expect
  }

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

  it('offers no Add photo on a visit started without signal until its start is sent', async () => {
    const start: OutboxOp = {
      t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' },
      visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
    };
    await mount('consultant', CONSULTANT, fakeGateway([], { startSiteVisit: vi.fn().mockRejectedValue(new Error('network')) }), 'en', [start]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-visit-v-tmp')).toBeTruthy());
    expect(within(screen.getByTestId('sv-visit-v-tmp')).queryByRole('button', { name: 'Add photo' })).toBeNull();
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
    // sent, not queued: nothing waits on the phone
    expect(useStore.getState().outbox).toHaveLength(0);
    // the form is clear for the next photo
    expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('');
  });

  it('sends a photo with no answer again under the same key, by Send again or by picking it again (Codex 4319347033)', async () => {
    const uploadMedia = vi.fn().mockRejectedValue(new Error('network'));
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount('consultant', CONSULTANT, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: 'Crack' } });
    const picked = photo();
    await pick('v-1', picked);
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo may not have been sent: there is no signal. Tap Send again when you have signal.'));
    expect(useStore.getState().outbox).toHaveLength(0);
    // the photo is held as it was sent: its note stays, locked, with Send again and Don't send in place of Add photo
    const note = within(card).getByLabelText('Note (optional)') as HTMLInputElement;
    expect([note.value, note.disabled]).toEqual(['Crack', true]);
    expect(within(card).queryByRole('button', { name: 'Add photo' })).toBeNull();
    // dropped: the server may still have stored it, so picking the same file again sends it under the same key
    fireEvent.click(within(card).getByRole('button', { name: 'Don’t send' }));
    expect(note.disabled).toBe(false);
    await pick('v-1', picked);
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    const keys = () => (uploadMedia.mock.calls as unknown as [{ clientKey: string }][]).map(([i]) => i.clientKey);
    expect(keys()[1]).toBe(keys()[0]);
    // and so does Send again, which then clears the form
    uploadMedia.mockResolvedValue({ id: 'm-8', url: '/media/m-8' });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Send again' })); });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(3));
    expect(keys()[2]).toBe(keys()[0]);
    expect(uploadMedia.mock.calls[2]).toMatchObject([{ siteVisit: { visitId: 'v-1', note: 'Crack' } }]);
    await vi.waitFor(() => expect(within(card).queryByRole('button', { name: 'Send again' })).toBeNull());
    expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('');
    // a different photo is a new one, under a new key
    const first = keys()[0];
    uploadMedia.mockClear();
    await pick('v-1', new File([new Uint8Array([4, 5, 6])], 'other.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(keys()[0]).not.toBe(first);
  });

  it('says an ended sign-in or a busy server as such, not as no signal (Codex 4319347063)', async () => {
    const said = async (status: number) => {
      const uploadMedia = vi.fn().mockRejectedValue(Object.assign(new Error(String(status)), { status }));
      await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
      await pick('v-1');
      await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalled());
      await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      const text = screen.getByRole('alert').textContent;
      // either can clear, so the photo can still be sent again under its key
      expect(within(screen.getByTestId('sv-visit-v-1')).getByRole('button', { name: 'Send again' })).toBeTruthy();
      cleanup();
      return text;
    };
    expect(await said(401)).toBe('This photo was not sent: your sign-in has ended. Sign in again, then tap Send again.');
    expect(await said(429)).toBe('This photo was not sent: the server is busy. Wait a moment, then tap Send again.');
  });

  it('locks the photo’s note, rating and place while it is sent, so nothing typed meanwhile is cleared (Codex 4319347044)', async () => {
    let answer!: (v: { id: string; url: string }) => void;
    const uploadMedia = vi.fn(() => new Promise<{ id: string; url: string }>((r) => { answer = r; }));
    await mount('consultant', CONSULTANT, fakeGateway([visit({ places: walked })], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await pick('v-1');
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    for (const label of ['Note (optional)', 'How is it? (optional)', 'Place (optional)']) {
      expect((within(card).getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    }
    await act(async () => { answer({ id: 'm-1', url: '/media/m-1' }); });
    await vi.waitFor(() => expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).disabled).toBe(false));
  });

  it('offers Add photo on a visit whose end is waiting to send, but not on one whose start is (Codex 4319347058)', async () => {
    const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' };
    const start: OutboxOp = {
      t: 'siteVisitStart', idempotencyKey: 'k-s', body: { id: 'v-tmp', claimedAt: '2026-10-14T06:30:00.000Z' },
      visitor: { name: 'Kiran Rao', role: 'consultant', placeName: null },
    };
    const offline = vi.fn().mockRejectedValue(new Error('network'));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { endSiteVisit: offline, startSiteVisit: offline }), 'en', [end, start]);
    await vi.waitFor(() => expect(screen.getByTestId('sv-visit-v-tmp')).toBeTruthy());
    expect(within(screen.getByTestId('sv-visit-v-1')).getByRole('button', { name: 'Add photo' })).toBeTruthy();
    expect(within(screen.getByTestId('sv-visit-v-tmp')).queryByRole('button', { name: 'Add photo' })).toBeNull();
  });

  it('refuses before sending a photo larger than the upload takes, when the phone cannot shrink it (Codex 4319124623)', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    // 3 bytes per 4 base64 characters: one byte over makes the photo's base64 longer than the limit
    const bytes = (MAX_PHOTO_BASE64 / 4) * 3 + 1;
    await pick('v-1', new File([new Uint8Array(bytes)], 'huge.jpg', { type: 'image/jpeg' }));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This photo is too large to send. Try a smaller one.'));
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses before sending an image type the upload does not take and the phone cannot redraw (Codex 4318755312)', async () => {
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

  it('reads the visits again before the photos’ signed links expire, whatever their lifetime (Codex 4318755326, 4319347052)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // a server whose links last a minute (FILE_URL_TTL_SEC=60)
    const exp = () => Math.floor(Date.now() / 1000) + 60;
    const gw = fakeGateway([visit({ files: [file({ url: `/media/m-1?t=${exp()}.sig` })] })]);
    await mount('client', 'u-client', gw);
    const before = gw.listSiteVisits!.mock.calls.length;
    gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [file({ url: `/media/m-1?t=${exp()}.fresh` })] })]);
    await act(async () => { vi.advanceTimersByTime(31_000); });
    vi.useRealTimers();
    await vi.waitFor(() => expect(screen.getByTestId('sv-file-m-1').querySelector('img')!.getAttribute('src')).toContain('.fresh'));
    expect(gw.listSiteVisits!.mock.calls.length).toBeGreaterThan(before);
  });

  it('times the link refresh from the soonest expiry shown, never sooner than the floor', () => {
    const at = (url: string) => visit({ files: [file({ url })] });
    const now = 1_000_000_000_000;
    const sec = now / 1000;
    expect(linkRefreshDelay([at(`/media/a?t=${sec + 3600}.s`), at(`/media/b?t=${sec + 600}.s`)], now)).toBe(300_000);
    expect(linkRefreshDelay([at(`/media/a?t=${sec + 2}.s`)], now)).toBe(LINK_REFRESH_FLOOR_MS);
    expect(linkRefreshDelay([visit()], now)).toBeNull();
  });

  it('says so when a closed visit refuses the photo, and takes it off the screen', async () => {
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'This site visit was closed by the PMC and takes no more files' });
    await mount('consultant', CONSULTANT, fakeGateway([visit({ status: 'ended' })], { uploadMedia: vi.fn().mockRejectedValue(refused) }));
    await pick('v-1');
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This was not saved. This site visit was closed by the PMC and takes no more files'));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.queryAllByTestId(/^sv-file-/)).toHaveLength(0);
  });

  it.each(['hi', 'gu'] as Lang[])('shows no English in %s on a visit with a photo and the photo controls', async (lang) => {
    const v = visit({ places: walked, files: [file()] });
    const { container } = await mount('consultant', CONSULTANT, fakeGateway([v]), lang);
    expect(leftoverEnglish(container, ['Kiran Rao', 'Ramesh Patel', 'Priya Shah', 'Kitchen', 'Ground floor', 'PMC', 'Crack near the sill', '14 Oct 2026 · 10:05 AM'])).toEqual([]);
  });
});

describe('shrinkPhoto (SV2: a photo made small before it is sent)', () => {
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
