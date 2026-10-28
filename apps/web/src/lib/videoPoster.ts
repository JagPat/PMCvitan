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
 * draw one in time. The clip is played muted on this phone alone (an object URL; nothing is sent), seeked to
 * `POSTER_AT_SEC`, drawn on a canvas at most `POSTER_MAX_WIDTH` wide and written by the canvas as JPEG, never a camera
 * JPEG, so it carries no Exif (V2 decision 1: the server refuses APP1). A frame the upload's contract refuses (too
 * large) is no frame. Null is never a failure of the clip: it is kept and sent with the plain play tile.
 */
export function drawPoster(blob: Blob, waitMs = POSTER_DRAW_WAIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') { resolve(null); return; }
    let url: string;
    try { url = URL.createObjectURL(blob); } catch { resolve(null); return; }
    const video = document.createElement('video');
    let done = false;
    const finish = (data: string | null): void => {
      if (done) return;
      done = true;
      timer.clear();
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      try { video.load(); } catch { /* let go */ }
      URL.revokeObjectURL(url);
      resolve(data);
    };
    const timer = setClampedTimeout(() => finish(null), waitMs);
    const draw = (): void => {
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
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      video.onloadeddata = null;
      try { video.currentTime = POSTER_AT_SEC; } catch { draw(); }
    };
    video.onseeked = draw;
    video.onerror = () => finish(null);
    video.src = url;
  });
}
