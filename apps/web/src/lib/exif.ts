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
 * any surprise answered with null. This runs on arbitrary bytes a user chose, and it is given
 * only the head of the file — so a segment may legitimately declare a length beyond the bytes
 * in hand without that being corruption.
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
    const found = findTiffHeader(bytes);
    if (found === null) return null;
    const { tiff, end } = found;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 42) return null;

    const ifd0 = readIfd(view, tiff, end, tiff + view.getUint32(tiff + 4, le), le);
    if (!ifd0) return null;

    const out: ExifCapture = {};

    const exifPtr = numberOf(view, tiff, end, ifd0.get(TAG_EXIF_IFD), le);
    if (exifPtr !== null) {
      const exif = readIfd(view, tiff, end, tiff + exifPtr, le);
      const taken = asciiOf(view, tiff, end, exif?.get(TAG_DATE_TIME_ORIGINAL), le);
      // '0000:00:00 00:00:00' is how some cameras say "unset" — a shape check rejects it
      if (taken && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(taken) && !taken.startsWith('0000')) {
        out.takenAtLocal = taken;
      }
    }

    const gpsPtr = numberOf(view, tiff, end, ifd0.get(TAG_GPS_IFD), le);
    if (gpsPtr !== null) {
      const gps = readIfd(view, tiff, end, tiff + gpsPtr, le);
      const lat = coordinate(view, tiff, end, gps?.get(TAG_GPS_LAT), gps?.get(TAG_GPS_LAT_REF), 'N', 'S', 90, le);
      const lng = coordinate(view, tiff, end, gps?.get(TAG_GPS_LNG), gps?.get(TAG_GPS_LNG_REF), 'E', 'W', 180, le);
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

/**
 * The TIFF header inside the JPEG's APP1 segment, and the END of that segment.
 *
 * `end` matters as much as `tiff`. EXIF offsets are relative to the TIFF header and can point
 * anywhere; bounding them by the whole decoded head would let a malformed APP1 reach into a
 * LATER segment — or into bytes appended after the image — and have them read back as capture
 * metadata. Every read is bounded by this segment instead. It is clamped to the bytes actually
 * held, so a large APP1 that runs past the decoded head still yields what is resident.
 */
function findTiffHeader(b: Uint8Array): { tiff: number; end: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // not a JPEG
  let p = 2;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) return null; // out of step with the marker stream
    // A marker may be introduced by ANY number of 0xff fill bytes, so `FF FF E1` is a
    // perfectly legal APP1. Reading the byte after the first 0xff as the code would take
    // that marker for 0xff and then read the code and length as a length — losing a stamp
    // the file was carrying.
    let m = p + 1;
    while (m < b.length && b[m] === 0xff) m += 1;
    if (m >= b.length) return null;
    const marker = b[m];

    // EOI ends the image. Bytes AFTER it are not part of it — appended or concatenated data
    // must never be read back as this photo's capture metadata, so this is terminal, not a
    // standalone marker to step over.
    if (marker === 0xd9) return null;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      p = m + 1; // standalone marker, no payload
      continue;
    }
    if (marker === 0xda) return null; // start of scan: past every metadata segment
    if (m + 2 >= b.length) return null;
    // the length field follows the marker code and counts itself
    const size = (b[m + 1] << 8) | b[m + 2];
    if (size < 2) return null;

    // A segment may DECLARE a length running past the bytes we hold — an APP1 alone can
    // approach 64 KiB — so the usable end is whichever comes first.
    const declaredEnd = m + 1 + size;
    const end = Math.min(declaredEnd, b.length);

    const payload = m + 3;
    // the signature must lie inside the segment the header DECLARES, not merely inside the
    // file: a length ending before its own 'Exif\0\0' does not declare an EXIF segment
    if (marker === 0xe1 && payload + 6 <= end) {
      const isExif = b[payload] === 0x45 && b[payload + 1] === 0x78 && b[payload + 2] === 0x69
        && b[payload + 3] === 0x66 && b[payload + 4] === 0 && b[payload + 5] === 0; // 'Exif\0\0'
      if (isExif) return { tiff: payload + 6, end };
    }
    if (declaredEnd > b.length || declaredEnd <= p) return null;
    p = declaredEnd;
  }
  return null;
}

interface Entry { type: number; count: number; at: number }

/** One IFD as tag → entry. Entry counts are capped: a corrupt count must not spin. */
function readIfd(view: DataView, tiff: number, end: number, at: number, le: boolean): Map<number, Entry> | null {
  if (at < tiff || at + 2 > end) return null;
  const count = view.getUint16(at, le);
  if (count === 0 || count > 512) return null;
  if (at + 2 + count * 12 > end) return null;
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
function valuesAt(view: DataView, tiff: number, end: number, entry: Entry, le: boolean): number | null {
  const unit = TYPE_SIZE[entry.type];
  if (!unit || entry.count === 0 || entry.count > 4096) return null;
  const size = unit * entry.count;
  const at = size <= 4 ? entry.at : tiff + view.getUint32(entry.at, le);
  if (at < tiff || at + size > end) return null;
  return at;
}

function numberOf(view: DataView, tiff: number, end: number, entry: Entry | undefined, le: boolean): number | null {
  if (!entry) return null;
  const at = valuesAt(view, tiff, end, entry, le);
  if (at === null) return null;
  if (entry.type === 4 || entry.type === 9) return view.getUint32(at, le);
  if (entry.type === 3) return view.getUint16(at, le);
  return null;
}

function asciiOf(view: DataView, tiff: number, end: number, entry: Entry | undefined, le: boolean): string | null {
  if (!entry || entry.type !== 2) return null;
  const at = valuesAt(view, tiff, end, entry, le);
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
  end: number,
  dms: Entry | undefined,
  ref: Entry | undefined,
  positive: 'N' | 'E',
  negative: 'S' | 'W',
  limit: number,
  le: boolean,
): number | null {
  if (!dms || dms.type !== 5 || dms.count !== 3) return null;
  const at = valuesAt(view, tiff, end, dms, le);
  if (at === null) return null;
  // EXIF permits only N/S on latitude and E/W on longitude. Accepting either pair on either
  // axis turns a corrupt 'W' latitude into a plausible POSITIVE one — a location in the wrong
  // place reads as truth, where no location at all reads as what it is.
  const hemisphere = asciiOf(view, tiff, end, ref, le);
  if (hemisphere !== positive && hemisphere !== negative) return null;

  let degrees = 0;
  for (let i = 0; i < 3; i += 1) {
    const numerator = view.getUint32(at + i * 8, le);
    const denominator = view.getUint32(at + i * 8 + 4, le);
    if (denominator === 0) return null;
    const part = numerator / denominator;
    if (!Number.isFinite(part)) return null;
    // Each component is bounded on its own. Summing first would silently NORMALISE nonsense:
    // 23° 90′ 0″ carries over into a perfectly plausible 24.5°, and a coordinate that reads as
    // plausible is worse than none — this becomes permanent capture evidence.
    if (i === 0 ? part > limit : part >= 60) return null;
    degrees += part / 60 ** i;
  }
  if (!Number.isFinite(degrees) || degrees > limit) return null;
  return hemisphere === negative ? -degrees : degrees;
}
