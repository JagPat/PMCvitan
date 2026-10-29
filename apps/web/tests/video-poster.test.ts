import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { POSTER_AT_SEC, POSTER_DRAW_WAIT_MS, POSTER_MAX_WIDTH, POSTER_QUALITY, drawPoster } from '@/lib/videoPoster';
import * as timers from '@/lib/clampedTimer';
import { POSTER_MAX_BASE64 } from '@/data/queueContracts';

/**
 * #995 V2b-2: the still frame a phone draws from a clip it recorded. jsdom decodes no video, so the clip's player and
 * the canvas are stand-ins that answer as a browser's do; `notes/video/v2b-2/` has the run in real Chromium, whose
 * frames the server's own JPEG reader takes. V2c: `ios` stands in for iOS Safari, which loads and decodes nothing for a
 * clip until it plays (Jagrut's iPhone, 29 Oct: no frame from a seek alone).
 */

type Clip =
  | 'plays' // loads on its own, and plays when asked
  | 'ios' // loads nothing until asked to play, then plays
  | 'short' // plays, and ends before POSTER_AT_SEC
  | 'oldPlay' // plays, but play() answers nothing (an older browser)
  | 'refuses' // will not play (autoplay refused); loads on its own, and seeks
  | 'refusesUnloaded' // will not play, and its size is known only later
  | 'cannotSeek' // will not play, nor seek
  | 'fails' // cannot read the clip at all
  | 'never'; // never answers
type Video = Record<string, unknown> & {
  videoWidth: number; videoHeight: number; readyState: number; currentTime: number;
  onloadedmetadata: (() => void) | null; ontimeupdate: (() => void) | null; onended: (() => void) | null;
  onseeked: (() => void) | null; onerror: (() => void) | null;
};
let video: Video;
let canvas: { width: number; height: number; drawn: unknown[] | null; drawnAt: number | null; type: string; quality: number | null; getContext: () => unknown; toBlob: (cb: (b: Blob | null) => void, t: string, q: number) => void };
/** what the canvas writes: a JPEG of these bytes, by default */
let writes: Blob | null;
let clip: Clip;
let seekedTo: number | null;
let pauses: number;
let paused: boolean;
let removed: boolean;
let attrs: Record<string, string>;
/** for `refusesUnloaded`: the clip's size becomes known */
let loadMeta: () => void;
const revoked: string[] = [];

beforeEach(() => {
  writes = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  clip = 'plays';
  revoked.length = 0;
  seekedTo = null;
  pauses = 0;
  paused = true;
  removed = false;
  attrs = {};
  let src = '';
  let at = 0;
  const meta = () => { video.readyState = 2; video.onloadedmetadata?.(); };
  loadMeta = meta;
  const run = () => {
    paused = false;
    queueMicrotask(() => {
      video.readyState = 2;
      at = 0.05;
      video.ontimeupdate?.();
      if (paused) return;
      if (clip === 'short') { video.onended?.(); return; }
      at = 0.25;
      video.ontimeupdate?.();
    });
  };
  video = {
    videoWidth: 1280, videoHeight: 720, readyState: 0, muted: false, defaultMuted: false, playsInline: false, preload: '',
    style: { cssText: '' }, onloadedmetadata: null, ontimeupdate: null, onended: null, onseeked: null, onerror: null,
    get src() { return src; },
    set src(v: string) {
      src = v;
      if (clip === 'fails') queueMicrotask(() => video.onerror?.());
      else if (clip === 'plays' || clip === 'short' || clip === 'oldPlay' || clip === 'refuses' || clip === 'cannotSeek') queueMicrotask(meta);
    },
    get currentTime() { return at; },
    set currentTime(t: number) {
      if (clip === 'cannotSeek') throw new Error('not seekable');
      at = t;
      seekedTo = t;
      queueMicrotask(() => video.onseeked?.());
    },
    setAttribute: (n: string, v: string) => { attrs[n] = v; },
    removeAttribute: (n: string) => { if (n === 'src') src = ''; delete attrs[n]; },
    load: () => {},
    remove: () => { removed = true; },
    pause: () => { pauses += 1; paused = true; },
    play: () => {
      if (clip === 'never') return new Promise(() => {});
      if (clip === 'refuses' || clip === 'refusesUnloaded' || clip === 'cannotSeek') return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      run();
      return clip === 'oldPlay' ? undefined : Promise.resolve();
    },
  } as unknown as Video;
  canvas = {
    width: 0, height: 0, drawn: null, drawnAt: null, type: '', quality: null,
    getContext: () => ({ drawImage: (...args: unknown[]) => { canvas.drawn = args; canvas.drawnAt = video.currentTime; } }),
    toBlob: (cb, t, q) => { canvas.type = t; canvas.quality = q; queueMicrotask(() => cb(writes)); },
  };
  const make = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'video' ? video : tag === 'canvas' ? canvas : make(tag))) as typeof document.createElement);
  vi.spyOn(document.body, 'appendChild').mockImplementation(((n: Node) => n) as typeof document.body.appendChild);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:clip'), revokeObjectURL: vi.fn((u: string) => { revoked.push(u); }) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const clipBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' });

describe('#995 V2b-2: drawPoster', () => {
  it('plays the clip muted and inline, out of sight in the page, and draws it once past the start, paused, at most 640 wide in its own shape, as JPEG 0.8', async () => {
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect([video.muted, video.defaultMuted, video.playsInline]).toEqual([true, true, true]);
    expect(attrs).toMatchObject({ muted: '', playsinline: '', 'aria-hidden': 'true' });
    expect(document.body.appendChild).toHaveBeenCalledWith(video);
    expect((video.style as { cssText: string }).cssText).toContain('opacity:0');
    // drawn on the first time update at or past POSTER_AT_SEC, not before, and paused there; no seek
    expect(canvas.drawnAt).toBeGreaterThanOrEqual(POSTER_AT_SEC);
    expect(pauses).toBeGreaterThan(0);
    expect(seekedTo).toBeNull();
    expect([canvas.width, canvas.height]).toEqual([POSTER_MAX_WIDTH, 360]);
    expect(canvas.drawn).toEqual([video, 0, 0, 640, 360]);
    expect([canvas.type, canvas.quality]).toEqual(['image/jpeg', POSTER_QUALITY]);
    // let go: out of the page, its URL revoked
    expect(removed).toBe(true);
    expect(revoked).toEqual(['blob:clip']);
  });

  it('V2c: draws a frame on a phone that loads nothing for a clip until it plays (iOS Safari)', async () => {
    clip = 'ios';
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(canvas.drawnAt).toBeGreaterThanOrEqual(POSTER_AT_SEC);
  });

  it('draws a clip shorter than the frame’s time at its end, and plays where play() answers nothing', async () => {
    clip = 'short';
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(canvas.drawn).not.toBeNull();
    clip = 'oldPlay';
    canvas.drawn = null;
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(canvas.drawnAt).toBeGreaterThanOrEqual(POSTER_AT_SEC);
  });

  it('seeks to the frame where the clip may not play, once its size is known, and draws the first frame of one it cannot seek', async () => {
    clip = 'refuses';
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(seekedTo).toBe(POSTER_AT_SEC);
    clip = 'refusesUnloaded';
    seekedTo = null;
    video.readyState = 0;
    const later = drawPoster(clipBlob);
    // refused before its size is known: no seek yet
    await Promise.resolve();
    await Promise.resolve();
    expect(seekedTo).toBeNull();
    loadMeta();
    expect(await later).toBe('/9j/2Q==');
    expect(seekedTo).toBe(POSTER_AT_SEC);
    clip = 'cannotSeek';
    canvas.drawn = null;
    expect(await drawPoster(clipBlob)).toBe('/9j/2Q==');
    expect(canvas.drawn).not.toBeNull();
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

  it('gives no frame, and lets the clip go, when this browser cannot play it, never answers, has no picture or writes no JPEG', async () => {
    clip = 'fails';
    expect(await drawPoster(clipBlob)).toBeNull();
    // never answers: the bound gives up on it (the timer fired here at once, not waited for)
    clip = 'never';
    const bound = vi.spyOn(timers, 'setClampedTimeout').mockImplementation((fn: () => void) => { queueMicrotask(fn); return { clear: () => {} }; });
    expect(await drawPoster(clipBlob)).toBeNull();
    expect(bound).toHaveBeenCalledWith(expect.any(Function), POSTER_DRAW_WAIT_MS);
    bound.mockRestore();
    clip = 'plays';
    video.videoWidth = 0;
    expect(await drawPoster(clipBlob)).toBeNull();
    video.videoWidth = 1280;
    writes = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });
    expect(await drawPoster(clipBlob)).toBeNull();
    writes = null;
    expect(await drawPoster(clipBlob)).toBeNull();
    expect(revoked).toEqual(Array(5).fill('blob:clip'));
    expect(removed).toBe(true);
  });

  it('gives no frame the upload’s contract refuses (over its size)', async () => {
    writes = new Blob([new Uint8Array((POSTER_MAX_BASE64 / 4) * 3 + 3)], { type: 'image/jpeg' });
    expect(await drawPoster(clipBlob)).toBeNull();
    writes = new Blob([new Uint8Array((POSTER_MAX_BASE64 / 4) * 3)], { type: 'image/jpeg' });
    expect(await drawPoster(clipBlob)).not.toBeNull();
  });
});
