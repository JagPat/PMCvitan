import { readExif } from '@/lib/exif';

/**
 * When and where a photo was taken, as the media contract wants it.
 *
 * `Media.takenAt` is a String column the schema documents as a *display* timestamp
 * ("03 Jul 2026 · 9:12 AM"), and the seed writes exactly that shape — so this formats one
 * rather than sending an instant. That is not a shortcut: EXIF `DateTimeOriginal` is the
 * camera's own wall clock with no zone attached, and for a site photo that clock IS the
 * site's local time. Rendering it as the site would read it is the honest conversion; an
 * ISO instant would require inventing a timezone the file never recorded.
 *
 * Everything here is synchronous, and deliberately so. The picker has ALREADY read the file
 * into a data URL, so the bytes are in hand: decoding the head of that string costs no yield.
 * An `await` here — even one as innocent as `file.slice().arrayBuffer()` — would suspend the
 * handler between the user choosing a photo and the store queueing it, a window in which a
 * project switch redirects the upload and a reload loses the photo outright.
 */
export interface CaptureStamp {
  takenAt?: string;
  geoLat?: number;
  geoLng?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How much of the photo to decode looking for EXIF.
 *
 * A JPEG APP1 segment declares a 16-bit length, so it can approach 64 KiB on its own, and it
 * may sit after an APP0 (JFIF) segment — a 64 KiB budget can therefore stop short of a valid
 * segment's end. This is generous enough that the whole of even a thumbnail-bearing APP1 is
 * resident, while still bounding the synchronous decode on a multi-megabyte photo.
 */
const HEAD_BYTES = 256 * 1024;

/**
 * The stamp a photo's own bytes support — empty when the file carries no capture metadata.
 *
 * Takes the data URL the picker already produced. Only its head is decoded: EXIF lives in an
 * APP1 segment near the start of the file, so there is no reason to walk megabytes of pixels.
 */
export function captureStamp(dataUrl: string): CaptureStamp {
  const exif = readExif(headBytes(dataUrl));
  if (!exif) return {};
  const stamp: CaptureStamp = {};
  const takenAt = exif.takenAtLocal ? displayTime(exif.takenAtLocal) : null;
  if (takenAt) stamp.takenAt = takenAt;
  if (exif.lat !== undefined && exif.lng !== undefined) {
    stamp.geoLat = exif.lat;
    stamp.geoLng = exif.lng;
  }
  return stamp;
}

/** Does this photo carry anything worth sending? */
export function hasStamp(stamp: CaptureStamp): boolean {
  return stamp.takenAt !== undefined || stamp.geoLat !== undefined;
}

/** The leading bytes of a `data:...;base64,...` URL, decoded. Empty on anything unexpected. */
function headBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return new Uint8Array();
  const base64 = dataUrl.slice(comma + 1);
  // 4 base64 characters carry 3 bytes; cut on a 4-character boundary so the tail decodes
  const wanted = Math.ceil(HEAD_BYTES / 3) * 4;
  const take = Math.min(base64.length, wanted);
  const chunk = base64.slice(0, take - (take % 4));
  if (!chunk) return new Uint8Array();
  try {
    const binary = atob(chunk);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(); // not base64 after all
  }
}

/**
 * `2026:08:11 09:15:00` → `11 Aug 2026 · 9:15 AM`, the shape the column documents.
 *
 * Every field is validated, and the day is validated against the actual calendar rather than
 * a 1–31 range: corrupt metadata like `2026:02:31 09:99:00` must yield NO stamp, not an
 * impossible one recorded permanently as when the photo was taken.
 */
function displayTime(exifLocal: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(exifLocal);
  if (!m) return null;
  const [, y, mo, d, h, min, sec] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour24 = Number(h);
  if (month < 1 || month > 12 || day < 1 || hour24 > 23 || Number(min) > 59 || Number(sec) > 59) return null;
  // a date that does not survive the round trip never existed — 31 Feb rolls to 3 Mar
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(day).padStart(2, '0')} ${MONTHS[month - 1]} ${y} · ${hour12}:${min} ${suffix}`;
}

/**
 * How long a rendered `takenAt` may be.
 *
 * The documented shape ("03 Jul 2026 · 9:12 AM") is around twenty characters. The column is a
 * free `String` and `apps/api/src/contracts.ts` accepts an unbounded `z.string()`, so an
 * authorized upload can put a value near the request-body limit in it. Rendering that whole
 * value builds a multi-megabyte wrapping text node and stalls the screen, so display is capped.
 * This is a display bound, not validation: it never changes what is stored.
 */
const STAMP_DISPLAY_MAX = 64;

/** A `takenAt` as it should be shown: bounded, and empty when there is nothing to show. */
export function stampText(takenAt: string | null | undefined): string {
  if (!takenAt) return '';
  return takenAt.length > STAMP_DISPLAY_MAX ? `${takenAt.slice(0, STAMP_DISPLAY_MAX)}…` : takenAt;
}
