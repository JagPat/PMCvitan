/**
 * The capture metadata a photo carries in itself.
 *
 * The daily log tells the user its progress photos are "geo + time stamped", and the media
 * contract has always accepted `takenAt`/`geoLat`/`geoLng` — the store just never sent them.
 * The tempting way to make the claim true is to stamp the moment the file was picked and the
 * device's position while picking it. That is not the same claim: `capture="environment"` is
 * a hint the picker may ignore, so the file can be any image on the phone, and a photo taken
 * last week was not taken where the engineer is standing now. `File.lastModified` does not
 * rescue it either — copying, downloading or editing an old photo rewrites it to today.
 *
 * So this reads what the photo actually carries. EXIF `DateTimeOriginal` is written by the
 * camera at the shutter and survives being copied around; GPS likewise records where the
 * SHUTTER was, not where the phone is now. When a file carries them the stamp is true by
 * construction. When it carries nothing — a screenshot, a stripped export, a PNG — the
 * honest answer is no stamp at all, and the daily log says so rather than inventing one.
 *
 * Deliberately minimal: JPEG APP1 only, the four tags below, every read bounds-checked, and
 * any surprise answered with null. This runs on arbitrary bytes a user chose.
 */
export interface ExifCapture {
  /** `DateTimeOriginal`, the camera's own wall clock: `YYYY:MM:DD HH:MM:SS`, no zone. */
  takenAtLocal?: string;
  lat?: number;
  lng?: number;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG = 0x0004;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Everything a photo tells us about its own capture, or null if it tells us nothing. */
export function readExif(bytes: Uint8Array): ExifCapture | null {
  try {
    const tiff = findTiffHeader(bytes);
    if (tiff === null) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 42) return null;

    const ifd0 = readIfd(view, tiff, tiff + view.getUint32(tiff + 4, le), le);
    if (!ifd0) return null;

    const out: ExifCapture = {};

    const exifPtr = numberOf(view, tiff, ifd0.get(TAG_EXIF_IFD), le);
    if (exifPtr !== null) {
      const exif = readIfd(view, tiff, tiff + exifPtr, le);
      const taken = asciiOf(view, tiff, exif?.get(TAG_DATE_TIME_ORIGINAL), le);
      // '0000:00:00 00:00:00' is how some cameras say "unset" — a shape check rejects it
      if (taken && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(taken) && !taken.startsWith('0000')) {
        out.takenAtLocal = taken;
      }
    }

    const gpsPtr = numberOf(view, tiff, ifd0.get(TAG_GPS_IFD), le);
    if (gpsPtr !== null) {
      const gps = readIfd(view, tiff, tiff + gpsPtr, le);
      const lat = coordinate(view, tiff, gps?.get(TAG_GPS_LAT), gps?.get(TAG_GPS_LAT_REF), 'S', 90, le);
      const lng = coordinate(view, tiff, gps?.get(TAG_GPS_LNG), gps?.get(TAG_GPS_LNG_REF), 'W', 180, le);
      // a half-fix is not a fix: both or neither
      if (lat !== null && lng !== null) {
        out.lat = lat;
        out.lng = lng;
      }
    }

    return out.takenAtLocal || out.lat !== undefined ? out : null;
  } catch {
    // malformed, truncated, or simply not the shape this reads — the photo still uploads
    return null;
  }
}

/** Offset of the TIFF header inside the JPEG's APP1 segment, or null. */
function findTiffHeader(b: Uint8Array): number | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // not a JPEG
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null; // out of step with the marker stream
    const marker = b[p + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2; // standalone marker, no payload
      continue;
    }
    if (marker === 0xda) return null; // start of scan: past every metadata segment
    const size = (b[p + 2] << 8) | b[p + 3];
    if (size < 2 || p + 2 + size > b.length) return null;
    if (marker === 0xe1 && p + 10 <= b.length) {
      const tag = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (tag === 'Exif' && b[p + 8] === 0 && b[p + 9] === 0) return p + 10;
    }
    p += 2 + size;
  }
  return null;
}

interface Entry { type: number; count: number; at: number }

/** One IFD as tag → entry. Entry counts are capped: a corrupt count must not spin. */
function readIfd(view: DataView, tiff: number, at: number, le: boolean): Map<number, Entry> | null {
  if (at < tiff || at + 2 > view.byteLength) return null;
  const count = view.getUint16(at, le);
  if (count === 0 || count > 512) return null;
  if (at + 2 + count * 12 > view.byteLength) return null;
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i += 1) {
    const e = at + 2 + i * 12;
    entries.set(view.getUint16(e, le), {
      type: view.getUint16(e + 2, le),
      count: view.getUint32(e + 4, le),
      at: e + 8,
    });
  }
  return entries;
}

/** Where an entry's values actually live: inline when they fit in four bytes, else out of line. */
function valuesAt(view: DataView, tiff: number, entry: Entry, le: boolean): number | null {
  const unit = TYPE_SIZE[entry.type];
  if (!unit || entry.count === 0 || entry.count > 4096) return null;
  const size = unit * entry.count;
  const at = size <= 4 ? entry.at : tiff + view.getUint32(entry.at, le);
  if (at < 0 || at + size > view.byteLength) return null;
  return at;
}

function numberOf(view: DataView, tiff: number, entry: Entry | undefined, le: boolean): number | null {
  if (!entry) return null;
  const at = valuesAt(view, tiff, entry, le);
  if (at === null) return null;
  if (entry.type === 4 || entry.type === 9) return view.getUint32(at, le);
  if (entry.type === 3) return view.getUint16(at, le);
  return null;
}

function asciiOf(view: DataView, tiff: number, entry: Entry | undefined, le: boolean): string | null {
  if (!entry || entry.type !== 2) return null;
  const at = valuesAt(view, tiff, entry, le);
  if (at === null) return null;
  let s = '';
  for (let i = 0; i < entry.count; i += 1) {
    const c = view.getUint8(at + i);
    if (c === 0) break; // NUL-terminated
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

/**
 * One GPS coordinate as signed degrees, or null.
 *
 * EXIF stores degrees/minutes/seconds as three rationals plus a hemisphere letter. A zero
 * denominator, an out-of-range result or a missing hemisphere all yield null rather than a
 * coordinate in the wrong ocean.
 */
function coordinate(
  view: DataView,
  tiff: number,
  dms: Entry | undefined,
  ref: Entry | undefined,
  negative: 'S' | 'W',
  limit: number,
  le: boolean,
): number | null {
  if (!dms || dms.type !== 5 || dms.count !== 3) return null;
  const at = valuesAt(view, tiff, dms, le);
  if (at === null) return null;
  const hemisphere = asciiOf(view, tiff, ref, le);
  if (hemisphere !== 'N' && hemisphere !== 'S' && hemisphere !== 'E' && hemisphere !== 'W') return null;

  let degrees = 0;
  for (let i = 0; i < 3; i += 1) {
    const numerator = view.getUint32(at + i * 8, le);
    const denominator = view.getUint32(at + i * 8 + 4, le);
    if (denominator === 0) return null;
    degrees += numerator / denominator / 60 ** i;
  }
  if (!Number.isFinite(degrees) || degrees > limit) return null;
  return hemisphere === negative ? -degrees : degrees;
}
