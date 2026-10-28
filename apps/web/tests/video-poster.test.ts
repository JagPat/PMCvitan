import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { POSTER_AT_SEC, POSTER_MAX_WIDTH, POSTER_QUALITY, drawPoster } from '@/lib/videoPoster';
import { POSTER_MAX_BASE64 } from '@/data/queueContracts';

/**
 * #995 V2b-2: the still frame a phone draws from a clip it recorded. jsdom decodes no video, so the clip's player and
 * the canvas are stand-ins that answer as a browser's do; `notes/video/v2b-2/` has the run in real Chromium, whose
 * frames the server's own JPEG reader takes.
 */

type Video = {
  videoWidth: number; videoHeight: number; muted: boolean; playsInline: boolean; preload: string;
  onloadeddata: (() => void) | null; onseeked: (() => void) | null; onerror: (() => void) | null;
  seekedTo: number | null; src: string; removeAttribute: (n: string) => void; load: () => void;
};
let video: Video;
let canvas: { width: number; height: number; drawn: unknown[] | null; type: string; quality: number | null; getContext: () => unknown; toBlob: (cb: (b: Blob | null) => void, t: string, q: number) => void };
/** what the canvas writes: a JPEG of these bytes, by default */
let writes: Blob | null;
/** what the clip does once given its source */
let clip: 'loads' | 'fails' | 'never' | 'cannotSeek';
const revoked: string[] = [];

beforeEach(() => {
  writes = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  clip = 'loads';
  revoked.length = 0;
  let src = '';
  let at = 0;
  video = {
    videoWidth: 1280, videoHeight: 720, muted: false, playsInline: false, preload: '', onloadeddata: null, onseeked: null, onerror: null, seekedTo: null,
    get src() { return src; },
    set src(v: string) {
      src = v;
      if (clip === 'fails') queueMicrotask(() => video.onerror?.());
      else if (clip !== 'never') queueMicrotask(() => video.onloadeddata?.());
    },
    removeAttribute: () => { src = ''; },
    load: () => {},
  } as Video;
  Object.defineProperty(video, 'currentTime', {
    get: () => at,
    set: (t: number) => {
      if (clip === 'cannotSeek') throw new Error('not seekable');
      at = t;
      video.seekedTo = t;
      queueMicrotask(() => video.onseeked?.());
    },
  });
  canvas = {
    width: 0, height: 0, drawn: null, type: '', quality: null,
    getContext: () => ({ drawImage: (...args: unknown[]) => { canvas.drawn = args; } }),
    toBlob: (cb, t, q) => { canvas.type = t; canvas.quality = q; queueMicrotask(() => cb(writes)); },
  };
  const make = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'video' ? video : tag === 'canvas' ? canvas : make(tag))) as typeof document.createElement);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:clip'), revokeObjectURL: vi.fn((u: string) => { revoked.push(u); }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const clipBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' });

describe('#995 V2b-2: drawPoster', () => {
  it('plays the clip muted on this phone, takes the frame just past the start, at most 640 wide in its own shape, as JPEG 0.8', async () => {
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.seekedTo).toBe(POSTER_AT_SEC);
    expect([canvas.width, canvas.height]).toEqual([POSTER_MAX_WIDTH, 360]);
    expect(canvas.drawn).toEqual([video, 0, 0, 640, 360]);
    expect([canvas.type, canvas.quality]).toEqual(['image/jpeg', POSTER_QUALITY]);
    expect(revoked).toEqual(['blob:clip']);
  });

  it('keeps a clip narrower than 640 at its own size, and a phone held upright in its own shape', async () => {
    video.videoWidth = 480;
    video.videoHeight = 640;
    expect(await drawPoster(clipBlob)).not.toBeNull();
    expect([canvas.width, canvas.height]).toEqual([480, 640]);
    video.videoWidth = 720;
    video.videoHeight = 1280;
    expect(await drawPoster(clipBlob)).not.toBeNull();
    expect([canvas.width, canvas.height]).toEqual([640, 1138]);
  });

  it('draws the first frame of a clip it cannot seek', async () => {
    clip = 'cannotSeek';
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(canvas.drawn).not.toBeNull();
  });

  it('gives no frame, and lets the clip go, when this browser cannot play it, never loads it, has no picture or writes no JPEG', async () => {
    clip = 'fails';
    expect(await drawPoster(clipBlob)).toBeNull();
    clip = 'never';
    expect(await drawPoster(clipBlob, 20)).toBeNull();
    clip = 'loads';
    video.videoWidth = 0;
    expect(await drawPoster(clipBlob)).toBeNull();
    video.videoWidth = 1280;
    writes = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });
    expect(await drawPoster(clipBlob)).toBeNull();
    writes = null;
    expect(await drawPoster(clipBlob)).toBeNull();
    expect(revoked).toEqual(Array(5).fill('blob:clip'));
  });

  it('gives no frame the upload’s contract refuses (over its size)', async () => {
    writes = new Blob([new Uint8Array((POSTER_MAX_BASE64 / 4) * 3 + 3)], { type: 'image/jpeg' });
    expect(await drawPoster(clipBlob)).toBeNull();
    writes = new Blob([new Uint8Array((POSTER_MAX_BASE64 / 4) * 3)], { type: 'image/jpeg' });
    expect(await drawPoster(clipBlob)).not.toBeNull();
  });
});
