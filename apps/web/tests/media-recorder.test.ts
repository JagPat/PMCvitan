import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { acceptedType, baseType, clockText, pickRecordType, RecordError, startRecording } from '@/lib/mediaRecorder';

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
const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  writes = null;
  stopTakes = 0;
  supported = new Set(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
  tracks = [{ stop: vi.fn() }];
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => ({ getTracks: () => tracks }));
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('Stage 1 voice notes: the shared recorder', () => {
  it('picks the first type the recorder writes that the upload takes, and none without a recorder or microphone', () => {
    expect(pickRecordType('audio')).toBe('audio/webm;codecs=opus');
    supported = new Set(['audio/mp4']);
    expect(pickRecordType('audio')).toBe('audio/mp4');
    supported = new Set(['audio/wav']);
    expect(pickRecordType('audio')).toBeNull();
    // video is not offered until the video web unit lists its types
    supported = new Set(['video/webm']);
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
    expect(acceptedType('video', 'video/webm')).toBe(false);
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
