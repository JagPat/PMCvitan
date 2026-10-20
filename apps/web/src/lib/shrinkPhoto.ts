/**
 * Site Visits SV2 (#792): a phone photo made small before it is sent, so a camera's full-size file goes quickly over a
 * site's weak signal. The longest side is brought down to `PHOTO_MAX_EDGE` and the photo saved as a JPEG; the capture
 * stamp is read from the original first (`captureStamp`), since a redrawn photo carries no EXIF.
 *
 * Whatever the browser cannot redraw (no canvas, a format it cannot decode such as HEIC outside Safari, any error)
 * goes as it was, so the caller checks the result against `MAX_PHOTO_BASE64` before sending it.
 */
export const PHOTO_MAX_EDGE = 2048;
/** The image types the upload takes (`RASTER_IMAGE_MIMES`, apps/api contracts.ts). Any other image the browser can
 *  decode (AVIF, BMP, ...) is redrawn as a JPEG; one it cannot is refused before it is sent. */
export const UPLOAD_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
/** A photo already within the edge is redrawn only when its file is larger than this (base64 characters). */
const SMALL_ENOUGH = 1_500_000;
/** The largest request body the API reads (`useBodyParser('json', { limit: '12mb' })`, apps/api app-setup.ts): a
 *  larger one is refused whole (413) before the upload's own check (`MAX_MEDIA_BASE64`, 14,000,000) is reached. */
export const API_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** Room in that body for everything around the photo: its JSON keys, the type, capture time and place, and a
 *  500-character note and the visit's fields, many times over. */
export const UPLOAD_ENVELOPE_BYTES = 64 * 1024;
/** The largest photo the upload takes, in base64 characters (one byte each in the body) (Codex 4320690152). */
export const MAX_PHOTO_BASE64 = API_BODY_LIMIT_BYTES - UPLOAD_ENVELOPE_BYTES;
const JPEG_QUALITY = 0.85;

export async function shrinkPhoto(dataUrl: string): Promise<string> {
  const m = /^data:([^;]+);base64,/.exec(dataUrl);
  return redraw(dataUrl, !!m && !UPLOAD_IMAGE_MIMES.includes(m[1]));
}

/** `force`: redraw whatever its size (a type the upload does not take). */
async function redraw(dataUrl: string, force: boolean): Promise<string> {
  try {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return dataUrl;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: m[1] }));
    try {
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (!force && scale === 1 && dataUrl.length <= SMALL_ENOUGH) return dataUrl;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      return out.startsWith('data:image/jpeg;base64,') && (force || out.length < dataUrl.length) ? out : dataUrl;
    } finally {
      bitmap.close();
    }
  } catch {
    return dataUrl;
  }
}
