import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import type { ApiGateway, OutboxOp, SiteVisit } from '@/data/apiGateway';
import { flushesEnded, settled, startWork, tracked } from './site-visit-work';

/**
 * Stage 1 voice notes on a visit (Jagrut, 19 Oct 2026): the visitor and anyone present record a note of up to two
 * minutes, with the same optional note, rating and place as a photo; it is kept and sent the way a photo is, and every
 * member plays it from the visit card. Recording is offered only where the browser's recorder writes a type the upload
 * takes. The note's length is never sent: the server reads it from the file.
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
const voiceFile = (over: Partial<NonNullable<SiteVisit['files']>[number]> = {}) => ({
  mediaId: 'm-v', url: '/media/m-v?sig=x', mime: 'audio/webm', takenAt: null, durationSec: 42, note: 'Slab level is off',
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

// a recorder that writes WebM (Opus), as Android browsers do (or `writes`, when a test says); the running time is the
// test's own clock
let now = 0;
let writes: string | null = null;
/** when set, a stop's last data and stop event wait until the test lets them go (`release`) */
let holdStop = false;
let release: (() => void) | null = null;
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
class FakeRecorder {
  static isTypeSupported(t: string) { return t.startsWith('audio/webm'); }
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = writes ?? options.mimeType; FakeRecorder.last = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    const end = () => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
      this.onstop?.();
    };
    if (holdStop) release = end; else end();
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
  holdStop = false;
  release = null;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  // a recording's length is on the phone's forward-only clock
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  tracks = [{ stop: vi.fn() }];
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => ({ getTracks: () => tracks }));
});
afterEach(async () => {
  await flushesEnded();
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

async function record(card: HTMLElement, ms: number, names = { record: 'Record voice note', stop: 'Stop and add' }) {
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: names.record })); });
  now += ms;
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: names.stop })); });
}
const HINDI = { record: 'वॉइस नोट रिकॉर्ड करें', stop: 'रोकें और जोड़ें' };
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });

describe('Stage 1 voice notes on a visit', () => {
  it('offers recording to the visitor and anyone present while the visit is not closed, only where the browser can record', async () => {
    await mount('consultant', CONSULTANT, fakeGateway([visit()]));
    // no recorder in this browser: nothing is offered that would fail
    expect(within(screen.getByTestId('sv-visit-v-1')).queryByRole('button', { name: 'Record voice note' })).toBeNull();
    cleanup();
    withRecorder();
    const offered = async (role: Role, me: string, v: SiteVisit) => {
      await mount(role, me, fakeGateway([v]));
      const has = within(screen.getByTestId('sv-visit-v-1')).queryByRole('button', { name: 'Record voice note' }) !== null;
      cleanup();
      return has;
    };
    expect(await offered('consultant', CONSULTANT, visit())).toBe(true);
    expect(await offered('engineer', ENG, visit({ attendees: [present] }))).toBe(true);
    expect(await offered('engineer', ENG, visit())).toBe(false);
    expect(await offered('consultant', CONSULTANT, visit({ status: 'closed', closeReason: 'Left open' }))).toBe(false);
  });

  it('sends a recorded note as a visit file in its base type, with its note, rating and place, and no length', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    const gw = fakeGateway([visit({ places: walked, attendees: [present] })], { uploadMedia });
    await mount('engineer', ENG, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: ' Check the slab ' } });
    fireEvent.change(within(card).getByLabelText('How is it? (optional)'), { target: { value: 'concern' } });
    fireEvent.change(within(card).getByLabelText('Place (optional)'), { target: { value: 'n-kit' } });
    gw.listSiteVisits!.mockImplementation(async () => [visit({ places: walked, attendees: [present], files: [voiceFile({ mediaId: 'm-9', addedById: ENG })] })]);
    await record(card, 5_000);
    await settled();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    const [input] = uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      kind: 'visit', mime: 'audio/webm', data: 'AQID', nodeId: 'n-kit',
      siteVisit: { visitId: 'v-1', note: 'Check the slab', rating: 'concern' },
    });
    expect(input).not.toHaveProperty('durationSec');
    expect(input).not.toHaveProperty('takenAt');
    expect(screen.getByTestId('sv-file-m-9').textContent).toContain('Voice note · 0:42');
    expect(useStore.getState().outbox).toHaveLength(0);
    expect((within(card).getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('');
  });

  it('keeps a note recorded without signal on the phone, shows it as waiting with a player, and sends it later', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async (): Promise<{ id: string; url: string }> => { throw new TypeError('Failed to fetch'); });
    const gw = fakeGateway([visit()], { uploadMedia });
    await mount('consultant', CONSULTANT, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    await record(card, 3_000);
    await settled();
    const queued = useStore.getState().outbox;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ t: 'siteVisitAddFile', visitId: 'v-1', file: { mime: 'audio/webm' } });
    expect((queued[0] as { file: object }).file).not.toHaveProperty('durationSec');
    // shown from the phone's own copy, which plays as it is
    const row = within(card).getByText('Voice note').closest('li')!;
    expect(row.textContent).toContain('waiting');
    expect(row.querySelector('audio')!.getAttribute('src')).toBe('data:audio/webm;base64,AQID');
    uploadMedia.mockImplementation(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await act(async () => { await useStore.getState().flushOutbox(); });
    await settled();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect((uploadMedia.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]).toMatchObject({ mime: 'audio/webm', data: 'AQID' });
  });

  it('does not keep a recording shorter than a second', async () => {
    withRecorder();
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await record(screen.getByTestId('sv-visit-v-1'), 600);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe('This recording was too short to add. Record for at least a second.');
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('keeps nothing on Discard and lets the microphone go', async () => {
    withRecorder();
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record voice note' })); });
    expect(within(card).getByTestId('sv-recording-v-1').textContent).toContain('Recording 0:00 of 2:00');
    now += 4_000;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Discard' })); });
    await settled();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(within(card).getByRole('button', { name: 'Record voice note' })).toBeTruthy();
  });

  it('lets the microphone go when the screen is left while recording', async () => {
    withRecorder();
    await mount('consultant', CONSULTANT, fakeGateway([visit()]));
    await act(async () => { fireEvent.click(within(screen.getByTestId('sv-visit-v-1')).getByRole('button', { name: 'Record voice note' })); });
    cleanup();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('says how to allow the microphone when it was refused, in the person’s language', async () => {
    withRecorder();
    getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'hi');
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'वॉइस नोट रिकॉर्ड करें' })); });
    expect(within(card).getByRole('status').textContent).toBe(
      'वॉइस नोट के लिए माइक्रोफ़ोन चाहिए। ब्राउज़र सेटिंग में इस साइट के लिए माइक्रोफ़ोन की अनुमति दें, फिर से कोशिश करें।',
    );
  });

  it('does not keep a recording that ran two minutes or more, though the cap should have stopped it', async () => {
    withRecorder();
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await record(screen.getByTestId('sv-visit-v-1'), 125_000);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe('This recording ran past two minutes and was not added. Record a shorter note.');
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('stops a recorder that writes a codec the server does not read, says so, and keeps nothing', async () => {
    withRecorder();
    writes = 'audio/webm;codecs=pcm';
    const uploadMedia = vi.fn();
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }), 'gu');
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'વૉઇસ નોટ રેકોર્ડ કરો' })); });
    expect(within(card).getByRole('status').textContent).toBe(
      'આ બ્રાઉઝર અવાજ એવા ફોર્મેટમાં રેકોર્ડ કરે છે જે Vitan મોકલી શકતું નથી. બીજું બ્રાઉઝર અજમાવો, જેમ કે Chrome અથવા Safari.',
    );
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(within(card).queryByTestId('sv-recording-v-1')).toBeNull();
    await settled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('refuses a note whose recorder names a codec the server does not read only once it stops, before it is kept', async () => {
    // a recorder may name its real codec only after it starts: it says Opus while recording, PCM once stopped
    let stopped = false;
    class Late extends FakeRecorder {
      constructor(stream: unknown, options: { mimeType: string }) {
        super(stream, options);
        Object.defineProperty(this, 'mimeType', { configurable: true, get: () => (stopped ? 'audio/webm;codecs=pcm' : 'audio/webm;codecs=opus'), set: () => {} });
      }
      stop() { stopped = true; super.stop(); }
    }
    withRecorder();
    vi.stubGlobal('MediaRecorder', Late);
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    await record(screen.getByTestId('sv-visit-v-1'), 5_000);
    await settled();
    expect(screen.getByRole('alert').textContent).toBe(
      'This browser records voice in a format Vitan cannot send. Try another browser, such as Chrome or Safari.',
    );
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
  });

  it('adds a recording the browser ended by itself, with the note as it is then, and stops showing it as recording', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record voice note' })); });
    // the note is written while recording
    fireEvent.change(within(card).getByLabelText('Note (optional)'), { target: { value: 'Written while recording' } });
    now += 3_000;
    // the microphone went away: the recorder stops without Stop being tapped
    await act(async () => { FakeRecorder.last!.stop(); });
    await settled();
    expect(within(card).queryByTestId('sv-recording-v-1')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Record voice note' })).toBeTruthy();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect((uploadMedia.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ siteVisit: { note: 'Written while recording' } });
  });

  it('keeps nothing when the screen is left after Stop but before the recording has finished', async () => {
    withRecorder();
    holdStop = true;
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }));
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record voice note' })); });
    now += 3_000;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Stop and add' })); });
    expect(release).not.toBeNull();
    cleanup();
    await act(async () => { release!(); });
    await settled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('records and sends a note when the screen runs under StrictMode, as the app does', async () => {
    withRecorder();
    const uploadMedia = vi.fn(async () => ({ id: 'm-9', url: '/media/m-9' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }), 'en', [], true);
    const card = screen.getByTestId('sv-visit-v-1');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Record voice note' })); });
    // the recording is running, not cancelled by the first, StrictMode-only unmount
    expect(within(card).getByTestId('sv-recording-v-1')).toBeTruthy();
    expect(tracks[0].stop).not.toHaveBeenCalled();
    now += 2_000;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Stop and add' })); });
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('gives a server’s refusal of a voice note in the person’s language', async () => {
    withRecorder();
    const uploadMedia = vi.fn().mockRejectedValue(refusal(400, 'A voice note is at most two minutes long'));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { uploadMedia }), 'hi');
    await record(screen.getByTestId('sv-visit-v-1'), 5_000, HINDI);
    await settled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sv-not-sent').textContent).toContain('वॉइस नोट ज़्यादा से ज़्यादा दो मिनट का होता है');
    expect(screen.getByRole('alert').textContent).toContain('वॉइस नोट ज़्यादा से ज़्यादा दो मिनट का होता है');
  });

  it('plays a stored note from the phone’s own copy of the file, fetched without credentials on Play', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => { created.push(b); return 'blob:voice-1'; }),
      revokeObjectURL: vi.fn(),
    }));
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', files: [voiceFile()] })]));
    const row = screen.getByTestId('sv-file-m-v');
    expect(row.textContent).toContain('Voice note · 0:42');
    expect(row.textContent).toContain('Slab level is off');
    // nothing is fetched until it is asked for
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Play: Slab level is off' })); });
    await settled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/media/m-v?sig=x'), expect.objectContaining({ credentials: 'omit' }));
    expect(row.querySelector('audio')!.getAttribute('src')).toBe('blob:voice-1');
    // typed as the file is, whatever the bucket answered with
    expect(created[0].type).toBe('audio/webm');
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-1');
  });

  it('starts the player on the Play tap itself, then plays the file once fetched, and leaves its controls when the browser still will not', async () => {
    let answer: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise((done) => { answer = done; })));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice-1'), revokeObjectURL: vi.fn() }));
    const played: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      played.push(this.getAttribute('src') ?? '');
      // an iPhone that still refuses once the tap has passed
      return played.length > 1 ? Promise.reject(new DOMException('no', 'NotAllowedError')) : Promise.resolve();
    });
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', files: [voiceFile()] })]));
    const row = screen.getByTestId('sv-file-m-v');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Play: Slab level is off' })); });
    // in the tap, before the file has come
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^data:audio\/wav;base64,/);
    await act(async () => { answer({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) }); });
    await settled();
    expect(played).toEqual([played[0], 'blob:voice-1']);
    // refused: the player stays, with its controls, and nothing says it failed
    const audio = row.querySelector('audio')!;
    expect(audio.hidden).toBe(false);
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(row.textContent).not.toContain('could not be played');
  });

  it('says a note could not be played and offers to try again', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) }));
    vi.stubGlobal('fetch', fetchSpy);
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', files: [voiceFile()] })]));
    const row = screen.getByTestId('sv-file-m-v');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Play: Slab level is off' })); });
    await settled();
    expect(row.textContent).toContain('This voice note could not be played.');
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says a note could not be played when the browser cannot play the file it fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) })));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:voice-1'), revokeObjectURL: vi.fn() }));
    await mount('client', 'u-client', fakeGateway([visit({ status: 'ended', files: [voiceFile()] })]));
    const row = screen.getByTestId('sv-file-m-v');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Play: Slab level is off' })); });
    await settled();
    await act(async () => { fireEvent.error(row.querySelector('audio')!); });
    expect(row.querySelector('audio')!.hidden).toBe(true);
    expect(row.textContent).toContain('This voice note could not be played.');
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
