import { addPosterSchema } from '@/data/queueContracts';
import { setClampedTimeout } from './clampedTimer';
import { blobBase64 } from './mediaRecorder';

/** The widest still frame drawn: a frame from a wider clip is scaled down to it, keeping its shape. */
export const POSTER_MAX_WIDTH = 640;
/** The JPEG quality the frame is written at: a 640 × 360 frame is 30 to 60 KB. */
export const POSTER_QUALITY = 0.8;
/** Where in the clip the frame is taken: just past the start, where a camera that is still waking may show black. */
export const POSTER_AT_SEC = 0.1;
/** How long drawing the frame may take before the clip is kept without one. */
export const POSTER_DRAW_WAIT_MS = 3000;

/**
 * #995 V2b-2: a recorded clip's still frame, as base64 JPEG with no `data:` prefix, or null when this browser cannot
 * draw one in time. The clip is played muted on this phone alone (an object URL; nothing is sent) until it passes
 * `POSTER_AT_SEC`, then paused and drawn on a canvas at most `POSTER_MAX_WIDTH` wide and written by the canvas as JPEG,
 * never a camera JPEG, so it carries no Exif (V2 decision 1: the server refuses APP1). A frame the upload's contract
 * refuses (too large) is no frame. Null is never a failure of the clip: it is kept and sent with the plain play tile.
 *
 * V2c: iOS Safari decodes no picture for a clip that is not playing (a seek alone drew nothing on Jagrut's iPhone,
 * 29 Oct), so the clip is played, not only seeked, and is put in the page (out of sight) while it plays, as iOS plays
 * only a video it can lay out. A browser that refuses to play it still gets the seek: the frame at `POSTER_AT_SEC`, or
 * the first frame if it cannot seek.
 */
export function drawPoster(blob: Blob, waitMs = POSTER_DRAW_WAIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') { resolve(null); return; }
    let url: string;
    try { url = URL.createObjectURL(blob); } catch { resolve(null); return; }
    const video = document.createElement('video');
    let done = false;
    let drawing = false;
    const finish = (data: string | null): void => {
      if (done) return;
      done = true;
      timer.clear();
      video.onloadedmetadata = null;
      video.ontimeupdate = null;
      video.onended = null;
      video.onseeked = null;
      video.onerror = null;
      try { video.pause(); } catch { /* let go */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* let go */ }
      video.remove();
      URL.revokeObjectURL(url);
      resolve(data);
    };
    const timer = setClampedTimeout(() => finish(null), waitMs);
    const draw = (): void => {
      if (done || drawing) return;
      drawing = true;
      try { video.pause(); } catch { /* the frame shown now is drawn */ }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) { finish(null); return; }
      const scale = Math.min(1, POSTER_MAX_WIDTH / w);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { finish(null); return; }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((jpeg) => {
          // a browser that writes no JPEG answers with a PNG: not a frame the server takes
          if (!jpeg || jpeg.type !== 'image/jpeg') { finish(null); return; }
          blobBase64(jpeg).then(
            (data) => finish(addPosterSchema.safeParse({ mime: 'image/jpeg', data }).success ? data : null),
            () => finish(null),
          );
        }, 'image/jpeg', POSTER_QUALITY);
      } catch {
        finish(null);
      }
    };
    // not played: the frame at POSTER_AT_SEC by a seek, once the clip's size is known; the first frame if it cannot seek
    const seek = (): void => {
      if (done) return;
      video.ontimeupdate = null;
      video.onseeked = draw;
      const go = (): void => { try { video.currentTime = POSTER_AT_SEC; } catch { draw(); } };
      if (video.readyState >= 1) go();
      else video.onloadedmetadata = go;
    };
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    // iOS reads its autoplay rules from the attributes
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    video.onerror = () => finish(null);
    // played: drawn once it passes POSTER_AT_SEC, or at its end for a clip shorter than that
    video.ontimeupdate = () => { if (video.currentTime >= POSTER_AT_SEC) draw(); };
    video.onended = draw;
    try { document.body.appendChild(video); } catch { /* played where it is */ }
    video.src = url;
    let played: Promise<void> | undefined;
    try { played = video.play(); } catch { seek(); return; }
    // an older browser's play() answers nothing: its time updates say whether it plays
    played?.catch(seek);
  });
}
