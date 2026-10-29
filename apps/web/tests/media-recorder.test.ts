import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { acceptedType, baseType, CAMERA_WAIT_MS, clockText, pickRecordType, RecordError, startRecording, type Recording } from '@/lib/mediaRecorder';

/**
 * Stage 1 voice notes: the shared recorder (voice now, video clips in V2). The type is picked before recording from
 * what the browser's recorder says it writes; a recorder that writes another type is stopped before anything is kept;
 * the cap stops a recording by itself; the microphone is let go however it ends. A fake clock throughout this file:
 * the cap is the recorder's own timer.
 */

type Track = { stop: ReturnType<typeof vi.fn> };
let writes: string | null = null;
/** how long the recorder takes from stop() to its stop event (writing its last data); 0 is at once */
let stopTakes = 0;
let supported = new Set<string>();

class FakeRecorder {
  static isTypeSupported(t: string) { return supported.has(t); }
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly options: Record<string, unknown>;
  constructor(_stream: unknown, options: Record<string, unknown>) {
    this.options = options;
    this.mimeType = writes ?? String(options.mimeType);
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    const end = () => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
      this.onstop?.();
    };
    if (stopTakes > 0) setTimeout(end, stopTakes); else end();
  }
}

let tracks: Track[] = [];
/** a device stream as the recorder sees it: its tracks, the camera's among them */
const devices = () => ({ getTracks: () => tracks, getVideoTracks: () => tracks });
const getUserMedia = vi.fn(async () => devices());
/** when the camera shows its first picture to the video that watches it: drawn at once (`frame`), only as loaded data
 *  with a size where there is no frame callback (`loaded`), or never */
let camera: 'frame' | 'loaded' | 'never' = 'frame';
/** the videos the recorder watched the camera on */
let watched: HTMLVideoElement[] = [];
/** shows the camera's first picture to a video still waiting for it (`never` holds it until the test calls this) */
let showPicture: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  writes = null;
  stopTakes = 0;
  supported = new Set(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
  tracks = [{ stop: vi.fn() }];
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => devices());
  camera = 'frame';
  watched = [];
  showPicture = null;
  FakeRecorder.last = null;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    const video = this as HTMLVideoElement;
    watched.push(video);
    if (camera === 'loaded') {
      Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
      queueMicrotask(() => video.onloadeddata?.(new Event('loadeddata')));
    }
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    get() {
      return camera === 'loaded' ? undefined : (cb: () => void) => { if (camera === 'frame') queueMicrotask(cb); else showPicture = cb; return 1; };
    },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('Stage 1 voice notes: the shared recorder', () => {
  it('picks the first type the recorder writes that the upload takes, and none without a recorder or microphone', () => {
    expect(pickRecordType('audio')).toBe('audio/webm;codecs=opus');
    supported = new Set(['audio/mp4']);
    expect(pickRecordType('audio')).toBe('audio/mp4');
    supported = new Set(['audio/wav']);
    expect(pickRecordType('audio')).toBeNull();
    // #995 V2b: a video clip is WebM (VP8, then VP9) where the recorder writes it, else MP4 (H.264 with AAC)
    supported = new Set(['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/mp4']);
    expect(pickRecordType('video')).toBe('video/webm;codecs=vp8,opus');
    supported = new Set(['video/webm;codecs=vp9,opus', 'video/mp4']);
    expect(pickRecordType('video')).toBe('video/webm;codecs=vp9,opus');
    supported = new Set(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']);
    expect(pickRecordType('video')).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    // never H.264 in WebM, which Chromium writes as Matroska (refused), nor a type the server does not read
    supported = new Set(['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'video/quicktime']);
    expect(pickRecordType('video')).toBeNull();
    // and a voice type is never a video's
    supported = new Set(['audio/webm']);
    expect(pickRecordType('video')).toBeNull();
    supported = new Set(['audio/webm']);
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    expect(pickRecordType('audio')).toBeNull();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.stubGlobal('MediaRecorder', undefined);
    expect(pickRecordType('audio')).toBeNull();
  });

  it('gives the recording in the base type, with how long it ran, and lets the microphone go', async () => {
    const r = await startRecording('audio', 'audio/webm;codecs=opus', 120_000);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    vi.advanceTimersByTime(4_000);
    const rec = await r.stop();
    expect(rec.mime).toBe('audio/webm');
    expect(rec.blob.type).toBe('audio/webm');
    expect(rec.blob.size).toBe(3);
    expect(rec.ms).toBeGreaterThanOrEqual(4_000);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    // the cap's timer went with it: nothing stops it again
    vi.advanceTimersByTime(200_000);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('stops itself at its cap, and that recording is what Stop then gives', async () => {
    const r = await startRecording('audio', 'audio/webm', 119_500);
    let ended: { rec: unknown; cause: string } | null = null;
    void r.ended.then((x) => { ended = x; });
    vi.advanceTimersByTime(119_499);
    await Promise.resolve();
    expect(FakeRecorder.last!.state).toBe('recording');
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();
    expect(FakeRecorder.last!.state).toBe('inactive');
    expect(ended).toMatchObject({ cause: 'cap', rec: { mime: 'audio/webm', ms: 119_500 } });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(await r.stop()).toBe(ended!.rec);
  });

  it('says when the browser ends a recording by itself, before its cap', async () => {
    const r = await startRecording('audio', 'audio/webm', 119_500);
    let ended: { rec: unknown; cause: string } | null = null;
    void r.ended.then((x) => { ended = x; });
    vi.advanceTimersByTime(30_000);
    // the microphone went away: the recorder stops without being asked
    FakeRecorder.last!.stop();
    await vi.runAllTimersAsync();
    expect(ended).toMatchObject({ cause: 'ended', rec: { mime: 'audio/webm', ms: 30_000 } });
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(await r.stop()).toBe(ended!.rec);
  });

  it('is as long as it ran until the stop was asked for, however long the recorder then takes to finish', async () => {
    stopTakes = 900;
    const r = await startRecording('audio', 'audio/webm', 119_500);
    vi.advanceTimersByTime(119_500);
    // the cap asked for the stop at 119.5 s; the stop event comes 0.9 s later
    await vi.runAllTimersAsync();
    expect((await r.stop()).ms).toBe(119_500);
    const s = await startRecording('audio', 'audio/webm', 119_500);
    vi.advanceTimersByTime(10_000);
    const stopped = s.stop();
    await vi.runAllTimersAsync();
    expect((await stopped).ms).toBe(10_000);
  });

  it('is as long as it ran on a clock the phone’s time of day does not move', async () => {
    const r = await startRecording('audio', 'audio/webm', 119_500);
    vi.advanceTimersByTime(10_000);
    // the phone's time is corrected forward an hour while it records
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(2_000);
    expect((await r.stop()).ms).toBe(12_000);
  });

  it('runs a recording the browser ended to when its microphone ended, and with no word of that to its stop event', async () => {
    stopTakes = 900;
    const mic = Object.assign(new EventTarget(), { stop: vi.fn() });
    tracks = [mic as unknown as Track];
    const r = await startRecording('audio', 'audio/webm', 119_500);
    let ended: { rec: { ms: number }; cause: string } | null = null;
    void r.ended.then((x) => { ended = x; });
    vi.advanceTimersByTime(50_000);
    mic.dispatchEvent(new Event('ended'));
    vi.advanceTimersByTime(300);
    FakeRecorder.last!.stop();
    await vi.runAllTimersAsync();
    expect(ended).toMatchObject({ cause: 'ended', rec: { ms: 50_000 } });
    // no word from the microphone: to the stop event, 0.9 s after the recorder stopped, so longer, never shorter
    tracks = [{ stop: vi.fn() }];
    const s = await startRecording('audio', 'audio/webm', 119_500);
    vi.advanceTimersByTime(119_400);
    FakeRecorder.last!.stop();
    await vi.runAllTimersAsync();
    expect((await s.stop()).ms).toBe(120_300);
  });

  describe('in a hidden tab, where the cap’s timer can run late', () => {
    // the phone's clock runs on to 125 s while the cap's timer has not yet run
    let t = 0;
    beforeEach(() => { t = 0; vi.spyOn(performance, 'now').mockImplementation(() => t); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('keeps the full length of a recording the browser ended past the cap, with its microphone’s end', async () => {
      const mic = Object.assign(new EventTarget(), { stop: vi.fn() });
      tracks = [mic as unknown as Track];
      const r = await startRecording('audio', 'audio/webm', 119_500);
      t = 125_000;
      mic.dispatchEvent(new Event('ended'));
      t = 125_200;
      FakeRecorder.last!.stop();
      expect((await r.ended).rec.ms).toBe(125_000);
    });

    it('and without it', async () => {
      const r = await startRecording('audio', 'audio/webm', 119_500);
      t = 125_000;
      FakeRecorder.last!.stop();
      expect((await r.ended).rec.ms).toBe(125_000);
    });

    it('and of one the late cap stopped, to when it stopped it', async () => {
      const r = await startRecording('audio', 'audio/webm', 119_500);
      t = 125_000;
      vi.advanceTimersByTime(119_500);
      t = 125_300;
      expect((await r.ended)).toMatchObject({ cause: 'cap', rec: { ms: 125_000 } });
    });
  });

  it('keeps nothing when cancelled, and lets the microphone go', async () => {
    const r = await startRecording('audio', 'audio/webm', 119_500);
    let ended = false;
    void r.ended.then(() => { ended = true; });
    r.cancel();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect((await r.stop()).blob.size).toBe(0);
    await vi.runAllTimersAsync();
    expect(ended).toBe(false);
  });

  it('does not say a recording stopped by Stop ended by itself', async () => {
    const r = await startRecording('audio', 'audio/webm', 119_500);
    let ended = false;
    void r.ended.then(() => { ended = true; });
    vi.advanceTimersByTime(5_000);
    await r.stop();
    await vi.runAllTimersAsync();
    expect(ended).toBe(false);
  });

  it('says the microphone was refused, apart from a phone that has none', async () => {
    getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    await expect(startRecording('audio', 'audio/webm', 1_000)).rejects.toMatchObject({ reason: 'denied' });
    getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }); });
    await expect(startRecording('audio', 'audio/webm', 1_000)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(new RecordError('denied')).toBeInstanceOf(Error);
  });

  it('stops a recorder that writes a type the upload does not take, before anything is kept', async () => {
    writes = 'audio/x-matroska;codecs=opus';
    await expect(startRecording('audio', 'audio/webm', 1_000)).rejects.toMatchObject({ reason: 'format' });
    expect(FakeRecorder.last!.state).toBe('inactive');
    expect(tracks[0].stop).toHaveBeenCalled();
    // the base type the upload takes, with a codec the server does not read in it: stopped the same way
    tracks = [{ stop: vi.fn() }];
    writes = 'audio/webm;codecs=pcm';
    await expect(startRecording('audio', 'audio/webm', 1_000)).rejects.toMatchObject({ reason: 'format' });
    expect(FakeRecorder.last!.state).toBe('inactive');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('takes a type only with the codecs the server reads in it', () => {
    expect(acceptedType('audio', 'audio/webm')).toBe(true);
    expect(acceptedType('audio', 'audio/webm;codecs=opus')).toBe(true);
    expect(acceptedType('audio', 'audio/webm; codecs="opus"')).toBe(true);
    expect(acceptedType('audio', 'audio/webm;codecs=pcm')).toBe(false);
    expect(acceptedType('audio', 'audio/webm;codecs=vorbis')).toBe(false);
    expect(acceptedType('audio', 'audio/mp4;codecs=mp4a.40.2')).toBe(true);
    expect(acceptedType('audio', 'audio/mp4;codecs=opus')).toBe(true);
    expect(acceptedType('audio', 'audio/mp4;codecs=mp4a.40.5')).toBe(false);
    expect(acceptedType('audio', 'audio/ogg;codecs=opus')).toBe(true);
    expect(acceptedType('audio', 'audio/ogg;codecs=vorbis')).toBe(false);
    expect(acceptedType('audio', 'audio/ogg;codecs=opus,vorbis')).toBe(false);
    expect(acceptedType('audio', 'audio/wav')).toBe(false);
    // #995 V1's video allow-list: VP8 or VP9 with Opus in WebM; H.264 (avc1, any profile) or VP9 with AAC-LC or Opus in MP4
    expect(acceptedType('video', 'video/webm')).toBe(true);
    expect(acceptedType('video', 'video/webm;codecs=vp8,opus')).toBe(true);
    expect(acceptedType('video', 'video/webm;codecs=vp9')).toBe(true);
    expect(acceptedType('video', 'video/webm;codecs=vp09.00.10.08,opus')).toBe(true);
    expect(acceptedType('video', 'video/webm;codecs=h264')).toBe(false);
    expect(acceptedType('video', 'video/webm;codecs=avc1.42E01E,opus')).toBe(false);
    expect(acceptedType('video', 'video/webm;codecs=av1,opus')).toBe(false);
    expect(acceptedType('video', 'video/webm;codecs=vp8,vorbis')).toBe(false);
    expect(acceptedType('video', 'video/mp4')).toBe(true);
    expect(acceptedType('video', 'video/mp4;codecs=avc1.64001F,mp4a.40.2')).toBe(true);
    expect(acceptedType('video', 'video/mp4;codecs=avc1,opus')).toBe(true);
    expect(acceptedType('video', 'video/mp4;codecs=vp09.00.10.08')).toBe(true);
    // as Chromium 153 names what it writes for a plain `video/mp4`
    expect(acceptedType('video', 'video/mp4;codecs=vp9,opus')).toBe(true);
    expect(acceptedType('video', 'video/mp4;codecs=avc3.64001F')).toBe(false);
    expect(acceptedType('video', 'video/mp4;codecs=avc1.')).toBe(false);
    expect(acceptedType('video', 'video/mp4;codecs=avc12')).toBe(false);
    expect(acceptedType('video', 'video/mp4;codecs=hvc1.1.6.L93.B0')).toBe(false);
    expect(acceptedType('video', 'video/mp4;codecs=av01.0.04M.08')).toBe(false);
    expect(acceptedType('video', 'video/mp4;codecs=avc1.64001F,mp4a.40.5')).toBe(false);
    expect(acceptedType('video', 'video/x-matroska;codecs=avc1')).toBe(false);
    expect(acceptedType('video', 'audio/webm')).toBe(false);
    expect(acceptedType('audio', 'video/webm')).toBe(false);
  });

  it('records a video clip picture only when the microphone is refused, and says no when the camera is', async () => {
    const both = { audio: true, video: { facingMode: 'environment' } };
    const picture = { video: { facingMode: 'environment' } };
    const no = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    getUserMedia.mockImplementation(async (media?: MediaStreamConstraints) => {
      if (media?.audio) throw no;
      return devices();
    });
    const r = await startRecording('video', 'video/webm;codecs=vp8,opus', 59_500, {
      bits: { videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 }, media: both, fallback: picture,
    });
    expect(getUserMedia.mock.calls).toEqual([[both], [picture]]);
    expect(FakeRecorder.last!.options).toMatchObject({ mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
    // what is recorded, live, for the screen to show
    expect(r.stream.getTracks()).toBe(tracks);
    vi.advanceTimersByTime(2_000);
    expect(await r.stop()).toMatchObject({ mime: 'video/webm', ms: 2_000 });
    // a camera refused too: the fallback's answer is the one that counts
    getUserMedia.mockReset();
    getUserMedia.mockImplementation(async () => { throw no; });
    await expect(startRecording('video', 'video/webm', 59_500, { media: both, fallback: picture })).rejects.toMatchObject({ reason: 'denied' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    // a phone with no camera at all
    getUserMedia.mockReset();
    getUserMedia.mockImplementation(async (media?: MediaStreamConstraints) => {
      throw Object.assign(new Error('none'), { name: media?.audio ? 'NotAllowedError' : 'NotFoundError' });
    });
    await expect(startRecording('video', 'video/webm', 59_500, { media: both, fallback: picture })).rejects.toMatchObject({ reason: 'unavailable' });
    // and with no fallback asked for, the first answer stands (voice)
    getUserMedia.mockReset();
    getUserMedia.mockImplementation(async () => { throw no; });
    await expect(startRecording('audio', 'audio/webm', 1_000)).rejects.toMatchObject({ reason: 'denied' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops a video recorder that writes H.264 in Matroska before anything is kept', async () => {
    writes = 'video/x-matroska;codecs=avc1';
    await expect(startRecording('video', 'video/webm;codecs=vp8,opus', 59_500)).rejects.toMatchObject({ reason: 'format' });
    expect(FakeRecorder.last!.state).toBe('inactive');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('starts a video clip only once the camera shows its first picture, on a muted inline video that then leaves', async () => {
    camera = 'never';
    let started: Recording | null = null;
    const pending = startRecording('video', 'video/webm;codecs=vp8,opus', 59_500).then((r) => { started = r; return r; });
    await vi.advanceTimersByTimeAsync(1_000);
    // the camera is on but shows nothing yet: no recorder, and the running time has not begun
    expect(FakeRecorder.last).toBeNull();
    expect(started).toBeNull();
    const video = watched[0]!;
    expect(video.isConnected).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('muted')).toBe(true);
    expect((video as HTMLVideoElement & { srcObject: unknown }).srcObject).toMatchObject({ getTracks: expect.any(Function) });
    // its first picture: the recorder starts, and the watching video leaves the page; the camera goes on
    showPicture!();
    const r = await pending;
    expect(FakeRecorder.last!.state).toBe('recording');
    expect(video.isConnected).toBe(false);
    expect((video as HTMLVideoElement & { srcObject: unknown }).srcObject).toBeNull();
    expect(tracks[0].stop).not.toHaveBeenCalled();
    // the clip runs from its first picture, not from when the camera was asked for; and the 5 s bound is gone
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await r.stop()).toMatchObject({ mime: 'video/webm', ms: 2_000 });
    await vi.advanceTimersByTimeAsync(CAMERA_WAIT_MS);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('says a video clip could not start when the camera shows no picture in time, and lets the devices go', async () => {
    camera = 'never';
    const pending = startRecording('video', 'video/webm;codecs=vp8,opus', 59_500);
    const said = expect(pending).rejects.toMatchObject({ reason: 'unavailable' });
    await vi.advanceTimersByTimeAsync(CAMERA_WAIT_MS - 1);
    expect(tracks[0].stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await said;
    expect(FakeRecorder.last).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(watched[0]!.isConnected).toBe(false);
    expect((watched[0] as HTMLVideoElement & { srcObject: unknown }).srcObject).toBeNull();
  });

  it('counts a camera picture by its loaded frame and size where the browser has no frame callback', async () => {
    camera = 'loaded';
    const r = await startRecording('video', 'video/mp4', 59_500);
    expect(FakeRecorder.last!.state).toBe('recording');
    expect(watched[0]!.isConnected).toBe(false);
    r.cancel();
  });

  it('says a clip with no camera at all could not start, and never waits on a voice note', async () => {
    getUserMedia.mockImplementation(async () => ({ getTracks: () => tracks, getVideoTracks: () => [] }));
    await expect(startRecording('video', 'video/webm', 59_500)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(FakeRecorder.last).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    camera = 'never';
    getUserMedia.mockImplementation(async () => ({ getTracks: () => tracks, getVideoTracks: () => tracks }));
    const r = await startRecording('audio', 'audio/webm', 1_000);
    expect(FakeRecorder.last!.state).toBe('recording');
    expect(watched).toHaveLength(0);
    r.cancel();
  });

  it('passes a kind’s bit rates and devices to the recorder', async () => {
    const r = await startRecording('audio', 'audio/webm', 1_000, { bits: { audioBitsPerSecond: 64_000 }, media: { audio: { echoCancellation: true } } });
    expect(FakeRecorder.last!.options).toMatchObject({ mimeType: 'audio/webm', audioBitsPerSecond: 64_000 });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true } });
    r.cancel();
  });

  it('writes types and running times plainly', () => {
    expect(baseType('Audio/WebM; codecs=opus')).toBe('audio/webm');
    expect(clockText(0)).toBe('0:00');
    expect(clockText(119_500)).toBe('1:59');
    expect(clockText(120_000)).toBe('2:00');
  });
});
