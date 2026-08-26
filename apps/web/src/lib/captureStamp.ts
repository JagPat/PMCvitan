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
 * Everything here is synchronous. Nothing prompts, nothing times out, and nothing runs
 * between accepting a photo and durably queueing it.
 */
export interface CaptureStamp {
  takenAt?: string;
  geoLat?: number;
  geoLng?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The stamp a photo's own bytes support — empty when the file carries no capture metadata.
 *
 * `bytes` need only be the head of the file: EXIF lives in the APP1 segment near the start,
 * so the caller reads a slice rather than the whole photo.
 */
export function captureStamp(bytes: Uint8Array): CaptureStamp {
  const exif = readExif(bytes);
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

/** `2026:08:11 09:15:00` → `11 Aug 2026 · 9:15 AM`, the shape the column documents. */
function displayTime(exifLocal: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):\d{2}$/.exec(exifLocal);
  if (!m) return null;
  const [, y, mo, d, h, min] = m;
  const month = MONTHS[Number(mo) - 1];
  const day = Number(d);
  const hour24 = Number(h);
  // a camera that wrote an impossible date is not a camera we can quote
  if (!month || day < 1 || day > 31 || hour24 > 23) return null;
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(day).padStart(2, '0')} ${month} ${y} · ${hour12}:${min} ${suffix}`;
}
