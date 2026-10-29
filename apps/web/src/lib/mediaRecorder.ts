/**
 * Stage 1 voice notes (Jagrut, 19 Oct 2026): recording on the phone, for a visit file. Kind-agnostic, so a video clip
 * records the same way: the type is chosen before recording from what this browser's recorder says it writes (a
 * recording never fails at upload for its type), the recording stops itself at its cap, and every track is let go
 * when it ends. Nothing here keeps or sends a file: the caller hands the finished blob to the visit-file outbox.
 */

export type RecordKind = 'audio' | 'video';

/** The recorder types tried, best first: WebM (Opus), which Chromium and Firefox write; MP4, which iPhones write (AAC);
 *  Ogg (Opus). The upload names only the base type (`VOICE_NOTE_MIMES`, `VIDEO_CLIP_MIMES`), so a `;codecs=` parameter
 *  is asked for and checked here, then stripped. A video clip is WebM (VP8, then VP9, with Opus) where the recorder
 *  writes it, else MP4 (H.264 with AAC, as iPhones write). Never `video/webm;codecs=h264`: Chromium writes that as
 *  Matroska, which the server refuses. */
export const RECORD_TYPES: Record<RecordKind, readonly string[]> = {
  audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'],
  video: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
};

/** The base types the upload takes for each kind, each with the codecs the server's reader takes in it (the #1025
 *  allow-list: Opus in WebM and Ogg, AAC-LC or Opus in MP4; #995 V1 for video: VP8 or VP9 with Opus in WebM, H.264
 *  (`avc1`, never `avc3`) or VP9 with AAC-LC or Opus in MP4; Chromium names VP9 in MP4 `vp9`). A codec ending `.*` is that codec with any profile and
 *  level (`avc1.64001F`), or none named. A recorder that reports anything else is not used. */
export const UPLOAD_CODECS: Record<RecordKind, Readonly<Record<string, readonly string[]>>> = {
  audio: { 'audio/webm': ['opus'], 'audio/ogg': ['opus'], 'audio/mp4': ['mp4a.40.2', 'opus'] },
  video: { 'video/webm': ['vp8', 'vp9', 'vp09.*', 'opus'], 'video/mp4': ['avc1.*', 'vp9', 'vp09.*', 'mp4a.40.2', 'opus'] },
};

/** Whether `codec`, as a recorder names it, is the allow-list's `entry`. */
function codecIs(codec: string, entry: string): boolean {
  if (!entry.endsWith('.*')) return codec === entry;
  const name = entry.slice(0, -2);
  return codec === name || (codec.startsWith(`${name}.`) && codec.length > name.length + 1);
}

/** Whether the upload takes a file of `kind` written as `type`: its base type is one the upload takes, and every codec
 *  it names (when it names any: a recorder may give the base type alone) is one the server reads in that type. */
export function acceptedType(kind: RecordKind, type: string): boolean {
  const codecs = UPLOAD_CODECS[kind][baseType(type)];
  if (!codecs) return false;
  const named = /;\s*codecs\s*=\s*"?([^";]*)"?/i.exec(type)?.[1];
  if (named === undefined) return true;
  const list = named.split(',').map((c) => c.trim().toLowerCase());
  return list.length > 0 && list.every((c) => codecs.some((entry) => codecIs(c, entry)));
}

/** `type` without its parameters, lower-cased: `audio/webm;codecs=opus` is `audio/webm`. */
export function baseType(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
}

/** The first type this browser's recorder says it can write for `kind`, or null when it can write none (or has no
 *  recorder): recording is then not offered. */
export function pickRecordType(kind: RecordKind): string | null {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (typeof Recorder?.isTypeSupported !== 'function') return null;
  if (!(globalThis as { navigator?: Navigator }).navigator?.mediaDevices?.getUserMedia) return null;
  return RECORD_TYPES[kind].find((t) => acceptedType(kind, t) && Recorder.isTypeSupported(t)) ?? null;
}

/** A finished recording: its bytes, the base type they were written in (`type`: as the recorder named it, codecs and
 *  all), and how long the recorder ran. */
export interface Recorded {
  blob: Blob;
  mime: string;
  type: string;
  ms: number;
}

/** Why a recording could not start: the person (or the browser for the site) said no to the microphone or camera; this
 *  phone has none the browser can use, or no recorder for the chosen type; or the recorder writes a format the upload
 *  does not take. */
export type RecordFailure = 'denied' | 'unavailable' | 'format';
export class RecordError extends Error {
  readonly reason: RecordFailure;
  constructor(reason: RecordFailure) {
    super(reason);
    this.name = 'RecordError';
    this.reason = reason;
  }
}

export interface Recording {
  /** Stop and take what was recorded. When the cap stopped it already, this is that recording. */
  stop(): Promise<Recorded>;
  /** Stop and keep nothing. */
  cancel(): void;
  /** Settles once when the recording stopped without Stop or Cancel: at its cap (`cap`), or because the browser ended it
   *  (`ended`: the microphone went away, the phone took it for a call). It carries that recording, which is then also
   *  what `stop` returns. */
  ended: Promise<{ rec: Recorded; cause: 'cap' | 'ended' }>;
  /** What is being recorded, live: a video clip shows it, muted, so the person sees what the camera sees. */
  stream: MediaStream;
}

/** What a kind may ask of the recorder beyond its type: its bit rates (a video clip keeps a minute inside the upload's
 *  size), and which devices it records from (video may record picture only when the microphone is refused: `fallback`
 *  is asked for once when `media` is refused or finds no device, and its answer is then the one that counts). */
export interface RecordOptions {
  bits?: { audioBitsPerSecond?: number; videoBitsPerSecond?: number };
  media?: MediaStreamConstraints;
  fallback?: MediaStreamConstraints;
}

/**
 * Start recording `kind` in `type` (from `pickRecordType`). It stops itself after `maxMs`. The recording is one blob,
 * written when it stops (no timeslice), so a container's own header and index are whole. It records from the phone's
 * own devices (`getUserMedia`), never a drawn stream. A recorder that writes a type the upload does not take for `kind`
 * (whatever it was asked for) is stopped at once and reported as a format refusal, so such a file is never kept. The
 * microphone (and camera) are let go as soon as it stops or is cancelled.
 */
export async function startRecording(kind: RecordKind, type: string, maxMs: number, options: RecordOptions = {}): Promise<Recording> {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
  if (!Recorder || !devices?.getUserMedia) throw new RecordError('unavailable');
  const ask = async (media: MediaStreamConstraints) => {
    try {
      return await devices.getUserMedia(media);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new RecordError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
  };
  const first = options.media ?? (kind === 'audio' ? { audio: true } : { audio: true, video: true });
  const stream: MediaStream = await ask(first).catch((err: unknown) => {
    if (!options.fallback) throw err;
    return ask(options.fallback);
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  // a video clip is recorded only once the camera shows a picture: an iPhone's camera takes a moment to start, and a
  // clip whose recorder started before then was kept black, would not play and was refused by the server (29 Oct)
  if (kind === 'video' && !(await firstPicture(stream, CAMERA_WAIT_MS))) {
    release();
    throw new RecordError('unavailable');
  }
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, { mimeType: type, ...options.bits });
  } catch {
    release();
    throw new RecordError('unavailable');
  }
  const chunks: Blob[] = [];
  let began: number | null = null;
  // when the stop was asked for (Stop, Cancel or the cap): the recording's length runs to there, not to the stop event,
  // which comes once the recorder has written its last data
  let stoppedAt: number | null = null;
  // and a recording the browser ended by itself runs to when its microphone (or camera) ended; with no word of that,
  // to its stop event, which can only make it longer than it was, so a note near the limit is refused, never kept long
  // (a hidden tab can run the cap's timer late, so a recording the browser ended may truly be past the cap)
  let endedAt: number | null = null;
  // (a track's own end: the device went away, or the phone took it; never our own release, which ends no track this way)
  stream.getTracks().forEach((t) => t.addEventListener?.('ended', () => { endedAt ??= clock(); }, { once: true }));
  let asked = false;
  let byCap = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  // the type the recorder actually writes, which may name codecs the request did not: the upload takes its base type
  const done = new Promise<Recorded>((resolve) => {
    recorder.onstop = () => {
      if (timer) clearTimeout(timer);
      release();
      const written = recorder.mimeType || type;
      const mime = baseType(written);
      const rec = { blob: new Blob(chunks, { type: mime }), mime, type: written, ms: began === null ? 0 : Math.max(0, (stoppedAt ?? endedAt ?? clock()) - began) };
      resolve(rec);
      // stopped by its cap, or by the browser itself: said, so the screen does not go on showing a recording
      if (!cancelled && (byCap || !asked)) resolveEnded({ rec, cause: byCap ? 'cap' : 'ended' });
    };
  });
  let resolveEnded: (r: { rec: Recorded; cause: 'cap' | 'ended' }) => void = () => {};
  const ended = new Promise<{ rec: Recorded; cause: 'cap' | 'ended' }>((resolve) => { resolveEnded = resolve; });
  const halt = () => {
    if (recorder.state === 'inactive') return;
    asked = true;
    stoppedAt ??= clock();
    recorder.stop();
  };
  try {
    recorder.start();
  } catch {
    release();
    throw new RecordError('unavailable');
  }
  // the type it writes, codecs and all, as it says once started: one the upload does not take is never recorded on
  if (!acceptedType(kind, recorder.mimeType || type)) {
    cancelled = true;
    recorder.onstop = null;
    recorder.ondataavailable = null;
    if (recorder.state !== 'inactive') recorder.stop();
    release();
    throw new RecordError('format');
  }
  began = clock();
  timer = setTimeout(() => {
    if (recorder.state === 'inactive' || asked) return;
    byCap = true;
    halt();
  }, maxMs);
  return {
    stop: () => { halt(); return done; },
    // the last data the recorder hands over as it stops is dropped too
    cancel: () => { cancelled = true; recorder.ondataavailable = null; chunks.length = 0; halt(); },
    ended,
    stream,
  };
}

/** How long a video clip waits for the camera's first picture before it starts recording, or says it could not. */
export const CAMERA_WAIT_MS = 5_000;

/**
 * Whether the camera in `stream` shows a picture within `ms`: false with no camera track. It is watched on a muted,
 * inline video in the page, out of sight (iOS plays only a video it can lay out), at its first drawn frame
 * (`requestVideoFrameCallback`), or once it has a frame and a size. The video leaves the page however it ends; the
 * stream's tracks go on for the recorder.
 */
function firstPicture(stream: MediaStream, ms: number): Promise<boolean> {
  if ((stream.getVideoTracks?.() ?? []).length === 0 || typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (seen: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      video.onloadeddata = video.onresize = null;
      try { video.pause(); } catch { /* nothing to pause */ }
      video.srcObject = null;
      video.remove();
      resolve(seen);
    };
    const sized = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish(true); };
    timer = setTimeout(() => finish(false), ms);
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    video.onloadeddata = sized;
    video.onresize = sized;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => finish(true));
    try {
      video.srcObject = stream;
      document.body.appendChild(video);
      // a refused play still has its frame and size counted, where the browser loads one without playing
      void Promise.resolve(video.play()).catch(() => {});
    } catch {
      finish(false);
    }
  });
}

/** A clock that only runs forward: a recording's length is never moved by the phone's time of day being changed or
 *  corrected while it records. */
function clock(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

/** `blob`'s bytes as base64, with no `data:` prefix. */
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

/** `ms` as `m:ss`, for a recording's running time. */
export function clockText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
