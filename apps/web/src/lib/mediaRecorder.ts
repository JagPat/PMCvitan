/**
 * Stage 1 voice notes (Jagrut, 19 Oct 2026): recording on the phone, for a visit file. Kind-agnostic, so a video clip
 * records the same way: the type is chosen before recording from what this browser's recorder says it writes (a
 * recording never fails at upload for its type), the recording stops itself at its cap, and every track is let go
 * when it ends. Nothing here keeps or sends a file: the caller hands the finished blob to the visit-file outbox.
 */

export type RecordKind = 'audio' | 'video';

/** The recorder types tried, best first. Android browsers record WebM (Opus), iPhones MP4 (AAC), Firefox Ogg; the
 *  server takes the base types (`VOICE_NOTE_MIMES`), so a `;codecs=` parameter is asked for here and stripped below. */
export const RECORD_TYPES: Record<RecordKind, readonly string[]> = {
  audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'],
  // the video web unit (V2) fills this in with what its server unit takes; until then video is never offered
  video: [],
};

/** The base types the upload takes for each kind: a recorder that reports anything else is not used. */
export const UPLOAD_TYPES: Record<RecordKind, readonly string[]> = {
  audio: ['audio/webm', 'audio/mp4', 'audio/ogg'],
  video: [],
};

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
  return RECORD_TYPES[kind].find((t) => UPLOAD_TYPES[kind].includes(baseType(t)) && Recorder.isTypeSupported(t)) ?? null;
}

/** A finished recording: its bytes, the base type they were written in, and how long the recorder ran. */
export interface Recorded {
  blob: Blob;
  mime: string;
  ms: number;
}

/** Why a recording could not start: the person (or the browser for the site) said no to the microphone or camera, or
 *  this phone has none the browser can use, or no recorder for the chosen type. */
export class RecordError extends Error {
  readonly reason: 'denied' | 'unavailable';
  constructor(reason: 'denied' | 'unavailable') {
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
  /** Settles once with the recording when it stopped itself at its cap (it is then also what `stop` returns). */
  capped: Promise<Recorded>;
}

/** What a kind may ask of the recorder beyond its type: its bit rates (a video clip keeps a minute inside the upload's
 *  size), and which devices it records from (video may record picture only when the microphone is refused). */
export interface RecordOptions {
  bits?: { audioBitsPerSecond?: number; videoBitsPerSecond?: number };
  media?: MediaStreamConstraints;
}

/**
 * Start recording `kind` in `type` (from `pickRecordType`). It stops itself after `maxMs`. The recording is one blob,
 * written when it stops (no timeslice), so a container's own header and index are whole. It records from the phone's
 * own devices (`getUserMedia`), never a drawn stream. A recorder that writes a type the upload does not take for `kind`
 * (whatever it was asked for) is stopped at once and reported as unavailable, so such a file is never kept. The
 * microphone (and camera) are let go as soon as it stops or is cancelled.
 */
export async function startRecording(kind: RecordKind, type: string, maxMs: number, options: RecordOptions = {}): Promise<Recording> {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
  if (!Recorder || !devices?.getUserMedia) throw new RecordError('unavailable');
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia(options.media ?? (kind === 'audio' ? { audio: true } : { audio: true, video: true }));
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    throw new RecordError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, { mimeType: type, ...options.bits });
  } catch {
    release();
    throw new RecordError('unavailable');
  }
  const chunks: Blob[] = [];
  let began: number | null = null;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  // the type the recorder actually writes, which may name codecs the request did not: the upload takes its base type
  const done = new Promise<Recorded>((resolve) => {
    recorder.onstop = () => {
      if (timer) clearTimeout(timer);
      release();
      const mime = baseType(recorder.mimeType || type);
      resolve({ blob: new Blob(chunks, { type: mime }), mime, ms: began === null ? 0 : Math.max(0, Date.now() - began) });
    };
  });
  let resolveCapped: (r: Recorded) => void = () => {};
  const capped = new Promise<Recorded>((resolve) => { resolveCapped = resolve; });
  const halt = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  try {
    recorder.start();
  } catch {
    release();
    throw new RecordError('unavailable');
  }
  // the type it writes, as it says once started: one the upload does not take is never recorded on
  if (!UPLOAD_TYPES[kind].includes(baseType(recorder.mimeType || type))) {
    cancelled = true;
    recorder.onstop = null;
    recorder.ondataavailable = null;
    if (recorder.state !== 'inactive') recorder.stop();
    release();
    throw new RecordError('unavailable');
  }
  began = Date.now();
  timer = setTimeout(() => {
    halt();
    void done.then((r) => { if (!cancelled) resolveCapped(r); });
  }, maxMs);
  return {
    stop: () => { halt(); return done; },
    // the last data the recorder hands over as it stops is dropped too
    cancel: () => { cancelled = true; recorder.ondataavailable = null; chunks.length = 0; halt(); },
    capped,
  };
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
