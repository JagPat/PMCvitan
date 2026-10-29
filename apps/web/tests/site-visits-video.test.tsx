import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { MediaPlayer } from '@/components/MediaPlayer';
import type { ApiGateway, OutboxOp, SiteVisit } from '@/data/apiGateway';
import { POSTER_WAIT_MS, fileVisitPhoto, getVisitPhoto, listVisitPhotos, putVisitPhoto, visitPhotoScope, type SiteVisitAddFileOp } from '@/data/visitPhotoStore';
import { tellSiteVisits } from '@/data/apiGateway';
import { flushesEnded, settled, startWork, tracked } from './site-visit-work';

// #995 V2b-2: drawing a clip's still frame needs a browser that decodes video (jsdom has none); `video-poster.test.ts`
// tests the drawing itself. Here each recording is given the frame the test says, none by default
const still = vi.hoisted(() => ({ frame: null as string | null }));
vi.mock('@/lib/videoPoster', () => ({ drawPoster: vi.fn(async () => still.frame) }));

/**
 * #995 V2b, video clips on a visit: the visitor and anyone present record a clip of up to a minute in the app, with the
 * same optional note, rating and place as a photo; it is kept and sent the way a voice note is, and every member plays
 * it from the visit card. Recording is offered only where the browser's recorder writes a type the upload takes (WebM
 * with VP8 or VP9 first, then MP4 with H.264). The clip's length is never sent: the server reads it from the file.
 */

const CONSULTANT = 'u-cons';
const ENG = 'u-eng';
const NODES: ProjectNode[] = [
  { id: 'n-gf', parentId: null, name: 'Ground floor', kind: 'zone', order: 0 },
  { id: 'n-kit', parentId: 'n-gf', name: 'Kitchen', kind: 'room', order: 0 },
];
const MEMBERS = [
  { userId: 'u-pmc', name: 'Priya Shah', role: 'pmc', email: null, phone: null, status: 'active' },
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
  { userId: ENG, name: 'Ramesh Patel', role: 'engineer', email: null, phone: null, status: 'active' },
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
const walked = [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null }];
const present = { id: 'a-1', kind: 'member' as const, userId: ENG, role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null };
const clipFile = (over: Partial<NonNullable<SiteVisit['files']>[number]> = {}) => ({
  mediaId: 'm-c', url: '/media/m-c?sig=x', mime: 'video/webm', takenAt: null, durationSec: 12, note: 'Crack by the column',
  rating: 'concern' as const, place: null, addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant',
  addedAt: '2026-10-14T04:50:00.000Z', ...over,
});

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };
const fakeGateway = (list: SiteVisit[], over: Fake = {}): Fake => ({
  listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? list.filter((v) => v.status === 'open') : list)),
  ...over,
});

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en', outbox: OutboxOp[] = [], strict = false) {
  useStore.setState({ ...getInitialState(), outbox, role, lang, sessionUserId: me, nodes: NODES, members: MEMBERS, loadTeam: async () => true });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(tracked(gw) as unknown as ApiGateway);
  // the app itself runs under StrictMode (main.tsx), which mounts, unmounts and mounts again
  const view = render(strict ? <StrictMode><SiteVisitsScreen /></StrictMode> : <SiteVisitsScreen />);
  await act(async () => {});
  return view;
}

// a recorder that writes what the test says it supports (WebM with VP8 and Opus, as Android browsers do, by default);
// the running time is the test's own clock
let now = 0;
let writes: string | null = null;
let supported = new Set(['video/webm;codecs=vp8,opus', 'video/webm', 'audio/webm;codecs=opus', 'audio/webm']);
/** the bytes a recording holds */
let bytes = new Uint8Array([1, 2, 3]);
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
/** a camera's stream as the recorder sees it: its tracks, the camera's among them */
const camera = () => ({ getTracks: () => tracks, getVideoTracks: () => tracks });
const getUserMedia = vi.fn(async (_media?: MediaStreamConstraints) => camera());
class FakeRecorder {
  static isTypeSupported(t: string) { return supported.has(t); }
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly options: Record<string, unknown>;
  constructor(_stream: unknown, options: { mimeType: string }) { this.options = options; this.mimeType = writes ?? options.mimeType; FakeRecorder.last = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const withRecorder = () => {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
};

beforeEach(() => {
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  onTestFinished(startWork(useStore));
  now = 0;
  writes = null;
  supported = new Set(['video/webm;codecs=vp8,opus', 'video/webm', 'audio/webm;codecs=opus', 'audio/webm']);
  bytes = new Uint8Array([1, 2, 3]);
  FakeRecorder.last = null;
  still.frame = null;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  tracks = [{ stop: vi.fn() }];
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => camera());
  // the camera shows its first picture as soon as it is watched (the recorder waits for it: 29 Oct)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(cb: () => void) { queueMicrotask(cb); return 1; },
  });
});
afterEach(async () => {
  await flushesEnded();
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

const NAMES = { record: 'Record video', stop: 'Stop and add' };
async function record(card: HTMLElement, ms: number, names = NAMES) {
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: names.record })); });
  now += ms;
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: names.stop })); });
}
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });

describe('#995 V2b: video clips on a visit', () => {
  it('offers a video to the visitor and anyone present while the visit is not closed, only where the browser records one the server reads', async () => {
    const offered = async (role: Role, me: string, v: SiteVisit) => {
      await mount(role, me, fakeGateway([v]));
      const has = within(screen.getByTestId('sv-visit-v-1')).queryByRole('button', { name: 'Record video' }) !== null;
      cleanup();
      return has;
    };
    // no recorder in this browser: nothing is offered that would fail
    expect(await offered('consultant', CONSULTANT, visit())).toBe(false);
    withRecorder();
    expect(await offered('consultant', CONSULTANT, visit())).toBe(true);
    expect(await offered('engineer', ENG, visit({ attendees: [present] }))).toBe(true);
    expect(await offered('engineer', ENG, visit())).toBe(false);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'closed', closeReason: 'Left open' }))).toBe(false);
    // a recorder that writes video only as H.264 in Matroska (or none at all) is not offered one; voice still is
    supported = new Set(['video/webm;codecs=h264', 'audio/webm']);
    await mount('consultant', CONSULTANT, fakeGateway([visit()]));
    const card = screen.getByTestId('sv-visit-v-1');
    expect(within(card).queryByRole('button', { name: 'Record video' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Record voice note' })).toBeTruthy();
  });

  it('records from the camera and microphone at a minute’s bit rates, showing what the camera sees, and sends the clip as a visit file with no length', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const gw = fakeGateway([visit({ places: walked, attendees: [present] })], { uploadMedia });
    await mount('engineer', ENG, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: ' Crack by the column ' } });
    fireEvent.change(within(card).getByLabelText('How is it? (optional)'), { target: { value: 'concern' } });
    fireEvent.change(within(card).getByLabelText('Place (optional)'), { target: { value: 'n-kit' } });
    gw.listSiteVisits!.mockImplementation(async () => [visit({ places: walked, attendees: [present], files: [clipFile({ mediaId: 'm-9', addedById: ENG })] })]);
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record video' })); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ audio: true, video: { facingMode: { ideal: 'environment' } } });
    expect(FakeRecorder.last!.options).toMatchObject({ mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
    const running = within(card).getByTestId('sv-recording-video-v-1');
    expect(running.textContent).toContain('Recording 0:00 of 1:00');
    const preview = running.querySelector('video')!;
    expect(preview.muted).toBe(true);
    expect((preview as HTMLVideoElement & { srcObject: unknown }).srcObject).toMatchObject({ getTracks: expect.any(Function) });
    // one recording at a time on the card
    expect((within(card).getByRole('button', { name: 'Record voice note' }) as HTMLButtonElement).disabled).toBe(true);
    now += 12_000;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Stop and add' })); });
    await settled();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    const [input] = uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      kind: 'visit', mime: 'video/webm', data: 'AQID', nodeId: 'n-kit',
      siteVisit: { visitId: 'v-1', note: 'Crack by the column', rating: 'concern' },
    });
    expect(input).not.toHaveProperty('durationSec');
    expect(input).not.toHaveProperty('takenAt');
    expect(screen.getByTestId('sv-file-m-9').textContent).toContain('Video · 0:12');
    expect(useStore.getState().outbox).toHaveLength(0);
    expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('');
    expect((within(card).getByRole('button', { name: 'Record voice note' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says the camera is starting until it shows its first picture, and only then records', async () => {
    withRecorder();
    let showPicture: (() => void) | null = null;
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value(cb: () => void) { showPicture = cb; return 1; },
    });
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'gu');
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'વીડિયો રેકોર્ડ કરો' })); });
    const button = within(card).getByTestId('sv-record-video-v-1') as HTMLButtonElement;
    expect(button.textContent).toBe('કૅમેરા શરૂ થઈ રહ્યો છે…');
    expect(button.disabled).toBe(true);
    expect(FakeRecorder.last).toBeNull();
    expect(within(card).queryByTestId('sv-recording-video-v-1')).toBeNull();
    await act(async () => { showPicture!(); });
    await settled();
    expect(FakeRecorder.last!.state).toBe('recording');
    expect(within(card).getByTestId('sv-recording-video-v-1')).toBeTruthy();
    // and a voice note's button never says so
    expect(within(card).getByTestId('sv-record-v-1').textContent).toBe('વૉઇસ નોટ રેકોર્ડ કરો');
  });

  it('lets the camera go at once when the screen is left while the camera is starting', async () => {
    withRecorder();
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value() { return 1; },
    });
    const view = await mount('consultant', CONSULTANT, fakeGateway([visit()]));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record video' })); });
    expect(within(card).getByTestId('sv-record-video-v-1').textContent).toBe('Starting the camera…');
    expect(tracks[0].stop).not.toHaveBeenCalled();
    view.unmount();
    await settled();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.last).toBeNull();
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('records picture only when the microphone is refused', async () => {
    withRecorder();
    getUserMedia.mockImplementation(async (media?: MediaStreamConstraints) => {
      if (media?.audio) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      return camera();
    });
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0]).not.toHaveProperty('audio');
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect((uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ mime: 'video/webm' });
  });

  it('falls back to MP4 (H.264 with AAC) where the recorder writes no WebM, as an iPhone before 18.4', async () => {
    withRecorder();
    supported = new Set(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'audio/mp4']);
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(FakeRecorder.last!.options).toMatchObject({ mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' });
    expect((uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ mime: 'video/mp4' });
  });

  it('says how to allow the camera when it was refused, in the person’s language', async () => {
    withRecorder();
    getUserMedia.mockImplementation(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'gu');
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'વીડિયો રેકોર્ડ કરો' })); });
    expect(within(card).getByRole('status').textContent).toBe(
      'વીડિયો માટે કૅમેરા જોઈએ. બ્રાઉઝર સેટિંગમાં આ સાઇટ માટે કૅમેરાની મંજૂરી આપો, પછી ફરી પ્રયત્ન કરો.',
    );
    expect(within(card).queryByTestId('sv-recording-video-v-1')).toBeNull();
  });

  it('keeps a clip recorded without signal on the phone, shows it as waiting with a player, and sends it later', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async (): Promise<{ id: string; url: string }> => { throw new TypeError('Failed to fetch'); });
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await record(card, 3_000);
    await settled();
    const queued = useStore.getState().outbox;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ t: 'siteVisitAddFile', visitId: 'v-1', file: { mime: 'video/webm' } });
    expect((queued[0] as { file: object }).file).not.toHaveProperty('durationSec');
    const row = within(card).getByText('Video').closest('li')!;
    expect(row.textContent).toContain('waiting');
    const player = row.querySelector('video')!;
    expect(player.getAttribute('src')).toBe('data:video/webm;base64,AQID');
    expect(player.hasAttribute('playsinline')).toBe(true);
    uploadMedia.mockImplementation(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await act(async () => { await useStore.getState().flushOutbox(); });
    await settled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('keeps nothing on Discard and lets the camera go', async () => {
    withRecorder();
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record video' })); });
    now += 4_000;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Discard' })); });
    await settled();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(within(card).queryByTestId('sv-recording-video-v-1')).toBeNull();
    expect((within(card).getByRole('button', { name: 'Record voice note' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not keep a clip shorter than a second, one that ran a minute or more, or one too large to send', async () => {
    withRecorder();
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await record(card, 600);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe('This recording was too short to add. Record for at least a second.');
    await record(card, 61_000);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe('This video ran past one minute and was not added. Record a shorter video.');
    // past the upload's size (12 MiB less 64 KiB of base64)
    bytes = new Uint8Array(9_500_000);
    await record(card, 30_000);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe('This video is too large to send. Record a shorter video.');
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('stops itself at 59.5 s, inside the server’s minute, and keeps that clip', async () => {
    withRecorder();
    // the recorder's own cap timer, caught as it is set, so the test runs it at its time rather than waiting a minute
    const real = globalThis.setTimeout;
    const caps: Array<{ ms: number; run: () => void }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number' && ms >= 30_000) { caps.push({ ms, run: fn }); return 0 as unknown as ReturnType<typeof setTimeout>; }
      return real(fn, ms, ...rest);
    }) as typeof setTimeout);
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record video' })); });
    expect(caps.map((c) => c.ms)).toEqual([59_500]);
    now += 59_500;
    await act(async () => { caps[0].run(); });
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect((uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ mime: 'video/webm' });
    expect(within(card).getByText('The video stopped at one minute and was added.')).toBeTruthy();
  });

  it('stops a recorder that writes H.264 in Matroska, says so, and keeps nothing', async () => {
    withRecorder();
    writes = 'video/x-matroska;codecs=avc1';
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }), 'hi');
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'वीडियो रिकॉर्ड करें' })); });
    await settled();
    expect(within(card).getByRole('status').textContent).toBe(
      'यह ब्राउज़र वीडियो ऐसे फ़ॉर्मेट में रिकॉर्ड करता है जिसे Vitan भेज नहीं सकता। कोई दूसरा ब्राउज़र आज़माएँ, जैसे Chrome या Safari।',
    );
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('gives a server’s refusal of a clip in the person’s language', async () => {
    withRecorder();
    const uploadMedia = vi.fn().mockRejectedValue(refusal(400, 'This file is not the video its type says'));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }), 'hi');
    await record(screen.getByTestId('sv-visit-v-1'), 5_000, { record: 'वीडियो रिकॉर्ड करें', stop: 'रोकें और जोड़ें' });
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sv-not-sent').textContent).toContain('यह वीडियो ठीक से रिकॉर्ड नहीं हुआ। कृपया इसे फिर से रिकॉर्ड करें।');
    expect(screen.getByTestId('sv-not-sent').querySelector('video')).not.toBeNull();
  });

  it('plays a stored clip inline from the phone’s own copy of the file, fetched without credentials on Play', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => { created.push(b); return 'blob:clip-1'; }),
      revokeObjectURL: vi.fn(),
    }));
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', files: [clipFile()] })]));
    const row = screen.getByTestId('sv-file-m-c');
    expect(row.textContent).toContain('Video · 0:12');
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Play: Crack by the column' })); });
    await settled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/media/m-c?sig=x'), expect.objectContaining({ credentials: 'omit' }));
    const player = row.querySelector('video')!;
    expect(player.getAttribute('src')).toBe('blob:clip-1');
    expect(player.hasAttribute('playsinline')).toBe(true);
    expect(created[0].type).toBe('video/webm');
    // a clip this browser cannot play says so in a video's words
    await act(async () => { fireEvent.error(player); });
    expect(row.textContent).toContain('This video could not be played.');
  });

  it('does not count a clip among the photos a marked-up copy is named by', async () => {
    const photo = (id: string) => clipFile({ mediaId: id, mime: 'image/jpeg', url: `/media/${id}`, durationSec: null, note: null });
    await mount('client', 'u-client', fakeGateway([visit({
      status: 'ended', files: [clipFile(), photo('m-p'), { ...photo('m-copy'), sourceMediaId: 'm-p' }],
    })]));
    expect(screen.getByTestId('sv-file-m-copy').textContent).toContain('Marked-up copy of photo 1');
  });
});

describe('#995 V2b-2: a clip’s still frame', () => {
  const FRAME = '/9j/AAAA';
  const keptRows = () => { const s = useStore.getState(); return listVisitPhotos(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId); };
  const keptRow = (key: string) => { const s = useStore.getState(); return getVisitPhoto(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId, key); };
  const flushAgain = async () => { await act(async () => { await useStore.getState().flushOutbox(); }); await settled(); };

  it('keeps the frame drawn from the clip with it, and sends it to the clip the server holds right after the clip', async () => {
    withRecorder();
    still.frame = FRAME;
    const order: string[] = [];
    const uploadMedia = vi.fn(async () => { order.push('clip'); return { id: 'm-9', url: '/media/m-9' }; });
    const addVisitPoster = vi.fn(async (id: string) => { order.push('frame'); return { id, posterUrl: `/media/${id}/poster?t=x` }; });
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia, addVisitPoster }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(order).toEqual(['clip', 'frame']);
    expect(addVisitPoster).toHaveBeenCalledWith('m-9', FRAME);
    // the frame is never part of the clip's upload
    expect(JSON.stringify(uploadMedia.mock.calls[0])).not.toContain(FRAME);
    // taken: it leaves the row, which then goes as any sent file's does
    const [row] = await keptRows();
    expect(row).toMatchObject({ state: 'filed' });
    expect(row).not.toHaveProperty('poster');
    expect(row).not.toHaveProperty('mediaId');
    expect(useStore.getState().outbox).toHaveLength(0);
    await flushAgain();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
  });

  it('sends a clip this phone drew no frame from alone, and a voice note never draws one', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const addVisitPoster = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia, addVisitPoster }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(addVisitPoster).not.toHaveBeenCalled();
    still.frame = FRAME;
    await record(screen.getByTestId('sv-visit-v-1'), 3_000, { record: 'Record voice note', stop: 'Stop and add' });
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect((uploadMedia.mock.calls[1] as unknown as [Record<string, unknown>])[0]).toMatchObject({ mime: 'audio/webm' });
    expect(addVisitPoster).not.toHaveBeenCalled();
  });

  it('lets a frame the server refuses for good go, never sent again: the clip keeps its plain play tile', async () => {
    withRecorder();
    still.frame = FRAME;
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const addVisitPoster = vi.fn().mockRejectedValue(refusal(400, 'This file is not a still frame the app can show'));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia, addVisitPoster }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    const [row] = await keptRows();
    expect(row).toMatchObject({ state: 'filed' });
    expect(row).not.toHaveProperty('poster');
    // nothing is said: the clip went
    expect(screen.queryByTestId('sv-not-sent')).toBeNull();
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps a frame that met no answer on the row, lets the visit’s later acts go, and sends the frame alone on the next flush', async () => {
    withRecorder();
    still.frame = FRAME;
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const addVisitPoster = vi.fn(async (id: string) => ({ id, posterUrl: `/media/${id}/poster?t=x` }));
    addVisitPoster.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(refusal(503, 'Busy'));
    const endSiteVisit = vi.fn(async () => visit({ status: 'ended', endedAt: '2026-10-14T05:00:00.000Z' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia, addVisitPoster, endSiteVisit }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    // the clip's act went: the frame holds nothing
    expect(useStore.getState().outbox).toHaveLength(0);
    let [row] = await keptRows();
    expect(row).toMatchObject({ state: 'filed', poster: FRAME, mediaId: 'm-9' });
    // the visit's next act goes; the flush that sends it sends the frame again, alone (a busy server: kept again)
    await act(async () => { fireEvent.click(within(screen.getByTestId('sv-visit-v-1')).getByRole('button', { name: 'End visit' })); });
    await settled();
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(addVisitPoster).toHaveBeenCalledTimes(2);
    [row] = await keptRows();
    expect(row).toMatchObject({ poster: FRAME, mediaId: 'm-9' });
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(3);
    expect(addVisitPoster).toHaveBeenLastCalledWith('m-9', FRAME);
    // the clip itself is never sent again
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(await keptRow(row.clientKey)).not.toHaveProperty('poster');
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(3);
  });

  it('keeps a frame that met no answer through a reload, and sends it then', async () => {
    withRecorder();
    still.frame = FRAME;
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const addVisitPoster = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia, addVisitPoster }));
    await record(screen.getByTestId('sv-visit-v-1'), 3_000);
    await settled();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    cleanup();
    // a fresh page: memory is gone, the row is kept
    const again = vi.fn(async (id: string) => ({ id, posterUrl: `/media/${id}/poster?t=x` }));
    const upload2 = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit({ files: [clipFile({ mediaId: 'm-9', addedById: CONSULTANT })] })], { uploadMedia: upload2, addVisitPoster: again }));
    await settled();
    await flushAgain();
    expect(again).toHaveBeenCalledWith('m-9', FRAME);
    expect(upload2).not.toHaveBeenCalled();
  });

  it('asks no read again for a frame alone once the server lists its clip: a server that keeps refusing it is not asked on a beat', async () => {
    for (const frame of [FRAME, null]) {
      withRecorder();
      still.frame = frame;
      let key = '';
      const uploadMedia = vi.fn(async (input: { clientKey: string }) => { key = input.clientKey; return { id: 'm-9', url: '/media/m-9' }; });
      const addVisitPoster = vi.fn().mockRejectedValue(refusal(503, 'Busy'));
      const gw = fakeGateway([visit()], { uploadMedia, addVisitPoster });
      await mount('consultant', CONSULTANT, gw);
      let arms = 0;
      const retry = useStore.getState().retrySiteVisits;
      useStore.setState({ retrySiteVisits: () => { arms += 1; retry(); } });
      await record(screen.getByTestId('sv-visit-v-1'), 3_000);
      await settled();
      // what the armed retry does: the screen reads again, and the queue is sent
      const fire = async () => {
        const s = useStore.getState();
        await act(async () => { tellSiteVisits({ kind: 'retry', project: s.activeProjectId, generation: s.projectScopeGeneration }); await s.flushOutbox(); });
        await settled();
      };
      // sent, not yet listed: each read is tried again, frame or none
      const before = arms;
      await fire();
      expect(arms).toBeGreaterThan(before);
      gw.listSiteVisits!.mockImplementation(async () => [visit({ files: [clipFile({ mediaId: 'm-9', clientKey: key, addedById: CONSULTANT })] })]);
      await fire();
      const listedAt = arms;
      const posts = addVisitPoster.mock.calls.length;
      await fire();
      await fire();
      // listed: nothing arms the retry again, so the frame is not sent on its beat
      expect(arms).toBe(listedAt);
      expect(addVisitPoster.mock.calls.length - posts).toBe(frame ? 2 : 0);
      const [row] = await keptRows();
      if (frame) expect(row).toMatchObject({ poster: FRAME, mediaId: 'm-9' });
      else expect(row).toBeUndefined();
      cleanup();
      await flushesEnded();
      await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
    }
  });

  it('puts a waiting frame’s act back once on a load, and starts no send of its own: the next flush sends it', async () => {
    useStore.setState({ ...getInitialState(), role: 'consultant', sessionUserId: CONSULTANT, nodes: NODES, members: MEMBERS });
    const addVisitPoster = vi.fn(async (id: string) => ({ id, posterUrl: `/media/${id}/poster?t=x` }));
    addVisitPoster.mockRejectedValueOnce(refusal(503, 'Busy')).mockRejectedValueOnce(refusal(503, 'Busy'));
    const uploadMedia = vi.fn();
    const gw = fakeGateway([visit()], { addVisitPoster, uploadMedia });
    (gw as { project?: string }).project = useStore.getState().activeProjectId;
    useStore.getState()._setGateway(tracked(gw) as unknown as ApiGateway);
    const s = useStore.getState();
    const scope = visitPhotoScope(s.sessionToken, s.sessionUserId);
    const clip: SiteVisitAddFileOp = {
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: 'k-c', scope, file: { id: 'c-1', mime: 'video/webm' },
      by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: '2026-10-14T04:50:00.000Z',
    };
    await putVisitPhoto(scope, s.activeProjectId, clip, 'AQID', null, undefined, FRAME);
    await fileVisitPhoto(scope, s.activeProjectId, 'c-1', 'm-9');
    // a load, then a second read of the kept rows meeting it: the act is queued once, and nothing is sent
    useStore.getState().hydrateOutbox();
    await settled();
    useStore.getState().hydrateOutbox();
    await settled();
    expect(useStore.getState().outbox.filter((o) => o.t === 'siteVisitAddFile')).toHaveLength(1);
    expect(addVisitPoster).not.toHaveBeenCalled();
    // each flush sends it once (a busy server, twice), and then once more, taken
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(2);
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(3);
    expect(addVisitPoster).toHaveBeenLastCalledWith('m-9', FRAME);
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(3);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('never puts back or sends a frame that waited past its day, and lets it go with no Site Visits read (Codex 4400008717)', async () => {
    useStore.setState({ ...getInitialState(), role: 'consultant', sessionUserId: CONSULTANT, nodes: NODES, members: MEMBERS });
    const addVisitPoster = vi.fn(async (id: string) => ({ id, posterUrl: `/media/${id}/poster?t=x` }));
    const uploadMedia = vi.fn();
    const gw = fakeGateway([visit()], { addVisitPoster, uploadMedia });
    (gw as { project?: string }).project = useStore.getState().activeProjectId;
    useStore.getState()._setGateway(tracked(gw) as unknown as ApiGateway);
    const s = useStore.getState();
    const scope = visitPhotoScope(s.sessionToken, s.sessionUserId);
    const clip = (key: string): SiteVisitAddFileOp => ({
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: `k-${key}`, scope, file: { id: key, mime: 'video/webm' },
      by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: '2026-10-14T04:50:00.000Z',
    });
    await putVisitPhoto(scope, s.activeProjectId, clip('c-old'), 'AQID', null, undefined, FRAME);
    await putVisitPhoto(scope, s.activeProjectId, clip('c-new'), 'AQID', null, undefined, FRAME);
    // c-old was sent a day ago; c-new a moment ago
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at - POSTER_WAIT_MS);
    await fileVisitPhoto(scope, s.activeProjectId, 'c-old', 'm-old');
    clock.mockRestore();
    await fileVisitPhoto(scope, s.activeProjectId, 'c-new', 'm-new');
    // the screen is never mounted: no read settles either row
    useStore.getState().hydrateOutbox();
    await settled();
    expect(useStore.getState().outbox.map((o) => ('idempotencyKey' in o ? o.idempotencyKey : null))).toEqual(['k-c-new']);
    expect(await keptRow('c-old')).not.toHaveProperty('poster');
    expect(await keptRow('c-old')).not.toHaveProperty('mediaId');
    await flushAgain();
    expect(addVisitPoster.mock.calls).toEqual([['m-new', FRAME]]);
    await flushAgain();
    expect(addVisitPoster).toHaveBeenCalledTimes(1);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('shows the clip’s still frame above Play when the server has one, and leaves out one that does not load', async () => {
    await mount('client', 'u-client', fakeGateway([visit({
      status: 'ended', files: [clipFile({ posterUrl: '/media/m-c/poster?t=x' }), clipFile({ mediaId: 'm-d', posterUrl: null })],
    })]));
    const tile = screen.getByTestId('sv-file-m-c').querySelector('img')!;
    expect(tile.getAttribute('src')).toContain('/media/m-c/poster?t=x');
    expect(tile.getAttribute('alt')).toBe('');
    expect(screen.getByTestId('sv-file-m-c').querySelector('video')!.getAttribute('poster')).toContain('/media/m-c/poster?t=x');
    expect(screen.getByTestId('sv-file-m-d').querySelector('img')).toBeNull();
    await act(async () => { fireEvent.error(tile); });
    expect(screen.getByTestId('sv-file-m-c').querySelector('img')).toBeNull();
    expect(within(screen.getByTestId('sv-file-m-c')).getByRole('button', { name: 'Play: Crack by the column' })).not.toBeNull();
  });

  it('tries a frame again when a later read brings it a fresh link (Codex 4399442176)', async () => {
    const words = { play: 'Play', failed: 'failed', retry: 'Try again' };
    const view = render(<MediaPlayer url="/media/m-c?sig=x" mime="video/webm" label="Clip" words={words} poster="/media/m-c/poster?t=old" />);
    await act(async () => { fireEvent.error(view.container.querySelector('img')!); });
    expect(view.container.querySelector('img')).toBeNull();
    view.rerender(<MediaPlayer url="/media/m-c?sig=y" mime="video/webm" label="Clip" words={words} poster="/media/m-c/poster?t=new" />);
    expect(view.container.querySelector('img')!.getAttribute('src')).toContain('/media/m-c/poster?t=new');
  });
});
