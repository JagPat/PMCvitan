/**
 * Site Visits SV2 (#792): a phone photo made small enough to wait on the phone. A photo added on a visit is queued in
 * the browser's storage until it is sent (offline on site, or a reload before signal), and a camera's full-size file
 * would not fit there. The longest side is brought down to `PHOTO_MAX_EDGE` and the photo saved as a JPEG; the
 * capture stamp is read from the original first (`captureStamp`), since a redrawn photo carries no EXIF.
 *
 * Whatever the browser cannot redraw (no canvas, a format it cannot decode such as HEIC outside Safari, any error)
 * goes as it was: the server takes it, and only its wait on the phone is less certain.
 */
export const PHOTO_MAX_EDGE = 2048;
/** A photo already within the edge is redrawn only when its file is larger than this (base64 characters). */
const SMALL_ENOUGH = 1_500_000;
const JPEG_QUALITY = 0.85;

export async function shrinkPhoto(dataUrl: string): Promise<string> {
  try {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return dataUrl;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: m[1] }));
    try {
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && dataUrl.length <= SMALL_ENOUGH) return dataUrl;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      return out.startsWith('data:image/jpeg;base64,') && out.length < dataUrl.length ? out : dataUrl;
    } finally {
      bitmap.close();
    }
  } catch {
    return dataUrl;
  }
}
