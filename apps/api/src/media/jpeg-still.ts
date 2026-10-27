/**
 * #995 V1b — is this upload the still frame a browser draws from a clip (a canvas `toBlob('image/jpeg')`), and nothing
 * else?
 *
 * A bounded marker walk, not a decoder: it reads every segment's header by its type and never decodes the picture.
 * Every marker is read against an allow-list of what a browser's canvas writes; one it does not name is a refusal,
 * never skipped:
 *  - SOI first, then only APP0 (the 14-byte JFIF header with no thumbnail, at most once), APP2 (a single-chunk ICC profile, chunk 1 of 1, at most once),
 *    DQT, DHT, DRI (exactly 4 bytes), exactly one SOF0 or SOF2, and SOS, each segment's length inside the file.
 *  - The SOF: 8-bit, 1 or 3 components with distinct ids, sampling factors 1 to 4 and a table 0 to 3, a width and a
 *    height each from 1 to {@link POSTER_MAX_SIDE}, and its length exactly its fields'. It comes before the first SOS.
 *  - Each SOS: at least one component, each one of the SOF's and none twice (so no more than the SOF has), its
 *    length exactly its fields'. Its entropy
 *    data, at least one byte, runs to the next marker that is not a stuffed byte or a restart marker. A baseline frame has one scan.
 *  - EOI ends the file: no byte after it, and at least one scan before it.
 * Refused: APP1 (Exif, XMP: a phone's location or camera), every other APPn, COM, DNL, DHP, EXP, JPG, arithmetic,
 * lossless and hierarchical frames, a multi-chunk ICC profile, fill bytes, and anything past EOI.
 */
export const POSTER_MAX_SIDE = 1920;

export interface JpegStill {
  width: number;
  height: number;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
const SOF0 = 0xc0;
const SOF2 = 0xc2;
const APP0 = 0xe0;
const APP2 = 0xe2;
const JFIF = Buffer.from('JFIF\0', 'latin1');
const ICC = Buffer.from('ICC_PROFILE\0', 'latin1');

class Refused extends Error {}
const fail = (): never => {
  throw new Refused();
};

/** The still's size when `bytes` is a canvas JPEG the walk admits, otherwise null. */
export function readJpegStill(bytes: Buffer): JpegStill | null {
  try {
    return walk(bytes);
  } catch (e) {
    if (e instanceof Refused || e instanceof RangeError) return null;
    throw e;
  }
}

function walk(b: Buffer): JpegStill {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) fail();
  let at = 2;
  let frame: { width: number; height: number; ids: number[]; progressive: boolean } | null = null;
  let scans = 0;
  let jfif = false;
  let icc = false;
  for (;;) {
    if (at + 2 > b.length || b[at] !== 0xff) fail();
    const marker = b[at + 1]!;
    if (marker === EOI) {
      if (at + 2 !== b.length || !frame || scans === 0) fail();
      return { width: frame!.width, height: frame!.height };
    }
    if (at + 4 > b.length) fail();
    const length = b.readUInt16BE(at + 2);
    const start = at + 4;
    const end = at + 2 + length;
    if (length < 2 || end > b.length) fail();
    const body = b.subarray(start, end);
    switch (marker) {
      case APP0:
        // the 14-byte JFIF header with no thumbnail, as a canvas writes it: no second picture rides inside
        if (jfif || frame || body.length !== 14 || !body.subarray(0, JFIF.length).equals(JFIF) || body[12] !== 0 || body[13] !== 0) fail();
        jfif = true;
        break;
      case APP2:
        // a profile in one chunk: its identifier, then chunk 1 of 1, then the profile
        if (icc || frame || body.length <= ICC.length + 2 || !body.subarray(0, ICC.length).equals(ICC)) fail();
        if (body[ICC.length] !== 1 || body[ICC.length + 1] !== 1) fail();
        icc = true;
        break;
      case DQT:
      case DHT:
        if (body.length === 0) fail();
        break;
      case DRI:
        if (body.length !== 2) fail();
        break;
      case SOF0:
      case SOF2: {
        if (frame || body.length < 6) fail();
        const components = body[5]!;
        if (body[0] !== 8 || (components !== 1 && components !== 3) || body.length !== 6 + 3 * components) fail();
        const height = body.readUInt16BE(1);
        const width = body.readUInt16BE(3);
        if (height < 1 || height > POSTER_MAX_SIDE || width < 1 || width > POSTER_MAX_SIDE) fail();
        const ids: number[] = [];
        for (let i = 0; i < components; i++) {
          const id = body[6 + 3 * i]!;
          const h = body[7 + 3 * i]! >> 4;
          const v = body[7 + 3 * i]! & 0x0f;
          if (ids.includes(id) || h < 1 || h > 4 || v < 1 || v > 4 || body[8 + 3 * i]! > 3) fail();
          ids.push(id);
        }
        frame = { width, height, ids, progressive: marker === SOF2 };
        break;
      }
      case SOS: {
        if (!frame || (!frame.progressive && scans > 0) || body.length < 1) fail();
        const count = body[0]!;
        if (count < 1 || body.length !== 4 + 2 * count) fail();
        const seen: number[] = [];
        for (let i = 0; i < count; i++) {
          const id = body[1 + 2 * i]!;
          if (!frame!.ids.includes(id) || seen.includes(id)) fail();
          seen.push(id);
        }
        scans++;
        at = entropyEnd(b, end);
        // a scan with no coded data draws nothing (Codex P2 on #1166)
        if (at === end) fail();
        continue;
      }
      default:
        fail();
    }
    at = end;
  }
}

/** Where a scan's entropy data ends: the first 0xFF that is neither a stuffed zero nor a restart marker. */
function entropyEnd(b: Buffer, from: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const next = b[i + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i++;
      continue;
    }
    return i;
  }
  return fail();
}
