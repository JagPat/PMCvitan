import { describe, it, expect } from 'vitest';
import { readExif } from '@/lib/exif';
import { captureStamp, hasStamp, stampText } from '@/lib/captureStamp';

/**
 * Unit B — a progress photo's stamp comes from the PHOTO, never from the moment it was picked.
 *
 * Two earlier shapes of this were rejected on review, both for claiming more than the file
 * supports: stamping the wall clock at selection time, then trusting `File.lastModified` (which
 * copying, downloading or editing rewrites to today — and which would then also attach the
 * engineer's current coordinates to a photo taken last week). EXIF is the actual capture
 * metadata: written at the shutter, carried by the file. When it is absent there is no stamp.
 *
 * The fixtures are BUILT here rather than checked in, so what each probe asserts is visible.
 */

// ---- a minimal but genuine JPEG + EXIF encoder, so the parser is tested on real bytes ----

interface Field { tag: number; type: number; count: number; value: number[] }

function long(tag: number, v: number): Field {
  return { tag, type: 4, count: 1, value: [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff] };
}

/** Little-endian TIFF with IFD0 → Exif IFD and GPS IFD, laid out with real offsets. */
function buildExif(opts: { dateTimeOriginal?: string; gps?: { lat: number[][]; latRef: string; lng: number[][]; lngRef: string } }): Uint8Array {
  const out: number[] = [];
  const push = (...b: number[]) => out.push(...b);
  const u16 = (v: number) => push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);

  push(0x49, 0x49); u16(42); u32(8); // 'II', magic 42, IFD0 at 8

  // heap begins after IFD0 (which we size first) — compute by laying IFD0 out twice
  const ifd0Entries: Field[] = [];

  // IFD0 holds at most two pointers; lay it out first so the heap that follows knows where
  // it starts — real offsets are the whole point of testing the parser on real bytes.
  const n0 = (opts.dateTimeOriginal ? 1 : 0) + (opts.gps ? 1 : 0);
  const ifd0Size = 2 + n0 * 12 + 4;
  let cursor = 8 + ifd0Size;

  const blocks: { at: number; bytes: number[] }[] = [];

  if (opts.dateTimeOriginal) {
    const ascii = [...opts.dateTimeOriginal].map((c) => c.charCodeAt(0)).concat(0);
    const exifIfdOffset = cursor;
    const exifIfdSize = 2 + 1 * 12 + 4;
    const asciiAt = exifIfdOffset + exifIfdSize;
    const ifd: number[] = [];
    ifd.push(1, 0);                                              // 1 entry
    ifd.push(0x03, 0x90, 2, 0);                                  // DateTimeOriginal, ASCII
    ifd.push(ascii.length & 0xff, ascii.length >> 8, 0, 0);      // count
    ifd.push(asciiAt & 0xff, (asciiAt >> 8) & 0xff, 0, 0);       // offset
    ifd.push(0, 0, 0, 0);                                        // next IFD
    blocks.push({ at: exifIfdOffset, bytes: ifd.concat(ascii) });
    cursor = asciiAt + ascii.length;
    ifd0Entries.push(long(0x8769, exifIfdOffset));
  }

  if (opts.gps) {
    const gpsIfdOffset = cursor;
    const gpsIfdSize = 2 + 4 * 12 + 4;
    let heap = gpsIfdOffset + gpsIfdSize;
    const ifd: number[] = [];
    const heapBytes: number[] = [];
    ifd.push(4, 0);
    const refEntry = (tag: number, letter: string) => {
      ifd.push(tag & 0xff, tag >> 8, 2, 0);           // ASCII
      ifd.push(2, 0, 0, 0);                            // count 2 (letter + NUL) — fits inline
      ifd.push(letter.charCodeAt(0), 0, 0, 0);
    };
    const dmsEntry = (tag: number, dms: number[][]) => {
      ifd.push(tag & 0xff, tag >> 8, 5, 0);            // RATIONAL
      ifd.push(3, 0, 0, 0);                            // count 3
      ifd.push(heap & 0xff, (heap >> 8) & 0xff, 0, 0); // out of line (24 bytes)
      for (const [num, den] of dms) {
        heapBytes.push(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, (num >> 24) & 0xff);
        heapBytes.push(den & 0xff, (den >> 8) & 0xff, (den >> 16) & 0xff, (den >> 24) & 0xff);
      }
      heap += 24;
    };
    refEntry(0x0001, opts.gps.latRef);
    dmsEntry(0x0002, opts.gps.lat);
    refEntry(0x0003, opts.gps.lngRef);
    dmsEntry(0x0004, opts.gps.lng);
    ifd.push(0, 0, 0, 0);
    blocks.push({ at: gpsIfdOffset, bytes: ifd.concat(heapBytes) });
    cursor = heap;
    ifd0Entries.push(long(0x8825, gpsIfdOffset));
  }

  u16(ifd0Entries.length);
  for (const f of ifd0Entries) {
    u16(f.tag); u16(f.type); u32(f.count); push(...f.value);
  }
  u32(0); // no IFD1

  for (const b of blocks) {
    while (out.length < b.at) push(0);
    push(...b.bytes);
  }
  return new Uint8Array(out);
}

/** A JPEG whose APP1 segment carries the given TIFF block. */
function jpegWithExif(tiff: Uint8Array): Uint8Array {
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // 'Exif\0\0' + TIFF
  const size = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, size >> 8, size & 0xff, ...payload, 0xff, 0xd9]);
}

/** What the picker hands the store: the whole file as a base64 data URL. */
function dataUrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

const AHMEDABAD = {
  lat: [[23, 1], [1, 1], [48, 1]] as number[][],   // 23° 1' 48"  N
  latRef: 'N',
  lng: [[72, 1], [34, 1], [12, 1]] as number[][],  // 72° 34' 12" E
  lngRef: 'E',
};

describe('a photo is stamped from what it recorded at the shutter', () => {
  it('reads the capture time the camera wrote', () => {
    const bytes = jpegWithExif(buildExif({ dateTimeOriginal: '2026:08:11 09:15:30' }));
    expect(readExif(bytes)?.takenAtLocal).toBe('2026:08:11 09:15:30');
    // and it reaches the media contract in the shape the column documents
    expect(captureStamp(dataUrlOf(bytes)).takenAt).toBe('11 Aug 2026 · 9:15 AM');
  });

  it('reads where the SHUTTER was, not where the phone is now', () => {
    const bytes = jpegWithExif(buildExif({ dateTimeOriginal: '2026:08:11 09:15:30', gps: AHMEDABAD }));
    const stamp = captureStamp(dataUrlOf(bytes));
    expect(stamp.geoLat).toBeCloseTo(23.03, 2);
    expect(stamp.geoLng).toBeCloseTo(72.57, 2);
  });

  it('reads a southern/western hemisphere as negative degrees', () => {
    const bytes = jpegWithExif(buildExif({
      gps: { lat: [[33, 1], [51, 1], [54, 1]], latRef: 'S', lng: [[151, 1], [12, 1], [36, 1]], lngRef: 'W' },
    }));
    const stamp = captureStamp(dataUrlOf(bytes));
    expect(stamp.geoLat).toBeCloseTo(-33.865, 2);
    expect(stamp.geoLng).toBeCloseTo(-151.21, 2);
  });

  it('formats afternoon and midnight the way the column documents', () => {
    const at = (s: string) => captureStamp(dataUrlOf(jpegWithExif(buildExif({ dateTimeOriginal: s })))).takenAt;
    expect(at('2026:08:11 13:05:00')).toBe('11 Aug 2026 · 1:05 PM');
    expect(at('2026:08:11 00:30:00')).toBe('11 Aug 2026 · 12:30 AM');
    expect(at('2026:08:11 12:00:00')).toBe('11 Aug 2026 · 12:00 PM');
  });
});

describe('a photo that records nothing is stamped with nothing', () => {
  it('invents no time for a file with no EXIF at all', () => {
    const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(readExif(plain)).toBeNull();
    expect(captureStamp(dataUrlOf(plain))).toEqual({});
    expect(hasStamp(captureStamp(dataUrlOf(plain)))).toBe(false);
  });

  it('invents no time for a PNG, a screenshot, or empty bytes', () => {
    for (const b of [new Uint8Array([0x89, 0x50, 0x4e, 0x47]), new Uint8Array(), new Uint8Array([0xff, 0xd8])]) {
      expect(captureStamp(dataUrlOf(b))).toEqual({});
    }
  });

  it('survives truncated and corrupt bytes without throwing', () => {
    const full = jpegWithExif(buildExif({ dateTimeOriginal: '2026:08:11 09:15:30', gps: AHMEDABAD }));
    for (let cut = 1; cut < full.length; cut += 1) {
      expect(() => captureStamp(dataUrlOf(full.slice(0, cut)))).not.toThrow();
    }
    const scrambled = Uint8Array.from(full, (b, i) => (i > 4 && i % 7 === 0 ? b ^ 0xff : b));
    expect(() => captureStamp(dataUrlOf(scrambled))).not.toThrow();
  });

  it('rejects the "unset" date some cameras write', () => {
    expect(captureStamp(dataUrlOf(jpegWithExif(buildExif({ dateTimeOriginal: '0000:00:00 00:00:00' })))).takenAt).toBeUndefined();
  });

  it('drops a coordinate with a zero denominator rather than reporting the wrong ocean', () => {
    const bytes = jpegWithExif(buildExif({
      gps: { lat: [[23, 0], [1, 1], [48, 1]], latRef: 'N', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(bytes)).geoLat).toBeUndefined();
  });

  it('drops coordinates with no hemisphere — a half-fix is not a fix', () => {
    const bytes = jpegWithExif(buildExif({
      gps: { lat: [[23, 1], [1, 1], [48, 1]], latRef: 'X', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(bytes)).geoLat).toBeUndefined();
    expect(captureStamp(dataUrlOf(bytes)).geoLng).toBeUndefined();
  });
});

/**
 * The four findings from `20311f92`, each pinned.
 *
 * F1 (the picker's second yield) is pinned in `media.test.ts`, where the store can observe
 * that nothing suspends between choosing a photo and queueing it. The other three are here.
 */
describe('corrupt metadata yields no stamp rather than a plausible wrong one', () => {
  const at = (s: string) => captureStamp(dataUrlOf(jpegWithExif(buildExif({ dateTimeOriginal: s })))).takenAt;

  it('F2: refuses a date that never existed', () => {
    expect(at('2026:02:31 09:15:00')).toBeUndefined(); // 31 February
    expect(at('2027:02:29 09:15:00')).toBeUndefined(); // 2027 is not a leap year
    expect(at('2026:13:01 09:15:00')).toBeUndefined(); // month 13
    expect(at('2026:00:10 09:15:00')).toBeUndefined(); // month 0
  });

  it('F2: refuses an impossible clock', () => {
    expect(at('2026:08:11 09:99:00')).toBeUndefined(); // 99 minutes
    expect(at('2026:08:11 09:15:99')).toBeUndefined(); // 99 seconds
    expect(at('2026:08:11 24:00:00')).toBeUndefined(); // hour 24
  });

  it('F2: still accepts a real leap day', () => {
    expect(at('2028:02:29 09:15:00')).toBe('29 Feb 2028 · 9:15 AM');
  });

  it('F4: refuses a hemisphere letter from the wrong axis', () => {
    // a corrupt 'W' on latitude used to pass and come back POSITIVE — a plausible wrong place
    const wrongLat = jpegWithExif(buildExif({
      gps: { lat: [[23, 1], [1, 1], [48, 1]], latRef: 'W', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(wrongLat)).geoLat).toBeUndefined();

    const wrongLng = jpegWithExif(buildExif({
      gps: { lat: [[23, 1], [1, 1], [48, 1]], latRef: 'N', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'N' },
    }));
    expect(captureStamp(dataUrlOf(wrongLng)).geoLng).toBeUndefined();
  });
});

describe('a large APP1 segment is still read', () => {
  it('F3: finds EXIF behind a preceding APP0, and past a segment longer than the bytes held', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 09:15:30', gps: AHMEDABAD });
    const app1 = [0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    // declare a segment far larger than what follows — a real APP1 carrying a thumbnail does
    // exactly this, and the head we decode can stop inside it
    const declared = 0xfffd;
    app1[2] = declared >> 8;
    app1[3] = declared & 0xff;
    const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...app1]);

    const stamp = captureStamp(dataUrlOf(bytes));
    expect(stamp.takenAt).toBe('11 Aug 2026 · 9:15 AM');
    expect(stamp.geoLat).toBeCloseTo(23.03, 2);
  });

  it('F3: decodes past 64 KiB of leading segments', () => {
    const filler = new Array(70 * 1024).fill(0);
    // one oversized APP0-style segment cannot exceed 0xffff, so pad with several
    const segments: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const size = 24 * 1024;
      segments.push(0xff, 0xe0, size >> 8, size & 0xff, ...filler.slice(0, size - 2));
    }
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 14:05:00' });
    const app1 = [0xff, 0xe1, ((tiff.length + 8) >> 8) & 0xff, (tiff.length + 8) & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const bytes = new Uint8Array([0xff, 0xd8, ...segments, ...app1]);
    expect(bytes.length).toBeGreaterThan(64 * 1024);

    expect(captureStamp(dataUrlOf(bytes)).takenAt).toBe('11 Aug 2026 · 2:05 PM');
  });
});

describe('a legal marker introduced by fill bytes is still a marker', () => {
  it('F-fill: reads EXIF from an APP1 introduced by repeated 0xff', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 09:15:30' });
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const size = payload.length + 2;
    // `FF FF FF E1` — fill bytes before the marker code are permitted by the JPEG spec
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xe1, size >> 8, size & 0xff, ...payload, 0xff, 0xd9]);

    expect(captureStamp(dataUrlOf(bytes)).takenAt).toBe('11 Aug 2026 · 9:15 AM');
  });

  it('F-fill: skips a padded standalone marker and still finds the APP1 behind it', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 16:40:00' });
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const size = payload.length + 2;
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xff, 0x01,                       // a padded standalone marker (TEM)
      0xff, 0xff, 0xe1, size >> 8, size & 0xff, ...payload,
      0xff, 0xd9,
    ]);

    expect(captureStamp(dataUrlOf(bytes)).takenAt).toBe('11 Aug 2026 · 4:40 PM');
  });

  it('F-fill: a run of 0xff that never reaches a marker still cannot hang or throw', () => {
    const bytes = new Uint8Array([0xff, 0xd8, ...new Array(5000).fill(0xff)]);
    expect(() => captureStamp(dataUrlOf(bytes))).not.toThrow();
    expect(captureStamp(dataUrlOf(bytes))).toEqual({});
  });
});

/**
 * The five findings from `8fa29c9c`. Three are parser hardening against bytes a user chose;
 * the local-demo stamp and the display cap are probed in `media.test.ts` and `format` below.
 *
 * The theme is one rule: a stamp that reads as plausible but is not what the photo recorded
 * is worse than no stamp, because it becomes permanent capture evidence.
 */
describe('malformed metadata is refused, not normalised', () => {
  it('A: refuses DMS components at or beyond 60 instead of carrying them over', () => {
    // 23° 90′ 0″ would normalise to a perfectly plausible 24.5°
    const badMinutes = jpegWithExif(buildExif({
      gps: { lat: [[23, 1], [90, 1], [0, 1]], latRef: 'N', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(badMinutes)).geoLat).toBeUndefined();

    const badSeconds = jpegWithExif(buildExif({
      gps: { lat: [[23, 1], [1, 1], [60, 1]], latRef: 'N', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(badSeconds)).geoLat).toBeUndefined();

    // and the degree component is still bounded on its own
    const badDegrees = jpegWithExif(buildExif({
      gps: { lat: [[91, 1], [0, 1], [0, 1]], latRef: 'N', lng: [[72, 1], [34, 1], [12, 1]], lngRef: 'E' },
    }));
    expect(captureStamp(dataUrlOf(badDegrees)).geoLat).toBeUndefined();
  });

  it('D: stops at the end-of-image marker, so appended bytes are not this photo', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 09:15:30' });
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const size = payload.length + 2;
    // SOI, EOI, then something shaped exactly like an EXIF APP1 concatenated afterwards
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xd9,
      0xff, 0xe1, size >> 8, size & 0xff, ...payload,
    ]);

    expect(captureStamp(dataUrlOf(bytes))).toEqual({});
  });

  it('C: refuses a segment whose declared length ends before its own Exif signature', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 09:15:30' });
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    // the bytes are all present, but the segment declares it ends inside the signature
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x05, ...payload, 0xff, 0xd9]);

    expect(captureStamp(dataUrlOf(bytes))).toEqual({});
  });

  it('C: does not read a TIFF offset that points outside the declaring segment', () => {
    const tiff = buildExif({ dateTimeOriginal: '2026:08:11 09:15:30' });
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    // declare a segment that stops just after the TIFF header, so IFD0 lies beyond its end
    const truncated = 2 + 6 + 8;
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, truncated >> 8, truncated & 0xff, ...payload,
      0xff, 0xd9,
    ]);

    // the bytes are in hand, but they are not this segment's to offer
    expect(captureStamp(dataUrlOf(bytes))).toEqual({});
  });
});

describe('a rendered stamp is bounded', () => {
  it('E: caps an abnormally long value rather than building a huge text node', () => {
    const huge = 'x'.repeat(5_000);
    const shown = stampText(huge);
    expect(shown.length).toBeLessThanOrEqual(65);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('E: leaves a normal stamp exactly as it is, and empty stays empty', () => {
    expect(stampText('11 Aug 2026 · 9:15 AM')).toBe('11 Aug 2026 · 9:15 AM');
    for (const v of [null, undefined, '']) expect(stampText(v)).toBe('');
  });
});
